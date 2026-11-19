'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, channelModeOf } = require('../../core/config');
const { classifyReadiness } = require('../../core/intl/readiness');
const { createIntl, LEAD_STATUSES, VIEWING_STATUSES } = require('../../core/intl/service');
const { WEBHOOK_UPDATES } = require('../../core/intl/telegramSend');
const { toPg } = require('../../core/intl/storePg');
const { signInitData } = require('../../core/uiAuth');
const { buildIntlServer, bootError } = require('../../engine/intlServer');

const NOW = new Date('2026-10-28T04:30:00.000Z');

const PG_TABLES = [
  'i_time_hold', 'i_audit', 'i_idem', 'i_message', 'i_draft', 'i_send', 'i_viewing',
  'i_slot', 'i_tg_update', 'i_tg_conn', 'i_lead', 'i_file', 'i_property', 'i_optout', 'i_settings',
];

function openIntl(extra = {}, hooks = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-'));
  const pgUrl = String(process.env.INTL_DATABASE_URL || '').trim();
  const config = loadConfig({
    PRODUCT_MODE: 'intl',
    CHANNEL_MODE: 'sim',
    HASH_SALT: 'intl-test-salt',
    ENGINE_TOKEN: 'intl-engine-token-0123456789',
    TELEGRAM_BOT_TOKEN: '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    TELEGRAM_ALLOWED_USER_IDS: '42',
    TELEGRAM_WEBHOOK_SECRET: 'hook-secret',
    TG_TEST_LEAD_IDS: '9300000001',
    DATA_DIR: dir,
    UI_PUBLIC_BASE: 'http://127.0.0.1:8791',
    REAL_DATA_ALLOWED: 'false',
    DEMO_UI_NO_AUTH: 'false',
    BROKER_TZ: 'Asia/Dubai',
    ...(pgUrl ? { INTL_DATABASE_URL: pgUrl, DATABASE_URL: pgUrl } : {}),
    ...extra,
  });
  const intl = createIntl(config, {
    ...(pgUrl ? {} : { file: path.join(dir, 'intl.sqlite') }),
    clock: () => NOW,
    fetch: hooks.fetch,
  });
  if (pgUrl) {
    for (const table of PG_TABLES) intl.store.run(`DELETE FROM ${table}`);
  }
  return { dir, config, intl };
}

async function property(intl) {
  return intl.addProperty({
    id: 'P1', title: 'Marina Gate', kind: 'rent', price: 120000, currency: 'AED', price_period: 'year', tz: 'Asia/Dubai',
  }, '42');
}

function conn(id, userId = 42, rights = { can_reply: true }) {
  return {
    business_connection: {
      id,
      is_enabled: true,
      rights,
      user: { id: userId },
      user_chat_id: 7000 + Number(userId),
    },
  };
}

function business(id, messageId, text, extra = {}) {
  return {
    update_id: extra.update_id,
    business_message: {
      message_id: messageId,
      chat: { id: extra.chatId || 555001, type: 'private' },
      text,
      date: extra.date || Math.floor(NOW.getTime() / 1000),
      business_connection_id: id,
      from: extra.from || { id: extra.chatId || 555001, first_name: 'Nina' },
      ...extra.message,
    },
  };
}

