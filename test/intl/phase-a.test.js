'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../../core/config');
const { createIntl } = require('../../core/intl/service');
const { signInitData } = require('../../core/uiAuth');
const { buildIntlServer } = require('../../engine/intlServer');
const { notifyNewLeadText, formatDigestText, deliverDigest } = require('../../core/intl/notify');

const root = path.join(__dirname, '..', '..');
const appJs = fs.readFileSync(path.join(root, 'ui-intl', 'app.js'), 'utf8');

test('Phase A UI wires WebApp shell, timeline, and gated demo login', () => {
  assert.match(appJs, /Telegram\.WebApp/);
  assert.match(appJs, /\.ready\(/);
  assert.match(appJs, /\.expand\(/);
  assert.match(appJs, /MainButton/);
  assert.match(appJs, /BackButton/);
  assert.match(appJs, /HapticFeedback|haptic\(/);
  assert.match(appJs, /threadTimeline|timeline\.map/);
  assert.match(appJs, /demo_ui === true/);
  assert.match(appJs, /signInLive/);
  assert.match(appJs, /id="demoLoginBtn"/);
  assert.doesNotMatch(appJs, /body\.apiKey|deepseekApiKey/);
});

test('ai-drafts ignores API keys from the request body', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-a-ai-'));
  const config = loadConfig({
    PRODUCT_MODE: 'intl',
    CHANNEL_MODE: 'sim',
    HASH_SALT: 'intl-test-salt',
    ENGINE_TOKEN: 'intl-engine-token-0123456789',
    TELEGRAM_BOT_TOKEN: '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    TELEGRAM_ALLOWED_USER_IDS: '42',
    DATA_DIR: dir,
    UI_PUBLIC_BASE: 'http://127.0.0.1:9',
    REAL_DATA_ALLOWED: 'false',
    DEMO_UI_NO_AUTH: 'false',
    LLM_MODE: 'mock',
  });
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const intl = createIntl(config, { file: path.join(dir, 'intl.sqlite'), clock: () => new Date('2026-10-28T04:30:00.000Z') });
  const server = buildIntlServer(config, intl);
  try {
    await intl.addProperty({
      id: 'P1', title: 'Marina', kind: 'rent', price: 120000, currency: 'AED', price_period: 'year', tz: 'Asia/Dubai',
    }, '42');
    const lead = await intl.ingest({
      channel: 'wa_sim', sender_id: 'sim:phase-a', sender_name: 'Omar', text: 'Can I view Marina this week?',
      property_id: 'P1', dedup_key: 'phase-a-1', fixture: true, broker_id: '42',
    });
    const headers = {
      Authorization: `tma ${signInitData({
        auth_date: String(Math.floor(Date.now() / 1000)),
        user: JSON.stringify({ id: 42 }),
      }, config.TELEGRAM_BOT_TOKEN)}`,
      'Content-Type': 'application/json',
    };
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/v1/intl/leads/${encodeURIComponent(lead.lead_id)}/ai-drafts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ apiKey: 'should-not-use', deepseekApiKey: 'should-not-use' }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.engine, 'fallback');
  } finally {
    await new Promise((done) => server.close(done));
    intl.close();
  }
});

test('health and settings expose demo_ui / channel_mode for the Mini App gate', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-a-health-'));
  const config = loadConfig({
    PRODUCT_MODE: 'intl',
    CHANNEL_MODE: 'sim',
    HASH_SALT: 'intl-test-salt',
    ENGINE_TOKEN: 'intl-engine-token-0123456789',
    TELEGRAM_BOT_TOKEN: '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    TELEGRAM_ALLOWED_USER_IDS: '42',
    DATA_DIR: dir,
    UI_PUBLIC_BASE: 'http://127.0.0.1:9',
    REAL_DATA_ALLOWED: 'false',
    DEMO_UI_NO_AUTH: 'true',
    LLM_MODE: 'mock',
  });
  const intl = createIntl(config, { file: path.join(dir, 'intl.sqlite') });
  const server = buildIntlServer(config, intl);
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const health = await fetch(`http://127.0.0.1:${port}/v1/health`).then((r) => r.json());
    assert.equal(health.channel_mode, 'sim');
    assert.equal(health.demo_ui, true);
    const settings = await fetch(`http://127.0.0.1:${port}/v1/intl/settings`).then((r) => r.json());
    assert.equal(settings.channel_mode, 'sim');
    assert.equal(settings.demo_ui, true);
  } finally {
    await new Promise((done) => server.close(done));
    intl.close();
  }
});

