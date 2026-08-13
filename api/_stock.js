// api/_stock.js — shared stock deduct/restore helpers for order items
// (products directly, KITs via their components). Used by api/orders.js
// (creating an order) and api/orders/[id].js (editing a Pre Compra's items
// during "Confirmando" — items already deducted at creation need their
// delta reconciled, not re-deducted from scratch).
//
// Costeo: cada venta consume stock_receipts lote por lote, del más antiguo
// al más nuevo (FIFO) — ver remaining_qty en api/_stock_receipts_routes.js.
// products.cost siempre queda igual al unit_cost del lote más viejo con
// remaining_qty > 0 (lo próximo que se va a vender), así el snapshot de
// costo que toma _finance.js al momento de la venta (ANTES de que esta
// deducción corra) ya refleja el costo correcto del lote que se está por
// consumir. Si los lotes se agotan a mitad de una venta (sobreventa de un
// insumo que no bloquea la orden), lo que sobra simplemente no tiene lote
// del cual descontar — el costo del producto no se toca más allá de eso.

// A KIT's components can live in DIFFERENT warehouses of the SAME store
// (distinct almacenes/closets), so the right warehouse for a component is
// resolved by store (locationId), not by the order's blanket warehouse_id —
// only falls back to that blanket id when the store lookup is ambiguous.
async function _componentWarehouseId(sql, tenantId, sku, locationId, fallbackWid) {
  if (locationId) {
    const rows = await sql`
      SELECT p.warehouse_id
      FROM products p
      JOIN warehouses w ON w.id = p.warehouse_id AND w.tenant_id = p.tenant_id
      WHERE p.sku = ${sku} AND p.tenant_id = ${tenantId} AND w.local_id = ${locationId}
    `;
    if (rows.length === 1) return rows[0].warehouse_id;
  }
  return fallbackWid;
}

// Deja products.cost apuntando al lote más viejo con remaining_qty > 0. Si
// no queda ningún lote activo, no lo toca — mantiene la última referencia
// conocida en vez de resetear a 0 (sirve para mostrar "cuánto costaba"
// mientras está sin stock).
async function _syncProductCost(sql, tenantId, sku, wid) {
  const [oldest] = await sql`
    SELECT unit_cost FROM stock_receipts
    WHERE tenant_id = ${tenantId} AND sku = ${sku} AND warehouse_id = ${wid} AND remaining_qty > 0
    ORDER BY created_at ASC LIMIT 1
  `;
  if (!oldest) return;
  await sql`
    UPDATE products SET cost = ${oldest.unit_cost}
    WHERE sku = ${sku} AND warehouse_id = ${wid} AND tenant_id = ${tenantId}
  `;
}

// Consume `qty` de stock_receipts para (sku, wid), lote por lote del más
// antiguo al más nuevo. No lanza error si los lotes no alcanzan — sólo
// descuenta lo que hay, igual que products.stock se clampea en 0.
async function _consumeLotsFifo(sql, tenantId, sku, wid, qty) {
  if (!(qty > 0)) return;
  let remaining = qty;
  const lots = await sql`
    SELECT id, remaining_qty FROM stock_receipts
    WHERE tenant_id = ${tenantId} AND sku = ${sku} AND warehouse_id = ${wid} AND remaining_qty > 0
    ORDER BY created_at ASC
  `;
  for (const lot of lots) {
    if (remaining <= 0) break;
    const take = Math.min(lot.remaining_qty, remaining);
    if (take <= 0) continue;
    await sql`UPDATE stock_receipts SET remaining_qty = remaining_qty - ${take} WHERE id = ${lot.id}`;
    remaining -= take;
  }
  await _syncProductCost(sql, tenantId, sku, wid);
}