test('channel mode accepts live, aliases test_live, and defaults to sim', () => {
  assert.equal(channelModeOf(undefined), 'sim');
  assert.equal(channelModeOf('live'), 'live');
  assert.equal(channelModeOf('test_live'), 'live');
  assert.equal(channelModeOf('nope'), 'invalid');
  assert.equal(loadConfig({ CHANNEL_MODE: 'live' }).CHANNEL_MODE, 'live');
  assert.equal(loadConfig({ CHANNEL_MODE: 'test_live' }).CHANNEL_MODE, 'live');
  assert.equal(loadConfig({}).INTL_LIVE_AUTOSEND, false);
  assert.equal(loadConfig({}).MAX_REPLIES_PER_CHAT_HOUR, 20);
  const liveBase = {
    PRODUCT_MODE: 'intl',
    CHANNEL_MODE: 'live',
    HASH_SALT: 'intl-test-salt-value',
    REAL_DATA_ALLOWED: 'false',
    INTL_DATABASE_URL: 'postgres://localhost/intl',
    TELEGRAM_BOT_TOKEN: '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    TELEGRAM_WEBHOOK_SECRET: 'hook-secret',
    TELEGRAM_ALLOWED_USER_IDS: '42',
  };
  assert.equal(bootError(loadConfig({
    PRODUCT_MODE: 'intl',
    CHANNEL_MODE: 'live',
    HASH_SALT: 'intl-test-salt-value',
    REAL_DATA_ALLOWED: 'false',
  })), 'postgres_required');
  assert.equal(bootError(loadConfig({ ...liveBase, TELEGRAM_BOT_TOKEN: '' })), 'telegram_token_missing');
  assert.equal(bootError(loadConfig({ ...liveBase, TELEGRAM_WEBHOOK_SECRET: 'bad secret' })), 'webhook_secret_invalid');
  assert.equal(bootError(loadConfig({ ...liveBase, TELEGRAM_ALLOWED_USER_IDS: '' })), 'telegram_allowlist_missing');
  // Live means real people, and real people mean real data: both opt-ins are required.
  assert.equal(bootError(loadConfig(liveBase)), 'real_data_required_for_live');
  assert.equal(bootError(loadConfig({ ...liveBase, REAL_DATA_ALLOWED: 'true', ALLOW_REAL_DATA: 'true' })), '');
  assert.equal(bootError(loadConfig({ ...liveBase, REAL_DATA_ALLOWED: 'true' })), 'real_data_blocked');
});

test('readiness does not mark negations, sea view, or a money figure as HOT', () => {
  for (const text of ['not urgent', 'не срочно', 'no rush', 'sea view', 'virtual tour', 'budget 2.5 million AED', 'today']) {
    assert.notEqual(classifyReadiness(text).label, 'HOT', text);
  }
  assert.equal(classifyReadiness('want to view tomorrow').label, 'HOT');
  assert.equal(classifyReadiness('can I view tomorrow').label, 'HOT');
  assert.equal(classifyReadiness('أريد معاينة غدا').label, 'HOT');
  assert.equal(classifyReadiness('Yarın evi görmek istiyorum').label, 'HOT');
  assert.equal(classifyReadiness('👍').label, 'COLD');
  assert.equal(classifyReadiness('STOP', { intent: 'stop' }).label, 'COLD');
});

test('a business message becomes a lead and the broker, the bot, and offline text do not', async () => {
  const { intl } = openIntl();
  await property(intl);
  await intl.telegram(conn('bc1'));
  const lead = await intl.telegram(business('bc1', 1, 'Can I view tomorrow?'));
  assert.equal(lead.stored, true);
  assert.equal(intl.lead(lead.lead_id).broker_id, '42');
  assert.equal(intl.lead(lead.lead_id).readiness, 'HOT');
  const broker = await intl.telegram(business('bc1', 2, 'I will reply myself', { from: { id: 42, first_name: 'Broker' }, chatId: 555001 }));
  assert.equal(broker.stored, false);
  const bot = await intl.telegram(business('bc1', 3, 'auto', { message: { sender_business_bot: { id: 9 } }, chatId: 555002 }));
  assert.equal(bot.stored, false);
  const offline = await intl.telegram(business('bc1', 4, 'away', { message: { is_from_offline: true }, chatId: 555003 }));
  assert.equal(offline.stored, false);
  const robot = await intl.telegram(business('bc1', 5, 'bot', { from: { id: 8, is_bot: true }, chatId: 555004 }));
  assert.equal(robot.stored, false);
  assert.equal(intl.store.one(`SELECT COUNT(*) AS n FROM i_lead`).n, 1);
  intl.close();
});

