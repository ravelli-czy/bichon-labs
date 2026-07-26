// api/product-groups.js — GET /api/product-groups  POST /api/product-groups
const { getDb } = require('./_db');
const cors = require('./_cors');
const { writeLog } = require('./_log');
const { getSession, resolveTenantId } = require('./_tenant');

module.exports = async (req, res) => {
  if (cors(req, res)) return;

  let sql;
  try { sql = getDb(); }
  catch (err) { return res.status(503).json({ error: err.message }); }

  const session  = await getSession(req);
  const tenantId = resolveTenantId(req, session);
  if (!tenantId) return res.status(401).json({ error: 'No autenticado o sin tenant' });
  const actor = session?.username || 'sistema';

  try {
    // ── GET — list all product groups (con cantidad de productos) ──────────
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT g.*,
          (SELECT COUNT(*) FROM products p
           WHERE p.tenant_id = g.tenant_id AND p.warehouse_id = '' AND p.groups @> to_jsonb(g.id)
          ) AS product_count
        FROM product_groups g
        WHERE g.tenant_id = ${tenantId}
        ORDER BY g.name
      `;
      return res.json(rows);
    }

    // ── POST — create product group (id correlativo automático) ────────────
    if (req.method === 'POST') {
      const { name } = req.body || {};
      if (!name) return res.status(400).json({ error: 'name is required' });

      let row;
      try {
        [row] = await sql`
          INSERT INTO product_groups (tenant_id, name, created_by)
          VALUES (${tenantId}, ${name}, ${actor})
          RETURNING *
        `;
      } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un grupo con ese nombre' });
        throw err;
      }

      await writeLog(sql, {
        tenant_id:   tenantId,
        actor,
        action:      'grupo_producto.creado',
        entity_type: 'product_group',
        entity_id:   String(row.id),
        entity_name: row.name,
        details:     { id: row.id, name: row.name },
      });

      return res.status(201).json(row);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('product-groups error:', err);
    return res.status(500).json({ error: err.message });
  }
};
