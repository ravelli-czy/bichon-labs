// api/_stock.js — shared stock deduct/restore helpers for order items
// (products directly, KITs via their components). Used by api/orders.js
// (creating an order) and api/orders/[id].js (editing a Pre Compra's items
// during "Confirmando" — items already deducted at creation need their
// delta reconciled, not re-deducted from scratch).
//
// Costeo: cada venta consume stock_receipts lote por lote, del más antiguo
// al más nuevo (FIFO) — ver remaining_qty en api/_stock_receipts_routes.js.
// A diferencia del diseño anterior (un products.cost cacheado, sincronizado
// después de cada consumo), acá el costo de una venta se arma con el costo
// REAL de los lotes que efectivamente se tocaron en ESA consumición —
// _consumeLotsFifo devuelve el detalle lote por lote consumido, y quien
// llama arma el costo ponderado a partir de eso. Si una venta cruza dos
// lotes de distinto costo, el snapshot refleja el costo ponderado real, no
// sólo el del lote más viejo. Si los lotes se agotan a mitad de una venta
// (sobreventa de un insumo que no bloquea la orden), lo que sobra no tiene
// lote del cual descontar — se extrapola el costo ponderado observado a la
// cantidad faltante (mejor aproximación disponible, ver deductStockForItems).

// Un id correlativo simple alcanza acá — a diferencia de otras tablas (ORD-,
// REC-...) esto no se muestra al usuario como referencia, sólo necesita ser
// único. timestamp + contador de proceso evita colisiones dentro de la misma
// venta (varios ítems/componentes se registran en el mismo milisegundo).
let _movementSeq = 0;
function _movementId() {
  _movementSeq = (_movementSeq + 1) % 1e6;
  return 'MOV-' + Date.now().toString(36).toUpperCase() + '-' + _movementSeq.toString(36).toUpperCase();
}

// Inserta una fila en stock_movements (tab Historial de Inventario, ver
// api/_stock_movements_routes.js). `movement` es opcional — deductStockForItems/
// restoreStockForItems se usan también en contextos que no necesitan quedar
// en el historial (ninguno hoy, pero deja la puerta abierta sin forzar el
// registro en cada llamada). No registra deltas en 0 (nada que contar).
async function _recordMovement(sql, movement, { sku, warehouseId, productName, delta, unitCost, stockAfter }) {
  if (!movement || !delta) return;
  const id = _movementId();
  const valueDelta = delta * (unitCost || 0);
  await sql`
    INSERT INTO stock_movements
      (id, tenant_id, sku, warehouse_id, product_name, type, delta, unit_cost, value_delta, stock_after, ref_type, ref_id, created_by)
    VALUES
      (${id}, ${movement.tenantId}, ${sku}, ${warehouseId || ''}, ${productName || ''}, ${movement.type},
       ${delta}, ${unitCost || 0}, ${valueDelta}, ${stockAfter || 0}, ${movement.refType || ''}, ${movement.refId || ''}, ${movement.actor || 'sistema'})
  `;
}

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

// Consume `qty` de stock_receipts para (sku, wid), lote por lote del más
// antiguo al más nuevo. No lanza error si los lotes no alcanzan — sólo
// descuenta lo que hay, igual que products.stock se clampea en 0. Devuelve
// el detalle de lo realmente consumido: [{ unitCost, qty }, ...] — uno por
// cada lote tocado (puede ser más de uno si el más viejo no alcanzaba).
async function _consumeLotsFifo(sql, tenantId, sku, wid, qty) {
  if (!(qty > 0)) return [];
  let remaining = qty;
  const lots = await sql`
    SELECT id, remaining_qty, unit_cost FROM stock_receipts
    WHERE tenant_id = ${tenantId} AND sku = ${sku} AND warehouse_id = ${wid} AND remaining_qty > 0
    ORDER BY created_at ASC
  `;
  const consumed = [];
  for (const lot of lots) {
    if (remaining <= 0) break;
    const take = Math.min(lot.remaining_qty, remaining);
    if (take <= 0) continue;
    await sql`UPDATE stock_receipts SET remaining_qty = remaining_qty - ${take} WHERE id = ${lot.id}`;
    remaining -= take;
    consumed.push({ unitCost: lot.unit_cost, qty: take });
  }
  return consumed;
}

// Reduce el detalle de _consumeLotsFifo a { unitCost, totalCost } — costo
// ponderado real de lo consumido, extrapolado a `requestedQty` si los lotes
// no alcanzaron a cubrirla completa (ver nota de sobreventa arriba).
function _weightedCost(consumed, requestedQty) {
  const qtyCovered = consumed.reduce((s, c) => s + c.qty, 0);
  const costCovered = consumed.reduce((s, c) => s + c.unitCost * c.qty, 0);
  const unitCost = qtyCovered > 0 ? costCovered / qtyCovered : 0;
  return { unitCost, totalCost: unitCost * (requestedQty || 0) };
}

