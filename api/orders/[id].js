// api/orders/[id].js — GET /api/orders/:id  PUT /api/orders/:id (update status)
const { getDb } = require('../_db');
const cors = require('../_cors');
const { writeLog } = require('../_log');
const { getSession, resolveTenantId } = require('../_tenant');

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
      const [row] = await sql`SELECT * FROM orders WHERE id = ${id} AND tenant_id = ${tenantId}`;
      if (!row) return res.status(404).json({ error: 'Order not found' });
      return res.json(row);
    }

    // ── PUT — update status OR customer info ─────────────────────────────
    if (req.method === 'PUT') {
      const {
        status, action, cliente, telefono, dedicatoria, receptor, receptor_telefono,
        payment_method, sales_channel, delivery_update, total,
      } = req.body || {};

      // Update customer-facing info fields
      if (action === 'info') {
        // Shallow-merged into the existing delivery jsonb — delivery_update only
        // carries keys the user actually edited (method/date/slot/address), so
        // receptor and anything else already stored is left untouched.
        const deliveryPatch = { receptor: receptor ?? '', receptor_telefono: receptor_telefono ?? '', ...(delivery_update || {}) };
        const [row] = await sql`
          UPDATE orders SET
            cliente        = ${cliente ?? ''},
            telefono       = ${telefono ?? ''},
            dedicatoria    = ${dedicatoria ?? ''},
            delivery       = delivery || ${JSON.stringify(deliveryPatch)}::jsonb,
            payment_method = ${payment_method ?? ''},
            sales_channel  = ${sales_channel ?? ''},
            total          = COALESCE(${total ?? null}, total),
            updated_by     = ${actor},
            updated_at     = NOW()
          WHERE id = ${id} AND tenant_id = ${tenantId}
          RETURNING *
        `;
        if (!row) return res.status(404).json({ error: 'Order not found' });
        await writeLog(sql, {
          tenant_id:   tenantId,
          actor,
          action:      'orden.info_editada',
          entity_type: 'orden',
          entity_id:   id,
          entity_name: `${id} — ${row.cliente}`,
          details:     { cliente: row.cliente, telefono: row.telefono },
        });
        return res.json(row);
      }

      // Update status
      if (!status) return res.status(400).json({ error: 'status or action required' });
      const [current] = await sql`SELECT status, cliente FROM orders WHERE id = ${id} AND tenant_id = ${tenantId}`;
      const [row] = await sql`
        UPDATE orders SET status = ${status}, updated_by = ${actor}, updated_at = NOW()
        WHERE id = ${id} AND tenant_id = ${tenantId} RETURNING *
      `;
      if (!row) return res.status(404).json({ error: 'Order not found' });

      await writeLog(sql, {
        tenant_id:   tenantId,
        actor,
        action:      'orden.estado_cambiado',
        entity_type: 'orden',
        entity_id:   id,
        entity_name: `${id}${current?.cliente ? ' — ' + current.cliente : ''}`,
        details:     { from_status: current?.status, to_status: status },
      });

      return res.json(row);
    }

    // ── DELETE ────────────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const [existing] = await sql`SELECT cliente FROM orders WHERE id = ${id} AND tenant_id = ${tenantId}`;
      if (!existing) return res.status(404).json({ error: 'Order not found' });

      // Delete linked shipment first (if any)
      await sql`DELETE FROM shipments WHERE order_id = ${id} AND tenant_id = ${tenantId}`.catch(() => {});

      await sql`DELETE FROM orders WHERE id = ${id} AND tenant_id = ${tenantId}`;

      await writeLog(sql, {
        tenant_id:   tenantId,
        actor,
        action:      'orden.eliminada',
        entity_type: 'orden',
        entity_id:   id,
        entity_name: `${id}${existing.cliente ? ' — ' + existing.cliente : ''}`,
        details:     { id },
      });

      return res.json({ ok: true, deleted: id });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('orders/[id] error:', err);
    return res.status(500).json({ error: err.message });
  }
};
