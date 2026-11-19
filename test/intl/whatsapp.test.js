'use strict';

// WhatsApp Cloud API channel: webhook verification + signature, inbound leads, outbound Graph call,
// and the two honest failure modes (24h window closed, template required).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../../core/config');
const { createIntl } = require('../../core/intl/service');
const { buildIntlServer } = require('../../engine/intlServer');

const root = path.join(__dirname, '..', '..');
const app = fs.readFileSync(path.join(root, 'ui-intl', 'app.js'), 'utf8');
const engine = fs.readFileSync(path.join(root, 'engine', 'intlServer.js'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.join(root, 'ui-intl', 'i18n', 'en.json'), 'utf8'));
const ru = JSON.parse(fs.readFileSync(path.join(root, 'ui-intl', 'i18n', 'ru.json'), 'utf8'));

const SECRET = 'wa-app-secret';
const VERIFY = 'wa-verify-token';

function open(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intl-whatsapp-'));
  const config = loadConfig({
    PRODUCT_MODE: 'intl',
    CHANNEL_MODE: 'live',
    ALLOW_SQLITE_LIVE: 'true',
    REAL_DATA_ALLOWED: 'true',
    ALLOW_REAL_DATA: 'true',
    HASH_SALT: 'whatsapp-salt',
    TELEGRAM_BOT_TOKEN: '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    TELEGRAM_ALLOWED_USER_IDS: '42',
    TELEGRAM_WEBHOOK_SECRET: 'tg-hook-secret',
    WHATSAPP_TOKEN: 'wa-test-token',
    WHATSAPP_PHONE_NUMBER_ID: '111222333',
    WHATSAPP_VERIFY_TOKEN: VERIFY,
    WHATSAPP_APP_SECRET: SECRET,
    DATA_DIR: dir,
    LLM_MODE: 'mock',
    ...extra,
  });
  const intl = createIntl(config, {
    file: path.join(dir, 'intl.sqlite'),
    clock: () => new Date('2026-10-28T04:30:00.000Z'),
    fetch: extra.__fetch,
  });
  return { intl, config };
}

function envelope(message, contactName = 'Omar') {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA1',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '971500000000', phone_number_id: '111222333' },
          contacts: [{ profile: { name: contactName }, wa_id: message.from }],
          messages: [message],
        },
      }],
    }],
  };
}

function sign(raw) {
  return 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
}

function fakeFetch(calls, reply) {
  return async (url, options) => {
    calls.push({ url, options });
    const payload = reply || { messages: [{ id: 'wamid.sent-1' }] };
    const status = reply && reply.__status ? reply.__status : 200;
    const body = reply && reply.__error ? { error: reply.__error } : payload;
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
}

test('webhook verification returns the challenge only for the right token', () => {
  const { intl } = open();
  try {
    const ok = intl.whatsappVerify(new URLSearchParams(`hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=challenge-42`));
    assert.equal(ok.ok, true);
    assert.equal(ok.challenge, 'challenge-42');
    const bad = intl.whatsappVerify(new URLSearchParams('hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x'));
    assert.equal(bad.ok, false);
  } finally { intl.close(); }
});

test('signed inbound message becomes a WhatsApp lead, unsigned one is rejected', async () => {
  const calls = [];
  const { intl } = open({ __fetch: fakeFetch(calls) });
  try {
    const payload = envelope({ id: 'wamid.in-1', from: '971501112233', timestamp: '1794900000', type: 'text', text: { body: 'Hi, can I view Marina 2BR?' } });
    const raw = JSON.stringify(payload);
    const bad = await intl.whatsappWebhook(raw, { 'x-hub-signature-256': 'sha256=deadbeef' });
    assert.equal(bad.status, 403);
    const ok = await intl.whatsappWebhook(raw, { 'x-hub-signature-256': sign(raw) });
    assert.equal(ok.ok, true);
    assert.equal(ok.received, 1);
    assert.equal(ok.stored, 1);
    const list = intl.leads();
    const lead = list.find((row) => row.channel === 'whatsapp');
    assert.ok(lead, 'whatsapp lead exists');
    assert.equal(lead.clean_name, 'Omar');
    // Meta retries the same event: dedupe by message id, no second lead.
    const again = await intl.whatsappWebhook(raw, { 'x-hub-signature-256': sign(raw) });
    assert.equal(again.stored, 0);
    assert.equal(intl.leads().filter((row) => row.channel === 'whatsapp').length, 1);
  } finally { intl.close(); }
});

test('media-only message does not crash and is stored as a non-text lead', async () => {
  const { intl } = open({ __fetch: fakeFetch([]) });
  try {
    const payload = envelope({ id: 'wamid.in-2', from: '971504445566', timestamp: '1794900100', type: 'image', image: { id: 'media-1' } }, 'Layla');
    const raw = JSON.stringify(payload);
    const result = await intl.whatsappWebhook(raw, { 'x-hub-signature-256': sign(raw) });
    assert.equal(result.ok, true);
    assert.equal(result.stored, 1);
    const lead = intl.leads().find((row) => row.channel === 'whatsapp');
    assert.ok(lead);
  } finally { intl.close(); }
});

test('outbound reply goes through the Graph messages endpoint', async () => {
  const calls = [];
  const { intl } = open({ __fetch: fakeFetch(calls) });
  try {
    await intl.addProperty({ id: 'P1', title: 'Marina 2BR', kind: 'sale', price: 310000, currency: 'AED', price_period: 'total', tz: 'Asia/Dubai' }, '42');
    const raw = JSON.stringify(envelope({ id: 'wamid.in-3', from: '971507778899', timestamp: '1794900000', type: 'text', text: { body: 'Viewing please' } }));
    await intl.whatsappWebhook(raw, { 'x-hub-signature-256': sign(raw) });
    const lead = intl.leads().find((row) => row.channel === 'whatsapp');
    await intl.saveDraft(lead.id, { text: 'Hello! Two times available.', option_id: null });
    const version = intl.lead(lead.id, '42').draft.version;
    const sent = await intl.send(lead.id, { manual: true, idempotency_key: 'wa-send-1', draft_version: version }, '42');
    assert.equal(sent.ok, true, JSON.stringify(sent));
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /graph\.facebook\.com\/v21\.0\/111222333\/messages$/);
    assert.equal(calls[0].options.headers.Authorization, 'Bearer wa-test-token');
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.messaging_product, 'whatsapp');
    assert.equal(body.to, '971507778899');
    assert.equal(body.type, 'text');
    assert.match(body.text.body, /Two times available/);
    assert.ok(body.text.body.includes('STOP'));
    assert.equal(intl.lead(lead.id, '42').status, 'sent');
  } finally { intl.close(); }
});

