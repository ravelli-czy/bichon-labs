// api/orders.js — GET /api/orders  POST /api/orders
// POST: creates order, decrements stock, auto-creates shipment.
const { getDb } = require('./_db');
const cors = require('./_cors');
const { createShipment } = require('./shipments');
const { writeLog } = require('./_log');
const { getSession, resolveTenantId } = require('./_tenant');

async function _deductKit(sql, kitSku, qty, wid, tenantId) {
  const [kit] = await sql`SELECT items FROM kits WHERE sku = ${kitSku} AND warehouse_id = '' AND tenant_id = ${tenantId}`;
  if (!kit?.items) return;
  for (const comp of kit.items) {
    if (comp.type === 'kit') {
      await _deductKit(sql, comp.sku, comp.qty * qty, wid, tenantId);
    } else {
      await sql`UPDATE products SET stock = GREATEST(0, stock - ${comp.qty * qty}), updated_at = NOW()
        WHERE sku = ${comp.sku} AND warehouse_id = ${wid} AND tenant_id = ${tenantId}`;
    }
  }
}

// ── Cost snapshotting ────────────────────────────────────────────────────
// An order item's cost at time of sale isn't tracked automatically (products'
// cost can change later), so we snapshot it into item.cost. These helpers
// resolve a product/KIT's current cost, recursing into nested KITs (a KIT
// built from other KITs via Mesón Creativo) to full depth.
async function _loadCostMaps(sql, tenantId) {
  const products = await sql`SELECT sku, warehouse_id, cost FROM products WHERE tenant_id = ${tenantId}`;
  const kits     = await sql`SELECT sku, items FROM kits WHERE tenant_id = ${tenantId} AND warehouse_id = ''`;
  const productsBySkuWh = new Map(); // "sku|warehouse_id" -> cost
  const productsBySku   = new Map(); // sku -> cost (first match, any warehouse)
  for (const p of products) {
    productsBySkuWh.set(`${p.sku}|${p.warehouse_id || ''}`, p.cost || 0);
    if (!productsBySku.has(p.sku)) productsBySku.set(p.sku, p.cost || 0);
  }
  const kitsBySku = new Map();
  for (const k of kits) kitsBySku.set(k.sku, k.items || []);
  return { productsBySkuWh, productsBySku, kitsBySku };
}
function _productCost({ productsBySkuWh, productsBySku }, sku, warehouseId) {
  const key = `${sku}|${warehouseId || ''}`;
  if (productsBySkuWh.has(key)) return productsBySkuWh.get(key);
  return productsBySku.get(sku) || 0;
}
function _kitUnitCost(maps, kitSku, depth = 0, seen = new Set()) {
  if (depth > 8 || seen.has(kitSku)) return 0;
  seen = new Set(seen); seen.add(kitSku);
  const items = maps.kitsBySku.get(kitSku);
  if (!items) return 0;
  return items.reduce((sum, comp) => {
    const compCost = comp.type === 'kit'
      ? _kitUnitCost(maps, comp.sku, depth + 1, seen)
      : _productCost(maps, comp.sku, comp.warehouse_id);
    return sum + compCost * comp.qty;
  }, 0);
}
function _itemUnitCost(maps, item) {
  return item.type === 'kit'
    ? _kitUnitCost(maps, item.sku)
    : _productCost(maps, item.sku, item.warehouse_id);
}
function _withCostSnapshot(items, maps) {
  return (items || []).map(item => ({ ...item, cost: _itemUnitCost(maps, item) }));
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;

  let sql;
  try { sql = getDb(); }
  catch (err) { return res.status(503).json({ error: err.message }); }

  const session  = await getSession(req);
  const tenantId = resolveTenantId(req, session);
  if (!tenantId) return res.status(401).json({ error: 'No autenticado o sin tenant' });
  const actor = session?.username || 'sistema';

  try {
    // ── GET — list all orders ─────────────────────────────────────────────
    if (req.method === 'GET') {
      const rows = await sql`SELECT * FROM orders WHERE tenant_id = ${tenantId} ORDER BY created_at DESC`;
      return res.json(rows);
    }

    // ── POST ?action=backfill-costs — one-time snapshot of item.cost onto
    // every existing order, using each product/KIT's CURRENT cost. Historical
    // orders never recorded a cost snapshot, so downstream cost/margin
    // calculations were always using today's cost instead of the cost at the
    // time of sale — this backfills a starting point. Admin-only.
    if (req.method === 'POST' && req.query?.action === 'backfill-costs') {
      if (!['admin','superadmin','master'].includes(session.role)) {
        return res.status(403).json({ error: 'No autorizado' });
      }
      const maps = await _loadCostMaps(sql, tenantId);
      const orders = await sql`SELECT id, items FROM orders WHERE tenant_id = ${tenantId}`;
      let ordersUpdated = 0, itemsUpdated = 0;
      for (const order of orders) {
        const items = Array.isArray(order.items) ? order.items : [];
        if (!items.length) continue;
        const newItems = _withCostSnapshot(items, maps);
        await sql`UPDATE orders SET items = ${JSON.stringify(newItems)}::jsonb WHERE id = ${order.id} AND tenant_id = ${tenantId}`;
        ordersUpdated++;
        itemsUpdated += newItems.length;
      }
      await writeLog(sql, {
        tenant_id:   tenantId,
        actor,
        action:      'ordenes.costos_recalculados',
        entity_type: 'orden',
        entity_id:   'bulk',
        entity_name: `${ordersUpdated} órdenes`,
        details:     { ordersUpdated, itemsUpdated },
      });
      return res.json({ ok: true, ordersUpdated, itemsUpdated });
    }

    // ── POST — create order + decrement stock + create shipment ───────────
    if (req.method === 'POST') {
      const {
        cliente = 'Cliente', telefono = '', dedicatoria = '',
        total = 0, items: rawItems = [], delivery = {}, warehouse_id: orderWarehouseId = '',
        payment_method = '', sales_channel = '',
      } = req.body || {};

      if (!rawItems.length) return res.status(400).json({ error: 'items is required' });
      // Snapshot each item's current cost so it survives future cost changes
      const items = _withCostSnapshot(rawItems, await _loadCostMaps(sql, tenantId));

      // ID must be globally unique (orders.id is a plain PK shared across tenants)
      const [{ max_num }] = await sql`
        SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 5) AS INTEGER)), 0) AS max_num
        FROM orders WHERE id ~ '^ORD-[0-9]+$'
      `;
      const id = 'ORD-' + String(parseInt(max_num) + 1).padStart(4, '0');
      const fecha = new Date().toLocaleDateString('es-CL');

      // Insert order
      const [order] = await sql`
        INSERT INTO orders (id, cliente, telefono, total, items, delivery, dedicatoria, fecha, status, created_by, tenant_id, payment_method, sales_channel)
        VALUES (
          ${id}, ${cliente}, ${telefono}, ${total},
          ${JSON.stringify(items)}, ${JSON.stringify(delivery)},
          ${dedicatoria}, ${fecha}, 'por_hacer', ${actor}, ${tenantId}, ${payment_method}, ${sales_channel}
        )
        RETURNING *
      `;

      // Decrement stock for each sold item (scoped to tenant + warehouse)
      for (const item of items) {
        // warehouse_id per item; fall back to order-level warehouse_id
        const wid = item.warehouse_id || orderWarehouseId || '';
        if (item.type === 'kit') {
          await _deductKit(sql, item.sku, item.qty, wid, tenantId);
        } else {
          await sql`
            UPDATE products
            SET stock = GREATEST(0, stock - ${item.qty}), updated_at = NOW()
            WHERE sku = ${item.sku} AND warehouse_id = ${wid} AND tenant_id = ${tenantId}
          `;
        }
      }

      // Auto-create shipment from order data
      let shipment = null;
      try {
        const d = delivery || {};
        shipment = await createShipment(sql, {
          tenant_id:            tenantId,
          order_id:             id,
          created_by:           actor,
          recipient_name:       cliente,
          recipient_phone:      telefono,
          address_street:       d.address_street  || '',
          address_city:         d.address_city    || '',
          address_region:       d.address_region  || '',
          address_notes:        d.address_notes   || '',
          scheduled_date:       d.date            || '',
          delivery_window_from: d.slot_from       || '',
          delivery_window_to:   d.slot_to         || '',
          delivery_method_type: d.method_type     || '',
          delivery_method_label:d.method_label    || '',
        });
      } catch (shipErr) {
        console.error('Shipment creation failed (non-fatal):', shipErr.message);
      }

      // Audit log
      await writeLog(sql, {
        tenant_id:   tenantId,
        actor,
        action:      'orden.creada',
        entity_type: 'orden',
        entity_id:   id,
        entity_name: `${id} — ${cliente}`,
        details:     { id, cliente, total, items_count: items.length },
      });

      // Return updated products + order + shipment so client can sync state
      const updatedProducts = await sql`SELECT * FROM products WHERE tenant_id = ${tenantId} ORDER BY name`;
      return res.status(201).json({ order, updatedProducts, shipment });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('orders error:', err);
    return res.status(500).json({ error: err.message });
  }
};
