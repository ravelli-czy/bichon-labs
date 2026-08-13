// api/_kit_shortage_alerts_routes.js — Módulo Alertas de insumos de KIT:
// configuración + historial/detalle de corridas + endpoint del cron.
//
// NO es una Serverless Function (prefijo `_`, mismo motivo que
// _stock_alerts_routes.js) — se invoca desde api/orders.js cuando
// `req.query.resource === 'kit-shortage-alerts'`.
//
// GET    /api/orders?resource=kit-shortage-alerts&scope=settings   → configuración del tenant (crea default si no existe)
// PUT    /api/orders?resource=kit-shortage-alerts&scope=settings   → guarda configuración (sólo admin)
// GET    /api/orders?resource=kit-shortage-alerts&scope=pending    → corrida pendiente más reciente (o null)
// GET    /api/orders?resource=kit-shortage-alerts                  → historial de corridas
// GET    /api/orders?resource=kit-shortage-alerts&id=KSA-0001      → detalle de una corrida
// PUT    /api/orders?resource=kit-shortage-alerts&id=KSA-0001      → marcar como revisada
//
// El cron se despacha aparte, ANTES de resolver tenant/sesión, protegido con
// CRON_SECRET — mismo patrón que handleStockAlertsCron.

const { writeLog } = require('./_log');
const { sendEmail, kitShortageAlertEmailHtml } = require('./_email');
const A = require('./_kit_shortage_alerts');

const ADMIN_ROLES = ['admin', 'superadmin', 'master'];
const isAdmin = session => ADMIN_ROLES.includes(session.role);

const KIT_SHORTAGE_ALERT_RESOURCES = ['kit-shortage-alerts'];

function mapSettings(row) {
  return {
    frequency:     row.frequency,
    weekday:       row.weekday,
    month_day:     row.month_day,
    lead_days:     row.lead_days,
    channel_home:  row.channel_home,
    channel_email: row.channel_email,
    email_to:      row.email_to || '',
    last_run_date: row.last_run_date || '',
    next_run:      A.nextRunDate(row),
    updated_by:    row.updated_by || '',
  };
}

async function notifyRunByEmail(settings, run) {
  if (!settings.channel_email || !settings.email_to) return;
  const recipients = settings.email_to.split(',').map(s => s.trim()).filter(Boolean);
  for (const to of recipients) {
    try {
      await sendEmail({
        to,
        subject: `Insumos de KIT por comprar — ${run.item_count} producto${run.item_count !== 1 ? 's' : ''} para ${run.order_count} venta${run.order_count !== 1 ? 's' : ''}`,
        html: kitShortageAlertEmailHtml({ run }),
      });
    } catch (emailErr) {
      console.error('[kit-shortage-alerts] email error:', emailErr.message);
    }
  }
}

async function getOrCreateSettings(sql, tenantId) {
  const [existing] = await sql`SELECT * FROM kit_shortage_alert_settings WHERE tenant_id = ${tenantId}`;
  if (existing) return existing;
  await sql`
    INSERT INTO kit_shortage_alert_settings (tenant_id, frequency, lead_days, channel_home, channel_email)
    VALUES (${tenantId}, 'diaria', 3, true, false)
    ON CONFLICT (tenant_id) DO NOTHING
  `;
  const [row] = await sql`SELECT * FROM kit_shortage_alert_settings WHERE tenant_id = ${tenantId}`;
  return row;
}

