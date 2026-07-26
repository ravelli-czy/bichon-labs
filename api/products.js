// api/products.js — GET /api/products  POST /api/products
// GET/POST /api/products?groups=1 — Grupo de Productos (colapsado acá para no sumar
// otra Serverless Function; el plan Hobby de Vercel tiene tope de 12).
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
    // ── /api/products?groups=1 — Grupo de Productos ─────────────────────────
    if (req.query?.groups === '1') {
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
          tenant_id: tenantId, actor, action: 'grupo_producto.creado',
          entity_type: 'product_group', entity_id: String(row.id), entity_name: row.name,
          details: { id: row.id, name: row.name },
        });
        return res.status(201).json(row);
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

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
        groups = [], sku: explicitSku,
      } = req.body || {};

      if (!name) return res.status(400).json({ error: 'name is required' });
      if (!Array.isArray(groups)) return res.status(400).json({ error: 'groups must be an array' });

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
        INSERT INTO products (sku, name, brand, cat, tipo, cost, price, stock, threshold, barcode, groups, created_by, tenant_id, warehouse_id)
        VALUES (${sku}, ${name}, ${brand}, ${cat}, ${tipo}, ${cost}, ${price}, ${stock}, ${threshold}, ${barcode}, ${JSON.stringify(groups)}, ${actor}, ${tenantId}, ${warehouse_id})
        RETURNING *
      `;

      // El Grupo de Productos es una propiedad del producto, no del almacén:
      // se sincroniza a todas las filas (SKUs por almacén) de este mismo sku.
      if (explicitSku) {
        await sql`
          UPDATE products SET groups = ${JSON.stringify(groups)}::jsonb
          WHERE sku = ${sku} AND tenant_id = ${tenantId} AND warehouse_id != ${warehouse_id}
        `;
      }

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
