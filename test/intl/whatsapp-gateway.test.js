'use strict';

// In-app WhatsApp gateway connection (Green API / Meta Cloud API): credentials saved in settings,
// webhook registered automatically for Green, status masked, and the webhook/polling paths resolve
// the effective config so a saved gateway works without restarting the server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../../core/config');
const { createIntl } = require('../../core/intl/service');
const whatsapp = require('../../core/intl/whatsappSend');

const root = path.join(__dirname, '..', '..');
const app = fs.readFileSync(path.join(root, 'ui-intl', 'app.js'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.join(root, 'ui-intl', 'i18n', 'en.json'), 'utf8'));
const ru = JSON.parse(fs.readFileSync(path.join(root, 'ui-intl', 'i18n', 'ru.json'), 'utf8'));

function jsonBody(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function open(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intl-gateway-'));
  const config = loadConfig({
    PRODUCT_MODE: 'intl',
    CHANNEL_MODE: 'live',
    ALLOW_SQLITE_LIVE: 'true',
    REAL_DATA_ALLOWED: 'true',
    ALLOW_REAL_DATA: 'true',
    HASH_SALT: 'gateway-salt',
    TELEGRAM_BOT_TOKEN: '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    TELEGRAM_ALLOWED_USER_IDS: '42',
    TELEGRAM_WEBHOOK_SECRET: 'tg-hook-secret',
    DATA_DIR: dir,
    UI_PUBLIC_BASE: 'https://pilot.example.test',
    LLM_MODE: 'mock',
    ...overrides,
  });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('getStateInstance')) return jsonBody({ stateInstance: 'authorized' });
    if (String(url).includes('setSettings')) return jsonBody({ saveSettings: true });
    if (String(url).includes('/qr/')) return jsonBody({ type: 'qrCode', message: 'BASE64QR' });
    return jsonBody({});
  };
  const intl = createIntl(config, { file: path.join(dir, 'intl.sqlite'), clock: () => new Date('2026-10-28T04:30:00.000Z'), fetch: fetchImpl });
  return { intl, config, calls, dir };
}

function storedHookToken(intl) {
  const row = intl.store.one("SELECT value FROM i_settings WHERE key = 'wa_webhook_token'");
  return row ? String(row.value) : '';
}

test('Green API connect saves credentials, registers the webhook and reports status', async () => {
  const { intl, config } = open();
  try {
    assert.equal(whatsapp.providerOf(config), 'none');
    const result = await intl.whatsappConnect({ gateway: 'green', id_instance: '710722803004', api_token: 'green-api-token-1234567890' }, '42');
    assert.equal(result.ok, true);
    assert.equal(result.gateway, 'green');
    assert.equal(result.configured, true);
    assert.equal(result.authorized, true);
    assert.equal(result.webhook_set, true);
    assert.match(result.webhook_url, /^https:\/\/pilot\.example\.test\/v1\/intl\/whatsapp\?token=/);

    const effective = whatsapp.effectiveConfig(config, intl.store);
    assert.equal(whatsapp.providerOf(effective), 'green');

    const settings = intl.getSettings();
    assert.equal(settings.wa_gateway, 'green');
    assert.equal(settings.wa_green_token, undefined, 'token is never exposed');
    assert.equal(settings.wa_webhook_token, undefined);
  } finally { intl.close(); }
});

test('a saved Green gateway accepts the webhook with the generated token', async () => {
  const { intl } = open();
  try {
    await intl.whatsappConnect({ gateway: 'green', id_instance: '710722803004', api_token: 'green-api-token-1234567890' }, '42');
    const hook = storedHookToken(intl);
    assert.ok(hook);
    const payload = {
      typeWebhook: 'incomingMessageReceived',
      timestamp: 1794900000,
      idMessage: 'gw-in-1',
      senderData: { chatId: '994501112233@c.us', senderName: 'Omar' },
      messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: 'Hi from gateway' } },
    };
    const wrong = await intl.whatsappWebhook(JSON.stringify(payload), {}, 'wrong');
    assert.equal(wrong.status, 403);
    const ok = await intl.whatsappWebhook(JSON.stringify(payload), {}, hook);
    assert.equal(ok.ok, true);
    assert.equal(ok.stored, 1);
    assert.equal(intl.leads().filter((row) => row.channel === 'whatsapp').length, 1);
  } finally { intl.close(); }
});

