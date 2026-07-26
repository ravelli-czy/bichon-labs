// api/_db.js — Neon PostgreSQL client (singleton per cold-start)
const { neon } = require('@neondatabase/serverless');

let _sql;

function getDb() {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        'DATABASE_URL is not set. ' +
        'Add it to Vercel environment variables: vercel env add DATABASE_URL'
      );
    }
    _sql = neon(url);
  }
  return _sql;
}

module.exports = { getDb };
