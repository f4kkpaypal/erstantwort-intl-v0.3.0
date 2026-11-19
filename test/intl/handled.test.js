'use strict';

// "Processed" folder: a broker who answered a lead by hand (phone, WhatsApp outside the app) marks
// it handled so it leaves the active list. Same bucket as an in-app reply, without a sent message.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../../core/config');
const { createIntl } = require('../../core/intl/service');

function open() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intl-handled-'));
  const config = loadConfig({
    PRODUCT_MODE: 'intl',
    CHANNEL_MODE: 'sim',
    HASH_SALT: 'handled-salt',
    TELEGRAM_BOT_TOKEN: '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    TELEGRAM_ALLOWED_USER_IDS: '42',
    DATA_DIR: dir,
    DEMO_UI_NO_AUTH: 'false',
    LLM_MODE: 'mock',
  });
  const intl = createIntl(config, { file: path.join(dir, 'intl.sqlite'), clock: () => new Date('2026-10-28T04:30:00.000Z') });
  return { intl };
}

test('marking a lead handled moves it to the processed folder and drops the draft', async () => {
  const { intl } = open();
  try {
    await intl.addProperty({
      id: 'P1', title: 'Marina', kind: 'rent', price: 120000, currency: 'AED', price_period: 'year', tz: 'Asia/Dubai',
    }, '42');
    const lead = await intl.ingest({
      channel: 'wa_sim', sender_id: 'sim:handled', sender_name: 'Omar', text: 'Can I view this week?',
      property_id: 'P1', dedup_key: 'handled-1', fixture: true, broker_id: '42',
    });
    assert.equal(intl.lead(lead.lead_id, '42').bucket, 'active');
    await intl.saveDraft(lead.lead_id, { text: 'Hello Omar, which time suits you?', option_id: null });
    assert.ok(intl.store.one('SELECT lead_id FROM i_draft WHERE lead_id = ?', [lead.lead_id]), 'draft exists before handling');

    const result = await intl.handled(lead.lead_id, '42');
    assert.equal(result.status, 'handled');

    const after = intl.lead(lead.lead_id, '42');
    assert.equal(after.status, 'handled');
    assert.equal(after.bucket, 'awaiting');
    assert.equal(intl.store.one('SELECT lead_id FROM i_draft WHERE lead_id = ?', [lead.lead_id]), null);
    assert.equal(intl.audit(lead.lead_id).some((row) => row.action === 'handled'), true);

    const list = intl.leads({ broker_id: '42' });
    assert.equal(list.filter((row) => row.bucket === 'active').length, 0, 'active list is cleared');
    assert.equal(list.filter((row) => row.bucket === 'awaiting').length, 1, 'lead sits in the processed folder');

    const again = await intl.handled(lead.lead_id, '42');
    assert.equal(again.already, true);
  } finally {
    intl.close();
  }
});

test('handled is refused for stopped and archived leads', async () => {
  const { intl } = open();
  try {
    await intl.addProperty({
      id: 'P1', title: 'Marina', kind: 'rent', price: 120000, currency: 'AED', price_period: 'year', tz: 'Asia/Dubai',
    }, '42');
    const lead = await intl.ingest({
      channel: 'wa_sim', sender_id: 'sim:stop', sender_name: 'Nina', text: 'STOP',
      property_id: 'P1', dedup_key: 'handled-2', fixture: true, broker_id: '42',
    });
    await intl.stop(lead.lead_id, '42');
    const refused = await intl.handled(lead.lead_id, '42');
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 409);
  } finally {
    intl.close();
  }
});
