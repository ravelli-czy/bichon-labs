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
        discount_pct, discount_amount, refund_amount, label_selections,
      } = req.body || {};

      // Update customer-facing info fields
      if (action === 'info') {
        // Shallow-merged into the existing delivery jsonb — delivery_update only
        // carries keys the user actually edited (method/date/slot/address), so
        // receptor and anything else already stored is left untouched.
        const deliveryPatch = { receptor: receptor ?? '', receptor_telefono: receptor_telefono ?? '', ...(delivery_update || {}) };
        const [before] = await sql`SELECT discount_amount, refund_amount FROM orders WHERE id = ${id} AND tenant_id = ${tenantId}`;
        if (!before) return res.status(404).json({ error: 'Order not found' });
        // label_selections y discount_pct son columnas nuevas (migración vía
        // POST /api/setup) — si todavía no se corrieron en esta base, se
        // sigue de largo sin ellas en vez de romper la edición de órdenes
        // por completo. discount_amount/total ya llevan el descuento
        // aplicado de todas formas; discount_pct solo sirve para repoblar
        // el campo % la próxima vez que se edite la orden.
        let row;
        try {
          [row] = await sql`
            UPDATE orders SET
              cliente          = ${cliente ?? ''},
              telefono         = ${telefono ?? ''},
              dedicatoria      = ${dedicatoria ?? ''},
              delivery         = delivery || ${JSON.stringify(deliveryPatch)}::jsonb,
              payment_method   = ${payment_method ?? ''},
              sales_channel    = ${sales_channel ?? ''},
              total            = COALESCE(${total ?? null}, total),
              discount_pct     = COALESCE(${discount_pct ?? null}, discount_pct),
              discount_amount  = COALESCE(${discount_amount ?? null}, discount_amount),
              refund_amount    = COALESCE(${refund_amount ?? null}, refund_amount),
              label_selections = label_selections || ${JSON.stringify(label_selections || {})}::jsonb,
              updated_by       = ${actor},
              updated_at       = NOW()
            WHERE id = ${id} AND tenant_id = ${tenantId}
            RETURNING *
          `;
        } catch (updateErr) {
          if (updateErr.code !== '42703') throw updateErr;
          console.warn('[orders/[id]] label_selections and/or discount_pct column not migrated yet, retrying without them');
          try {
            [row] = await sql`
              UPDATE orders SET
                cliente          = ${cliente ?? ''},
                telefono         = ${telefono ?? ''},
                dedicatoria      = ${dedicatoria ?? ''},
                delivery         = delivery || ${JSON.stringify(deliveryPatch)}::jsonb,
                payment_method   = ${payment_method ?? ''},
                sales_channel    = ${sales_channel ?? ''},
                total            = COALESCE(${total ?? null}, total),
                discount_amount  = COALESCE(${discount_amount ?? null}, discount_amount),
                refund_amount    = COALESCE(${refund_amount ?? null}, refund_amount),
                label_selections = label_selections || ${JSON.stringify(label_selections || {})}::jsonb,
                updated_by       = ${actor},
                updated_at       = NOW()
              WHERE id = ${id} AND tenant_id = ${tenantId}
              RETURNING *
            `;
          } catch (updateErr2) {
            if (updateErr2.code !== '42703') throw updateErr2;
            [row] = await sql`
              UPDATE orders SET
                cliente          = ${cliente ?? ''},
                telefono         = ${telefono ?? ''},
                dedicatoria      = ${dedicatoria ?? ''},
                delivery         = delivery || ${JSON.stringify(deliveryPatch)}::jsonb,
                payment_method   = ${payment_method ?? ''},
                sales_channel    = ${sales_channel ?? ''},
                total            = COALESCE(${total ?? null}, total),
                discount_amount  = COALESCE(${discount_amount ?? null}, discount_amount),
                refund_amount    = COALESCE(${refund_amount ?? null}, refund_amount),
                updated_by       = ${actor},
                updated_at       = NOW()
              WHERE id = ${id} AND tenant_id = ${tenantId}
              RETURNING *
            `;
          }
        }
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
        // Descuento/devolución alimentan directamente los ingresos netos de
        // Finanzas — se registra un log de auditoría dedicado (con valores
        // antes/después) cada vez que cambian, además del log genérico de
        // edición de info de arriba.
        if (before.discount_amount !== row.discount_amount || before.refund_amount !== row.refund_amount) {
          await writeLog(sql, {
            tenant_id:   tenantId,
            actor,
            action:      'orden.financiero_editado',
            entity_type: 'orden',
            entity_id:   id,
            entity_name: `${id} — ${row.cliente}`,
            details:     {
              discount_amount: { from: before.discount_amount, to: row.discount_amount },
              refund_amount:   { from: before.refund_amount,   to: row.refund_amount   },
            },
          });
        }
        return res.json(row);
      }

      // Update status
      if (!status) return res.status(400).json({ error: 'status or action required' });
      const [current] = await sql`SELECT status, cliente, delivered_at FROM orders WHERE id = ${id} AND tenant_id = ${tenantId}`;
      if (!current) return res.status(404).json({ error: 'Order not found' });
      // La fecha de reconocimiento de ingreso en Finanzas es la fecha real en
      // que la orden queda "entregada" (no la de creación) — se registra una
      // sola vez, la primera vez que la orden alcanza ese estado.
      const setsDeliveredAt = status === 'entregada' && !current.delivered_at;
      const [row] = setsDeliveredAt
        ? await sql`
            UPDATE orders SET status = ${status}, delivered_at = NOW(), updated_by = ${actor}, updated_at = NOW()
            WHERE id = ${id} AND tenant_id = ${tenantId} RETURNING *
          `
        : await sql`
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
