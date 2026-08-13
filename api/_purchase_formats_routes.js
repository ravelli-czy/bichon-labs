// api/_purchase_formats_routes.js — Mantenedor de Formatos de compra.
//
// NO es una Serverless Function (prefijo `_`, mismo motivo que
// _stock_receipts_routes.js/_finance_routes.js/_coupons_routes.js) — se
// invoca desde api/products.js cuando `req.query.resource ===
// 'purchase-formats'` (el proyecto está en el tope de 12 Serverless
// Functions del plan Hobby de Vercel).
//
// Es una lista única por tenant, NO por producto: cada formato (ej. "Pack
// x3" -> factor 3, "Botella 1.5L" -> factor 7.5) dice cuántas unidades de
// stock rinde, sin importar qué producto sea — la unidad de stock en sí
// sigue siendo una propiedad de cada producto (products.stock_unit), no de
// acá. Se administra en /stock-receipts (tab Formatos) y se elige por
// dropdown al hacer un Ingreso de inventario (ver
// api/_stock_receipts_routes.js, que resuelve label/factor por id acá).
//
// GET    /api/products?resource=purchase-formats             → listar
// POST   /api/products?resource=purchase-formats             → crear { label, factor }
// PUT    /api/products?resource=purchase-formats&id=PF-0001  → editar
// DELETE /api/products?resource=purchase-formats&id=PF-0001  → eliminar
const { writeLog } = require('./_log');

const PURCHASE_FORMAT_RESOURCES = ['purchase-formats'];

function isPlainNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

async function handlePurchaseFormatsResource(req, res, sql, session, tenantId, actor) {
  try {
    if (req.method === 'GET') {
      const rows = await sql`SELECT * FROM purchase_formats WHERE tenant_id = ${tenantId} ORDER BY label`;
      return res.json(rows);
    }

    if (req.method === 'POST') {
      const { label, factor } = req.body || {};
      const cleanLabel = (label || '').trim();
      if (!cleanLabel) return res.status(400).json({ error: 'label is required' });
      if (!isPlainNumber(factor) || factor <= 0) return res.status(400).json({ error: 'factor debe ser un número mayor a 0' });

      const [{ max_num }] = await sql`
        SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 4) AS INTEGER)), 0) AS max_num
        FROM purchase_formats WHERE id ~ '^PF-[0-9]+$' AND tenant_id = ${tenantId}
      `;
      const id = 'PF-' + String(parseInt(max_num) + 1).padStart(4, '0');

      let row;
      try {
        [row] = await sql`
          INSERT INTO purchase_formats (id, tenant_id, label, factor, created_by)
          VALUES (${id}, ${tenantId}, ${cleanLabel}, ${factor}, ${actor})
          RETURNING *
        `;
      } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un formato con ese nombre' });
        throw err;
      }
      await writeLog(sql, {
        tenant_id: tenantId, actor, action: 'formato_compra.creado',
        entity_type: 'purchase_format', entity_id: id, entity_name: `${id} — ${cleanLabel}`,
        details: { id, label: cleanLabel, factor },
      });
      return res.status(201).json(row);
    }

    const id = req.query?.id;

    if (req.method === 'PUT') {
      if (!id) return res.status(400).json({ error: 'id is required' });
      const { label, factor } = req.body || {};
      if (label !== undefined && !label.trim()) return res.status(400).json({ error: 'label no puede quedar vacío' });
      if (factor !== undefined && (!isPlainNumber(factor) || factor <= 0)) {
        return res.status(400).json({ error: 'factor debe ser un número mayor a 0' });
      }
      let row;
      try {
        [row] = await sql`
          UPDATE purchase_formats SET
            label      = COALESCE(${label !== undefined ? label.trim() : null}, label),
            factor     = COALESCE(${factor ?? null}, factor),
            updated_by = ${actor},
            updated_at = NOW()
          WHERE id = ${id} AND tenant_id = ${tenantId}
          RETURNING *
        `;
      } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un formato con ese nombre' });
        throw err;
      }
      if (!row) return res.status(404).json({ error: 'Formato no encontrado' });
      await writeLog(sql, {
        tenant_id: tenantId, actor, action: 'formato_compra.editado',
        entity_type: 'purchase_format', entity_id: id, entity_name: `${id} — ${row.label}`,
        details: { id, label: row.label, factor: row.factor },
      });
      return res.json(row);
    }

    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ error: 'id is required' });
      const [row] = await sql`DELETE FROM purchase_formats WHERE id = ${id} AND tenant_id = ${tenantId} RETURNING *`;
      if (!row) return res.status(404).json({ error: 'Formato no encontrado' });
      await writeLog(sql, {
        tenant_id: tenantId, actor, action: 'formato_compra.eliminado',
        entity_type: 'purchase_format', entity_id: id, entity_name: `${id} — ${row.label}`,
        details: { id, label: row.label },
      });
      return res.json({ ok: true, deleted: id });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('purchase-formats error:', err);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = { handlePurchaseFormatsResource, PURCHASE_FORMAT_RESOURCES };
