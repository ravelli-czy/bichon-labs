// api/orders/[id].js — GET /api/orders/:id  PUT /api/orders/:id (update status)
const { getDb } = require('../_db');
const cors = require('../_cors');
const { writeLog } = require('../_log');
const { getSession, resolveTenantId } = require('../_tenant');
const { claimCoupon, releaseCoupon, computeDiscountAmount, normalizeCode } = require('../_coupons');
const { loadCostMaps, withFinancialSnapshot } = require('../_finance');
const { deductStockForItems, restoreStockForItems } = require('../_stock');

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
        payment_method, sales_channel, location_id, delivery_update,
        coupon_code, refund_amount, label_selections, items: rawItems,
      } = req.body || {};

      // ── Pre Compra "Confirmando": editar productos (agregar/quitar) ───────
      // Solo se permite mientras la orden está en 'confirmando' — es la única
      // pantalla que ofrece este botón. Reconcilia el stock ya descontado al
      // crear la orden contra los items nuevos (solo ajusta el delta, no
      // restaura+rededuce todo), y opcionalmente transiciona el estado en la
      // misma llamada (ver saveOrderEdit → 'Confirmar Compra' en el frontend,
      // que manda status:'por_hacer' junto con los items finales).
      if (action === 'items') {
        if (!Array.isArray(rawItems) || !rawItems.length) {
          return res.status(400).json({ error: 'items is required' });
        }
        const [before] = await sql`SELECT items, delivery, discount_amount, status, location_id FROM orders WHERE id = ${id} AND tenant_id = ${tenantId}`;
        if (!before) return res.status(404).json({ error: 'Order not found' });
        if (before.status !== 'confirmando') {
          return res.status(400).json({ error: 'Solo se pueden editar productos mientras la orden está en Confirmando' });
        }

        const items = withFinancialSnapshot(rawItems, await loadCostMaps(sql, tenantId));

        // Diff contra los items anteriores para solo mover el delta de stock
        // (no restaurar todo y volver a descontar todo), agrupando por
        // sku+type+warehouse_id igual que hace el picker de productos.
        const keyOf = i => `${i.type || 'product'}:${i.sku}:${i.warehouse_id || ''}`;
        const oldMap = new Map((before.items || []).map(i => [keyOf(i), i]));
        const newMap = new Map(items.map(i => [keyOf(i), i]));
        const toDeduct = [], toRestore = [];
        for (const [key, item] of newMap) {
          const delta = (item.qty || 0) - (oldMap.get(key)?.qty || 0);
          if (delta > 0) toDeduct.push({ ...item, qty: delta });
          else if (delta < 0) toRestore.push({ ...item, qty: -delta });
        }
        for (const [key, item] of oldMap) {
          if (!newMap.has(key)) toRestore.push(item);
        }
        const locationId = before.location_id || '';
        // Los ítems recién deducidos acá (delta positivo) reciben el costo
        // REAL de los lotes FIFO que se acaban de consumir — más preciso que
        // el "costo actual" que traían del snapshot de arriba. Los que no
        // cambiaron de cantidad (o se restituyen) se quedan con esa
        // estimación: no hay una consumición nueva de la cual tomar el dato.
        if (toDeduct.length) {
          const deductResults = await deductStockForItems(sql, toDeduct, tenantId, '', locationId);
          toDeduct.forEach((deductedItem, i) => {
            const target = items.find(it => keyOf(it) === keyOf(deductedItem));
            const result = deductResults[i];
            if (!target || !result) return;
            // Aplica el costo unitario real (de la porción recién deducida) a
            // toda la línea — más simple que mezclarlo con el costo estimado
            // que ya traía la porción previa, y siempre más preciso que la
            // estimación genérica que reemplaza.
            target.unitCostAtSale  = result.unitCost;
            target.cost            = result.unitCost;
            target.totalCostAtSale = Math.round((result.unitCost || 0) * (target.qty || 0) * 100) / 100;
            if (target.type === 'kit' && result.components) target.componentBreakdown = result.components;
          });
        }
        if (toRestore.length) await restoreStockForItems(sql, toRestore, tenantId, '', locationId);

        const itemsSubtotal = items.reduce((s, i) => s + (i.price || 0) * (i.qty || 0), 0);
        const shippingRevenue = before.delivery?.slot_cost || 0;
        const total = itemsSubtotal - (before.discount_amount || 0) + shippingRevenue;
        const nextStatus = status || before.status;

        const [row] = await sql`
          UPDATE orders SET
            items      = ${JSON.stringify(items)},
            total      = ${total},
            status     = ${nextStatus},
            updated_by = ${actor},
            updated_at = NOW()
          WHERE id = ${id} AND tenant_id = ${tenantId}
          RETURNING *
        `;
        if (!row) return res.status(404).json({ error: 'Order not found' });

        await writeLog(sql, {
          tenant_id:   tenantId,
          actor,
          action:      'orden.items_editados',
          entity_type: 'orden',
          entity_id:   id,
          entity_name: `${id} — ${row.cliente}`,
          details:     { items_count: items.length, total, from_status: before.status, to_status: nextStatus },
        });

        const updatedProducts = await sql`SELECT * FROM products WHERE tenant_id = ${tenantId} ORDER BY name`;
        return res.json({ order: row, updatedProducts });
      }

      // Update customer-facing info fields
      if (action === 'info') {
        // Shallow-merged into the existing delivery jsonb — delivery_update only
        // carries keys the user actually edited (method/date/slot/address), so
        // receptor and anything else already stored is left untouched.
        const deliveryPatch = { receptor: receptor ?? '', receptor_telefono: receptor_telefono ?? '', ...(delivery_update || {}) };
        // coupon_id/coupon_code are newer columns — fall back to a select
        // without them if that migration hasn't run yet, so a pending
        // migration never blocks editing an order (the cupón just can't be
        // changed on this edit until it does).
        let before;
        try {
          [before] = await sql`SELECT items, delivery, coupon_id, coupon_code, discount_amount, refund_amount FROM orders WHERE id = ${id} AND tenant_id = ${tenantId}`;
        } catch (selErr) {
          if (selErr.code !== '42703') throw selErr;
          [before] = await sql`SELECT items, delivery, discount_amount, refund_amount FROM orders WHERE id = ${id} AND tenant_id = ${tenantId}`;
          if (before) { before.coupon_id = null; before.coupon_code = ''; }
        }
        if (!before) return res.status(404).json({ error: 'Order not found' });

        // Cupón: '' = sin cupón. Sólo se reclama/libera si el código deseado
        // difiere del que la orden ya tenía — reclama el nuevo ANTES de
        // liberar el viejo, así un código inválido nunca deja la orden sin
        // el cupón que ya tenía. total se recalcula siempre acá (nunca se
        // confía en un total del cliente), a partir del subtotal real de
        // items guardado en la orden.
        const itemsSubtotal = (before.items || []).reduce((s, i) => s + (i.price || 0) * (i.qty || 0), 0);
        const beforeCode = before.coupon_code || '';
        const desiredCode = normalizeCode(coupon_code ?? '');
        let couponId = before.coupon_id || null;
        let couponCodeFinal = beforeCode;
        let discountAmount = before.discount_amount || 0;
        if (desiredCode !== beforeCode) {
          let claimed = null;
          if (desiredCode) {
            claimed = await claimCoupon(sql, tenantId, desiredCode);
            if (!claimed) return res.status(400).json({ error: 'Cupón inválido, inactivo o agotado' });
          }
          if (before.coupon_id) await releaseCoupon(sql, tenantId, before.coupon_id);
          couponId = claimed ? claimed.id : null;
          couponCodeFinal = claimed ? claimed.code : '';
          discountAmount = claimed ? computeDiscountAmount(claimed, itemsSubtotal) : 0;
        }
        const shippingRevenue = (delivery_update && delivery_update.slot_cost !== undefined)
          ? delivery_update.slot_cost
          : (before.delivery?.slot_cost || 0);
        const total = itemsSubtotal - discountAmount + shippingRevenue;

        // label_selections y coupon_id/coupon_code son columnas nuevas
        // (migración vía POST /api/setup) — si todavía no se corrieron en
        // esta base, se sigue de largo sin ellas en vez de romper la edición
        // de órdenes por completo. discount_amount/total ya llevan el
        // descuento aplicado de todas formas.
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
              location_id      = ${location_id ?? ''},
              total            = ${total},
              coupon_id        = ${couponId},
              coupon_code      = ${couponCodeFinal},
              discount_amount  = ${discountAmount},
              refund_amount    = COALESCE(${refund_amount ?? null}, refund_amount),
              label_selections = label_selections || ${JSON.stringify(label_selections || {})}::jsonb,
              updated_by       = ${actor},
              updated_at       = NOW()
            WHERE id = ${id} AND tenant_id = ${tenantId}
            RETURNING *
          `;
        } catch (updateErr) {
          if (updateErr.code !== '42703') throw updateErr;
          console.warn('[orders/[id]] label_selections and/or coupon_id/coupon_code column not migrated yet, retrying without them');
          try {
            [row] = await sql`
              UPDATE orders SET
                cliente          = ${cliente ?? ''},
                telefono         = ${telefono ?? ''},
                dedicatoria      = ${dedicatoria ?? ''},
                delivery         = delivery || ${JSON.stringify(deliveryPatch)}::jsonb,
                payment_method   = ${payment_method ?? ''},
                sales_channel    = ${sales_channel ?? ''},
                location_id      = ${location_id ?? ''},
                total            = ${total},
                discount_amount  = ${discountAmount},
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
                location_id      = ${location_id ?? ''},
                total            = ${total},
                discount_amount  = ${discountAmount},
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
              coupon_code:     { from: beforeCode, to: couponCodeFinal },
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
      // ?restoreStock=1 — caller (see sheet-eliminar-orden in el frontend)
      // must choose explicitly what to do with the stock consumed by this
      // order (and its KIT components): give it back, or leave it deducted
      // and treat this sale as a loss. Either way the order — and its
      // amount — disappears from every sales indicator, since those are
      // all computed live from the `orders` table.
      const restoreStock = req.query.restoreStock === '1' || req.query.restoreStock === 'true';

      // coupon_id is a newer column (migration via POST /api/setup) — fall
      // back to a select without it if that hasn't run yet, so a pending
      // migration never blocks deleting an order.
      let existing;
      try {
        [existing] = await sql`SELECT cliente, coupon_id, items, location_id FROM orders WHERE id = ${id} AND tenant_id = ${tenantId}`;
      } catch (selErr) {
        if (selErr.code !== '42703') throw selErr;
        [existing] = await sql`SELECT cliente, items, location_id FROM orders WHERE id = ${id} AND tenant_id = ${tenantId}`;
      }
      if (!existing) return res.status(404).json({ error: 'Order not found' });

      // Release the coupon use (if any) so a deleted order doesn't
      // permanently burn a use of its cupón.
      if (existing.coupon_id) await releaseCoupon(sql, tenantId, existing.coupon_id);

      // Give back the stock (and, via the FIFO lots, its precio costo) that
      // was deducted when this order was created — mirrors the restore path
      // already used when items are removed from a Pre-Compra.
      if (restoreStock && existing.items?.length) {
        await restoreStockForItems(sql, existing.items, tenantId, '', existing.location_id);
      }

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
        details:     { id, restoreStock },
      });

      return res.json({ ok: true, deleted: id, restoreStock });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('orders/[id] error:', err);
    return res.status(500).json({ error: err.message });
  }
};
