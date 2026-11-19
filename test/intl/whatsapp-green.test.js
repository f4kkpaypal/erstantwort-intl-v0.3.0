'use strict';

// Green API provider: webhook secret in the URL, inbound text leads, outbound sendMessage.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../../core/config');
const { createIntl } = require('../../core/intl/service');
const whatsapp = require('../../core/intl/whatsappSend');
const { buildIntlServer } = require('../../engine/intlServer');

const root = path.join(__dirname, '..', '..');
const engine = fs.readFileSync(path.join(root, 'engine', 'intlServer.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'ui-intl', 'app.js'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.join(root, 'ui-intl', 'i18n', 'en.json'), 'utf8'));
const ru = JSON.parse(fs.readFileSync(path.join(root, 'ui-intl', 'i18n', 'ru.json'), 'utf8'));

const GREEN = { id: '710722803004', token: 'green-api-token-123', hook: 'green-hook-secret-xyz' };

function open() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intl-green-'));
  const config = loadConfig({
    PRODUCT_MODE: 'intl',
    CHANNEL_MODE: 'live',
    ALLOW_SQLITE_LIVE: 'true',
    REAL_DATA_ALLOWED: 'true',
    ALLOW_REAL_DATA: 'true',
    HASH_SALT: 'green-salt',
    TELEGRAM_BOT_TOKEN: '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    TELEGRAM_ALLOWED_USER_IDS: '42',
    TELEGRAM_WEBHOOK_SECRET: 'tg-hook-secret',
    WHATSAPP_PROVIDER: 'green',
    GREENAPI_ID_INSTANCE: GREEN.id,
    GREENAPI_API_TOKEN: GREEN.token,
    GREENAPI_WEBHOOK_TOKEN: GREEN.hook,
    DATA_DIR: dir,
    LLM_MODE: 'mock',
  });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ idMessage: 'green-msg-1' }) };
  };
  const intl = createIntl(config, {
    file: path.join(dir, 'intl.sqlite'),
    clock: () => new Date('2026-10-28T04:30:00.000Z'),
    fetch: fetchImpl,
  });
  return { intl, config, calls };
}

function greenIncoming(chatId, text, extra = {}) {
  return {
    typeWebhook: 'incomingMessageReceived',
    instanceData: { idInstance: GREEN.id, wid: '994557095976@c.us', typeInstance: 'whatsapp' },
    timestamp: 1794900000,
    idMessage: extra.idMessage || 'green-in-1',
    senderData: { chatId, chatName: 'Omar', sender: chatId, senderName: extra.name || 'Omar' },
    messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: text } },
  };
}

test('provider detection prefers Green API when its credentials are set', () => {
  const { intl, config } = open();
  try {
    assert.equal(whatsapp.providerOf(config), 'green');
    assert.equal(whatsapp.whatsappConfigured(config), true);
    const raw = JSON.stringify(greenIncoming('994501112233@c.us', 'Hi'));
    assert.equal(whatsapp.inboundMessages(JSON.parse(raw), 'green').length, 1);
  } finally { intl.close(); }
});

test('webhook token is required and wrong token is rejected', async () => {
  const { intl } = open();
  try {
    const raw = JSON.stringify(greenIncoming('994501112233@c.us', 'Hi'));
    const bad = await intl.whatsappWebhook(raw, {}, 'wrong-token');
    assert.equal(bad.status, 403);
    const ok = await intl.whatsappWebhook(raw, {}, GREEN.hook);
    assert.equal(ok.ok, true);
    assert.equal(ok.stored, 1);
    const lead = intl.leads().find((row) => row.channel === 'whatsapp');
    assert.ok(lead);
    assert.equal(lead.clean_name, 'Omar');
  } finally { intl.close(); }
});

test('groups are ignored and duplicates are deduped', async () => {
  const { intl } = open();
  try {
    const group = JSON.stringify(greenIncoming('120363000000000000@g.us', 'group text', { idMessage: 'green-g-1' }));
    const g = await intl.whatsappWebhook(group, {}, GREEN.hook);
    assert.equal(g.stored, 0);
    const direct = JSON.stringify(greenIncoming('994501112233@c.us', 'direct', { idMessage: 'green-d-1' }));
    await intl.whatsappWebhook(direct, {}, GREEN.hook);
    const again = await intl.whatsappWebhook(direct, {}, GREEN.hook);
    assert.equal(again.stored, 0);
    assert.equal(intl.leads().filter((row) => row.channel === 'whatsapp').length, 1);
  } finally { intl.close(); }
});

