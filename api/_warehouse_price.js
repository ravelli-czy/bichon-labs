// api/_warehouse_price.js — Precio único por tienda entre almacenes 'venta'.
// Compartido entre api/products.js (POST) y api/products/[sku].js (PUT) —
// no es una Serverless Function propia (prefijo `_`, mismo motivo que
// _stock.js: tope de 12 funciones en el plan Hobby de Vercel).
//
// El selector de Ventas colapsa el stock de un sku a una sola fila por
// tienda (suma de todos sus almacenes 'venta') y necesita UN precio para
// mostrar/cobrar — por eso el precio de un sku debe ser idéntico en todos
// los almacenes 'venta' de una misma tienda. Devuelve null si no hay
// conflicto, o un objeto de error listo para responder con 400 si lo hay.
async function checkSalePriceMatch(sql, tenantId, sku, warehouseId, price) {
  if (!sku || price === undefined || price === null || !warehouseId) return null;
  const [wh] = await sql`SELECT type, local_id FROM warehouses WHERE id = ${warehouseId} AND tenant_id = ${tenantId}`;
  if (!wh || wh.type !== 'venta' || !wh.local_id) return null;

  const [mismatch] = await sql`
    SELECT p.warehouse_id, w.name AS warehouse_name, p.price
    FROM products p
    JOIN warehouses w ON w.id = p.warehouse_id AND w.tenant_id = p.tenant_id
    WHERE p.sku = ${sku} AND p.tenant_id = ${tenantId} AND w.local_id = ${wh.local_id}
      AND w.type = 'venta' AND p.warehouse_id != ${warehouseId} AND p.price != ${price}
    LIMIT 1
  `;
  if (!mismatch) return null;
  return { error: `El precio debe ser el mismo en todos los almacenes de venta de la tienda — ${mismatch.warehouse_name} ya tiene ${mismatch.price}` };
}

module.exports = { checkSalePriceMatch };