test('Meta Cloud API connect stores credentials and returns the webhook URL', async () => {
  const { intl, config } = open({ UI_PUBLIC_BASE: 'https://cloud.example.test' });
  try {
    const result = await intl.whatsappConnect({
      gateway: 'cloud',
      token: 'EAAGabcdefghijklmnopqrstuvwxyz012345',
      phone_number_id: '123456',
      verify_token: 'meta-verify',
      app_secret: 'abcdef0123456789abcdef0123456789',
    }, '42');
    assert.equal(result.ok, true);
    assert.equal(result.gateway, 'cloud');
    assert.match(result.webhook_url, /^https:\/\/cloud\.example\.test\/v1\/intl\/whatsapp/);
    assert.equal(result.verify_token, 'meta-verify');
    const settings = intl.getSettings();
    assert.equal(settings.wa_gateway, 'cloud');
    assert.equal(settings.wa_cloud_token, undefined);
    assert.equal(settings.wa_cloud_secret, undefined);
    const effective = whatsapp.effectiveConfig(config, intl.store);
    assert.equal(whatsapp.providerOf(effective), 'cloud');
  } finally { intl.close(); }
});

test('disconnect clears the saved gateway', async () => {
  const { intl } = open();
  try {
    await intl.whatsappConnect({ gateway: 'green', id_instance: '710722803004', api_token: 'green-api-token-1234567890' }, '42');
    assert.equal(intl.whatsappStatus().configured, true);
    const out = await intl.whatsappDisconnect('42');
    assert.equal(out.configured, false);
    assert.equal(intl.getSettings().wa_gateway, undefined);
  } finally { intl.close(); }
});

test('processing settings accept reply style and digest schedule', async () => {
  const { intl } = open();
  try {
    await intl.settings({ reply_style: 'short', digest_enabled: false, digest_time: '07:15' }, '42');
    const saved = intl.getSettings();
    assert.equal(saved.reply_style, 'short');
    assert.equal(saved.digest_enabled, '0');
    assert.equal(saved.digest_time, '07:15');
    const bad = await intl.settings({ digest_time: '25:00' }, '42');
    assert.equal(bad.ok, false);
    const digest = await intl.digestTick('schedule');
    assert.equal(digest.disabled, true);
  } finally { intl.close(); }
});

test('metrics expose planned viewings for the analytics card', async () => {
  const { intl } = open();
  try {
    await intl.addProperty({ id: 'P1', title: 'Marina', kind: 'rent', price: 120000, currency: 'AED', price_period: 'year', tz: 'Asia/Dubai' }, '42');
    const metrics = await intl.metrics('42');
    assert.equal(typeof metrics.viewings_planned, 'number');
    assert.equal(typeof metrics.waiting, 'number');
  } finally { intl.close(); }
});

test('the settings and gateway screens exist with the honest Meta wording', () => {
  assert.match(app, /async function showWhatsApp/);
  assert.match(app, /async function showSetup/);
  assert.match(app, /id="replyStyle"/);
  assert.match(app, /id="digestTime"/);
  assert.match(app, /id="toggle-digest"/);
  assert.match(app, /id="toggle-ai"/);
  assert.match(app, /id="whatsappRow"/);
  assert.match(app, /id="waConnect"/);
  assert.match(app, /id="waQr"/);
  assert.match(app, /id="step-connect"/);
  assert.match(app, /id="openSummary"/);
  // Meta is presented as the official, recommended gateway - without blocking-risk claims.
  assert.match(app, /t\('waMetaBadge'\)/);
  assert.match(app, /t\('waMetaRecommended'\)/);
  assert.equal(/\brisk\b/i.test(app), false);
  assert.equal(/риск/i.test(app), false);
  assert.match(en.waMetaBadge, /Official/);
  assert.match(ru.waMetaBadge, /Официальн/i);
  assert.match(en.waMetaRecommended, /Recommended/);
  assert.match(ru.waMetaRecommended, /Рекоменд/i);
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ru).sort());
});
