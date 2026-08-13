// api/orders.js — GET /api/orders  POST /api/orders
// POST: creates order, decrements stock, auto-creates shipment.
const { getDb } = require('./_db');
const cors = require('./_cors');
const { createShipment } = require('./shipments');
const { writeLog } = require('./_log');
const { getSession, resolveTenantId } = require('./_tenant');
const { loadCostMaps, withFinancialSnapshot } = require('./_finance');
const { handleFinanceResource, FINANCE_RESOURCES } = require('./_finance_routes');
const { handleCouponsResource, COUPON_RESOURCES } = require('./_coupons_routes');
const { claimCoupon, computeDiscountAmount } = require('./_coupons');
const { handleStockAlertsResource, STOCK_ALERT_RESOURCES, handleStockAlertsCron } = require('./_stock_alerts_routes');
const { handleKitShortageAlertsResource, KIT_SHORTAGE_ALERT_RESOURCES, handleKitShortageAlertsCron } = require('./_kit_shortage_alerts_routes');
const { deductStockForItems } = require('./_stock');

// Resolves which specific warehouse row to decrement a KIT component's
// stock from. A KIT's components can live in DIFFERENT almacenes of the
// SAME store (ver _resolveLocalIdFromItems más abajo), so the single `wid`
// the caller has (usually '' for a KIT item — KITs are warehouse-agnostic,
// ver _populateVentaAddItemSelect en el frontend) is often just wrong for a
// given component. Prefer the warehouse that belongs to the order's actual
// store (locationId) and stocks this SKU; only fall back to the blanket wid
// when that's ambiguous (0 or >1 matches) or there's no location at all —
// this used to silently no-op (UPDATE matching 0 rows) whenever wid didn't
// happen to equal the component's real warehouse_id.
// Resolves a local_id for an order's location_id backfill (ver
// ?action=backfill-location más abajo) straight from its delivery method —
// each local configures its own delivery_methods with its own name
// (ver locales.html), so order.delivery.method_label is actually a
// precise, unambiguous signal for "which store fulfilled this order",
// unlike guessing from a shared product catalog (ver
// _resolveLocalIdFromItems below, which can't tell apart a SKU that
// exists in more than one store). Returns '' if there's no
// method_label, no match, or the name isn't unique to a single local
// (never guesses between two candidates).
async function _resolveLocationIdFromDelivery(sql, tenantId, delivery) {
  const label = delivery?.method_label;
  if (!label) return '';
  const rows = await sql`SELECT DISTINCT local_id FROM delivery_methods WHERE tenant_id = ${tenantId} AND name = ${label}`;
  return rows.length === 1 ? rows[0].local_id : '';
}

// Flattens a KIT's CURRENT component list into its leaf product SKUs,
// descending into nested KITs (a KIT built from other KITs via Mesón
// Creativo) to full depth — same traversal as _deductKit/the frontend's
// _kitComponentRows, just collecting SKUs instead of mutating stock.
async function _flattenKitSkus(sql, tenantId, kitSku, depth = 0, out = new Set()) {
  if (depth > 6) return out;
  const [kit] = await sql`SELECT items FROM kits WHERE sku = ${kitSku} AND warehouse_id = '' AND tenant_id = ${tenantId}`;
  if (!kit?.items) return out;
  for (const comp of kit.items) {
    if (comp.type === 'kit') await _flattenKitSkus(sql, tenantId, comp.sku, depth + 1, out);
    else out.add(comp.sku);
  }
  return out;
}

// Set of local_ids a SKU is stocked in, resolved through whichever
// warehouse(s) carry it (a product can be stocked in more than one
// warehouse — usually within the same store, e.g. distinct almacenes/
// closets — but in principle in more than one store too).
async function _localIdsForSku(sql, tenantId, sku) {
  const rows = await sql`
    SELECT DISTINCT w.local_id
    FROM products p
    JOIN warehouses w ON w.id = p.warehouse_id AND w.tenant_id = p.tenant_id
    WHERE p.sku = ${sku} AND p.tenant_id = ${tenantId} AND p.warehouse_id != ''
  `;
  return new Set(rows.map(r => r.local_id));
}