test('presentLead returns the full message timeline', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-a-thread-'));
  const config = loadConfig({
    PRODUCT_MODE: 'intl',
    CHANNEL_MODE: 'sim',
    HASH_SALT: 'intl-test-salt',
    ENGINE_TOKEN: 'intl-engine-token-0123456789',
    TELEGRAM_BOT_TOKEN: '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    TELEGRAM_ALLOWED_USER_IDS: '42',
    DATA_DIR: dir,
    UI_PUBLIC_BASE: 'http://127.0.0.1:9',
    REAL_DATA_ALLOWED: 'false',
    LLM_MODE: 'mock',
  });
  const intl = createIntl(config, { file: path.join(dir, 'intl.sqlite'), clock: () => new Date('2026-10-28T04:30:00.000Z') });
  await intl.addProperty({
    id: 'P1', title: 'Marina', kind: 'rent', price: 120000, currency: 'AED', price_period: 'year', tz: 'Asia/Dubai',
  }, '42');
  const first = await intl.ingest({
    channel: 'wa_sim', sender_id: 'sim:thread', sender_name: 'Omar', text: 'First hello',
    property_id: 'P1', dedup_key: 'thread-1', fixture: true, append_open: true, broker_id: '42',
  });
  await intl.ingest({
    channel: 'wa_sim', sender_id: 'sim:thread', sender_name: 'Omar', text: 'Second hello',
    property_id: 'P1', dedup_key: 'thread-2', fixture: true, append_open: true, broker_id: '42',
  });
  const lead = await intl.lead(first.lead_id, '42');
  const inbound = (lead.messages || []).filter((row) => row.direction === 'in');
  assert.ok(inbound.length >= 2);
  intl.close();
});

test('live digest delivery posts to Telegram; sim stays local', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 9 } }),
    };
  };
  const text = notifyNewLeadText({ leadId: 'L-1', grade: 'HOT', status: 'pending_approval', propertyId: 'P1' });
  assert.match(text, /You got a new message from a HOT lead/);
  assert.match(notifyNewLeadText({ grade: 'WARM', lang: 'ru' }), /Вам пришло новое сообщение от WARM лида/);
  const digestText = formatDigestText({ write_first: [{ id: 'L-1', grade: 'HOT', waiting_minutes: 12 }] }, {
    BROKER_TZ: 'Asia/Dubai',
    UI_PUBLIC_BASE: 'https://example.test',
  });
  assert.match(digestText, /Morning digest/);
  assert.match(digestText, /L-1/);

  const sim = await deliverDigest({
    CHANNEL_MODE: 'sim',
    TELEGRAM_BOT_TOKEN: '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    TELEGRAM_ALLOWED_USER_IDS: ['42'],
  }, { write_first: [] }, fetchImpl);
  assert.equal(sim.telegram_delivery, false);
  assert.equal(calls.length, 0);

  const live = await deliverDigest({
    CHANNEL_MODE: 'live',
    TELEGRAM_BOT_TOKEN: '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    TELEGRAM_ALLOWED_USER_IDS: ['42'],
    UI_PUBLIC_BASE: 'https://example.test',
  }, { write_first: [{ id: 'L-1', grade: 'WARM', waiting_minutes: 3 }] }, fetchImpl);
  assert.equal(live.telegram_delivery, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /sendMessage/);
  assert.equal(calls[0].body.chat_id, '42');
});

