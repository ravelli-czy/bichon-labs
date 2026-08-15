// api/shipments/[id].js — GET/PUT /api/shipments/:id
const { getDb } = require('../_db');
const cors = require('../_cors');
const { writeLog } = require('../_log');
const { getSession, resolveTenantId } = require('../_tenant');

const STATUS_META = {
  ready:         { next: ['on_the_way'] },
  on_the_way:    { next: ['delivered', 'not_delivered'] },
  delivered:     { next: [] },
  not_delivered: { next: ['ready'] },
};

// Shipment status → order status mapping
const SHIPMENT_TO_ORDER = {
  on_the_way:    'en_camino',
  delivered:     'entregada',
  not_delivered: 'no_entregada',
  ready:         'lista_para_enviar',
};

module.exports = async (req, res) => {
  if (cors(req, res)) return;

  let sql;
  try { sql = getDb(); }
  catch (err) { return res.status(503).json({ error: err.message }); }

  const session  = await getSession(req);
  const tenantId = resolveTenantId(req, session);
  if (!tenantId) return res.status(401).json({ error: 'No autenticado o sin tenant' });
  const actor = session?.username || 'sistema';

  const { id } = req.query;

  try {
    // ── GET ───────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const [row] = await sql`SELECT * FROM shipments WHERE id = ${id} AND tenant_id = ${tenantId}`;
      if (!row) return res.status(404).json({ error: 'Shipment not found' });
      return res.json(row);
    }

    // ── PUT — update status, courier, notes, or address ──────────────────
    if (req.method === 'PUT') {
      const { action, status, courier_id, notes, note,
              address_street, address_city, address_region, address_notes,
              photo_url, lat, lng,
              scheduled_date, delivery_window_from, delivery_window_to } = req.body || {};

      // Geo coordinates update
      if (action === 'geo') {
        const { lat, lng } = req.body || {};
        if (lat == null || lng == null) return res.status(400).json({ error: 'lat and lng required' });
        // Ensure columns exist (idempotent)
        await sql`ALTER TABLE shipments ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION`.catch(() => {});
        await sql`ALTER TABLE shipments ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION`.catch(() => {});
        const [row] = await sql`
          UPDATE shipments SET
            lat        = ${lat},
            lng        = ${lng},
            updated_by = ${actor},
            updated_at = NOW()
          WHERE id = ${id} AND tenant_id = ${tenantId}
          RETURNING *
        `;
        if (!row) return res.status(404).json({ error: 'Shipment not found' });
        await writeLog(sql, {
          tenant_id: tenantId, actor, action: 'envio.geo_asignada',
          entity_type: 'envio', entity_id: id, entity_name: id,
          details: { lat, lng },
        });
        return res.json(row);
      }

      // Address update
      if (action === 'address') {
        const [row] = await sql`
          UPDATE shipments SET
            address_street = ${address_street ?? ''},
            address_city   = ${address_city   ?? ''},
            address_region = ${address_region ?? ''},
            address_notes  = ${address_notes  ?? ''},
            updated_by     = ${actor},
            updated_at     = NOW()
          WHERE id = ${id} AND tenant_id = ${tenantId}
          RETURNING *
        `;
        if (!row) return res.status(404).json({ error: 'Shipment not found' });

        // Sync address to linked order's delivery JSONB
        if (row.order_id) {
          await sql`
            UPDATE orders SET
              delivery   = delivery || ${JSON.stringify({
                address_street:  address_street  ?? '',
                address_city:    address_city    ?? '',
                address_region:  address_region  ?? '',
                address_notes:   address_notes   ?? '',
              })}::jsonb,
              updated_by = ${actor},
              updated_at = NOW()
            WHERE id = ${row.order_id} AND tenant_id = ${tenantId}
          `.catch(err => console.error('Order address sync failed (non-fatal):', err.message));
        }

        await writeLog(sql, {
          tenant_id:   tenantId,
          actor,
          action:      'envio.direccion_editada',
          entity_type: 'envio',
          entity_id:   id,
          entity_name: id,
          details:     { address_street, address_city, address_region, order_id: row.order_id || null },
        });
        return res.json(row);
      }

      const [current] = await sql`SELECT * FROM shipments WHERE id = ${id} AND tenant_id = ${tenantId}`;
      if (!current) return res.status(404).json({ error: 'Shipment not found' });

      // Append history entry if status is changing
      let history = Array.isArray(current.history) ? current.history : [];
      const newStatus = status || current.status;
      if (status && status !== current.status) {
        history = [...history, {
          to_status: status,
          note: note || (STATUS_META[status] ? `Estado actualizado a ${status}` : 'Actualizado'),
          created_at: new Date().toISOString(),
        }];
      }

      const attempts = (status === 'not_delivered')
        ? (current.attempts || 0) + 1
        : current.attempts;

      // La foto de entrega y la coordenada GPS que el repartidor captura al
      // marcar "Entregado" antes no viajaban en este PUT — se quedaban solo
      // en el estado local del navegador, así que la prueba de entrega nunca
      // llegaba al servidor. Las columnas se aseguran de forma idempotente
      // ACÁ (igual que hace `action: 'geo'` más arriba) porque el UPDATE de
      // abajo siempre las referencia, tenga o no photo_url/lat/lng este PUT
      // en particular — sin esto, cualquier cambio de estado fallaría en una
      // base donde nunca antes se hubiera llamado con esos campos.
      await sql`ALTER TABLE shipments ADD COLUMN IF NOT EXISTS photo_url TEXT`.catch(() => {});
      await sql`ALTER TABLE shipments ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION`.catch(() => {});
      await sql`ALTER TABLE shipments ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION`.catch(() => {});

      const [row] = await sql`
        UPDATE shipments SET
          status               = COALESCE(${newStatus  ?? null}, status),
          courier_id           = COALESCE(${courier_id ?? null}, courier_id),
          notes                = COALESCE(${notes      ?? null}, notes),
          attempts             = ${attempts},
          history              = ${JSON.stringify(history)}::jsonb,
          photo_url            = COALESCE(${photo_url ?? null}, photo_url),
          lat                  = COALESCE(${lat ?? null}, lat),
          lng                  = COALESCE(${lng ?? null}, lng),
          scheduled_date       = COALESCE(${scheduled_date       ?? null}, scheduled_date),
          delivery_window_from = COALESCE(${delivery_window_from ?? null}, delivery_window_from),
          delivery_window_to   = COALESCE(${delivery_window_to   ?? null}, delivery_window_to),
          updated_by = ${actor},
          updated_at = NOW()
        WHERE id = ${id} AND tenant_id = ${tenantId}
        RETURNING *
      `;

      // Audit log when status changes
      if (status && status !== current.status) {
        await writeLog(sql, {
          tenant_id:   tenantId,
          actor,
          action:      'envio.estado_cambiado',
          entity_type: 'envio',
          entity_id:   id,
          entity_name: row.order_id ? `${id} (${row.order_id})` : id,
          details:     { from_status: current.status, to_status: status, order_id: row.order_id || null },
        });
      }

      // Sync order status when shipment status changes
      if (status && status !== current.status && row.order_id) {
        const orderStatus = SHIPMENT_TO_ORDER[status];
        const isReschedule = status === 'ready' && current.status === 'not_delivered';
        if (orderStatus && (status !== 'ready' || isReschedule)) {
          // Igual que en api/orders/[id].js: delivered_at es la fecha real en
          // que la orden queda "entregada" — Finanzas solo reconoce ingresos
          // de órdenes con delivered_at seteado, así que también hay que
          // fijarlo acá (antes solo se hacía si el estado se cambiaba directo
          // por PUT /api/orders/:id, dejando huérfanas las entregas marcadas
          // desde el envío/ruteo).
          const setsDeliveredAt = orderStatus === 'entregada';
          await sql`
            UPDATE orders SET
              status       = ${orderStatus},
              delivered_at = CASE WHEN ${setsDeliveredAt} AND delivered_at IS NULL THEN NOW() ELSE delivered_at END
            WHERE id = ${row.order_id} AND tenant_id = ${tenantId}
          `.catch(err => console.error('Order sync failed (non-fatal):', err.message));
        }
      }

      return res.json(row);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('shipments/[id] error:', err);
    return res.status(500).json({ error: err.message });
  }
};
