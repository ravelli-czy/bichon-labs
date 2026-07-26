// api/product-groups/[id].js — PUT/DELETE /api/product-groups/:id
const { getDb } = require('../_db');
const cors = require('../_cors');
const { writeLog } = require('../_log');
const { getSession, resolveTenantId } = require('../_tenant');

module.exports = async (req, res) => {
  if (cors(req, res)) return;

  let sql;
  try { sql = getDb(); }
  catch (err) { return res.status(503).json({ error: err.message }); }

  const session  = await getSession(req);
  const tenantId = resolveTenantId(req, session);
  if (!tenantId) return res.status(401).json({ error: 'No autenticado o sin tenant' });
  const actor = session?.username || 'sistema';

  const { id } = req.query;

  try {
    // ── PUT — rename product group ──────────────────────────────────────────
    if (req.method === 'PUT') {
      const { name } = req.body || {};
      if (!name) return res.status(400).json({ error: 'name is required' });

      let row;
      try {
        [row] = await sql`
          UPDATE product_groups SET name = ${name}
          WHERE id = ${id} AND tenant_id = ${tenantId}
          RETURNING *
        `;
      } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un grupo con ese nombre' });
        throw err;
      }
      if (!row) return res.status(404).json({ error: 'Grupo no encontrado' });

      await writeLog(sql, {
        tenant_id:   tenantId,
        actor,
        action:      'grupo_producto.editado',
        entity_type: 'product_group',
        entity_id:   String(row.id),
        entity_name: row.name,
        details:     { id: row.id, name: row.name },
      });

      return res.json(row);
    }

    // ── DELETE — eliminar grupo y desasignarlo de productos/kits ────────────
    if (req.method === 'DELETE') {
      const [row] = await sql`DELETE FROM product_groups WHERE id = ${id} AND tenant_id = ${tenantId} RETURNING *`;
      if (!row) return res.status(404).json({ error: 'Grupo no encontrado' });

      const groupIdJson = JSON.stringify(parseInt(id, 10));

      await sql`
        UPDATE products SET groups = (
          SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
          FROM jsonb_array_elements(groups) elem
          WHERE elem <> ${groupIdJson}::jsonb
        )
        WHERE tenant_id = ${tenantId} AND groups @> ${groupIdJson}::jsonb
      `;
      await sql`
        UPDATE kits SET stock_group_ids = (
          SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
          FROM jsonb_array_elements(stock_group_ids) elem
          WHERE elem <> ${groupIdJson}::jsonb
        )
        WHERE tenant_id = ${tenantId} AND stock_group_ids @> ${groupIdJson}::jsonb
      `;

      await writeLog(sql, {
        tenant_id:   tenantId,
        actor,
        action:      'grupo_producto.eliminado',
        entity_type: 'product_group',
        entity_id:   String(row.id),
        entity_name: row.name,
        details:     { id: row.id, name: row.name },
      });

      return res.json({ ok: true, deleted: row.id });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('product-groups/[id] error:', err);
    return res.status(500).json({ error: err.message });
  }
};