test('webhook duplicates and a retry before update_id create one lead', async () => {
  const { intl } = openIntl();
  await property(intl);
  await intl.telegram(conn('bc1'));
  const first = await intl.telegram({ ...business('bc1', 9, 'What is the price?'), update_id: 41 });
  const again = await intl.telegram({ ...business('bc1', 9, 'What is the price?'), update_id: 41 });
  assert.equal(again.duplicate, true);
  assert.equal(intl.store.one(`SELECT COUNT(*) AS n FROM i_lead`).n, 1);
  intl.store.run('DELETE FROM i_tg_update WHERE update_id = ?', [41]);
  const retry = await intl.telegram({ ...business('bc1', 9, 'What is the price?'), update_id: 41 });
  assert.equal(retry.duplicate, true);
  assert.equal(intl.store.one(`SELECT COUNT(*) AS n FROM i_lead`).n, 1);
  assert.equal(first.lead_id, intl.store.one(`SELECT lead_id FROM i_message WHERE dedup_key = ?`, ['telegram:555001:9']).lead_id);
  intl.close();
});

test('an edit changes the text only', async () => {
  const { intl } = openIntl();
  await property(intl);
  await intl.telegram(conn('bc1'));
  const created = await intl.telegram(business('bc1', 6, 'Can I view tomorrow?'));
  const before = intl.lead(created.lead_id);
  await intl.saveDraft(created.lead_id, { text: 'Keep this draft.', option_id: 'ask' });
  await intl.telegram({
    edited_business_message: { message_id: 6, chat: { id: 555001 }, text: 'please stop' },
  });
  const after = intl.lead(created.lead_id);
  assert.equal(after.status, before.status);
  assert.equal(after.readiness, before.readiness);
  assert.equal(after.score, before.score);
  assert.match(intl.store.one('SELECT text FROM i_message WHERE dedup_key = ?', ['telegram:555001:6']).text, /please stop/);
  assert.ok(intl.store.one('SELECT lead_id FROM i_draft WHERE lead_id = ?', [created.lead_id]));
  intl.close();
});

test('an unknown connection is fetched only in live, and sim never calls Telegram', async () => {
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    if (String(url).includes('getBusinessConnection')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: 'bc_new', user: { id: 42 }, user_chat_id: 77, rights: { can_reply: true }, is_enabled: true } }) };
    }
    throw new Error('send should not run');
  };
  const sim = openIntl({}, { fetch });
  await sim.intl.telegram(business('bc_missing', 1, 'Hi'));
  assert.equal(calls.length, 0);
  sim.intl.close();
  const live = openIntl({ CHANNEL_MODE: 'live' }, { fetch });
  await property(live.intl);
  const created = await live.intl.telegram(business('bc_new', 2, 'Hi, what is the price?'));
  assert.equal(created.stored, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /getBusinessConnection$/);
  assert.equal(calls[0].body.business_connection_id, 'bc_new');
  live.intl.close();
});

