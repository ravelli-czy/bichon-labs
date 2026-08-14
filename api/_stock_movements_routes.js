// api/_stock_movements_routes.js — tab Historial de Inventario: lista de
// movimientos de stock del año en curso (ventas, restituciones, ingresos de
// inventario — ver stock_movements en api/setup.js y quién la escribe:
// deductStockForItems/restoreStockForItems en api/_stock.js, y el POST de
// api/_stock_receipts_routes.js) + el valor de inventario actual, para que
// el frontend arme el gráfico "valor de stock" del año reconstruyendo hacia
// atrás desde ese valor real con cada value_delta (ver renderStockHistory en
// frontend/index.html).
//
// NO es una Serverless Function (prefijo `_`, mismo motivo que
// _stock_receipts_routes.js) — se invoca desde api/products.js cuando
// `req.query.resource === 'stock-movements'`.
//
// GET /api/products?resource=stock-movements → { current_value, movements }

const { loadCostMaps, productCost } = require('./_finance');

const STOCK_MOVEMENT_RESOURCES = ['stock-movements'];

// Valor total de inventario ahora mismo: sum(stock * costo actual) sobre
// todas las filas con stock físico (warehouse_id real, no el registro de
// catálogo) — mismo costo en vivo que usa Finanzas (loadCostMaps/productCost).
async function currentStockValue(sql, tenantId) {
  const maps = await loadCostMaps(sql, tenantId);
  const rows = await sql`
    SELECT sku, warehouse_id, stock FROM products
    WHERE tenant_id = ${tenantId} AND warehouse_id != ''
  `;
  return rows.reduce((sum, r) => sum + (r.stock || 0) * productCost(maps, r.sku, r.warehouse_id), 0);
}

async function handleStockMovementsResource(req, res, sql, session, tenantId, actor) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString();
    const [movements, current_value] = await Promise.all([
      sql`
        SELECT id, sku, warehouse_id, product_name, type, delta, unit_cost, value_delta, stock_after, ref_type, ref_id, created_at
        FROM stock_movements
        WHERE tenant_id = ${tenantId} AND created_at >= ${yearStart}
        ORDER BY created_at ASC
      `,
      currentStockValue(sql, tenantId),
    ]);
    return res.json({ current_value, movements });
  } catch (err) {
    console.error('stock-movements error:', err);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = { handleStockMovementsResource, STOCK_MOVEMENT_RESOURCES };