// Inversa de _consumeLotsFifo — se usa al restaurar stock (orden editada o
// cancelada). Devuelve la cantidad al lote más viejo activo, para no alterar
// el orden FIFO de lo que ya había. Si no queda ningún lote (se vendió todo
// lo que había), crea uno nuevo al costo actual del producto — es la mejor
// referencia disponible, no hay forma de saber de qué lote salió realmente
// sin un registro de consumo por línea de orden (fuera del alcance acá).
async function _restoreLotsFifo(sql, tenantId, sku, wid, qty) {
  if (!(qty > 0)) return;
  const [oldest] = await sql`
    SELECT id FROM stock_receipts
    WHERE tenant_id = ${tenantId} AND sku = ${sku} AND warehouse_id = ${wid} AND remaining_qty > 0
    ORDER BY created_at ASC LIMIT 1
  `;
  if (oldest) {
    await sql`UPDATE stock_receipts SET remaining_qty = remaining_qty + ${qty} WHERE id = ${oldest.id}`;
    return;
  }
  const [product] = await sql`
    SELECT name, cost FROM products WHERE sku = ${sku} AND warehouse_id = ${wid} AND tenant_id = ${tenantId}
  `;
  if (!product) return;
  const id = 'RESTORE-' + sku + '-' + (wid || 'x') + '-' + Date.now().toString(36);
  await sql`
    INSERT INTO stock_receipts
      (id, tenant_id, sku, warehouse_id, product_name, form_label, factor, qty_purchased, total_cost, units_added, unit_cost, new_avg_cost, remaining_qty, created_by)
    VALUES
      (${id}, ${tenantId}, ${sku}, ${wid}, ${product.name}, 'Restaurado (orden editada o cancelada)', 1, ${qty}, ${qty * (product.cost || 0)}, ${qty}, ${product.cost || 0}, ${product.cost || 0}, ${qty}, 'sistema')
    ON CONFLICT (id) DO NOTHING
  `;
  await _syncProductCost(sql, tenantId, sku, wid);
}

async function _deductKit(sql, kitSku, qty, wid, tenantId, locationId) {
  const [kit] = await sql`SELECT items FROM kits WHERE sku = ${kitSku} AND warehouse_id = '' AND tenant_id = ${tenantId}`;
  if (!kit?.items) return;
  for (const comp of kit.items) {
    if (comp.type === 'kit') {
      await _deductKit(sql, comp.sku, comp.qty * qty, wid, tenantId, locationId);
    } else {
      const compWid = await _componentWarehouseId(sql, tenantId, comp.sku, locationId, wid);
      await sql`UPDATE products SET stock = GREATEST(0, stock - ${comp.qty * qty}), updated_at = NOW()
        WHERE sku = ${comp.sku} AND warehouse_id = ${compWid} AND tenant_id = ${tenantId}`;
      await _consumeLotsFifo(sql, tenantId, comp.sku, compWid, comp.qty * qty);
    }
  }
}

async function _restoreKit(sql, kitSku, qty, wid, tenantId, locationId) {
  const [kit] = await sql`SELECT items FROM kits WHERE sku = ${kitSku} AND warehouse_id = '' AND tenant_id = ${tenantId}`;
  if (!kit?.items) return;
  for (const comp of kit.items) {
    if (comp.type === 'kit') {
      await _restoreKit(sql, comp.sku, comp.qty * qty, wid, tenantId, locationId);
    } else {
      const compWid = await _componentWarehouseId(sql, tenantId, comp.sku, locationId, wid);
      await sql`UPDATE products SET stock = stock + ${comp.qty * qty}, updated_at = NOW()
        WHERE sku = ${comp.sku} AND warehouse_id = ${compWid} AND tenant_id = ${tenantId}`;
      await _restoreLotsFifo(sql, tenantId, comp.sku, compWid, comp.qty * qty);
    }
  }
}

// Deducts stock for a list of order items — same logic used when an order
// is first created (ver POST /api/orders).
async function deductStockForItems(sql, items, tenantId, orderWarehouseId, locationId) {
  for (const item of items) {
    const wid = item.warehouse_id || orderWarehouseId || '';
    if (item.type === 'kit') {
      await _deductKit(sql, item.sku, item.qty, wid, tenantId, locationId);
    } else {
      await sql`
        UPDATE products SET stock = GREATEST(0, stock - ${item.qty}), updated_at = NOW()
        WHERE sku = ${item.sku} AND warehouse_id = ${wid} AND tenant_id = ${tenantId}
      `;
      await _consumeLotsFifo(sql, tenantId, item.sku, wid, item.qty);
    }
  }
}

// Restores stock for a list of order items — the inverse of
// deductStockForItems, used when items are removed/reduced from an order
// that already decremented stock (ver PUT /api/orders/:id action=items).
async function restoreStockForItems(sql, items, tenantId, orderWarehouseId, locationId) {
  for (const item of items) {
    const wid = item.warehouse_id || orderWarehouseId || '';
    if (item.type === 'kit') {
      await _restoreKit(sql, item.sku, item.qty, wid, tenantId, locationId);
    } else {
      await sql`
        UPDATE products SET stock = stock + ${item.qty}, updated_at = NOW()
        WHERE sku = ${item.sku} AND warehouse_id = ${wid} AND tenant_id = ${tenantId}
      `;
      await _restoreLotsFifo(sql, tenantId, item.sku, wid, item.qty);
    }
  }
}

module.exports = { deductStockForItems, restoreStockForItems };