test('live manual send uses business_connection_id once, sim does not call out, and a lost response is not sent twice', async () => {
  const calls = [];
  const fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url: String(url), body });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 77 } }) };
  };
  const sim = openIntl();
  await property(sim.intl);
  await sim.intl.telegram(conn('bc1'));
  const simLead = await sim.intl.telegram(business('bc1', 1, 'What is the price?'));
  const simDraft = await sim.intl.saveDraft(simLead.lead_id, { text: 'The price is on the listing.', option_id: 'price', attachments: [{ kind: 'plan', url: '/v1/intl/files/x' }] });
  const simSent = await sim.intl.send(simLead.lead_id, { draft_version: simDraft.version, idempotency_key: 'sim-1' }, '42');
  assert.equal(simSent.simulated, true);
  assert.equal(calls.length, 0);
  sim.intl.close();

  const live = openIntl({ CHANNEL_MODE: 'live' }, { fetch });
  await property(live.intl);
  await live.intl.telegram(conn('bc1'));
  const lead = await live.intl.telegram(business('bc1', 3, 'What is the price?'));
  const draft = await live.intl.saveDraft(lead.lead_id, {
    text: 'The price is on the listing.',
    option_id: 'price',
    attachments: [{ kind: 'plan', url: '/v1/intl/files/x' }],
  });
  const sent = await live.intl.send(lead.lead_id, { draft_version: draft.version, idempotency_key: 'live-1' }, '42');
  assert.equal(sent.ok, true);
  assert.equal(sent.simulated, false);
  assert.deepEqual(sent.attachments, []);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /sendMessage$/);
  assert.equal(calls[0].body.business_connection_id, 'bc1');
  assert.equal(calls[0].body.text.includes('The price is on the listing.'), true);
  assert.equal(calls[0].body.photo, undefined);
  const repeat = await live.intl.send(lead.lead_id, { draft_version: draft.version, idempotency_key: 'live-1' }, '42');
  assert.equal(repeat.send_id, sent.send_id);
  assert.equal(calls.length, 1);
  live.intl.store.run(`DELETE FROM i_idem WHERE key = ?`, ['live-1']);
  live.intl.store.run(`UPDATE i_send SET status = 'sending' WHERE idempotency_key = ?`, ['live-1']);
  const lost = await live.intl.send(lead.lead_id, { draft_version: draft.version, idempotency_key: 'live-1' }, '42');
  assert.equal(lost.replay, true);
  assert.equal(calls.length, 1);
  live.intl.close();
});

