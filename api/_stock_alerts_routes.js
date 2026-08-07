// api/_stock_alerts_routes.js — Módulo Alertas de stock: configuración +
// historial/detalle de corridas + endpoint del cron.
//
// NO es una Serverless Function (prefijo `_`, igual que _coupons_routes.js)
// — se invoca desde api/orders.js cuando `req.query.resource === 'stock-alerts'`
// (el proyecto está en el tope de 12 Serverless Functions del plan Hobby de
// Vercel — ver comentario en api/orders.js).
//
// GET    /api/orders?resource=stock-alerts&scope=settings   → configuración del tenant (crea default si no existe)
// PUT    /api/orders?resource=stock-alerts&scope=settings   → guarda configuración (sólo admin)
// GET    /api/orders?resource=stock-alerts&scope=pending    → corrida pendiente más reciente (o null) — para el aviso del header
// GET    /api/orders?resource=stock-alerts                  → historial de corridas
// GET    /api/orders?resource=stock-alerts&id=ALR-0001       → detalle de una corrida
// PUT    /api/orders?resource=stock-alerts&id=ALR-0001       → marcar como revisada
//
// El cron NO pasa por handleStockAlertsResource — no tiene sesión de usuario
// (Vercel Cron llama sin cookie). Se despacha aparte, ANTES de resolver
// tenant/sesión, directo desde api/orders.js hacia handleStockAlertsCron acá
// abajo, protegido con CRON_SECRET en vez de un login.

const { writeLog } = require('./_log');
const { sendEmail, stockAlertEmailHtml } = require('./_email');
const A = require('./_stock_alerts');

const ADMIN_ROLES = ['admin', 'superadmin', 'master'];
const isAdmin = session => ADMIN_ROLES.includes(session.role);

const STOCK_ALERT_RESOURCES = ['stock-alerts'];

function mapSettings(row) {
  return {
    frequency:     row.frequency,
    weekday:       row.weekday,
    month_day:     row.month_day,
    channel_home:  row.channel_home,
    channel_email: row.channel_email,
    email_to:      row.email_to || '',
    last_run_date: row.last_run_date || '',
    next_run:      A.nextRunDate(row),
    // '' sólo en la fila default que crea getOrCreateSettings antes de que
    // alguien guarde por primera vez — la UI usa esto para decidir si el
    // panel de configuración arranca colapsado o abierto.
    updated_by:    row.updated_by || '',
  };
}

// Envía el correo de aviso (si el canal está activo) — compartido entre el
// cron y la generación manual para no duplicar el armado del mensaje.
async function notifyRunByEmail(settings, run) {
  if (!settings.channel_email || !settings.email_to) return;
  const recipients = settings.email_to.split(',').map(s => s.trim()).filter(Boolean);
  for (const to of recipients) {
    try {
      await sendEmail({
        to,
        subject: `Nueva lista de compra — ${run.item_count} producto${run.item_count !== 1 ? 's' : ''} con stock bajo`,
        html: stockAlertEmailHtml({ run }),
      });
    } catch (emailErr) {
      console.error('[stock-alerts] email error:', emailErr.message);
    }
  }
}

async function getOrCreateSettings(sql, tenantId) {
  const [existing] = await sql`SELECT * FROM stock_alert_settings WHERE tenant_id = ${tenantId}`;
  if (existing) return existing;
  await sql`
    INSERT INTO stock_alert_settings (tenant_id, frequency, weekday, channel_home, channel_email)
    VALUES (${tenantId}, 'semanal', 1, true, false)
    ON CONFLICT (tenant_id) DO NOTHING
  `;
  const [row] = await sql`SELECT * FROM stock_alert_settings WHERE tenant_id = ${tenantId}`;
  return row;
}