test('reminders stay silent in chat: only the first message notifies', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-a-remind-'));
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  let clock = new Date('2026-10-28T04:00:00.000Z');
  const config = loadConfig({
    PRODUCT_MODE: 'intl',
    CHANNEL_MODE: 'live',
    HASH_SALT: 'intl-test-salt-live-ok',
    ENGINE_TOKEN: 'intl-engine-token-0123456789',
    TELEGRAM_BOT_TOKEN: '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    TELEGRAM_ALLOWED_USER_IDS: '42',
    TELEGRAM_WEBHOOK_SECRET: 'hook-secret',
    INTL_DATABASE_URL: '',
    DATA_DIR: dir,
    UI_PUBLIC_BASE: 'https://example.test',
    REAL_DATA_ALLOWED: 'false',
    INTL_REMIND_MINUTES: '10',
    LLM_MODE: 'mock',
  });
  const intl = createIntl(config, {
    file: path.join(dir, 'intl.sqlite'),
    clock: () => clock,
    fetch: fetchImpl,
  });
  await intl.addProperty({
    id: 'P1', title: 'Marina', kind: 'rent', price: 120000, currency: 'AED', price_period: 'year', tz: 'Asia/Dubai',
  }, '42');
  const lead = await intl.ingest({
    channel: 'telegram', sender_id: '9001', sender_name: 'Omar', text: 'Viewing please',
    property_id: 'P1', dedup_key: 'remind-1', fixture: true, business: true,
    business_connection_id: 'bc-1', reply_target: '9001', broker_id: '42',
  });
  assert.ok(lead.lead_id);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const afterNotify = calls.length;
  assert.ok(afterNotify >= 1, 'the first message notifies the broker');
  clock = new Date('2026-10-28T04:20:00.000Z');
  const first = await intl.remind();
  assert.equal(first.reminded, 0);
  assert.equal(first.silent, true);
  assert.equal(calls.length, afterNotify, 'waiting reminders do not ping the chat');
  const second = await intl.remind();
  assert.equal(second.reminded, 0);
  assert.equal(calls.length, afterNotify);
  intl.close();
});

test('broker is notified only about the first message of a lead', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-a-first-'));
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  const config = loadConfig({
    PRODUCT_MODE: 'intl',
    CHANNEL_MODE: 'live',
    HASH_SALT: 'intl-test-salt-live-first',
    TELEGRAM_BOT_TOKEN: '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    TELEGRAM_ALLOWED_USER_IDS: '42',
    TELEGRAM_WEBHOOK_SECRET: 'hook-secret',
    DATA_DIR: dir,
    UI_PUBLIC_BASE: 'https://example.test',
    REAL_DATA_ALLOWED: 'false',
    LLM_MODE: 'mock',
  });
  const intl = createIntl(config, {
    file: path.join(dir, 'intl.sqlite'),
    clock: () => new Date('2026-10-28T04:30:00.000Z'),
    fetch: fetchImpl,
  });
  await intl.addProperty({
    id: 'P1', title: 'Marina', kind: 'rent', price: 120000, currency: 'AED', price_period: 'year', tz: 'Asia/Dubai',
  }, '42');
  await intl.ingest({
    channel: 'telegram', sender_id: '9002', sender_name: 'Omar', text: 'Viewing please',
    property_id: 'P1', dedup_key: 'first-1', fixture: true, business: true,
    business_connection_id: 'bc-2', reply_target: '9002', broker_id: '42',
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.text, /Вам пришло новое сообщение от (HOT|WARM|COLD) лида/);
  await intl.ingest({
    channel: 'telegram', sender_id: '9002', sender_name: 'Omar', text: 'Any time this week',
    property_id: 'P1', dedup_key: 'first-2', fixture: true, business: true,
    business_connection_id: 'bc-2', reply_target: '9002', broker_id: '42',
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls.length, 1, 'follow-up messages stay silent in chat');
  intl.close();
});

test('root duplicates re-export canonical modules', () => {
  assert.match(fs.readFileSync(path.join(root, 'intlServer.js'), 'utf8'), /engine\/intlServer/);
  assert.match(fs.readFileSync(path.join(root, 'gemini.js'), 'utf8'), /core\/intl\/gemini/);
  assert.ok(fs.existsSync(path.join(root, 'docs', 'INTL_POSTGRES_HOST.md')));
});
