'use strict';

// Nightly / on-demand dump of the intl Postgres database.
 // Usage: INTL_DATABASE_URL=postgres://... node scripts/backup_intl.js
// Writes var/backups/intl-<stamp>.sql (or DATA_DIR/backups/). Never prints the URL.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function main() {
  const url = String(process.env.INTL_DATABASE_URL || process.env.DATABASE_URL || '').trim();
  if (!/^postgres(?:ql)?:\/\//i.test(url)) {
    console.error('intl_backup_missing_url');
    process.exit(1);
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    console.error('intl_backup_bad_url');
    process.exit(1);
  }
  const dataDir = process.env.DATA_DIR || 'var';
  const destDir = path.join(dataDir, 'backups');
  fs.mkdirSync(destDir, { recursive: true });
  const outFile = path.join(destDir, `intl-${stamp()}.sql`);
  const env = { ...process.env, PGPASSWORD: decodeURIComponent(parsed.password || '') };
  const args = [
    '-h', parsed.hostname,
    '-p', parsed.port || '5432',
    '-U', decodeURIComponent(parsed.username || 'intl'),
    '-d', (parsed.pathname || '/intl').replace(/^\//, '') || 'intl',
    '--no-password',
  ];
  let dump;
  try {
    dump = execFileSync('pg_dump', args, { encoding: 'utf8', timeout: 180000, env, maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    const code = err && err.status != null ? err.status : 'error';
    console.error(`intl_backup_failed status=${code}`);
    process.exit(1);
  }
  if (!dump || !/PostgreSQL database dump|CREATE /.test(dump)) {
    console.error('intl_backup_empty');
    process.exit(1);
  }
  if (env.PGPASSWORD && env.PGPASSWORD.length > 6 && dump.includes(env.PGPASSWORD)) {
    console.error('intl_backup_leaked_password');
    process.exit(1);
  }
  fs.writeFileSync(outFile, dump);
  console.log(`intl_backup_ok file=${path.basename(outFile)} bytes=${Buffer.byteLength(dump)}`);
}

if (require.main === module) main();

module.exports = { main };
