// api/_log.js — Audit log helper (shared module, not a serverless function)
const { getSession } = require('./_tenant');

async function getActor(req) {
  const session = await getSession(req);
  return session?.username || 'sistema';
}

async function writeLog(sql, {
  tenant_id   = '',
  actor       = 'sistema',
  action,
  entity_type = '',
  entity_id   = '',
  entity_name = '',
  details     = {},
}) {
  const id = 'LOG-' + Date.now().toString(36).toUpperCase()
           + Math.random().toString(36).slice(2, 6).toUpperCase();
  try {
    await sql`
      INSERT INTO audit_logs
        (id, tenant_id, actor, action, entity_type, entity_id, entity_name, details)
      VALUES
        (${id}, ${tenant_id}, ${actor}, ${action}, ${entity_type},
         ${entity_id}, ${entity_name}, ${JSON.stringify(details)})
    `;
  } catch (err) {
    console.error('[audit] write error:', err.message);
  }
}

module.exports = { writeLog, getActor };
