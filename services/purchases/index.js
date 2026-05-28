// services/purchases/index.js
// Microservicio de Compras — órdenes de compra, recepción de mercadería.
// Al recibir una ÓC, notifica a WMS para incrementar stock.

const express = require("express");
const mysql = require("mysql2/promise");
const amqp    = require("amqplib");
const fetch   = require("node-fetch");
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
const PORT = process.env.PORT || 3004;
const WMS  = process.env.WMS_URL || "http://localhost:3002";
let   mq;

async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id            VARCHAR(50) PRIMARY KEY,
      supplier_id   VARCHAR(50) NOT NULL,
      supplier_name VARCHAR(200),           -- desnormalizado para historial
      doc_number    VARCHAR(100),           -- N° boleta o factura
      doc_type      VARCHAR(20) DEFAULT 'boleta',  -- boleta | factura
      status        VARCHAR(20) DEFAULT 'pending', -- pending | received | cancelled
      total         DECIMAL(12,2) DEFAULT 0,
      notes         TEXT,
      ordered_at    DATETIME DEFAULT NOW(),
      received_at   DATETIME,
      created_at    DATETIME DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS purchase_items (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      order_id     VARCHAR(50) NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      product_sku  VARCHAR(50) NOT NULL,
      qty          INTEGER NOT NULL,
      unit_cost    DECIMAL(12,2) NOT NULL,
      subtotal     DECIMAL(12,2) AS (qty * unit_cost) STORED
    );

    CREATE INDEX IF NOT EXISTS idx_po_supplier ON purchase_orders(supplier_id);
    CREATE INDEX IF NOT EXISTS idx_po_status   ON purchase_orders(status);
  `);
}

async function initMQ() {
  try {
    const conn = await amqp.connect(process.env.RABBITMQ_URL || "amqp://localhost");
    mq = await conn.createChannel();
    await mq.assertExchange("stockflow", "topic", { durable: true });
    console.log("[Purchases] RabbitMQ conectado");
  } catch (err) {
    console.warn("[Purchases] RabbitMQ no disponible:", err.message);
  }
}

function nextPOId() {
  return "OC-" + Date.now().toString(36).toUpperCase();
}

// ══════════════════════════════════════════
// PURCHASE ORDERS
// ══════════════════════════════════════════

// GET /api/purchases — listar con filtros
app.get("/api/purchases", async (req, res) => {
  try {
    const { supplier_id, status, from, to, limit = 100 } = req.query;
    let sql = `
      SELECT po.*, json_agg(json_build_object(
        'id',pi.id,'product_sku',pi.product_sku,'qty',pi.qty,
        'unit_cost',pi.unit_cost,'subtotal',pi.subtotal
      )) AS items
      FROM purchase_orders po
      LEFT JOIN purchase_items pi ON po.id = pi.order_id
      WHERE 1=1`;
    const params = []; let i = 1;
    if (supplier_id) { sql += ` AND po.supplier_id=$${i++}`; params.push(supplier_id); }
    if (status)      { sql += ` AND po.status=$${i++}`;      params.push(status); }
    if (from)        { sql += ` AND po.ordered_at >= $${i++}`; params.push(from); }
    if (to)          { sql += ` AND po.ordered_at <= $${i++}`; params.push(to); }
    sql += ` GROUP BY po.id ORDER BY po.ordered_at DESC LIMIT $${i}`;
    params.push(Number(limit));
    const [rows] = await db.query(sql, params);
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/purchases/summary — resumen financiero de compras
app.get("/api/purchases/summary", async (req, res) => {
  const { from, to } = req.query;
  let sql = `SELECT
    COUNT(*) AS total_orders,
    COALESCE(SUM(CASE WHEN status='received' THEN total ELSE 0 END),0) AS total_spent,
    COUNT(CASE WHEN status='pending' THEN 1 END) AS pending_count
    FROM purchase_orders WHERE 1=1`;
  const params = []; let i = 1;
  if (from) { sql += ` AND ordered_at >= $${i++}`; params.push(from); }
  if (to)   { sql += ` AND ordered_at <= $${i++}`; params.push(to); }
  const [rows] = await db.query(sql, params);
  res.json({ data: rows[0] });
});

// GET /api/purchases/:id
app.get("/api/purchases/:id", async (req, res) => {
  const [rows] = await db.query("SELECT * FROM purchase_orders WHERE id=?",[req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "ÓC no encontrada" });
  const [items] = await db.query("SELECT * FROM purchase_items WHERE order_id=?",[req.params.id]);
  res.json({ data: { ...rows[0], items } });
});

// POST /api/purchases — crear orden de compra
app.post("/api/purchases", async (req, res) => {
  const client = await db.getConnection();
  try {
    const {
      supplier_id, supplier_name, doc_number, doc_type = "boleta",
      items = [], notes, status = "pending"
    } = req.body;

    if (!supplier_id) return res.status(400).json({ error: "supplier_id es obligatorio" });
    if (!items.length) return res.status(400).json({ error: "La ÓC necesita al menos un artículo" });

    await client.query("START TRANSACTION");
    const id    = nextPOId();
    const total = items.reduce((s, i) => s + i.qty * i.unit_cost, 0);

    await client.query(
      `INSERT INTO purchase_orders (id,supplier_id,supplier_name,doc_number,doc_type,status,total,notes)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, supplier_id, supplier_name, doc_number, doc_type, status, total, notes]
    );

    for (const item of items) {
      await client.query(
        "INSERT INTO purchase_items (order_id,product_sku,qty,unit_cost) VALUES (?,?,?,?)",
        [id, item.product_sku, item.qty, item.unit_cost]
      );
    }
    await client.query("COMMIT");

    // Si llega ya recibida, actualizar stock inmediatamente
    if (status === "received") {
      await receiveItems(id, items);
    }

    res.status(201).json({ data: { id, total, items } });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PUT /api/purchases/:id — actualizar datos de la ÓC (no artículos)
