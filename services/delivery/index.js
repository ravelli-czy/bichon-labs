// services/delivery/index.js
// Microservicio de Delivery
// Gestiona envíos, couriers, zonas, etiquetas, tracking público y reagendamiento.

const express  = require("express");
const mysql = require("mysql2/promise");
const amqp     = require("amqplib");
const QRCode   = require("qrcode");
const app      = express();

// Shopify webhook necesita raw body — acá no aplica, todo JSON
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
const PORT = process.env.PORT || 3008;
const BASE_URL = process.env.BASE_URL || "http://localhost:3008";
let   mq;

// ══════════════════════════════════════════════════════
// INIT DB
// ══════════════════════════════════════════════════════
async function initDB() {
  await db.query(`
    -- ─── COURIERS ────────────────────────────────────
    CREATE TABLE IF NOT EXISTS couriers (
      id           VARCHAR(50) PRIMARY KEY,
      name         VARCHAR(200) NOT NULL,
      rut          VARCHAR(20),
      phone        VARCHAR(30),
      email        VARCHAR(200),
      contact_name VARCHAR(200),
      logo_url     TEXT,
      active       TINYINT(1) DEFAULT 1,
      created_at   DATETIME DEFAULT NOW(),
      updated_at   DATETIME DEFAULT NOW()
    );

    -- ─── ZONAS DE COBERTURA ──────────────────────────
    -- Cada courier puede cubrir N zonas (comunas, regiones, etc.)
    CREATE TABLE IF NOT EXISTS courier_zones (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      courier_id  VARCHAR(50) NOT NULL REFERENCES couriers(id) ON DELETE CASCADE,
      zone_name   VARCHAR(200) NOT NULL,   -- "Santiago Centro", "Providencia", etc.
      zone_code   VARCHAR(50),             -- código interno o postal
      delivery_days INTEGER DEFAULT 1,     -- días hábiles estimados en esa zona
      base_cost   DECIMAL(10,2) DEFAULT 0  -- costo base de envío en esa zona
    );

    -- ─── SHIPMENTS (Envíos) ──────────────────────────
    CREATE TABLE IF NOT EXISTS shipments (
      id              VARCHAR(50) PRIMARY KEY,
      order_id        VARCHAR(50) NOT NULL,   -- referencia a OMS
      courier_id      VARCHAR(50) REFERENCES couriers(id),
      tracking_code   VARCHAR(100) UNIQUE,    -- código público de tracking

      -- Datos del destinatario
      recipient_name  VARCHAR(200) NOT NULL,
      recipient_phone VARCHAR(30),
      recipient_email VARCHAR(200),

      -- Dirección
      address_street  VARCHAR(300) NOT NULL,
      address_city    VARCHAR(100) NOT NULL,
      address_region  VARCHAR(100),
      address_zip     VARCHAR(20),
      address_notes   TEXT,               -- "depto 3B, timbre roto"
      zone_name       VARCHAR(200),       -- zona del courier asignada

      -- Fechas
      scheduled_date  DATE NOT NULL,
      delivery_window_from TIME,          -- ej: 10:00
      delivery_window_to   TIME,          -- ej: 14:00
      delivered_at    DATETIME,

      -- Estado
      -- ready → on_the_way → delivered | not_delivered → ready (reagendado)
      status          VARCHAR(30) NOT NULL DEFAULT 'ready',

      -- Costo
      shipping_cost   DECIMAL(10,2) DEFAULT 0,

      -- Etiqueta
      label_config    JSON DEFAULT '{}'::jsonb,  -- config de la etiqueta

      -- Metadatos
      attempts        INTEGER DEFAULT 0,
      notes           TEXT,
      created_at      DATETIME DEFAULT NOW(),
      updated_at      DATETIME DEFAULT NOW()
    );

    -- ─── HISTORIAL DE ESTADOS ────────────────────────
    CREATE TABLE IF NOT EXISTS shipment_history (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      shipment_id  VARCHAR(50) NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
      from_status  VARCHAR(30),
      to_status    VARCHAR(30) NOT NULL,
      note         TEXT,              -- motivo (ej: "Nadie en casa")
      changed_by   VARCHAR(100),      -- usuario o "system"
      created_at   DATETIME DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_shipments_order    ON shipments(order_id);
    CREATE INDEX IF NOT EXISTS idx_shipments_status   ON shipments(status);
    CREATE INDEX IF NOT EXISTS idx_shipments_tracking ON shipments(tracking_code);
    CREATE INDEX IF NOT EXISTS idx_shipments_date     ON shipments(scheduled_date);
    CREATE INDEX IF NOT EXISTS idx_history_shipment   ON shipment_history(shipment_id);
  `);
}

