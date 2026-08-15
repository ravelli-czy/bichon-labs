// api/_finance.js — Finance domain helpers (shared module, not a serverless function)
// Reused by orders.js (cost snapshotting at sale time) and finance.js (Finanzas
// module: reporting + gastos + categorías).
//
// ── IVA / moneda / timezone ──────────────────────────────────────────────
// StockFlow no separa impuesto de venta en ningún punto del sistema hoy: los
// montos guardados en `orders.total` / `orders.items[].price` no distinguen
// neto de IVA. `expenses.tax_amount` y `orders.tax_amount` quedan reservados
// en el modelo para cuando exista esa información (ver setup.js). Hasta
// entonces, Finanzas trata todos los montos existentes como si ya fueran
// netos — es un comportamiento temporal, documentado, no un cálculo real de
// IVA. Igual para moneda: no hay configuración de moneda por cuenta, así que
// se usa CLP (la moneda implícita de todo el sistema — ver `fmt()` en
// frontend/index.html) como default centralizado y reemplazable.
// No hay timezone por cuenta tampoco; se usa America/Santiago (coherente con
// el locale es-CL usado en todo el proyecto) como default centralizado.
const DEFAULT_CURRENCY = 'CLP';
const DEFAULT_TIMEZONE = 'America/Santiago';

// Único estado de orden que se reconoce como venta para Finanzas. Se usa el
// estado real del proyecto (ver ORDER_STATUS_META en frontend/index.html) —
// no se inventan estados nuevos. `cancelled` y `no_entregada` quedan fuera.
const REVENUE_STATUSES = ['entregada'];

