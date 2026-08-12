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
//   body { lines: [{ sku, warehouse_id, form_label, factor, qty_purchased, total_cost }] }
//
// Cada línea: units_added = floor(qty_purchased * factor) — el remanente
// fraccionario se pierde (ej. 3 botellas de 1.5L × 7.5 = 22.5 → se suman 22).
// El costo del producto se recalcula como promedio ponderado contra el stock
// y costo que ya tenía, no se reemplaza — así una misma compra puede mezclar
// costos distintos por forma (ej. Croissant a $500/u en pack vs $1.250/u a
// granel) y el costo del producto queda consistente con lo que realmente
// costó tenerlo en bodega.
const { writeLog } = require('./_log');

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
        const factor = line.factor ?? 1;
        if (!isPlainNumber(factor) || factor <= 0) {
          return res.status(400).json({ error: `Factor de conversión inválido para ${line.sku}` });
        }
      }

      let nextNum = await nextReceiptId(sql, tenantId);
      const receipts = [];
      for (const line of lines) {
        const wid = line.warehouse_id || '';
        const factor = line.factor ?? 1;
        const totalCost = isPlainNumber(line.total_cost) ? Math.round(line.total_cost) : 0;
        const formLabel = (line.form_label || '').trim();

        const [product] = await sql`
          SELECT sku, name, stock, cost FROM products
          WHERE sku = ${line.sku} AND warehouse_id = ${wid} AND tenant_id = ${tenantId}
        `;
        if (!product) return res.status(404).json({ error: `Producto no encontrado: ${line.sku}` });

        const unitsAdded = Math.floor(line.qty_purchased * factor);
        const newStock = product.stock + unitsAdded;
        const unitCost = unitsAdded > 0 ? Math.round(totalCost / unitsAdded) : 0;
        // Si el redondeo hacia abajo dejó unitsAdded en 0 (ej: compraste una
        // fracción muy chica), no hay stock nuevo que mezclar — mantiene el
        // costo promedio actual en vez de inflarlo con un total_cost que no
        // corresponde a ninguna unidad agregada.
        const newAvgCost = unitsAdded > 0
          ? Math.round((product.stock * product.cost + totalCost) / newStock)
          : product.cost;

        const [updated] = await sql`
          UPDATE products SET stock = ${newStock}, cost = ${newAvgCost}, updated_by = ${actor}, updated_at = NOW()
          WHERE sku = ${line.sku} AND warehouse_id = ${wid} AND tenant_id = ${tenantId}
          RETURNING *
        `;

        const id = 'REC-' + String(++nextNum).padStart(4, '0');
        const [receipt] = await sql`
          INSERT INTO stock_receipts
            (id, tenant_id, sku, warehouse_id, product_name, form_label, factor, qty_purchased, total_cost, units_added, unit_cost, new_avg_cost, created_by)
          VALUES
            (${id}, ${tenantId}, ${line.sku}, ${wid}, ${product.name}, ${formLabel}, ${factor}, ${line.qty_purchased}, ${totalCost}, ${unitsAdded}, ${unitCost}, ${newAvgCost}, ${actor})
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
          details:     { id, form_label: formLabel, qty_purchased: line.qty_purchased, factor, units_added: unitsAdded, total_cost: totalCost, new_avg_cost: newAvgCost },
        });
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
