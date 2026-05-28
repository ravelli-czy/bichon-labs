// services/users/index.js — MySQL
const express = require("express");
const mysql   = require("mysql2/promise");
const bcrypt  = require("bcrypt");
const jwt     = require("jsonwebtoken");
const crypto  = require("crypto");
const app = express();
app.use(express.json());

const PORT       = process.env.PORT || 3006;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";
const JWT_EXPIRY = process.env.JWT_EXPIRY  || "7d";

const db = mysql.createPool({
  host: process.env.DB_HOST || "localhost", port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || "root", password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "users_db",
  waitForConnections: true, connectionLimit: 10, timezone: "+00:00",
});

async function initDB() {
  await db.query(`CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    email VARCHAR(200) NOT NULL UNIQUE,
    password_hash VARCHAR(200) NOT NULL,
    name VARCHAR(200), role VARCHAR(30) NOT NULL DEFAULT 'operator',
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT NOW(), last_login DATETIME
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await db.query(`CREATE TABLE IF NOT EXISTS profiles (
    user_id VARCHAR(36) NOT NULL PRIMARY KEY,
    phone VARCHAR(30), whatsapp VARCHAR(30), avatar_url TEXT,
    preferences JSON, notify_email TINYINT(1) DEFAULT 1,
    notify_whatsapp TINYINT(1) DEFAULT 0, notify_app TINYINT(1) DEFAULT 1,
    updated_at DATETIME DEFAULT NOW(),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

const signToken = u => jwt.sign({ id:u.id,email:u.email,name:u.name,role:u.role }, JWT_SECRET, { expiresIn:JWT_EXPIRY });

app.post("/api/auth/register", async (req, res) => {
  const { email, password, name, role="operator" } = req.body;
  if (!email||!password) return res.status(400).json({ error:"email y password obligatorios" });
  try {
    const id   = crypto.randomUUID();
    const hash = await bcrypt.hash(password, 10);
    await db.query("INSERT INTO users (id,email,password_hash,name,role) VALUES (?,?,?,?,?)", [id,email,hash,name,role]);
    await db.query("INSERT INTO profiles (user_id) VALUES (?)", [id]);
    const user = { id,email,name,role };
    res.status(201).json({ data:user, token:signToken(user) });
  } catch(err) {
    if (err.code==="ER_DUP_ENTRY") return res.status(409).json({ error:"Email ya registrado" });
    res.status(500).json({ error:err.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email||!password) return res.status(400).json({ error:"email y password requeridos" });
  const [rows] = await db.query("SELECT * FROM users WHERE email=? AND active=1", [email]);
  if (!rows.length) return res.status(401).json({ error:"Credenciales incorrectas" });
  if (!(await bcrypt.compare(password, rows[0].password_hash))) return res.status(401).json({ error:"Credenciales incorrectas" });
  await db.query("UPDATE users SET last_login=NOW() WHERE id=?", [rows[0].id]);
  const user = { id:rows[0].id, email:rows[0].email, name:rows[0].name, role:rows[0].role };
  res.json({ data:user, token:signToken(user) });
});

app.post("/api/auth/refresh", (req,res) => {
  try { const d=jwt.verify(req.body.token,JWT_SECRET,{ignoreExpiration:true}); res.json({ token:signToken(d) }); }
  catch { res.status(401).json({ error:"Token inválido" }); }
});
app.post("/api/auth/logout", (req,res) => res.json({ message:"Sesión cerrada" }));

app.get("/api/users", async (req,res) => { const [r]=await db.query("SELECT id,email,name,role,active,created_at,last_login FROM users ORDER BY created_at DESC"); res.json({ data:r }); });
app.get("/api/users/:id", async (req,res) => { const [r]=await db.query("SELECT id,email,name,role,active,created_at,last_login FROM users WHERE id=?",[req.params.id]); if(!r.length) return res.status(404).json({ error:"No encontrado" }); res.json({ data:r[0] }); });

app.put("/api/users/:id", async (req,res) => {
  const { name,role,active } = req.body;
  const sets=[]; const p=[];
  if(name!==undefined){sets.push("name=?");p.push(name);}
  if(role!==undefined){sets.push("role=?");p.push(role);}
  if(active!==undefined){sets.push("active=?");p.push(active?1:0);}
  if(!sets.length) return res.status(400).json({ error:"Sin campos" });
  p.push(req.params.id);
  await db.query(`UPDATE users SET ${sets.join(",")} WHERE id=?`,p);
  const [r]=await db.query("SELECT id,email,name,role,active FROM users WHERE id=?",[req.params.id]);
  res.json({ data:r[0] });
});

app.put("/api/users/:id/password", async (req,res) => {
  const { current_password, new_password } = req.body;
  const [r]=await db.query("SELECT * FROM users WHERE id=?",[req.params.id]);
  if(!r.length) return res.status(404).json({ error:"No encontrado" });
  if(!(await bcrypt.compare(current_password,r[0].password_hash))) return res.status(401).json({ error:"Contraseña incorrecta" });
  await db.query("UPDATE users SET password_hash=? WHERE id=?",[await bcrypt.hash(new_password,10),req.params.id]);
  res.json({ message:"Contraseña actualizada" });
});

app.delete("/api/users/:id", async (req,res) => { await db.query("UPDATE users SET active=0 WHERE id=?",[req.params.id]); res.json({ message:"Desactivado" }); });

app.get("/api/profiles/:uid", async (req,res) => { const [r]=await db.query("SELECT * FROM profiles WHERE user_id=?",[req.params.uid]); if(!r.length) return res.status(404).json({ error:"No encontrado" }); res.json({ data:r[0] }); });

app.put("/api/profiles/:uid", async (req,res) => {
  const { phone,whatsapp,preferences,notify_email,notify_whatsapp,notify_app } = req.body;
  const sets=[]; const p=[];
  if(phone!==undefined){sets.push("phone=?");p.push(phone);}
  if(whatsapp!==undefined){sets.push("whatsapp=?");p.push(whatsapp);}
  if(preferences!==undefined){sets.push("preferences=?");p.push(JSON.stringify(preferences));}
  if(notify_email!==undefined){sets.push("notify_email=?");p.push(notify_email?1:0);}
  if(notify_whatsapp!==undefined){sets.push("notify_whatsapp=?");p.push(notify_whatsapp?1:0);}
  if(notify_app!==undefined){sets.push("notify_app=?");p.push(notify_app?1:0);}
  if(!sets.length) return res.status(400).json({ error:"Sin campos" });
  sets.push("updated_at=NOW()"); p.push(req.params.uid);
  await db.query(`UPDATE profiles SET ${sets.join(",")} WHERE user_id=?`,p);
  const [r]=await db.query("SELECT * FROM profiles WHERE user_id=?",[req.params.uid]);
  res.json({ data:r[0] });
});

app.get("/health", (req,res) => res.json({ status:"ok", service:"users", db:"mysql" }));
initDB().then(() => app.listen(PORT, () => console.log(`[Users] Puerto ${PORT} — MySQL`)));