// Inversa de _consumeLotsFifo — se usa al restaurar stock (orden editada o
// cancelada). Devuelve la cantidad al lote más viejo activo, para no alterar
// el orden FIFO de lo que ya había. Si no queda ningún lote (se vendió todo
// lo que había), crea uno nuevo — al costo del último lote registrado para
// este sku/almacén (la mejor referencia disponible; no hay forma de saber de
// qué lote salió realmente la venta que se está restaurando sin un registro
// de consumo por línea de orden, fuera del alcance acá).
// Devuelve el unit_cost aplicado (el del lote al que se devolvió, o el
// fallback si tuvo que crear uno nuevo) — lo usa quien llama para registrar
// el value_delta del movimiento de historial (ver _recordMovement arriba).
async function _restoreLotsFifo(sql, tenantId, sku, wid, qty) {
  if (!(qty > 0)) return 0;
  const [oldest] = await sql`
    SELECT id, unit_cost FROM stock_receipts
    WHERE tenant_id = ${tenantId} AND sku = ${sku} AND warehouse_id = ${wid} AND remaining_qty > 0
    ORDER BY created_at ASC LIMIT 1
  `;
  if (oldest) {
    await sql`UPDATE stock_receipts SET remaining_qty = remaining_qty + ${qty} WHERE id = ${oldest.id}`;
    return oldest.unit_cost;
  }
  const [product] = await sql`
    SELECT name FROM products WHERE sku = ${sku} AND warehouse_id = ${wid} AND tenant_id = ${tenantId}
  `;
  if (!product) return 0;
  const [lastLot] = await sql`
    SELECT unit_cost FROM stock_receipts
    WHERE tenant_id = ${tenantId} AND sku = ${sku} AND warehouse_id = ${wid}
    ORDER BY created_at DESC LIMIT 1
  `;
  const fallbackCost = lastLot ? lastLot.unit_cost : 0;
  const id = 'RESTORE-' + sku + '-' + (wid || 'x') + '-' + Date.now().toString(36);
  await sql`
    INSERT INTO stock_receipts
      (id, tenant_id, sku, warehouse_id, product_name, form_label, factor, qty_purchased, total_cost, units_added, unit_cost, new_avg_cost, remaining_qty, created_by)
    VALUES
      (${id}, ${tenantId}, ${sku}, ${wid}, ${product.name}, 'Restaurado (orden editada o cancelada)', 1, ${qty}, ${qty * fallbackCost}, ${qty}, ${fallbackCost}, ${fallbackCost}, ${qty}, 'sistema')
    ON CONFLICT (id) DO NOTHING
  `;
  return fallbackCost;
}

// Deduce stock de los componentes de un KIT (recursivo — un KIT puede
// contener otros KITs vía Mesón Creativo). Devuelve { totalCost, components }
// — components es una lista PLANA (los KITs anidados se aplanan) con la
// cantidad y el costo ponderado real consumido por cada componente, para la
// qty total pedida (no normalizado por unidad — eso lo hace quien llama).
// `depth` — mismo tope (6) que el resto del código que recorre KITs
// anidados (_flattenKitSkus en api/orders.js, accumulateInsumoNeeds en
// api/_kit_shortage_alerts.js, _kitLeafSkus en el frontend) — corta un
// ciclo (KIT que se contiene a sí mismo, directa o indirectamente) antes de
// que la recursión cuelgue la función; api/kits.js no valida ciclos al crear
// un KIT, así que esto es la única red de seguridad en la venta real.
async function _deductKit(sql, kitSku, qty, wid, tenantId, locationId, movement, depth = 0) {
  if (depth > 6) return { totalCost: 0, components: [] };
  const [kit] = await sql`SELECT items FROM kits WHERE sku = ${kitSku} AND warehouse_id = '' AND tenant_id = ${tenantId}`;
  if (!kit?.items) return { totalCost: 0, components: [] };
  const components = [];
  let totalCost = 0;
  for (const comp of kit.items) {
    if (comp.type === 'kit') {
      const nested = await _deductKit(sql, comp.sku, comp.qty * qty, wid, tenantId, locationId, movement, depth + 1);
      totalCost += nested.totalCost;
      components.push(...nested.components);
    } else {
      const compWid = await _componentWarehouseId(sql, tenantId, comp.sku, locationId, wid);
      const compQty = comp.qty * qty;
      const [row] = await sql`UPDATE products SET stock = GREATEST(0, stock - ${compQty}), updated_at = NOW()
        WHERE sku = ${comp.sku} AND warehouse_id = ${compWid} AND tenant_id = ${tenantId}
        RETURNING stock, name`;
      const consumed = await _consumeLotsFifo(sql, tenantId, comp.sku, compWid, compQty);
      const { unitCost, totalCost: lineCost } = _weightedCost(consumed, compQty);
      totalCost += lineCost;
      components.push({ sku: comp.sku, warehouseId: compWid || '', quantity: compQty, unitCost, totalCost: lineCost });
      if (row) {
        await _recordMovement(sql, movement, {
          sku: comp.sku, warehouseId: compWid, productName: row.name,
          delta: -compQty, unitCost, stockAfter: row.stock,
        });
      }
    }
  }
  return { totalCost, components };
}