app.put("/api/purchases/:id", async (req, res) => {
  const fields = ["doc_number","doc_type","notes","supplier_name"];
  const updates = []; const params = []; let i = 1;
  fields.forEach(f => {
    if (req.body[f] !== undefined) { updates.push(`${f}=$${i++}`); params.push(req.body[f]); }
  });
  if (!updates.length) return res.status(400).json({ error: "Sin campos" });
  params.push(req.params.id);
  const [rows] = await db.query(
    `UPDATE purchase_orders SET ${updates.join(",")} WHERE id=$${i}`, params
  );
  if (!rows.length) return res.status(404).json({ error: "ÓC no encontrada" });
  res.json({ data: rows[0] });
});

// POST /api/purchases/:id/receive — marcar como recibida e incrementar stock
app.post("/api/purchases/:id/receive", async (req, res) => {
  const [rows] = await db.query(
    "SELECT * FROM purchase_orders WHERE id=?",[req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "ÓC no encontrada" });
  if (rows[0].status === "received") return res.status(409).json({ error: "Ya fue recibida" });
  if (rows[0].status === "cancelled") return res.status(409).json({ error: "ÓC cancelada" });

  const [items] = await db.query(
    "SELECT * FROM purchase_items WHERE order_id=?",[req.params.id]
  );

  await db.query(
    "UPDATE purchase_orders SET status='received',received_at=NOW() WHERE id=?",[req.params.id]
  );

  const result = await receiveItems(req.params.id, items);
  res.json({ message: "Mercadería recibida y stock actualizado", stock_updates: result });
});

// DELETE /api/purchases/:id — cancelar ÓC (solo si pendiente)
app.delete("/api/purchases/:id", async (req, res) => {
  const [rows] = await db.query("SELECT status FROM purchase_orders WHERE id=?",[req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "ÓC no encontrada" });
  if (rows[0].status !== "pending") return res.status(409).json({ error: "Solo se pueden cancelar ÓC pendientes" });
  await db.query("UPDATE purchase_orders SET status='cancelled' WHERE id=?",[req.params.id]);
  res.json({ message: "ÓC cancelada" });
});

// ─── HELPERS ───────────────────────────────────
async function receiveItems(orderId, items) {
  const results = [];
  for (const item of items) {
    try {
      const r = await fetch(`${WMS}/api/inventory/${item.product_sku}/stock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "in",
          qty: item.qty,
          reference: orderId,
          note: "Recepción ÓC"
        }),
      });
      const data = await r.json();
      results.push({ sku: item.product_sku, result: data });
    } catch (err) {
      console.error("[Purchases] Error actualizando WMS:", err.message);
      results.push({ sku: item.product_sku, error: err.message });
    }
  }
  mq?.publish("stockflow", "purchase.received", Buffer.from(JSON.stringify({
    type: "purchase.received", orderId, items
  })));
  return results;
}

app.get("/health", (req, res) => res.json({ status: "ok", service: "purchases" }));

initDB()
  .then(initMQ)
  .then(() => app.listen(PORT, () => console.log(`[Purchases] Puerto ${PORT}`)));
