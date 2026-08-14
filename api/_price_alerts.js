// api/_price_alerts.js — Alertas de precio: helpers de datos (productos/KITs
// con margen bajo el % de utilidad esperado, generación del snapshot
// inmutable de una corrida). Compartido entre api/_price_alerts_routes.js
// (UI: config/historial/detalle) y runPriceAlertsCronCore (colgado del cron
// diario de Alertas de insumos de KIT — Vercel Hobby tiene tope de 2 Cron
// Jobs por proyecto y ya están usados, ver vercel.json).
// Prefijo `_` — no es una Serverless Function (mismo motivo que _stock_alerts.js).

const { loadCostMaps, productCost, kitUnitCost, round2 } = require('./_finance');

const FREQUENCIES = ['diaria', 'semanal', 'quincenal', 'mensual'];

async function nextAlertRunId(sql) {
  const [{ max_num }] = await sql`
    SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 5) AS INTEGER)), 0) AS max_num
    FROM price_alert_runs WHERE id ~ '^PRA-[0-9]+$'
  `;
  return 'PRA-' + String(parseInt(max_num) + 1).padStart(4, '0');
}

// Margen bruto %: (precio - costo) / precio * 100. Sin precio de venta (0 o
// ausente) no hay margen que calcular — se excluye, no se trata como 0%.
function marginPct(price, cost) {
  if (!(price > 0)) return null;
  return ((price - cost) / price) * 100;
}

// Productos y KITs de venta (tipo != 'insumo', con precio > 0) cuyo margen
// actual cae bajo thresholdPct. Un registro por SKU — mismo criterio que
// Precios (priceRow/renderPrecios en frontend/index.html): preferimos el
// registro de catálogo (warehouse_id vacío) si existe. El costo se computa
// en vivo con el mismo helper que usa Finanzas (loadCostMaps/productCost/
// kitUnitCost) — products ya no tiene una columna cost propia.
async function fetchAlertProducts(sql, tenantId, thresholdPct) {
  const maps = await loadCostMaps(sql, tenantId);

  const products = await sql`
    SELECT DISTINCT ON (sku) sku, name, tipo, price
    FROM products
    WHERE tenant_id = ${tenantId} AND tipo != 'insumo' AND price > 0
    ORDER BY sku, (warehouse_id = '') DESC
  `;
  const kits = await sql`
    SELECT sku, name, price FROM kits
    WHERE tenant_id = ${tenantId} AND warehouse_id = '' AND tipo != 'insumo' AND price > 0
  `;

  const items = [];
  for (const p of products) {
    const cost = productCost(maps, p.sku, '');
    const m = marginPct(Number(p.price), cost);
    if (m === null || m >= thresholdPct) continue;
    items.push({ sku: p.sku, name: p.name, tipo: 'producto', price: Number(p.price), cost: round2(cost), margin_pct: round2(m) });
  }
  for (const k of kits) {
    const cost = kitUnitCost(maps, k.sku);
    const m = marginPct(Number(k.price), cost);
    if (m === null || m >= thresholdPct) continue;
    items.push({ sku: k.sku, name: k.name, tipo: 'kit', price: Number(k.price), cost: round2(cost), margin_pct: round2(m) });
  }
  items.sort((a, b) => a.margin_pct - b.margin_pct); // peor margen primero
  return items;
}

function avgMarginPct(items) {
  if (!items.length) return 0;
  return round2(items.reduce((sum, i) => sum + i.margin_pct, 0) / items.length);
}

// ¿Corresponde generar hoy según la config del tenant? Mismo criterio que
// api/_stock_alerts.js — 'quincenal' son fechas fijas de calendario (días 1
// y 15), no un intervalo de 14 días desde la última corrida.
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
// (sin insertar nada) si nada está bajo el margen esperado ahora mismo. El
// registro insertado nunca se recalcula después: es una foto del margen en
// ese momento exacto, con el % esperado que se usó para juzgarlo.
async function generateRun(sql, tenantId, thresholdPct) {
  const items = await fetchAlertProducts(sql, tenantId, thresholdPct);
  if (!items.length) return null;
  const avg = avgMarginPct(items);
  const id = await nextAlertRunId(sql);
  const [row] = await sql`
    INSERT INTO price_alert_runs (id, tenant_id, item_count, avg_margin_pct, margin_threshold_pct, status, items)
    VALUES (${id}, ${tenantId}, ${items.length}, ${avg}, ${thresholdPct}, 'pendiente', ${JSON.stringify(items)}::jsonb)
    RETURNING *
  `;
  return row;
}

module.exports = {
  FREQUENCIES,
  fetchAlertProducts,
  marginPct,
  avgMarginPct,
  isDueToday,
  nextRunDate,
  generateRun,
  nextAlertRunId,
};