test('live auto-send stays off, a closed window is not sent, and archive blocks send', async () => {
  const calls = [];
  const fetch = async () => {
    calls.push('http');
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  const { intl } = openIntl({ CHANNEL_MODE: 'live', INTL_LIVE_AUTOSEND: 'false' }, { fetch });
  await property(intl);
  await intl.telegram(conn('bc1'));
  await intl.settings({ auto_send_hot: true }, '42');
  const hot = await intl.telegram(business('bc1', 1, 'I want to view tomorrow at 4pm'));
  assert.equal(hot.stored, true);
  await intl.compete();
  assert.equal(intl.lead(hot.lead_id).status === 'sent', false);
  assert.equal(calls.length, 0);
  const closed = await intl.telegram(business('bc1', 2, 'What is the price?', {
    chatId: 555009,
    date: Math.floor((NOW.getTime() - 25 * 3600000) / 1000),
  }));
  const draft = await intl.saveDraft(closed.lead_id, { text: 'Still here.', option_id: 'ask' });
  const late = await intl.send(closed.lead_id, { draft_version: draft.version, idempotency_key: 'late' }, '42');
  assert.equal(late.error_code, 'window_closed');
  assert.notEqual(intl.lead(closed.lead_id).status, 'sent');
  const fresh = await intl.telegram(business('bc1', 3, 'How much is it?', { chatId: 555010 }));
  const freshDraft = await intl.saveDraft(fresh.lead_id, { text: 'The price is listed.', option_id: 'price' });
  await intl.archive(fresh.lead_id, '42');
  const blocked = await intl.send(fresh.lead_id, { draft_version: freshDraft.version, idempotency_key: 'arch' }, '42');
  assert.equal(blocked.ok, false);
  assert.equal(calls.length, 0);
  intl.close();
});

test('send with a slot is unconfirmed, a second lead gets slot_taken, and confirm marks it confirmed', async () => {
  const { intl } = openIntl();
  await property(intl);
  const first = await intl.ingest({
    channel: 'wa_sim', sender_id: 'sim:a', sender_name: 'A', text: 'What is the price?', property_id: 'P1', dedup_key: 'p-a', fixture: true,
  });
  const second = await intl.ingest({
    channel: 'wa_sim', sender_id: 'sim:b', sender_name: 'B', text: 'What is the price?', property_id: 'P1', dedup_key: 'p-b', fixture: true,
  });
  const slotId = intl.lead(first.lead_id).slots[0].id;
  const draft = await intl.saveDraft(first.lead_id, { text: 'Thursday works.', option_id: 'one', slot_ids: [slotId] });
  const sent = await intl.send(first.lead_id, { draft_version: draft.version, idempotency_key: 'slot-a' }, '42');
  assert.equal(sent.ok, true);
  assert.equal(intl.lead(first.lead_id).status, 'sent');
  assert.equal(intl.lead(first.lead_id).viewing_status, 'unconfirmed');
  assert.ok(LEAD_STATUSES.includes(intl.lead(first.lead_id).status));
  assert.ok(VIEWING_STATUSES.includes('unconfirmed'));
  const other = await intl.saveDraft(second.lead_id, { text: 'Thursday works.', option_id: 'one', slot_ids: [slotId] });
  const clash = await intl.send(second.lead_id, { draft_version: other.version, idempotency_key: 'slot-b' }, '42');
  assert.equal(clash.error_code, 'slot_taken');
  const viewing = intl.store.one('SELECT id FROM i_viewing WHERE lead_id = ?', [first.lead_id]);
  const confirmed = await intl.setViewing(viewing.id, 'confirmed', '42');
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(intl.lead(first.lead_id).viewing_status, 'confirmed');
  const listed = intl.leads({ property_id: 'P1' });
  assert.equal(listed.every((row) => row.property_id === 'P1'), true);
  assert.equal(listed.find((row) => row.id === first.lead_id).viewing_status, 'confirmed');
  intl.close();
});

test('a stranger lead is hidden and initData is required', async () => {
  const { config, intl } = openIntl();
  await property(intl);
  await intl.telegram(conn('bc1', 42));
  const own = await intl.telegram(business('bc1', 1, 'What is the price?'));
  intl.store.run(`UPDATE i_lead SET broker_id = ? WHERE id = ?`, ['99', own.lead_id]);
  const server = buildIntlServer(config, intl);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const headers = {
    Authorization: `tma ${signInitData({
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: 42 }),
    }, config.TELEGRAM_BOT_TOKEN)}`,
  };
  const closed = await fetch(`http://127.0.0.1:${port}/v1/intl/leads/${own.lead_id}`);
  const hidden = await fetch(`http://127.0.0.1:${port}/v1/intl/leads/${own.lead_id}`, { headers });
  const health = await fetch(`http://127.0.0.1:${port}/v1/health`);
  const body = await health.json();
  assert.equal(closed.status, 401);
  assert.equal(hidden.status, 404);
  assert.equal(body.product_mode, 'intl');
  assert.equal(body.channel_mode, 'sim');
  assert.equal(body.live_autosend, false);
  assert.equal(body.store, process.env.INTL_DATABASE_URL ? 'postgres' : 'sqlite');
  server.close();
  intl.close();
});

test('an Arabic or Turkish viewing is not COLD and a later ok keeps HOT', async () => {
  const { intl } = openIntl();
  await property(intl);
  const arabic = await intl.ingest({
    channel: 'wa_sim', sender_id: 'sim:ar', sender_name: 'Omar', property_id: 'P1', fixture: true,
    text: 'أريد معاينة غدا', dedup_key: 'ar-1',
  });
  assert.notEqual(intl.lead(arabic.lead_id).readiness, 'COLD');
  const turkish = await intl.ingest({
    channel: 'wa_sim', sender_id: 'sim:tr', sender_name: 'Ayse', property_id: 'P1', fixture: true,
    text: 'Yarın evi görmek istiyorum', dedup_key: 'tr-1',
  });
  assert.notEqual(intl.lead(turkish.lead_id).readiness, 'COLD');
  const unsupported = await intl.ingest({
    channel: 'wa_sim', sender_id: 'sim:zz', sender_name: 'Z', property_id: 'P1', fixture: true,
    text: 'مرحبا كيف حالك', dedup_key: 'zz-1',
  });
  assert.equal(intl.lead(unsupported.lead_id).status, 'review');
  const hot = await intl.ingest({
    channel: 'wa_sim', sender_id: 'sim:hot', sender_name: 'Nina', property_id: 'P1', fixture: true,
    text: 'I want to view tomorrow', dedup_key: 'hot-1',
  });
  assert.equal(intl.lead(hot.lead_id).readiness, 'HOT');
  await intl.ingest({
    channel: 'wa_sim', sender_id: 'sim:hot', sender_name: 'Nina', property_id: 'P1', fixture: true,
    text: 'ok 👍', dedup_key: 'hot-2',
  });
  assert.equal(intl.lead(hot.lead_id).readiness, 'HOT');
  intl.close();
});

test('a caption is scored as text and a photo without text stays in review', async () => {
  const { intl } = openIntl();
  await property(intl);
  await intl.telegram(conn('bc1'));
  const caption = await intl.telegram(business('bc1', 11, '', {
    message: { caption: 'Can I view tomorrow?', photo: [{ file_id: 'p' }] },
  }));
  assert.equal(intl.lead(caption.lead_id).readiness, 'HOT');
  assert.notEqual(intl.lead(caption.lead_id).status, 'review');
  const bare = await intl.telegram(business('bc1', 12, '', {
    chatId: 555088,
    message: { photo: [{ file_id: 'q' }] },
  }));
  assert.equal(intl.lead(bare.lead_id).status, 'review');
  intl.close();
});

test('live allows one message per second in a chat', async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: calls } }) };
  };
  const { intl } = openIntl({ CHANNEL_MODE: 'live' }, { fetch });
  await property(intl);
  await intl.telegram(conn('bc1'));
  const lead = await intl.telegram(business('bc1', 21, 'What is the price?'));
  const draft = await intl.saveDraft(lead.lead_id, { text: 'The price is listed.', option_id: 'price' });
  const sent = await intl.send(lead.lead_id, { draft_version: draft.version, idempotency_key: 'pace-1' }, '42');
  assert.equal(sent.ok, true);
  await intl.telegram(business('bc1', 22, 'And the size?'));
  const next = await intl.saveDraft(lead.lead_id, { text: 'I can send the size too.', option_id: 'ask' });
  const paced = await intl.send(lead.lead_id, { draft_version: next.version, idempotency_key: 'pace-2' }, '42');
  assert.equal(paced.error_code, 'rate_limited');
  assert.equal(calls, 1);
  intl.close();
});

