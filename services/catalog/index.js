// services/catalog/index.js
// Microservicio de Catálogo — gestiona productos, marcas, categorías y precios.

const express = require("express");
const mysql = require("mysql2/promise");
const app = express();
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
const PORT = process.env.PORT || 3001;

// ─── INIT DB ───────────────────────────────────
async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS products (
      sku           VARCHAR(50) PRIMARY KEY,
      barcode       VARCHAR(100) UNIQUE,
      name          VARCHAR(200) NOT NULL,
      brand         VARCHAR(100),
      category      VARCHAR(100),
      unit          VARCHAR(50) DEFAULT 'unidad',
      cost_price    DECIMAL(12,2) DEFAULT 0,
      sale_price    DECIMAL(12,2) DEFAULT 0,
      description   TEXT,
      image_url     TEXT,
      supplier_id   VARCHAR(50),       -- referencia al servicio Suppliers
      active        TINYINT(1) DEFAULT 1,
      created_at    DATETIME DEFAULT NOW(),
      updated_at    DATETIME DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS categories (
      id    INT AUTO_INCREMENT PRIMARY KEY,
      name  VARCHAR(100) UNIQUE NOT NULL,
      icon  VARCHAR(50)
    );
  `);
}

// ══════════════════════════════════════════
// PRODUCTS
// ══════════════════════════════════════════

// GET /api/catalog/products — listar todos (con filtros opcionales)
// Query params: ?category=X  ?brand=X  ?q=texto  ?active=true
app.get("/api/catalog/products", async (req, res) => {
  try {
    const { category, brand, q, active = "true" } = req.query;
    let sql = "SELECT * FROM products WHERE active = ?";
    const params = [active === "true"];
    let i = 2;

    if (category) { sql += ` AND category = $${i++}`; params.push(category); }
    if (brand)    { sql += ` AND brand = $${i++}`;    params.push(brand); }
    if (q) {
      sql += ` AND (name LIKE $${i} OR brand LIKE $${i} OR sku LIKE $${i})`;
      params.push(`%${q}%`); i++;
    }
    sql += " ORDER BY name ASC";

    const [rows] = await db.query(sql, params);
    res.json({ data: rows, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/catalog/products/:sku — obtener producto por SKU
app.get("/api/catalog/products/:sku", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT * FROM products WHERE sku = ?",
      [req.params.sku]
    );
    if (!rows.length) return res.status(404).json({ error: "Producto no encontrado" });
    res.json({ data: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/catalog/products/barcode/:code — buscar por código de barras (PIM lookup)
app.get("/api/catalog/products/barcode/:code", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT * FROM products WHERE barcode = ?",
      [req.params.code]
    );
    if (!rows.length) {
      // Intentar lookup externo (PIM / Open Food Facts / GS1)
      const pimResult = await externalPIMLookup(req.params.code);
      if (pimResult) return res.json({ data: pimResult, source: "pim_external", existing: false });
      return res.status(404).json({ error: "Producto no encontrado", existing: false });
    }
    res.json({ data: rows[0], source: "catalog", existing: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/catalog/products — crear producto
app.post("/api/catalog/products", async (req, res) => {
  try {
    const {
      sku, barcode, name, brand, category, unit = "unidad",
      cost_price = 0, sale_price = 0, description, image_url, supplier_id
    } = req.body;

    if (!name) return res.status(400).json({ error: "El campo 'name' es obligatorio" });
    if (!sku)  return res.status(400).json({ error: "El campo 'sku' es obligatorio" });

    const [rows] = await db.query(`
      INSERT INTO products (sku, barcode, name, brand, category, unit, cost_price, sale_price,
                            description, image_url, supplier_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [sku, barcode, name, brand, category, unit, cost_price, sale_price, description, image_url, supplier_id]
    );
    res.status(201).json({ data: rows[0] });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "SKU o código de barras ya existe" });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/catalog/products/:sku — actualizar producto
app.put("/api/catalog/products/:sku", async (req, res) => {
  try {
    const fields = ["name","brand","category","unit","cost_price","sale_price",
                    "description","image_url","supplier_id","barcode","active"];
    const updates = [];
    const params = [];
    let i = 1;

    fields.forEach(f => {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = $${i++}`);
        params.push(req.body[f]);
      }
    });

    if (!updates.length) return res.status(400).json({ error: "Sin campos para actualizar" });
    updates.push(`updated_at = NOW()`);
    params.push(req.params.sku);

    const [rows] = await db.query(
      `UPDATE products SET ${updates.join(",")} WHERE sku = $${i}`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: "Producto no encontrado" });
    res.json({ data: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/catalog/products/:sku — desactivar producto (soft delete)
app.delete("/api/catalog/products/:sku", async (req, res) => {
  try {
    const [rows] = await db.query(
      "UPDATE products SET active = false, updated_at = NOW() WHERE sku = ?",
      [req.params.sku]
    );
    if (!rows.length) return res.status(404).json({ error: "Producto no encontrado" });
    res.json({ message: "Producto desactivado", sku: rows[0].sku });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
// CATEGORIES
// ══════════════════════════════════════════

app.get("/api/catalog/categories", async (req, res) => {
  const [rows] = await db.query("SELECT * FROM categories ORDER BY name");
  res.json({ data: rows });
});

app.post("/api/catalog/categories", async (req, res) => {
  const { name, icon } = req.body;
  if (!name) return res.status(400).json({ error: "El nombre es obligatorio" });
  try {
    const [rows] = await db.query(
      "INSERT INTO categories (name, icon) VALUES (?,?) ON CONFLICT (name) DO NOTHING",
      [name, icon]
    );
    res.status(201).json({ data: rows[0] || { name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/catalog/categories/:id", async (req, res) => {
  await db.query("DELETE FROM categories WHERE id = ?", [req.params.id]);
  res.json({ message: "Categoría eliminada" });
});

// ══════════════════════════════════════════
// PIM LOOKUP HELPER
// Consulta Open Food Facts u otro catálogo externo por código de barras
// ══════════════════════════════════════════
async function externalPIMLookup(barcode) {
  try {
    const res = await fetch(`https://world.openfoodfacts.org/api/v0/product/${barcode}.json`);
    const data = await res.json();
    if (data.status !== 1) return null;
    const p = data.product;
    return {
      barcode,
      name: p.product_name || p.product_name_es || "Producto desconocido",
      brand: p.brands || "Sin marca",
      category: p.categories_tags?.[0]?.replace("en:", "") || "General",
      image_url: p.image_url || null,
    };
  } catch {
    return null;
  }
}

// ─── HEALTH ────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok", service: "catalog" }));

initDB().then(() => {
  app.listen(PORT, () => console.log(`[Catalog] Puerto ${PORT}`));
});
