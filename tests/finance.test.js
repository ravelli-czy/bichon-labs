// tests/finance.test.js — Pruebas del módulo Finanzas.
//
// El proyecto no tenía infraestructura de tests previa (ver README/docker-compose:
// microservicios legacy sin suite de pruebas), así que estas pruebas usan sólo
// `assert` de Node (sin dependencias nuevas) contra las funciones PURAS de
// api/_finance.js y api/_finance_routes.js (cálculos, validación, agregación).
// api/_finance_routes.js NO es una Serverless Function — su lógica se invoca
// desde api/orders.js cuando `?resource=` matchea un recurso de Finanzas (se
// consolidó ahí para no exceder el tope de 12 Serverless Functions del plan
// Hobby de Vercel; ver el comentario al inicio de _finance_routes.js). Estas
// pruebas no requieren una base de datos real: las funciones que sí consultan
// Postgres (loadOrders/loadExpensesInRange/validateExpenseInput) se ejercitan
// con un `sql` mock que imita el driver de @neondatabase/serverless (una
// función usable como tagged template).
//
// Ejecutar: node tests/finance.test.js   (o `npm test` desde la raíz)

const assert = require('assert');
const F = require('../api/_finance');
const fin = require('../api/_finance_routes');

let pass = 0, fail = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    pass++;
  } catch (err) {
    fail++;
    failures.push({ name, err });
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    pass++;
  } catch (err) {
    fail++;
    failures.push({ name, err });
  }
}

// ── Mock del driver Neon: una función tag-template que graba cada consulta
// y responde según qué tabla aparece en el texto de la query ────────────────
function makeSqlMock({ categories = false, locales = false, warehouses = false, rows = [] } = {}) {
  const calls = [];
  const sql = async (strings, ...values) => {
    calls.push({ text: strings.join('?'), values });
    const text = strings.join(' ');
    if (text.includes('expense_categories')) return categories ? [{ id: values[values.length - 1] }] : [];
    if (text.includes('FROM locales')) return locales ? [{ id: values[values.length - 1] }] : [];
    if (text.includes('FROM warehouses')) return warehouses ? [{ id: values[values.length - 1] }] : [];
    return rows;
  };
  sql.calls = calls;
  return sql;
}

// ══════════════════════════════════════════════════════════════════════════
// 1. Ingresos netos, descuentos, devoluciones
// ══════════════════════════════════════════════════════════════════════════
test('orderNetSales: ventas brutas + despacho - descuentos - devoluciones', () => {
  const order = {
    items: [{ price: 1000, qty: 3 }], // grossSales = 3000
    delivery: { slot_cost: 500 },     // shippingRevenue = 500
    discount_amount: 200,
    refund_amount: 100,
  };
  assert.strictEqual(F.orderGrossSales(order), 3000);
  assert.strictEqual(F.orderShippingRevenue(order), 500);
  assert.strictEqual(F.orderNetSales(order), 3000 + 500 - 200 - 100); // 3200
});

test('orderNetSales: sin descuentos/devoluciones/despacho por defecto', () => {
  const order = { items: [{ price: 500, qty: 2 }] };
  assert.strictEqual(F.orderNetSales(order), 1000);
});

test('orderFinancialSummary: utilidad bruta y margen bruto', () => {
  // Ingresos netos: 10.000 / Costo de ventas: 6.000 → Utilidad bruta 4.000, margen 40%
  const order = {
    id: 'ORD-TEST',
    items: [{ price: 10000, qty: 1, totalCostAtSale: 6000 }],
  };
  const s = F.orderFinancialSummary(order);
  assert.strictEqual(s.netSales, 10000);
  assert.strictEqual(s.costOfGoodsSold, 6000);
  assert.strictEqual(s.grossProfit, 4000);
  assert.strictEqual(s.grossMarginPercentage, 40);
});

test('margen bruto es 0% (no NaN/Infinity) cuando los ingresos netos son 0', () => {
  const order = { items: [] };
  const s = F.orderFinancialSummary(order);
  assert.strictEqual(s.netSales, 0);
  assert.strictEqual(s.grossMarginPercentage, 0);
  assert.ok(Number.isFinite(s.grossMarginPercentage));
});

