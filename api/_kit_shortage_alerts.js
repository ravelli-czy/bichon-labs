// api/_kit_shortage_alerts.js — Alertas de insumos de KIT: helpers de datos.
// Prefijo `_` — no es una Serverless Function (mismo motivo que _stock_alerts.js).
//
// Un KIT puede tener "componentes base" (los que determinan su stock/
// disponibilidad, vía kit.stock_group_ids ∩ product.groups — ver
// kitStockItems() en frontend/index.html) y "componentes insumo" (todo lo
// demás): un insumo puede estar en 0 y la venta del KIT igual se concreta,
// porque la deducción real (_deductKit en api/_stock.js) descuenta todos los
// componentes por igual sin mirar stock_group_ids ni bloquear por falta de
// stock. Esta alerta existe justamente porque esa deuda no queda registrada
// en ningún lado — hay que recalcularla hacia adelante, mirando qué piden
// las órdenes con entrega próxima.
//
// A diferencia de Alertas de stock (compara contra un threshold fijo), acá
// "necesario" es la suma de lo que piden las órdenes dentro de la ventana de
// lead_days, y "falta comprar" = necesario − stock actual.

const { FREQUENCIES, isDueToday, nextRunDate } = require('./_stock_alerts');

async function nextKitShortageRunId(sql) {
  const [{ max_num }] = await sql`
    SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 5) AS INTEGER)), 0) AS max_num
    FROM kit_shortage_alert_runs WHERE id ~ '^KSA-[0-9]+$'
  `;
  return 'KSA-' + String(parseInt(max_num) + 1).padStart(4, '0');
}

// ¿El producto (por SKU) pertenece a alguno de estos grupos? Mismo criterio
// que productSkuHasGroup() en frontend/index.html — un SKU puede tener
// varias filas (una por almacén) y el grupo puede estar en cualquiera.
function _skuHasGroup(productRowsBySku, sku, groupIds) {
  const rows = productRowsBySku[sku] || [];
  return rows.some(p => Array.isArray(p.groups) && p.groups.some(g => groupIds.includes(g)));
}

// Recorre un KIT (y sus sub-KITs) acumulando en `needs` cuánto se necesita de
// cada componente INSUMO (no-gating) hoja, multiplicado por la cantidad
// vendida. Los sub-KITs siempre se recorren igual que _deductKit — la
// distinción base/insumo se evalúa nivel por nivel contra el
// stock_group_ids de CADA kit, no solo el de más arriba.
function accumulateInsumoNeeds(kitsBySku, productRowsBySku, kitSku, qty, wid, needs, depth = 0) {
  if (depth > 6) return; // mismo límite que _flattenKitSkus en api/orders.js
  const kit = kitsBySku[kitSku];
  if (!kit || !Array.isArray(kit.items)) return;
  const groupIds = Array.isArray(kit.stock_group_ids) ? kit.stock_group_ids : [];
  const allGate = !groupIds.length; // sin grupos configurados = todos cuentan (comportamiento actual)

  for (const comp of kit.items) {
    const compQty = (comp.qty || 0) * qty;
    if (!compQty) continue;
    if (comp.type === 'kit') {
      accumulateInsumoNeeds(kitsBySku, productRowsBySku, comp.sku, compQty, comp.warehouse_id || wid, needs, depth + 1);
      continue;
    }
    const isGating = allGate || _skuHasGroup(productRowsBySku, comp.sku, groupIds);
    if (isGating) continue; // ya cubierto por Alertas de stock normales
    const compWid = comp.warehouse_id || wid || '';
    const key = comp.sku + '::' + compWid;
    const prev = needs.get(key);
    needs.set(key, { qty: (prev?.qty || 0) + compQty, sku: comp.sku, wid: compWid });
  }
}

// Órdenes "vivas" (no entregadas/canceladas) con fecha de entrega dentro de
// [hoy, hoy + leadDays]. leadDays === null/undefined → sin tope superior,
// toma cualquier entrega futura (usado por "Generar ahora": lead_days sólo
// gobierna CUÁNDO se dispara el aviso automático, no qué revisa el botón
// manual).
async function fetchOrdersInWindow(sql, tenantId, leadDays) {
  // Los 3 estados finales son literales fijos, no interpolados — igual
  // criterio que VENTAS_DATE_FILTER_DONE_STATUSES en frontend/index.html.
  const rows = await sql`
    SELECT id, cliente, delivery, items FROM orders
    WHERE tenant_id = ${tenantId} AND status NOT IN ('entregada', 'no_entregada', 'cancelled')
  `;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const until = leadDays == null ? null : new Date(today);
  if (until) until.setDate(until.getDate() + leadDays);
  return rows.filter(o => {
    const dateStr = o.delivery?.date;
    if (!dateStr) return false;
    const d = new Date(dateStr + 'T12:00:00');
    return !isNaN(d) && d >= today && (!until || d <= until);
  });
}

