// api/finance.js — Módulo Finanzas: resumen, estado de resultados, evolución
// temporal, gastos y categorías. Todo resuelto con querystring (?resource=)
// en un solo archivo, sin rutas dinámicas [id].js, para no sumar más
// Serverless Functions — mismo patrón que api/locales.js y
// api/users.js?action=logs (ver comentarios ahí: tope de 12 en el plan
// Hobby de Vercel). Este archivo agrega 1 función nueva al conteo total.
//
// GET  /api/finance?resource=summary&from=&to=&location_id=&sales_channel=
// GET  /api/finance?resource=income-statement&from=&to=&location_id=&sales_channel=
// GET  /api/finance?resource=timeseries&from=&to=&location_id=&sales_channel=&granularity=
// GET  /api/finance?resource=monthly-table&from=&to=&location_id=
// GET  /api/finance?resource=export&from=&to=&location_id=&sales_channel=   → CSV
//
// GET    /api/finance?resource=expenses&q=&month=&from=&to=&category_id=&location_id=&payment_status=&sort=&order=&page=&limit=
// GET    /api/finance?resource=expenses&id=EXP-0001
// POST   /api/finance?resource=expenses
// PUT    /api/finance?resource=expenses&id=EXP-0001
// POST   /api/finance?resource=expenses&id=EXP-0001&action=duplicate
// DELETE /api/finance?resource=expenses&id=EXP-0001                         (soft-delete / anular)
//
// GET    /api/finance?resource=categories
// POST   /api/finance?resource=categories
// PUT    /api/finance?resource=categories&id=CAT-001
// PUT    /api/finance?resource=categories&id=CAT-001&action=toggle

const { getDb } = require('./_db');
const cors = require('./_cors');
const { writeLog } = require('./_log');
const { getSession, resolveTenantId } = require('./_tenant');
const F = require('./_finance');

const ADMIN_ROLES = ['admin', 'superadmin', 'master'];
const isAdmin = session => ADMIN_ROLES.includes(session.role);

// ── Rangos de fecha ───────────────────────────────────────────────────────
function todayKey() { return F.zonedDateKey(new Date()); }

