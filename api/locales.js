// api/locales.js — Locales, Almacenes y Formas de entrega
// Todo resuelto con querystring (sin rutas dinámicas [id].js) para no sumar
// más Serverless Functions (tope 12 en Hobby) y evitar el catch-all opcional
// [[...path]].js, que NO está soportado fuera de un proyecto Next.js.
//
// GET    /api/locales                                                              → listar locales (con almacenes y formas de entrega anidadas)
// POST   /api/locales                                                              → crear local
// PUT    /api/locales?id=:id                                                       → editar local
// DELETE /api/locales?id=:id                                                       → eliminar local (cascada: almacenes, formas de entrega, slots)
// POST   /api/locales?id=:id&resource=warehouses                                   → crear almacén
// PUT    /api/locales?id=:id&resource=warehouses&whId=:whId                        → editar almacén
// DELETE /api/locales?id=:id&resource=warehouses&whId=:whId                        → eliminar almacén
// POST   /api/locales?id=:id&resource=delivery-methods                             → crear forma de entrega
// PUT    /api/locales?id=:id&resource=delivery-methods&dmId=:dmId                  → editar forma de entrega
// DELETE /api/locales?id=:id&resource=delivery-methods&dmId=:dmId                  → eliminar forma de entrega (cascada: slots)
// POST   /api/locales?id=:id&resource=delivery-methods&dmId=:dmId&sub=slots        → crear slot
// PUT    /api/locales?id=:id&resource=delivery-methods&dmId=:dmId&sub=slots&slotId=:slotId    → editar slot
// DELETE /api/locales?id=:id&resource=delivery-methods&dmId=:dmId&sub=slots&slotId=:slotId    → eliminar slot

const { getDb } = require('./_db');
const cors = require('./_cors');
const { writeLog } = require('./_log');
const { getSession, resolveTenantId } = require('./_tenant');

async function nextLocalId(sql, tenantId) {
  const [{ max_num }] = await sql`
    SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 5) AS INTEGER)), 0) AS max_num
    FROM locales WHERE id ~ '^LOC-[0-9]+$' AND tenant_id = ${tenantId}
  `;
  return 'LOC-' + String(parseInt(max_num) + 1).padStart(3, '0');
}
async function nextWarehouseId(sql, tenantId) {
  const [{ max_num }] = await sql`
    SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 5) AS INTEGER)), 0) AS max_num
    FROM warehouses WHERE id ~ '^WHS-[0-9]+$' AND tenant_id = ${tenantId}
  `;
  return 'WHS-' + String(parseInt(max_num) + 1).padStart(3, '0');
}
async function nextDeliveryMethodId(sql, tenantId) {
  const [{ max_num }] = await sql`
    SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 5) AS INTEGER)), 0) AS max_num
    FROM delivery_methods WHERE id ~ '^DLM-[0-9]+$' AND tenant_id = ${tenantId}
  `;
  return 'DLM-' + String(parseInt(max_num) + 1).padStart(3, '0');
}

async function fetchLocalesNested(sql, tenantId, onlyLocalId = null) {
  const locales = onlyLocalId
    ? await sql`SELECT * FROM locales WHERE tenant_id = ${tenantId} AND id = ${onlyLocalId}`
    : await sql`SELECT * FROM locales WHERE tenant_id = ${tenantId} ORDER BY created_at ASC`;
  if (!locales.length) return locales.map(mapLocale);

  // Fetch everything for the tenant and match up in JS — avoids relying on
  // array-bind (ANY(...)) support and keeps this to a fixed 4 queries total.
  const warehouses = await sql`SELECT * FROM warehouses WHERE tenant_id = ${tenantId} ORDER BY created_at ASC`;
  const methods     = await sql`SELECT * FROM delivery_methods WHERE tenant_id = ${tenantId} ORDER BY created_at ASC`;
  const slots       = await sql`SELECT * FROM delivery_slots WHERE tenant_id = ${tenantId} ORDER BY day_of_week ASC, time_from ASC`;

  return locales.map(loc => ({
    ...mapLocale(loc),
    warehouses: warehouses.filter(w => w.local_id === loc.id).map(mapWarehouse),
    delivery_methods: methods.filter(m => m.local_id === loc.id).map(m => ({
      ...mapMethod(m),
      slots: slots.filter(s => s.delivery_method_id === m.id).map(mapSlot),
    })),
  }));
}

