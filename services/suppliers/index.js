// services/suppliers/index.js
// Microservicio de Proveedores.
// Almacena datos de contacto que se muestran en alertas de stock bajo.

const express = require("express");
const mysql = require("mysql2/promise");
const app  = express();
app.use(express.json());

const db = mysql.createPool({
  host:     process.env.DB_HOST     || "localhost",
  port:     process.env.DB_PORT     || 3306,
  user:     process.env.DB_USER     || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME     || "stockflow",
  waitForConnections: true,
  connectionLimit: 10,
  timezone: "+00:00",
});
const PORT = process.env.PORT || 3005;

async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS suppliers (
      id           VARCHAR(50) PRIMARY KEY,
      name         VARCHAR(200) NOT NULL,
      rut          VARCHAR(20),
      phone        VARCHAR(30),
      whatsapp     VARCHAR(30),
      email        VARCHAR(200),
      address      TEXT,
      contact_name VARCHAR(200),   -- persona de contacto
      notes        TEXT,
      active       TINYINT(1) DEFAULT 1,
      created_at   DATETIME DEFAULT NOW(),
      updated_at   DATETIME DEFAULT NOW()
    );

    -- Qué productos suministra cada proveedor (referencia cruzada con Catalog)
    CREATE TABLE IF NOT EXISTS supplier_products (
      supplier_id  VARCHAR(50) NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      product_sku  VARCHAR(50) NOT NULL,
      lead_days    INTEGER DEFAULT 1,     -- días de entrega estimados
      min_order    INTEGER DEFAULT 1,     -- pedido mínimo
      unit_cost    DECIMAL(12,2),
      PRIMARY KEY (supplier_id, product_sku)
    );
  `);
}

// ══════════════════════════════════════════
// SUPPLIERS
// ══════════════════════════════════════════

// GET /api/suppliers
app.get("/api/suppliers", async (req, res) => {
  const { q, active = "true" } = req.query;
  let sql = "SELECT * FROM suppliers WHERE active=?";
  const params = [active === "true"];
  if (q) { sql += " AND (name LIKE ? OR email LIKE ?)"; params.push(`%${q}%`); }
  sql += " ORDER BY name";
  const [rows] = await db.query(sql, params);
  res.json({ data: rows });
});

// GET /api/suppliers/:id
app.get("/api/suppliers/:id", async (req, res) => {
  const [rows] = await db.query("SELECT * FROM suppliers WHERE id=?",[req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Proveedor no encontrado" });
  const [prods] = await db.query(
    "SELECT * FROM supplier_products WHERE supplier_id=?",[req.params.id]
  );
  res.json({ data: { ...rows[0], products: prods } });
});

// GET /api/suppliers/by-product/:sku — proveedor asignado a un producto (para alertas)
app.get("/api/suppliers/by-product/:sku", async (req, res) => {
  const [rows] = await db.query(`
    SELECT s.* FROM suppliers s
    JOIN supplier_products sp ON s.id = sp.supplier_id
    WHERE sp.product_sku = ? AND s.active = true
    LIMIT 1
  `, [req.params.sku]);
  if (!rows.length) return res.status(404).json({ error: "Sin proveedor para este SKU" });
  res.json({ data: rows[0] });
});

// POST /api/suppliers
app.post("/api/suppliers", async (req, res) => {
  const { name, rut, phone, whatsapp, email, address, contact_name, notes } = req.body;
  if (!name) return res.status(400).json({ error: "El nombre es obligatorio" });
  const id = "SUP-" + Date.now().toString(36).toUpperCase();
  try {
    const [rows] = await db.query(
      `INSERT INTO suppliers (id,name,rut,phone,whatsapp,email,address,contact_name,notes)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, name, rut, phone, whatsapp||phone, email, address, contact_name, notes]
    );
    res.status(201).json({ data: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/suppliers/:id
app.put("/api/suppliers/:id", async (req, res) => {
  const fields = ["name","rut","phone","whatsapp","email","address","contact_name","notes","active"];
  const updates = []; const params = []; let i = 1;
  fields.forEach(f => {
    if (req.body[f] !== undefined) { updates.push(`${f}=$${i++}`); params.push(req.body[f]); }
  });
  if (!updates.length) return res.status(400).json({ error: "Sin campos" });
  updates.push("updated_at=NOW()");
  params.push(req.params.id);
  const [rows] = await db.query(
    `UPDATE suppliers SET ${updates.join(",")} WHERE id=$${i}`, params
  );
  if (!rows.length) return res.status(404).json({ error: "Proveedor no encontrado" });
  res.json({ data: rows[0] });
});

// DELETE /api/suppliers/:id — soft delete
app.delete("/api/suppliers/:id", async (req, res) => {
  await db.query("UPDATE suppliers SET active=false,updated_at=NOW() WHERE id=?",[req.params.id]);
  res.json({ message: "Proveedor desactivado" });
});

// ── SUPPLIER PRODUCTS ─────────────────────
// PUT /api/suppliers/:id/products — reemplazar lista de productos del proveedor
app.put("/api/suppliers/:id/products", async (req, res) => {
  const { products = [] } = req.body;
  const client = await db.getConnection();
  try {
    await client.query("START TRANSACTION");
    await client.query("DELETE FROM supplier_products WHERE supplier_id=?",[req.params.id]);
    for (const p of products) {
      await client.query(
        `INSERT INTO supplier_products (supplier_id,product_sku,lead_days,min_order,unit_cost)
         VALUES (?,?,?,?,?)
         ON CONFLICT (supplier_id,product_sku) DO UPDATE
         SET lead_days=?,min_order=?,unit_cost=?`,
        [req.params.id, p.product_sku, p.lead_days||1, p.min_order||1, p.unit_cost]
      );
    }
    await client.query("COMMIT");
    res.json({ message: "Productos del proveedor actualizados" });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get("/health", (req, res) => res.json({ status: "ok", service: "suppliers" }));

initDB().then(() => app.listen(PORT, () => console.log(`[Suppliers] Puerto ${PORT}`)));
