// api/products/[sku].js — GET/PUT/DELETE /api/products/:sku
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
    // ── GET ───────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const [row] = await sql`SELECT * FROM products WHERE sku = ${sku} AND warehouse_id = ${warehouse_id} AND tenant_id = ${tenantId}`;
      if (!row) return res.status(404).json({ error: 'Product not found' });
      return res.json(row);
    }

    // ── PUT — update product ──────────────────────────────────────────────
    if (req.method === 'PUT') {
      const { name, brand, cat, tipo, cost, price, stock, threshold, barcode } = req.body || {};
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
          updated_by = ${actor},
          updated_at = NOW()
        WHERE sku = ${sku} AND warehouse_id = ${warehouse_id} AND tenant_id = ${tenantId}
        RETURNING *
      `;
      if (!row) return res.status(404).json({ error: 'Product not found' });

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