test('pct(): división por cero segura', () => {
  assert.strictEqual(F.pct(100, 0), 0);
  assert.strictEqual(F.pct(0, 0), 0);
  assert.strictEqual(F.pct(50, 200), 25);
});

// ══════════════════════════════════════════════════════════════════════════
// 2. Costo de productos y KITs (incl. anidados, sin doble conteo)
// ══════════════════════════════════════════════════════════════════════════
test('productCost: resuelve por sku+almacén, cae a cualquier almacén si no hay match', () => {
  const maps = { productsBySkuWh: new Map([['PRD-1|WH-1', 100]]), productsBySku: new Map([['PRD-1', 90]]) };
  assert.strictEqual(F.productCost(maps, 'PRD-1', 'WH-1'), 100);
  assert.strictEqual(F.productCost(maps, 'PRD-1', 'WH-2'), 90); // sin match exacto → fallback
  assert.strictEqual(F.productCost(maps, 'PRD-X', ''), 0);
});

function simpleKitMaps() {
  // KIT-A = 2x PRD-1 (costo 100) + 1x PRD-2 (costo 50) → costo unitario 250
  return {
    productsBySkuWh: new Map(),
    productsBySku: new Map([['PRD-1', 100], ['PRD-2', 50]]),
    kitsBySku: new Map([
      ['KIT-A', [{ type: 'product', sku: 'PRD-1', qty: 2 }, { type: 'product', sku: 'PRD-2', qty: 1 }]],
    ]),
  };
}
test('kitUnitCost: KIT simple sin componentes anidados', () => {
  assert.strictEqual(F.kitUnitCost(simpleKitMaps(), 'KIT-A'), 250);
});

function nestedKitMaps() {
  // KIT-B contiene 1x KIT-A + 1x PRD-1 → descompuesto: PRD-1 x(2+1)=3, PRD-2 x1
  // Costo esperado: 3*100 + 1*50 = 350 — sin contar PRD-1 dos veces por separado.
  const maps = simpleKitMaps();
  maps.kitsBySku.set('KIT-B', [{ type: 'kit', sku: 'KIT-A', qty: 1 }, { type: 'product', sku: 'PRD-1', qty: 1 }]);
  return maps;
}
test('kitCostBreakdown: KIT que contiene otro KIT — cantidades correctas, sin doble conteo', () => {
  const maps = nestedKitMaps();
  const { totalCost, components } = F.kitCostBreakdown(maps, 'KIT-B', 1);
  assert.strictEqual(totalCost, 350);
  const bySku = Object.fromEntries(components.map(c => [c.sku, c.quantity]));
  assert.strictEqual(bySku['PRD-1'], 3); // 2 (vía KIT-A) + 1 (directo) — una sola línea, no duplicada
  assert.strictEqual(bySku['PRD-2'], 1);
  assert.strictEqual(components.filter(c => c.sku === 'PRD-1').length, 1); // no aparece dos veces
});

test('kitCostBreakdown: multiplica correctamente cantidades y niveles al vender más de 1 KIT', () => {
  const maps = nestedKitMaps();
  const { totalCost } = F.kitCostBreakdown(maps, 'KIT-B', 3); // 3 KITs vendidos
  assert.strictEqual(totalCost, 350 * 3);
});

test('decomposeKit: guarda de ciclos (KIT que se referencia a sí mismo) no cuelga ni explota', () => {
  const maps = simpleKitMaps();
  maps.kitsBySku.set('KIT-LOOP', [{ type: 'kit', sku: 'KIT-LOOP', qty: 1 }]);
  const acc = F.decomposeKit(maps, 'KIT-LOOP', 1);
  assert.strictEqual(acc.size, 0); // no hay productos base — sólo se corta el ciclo
});

test('withFinancialSnapshot: agrega snapshot sin romper las claves existentes (sku/qty/price/type)', () => {
  const maps = simpleKitMaps();
  const items = [
    { sku: 'PRD-1', type: 'product', qty: 2, price: 500 },
    { sku: 'KIT-A', type: 'kit', qty: 1, price: 1000 },
  ];
  const snap = F.withFinancialSnapshot(items, maps);
  // Claves legadas intactas
  assert.strictEqual(snap[0].sku, 'PRD-1');
  assert.strictEqual(snap[0].qty, 2);
  assert.strictEqual(snap[0].price, 500);
  // Snapshot nuevo agregado
  assert.strictEqual(snap[0].unitCostAtSale, 100);
  assert.strictEqual(snap[0].totalCostAtSale, 200);
  assert.strictEqual(snap[0].totalSaleAmount, 1000);
  assert.strictEqual(snap[0].skuId, 'PRD-1');
  assert.strictEqual(snap[0].kitId, undefined);
  // KIT: incluye desglose de componentes
  assert.strictEqual(snap[1].kitId, 'KIT-A');
  assert.strictEqual(snap[1].unitCostAtSale, 250);
  assert.ok(Array.isArray(snap[1].componentBreakdown));
  assert.strictEqual(snap[1].componentBreakdown.length, 2);
});

