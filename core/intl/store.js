'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { intlDatabaseUrl } = require('../config');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS i_property (
  id TEXT PRIMARY KEY, title TEXT, kind TEXT, price INTEGER, currency TEXT, price_period TEXT,
  tz TEXT, tz_label_en TEXT, tz_label_ru TEXT, area_value INTEGER, area_unit TEXT,
  ref_en TEXT, ref_ru TEXT, price_en TEXT, price_ru TEXT, facts TEXT, active INTEGER, created_at TEXT
);
CREATE TABLE IF NOT EXISTS i_slot (
  id TEXT PRIMARY KEY, property_id TEXT, start_utc TEXT, duration_min INTEGER, status TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS i_lead (
  id TEXT PRIMARY KEY, channel TEXT, sender_hash TEXT, sender_name TEXT, reply_target TEXT, property_id TEXT,
  language TEXT, intent TEXT, also_json TEXT, asks_discount INTEGER, budget_amount INTEGER, budget_currency TEXT,
  budget_period TEXT, timing_class TEXT, timing_label TEXT, cash INTEGER, flags TEXT, non_text_type TEXT,
  score INTEGER, grade TEXT, reasons TEXT, analysis_source TEXT, status TEXT, pipeline TEXT, optout INTEGER DEFAULT 0,
  first_msg_at TEXT, last_msg_at TEXT, last_inbound_message_id TEXT, retention_until TEXT, business_connection_id TEXT,
  clean_name TEXT, readiness TEXT, proposed_utc TEXT, broker_id TEXT, last_client_at TEXT,
  UNIQUE(channel, sender_hash, property_id)
);
CREATE TABLE IF NOT EXISTS i_message (
  id TEXT PRIMARY KEY, lead_id TEXT, direction TEXT, text TEXT, kind TEXT, channel_msg_id TEXT,
  dedup_key TEXT UNIQUE, option_id TEXT, edited INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0, created_at TEXT
);
CREATE TABLE IF NOT EXISTS i_draft (
  lead_id TEXT PRIMARY KEY, option_id TEXT, text TEXT, slot_ids TEXT, edited INTEGER, version INTEGER, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS i_send (
  send_id TEXT PRIMARY KEY, lead_id TEXT, reply_to_message_id TEXT, draft_hash TEXT, manual INTEGER,
  idempotency_key TEXT UNIQUE, status TEXT, fail_reason TEXT, channel TEXT, response TEXT, created_at TEXT, updated_at TEXT,
  UNIQUE(lead_id, reply_to_message_id, draft_hash)
);
CREATE TABLE IF NOT EXISTS i_idem (key TEXT PRIMARY KEY, route TEXT, response TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS i_viewing (
  id TEXT PRIMARY KEY, lead_id TEXT, property_id TEXT, slot_id TEXT, start_utc TEXT, status TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS i_optout (channel TEXT, sender_hash TEXT, created_at TEXT, PRIMARY KEY(channel, sender_hash));
CREATE TABLE IF NOT EXISTS i_tg_conn (
  business_connection_id TEXT PRIMARY KEY, can_reply INTEGER, is_enabled INTEGER, updated_at TEXT,
  user_id TEXT, user_chat_id TEXT, broker_id TEXT, rights_json TEXT
);
CREATE TABLE IF NOT EXISTS i_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, actor TEXT, action TEXT, lead_id TEXT, meta TEXT
);
CREATE TABLE IF NOT EXISTS i_settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS i_file (
  id TEXT PRIMARY KEY,
  property_id TEXT,
  kind TEXT,
  mime TEXT,
  name TEXT,
  bytes BLOB,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS i_time_hold (
  broker_key TEXT NOT NULL,
  start_utc TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  first_msg_at TEXT,
  competition_due_at TEXT,
  PRIMARY KEY (broker_key, start_utc)
);
CREATE TABLE IF NOT EXISTS i_tg_update (update_id INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS i_team_member (
  owner_broker_id TEXT NOT NULL,
  member_telegram_id TEXT NOT NULL,
  role TEXT NOT NULL,
  invite_token_hash TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  PRIMARY KEY (owner_broker_id, member_telegram_id)
);
`;

function ensureColumn(db, table, name, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((col) => col.name === name)) db.exec(ddl);
}

class IntlStore {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
    ensureColumn(this.db, 'i_lead', 'readiness', 'ALTER TABLE i_lead ADD COLUMN readiness TEXT');
    ensureColumn(this.db, 'i_lead', 'proposed_utc', 'ALTER TABLE i_lead ADD COLUMN proposed_utc TEXT');
    ensureColumn(this.db, 'i_lead', 'client_confirmed', 'ALTER TABLE i_lead ADD COLUMN client_confirmed INTEGER DEFAULT 0');
    ensureColumn(this.db, 'i_lead', 'broker_id', 'ALTER TABLE i_lead ADD COLUMN broker_id TEXT');
    ensureColumn(this.db, 'i_lead', 'last_client_at', 'ALTER TABLE i_lead ADD COLUMN last_client_at TEXT');
    ensureColumn(this.db, 'i_tg_conn', 'user_id', 'ALTER TABLE i_tg_conn ADD COLUMN user_id TEXT');
    ensureColumn(this.db, 'i_tg_conn', 'user_chat_id', 'ALTER TABLE i_tg_conn ADD COLUMN user_chat_id TEXT');
    ensureColumn(this.db, 'i_tg_conn', 'broker_id', 'ALTER TABLE i_tg_conn ADD COLUMN broker_id TEXT');
    ensureColumn(this.db, 'i_tg_conn', 'rights_json', 'ALTER TABLE i_tg_conn ADD COLUMN rights_json TEXT');
    ensureColumn(this.db, 'i_property', 'photos', 'ALTER TABLE i_property ADD COLUMN photos TEXT');
    for (const [name, type] of [
      ['address', 'TEXT'],
      ['district', 'TEXT'],
      ['bedrooms', 'INTEGER'],
      ['listing_url', 'TEXT'],
      ['brochure_url', 'TEXT'],
      ['plan_url', 'TEXT'],
      ['meeting_point', 'TEXT'],
      ['access_notes', 'TEXT'],
    ]) {
      ensureColumn(this.db, 'i_property', name, `ALTER TABLE i_property ADD COLUMN ${name} ${type}`);
    }
    ensureColumn(this.db, 'i_draft', 'attachments', 'ALTER TABLE i_draft ADD COLUMN attachments TEXT');
    ensureColumn(this.db, 'i_time_hold', 'competition_due_at', 'ALTER TABLE i_time_hold ADD COLUMN competition_due_at TEXT');
    ensureColumn(this.db, 'i_property', 'broker_id', 'ALTER TABLE i_property ADD COLUMN broker_id TEXT');
    this.db.exec(`CREATE TABLE IF NOT EXISTS i_followup (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      broker_id TEXT,
      due_at TEXT NOT NULL,
      kind TEXT,
      note TEXT,
      status TEXT,
      created_at TEXT
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS i_team_member (
      owner_broker_id TEXT NOT NULL,
      member_telegram_id TEXT NOT NULL,
      role TEXT NOT NULL,
      invite_token_hash TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      accepted_at TEXT,
      PRIMARY KEY (owner_broker_id, member_telegram_id)
    )`);
    try {
      this.db.exec(`CREATE INDEX IF NOT EXISTS i_team_member_member
        ON i_team_member (member_telegram_id, status)`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS i_team_member_owner
        ON i_team_member (owner_broker_id, status)`);
    } catch { /* index already exists */ }
    // One active booking per (lead_id, slot_id). The index is partial on purpose:
    // cancelled rows stay in the table, so the same lead may book the same slot
    // again after a cancellation. Fresh databases get the index unconditionally;
    // older databases may hold duplicates from the pre-atomic booking path, so the
    // surplus rows are removed first. Neither step may abort the boot.
    try {
      // Keep a confirmed row over an unconfirmed duplicate: the confirmed one is
      // the reservation the broker actually acted on.
      this.db.exec(`DELETE FROM i_viewing
        WHERE status = 'unconfirmed'
          AND EXISTS (
            SELECT 1 FROM i_viewing c
            WHERE c.status = 'confirmed'
              AND c.lead_id = i_viewing.lead_id
              AND c.slot_id = i_viewing.slot_id
              AND c.rowid <> i_viewing.rowid
          )`);
      this.db.exec(`DELETE FROM i_viewing
        WHERE status <> 'cancelled'
          AND rowid NOT IN (
            SELECT MIN(rowid) FROM i_viewing
            WHERE status <> 'cancelled'
            GROUP BY lead_id, slot_id
          )`);
    } catch { /* nothing to dedupe */ }
    try {
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS i_viewing_lead_slot_active
        ON i_viewing (lead_id, slot_id) WHERE status <> 'cancelled'`);
    } catch {
      // A legacy table with unrepairable duplicates keeps working; bookViewing still
      // claims the slot with a conditional UPDATE in a transaction.
    }
  }

  run(sql, params = []) { return this.db.prepare(sql).run(...params); }
  one(sql, params = []) { return this.db.prepare(sql).get(...params) || null; }
  all(sql, params = []) { return this.db.prepare(sql).all(...params); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* the transaction is already closed */ }
      throw err;
    }
  }
  close() { this.db.close(); }
}

function openIntlStore(config, options = {}) {
  if (options.store) return options.store;
  const url = intlDatabaseUrl(config);
  if (url && !options.file) {
    const { PgIntlStore } = require('./storePg');
    return new PgIntlStore(url);
  }
  const file = options.file || path.join(config.DATA_DIR || 'var', 'intl.sqlite');
  return new IntlStore(file);
}

module.exports = { IntlStore, SCHEMA, openIntlStore };
