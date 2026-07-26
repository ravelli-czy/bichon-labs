// api/kits.js — GET /api/kits  POST /api/kits
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
    // ── GET — list all kits ───────────────────────────────────────────────
    if (req.method === 'GET') {
      const rows = await sql`SELECT * FROM kits WHERE tenant_id = ${tenantId} ORDER BY sku, warehouse_id, name`;
      return res.json(rows);
    }

    // ── POST — create kit ─────────────────────────────────────────────────
    if (req.method === 'POST') {
      const { name, price = 0, items = [], sku: customSku, warehouse_id = '' } = req.body || {};
      if (!name) return res.status(400).json({ error: 'name is required' });

      let sku = customSku;
      if (!sku) {
        const [{ max_num }] = await sql`
          SELECT COALESCE(MAX(
            CAST(SUBSTRING(sku FROM 5) AS INTEGER)
          ), 0) AS max_num
          FROM kits
          WHERE sku ~ '^KIT-[0-9]+$' AND tenant_id = ${tenantId} AND warehouse_id = ''
        `;
        sku = 'KIT-' + String(parseInt(max_num) + 1).padStart(3, '0');
      }

      const [row] = await sql`
        INSERT INTO kits (sku, name, price, items, created_by, tenant_id, warehouse_id)
        VALUES (${sku}, ${name}, ${price}, ${JSON.stringify(items)}, ${actor}, ${tenantId}, ${warehouse_id})
        RETURNING *
      `;

      await writeLog(sql, {
        tenant_id:   tenantId,
        actor,
        action:      'kit.creado',
        entity_type: 'kit',
        entity_id:   sku,
        entity_name: `${sku} — ${name}`,
        details:     { sku, name, price, items_count: items.length },
      });

      return res.status(201).json(row);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('kits error:', err);
    return res.status(500).json({ error: err.message });
  }
};