async function initMQ() {
  try {
    const conn = await amqp.connect(process.env.RABBITMQ_URL || "amqp://localhost");
    mq = await conn.createChannel();
    await mq.assertExchange("stockflow", "topic", { durable: true });

    // Escuchar orden creada desde OMS para auto-crear el shipment si tiene dirección
    const q = await mq.assertQueue("delivery_events", { durable: true });
    mq.bindQueue(q.queue, "stockflow", "order.created");
    mq.consume(q.queue, handleOrderCreated, { noAck: false });
    console.log("[Delivery] RabbitMQ conectado");
  } catch (err) {
    console.warn("[Delivery] RabbitMQ no disponible:", err.message);
  }
}

async function handleOrderCreated(msg) {
  if (!msg) return;
  try {
    const event = JSON.parse(msg.content.toString());
    // Si la orden trae datos de envío, crear el shipment automáticamente
    if (event.shipping) {
      await createShipmentFromOrder(event.orderId, event.shipping);
    }
    mq?.ack(msg);
  } catch (err) {
    console.error("[Delivery] Error en evento:", err.message);
    mq?.nack(msg, false, false);
  }
}

// ══════════════════════════════════════════════════════
// UTILS
// ══════════════════════════════════════════════════════
function genId(prefix) {
  return prefix + "-" + Date.now().toString(36).toUpperCase();
}

function genTrackingCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "SF";
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// Máquina de estados del envío
const STATUS_TRANSITIONS = {
  ready:         ["on_the_way"],
  on_the_way:    ["delivered", "not_delivered"],
  not_delivered: ["ready"],   // reagendamiento
  delivered:     [],          // estado final
};

const STATUS_LABELS = {
  ready:         "Listo para enviar",
  on_the_way:    "En camino",
  delivered:     "Entregado",
  not_delivered: "No entregado",
};

function canTransition(from, to) {
  return STATUS_TRANSITIONS[from]?.includes(to) || false;
}

// ══════════════════════════════════════════════════════
// COURIERS
// ══════════════════════════════════════════════════════

