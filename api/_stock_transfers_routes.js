// api/_stock_transfers_routes.js — Movimientos de Inventario: mueve stock de
// un sku entre 2 almacenes de la MISMA tienda (típicamente abastecimiento →
// venta, para reponer antes de que el almacén de venta llegue a 0 — ver
// warehouses.reorder_threshold/api/_stock_alerts.js — pero no se restringe
// la dirección: cualquier combinación de tipos de almacén de la misma
// tienda es válida).
//
// NO es una Serverless Function (prefijo `_`, mismo motivo que
// _stock_receipts_routes.js) — se invoca desde api/products.js cuando
// `req.query.resource === 'stock-transfers'`.
//
// GET  /api/products?resource=stock-transfers              → historial de traslados
// POST /api/products?resource=stock-transfers               → body
//   { sku, warehouse_id_from, warehouse_id_to, qty }
//
// A diferencia de una venta (que nunca bloquea por falta de stock — es una
// orden de cliente ya en curso), un traslado SÍ bloquea si no alcanza: es
// una acción administrativa deliberada, no hay ninguna venta que perder
// dejándolo fallar (decisión confirmada con el usuario).
const { writeLog } = require('./_log');
const { recordStockMovement, consumeLotsFifo, weightedCost } = require('./_stock');

const STOCK_TRANSFER_RESOURCES = ['stock-transfers'];

async function nextTransferId(sql, tenantId) {
  const [{ max_num }] = await sql`
    SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 5) AS INTEGER)), 0) AS max_num
    FROM stock_transfers WHERE id ~ '^TRF-[0-9]+$' AND tenant_id = ${tenantId}
  `;
  return 'TRF-' + String(parseInt(max_num) + 1).padStart(4, '0');
}

