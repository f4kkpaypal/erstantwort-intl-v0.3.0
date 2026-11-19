'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../../core/config');
const { createIntl } = require('../../core/intl/service');

const NOW = new Date('2026-10-28T04:30:00.000Z');
const ONE_DAY = 86400000;

function openIntl() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intl-retention-'));
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

async function property(intl) {
  return intl.addProperty({
    id: 'P1',
    title: 'Marina Gate',
    kind: 'rent',
    price: 120000,
    currency: 'AED',
    price_period: 'year',
    tz: 'Asia/Dubai',
  }, '42');
}

function expire(intl, leadId) {
  intl.store.run('UPDATE i_lead SET retention_until = ? WHERE id = ?', ['2020-01-01T00:00:00.000Z', leadId]);
}

test('retention removes the Telegram chat id, the channel message id and the text', async () => {
  const api = openIntl();
  try {
    await property(api.intl);
    const lead = await api.intl.ingest({
      channel: 'telegram',
      sender_id: '7001',
      sender_name: 'Layla',
      text: 'Hello, is the flat still available?',
      property_id: 'P1',
      dedup_key: 'telegram:777000111:55',
      channel_msg_id: '55',
      reply_target: '777000111',
      fixture: true,
      broker_id: '42',
    });
    assert.equal(lead.stored, true);
    expire(api.intl, lead.lead_id);
    assert.equal(api.intl.retain(), 1);
    const message = api.intl.store.one('SELECT * FROM i_message WHERE lead_id = ?', [lead.lead_id]);
    assert.equal(message.text, '');
    assert.equal(message.deleted, 1);
    assert.equal(message.dedup_key, null);
    assert.equal(message.channel_msg_id, null);
    assert.equal(api.intl.store.one('SELECT COUNT(*) AS n FROM i_message WHERE dedup_key LIKE ?', ['telegram:%']).n, 0);
    const row = api.intl.store.one('SELECT sender_name, clean_name, reply_target FROM i_lead WHERE id = ?', [lead.lead_id]);
    assert.equal(row.sender_name, '');
    assert.equal(row.clean_name, '');
    assert.equal(row.reply_target, null);
  } finally {
    api.close();
  }
});

test('a new incoming message extends retention_until and keeps the conversation', async () => {
  const api = openIntl();
  try {
    await property(api.intl);
    const first = await api.intl.ingest({
      channel: 'wa_sim',
      sender_id: 'sim:extend',
      sender_name: 'Omar',
      text: 'Can I see it tomorrow?',
      property_id: 'P1',
      dedup_key: 'ret-extend-1',
      fixture: true,
      broker_id: '42',
    });
    expire(api.intl, first.lead_id);
    const second = await api.intl.ingest({
      channel: 'wa_sim',
      sender_id: 'sim:extend',
      sender_name: 'Omar',
      text: 'What is the price?',
      property_id: 'P1',
      dedup_key: 'ret-extend-2',
      fixture: true,
      broker_id: '42',
    });
    assert.equal(second.lead_id, first.lead_id);
    const until = Date.parse(api.intl.store.one('SELECT retention_until FROM i_lead WHERE id = ?', [first.lead_id]).retention_until);
    assert.ok(Number.isFinite(until), 'retention_until is set');
    assert.ok(until > NOW.getTime() + 29 * ONE_DAY, `retention_until extended: ${until}`);
    assert.equal(api.intl.retain(), 0);
    assert.equal(api.intl.store.one(`SELECT COUNT(*) AS n FROM i_message WHERE lead_id = ? AND text != ''`, [first.lead_id]).n, 2);
  } finally {
    api.close();
  }
});

test('a short acknowledgement also extends retention_until', async () => {
  const api = openIntl();
  try {
    await property(api.intl);
    const first = await api.intl.ingest({
      channel: 'wa_sim',
      sender_id: 'sim:ack',
      sender_name: 'Nina',
      text: 'Can I see it tomorrow?',
      property_id: 'P1',
      dedup_key: 'ret-ack-1',
      fixture: true,
      broker_id: '42',
    });
    expire(api.intl, first.lead_id);
    await api.intl.ingest({
      channel: 'wa_sim',
      sender_id: 'sim:ack',
      sender_name: 'Nina',
      text: 'ok',
      property_id: 'P1',
      dedup_key: 'ret-ack-2',
      fixture: true,
      broker_id: '42',
    });
    const until = Date.parse(api.intl.store.one('SELECT retention_until FROM i_lead WHERE id = ?', [first.lead_id]).retention_until);
    assert.ok(until > NOW.getTime() + 29 * ONE_DAY, 'retention_until extended by the short ack');
    assert.equal(api.intl.retain(), 0);
  } finally {
    api.close();
  }
});

test('an expired lead is still purged while a fresh one is untouched', async () => {
  const api = openIntl();
  try {
    await property(api.intl);
    const old = await api.intl.ingest({
      channel: 'wa_sim',
      sender_id: 'sim:old',
      sender_name: 'Old',
      text: 'Can I see it tomorrow?',
      property_id: 'P1',
      dedup_key: 'ret-old',
      fixture: true,
      broker_id: '42',
    });
    const fresh = await api.intl.ingest({
      channel: 'wa_sim',
      sender_id: 'sim:fresh',
      sender_name: 'Fresh',
      text: 'Can I see it tomorrow?',
      property_id: 'P1',
      dedup_key: 'ret-fresh',
      fixture: true,
      broker_id: '42',
    });
    expire(api.intl, old.lead_id);
    assert.equal(api.intl.retain(), 1);
    assert.equal(api.intl.store.one('SELECT dedup_key FROM i_message WHERE dedup_key = ?', ['ret-old']), null);
    assert.equal(api.intl.store.one('SELECT text FROM i_message WHERE lead_id = ?', [fresh.lead_id]).text, 'Can I see it tomorrow?');
    assert.equal(api.intl.store.one('SELECT retention_until FROM i_lead WHERE id = ?', [fresh.lead_id]).retention_until != null, true);
  } finally {
    api.close();
  }
});
