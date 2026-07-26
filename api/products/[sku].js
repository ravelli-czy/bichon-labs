// api/products/[sku].js — GET/PUT/DELETE /api/products/:sku
// PUT/DELETE /api/products/:id?groups=1 — Grupo de Productos (:id es el id numérico
// del grupo). Colapsado acá para no sumar otra Serverless Function (tope 12 en Hobby).
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

  const { sku, warehouse_id = '' } = req.query;

  try {
    // ── /api/products/:id?groups=1 — Grupo de Productos ─────────────────────
    if (req.query?.groups === '1') {
      const groupId = sku;

      if (req.method === 'PUT') {
        const { name } = req.body || {};
        if (!name) return res.status(400).json({ error: 'name is required' });
        let row;
        try {
          [row] = await sql`
            UPDATE product_groups SET name = ${name}
            WHERE id = ${groupId} AND tenant_id = ${tenantId}
            RETURNING *
          `;
        } catch (err) {
          if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un grupo con ese nombre' });
          throw err;
        }
        if (!row) return res.status(404).json({ error: 'Grupo no encontrado' });
        await writeLog(sql, {
          tenant_id: tenantId, actor, action: 'grupo_producto.editado',
          entity_type: 'product_group', entity_id: String(row.id), entity_name: row.name,
          details: { id: row.id, name: row.name },
        });
        return res.json(row);
      }

      if (req.method === 'DELETE') {
        const [row] = await sql`DELETE FROM product_groups WHERE id = ${groupId} AND tenant_id = ${tenantId} RETURNING *`;
        if (!row) return res.status(404).json({ error: 'Grupo no encontrado' });

        const groupIdJson = JSON.stringify(parseInt(groupId, 10));
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
          tenant_id: tenantId, actor, action: 'grupo_producto.eliminado',
          entity_type: 'product_group', entity_id: String(row.id), entity_name: row.name,
          details: { id: row.id, name: row.name },
        });
        return res.json({ ok: true, deleted: row.id });
      }

      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── GET ───────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const [row] = await sql`SELECT * FROM products WHERE sku = ${sku} AND warehouse_id = ${warehouse_id} AND tenant_id = ${tenantId}`;
      if (!row) return res.status(404).json({ error: 'Product not found' });
      return res.json(row);
    }

    // ── PUT — update product ──────────────────────────────────────────────
    if (req.method === 'PUT') {
      const { name, brand, cat, tipo, cost, price, stock, threshold, barcode, groups } = req.body || {};
      if (groups !== undefined && !Array.isArray(groups)) return res.status(400).json({ error: 'groups must be an array' });
      const groupsJson = groups !== undefined ? JSON.stringify(groups) : null;
      const [row] = await sql`
        UPDATE products SET
          name      = COALESCE(${name      ?? null}, name),
          brand     = COALESCE(${brand     ?? null}, brand),
          cat       = COALESCE(${cat       ?? null}, cat),
          tipo      = COALESCE(${tipo      ?? null}, tipo),
          cost      = COALESCE(${cost      ?? null}, cost),
          price     = COALESCE(${price     ?? null}, price),
          stock     = COALESCE(${stock     ?? null}, stock),
          threshold = COALESCE(${threshold ?? null}, threshold),
          barcode   = COALESCE(${barcode   ?? null}, barcode),
          groups    = COALESCE(${groupsJson}::jsonb, groups),
          updated_by = ${actor},
          updated_at = NOW()
        WHERE sku = ${sku} AND warehouse_id = ${warehouse_id} AND tenant_id = ${tenantId}
        RETURNING *
      `;
      if (!row) return res.status(404).json({ error: 'Product not found' });

      // El Grupo de Productos es una propiedad del producto, no del almacén:
      // se sincroniza a todas las filas (SKUs por almacén) de este mismo sku.
      if (groups !== undefined) {
        await sql`
          UPDATE products SET groups = ${groupsJson}::jsonb
          WHERE sku = ${sku} AND tenant_id = ${tenantId} AND warehouse_id != ${warehouse_id}
        `;
      }

      await writeLog(sql, {
        tenant_id:   tenantId,
        actor,
        action:      'producto.editado',
        entity_type: 'producto',
        entity_id:   sku,
        entity_name: `${sku} — ${row.name}`,
        details:     { sku, warehouse_id, name: row.name, stock: row.stock },
      });

      return res.json(row);
    }

    // ── DELETE ────────────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const [existing] = await sql`SELECT name FROM products WHERE sku = ${sku} AND warehouse_id = ${warehouse_id} AND tenant_id = ${tenantId}`;
      const result = await sql`DELETE FROM products WHERE sku = ${sku} AND warehouse_id = ${warehouse_id} AND tenant_id = ${tenantId} RETURNING sku`;
      if (!result.length) return res.status(404).json({ error: 'Product not found' });

      await writeLog(sql, {
        tenant_id:   tenantId,
        actor,
        action:      'producto.eliminado',
        entity_type: 'producto',
        entity_id:   sku,
        entity_name: existing ? `${sku} — ${existing.name}` : sku,
        details:     { sku, name: existing?.name },
      });

      return res.json({ ok: true, deleted: sku });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('products/[sku] error:', err);
    return res.status(500).json({ error: err.message });
  }
};