test('webhook allowed updates include the business types and the migration is postgres-shaped', () => {
  for (const name of ['business_connection', 'business_message', 'edited_business_message', 'deleted_business_messages']) {
    assert.ok(WEBHOOK_UPDATES.includes(name), name);
  }
  const script = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'telegram_webhook.js'), 'utf8');
  assert.match(script, /setWebhook/);
  assert.match(script, /getWebhookInfo/);
  assert.equal(script.includes('123456:'), false);
  const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'migrations', '002_intl.sql'), 'utf8');
  assert.match(sql, /broker_id/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS i_lead/);
  assert.match(sql, /price DOUBLE PRECISION/);
  assert.match(sql, /budget_amount DOUBLE PRECISION/);
  assert.match(sql, /area_value DOUBLE PRECISION/);
  assert.equal(toPg('SELECT * FROM i_lead WHERE id = ? AND broker_id = ?'), 'SELECT * FROM i_lead WHERE id = $1 AND broker_id = $2');
  assert.equal(toPg("SELECT 'a?b' = ?"), "SELECT 'a?b' = $1");
});

test('area 85.5 and price 1250.5 persist', async () => {
  const { intl } = openIntl();
  const saved = await intl.addProperty({
    id: 'P-frac',
    title: 'Frac',
    kind: 'rent',
    price: 1250.5,
    currency: 'USD',
    price_period: 'year',
    tz: 'Asia/Dubai',
    area_value: 85.5,
    area_unit: 'sqm',
  }, '42');
  assert.equal(saved.ok, true);
  const row = intl.store.one('SELECT price, area_value FROM i_property WHERE id = ?', ['P-frac']);
  assert.equal(Number(row.price), 1250.5);
  assert.equal(Number(row.area_value), 85.5);
  intl.close();
});

