// api/_stock_movements_routes.js — Historial de movimientos de UN producto/
// SKU+almacén específico (tab "Historial" dentro de la ficha de Editar
// stock / Editar producto en Inventario) — ver stock_movements en
// api/setup.js y quién la escribe: deductStockForItems/restoreStockForItems
// en api/_stock.js, y el POST de api/_stock_receipts_routes.js.
//
// Cada fila ya trae stock_after (el stock real de ese SKU/almacén después
// del movimiento), así que el gráfico se arma directo con esos puntos —no
// hace falta reconstruir nada.
//
// NO es una Serverless Function (prefijo `_`, mismo motivo que
// _stock_receipts_routes.js) — se invoca desde api/products.js cuando
// `req.query.resource === 'stock-movements'`.
//
// GET /api/products?resource=stock-movements&sku=X&warehouse_id=Y
//   → { movements: [...] } — de más antiguo a más reciente

const STOCK_MOVEMENT_RESOURCES = ['stock-movements'];

async function handleStockMovementsResource(req, res, sql, session, tenantId, actor) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const sku = req.query?.sku;
  if (!sku) return res.status(400).json({ error: 'sku es requerido' });
  const warehouseId = req.query?.warehouse_id || '';
  try {
    const movements = await sql`
      SELECT id, sku, warehouse_id, product_name, type, delta, unit_cost, value_delta, stock_after, ref_type, ref_id, created_at
      FROM stock_movements
      WHERE tenant_id = ${tenantId} AND sku = ${sku} AND warehouse_id = ${warehouseId}
      ORDER BY created_at ASC
    `;
    return res.json({ movements });
  } catch (err) {
    console.error('stock-movements error:', err);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = { handleStockMovementsResource, STOCK_MOVEMENT_RESOURCES };
