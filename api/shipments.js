// api/shipments.js — GET /api/shipments  POST /api/shipments
const { getDb } = require('./_db');
const cors = require('./_cors');
const { getSession, resolveTenantId } = require('./_tenant');

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
    // ── Named routes stored in tenant settings ────────────────────────────
    if (req.query?.action === 'routes') {
      if (req.method === 'GET') {
        const rows = await sql`SELECT settings FROM tenants WHERE id = ${tenantId}`;
        const routes = rows[0]?.settings?.named_routes || [];
        return res.json(routes);
      }
      if (req.method === 'POST') {
        const { routes } = req.body || {};
        if (!Array.isArray(routes)) return res.status(400).json({ error: 'routes array required' });
        await sql`UPDATE tenants SET settings = jsonb_set(COALESCE(settings,'{}'), '{named_routes}', ${JSON.stringify(routes)}::jsonb) WHERE id = ${tenantId}`;
        return res.json({ ok: true });
      }
    }

    // ── GET — list shipments (optionally filtered by ?order_id=) ─────────
    if (req.method === 'GET') {
      const { order_id } = req.query || {};
      const rows = order_id
        ? await sql`SELECT * FROM shipments WHERE order_id = ${order_id} AND tenant_id = ${tenantId} ORDER BY created_at DESC`
        : await sql`SELECT * FROM shipments WHERE tenant_id = ${tenantId} ORDER BY created_at DESC`;
      return res.json(rows);
    }

    // ── POST — create shipment manually ──────────────────────────────────
    if (req.method === 'POST') {
      const body = req.body || {};
      const shipment = await createShipment(sql, { ...body, tenant_id: tenantId, created_by: actor });
      return res.status(201).json(shipment);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('shipments error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// Shared helper — also called from orders.js
async function createShipment(sql, {
  tenant_id = '',
  order_id = '',
  created_by = '',
  courier_id = '',
  recipient_name = '',
  recipient_phone = '',
  address_street = '',
  address_city = '',
  address_region = '',
  address_notes = '',
  scheduled_date = '',
  delivery_window_from = '',
  delivery_window_to = '',
  delivery_method_type = '',
  delivery_method_label = '',
  shipping_cost = 0,
  notes = '',
}) {
  // ID must be globally unique (shipments.id is a plain PK shared across tenants)
  const [{ max_num }] = await sql`
    SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 5) AS INTEGER)), 0) AS max_num
    FROM shipments WHERE id ~ '^SHP-[0-9]+$'
  `;
  const id = 'SHP-' + String(parseInt(max_num) + 1).padStart(3, '0');

  const tracking_code = 'SF' + Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g,'').substring(0, 8).padEnd(8,'0');
  const history = JSON.stringify([{
    to_status: 'ready',
    note: order_id ? `Envío creado automáticamente desde orden ${order_id}` : 'Envío creado',
    created_at: new Date().toISOString(),
  }]);

  const [row] = await sql`
    INSERT INTO shipments (
      id, order_id, courier_id, tracking_code,
      recipient_name, recipient_phone,
      address_street, address_city, address_region, address_notes,
      scheduled_date, delivery_window_from, delivery_window_to,
      delivery_method_type, delivery_method_label,
      status, shipping_cost, attempts, notes, history, created_by, tenant_id
    ) VALUES (
      ${id}, ${order_id}, ${courier_id}, ${tracking_code},
      ${recipient_name}, ${recipient_phone},
      ${address_street}, ${address_city}, ${address_region}, ${address_notes},
      ${scheduled_date}, ${delivery_window_from}, ${delivery_window_to},
      ${delivery_method_type}, ${delivery_method_label},
      'ready', ${shipping_cost}, 0, ${notes}, ${history}::jsonb, ${created_by}, ${tenant_id}
    ) RETURNING *
  `;
  return row;
}

module.exports.createShipment = createShipment;
