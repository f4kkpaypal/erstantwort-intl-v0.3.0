'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const {
  buildIntlServer,
  listenPort,
  applyHttpTimeouts,
} = require('../../engine/intlServer');
const { loadConfig } = require('../../core/config');
const { createIntl } = require('../../core/intl/service');

const root = path.join(__dirname, '..', '..');

test('listenPort prefers PORT then INTL_PORT', () => {
  assert.equal(listenPort({ PORT: '3000', INTL_PORT: '8791' }), 3000);
  assert.equal(listenPort({ INTL_PORT: '8791' }), 8791);
  assert.equal(listenPort({}), 8791);
});

test('HTTP server timeouts are bounded for reverse proxies', () => {
  const server = applyHttpTimeouts(http.createServer());
  assert.equal(server.requestTimeout, 60_000);
  assert.equal(server.headersTimeout, 65_000);
  assert.equal(server.keepAliveTimeout, 65_000);
  server.close();
});

test('healthz returns draining while shutting down', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intl-hard-'));
  const config = loadConfig({
    PRODUCT_MODE: 'intl',
    CHANNEL_MODE: 'sim',
    HASH_SALT: 'harden-salt-value',
    TELEGRAM_BOT_TOKEN: '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    TELEGRAM_ALLOWED_USER_IDS: '*',
    MULTI_USER: 'true',
    DEMO_UI_NO_AUTH: 'false',
    DATA_DIR: dir,
    LLM_MODE: 'mock',
  });
  const intl = createIntl(config, { file: path.join(dir, 'intl.sqlite') });
  const state = { draining: true };
  const server = buildIntlServer(config, intl, { state });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 503);
    assert.equal(await res.text(), 'draining');
    state.draining = false;
    const ok = await fetch(`http://127.0.0.1:${port}/readyz`);
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /^ok /);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    intl.close();
  }
});

test('static assets advertise a short public cache; html does not', () => {
  const app = fs.readFileSync(path.join(root, 'engine', 'intlServer.js'), 'utf8');
  assert.match(app, /max-age=86400/);
  assert.match(app, /SIGTERM/);
  assert.match(app, /intl_shutdown/);
});

test('Dockerfile is multi-stage and compose caps logs/memory', () => {
  const docker = fs.readFileSync(path.join(root, 'Dockerfile.intl'), 'utf8');
  assert.match(docker, /AS deps/);
  assert.match(docker, /AS runner/);
  assert.match(docker, /HEALTHCHECK/);
  assert.match(docker, /max-old-space-size=384/);
  const compose = fs.readFileSync(path.join(root, 'docker-compose.intl.yml'), 'utf8');
  assert.match(compose, /max-size: "10m"/);
  assert.match(compose, /mem_limit: 512m/);
  assert.match(compose, /stop_grace_period: 20s/);
  assert.match(compose, /shared_buffers=128MB/);
  assert.match(compose, /LOG_STDOUT: "true"/);
  assert.ok(fs.existsSync(path.join(root, 'Caddyfile.intl')));
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'preflight_server.js')));
});