async function handleKitShortageAlertsResource(req, res, sql, session, tenantId, actor) {
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
      const lead_days = Number(body.lead_days);
      if (!Number.isInteger(lead_days) || lead_days < 0 || lead_days > 60) {
        return res.status(400).json({ error: 'lead_days debe ser un entero entre 0 y 60' });
      }
      const channel_home  = !!body.channel_home;
      const channel_email = !!body.channel_email;
      const email_to = channel_email ? String(body.email_to || '').trim() : '';
      if (channel_email && !email_to) return res.status(400).json({ error: 'Ingresa al menos un correo para el canal Correo' });

      await getOrCreateSettings(sql, tenantId);
      const [row] = await sql`
        UPDATE kit_shortage_alert_settings SET
          frequency     = ${frequency},
          weekday       = ${weekday},
          month_day     = ${month_day},
          lead_days     = ${lead_days},
          channel_home  = ${channel_home},
          channel_email = ${channel_email},
          email_to      = ${email_to},
          updated_by    = ${actor},
          updated_at    = NOW()
        WHERE tenant_id = ${tenantId}
        RETURNING *
      `;
      await writeLog(sql, {
        tenant_id: tenantId, actor, action: 'alertas_insumos_kit.config_editada',
        entity_type: 'alerta_insumos_kit_config', entity_id: tenantId, entity_name: 'Configuración de alertas de insumos de KIT',
        details: { frequency, weekday, month_day, lead_days, channel_home, channel_email },
      });
      return res.json(mapSettings(row));
    }

    // ── GENERAR AHORA (manual) ──────────────────────────────────────────
    if (q.action === 'generate-now' && req.method === 'POST') {
      if (!isAdmin(session)) return res.status(403).json({ error: 'Sólo administradores pueden generar una lista manualmente' });
      const settings = await getOrCreateSettings(sql, tenantId);
      // Generación manual: revisa TODAS las ventas con entrega futura, sin
      // límite — lead_days sólo gobierna cuándo dispara el aviso automático
      // (cron/correo), no qué toma este botón.
      const run = await A.generateRun(sql, tenantId, null);
      if (!run) return res.json({ ok: true, run: null }); // sin faltantes ahora mismo

      const todayStr = new Date().toISOString().slice(0, 10);
      await sql`UPDATE kit_shortage_alert_settings SET last_run_date = ${todayStr} WHERE tenant_id = ${tenantId}`;
      await notifyRunByEmail(settings, run);
      await writeLog(sql, {
        tenant_id: tenantId, actor, action: 'alertas_insumos_kit.lista_generada_manual',
        entity_type: 'alerta_insumos_kit', entity_id: run.id, entity_name: run.id,
        details: { item_count: run.item_count, order_count: run.order_count, estimated_value: Number(run.estimated_value) },
      });
      return res.json({ ok: true, run });
    }

    // ── AVISO DE HEADER: corrida pendiente más reciente ────────────────
    if (q.scope === 'pending' && req.method === 'GET') {
      const [row] = await sql`
        SELECT id, generated_at, item_count, order_count, estimated_value FROM kit_shortage_alert_runs
        WHERE tenant_id = ${tenantId} AND status = 'pendiente'
        ORDER BY generated_at DESC LIMIT 1
      `;
      return res.json(row || null);
    }

    // ── HISTORIAL ────────────────────────────────────────────────────────
    if (!id && req.method === 'GET') {
      const rows = await sql`
        SELECT id, generated_at, item_count, order_count, estimated_value, status, reviewed_by, reviewed_at
        FROM kit_shortage_alert_runs WHERE tenant_id = ${tenantId} ORDER BY generated_at DESC
      `;
      return res.json(rows);
    }

    if (!id) return res.status(405).json({ error: 'Method not allowed' });

    // ── DETALLE ──────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const [row] = await sql`SELECT * FROM kit_shortage_alert_runs WHERE id = ${id} AND tenant_id = ${tenantId}`;
      if (!row) return res.status(404).json({ error: 'Lista no encontrada' });
      return res.json(row);
    }

    // ── MARCAR COMO REVISADA ─────────────────────────────────────────────
    if (req.method === 'PUT') {
      const [row] = await sql`
        UPDATE kit_shortage_alert_runs SET status = 'revisada', reviewed_by = ${actor}, reviewed_at = NOW()
        WHERE id = ${id} AND tenant_id = ${tenantId} AND status != 'revisada'
        RETURNING *
      `;
      if (row) {
        await writeLog(sql, {
          tenant_id: tenantId, actor, action: 'alertas_insumos_kit.lista_revisada',
          entity_type: 'alerta_insumos_kit', entity_id: id, entity_name: id, details: {},
        });
        return res.json(row);
      }
      const [existing] = await sql`SELECT * FROM kit_shortage_alert_runs WHERE id = ${id} AND tenant_id = ${tenantId}`;
      if (!existing) return res.status(404).json({ error: 'Lista no encontrada' });
      return res.json(existing);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('kit-shortage-alerts error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── CRON: generación diaria ────────────────────────────────────────────
// Corre todos los días (tope de Vercel Hobby) y decide por tenant, según su
// config, si hoy corresponde generar — mismo patrón que handleStockAlertsCron.
async function handleKitShortageAlertsCron(req, res, sql) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'No autorizado' });
  }

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  let tenantsChecked = 0, runsGenerated = 0;

  try {
    const settingsRows = await sql`SELECT * FROM kit_shortage_alert_settings`;
    for (const settings of settingsRows) {
      tenantsChecked++;
      if (settings.last_run_date === todayStr) continue;
      if (!A.isDueToday(settings, today)) continue;

      const run = await A.generateRun(sql, settings.tenant_id, settings.lead_days);
      await sql`UPDATE kit_shortage_alert_settings SET last_run_date = ${todayStr} WHERE tenant_id = ${settings.tenant_id}`;
      if (!run) continue;

      runsGenerated++;
      await writeLog(sql, {
        tenant_id: settings.tenant_id, actor: 'sistema', action: 'alertas_insumos_kit.lista_generada',
        entity_type: 'alerta_insumos_kit', entity_id: run.id, entity_name: run.id,
        details: { item_count: run.item_count, order_count: run.order_count, estimated_value: Number(run.estimated_value) },
      });

      await notifyRunByEmail(settings, run);
    }
    return res.json({ ok: true, tenantsChecked, runsGenerated });
  } catch (err) {
    console.error('kit-shortage-alerts cron error:', err);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = { handleKitShortageAlertsResource, KIT_SHORTAGE_ALERT_RESOURCES, handleKitShortageAlertsCron };