test('outbound uses /waInstance/sendMessage and stores the idMessage', async () => {
  const { intl, calls } = open();
  try {
    await intl.addProperty({ id: 'P1', title: 'Marina 2BR', kind: 'sale', price: 310000, currency: 'AED', price_period: 'total', tz: 'Asia/Dubai' }, '42');
    const raw = JSON.stringify(greenIncoming('994501112233@c.us', 'Viewing please', { idMessage: 'green-in-2' }));
    await intl.whatsappWebhook(raw, {}, GREEN.hook);
    const lead = intl.leads().find((row) => row.channel === 'whatsapp');
    await intl.saveDraft(lead.id, { text: 'Hello! Two times available.', option_id: null });
    const version = intl.lead(lead.id, '42').draft.version;
    const sent = await intl.send(lead.id, { manual: true, idempotency_key: 'green-send-1', draft_version: version }, '42');
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const call = calls[calls.length - 1];
    assert.match(call.url, new RegExp(`/waInstance${GREEN.id}/sendMessage/${GREEN.token}$`));
    const body = JSON.parse(call.options.body);
    assert.equal(body.chatId, '994501112233@c.us');
    assert.match(body.message, /Two times available/);
    assert.ok(body.message.includes('STOP') || body.message.includes('STOP'));
    const after = intl.lead(lead.id, '42');
    assert.equal(after.status, 'sent');
    assert.equal(after.channel, 'whatsapp');
  } finally { intl.close(); }
});

test('polling receiveNotification is a safe fallback when the webhook is not delivered', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intl-green-poll-'));
  const config = loadConfig({
    PRODUCT_MODE: 'intl', CHANNEL_MODE: 'live', ALLOW_SQLITE_LIVE: 'true',
    REAL_DATA_ALLOWED: 'true', ALLOW_REAL_DATA: 'true', HASH_SALT: 'green-poll-salt',
    TELEGRAM_BOT_TOKEN: '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', TELEGRAM_ALLOWED_USER_IDS: '42',
    TELEGRAM_WEBHOOK_SECRET: 'tg-hook-secret', WHATSAPP_PROVIDER: 'green',
    GREENAPI_ID_INSTANCE: GREEN.id, GREENAPI_API_TOKEN: GREEN.token, GREENAPI_WEBHOOK_TOKEN: GREEN.hook,
    DATA_DIR: dir, LLM_MODE: 'mock',
  });
  const incoming = greenIncoming('994509998877@c.us', 'Polled message', { idMessage: 'green-poll-1' });
  let queue = [{ receiptId: 11, body: incoming }];
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('receiveNotification')) {
      const next = queue.shift();
      return { ok: true, status: 200, json: async () => (next || null) };
    }
    if (url.includes('deleteNotification')) return { ok: true, status: 200, json: async () => ({ result: true }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const intl = createIntl(config, { file: path.join(dir, 'intl.sqlite'), clock: () => new Date('2026-10-28T04:30:00.000Z'), fetch: fetchImpl });
  try {
    const first = await intl.whatsappPoll();
    assert.equal(first.ok, true);
    assert.equal(first.stored, 1);
    const lead = intl.leads().find((row) => row.channel === 'whatsapp');
    assert.ok(lead);
    assert.equal(lead.sender_name, 'Omar');
    assert.ok(calls.some((call) => call.url.includes('receiveNotification')));
    assert.ok(calls.some((call) => call.url.includes('/deleteNotification/') && call.url.endsWith('/11')));
    const second = await intl.whatsappPoll();
    assert.equal(second.stored, 0);
    assert.equal(intl.leads().filter((row) => row.channel === 'whatsapp').length, 1);
  } finally { intl.close(); }
});
test('HTTP webhook accepts only the configured token and GET is not used for Green', async () => {
  const { intl, config } = open();
  const server = buildIntlServer(config, intl);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const payload = JSON.stringify(greenIncoming('994507778899@c.us', 'HTTP green', { idMessage: 'green-http-1' }));
    const wrong = await fetch(`http://127.0.0.1:${port}/v1/intl/whatsapp?token=nope`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
    assert.equal(wrong.status, 403);
    const ok = await fetch(`http://127.0.0.1:${port}/v1/intl/whatsapp?token=${GREEN.hook}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.stored, 1);
    const get = await fetch(`http://127.0.0.1:${port}/v1/intl/whatsapp?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1`);
    assert.equal(get.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    intl.close();
  }
});

test('UI and docs mention the Green API provider honestly', () => {
  assert.match(engine, /whatsappWebhook\(raw, req\.headers, url\.searchParams\.get\('token'\)\)/);
  assert.match(app, /t\('whatsapp'\)/);
  assert.match(en.pilotGreen, /third-party bridge/);
  assert.match(ru.pilotGreen, /сторонний мост/);
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ru).sort());
  const doc = fs.readFileSync(path.join(root, 'WHATSAPP.md'), 'utf8');
  assert.match(doc, /Green API/);
  assert.match(doc, /GREENAPI_WEBHOOK_TOKEN/);
  assert.match(doc, /sendMessage/);
});
