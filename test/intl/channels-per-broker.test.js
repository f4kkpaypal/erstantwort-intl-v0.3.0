'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../../core/config');
const { createIntl } = require('../../core/intl/service');
const { connectStatus } = require('../../core/intl/desk');

function configFor(dir) {
  return loadConfig({
    PRODUCT_MODE: 'intl',
    CHANNEL_MODE: 'sim',
    HASH_SALT: 'channels-salt-value',
    TELEGRAM_BOT_TOKEN: '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    TELEGRAM_ALLOWED_USER_IDS: '*',
    MULTI_USER: 'true',
    OWNER_TELEGRAM_ID: '42',
    DATA_DIR: dir,
    LLM_MODE: 'mock',
  });
}

test('Telegram Business status is scoped to the current broker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intl-channels-'));
  const config = configFor(dir);
  const intl = createIntl(config, { file: path.join(dir, 'intl.sqlite') });
  try {
    const insert = (id, broker) => intl.store.run(
      `INSERT INTO i_tg_conn (business_connection_id, can_reply, is_enabled, updated_at, user_id, user_chat_id, broker_id)
       VALUES (?, 1, 1, ?, ?, ?, ?)`,
      [id, new Date().toISOString(), broker, broker, broker],
    );
    insert('bc-42', '42');
    insert('bc-111', '111');

    const owner = connectStatus(intl.store, config, { brokerId: '42' });
    const stranger = connectStatus(intl.store, config, { brokerId: '111' });
    const unscoped = connectStatus(intl.store, config);
    assert.equal(owner.connections, 1);
    assert.equal(stranger.connections, 1);
    assert.equal(unscoped.connections, 2);
  } finally {
    intl.close();
  }
});

test('each broker can connect its own Green API instance without touching the owner', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intl-channels-wa-'));
  const config = configFor(dir);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('getStateInstance')) {
      return { ok: true, status: 200, json: async () => ({ stateInstance: 'authorized' }) };
    }
    if (String(url).includes('setSettings')) {
      return { ok: true, status: 200, json: async () => ({ saveSettings: true }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const intl = createIntl(config, { file: path.join(dir, 'intl.sqlite'), fetch: fetchImpl });
  try {
    const before = intl.whatsappStatus('111');
    assert.equal(before.configured, false);

    const saved = await intl.whatsappConnect({
      gateway: 'green',
      id_instance: '710722803004',
      api_token: 'green-api-token-1234567890',
    }, '111');
    assert.equal(saved.ok, true);
    assert.equal(saved.configured, true);

    const mine = intl.whatsappStatus('111');
    const owner = intl.whatsappStatus('42');
    assert.equal(mine.configured, true);
    assert.equal(owner.configured, false, 'owner env stays untouched');
    assert.ok(mine.webhook_url.includes('token='));
    assert.ok(calls.some((url) => url.includes('waInstance710722803004')));

    const conflict = await intl.whatsappConnect({
      gateway: 'green',
      id_instance: '710722803004',
      api_token: 'green-api-token-1234567890',
    }, '222');
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error_code, 'instance_already_connected');

    const settings = intl.getSettings();
    assert.equal(Object.keys(settings).some((key) => key.startsWith('wa_green_token::')), false);
  } finally {
    intl.close();
  }
});