async function handleStockAlertsResource(req, res, sql, session, tenantId, actor) {
  const q = req.query || {};
  const id = q.id;

  try {
    // ── CONFIGURACIÓN ───────────────────────────────────────────────────
    if (q.scope === 'settings' && req.method === 'GET') {
      const row = await getOrCreateSettings(sql, tenantId);
      return res.json(mapSettings(row));
    }
    if (q.scope === 'settings' && req.method === 'PUT') {
      if (!isAdmin(session)) return res.status(403).json({ error: 'Sólo administradores pueden editar esta configuración' });
      const body = req.body || {};
      const frequency = body.frequency;
      if (!A.FREQUENCIES.includes(frequency)) return res.status(400).json({ error: 'frequency inválida' });

      let weekday = null, month_day = null;
      if (frequency === 'semanal') {
        weekday = Number(body.weekday);
        if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return res.status(400).json({ error: 'weekday debe ser un entero entre 0 (domingo) y 6 (sábado)' });
      }
      if (frequency === 'mensual') {
        month_day = Number(body.month_day);
        if (!Number.isInteger(month_day) || month_day < 1 || month_day > 31) return res.status(400).json({ error: 'month_day debe ser un entero entre 1 y 31' });
      }
      const channel_home  = !!body.channel_home;
      const channel_email = !!body.channel_email;
      const email_to = channel_email ? String(body.email_to || '').trim() : '';
      if (channel_email && !email_to) return res.status(400).json({ error: 'Ingresa al menos un correo para el canal Correo' });

      await getOrCreateSettings(sql, tenantId);
      const [row] = await sql`
        UPDATE stock_alert_settings SET
          frequency     = ${frequency},
          weekday       = ${weekday},
          month_day     = ${month_day},
          channel_home  = ${channel_home},
          channel_email = ${channel_email},
          email_to      = ${email_to},
          updated_by    = ${actor},
          updated_at    = NOW()
        WHERE tenant_id = ${tenantId}
        RETURNING *
      `;
      await writeLog(sql, {
        tenant_id: tenantId, actor, action: 'alertas_stock.config_editada',
        entity_type: 'alerta_stock_config', entity_id: tenantId, entity_name: 'Configuración de alertas de stock',
        details: { frequency, weekday, month_day, channel_home, channel_email },
      });
      return res.json(mapSettings(row));
    }

    // ── GENERAR AHORA (manual, fuera de la frecuencia configurada) ──────
    if (q.action === 'generate-now' && req.method === 'POST') {
      if (!isAdmin(session)) return res.status(403).json({ error: 'Sólo administradores pueden generar una lista manualmente' });
      const run = await A.generateRun(sql, tenantId);
      if (!run) return res.json({ ok: true, run: null }); // sin productos con alerta ahora mismo

      const todayStr = new Date().toISOString().slice(0, 10);
      const settings = await getOrCreateSettings(sql, tenantId);
      // Cuenta como la corrida del día — evita que el cron genere una
      // segunda lista duplicada más tarde el mismo día.
      await sql`UPDATE stock_alert_settings SET last_run_date = ${todayStr} WHERE tenant_id = ${tenantId}`;
      await notifyRunByEmail(settings, run);
      await writeLog(sql, {
        tenant_id: tenantId, actor, action: 'alertas_stock.lista_generada_manual',
        entity_type: 'alerta_stock', entity_id: run.id, entity_name: run.id,
        details: { item_count: run.item_count, estimated_value: Number(run.estimated_value) },
      });
      return res.json({ ok: true, run });
    }

    // ── AVISO DE HEADER: corrida pendiente más reciente ────────────────
    if (q.scope === 'pending' && req.method === 'GET') {
      const [row] = await sql`
        SELECT id, generated_at, item_count, estimated_value FROM stock_alert_runs
        WHERE tenant_id = ${tenantId} AND status = 'pendiente'
        ORDER BY generated_at DESC LIMIT 1
      `;
      return res.json(row || null);
    }

    // ── HISTORIAL ────────────────────────────────────────────────────────
    if (!id && req.method === 'GET') {
      const rows = await sql`
        SELECT id, generated_at, item_count, estimated_value, status, reviewed_by, reviewed_at
        FROM stock_alert_runs WHERE tenant_id = ${tenantId} ORDER BY generated_at DESC
      `;
      return res.json(rows);
    }

    if (!id) return res.status(405).json({ error: 'Method not allowed' });

    // ── DETALLE ──────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const [row] = await sql`SELECT * FROM stock_alert_runs WHERE id = ${id} AND tenant_id = ${tenantId}`;
      if (!row) return res.status(404).json({ error: 'Lista no encontrada' });
      return res.json(row);
    }

    // ── MARCAR COMO REVISADA ─────────────────────────────────────────────
    if (req.method === 'PUT') {
      const [row] = await sql`
        UPDATE stock_alert_runs SET status = 'revisada', reviewed_by = ${actor}, reviewed_at = NOW()
        WHERE id = ${id} AND tenant_id = ${tenantId} AND status != 'revisada'
        RETURNING *
      `;
      if (row) {
        await writeLog(sql, {
          tenant_id: tenantId, actor, action: 'alertas_stock.lista_revisada',
          entity_type: 'alerta_stock', entity_id: id, entity_name: id, details: {},
        });
        return res.json(row);
      }
      // Ya estaba revisada (o no existe) — idempotente en vez de 409 por un
      // doble click, pero sigue siendo 404 real si el id no es de este tenant.
      const [existing] = await sql`SELECT * FROM stock_alert_runs WHERE id = ${id} AND tenant_id = ${tenantId}`;
      if (!existing) return res.status(404).json({ error: 'Lista no encontrada' });
      return res.json(existing);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('stock-alerts error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── CRON: generación diaria ────────────────────────────────────────────
// Vercel Cron sólo puede disparar como máximo una vez al día en el plan
// Hobby, así que el cron corre todos los días y decide acá, por tenant, si
// hoy corresponde generar según su config (ver isDueToday). No hay sesión
// de usuario — se protege con CRON_SECRET (Vercel agrega automáticamente
// el header Authorization: Bearer $CRON_SECRET cuando esa env var está
// configurada) en vez de con el login normal de la app.
async function handleStockAlertsCron(req, res, sql) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'No autorizado' });
  }

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  let tenantsChecked = 0, runsGenerated = 0;

  try {
    const settingsRows = await sql`SELECT * FROM stock_alert_settings`;
    for (const settings of settingsRows) {
      tenantsChecked++;
      if (settings.last_run_date === todayStr) continue; // ya corrió hoy
      if (!A.isDueToday(settings, today)) continue;

      const run = await A.generateRun(sql, settings.tenant_id);
      await sql`UPDATE stock_alert_settings SET last_run_date = ${todayStr} WHERE tenant_id = ${settings.tenant_id}`;
      if (!run) continue; // sin productos con alerta hoy — no genera ni notifica

      runsGenerated++;
      await writeLog(sql, {
        tenant_id: settings.tenant_id, actor: 'sistema', action: 'alertas_stock.lista_generada',
        entity_type: 'alerta_stock', entity_id: run.id, entity_name: run.id,
        details: { item_count: run.item_count, estimated_value: Number(run.estimated_value) },
      });

      await notifyRunByEmail(settings, run);
      // Canal Home: no hay tabla de notificaciones — la UI lee directamente
      // la corrida 'pendiente' más reciente vía scope=pending (ver arriba).
    }
    return res.json({ ok: true, tenantsChecked, runsGenerated });
  } catch (err) {
    console.error('stock-alerts cron error:', err);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = { handleStockAlertsResource, STOCK_ALERT_RESOURCES, handleStockAlertsCron };
