// api/products.js — GET /api/products  POST /api/products
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
    // ── GET — list all products ───────────────────────────────────────────
    if (req.method === 'GET') {
      const rows = await sql`SELECT * FROM products WHERE tenant_id = ${tenantId} ORDER BY warehouse_id, name`;
      return res.json(rows);
    }

    // ── POST — create product ─────────────────────────────────────────────
    if (req.method === 'POST') {
      const {
        name, brand = 'Sin marca', cat = 'General',
        tipo = 'producto', cost = 0, price = 0,
        stock = 0, threshold = 10, warehouse_id = '', barcode = '',
        sku: explicitSku,
      } = req.body || {};

      if (!name) return res.status(400).json({ error: 'name is required' });

      let sku;
      if (explicitSku) {
        // Explicit SKU provided — adding a warehouse instance to an existing product
        sku = explicitSku;
      } else {
        // Auto-generate SKU scoped to tenant
        const [{ max_num }] = await sql`
          SELECT COALESCE(MAX(
            CAST(SUBSTRING(sku FROM 5) AS INTEGER)
          ), 0) AS max_num
          FROM products
          WHERE sku ~ '^PRD-[0-9]+$' AND tenant_id = ${tenantId}
        `;
        sku = 'PRD-' + String(parseInt(max_num) + 1).padStart(3, '0');
      }

      const [row] = await sql`
        INSERT INTO products (sku, name, brand, cat, tipo, cost, price, stock, threshold, barcode, created_by, tenant_id, warehouse_id)
        VALUES (${sku}, ${name}, ${brand}, ${cat}, ${tipo}, ${cost}, ${price}, ${stock}, ${threshold}, ${barcode}, ${actor}, ${tenantId}, ${warehouse_id})
        RETURNING *
      `;

      await writeLog(sql, {
        tenant_id:   tenantId,
        actor,
        action:      'producto.creado',
        entity_type: 'producto',
        entity_id:   sku,
        entity_name: `${sku} — ${name}`,
        details:     { sku, name, brand, cat, tipo, stock },
      });

      return res.status(201).json(row);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('products error:', err);
    return res.status(500).json({ error: err.message });
  }
};