// Resolves a local_id to anchor an order's location_id backfill on, when
// _resolveLocationIdFromDelivery above couldn't. A KIT isn't itself tied to
// a warehouse — and its components legitimately live in DIFFERENT almacenes
// (closets/rooms) of the SAME store (e.g. one component in "Clóset Oficina",
// another in "Closet pasillo" — both under "Tienda Principal"), so the
// right grouping key is the STORE (local_id), not the literal warehouse_id.
// For each component with a known warehouse, intersect the set of locals it
// could belong to; components with no warehouse info at all don't
// disqualify the match, they just contribute no signal (same idea the user
// described: a couple of missing almacenes is fine as long as the ones you
// DO have agree). Only returns a local if the intersection across every
// component that had signal narrows to exactly one — conflicting signals or
// zero signal return '' rather than guess wrong.
async function _resolveLocalIdFromItems(sql, tenantId, items) {
  const direct = items.find(i => i.warehouse_id)?.warehouse_id;
  if (direct) {
    const [wh] = await sql`SELECT local_id FROM warehouses WHERE id = ${direct} AND tenant_id = ${tenantId}`;
    if (wh?.local_id) return wh.local_id;
  }
  for (const item of items) {
    if (item.type !== 'kit') continue;
    const skus = [...await _flattenKitSkus(sql, tenantId, item.sku)];
    if (!skus.length) continue;
    let common = null; // null = no component with signal seen yet
    for (const sku of skus) {
      const locals = await _localIdsForSku(sql, tenantId, sku);
      if (!locals.size) continue; // this component isn't stocked anywhere — no signal, doesn't disqualify
      common = common === null ? locals : new Set([...common].filter(l => locals.has(l)));
      if (common.size === 0) break; // components disagree — ambiguous for this kit item
    }
    if (common && common.size === 1) return [...common][0];
  }
  return '';
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

  // ── Cron de Alertas de stock ────────────────────────────────────────────
  // Vercel Cron llama sin sesión de usuario (no hay cookie), así que este
  // despacho va ANTES de resolver tenant/sesión — se autentica con
  // CRON_SECRET en vez de login. Ver handleStockAlertsCron en
  // api/_stock_alerts_routes.js.
  if (req.query?.resource === 'stock-alerts' && req.query?.action === 'cron-run') {
    return handleStockAlertsCron(req, res, sql);
  }
  // ── Cron de Alertas de insumos de KIT — mismo motivo/patrón. Ver
  // handleKitShortageAlertsCron en api/_kit_shortage_alerts_routes.js.
  if (req.query?.resource === 'kit-shortage-alerts' && req.query?.action === 'cron-run') {
    return handleKitShortageAlertsCron(req, res, sql);
  }

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
  // ── Cupones: CRUD + validación de código ───────────────────────────────
  // Mismo motivo que Finanzas — vive en api/_coupons_routes.js, no en su
  // propio api/coupons.js (ver comentario ahí).
  if (COUPON_RESOURCES.includes(req.query?.resource)) {
    return handleCouponsResource(req, res, sql, session, tenantId, actor);
  }
  // ── Alertas de stock: configuración + historial + detalle ──────────────
  // Mismo motivo que Finanzas/Cupones — vive en api/_stock_alerts_routes.js.
  if (STOCK_ALERT_RESOURCES.includes(req.query?.resource)) {
    return handleStockAlertsResource(req, res, sql, session, tenantId, actor);
  }
  // ── Alertas de insumos de KIT: configuración + historial + detalle ──────
  // Mismo motivo — vive en api/_kit_shortage_alerts_routes.js.
  if (KIT_SHORTAGE_ALERT_RESOURCES.includes(req.query?.resource)) {
    return handleKitShortageAlertsResource(req, res, sql, session, tenantId, actor);
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

    // ── POST ?action=backfill-location — one-time resolution of location_id
    // on every existing order that's missing it, using the same logic as
    // order creation (first item's warehouse_id → warehouses.local_id).
    // Historical orders created before a warehouse was linked to a local (or
    // whose items had no warehouse_id yet) never got a location_id, so they
    // can't resolve a Locales prefix (ver orderDisplayId/orderPrefixBadge en
    // frontend/index.html) or show up in Finanzas' sucursal filter. Admin-only.
    if (req.method === 'POST' && req.query?.action === 'backfill-location') {
      if (!['admin','superadmin','master'].includes(session.role)) {
        return res.status(403).json({ error: 'No autorizado' });
      }
      const orders = await sql`
        SELECT id, items, delivery FROM orders
        WHERE tenant_id = ${tenantId} AND (location_id IS NULL OR location_id = '')
      `;
      let ordersUpdated = 0, ordersSkipped = 0;
      for (const order of orders) {
        const items = Array.isArray(order.items) ? order.items : [];
        // Prefer the delivery method — precise per-local signal — over
        // guessing from the product catalog (see _resolveLocalIdFromItems'
        // comment for why that guess is grouped by store, not by literal
        // warehouse).
        let locationId = await _resolveLocationIdFromDelivery(sql, tenantId, order.delivery);
        if (!locationId) locationId = await _resolveLocalIdFromItems(sql, tenantId, items);
        if (!locationId) { ordersSkipped++; continue; }
        await sql`UPDATE orders SET location_id = ${locationId} WHERE id = ${order.id} AND tenant_id = ${tenantId}`;
        ordersUpdated++;
      }
      await writeLog(sql, {
        tenant_id:   tenantId,
        actor,
        action:      'ordenes.location_backfill',
        entity_type: 'orden',
        entity_id:   'bulk',
        entity_name: `${ordersUpdated} órdenes`,
        details:     { ordersScanned: orders.length, ordersUpdated, ordersSkipped },
      });
      return res.json({ ok: true, ordersScanned: orders.length, ordersUpdated, ordersSkipped });
    }

    // ── POST — create order + decrement stock + create shipment ───────────
    if (req.method === 'POST') {
      const {
        cliente = 'Cliente', telefono = '', dedicatoria = '',
        items: rawItems = [], delivery = {}, warehouse_id: orderWarehouseId = '',
        location_id: orderLocationId = '',
        payment_method = '', sales_channel = '',
        coupon_code = '', refund_amount = 0,
        label_selections = {}, order_type = 'normal',
      } = req.body || {};

      if (!rawItems.length) return res.status(400).json({ error: 'items is required' });
      // Pre Compra: sistemas terceros marcan la orden con order_type:'pre_compra'
      // para que nazca 'por_confirmar' en vez de 'por_hacer' — el equipo la
      // revisa/confirma manualmente antes de que entre al flujo normal.
      const orderType = order_type === 'pre_compra' ? 'pre_compra' : 'normal';
      const initialStatus = orderType === 'pre_compra' ? 'por_confirmar' : 'por_hacer';
      // Item 8.2: elegir un template de etiqueta ya cargado puede ser
      // obligatorio para completar la venta — configurable por tenant en
      // Preferencias → Flujos → Etiquetado (default: obligatorio). Solo
      // bloquea si además el tenant tiene al menos un template activo
      // configurado, y si la tabla/columna ya existen (no rompe la venta
      // mientras se despliega esta función o si la migración no corrió).
      let mustSelectLabel = false;
      try {
        const [tenantRow] = await sql`SELECT settings FROM tenants WHERE id = ${tenantId}`;
        const etiquetaObligatoria = tenantRow?.settings?.labelFlow?.etiquetaObligatoria !== false;
        if (etiquetaObligatoria) {
          const [row] = await sql`
            SELECT COUNT(*)::int AS label_tpl_count FROM label_templates
            WHERE tenant_id = ${tenantId} AND type = 'etiqueta' AND active = true
          `;
          mustSelectLabel = (row?.label_tpl_count || 0) > 0;
        }
      } catch (labelErr) {
        console.warn('[orders] label_templates check skipped:', labelErr.message);
      }
      if (mustSelectLabel && !label_selections.etiqueta) {
        return res.status(400).json({ error: 'Selecciona un template de etiqueta' });
      }
      // Snapshot each item's current cost (and full financial snapshot for
      // Finanzas) so it survives future cost/price changes
      const items = _withCostSnapshot(rawItems, await _loadCostMaps(sql, tenantId));

      // Cupón (opcional): reclama un uso atómicamente (falla si no existe,
      // está inactivo o ya alcanzó max_uses — evita que dos ventas
      // simultáneas se lleven el último uso disponible) y calcula el
      // descuento contra el subtotal real de productos. total se calcula
      // siempre acá, nunca se confía en un total enviado por el cliente,
      // para que el cupón no pueda maquillarse desde el frontend.
      const itemsSubtotal = items.reduce((s, i) => s + (i.price || 0) * (i.qty || 0), 0);
      let couponId = null, couponCode = '', discountAmount = 0;
      if (coupon_code) {
        const claimed = await claimCoupon(sql, tenantId, coupon_code);
        if (!claimed) return res.status(400).json({ error: 'Cupón inválido, inactivo o agotado' });
        couponId = claimed.id;
        couponCode = claimed.code;
        discountAmount = computeDiscountAmount(claimed, itemsSubtotal);
      }
      const shippingRevenue = delivery?.slot_cost || 0;
      const total = itemsSubtotal - discountAmount + shippingRevenue;

      // ID must be globally unique (orders.id is a plain PK shared across tenants)
      const [{ max_num }] = await sql`
        SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 5) AS INTEGER)), 0) AS max_num
        FROM orders WHERE id ~ '^ORD-[0-9]+$'
      `;
      const id = 'ORD-' + String(parseInt(max_num) + 1).padStart(4, '0');
      const fecha = new Date().toLocaleDateString('es-CL');

      // Location (store) for Finanzas filtering and the order-id prefix.
      // Priority: (1) the store the frontend's Nueva venta picker explicitly
      // selected (S._ventaSelectedLocale) — the client always knows this now
      // and it's the most reliable signal; (2) the delivery method's name,
      // which is unique per local (ver _resolveLocationIdFromDelivery); (3)
      // resolving from the items themselves, which also handles KIT-only
      // orders whose components live in different warehouses of the same
      // store (ver _resolveLocalIdFromItems — same logic used by the
      // ?action=backfill-location endpoint above, kept in sync with it).
      let locationId = orderLocationId || '';
      try {
        if (!locationId) locationId = await _resolveLocationIdFromDelivery(sql, tenantId, delivery);
        if (!locationId) locationId = await _resolveLocalIdFromItems(sql, tenantId, rawItems);
        if (!locationId && orderWarehouseId) {
          const [wh] = await sql`SELECT local_id FROM warehouses WHERE id = ${orderWarehouseId} AND tenant_id = ${tenantId}`;
          locationId = wh?.local_id || '';
        }
      } catch { /* non-fatal — location filter just won't apply to this order */ }

      // Insert order. label_selections and coupon_id/coupon_code are newer
      // columns (migration via POST /api/setup) — each tier falls back to
      // inserting without them if that migration hasn't run yet on this
      // database, so a pending migration never blocks sales. discount_amount/
      // total already carry the discount either way; coupon_id/coupon_code
      // are only needed to show which cupón was used and to release its use
      // later (edit/delete) — if that migration is pending, the use stays
      // claimed (used_count already incremented above) even though the order
      // itself won't record which cupón claimed it.
      let order;
      try {
        [order] = await sql`
          INSERT INTO orders (
            id, cliente, telefono, total, items, delivery, dedicatoria, fecha, status,
            created_by, tenant_id, payment_method, sales_channel,
            coupon_id, coupon_code, discount_amount, refund_amount, location_id, label_selections, order_type
          )
          VALUES (
            ${id}, ${cliente}, ${telefono}, ${total},
            ${JSON.stringify(items)}, ${JSON.stringify(delivery)},
            ${dedicatoria}, ${fecha}, ${initialStatus}, ${actor}, ${tenantId}, ${payment_method}, ${sales_channel},
            ${couponId}, ${couponCode}, ${discountAmount}, ${refund_amount || 0}, ${locationId}, ${JSON.stringify(label_selections || {})}, ${orderType}
          )
          RETURNING *
        `;
      } catch (insertErr) {
        if (insertErr.code !== '42703') throw insertErr; // no es "columna no existe" — error real, no lo ocultamos
        console.warn('[orders] label_selections and/or coupon_id/coupon_code and/or order_type column not migrated yet, retrying without them');
        try {
          [order] = await sql`
            INSERT INTO orders (
              id, cliente, telefono, total, items, delivery, dedicatoria, fecha, status,
              created_by, tenant_id, payment_method, sales_channel,
              discount_amount, refund_amount, location_id, label_selections, order_type
            )
            VALUES (
              ${id}, ${cliente}, ${telefono}, ${total},
              ${JSON.stringify(items)}, ${JSON.stringify(delivery)},
              ${dedicatoria}, ${fecha}, ${initialStatus}, ${actor}, ${tenantId}, ${payment_method}, ${sales_channel},
              ${discountAmount}, ${refund_amount || 0}, ${locationId}, ${JSON.stringify(label_selections || {})}, ${orderType}
            )
            RETURNING *
          `;
        } catch (insertErr2) {
          if (insertErr2.code !== '42703') throw insertErr2;
          try {
            [order] = await sql`
              INSERT INTO orders (
                id, cliente, telefono, total, items, delivery, dedicatoria, fecha, status,
                created_by, tenant_id, payment_method, sales_channel,
                discount_amount, refund_amount, location_id, order_type
              )
              VALUES (
                ${id}, ${cliente}, ${telefono}, ${total},
                ${JSON.stringify(items)}, ${JSON.stringify(delivery)},
                ${dedicatoria}, ${fecha}, ${initialStatus}, ${actor}, ${tenantId}, ${payment_method}, ${sales_channel},
                ${discountAmount}, ${refund_amount || 0}, ${locationId}, ${orderType}
              )
              RETURNING *
            `;
          } catch (insertErr3) {
            if (insertErr3.code !== '42703') throw insertErr3;
            [order] = await sql`
              INSERT INTO orders (
                id, cliente, telefono, total, items, delivery, dedicatoria, fecha, status,
                created_by, tenant_id, payment_method, sales_channel,
                discount_amount, refund_amount, location_id
              )
              VALUES (
                ${id}, ${cliente}, ${telefono}, ${total},
                ${JSON.stringify(items)}, ${JSON.stringify(delivery)},
                ${dedicatoria}, ${fecha}, ${initialStatus}, ${actor}, ${tenantId}, ${payment_method}, ${sales_channel},
                ${discountAmount}, ${refund_amount || 0}, ${locationId}
              )
              RETURNING *
            `;
          }
        }
      }

      // Decrement stock for each sold item (scoped to tenant + warehouse)
      await deductStockForItems(sql, items, tenantId, orderWarehouseId, locationId);

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
        details:     { id, cliente, total, items_count: items.length, coupon_code: couponCode || undefined },
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
