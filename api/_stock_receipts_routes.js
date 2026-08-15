// api/_stock_receipts_routes.js — Ingreso de inventario (recepciones de compra).
//
// NO es una Serverless Function (prefijo `_`, mismo motivo que
// _finance_routes.js/_coupons_routes.js/_stock_alerts_routes.js) — se invoca
// desde api/products.js cuando `req.query.resource === 'stock-receipts'` (el
// proyecto está en el tope de 12 Serverless Functions del plan Hobby de
// Vercel, ver comentario en api/products.js).
//
// GET  /api/products?resource=stock-receipts             → historial de recepciones
// POST /api/products?resource=stock-receipts              → registra una compra (una o
//   varias líneas de una vez, ej: "3 botellas de jugo + 2 packs de croissant"):
//   body { lines: [{ sku, warehouse_id, format_id, qty_purchased, total_cost }] }
//   format_id referencia al Mantenedor de Formatos de compra (purchase_formats,
//   ver api/_purchase_formats_routes.js) — vacío/null = "Directo" (factor 1,
//   compras en la misma unidad de stock del producto). El label/factor se
//   resuelven acá server-side (nunca se confía en lo que mande el cliente) y
//   quedan snapshoteados en stock_receipts, así el historial no cambia si el
//   formato se edita o borra después.
//
// Cada línea: units_added = floor(qty_purchased * factor) — el remanente
// fraccionario se pierde (ej. 3 botellas de 1.5L × 7.5 = 22.5 → se suman 22).
//
// Cada recepción es un lote (remaining_qty = units_added al crearla) — al
// vender se consume lote por lote, del más antiguo al más nuevo (FIFO, ver
// api/_stock.js). products ya no tiene una columna cost cacheada — el costo
// "actual" del producto (para mostrar, o al armar un snapshot de venta sin
// una consumición real de la que tomarlo) se computa en vivo contra
// stock_receipts: el unit_cost del lote más antiguo con remaining_qty > 0,
// o el del último lote registrado si no queda ninguno activo (ver
// api/_finance.js:loadCostMaps, misma lógica).
const { writeLog } = require('./_log');
const { recordStockMovement } = require('./_stock');

const STOCK_RECEIPT_RESOURCES = ['stock-receipts'];

function isPlainNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

async function nextReceiptId(sql, tenantId) {
  const [{ max_num }] = await sql`
    SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 5) AS INTEGER)), 0) AS max_num
    FROM stock_receipts
    WHERE id ~ '^REC-[0-9]+$' AND tenant_id = ${tenantId}
  `;
  return parseInt(max_num);
}

