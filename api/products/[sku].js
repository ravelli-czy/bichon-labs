// api/products/[sku].js — GET/PUT/DELETE /api/products/:sku
// PUT/DELETE /api/products/:id?groups=1 — Grupo de Productos (:id es el id numérico
// del grupo). Colapsado acá para no sumar otra Serverless Function (tope 12 en Hobby).
const { getDb } = require('../_db');
const cors = require('../_cors');
const { writeLog } = require('../_log');
const { getSession, resolveTenantId } = require('../_tenant');
const { checkSalePriceMatch } = require('../_warehouse_price');

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
    // ── /api/products/:id?labels=1 — Templates de etiqueta/tarjeta ──────────
    if (req.query?.labels === '1') {
      const id = sku;

      if (req.method === 'GET') {
        const [row] = await sql`SELECT * FROM label_templates WHERE id = ${id} AND tenant_id = ${tenantId}`;
        if (!row) return res.status(404).json({ error: 'Template no encontrado' });
        return res.json(row);
      }

      if (req.method === 'PUT') {
        const { type, name, image_url, font, width_mm, height_mm, auto_size, paper_type, content_text, active } = req.body || {};
        // Tipos custom son texto libre — solo validamos que no venga vacío.
        if (type !== undefined && (typeof type !== 'string' || !type.trim())) {
          return res.status(400).json({ error: 'type inválido' });
        }
        // Nota: igual que en el resto de la API, un campo omitido deja el
        // valor actual sin tocar (no hay forma de "limpiar" a null vía PUT).
        // auto_size=true simplemente hace que width_mm/height_mm se ignoren
        // al imprimir, así que no hace falta poder limpiarlos.
        const [row] = await sql`
          UPDATE label_templates SET
            type         = COALESCE(${type         ?? null}, type),
            name         = COALESCE(${name         ?? null}, name),
            image_url    = COALESCE(${image_url     ?? null}, image_url),
            font         = COALESCE(${font          ?? null}, font),
            width_mm     = COALESCE(${width_mm      ?? null}, width_mm),
            height_mm    = COALESCE(${height_mm     ?? null}, height_mm),
            auto_size    = COALESCE(${auto_size     ?? null}, auto_size),
            paper_type   = COALESCE(${paper_type    ?? null}, paper_type),
            content_text = COALESCE(${content_text  ?? null}, content_text),
            active       = COALESCE(${active        ?? null}, active),
            updated_by = ${actor},
            updated_at = NOW()
          WHERE id = ${id} AND tenant_id = ${tenantId}
          RETURNING *
        `;
        if (!row) return res.status(404).json({ error: 'Template no encontrado' });
        await writeLog(sql, {
          tenant_id: tenantId, actor, action: 'label_template.editado',
          entity_type: 'label_template', entity_id: id, entity_name: `${id} — ${row.name}`,
          details: { id, name: row.name },
        });
        return res.json(row);
      }

      if (req.method === 'DELETE') {
        const [row] = await sql`DELETE FROM label_templates WHERE id = ${id} AND tenant_id = ${tenantId} RETURNING *`;
        if (!row) return res.status(404).json({ error: 'Template no encontrado' });
        await writeLog(sql, {
          tenant_id: tenantId, actor, action: 'label_template.eliminado',
          entity_type: 'label_template', entity_id: id, entity_name: `${id} — ${row.name}`,
          details: { id, name: row.name },
        });
        return res.json({ ok: true, deleted: id });
      }

      return res.status(405).json({ error: 'Method not allowed' });
    }

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

    // ── /api/products/:id?suppliers=1 — Catálogo de Proveedores ─────────────
    if (req.query?.suppliers === '1') {
      const supplierId = sku;

      if (req.method === 'PUT') {
        const { name } = req.body || {};
        if (!name) return res.status(400).json({ error: 'name is required' });
        let row;
        try {
          [row] = await sql`
            UPDATE suppliers SET name = ${name}
            WHERE id = ${supplierId} AND tenant_id = ${tenantId}
            RETURNING *
          `;
        } catch (err) {
          if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un proveedor con ese nombre' });
          throw err;
        }
        if (!row) return res.status(404).json({ error: 'Proveedor no encontrado' });
        await writeLog(sql, {
          tenant_id: tenantId, actor, action: 'proveedor.editado',
          entity_type: 'supplier', entity_id: row.id, entity_name: row.name,
          details: { id: row.id, name: row.name },
        });
        return res.json(row);
      }

      if (req.method === 'DELETE') {
        const [row] = await sql`DELETE FROM suppliers WHERE id = ${supplierId} AND tenant_id = ${tenantId} RETURNING *`;
        if (!row) return res.status(404).json({ error: 'Proveedor no encontrado' });

        const supplierIdJson = JSON.stringify(supplierId);
        await sql`
          UPDATE products SET suppliers = (
            SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
            FROM jsonb_array_elements(suppliers) elem
            WHERE elem <> ${supplierIdJson}::jsonb
          )
          WHERE tenant_id = ${tenantId} AND suppliers @> ${supplierIdJson}::jsonb
        `;

        await writeLog(sql, {
          tenant_id: tenantId, actor, action: 'proveedor.eliminado',
          entity_type: 'supplier', entity_id: row.id, entity_name: row.name,
          details: { id: row.id, name: row.name },
        });
        return res.json({ ok: true, deleted: row.id });
      }

      return res.status(405).json({ error: 'Method not allowed' });
    }

    // cost ya no es una columna propia — se computa en vivo: el unit_cost del
    // lote FIFO más viejo con stock (lo próximo que se va a vender), o si no
    // queda ninguno activo, el del último lote registrado. Si el almacén
    // exacto de la fila no tiene ningún lote (ej. el registro de catálogo,
    // warehouse_id vacío, que nunca tiene lotes propios porque Ingreso de
    // inventario siempre exige elegir un almacén real), cae a cualquier lote
    // del SKU en cualquier almacén. Ver api/_finance.js:loadCostMaps, misma
    // lógica (repetida en texto acá porque el driver de Neon no soporta
    // componer fragments de sql``).

    // ── GET ───────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const [row] = await sql`
        SELECT p.sku, p.name, p.brand, p.cat, p.tipo, p.price, p.stock, p.threshold,
               p.created_by, p.updated_by, p.created_at, p.updated_at, p.tenant_id, p.warehouse_id,
               p.barcode, p.groups, p.suppliers, p.stock_unit, p.purchase_unit, p.purchase_factor, p.purchase_forms,
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
        WHERE p.sku = ${sku} AND p.warehouse_id = ${warehouse_id} AND p.tenant_id = ${tenantId}
      `;
      if (!row) return res.status(404).json({ error: 'Product not found' });
      return res.json(row);
    }

    // ── PUT — update product ──────────────────────────────────────────────
    if (req.method === 'PUT') {
      const {
        name, brand, cat, tipo, price, stock, threshold, barcode, groups, suppliers, new_warehouse_id,
        stock_unit,
      } = req.body || {};
      if (groups !== undefined && !Array.isArray(groups)) return res.status(400).json({ error: 'groups must be an array' });
      if (suppliers !== undefined && !Array.isArray(suppliers)) return res.status(400).json({ error: 'suppliers must be an array' });
      const groupsJson = groups !== undefined ? JSON.stringify(groups) : null;
      const suppliersJson = suppliers !== undefined ? JSON.stringify(suppliers) : null;

      if (price !== undefined && price !== null) {
        const priceMismatch = await checkSalePriceMatch(sql, tenantId, sku, new_warehouse_id || warehouse_id, price);
        if (priceMismatch) return res.status(400).json(priceMismatch);
      }

      await sql`
        UPDATE products SET
          name            = COALESCE(${name            ?? null}, name),
          brand           = COALESCE(${brand           ?? null}, brand),
          cat             = COALESCE(${cat             ?? null}, cat),
          tipo            = COALESCE(${tipo            ?? null}, tipo),
          price           = COALESCE(${price           ?? null}, price),
          stock           = COALESCE(${stock           ?? null}, stock),
          threshold       = COALESCE(${threshold       ?? null}, threshold),
          barcode         = COALESCE(${barcode         ?? null}, barcode),
          groups          = COALESCE(${groupsJson}::jsonb, groups),
          suppliers       = COALESCE(${suppliersJson}::jsonb, suppliers),
          warehouse_id    = COALESCE(${new_warehouse_id ?? null}, warehouse_id),
          stock_unit      = COALESCE(${stock_unit      ?? null}, stock_unit),
          updated_by = ${actor},
          updated_at = NOW()
        WHERE sku = ${sku} AND warehouse_id = ${warehouse_id} AND tenant_id = ${tenantId}
      `;
      // new_warehouse_id (mover el SKU a otro almacén) cambia la PK — hay que
      // volver a buscar por el warehouse_id nuevo, no el original.
      const finalWarehouseId = new_warehouse_id ?? warehouse_id;

      // Los insumos no llevan marca propia — se fuerza en servidor (no sólo
      // en el form) para que no se pueda evadir llamando la API directo.
      // Corre después del UPDATE de arriba para ver el tipo ya resuelto
      // (el que vino en el body, o si no vino, el que ya tenía en la BD).
      await sql`
        UPDATE products SET brand = 'Insumo'
        WHERE sku = ${sku} AND warehouse_id = ${finalWarehouseId} AND tenant_id = ${tenantId} AND tipo = 'insumo'
      `;

      const [row] = await sql`
        SELECT p.sku, p.name, p.brand, p.cat, p.tipo, p.price, p.stock, p.threshold,
               p.created_by, p.updated_by, p.created_at, p.updated_at, p.tenant_id, p.warehouse_id,
               p.barcode, p.groups, p.suppliers, p.stock_unit, p.purchase_unit, p.purchase_factor, p.purchase_forms,
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
        WHERE p.sku = ${sku} AND p.warehouse_id = ${finalWarehouseId} AND p.tenant_id = ${tenantId}
      `;
      if (!row) return res.status(404).json({ error: 'Product not found' });

      // El Grupo de Productos y los Proveedores configurados son propiedades
      // del producto, no del almacén: se sincronizan a todas las filas (SKUs
      // por almacén) de este mismo sku.
      if (groups !== undefined) {
        await sql`
          UPDATE products SET groups = ${groupsJson}::jsonb
          WHERE sku = ${sku} AND tenant_id = ${tenantId} AND warehouse_id != ${warehouse_id}
        `;
      }
      if (suppliers !== undefined) {
        await sql`
          UPDATE products SET suppliers = ${suppliersJson}::jsonb
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
