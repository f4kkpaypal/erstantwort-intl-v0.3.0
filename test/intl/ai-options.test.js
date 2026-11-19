'use strict';

// External AI reply options are an opt-in: INTL_AI_OPTIONS=false must mean zero egress, even if
// DeepSeek/Gemini keys happen to sit in the environment. When the flag is on, the same request may
// call the provider; the response then falls back to the rule-based options if the provider fails.
//
// undici.request is stubbed instead of patched at the HTTP layer: core/intl/deepseek.js captures
// the destructured `request` at load time, so the stub has to exist before that module is loaded.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const undici = require('undici');
const calls = [];
const originalRequest = undici.request;
undici.request = async (target) => {
  calls.push(String(typeof target === 'string' ? target : (target && (target.href || target.url)) || target));
  throw new Error('network_blocked_in_test');
};
for (const mod of ['../../core/intl/deepseek', '../../core/intl/gemini', '../../engine/intlServer']) {
  try {
    delete require.cache[require.resolve(mod)];
  } catch { /* not loaded yet */ }
}
const { buildIntlServer, aiOptionsEnabled, aiCacheGet, aiCacheSet, aiCacheClear } = require('../../engine/intlServer');
const { loadConfig } = require('../../core/config');
const { createIntl } = require('../../core/intl/service');
const { signInitData } = require('../../core/uiAuth');
undici.request = originalRequest;

const BASE_ENV = {
  PRODUCT_MODE: 'intl',
  CHANNEL_MODE: 'sim',
  HASH_SALT: 'intl-ai-test-salt',
  TELEGRAM_BOT_TOKEN: '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  TELEGRAM_ALLOWED_USER_IDS: '42',
  UI_PUBLIC_BASE: 'http://127.0.0.1:9',
  DEMO_UI_NO_AUTH: 'false',
  LLM_MODE: 'mock',
};

function configOf(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intl-ai-'));
  return loadConfig({ ...BASE_ENV, DATA_DIR: dir, ...extra });
}

function headersFor(config) {
  return {
    Authorization: `tma ${signInitData({
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: 42 }),
    }, config.TELEGRAM_BOT_TOKEN)}`,
    'Content-Type': 'application/json',
  };
}

async function open(config) {
  const dir = config.DATA_DIR;
  const intl = createIntl(config, { file: path.join(dir, 'intl.sqlite'), clock: () => new Date('2026-10-28T04:30:00.000Z') });
  const server = buildIntlServer(config, intl);
  await intl.addProperty({
    id: 'P1', title: 'Marina', kind: 'rent', price: 120000, currency: 'AED', price_period: 'year', tz: 'Asia/Dubai',
  }, '42');
  const lead = await intl.ingest({
    channel: 'wa_sim', sender_id: 'sim:ai-test', sender_name: 'Omar', text: 'Can I view Marina this week?',
    property_id: 'P1', dedup_key: 'ai-test-1', fixture: true, broker_id: '42',
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { intl, server, port, leadId: lead.lead_id };
}

async function withServer(config, fn) {
  const ctx = await open(config);
  try {
    return await fn(ctx);
  } finally {
    await new Promise((done) => ctx.server.close(done));
    ctx.intl.close();
  }
}

test('AI options are off by default: no key, no call, rule-based fallback', async () => {
  calls.length = 0;
  const config = configOf({ DEEPSEEK_API_KEY: 'sk-test-not-used' });
  assert.equal(config.INTL_AI_OPTIONS, false);
  assert.equal(aiOptionsEnabled(config), false);
  await withServer(config, async ({ port, leadId }) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/intl/leads/${encodeURIComponent(leadId)}/ai-drafts`, {
      method: 'POST', headers: headersFor(config), body: '{}',
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ai_enabled, false);
    assert.equal(body.engine, 'fallback');
    const list = await fetch(`http://127.0.0.1:${port}/v1/intl/leads`, { headers: headersFor(config) });
    assert.equal(list.status, 200);
    const one = await fetch(`http://127.0.0.1:${port}/v1/intl/leads/${encodeURIComponent(leadId)}`, { headers: headersFor(config) });
    assert.equal(one.status, 200);
    const lead = await one.json();
    assert.equal(lead.ai_engine, undefined);
  });
  assert.deepEqual(calls, [], 'no provider request may leave the process while the flag is off');
});

test('AI options stay off on the live channel without the real-data opt-in', () => {
  const config = configOf({ INTL_AI_OPTIONS: 'true', DEEPSEEK_API_KEY: 'sk-test', CHANNEL_MODE: 'live' });
  assert.equal(aiOptionsEnabled(config), false);
});

test('AI options are off when the flag is on but no provider key exists', () => {
  const config = configOf({ INTL_AI_OPTIONS: 'true' });
  assert.equal(aiOptionsEnabled(config), false);
});

test('flag on, key present, sim channel: the provider is called and a failure falls back', async () => {
  calls.length = 0;
  const config = configOf({ INTL_AI_OPTIONS: 'true', DEEPSEEK_API_KEY: 'sk-test' });
  assert.equal(aiOptionsEnabled(config), true);
  await withServer(config, async ({ port, leadId }) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/intl/leads/${encodeURIComponent(leadId)}/ai-drafts`, {
      method: 'POST', headers: headersFor(config), body: '{}',
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ai_enabled, true);
    assert.equal(body.engine, 'fallback');
    assert.ok(Array.isArray(body.options));
  });
  assert.ok(calls.length >= 1, 'the provider must be called once the gate opens');
  assert.ok(calls.every((url) => url.includes('api.deepseek.com') || url.includes('generativelanguage.googleapis.com')));
});

test('the options cache is bounded and expires', async () => {
  const config = configOf({ AI_OPTIONS_MAX: '2', AI_OPTIONS_TTL_S: '1' });
  aiCacheClear();
  aiCacheSet('a', [{ id: 'x' }], config);
  aiCacheSet('b', [{ id: 'y' }], config);
  aiCacheSet('c', [{ id: 'z' }], config);
  assert.equal(aiCacheGet('a', config), null, 'oldest entry is evicted at the limit');
  assert.deepEqual(aiCacheGet('b', config), [{ id: 'y' }]);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(aiCacheGet('b', config), null, 'entries expire after AI_OPTIONS_TTL_S');
  aiCacheClear();
});
