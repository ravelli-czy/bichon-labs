// services/wms/index.js
// Microservicio WMS — inventario, stock, movimientos y KITs.
// Emite eventos a RabbitMQ cuando el stock baja de umbral.

const express = require("express");
const { Pool }   = require("mysql2/promise");
const amqp       = require("amqplib");
const app        = express();
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
const PORT = process.env.PORT || 3002;
let   mq;   // canal RabbitMQ

// ─── INIT ──────────────────────────────────────
async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS inventory (
      sku           VARCHAR(50) PRIMARY KEY,
      stock         INTEGER NOT NULL DEFAULT 0,
      threshold     INTEGER NOT NULL DEFAULT 10,   -- umbral alerta
      reserved      INTEGER NOT NULL DEFAULT 0,    -- reservado por órdenes pendientes
      location      VARCHAR(100),                  -- ubicación en bodega (opcional)
      updated_at    DATETIME DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS movements (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      sku           VARCHAR(50) NOT NULL,
      type          VARCHAR(10) NOT NULL CHECK (type IN ('in','out','adjust')),
      qty           INTEGER NOT NULL,
      stock_before  INTEGER NOT NULL,
      stock_after   INTEGER NOT NULL,
      reference     VARCHAR(100),   -- ID de ÓC, venta, etc.
      note          TEXT,
      created_at    DATETIME DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS kits (
      sku       VARCHAR(50) PRIMARY KEY,
      name      VARCHAR(200) NOT NULL,
      sku_ref   VARCHAR(50),   -- SKU en catálogo
      active    TINYINT(1) DEFAULT 1,
      created_at DATETIME DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS kit_components (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      kit_sku     VARCHAR(50) NOT NULL REFERENCES kits(sku) ON DELETE CASCADE,
      product_sku VARCHAR(50) NOT NULL,
      qty         INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      sku         VARCHAR(50) NOT NULL,
      triggered_at DATETIME DEFAULT NOW(),
      resolved_at  DATETIME,
      stock_at_trigger INTEGER,
      notified    TINYINT(1) DEFAULT 0
    );
  `);
}

async function initMQ() {
  try {
    const conn = await amqp.connect(process.env.RABBITMQ_URL || "amqp://localhost");
    mq = await conn.createChannel();
    await mq.assertExchange("stockflow", "topic", { durable: true });
    // Escuchar eventos de OMS y Purchases
    const q = await mq.assertQueue("wms_events", { durable: true });
    mq.bindQueue(q.queue, "stockflow", "order.created");
    mq.bindQueue(q.queue, "stockflow", "purchase.received");
    mq.consume(q.queue, handleExternalEvent, { noAck: false });
    console.log("[WMS] RabbitMQ conectado");
  } catch (err) {
    console.warn("[WMS] RabbitMQ no disponible, sin mensajería:", err.message);
  }
}

async function handleExternalEvent(msg) {
  if (!msg) return;
  const event = JSON.parse(msg.content.toString());
  if (event.type === "order.created") {
    // El OMS ya descuenta, pero podemos verificar alertas
    for (const item of event.items || []) {
      await checkAlertThreshold(item.sku);
    }
  }
  if (event.type === "purchase.received") {
    for (const item of event.items || []) {
      const inv = await db.query("SELECT stock,threshold FROM inventory WHERE sku=?",[item.sku]);
      if(inv.rows[0]?.stock > inv.rows[0]?.threshold) await resolveAlert(item.sku);
    }
  }
  mq?.ack(msg);
}

// ══════════════════════════════════════════
// INVENTORY
// ══════════════════════════════════════════

// GET /api/inventory — listar todo el inventario con filtros
app.get("/api/inventory", async (req, res) => {
  try {
    const { low_stock, q } = req.query;
    let sql = "SELECT * FROM inventory";
    const params = [];
    if (low_stock === "true") sql += " WHERE stock <= threshold";
    if (q) {
      sql += (low_stock === "true" ? " AND" : " WHERE") + " sku LIKE ?";
      params.push(`%${q}%`);
    }
    sql += " ORDER BY sku";
    const [rows] = await db.query(sql, params);
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/inventory/:sku
app.get("/api/inventory/:sku", async (req, res) => {
  const [rows] = await db.query("SELECT * FROM inventory WHERE sku=?",[req.params.sku]);
  if (!rows.length) return res.status(404).json({ error: "SKU no encontrado" });
  res.json({ data: rows[0] });
});

// POST /api/inventory — crear registro de inventario para un SKU
app.post("/api/inventory", async (req, res) => {
  try {
    const { sku, stock = 0, threshold = 10, location } = req.body;
    if (!sku) return res.status(400).json({ error: "sku obligatorio" });
    const [rows] = await db.query(
      `INSERT INTO inventory (sku, stock, threshold, location)
       VALUES (?,?,?,?)
       ON CONFLICT (sku) DO UPDATE SET threshold=?, location=?`,
      [sku, stock, threshold, location]
    );
    if (stock > 0) await recordMovement(sku, "in", stock, 0, stock, "stock_inicial");
    await checkAlertThreshold(sku);
    res.status(201).json({ data: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/inventory/:sku/threshold — actualizar umbral de alerta
app.put("/api/inventory/:sku/threshold", async (req, res) => {
  const { threshold } = req.body;
  if (!threshold) return res.status(400).json({ error: "threshold obligatorio" });
  const [rows] = await db.query(
    "UPDATE inventory SET threshold=?, updated_at=NOW() WHERE sku=?",
    [threshold, req.params.sku]
  );
  if (!rows.length) return res.status(404).json({ error: "SKU no encontrado" });
  await checkAlertThreshold(req.params.sku);
  res.json({ data: rows[0] });
});

// POST /api/inventory/:sku/stock — ajustar stock (in, out, adjust)
app.post("/api/inventory/:sku/stock", async (req, res) => {
  const client = await db.getConnection();
  try {
    await client.query("START TRANSACTION");
    const { type, qty, reference, note } = req.body;
    if (!["in","out","adjust"].includes(type)) return res.status(400).json({ error: "type debe ser in | out | adjust" });
    if (!qty || qty <= 0) return res.status(400).json({ error: "qty debe ser > 0" });

    const cur = await client.query("SELECT stock FROM inventory WHERE sku=? FOR UPDATE",[req.params.sku]);
    if (!cur.rows.length) return res.status(404).json({ error: "SKU no encontrado" });

    const before = cur.rows[0].stock;
    let after;
    if (type === "in")     after = before + qty;
    else if (type === "out") after = Math.max(0, before - qty);
    else                   after = qty;

    await client.query(
      "UPDATE inventory SET stock=?, updated_at=NOW() WHERE sku=?",
      [after, req.params.sku]
    );
    await recordMovementTx(client, req.params.sku, type, qty, before, after, reference, note);
    await client.query("COMMIT");

    await checkAlertThreshold(req.params.sku);
    res.json({ data: { sku: req.params.sku, stock_before: before, stock_after: after, type } });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/inventory/:sku — eliminar registro (solo si stock = 0)
app.delete("/api/inventory/:sku", async (req, res) => {
  const [rows] = await db.query("SELECT stock FROM inventory WHERE sku=?",[req.params.sku]);
  if (!rows.length) return res.status(404).json({ error: "SKU no encontrado" });
  if (rows[0].stock > 0) return res.status(409).json({ error: "No se puede eliminar con stock > 0" });
  await db.query("DELETE FROM inventory WHERE sku=?",[req.params.sku]);
  res.json({ message: "Eliminado" });
});

// ══════════════════════════════════════════
// MOVEMENTS
// ══════════════════════════════════════════

// GET /api/movements — historial completo con filtros
app.get("/api/movements", async (req, res) => {
  const { sku, type, from, to, limit = 100 } = req.query;
  let sql = "SELECT * FROM movements WHERE 1=1";
  const params = [];
  let i = 1;
  if (sku)  { sql += ` AND sku=$${i++}`;                      params.push(sku); }
  if (type) { sql += ` AND type=$${i++}`;                     params.push(type); }
  if (from) { sql += ` AND created_at >= $${i++}`;            params.push(from); }
  if (to)   { sql += ` AND created_at <= $${i++}`;            params.push(to); }
  sql += ` ORDER BY created_at DESC LIMIT $${i}`;
  params.push(Number(limit));
  const [rows] = await db.query(sql, params);
  res.json({ data: rows });
});

// GET /api/movements/:sku — historial de un producto
app.get("/api/movements/:sku", async (req, res) => {
  const [rows] = await db.query(
    "SELECT * FROM movements WHERE sku=? ORDER BY created_at DESC LIMIT 200",
    [req.params.sku]
  );
  res.json({ data: rows });
});

// ══════════════════════════════════════════
// KITS
// ══════════════════════════════════════════

// GET /api/kits — listar KITs con stock calculado
app.get("/api/kits", async (req, res) => {
  try {
    const [kits] = await db.query("SELECT * FROM kits WHERE active=true ORDER BY name");
    const result = await Promise.all(kits.map(async (kit) => {
      const [comps] = await db.query(
        "SELECT * FROM kit_components WHERE kit_sku=?", [kit.sku]
      );
      let available = Infinity;
      for (const c of comps) {
        const inv = await db.query("SELECT stock FROM inventory WHERE sku=?",[c.product_sku]);
        const stock = inv.rows[0]?.stock || 0;
        available = Math.min(available, Math.floor(stock / c.qty));
      }
      return { ...kit, components: comps, available_stock: comps.length ? available : 0 };
    }));
    res.json({ data: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/kits/:sku — detalle de un KIT
app.get("/api/kits/:sku", async (req, res) => {
  const [rows] = await db.query("SELECT * FROM kits WHERE sku=?",[req.params.sku]);
  if (!rows.length) return res.status(404).json({ error: "KIT no encontrado" });
  const [comps] = await db.query(
    "SELECT * FROM kit_components WHERE kit_sku=?",[req.params.sku]
  );
  res.json({ data: { ...rows[0], components: comps } });
});

// POST /api/kits — crear KIT
app.post("/api/kits", async (req, res) => {
  const client = await db.getConnection();
  try {
    const { sku, name, components = [] } = req.body;
    if (!sku || !name) return res.status(400).json({ error: "sku y name son obligatorios" });
    if (!components.length) return res.status(400).json({ error: "El KIT necesita al menos un componente" });

    await client.query("START TRANSACTION");
    const [rows] = await client.query(
      "INSERT INTO kits (sku,name) VALUES (?,?)",[sku,name]
    );
    for (const c of components) {
      await client.query(
        "INSERT INTO kit_components (kit_sku,product_sku,qty) VALUES (?,?,?)",
        [sku, c.product_sku, c.qty]
      );
    }
    await client.query("COMMIT");
    res.status(201).json({ data: rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PUT /api/kits/:sku — actualizar KIT (reemplaza componentes)
app.put("/api/kits/:sku", async (req, res) => {
  const client = await db.getConnection();
  try {
    const { name, components, active } = req.body;
    await client.query("START TRANSACTION");
    const updates = []; const params = []; let i = 1;
    if (name)   { updates.push(`name=$${i++}`);   params.push(name); }
    if (active !== undefined) { updates.push(`active=$${i++}`); params.push(active); }
    if (updates.length) {
      params.push(req.params.sku);
      await client.query(`UPDATE kits SET ${updates.join(",")} WHERE sku=$${i}`, params);
    }
    if (components) {
      await client.query("DELETE FROM kit_components WHERE kit_sku=?",[req.params.sku]);
      for (const c of components) {
        await client.query(
          "INSERT INTO kit_components (kit_sku,product_sku,qty) VALUES (?,?,?)",
          [req.params.sku, c.product_sku, c.qty]
        );
      }
    }
    await client.query("COMMIT");
    res.json({ message: "KIT actualizado" });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/kits/:sku — desactivar KIT
app.delete("/api/kits/:sku", async (req, res) => {
  await db.query("UPDATE kits SET active=false WHERE sku=?",[req.params.sku]);
  res.json({ message: "KIT desactivado" });
});

// POST /api/kits/:sku/consume — consumir stock del KIT (usado por OMS)
app.post("/api/kits/:sku/consume", async (req, res) => {
  const { qty = 1, reference } = req.body;
  const client = await db.getConnection();
  try {
    await client.query("START TRANSACTION");
    const [comps] = await db.query(
      "SELECT * FROM kit_components WHERE kit_sku=?",[req.params.sku]
    );
    const results = [];
    for (const c of comps) {
      const totalQty = c.qty * qty;
      const cur = await client.query("SELECT stock FROM inventory WHERE sku=? FOR UPDATE",[c.product_sku]);
      const before = cur.rows[0]?.stock || 0;
      const after  = Math.max(0, before - totalQty);
      await client.query("UPDATE inventory SET stock=?,updated_at=NOW() WHERE sku=?",[after,c.product_sku]);
      await recordMovementTx(client,c.product_sku,"out",totalQty,before,after,reference,"Venta KIT "+req.params.sku);
      results.push({ sku: c.product_sku, before, after });
    }
    await client.query("COMMIT");
    for (const c of comps) await checkAlertThreshold(c.product_sku);
    res.json({ data: results });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ══════════════════════════════════════════
// ALERTS
// ══════════════════════════════════════════

// GET /api/inventory/alerts — alertas activas
app.get("/api/inventory/alerts", async (req, res) => {
  const [rows] = await db.query(`
    SELECT a.*, i.stock, i.threshold
    FROM alerts a JOIN inventory i ON a.sku=i.sku
    WHERE a.resolved_at IS NULL ORDER BY a.triggered_at DESC
  `);
  res.json({ data: rows });
});

// ─── HELPERS ───────────────────────────────────
async function recordMovement(sku, type, qty, before, after, reference, note) {
  await db.query(
    "INSERT INTO movements (sku,type,qty,stock_before,stock_after,reference,note) VALUES (?,?,?,?,?,?,?)",
    [sku, type, qty, before, after, reference, note]
  );
}
async function recordMovementTx(client, sku, type, qty, before, after, reference, note) {
  await client.query(
    "INSERT INTO movements (sku,type,qty,stock_before,stock_after,reference,note) VALUES (?,?,?,?,?,?,?)",
    [sku, type, qty, before, after, reference, note]
  );
}

async function checkAlertThreshold(sku) {
  const inv = await db.query("SELECT stock,threshold FROM inventory WHERE sku=?",[sku]);
  if (!inv.rows.length) return;
  const { stock, threshold } = inv.rows[0];
  if (stock <= threshold) {
    // Crear alerta si no existe una activa
    const ex = await db.query("SELECT id FROM alerts WHERE sku=? AND resolved_at IS NULL",[sku]);
    if (!ex.rows.length) {
      await db.query(
        "INSERT INTO alerts (sku,stock_at_trigger) VALUES (?,?)",
        [sku, stock]
      );
      // Emitir evento para que Notifications envíe WhatsApp/Email
      mq?.publish("stockflow", "stock.low", Buffer.from(JSON.stringify({ sku, stock, threshold })));
    }
  }
}

async function resolveAlert(sku) {
  await db.query(
    "UPDATE alerts SET resolved_at=NOW() WHERE sku=? AND resolved_at IS NULL",
    [sku]
  );
}

app.get("/health", (req, res) => res.json({ status: "ok", service: "wms" }));

initDB()
  .then(initMQ)
  .then(() => app.listen(PORT, () => console.log(`[WMS] Puerto ${PORT}`)));
