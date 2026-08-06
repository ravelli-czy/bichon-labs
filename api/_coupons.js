// api/_coupons.js — Cupones: helpers de datos (ID, normalización, estado,
// cálculo de descuento) y las operaciones atómicas de reclamar/liberar un
// uso, compartidas entre api/orders.js (aplicar un cupón al crear/editar/
// eliminar una orden) y api/_coupons_routes.js (CRUD del módulo Cupones).
// Prefijo `_` — no es una Serverless Function (igual que _finance.js).

const DISCOUNT_TYPES = ['percentage', 'fixed'];

// IDs son PK global (no por tenant) — mismo criterio que orders/expenses/
// categories (ver comentario en _finance.js nextCategoryId).
async function nextCouponId(sql) {
  const [{ max_num }] = await sql`
    SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 5) AS INTEGER)), 0) AS max_num
    FROM coupons WHERE id ~ '^CUP-[0-9]+$'
  `;
  return 'CUP-' + String(parseInt(max_num) + 1).padStart(3, '0');
}

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}

// 'redimido' manda sobre `active` — un cupón que llegó a su límite de usos
// se muestra como redimido aunque alguien reactive el flag manualmente sin
// subir max_uses. Si luego se sube max_uses por sobre used_count, vuelve a
// reflejar el flag `active` real (que releaseCoupon ya reactiva solo).
function couponStatus(c) {
  if (c.used_count >= c.max_uses) return 'redimido';
  if (!c.active) return 'inactivo';
  return 'activo';
}

function mapCoupon(c) {
  return {
    id: c.id,
    code: c.code,
    discount_type: c.discount_type,
    discount_value: Number(c.discount_value),
    max_uses: c.max_uses,
    used_count: c.used_count,
    active: c.active,
    status: couponStatus(c),
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}

// Monto de descuento para un cupón ya resuelto, contra el subtotal de
// productos de la orden. Los cupones de monto fijo nunca dejan el total
// negativo — se acotan al subtotal.
function computeDiscountAmount(coupon, itemsSubtotal) {
  if (coupon.discount_type === 'percentage') {
    return Math.round(itemsSubtotal * Number(coupon.discount_value) / 100);
  }
  return Math.min(Math.round(Number(coupon.discount_value)), itemsSubtotal);
}

// Reclama atómicamente un uso del cupón: sólo tiene éxito si sigue activo y
// no ha alcanzado max_uses — evita condiciones de carrera entre dos ventas
// simultáneas peleando por el último uso disponible. Si este uso agota el
// cupón, lo marca inactivo en la misma sentencia (ver couponStatus).
async function claimCoupon(sql, tenantId, rawCode) {
  const code = normalizeCode(rawCode);
  if (!code) return null;
  const [row] = await sql`
    UPDATE coupons SET
      used_count = used_count + 1,
      active     = CASE WHEN used_count + 1 >= max_uses THEN false ELSE active END,
      updated_at = NOW()
    WHERE tenant_id = ${tenantId} AND code = ${code} AND active = true AND used_count < max_uses
    RETURNING *
  `;
  return row || null;
}

// Libera un uso previamente reclamado (orden editada/eliminada) — reactiva
// el cupón si el uso liberado lo vuelve a dejar bajo max_uses.
async function releaseCoupon(sql, tenantId, couponId) {
  if (!couponId) return null;
  const [row] = await sql`
    UPDATE coupons SET
      used_count = GREATEST(0, used_count - 1),
      active     = CASE WHEN GREATEST(0, used_count - 1) < max_uses THEN true ELSE active END,
      updated_at = NOW()
    WHERE id = ${couponId} AND tenant_id = ${tenantId}
    RETURNING *
  `;
  return row || null;
}

module.exports = {
  DISCOUNT_TYPES,
  nextCouponId,
  normalizeCode,
  couponStatus,
  mapCoupon,
  computeDiscountAmount,
  claimCoupon,
  releaseCoupon,
};
