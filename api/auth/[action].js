// api/auth/[action].js — handles all auth + tenant + master-user routes:
//   POST /api/auth/login                    → sign in, return token + tenant info
//   GET  /api/auth/me                       → verify token, return user + tenant info
//   POST /api/auth/logout                   → invalidate token
//   POST /api/auth/request-reset            → generate recovery code
//   POST /api/auth/reset                    → apply new password
//   GET  /api/auth/tenants                  → list all tenants (superadmin + master)
//   POST /api/auth/tenants                  → create tenant (superadmin)
//   PUT  /api/auth/tenants?id=...           → update tenant (superadmin)
//   DELETE /api/auth/tenants?id=...         → delete tenant (superadmin)
//   GET  /api/auth/master-users             → list master users (superadmin + master)
//   POST /api/auth/master-users             → create master user (superadmin)
//   PUT  /api/auth/master-users?id=...      → update master user (superadmin)
//   DELETE /api/auth/master-users?id=...    → delete master user (superadmin)
//   POST /api/auth/master-users?id=...&action=resend → resend invite (superadmin)

const { getDb } = require('../_db');
const cors = require('../_cors');
const crypto = require('crypto');
const { getSession } = require('../_tenant');
const { sendEmail, inviteEmailHtml } = require('../_email');

const APP_URL = process.env.APP_URL || 'https://bichon-labs.vercel.app';

// Roles that have platform-level (cross-tenant) access
const PLATFORM_ROLES = ['superadmin', 'master'];

