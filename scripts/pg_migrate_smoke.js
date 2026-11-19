'use strict';

// Offline smoke: migration files 002→006 exist, apply in order, and contain the
 // shapes the daily pilot needs. With INTL_DATABASE_URL set, also applies onto a
 // throwaway database and checks i_schema_migrations.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIGRATIONS = [
  '002_intl.sql',
  '003_intl_numeric.sql',
  '004_intl_desk.sql',
  '005_intl_viewing_unique.sql',
  '006_intl_property_profile.sql',
  '007_intl_team.sql',
];

function readMigration(name) {
  const file = path.join(ROOT, 'db', 'migrations', name);
  if (!fs.existsSync(file)) throw new Error(`missing_migration:${name}`);
  return fs.readFileSync(file, 'utf8');
}

function smokeFiles() {
  const texts = {};
  for (const name of MIGRATIONS) texts[name] = readMigration(name);
  if (!/CREATE TABLE IF NOT EXISTS i_lead/.test(texts['002_intl.sql'])) throw new Error('002_missing_i_lead');
  if (!/DOUBLE PRECISION/.test(texts['002_intl.sql']) && !/DOUBLE PRECISION/.test(texts['003_intl_numeric.sql'])) {
    throw new Error('numeric_columns_missing');
  }
  if (!/i_viewing_lead_slot_active/.test(texts['005_intl_viewing_unique.sql'])) {
    throw new Error('005_missing_unique_index');
  }
  if (!/listing_url|brochure_url|bedrooms/.test(texts['006_intl_property_profile.sql'])) {
    throw new Error('006_missing_property_profile');
  }
  if (!/i_team_member/.test(texts['007_intl_team.sql'])) {
    throw new Error('007_missing_i_team_member');
  }
  return { ok: true, files: MIGRATIONS.length };
}

async function smokeLive(url) {
  const { Client } = require('pg');
  const { PgIntlStore } = require('../core/intl/storePg');
  const name = `intl_smoke_${Date.now()}`;
  const admin = new Client({ connectionString: url });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const migUrl = new URL(url);
  migUrl.pathname = `/${name}`;
  const store = new PgIntlStore(migUrl.toString());
  try {
    for (const file of MIGRATIONS) {
      const row = store.one('SELECT filename FROM i_schema_migrations WHERE filename = ?', [file]);
      if (!row || row.filename !== file) throw new Error(`not_applied:${file}`);
    }
    store.run(
      `INSERT INTO i_property (id, title, kind, price, currency, price_period, tz, active, created_at)
       VALUES ('P-smoke', 'Smoke', 'sale', 1, 'AED', 'sale', 'Asia/Dubai', 1, ?)`,
      [new Date().toISOString()],
    );
    const row = store.one('SELECT id FROM i_property WHERE id = ?', ['P-smoke']);
    if (!row) throw new Error('insert_failed');
    return { ok: true, database: name, applied: MIGRATIONS.length };
  } finally {
    store.close();
  }
}

async function main() {
  const files = smokeFiles();
  console.log(`migrate_smoke_files ok=${files.ok} count=${files.files}`);
  const url = String(process.env.INTL_DATABASE_URL || '').trim();
  if (!url) {
    console.log('migrate_smoke_live skipped=no_url');
    return;
  }
  const live = await smokeLive(url);
  console.log(`migrate_smoke_live ok=${live.ok} applied=${live.applied}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.message ? err.message : 'migrate_smoke_failed');
    process.exit(1);
  });
}

module.exports = { smokeFiles, smokeLive, MIGRATIONS };