// `depth` — mismo tope que _deductKit arriba (misma razón: cortar un ciclo).
async function _restoreKit(sql, kitSku, qty, wid, tenantId, locationId, movement, depth = 0) {
  if (depth > 6) return;
  const [kit] = await sql`SELECT items FROM kits WHERE sku = ${kitSku} AND warehouse_id = '' AND tenant_id = ${tenantId}`;
  if (!kit?.items) return;
  for (const comp of kit.items) {
    if (comp.type === 'kit') {
      await _restoreKit(sql, comp.sku, comp.qty * qty, wid, tenantId, locationId, movement, depth + 1);
    } else {
      const compWid = await _componentWarehouseId(sql, tenantId, comp.sku, locationId, wid);
      const compQty = comp.qty * qty;
      const [row] = await sql`UPDATE products SET stock = stock + ${compQty}, updated_at = NOW()
        WHERE sku = ${comp.sku} AND warehouse_id = ${compWid} AND tenant_id = ${tenantId}
        RETURNING stock, name`;
      const unitCost = await _restoreLotsFifo(sql, tenantId, comp.sku, compWid, compQty);
      if (row) {
        await _recordMovement(sql, movement, {
          sku: comp.sku, warehouseId: compWid, productName: row.name,
          delta: compQty, unitCost, stockAfter: row.stock,
        });
      }
    }
  }
}

// Deducts stock for a list of order items — same logic used when an order
// is first created (ver POST /api/orders). Devuelve un arreglo paralelo a
// `items` con el costo REAL consumido por cada línea: { unitCost, totalCost,
// components? } — components sólo en líneas KIT, normalizado a "por 1
// unidad del KIT" (mismo shape que el componentBreakdown histórico).
// `movement` (opcional) — { tenantId, type, refType, refId, actor } — cuando
// se pasa, registra un movimiento en stock_movements por cada SKU real
// tocado (KITs se descomponen en sus componentes, ver _deductKit). Sin
// `movement` se comporta exactamente igual que antes (usado en contextos que
// no deben quedar en el historial).
async function deductStockForItems(sql, items, tenantId, orderWarehouseId, locationId, movement = null) {
  const results = [];
  for (const item of items) {
    const wid = item.warehouse_id || orderWarehouseId || '';
    const qty = item.qty || 0;
    if (item.type === 'kit') {
      const { totalCost, components } = await _deductKit(sql, item.sku, qty, wid, tenantId, locationId, movement);
      results.push({
        unitCost: qty > 0 ? totalCost / qty : 0,
        totalCost,
        components: components.map(c => ({
          sku: c.sku, warehouseId: c.warehouseId,
          quantity: qty > 0 ? c.quantity / qty : 0, // por 1 unidad del KIT
          unitCost: c.unitCost,
          totalCost: qty > 0 ? c.totalCost / qty : 0, // idem
        })),
      });
    } else {
      const [row] = await sql`
        UPDATE products SET stock = GREATEST(0, stock - ${qty}), updated_at = NOW()
        WHERE sku = ${item.sku} AND warehouse_id = ${wid} AND tenant_id = ${tenantId}
        RETURNING stock, name
      `;
      const consumed = await _consumeLotsFifo(sql, tenantId, item.sku, wid, qty);
      const costInfo = _weightedCost(consumed, qty);
      results.push(costInfo);
      if (row) {
        await _recordMovement(sql, movement, {
          sku: item.sku, warehouseId: wid, productName: row.name,
          delta: -qty, unitCost: costInfo.unitCost, stockAfter: row.stock,
        });
      }
    }
  }
  return results;
}

// Restores stock for a list of order items — the inverse of
// deductStockForItems, used when items are removed/reduced from an order
// that already decremented stock (ver PUT /api/orders/:id action=items) o
// se elimina una orden restituyendo su stock.
// `movement` — mismo contrato que deductStockForItems.
async function restoreStockForItems(sql, items, tenantId, orderWarehouseId, locationId, movement = null) {
  for (const item of items) {
    const wid = item.warehouse_id || orderWarehouseId || '';
    if (item.type === 'kit') {
      await _restoreKit(sql, item.sku, item.qty, wid, tenantId, locationId, movement);
    } else {
      const [row] = await sql`
        UPDATE products SET stock = stock + ${item.qty}, updated_at = NOW()
        WHERE sku = ${item.sku} AND warehouse_id = ${wid} AND tenant_id = ${tenantId}
        RETURNING stock, name
      `;
      const unitCost = await _restoreLotsFifo(sql, tenantId, item.sku, wid, item.qty);
      if (row) {
        await _recordMovement(sql, movement, {
          sku: item.sku, warehouseId: wid, productName: row.name,
          delta: item.qty, unitCost, stockAfter: row.stock,
        });
      }
    }
  }
}

module.exports = { deductStockForItems, restoreStockForItems, recordStockMovement: _recordMovement };