// Genera el snapshot inmutable de una corrida y lo inserta. Devuelve null
// (sin insertar nada) si no hay nada que comprar — igual criterio que
// generateRun en _stock_alerts.js. leadDays === null → sin tope (ver
// fetchOrdersInWindow).
async function generateRun(sql, tenantId, leadDays) {
  const orders = await fetchOrdersInWindow(sql, tenantId, leadDays);
  if (!orders.length) return null;

  const kits = await sql`SELECT sku, items, stock_group_ids FROM kits WHERE tenant_id = ${tenantId} AND warehouse_id = ''`;
  const kitsBySku = Object.fromEntries(kits.map(k => [k.sku, k]));

  const products = await sql`
    SELECT p.sku, p.name, p.warehouse_id, p.stock, p.cost, p.groups,
           w.name AS warehouse_name, w.local_id, l.name AS local_name
    FROM products p
    LEFT JOIN warehouses w ON w.id = p.warehouse_id AND w.tenant_id = p.tenant_id
    LEFT JOIN locales l ON l.id = w.local_id AND l.tenant_id = p.tenant_id
    WHERE p.tenant_id = ${tenantId}
  `;
  const productRowsBySku = {};
  for (const p of products) (productRowsBySku[p.sku] ||= []).push(p);

  // needs: "sku::wid" -> { qty, sku, wid }; ordersByKey: "sku::wid" -> [{id, cliente, delivery_date, qty}]
  const needs = new Map();
  const ordersByKey = new Map();
  for (const o of orders) {
    for (const item of (o.items || [])) {
      if (item.type !== 'kit' || !item.qty) continue;
      const lineNeeds = new Map();
      accumulateInsumoNeeds(kitsBySku, productRowsBySku, item.sku, item.qty, item.warehouse_id || '', lineNeeds);
      for (const [key, n] of lineNeeds) {
        const prev = needs.get(key);
        needs.set(key, { qty: (prev?.qty || 0) + n.qty, sku: n.sku, wid: n.wid });
        if (!ordersByKey.has(key)) ordersByKey.set(key, []);
        ordersByKey.get(key).push({ id: o.id, cliente: o.cliente, delivery_date: o.delivery?.date || '', qty: n.qty });
      }
    }
  }
  if (!needs.size) return null;

  const items = [];
  let estimatedValue = 0;
  for (const [key, n] of needs) {
    const rows = productRowsBySku[n.sku] || [];
    const row = rows.find(p => (p.warehouse_id || '') === n.wid) || rows.find(p => p.warehouse_id) || rows[0];
    if (!row) continue; // producto ya no existe
    const needed = Math.ceil(n.qty);
    const stock = row.stock || 0;
    const missing = Math.max(0, needed - stock);
    if (missing <= 0) continue; // ya hay suficiente stock para cubrir estas ventas
    const cost = Number(row.cost) || 0;
    estimatedValue += missing * cost;
    items.push({
      sku: n.sku, name: row.name, warehouse_id: n.wid,
      warehouse_name: row.warehouse_name || '', local_id: row.local_id || '', local_name: row.local_name || '',
      needed, stock, missing, cost,
      orders: (ordersByKey.get(key) || []).sort((a, b) => (a.delivery_date || '').localeCompare(b.delivery_date || '')),
    });
  }
  if (!items.length) return null;

  items.sort((a, b) => b.missing - a.missing);
  const orderCount = new Set(items.flatMap(i => i.orders.map(o => o.id))).size;
  const id = await nextKitShortageRunId(sql);
  const [row] = await sql`
    INSERT INTO kit_shortage_alert_runs (id, tenant_id, item_count, order_count, estimated_value, status, items)
    VALUES (${id}, ${tenantId}, ${items.length}, ${orderCount}, ${estimatedValue}, 'pendiente', ${JSON.stringify(items)}::jsonb)
    RETURNING *
  `;
  return row;
}

module.exports = {
  FREQUENCIES,
  isDueToday,
  nextRunDate,
  generateRun,
  nextKitShortageRunId,
};
