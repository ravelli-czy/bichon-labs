// api/setup.js — Create tables and optionally seed demo data
// POST /api/setup         → create tables only
// POST /api/setup?seed=1  → create tables + insert demo data
// POST /api/setup?clear=1 → delete all products/kits/orders/shipments for tenant (admin+)

const { getDb } = require('./_db');
const cors = require('./_cors');
const crypto = require('crypto');
const { getSession, resolveTenantId } = require('./_tenant');

const SEED_PRODUCTS = [
  { sku: 'PRD-001', name: 'Cámara IP 1080p',   brand: 'Hikvision', cat: 'Seguridad', tipo: 'ambos',    cost: 45000, price: 79000, stock: 24, threshold: 10 },
  { sku: 'PRD-002', name: 'Cable HDMI 3m',      brand: 'Ugreen',    cat: 'Cables',    tipo: 'ambos',    cost: 3500,  price: 8900,  stock: 8,  threshold: 15 },
  { sku: 'PRD-003', name: 'Fuente poder 12V',   brand: 'Syscom',    cat: 'Accesorios',tipo: 'insumo',   cost: 8200,  price: 0,     stock: 0,  threshold: 10 },
  { sku: 'PRD-004', name: 'Disco duro 1TB',     brand: 'Seagate',   cat: 'Storage',   tipo: 'producto', cost: 38000, price: 62000, stock: 3,  threshold: 5  },
  { sku: 'PRD-005', name: 'Conector BNC',       brand: 'Steren',    cat: 'Cables',    tipo: 'insumo',   cost: 450,   price: 0,     stock: 120,threshold: 30 },
  { sku: 'PRD-006', name: 'Croissant',          brand: 'Artesanal', cat: 'Alimentos', tipo: 'insumo',   cost: 800,   price: 0,     stock: 15, threshold: 5  },
  { sku: 'PRD-007', name: 'Jugo naranja 500ml', brand: 'Artesanal', cat: 'Bebidas',   tipo: 'insumo',   cost: 600,   price: 0,     stock: 12, threshold: 5  },
  { sku: 'PRD-008', name: 'Café espresso',      brand: 'Artesanal', cat: 'Bebidas',   tipo: 'insumo',   cost: 400,   price: 0,     stock: 20, threshold: 8  },
];