// GET /api/delivery/couriers
app.get("/api/delivery/couriers", async (req, res) => {
  try {
    const { active = "true", q } = req.query;
    let sql = "SELECT c.*, json_agg(z.*) FILTER (WHERE z.id IS NOT NULL) AS zones FROM couriers c LEFT JOIN courier_zones z ON c.id = z.courier_id WHERE c.active = ?";
    const params = [active === "true"];
    if (q) { sql += " AND (c.name LIKE ? OR c.contact_name LIKE ?)"; params.push(`%${q}%`); }
    sql += " GROUP BY c.id ORDER BY c.name";
    const [rows] = await db.query(sql, params);
    res.json({ data: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/delivery/couriers/for-zone/:zone — couriers que cubren una zona
app.get("/api/delivery/couriers/for-zone/:zone", async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT c.*, z.delivery_days, z.base_cost, z.zone_name AS matched_zone
      FROM couriers c
      JOIN courier_zones z ON c.id = z.courier_id
      WHERE c.active = true
        AND (z.zone_name LIKE ? OR z.zone_code LIKE ?)
      ORDER BY z.base_cost ASC`,
      [`%${req.params.zone}%`]
    );
    res.json({ data: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/delivery/couriers/:id
app.get("/api/delivery/couriers/:id", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM couriers WHERE id=?", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Courier no encontrado" });
    const [zones] = await db.query("SELECT * FROM courier_zones WHERE courier_id=? ORDER BY zone_name", [req.params.id]);
    const [stats] = await db.query(`
      SELECT COUNT(*) AS total,
             COUNT(CASE WHEN status='delivered' THEN 1 END) AS delivered,
             COUNT(CASE WHEN status='not_delivered' THEN 1 END) AS failed,
             ROUND(AVG(shipping_cost),0) AS avg_cost
      FROM shipments WHERE courier_id=?`, [req.params.id]);
    res.json({ data: { ...rows[0], zones, stats: stats[0] } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/delivery/couriers
app.post("/api/delivery/couriers", async (req, res) => {
  try {
    const { name, rut, phone, email, contact_name, logo_url, zones = [] } = req.body;
    if (!name) return res.status(400).json({ error: "El nombre es obligatorio" });
    const id = genId("COU");
    const client = await db.getConnection();
    await client.query("START TRANSACTION");
    const [rows] = await client.query(
      `INSERT INTO couriers (id,name,rut,phone,email,contact_name,logo_url)
       VALUES (?,?,?,?,?,?,?)`,
      [id, name, rut, phone, email, contact_name, logo_url]
    );
    for (const z of zones) {
      await client.query(
        "INSERT INTO courier_zones (courier_id,zone_name,zone_code,delivery_days,base_cost) VALUES (?,?,?,?,?)",
        [id, z.zone_name, z.zone_code, z.delivery_days || 1, z.base_cost || 0]
      );
    }
    await client.query("COMMIT");
    client.release();
    res.status(201).json({ data: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/delivery/couriers/:id
app.put("/api/delivery/couriers/:id", async (req, res) => {
  try {
    const fields = ["name","rut","phone","email","contact_name","logo_url","active"];
    const updates = []; const params = []; let i = 1;
    fields.forEach(f => { if (req.body[f] !== undefined) { updates.push(`${f}=$${i++}`); params.push(req.body[f]); } });
    if (!updates.length) return res.status(400).json({ error: "Sin campos" });
    updates.push("updated_at=NOW()");
    params.push(req.params.id);
    const [rows] = await db.query(`UPDATE couriers SET ${updates.join(",")} WHERE id=$${i}`, params);
    if (!rows.length) return res.status(404).json({ error: "Courier no encontrado" });
    res.json({ data: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/delivery/couriers/:id/zones — reemplazar zonas
app.put("/api/delivery/couriers/:id/zones", async (req, res) => {
  const client = await db.getConnection();
  try {
    const { zones = [] } = req.body;
    await client.query("START TRANSACTION");
    await client.query("DELETE FROM courier_zones WHERE courier_id=?", [req.params.id]);
    for (const z of zones) {
      await client.query(
        "INSERT INTO courier_zones (courier_id,zone_name,zone_code,delivery_days,base_cost) VALUES (?,?,?,?,?)",
        [req.params.id, z.zone_name, z.zone_code, z.delivery_days || 1, z.base_cost || 0]
      );
    }
    await client.query("COMMIT");
    res.json({ message: "Zonas actualizadas" });
  } catch (err) { await client.query("ROLLBACK"); res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

// DELETE /api/delivery/couriers/:id
app.delete("/api/delivery/couriers/:id", async (req, res) => {
  await db.query("UPDATE couriers SET active=false,updated_at=NOW() WHERE id=?", [req.params.id]);
  res.json({ message: "Courier desactivado" });
});

// ══════════════════════════════════════════════════════
// SHIPMENTS
// ══════════════════════════════════════════════════════

// GET /api/delivery/shipments — listar con filtros
app.get("/api/delivery/shipments", async (req, res) => {
  try {
    const { status, courier_id, date, from, to, limit = 100 } = req.query;
    let sql = `SELECT s.*, c.name AS courier_name, c.phone AS courier_phone
               FROM shipments s LEFT JOIN couriers c ON s.courier_id = c.id WHERE 1=1`;
    const params = []; let i = 1;
    if (status)     { sql += ` AND s.status=$${i++}`;           params.push(status); }
    if (courier_id) { sql += ` AND s.courier_id=$${i++}`;       params.push(courier_id); }
    if (date)       { sql += ` AND s.scheduled_date=$${i++}`;   params.push(date); }
    if (from)       { sql += ` AND s.scheduled_date >= $${i++}`; params.push(from); }
    if (to)         { sql += ` AND s.scheduled_date <= $${i++}`; params.push(to); }
    sql += ` ORDER BY s.scheduled_date ASC, s.created_at DESC LIMIT $${i}`;
    params.push(Number(limit));
    const [rows] = await db.query(sql, params);
    res.json({ data: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/delivery/shipments/summary — métricas para dashboard
app.get("/api/delivery/shipments/summary", async (req, res) => {
  try {
    const { from, to } = req.query;
    let sql = `SELECT
      COUNT(*) AS total,
      COUNT(CASE WHEN status='ready'         THEN 1 END) AS ready,
      COUNT(CASE WHEN status='on_the_way'    THEN 1 END) AS on_the_way,
      COUNT(CASE WHEN status='delivered'     THEN 1 END) AS delivered,
      COUNT(CASE WHEN status='not_delivered' THEN 1 END) AS not_delivered,
      COALESCE(SUM(shipping_cost),0) AS total_shipping_cost,
      ROUND(COUNT(CASE WHEN status='delivered' THEN 1 END)::numeric /
        NULLIF(COUNT(CASE WHEN status IN ('delivered','not_delivered') THEN 1 END),0)*100,1
      ) AS delivery_rate
      FROM shipments WHERE 1=1`;
    const params = []; let i = 1;
    if (from) { sql += ` AND created_at >= $${i++}`; params.push(from); }
    if (to)   { sql += ` AND created_at <= $${i++}`; params.push(to); }
    const [rows] = await db.query(sql, params);
    res.json({ data: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/delivery/shipments/:id
app.get("/api/delivery/shipments/:id", async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT s.*, c.name AS courier_name, c.phone AS courier_phone, c.email AS courier_email
       FROM shipments s LEFT JOIN couriers c ON s.courier_id = c.id WHERE s.id=?`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Envío no encontrado" });
    const [history] = await db.query(
      "SELECT * FROM shipment_history WHERE shipment_id=? ORDER BY created_at ASC",
      [req.params.id]
    );
    res.json({ data: { ...rows[0], history } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/delivery/shipments — crear envío manual
app.post("/api/delivery/shipments", async (req, res) => {
  try {
    const {
      order_id, courier_id,
      recipient_name, recipient_phone, recipient_email,
      address_street, address_city, address_region, address_zip, address_notes, zone_name,
      scheduled_date, delivery_window_from, delivery_window_to,
      shipping_cost = 0, notes, label_config = {}
    } = req.body;

    if (!order_id)        return res.status(400).json({ error: "order_id es obligatorio" });
    if (!recipient_name)  return res.status(400).json({ error: "recipient_name es obligatorio" });
    if (!address_street)  return res.status(400).json({ error: "La dirección es obligatoria" });
    if (!address_city)    return res.status(400).json({ error: "La ciudad es obligatoria" });
    if (!scheduled_date)  return res.status(400).json({ error: "La fecha es obligatoria" });

    const id = genId("SHP");
    const tracking_code = genTrackingCode();

    const [rows] = await db.query(
      `INSERT INTO shipments (
         id, order_id, courier_id, tracking_code,
         recipient_name, recipient_phone, recipient_email,
         address_street, address_city, address_region, address_zip, address_notes, zone_name,
         scheduled_date, delivery_window_from, delivery_window_to,
         shipping_cost, notes, label_config
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, order_id, courier_id || null, tracking_code,
       recipient_name, recipient_phone, recipient_email,
       address_street, address_city, address_region, address_zip, address_notes, zone_name,
       scheduled_date, delivery_window_from || null, delivery_window_to || null,
       shipping_cost, notes, JSON.stringify(label_config)]
    );

    // Registrar en historial
    await db.query(
      "INSERT INTO shipment_history (shipment_id,from_status,to_status,note,changed_by) VALUES (?,NULL,?,?,?)",
      [id, "ready", "Envío creado", "system"]
    );

    // Emitir evento
    mq?.publish("stockflow", "shipment.created", Buffer.from(JSON.stringify({
      type: "shipment.created", shipmentId: id, orderId: order_id, tracking_code
    })));

    res.status(201).json({ data: rows[0], tracking_url: `${BASE_URL}/track/${tracking_code}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/delivery/shipments/:id — actualizar datos del envío (sin cambiar estado)
app.put("/api/delivery/shipments/:id", async (req, res) => {
  try {
    const fields = [
      "courier_id","recipient_name","recipient_phone","recipient_email",
      "address_street","address_city","address_region","address_zip","address_notes","zone_name",
      "scheduled_date","delivery_window_from","delivery_window_to","shipping_cost","notes","label_config"
    ];
    const updates = []; const params = []; let i = 1;
    fields.forEach(f => {
      if (req.body[f] !== undefined) {
        updates.push(`${f}=$${i++}`);
        params.push(f === "label_config" ? JSON.stringify(req.body[f]) : req.body[f]);
      }
    });
    if (!updates.length) return res.status(400).json({ error: "Sin campos" });
    updates.push("updated_at=NOW()");
    params.push(req.params.id);
    const [rows] = await db.query(`UPDATE shipments SET ${updates.join(",")} WHERE id=$${i}`, params);
    if (!rows.length) return res.status(404).json({ error: "Envío no encontrado" });
    res.json({ data: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/delivery/shipments/:id/status — cambiar estado
app.post("/api/delivery/shipments/:id/status", async (req, res) => {
  const client = await db.getConnection();
  try {
    const { status: newStatus, note, changed_by = "system" } = req.body;
    if (!newStatus) return res.status(400).json({ error: "status es obligatorio" });

    await client.query("START TRANSACTION");
    const [rows] = await client.query(
      "SELECT * FROM shipments WHERE id=? FOR UPDATE", [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Envío no encontrado" });

    const current = rows[0];
    if (!canTransition(current.status, newStatus)) {
      return res.status(409).json({
        error: `No se puede pasar de "${STATUS_LABELS[current.status]}" a "${STATUS_LABELS[newStatus]}"`,
        allowed: STATUS_TRANSITIONS[current.status].map(s => ({ status: s, label: STATUS_LABELS[s] }))
      });
    }

    // Actualizar campos especiales según el nuevo estado
    const extraUpdates = [];
    if (newStatus === "on_the_way")    extraUpdates.push("attempts = attempts + 1");
    if (newStatus === "delivered")     extraUpdates.push("delivered_at = NOW()");

    const extraSql = extraUpdates.length ? ", " + extraUpdates.join(", ") : "";
    await client.query(
      `UPDATE shipments SET status=?, updated_at=NOW() ${extraSql} WHERE id=?`,
      [newStatus, req.params.id]
    );

    await client.query(
      "INSERT INTO shipment_history (shipment_id,from_status,to_status,note,changed_by) VALUES (?,?,?,?,?)",
      [req.params.id, current.status, newStatus, note || null, changed_by]
    );

    await client.query("COMMIT");

    // Emitir evento
    mq?.publish("stockflow", `shipment.${newStatus}`, Buffer.from(JSON.stringify({
      type: `shipment.${newStatus}`, shipmentId: req.params.id, orderId: current.order_id
    })));

    res.json({ message: `Estado actualizado a "${STATUS_LABELS[newStatus]}"`, status: newStatus });
  } catch (err) {
    await client.query("ROLLBACK");
    if (!res.headersSent) res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// POST /api/delivery/shipments/:id/reschedule — reagendar (Not Delivered → Ready)
app.post("/api/delivery/shipments/:id/reschedule", async (req, res) => {
  try {
    const { scheduled_date, delivery_window_from, delivery_window_to, note, courier_id } = req.body;
    if (!scheduled_date) return res.status(400).json({ error: "La nueva fecha es obligatoria" });

    const [rows] = await db.query("SELECT * FROM shipments WHERE id=?", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Envío no encontrado" });
    if (rows[0].status !== "not_delivered") {
      return res.status(409).json({ error: "Solo se pueden reagendar envíos con estado 'No entregado'" });
    }

    await db.query(
      `UPDATE shipments SET
         status='ready', scheduled_date=?,
         delivery_window_from=?, delivery_window_to=?,
         courier_id=COALESCE(?,courier_id),
         updated_at=NOW()
       WHERE id=?`,
      [scheduled_date, delivery_window_from || null, delivery_window_to || null, courier_id || null, req.params.id]
    );

    await db.query(
      "INSERT INTO shipment_history (shipment_id,from_status,to_status,note,changed_by) VALUES (?,'not_delivered','ready',?,'user')",
      [req.params.id, note || "Reagendado para " + scheduled_date]
    );

    res.json({ message: "Envío reagendado para " + scheduled_date, status: "ready" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/delivery/shipments/:id — cancelar (solo si está en ready)
app.delete("/api/delivery/shipments/:id", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT status FROM shipments WHERE id=?", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Envío no encontrado" });
    if (!["ready"].includes(rows[0].status)) {
      return res.status(409).json({ error: "Solo se pueden cancelar envíos en estado 'Listo para enviar'" });
    }
    await db.query("DELETE FROM shipments WHERE id=?", [req.params.id]);
    res.json({ message: "Envío cancelado" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// TRACKING PÚBLICO — sin autenticación
// ══════════════════════════════════════════════════════

// GET /track/:code — tracking público para el cliente
app.get("/track/:code", async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT s.id, s.tracking_code, s.status, s.recipient_name,
              s.address_city, s.address_region,
              s.scheduled_date, s.delivery_window_from, s.delivery_window_to,
              s.delivered_at, s.attempts,
              c.name AS courier_name, c.phone AS courier_phone
       FROM shipments s LEFT JOIN couriers c ON s.courier_id = c.id
       WHERE s.tracking_code = ?`,
      [req.params.code]
    );
    if (!rows.length) return res.status(404).json({ error: "Código de rastreo no encontrado" });

    const [history] = await db.query(
      "SELECT to_status, note, created_at FROM shipment_history WHERE shipment_id=? ORDER BY created_at ASC",
      [rows[0].id]
    );

    const ship = rows[0];
    // Generar QR con URL de tracking
    const trackingUrl = `${BASE_URL}/track/${ship.tracking_code}`;
    const qrDataUrl = await QRCode.toDataURL(trackingUrl, { width: 120, margin: 1 });

    res.json({
      data: {
        tracking_code: ship.tracking_code,
        status: ship.status,
        status_label: STATUS_LABELS[ship.status],
        recipient_name: ship.recipient_name,
        destination: [ship.address_city, ship.address_region].filter(Boolean).join(", "),
        scheduled_date: ship.scheduled_date,
        delivery_window: ship.delivery_window_from
          ? `${ship.delivery_window_from} – ${ship.delivery_window_to}`
          : null,
        delivered_at: ship.delivered_at,
        courier_name: ship.courier_name,
        courier_phone: ship.courier_phone,
        attempts: ship.attempts,
        history: history.map(h => ({ status: STATUS_LABELS[h.to_status], note: h.note, date: h.created_at })),
        qr_code: qrDataUrl,
      }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// ETIQUETAS DE ENVÍO
// ══════════════════════════════════════════════════════

// GET /api/delivery/shipments/:id/label — generar etiqueta HTML imprimible
// Query: ?size=A4|A5|10x15  &show_qr=true  &show_logo=true
app.get("/api/delivery/shipments/:id/label", async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT s.*, c.name AS courier_name, c.phone AS courier_phone, c.logo_url AS courier_logo
       FROM shipments s LEFT JOIN couriers c ON s.courier_id = c.id WHERE s.id=?`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Envío no encontrado" });

    const ship = rows[0];
    const config = {
      size:       req.query.size       || ship.label_config?.size       || "10x15",
      show_qr:   (req.query.show_qr   ?? ship.label_config?.show_qr)   !== "false",
      show_logo: (req.query.show_logo  ?? ship.label_config?.show_logo) !== "false",
      show_barcode: (req.query.show_barcode ?? ship.label_config?.show_barcode) !== "false",
      font_size:  req.query.font_size  || ship.label_config?.font_size  || "medium",
      fields: req.query.fields?.split(",") || ship.label_config?.fields || [
        "recipient","address","scheduled_date","window","courier","tracking","order_id"
      ],
    };

    // Dimensiones según tamaño
    const sizes = {
      "10x15": { w: "100mm", h: "150mm" },
      "A4":    { w: "210mm", h: "297mm" },
      "A5":    { w: "148mm", h: "210mm" },
      "4x6":   { w: "4in",   h: "6in"   },
    };
    const dim = sizes[config.size] || sizes["10x15"];

    const trackingUrl = `${BASE_URL}/track/${ship.tracking_code}`;
    const qrDataUrl = config.show_qr
      ? await QRCode.toDataURL(trackingUrl, { width: 150, margin: 1 })
      : null;

    const fontSizes = { small: "10px", medium: "13px", large: "16px" };
    const fs = fontSizes[config.font_size] || "13px";

    const windowStr = ship.delivery_window_from
      ? `${ship.delivery_window_from.slice(0,5)} – ${ship.delivery_window_to?.slice(0,5)}`
      : "Sin definir";

    const fieldsMap = {
      recipient:      `<div class="row"><span class="label">Destinatario</span><span class="val bold">${ship.recipient_name}</span></div>${ship.recipient_phone?`<div class="row"><span class="label">Teléfono</span><span class="val">${ship.recipient_phone}</span></div>`:""}`,
      address:        `<div class="row"><span class="label">Dirección</span><span class="val bold">${ship.address_street}, ${ship.address_city}${ship.address_region?", "+ship.address_region:""}</span></div>${ship.address_notes?`<div class="row"><span class="label">Referencia</span><span class="val">${ship.address_notes}</span></div>`:""}`,
      scheduled_date: `<div class="row"><span class="label">Fecha entrega</span><span class="val bold">${new Date(ship.scheduled_date).toLocaleDateString("es-CL",{day:"2-digit",month:"long",year:"numeric"})}</span></div>`,
      window:         `<div class="row"><span class="label">Horario</span><span class="val">${windowStr}</span></div>`,
      courier:        ship.courier_name ? `<div class="row"><span class="label">Courier</span><span class="val">${ship.courier_name}</span></div>` : "",
      tracking:       `<div class="row"><span class="label">N° Seguimiento</span><span class="val tracking">${ship.tracking_code}</span></div>`,
      order_id:       `<div class="row"><span class="label">Orden</span><span class="val">${ship.order_id}</span></div>`,
      notes:          ship.notes ? `<div class="row"><span class="label">Notas</span><span class="val">${ship.notes}</span></div>` : "",
    };

    const fieldsHtml = config.fields.map(f => fieldsMap[f] || "").join("");

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Etiqueta ${ship.tracking_code}</title>
<style>
  @page { size: ${dim.w} ${dim.h}; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { width: ${dim.w}; height: ${dim.h}; font-family: Arial, Helvetica, sans-serif; font-size: ${fs}; background: #fff; color: #000; padding: 6mm; display: flex; flex-direction: column; }
  .header { display: flex; align-items: center; justify-content: space-between; border-bottom: 2px solid #000; padding-bottom: 4mm; margin-bottom: 4mm; }
  .brand { font-size: 18px; font-weight: 900; letter-spacing: -0.5px; }
  .courier-logo { max-height: 30px; max-width: 80px; object-fit: contain; }
  .status-badge { background: #000; color: #fff; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; }
  .body { flex: 1; display: flex; gap: 4mm; }
  .fields { flex: 1; }
  .row { margin-bottom: 3mm; }
  .label { display: block; font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; color: #666; margin-bottom: 1px; }
  .val { display: block; font-size: ${fs}; line-height: 1.3; }
  .bold { font-weight: bold; }
  .tracking { font-family: monospace; font-size: 15px; font-weight: 900; letter-spacing: 2px; background: #f0f0f0; padding: 2px 6px; border-radius: 3px; }
  .qr-col { display: flex; flex-direction: column; align-items: center; gap: 2mm; flex-shrink: 0; }
  .qr-col img { width: 28mm; height: 28mm; }
  .qr-label { font-size: 8px; text-align: center; color: #666; }
  .divider { border: none; border-top: 1px dashed #ccc; margin: 3mm 0; }
  .footer { border-top: 1px solid #000; padding-top: 3mm; margin-top: auto; font-size: 9px; color: #666; display: flex; justify-content: space-between; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } .no-print { display: none; } }
</style>
</head>
<body>
  <div class="header">
    <div>
      <div class="brand">StockFlow</div>
      ${ship.zone_name ? `<div style="font-size:10px;color:#666">${ship.zone_name}</div>` : ""}
    </div>
    ${config.show_logo && ship.courier_logo ? `<img class="courier-logo" src="${ship.courier_logo}" alt="${ship.courier_name}">` : (ship.courier_name ? `<div style="font-size:11px;font-weight:bold">${ship.courier_name}</div>` : "")}
    <div class="status-badge">Listo para enviar</div>
  </div>

  <div class="body">
    <div class="fields">${fieldsHtml}</div>
    ${qrDataUrl ? `<div class="qr-col"><img src="${qrDataUrl}" alt="QR"><div class="qr-label">Escanea para rastrear</div></div>` : ""}
  </div>

  <div class="footer">
    <span>${new Date().toLocaleDateString("es-CL")} ${new Date().toLocaleTimeString("es-CL",{hour:"2-digit",minute:"2-digit"})}</span>
    <span>${ship.tracking_code}</span>
    <span>${ship.order_id}</span>
  </div>

  <div class="no-print" style="position:fixed;bottom:10px;right:10px;display:flex;gap:8px">
    <button onclick="window.print()" style="padding:8px 16px;background:#000;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold">🖨️ Imprimir</button>
    <button onclick="window.close()" style="padding:8px 16px;background:#eee;border:1px solid #ccc;border-radius:6px;cursor:pointer">Cerrar</button>
  </div>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/delivery/shipments/:id/label-config — guardar configuración de etiqueta
app.put("/api/delivery/shipments/:id/label-config", async (req, res) => {
  try {
    const { label_config } = req.body;
    await db.query("UPDATE shipments SET label_config=?,updated_at=NOW() WHERE id=?", [JSON.stringify(label_config), req.params.id]);
    res.json({ message: "Configuración de etiqueta guardada" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// HISTORIAL de un envío
// ══════════════════════════════════════════════════════
app.get("/api/delivery/shipments/:id/history", async (req, res) => {
  const [rows] = await db.query(
    "SELECT * FROM shipment_history WHERE shipment_id=? ORDER BY created_at ASC", [req.params.id]
  );
  res.json({ data: rows.map(h => ({ ...h, status_label: STATUS_LABELS[h.to_status] })) });
});

// ══════════════════════════════════════════════════════
// HELPER interno para crear shipment desde evento OMS
// ══════════════════════════════════════════════════════
async function createShipmentFromOrder(orderId, shipping) {
  try {
    const id = genId("SHP");
    const tracking_code = genTrackingCode();
    await db.query(
      `INSERT INTO shipments (id,order_id,tracking_code,recipient_name,recipient_phone,recipient_email,
         address_street,address_city,address_region,scheduled_date,shipping_cost)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [id, orderId, tracking_code, shipping.recipient_name, shipping.phone, shipping.email,
       shipping.address_street, shipping.address_city, shipping.address_region,
       shipping.scheduled_date || new Date().toISOString().split("T")[0], shipping.cost || 0]
    );
    await db.query(
      "INSERT INTO shipment_history (shipment_id,from_status,to_status,note,changed_by) VALUES (?,NULL,'ready','Creado automáticamente desde orden','system')",
      [id]
    );
    console.log(`[Delivery] Shipment ${id} creado para orden ${orderId}`);
  } catch (err) {
    console.error("[Delivery] Error auto-creando shipment:", err.message);
  }
}

// ── HEALTH ────────────────────────────────────────────
app.get("/health", (req, res) => res.json({
  status: "ok", service: "delivery",
  status_machine: STATUS_TRANSITIONS
}));

initDB()
  .then(initMQ)
  .then(() => app.listen(PORT, () => console.log(`[Delivery] Puerto ${PORT}`)));

// ══════════════════════════════════════════════════════
// RUTAS DE DESPACHO
// ══════════════════════════════════════════════════════

// GET /api/delivery/routes — listar rutas
app.get("/api/delivery/routes", async (req, res) => {
  const [rows] = await db.query(`
    SELECT r.*, COUNT(rs.shipment_id) AS stop_count,
      COUNT(CASE WHEN s.status='delivered' THEN 1 END) AS delivered_count
    FROM dispatch_routes r
    LEFT JOIN route_shipments rs ON r.id = rs.route_id
    LEFT JOIN shipments s ON rs.shipment_id = s.id
    WHERE r.active = true
    GROUP BY r.id ORDER BY r.route_date DESC
  `);
  res.json({ data: rows });
});

// GET /api/delivery/routes/:id — detalle con paradas ordenadas
app.get("/api/delivery/routes/:id", async (req, res) => {
  const [rows] = await db.query("SELECT * FROM dispatch_routes WHERE id=?", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Ruta no encontrada" });
  const [stops] = await db.query(`
    SELECT rs.seq, rs.id AS route_stop_id, s.*,
           c.name AS courier_name
    FROM route_shipments rs
    JOIN shipments s ON rs.shipment_id = s.id
    LEFT JOIN couriers c ON s.courier_id = c.id
    WHERE rs.route_id = ? ORDER BY rs.seq ASC
  `, [req.params.id]);
  res.json({ data: { ...rows[0], stops } });
});

// POST /api/delivery/routes — crear ruta
app.post("/api/delivery/routes", async (req, res) => {
  const { name, route_date, courier_id, shipment_ids = [] } = req.body;
  if (!name || !route_date) return res.status(400).json({ error: "name y route_date son obligatorios" });
  const id = genId("RTE");
  const client = await db.getConnection();
  try {
    await client.query("START TRANSACTION");
    const [rows] = await client.query(
      "INSERT INTO dispatch_routes (id,name,route_date,courier_id) VALUES (?,?,?,?)",
      [id, name, route_date, courier_id || null]
    );
    for (let i = 0; i < shipment_ids.length; i++) {
      await client.query(
        "INSERT INTO route_shipments (route_id,shipment_id,seq) VALUES (?,?,?)",
        [id, shipment_ids[i], i + 1]
      );
    }
    await client.query("COMMIT");
    res.status(201).json({ data: rows[0] });
  } catch (err) { await client.query("ROLLBACK"); res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

// PUT /api/delivery/routes/:id/reorder — reordenar paradas (drag & drop)
app.put("/api/delivery/routes/:id/reorder", async (req, res) => {
  const { order } = req.body; // [{ shipment_id, seq }]
  if (!Array.isArray(order)) return res.status(400).json({ error: "order debe ser un array" });
  const client = await db.getConnection();
  try {
    await client.query("START TRANSACTION");
    for (const { shipment_id, seq } of order) {
      await client.query(
        "UPDATE route_shipments SET seq=? WHERE route_id=? AND shipment_id=?",
        [seq, req.params.id, shipment_id]
      );
    }
    await client.query("COMMIT");
    res.json({ message: "Ruta reordenada" });
  } catch (err) { await client.query("ROLLBACK"); res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

// POST /api/delivery/shipments/:id/proof — guardar prueba de entrega (GPS + foto)
app.post("/api/delivery/shipments/:id/proof", async (req, res) => {
  try {
    const { gps_lat, gps_lng, gps_accuracy, photo_base64, photo_url, note } = req.body;
    await db.query(`
      UPDATE shipments SET
        delivery_gps_lat=?, delivery_gps_lng=?, delivery_gps_accuracy=?,
        delivery_photo_url=?, updated_at=NOW()
      WHERE id=?`,
      [gps_lat, gps_lng, gps_accuracy, photo_url || null, req.params.id]
    );
    // En prod: subir photo_base64 a S3 y guardar la URL
    res.json({ message: "Prueba de entrega registrada", gps: { lat: gps_lat, lng: gps_lng } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// Nota: Agregar a initDB() las siguientes tablas:
/*
  CREATE TABLE IF NOT EXISTS dispatch_routes (
    id           VARCHAR(50) PRIMARY KEY,
    name         VARCHAR(200) NOT NULL,
    route_date   DATE NOT NULL,
    courier_id   VARCHAR(50) REFERENCES couriers(id),
    active       TINYINT(1) DEFAULT 1,
    created_at   DATETIME DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS route_shipments (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    route_id     VARCHAR(50) NOT NULL REFERENCES dispatch_routes(id) ON DELETE CASCADE,
    shipment_id  VARCHAR(50) NOT NULL REFERENCES shipments(id),
    seq          INTEGER NOT NULL DEFAULT 1,
    UNIQUE(route_id, shipment_id)
  );
  -- Campos adicionales en shipments para prueba de entrega:
  ALTER TABLE shipments ADD COLUMN IF NOT EXISTS delivery_gps_lat  DECIMAL(10,7);
  ALTER TABLE shipments ADD COLUMN IF NOT EXISTS delivery_gps_lng  DECIMAL(10,7);
  ALTER TABLE shipments ADD COLUMN IF NOT EXISTS delivery_gps_accuracy DECIMAL(8,2);
  ALTER TABLE shipments ADD COLUMN IF NOT EXISTS delivery_photo_url TEXT;
*/
