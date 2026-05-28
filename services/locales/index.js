// services/locales/index.js
// Microservicio de Locales
// Gestiona tiendas, almacenes, formas de entrega y slots horarios.
//
// Modelo de datos:
//   Local (tienda) → N Almacenes → inventario propio por almacén
//   Local → N Formas de Entrega → N Slots por día de semana
//   Orden → 1 Local + 1 Almacén + 1 Forma de entrega + fecha + slot

const express  = require("express");
const mysql = require("mysql2/promise");
const app      = express();
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
const PORT = process.env.PORT || 3009;

// ══════════════════════════════════════════════════════
// INIT DB
// ══════════════════════════════════════════════════════
async function initDB() {
  await db.query(`

    -- ─── LOCALES (tiendas / puntos de despacho) ──────
    CREATE TABLE IF NOT EXISTS locales (
      id            VARCHAR(50) PRIMARY KEY,
      name          VARCHAR(200) NOT NULL,
      -- Dirección completa (punto de partida de rutas)
      address_street  VARCHAR(300) NOT NULL,
      address_city    VARCHAR(100) NOT NULL,
      address_region  VARCHAR(100),
      address_zip     VARCHAR(20),
      address_lat     DECIMAL(10,7),   -- para el mapa de rutas
      address_lng     DECIMAL(10,7),
      -- Contacto
      phone           VARCHAR(30),
      email           VARCHAR(200),
      -- Config
      timezone        VARCHAR(60) DEFAULT 'America/Santiago',
      currency        VARCHAR(10) DEFAULT 'CLP',
      active          TINYINT(1) DEFAULT 1,
      created_at      DATETIME DEFAULT NOW(),
      updated_at      DATETIME DEFAULT NOW()
    );

    -- ─── ALMACENES (N por local) ──────────────────────
    -- Cada almacén tiene su propio inventario (vía WMS con warehouse_id)
    CREATE TABLE IF NOT EXISTS warehouses (
      id            VARCHAR(50) PRIMARY KEY,
      local_id      VARCHAR(50) NOT NULL REFERENCES locales(id) ON DELETE CASCADE,
      name          VARCHAR(200) NOT NULL,    -- "Bodega Principal", "Refrigerados"
      description   TEXT,
      active        TINYINT(1) DEFAULT 1,
      created_at    DATETIME DEFAULT NOW()
    );

    -- ─── FORMAS DE ENTREGA ────────────────────────────
    -- Cada local puede tener múltiples formas de entrega
    CREATE TABLE IF NOT EXISTS delivery_methods (
      id              VARCHAR(50) PRIMARY KEY,
      local_id        VARCHAR(50) NOT NULL REFERENCES locales(id) ON DELETE CASCADE,
      name            VARCHAR(200) NOT NULL,   -- "Despacho a domicilio", "Retiro en tienda"
      type            VARCHAR(30)  NOT NULL,   -- home_delivery | store_pickup | pickup_point
      description     TEXT,
      -- Config logística
      requires_address TINYINT(1) DEFAULT 1,   -- false para retiro en tienda
      max_distance_km  DECIMAL(8,2),           -- NULL = sin límite
      base_cost        DECIMAL(10,2) DEFAULT 0,
      free_above       DECIMAL(12,2),          -- envío gratis sobre este monto
      -- Ventana de preparación
      prep_hours       INTEGER DEFAULT 2,      -- horas de anticipación mínima para agendar
      -- Estado
      active           TINYINT(1) DEFAULT 1,
      created_at       DATETIME DEFAULT NOW(),
      updated_at       DATETIME DEFAULT NOW()
    );

    -- ─── SLOTS DE ENTREGA ─────────────────────────────
    -- Configurables por día de semana (0=Dom, 1=Lun ... 6=Sáb)
    CREATE TABLE IF NOT EXISTS delivery_slots (
      id                  INT AUTO_INCREMENT PRIMARY KEY,
      delivery_method_id  VARCHAR(50) NOT NULL REFERENCES delivery_methods(id) ON DELETE CASCADE,
      day_of_week         INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
      -- Ventana horaria del slot
      time_from           TIME NOT NULL,
      time_to             TIME NOT NULL,
      label               VARCHAR(100),        -- "Mañana", "Tarde", "Noche" (opcional, se genera si es NULL)
      -- Capacidad
      max_orders          INTEGER DEFAULT 999, -- NULL = ilimitado
      -- Costo adicional del slot (ej: express tiene sobrecosto)
      extra_cost          DECIMAL(10,2) DEFAULT 0,
      -- Activo
      active              TINYINT(1) DEFAULT 1
    );

    -- ─── DISPONIBILIDAD BLOQUEADA ─────────────────────
    -- Para bloquear slots específicos en fechas concretas (feriados, etc.)
    CREATE TABLE IF NOT EXISTS slot_blocks (
      id                  INT AUTO_INCREMENT PRIMARY KEY,
      delivery_method_id  VARCHAR(50) NOT NULL REFERENCES delivery_methods(id) ON DELETE CASCADE,
      blocked_date        DATE NOT NULL,
      day_of_week         INTEGER,
      reason              TEXT,
      created_at          DATETIME DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_warehouses_local    ON warehouses(local_id);
    CREATE INDEX IF NOT EXISTS idx_dm_local            ON delivery_methods(local_id);
    CREATE INDEX IF NOT EXISTS idx_slots_method        ON delivery_slots(delivery_method_id);
    CREATE INDEX IF NOT EXISTS idx_slots_dow           ON delivery_slots(day_of_week);
  `);
}

