#!/usr/bin/env node
'use strict';

// Day-0 smoke for colleague sharing (no live Telegram required).
// Usage: node scripts/team_smoke.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../core/config');
const { createIntl } = require('../core/intl/service');
const { buildIntlServer } = require('../engine/intlServer');
const { signInitData } = require('../core/uiAuth');

const BOT = '123456:TEAMSMOKEAAAAAAAAAAAAAAAAAAAA';

function initDataFor(id) {
  return signInitData({
    auth_date: Math.floor(Date.now() / 1000),
    query_id: 'smoke-' + id,
    user: JSON.stringify({ id, first_name: 'Smoke' + id }),
  }, BOT);
}

async function call(port, id, pathname, options = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `tma ${initDataFor(id)}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    throw new Error(`${pathname} → ${res.status} ${body.error_code || JSON.stringify(body)}`);
  }
  return body;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-smoke-'));
  const config = loadConfig({
    PRODUCT_MODE: 'intl',
    CHANNEL_MODE: 'sim',
    HASH_SALT: 'team-smoke-salt',
    TELEGRAM_BOT_TOKEN: BOT,
    TELEGRAM_ALLOWED_USER_IDS: '*',
    MULTI_USER: 'true',
    DEMO_UI_NO_AUTH: 'false',
    DATA_DIR: dir,
    LLM_MODE: 'mock',
  });
  const intl = createIntl(config, { file: path.join(dir, 'intl.sqlite') });
  const server = buildIntlServer(config, intl);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await intl.ingest({
      channel: 'telegram',
      sender_id: 'smoke-client',
      sender_name: 'Smoke',
      text: 'Hi, booking please',
      dedup_key: 'team-smoke-1',
      fixture: true,
      broker_id: '1001',
      reply_target: '1001',
    });
    const invite = await call(port, 1001, '/v1/intl/team/invite', {
      method: 'POST',
      body: { telegram_id: '2002', role: 'editor' },
    });
    await call(port, 2002, '/v1/intl/team/accept', {
      method: 'POST',
      body: { owner_id: '1001', token: invite.invite_token },
    });
    const leads = await call(port, 2002, '/v1/intl/leads?workspace=1001');
    if (!leads.leads || leads.leads.length !== 1) throw new Error('shared inbox empty');
    await call(port, 1001, '/v1/intl/team/revoke', {
      method: 'POST',
      body: { telegram_id: '2002' },
    });
    const res = await fetch(`http://127.0.0.1:${port}/v1/intl/leads?workspace=1001`, {
      headers: { Authorization: `tma ${initDataFor(2002)}` },
    });
    if (res.status !== 403) throw new Error('revoke did not close access');
    console.log('team_smoke ok');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    intl.close();
  }
}

main().catch((err) => {
  console.error('team_smoke_failed', err.message || err);
  process.exit(1);
});
