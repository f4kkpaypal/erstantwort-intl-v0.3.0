'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../../core/config');
const { createIntl } = require('../../core/intl/service');
const { buildIntlServer } = require('../../engine/intlServer');
const { signInitData } = require('../../core/uiAuth');

const BOT = '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function initDataFor(id) {
  return signInitData({
    auth_date: Math.floor(Date.now() / 1000),
    query_id: 'test-' + id,
    user: JSON.stringify({ id, first_name: 'U' + id }),
  }, BOT);
}

function makeServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intl-multi-'));
  const config = loadConfig({
    PRODUCT_MODE: 'intl',
    CHANNEL_MODE: 'sim',
    HASH_SALT: 'multi-salt-value',
    TELEGRAM_BOT_TOKEN: BOT,
    TELEGRAM_ALLOWED_USER_IDS: '*',
    MULTI_USER: 'true',
    OWNER_TELEGRAM_ID: '42',
    DEMO_UI_NO_AUTH: 'false',
    DATA_DIR: dir,
    LLM_MODE: 'mock',
  });
  const intl = createIntl(config, { file: path.join(dir, 'intl.sqlite') });
  return { intl, server: buildIntlServer(config, intl) };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function call(port, id, pathname, options = {}) {
  const headers = {
    Authorization: `tma ${initDataFor(id)}`,
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
  };
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('any Telegram user is admitted, but sees only their own workspace', async () => {
  const { intl, server } = makeServer();
  const port = await listen(server);
  try {
    // owner has a real lead; other users must not see it
    await intl.ingest({
      channel: 'telegram',
      sender_id: 'real-client',
      sender_name: 'Real',
      text: 'Viewing please',
      dedup_key: 'multi-real-1',
      fixture: true,
      broker_id: '42',
      reply_target: '42',
    });

    const ownerSettings = await call(port, 42, '/v1/intl/settings');
    assert.equal(ownerSettings.status, 200);
    assert.equal(ownerSettings.body.is_owner, true);

    const strangerSettings = await call(port, 777, '/v1/intl/settings');
    assert.equal(strangerSettings.status, 200);
    assert.equal(strangerSettings.body.is_owner, false);

    const ownerLeads = await call(port, 42, '/v1/intl/leads');
    assert.equal(ownerLeads.status, 200);
    assert.equal(ownerLeads.body.leads.length, 1);

    const strangerLeads = await call(port, 777, '/v1/intl/leads');
    assert.equal(strangerLeads.status, 200);
    assert.equal(strangerLeads.body.leads.length, 0);

    // every admitted user can edit the shared settings (multi-user mode keeps them editable)
    const strangerSave = await call(port, 777, '/v1/intl/settings', { method: 'POST', body: { reply_style: 'short' } });
    assert.equal(strangerSave.status, 200);
    assert.equal(strangerSave.body.ok, true);

    const ownerSave = await call(port, 42, '/v1/intl/settings', { method: 'POST', body: { reply_style: 'business' } });
    assert.equal(ownerSave.status, 200);
    assert.equal(ownerSave.body.ok, true);

    // and their own properties stay separated
    const mine = await call(port, 111, '/v1/intl/properties');
    const other = await call(port, 222, '/v1/intl/properties');
    assert.equal(mine.status, 200);
    assert.equal(other.status, 200);
    assert.deepEqual(mine.body.properties, []);
    assert.deepEqual(other.body.properties, []);

    // without an invite, a stranger cannot open the owner's workspace
    const forbidden = await call(port, 777, '/v1/intl/leads?workspace=42');
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error_code, 'workspace_forbidden');

    const team = await call(port, 42, '/v1/intl/team');
    assert.equal(team.status, 200);
    assert.equal(team.body.members.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    intl.close();
  }
});
