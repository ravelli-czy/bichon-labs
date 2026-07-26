// api/logs.js — GET /api/logs (admin o superadmin, scoped to tenant)
// Query params: ?limit=100&offset=0&entity_type=orden&actor=admin
const { getDb } = require('./_db');
const cors      = require('./_cors');
const { getSession, resolveTenantId } = require('./_tenant');

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  let sql;
  try { sql = getDb(); } catch (e) { return res.status(503).json({ error: e.message }); }

  // ── Auth: admin o superadmin ──────────────────────────────────────────────
  const session  = await getSession(req);
  const tenantId = resolveTenantId(req, session);

  if (!session) return res.status(401).json({ error: 'No autenticado' });
  if (!['admin','superadmin','master'].includes(session.role))
    return res.status(403).json({ error: 'Solo administradores pueden ver los logs' });
  if (!tenantId)
    return res.status(400).json({ error: 'Sin contexto de cliente.' });

  const { entity_type, actor, limit = '60', offset = '0' } = req.query || {};
  const lim = Math.min(parseInt(limit) || 60, 500);
  const off = parseInt(offset) || 0;

  try {
    let rows, countRow;

    if (entity_type && actor) {
      rows     = await sql`SELECT * FROM audit_logs WHERE tenant_id = ${tenantId} AND entity_type = ${entity_type} AND actor = ${actor} ORDER BY created_at DESC LIMIT ${lim} OFFSET ${off}`;
      [countRow] = await sql`SELECT COUNT(*)::int AS total FROM audit_logs WHERE tenant_id = ${tenantId} AND entity_type = ${entity_type} AND actor = ${actor}`;
    } else if (entity_type) {
      rows     = await sql`SELECT * FROM audit_logs WHERE tenant_id = ${tenantId} AND entity_type = ${entity_type} ORDER BY created_at DESC LIMIT ${lim} OFFSET ${off}`;
      [countRow] = await sql`SELECT COUNT(*)::int AS total FROM audit_logs WHERE tenant_id = ${tenantId} AND entity_type = ${entity_type}`;
    } else if (actor) {
      rows     = await sql`SELECT * FROM audit_logs WHERE tenant_id = ${tenantId} AND actor = ${actor} ORDER BY created_at DESC LIMIT ${lim} OFFSET ${off}`;
      [countRow] = await sql`SELECT COUNT(*)::int AS total FROM audit_logs WHERE tenant_id = ${tenantId} AND actor = ${actor}`;
    } else {
      rows     = await sql`SELECT * FROM audit_logs WHERE tenant_id = ${tenantId} ORDER BY created_at DESC LIMIT ${lim} OFFSET ${off}`;
      [countRow] = await sql`SELECT COUNT(*)::int AS total FROM audit_logs WHERE tenant_id = ${tenantId}`;
    }

    return res.json({ rows, total: countRow?.total ?? 0, limit: lim, offset: off });
  } catch (err) {
    console.error('logs error:', err);
    return res.status(500).json({ error: err.message });
  }
};
