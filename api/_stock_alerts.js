// api/_stock_alerts.js — Alertas de stock: helpers de datos (productos con
// alerta, valor estimado, cuándo corresponde generar según la config del
// tenant, generación del snapshot inmutable de una corrida). Compartido
// entre api/_stock_alerts_routes.js (UI: config/historial/detalle) y el
// cron (?resource=stock-alerts&action=cron-run en api/orders.js, que no
// tiene sesión de usuario — por eso esto no depende de session/tenantId
// resueltos por request, sólo recibe el tenantId a mano).
// Prefijo `_` — no es una Serverless Function (mismo motivo que _coupons.js).

const FREQUENCIES = ['diaria', 'semanal', 'quincenal', 'mensual'];

async function nextAlertRunId(sql) {
  const [{ max_num }] = await sql`
    SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 5) AS INTEGER)), 0) AS max_num
    FROM stock_alert_runs WHERE id ~ '^ALR-[0-9]+$'
  `;
  return 'ALR-' + String(parseInt(max_num) + 1).padStart(4, '0');
}

// Productos con stock < threshold para un tenant, con nombre de almacén y
// tienda ya resueltos — mismo criterio que alertLevel()/getAlerts() del
// frontend (stock < threshold, sólo filas con warehouse_id real), pero
// consultado directo de la base para poder correr sin sesión de usuario.
async function fetchAlertProducts(sql, tenantId) {
  // cost ya no es una columna propia — se computa en vivo, mismo criterio
  // que api/_finance.js:loadCostMaps (lote FIFO más viejo con stock, o el
  // último lote registrado si no queda ninguno activo).
  return sql`
    SELECT p.sku, p.name, p.tipo, p.warehouse_id, w.name AS warehouse_name,
           w.local_id, l.name AS local_name, p.stock, p.threshold,
           COALESCE(
             (SELECT sr.unit_cost FROM stock_receipts sr
              WHERE sr.tenant_id = p.tenant_id AND sr.sku = p.sku AND sr.warehouse_id = p.warehouse_id AND sr.remaining_qty > 0
              ORDER BY sr.created_at ASC LIMIT 1),
             (SELECT sr.unit_cost FROM stock_receipts sr
              WHERE sr.tenant_id = p.tenant_id AND sr.sku = p.sku AND sr.warehouse_id = p.warehouse_id
              ORDER BY sr.created_at DESC LIMIT 1),
             (SELECT sr.unit_cost FROM stock_receipts sr
              WHERE sr.tenant_id = p.tenant_id AND sr.sku = p.sku AND sr.remaining_qty > 0
              ORDER BY sr.created_at ASC LIMIT 1),
             (SELECT sr.unit_cost FROM stock_receipts sr
              WHERE sr.tenant_id = p.tenant_id AND sr.sku = p.sku
              ORDER BY sr.created_at DESC LIMIT 1),
             0
           ) AS cost
    FROM products p
    LEFT JOIN warehouses w ON w.id = p.warehouse_id AND w.tenant_id = p.tenant_id
    LEFT JOIN locales l ON l.id = w.local_id AND l.tenant_id = p.tenant_id
    WHERE p.tenant_id = ${tenantId} AND p.warehouse_id != '' AND p.stock < p.threshold
    ORDER BY l.name NULLS LAST, w.name NULLS LAST, p.name
  `;
}

// Valor estimado de reposición: por cada producto con alerta, cuánto
// costaría comprar hasta llegar al stock de alerta, a costo unitario.
// Fórmula confirmada con el usuario: sum((threshold - stock) * cost).
function estimatedValue(items) {
  return items.reduce((sum, i) => sum + Math.max(0, (i.threshold || 0) - (i.stock || 0)) * (Number(i.cost) || 0), 0);
}

// ¿Corresponde generar hoy según la config del tenant? 'quincenal' son
// fechas fijas de calendario (días 1 y 15 de cada mes) — confirmado con el
// usuario, no es un intervalo de 14 días desde la última corrida.
function isDueToday(settings, today) {
  const dow = today.getDay();  // 0=domingo..6=sábado
  const dom = today.getDate(); // 1-31
  switch (settings.frequency) {
    case 'diaria':    return true;
    case 'semanal':   return dow === settings.weekday;
    case 'quincenal': return dom === 1 || dom === 15;
    case 'mensual': {
      const lastDayOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
      const target = Math.min(settings.month_day || 1, lastDayOfMonth);
      return dom === target;
    }
    default: return false;
  }
}

// Próxima fecha de generación (sólo la fecha — la hora la fija el horario
// del cron diario, ver vercel.json). Busca desde mañana para no repetir
// "hoy" si la corrida de hoy ya se generó.
function nextRunDate(settings, from = new Date()) {
  const d = new Date(from);
  d.setDate(d.getDate() + 1);
  for (let i = 0; i < 60; i++) {
    if (isDueToday(settings, d)) return d;
    d.setDate(d.getDate() + 1);
  }
  return null;
}

// Genera el snapshot inmutable de una corrida y lo inserta. Devuelve null
// (sin insertar nada) si no hay productos con alerta — no tiene sentido
// una lista de compras vacía ni avisar de que "todo está bien" por email.
// El registro insertado nunca se recalcula después: es una foto del estado
// de products en ese momento exacto.
async function generateRun(sql, tenantId) {
  const products = await fetchAlertProducts(sql, tenantId);
  if (!products.length) return null;
  const items = products.map(p => ({
    sku: p.sku, name: p.name, tipo: p.tipo,
    warehouse_id: p.warehouse_id, warehouse_name: p.warehouse_name || '',
    local_id: p.local_id || '', local_name: p.local_name || '',
    stock: p.stock, threshold: p.threshold, cost: Number(p.cost) || 0,
  }));
  const value = estimatedValue(items);
  const id = await nextAlertRunId(sql);
  const [row] = await sql`
    INSERT INTO stock_alert_runs (id, tenant_id, item_count, estimated_value, status, items)
    VALUES (${id}, ${tenantId}, ${items.length}, ${value}, 'pendiente', ${JSON.stringify(items)}::jsonb)
    RETURNING *
  `;
  return row;
}

module.exports = {
  FREQUENCIES,
  fetchAlertProducts,
  estimatedValue,
  isDueToday,
  nextRunDate,
  generateRun,
  nextAlertRunId,
};
