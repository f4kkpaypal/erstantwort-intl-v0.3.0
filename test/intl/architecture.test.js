'use strict';

// Architecture guards: retry/backoff, strict credential validation, reactive store batching,
// global error interception, client-error endpoint and the settings screen trimming.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { withRetry, fetchWithRetry, backoffMs, isRetryable } = require('../../core/intl/retry');
const validation = require('../../core/intl/validation');
const { createStore } = require('../../ui-intl/store');
const { loadConfig } = require('../../core/config');
const { createIntl } = require('../../core/intl/service');
const { buildIntlServer, bootError } = require('../../engine/intlServer');
const { signInitData } = require('../../core/uiAuth');

const root = path.join(__dirname, '..', '..');
const app = fs.readFileSync(path.join(root, 'ui-intl', 'app.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'ui-intl', 'index.html'), 'utf8');

const waitTick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('withRetry retries 5xx with backoff and honours Retry-After', async () => {
  const delays = [];
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('http_503'), { status: 503 });
    return 'ok';
  }, { attempts: 3, baseMs: 10, sleep: async (ms) => { delays.push(ms); } });
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
  assert.equal(delays.length, 1);
  assert.ok(delays[0] >= 10);

  const honoured = [];
  let secondCalls = 0;
  await withRetry(async () => {
    secondCalls += 1;
    if (secondCalls === 1) throw Object.assign(new Error('http_429'), { status: 429, retryAfterMs: 250 });
    return 'ok';
  }, { attempts: 2, sleep: async (ms) => { honoured.push(ms); } });
  assert.equal(honoured[0], 250);
});

test('withRetry does not retry client errors', async () => {
  let calls = 0;
  await assert.rejects(() => withRetry(async () => {
    calls += 1;
    throw Object.assign(new Error('bad_request'), { status: 400 });
  }, { attempts: 3, sleep: async () => {} }));
  assert.equal(calls, 1);
  assert.equal(isRetryable(Object.assign(new Error('x'), { status: 400 })), false);
  assert.equal(isRetryable(Object.assign(new Error('x'), { status: 503 })), true);
});

test('fetchWithRetry retries 500 and stops on 400', async () => {
  let calls = 0;
  const fiveHundred = { status: 500, headers: { get: () => null }, json: async () => ({}) };
  const ok = { status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) };
  const retried = await fetchWithRetry(async () => {
    calls += 1;
    return calls === 1 ? fiveHundred : ok;
  }, 'https://example.test/api', { method: 'GET' }, { attempts: 2, baseMs: 5, sleep: async () => {} });
  assert.equal(retried.status, 200);
  assert.equal(calls, 2);

  let clientCalls = 0;
  const clientError = { status: 400, headers: { get: () => null }, json: async () => ({}) };
  const passthrough = await fetchWithRetry(async () => {
    clientCalls += 1;
    return clientError;
  }, 'https://example.test/api', { method: 'GET' }, { attempts: 3, sleep: async () => {} });
  assert.equal(passthrough.status, 400);
  assert.equal(clientCalls, 1);
  assert.ok(backoffMs(1, { baseMs: 100, jitter: 0 }) >= 100);
});