test('outside the 24h window the send is refused before any network call', async () => {
  const calls = [];
  const { intl } = open({ __fetch: fakeFetch(calls) });
  try {
    // message timestamp far in the past relative to the fixed clock
    const raw = JSON.stringify(envelope({ id: 'wamid.in-4', from: '971500000111', timestamp: '1700000000', type: 'text', text: { body: 'Hello' } }));
    await intl.whatsappWebhook(raw, { 'x-hub-signature-256': sign(raw) });
    const lead = intl.leads().find((row) => row.channel === 'whatsapp');
    await intl.saveDraft(lead.id, { text: 'Old reply', option_id: null });
    const result = await intl.send(lead.id, { manual: true, idempotency_key: 'wa-send-old', draft_version: intl.lead(lead.id, '42').draft.version }, '42');
    assert.equal(result.ok, false);
    assert.equal(result.error_code, 'window_closed');
    assert.equal(calls.length, 0);
  } finally { intl.close(); }
});

test('Meta template error is surfaced honestly as template_required', async () => {
  const calls = [];
  const { intl } = open({ __fetch: fakeFetch(calls, { __status: 400, __error: { code: 131047, message: 'Re-engagement message' } }) });
  try {
    const raw = JSON.stringify(envelope({ id: 'wamid.in-5', from: '971500000222', timestamp: '1794900000', type: 'text', text: { body: 'Hello' } }));
    await intl.whatsappWebhook(raw, { 'x-hub-signature-256': sign(raw) });
    const lead = intl.leads().find((row) => row.channel === 'whatsapp');
    await intl.saveDraft(lead.id, { text: 'Hi there', option_id: null });
    const result = await intl.send(lead.id, { manual: true, idempotency_key: 'wa-send-template', draft_version: intl.lead(lead.id, '42').draft.version }, '42');
    assert.equal(result.ok, false);
    assert.equal(result.error_code, 'template_required');
  } finally { intl.close(); }
});

test('engine exposes the GET and POST webhook routes', async () => {
  const calls = [];
  const { intl, config } = open({ __fetch: fakeFetch(calls) });
  const server = buildIntlServer(config, intl);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const challenge = await fetch(`http://127.0.0.1:${port}/v1/intl/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=abc123`);
    assert.equal(challenge.status, 200);
    assert.equal(await challenge.text(), 'abc123');
    const forbidden = await fetch(`http://127.0.0.1:${port}/v1/intl/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=abc123`);
    assert.equal(forbidden.status, 403);
    const payload = envelope({ id: 'wamid.http-1', from: '971509990000', timestamp: '1794900000', type: 'text', text: { body: 'Webhook HTTP' } });
    const raw = JSON.stringify(payload);
    const bad = await fetch(`http://127.0.0.1:${port}/v1/intl/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00' }, body: raw });
    assert.equal(bad.status, 403);
    const ok = await fetch(`http://127.0.0.1:${port}/v1/intl/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) }, body: raw });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.equal(body.stored, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    intl.close();
  }
});

test('UI and dictionaries talk about WhatsApp Cloud API without lying', () => {
  assert.match(app, /channel === 'whatsapp'/);
  assert.match(app, /t\('whatsapp'\)/);
  assert.match(engine, /\/v1\/intl\/whatsapp/);
  assert.match(engine, /readRawBody/);
  assert.match(en.step1, /WhatsApp API/);
  assert.match(ru.step1, /WhatsApp API/);
  assert.match(en.demoWaRow, /live/);
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ru).sort());
});

test('the WhatsApp guide ships with the build', () => {
  const doc = fs.readFileSync(path.join(root, 'WHATSAPP.md'), 'utf8');
  assert.match(doc, /Cloud API/);
  assert.match(doc, /24-hour|24 hour|24-час/i);
  assert.match(doc, /WHATSAPP_VERIFY_TOKEN/);
  assert.match(doc, /WHATSAPP_APP_SECRET/);
  assert.match(doc, /graph\.facebook\.com/);
});
