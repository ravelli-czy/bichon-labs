// api/_coupons_routes.js — Módulo Cupones: CRUD + validación de código.
//
// NO es una Serverless Function (prefijo `_`, igual que _finance_routes.js)
// — se invoca desde api/orders.js cuando `req.query.resource === 'coupons'`,
// en vez de vivir en su propio api/coupons.js (el proyecto está en el tope
// de 12 Serverless Functions del plan Hobby de Vercel — ver comentario en
// _finance_routes.js y en api/orders.js).
//
// GET    /api/orders?resource=coupons                    → listar cupones (con estado calculado)
// GET    /api/orders?resource=coupons&id=CUP-001          → detalle + órdenes que lo usaron
// GET    /api/orders?resource=coupons&validate=CODIGO     → valida un código usable ahora (sin reclamarlo)
// POST   /api/orders?resource=coupons                     → crear cupón
// PUT    /api/orders?resource=coupons&id=CUP-001          → editar cupón
// DELETE /api/orders?resource=coupons&id=CUP-001          → eliminar cupón
//
// El reclamo/liberación de usos al crear/editar/eliminar una ORDEN vive en
// api/orders.js y api/orders/[id].js (importan claimCoupon/releaseCoupon de
// ./_coupons directamente) — este archivo sólo expone la gestión del cupón
// en sí y la validación previa a aplicarlo.

const { writeLog } = require('./_log');
const C = require('./_coupons');

const ADMIN_ROLES = ['admin', 'superadmin', 'master'];
const isAdmin = session => ADMIN_ROLES.includes(session.role);

const COUPON_RESOURCES = ['coupons'];

function validateCouponInput(body, { partial = false } = {}) {
  const errors = [];
  let code, discount_type, discount_value, max_uses;

  if (!partial || body.code !== undefined) {
    code = C.normalizeCode(body.code);
    if (!code) errors.push('code es requerido');
    else if (code.length > 30) errors.push('code debe tener 30 caracteres o menos');
  }
  if (!partial || body.discount_type !== undefined) {
    discount_type = body.discount_type;
    if (!C.DISCOUNT_TYPES.includes(discount_type)) errors.push("discount_type debe ser 'percentage' o 'fixed'");
  }
  if (!partial || body.discount_value !== undefined) {
    discount_value = Number(body.discount_value);
    if (!Number.isFinite(discount_value) || discount_value <= 0) errors.push('discount_value debe ser mayor a 0');
    else if (discount_type === 'percentage' && discount_value > 100) errors.push('discount_value no puede superar 100 cuando discount_type es percentage');
  }
  if (!partial || body.max_uses !== undefined) {
    max_uses = Number(body.max_uses);
    if (!Number.isInteger(max_uses) || max_uses < 1) errors.push('max_uses debe ser un entero mayor o igual a 1');
  }

  return { errors, code, discount_type, discount_value, max_uses };
}

