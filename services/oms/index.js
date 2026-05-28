// services/oms/index.js
// Microservicio OMS — órdenes de venta y webhook Shopify.
// Soporta: local, almacén, forma de entrega, slot de entrega, dirección.

const express = require("express");
const mysql = require("mysql2/promise");
const amqp    = require("amqplib");
const crypto  = require("crypto");
const fetch   = require("node-fetch");

const app  = express();
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
const PORT = process.env.PORT || 3003;
const WMS      = process.env.WMS_URL      || "http://localhost:3002";
const LOCALES  = process.env.LOCALES_URL  || "http://localhost:3009";
let   mq;

app.use("/api/webhooks/shopify", express.raw({ type: "application/json" }));
app.use(express.json());

// ── INIT DB ────────────────────────────────────
async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS sale_orders (
      id              VARCHAR(50) PRIMARY KEY,
      customer_name   VARCHAR(200),
      customer_email  VARCHAR(200),
      customer_phone  VARCHAR(30),
      channel         VARCHAR(50) DEFAULT 'manual',
      external_id     VARCHAR(100),
      status          VARCHAR(30) DEFAULT 'completed',
      total           DECIMAL(12,2) DEFAULT 0,
      note            TEXT,
      recipient_message TEXT,

      local_id        VARCHAR(50),
      local_name      VARCHAR(200),
      warehouse_id    VARCHAR(50),
      warehouse_name  VARCHAR(200),

      delivery_method_id    VARCHAR(50),
      delivery_method_name  VARCHAR(200),
      delivery_method_type  VARCHAR(30),

      delivery_date         DATE,
      delivery_slot_id      INTEGER,
      delivery_slot_from    TIME,
      delivery_slot_to      TIME,
      delivery_slot_label   VARCHAR(100),

      delivery_address_street  VARCHAR(300),
      delivery_address_city    VARCHAR(100),
      delivery_address_region  VARCHAR(100),
      delivery_address_zip     VARCHAR(20),
      delivery_address_notes   TEXT,

      shipping_cost   DECIMAL(10,2) DEFAULT 0,
      created_at      DATETIME DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      order_id   VARCHAR(50) NOT NULL REFERENCES sale_orders(id) ON DELETE CASCADE,
      item_type  VARCHAR(10) NOT NULL CHECK (item_type IN ('kit','product')),
      sku        VARCHAR(50) NOT NULL,
      qty        INTEGER NOT NULL,
      unit_price DECIMAL(12,2) NOT NULL,
      subtotal   DECIMAL(12,2) AS (qty * unit_price) STORED
    );

    CREATE INDEX IF NOT EXISTS idx_orders_created  ON sale_orders(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_local    ON sale_orders(local_id);
    CREATE INDEX IF NOT EXISTS idx_orders_date     ON sale_orders(delivery_date);
    CREATE INDEX IF NOT EXISTS idx_order_items     ON order_items(order_id);
  `);
}

async function initMQ() {
  try {
    const conn = await amqp.connect(process.env.RABBITMQ_URL || "amqp://localhost");
    mq = await conn.createChannel();
    await mq.assertExchange("stockflow", "topic", { durable: true });
    console.log("[OMS] RabbitMQ conectado");
  } catch (err) { console.warn("[OMS] RabbitMQ no disponible:", err.message); }
}

function nextOrderId() { return "ORD-" + Date.now().toString(36).toUpperCase(); }

// ══════════════════════════════════════════════════════
// DISPONIBILIDAD DE SLOTS — proxy al microservicio Locales
// ══════════════════════════════════════════════════════
// GET /api/orders/availability/:local_id?from=2025-06-01&to=2025-06-07
app.get("/api/orders/availability/:local_id", async (req, res) => {
  try {
    const params = new URLSearchParams(req.query).toString();
    const r = await fetch(`${LOCALES}/api/locales/${req.params.local_id}/availability?${params}`);
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) { res.status(502).json({ error: "Locales no disponible: " + err.message }); }
});

// ══════════════════════════════════════════════════════
// SALE ORDERS
// ══════════════════════════════════════════════════════

// GET /api/orders
app.get("/api/orders", async (req, res) => {
  try {
    const { channel, from, to, limit = 100, status, local_id, delivery_date } = req.query;
    let sql = `
      SELECT o.*, json_agg(json_build_object(
        'id',i.id,'item_type',i.item_type,'sku',i.sku,
        'qty',i.qty,'unit_price',i.unit_price,'subtotal',i.subtotal
      )) AS items
      FROM sale_orders o
      LEFT JOIN order_items i ON o.id = i.order_id
      WHERE 1=1`;
    const params = []; let idx = 1;
    if (channel)       { sql += ` AND o.channel=$${idx++}`;         params.push(channel); }
    if (status)        { sql += ` AND o.status=$${idx++}`;          params.push(status); }
    if (from)          { sql += ` AND o.created_at >= $${idx++}`;   params.push(from); }
    if (to)            { sql += ` AND o.created_at <= $${idx++}`;   params.push(to); }
    if (local_id)      { sql += ` AND o.local_id=$${idx++}`;        params.push(local_id); }
    if (delivery_date) { sql += ` AND o.delivery_date=$${idx++}`;   params.push(delivery_date); }
    sql += ` GROUP BY o.id ORDER BY o.created_at DESC LIMIT $${idx}`;
    params.push(Number(limit));
    const [rows] = await db.query(sql, params);
    res.json({ data: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/orders/summary
app.get("/api/orders/summary", async (req, res) => {
  try {
    const { from, to, local_id } = req.query;
    let sql = `SELECT
      COUNT(*) AS total_orders,
      COALESCE(SUM(total),0) AS total_revenue,
      COALESCE(SUM(shipping_cost),0) AS total_shipping,
      COALESCE(SUM(CASE WHEN channel='shopify' THEN total ELSE 0 END),0) AS shopify_revenue
      FROM sale_orders WHERE 1=1`;
    const params = []; let i = 1;
    if (from)     { sql += ` AND created_at >= $${i++}`; params.push(from); }
    if (to)       { sql += ` AND created_at <= $${i++}`; params.push(to); }
    if (local_id) { sql += ` AND local_id=$${i++}`;      params.push(local_id); }
    const [rows] = await db.query(sql, params);
    res.json({ data: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/orders/:id
app.get("/api/orders/:id", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM sale_orders WHERE id=?", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Orden no encontrada" });
    const [items] = await db.query("SELECT * FROM order_items WHERE order_id=?", [req.params.id]);
    res.json({ data: { ...rows[0], items } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/orders — crear orden manual
app.post("/api/orders", async (req, res) => {
  const client = await db.getConnection();
  try {
    const {
      customer_name, customer_email, customer_phone,
      channel = "manual", items = [], note, recipient_message,

      // Local y almacén
      local_id, local_name, warehouse_id, warehouse_name,

      // Forma de entrega
      delivery_method_id, delivery_method_name, delivery_method_type,

      // Slot
      delivery_date, delivery_slot_id, delivery_slot_from,
      delivery_slot_to, delivery_slot_label,

      // Dirección (si aplica)
      delivery_address_street, delivery_address_city,
      delivery_address_region, delivery_address_zip, delivery_address_notes,

      shipping_cost = 0,
    } = req.body;

    if (!items.length) return res.status(400).json({ error: "La orden necesita al menos un item" });

    await client.query("START TRANSACTION");
    const id = nextOrderId();
    const subtotal = items.reduce((s, i) => s + i.qty * i.unit_price, 0);
    const total    = subtotal + parseFloat(shipping_cost || 0);

    await client.query(`
      INSERT INTO sale_orders (
        id, customer_name, customer_email, customer_phone,
        channel, total, note, recipient_message,
        local_id, local_name, warehouse_id, warehouse_name,
        delivery_method_id, delivery_method_name, delivery_method_type,
        delivery_date, delivery_slot_id, delivery_slot_from, delivery_slot_to, delivery_slot_label,
        delivery_address_street, delivery_address_city, delivery_address_region,
        delivery_address_zip, delivery_address_notes, shipping_cost
      ) VALUES (
        ?,?,?,?,?,?,?,?,
        ?,?,?,?,
        ?,?,?,
        ?,?,?,?,?,
        ?,?,?,?,?,?
      )`,
      [id, customer_name, customer_email, customer_phone,
       channel, total, note, recipient_message,
       local_id || null, local_name || null, warehouse_id || null, warehouse_name || null,
       delivery_method_id || null, delivery_method_name || null, delivery_method_type || null,
       delivery_date || null, delivery_slot_id || null, delivery_slot_from || null,
       delivery_slot_to || null, delivery_slot_label || null,
       delivery_address_street || null, delivery_address_city || null,
       delivery_address_region || null, delivery_address_zip || null,
       delivery_address_notes || null, shipping_cost]
    );

    for (const item of items) {
      await client.query(
        "INSERT INTO order_items (order_id,item_type,sku,qty,unit_price) VALUES (?,?,?,?,?)",
        [id, item.item_type, item.sku, item.qty, item.unit_price]
      );
    }
    await client.query("COMMIT");

    // Descontar stock en WMS (pasando warehouse_id)
    await deductStockForOrder(id, items, warehouse_id);

    mq?.publish("stockflow", "order.created", Buffer.from(JSON.stringify({
      type: "order.created", orderId: id, channel, items,
      local_id, warehouse_id,
      shipping: delivery_method_type === "home_delivery" ? {
        recipient_name:  customer_name,
        phone:           customer_phone,
        email:           customer_email,
        address_street:  delivery_address_street,
        address_city:    delivery_address_city,
        address_region:  delivery_address_region,
        scheduled_date:  delivery_date,
        delivery_window_from: delivery_slot_from,
        delivery_window_to:   delivery_slot_to,
        cost: shipping_cost,
      } : null
    })));

    res.status(201).json({ data: { id, total, items } });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// PUT /api/orders/:id
app.put("/api/orders/:id", async (req, res) => {
  try {
    const { status, note, recipient_message } = req.body;
    const [rows] = await db.query(
      "UPDATE sale_orders SET status=?,note=?,recipient_message=? WHERE id=?",
      [status, note, recipient_message, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Orden no encontrada" });
    res.json({ data: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/orders/:id — cancelar
app.delete("/api/orders/:id", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM sale_orders WHERE id=?", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Orden no encontrada" });
    if (rows[0].status === "cancelled") return res.status(409).json({ error: "Ya cancelada" });
    const [items] = await db.query("SELECT * FROM order_items WHERE order_id=?", [req.params.id]);
    for (const item of items) {
      await fetch(`${WMS}/api/inventory/${item.sku}/stock`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type:"in", qty:item.qty, reference:req.params.id+"_cancel", note:"Cancelación" })
      });
    }
    await db.query("UPDATE sale_orders SET status='cancelled' WHERE id=?", [req.params.id]);
    res.json({ message: "Orden cancelada y stock repuesto" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SHOPIFY WEBHOOK ────────────────────────────
app.post("/api/webhooks/shopify", async (req, res) => {
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  const secret     = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (secret) {
    const digest = crypto.createHmac("sha256",secret).update(req.body).digest("base64");
    if (digest !== hmacHeader) return res.status(401).json({ error:"HMAC inválido" });
  }
  try {
    const shopifyOrder = JSON.parse(req.body.toString());
    const items = shopifyOrder.line_items.map(li => ({
      item_type:"product", sku:li.sku||li.variant_id.toString(),
      qty:li.quantity, unit_price:parseFloat(li.price),
    }));
    const total = parseFloat(shopifyOrder.total_price);
    const id    = nextOrderId();
    await db.query(
      `INSERT INTO sale_orders (id,customer_name,customer_email,channel,external_id,total)
       VALUES (?,?,?,'shopify',?,?)`,
      [id, shopifyOrder.customer?.first_name+" "+shopifyOrder.customer?.last_name,
       shopifyOrder.customer?.email, shopifyOrder.id.toString(), total]
    );
    for (const item of items) {
      await db.query(
        "INSERT INTO order_items (order_id,item_type,sku,qty,unit_price) VALUES (?,?,?,?,?)",
        [id, item.item_type, item.sku, item.qty, item.unit_price]
      );
    }
    await deductStockForOrder(id, items, null);
    mq?.publish("stockflow","order.created",Buffer.from(JSON.stringify({
      type:"order.created",orderId:id,channel:"shopify",items
    })));
    res.status(200).json({ received:true, order_id:id });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── HELPERS ────────────────────────────────────
async function deductStockForOrder(orderId, items, warehouseId) {
  for (const item of items) {
    const url = item.item_type==="kit"
      ? `${WMS}/api/kits/${item.sku}/consume`
      : `${WMS}/api/inventory/${item.sku}/stock`;
    await fetch(url, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify(
        item.item_type==="kit"
          ? { qty:item.qty, reference:orderId, warehouse_id:warehouseId }
          : { type:"out", qty:item.qty, reference:orderId, note:"Venta", warehouse_id:warehouseId }
      )
    });
  }
}

app.get("/health", (req, res) => res.json({ status:"ok", service:"oms" }));

initDB().then(initMQ).then(() => app.listen(PORT, () => console.log(`[OMS] Puerto ${PORT}`)));
