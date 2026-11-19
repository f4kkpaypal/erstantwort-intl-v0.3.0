'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../../core/config');
const { connectStatus } = require('../../core/intl/desk');
const { ensureWebhook, refreshWebhookState } = require('../../engine/intlServer');
const { smokeFiles, MIGRATIONS } = require('../../scripts/pg_migrate_smoke');

const root = path.join(__dirname, '..', '..');

test('Dockerfile.intl boots intlServer and render pilot does not use free_host', () => {
  const docker = fs.readFileSync(path.join(root, 'Dockerfile.intl'), 'utf8');
  assert.match(docker, /CMD \["node", "engine\/intlServer\.js"\]/);
  assert.equal(docker.includes('free_host'), false);
  assert.match(docker, /AS deps/);
  assert.match(docker, /INTL_WHATSAPP_UI=false/);
  assert.match(docker, /MULTI_USER=true/);
  assert.match(docker, /AUTO_SET_WEBHOOK=true/);
  assert.match(docker, /HEALTHCHECK/);
  const yaml = fs.readFileSync(path.join(root, 'render.yaml'), 'utf8');
  assert.match(yaml, /name: erstantwort-intl-pilot[\s\S]*dockerfilePath: \.\/Dockerfile\.intl/);
  assert.match(yaml, /name: erstantwort-intl-demo[\s\S]*dockerfilePath: \.\/Dockerfile\.free/);
  const pilotStart = yaml.indexOf('name: erstantwort-intl-pilot');
  const dbStart = yaml.indexOf('\ndatabases:');
  assert.ok(pilotStart >= 0 && dbStart > pilotStart);
  const pilotBlock = yaml.slice(pilotStart, dbStart);
  assert.equal(pilotBlock.includes('Dockerfile.free'), false);
  assert.match(pilotBlock, /key: EPHEMERAL_DISK/);
  assert.match(pilotBlock, /key: ALLOW_REAL_DATA/);
  assert.match(pilotBlock, /key: AUTO_SET_WEBHOOK/);
  assert.match(fs.readFileSync(path.join(root, 'docker-compose.intl.yml'), 'utf8'), /Dockerfile\.intl/);
});

test('INTL_WHATSAPP_UI defaults off and connectStatus hides WhatsApp checklist', () => {
  const config = loadConfig({
    PRODUCT_MODE: 'intl',
    HASH_SALT: 'intl-test-salt-value',
    CHANNEL_MODE: 'sim',
  });
  assert.equal(config.INTL_WHATSAPP_UI, false);
  assert.equal(config.AUTO_SET_WEBHOOK, false);
  const store = {
    all() { return []; },
    one() { return { at: '' }; },
  };
  const status = connectStatus(store, config);
  assert.equal(status.whatsapp_ui, false);
  assert.equal(status.whatsapp.ui_enabled, false);
  assert.equal(status.checklist.some((row) => row.id === 'whatsapp'), false);
  const on = connectStatus(store, { ...config, INTL_WHATSAPP_UI: true });
  assert.equal(on.whatsapp_ui, true);
  assert.equal(on.whatsapp.ui_enabled, true);
  assert.equal(on.checklist.some((row) => row.id === 'whatsapp'), true);
});

test('ensureWebhook sets the URL on live when AUTO_SET_WEBHOOK is on', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
    if (String(url).includes('setWebhook')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: { url: 'https://pilot.example/v1/intl/telegram', pending_update_count: 0 },
      }),
    };
  };
  const config = loadConfig({
    PRODUCT_MODE: 'intl',
    CHANNEL_MODE: 'live',
    HASH_SALT: 'intl-test-salt-value',
    REAL_DATA_ALLOWED: 'true',
    ALLOW_REAL_DATA: 'true',
    ALLOW_SQLITE_LIVE: 'true',
    AUTO_SET_WEBHOOK: 'true',
    TELEGRAM_BOT_TOKEN: '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    TELEGRAM_WEBHOOK_SECRET: 'hook-secret',
    TELEGRAM_ALLOWED_USER_IDS: '42',
    UI_PUBLIC_BASE: 'https://pilot.example',
  });
  const intl = { webhookState: {} };
  const result = await ensureWebhook(intl, config, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(intl.webhookState.url_set, true);
  assert.ok(calls.some((row) => row.url.includes('setWebhook')));
  assert.equal(calls.find((row) => row.url.includes('setWebhook')).body.url, 'https://pilot.example/v1/intl/telegram');
});

test('ensureWebhook skips when AUTO_SET_WEBHOOK is off but can still refresh state', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { url: 'https://x.example/v1/intl/telegram' } }),
    };
  };
  const config = loadConfig({
    PRODUCT_MODE: 'intl',
    CHANNEL_MODE: 'live',
    HASH_SALT: 'intl-test-salt-value',
    REAL_DATA_ALLOWED: 'true',
    ALLOW_REAL_DATA: 'true',
    ALLOW_SQLITE_LIVE: 'true',
    AUTO_SET_WEBHOOK: 'false',
    TELEGRAM_BOT_TOKEN: '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    TELEGRAM_WEBHOOK_SECRET: 'hook-secret',
    TELEGRAM_ALLOWED_USER_IDS: '42',
    UI_PUBLIC_BASE: 'https://x.example',
  });
  const intl = { webhookState: {} };
  const result = await ensureWebhook(intl, config, fetchImpl);
  assert.equal(result.skipped, true);
  assert.equal(called, true);
  assert.equal(intl.webhookState.url_set, true);
  await refreshWebhookState(intl, config, fetchImpl);
  assert.equal(intl.webhookState.url_set, true);
});

test('migration smoke files 002 through 007 are present and shaped', () => {
  const result = smokeFiles();
  assert.equal(result.ok, true);
  assert.equal(result.files, MIGRATIONS.length);
  assert.equal(MIGRATIONS[0], '002_intl.sql');
  assert.equal(MIGRATIONS[MIGRATIONS.length - 1], '007_intl_team.sql');
});

test('daily runbook and acceptance checklist ship in docs', () => {
  const pilot = fs.readFileSync(path.join(root, 'docs', 'DAILY_PILOT.md'), 'utf8');
  assert.match(pilot, /Dockerfile\.intl/);
  assert.match(pilot, /docker-compose\.intl\.yml/);
  assert.match(pilot, /Render Free/);
  assert.match(pilot, /AUTO_SET_WEBHOOK/);
  const accept = fs.readFileSync(path.join(root, 'docs', 'DAILY_ACCEPTANCE.md'), 'utf8');
  assert.match(accept, /7/);
  assert.match(accept, /STOP/);
  assert.match(accept, /slot_unavailable/);
});