// ══════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════
function genId(prefix) {
  return prefix + "-" + Date.now().toString(36).toUpperCase();
}

const DOW_NAMES = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];

// Genera el label automático del slot si no se proveyó
function autoLabel(timeFrom, timeTo) {
  const h = parseInt(timeFrom.split(":")[0]);
  if (h < 12) return "Mañana";
  if (h < 17) return "Tarde";
  return "Noche";
}

// ══════════════════════════════════════════════════════
// LOCALES
// ══════════════════════════════════════════════════════

// GET /api/locales — listar con conteo de almacenes y métodos
app.get("/api/locales", async (req, res) => {
  try {
    const { active = "true" } = req.query;
    const [rows] = await db.query(`
      SELECT l.*,
        (SELECT COUNT(*) FROM warehouses w WHERE w.local_id = l.id AND w.active = true) AS warehouse_count,
        (SELECT COUNT(*) FROM delivery_methods dm WHERE dm.local_id = l.id AND dm.active = true) AS delivery_method_count
      FROM locales l
      WHERE l.active = ?
      ORDER BY l.name ASC`,
      [active === "true"]
    );
    res.json({ data: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/locales/:id — detalle completo con almacenes y métodos
app.get("/api/locales/:id", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM locales WHERE id = ?", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Local no encontrado" });

    const [warehouses] = await db.query(
      "SELECT * FROM warehouses WHERE local_id = ? AND active = true ORDER BY name",
      [req.params.id]
    );
    const [methods] = await db.query(
      "SELECT * FROM delivery_methods WHERE local_id = ? AND active = true ORDER BY name",
      [req.params.id]
    );

    // Para cada método, cargar sus slots agrupados por día
    const methodsWithSlots = await Promise.all(methods.map(async (m) => {
      const [slots] = await db.query(
        "SELECT * FROM delivery_slots WHERE delivery_method_id = ? AND active = true ORDER BY day_of_week, time_from",
        [m.id]
      );
      const slotsByDay = {};
      for (let d = 0; d <= 6; d++) {
        slotsByDay[d] = {
          day_name: DOW_NAMES[d],
          slots: slots.filter(s => s.day_of_week === d).map(s => ({
            ...s,
            label: s.label || autoLabel(s.time_from, s.time_to),
          }))
        };
      }
      return { ...m, slots_by_day: slotsByDay };
    }));

    res.json({ data: { ...rows[0], warehouses, delivery_methods: methodsWithSlots } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/locales
app.post("/api/locales", async (req, res) => {
  try {
    const {
      name, address_street, address_city, address_region, address_zip,
      address_lat, address_lng, phone, email, timezone, currency
    } = req.body;
    if (!name || !address_street || !address_city) {
      return res.status(400).json({ error: "name, address_street y address_city son obligatorios" });
    }
    const id = genId("LOC");
    const [rows] = await db.query(
      `INSERT INTO locales (id,name,address_street,address_city,address_region,address_zip,
        address_lat,address_lng,phone,email,timezone,currency)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, name, address_street, address_city, address_region, address_zip,
       address_lat, address_lng, phone, email, timezone || "America/Santiago", currency || "CLP"]
    );
    res.status(201).json({ data: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/locales/:id
app.put("/api/locales/:id", async (req, res) => {
  try {
    const fields = ["name","address_street","address_city","address_region","address_zip",
                    "address_lat","address_lng","phone","email","timezone","currency","active"];
    const updates = []; const params = []; let i = 1;
    fields.forEach(f => { if (req.body[f] !== undefined) { updates.push(`${f}=$${i++}`); params.push(req.body[f]); } });
    if (!updates.length) return res.status(400).json({ error: "Sin campos" });
    updates.push("updated_at=NOW()");
    params.push(req.params.id);
    const [rows] = await db.query(
      `UPDATE locales SET ${updates.join(",")} WHERE id=$${i}`, params
    );
    if (!rows.length) return res.status(404).json({ error: "Local no encontrado" });
    res.json({ data: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/locales/:id
app.delete("/api/locales/:id", async (req, res) => {
  await db.query("UPDATE locales SET active=false,updated_at=NOW() WHERE id=?", [req.params.id]);
  res.json({ message: "Local desactivado" });
});

// ══════════════════════════════════════════════════════
// ALMACENES
// ══════════════════════════════════════════════════════

// GET /api/locales/:local_id/warehouses
app.get("/api/locales/:local_id/warehouses", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT * FROM warehouses WHERE local_id=? AND active=true ORDER BY name",
      [req.params.local_id]
    );
    res.json({ data: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/locales/:local_id/warehouses/:id
app.get("/api/locales/:local_id/warehouses/:id", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT * FROM warehouses WHERE id=? AND local_id=?",
      [req.params.id, req.params.local_id]
    );
    if (!rows.length) return res.status(404).json({ error: "Almacén no encontrado" });
    res.json({ data: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/locales/:local_id/warehouses
app.post("/api/locales/:local_id/warehouses", async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: "El nombre es obligatorio" });
    // Verificar que el local existe
    const [loc] = await db.query("SELECT id FROM locales WHERE id=?", [req.params.local_id]);
    if (!loc.length) return res.status(404).json({ error: "Local no encontrado" });
    const id = genId("WHS");
    const [rows] = await db.query(
      "INSERT INTO warehouses (id,local_id,name,description) VALUES (?,?,?,?)",
      [id, req.params.local_id, name, description]
    );
    res.status(201).json({ data: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/locales/:local_id/warehouses/:id
app.put("/api/locales/:local_id/warehouses/:id", async (req, res) => {
  try {
    const { name, description, active } = req.body;
    const updates = []; const params = []; let i = 1;
    if (name        !== undefined) { updates.push(`name=$${i++}`);        params.push(name); }
    if (description !== undefined) { updates.push(`description=$${i++}`); params.push(description); }
    if (active      !== undefined) { updates.push(`active=$${i++}`);      params.push(active); }
    if (!updates.length) return res.status(400).json({ error: "Sin campos" });
    params.push(req.params.id, req.params.local_id);
    const [rows] = await db.query(
      `UPDATE warehouses SET ${updates.join(",")} WHERE id=$${i} AND local_id=$${i+1}`, params
    );
    if (!rows.length) return res.status(404).json({ error: "Almacén no encontrado" });
    res.json({ data: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/locales/:local_id/warehouses/:id
app.delete("/api/locales/:local_id/warehouses/:id", async (req, res) => {
  await db.query(
    "UPDATE warehouses SET active=false WHERE id=? AND local_id=?",
    [req.params.id, req.params.local_id]
  );
  res.json({ message: "Almacén desactivado" });
});

// ══════════════════════════════════════════════════════
// FORMAS DE ENTREGA
// ══════════════════════════════════════════════════════

// GET /api/locales/:local_id/delivery-methods
app.get("/api/locales/:local_id/delivery-methods", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT * FROM delivery_methods WHERE local_id=? AND active=true ORDER BY name",
      [req.params.local_id]
    );
    // Agregar slots a cada método
    const result = await Promise.all(rows.map(async (m) => {
      const [slots] = await db.query(
        "SELECT * FROM delivery_slots WHERE delivery_method_id=? AND active=true ORDER BY day_of_week,time_from",
        [m.id]
      );
      return { ...m, slots };
    }));
    res.json({ data: result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/locales/:local_id/delivery-methods/:id
app.get("/api/locales/:local_id/delivery-methods/:id", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT * FROM delivery_methods WHERE id=? AND local_id=?",
      [req.params.id, req.params.local_id]
    );
    if (!rows.length) return res.status(404).json({ error: "Forma de entrega no encontrada" });
    const [slots] = await db.query(
      "SELECT * FROM delivery_slots WHERE delivery_method_id=? ORDER BY day_of_week,time_from",
      [req.params.id]
    );
    // Agrupar slots por día
    const slotsByDay = {};
    for (let d = 0; d <= 6; d++) {
      slotsByDay[d] = {
        day_name: DOW_NAMES[d],
        slots: slots.filter(s => s.day_of_week === d).map(s => ({
          ...s, label: s.label || autoLabel(s.time_from, s.time_to)
        }))
      };
    }
    res.json({ data: { ...rows[0], slots_by_day: slotsByDay } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/locales/:local_id/delivery-methods
app.post("/api/locales/:local_id/delivery-methods", async (req, res) => {
  try {
    const {
      name, type = "home_delivery", description,
      requires_address = true, max_distance_km, base_cost = 0,
      free_above, prep_hours = 2
    } = req.body;
    if (!name) return res.status(400).json({ error: "El nombre es obligatorio" });
    if (!["home_delivery","store_pickup","pickup_point"].includes(type)) {
      return res.status(400).json({ error: "type debe ser home_delivery | store_pickup | pickup_point" });
    }
    const id = genId("DLM");
    const [rows] = await db.query(
      `INSERT INTO delivery_methods (id,local_id,name,type,description,requires_address,
        max_distance_km,base_cost,free_above,prep_hours)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, req.params.local_id, name, type, description, requires_address,
       max_distance_km || null, base_cost, free_above || null, prep_hours]
    );
    res.status(201).json({ data: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/locales/:local_id/delivery-methods/:id
app.put("/api/locales/:local_id/delivery-methods/:id", async (req, res) => {
  try {
    const fields = ["name","description","requires_address","max_distance_km",
                    "base_cost","free_above","prep_hours","active"];
    const updates = []; const params = []; let i = 1;
    fields.forEach(f => { if (req.body[f] !== undefined) { updates.push(`${f}=$${i++}`); params.push(req.body[f]); } });
    if (!updates.length) return res.status(400).json({ error: "Sin campos" });
    updates.push("updated_at=NOW()");
    params.push(req.params.id, req.params.local_id);
    const [rows] = await db.query(
      `UPDATE delivery_methods SET ${updates.join(",")} WHERE id=$${i} AND local_id=$${i+1}`, params
    );
    if (!rows.length) return res.status(404).json({ error: "Forma de entrega no encontrada" });
    res.json({ data: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/locales/:local_id/delivery-methods/:id
app.delete("/api/locales/:local_id/delivery-methods/:id", async (req, res) => {
  await db.query(
    "UPDATE delivery_methods SET active=false,updated_at=NOW() WHERE id=? AND local_id=?",
    [req.params.id, req.params.local_id]
  );
  res.json({ message: "Forma de entrega desactivada" });
});

// ══════════════════════════════════════════════════════
// SLOTS DE ENTREGA
// ══════════════════════════════════════════════════════

// GET /api/locales/:local_id/delivery-methods/:method_id/slots
app.get("/api/locales/:local_id/delivery-methods/:method_id/slots", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT * FROM delivery_slots WHERE delivery_method_id=? ORDER BY day_of_week,time_from",
      [req.params.method_id]
    );
    const slotsByDay = {};
    for (let d = 0; d <= 6; d++) {
      slotsByDay[d] = {
        day_name: DOW_NAMES[d],
        slots: rows.filter(s => s.day_of_week === d).map(s => ({
          ...s, label: s.label || autoLabel(s.time_from, s.time_to)
        }))
      };
    }
    res.json({ data: slotsByDay });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/locales/:local_id/delivery-methods/:method_id/slots
// Crea o reemplaza slots para un método — acepta array de slots
app.post("/api/locales/:local_id/delivery-methods/:method_id/slots", async (req, res) => {
  const client = await db.getConnection();
  try {
    const { slots = [], replace_day } = req.body;
    // replace_day: si se pasa, borra primero los slots de ese día antes de insertar
    await client.query("START TRANSACTION");
    if (replace_day !== undefined) {
      await client.query(
        "DELETE FROM delivery_slots WHERE delivery_method_id=? AND day_of_week=?",
        [req.params.method_id, replace_day]
      );
    }
    const created = [];
    for (const slot of slots) {
      const [rows] = await client.query(
        `INSERT INTO delivery_slots
           (delivery_method_id, day_of_week, time_from, time_to, label, max_orders, extra_cost)
         VALUES (?,?,?,?,?,?,?)`,
        [req.params.method_id, slot.day_of_week, slot.time_from, slot.time_to,
         slot.label || null, slot.max_orders || 999, slot.extra_cost || 0]
      );
      created.push(rows[0]);
    }
    await client.query("COMMIT");
    res.status(201).json({ data: created });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// PUT /api/locales/:local_id/delivery-methods/:method_id/slots/:slot_id
app.put("/api/locales/:local_id/delivery-methods/:method_id/slots/:slot_id", async (req, res) => {
  try {
    const fields = ["day_of_week","time_from","time_to","label","max_orders","extra_cost","active"];
    const updates = []; const params = []; let i = 1;
    fields.forEach(f => { if (req.body[f] !== undefined) { updates.push(`${f}=$${i++}`); params.push(req.body[f]); } });
    if (!updates.length) return res.status(400).json({ error: "Sin campos" });
    params.push(req.params.slot_id, req.params.method_id);
    const [rows] = await db.query(
      `UPDATE delivery_slots SET ${updates.join(",")} WHERE id=$${i} AND delivery_method_id=$${i+1}`, params
    );
    if (!rows.length) return res.status(404).json({ error: "Slot no encontrado" });
    res.json({ data: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/locales/:local_id/delivery-methods/:method_id/slots/:slot_id
app.delete("/api/locales/:local_id/delivery-methods/:method_id/slots/:slot_id", async (req, res) => {
  await db.query("DELETE FROM delivery_slots WHERE id=? AND delivery_method_id=?",
    [req.params.slot_id, req.params.method_id]);
  res.json({ message: "Slot eliminado" });
});

// ══════════════════════════════════════════════════════
// DISPONIBILIDAD — endpoint clave para el OMS
// ══════════════════════════════════════════════════════
// GET /api/locales/:local_id/availability?from=2025-06-01&to=2025-06-07
// Retorna todos los slots disponibles en el rango de fechas dado,
// descartando días bloqueados y considerando prep_hours.

app.get("/api/locales/:local_id/availability", async (req, res) => {
  try {
    const { from, to, method_id } = req.query;
    if (!from || !to) return res.status(400).json({ error: "from y to son obligatorios (YYYY-MM-DD)" });

    // Obtener métodos activos del local
    let methodsQuery = "SELECT * FROM delivery_methods WHERE local_id=? AND active=true";
    const methodsParams = [req.params.local_id];
    if (method_id) { methodsQuery += " AND id=?"; methodsParams.push(method_id); }
    const [methods] = await db.query(methodsQuery, methodsParams);

    // Fechas en el rango
    const dates = [];
    let d = new Date(from + "T00:00:00");
    const end = new Date(to + "T00:00:00");
    while (d <= end) {
      dates.push(new Date(d));
      d.setDate(d.getDate() + 1);
    }

    // Bloques activos en el período
    const [blocks] = await db.query(
      "SELECT * FROM slot_blocks WHERE blocked_date BETWEEN ? AND ?",
      [from, to]
    );
    const blockedDates = new Set(blocks.map(b => b.blocked_date.toISOString().split("T")[0]));

    const availability = [];

    for (const method of methods) {
      const [slots] = await db.query(
        "SELECT * FROM delivery_slots WHERE delivery_method_id=? AND active=true ORDER BY day_of_week,time_from",
        [method.id]
      );

      const methodDates = [];
      for (const date of dates) {
        const dateStr  = date.toISOString().split("T")[0];
        const dow      = date.getDay(); // 0=Dom..6=Sáb
        if (blockedDates.has(dateStr)) continue;

        const daySlots = slots
          .filter(s => s.day_of_week === dow)
          .map(s => ({
            slot_id:    s.id,
            time_from:  s.time_from,
            time_to:    s.time_to,
            label:      s.label || autoLabel(s.time_from, s.time_to),
            max_orders: s.max_orders,
            extra_cost: parseFloat(s.extra_cost) || 0,
          }));

        if (daySlots.length) {
          methodDates.push({ date: dateStr, day_name: DOW_NAMES[dow], slots: daySlots });
        }
      }

      if (methodDates.length) {
        availability.push({
          method_id:        method.id,
          method_name:      method.name,
          method_type:      method.type,
          base_cost:        parseFloat(method.base_cost) || 0,
          free_above:       method.free_above ? parseFloat(method.free_above) : null,
          requires_address: method.requires_address,
          dates:            methodDates,
        });
      }
    }

    res.json({ data: availability });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// BLOQUEOS DE SLOTS
// ══════════════════════════════════════════════════════

// POST /api/locales/:local_id/delivery-methods/:method_id/blocks
app.post("/api/locales/:local_id/delivery-methods/:method_id/blocks", async (req, res) => {
  try {
    const { blocked_date, reason } = req.body;
    if (!blocked_date) return res.status(400).json({ error: "blocked_date es obligatorio" });
    const d = new Date(blocked_date);
    const [rows] = await db.query(
      "INSERT INTO slot_blocks (delivery_method_id,blocked_date,day_of_week,reason) VALUES (?,?,?,?)",
      [req.params.method_id, blocked_date, d.getDay(), reason || null]
    );
    res.status(201).json({ data: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/locales/:local_id/delivery-methods/:method_id/blocks/:block_id
app.delete("/api/locales/:local_id/delivery-methods/:method_id/blocks/:block_id", async (req, res) => {
  await db.query("DELETE FROM slot_blocks WHERE id=? AND delivery_method_id=?",
    [req.params.block_id, req.params.method_id]);
  res.json({ message: "Bloqueo eliminado" });
});

// ── HEALTH ────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok", service: "locales" }));

initDB().then(() => app.listen(PORT, () => console.log(`[Locales] Puerto ${PORT}`)));