function firstOfMonthKey(offsetMonths = 0) {
  const { year, month } = F.zonedParts(new Date());
  const d = new Date(Date.UTC(year, month - 1 + offsetMonths, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function parseRange(query) {
  if (query.month && /^\d{4}-\d{2}$/.test(query.month)) {
    const [y, m] = query.month.split('-').map(Number);
    const from = `${y}-${String(m).padStart(2, '0')}-01`;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const to = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    return { from, to };
  }
  const from = query.from || firstOfMonthKey(0);
  const to   = query.to   || todayKey();
  return { from, to };
}

function daySpan(from, to) {
  const a = new Date(from + 'T00:00:00Z');
  const b = new Date(to   + 'T00:00:00Z');
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

// Período inmediatamente anterior, de igual duración que [from, to] — mes
// actual vs mes anterior, últimos 7 días vs los 7 anteriores, rango
// personalizado vs el rango inmediatamente anterior de igual duración.
function previousPeriod(from, to) {
  const span = daySpan(from, to);
  const a = new Date(from + 'T00:00:00Z');
  const prevTo = new Date(a); prevTo.setUTCDate(prevTo.getUTCDate() - 1);
  const prevFrom = new Date(prevTo); prevFrom.setUTCDate(prevFrom.getUTCDate() - (span - 1));
  const toKey = d => d.toISOString().slice(0, 10);
  return { from: toKey(prevFrom), to: toKey(prevTo) };
}

function pickGranularity(from, to, requested) {
  if (['hour', 'day', 'week', 'month'].includes(requested)) return requested;
  const span = daySpan(from, to);
  if (span <= 1) return 'hour';
  if (span <= 31) return 'day';
  if (span <= 180) return 'week';
  return 'month';
}

// ── Carga de datos — siempre filtrada por tenant + rango de fecha en SQL,
// nunca "traer todas las órdenes/gastos y filtrar en el frontend" ─────────
async function loadOrders(sql, tenantId, { from, to, locationId, salesChannel }) {
  const status = F.REVENUE_STATUSES[0];
  if (locationId && salesChannel) {
    return sql`
      SELECT id, items, delivery, discount_amount, refund_amount, delivered_at, location_id, sales_channel
      FROM orders
      WHERE tenant_id = ${tenantId} AND status = ${status} AND delivered_at IS NOT NULL
        AND (delivered_at AT TIME ZONE ${F.DEFAULT_TIMEZONE})::date BETWEEN ${from}::date AND ${to}::date
        AND location_id = ${locationId} AND sales_channel = ${salesChannel}`;
  }
  if (locationId) {
    return sql`
      SELECT id, items, delivery, discount_amount, refund_amount, delivered_at, location_id, sales_channel
      FROM orders
      WHERE tenant_id = ${tenantId} AND status = ${status} AND delivered_at IS NOT NULL
        AND (delivered_at AT TIME ZONE ${F.DEFAULT_TIMEZONE})::date BETWEEN ${from}::date AND ${to}::date
        AND location_id = ${locationId}`;
  }
  if (salesChannel) {
    return sql`
      SELECT id, items, delivery, discount_amount, refund_amount, delivered_at, location_id, sales_channel
      FROM orders
      WHERE tenant_id = ${tenantId} AND status = ${status} AND delivered_at IS NOT NULL
        AND (delivered_at AT TIME ZONE ${F.DEFAULT_TIMEZONE})::date BETWEEN ${from}::date AND ${to}::date
        AND sales_channel = ${salesChannel}`;
  }
  return sql`
    SELECT id, items, delivery, discount_amount, refund_amount, delivered_at, location_id, sales_channel
    FROM orders
    WHERE tenant_id = ${tenantId} AND status = ${status} AND delivered_at IS NOT NULL
      AND (delivered_at AT TIME ZONE ${F.DEFAULT_TIMEZONE})::date BETWEEN ${from}::date AND ${to}::date`;
}

async function loadExpensesInRange(sql, tenantId, { from, to, locationId }) {
  if (locationId) {
    return sql`
      SELECT * FROM expenses
      WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
        AND date BETWEEN ${from}::date AND ${to}::date AND location_id = ${locationId}`;
  }
  return sql`
    SELECT * FROM expenses
    WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
      AND date BETWEEN ${from}::date AND ${to}::date`;
}

// ── Cálculos agregados ────────────────────────────────────────────────────
function summarizeOrders(orders) {
  let grossSales = 0, shippingRevenue = 0, discounts = 0, refunds = 0, costOfGoodsSold = 0;
  let incompleteCostOrders = 0;
  for (const o of orders) {
    const s = F.orderFinancialSummary(o);
    grossSales += s.grossSales;
    shippingRevenue += s.shippingRevenue;
    discounts += s.discounts;
    refunds += s.refunds;
    costOfGoodsSold += s.costOfGoodsSold;
    if (!s.hasReliableCost) incompleteCostOrders++;
  }
  const netSales = grossSales + shippingRevenue - discounts - refunds;
  const grossProfit = netSales - costOfGoodsSold;
  const grossMarginPercentage = F.pct(grossProfit, netSales);
  return {
    grossSales, shippingRevenue, discounts, refunds, netSales,
    costOfGoodsSold, grossProfit, grossMarginPercentage,
    ordersCount: orders.length, incompleteCostOrders,
  };
}

function sumExpenses(expenses) {
  return expenses.reduce((s, e) => s + (e.total_amount || 0), 0);
}

// Estado de Resultados operacional (sección 24 del brief: aproximación
// operacional, no EBITDA contable certificado — no incluye depreciación,
// amortización, intereses ni impuestos corporativos porque StockFlow no
// registra esa información).
function buildIncomeStatement(orders, expenses) {
  const rev = summarizeOrders(orders);
  const operatingExpenses = sumExpenses(expenses);
  const ebitda = rev.grossProfit - operatingExpenses;
  const ebitdaMarginPercentage = F.pct(ebitda, rev.netSales);
  return {
    ...rev,
    operatingExpenses,
    ebitda,
    ebitdaMarginPercentage,
    currency: F.DEFAULT_CURRENCY,
  };
}

function variation(current, previous) {
  const absolute = current - previous;
  const percentage = previous !== 0 ? (absolute / Math.abs(previous)) * 100 : (current !== 0 ? 100 : 0);
  return { current, previous, absolute, percentage, trend: absolute > 0 ? 'up' : absolute < 0 ? 'down' : 'flat' };
}

// ── Series temporales (evolución financiera / márgenes) ──────────────────
function bucketKeyForOrder(deliveredAt, granularity) {
  const p = F.zonedParts(deliveredAt);
  if (granularity === 'hour') return `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}T${String(p.hour).padStart(2,'0')}:00`;
  const dayKey = `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`;
  if (granularity === 'day') return dayKey;
  if (granularity === 'week') {
    const d = new Date(dayKey + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // lunes de esa semana
    return d.toISOString().slice(0, 10);
  }
  return `${p.year}-${String(p.month).padStart(2,'0')}`; // month
}
function bucketKeyForExpense(dateVal, granularity) {
  const dayKey = String(dateVal).slice(0, 10);
  if (granularity === 'hour' || granularity === 'day') return granularity === 'hour' ? dayKey + 'T00:00' : dayKey;
  if (granularity === 'week') {
    const d = new Date(dayKey + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }
  return dayKey.slice(0, 7);
}

function generateBucketKeys(from, to, granularity) {
  const keys = [];
  if (granularity === 'hour') {
    for (let h = 0; h < 24; h++) keys.push(`${from}T${String(h).padStart(2, '0')}:00`);
    return keys;
  }
  const start = new Date(from + 'T00:00:00Z');
  const end   = new Date(to   + 'T00:00:00Z');
  if (granularity === 'day') {
    for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) keys.push(d.toISOString().slice(0, 10));
    return keys;
  }
  if (granularity === 'week') {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    for (; d <= end; d.setUTCDate(d.getUTCDate() + 7)) keys.push(d.toISOString().slice(0, 10));
    return keys;
  }
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const endMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  for (; d <= endMonth; d.setUTCMonth(d.getUTCMonth() + 1)) keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  return keys;
}

function emptyBucket(key) {
  return { bucket: key, grossSales: 0, shippingRevenue: 0, discounts: 0, refunds: 0, netSales: 0, costOfGoodsSold: 0, grossProfit: 0, expenses: 0, ebitda: 0, grossMarginPercentage: 0, ebitdaMarginPercentage: 0 };
}

function buildTimeseries(orders, expenses, from, to, granularity) {
  const buckets = new Map();
  for (const k of generateBucketKeys(from, to, granularity)) buckets.set(k, emptyBucket(k));
  const ensure = k => { if (!buckets.has(k)) buckets.set(k, emptyBucket(k)); return buckets.get(k); };

  for (const o of orders) {
    const s = F.orderFinancialSummary(o);
    const b = ensure(bucketKeyForOrder(o.delivered_at, granularity));
    b.grossSales += s.grossSales;
    b.shippingRevenue += s.shippingRevenue;
    b.discounts += s.discounts;
    b.refunds += s.refunds;
    b.netSales += s.netSales;
    b.costOfGoodsSold += s.costOfGoodsSold;
    b.grossProfit += s.grossProfit;
  }
  for (const e of expenses) {
    const b = ensure(bucketKeyForExpense(e.date, granularity));
    b.expenses += e.total_amount || 0;
  }
  const sorted = Array.from(buckets.values()).sort((a, b) => a.bucket.localeCompare(b.bucket));
  for (const b of sorted) {
    b.ebitda = b.grossProfit - b.expenses;
    b.grossMarginPercentage = F.pct(b.grossProfit, b.netSales);
    b.ebitdaMarginPercentage = F.pct(b.ebitda, b.netSales);
  }
  return sorted;
}

// ── Validación de gastos (misma validación existe también en el frontend,
// pero nunca se confía sólo en ella) ─────────────────────────────────────
const PAYMENT_STATUSES = ['pending', 'paid', 'overdue'];

async function validateExpenseInput(sql, tenantId, body, { partial = false } = {}) {
  const errors = [];
  const out = {};

  if (!partial || body.date !== undefined) {
    if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(String(body.date))) errors.push('Fecha inválida o requerida');
    out.date = body.date;
  }
  if (!partial || body.description !== undefined) {
    if (!body.description || !String(body.description).trim()) errors.push('Descripción requerida');
    out.description = String(body.description || '').trim();
  }
  if (!partial || body.category_id !== undefined) {
    if (!body.category_id) errors.push('Categoría requerida');
    else {
      const [cat] = await sql`SELECT id FROM expense_categories WHERE id = ${body.category_id} AND tenant_id = ${tenantId}`;
      if (!cat) errors.push('La categoría no pertenece a esta cuenta');
    }
    out.category_id = body.category_id;
  }
  if (body.location_id) {
    const [loc] = await sql`SELECT id FROM locales WHERE id = ${body.location_id} AND tenant_id = ${tenantId}`;
    if (!loc) errors.push('La sucursal no pertenece a esta cuenta');
  }
  if (body.warehouse_id) {
    const [wh] = await sql`SELECT id FROM warehouses WHERE id = ${body.warehouse_id} AND tenant_id = ${tenantId}`;
    if (!wh) errors.push('El almacén no pertenece a esta cuenta');
  }
  if (body.payment_status !== undefined && !PAYMENT_STATUSES.includes(body.payment_status)) {
    errors.push('Estado de pago inválido');
  }

  const netAmount   = Number(body.net_amount ?? 0);
  const taxAmount   = Number(body.tax_amount ?? 0);
  const totalAmount = body.total_amount !== undefined ? Number(body.total_amount) : netAmount + taxAmount;
  if (!partial || body.net_amount !== undefined || body.tax_amount !== undefined || body.total_amount !== undefined) {
    if ([netAmount, taxAmount, totalAmount].some(n => !Number.isFinite(n))) errors.push('Montos inválidos');
    if (totalAmount <= 0) errors.push('El monto debe ser mayor que cero');
    if (Math.abs(netAmount + taxAmount - totalAmount) > 1) errors.push('El neto + IVA debe ser igual al total');
  }

  return { errors, netAmount, taxAmount, totalAmount };
}

// ── Handler ────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  if (cors(req, res)) return;

  let sql;
  try { sql = getDb(); }
  catch (err) { return res.status(503).json({ error: err.message }); }

  const session  = await getSession(req);
  const tenantId = resolveTenantId(req, session);
  if (!session)  return res.status(401).json({ error: 'No autenticado' });
  if (!tenantId) return res.status(400).json({ error: 'Sin contexto de cliente' });
  const actor = session.username || 'sistema';

  const q = req.query || {};
  const resource = q.resource;

  try {
    // ── SUMMARY — tarjetas del Resumen con comparación vs período anterior ─
    if (resource === 'summary' && req.method === 'GET') {
      const { from, to } = parseRange(q);
      const prev = previousPeriod(from, to);
      const filters = { locationId: q.location_id || '', salesChannel: q.sales_channel || '' };

      const [orders, expenses, prevOrders, prevExpenses] = await Promise.all([
        loadOrders(sql, tenantId, { from, to, ...filters }),
        loadExpensesInRange(sql, tenantId, { from, to, locationId: filters.locationId }),
        loadOrders(sql, tenantId, { from: prev.from, to: prev.to, ...filters }),
        loadExpensesInRange(sql, tenantId, { from: prev.from, to: prev.to, locationId: filters.locationId }),
      ]);

      const cur  = buildIncomeStatement(orders, expenses);
      const past = buildIncomeStatement(prevOrders, prevExpenses);

      return res.json({
        period: { from, to },
        previousPeriod: prev,
        currency: F.DEFAULT_CURRENCY,
        cards: {
          netSales:            variation(cur.netSales, past.netSales),
          costOfGoodsSold:     variation(cur.costOfGoodsSold, past.costOfGoodsSold),
          grossProfit:         variation(cur.grossProfit, past.grossProfit),
          grossMarginPercentage: variation(cur.grossMarginPercentage, past.grossMarginPercentage),
          operatingExpenses:   variation(cur.operatingExpenses, past.operatingExpenses),
          ebitda:              variation(cur.ebitda, past.ebitda),
          ebitdaMarginPercentage: variation(cur.ebitdaMarginPercentage, past.ebitdaMarginPercentage),
        },
        ordersCount: cur.ordersCount,
        incompleteCostOrders: cur.incompleteCostOrders,
      });
    }

    // ── INCOME STATEMENT — Estado de Resultados del período ────────────────
    if (resource === 'income-statement' && req.method === 'GET') {
      const { from, to } = parseRange(q);
      const [orders, expenses] = await Promise.all([
        loadOrders(sql, tenantId, { from, to, locationId: q.location_id || '', salesChannel: q.sales_channel || '' }),
        loadExpensesInRange(sql, tenantId, { from, to, locationId: q.location_id || '' }),
      ]);
      return res.json({ period: { from, to }, ...buildIncomeStatement(orders, expenses) });
    }

    // ── TIMESERIES — evolución financiera / márgenes ────────────────────────
    if (resource === 'timeseries' && req.method === 'GET') {
      const { from, to } = parseRange(q);
      const granularity = pickGranularity(from, to, q.granularity);
      const [orders, expenses] = await Promise.all([
        loadOrders(sql, tenantId, { from, to, locationId: q.location_id || '', salesChannel: q.sales_channel || '' }),
        loadExpensesInRange(sql, tenantId, { from, to, locationId: q.location_id || '' }),
      ]);
      return res.json({ period: { from, to }, granularity, series: buildTimeseries(orders, expenses, from, to, granularity) });
    }

    // ── MONTHLY TABLE — tabla mensual del Estado de Resultados ─────────────
    if (resource === 'monthly-table' && req.method === 'GET') {
      const { from, to } = parseRange(q);
      const [orders, expenses] = await Promise.all([
        loadOrders(sql, tenantId, { from, to, locationId: q.location_id || '', salesChannel: q.sales_channel || '' }),
        loadExpensesInRange(sql, tenantId, { from, to, locationId: q.location_id || '' }),
      ]);
      const months = buildTimeseries(orders, expenses, from, to, 'month');
      const total  = buildIncomeStatement(orders, expenses);
      return res.json({ period: { from, to }, currency: F.DEFAULT_CURRENCY, months, total });
    }

    // ── GASTOS POR CATEGORÍA (para el gráfico) ─────────────────────────────
    if (resource === 'expenses-by-category' && req.method === 'GET') {
      const { from, to } = parseRange(q);
      const [expenses, categories] = await Promise.all([
        loadExpensesInRange(sql, tenantId, { from, to, locationId: q.location_id || '' }),
        sql`SELECT id, name FROM expense_categories WHERE tenant_id = ${tenantId}`,
      ]);
      const catName = new Map(categories.map(c => [c.id, c.name]));
      const totals = new Map();
      for (const e of expenses) {
        const name = catName.get(e.category_id) || 'Sin categoría';
        totals.set(name, (totals.get(name) || 0) + (e.total_amount || 0));
      }
      const rows = Array.from(totals, ([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total);
      return res.json({ period: { from, to }, rows });
    }

    // ── EXPORT — CSV del Estado de Resultados, respetando filtros ─────────
    if (resource === 'export' && req.method === 'GET') {
      if (!isAdmin(session)) return res.status(403).json({ error: 'Sólo administradores pueden exportar' });
      const { from, to } = parseRange(q);
      const [orders, expenses] = await Promise.all([
        loadOrders(sql, tenantId, { from, to, locationId: q.location_id || '', salesChannel: q.sales_channel || '' }),
        loadExpensesInRange(sql, tenantId, { from, to, locationId: q.location_id || '' }),
      ]);
      const stmt = buildIncomeStatement(orders, expenses);
      const rows = [
        ['Estado de Resultados — StockFlow'],
        ['Cuenta', tenantId],
        ['Sucursal', q.location_id || 'Todas'],
        ['Período', `${from} a ${to}`],
        ['Moneda', F.DEFAULT_CURRENCY],
        ['Generado', new Date().toISOString()],
        [],
        ['Concepto', 'Monto'],
        ['Ingresos por ventas', stmt.grossSales],
        ['Ingresos por despacho', stmt.shippingRevenue],
        ['Descuentos', -stmt.discounts],
        ['Devoluciones', -stmt.refunds],
        ['Ingresos netos', stmt.netSales],
        ['Costo de ventas', -stmt.costOfGoodsSold],
        ['Utilidad bruta', stmt.grossProfit],
        ['Margen bruto %', stmt.grossMarginPercentage.toFixed(2)],
        ['Gastos operacionales', -stmt.operatingExpenses],
        ['EBITDA operacional', stmt.ebitda],
        ['Margen EBITDA %', stmt.ebitdaMarginPercentage.toFixed(2)],
      ];
      const csv = rows.map(r => r.map(cell => {
        const v = cell === undefined || cell === null ? '' : String(cell);
        return /[",;\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
      }).join(',')).join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="estado-resultados-${from}_${to}.csv"`);
      return res.status(200).send(csv);
    }

    // ── CATEGORÍAS ──────────────────────────────────────────────────────────
    if (resource === 'categories') {
      if (req.method === 'GET') {
        const rows = await sql`SELECT * FROM expense_categories WHERE tenant_id = ${tenantId} ORDER BY name`;
        return res.json(rows);
      }
      if (!isAdmin(session)) return res.status(403).json({ error: 'Sólo administradores pueden gestionar categorías' });

      if (req.method === 'POST') {
        const { name, code = '' } = req.body || {};
        if (!name || !String(name).trim()) return res.status(400).json({ error: 'name es requerido' });
        const id = await F.nextCategoryId(sql, tenantId);
        let row;
        try {
          [row] = await sql`
            INSERT INTO expense_categories (id, tenant_id, name, code, is_active, is_default, created_by)
            VALUES (${id}, ${tenantId}, ${String(name).trim()}, ${code}, TRUE, FALSE, ${actor})
            RETURNING *`;
        } catch (err) {
          if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });
          throw err;
        }
        await writeLog(sql, { tenant_id: tenantId, actor, action: 'categoria_gasto.creada', entity_type: 'expense_category', entity_id: row.id, entity_name: row.name, details: { name: row.name } });
        return res.status(201).json(row);
      }

      if (req.method === 'PUT' && q.id) {
        const [before] = await sql`SELECT * FROM expense_categories WHERE id = ${q.id} AND tenant_id = ${tenantId}`;
        if (!before) return res.status(404).json({ error: 'Categoría no encontrada' });

        if (q.action === 'toggle') {
          const [row] = await sql`
            UPDATE expense_categories SET is_active = NOT is_active, updated_at = NOW()
            WHERE id = ${q.id} AND tenant_id = ${tenantId} RETURNING *`;
          await writeLog(sql, {
            tenant_id: tenantId, actor, action: 'categoria_gasto.activacion_cambiada', entity_type: 'expense_category',
            entity_id: row.id, entity_name: row.name, details: { from: before.is_active, to: row.is_active },
          });
          return res.json(row);
        }

        const { name, code } = req.body || {};
        let row;
        try {
          [row] = await sql`
            UPDATE expense_categories SET
              name = COALESCE(${name ?? null}, name),
              code = COALESCE(${code ?? null}, code),
              updated_at = NOW()
            WHERE id = ${q.id} AND tenant_id = ${tenantId}
            RETURNING *`;
        } catch (err) {
          if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });
          throw err;
        }
        await writeLog(sql, {
          tenant_id: tenantId, actor, action: 'categoria_gasto.editada', entity_type: 'expense_category',
          entity_id: row.id, entity_name: row.name, details: { before: { name: before.name, code: before.code }, after: { name: row.name, code: row.code } },
        });
        return res.json(row);
      }

      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── GASTOS ──────────────────────────────────────────────────────────────
    if (resource === 'expenses') {
      // GET detalle
      if (req.method === 'GET' && q.id) {
        const [row] = await sql`SELECT * FROM expenses WHERE id = ${q.id} AND tenant_id = ${tenantId} AND deleted_at IS NULL`;
        if (!row) return res.status(404).json({ error: 'Gasto no encontrado' });
        return res.json(row);
      }

      // GET listado — filtrado en SQL por tenant + rango de fecha (indexado);
      // el resto de los filtros (categoría, sucursal, estado de pago,
      // búsqueda), el orden y la paginación se aplican sobre ese conjunto ya
      // acotado, evitando traer todo el historial de gastos de la cuenta.
      if (req.method === 'GET') {
        const { from, to } = q.month || q.from || q.to
          ? parseRange(q)
          : { from: '1970-01-01', to: '2999-12-31' }; // sin filtro de fecha explícito → todo el historial
        let rows = await loadExpensesInRange(sql, tenantId, { from, to, locationId: q.location_id || '' });

        if (q.category_id) rows = rows.filter(e => e.category_id === q.category_id);
        if (q.payment_status) rows = rows.filter(e => e.payment_status === q.payment_status);
        if (q.q) {
          const needle = String(q.q).toLowerCase();
          rows = rows.filter(e => (e.description || '').toLowerCase().includes(needle) || (e.supplier_name || '').toLowerCase().includes(needle));
        }

        const sortField = ['date', 'total_amount', 'created_at'].includes(q.sort) ? q.sort : 'date';
        const order = q.order === 'asc' ? 1 : -1;
        rows.sort((a, b) => {
          const av = a[sortField], bv = b[sortField];
          if (av === bv) return 0;
          return av > bv ? order : -order;
        });

        const limit = Math.min(parseInt(q.limit) || 50, 200);
        const page  = Math.max(parseInt(q.page) || 1, 1);
        const total = rows.length;
        const paged = rows.slice((page - 1) * limit, (page - 1) * limit + limit);
        return res.json({ rows: paged, total, page, limit });
      }

      // POST — crear gasto (staff con permiso operativo, o admin+)
      if (req.method === 'POST' && !q.id) {
        const body = req.body || {};
        const { errors, netAmount, taxAmount, totalAmount } = await validateExpenseInput(sql, tenantId, body);
        if (errors.length) return res.status(400).json({ error: errors.join('; ') });

        const id = await F.nextExpenseId(sql, tenantId);
        const [row] = await sql`
          INSERT INTO expenses (
            id, tenant_id, location_id, warehouse_id, date, description, category_id,
            supplier_name, net_amount, tax_amount, total_amount, payment_status, payment_method,
            notes, created_by
          ) VALUES (
            ${id}, ${tenantId}, ${body.location_id || ''}, ${body.warehouse_id || ''}, ${body.date}::date,
            ${String(body.description).trim()}, ${body.category_id}, ${body.supplier_name || ''},
            ${netAmount}, ${taxAmount}, ${totalAmount}, ${body.payment_status || 'pending'}, ${body.payment_method || ''},
            ${body.notes || ''}, ${actor}
          ) RETURNING *`;

        await writeLog(sql, {
          tenant_id: tenantId, actor, action: 'gasto.creado', entity_type: 'expense',
          entity_id: row.id, entity_name: `${row.id} — ${row.description}`,
          details: { description: row.description, total_amount: row.total_amount, category_id: row.category_id },
        });
        return res.status(201).json(row);
      }

      // POST ?id=&action=duplicate — duplicar gasto
      if (req.method === 'POST' && q.id && q.action === 'duplicate') {
        const [src] = await sql`SELECT * FROM expenses WHERE id = ${q.id} AND tenant_id = ${tenantId} AND deleted_at IS NULL`;
        if (!src) return res.status(404).json({ error: 'Gasto no encontrado' });
        const id = await F.nextExpenseId(sql, tenantId);
        const [row] = await sql`
          INSERT INTO expenses (
            id, tenant_id, location_id, warehouse_id, date, description, category_id,
            supplier_name, net_amount, tax_amount, total_amount, payment_status, payment_method, notes, created_by
          ) VALUES (
            ${id}, ${tenantId}, ${src.location_id}, ${src.warehouse_id}, ${src.date}, ${src.description}, ${src.category_id},
            ${src.supplier_name}, ${src.net_amount}, ${src.tax_amount}, ${src.total_amount}, 'pending', ${src.payment_method},
            ${src.notes}, ${actor}
          ) RETURNING *`;
        await writeLog(sql, {
          tenant_id: tenantId, actor, action: 'gasto.duplicado', entity_type: 'expense',
          entity_id: row.id, entity_name: `${row.id} — ${row.description}`, details: { from_id: src.id },
        });
        return res.status(201).json(row);
      }

      // PUT ?id= — editar gasto
      if (req.method === 'PUT' && q.id) {
        const [before] = await sql`SELECT * FROM expenses WHERE id = ${q.id} AND tenant_id = ${tenantId} AND deleted_at IS NULL`;
        if (!before) return res.status(404).json({ error: 'Gasto no encontrado' });
        const body = req.body || {};
        const { errors, netAmount, taxAmount, totalAmount } = await validateExpenseInput(sql, tenantId, body, { partial: true });
        if (errors.length) return res.status(400).json({ error: errors.join('; ') });

        const hasAmounts = body.net_amount !== undefined || body.tax_amount !== undefined || body.total_amount !== undefined;
        const [row] = await sql`
          UPDATE expenses SET
            location_id    = COALESCE(${body.location_id    ?? null}, location_id),
            warehouse_id   = COALESCE(${body.warehouse_id   ?? null}, warehouse_id),
            date           = COALESCE(${body.date           ?? null}, date),
            description    = COALESCE(${body.description !== undefined ? String(body.description).trim() : null}, description),
            category_id    = COALESCE(${body.category_id    ?? null}, category_id),
            supplier_name  = COALESCE(${body.supplier_name  ?? null}, supplier_name),
            net_amount     = COALESCE(${hasAmounts ? netAmount   : null}, net_amount),
            tax_amount     = COALESCE(${hasAmounts ? taxAmount   : null}, tax_amount),
            total_amount   = COALESCE(${hasAmounts ? totalAmount : null}, total_amount),
            payment_status = COALESCE(${body.payment_status  ?? null}, payment_status),
            payment_method = COALESCE(${body.payment_method  ?? null}, payment_method),
            notes          = COALESCE(${body.notes           ?? null}, notes),
            updated_by     = ${actor},
            updated_at     = NOW()
          WHERE id = ${q.id} AND tenant_id = ${tenantId} AND deleted_at IS NULL
          RETURNING *`;
        if (!row) return res.status(404).json({ error: 'Gasto no encontrado' });

        await writeLog(sql, {
          tenant_id: tenantId, actor, action: 'gasto.editado', entity_type: 'expense',
          entity_id: row.id, entity_name: `${row.id} — ${row.description}`,
          details: { before: { description: before.description, total_amount: before.total_amount }, after: { description: row.description, total_amount: row.total_amount } },
        });
        return res.json(row);
      }

      // DELETE ?id= — anular gasto (soft-delete, admin+)
      if (req.method === 'DELETE' && q.id) {
        if (!isAdmin(session)) return res.status(403).json({ error: 'Sólo administradores pueden anular gastos' });
        const [row] = await sql`
          UPDATE expenses SET deleted_at = NOW(), updated_by = ${actor}, updated_at = NOW()
          WHERE id = ${q.id} AND tenant_id = ${tenantId} AND deleted_at IS NULL
          RETURNING *`;
        if (!row) return res.status(404).json({ error: 'Gasto no encontrado' });
        await writeLog(sql, {
          tenant_id: tenantId, actor, action: 'gasto.anulado', entity_type: 'expense',
          entity_id: row.id, entity_name: `${row.id} — ${row.description}`, details: { total_amount: row.total_amount },
        });
        return res.json({ ok: true, deleted: row.id });
      }

      return res.status(405).json({ error: 'Method not allowed' });
    }

    return res.status(404).json({ error: 'Unknown resource' });
  } catch (err) {
    console.error(`finance/${resource} error:`, err);
    return res.status(500).json({ error: err.message });
  }
};

// Expone las funciones puras (sin efectos secundarios en la request/response)
// como propiedades de la función exportada, para que tests/finance.test.js
// pueda probarlas directamente sin duplicar esta lógica. No cambia en nada
// cómo Vercel invoca este archivo (sigue siendo `module.exports(req, res)`).
Object.assign(module.exports, {
  ADMIN_ROLES, isAdmin,
  parseRange, daySpan, previousPeriod, pickGranularity,
  loadOrders, loadExpensesInRange,
  summarizeOrders, sumExpenses, buildIncomeStatement, variation,
  bucketKeyForOrder, bucketKeyForExpense, generateBucketKeys, buildTimeseries,
  validateExpenseInput, PAYMENT_STATUSES,
});
