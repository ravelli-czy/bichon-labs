// api/setup.js — Create tables and optionally seed demo data
// POST /api/setup         → create tables only
// POST /api/setup?seed=1  → create tables + insert demo data
// POST /api/setup?clear=1 → delete all products/kits/orders/shipments for tenant (admin+)

const { getDb } = require('./_db');
const cors = require('./_cors');
const crypto = require('crypto');
const { getSession, resolveTenantId } = require('./_tenant');
const { seedDefaultCategories } = require('./_finance');

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
    await sql`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS color2 TEXT DEFAULT '#16c98d'`;
    await sql`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS color3 TEXT DEFAULT '#4c3fff'`;

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
    // Unidad en la que se lleva el stock (ej: "lámina", "ml", "unidad") y su
    // equivalencia opcional con la unidad en que se compra (ej: 1 "paquete" =
    // 16 "lámina"), para poder cargar stock convirtiendo automáticamente.
    await sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_unit      TEXT NOT NULL DEFAULT 'unidad'`;
    await sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS purchase_unit   TEXT NOT NULL DEFAULT ''`;
    await sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS purchase_factor INTEGER NOT NULL DEFAULT 1`;
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
    // 'producto' (Venta) | 'insumo' — filtro Kit de Venta vs Kit de Insumo en Inventario
    await sql`ALTER TABLE kits ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'producto'`;
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

    // Templates de etiqueta/tarjeta (item 8): etiqueta adhesiva, huincha de
    // sellado, tarjeta de instrucciones de producto. Se seleccionan (no se
    // crean al vuelo) al crear una venta y se imprimen desde la orden.
    await sql`
      CREATE TABLE IF NOT EXISTS label_templates (
        id          TEXT PRIMARY KEY,
        tenant_id   TEXT NOT NULL DEFAULT 'TEN-001',
        type        TEXT NOT NULL DEFAULT 'etiqueta',
        name        TEXT NOT NULL,
        image_url   TEXT DEFAULT '',
        font        TEXT DEFAULT 'Nunito',
        width_mm    NUMERIC,
        height_mm   NUMERIC,
        auto_size   BOOLEAN NOT NULL DEFAULT true,
        paper_type  TEXT NOT NULL DEFAULT 'adhesivo',
        content_text TEXT DEFAULT '',
        active      BOOLEAN NOT NULL DEFAULT true,
        created_by  TEXT DEFAULT '',
        updated_by  TEXT DEFAULT '',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS label_templates_tenant_idx ON label_templates (tenant_id)`;

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
    await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_by     TEXT DEFAULT ''`;
    await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_by     TEXT DEFAULT ''`;
    await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ DEFAULT NOW()`;
    await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tenant_id      TEXT NOT NULL DEFAULT 'TEN-001'`;
    await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT ''`;
    await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS sales_channel  TEXT DEFAULT ''`;
    // Pre Compra: 'normal' (default, creada desde la app o por una API que no
    // manda el flag) | 'pre_compra' (creada por un sistema tercero vía API
    // con order_type:'pre_compra' — ver api/orders.js). Una pre_compra nace
    // con status 'por_confirmar' en vez de 'por_hacer'; al confirmarla pasa
    // a 'por_hacer' y sigue el flujo normal. order_type queda tal cual para
    // siempre (no se re-normaliza al confirmar), es solo el origen.
    await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_type     TEXT NOT NULL DEFAULT 'normal'`;

    // ── Finanzas: columnas financieras de la orden ────────────────────────
    // discount_amount / refund_amount reducen el ingreso neto (ver
    // api/_finance.js). delivered_at es la fecha real en que la orden pasó a
    // 'entregada' — se usa para reconocer el ingreso en el período correcto,
    // en vez de la fecha de creación (created_at) o el string legado `fecha`.
    // location_id resuelve el local/sucursal para poder filtrar por
    // sucursal en Finanzas — órdenes antiguas o sin almacén asociado
    // quedan con '' (sin sucursal conocida), nunca se inventa un valor.
    // tax_amount queda NULL/reservado: StockFlow no separa IVA todavía (ver
    // _finance.js) — cuando exista esa info, se puede popular sin migrar nada.
    await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount INTEGER NOT NULL DEFAULT 0`;
    // discount_pct: columna legacy del descuento manual por % (reemplazado
    // por Cupones — ver api/_coupons.js). Ya no se escribe desde la app;
    // queda sin migrar hacia atrás para no romper filas históricas.
    await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_pct    NUMERIC NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_amount   INTEGER NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at    TIMESTAMPTZ`;
    await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS location_id     TEXT NOT NULL DEFAULT ''`;
    await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_amount      INTEGER`;
    // Templates de etiqueta elegidos para esta orden (item 8) — { etiqueta,
    // huincha_sellado, tarjeta_instrucciones } con el id de label_templates o null.
    await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS label_selections JSONB NOT NULL DEFAULT '{}'`;
    // Cupón aplicado a esta orden (opcional) — coupon_id referencia la fila
    // viva en `coupons` (para liberar el uso si se edita/elimina la orden);
    // coupon_code es un snapshot del código al momento de aplicarlo, para
    // mostrarlo en la orden aunque el cupón se edite o elimine después.
    await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_id       TEXT`;
    await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_code     TEXT DEFAULT ''`;
    await sql`CREATE INDEX IF NOT EXISTS orders_tenant_status_idx    ON orders (tenant_id, status)`;
    await sql`CREATE INDEX IF NOT EXISTS orders_delivered_at_idx     ON orders (delivered_at)`;
    await sql`CREATE INDEX IF NOT EXISTS orders_tenant_delivered_idx ON orders (tenant_id, delivered_at)`;
    await sql`CREATE INDEX IF NOT EXISTS orders_location_idx         ON orders (location_id)`;

    // Backfill: órdenes que YA estaban en 'entregada' antes de que existiera
    // esta columna nunca dispararon el código que la setea (sólo corre en
    // transiciones nuevas hacia 'entregada', ver api/orders/[id].js), así que
    // quedarían con delivered_at NULL para siempre y serían invisibles en
    // Finanzas (que filtra por delivered_at IS NOT NULL). No existe una fecha
    // de entrega histórica real que rescatar, así que se usa `updated_at`
    // como mejor estimación disponible (se actualiza en cada cambio de
    // estado, incluida la transición a 'entregada') — es una aproximación,
    // no un dato inventado. Idempotente: sólo toca filas con delivered_at NULL.
    await sql`
      UPDATE orders SET delivered_at = updated_at
      WHERE status = 'entregada' AND delivered_at IS NULL
    `;

    // ── Cupones ─────────────────────────────────────────────────────────────
    // discount_type: 'percentage' | 'fixed'. used_count/max_uses controlan el
    // límite de usos — ver claimCoupon/releaseCoupon en api/_coupons.js para
    // el reclamo/liberación atómica al crear/editar/eliminar una orden.
    await sql`
      CREATE TABLE IF NOT EXISTS coupons (
        id             TEXT PRIMARY KEY,
        tenant_id      TEXT NOT NULL DEFAULT 'TEN-001',
        code           TEXT NOT NULL,
        discount_type  TEXT NOT NULL DEFAULT 'percentage',
        discount_value NUMERIC NOT NULL DEFAULT 0,
        max_uses       INTEGER NOT NULL DEFAULT 1,
        used_count     INTEGER NOT NULL DEFAULT 0,
        active         BOOLEAN NOT NULL DEFAULT TRUE,
        created_by     TEXT DEFAULT '',
        created_at     TIMESTAMPTZ DEFAULT NOW(),
        updated_at     TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (tenant_id, code)
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS coupons_tenant_idx ON coupons (tenant_id)`;

    // ── Alertas de stock: configuración (una fila por tenant) + historial de
    // corridas generadas por el cron (ver api/_stock_alerts.js). weekday/
    // month_day sólo se usan según frequency ('semanal'/'mensual' —
    // 'quincenal' son fechas fijas de calendario, no necesita día propio).
    // last_run_date evita que el tenant reciba dos corridas el mismo día si
    // el cron llegara a dispararse más de una vez.
    await sql`
      CREATE TABLE IF NOT EXISTS stock_alert_settings (
        tenant_id     TEXT PRIMARY KEY,
        frequency     TEXT NOT NULL DEFAULT 'semanal',
        weekday       INTEGER,
        month_day     INTEGER,
        channel_home  BOOLEAN NOT NULL DEFAULT TRUE,
        channel_email BOOLEAN NOT NULL DEFAULT FALSE,
        email_to      TEXT DEFAULT '',
        last_run_date TEXT DEFAULT '',
        updated_by    TEXT DEFAULT '',
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    // items: snapshot inmutable de los productos con alerta al momento de
    // generar (sku, nombre, almacén, tienda, stock, stock de alerta, costo)
    // — nunca se recalcula después, ver generateRun en api/_stock_alerts.js.
    await sql`
      CREATE TABLE IF NOT EXISTS stock_alert_runs (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL DEFAULT 'TEN-001',
        generated_at    TIMESTAMPTZ DEFAULT NOW(),
        item_count      INTEGER NOT NULL DEFAULT 0,
        estimated_value NUMERIC NOT NULL DEFAULT 0,
        status          TEXT NOT NULL DEFAULT 'pendiente',
        reviewed_by     TEXT DEFAULT '',
        reviewed_at     TIMESTAMPTZ,
        items           JSONB NOT NULL DEFAULT '[]'::jsonb
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS stock_alert_runs_tenant_idx ON stock_alert_runs (tenant_id, generated_at DESC)`;

    // ── Finanzas: categorías de gasto ──────────────────────────────────────
    await sql`
      CREATE TABLE IF NOT EXISTS expense_categories (
        id          TEXT PRIMARY KEY,
        tenant_id   TEXT NOT NULL DEFAULT 'TEN-001',
        name        TEXT NOT NULL,
        code        TEXT DEFAULT '',
        is_active   BOOLEAN NOT NULL DEFAULT TRUE,
        is_default  BOOLEAN NOT NULL DEFAULT FALSE,
        created_by  TEXT DEFAULT '',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (tenant_id, name)
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS expense_categories_tenant_idx ON expense_categories (tenant_id)`;

    // ── Finanzas: gastos ────────────────────────────────────────────────────
    // Eliminación lógica vía deleted_at (mismo patrón que ya usa el resto del
    // proyecto para soft-delete — ver api_keys.status / users.status).
    await sql`
      CREATE TABLE IF NOT EXISTS expenses (
        id             TEXT PRIMARY KEY,
        tenant_id      TEXT NOT NULL DEFAULT 'TEN-001',
        location_id    TEXT DEFAULT '',
        warehouse_id   TEXT DEFAULT '',
        date           DATE NOT NULL,
        description    TEXT NOT NULL,
        category_id    TEXT NOT NULL,
        supplier_name  TEXT DEFAULT '',
        net_amount     INTEGER NOT NULL DEFAULT 0,
        tax_amount     INTEGER NOT NULL DEFAULT 0,
        total_amount   INTEGER NOT NULL DEFAULT 0,
        payment_status TEXT NOT NULL DEFAULT 'pending',
        payment_method TEXT DEFAULT '',
        notes          TEXT DEFAULT '',
        created_by     TEXT DEFAULT '',
        updated_by     TEXT DEFAULT '',
        created_at     TIMESTAMPTZ DEFAULT NOW(),
        updated_at     TIMESTAMPTZ DEFAULT NOW(),
        deleted_at     TIMESTAMPTZ
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS expenses_tenant_idx        ON expenses (tenant_id)`;
    await sql`CREATE INDEX IF NOT EXISTS expenses_date_idx          ON expenses (date)`;
    await sql`CREATE INDEX IF NOT EXISTS expenses_category_idx      ON expenses (category_id)`;
    await sql`CREATE INDEX IF NOT EXISTS expenses_location_idx      ON expenses (location_id)`;
    await sql`CREATE INDEX IF NOT EXISTS expenses_tenant_date_idx   ON expenses (tenant_id, date)`;

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
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS settings   JSONB DEFAULT '{}'`;

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

    // ── Locales / Almacenes / Formas de entrega ───────────────────────────────
    await sql`
      CREATE TABLE IF NOT EXISTS locales (
        id             TEXT PRIMARY KEY,
        tenant_id      TEXT NOT NULL DEFAULT 'TEN-001',
        name           TEXT NOT NULL,
        address_street TEXT DEFAULT '',
        address_city   TEXT DEFAULT '',
        address_region TEXT DEFAULT '',
        phone          TEXT DEFAULT '',
        email          TEXT DEFAULT '',
        lat            DOUBLE PRECISION,
        lng            DOUBLE PRECISION,
        created_by     TEXT DEFAULT '',
        created_at     TIMESTAMPTZ DEFAULT NOW(),
        updated_at     TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    // Prefijo corto (máx. 10 caracteres) que identifica al local en cada
    // orden asociada a él — se muestra como "PREFIJO  #ORD-0022" (ver
    // orderDisplayId() en frontend/index.html). Opcional: '' = sin prefijo,
    // se muestra solo el ID de la orden como antes.
    await sql`ALTER TABLE locales ADD COLUMN IF NOT EXISTS prefix TEXT NOT NULL DEFAULT ''`;
    await sql`CREATE INDEX IF NOT EXISTS locales_tenant_idx ON locales (tenant_id)`;

    await sql`
      CREATE TABLE IF NOT EXISTS warehouses (
        id          TEXT PRIMARY KEY,
        tenant_id   TEXT NOT NULL DEFAULT 'TEN-001',
        local_id    TEXT NOT NULL REFERENCES locales(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        description TEXT DEFAULT '',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS warehouses_local_idx ON warehouses (local_id)`;
    await sql`CREATE INDEX IF NOT EXISTS warehouses_tenant_idx ON warehouses (tenant_id)`;

    await sql`
      CREATE TABLE IF NOT EXISTS delivery_methods (
        id               TEXT PRIMARY KEY,
        tenant_id        TEXT NOT NULL DEFAULT 'TEN-001',
        local_id         TEXT NOT NULL REFERENCES locales(id) ON DELETE CASCADE,
        name             TEXT NOT NULL,
        type             TEXT NOT NULL DEFAULT 'home_delivery',
        base_cost        INTEGER NOT NULL DEFAULT 0,
        free_above       INTEGER,
        prep_hours       INTEGER NOT NULL DEFAULT 2,
        requires_address BOOLEAN NOT NULL DEFAULT TRUE,
        created_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS delivery_methods_local_idx ON delivery_methods (local_id)`;
    await sql`CREATE INDEX IF NOT EXISTS delivery_methods_tenant_idx ON delivery_methods (tenant_id)`;

    await sql`
      CREATE TABLE IF NOT EXISTS delivery_slots (
        id                  SERIAL PRIMARY KEY,
        tenant_id           TEXT NOT NULL DEFAULT 'TEN-001',
        delivery_method_id  TEXT NOT NULL REFERENCES delivery_methods(id) ON DELETE CASCADE,
        day_of_week         INTEGER NOT NULL,
        time_from           TEXT NOT NULL,
        time_to             TEXT NOT NULL,
        label               TEXT DEFAULT '',
        max_orders          INTEGER DEFAULT 20,
        extra_cost          INTEGER DEFAULT 0,
        created_at          TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS delivery_slots_method_idx ON delivery_slots (delivery_method_id)`;

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

    const created = ['tenants', 'products', 'kits', 'product_groups', 'label_templates', 'orders', 'coupons', 'stock_alert_settings', 'stock_alert_runs', 'purchases', 'suppliers', 'shipments', 'users', 'sessions', 'audit_logs', 'api_keys', 'locales', 'warehouses', 'delivery_methods', 'delivery_slots', 'expense_categories', 'expenses'];

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

    // ── Finanzas: backfill de categorías de gasto por defecto ─────────────
    // Migración segura para cuentas existentes — idempotente (seedDefaultCategories
    // matchea por nombre y usa ON CONFLICT DO NOTHING), no borra ni pisa
    // categorías que una cuenta ya haya creado o renombrado. Se ejecuta cada
    // vez que corre /api/setup, así que también cubre tenants creados luego
    // sin pasar por el flujo normal de creación de tenant.
    try {
      const allTenants = await sql`SELECT id FROM tenants`;
      for (const t of allTenants) {
        await seedDefaultCategories(sql, t.id, 'sistema');
      }
    } catch (seedErr) {
      console.error('[setup] category seed error:', seedErr.message);
    }

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