test('003 turns an old INTEGER schema into exact fractional prices', async () => {
  const url = String(process.env.INTL_DATABASE_URL || '').trim();
  if (!url) return;
  const { Client } = require('pg');
  const { PgIntlStore } = require('../../core/intl/storePg');
  const admin = new Client({ connectionString: url });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS intl_mig');
  await admin.query('CREATE DATABASE intl_mig');
  await admin.end();
  const migUrl = new URL(url);
  migUrl.pathname = '/intl_mig';
  const setup = new Client({ connectionString: migUrl.toString() });
  await setup.connect();
  const old = fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'migrations', '002_intl.sql'), 'utf8')
    .replace(/DOUBLE PRECISION/g, 'INTEGER');
  const statements = old.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
    .split(/;\s*(?:\n|$)/).map((part) => part.trim()).filter(Boolean);
  for (const statement of statements) await setup.query(statement);
  await setup.query(`INSERT INTO i_schema_migrations (filename, applied_at) VALUES ('002_intl.sql', '2026-01-01T00:00:00.000Z')`);
  await setup.end();
  const store = new PgIntlStore(migUrl.toString());
  try {
    store.run(
      `INSERT INTO i_property (id, title, kind, price, currency, price_period, tz, area_value, active, created_at)
       VALUES ('P-old', 'Old', 'rent', ?, 'USD', 'year', 'Asia/Dubai', ?, 1, '2026-01-01')`,
      [1250.5, 85.5],
    );
    const row = store.one('SELECT price, area_value FROM i_property WHERE id = ?', ['P-old']);
    assert.equal(Number(row.price), 1250.5);
    assert.equal(Number(row.area_value), 85.5);
    assert.equal(store.one(`SELECT filename FROM i_schema_migrations WHERE filename = '003_intl_numeric.sql'`).filename, '003_intl_numeric.sql');
  } finally {
    store.close();
  }
});

test('a fresh postgres database applies 002 before 003', async () => {
  const url = String(process.env.INTL_DATABASE_URL || '').trim();
  if (!url) return;
  const { Client } = require('pg');
  const { PgIntlStore } = require('../../core/intl/storePg');
  const name = `intl_fresh_${Date.now()}`;
  const admin = new Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const freshUrl = new URL(url);
  freshUrl.pathname = `/${name}`;
  const store = new PgIntlStore(freshUrl.toString());
  try {
    const files = store.all('SELECT filename FROM i_schema_migrations ORDER BY filename').map((row) => row.filename);
    assert.deepEqual(files, ['002_intl.sql', '003_intl_numeric.sql', '004_intl_desk.sql', '005_intl_viewing_unique.sql', '006_intl_property_profile.sql']);
    const cols = store.all(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name IN ('price', 'area_value', 'budget_amount')`,
    );
    assert.equal(cols.length, 3);
    for (const col of cols) assert.equal(col.data_type, 'double precision', `${col.table_name}.${col.column_name}`);
    store.run(
      `INSERT INTO i_property (id, title, kind, price, currency, price_period, tz, area_value, active, created_at)
       VALUES ('P-fresh', 'Fresh', 'rent', ?, 'USD', 'year', 'Asia/Dubai', ?, 1, '2026-01-01')`,
      [1250.5, 85.5],
    );
    const row = store.one('SELECT price, area_value FROM i_property WHERE id = ?', ['P-fresh']);
    assert.equal(Number(row.price), 1250.5);
    assert.equal(Number(row.area_value), 85.5);
  } finally {
    store.close();
    const drop = new Client({ connectionString: url });
    await drop.connect();
    await drop.query(`DROP DATABASE ${name}`);
    await drop.end();
  }
});
