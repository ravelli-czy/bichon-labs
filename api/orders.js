// api/orders.js — GET /api/orders  POST /api/orders
// POST: creates order, decrements stock, auto-creates shipment.
const { getDb } = require('./_db');
const cors = require('./_cors');
const { createShipment } = require('./shipments');
const { writeLog } = require('./_log');
const { getSession, resolveTenantId } = require('./_tenant');
const { loadCostMaps, withFinancialSnapshot } = require('./_finance');
const { handleFinanceResource, FINANCE_RESOURCES } = require('./_finance_routes');

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
// cost can change later), so we snapshot it at creation time. `withFinancialSnapshot`
// (api/_finance.js) resolves each product/KIT's current cost, recursing into
// nested KITs (a KIT built from other KITs via Mesón Creativo) to full depth,
// and attaches the full financial snapshot the Finanzas module relies on
// (unitCostAtSale, totalCostAtSale, etc.) without touching the existing keys.
const _loadCostMaps = loadCostMaps;
const _withCostSnapshot = withFinancialSnapshot;

module.exports = async (req, res) => {
  if (cors(req, res)) return;

  let sql;
  try { sql = getDb(); }
  catch (err) { return res.status(503).json({ error: err.message }); }

  const session  = await getSession(req);
  const tenantId = resolveTenantId(req, session);
  if (!tenantId) return res.status(401).json({ error: 'No autenticado o sin tenant' });
  const actor = session?.username || 'sistema';

  // ── Finanzas: resumen, estado de resultados, gastos, categorías ────────
  // Vive en api/_finance_routes.js (NO es una Serverless Function propia) y
  // se despacha desde acá para no sumar un archivo nuevo bajo api/ — el
  // proyecto ya estaba en el tope de 12 Serverless Functions del plan Hobby
  // de Vercel (ver comentarios en products.js/locales.js/users.js) y un
  // api/finance.js aparte lo hacía saltar a 13, lo que rompió el deploy.
  if (FINANCE_RESOURCES.includes(req.query?.resource)) {
    return handleFinanceResource(req, res, sql, session, tenantId, actor);
  }

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
        discount_amount = 0, refund_amount = 0,
      } = req.body || {};

      if (!rawItems.length) return res.status(400).json({ error: 'items is required' });
      // Snapshot each item's current cost (and full financial snapshot for
      // Finanzas) so it survives future cost/price changes
      const items = _withCostSnapshot(rawItems, await _loadCostMaps(sql, tenantId));

      // ID must be globally unique (orders.id is a plain PK shared across tenants)
      const [{ max_num }] = await sql`
        SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 5) AS INTEGER)), 0) AS max_num
        FROM orders WHERE id ~ '^ORD-[0-9]+$'
      `;
      const id = 'ORD-' + String(parseInt(max_num) + 1).padStart(4, '0');
      const fecha = new Date().toLocaleDateString('es-CL');

      // Best-effort location for Finanzas filtering: orders don't carry their
      // own local/sucursal, only a warehouse per item — resolve it from the
      // first item's (or order-level) warehouse_id via warehouses.local_id.
      let locationId = '';
      const firstWarehouseId = rawItems.find(i => i.warehouse_id)?.warehouse_id || orderWarehouseId || '';
      if (firstWarehouseId) {
        try {
          const [wh] = await sql`SELECT local_id FROM warehouses WHERE id = ${firstWarehouseId} AND tenant_id = ${tenantId}`;
          locationId = wh?.local_id || '';
        } catch { /* non-fatal — location filter just won't apply to this order */ }
      }

      // Insert order
      const [order] = await sql`
        INSERT INTO orders (
          id, cliente, telefono, total, items, delivery, dedicatoria, fecha, status,
          created_by, tenant_id, payment_method, sales_channel,
          discount_amount, refund_amount, location_id
        )
        VALUES (
          ${id}, ${cliente}, ${telefono}, ${total},
          ${JSON.stringify(items)}, ${JSON.stringify(delivery)},
          ${dedicatoria}, ${fecha}, 'por_hacer', ${actor}, ${tenantId}, ${payment_method}, ${sales_channel},
          ${discount_amount || 0}, ${refund_amount || 0}, ${locationId}
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