function pct(numerator, denominator) {
  if (!denominator) return 0;
  return (numerator / denominator) * 100;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ── Costo de productos / KITs ────────────────────────────────────────────
// "Costo actual" de referencia: el del lote FIFO más viejo con stock activo
// (lo próximo que se va a vender), o si no queda ninguno activo, el del
// último lote registrado (mejor referencia disponible). Se computa en vivo
// contra stock_receipts — products ya no tiene una columna cost cacheada.
// Primero busca en el almacén exacto de la fila; si no hay ningún lote ahí
// (ej. el registro de catálogo, warehouse_id vacío, que nunca tiene lotes
// propios porque Ingreso de inventario siempre exige elegir un almacén
// real), cae a cualquier lote del SKU en cualquier almacén. Si el SKU nunca
// tuvo NINGÚN lote (nunca se compró por Ingreso de inventario — ej. un
// insumo que se cargó a mano hace tiempo y hoy está en 0), cae al último
// costo con el que efectivamente se vendió: la última orden donde aparece,
// directo o como componente de un KIT (ver items[].unitCostAtSale/cost y
// items[].componentBreakdown[].unitCost). Mejor esa referencia que $0.
// Usado para estimar costo cuando NO hay una consumición real de la que
// tomarlo (ver buildSaleSnapshot para el caso con consumición real): el
// backfill de costos históricos, y las líneas de una Pre Compra que no
// cambiaron de cantidad al editar sus items.
async function loadCostMaps(sql, tenantId) {
  const products = await sql`
    SELECT p.sku, p.warehouse_id,
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
        (SELECT COALESCE((item->>'unitCostAtSale')::numeric, (item->>'cost')::numeric)
         FROM orders o, jsonb_array_elements(o.items) AS item
         WHERE o.tenant_id = p.tenant_id AND item->>'sku' = p.sku
         ORDER BY o.created_at DESC LIMIT 1),
        (SELECT (comp->>'unitCost')::numeric
         FROM orders o,
              jsonb_array_elements(o.items) AS item,
              jsonb_array_elements(COALESCE(item->'componentBreakdown', '[]'::jsonb)) AS comp
         WHERE o.tenant_id = p.tenant_id AND comp->>'sku' = p.sku
         ORDER BY o.created_at DESC LIMIT 1),
        0
      ) AS cost
    FROM products p WHERE p.tenant_id = ${tenantId}
  `;
  const kits = await sql`SELECT sku, items FROM kits WHERE tenant_id = ${tenantId} AND warehouse_id = ''`;
  const productsBySkuWh = new Map(); // "sku|warehouse_id" -> cost
  const productsBySku   = new Map(); // sku -> cost (primer match, cualquier almacén)
  for (const p of products) {
    productsBySkuWh.set(`${p.sku}|${p.warehouse_id || ''}`, p.cost || 0);
    if (!productsBySku.has(p.sku)) productsBySku.set(p.sku, p.cost || 0);
  }
  const kitsBySku = new Map();
  for (const k of kits) kitsBySku.set(k.sku, k.items || []);
  return { productsBySkuWh, productsBySku, kitsBySku };
}

function productCost({ productsBySkuWh, productsBySku }, sku, warehouseId) {
  const key = `${sku}|${warehouseId || ''}`;
  if (productsBySkuWh.has(key)) return productsBySkuWh.get(key);
  return productsBySku.get(sku) || 0;
}

// Descompone un KIT (que puede contener otros KITs, vía Mesón Creativo) en
// cantidades de producto base, sumando componentes repetidos en vez de
// contarlos dos veces. `path` evita ciclos; `depth` es un tope de seguridad.
function decomposeKit(maps, kitSku, qty, depth = 0, path = null, acc = null) {
  path = path || new Set();
  acc  = acc  || new Map(); // "sku|warehouse_id" -> cantidad acumulada
  if (depth > 8 || path.has(kitSku)) return acc;
  const items = maps.kitsBySku.get(kitSku);
  if (!items) return acc;
  const nextPath = new Set(path);
  nextPath.add(kitSku);
  for (const comp of items) {
    const compQty = (comp.qty || 0) * qty;
    if (comp.type === 'kit') {
      decomposeKit(maps, comp.sku, compQty, depth + 1, nextPath, acc);
    } else {
      const key = `${comp.sku}|${comp.warehouse_id || ''}`;
      acc.set(key, (acc.get(key) || 0) + compQty);
    }
  }
  return acc;
}

function kitCostBreakdown(maps, kitSku, qty) {
  const acc = decomposeKit(maps, kitSku, qty);
  const components = [];
  let totalCost = 0;
  for (const [key, compQty] of acc) {
    const sep = key.lastIndexOf('|');
    const sku = key.slice(0, sep);
    const warehouseId = key.slice(sep + 1);
    const unitCost = productCost(maps, sku, warehouseId);
    const lineCost = unitCost * compQty;
    totalCost += lineCost;
    components.push({ sku, warehouseId: warehouseId || '', quantity: compQty, unitCost, totalCost: lineCost });
  }
  return { totalCost, components };
}

function kitUnitCost(maps, kitSku) {
  return kitCostBreakdown(maps, kitSku, 1).totalCost;
}

function itemUnitCost(maps, item) {
  return item.type === 'kit' ? kitUnitCost(maps, item.sku) : productCost(maps, item.sku, item.warehouse_id);
}

// ── Snapshot financiero por línea de orden ───────────────────────────────
// Agrega las claves del snapshot financiero pedido (unitSalePrice,
// unitCostAtSale, totalSaleAmount, totalCostAtSale, discountAmount, etc.)
// SIN tocar las claves que el resto de la app ya lee (sku, qty, price, cost,
// type, warehouse_id, name) — sólo agrega, nunca renombra ni elimina, para
// no romper el carrito/comandas/recibos existentes.
function withFinancialSnapshot(items, maps) {
  return (items || []).map(item => {
    const unitCostAtSale  = itemUnitCost(maps, item);
    const unitSalePrice   = item.price || 0;
    const quantity        = item.qty || 0;
    const discountAmount  = item.discount || 0;
    const totalSaleAmount = round2(unitSalePrice * quantity - discountAmount);
    const totalCostAtSale = round2(unitCostAtSale * quantity);
    const snapshot = {
      ...item,
      cost: unitCostAtSale, // compatibilidad: código existente lee item.cost
      productId: item.sku,
      quantity,
      unitSalePrice,
      unitCostAtSale,
      totalSaleAmount,
      totalCostAtSale,
      discountAmount,
    };
    if (item.type === 'kit') {
      snapshot.kitId = item.sku;
      snapshot.componentBreakdown = kitCostBreakdown(maps, item.sku, 1).components;
    } else {
      snapshot.skuId = item.sku;
    }
    return snapshot;
  });
}

// ── Snapshot financiero a partir de consumición REAL (deductStockForItems) ──
// A diferencia de withFinancialSnapshot (que estima el costo con el "costo
// actual" leído de antemano, sin saber qué se va a consumir realmente), acá
// el costo viene de los lotes FIFO que efectivamente se tocaron al crear la
// orden — más preciso cuando una venta cruza dos lotes de distinto costo.
// `consumption` es el arreglo que devuelve deductStockForItems, paralelo a
// `items` (mismo orden, mismo largo).
function buildSaleSnapshot(items, consumption) {
  return (items || []).map((item, i) => {
    const c = consumption[i] || { unitCost: 0, totalCost: 0 };
    const unitCostAtSale  = c.unitCost || 0;
    const unitSalePrice   = item.price || 0;
    const quantity        = item.qty || 0;
    const discountAmount  = item.discount || 0;
    const totalSaleAmount = round2(unitSalePrice * quantity - discountAmount);
    const totalCostAtSale = round2(c.totalCost || 0);
    const snapshot = {
      ...item,
      cost: unitCostAtSale, // compatibilidad: código existente lee item.cost
      productId: item.sku,
      quantity,
      unitSalePrice,
      unitCostAtSale,
      totalSaleAmount,
      totalCostAtSale,
      discountAmount,
    };
    if (item.type === 'kit') {
      snapshot.kitId = item.sku;
      snapshot.componentBreakdown = c.components || [];
    } else {
      snapshot.skuId = item.sku;
      // Reparto real entre almacenes 'venta' de la tienda cuando el sku
      // tenía stock en más de uno (ver _resolveSaleWarehouses en
      // api/_stock.js) — restoreStockForItems lo usa para devolver el stock
      // exactamente a donde salió, no a donde la prioridad actual diría hoy.
      snapshot.warehouseSplits = c.warehouseSplits || [];
    }
    return snapshot;
  });
}

// Costo de ventas de una orden a partir de su snapshot. Usa el costo
// histórico guardado (totalCostAtSale); si la orden es anterior a Finanzas y
// sólo tiene el costo unitario legado (item.cost), lo deriva desde ahí.
// Nunca recalcula con el costo ACTUAL del producto.
function orderCostOfGoods(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  return items.reduce((sum, item) => {
    if (typeof item.totalCostAtSale === 'number') return sum + item.totalCostAtSale;
    if (typeof item.cost === 'number') return sum + item.cost * (item.qty || 0);
    return sum;
  }, 0);
}

// true si TODAS las líneas de la orden tienen algún costo snapshoteado
// (nuevo o legado). Órdenes muy antiguas, previas a cualquier snapshot,
// devuelven false — se marcan como "costo estimado/incompleto" en Finanzas,
// nunca se inventa un costo.
function orderHasReliableCost(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  if (!items.length) return true;
  return items.every(item => typeof item.totalCostAtSale === 'number' || typeof item.cost === 'number');
}

function orderGrossSales(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  return items.reduce((sum, item) => sum + (item.price || 0) * (item.qty || 0), 0);
}

// El despacho cobrado al cliente vive en delivery.slot_cost (nombre legado:
// en realidad es el total de envío — costo base del método + extra del
// horario — ver ventaShippingCost() en frontend/index.html). Es ingreso.
function orderShippingRevenue(order) {
  return order?.delivery?.slot_cost || 0;
}

// Ingresos netos = Ventas brutas + Ingresos por despacho - Descuentos - Devoluciones
function orderNetSales(order) {
  const grossSales      = orderGrossSales(order);
  const shippingRevenue = orderShippingRevenue(order);
  const discounts       = order.discount_amount || 0;
  const refunds         = order.refund_amount || 0;
  return grossSales + shippingRevenue - discounts - refunds;
}

// Descompone una orden en las líneas del Estado de Resultados que le
// corresponden (ver income-statement en api/finance.js).
function orderFinancialSummary(order) {
  const grossSales      = orderGrossSales(order);
  const shippingRevenue = orderShippingRevenue(order);
  const discounts       = order.discount_amount || 0;
  const refunds         = order.refund_amount || 0;
  const netSales         = grossSales + shippingRevenue - discounts - refunds;
  const costOfGoodsSold   = orderCostOfGoods(order);
  const grossProfit       = netSales - costOfGoodsSold;
  const grossMarginPercentage = pct(grossProfit, netSales);
  return {
    orderId: order.id,
    grossSales, shippingRevenue, discounts, refunds, netSales,
    costOfGoodsSold, grossProfit, grossMarginPercentage,
    hasReliableCost: orderHasReliableCost(order),
    deliveredAt: order.delivered_at || null,
  };
}

// ── Categorías de gasto por defecto ──────────────────────────────────────
const DEFAULT_EXPENSE_CATEGORIES = [
  'Arriendo', 'Sueldos', 'Honorarios', 'Publicidad y marketing',
  'Comisiones de medios de pago', 'Servicios básicos', 'Software y suscripciones',
  'Transporte', 'Combustible', 'Logística', 'Packaging', 'Mantenciones',
  'Telefonía e internet', 'Gastos administrativos', 'Otros',
];

// `id` en expense_categories/expenses es una PK global (TEXT PRIMARY KEY,
// sin tenant_id en la clave — a diferencia de products/kits, que sí usan PK
// compuesta (sku, warehouse_id, tenant_id)). Por eso el "próximo ID" se
// calcula sobre TODAS las filas, no sólo las de este tenant — igual que
// orders.js/shipments.js/users.js (ver sus comentarios "id is a plain PK
// shared across tenants"). Calcularlo scoped-por-tenant (como hacía antes)
// producía el mismo CAT-001/EXP-0001 para la primera fila de cada cuenta
// nueva y chocaba contra la PK global de la primera cuenta que ya lo tenía.
async function nextCategoryId(sql, tenantId) {
  const [{ max_num }] = await sql`
    SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 5) AS INTEGER)), 0) AS max_num
    FROM expense_categories WHERE id ~ '^CAT-[0-9]+$'
  `;
  return 'CAT-' + String(parseInt(max_num) + 1).padStart(3, '0');
}

async function nextExpenseId(sql, tenantId) {
  const [{ max_num }] = await sql`
    SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 5) AS INTEGER)), 0) AS max_num
    FROM expenses WHERE id ~ '^EXP-[0-9]+$'
  `;
  return 'EXP-' + String(parseInt(max_num) + 1).padStart(4, '0');
}

// Idempotente — segura de llamar repetidas veces (setup.js al iniciar, y al
// crear un tenant nuevo). Nunca duplica ni pisa categorías ya creadas
// (incluida una que la cuenta haya renombrado — se matchea por nombre).
async function seedDefaultCategories(sql, tenantId, actor = 'sistema') {
  let created = 0;
  for (const name of DEFAULT_EXPENSE_CATEGORIES) {
    const [existing] = await sql`SELECT id FROM expense_categories WHERE tenant_id = ${tenantId} AND name = ${name}`;
    if (existing) continue;
    const id = await nextCategoryId(sql, tenantId);
    await sql`
      INSERT INTO expense_categories (id, tenant_id, name, is_active, is_default, created_by)
      VALUES (${id}, ${tenantId}, ${name}, TRUE, TRUE, ${actor})
      ON CONFLICT (tenant_id, name) DO NOTHING
    `;
    created++;
  }
  return created;
}

// ── Zona horaria ──────────────────────────────────────────────────────────
// Extrae año/mes/día/hora de una fecha en una zona horaria dada, usando Intl
// (soportado nativamente en el runtime de Vercel/Node — sin dependencias
// nuevas). Es la base para agrupar por hora/día/semana/mes sin errores de
// "salto de día" por UTC (ver sección 14 del brief de Finanzas).
function zonedParts(date, tz = DEFAULT_TIMEZONE) {
  const d = date instanceof Date ? date : new Date(date);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
    }).formatToParts(d).map(p => [p.type, p.value])
  );
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: parts.hour === '24' ? 0 : +parts.hour };
}

function zonedDateKey(date, tz = DEFAULT_TIMEZONE) {
  const { year, month, day } = zonedParts(date, tz);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

module.exports = {
  DEFAULT_CURRENCY, DEFAULT_TIMEZONE, REVENUE_STATUSES, DEFAULT_EXPENSE_CATEGORIES,
  pct, round2,
  loadCostMaps, productCost, decomposeKit, kitCostBreakdown, kitUnitCost, itemUnitCost,
  withFinancialSnapshot, buildSaleSnapshot, orderCostOfGoods, orderHasReliableCost, orderGrossSales,
  orderShippingRevenue, orderNetSales, orderFinancialSummary,
  nextCategoryId, nextExpenseId, seedDefaultCategories,
  zonedParts, zonedDateKey,
};