const SEED_KITS = [
  {
    sku: 'KIT-001', name: 'Kit Seguridad Básico', price: 139000,
    items: [{ sku: 'PRD-001', qty: 1 }, { sku: 'PRD-002', qty: 1 }, { sku: 'PRD-003', qty: 1 }],
  },
  {
    sku: 'KIT-002', name: 'Desayuno Ejecutivo', price: 4900,
    items: [{ sku: 'PRD-006', qty: 1 }, { sku: 'PRD-007', qty: 1 }, { sku: 'PRD-008', qty: 1 }],
  },
];

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let sql;
  try {
    sql = getDb();
  } catch (err) {
    return res.status(503).json({ error: err.message });
  }

  // ── CLEAR DATA — borrar todos los datos del tenant (admin+) ──────────────
  if (req.query?.clear === '1') {
    const session  = await getSession(req);
    const tenantId = resolveTenantId(req, session);
    if (!session || !['admin','superadmin','master'].includes(session.role)) {
      return res.status(403).json({ error: 'Solo administradores pueden borrar datos' });
    }
    if (!tenantId) {
      return res.status(400).json({ error: 'Sin contexto de cliente' });
    }
    try {
      await sql`DELETE FROM shipments WHERE tenant_id = ${tenantId}`;
      await sql`DELETE FROM orders     WHERE tenant_id = ${tenantId}`;
      await sql`DELETE FROM kits       WHERE tenant_id = ${tenantId}`;
      await sql`DELETE FROM products   WHERE tenant_id = ${tenantId}`;
      return res.json({ ok: true, message: 'Datos eliminados: productos, kits, órdenes, envíos' });
    } catch (clearErr) {
      console.error('[setup/clear] error:', clearErr);
      return res.status(500).json({ error: clearErr.message });
    }
  }

  try {
    // ── Create tables ───────────────────────────────────────────────────────

    // Tenants table (must exist first — referenced by all data tables)
    await sql`
      CREATE TABLE IF NOT EXISTS tenants (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        slug        TEXT NOT NULL UNIQUE,
        logo_url    TEXT DEFAULT '',
        logo_text   TEXT DEFAULT '',
        color       TEXT DEFAULT '#5b4fff',
        plan        TEXT DEFAULT 'starter',
        status      TEXT DEFAULT 'active',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        created_by  TEXT DEFAULT ''
      )
    `;
    await sql`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}'`;

    await sql`
      CREATE TABLE IF NOT EXISTS products (
        sku         TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        brand       TEXT NOT NULL DEFAULT 'Sin marca',
        cat         TEXT NOT NULL DEFAULT 'General',
        tipo        TEXT NOT NULL DEFAULT 'producto',
        cost        INTEGER NOT NULL DEFAULT 0,
        price       INTEGER NOT NULL DEFAULT 0,
        stock       INTEGER NOT NULL DEFAULT 0,
        threshold   INTEGER NOT NULL DEFAULT 10,
        created_by  TEXT DEFAULT '',
        updated_by  TEXT DEFAULT '',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS created_by   TEXT DEFAULT ''`;
    await sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS updated_by   TEXT DEFAULT ''`;
    await sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS tenant_id    TEXT NOT NULL DEFAULT 'TEN-001'`;
    await sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS warehouse_id TEXT NOT NULL DEFAULT ''`;
    await sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode      TEXT DEFAULT ''`;
    await sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS groups       JSONB NOT NULL DEFAULT '[]'`;
    // Migrate PK from global sku → composite (sku, warehouse_id, tenant_id)
    try {
      await sql`ALTER TABLE products DROP CONSTRAINT IF EXISTS products_pkey CASCADE`;
      await sql`ALTER TABLE products ADD PRIMARY KEY (sku, warehouse_id, tenant_id)`;
    } catch (pkErr) {
      console.log('[setup] Products PK migration skipped:', pkErr.message);
    }

    await sql`
      CREATE TABLE IF NOT EXISTS kits (
        sku         TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        price       INTEGER NOT NULL DEFAULT 0,
        items       JSONB NOT NULL DEFAULT '[]',
        created_by  TEXT DEFAULT '',
        updated_by  TEXT DEFAULT '',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`ALTER TABLE kits ADD COLUMN IF NOT EXISTS created_by  TEXT DEFAULT ''`;
    await sql`ALTER TABLE kits ADD COLUMN IF NOT EXISTS updated_by  TEXT DEFAULT ''`;
    await sql`ALTER TABLE kits ADD COLUMN IF NOT EXISTS tenant_id   TEXT NOT NULL DEFAULT 'TEN-001'`;
    await sql`ALTER TABLE kits ADD COLUMN IF NOT EXISTS warehouse_id TEXT NOT NULL DEFAULT ''`;
    // Grupos de Productos que determinan el stock/disponibilidad del KIT.
    // Vacío ([]) = comportamiento actual: todos los componentes cuentan.
    await sql`ALTER TABLE kits ADD COLUMN IF NOT EXISTS stock_group_ids JSONB NOT NULL DEFAULT '[]'`;
    // Migrate kits PK → (sku, warehouse_id, tenant_id) — warehouse variants share master SKU
    try {
      await sql`ALTER TABLE kits DROP CONSTRAINT IF EXISTS kits_pkey CASCADE`;
      await sql`ALTER TABLE kits ADD PRIMARY KEY (sku, warehouse_id, tenant_id)`;
    } catch (pkKitErr) {
      console.log('[setup] Kits PK migration skipped:', pkKitErr.message);
    }

    // Grupo de Productos — agrupación transversal de productos, id correlativo
    // asignado por la plataforma. Base para futuras funcionalidades (pesables,
    // alto valor, etc) y para configurar qué componentes determinan el stock de un KIT.
    await sql`
      CREATE TABLE IF NOT EXISTS product_groups (
        id          SERIAL PRIMARY KEY,
        tenant_id   TEXT NOT NULL DEFAULT 'TEN-001',
        name        TEXT NOT NULL,
        created_by  TEXT DEFAULT '',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (tenant_id, name)
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS orders (
        id          TEXT PRIMARY KEY,
        cliente     TEXT NOT NULL DEFAULT 'Cliente',
        telefono    TEXT DEFAULT '',
        total       INTEGER NOT NULL DEFAULT 0,
        fecha       TEXT NOT NULL,
        items       JSONB NOT NULL DEFAULT '[]',
        delivery    JSONB NOT NULL DEFAULT '{}',
        dedicatoria TEXT DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'pending',
        created_by  TEXT DEFAULT '',
        updated_by  TEXT DEFAULT '',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_by  TEXT DEFAULT ''`;
    await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_by  TEXT DEFAULT ''`;
    await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ DEFAULT NOW()`;
    await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tenant_id   TEXT NOT NULL DEFAULT 'TEN-001'`;

    await sql`
      CREATE TABLE IF NOT EXISTS purchases (
        id          TEXT PRIMARY KEY,
        supplier    TEXT DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'pending',
        items       JSONB NOT NULL DEFAULT '[]',
        total       INTEGER NOT NULL DEFAULT 0,
        notes       TEXT DEFAULT '',
        fecha       TEXT NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS suppliers (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        contact     TEXT DEFAULT '',
        phone       TEXT DEFAULT '',
        email       TEXT DEFAULT '',
        notes       TEXT DEFAULT '',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS shipments (
        id                    TEXT PRIMARY KEY,
        order_id              TEXT,
        courier_id            TEXT DEFAULT '',
        tracking_code         TEXT NOT NULL,
        recipient_name        TEXT NOT NULL DEFAULT '',
        recipient_phone       TEXT DEFAULT '',
        address_street        TEXT DEFAULT '',
        address_city          TEXT DEFAULT '',
        address_region        TEXT DEFAULT '',
        address_notes         TEXT DEFAULT '',
        scheduled_date        TEXT DEFAULT '',
        delivery_window_from  TEXT DEFAULT '',
        delivery_window_to    TEXT DEFAULT '',
        delivery_method_type  TEXT DEFAULT '',
        delivery_method_label TEXT DEFAULT '',
        status                TEXT NOT NULL DEFAULT 'ready',
        shipping_cost         INTEGER DEFAULT 0,
        attempts              INTEGER DEFAULT 0,
        notes                 TEXT DEFAULT '',
        history               JSONB DEFAULT '[]',
        created_by            TEXT DEFAULT '',
        updated_by            TEXT DEFAULT '',
        created_at            TIMESTAMPTZ DEFAULT NOW(),
        updated_at            TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`ALTER TABLE shipments ADD COLUMN IF NOT EXISTS created_by  TEXT DEFAULT ''`;
    await sql`ALTER TABLE shipments ADD COLUMN IF NOT EXISTS updated_by  TEXT DEFAULT ''`;
    await sql`ALTER TABLE shipments ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ DEFAULT NOW()`;
    await sql`ALTER TABLE shipments ADD COLUMN IF NOT EXISTS tenant_id   TEXT NOT NULL DEFAULT 'TEN-001'`;

    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id                    TEXT PRIMARY KEY,
        username              TEXT NOT NULL UNIQUE,
        email                 TEXT DEFAULT '',
        display_name          TEXT DEFAULT '',
        password_hash         TEXT NOT NULL,
        role                  TEXT NOT NULL DEFAULT 'staff',
        status                TEXT NOT NULL DEFAULT 'active',
        reset_token           TEXT,
        reset_token_expires   TIMESTAMPTZ,
        created_at            TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    // Migrate existing users table: add columns if they don't exist
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT DEFAULT ''`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS status     TEXT NOT NULL DEFAULT 'active'`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_id  TEXT NOT NULL DEFAULT ''`;

    await sql`
      CREATE TABLE IF NOT EXISTS sessions (
        token       TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL,
        username    TEXT NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id           TEXT PRIMARY KEY,
        tenant_id    TEXT NOT NULL DEFAULT 'TEN-001',
        actor        TEXT NOT NULL DEFAULT 'sistema',
        action       TEXT NOT NULL,
        entity_type  TEXT NOT NULL DEFAULT '',
        entity_id    TEXT DEFAULT '',
        entity_name  TEXT DEFAULT '',
        details      JSONB DEFAULT '{}',
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs (created_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS audit_logs_entity_type_idx ON audit_logs (entity_type)`;
    await sql`CREATE INDEX IF NOT EXISTS audit_logs_actor_idx ON audit_logs (actor)`;
    await sql`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'TEN-001'`;
    await sql`CREATE INDEX IF NOT EXISTS audit_logs_tenant_idx ON audit_logs (tenant_id)`;

    // API Keys table
    await sql`
      CREATE TABLE IF NOT EXISTS api_keys (
        id               TEXT PRIMARY KEY,
        tenant_id        TEXT NOT NULL,
        user_id          TEXT NOT NULL,
        name             TEXT NOT NULL DEFAULT 'API Key',
        key_id           TEXT NOT NULL UNIQUE,
        key_secret_hash  TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'active',
        last_used_at     TIMESTAMPTZ,
        created_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS api_keys_key_id_idx  ON api_keys (key_id)`;
    await sql`CREATE INDEX IF NOT EXISTS api_keys_tenant_idx  ON api_keys (tenant_id)`;
    await sql`CREATE INDEX IF NOT EXISTS api_keys_user_idx    ON api_keys (user_id)`;

    const created = ['tenants', 'products', 'kits', 'product_groups', 'orders', 'purchases', 'suppliers', 'shipments', 'users', 'sessions', 'audit_logs', 'api_keys'];

    // Always ensure superadmin user exists
    const [{ ucount }] = await sql`SELECT COUNT(*) AS ucount FROM users WHERE username = 'admin'`;
    if (parseInt(ucount) === 0) {
      const hash = crypto.createHash('sha256').update('StockFlow2026!').digest('hex');
      await sql`
        INSERT INTO users (id, username, password_hash, role, tenant_id)
        VALUES ('USR-001', 'admin', ${hash}, 'superadmin', '')
        ON CONFLICT (username) DO NOTHING
      `;
    }

    // ── Multi-tenancy migration ─────────────────────────────────────────────
    // Create default tenant for existing data
    await sql`
      INSERT INTO tenants (id, name, slug, logo_text, created_by)
      VALUES ('TEN-001', 'Cliente Demo', 'cliente-demo', 'CD', 'sistema')
      ON CONFLICT (id) DO NOTHING
    `;

    // Promote existing admin → superadmin (no tenant)
    await sql`UPDATE users SET role = 'superadmin', tenant_id = '' WHERE username = 'admin' AND role = 'admin'`;

    // Assign non-superadmin users without tenant to TEN-001
    await sql`UPDATE users SET tenant_id = 'TEN-001' WHERE tenant_id = '' AND role != 'superadmin'`;

    // Assign orphan data to TEN-001
    await sql`UPDATE products  SET tenant_id = 'TEN-001' WHERE tenant_id = ''`;
    await sql`UPDATE kits       SET tenant_id = 'TEN-001' WHERE tenant_id = ''`;
    await sql`UPDATE orders     SET tenant_id = 'TEN-001' WHERE tenant_id = ''`;
    await sql`UPDATE shipments  SET tenant_id = 'TEN-001' WHERE tenant_id = ''`;
    await sql`UPDATE audit_logs SET tenant_id = 'TEN-001' WHERE tenant_id = ''`;

    // ── Optional seeding ─────────────────────────────────────────────────────
    const doSeed = req.query?.seed === '1' || req.body?.seed === true;
    let seeded = false;

    if (doSeed) {
      // Only seed if tables are empty
      const [{ count }] = await sql`SELECT COUNT(*) as count FROM products`;
      if (parseInt(count) === 0) {
        for (const p of SEED_PRODUCTS) {
          await sql`
            INSERT INTO products (sku, name, brand, cat, tipo, cost, price, stock, threshold)
            VALUES (${p.sku}, ${p.name}, ${p.brand}, ${p.cat}, ${p.tipo}, ${p.cost}, ${p.price}, ${p.stock}, ${p.threshold})
            ON CONFLICT (sku) DO NOTHING
          `;
        }
        for (const k of SEED_KITS) {
          await sql`
            INSERT INTO kits (sku, name, price, items)
            VALUES (${k.sku}, ${k.name}, ${k.price}, ${JSON.stringify(k.items)})
            ON CONFLICT DO NOTHING
          `;
        }
        seeded = true;
      }
    }

    return res.json({
      ok: true,
      tables: created,
      seeded,
      message: seeded
        ? 'Tables created and seeded with demo data'
        : 'Tables created (or already existed)',
    });
  } catch (err) {
    console.error('Setup error:', err);
    return res.status(500).json({ error: err.message });
  }
};