// ══════════════════════════════════════════════════════════════════════════
// 3. Costo histórico — nunca recalcular con el costo actual
// ══════════════════════════════════════════════════════════════════════════
test('orderCostOfGoods: usa totalCostAtSale (snapshot), no el costo actual del producto', () => {
  const order = { items: [{ qty: 5, totalCostAtSale: 999 }] }; // costo actual sería otro, pero no se usa
  assert.strictEqual(F.orderCostOfGoods(order), 999);
});
test('orderCostOfGoods: cae al snapshot legado (item.cost unitario) si no hay totalCostAtSale', () => {
  const order = { items: [{ qty: 4, cost: 25 }] };
  assert.strictEqual(F.orderCostOfGoods(order), 100);
});
test('orderHasReliableCost: false para órdenes previas a cualquier snapshot (sin costo)', () => {
  assert.strictEqual(F.orderHasReliableCost({ items: [{ qty: 1 }] }), false);
  assert.strictEqual(F.orderHasReliableCost({ items: [{ qty: 1, cost: 10 }] }), true);
  assert.strictEqual(F.orderHasReliableCost({ items: [] }), true);
});

// ══════════════════════════════════════════════════════════════════════════
// 4. EBITDA / Margen EBITDA — casos del brief (positivo y negativo)
// ══════════════════════════════════════════════════════════════════════════
test('EBITDA y margen EBITDA — caso positivo (Ingresos 10.000 / Costo 6.000 / Gastos 3.000)', () => {
  const orders = [{ items: [{ price: 10000, qty: 1, totalCostAtSale: 6000 }] }];
  const expenses = [{ total_amount: 3000 }];
  const stmt = fin.buildIncomeStatement(orders, expenses);
  assert.strictEqual(stmt.netSales, 10000);
  assert.strictEqual(stmt.costOfGoodsSold, 6000);
  assert.strictEqual(stmt.grossProfit, 4000);
  assert.strictEqual(stmt.grossMarginPercentage, 40);
  assert.strictEqual(stmt.operatingExpenses, 3000);
  assert.strictEqual(stmt.ebitda, 1000);
  assert.strictEqual(stmt.ebitdaMarginPercentage, 10);
});

test('EBITDA negativo — caso del brief (Ingresos 10.000 / Costo 6.000 / Gastos 5.000)', () => {
  const orders = [{ items: [{ price: 10000, qty: 1, totalCostAtSale: 6000 }] }];
  const expenses = [{ total_amount: 5000 }];
  const stmt = fin.buildIncomeStatement(orders, expenses);
  assert.strictEqual(stmt.ebitda, -1000);
  assert.strictEqual(stmt.ebitdaMarginPercentage, -10);
});

test('período sin ventas: EBITDA = -gastos, márgenes en 0% (no división inválida)', () => {
  const stmt = fin.buildIncomeStatement([], [{ total_amount: 500 }]);
  assert.strictEqual(stmt.netSales, 0);
  assert.strictEqual(stmt.grossMarginPercentage, 0);
  assert.strictEqual(stmt.ebitda, -500);
  assert.strictEqual(stmt.ebitdaMarginPercentage, 0); // netSales=0 → 0%, no -Infinity
  assert.ok(Number.isFinite(stmt.ebitdaMarginPercentage));
});

test('período sin ventas ni gastos: todo en cero, ordersCount 0', () => {
  const stmt = fin.buildIncomeStatement([], []);
  assert.strictEqual(stmt.ordersCount, 0);
  assert.strictEqual(stmt.netSales, 0);
  assert.strictEqual(stmt.ebitda, 0);
});

