'use strict';

const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort } = require('worker_threads');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'db', 'migrations');
const HEADER_INTS = 4;
const BODY_OFFSET = HEADER_INTS * 4;
const DEFAULT_TIMEOUT_MS = process.env.PG_QUERY_TIMEOUT_MS
  ? Math.max(1000, Number(process.env.PG_QUERY_TIMEOUT_MS) || 15000)
  : 15000;

function toPg(sql) {
  let n = 0;
  let out = '';
  let i = 0;
  const text = String(sql);
  while (i < text.length) {
    if (text[i] === "'") {
      const start = i;
      i += 1;
      while (i < text.length) {
        if (text[i] === "'" && text[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (text[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      out += text.slice(start, i);
      continue;
    }
    if (text[i] === '?') {
      n += 1;
      out += `$${n}`;
      i += 1;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

function revive(value) {
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === 'object') {
    if (value.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data);
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = revive(item);
    return out;
  }
  return value;
}

function migrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{3}_intl(?:_[\w-]+)?\.sql$/i.test(name))
    .sort();
}

function migrationStatements(file) {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  return sql.split(/;\s*(?:\n|$)/).map((part) => part.trim()).filter(Boolean);
}

if (!isMainThread && parentPort) {
  const { Client } = require('pg');
  const headerOf = (sab) => new Int32Array(sab, 0, HEADER_INTS);
  const bodyOf = (sab) => new Uint8Array(sab, BODY_OFFSET);

  function finish(sab, seq, state, payload) {
    const header = headerOf(sab);
    if (seq != null && Atomics.load(header, 2) !== seq) return;
    const body = bodyOf(sab);
    let published = state;
    let raw = Buffer.from(JSON.stringify(payload));
    if (raw.length > body.length) {
      raw = Buffer.from(JSON.stringify({ message: 'result_too_large' }));
      published = 2;
    }
    if (seq != null && Atomics.load(header, 2) !== seq) return;
    body.set(raw, 0);
    if (seq != null && Atomics.load(header, 2) !== seq) return;
    Atomics.store(header, 1, raw.length);
    Atomics.store(header, 3, seq == null ? 0 : seq);
    Atomics.store(header, 0, published);
    Atomics.notify(header, 0);
  }

  function installParsers() {
    const { types } = require('pg');
    const asNumber = (val) => {
      const n = Number(val);
      return Number.isFinite(n) ? n : val;
    };
    types.setTypeParser(20, (val) => {
      const n = Number(val);
      return Number.isSafeInteger(n) ? n : val;
    });
    types.setTypeParser(700, asNumber);
    types.setTypeParser(701, asNumber);
    types.setTypeParser(1700, asNumber);
  }

  async function applyMigration(client) {
    await client.query(
      `CREATE TABLE IF NOT EXISTS i_schema_migrations (
         filename TEXT PRIMARY KEY,
         applied_at TEXT NOT NULL
       )`,
    );
    for (const file of migrationFiles()) {
      const seen = await client.query(
        'SELECT filename FROM i_schema_migrations WHERE filename = $1',
        [file],
      );
      if (seen.rows.length) continue;
      const statements = migrationStatements(file)
        .filter((statement) => !/CREATE TABLE IF NOT EXISTS i_schema_migrations/i.test(statement));
      await client.query('BEGIN');
      try {
        for (const statement of statements) await client.query(statement);
        await client.query(
          'INSERT INTO i_schema_migrations (filename, applied_at) VALUES ($1, $2)',
          [file, new Date().toISOString()],
        );
        await client.query('COMMIT');
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* the transaction is already closed */ }
        throw err;
      }
    }
  }

  let client = null;
  parentPort.on('message', async (msg) => {
    try {
      if (!msg || msg.type === 'close') {
        if (client) {
          try { await client.end(); } catch { /* already closed */ }
        }
        process.exit(0);
        return;
      }
      if (msg.type === 'init') {
        try {
          installParsers();
          client = new Client({ connectionString: msg.url });
          await client.connect();
          await applyMigration(client);
          finish(msg.sab, msg.seq, 1, { ok: true });
        } catch (err) {
          finish(msg.sab, msg.seq, 2, { message: err.message || 'intl_postgres_unavailable' });
        }
        return;
      }
      if (msg.type === 'query') {
        try {
          const result = await client.query(toPg(msg.sql), msg.params || []);
          finish(msg.sab, msg.seq, 1, { rows: result.rows || [], rowCount: result.rowCount || 0 });
        } catch (err) {
          finish(msg.sab, msg.seq, 2, { message: err.message || 'query_failed' });
        }
      }
    } catch (err) {
      if (msg && msg.sab) finish(msg.sab, msg.seq, 2, { message: err.message || 'query_failed' });
    }
  });
}

function readResult(sab, seq) {
  const header = new Int32Array(sab, 0, HEADER_INTS);
  const state = Atomics.load(header, 0);
  const replySeq = Atomics.load(header, 3);
  if (replySeq !== seq) {
    const error = new Error('intl_postgres_timeout');
    error.code = 'intl_postgres';
    throw error;
  }
  const length = Atomics.load(header, 1);
  const json = Buffer.from(sab, BODY_OFFSET, length).toString('utf8');
  const parsed = json ? JSON.parse(json) : null;
  Atomics.store(header, 0, 0);
  Atomics.store(header, 1, 0);
  if (state === 2) {
    const error = new Error((parsed && parsed.message) || 'query_failed');
    error.code = 'intl_postgres';
    throw error;
  }
  return revive(parsed);
}

const openStores = new Set();
let exitArmed = false;
function armStoreExit() {
  if (exitArmed) return;
  exitArmed = true;
  process.on('beforeExit', () => {
    for (const store of openStores) store.closing = true;
  });
}

class PgIntlStore {
  constructor(url) {
    this.url = url;
    this.file = '';
    this.seq = 0;
    this.closing = false;
    this.sab = new SharedArrayBuffer(BODY_OFFSET + (16 * 1024 * 1024));
    this.worker = new Worker(__filename);
    const failFast = () => {
      if (this.closing) return;
      console.error('intl_postgres_worker_failed');
      process.exit(1);
    };
    this.worker.on('error', failFast);
    this.worker.on('exit', (code) => {
      if (this.closing || code === 0) return;
      failFast();
    });
    openStores.add(this);
    armStoreExit();
    try {
      this.call({ type: 'init', url, sab: this.sab }, 20000);
    } catch (err) {
      this.closing = true;
      openStores.delete(this);
      try { this.worker.terminate(); } catch { /* already gone */ }
      const error = new Error(err.message || 'intl_postgres_unavailable');
      error.code = err.code || 'intl_postgres';
      throw error;
    }
  }

  call(msg, timeoutMs) {
    this.seq = (this.seq + 1) | 0;
    if (this.seq === 0) this.seq = 1;
    const seq = this.seq;
    const header = new Int32Array(this.sab, 0, HEADER_INTS);
    Atomics.store(header, 0, 0);
    Atomics.store(header, 1, 0);
    Atomics.store(header, 3, 0);
    Atomics.store(header, 2, seq);
    this.worker.postMessage({ ...msg, sab: this.sab, seq });
    const wait = Atomics.wait(header, 0, 0, timeoutMs || DEFAULT_TIMEOUT_MS);
    if (wait === 'timed-out' || Atomics.load(header, 0) === 0 || Atomics.load(header, 3) !== seq) {
      throw new Error('intl_postgres_timeout');
    }
    return readResult(this.sab, seq);
  }

  query(sql, params) {
    return this.call({ type: 'query', sql, params, sab: this.sab });
  }

  run(sql, params = []) {
    const result = this.query(sql, params);
    return { changes: result.rowCount || 0 };
  }

  one(sql, params = []) {
    const result = this.query(sql, params);
    return result.rows && result.rows[0] ? result.rows[0] : null;
  }

  all(sql, params = []) {
    const result = this.query(sql, params);
    return result.rows || [];
  }

  transaction(fn) {
    this.query('BEGIN');
    try {
      const result = fn();
      this.query('COMMIT');
      return result;
    } catch (err) {
      try { this.query('ROLLBACK'); } catch { /* already closed */ }
      throw err;
    }
  }

  close() {
    this.closing = true;
    openStores.delete(this);
    try { this.worker.postMessage({ type: 'close' }); } catch { /* worker already gone */ }
    this.worker.terminate();
  }
}

module.exports = { PgIntlStore, toPg };
