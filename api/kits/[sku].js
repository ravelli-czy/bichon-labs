// api/kits/[sku].js — GET/PUT/DELETE /api/kits/:sku
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

  const { sku, warehouse_id: wid = '' } = req.query;

  try {
    // ── GET ───────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const [row] = await sql`SELECT * FROM kits WHERE sku = ${sku} AND warehouse_id = ${wid} AND tenant_id = ${tenantId}`;
      if (!row) return res.status(404).json({ error: 'Kit not found' });
      return res.json(row);
    }

    // ── PUT — update kit ──────────────────────────────────────────────────
    if (req.method === 'PUT') {
      const { name, price, items, stock_group_ids, groups, tipo, brand } = req.body || {};
      if (brand !== undefined && !(brand && brand.trim())) return res.status(400).json({ error: 'brand no puede quedar vacío' });
      const itemsJson = items !== undefined ? JSON.stringify(items) : null;
      const stockGroupIdsJson = stock_group_ids !== undefined ? JSON.stringify(stock_group_ids) : null;
      const groupsJson = groups !== undefined ? JSON.stringify(groups) : null;
      // Editing the master propagates name/price/items/tipo/brand to all warehouse variants
      await sql`
        UPDATE kits SET
          name            = COALESCE(${name     ?? null}, name),
          price           = COALESCE(${price    ?? null}, price),
          items           = COALESCE(${itemsJson}::jsonb, items),
          stock_group_ids = COALESCE(${stockGroupIdsJson}::jsonb, stock_group_ids),
          groups          = COALESCE(${groupsJson}::jsonb, groups),
          tipo            = COALESCE(${tipo     ?? null}, tipo),
          brand           = COALESCE(${brand    ?? null}, brand),
          updated_by = ${actor},
          updated_at = NOW()
        WHERE sku = ${sku} AND tenant_id = ${tenantId}
      `;
      const [row] = await sql`SELECT * FROM kits WHERE sku = ${sku} AND warehouse_id = ${wid} AND tenant_id = ${tenantId}`;
      if (!row) return res.status(404).json({ error: 'Kit not found' });

      await writeLog(sql, {
        tenant_id:   tenantId,
        actor,
        action:      'kit.editado',
        entity_type: 'kit',
        entity_id:   sku,
        entity_name: `${sku} — ${row.name}`,
        details:     { sku, name: row.name, price: row.price },
      });

      return res.json(row);
    }

    // ── DELETE ────────────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      if (wid !== '') {
        // Delete only this warehouse variant
        const [existing] = await sql`SELECT name FROM kits WHERE sku = ${sku} AND warehouse_id = ${wid} AND tenant_id = ${tenantId}`;
        const result = await sql`DELETE FROM kits WHERE sku = ${sku} AND warehouse_id = ${wid} AND tenant_id = ${tenantId} RETURNING sku`;
        if (!result.length) return res.status(404).json({ error: 'Kit SKU not found' });
        await writeLog(sql, {
          tenant_id:   tenantId,
          actor,
          action:      'kit.sku.eliminado',
          entity_type: 'kit',
          entity_id:   sku,
          entity_name: existing ? `${sku} — ${existing.name}` : sku,
          details:     { sku, warehouse_id: wid, name: existing?.name },
        });
        return res.json({ ok: true, deleted: sku, warehouse_id: wid });
      }
      // Delete master + all warehouse variants
      const [existing] = await sql`SELECT name FROM kits WHERE sku = ${sku} AND warehouse_id = '' AND tenant_id = ${tenantId}`;
      const result = await sql`DELETE FROM kits WHERE sku = ${sku} AND tenant_id = ${tenantId} RETURNING sku`;
      if (!result.length) return res.status(404).json({ error: 'Kit not found' });

      await writeLog(sql, {
        tenant_id:   tenantId,
        actor,
        action:      'kit.eliminado',
        entity_type: 'kit',
        entity_id:   sku,
        entity_name: existing ? `${sku} — ${existing.name}` : sku,
        details:     { sku, name: existing?.name },
      });

      return res.json({ ok: true, deleted: sku });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('kits/[sku] error:', err);
    return res.status(500).json({ error: err.message });
  }
};