// ══════════════════════════════════════════════════════════════════════════
// 5. Evitar doble contabilización de órdenes
// ══════════════════════════════════════════════════════════════════════════
test('summarizeOrders: cada orden se cuenta una sola vez aunque se sume dos veces la MISMA referencia', () => {
  const order = { items: [{ price: 100, qty: 1, totalCostAtSale: 40 }] };
  const summary = fin.summarizeOrders([order]); // una sola vez en la lista
  assert.strictEqual(summary.ordersCount, 1);
  assert.strictEqual(summary.netSales, 100);
});

// ══════════════════════════════════════════════════════════════════════════
// 6. Comparación con período anterior
// ══════════════════════════════════════════════════════════════════════════
test('previousPeriod: mismo largo que el período actual, inmediatamente anterior', () => {
  // 7 días (2026-01-08 a 2026-01-14) → anterior debe ser 2026-01-01 a 2026-01-07
  const prev = fin.previousPeriod('2026-01-08', '2026-01-14');
  assert.strictEqual(prev.from, '2026-01-01');
  assert.strictEqual(prev.to, '2026-01-07');
});

test('previousPeriod: mes actual (31 días) vs mes anterior de igual duración', () => {
  const prev = fin.previousPeriod('2026-02-01', '2026-02-28'); // 28 días
  assert.strictEqual(fin.daySpan(prev.from, prev.to), 28);
});

test('variation(): calcula absoluto, porcentual y tendencia', () => {
  const v = fin.variation(120, 100);
  assert.strictEqual(v.absolute, 20);
  assert.strictEqual(v.percentage, 20);
  assert.strictEqual(v.trend, 'up');
  const flat = fin.variation(50, 50);
  assert.strictEqual(flat.trend, 'flat');
  const fromZero = fin.variation(10, 0);
  assert.strictEqual(fromZero.percentage, 100); // sin dividir por cero
});

// ══════════════════════════════════════════════════════════════════════════
// 7. Zona horaria — sin saltos de día por UTC
// ══════════════════════════════════════════════════════════════════════════
test('zonedDateKey: una hora temprana UTC cae en el día ANTERIOR en America/Santiago', () => {
  // 2026-01-01T02:00:00Z es, en Santiago (UTC-3 en verano), 2025-12-31 23:00 local.
  const key = F.zonedDateKey('2026-01-01T02:00:00.000Z', 'America/Santiago');
  assert.strictEqual(key, '2025-12-31');
  // El error típico (usar la fecha UTC directamente) daría '2026-01-01' — distinto.
  assert.notStrictEqual(key, new Date('2026-01-01T02:00:00.000Z').toISOString().slice(0, 10));
});

// ══════════════════════════════════════════════════════════════════════════
// 8. Validación de gastos (misma validación que corre en el backend real)
// ══════════════════════════════════════════════════════════════════════════
testAsync('validateExpenseInput: rechaza gasto sin fecha/descripción/categoría/monto', async () => {
  const sql = makeSqlMock({ categories: false });
  const { errors } = await fin.validateExpenseInput(sql, 'TEN-001', {});
  assert.ok(errors.some(e => /[Ff]echa/.test(e)));
  assert.ok(errors.some(e => /[Dd]escripción/.test(e)));
  assert.ok(errors.some(e => /[Cc]ategoría/.test(e)));
});

testAsync('validateExpenseInput: rechaza categoría/sucursal que no pertenece al tenant', async () => {
  const sql = makeSqlMock({ categories: false, locales: false });
  const { errors } = await fin.validateExpenseInput(sql, 'TEN-001', {
    date: '2026-01-01', description: 'Test', category_id: 'CAT-OTRO-TENANT', location_id: 'LOC-OTRO-TENANT',
    net_amount: 100, tax_amount: 0, total_amount: 100,
  });
  assert.ok(errors.some(e => /categoría no pertenece/.test(e)));
  assert.ok(errors.some(e => /sucursal no pertenece/.test(e)));
});

testAsync('validateExpenseInput: rechaza monto <= 0 y neto+IVA != total', async () => {
  const sql = makeSqlMock({ categories: true });
  const zero = await fin.validateExpenseInput(sql, 'TEN-001', {
    date: '2026-01-01', description: 'Test', category_id: 'CAT-001', net_amount: 0, tax_amount: 0, total_amount: 0,
  });
  assert.ok(zero.errors.some(e => /mayor que cero/.test(e)));

  const mismatch = await fin.validateExpenseInput(sql, 'TEN-001', {
    date: '2026-01-01', description: 'Test', category_id: 'CAT-001', net_amount: 100, tax_amount: 19, total_amount: 200,
  });
  assert.ok(mismatch.errors.some(e => /neto \+ IVA/.test(e)));
});