async function handleStockReceiptsResource(req, res, sql, session, tenantId, actor) {
  try {
    // ── GET — historial de recepciones ────────────────────────────────────
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT * FROM stock_receipts
        WHERE tenant_id = ${tenantId}
        ORDER BY created_at DESC
        LIMIT 300
      `;
      return res.json(rows);
    }

    // ── POST — registrar una compra (una o varias líneas) ──────────────────
    if (req.method === 'POST') {
      const { lines } = req.body || {};
      if (!Array.isArray(lines) || !lines.length) {
        return res.status(400).json({ error: 'lines debe ser un arreglo con al menos una línea' });
      }
      for (const line of lines) {
        if (!line || typeof line.sku !== 'string' || !line.sku) {
          return res.status(400).json({ error: 'Cada línea necesita un sku' });
        }
        if (!isPlainNumber(line.qty_purchased) || line.qty_purchased <= 0) {
          return res.status(400).json({ error: `Cantidad inválida para ${line.sku}` });
        }
      }

      const formats = await sql`SELECT id, label, factor FROM purchase_formats WHERE tenant_id = ${tenantId}`;
      const formatsById = Object.fromEntries(formats.map(f => [f.id, f]));

      let nextNum = await nextReceiptId(sql, tenantId);
      const receipts = [];
      for (const line of lines) {
        const wid = line.warehouse_id || '';
        const format = line.format_id ? formatsById[line.format_id] : null;
        if (line.format_id && !format) {
          return res.status(400).json({ error: `Formato de compra no encontrado para ${line.sku}` });
        }
        const factor = format ? Number(format.factor) : 1;
        const formLabel = format ? format.label : '';
        const totalCost = isPlainNumber(line.total_cost) ? Math.round(line.total_cost) : 0;

        const [product] = await sql`
          SELECT sku, name, stock FROM products
          WHERE sku = ${line.sku} AND warehouse_id = ${wid} AND tenant_id = ${tenantId}
        `;
        if (!product) return res.status(404).json({ error: `Producto no encontrado: ${line.sku}` });

        const unitsAdded = Math.floor(line.qty_purchased * factor);
        const unitCost = unitsAdded > 0 ? Math.round(totalCost / unitsAdded) : 0;
        // "Costo del producto" tras esta recepción, sólo para el historial
        // (columna new_avg_cost/"Costo producto") — no se guarda en
        // products, se computa igual que products.cost se computaba antes:
        // sin stock activo todavía (no hay lote más viejo esperando), este
        // lote nuevo pasa a ser el próximo a consumirse, así que es su
        // costo; si ya había stock, sigue siendo el del lote que ya estaba
        // primero en la cola.
        let newCost = unitCost;
        if (product.stock > 0) {
          const [oldestLot] = await sql`
            SELECT unit_cost FROM stock_receipts
            WHERE tenant_id = ${tenantId} AND sku = ${line.sku} AND warehouse_id = ${wid} AND remaining_qty > 0
            ORDER BY created_at ASC LIMIT 1
          `;
          newCost = oldestLot ? oldestLot.unit_cost : unitCost;
        }

        // Incremento relativo (stock = stock + x), no una escritura del valor
        // absoluto calculado en JS — dos recepciones concurrentes del mismo
        // SKU/almacén ya no se pisan (lost update): cada UPDATE parte del
        // valor que Postgres tiene en ese instante, no de la lectura de arriba.
        const [updated] = await sql`
          UPDATE products SET stock = stock + ${unitsAdded}, updated_by = ${actor}, updated_at = NOW()
          WHERE sku = ${line.sku} AND warehouse_id = ${wid} AND tenant_id = ${tenantId}
          RETURNING *
        `;

        const id = 'REC-' + String(++nextNum).padStart(4, '0');
        const [receipt] = await sql`
          INSERT INTO stock_receipts
            (id, tenant_id, sku, warehouse_id, product_name, form_label, factor, qty_purchased, total_cost, units_added, unit_cost, new_avg_cost, remaining_qty, created_by)
          VALUES
            (${id}, ${tenantId}, ${line.sku}, ${wid}, ${product.name}, ${formLabel}, ${factor}, ${line.qty_purchased}, ${totalCost}, ${unitsAdded}, ${unitCost}, ${newCost}, ${unitsAdded}, ${actor})
          RETURNING *
        `;
        receipts.push({ ...receipt, product: updated });

        await writeLog(sql, {
          tenant_id:   tenantId,
          actor,
          action:      'stock.recepcion',
          entity_type: 'producto',
          entity_id:   line.sku,
          entity_name: `${line.sku} — ${product.name}`,
          details:     { id, form_label: formLabel, qty_purchased: line.qty_purchased, factor, units_added: unitsAdded, total_cost: totalCost, product_cost: newCost },
        });
        // Historial de movimientos de stock (tab Historial en Inventario) —
        // usa unit_cost (el costo real de ESTA compra), no newCost (el costo
        // de referencia del lote FIFO más viejo), para que value_delta
        // refleje la plata efectivamente gastada en este ingreso.
        await recordStockMovement(sql, { tenantId, type: 'ingreso', refType: 'stock_receipt', refId: id, actor },
          { sku: line.sku, warehouseId: wid, productName: product.name, delta: unitsAdded, unitCost, stockAfter: updated.stock });
      }

      return res.status(201).json({ receipts });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('stock-receipts error:', err);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = { handleStockReceiptsResource, STOCK_RECEIPT_RESOURCES };
