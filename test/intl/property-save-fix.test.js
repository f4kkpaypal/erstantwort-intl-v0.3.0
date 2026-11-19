'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../../core/config');
const { createIntl } = require('../../core/intl/service');
const { signInitData } = require('../../core/uiAuth');
const { buildIntlServer } = require('../../engine/intlServer');

const TOKEN = '123456:AA-test-token-for-property-save';
const ROOT = path.join(__dirname, '..', '..');

function openIntl() {
  const file = path.join(require('os').tmpdir(), `intl-prop-save-${process.pid}-${Date.now()}.sqlite`);
  const config = loadConfig({
    PRODUCT_MODE: 'intl',
    CHANNEL_MODE: 'sim',
    DEMO_UI_NO_AUTH: 'false',
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_ALLOWED_USER_IDS: '42',
    MULTI_USER: 'true',
    HASH_SALT: 'test-salt-property-save',
    LLM_MODE: 'mock',
  });
  const intl = createIntl(config, { file });
  return { config, intl, file };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('postgres migration 008 adds meeting_point and access_notes', () => {
  const file = path.join(ROOT, 'db', 'migrations', '008_intl_property_meeting.sql');
  const sql = fs.readFileSync(file, 'utf8');
  assert.match(sql, /meeting_point/i);
  assert.match(sql, /access_notes/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS/i);
});

test('mini app ships a local Telegram WebApp SDK and waits for initData', () => {
  const html = fs.readFileSync(path.join(ROOT, 'ui-intl', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'ui-intl', 'app.js'), 'utf8');
  assert.match(html, /telegram-web-app\.js/);
  assert.ok(fs.existsSync(path.join(ROOT, 'ui-intl', 'telegram-web-app.js')));
  assert.match(app, /ensureInitData/);
  assert.match(app, /isTelegramClient/);
  assert.match(app, /initWaiting/);
  assert.doesNotMatch(app, /signInLive[\s\S]{0,120}isTelegramClient/);
  assert.match(app, /parsePriceInput/);
  assert.match(app, /normalizeListingUrl/);
});

test('properties tab uses a sticky save button with an explicit click handler', () => {
  const app = fs.readFileSync(path.join(ROOT, 'ui-intl', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'ui-intl', 'style.css'), 'utf8');
  assert.match(app, /savePropertyNow/);
  assert.match(app, /id="saveProp" type="button"/);
  assert.match(app, /prop-act/);
  assert.match(app, /saveBtn\.onclick/);
  assert.match(css, /\.prop-act/);
  assert.match(css, /\.formerr/);
});

test('POST /v1/intl/properties saves meeting_point and listing without scheme', async () => {
  const { config, intl, file } = openIntl();
  const server = buildIntlServer(config, intl);
  const port = await listen(server);
  const tma = signInitData({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: 42, first_name: 'Broker' }),
  }, TOKEN);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/intl/properties`, {
      method: 'POST',
      headers: {
        Authorization: `tma ${tma}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Marina Gate 2BR',
        kind: 'rent',
        price: '120,000',
        currency: 'AED',
        price_period: 'year',
        tz: 'Asia/Dubai',
        meeting_point: 'Lobby desk',
        access_notes: 'Ask security',
        listing_url: 'bayut.com/property/123',
        address: 'Dubai Marina',
        district: 'Marina',
        bedrooms: 2,
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.ok(body.id);
    const row = intl.store.one('SELECT * FROM i_property WHERE id = ?', [body.id]);
    assert.equal(row.title, 'Marina Gate 2BR');
    assert.equal(row.meeting_point, 'Lobby desk');
    assert.equal(row.access_notes, 'Ask security');
    assert.equal(row.listing_url, 'https://bayut.com/property/123');
    assert.equal(String(row.broker_id), '42');
    const list = await fetch(`http://127.0.0.1:${port}/v1/intl/properties`, {
      headers: { Authorization: `tma ${tma}` },
    }).then((r) => r.json());
    assert.equal(list.ok, true);
    assert.equal(list.properties.some((item) => item.id === body.id), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    intl.close();
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
});
