// api/products.js — GET /api/products  POST /api/products
// GET/POST /api/products?groups=1 — Grupo de Productos (colapsado acá para no sumar
// otra Serverless Function; el plan Hobby de Vercel tiene tope de 12).
// /api/products?resource=stock-receipts — Ingreso de inventario, mismo motivo,
// vive en api/_stock_receipts_routes.js.
// /api/products?resource=purchase-formats — Mantenedor de Formatos de compra,
// mismo motivo, vive en api/_purchase_formats_routes.js.
const { getDb } = require('./_db');
const cors = require('./_cors');
const { writeLog } = require('./_log');
const { getSession, resolveTenantId } = require('./_tenant');
const { handleStockReceiptsResource, STOCK_RECEIPT_RESOURCES } = require('./_stock_receipts_routes');
const { handlePurchaseFormatsResource, PURCHASE_FORMAT_RESOURCES } = require('./_purchase_formats_routes');

module.exports = async (req, res) => {
  if (cors(req, res)) return;

  let sql;
  try { sql = getDb(); }
  catch (err) { return res.status(503).json({ error: err.message }); }

  const session  = await getSession(req);
  const tenantId = resolveTenantId(req, session);
  if (!tenantId) return res.status(401).json({ error: 'No autenticado o sin tenant' });
  const actor = session?.username || 'sistema';

  // ── Ingreso de inventario: historial + registrar compra ─────────────────
  if (STOCK_RECEIPT_RESOURCES.includes(req.query?.resource)) {
    return handleStockReceiptsResource(req, res, sql, session, tenantId, actor);
  }
  // ── Mantenedor de Formatos de compra ─────────────────────────────────────
  if (PURCHASE_FORMAT_RESOURCES.includes(req.query?.resource)) {
    return handlePurchaseFormatsResource(req, res, sql, session, tenantId, actor);
  }

  try {
    // ── /api/products?labels=1 — Templates de etiqueta/tarjeta (item 8) ────
    if (req.query?.labels === '1') {
      if (req.method === 'GET') {
        const rows = await sql`SELECT * FROM label_templates WHERE tenant_id = ${tenantId} ORDER BY type, name`;
        return res.json(rows);
      }
      if (req.method === 'POST') {
        const {
          type = 'etiqueta', name, image_url = '', font = 'Nunito',
          width_mm = null, height_mm = null, auto_size = true,
          paper_type = 'adhesivo', content_text = '',
        } = req.body || {};
        if (!name) return res.status(400).json({ error: 'name is required' });
        // El tenant puede definir tipos de etiqueta propios además de los 3
        // predefinidos (etiqueta, huincha_sellado, tarjeta_instrucciones) —
        // la columna es texto libre, sin CHECK constraint.
        if (typeof type !== 'string' || !type.trim()) {
          return res.status(400).json({ error: 'type inválido' });
        }
        const [{ max_num }] = await sql`
          SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 5) AS INTEGER)), 0) AS max_num
          FROM label_templates
          WHERE id ~ '^LBL-[0-9]+$' AND tenant_id = ${tenantId}
        `;
        const id = 'LBL-' + String(parseInt(max_num) + 1).padStart(3, '0');
        const [row] = await sql`
          INSERT INTO label_templates
            (id, tenant_id, type, name, image_url, font, width_mm, height_mm, auto_size, paper_type, content_text, created_by)
          VALUES
            (${id}, ${tenantId}, ${type}, ${name}, ${image_url}, ${font}, ${width_mm}, ${height_mm}, ${auto_size}, ${paper_type}, ${content_text}, ${actor})
          RETURNING *
        `;
        await writeLog(sql, {
          tenant_id: tenantId, actor, action: 'label_template.creado',
          entity_type: 'label_template', entity_id: id, entity_name: `${id} — ${name}`,
          details: { id, type, name, paper_type },
        });
        return res.status(201).json(row);
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

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
    // cost ya no es una columna propia — se computa en vivo: el unit_cost del
    // lote FIFO más viejo con stock (lo próximo que se va a vender), o si no
    // queda ninguno activo, el del último lote registrado (mejor referencia
    // disponible). Si el almacén exacto de la fila no tiene ningún lote (ej.
    // el registro de catálogo, warehouse_id vacío, que nunca tiene lotes
    // propios porque Ingreso de inventario siempre exige elegir un almacén
    // real), cae a cualquier lote del SKU en cualquier almacén. Si el SKU
    // nunca tuvo NINGÚN lote, cae al último costo con el que efectivamente
    // se vendió (última orden donde aparece, directo o como componente de un
    // KIT). Ver api/_finance.js:loadCostMaps, misma lógica.
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT p.sku, p.name, p.brand, p.cat, p.tipo, p.price, p.stock, p.threshold,
               p.created_by, p.updated_by, p.created_at, p.updated_at, p.tenant_id, p.warehouse_id,
               p.barcode, p.groups, p.stock_unit, p.purchase_unit, p.purchase_factor, p.purchase_forms,
               COALESCE(
                 (SELECT sr.unit_cost FROM stock_receipts sr
                  WHERE sr.tenant_id = p.tenant_id AND sr.sku = p.sku AND sr.warehouse_id = p.warehouse_id AND sr.remaining_qty > 0
                  ORDER BY sr.created_at ASC LIMIT 1),
                 (SELECT sr.unit_cost FROM stock_receipts sr
                  WHERE sr.tenant_id = p.tenant_id AND sr.sku = p.sku AND sr.warehouse_id = p.warehouse_id
                  ORDER BY sr.created_at DESC LIMIT 1),
                 (SELECT sr.unit_cost FROM stock_receipts sr
                  WHERE sr.tenant_id = p.tenant_id AND sr.sku = p.sku AND sr.remaining_qty > 0
                  ORDER BY sr.created_at ASC LIMIT 1),
                 (SELECT sr.unit_cost FROM stock_receipts sr
                  WHERE sr.tenant_id = p.tenant_id AND sr.sku = p.sku
                  ORDER BY sr.created_at DESC LIMIT 1),
                 (SELECT COALESCE((item->>'unitCostAtSale')::numeric, (item->>'cost')::numeric)
                  FROM orders o, jsonb_array_elements(o.items) AS item
                  WHERE o.tenant_id = p.tenant_id AND item->>'sku' = p.sku
                  ORDER BY o.created_at DESC LIMIT 1),
                 (SELECT (comp->>'unitCost')::numeric
                  FROM orders o,
                       jsonb_array_elements(o.items) AS item,
                       jsonb_array_elements(COALESCE(item->'componentBreakdown', '[]'::jsonb)) AS comp
                  WHERE o.tenant_id = p.tenant_id AND comp->>'sku' = p.sku
                  ORDER BY o.created_at DESC LIMIT 1),
                 0
               ) AS cost
        FROM products p
        WHERE p.tenant_id = ${tenantId}
        ORDER BY p.warehouse_id, p.name
      `;
      return res.json(rows);
    }

    // ── POST — create product ─────────────────────────────────────────────
    if (req.method === 'POST') {
      const {
        name, brand = 'Sin marca', cat = 'General',
        tipo = 'producto', price = 0,
        stock = 0, threshold = 10, warehouse_id = '', barcode = '',
        groups = [], sku: explicitSku,
        stock_unit = 'unidad',
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
        INSERT INTO products (sku, name, brand, cat, tipo, price, stock, threshold, barcode, groups, created_by, tenant_id, warehouse_id, stock_unit)
        VALUES (${sku}, ${name}, ${brand}, ${cat}, ${tipo}, ${price}, ${stock}, ${threshold}, ${barcode}, ${JSON.stringify(groups)}, ${actor}, ${tenantId}, ${warehouse_id}, ${stock_unit})
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
