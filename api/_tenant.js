// api/_tenant.js — Multi-tenancy helpers (shared module, not a serverless function)
//
// getSession(req)               → { user_id, username, role, tenant_id } | null
//   Supports two auth methods:
//   1. Bearer token  (Authorization: Bearer <token>)
//   2. API key pair  (X-API-Key + X-API-Secret headers)
//
// resolveTenantId(req, session) → tenant_id string | null
//   - Regular users: their user.tenant_id
//   - Superadmin/master: X-Tenant-Id request header

const { getDb } = require('./_db');
const crypto    = require('crypto');

async function getSession(req) {
  // ── 1. Bearer token auth ─────────────────────────────────────────────────
  const authHeader = (req.headers.authorization || '');
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) {
      try {
        const sql = getDb();
        const [s] = await sql`
          SELECT s.user_id, s.username, u.role, u.tenant_id
          FROM sessions s
          JOIN users u ON u.id = s.user_id
          WHERE s.token = ${token} AND s.expires_at > NOW()
        `;
        if (s) return s;
      } catch { /* fall through to API key */ }
    }
  }

  // ── 2. API Key auth (X-API-Key + X-API-Secret) ───────────────────────────
  const apiKey    = (req.headers['x-api-key']    || '').trim();
  const apiSecret = (req.headers['x-api-secret'] || '').trim();
  if (apiKey && apiSecret) {
    try {
      const sql = getDb();
      const [keyRow] = await sql`
        SELECT ak.id AS ak_id, ak.key_secret_hash,
               u.id AS user_id, u.username, u.role, u.tenant_id
        FROM api_keys ak
        JOIN users u ON ak.user_id = u.id
        WHERE ak.key_id = ${apiKey} AND ak.status = 'active'
      `;
      if (!keyRow) return null;
      const secretHash = crypto.createHash('sha256').update(apiSecret).digest('hex');
      if (secretHash !== keyRow.key_secret_hash) return null;
      // Update last_used_at (fire-and-forget)
      sql`UPDATE api_keys SET last_used_at = NOW() WHERE id = ${keyRow.ak_id}`.catch(() => {});
      return {
        user_id:   keyRow.user_id,
        username:  keyRow.username,
        role:      keyRow.role,
        tenant_id: keyRow.tenant_id,
      };
    } catch { return null; }
  }

  return null;
}

function resolveTenantId(req, session) {
  if (!session) return null;
  // superadmin and master users use the X-Tenant-Id request header
  if (session.role === 'superadmin' || session.role === 'master') {
    return (req.headers['x-tenant-id'] || '').trim() || null;
  }
  return (session.tenant_id || '').trim() || null;
}

module.exports = { getSession, resolveTenantId };
