'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../../core/config');
const { createIntl } = require('../../core/intl/service');
const { IntlStore } = require('../../core/intl/store');

const NOW = new Date('2026-10-28T04:30:00.000Z');
const SLOT_P1 = '2026-10-29T13:00:00.000Z';
const SLOT_P2 = '2026-10-30T13:00:00.000Z';

function openIntl() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intl-booking-'));
  const config = loadConfig({
    PRODUCT_MODE: 'intl',
    CHANNEL_MODE: 'sim',
    HASH_SALT: 'intl-test-salt',
    ENGINE_TOKEN: 'intl-engine-token-0123456789',
    TELEGRAM_BOT_TOKEN: '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    TELEGRAM_ALLOWED_USER_IDS: '42',
    DATA_DIR: dir,
    UI_PUBLIC_BASE: 'http://127.0.0.1:8791',
    REAL_DATA_ALLOWED: 'false',
    DEMO_UI_NO_AUTH: 'false',
    BROKER_TZ: 'Asia/Dubai',
  });
  const intl = createIntl(config, { file: path.join(dir, 'intl.sqlite'), clock: () => NOW });
  return {
    dir,
    config,
    intl,
    close() {
      intl.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function property(intl, id, title) {
  return intl.addProperty({
    id,
    title,
    kind: 'rent',
    price: 120000,
    currency: 'AED',
    price_period: 'year',
    tz: 'Asia/Dubai',
  }, '42');
}

async function slot(intl, propertyId, start) {
  return intl.addSlot(propertyId, { start_utc: start }, '42');
}

function ask(intl, sender, propertyId = 'P1') {
  return intl.ingest({
    channel: 'wa_sim',
    sender_id: sender,
    sender_name: sender,
    text: 'Can I see it tomorrow?',
    property_id: propertyId,
    dedup_key: `booking-${sender}`,
    fixture: true,
    broker_id: '42',
  });
}

function counts(intl) {
  return {
    viewings: intl.store.one('SELECT COUNT(*) AS n FROM i_viewing').n,
    audits: intl.store.one('SELECT COUNT(*) AS n FROM i_audit').n,
  };
}

test('two leads cannot take the same slot: one ok, the other 409 slot_unavailable', async () => {
  const api = openIntl();
  try {
    await property(api.intl, 'P1', 'Marina Gate');
    const s = await slot(api.intl, 'P1', SLOT_P1);
    assert.equal(s.ok, true);
    const leadA = await ask(api.intl, 'sim:first');
    const leadB = await ask(api.intl, 'sim:second');
    const first = await api.intl.book(leadA.lead_id, s.id, '42');
    assert.equal(first.ok, true);
    assert.equal(first.status, 'unconfirmed');
    const second = await api.intl.book(leadB.lead_id, s.id, '42');
    assert.equal(second.ok, false);
    assert.equal(second.status, 409);
    assert.equal(second.error_code, 'slot_unavailable');
    assert.equal(counts(api.intl).viewings, 1);
    assert.equal(api.intl.store.one('SELECT status FROM i_slot WHERE id = ?', [s.id]).status, 'booked');
  } finally {
    api.close();
  }
});

test('booking the same slot for the same lead twice returns the existing reservation', async () => {
  const api = openIntl();
  try {
    await property(api.intl, 'P1', 'Marina Gate');
    const s = await slot(api.intl, 'P1', SLOT_P1);
    const lead = await ask(api.intl, 'sim:repeat');
    const first = await api.intl.book(lead.lead_id, s.id, '42');
    const again = await api.intl.book(lead.lead_id, s.id, '42');
    assert.equal(again.ok, true);
    assert.equal(again.reused, true);
    assert.equal(again.id, first.id);
    assert.equal(counts(api.intl).viewings, 1);
    assert.equal(api.intl.store.one('SELECT COUNT(*) AS n FROM i_viewing WHERE lead_id = ? AND slot_id = ?', [lead.lead_id, s.id]).n, 1);
  } finally {
    api.close();
  }
});

test('a lead cannot book a slot of another property', async () => {
  const api = openIntl();
  try {
    await property(api.intl, 'P1', 'Marina Gate');
    await property(api.intl, 'P2', 'Business Bay');
    const foreign = await slot(api.intl, 'P2', SLOT_P2);
    const lead = await ask(api.intl, 'sim:foreign');
    const booked = await api.intl.book(lead.lead_id, foreign.id, '42');
    assert.equal(booked.ok, false);
    assert.equal(booked.status, 409);
    assert.equal(booked.error_code, 'slot_property_mismatch');
    assert.equal(counts(api.intl).viewings, 0);
    assert.equal(api.intl.store.one('SELECT status FROM i_slot WHERE id = ?', [foreign.id]).status, 'free');
  } finally {
    api.close();
  }
});

test('confirm is idempotent and only an unconfirmed viewing can be confirmed', async () => {
  const api = openIntl();
  try {
    await property(api.intl, 'P1', 'Marina Gate');
    const s = await slot(api.intl, 'P1', SLOT_P1);
    const lead = await ask(api.intl, 'sim:confirm');
    const booked = await api.intl.book(lead.lead_id, s.id, '42');
    const first = await api.intl.setViewing(booked.id, 'confirmed', '42');
    assert.equal(first.ok, true);
    assert.equal(first.status, 'confirmed');
    const again = await api.intl.setViewing(booked.id, 'confirmed', '42');
    assert.equal(again.ok, true);
    assert.equal(again.status, 'confirmed');
    assert.equal(api.intl.store.one('SELECT status FROM i_viewing WHERE id = ?', [booked.id]).status, 'confirmed');
    assert.equal(api.intl.store.one('SELECT client_confirmed FROM i_lead WHERE id = ?', [lead.lead_id]).client_confirmed, 1);
    assert.equal(api.intl.store.one('SELECT status FROM i_slot WHERE id = ?', [s.id]).status, 'booked');
    // The slot reserved by this lead stays acceptable for its own reply flow.
    const reread = await api.intl.book(lead.lead_id, s.id, '42');
    assert.equal(reread.ok, true);
    assert.equal(reread.status, 'confirmed');
    assert.equal(counts(api.intl).viewings, 1);
  } finally {
    api.close();
  }
});

test('cancel frees the slot and the same lead can book it again', async () => {
  const api = openIntl();
  try {
    await property(api.intl, 'P1', 'Marina Gate');
    const s = await slot(api.intl, 'P1', SLOT_P1);
    const lead = await ask(api.intl, 'sim:cancel');
    const booked = await api.intl.book(lead.lead_id, s.id, '42');
    const cancelled = await api.intl.setViewing(booked.id, 'cancelled', '42');
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(api.intl.store.one('SELECT status FROM i_slot WHERE id = ?', [s.id]).status, 'free');
    const rebooked = await api.intl.book(lead.lead_id, s.id, '42');
    assert.equal(rebooked.ok, true);
    assert.notEqual(rebooked.id, booked.id);
    assert.equal(api.intl.store.one('SELECT status FROM i_slot WHERE id = ?', [s.id]).status, 'booked');
    assert.equal(
      api.intl.store.one(`SELECT COUNT(*) AS n FROM i_viewing WHERE lead_id = ? AND slot_id = ? AND status != 'cancelled'`, [lead.lead_id, s.id]).n,
      1,
    );
    // A cancelled reservation cannot be confirmed afterwards.
    const confirmed = await api.intl.setViewing(booked.id, 'confirmed', '42');
    assert.equal(confirmed.ok, false);
    assert.equal(confirmed.status, 409);
    assert.equal(confirmed.error_code, 'invalid_transition');
    assert.equal(api.intl.store.one('SELECT status FROM i_viewing WHERE id = ?', [booked.id]).status, 'cancelled');
  } finally {
    api.close();
  }
});

test('cancelling one viewing never frees a slot held by another lead', async () => {
  const api = openIntl();
  try {
    await property(api.intl, 'P1', 'Marina Gate');
    const s = await slot(api.intl, 'P1', SLOT_P1);
    const leadA = await ask(api.intl, 'sim:holder');
    const leadB = await ask(api.intl, 'sim:other');
    const booked = await api.intl.book(leadA.lead_id, s.id, '42');
    // Simulate an inconsistent old row: a second active viewing on the same slot.
    api.intl.store.run('DROP INDEX IF EXISTS i_viewing_lead_slot_active');
    api.intl.store.run(
      `INSERT INTO i_viewing (id, lead_id, property_id, slot_id, start_utc, status, created_at) VALUES ('V-old', ?, 'P1', ?, ?, 'unconfirmed', ?)`,
      [leadB.lead_id, s.id, SLOT_P1, NOW.toISOString()],
    );
    const cancelled = await api.intl.setViewing(booked.id, 'cancelled', '42');
    assert.equal(cancelled.ok, true);
    assert.equal(api.intl.store.one('SELECT status FROM i_slot WHERE id = ?', [s.id]).status, 'booked');
    api.intl.store.run('DELETE FROM i_viewing WHERE id = ?', ['V-old']);
  } finally {
    api.close();
  }
});

test('a legacy sqlite database is deduped and indexed on open instead of failing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intl-legacy-'));
  const file = path.join(dir, 'intl.sqlite');
  try {
    const first = new IntlStore(file);
    first.db.exec('DROP INDEX IF EXISTS i_viewing_lead_slot_active');
    first.db.exec(
      `INSERT INTO i_viewing (id, lead_id, property_id, slot_id, start_utc, status, created_at) VALUES
       ('V1', 'L1', 'P1', 'S1', '2026-10-29T13:00:00.000Z', 'unconfirmed', '2026-10-28'),
       ('V2', 'L1', 'P1', 'S1', '2026-10-29T13:00:00.000Z', 'confirmed', '2026-10-28')`,
    );
    first.close();
    const reopened = new IntlStore(file);
    try {
      const rows = reopened.all('SELECT id, status FROM i_viewing');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'confirmed');
      assert.throws(
        () => reopened.run(`INSERT INTO i_viewing (id, lead_id, property_id, slot_id, start_utc, status, created_at)
          VALUES ('V3', 'L1', 'P1', 'S1', '2026-10-29T13:00:00.000Z', 'unconfirmed', '2026-10-28')`),
        /UNIQUE/i,
      );
      // A cancelled row stays outside the index, so the pair can be reused.
      reopened.run(`UPDATE i_viewing SET status = 'cancelled' WHERE id = ?`, [rows[0].id]);
      reopened.run(`INSERT INTO i_viewing (id, lead_id, property_id, slot_id, start_utc, status, created_at)
        VALUES ('V4', 'L1', 'P1', 'S1', '2026-10-29T13:00:00.000Z', 'unconfirmed', '2026-10-28')`);
      assert.equal(reopened.all('SELECT id FROM i_viewing').length, 2);
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the postgres migration ships the same partial unique index', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'migrations', '005_intl_viewing_unique.sql'), 'utf8');
  assert.match(sql, /DELETE FROM i_viewing/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS i_viewing_lead_slot_active/i);
  assert.match(sql, /WHERE status <> 'cancelled'/i);
  // Same splitter as core/intl/storePg.js: the migration runner must see exactly
  // two statements, both terminated, with no comment fragment leaking into SQL.
  const stripped = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  const statements = stripped.split(/;\s*(?:\n|$)/).map((part) => part.trim()).filter(Boolean);
  assert.equal(statements.length, 3);
  assert.match(statements[0], /^DELETE FROM i_viewing u/);
  assert.match(statements[1], /^DELETE FROM i_viewing a/);
  assert.match(statements[2], /^CREATE UNIQUE INDEX/);
});