async function handleStockTransfersResource(req, res, sql, session, tenantId, actor) {
  try {
    // ── GET — historial de traslados ────────────────────────────────────────
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT * FROM stock_transfers
        WHERE tenant_id = ${tenantId}
        ORDER BY created_at DESC
        LIMIT 300
      `;
      return res.json(rows);
    }

    // ── POST — trasladar stock ────────────────────────────────────────────
    if (req.method === 'POST') {
      const { sku, warehouse_id_from, warehouse_id_to, qty } = req.body || {};
      if (typeof sku !== 'string' || !sku) return res.status(400).json({ error: 'sku is required' });
      if (!warehouse_id_from || !warehouse_id_to) return res.status(400).json({ error: 'warehouse_id_from y warehouse_id_to son obligatorios' });
      if (warehouse_id_from === warehouse_id_to) return res.status(400).json({ error: 'El almacén de origen y destino deben ser distintos' });
      const qtyInt = Math.trunc(Number(qty));
      if (!Number.isFinite(qtyInt) || qtyInt <= 0) return res.status(400).json({ error: 'qty debe ser un número mayor a 0' });

      const warehouses = await sql`
        SELECT id, name, local_id FROM warehouses WHERE id IN (${warehouse_id_from}, ${warehouse_id_to}) AND tenant_id = ${tenantId}
      `;
      const from = warehouses.find(w => w.id === warehouse_id_from);
      const to   = warehouses.find(w => w.id === warehouse_id_to);
      if (!from || !to) return res.status(404).json({ error: 'Almacén no encontrado' });
      if (from.local_id !== to.local_id) return res.status(400).json({ error: 'Los almacenes deben pertenecer a la misma tienda' });

      const [originProduct] = await sql`
        SELECT sku, name, stock FROM products WHERE sku = ${sku} AND warehouse_id = ${warehouse_id_from} AND tenant_id = ${tenantId}
      `;
      if (!originProduct) return res.status(404).json({ error: `${sku} no tiene stock registrado en ${from.name}` });
      if (originProduct.stock < qtyInt) {
        return res.status(400).json({ error: `Stock insuficiente en ${from.name}: hay ${originProduct.stock}, se pidieron ${qtyInt}` });
      }

      // El producto puede no existir todavía en destino (primer traslado de
      // este sku a ese almacén) — se crea copiando la metadata del origen,
      // con stock 0 inicial (mismo patrón que "agregar almacén a un
      // producto existente" en api/products.js POST con explicitSku).
      let [destProduct] = await sql`
        SELECT sku, name, stock FROM products WHERE sku = ${sku} AND warehouse_id = ${warehouse_id_to} AND tenant_id = ${tenantId}
      `;
      if (!destProduct) {
        const [fullOrigin] = await sql`
          SELECT name, brand, cat, tipo, price, threshold, barcode, groups, stock_unit
          FROM products WHERE sku = ${sku} AND warehouse_id = ${warehouse_id_from} AND tenant_id = ${tenantId}
        `;
        [destProduct] = await sql`
          INSERT INTO products (sku, name, brand, cat, tipo, price, stock, threshold, barcode, groups, created_by, tenant_id, warehouse_id, stock_unit)
          VALUES (${sku}, ${fullOrigin.name}, ${fullOrigin.brand}, ${fullOrigin.cat}, ${fullOrigin.tipo}, ${fullOrigin.price}, 0, ${fullOrigin.threshold}, ${fullOrigin.barcode}, ${JSON.stringify(fullOrigin.groups)}, ${actor}, ${tenantId}, ${warehouse_id_to}, ${fullOrigin.stock_unit})
          RETURNING sku, name, stock
        `;
      }

      const consumed = await consumeLotsFifo(sql, tenantId, sku, warehouse_id_from, qtyInt);
      const { unitCost } = weightedCost(consumed, qtyInt);

      const [originAfter] = await sql`
        UPDATE products SET stock = GREATEST(0, stock - ${qtyInt}), updated_at = NOW()
        WHERE sku = ${sku} AND warehouse_id = ${warehouse_id_from} AND tenant_id = ${tenantId}
        RETURNING stock
      `;
      const [destAfter] = await sql`
        UPDATE products SET stock = stock + ${qtyInt}, updated_at = NOW()
        WHERE sku = ${sku} AND warehouse_id = ${warehouse_id_to} AND tenant_id = ${tenantId}
        RETURNING stock
      `;

      // Lote nuevo en destino, siempre — nunca se mezcla con un lote
      // existente: cada traslado-entrada es, para efectos de FIFO, un
      // evento de "adquisición" nuevo para ESE almacén (se consume después
      // de lo que ya hubiera ahí, igual que una recepción de compra).
      const receiptId = 'TRF-RCV-' + sku + '-' + warehouse_id_to + '-' + Date.now().toString(36);
      await sql`
        INSERT INTO stock_receipts
          (id, tenant_id, sku, warehouse_id, product_name, form_label, factor, qty_purchased, total_cost, units_added, unit_cost, new_avg_cost, remaining_qty, created_by)
        VALUES
          (${receiptId}, ${tenantId}, ${sku}, ${warehouse_id_to}, ${originProduct.name}, ${'Traslado desde ' + from.name}, 1, ${qtyInt}, ${qtyInt * unitCost}, ${qtyInt}, ${unitCost}, ${unitCost}, ${qtyInt}, ${actor})
        ON CONFLICT (id) DO NOTHING
      `;

      const id = await nextTransferId(sql, tenantId);
      const [transfer] = await sql`
        INSERT INTO stock_transfers
          (id, tenant_id, sku, product_name, local_id, warehouse_id_from, warehouse_from_name, warehouse_id_to, warehouse_to_name, qty, unit_cost, created_by)
        VALUES
          (${id}, ${tenantId}, ${sku}, ${originProduct.name}, ${from.local_id}, ${warehouse_id_from}, ${from.name}, ${warehouse_id_to}, ${to.name}, ${qtyInt}, ${unitCost}, ${actor})
        RETURNING *
      `;

      await recordStockMovement(sql, { tenantId, type: 'traslado_salida', refType: 'stock_transfer', refId: id, actor },
        { sku, warehouseId: warehouse_id_from, productName: originProduct.name, delta: -qtyInt, unitCost, stockAfter: originAfter.stock });
      await recordStockMovement(sql, { tenantId, type: 'traslado_entrada', refType: 'stock_transfer', refId: id, actor },
        { sku, warehouseId: warehouse_id_to, productName: originProduct.name, delta: qtyInt, unitCost, stockAfter: destAfter.stock });

      await writeLog(sql, {
        tenant_id: tenantId, actor, action: 'stock.traslado',
        entity_type: 'producto', entity_id: sku, entity_name: `${sku} — ${originProduct.name}`,
        details: { id, from: from.name, to: to.name, qty: qtyInt, unit_cost: unitCost },
      });

      return res.status(201).json({ transfer, origin_stock: originAfter.stock, dest_stock: destAfter.stock });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('stock-transfers error:', err);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = { handleStockTransfersResource, STOCK_TRANSFER_RESOURCES };