testAsync('validateExpenseInput: acepta un gasto válido sin errores', async () => {
  const sql = makeSqlMock({ categories: true, locales: true, warehouses: true });
  const { errors, totalAmount } = await fin.validateExpenseInput(sql, 'TEN-001', {
    date: '2026-01-01', description: 'Arriendo enero', category_id: 'CAT-001', location_id: 'LOC-001',
    net_amount: 100000, tax_amount: 19000, total_amount: 119000, payment_status: 'paid',
  });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(totalAmount, 119000);
});

// ══════════════════════════════════════════════════════════════════════════
// 9. Aislamiento multi-tenant — toda consulta de Finanzas filtra por tenant_id
// ══════════════════════════════════════════════════════════════════════════
testAsync('loadOrders: siempre incluye el tenant_id resuelto del backend en la consulta (todas las variantes de filtro)', async () => {
  const variants = [
    {},
    { locationId: 'LOC-001' },
    { salesChannel: 'whatsapp' },
    { locationId: 'LOC-001', salesChannel: 'whatsapp' },
  ];
  for (const extra of variants) {
    const sql = makeSqlMock();
    await fin.loadOrders(sql, 'TEN-ACC-A', { from: '2026-01-01', to: '2026-01-31', ...extra });
    const call = sql.calls[0];
    assert.ok(call.text.includes('tenant_id'), 'la query debe filtrar por tenant_id');
    assert.ok(call.values.includes('TEN-ACC-A'), 'el tenant_id resuelto del backend debe viajar como parámetro');
  }
});

testAsync('loadExpensesInRange: siempre incluye tenant_id y excluye anulados (deleted_at IS NULL)', async () => {
  const sql = makeSqlMock();
  await fin.loadExpensesInRange(sql, 'TEN-ACC-B', { from: '2026-01-01', to: '2026-01-31' });
  const call = sql.calls[0];
  assert.ok(call.text.includes('tenant_id'));
  assert.ok(call.text.includes('deleted_at IS NULL'));
  assert.ok(call.values.includes('TEN-ACC-B'));
});

test('isAdmin: sólo admin/superadmin/master gestionan categorías y anulan gastos — staff no', () => {
  assert.strictEqual(fin.isAdmin({ role: 'staff' }), false);
  assert.strictEqual(fin.isAdmin({ role: 'admin' }), true);
  assert.strictEqual(fin.isAdmin({ role: 'superadmin' }), true);
  assert.strictEqual(fin.isAdmin({ role: 'master' }), true);
});

// ══════════════════════════════════════════════════════════════════════════
// 10. Granularidad de la serie temporal
// ══════════════════════════════════════════════════════════════════════════
test('pickGranularity: hora para 1 día, día para rangos cortos, semana para medianos, mes para largos', () => {
  assert.strictEqual(fin.pickGranularity('2026-01-01', '2026-01-01'), 'hour');
  assert.strictEqual(fin.pickGranularity('2026-01-01', '2026-01-15'), 'day');
  assert.strictEqual(fin.pickGranularity('2026-01-01', '2026-03-01'), 'week');
  assert.strictEqual(fin.pickGranularity('2026-01-01', '2026-12-31'), 'month');
});

test('buildTimeseries: genera buckets continuos aunque un día no tenga datos', () => {
  const orders = [{ delivered_at: '2026-01-01T15:00:00.000Z', items: [{ price: 100, qty: 1, totalCostAtSale: 40 }] }];
  const series = fin.buildTimeseries(orders, [], '2026-01-01', '2026-01-03', 'day');
  assert.strictEqual(series.length, 3); // 3 días generados, aunque sólo el primero tenga ventas
  assert.strictEqual(series[1].netSales, 0);
  assert.strictEqual(series[1].grossMarginPercentage, 0);
});

// ── Resultado ────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  for (const f of failures) {
    console.error(`\n✗ ${f.name}`);
    console.error(f.err.message);
  }
  process.exit(1);
}
