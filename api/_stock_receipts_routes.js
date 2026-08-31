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

// Proveedor obligatorio por línea: line.supplier_id referencia uno ya
// existente en el catálogo de proveedores del tenant, o line.new_supplier_name
// da de alta uno nuevo al vuelo (mismo patrón que los Grupos de Productos
// se creaban al vuelo en el import de productos) — si ya existe un proveedor
// con ese nombre (case-insensitive) para el tenant, se reusa en vez de
// duplicarlo.
async function resolveLineSupplier(sql, tenantId, actor, line) {
  if (line.supplier_id) {
    const [sup] = await sql`SELECT id, name FROM suppliers WHERE id = ${line.supplier_id} AND tenant_id = ${tenantId}`;
    if (!sup) return { error: `Proveedor no encontrado para ${line.sku}` };
    return { id: sup.id, name: sup.name };
  }
  const newName = (line.new_supplier_name || '').trim();
  if (!newName) return { error: `Selecciona o ingresa un proveedor para ${line.sku}` };

  const [existing] = await sql`SELECT id, name FROM suppliers WHERE tenant_id = ${tenantId} AND LOWER(name) = LOWER(${newName})`;
  if (existing) return { id: existing.id, name: existing.name };

  const [{ max_num }] = await sql`
    SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 5) AS INTEGER)), 0) AS max_num
    FROM suppliers WHERE id ~ '^PRV-[0-9]+$' AND tenant_id = ${tenantId}
  `;
  const id = 'PRV-' + String(parseInt(max_num) + 1).padStart(3, '0');
  const [created] = await sql`
    INSERT INTO suppliers (id, tenant_id, name, created_by)
    VALUES (${id}, ${tenantId}, ${newName}, ${actor})
    RETURNING *
  `;
  return { id: created.id, name: created.name };
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
        if (line.total_cost !== undefined && (!isPlainNumber(line.total_cost) || line.total_cost < 0)) {
          return res.status(400).json({ error: `Costo total inválido para ${line.sku}` });
        }
        if (!line.supplier_id && !(line.new_supplier_name || '').trim()) {
          return res.status(400).json({ error: `Selecciona o ingresa un proveedor para ${line.sku}` });
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
          SELECT sku, name, stock, suppliers FROM products
          WHERE sku = ${line.sku} AND warehouse_id = ${wid} AND tenant_id = ${tenantId}
        `;
        if (!product) return res.status(404).json({ error: `Producto no encontrado: ${line.sku}` });

        const supplier = await resolveLineSupplier(sql, tenantId, actor, line);
        if (supplier.error) return res.status(400).json({ error: supplier.error });

        // Si el proveedor elegido no está entre los ya configurados para
        // este SKU, se agrega solo — Ingreso de inventario es justamente
        // donde se "descubren" los proveedores reales de cada producto.
        const currentSuppliers = Array.isArray(product.suppliers) ? product.suppliers : [];
        const suppliersChanged = !currentSuppliers.includes(supplier.id);
        const newSuppliers = suppliersChanged ? [...currentSuppliers, supplier.id] : currentSuppliers;

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
          UPDATE products SET stock = stock + ${unitsAdded}, suppliers = ${JSON.stringify(newSuppliers)}::jsonb, updated_by = ${actor}, updated_at = NOW()
          WHERE sku = ${line.sku} AND warehouse_id = ${wid} AND tenant_id = ${tenantId}
          RETURNING *
        `;
        // El proveedor configurado es una propiedad del producto, no del
        // almacén — se sincroniza a las demás filas (SKUs por almacén) de
        // este mismo sku, igual que Grupo de Productos.
        if (suppliersChanged) {
          await sql`
            UPDATE products SET suppliers = ${JSON.stringify(newSuppliers)}::jsonb
            WHERE sku = ${line.sku} AND tenant_id = ${tenantId} AND warehouse_id != ${wid}
          `;
        }

        const id = 'REC-' + String(++nextNum).padStart(4, '0');
        const [receipt] = await sql`
          INSERT INTO stock_receipts
            (id, tenant_id, sku, warehouse_id, product_name, form_label, factor, qty_purchased, total_cost, units_added, unit_cost, new_avg_cost, remaining_qty, supplier_id, supplier_name, created_by)
          VALUES
            (${id}, ${tenantId}, ${line.sku}, ${wid}, ${product.name}, ${formLabel}, ${factor}, ${line.qty_purchased}, ${totalCost}, ${unitsAdded}, ${unitCost}, ${newCost}, ${unitsAdded}, ${supplier.id}, ${supplier.name}, ${actor})
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
          details:     { id, form_label: formLabel, qty_purchased: line.qty_purchased, factor, units_added: unitsAdded, total_cost: totalCost, product_cost: newCost, supplier_id: supplier.id, supplier_name: supplier.name },
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

    // ── PUT — corrige cantidad/costo de una recepción ya registrada ────────
    // No se puede editar sku/almacén/formato (eso obligaría a deshacer y
    // rehacer el lote) — sólo qty_purchased/total_cost, los datos que se
    // escriben a mano al registrar y donde es fácil equivocarse. factor
    // queda igual que al crear el lote; units_added/unit_cost se recalculan
    // igual que en el POST. El ajuste de stock/remaining_qty es SOLO la
    // diferencia (delta) contra lo que había antes — si el lote ya se
    // consumió parcial o totalmente por ventas, esas unidades vendidas no se
    // tocan (no hay forma de deshacer una venta ya despachada desde acá);
    // sólo se puede bajar la cantidad hasta lo que ya se vendió de este lote,
    // nunca menos.
    if (req.method === 'PUT') {
      const id = req.query?.id;
      if (!id) return res.status(400).json({ error: 'id is required' });
      const { qty_purchased, total_cost } = req.body || {};
      if (qty_purchased !== undefined && (!isPlainNumber(qty_purchased) || qty_purchased <= 0)) {
        return res.status(400).json({ error: 'Cantidad inválida' });
      }
      if (total_cost !== undefined && (!isPlainNumber(total_cost) || total_cost < 0)) {
        return res.status(400).json({ error: 'Costo total inválido' });
      }

      const [existing] = await sql`SELECT * FROM stock_receipts WHERE id = ${id} AND tenant_id = ${tenantId}`;
      if (!existing) return res.status(404).json({ error: 'Ingreso no encontrado' });

      const newQtyPurchased = qty_purchased !== undefined ? qty_purchased : Number(existing.qty_purchased);
      const newTotalCost    = total_cost    !== undefined ? Math.round(total_cost) : existing.total_cost;
      const newUnitsAdded   = Math.floor(newQtyPurchased * Number(existing.factor));
      const newUnitCost     = newUnitsAdded > 0 ? Math.round(newTotalCost / newUnitsAdded) : 0;

      const alreadySold = existing.units_added - existing.remaining_qty;
      if (newUnitsAdded < alreadySold) {
        return res.status(400).json({ error: `No puedes bajar la cantidad por debajo de lo ya vendido de este ingreso (${alreadySold} unidades).` });
      }
      const delta = newUnitsAdded - existing.units_added;
      const newRemainingQty = existing.remaining_qty + delta;

      const [receipt] = await sql`
        UPDATE stock_receipts SET
          qty_purchased = ${newQtyPurchased},
          total_cost    = ${newTotalCost},
          units_added   = ${newUnitsAdded},
          unit_cost     = ${newUnitCost},
          remaining_qty = ${newRemainingQty},
          updated_by    = ${actor},
          updated_at    = NOW()
        WHERE id = ${id} AND tenant_id = ${tenantId}
        RETURNING *
      `;
      const [product] = await sql`
        UPDATE products SET stock = GREATEST(0, stock + ${delta}), updated_by = ${actor}, updated_at = NOW()
        WHERE sku = ${existing.sku} AND warehouse_id = ${existing.warehouse_id} AND tenant_id = ${tenantId}
        RETURNING *
      `;

      await writeLog(sql, {
        tenant_id:   tenantId,
        actor,
        action:      'stock_receipt.editado',
        entity_type: 'producto',
        entity_id:   existing.sku,
        entity_name: `${id} — ${existing.product_name}`,
        details: {
          id,
          before: { qty_purchased: existing.qty_purchased, total_cost: existing.total_cost, units_added: existing.units_added },
          after:  { qty_purchased: newQtyPurchased, total_cost: newTotalCost, units_added: newUnitsAdded },
        },
      });
      if (delta && product) {
        await recordStockMovement(sql, { tenantId, type: 'edicion_ingreso', refType: 'stock_receipt', refId: id, actor },
          { sku: existing.sku, warehouseId: existing.warehouse_id, productName: existing.product_name, delta, unitCost: newUnitCost, stockAfter: product.stock });
      }

      return res.json({ receipt, product });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('stock-receipts error:', err);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = { handleStockReceiptsResource, STOCK_RECEIPT_RESOURCES };
