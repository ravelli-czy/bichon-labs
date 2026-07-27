// api/users.js — Gestión de usuarios (admin o superadmin)
// GET    /api/users              → listar usuarios del tenant actual
// POST   /api/users              → crear usuario + enviar invitación
// PUT    /api/users?id=USR-001   → actualizar rol / display_name
// DELETE /api/users?id=USR-001   → eliminar usuario
// POST   /api/users?id=USR-001&action=resend → reenviar invitación

const { getDb } = require('./_db');
const cors      = require('./_cors');
const crypto    = require('crypto');
const { sendEmail, inviteEmailHtml } = require('./_email');
const { writeLog } = require('./_log');
const { getSession, resolveTenantId } = require('./_tenant');

const APP_URL = process.env.APP_URL || 'https://bichon-labs.vercel.app';

module.exports = async (req, res) => {
  if (cors(req, res)) return;

  let sql;
  try { sql = getDb(); } catch (e) { return res.status(503).json({ error: e.message }); }

  // ── Auth: admin o superadmin ──────────────────────────────────────────────
  const session  = await getSession(req);
  const tenantId = resolveTenantId(req, session);

  if (!session) return res.status(401).json({ error: 'No autenticado' });

  // ── LOGS — GET /api/users?action=logs (admin o superadmin, scoped to tenant) ──
  // Colapsado acá para no sumar otra Serverless Function (tope 12 en Hobby).
  if ((req.query || {}).action === 'logs') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    if (!['admin','superadmin','master'].includes(session.role))
      return res.status(403).json({ error: 'Solo administradores pueden ver los logs' });
    if (!tenantId) return res.status(400).json({ error: 'Sin contexto de cliente.' });

    const { entity_type, actor: logActor, limit = '60', offset = '0' } = req.query || {};
    const lim = Math.min(parseInt(limit) || 60, 500);
    const off = parseInt(offset) || 0;

    try {
      let rows, countRow;
      if (entity_type && logActor) {
        rows     = await sql`SELECT * FROM audit_logs WHERE tenant_id = ${tenantId} AND entity_type = ${entity_type} AND actor = ${logActor} ORDER BY created_at DESC LIMIT ${lim} OFFSET ${off}`;
        [countRow] = await sql`SELECT COUNT(*)::int AS total FROM audit_logs WHERE tenant_id = ${tenantId} AND entity_type = ${entity_type} AND actor = ${logActor}`;
      } else if (entity_type) {
        rows     = await sql`SELECT * FROM audit_logs WHERE tenant_id = ${tenantId} AND entity_type = ${entity_type} ORDER BY created_at DESC LIMIT ${lim} OFFSET ${off}`;
        [countRow] = await sql`SELECT COUNT(*)::int AS total FROM audit_logs WHERE tenant_id = ${tenantId} AND entity_type = ${entity_type}`;
      } else if (logActor) {
        rows     = await sql`SELECT * FROM audit_logs WHERE tenant_id = ${tenantId} AND actor = ${logActor} ORDER BY created_at DESC LIMIT ${lim} OFFSET ${off}`;
        [countRow] = await sql`SELECT COUNT(*)::int AS total FROM audit_logs WHERE tenant_id = ${tenantId} AND actor = ${logActor}`;
      } else {
        rows     = await sql`SELECT * FROM audit_logs WHERE tenant_id = ${tenantId} ORDER BY created_at DESC LIMIT ${lim} OFFSET ${off}`;
        [countRow] = await sql`SELECT COUNT(*)::int AS total FROM audit_logs WHERE tenant_id = ${tenantId}`;
      }
      return res.json({ rows, total: countRow?.total ?? 0, limit: lim, offset: off });
    } catch (err) {
      console.error('[users/logs] error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── SETTINGS — cualquier usuario autenticado puede leer; solo admin+ puede escribir ──
  if ((req.query || {}).action === 'settings') {
    if (!tenantId) return res.status(400).json({ error: 'Sin contexto de cliente' });
    try {
      if (req.method === 'GET') {
        const [tenant] = await sql`SELECT settings FROM tenants WHERE id = ${tenantId}`;
        return res.json((tenant && tenant.settings) ? tenant.settings : {});
      }
      if (req.method === 'PUT') {
        if (!['admin','superadmin','master'].includes(session.role))
          return res.status(403).json({ error: 'Solo administradores pueden cambiar la configuración' });
        const { settings: newSettings = {} } = req.body || {};
        const [tenant] = await sql`
          UPDATE tenants
          SET settings = COALESCE(settings, '{}')::jsonb || ${JSON.stringify(newSettings)}::jsonb
          WHERE id = ${tenantId}
          RETURNING settings
        `;
        return res.json((tenant && tenant.settings) ? tenant.settings : {});
      }
      return res.status(405).json({ error: 'Method not allowed' });
    } catch (err) {
      console.error('[users/settings] error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  if (!['admin','superadmin','master'].includes(session.role))
    return res.status(403).json({ error: 'Solo administradores pueden gestionar usuarios' });
  if (!tenantId)
    return res.status(400).json({ error: 'Sin contexto de cliente. Entra a un cliente primero.' });

  const { id, action } = req.query || {};

  try {
    // ── API KEYS ──────────────────────────────────────────────────────────
    if (action === 'apikeys') {
      // Platform roles without a tenant context can't manage keys
      if (!tenantId)
        return res.status(400).json({ error: 'Sin contexto de cliente para gestionar API keys' });

      // GET — list API keys for a user
      if (req.method === 'GET') {
        // staff defaults to self; admin/superadmin requires explicit user_id
        const isStaff = session.role === 'staff';
        const targetUserId = req.query.user_id || (isStaff ? session.user_id : null);
        if (!targetUserId) return res.status(400).json({ error: 'user_id requerido' });
        if (isStaff && targetUserId !== session.user_id)
          return res.status(403).json({ error: 'Solo puedes ver tus propias API keys' });
        const rows = await sql`
          SELECT id, name, key_id, status, last_used_at, created_at
          FROM api_keys
          WHERE user_id = ${targetUserId} AND tenant_id = ${tenantId}
          ORDER BY created_at DESC
        `;
        return res.json(rows);
      }

      // POST — create new API key
      if (req.method === 'POST') {
        const isStaff = session.role === 'staff';
        const { name = 'API Key', user_id: targetUserId = isStaff ? session.user_id : null } = req.body || {};
        if (!targetUserId) return res.status(400).json({ error: 'user_id requerido' });
        if (isStaff && targetUserId !== session.user_id)
          return res.status(403).json({ error: 'Solo puedes crear API keys para tu propio usuario' });

        const [targetUser] = await sql`
          SELECT id, username FROM users WHERE id = ${targetUserId} AND tenant_id = ${tenantId}
        `;
        if (!targetUser) return res.status(404).json({ error: 'Usuario no encontrado' });

        const [{ kcount }] = await sql`
          SELECT COUNT(*) AS kcount FROM api_keys
          WHERE user_id = ${targetUserId} AND tenant_id = ${tenantId} AND status = 'active'
        `;
        if (parseInt(kcount) >= 10)
          return res.status(400).json({ error: 'Máximo 10 API keys activas por usuario' });

        const keyId      = 'sfk_' + crypto.randomBytes(12).toString('hex');
        const rawSecret  = crypto.randomBytes(24).toString('hex');
        const secretHash = crypto.createHash('sha256').update(rawSecret).digest('hex');

        const [{ max_num }] = await sql`
          SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 4) AS INTEGER)), 0) AS max_num
          FROM api_keys WHERE id ~ '^AK-[0-9]+$'
        `;
        const akId = 'AK-' + String(parseInt(max_num) + 1).padStart(3, '0');

        const [key] = await sql`
          INSERT INTO api_keys (id, tenant_id, user_id, name, key_id, key_secret_hash)
          VALUES (${akId}, ${tenantId}, ${targetUserId}, ${name}, ${keyId}, ${secretHash})
          RETURNING id, name, key_id, status, created_at
        `;

        await writeLog(sql, {
          tenant_id:   tenantId,
          actor:       session.username,
          action:      'apikey.creada',
          entity_type: 'api_key',
          entity_id:   akId,
          entity_name: name,
          details:     { user_id: targetUserId, username: targetUser.username },
        });

        return res.status(201).json({ ...key, secret: rawSecret });
      }

      // DELETE — revoke API key
      if (req.method === 'DELETE') {
        const keyIdParam = req.query.key_id;
        if (!keyIdParam) return res.status(400).json({ error: 'key_id requerido' });

        const [keyRow] = await sql`
          SELECT id, user_id, name FROM api_keys
          WHERE id = ${keyIdParam} AND tenant_id = ${tenantId}
        `;
        if (!keyRow) return res.status(404).json({ error: 'API key no encontrada' });
        if (session.role === 'staff' && keyRow.user_id !== session.user_id)
          return res.status(403).json({ error: 'No puedes revocar esta API key' });

        await sql`DELETE FROM api_keys WHERE id = ${keyIdParam} AND tenant_id = ${tenantId}`;

        await writeLog(sql, {
          tenant_id:   tenantId,
          actor:       session.username,
          action:      'apikey.revocada',
          entity_type: 'api_key',
          entity_id:   keyIdParam,
          entity_name: keyRow.name,
          details:     {},
        });

        return res.json({ ok: true });
      }

      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── GET — listar usuarios del tenant ──────────────────────────────────
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT id, username, email, display_name, role, status, created_at,
               (reset_token IS NOT NULL AND reset_token_expires > NOW()) AS invite_pending
        FROM users
        WHERE tenant_id = ${tenantId}
        ORDER BY created_at ASC
      `;
      return res.json(rows);
    }

    // ── POST (sin id) — crear usuario y enviar invitación ─────────────────
    if (req.method === 'POST' && !id) {
      const { username, email, role = 'staff', display_name = '' } = req.body || {};
      if (!username) return res.status(400).json({ error: 'username es requerido' });
      if (!email)    return res.status(400).json({ error: 'email es requerido' });

      if (!/^[a-zA-Z0-9_]{3,32}$/.test(username))
        return res.status(400).json({ error: 'username debe tener 3-32 caracteres alfanuméricos' });

      const [existing] = await sql`SELECT id FROM users WHERE username = ${username}`;
      if (existing) return res.status(409).json({ error: 'El nombre de usuario ya está en uso' });

      const [{ max_num }] = await sql`
        SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 5) AS INTEGER)), 0) AS max_num
        FROM users WHERE id ~ '^USR-[0-9]+$'
      `;
      const userId = 'USR-' + String(parseInt(max_num) + 1).padStart(3, '0');

      const placeholderHash = crypto.randomBytes(32).toString('hex');
      const inviteToken   = crypto.randomBytes(4).toString('hex').toUpperCase();
      const inviteExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const [user] = await sql`
        INSERT INTO users (
          id, username, email, display_name, password_hash, role, status,
          reset_token, reset_token_expires, tenant_id
        ) VALUES (
          ${userId}, ${username}, ${email}, ${display_name},
          ${placeholderHash}, ${role}, 'pending_invite',
          ${inviteToken}, ${inviteExpires.toISOString()}, ${tenantId}
        )
        RETURNING id, username, email, display_name, role, status, created_at
      `;

      const inviteUrl = `${APP_URL}/invite?token=${inviteToken}&u=${encodeURIComponent(username)}`;
      let invite_sent = false;
      let email_error = null;

      try {
        await sendEmail({
          to: email,
          subject: `Invitación para acceder a StockFlow`,
          html: inviteEmailHtml({
            username,
            display_name,
            inviteUrl,
            inviterName: session.username,
          }),
          text: `Hola ${display_name || username}! Has sido invitado a StockFlow. Crea tu contraseña aquí: ${inviteUrl} (válido 7 días)`,
        });
        invite_sent = true;
      } catch (emailErr) {
        console.error('[users] email send error:', emailErr.message);
        email_error = emailErr.message;
      }

      await writeLog(sql, {
        tenant_id:   tenantId,
        actor:       session.username,
        action:      'usuario.creado',
        entity_type: 'usuario',
        entity_id:   userId,
        entity_name: username,
        details:     { username, email, role, invite_sent },
      });

      return res.status(201).json({ ...user, invite_sent, email_error, invite_token: inviteToken });
    }

    // ── POST con id + action=resend — reenviar invitación ────────────────
    if (req.method === 'POST' && id && action === 'resend') {
      const [user] = await sql`
        SELECT id, username, email, display_name FROM users
        WHERE id = ${id} AND tenant_id = ${tenantId}
      `;
      if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
      if (!user.email) return res.status(400).json({ error: 'El usuario no tiene email registrado' });

      const inviteToken   = crypto.randomBytes(4).toString('hex').toUpperCase();
      const inviteExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      await sql`
        UPDATE users
        SET reset_token = ${inviteToken}, reset_token_expires = ${inviteExpires.toISOString()},
            status = 'pending_invite'
        WHERE id = ${id} AND tenant_id = ${tenantId}
      `;

      const inviteUrl = `${APP_URL}/invite?token=${inviteToken}&u=${encodeURIComponent(user.username)}`;
      await sendEmail({
        to: user.email,
        subject: `Nuevo enlace de invitación — StockFlow`,
        html: inviteEmailHtml({
          username: user.username,
          display_name: user.display_name,
          inviteUrl,
          inviterName: session.username,
        }),
        text: `Nuevo enlace de invitación para StockFlow: ${inviteUrl} (válido 7 días)`,
      });

      await writeLog(sql, {
        tenant_id:   tenantId,
        actor:       session.username,
        action:      'usuario.invitacion_reenviada',
        entity_type: 'usuario',
        entity_id:   id,
        entity_name: user.username,
        details:     { username: user.username, email: user.email },
      });

      return res.json({ ok: true, message: 'Invitación reenviada correctamente' });
    }

    // ── PUT — actualizar rol o display_name ──────────────────────────────
    if (req.method === 'PUT' && id) {
      const { role, display_name } = req.body || {};
      if (id === session.user_id && role && role !== 'admin')
        return res.status(400).json({ error: 'No puedes cambiar tu propio rol de admin' });

      const [user] = await sql`
        UPDATE users
        SET role         = COALESCE(NULLIF(${role || ''}, ''), role),
            display_name = COALESCE(${display_name ?? null}, display_name)
        WHERE id = ${id} AND tenant_id = ${tenantId}
        RETURNING id, username, email, display_name, role, status, created_at
      `;
      if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

      await writeLog(sql, {
        tenant_id:   tenantId,
        actor:       session.username,
        action:      'usuario.editado',
        entity_type: 'usuario',
        entity_id:   id,
        entity_name: user.username,
        details:     { username: user.username, role: user.role, display_name: user.display_name },
      });

      return res.json(user);
    }

    // ── DELETE — eliminar usuario ─────────────────────────────────────────
    if (req.method === 'DELETE' && id) {
      if (id === session.user_id)
        return res.status(400).json({ error: 'No puedes eliminar tu propio usuario' });

      await sql`DELETE FROM sessions WHERE user_id = ${id}`;
      const [deleted] = await sql`
        DELETE FROM users WHERE id = ${id} AND tenant_id = ${tenantId}
        RETURNING id, username
      `;
      if (!deleted) return res.status(404).json({ error: 'Usuario no encontrado' });

      await writeLog(sql, {
        tenant_id:   tenantId,
        actor:       session.username,
        action:      'usuario.eliminado',
        entity_type: 'usuario',
        entity_id:   id,
        entity_name: deleted.username,
        details:     { username: deleted.username },
      });

      return res.json({ ok: true, deleted: deleted.username });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[users] error:', err);
    return res.status(500).json({ error: err.message });
  }
};