test('credential validation accepts real shapes and names the failing field', () => {
  assert.equal(validation.isTelegramToken('123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), true);
  assert.equal(validation.isTelegramToken('123:short'), false);
  assert.equal(validation.isGreenInstance('710722803004'), true);
  assert.equal(validation.isGreenInstance('abc'), false);
  assert.equal(validation.isGreenToken('green-api-token-1234567890'), true);
  assert.equal(validation.isGreenToken('short'), false);
  assert.equal(validation.isCloudToken('EAAGabcdefghijklmnopqrstuvwxyz012345'), true);
  assert.equal(validation.isCloudPhoneId('123456'), true);
  assert.equal(validation.isVerifyToken('meta-verify'), true);
  assert.equal(validation.isAppSecret('abcdef0123456789abcdef0123456789'), true);

  assert.deepEqual(validation.validateGatewayPayload({ gateway: 'green', id_instance: 'abc', api_token: 'short' }), { ok: false, error: 'invalid_credentials', field: 'id_instance' });
  assert.deepEqual(validation.validateGatewayPayload({ gateway: 'cloud' }), { ok: false, error: 'invalid_credentials', field: 'access_token' });
  assert.deepEqual(validation.validateGatewayPayload({ gateway: 'nope' }), { ok: false, error: 'invalid_gateway' });
  assert.deepEqual(validation.validateGatewayPayload({
    gateway: 'cloud',
    cloud_token: 'EAAGabcdefghijklmnopqrstuvwxyz012345',
    cloud_phone_id: '123456',
    cloud_verify: 'meta-verify',
    cloud_secret: 'abcdef0123456789abcdef0123456789',
  }), { ok: true, gateway: 'cloud' });
});

test('the reactive store batches a burst of changes into one notification', async () => {
  const store = createStore({ a: 1, b: 2 });
  let calls = 0;
  let seen = null;
  const off = store.subscribe((state) => { calls += 1; seen = state; });
  store.set({ a: 10 });
  store.set({ b: 20 });
  assert.equal(calls, 0, 'notifications are microtask-batched');
  await waitTick();
  assert.equal(calls, 1);
  assert.deepEqual(seen, { a: 10, b: 20 });
  store.update((state) => ({ ...state, a: state.a + 1 }));
  await waitTick();
  assert.equal(calls, 2);
  assert.equal(store.select('b'), 20);
  off();
  store.set({ a: 0 });
  await waitTick();
  assert.equal(calls, 2);
});

test('boot refuses malformed Telegram and WhatsApp credentials', () => {
  const base = {
    PRODUCT_MODE: 'intl',
    CHANNEL_MODE: 'live',
    HASH_SALT: 'arch-salt-value',
    ALLOW_SQLITE_LIVE: 'true',
    REAL_DATA_ALLOWED: 'true',
    ALLOW_REAL_DATA: 'true',
    TELEGRAM_BOT_TOKEN: '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    TELEGRAM_WEBHOOK_SECRET: 'hook-secret',
    TELEGRAM_ALLOWED_USER_IDS: '42',
    UI_PUBLIC_BASE: 'https://example.test',
  };
  assert.equal(bootError(loadConfig(base)), '');
  assert.equal(bootError(loadConfig({ ...base, TELEGRAM_BOT_TOKEN: '123:short' })), 'telegram_token_invalid');
  assert.equal(bootError(loadConfig({ ...base, WHATSAPP_PROVIDER: 'green', GREENAPI_ID_INSTANCE: 'abc', GREENAPI_API_TOKEN: 'short', GREENAPI_WEBHOOK_TOKEN: 'x' })), 'whatsapp_credentials_invalid');
  assert.equal(bootError(loadConfig({ ...base, WHATSAPP_PROVIDER: 'cloud', WHATSAPP_TOKEN: 'short', WHATSAPP_PHONE_NUMBER_ID: '1', WHATSAPP_VERIFY_TOKEN: 'v', WHATSAPP_APP_SECRET: 's' })), 'whatsapp_credentials_invalid');
});

test('the client-error endpoint accepts boot failures and never leaks the body', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intl-arch-'));
  const config = loadConfig({
    PRODUCT_MODE: 'intl',
    CHANNEL_MODE: 'sim',
    HASH_SALT: 'arch-salt-value',
    TELEGRAM_BOT_TOKEN: '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    TELEGRAM_ALLOWED_USER_IDS: '42',
    DATA_DIR: dir,
    LLM_MODE: 'mock',
    DEMO_UI_NO_AUTH: 'false',
  });
  const intl = createIntl(config, { file: path.join(dir, 'intl.sqlite') });
  const server = buildIntlServer(config, intl);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/intl/client-error`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'boom at boot', screen: 'setup', source: 'window' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    const bad = await fetch(`http://127.0.0.1:${port}/v1/intl/client-error`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
    assert.equal(bad.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    intl.close();
  }
});

test('UI wires the reactive store, global interception, retry and trimmed settings', () => {
  assert.match(index, /<script src="store\.js(?:\?[^"]*)?"><\/script>\s*<script src="tgLaunch\.js(?:\?[^"]*)?"><\/script>/);
  assert.match(app, /uiStore/);
  assert.match(app, /DSHStore\.createStore/);
  assert.match(app, /function reportError\(/);
  assert.match(app, /addEventListener\('unhandledrejection'/);
  assert.match(app, /addEventListener\('error'/);
  assert.match(app, /\/v1\/intl\/client-error/);
  assert.match(app, /renderGlobalErrorBanner/);
  assert.match(app, /function requestRender\(/);
  assert.match(app, /apiInflight/);
  assert.match(app, /function apiBackoff\(/);
  assert.match(app, /whatsappFieldError/);
  assert.match(app, /inspectInitData/);
  // Everything after item 6 is gone from Settings: no quick start, tools or CSV blocks.
  assert.doesNotMatch(app, /class="quickstart"/);
  assert.doesNotMatch(app, /id="exportViewings"/);
  assert.doesNotMatch(app, /id="step-property"/);
  assert.doesNotMatch(app, /id="step-approve"/);
  assert.doesNotMatch(app, /href="#\/simulator"/);
});

test('the strict typecheck gate covers the new architecture modules', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['typecheck:strict'], 'tsc -p tsconfig.strict.json');
  const tsconfig = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.strict.json'), 'utf8'));
  assert.equal(tsconfig.compilerOptions.checkJs, true);
  assert.equal(tsconfig.compilerOptions.strict, true);
  for (const file of ['core/intl/retry.js', 'core/intl/validation.js', 'ui-intl/store.js']) {
    assert.ok(tsconfig.include.includes(file), file);
  }
});