function mapLocale(l) {
  return {
    id: l.id, name: l.name,
    address_street: l.address_street, address_city: l.address_city, address_region: l.address_region,
    phone: l.phone, email: l.email,
    lat: l.lat !== null && l.lat !== undefined ? Number(l.lat) : null,
    lng: l.lng !== null && l.lng !== undefined ? Number(l.lng) : null,
  };
}
function mapWarehouse(w) {
  return { id: w.id, name: w.name, description: w.description };
}
function mapMethod(m) {
  return {
    id: m.id, name: m.name, type: m.type,
    base_cost: m.base_cost, free_above: m.free_above,
    prep_hours: m.prep_hours, requires_address: m.requires_address,
  };
}
function mapSlot(s) {
  return {
    id: s.id, day_of_week: s.day_of_week, time_from: s.time_from, time_to: s.time_to,
    label: s.label, max_orders: s.max_orders, extra_cost: s.extra_cost,
  };
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

  const { id: localId, resource, whId, dmId, sub, slotId: slotIdRaw } = req.query || {};

  try {
    // ── /api/locales (sin id) ────────────────────────────────────────────
    if (!localId) {
      if (req.method === 'GET') {
        return res.json(await fetchLocalesNested(sql, tenantId));
      }
      if (req.method === 'POST') {
        const {
          name, address_street = '', address_city = '', address_region = '',
          phone = '', email = '', lat = null, lng = null,
        } = req.body || {};
        if (!name) return res.status(400).json({ error: 'name is required' });
        if (!address_street || !address_city) return res.status(400).json({ error: 'address_street and address_city are required' });

        const id = await nextLocalId(sql, tenantId);
        const [row] = await sql`
          INSERT INTO locales (id, tenant_id, name, address_street, address_city, address_region, phone, email, lat, lng, created_by)
          VALUES (${id}, ${tenantId}, ${name}, ${address_street}, ${address_city}, ${address_region}, ${phone}, ${email}, ${lat}, ${lng}, ${actor})
          RETURNING *
        `;
        await writeLog(sql, {
          tenant_id: tenantId, actor, action: 'local.creado',
          entity_type: 'local', entity_id: id, entity_name: name,
          details: { id, name, address_street, address_city },
        });
        return res.status(201).json({ ...mapLocale(row), warehouses: [], delivery_methods: [] });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── /api/locales?id=:id (sin resource) ───────────────────────────────
    if (!resource) {
      if (req.method === 'PUT') {
        const { name, address_street, address_city, address_region, phone, email, lat, lng } = req.body || {};
        const [row] = await sql`
          UPDATE locales SET
            name           = COALESCE(${name           ?? null}, name),
            address_street = COALESCE(${address_street ?? null}, address_street),
            address_city   = COALESCE(${address_city    ?? null}, address_city),
            address_region = COALESCE(${address_region  ?? null}, address_region),
            phone          = COALESCE(${phone           ?? null}, phone),
            email          = COALESCE(${email           ?? null}, email),
            lat            = COALESCE(${lat ?? null}, lat),
            lng            = COALESCE(${lng ?? null}, lng),
            updated_at     = NOW()
          WHERE id = ${localId} AND tenant_id = ${tenantId}
          RETURNING *
        `;
        if (!row) return res.status(404).json({ error: 'Local not found' });
        await writeLog(sql, {
          tenant_id: tenantId, actor, action: 'local.editado',
          entity_type: 'local', entity_id: localId, entity_name: row.name,
          details: { id: localId, name: row.name },
        });
        const [nested] = await fetchLocalesNested(sql, tenantId, localId);
        return res.json(nested);
      }
      if (req.method === 'DELETE') {
        const [row] = await sql`DELETE FROM locales WHERE id = ${localId} AND tenant_id = ${tenantId} RETURNING *`;
        if (!row) return res.status(404).json({ error: 'Local not found' });
        await writeLog(sql, {
          tenant_id: tenantId, actor, action: 'local.eliminado',
          entity_type: 'local', entity_id: localId, entity_name: row.name,
          details: { id: localId, name: row.name },
        });
        return res.json({ ok: true, deleted: localId });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // Everything below requires the parent local to exist within the tenant
    const [parentLocal] = await sql`SELECT id FROM locales WHERE id = ${localId} AND tenant_id = ${tenantId}`;
    if (!parentLocal) return res.status(404).json({ error: 'Local not found' });

    // ── /api/locales?id=:id&resource=warehouses ──────────────────────────
    if (resource === 'warehouses' && !whId) {
      if (req.method === 'POST') {
        const { name, description = '' } = req.body || {};
        if (!name) return res.status(400).json({ error: 'name is required' });
        const id = await nextWarehouseId(sql, tenantId);
        const [row] = await sql`
          INSERT INTO warehouses (id, tenant_id, local_id, name, description)
          VALUES (${id}, ${tenantId}, ${localId}, ${name}, ${description})
          RETURNING *
        `;
        await writeLog(sql, {
          tenant_id: tenantId, actor, action: 'almacen.creado',
          entity_type: 'almacen', entity_id: id, entity_name: name,
          details: { id, name, local_id: localId },
        });
        return res.status(201).json(mapWarehouse(row));
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── /api/locales?id=:id&resource=warehouses&whId=:whId ───────────────
    if (resource === 'warehouses' && whId) {
      if (req.method === 'PUT') {
        const { name, description } = req.body || {};
        const [row] = await sql`
          UPDATE warehouses SET
            name        = COALESCE(${name        ?? null}, name),
            description = COALESCE(${description ?? null}, description)
          WHERE id = ${whId} AND local_id = ${localId} AND tenant_id = ${tenantId}
          RETURNING *
        `;
        if (!row) return res.status(404).json({ error: 'Warehouse not found' });
        await writeLog(sql, {
          tenant_id: tenantId, actor, action: 'almacen.editado',
          entity_type: 'almacen', entity_id: whId, entity_name: row.name,
          details: { id: whId, name: row.name },
        });
        return res.json(mapWarehouse(row));
      }
      if (req.method === 'DELETE') {
        const [row] = await sql`DELETE FROM warehouses WHERE id = ${whId} AND local_id = ${localId} AND tenant_id = ${tenantId} RETURNING *`;
        if (!row) return res.status(404).json({ error: 'Warehouse not found' });
        await writeLog(sql, {
          tenant_id: tenantId, actor, action: 'almacen.eliminado',
          entity_type: 'almacen', entity_id: whId, entity_name: row.name,
          details: { id: whId, name: row.name },
        });
        return res.json({ ok: true, deleted: whId });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── /api/locales?id=:id&resource=delivery-methods (sin dmId) ─────────
    if (resource === 'delivery-methods' && !dmId) {
      if (req.method === 'POST') {
        const {
          name, type = 'home_delivery', base_cost = 0, free_above = null, prep_hours = 2,
        } = req.body || {};
        if (!name) return res.status(400).json({ error: 'name is required' });
        const requires_address = type !== 'store_pickup';
        const id = await nextDeliveryMethodId(sql, tenantId);
        const [row] = await sql`
          INSERT INTO delivery_methods (id, tenant_id, local_id, name, type, base_cost, free_above, prep_hours, requires_address)
          VALUES (${id}, ${tenantId}, ${localId}, ${name}, ${type}, ${base_cost}, ${free_above}, ${prep_hours}, ${requires_address})
          RETURNING *
        `;
        await writeLog(sql, {
          tenant_id: tenantId, actor, action: 'forma_entrega.creada',
          entity_type: 'delivery_method', entity_id: id, entity_name: name,
          details: { id, name, type, local_id: localId },
        });
        return res.status(201).json({ ...mapMethod(row), slots: [] });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── /api/locales?id=:id&resource=delivery-methods&dmId=:dmId (sin sub) ─
    if (resource === 'delivery-methods' && dmId && !sub) {
      if (req.method === 'PUT') {
        const { name, type, base_cost, free_above, prep_hours } = req.body || {};
        if (!name || !type) return res.status(400).json({ error: 'name and type are required' });
        const requires_address = type !== 'store_pickup';
        const [row] = await sql`
          UPDATE delivery_methods SET
            name             = ${name},
            type             = ${type},
            base_cost        = ${base_cost ?? 0},
            free_above       = ${free_above ?? null},
            prep_hours       = ${prep_hours ?? 2},
            requires_address = ${requires_address}
          WHERE id = ${dmId} AND local_id = ${localId} AND tenant_id = ${tenantId}
          RETURNING *
        `;
        if (!row) return res.status(404).json({ error: 'Delivery method not found' });
        await writeLog(sql, {
          tenant_id: tenantId, actor, action: 'forma_entrega.editada',
          entity_type: 'delivery_method', entity_id: dmId, entity_name: row.name,
          details: { id: dmId, name: row.name },
        });
        const slots = await sql`SELECT * FROM delivery_slots WHERE delivery_method_id = ${dmId} AND tenant_id = ${tenantId} ORDER BY day_of_week ASC, time_from ASC`;
        return res.json({ ...mapMethod(row), slots: slots.map(mapSlot) });
      }
      if (req.method === 'DELETE') {
        const [row] = await sql`DELETE FROM delivery_methods WHERE id = ${dmId} AND local_id = ${localId} AND tenant_id = ${tenantId} RETURNING *`;
        if (!row) return res.status(404).json({ error: 'Delivery method not found' });
        await writeLog(sql, {
          tenant_id: tenantId, actor, action: 'forma_entrega.eliminada',
          entity_type: 'delivery_method', entity_id: dmId, entity_name: row.name,
          details: { id: dmId, name: row.name },
        });
        return res.json({ ok: true, deleted: dmId });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── /api/locales?...&resource=delivery-methods&dmId=:dmId&sub=slots ──
    if (resource === 'delivery-methods' && dmId && sub === 'slots') {
      const [parentMethod] = await sql`SELECT id FROM delivery_methods WHERE id = ${dmId} AND local_id = ${localId} AND tenant_id = ${tenantId}`;
      if (!parentMethod) return res.status(404).json({ error: 'Delivery method not found' });

      if (!slotIdRaw) {
        if (req.method === 'POST') {
          const { day_of_week, time_from, time_to, label = '', max_orders = 20, extra_cost = 0 } = req.body || {};
          if (day_of_week === undefined || day_of_week === null) return res.status(400).json({ error: 'day_of_week is required' });
          if (!time_from || !time_to) return res.status(400).json({ error: 'time_from and time_to are required' });
          const [row] = await sql`
            INSERT INTO delivery_slots (tenant_id, delivery_method_id, day_of_week, time_from, time_to, label, max_orders, extra_cost)
            VALUES (${tenantId}, ${dmId}, ${day_of_week}, ${time_from}, ${time_to}, ${label}, ${max_orders}, ${extra_cost})
            RETURNING *
          `;
          await writeLog(sql, {
            tenant_id: tenantId, actor, action: 'slot.creado',
            entity_type: 'delivery_slot', entity_id: String(row.id), entity_name: `${dmId} — ${label}`,
            details: { id: row.id, delivery_method_id: dmId, day_of_week, time_from, time_to },
          });
          return res.status(201).json(mapSlot(row));
        }
        return res.status(405).json({ error: 'Method not allowed' });
      }

      const slotId = Number(slotIdRaw);
      if (!Number.isInteger(slotId)) return res.status(400).json({ error: 'Invalid slot id' });

      if (req.method === 'PUT') {
        const { day_of_week, time_from, time_to, label, max_orders, extra_cost } = req.body || {};
        const [row] = await sql`
          UPDATE delivery_slots SET
            day_of_week = COALESCE(${day_of_week ?? null}, day_of_week),
            time_from   = COALESCE(${time_from   ?? null}, time_from),
            time_to     = COALESCE(${time_to     ?? null}, time_to),
            label       = COALESCE(${label       ?? null}, label),
            max_orders  = COALESCE(${max_orders  ?? null}, max_orders),
            extra_cost  = COALESCE(${extra_cost  ?? null}, extra_cost)
          WHERE id = ${slotId} AND delivery_method_id = ${dmId} AND tenant_id = ${tenantId}
          RETURNING *
        `;
        if (!row) return res.status(404).json({ error: 'Slot not found' });
        await writeLog(sql, {
          tenant_id: tenantId, actor, action: 'slot.editado',
          entity_type: 'delivery_slot', entity_id: String(slotId), entity_name: `${dmId} — ${row.label}`,
          details: { id: slotId, delivery_method_id: dmId },
        });
        return res.json(mapSlot(row));
      }
      if (req.method === 'DELETE') {
        const [row] = await sql`DELETE FROM delivery_slots WHERE id = ${slotId} AND delivery_method_id = ${dmId} AND tenant_id = ${tenantId} RETURNING *`;
        if (!row) return res.status(404).json({ error: 'Slot not found' });
        await writeLog(sql, {
          tenant_id: tenantId, actor, action: 'slot.eliminado',
          entity_type: 'delivery_slot', entity_id: String(slotId), entity_name: `${dmId} — ${row.label}`,
          details: { id: slotId, delivery_method_id: dmId },
        });
        return res.json({ ok: true, deleted: slotId });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    return res.status(404).json({ error: 'Not found' });
  } catch (err) {
    console.error('locales error:', err);
    return res.status(500).json({ error: err.message });
  }
};