module.exports = async (req, res) => {
  if (cors(req, res)) return;

  let sql;
  try { sql = getDb(); } catch (err) { return res.status(503).json({ error: err.message }); }

  const { action, id } = req.query;

  try {
    // ── GET /api/auth/me ──────────────────────────────────────────────────
    if (action === 'me' && req.method === 'GET') {
      const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
      if (!token) return res.status(401).json({ error: 'No token' });

      const [session] = await sql`
        SELECT s.user_id, s.username, u.role, u.tenant_id
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token = ${token} AND s.expires_at > NOW()
      `;
      if (!session) return res.status(401).json({ error: 'Sesión inválida o expirada' });

      let tenant = null;
      if (session.tenant_id) {
        const [t] = await sql`SELECT id, name, slug, logo_url, logo_text, color, color2, color3 FROM tenants WHERE id = ${session.tenant_id}`;
        tenant = t || null;
      }

      return res.json({
        username:  session.username,
        user_id:   session.user_id,
        role:      session.role,
        tenant_id: session.tenant_id || '',
        tenant,
      });
    }

    // ── POST /api/auth/login ──────────────────────────────────────────────
    if (action === 'login' && req.method === 'POST') {
      const { username, password } = req.body || {};
      if (!username || !password) return res.status(400).json({ error: 'username y password requeridos' });

      const hash = crypto.createHash('sha256').update(password).digest('hex');
      const [user] = await sql`
        SELECT id, username, role, tenant_id, status FROM users
        WHERE username = ${username} AND password_hash = ${hash}
      `;
      if (!user) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
      if (user.status === 'pending_invite')
        return res.status(403).json({ error: 'Tu cuenta aún no ha sido activada. Revisa tu correo de invitación.' });

      let tenant = null;
      if (user.tenant_id) {
        const [t] = await sql`SELECT id, name, slug, logo_url, logo_text, color, color2, color3 FROM tenants WHERE id = ${user.tenant_id}`;
        tenant = t || null;
      }

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await sql`
        INSERT INTO sessions (token, user_id, username, expires_at)
        VALUES (${token}, ${user.id}, ${user.username}, ${expiresAt.toISOString()})
      `;
      return res.json({
        token,
        username:  user.username,
        role:      user.role,
        tenant_id: user.tenant_id || '',
        tenant,
      });
    }

    // ── POST /api/auth/logout ─────────────────────────────────────────────
    if (action === 'logout' && req.method === 'POST') {
      const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
      if (token) await sql`DELETE FROM sessions WHERE token = ${token}`.catch(() => {});
      return res.json({ ok: true });
    }

    // ── POST /api/auth/request-reset ─────────────────────────────────────
    if (action === 'request-reset' && req.method === 'POST') {
      const { username } = req.body || {};
      if (!username) return res.status(400).json({ error: 'username requerido' });

      const [user] = await sql`SELECT id FROM users WHERE username = ${username}`;
      if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

      const token = crypto.randomBytes(4).toString('hex').toUpperCase();
      const expires = new Date(Date.now() + 60 * 60 * 1000);
      await sql`
        UPDATE users
        SET reset_token = ${token}, reset_token_expires = ${expires.toISOString()}
        WHERE id = ${user.id}
      `;
      return res.json({ reset_token: token, message: 'Código generado. Válido por 60 minutos.' });
    }

    // ── POST /api/auth/reset ──────────────────────────────────────────────
    if (action === 'reset' && req.method === 'POST') {
      const { username, reset_token, new_password } = req.body || {};
      if (!username || !reset_token || !new_password)
        return res.status(400).json({ error: 'username, reset_token y new_password requeridos' });
      if (new_password.length < 6)
        return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

      const [user] = await sql`
        SELECT id FROM users
        WHERE username = ${username}
          AND reset_token = ${reset_token.toUpperCase()}
          AND reset_token_expires > NOW()
      `;
      if (!user) return res.status(400).json({ error: 'Código inválido o expirado' });

      const hash = crypto.createHash('sha256').update(new_password).digest('hex');
      await sql`
        UPDATE users
        SET password_hash = ${hash}, reset_token = NULL, reset_token_expires = NULL,
            status = 'active'
        WHERE id = ${user.id}
      `;
      await sql`DELETE FROM sessions WHERE user_id = ${user.id}`;
      return res.json({ ok: true, message: 'Contraseña configurada. Inicia sesión para continuar.' });
    }

    // ── TENANTS (superadmin + master can list; only superadmin can mutate) ─
    if (action === 'tenants') {
      const session = await getSession(req);
      if (!session) return res.status(401).json({ error: 'No autenticado' });

      // Self-service: a tenant's own admin can update its branding (name,
      // colors, logo) — nothing else, and only for their own tenant.
      if (req.method === 'PUT' && session.role === 'admin') {
        if (!id || id !== session.tenant_id) return res.status(403).json({ error: 'Solo puedes editar tu propio cliente' });
        const { name, color, color2, color3, logo_url } = req.body || {};
        const [tenant] = await sql`
          UPDATE tenants SET
            name     = COALESCE(${name     ?? null}, name),
            color    = COALESCE(${color    ?? null}, color),
            color2   = COALESCE(${color2   ?? null}, color2),
            color3   = COALESCE(${color3   ?? null}, color3),
            logo_url = COALESCE(${logo_url ?? null}, logo_url)
          WHERE id = ${id}
          RETURNING *
        `;
        if (!tenant) return res.status(404).json({ error: 'Cliente no encontrado' });
        return res.json(tenant);
      }

      if (!PLATFORM_ROLES.includes(session.role))
        return res.status(403).json({ error: 'Solo superadmin o master pueden gestionar clientes' });

      // GET — list all tenants with user count
      if (req.method === 'GET') {
        const rows = await sql`SELECT * FROM tenants ORDER BY name`;
        const enriched = await Promise.all(rows.map(async t => {
          const [{ uc }] = await sql`SELECT COUNT(*)::int AS uc FROM users WHERE tenant_id = ${t.id}`;
          return { ...t, users_count: uc };
        }));
        return res.json(enriched);
      }

      // Mutations: superadmin only
      if (session.role !== 'superadmin')
        return res.status(403).json({ error: 'Solo superadmin puede crear, editar o eliminar clientes' });

      // POST — create tenant
      if (req.method === 'POST') {
        const { name, slug, logo_url = '', logo_text = '', color = '#5b4fff', color2 = '#16c98d', color3 = '#4c3fff', plan = 'starter' } = req.body || {};
        if (!name) return res.status(400).json({ error: 'name es requerido' });
        if (!slug) return res.status(400).json({ error: 'slug es requerido' });
        if (!/^[a-z0-9-]{2,64}$/.test(slug)) return res.status(400).json({ error: 'El slug sólo admite letras minúsculas, números y guiones' });

        const [dup] = await sql`SELECT id FROM tenants WHERE slug = ${slug}`;
        if (dup) return res.status(409).json({ error: 'El slug ya está en uso' });

        const [{ max_num }] = await sql`
          SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 5) AS INTEGER)), 0) AS max_num
          FROM tenants WHERE id ~ '^TEN-[0-9]+$'
        `;
        const tenantId = 'TEN-' + String(parseInt(max_num) + 1).padStart(3, '0');

        const [tenant] = await sql`
          INSERT INTO tenants (id, name, slug, logo_url, logo_text, color, color2, color3, plan, created_by)
          VALUES (${tenantId}, ${name}, ${slug}, ${logo_url}, ${logo_text}, ${color}, ${color2}, ${color3}, ${plan}, ${session.username})
          RETURNING *
        `;
        return res.status(201).json({ ...tenant, users_count: 0 });
      }

      // PUT — update tenant
      if (req.method === 'PUT') {
        if (!id) return res.status(400).json({ error: 'id es requerido' });
        const { name, logo_url, logo_text, color, color2, color3, plan, status } = req.body || {};
        const [tenant] = await sql`
          UPDATE tenants SET
            name      = COALESCE(${name      ?? null}, name),
            logo_url  = COALESCE(${logo_url  ?? null}, logo_url),
            logo_text = COALESCE(${logo_text ?? null}, logo_text),
            color     = COALESCE(${color     ?? null}, color),
            color2    = COALESCE(${color2    ?? null}, color2),
            color3    = COALESCE(${color3    ?? null}, color3),
            plan      = COALESCE(${plan      ?? null}, plan),
            status    = COALESCE(${status    ?? null}, status)
          WHERE id = ${id}
          RETURNING *
        `;
        if (!tenant) return res.status(404).json({ error: 'Cliente no encontrado' });
        const [{ uc }] = await sql`SELECT COUNT(*)::int AS uc FROM users WHERE tenant_id = ${id}`;
        return res.json({ ...tenant, users_count: uc });
      }

      // DELETE — delete tenant
      if (req.method === 'DELETE') {
        if (!id) return res.status(400).json({ error: 'id es requerido' });
        if (id === 'TEN-001') return res.status(400).json({ error: 'No se puede eliminar el cliente Demo' });
        const [deleted] = await sql`DELETE FROM tenants WHERE id = ${id} RETURNING id, name`;
        if (!deleted) return res.status(404).json({ error: 'Cliente no encontrado' });
        return res.json({ ok: true, deleted: deleted.name });
      }
    }

    // ── MASTER USERS ──────────────────────────────────────────────────────
    if (action === 'master-users') {
      const session = await getSession(req);
      if (!session) return res.status(401).json({ error: 'No autenticado' });
      if (!PLATFORM_ROLES.includes(session.role))
        return res.status(403).json({ error: 'Acceso denegado' });

      // GET — list all master users (superadmin + master can view)
      if (req.method === 'GET') {
        const rows = await sql`
          SELECT id, username, email, display_name, role, status, created_at,
                 (reset_token IS NOT NULL AND reset_token_expires > NOW()) AS invite_pending
          FROM users
          WHERE role = 'master'
          ORDER BY created_at ASC
        `;
        return res.json(rows);
      }

      // Mutations: superadmin only (prevents privilege escalation)
      if (session.role !== 'superadmin')
        return res.status(403).json({ error: 'Solo superadmin puede gestionar usuarios master' });

      // POST — create master user + send invite
      if (req.method === 'POST' && !id) {
        const { username, email, display_name = '' } = req.body || {};
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
            ${placeholderHash}, 'master', 'pending_invite',
            ${inviteToken}, ${inviteExpires.toISOString()}, ''
          )
          RETURNING id, username, email, display_name, role, status, created_at
        `;

        const inviteUrl = `${APP_URL}/invite?token=${inviteToken}&u=${encodeURIComponent(username)}`;
        let invite_sent = false;
        let email_error = null;
        try {
          await sendEmail({
            to: email,
            subject: 'Invitación como Usuario Master — StockFlow',
            html: inviteEmailHtml({ username, display_name, inviteUrl, inviterName: session.username }),
            text: `Hola ${display_name || username}! Has sido invitado como Usuario Master de StockFlow. Crea tu contraseña aquí: ${inviteUrl}`,
          });
          invite_sent = true;
        } catch (e) {
          console.error('[master-users] email error:', e.message);
          email_error = e.message;
        }

        return res.status(201).json({ ...user, invite_sent, email_error, invite_token: inviteToken });
      }

      // POST ?id=...&action=resend — resend invite
      if (req.method === 'POST' && id) {
        const [user] = await sql`SELECT id, username, email, display_name FROM users WHERE id = ${id} AND role = 'master'`;
        if (!user) return res.status(404).json({ error: 'Usuario master no encontrado' });

        const inviteToken   = crypto.randomBytes(4).toString('hex').toUpperCase();
        const inviteExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await sql`UPDATE users SET reset_token = ${inviteToken}, reset_token_expires = ${inviteExpires.toISOString()}, status = 'pending_invite' WHERE id = ${id}`;

        const inviteUrl = `${APP_URL}/invite?token=${inviteToken}&u=${encodeURIComponent(user.username)}`;
        await sendEmail({
          to: user.email,
          subject: 'Nuevo enlace de invitación — StockFlow',
          html: inviteEmailHtml({ username: user.username, display_name: user.display_name, inviteUrl, inviterName: session.username }),
          text: `Nuevo enlace: ${inviteUrl}`,
        }).catch(() => {});

        return res.json({ ok: true, message: 'Invitación reenviada' });
      }

      // PUT — update display_name
      if (req.method === 'PUT' && id) {
        const { display_name } = req.body || {};
        const [user] = await sql`
          UPDATE users SET display_name = COALESCE(${display_name ?? null}, display_name)
          WHERE id = ${id} AND role = 'master'
          RETURNING id, username, email, display_name, role, status, created_at
        `;
        if (!user) return res.status(404).json({ error: 'Usuario master no encontrado' });
        return res.json(user);
      }

      // DELETE — remove master user
      if (req.method === 'DELETE' && id) {
        if (id === session.user_id) return res.status(400).json({ error: 'No puedes eliminarte a ti mismo' });
        await sql`DELETE FROM sessions WHERE user_id = ${id}`;
        const [deleted] = await sql`DELETE FROM users WHERE id = ${id} AND role = 'master' RETURNING id, username`;
        if (!deleted) return res.status(404).json({ error: 'Usuario master no encontrado' });
        return res.json({ ok: true, deleted: deleted.username });
      }
    }

    return res.status(404).json({ error: 'Unknown auth action' });
  } catch (err) {
    console.error(`auth/${action} error:`, err);
    return res.status(500).json({ error: err.message });
  }
};