async function handleCouponsResource(req, res, sql, session, tenantId, actor) {
  const q = req.query || {};
  const id = q.id;

  try {
    // ── VALIDAR CÓDIGO (sin reclamarlo) — usado al armar una venta ────────
    if (q.validate !== undefined && req.method === 'GET') {
      const code = C.normalizeCode(q.validate);
      if (!code) return res.status(400).json({ error: 'Código de cupón requerido' });
      const [row] = await sql`SELECT * FROM coupons WHERE tenant_id = ${tenantId} AND code = ${code}`;
      if (!row) return res.status(404).json({ error: 'Cupón no encontrado' });
      const status = C.couponStatus(row);
      if (status === 'redimido') return res.status(400).json({ error: 'Cupón agotado — alcanzó su límite de usos' });
      if (status === 'inactivo') return res.status(400).json({ error: 'Cupón inactivo' });
      return res.json(C.mapCoupon(row));
    }

    // ── LISTAR ──────────────────────────────────────────────────────────
    if (!id && req.method === 'GET') {
      const rows = await sql`SELECT * FROM coupons WHERE tenant_id = ${tenantId} ORDER BY created_at DESC`;
      return res.json(rows.map(C.mapCoupon));
    }

    // ── CREAR ───────────────────────────────────────────────────────────
    if (!id && req.method === 'POST') {
      if (!isAdmin(session)) return res.status(403).json({ error: 'Sólo administradores pueden crear cupones' });
      const { errors, code, discount_type, discount_value, max_uses } = validateCouponInput(req.body || {});
      if (errors.length) return res.status(400).json({ error: errors.join('; ') });

      const newId = await C.nextCouponId(sql);
      let row;
      try {
        [row] = await sql`
          INSERT INTO coupons (id, tenant_id, code, discount_type, discount_value, max_uses, used_count, active, created_by)
          VALUES (${newId}, ${tenantId}, ${code}, ${discount_type}, ${discount_value}, ${max_uses}, 0, true, ${actor})
          RETURNING *
        `;
      } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un cupón con ese código' });
        throw err;
      }
      await writeLog(sql, {
        tenant_id: tenantId, actor, action: 'cupon.creado',
        entity_type: 'cupon', entity_id: row.id, entity_name: row.code,
        details: { code: row.code, discount_type, discount_value, max_uses },
      });
      return res.status(201).json(C.mapCoupon(row));
    }

    if (!id) return res.status(405).json({ error: 'Method not allowed' });

    // ── DETALLE + órdenes que lo usaron ─────────────────────────────────
    if (req.method === 'GET') {
      const [row] = await sql`SELECT * FROM coupons WHERE id = ${id} AND tenant_id = ${tenantId}`;
      if (!row) return res.status(404).json({ error: 'Coupon not found' });
      const orders = await sql`
        SELECT id, cliente, fecha, total, status FROM orders
        WHERE tenant_id = ${tenantId} AND coupon_id = ${id}
        ORDER BY created_at DESC
      `;
      return res.json({ ...C.mapCoupon(row), orders });
    }

    // ── EDITAR ──────────────────────────────────────────────────────────
    if (req.method === 'PUT') {
      if (!isAdmin(session)) return res.status(403).json({ error: 'Sólo administradores pueden editar cupones' });
      const body = req.body || {};
      const { errors, code, discount_type, discount_value, max_uses } = validateCouponInput(body, { partial: true });
      if (errors.length) return res.status(400).json({ error: errors.join('; ') });
      const active = body.active !== undefined ? !!body.active : null;

      let row;
      try {
        [row] = await sql`
          UPDATE coupons SET
            code           = COALESCE(${code ?? null}, code),
            discount_type  = COALESCE(${discount_type ?? null}, discount_type),
            discount_value = COALESCE(${discount_value ?? null}, discount_value),
            max_uses       = COALESCE(${max_uses ?? null}, max_uses),
            active         = COALESCE(${active}, active),
            updated_at     = NOW()
          WHERE id = ${id} AND tenant_id = ${tenantId}
          RETURNING *
        `;
      } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un cupón con ese código' });
        throw err;
      }
      if (!row) return res.status(404).json({ error: 'Coupon not found' });
      await writeLog(sql, {
        tenant_id: tenantId, actor, action: 'cupon.editado',
        entity_type: 'cupon', entity_id: id, entity_name: row.code,
        details: { code: row.code },
      });
      return res.json(C.mapCoupon(row));
    }

    // ── ELIMINAR ────────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      if (!isAdmin(session)) return res.status(403).json({ error: 'Sólo administradores pueden eliminar cupones' });
      const [row] = await sql`DELETE FROM coupons WHERE id = ${id} AND tenant_id = ${tenantId} RETURNING *`;
      if (!row) return res.status(404).json({ error: 'Coupon not found' });
      await writeLog(sql, {
        tenant_id: tenantId, actor, action: 'cupon.eliminado',
        entity_type: 'cupon', entity_id: id, entity_name: row.code,
        details: { code: row.code },
      });
      return res.json({ ok: true, deleted: id });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('coupons error:', err);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = { handleCouponsResource, COUPON_RESOURCES };
