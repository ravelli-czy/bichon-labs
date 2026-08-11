// api/_stock.js — shared stock deduct/restore helpers for order items
// (products directly, KITs via their components). Used by api/orders.js
// (creating an order) and api/orders/[id].js (editing a Pre Compra's items
// during "Confirmando" — items already deducted at creation need their
// delta reconciled, not re-deducted from scratch).

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
    }
  }
}

module.exports = { deductStockForItems, restoreStockForItems };
