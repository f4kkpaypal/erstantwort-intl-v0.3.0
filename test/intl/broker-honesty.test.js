'use strict';

// Broker trust batch: no WhatsApp theatre, links instead of "attachments", AED default,
// meeting point for the field, an undo for the swipe, note toggles and a CSV export.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../../core/config');
const { createIntl } = require('../../core/intl/service');

const root = path.join(__dirname, '..', '..');
const app = fs.readFileSync(path.join(root, 'ui-intl', 'app.js'), 'utf8');
const optionsSrc = fs.readFileSync(path.join(root, 'core', 'intl', 'options.js'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.join(root, 'ui-intl', 'i18n', 'en.json'), 'utf8'));
const ru = JSON.parse(fs.readFileSync(path.join(root, 'ui-intl', 'i18n', 'ru.json'), 'utf8'));

function open() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intl-honesty-'));
  const config = loadConfig({
    PRODUCT_MODE: 'intl',
    CHANNEL_MODE: 'sim',
    HASH_SALT: 'honesty-salt',
    TELEGRAM_BOT_TOKEN: '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    TELEGRAM_ALLOWED_USER_IDS: '42',
    DATA_DIR: dir,
    LLM_MODE: 'mock',
  });
  const intl = createIntl(config, { file: path.join(dir, 'intl.sqlite'), clock: () => new Date('2026-10-28T04:30:00.000Z') });
  return { intl };
}

async function withLead(intl) {
  const property = await intl.addProperty({
    id: 'P1', title: 'Marina 2BR', kind: 'sale', price: 310000, currency: 'AED', price_period: 'total',
    tz: 'Asia/Dubai', address: 'Marina Gate 1', district: 'Dubai Marina',
    meeting_point: 'Lobby, Marina Gate 1', access_notes: 'Parking P2, gate code 4431, ask for Ahmed',
  }, '42');
  assert.equal(property.ok, true, JSON.stringify(property));
  const lead = await intl.ingest({
    channel: 'telegram', sender_id: '42', sender_name: 'Omar', text: 'Hi, can I view Marina 2BR today?',
    property_id: 'P1', dedup_key: 'honesty-1', fixture: true, broker_id: '42',
  });
  return { leadId: lead.lead_id };
}

test('property keeps the meeting point and access notes for the field', async () => {
  const { intl } = open();
  try {
    await withLead(intl);
    const row = intl.store.one('SELECT * FROM i_property WHERE id = ?', ['P1']);
    assert.equal(row.meeting_point, 'Lobby, Marina Gate 1');
    assert.equal(row.access_notes, 'Parking P2, gate code 4431, ask for Ahmed');
    const listed = intl.store.all('SELECT * FROM i_property WHERE id = ?', ['P1'])[0];
    assert.equal(listed.address, 'Marina Gate 1');
  } finally { intl.close(); }
});

test('CSV export carries the field data and the lead list', async () => {
  const { intl } = open();
  try {
    const { leadId } = await withLead(intl);
    const viewings = intl.exportCsv('viewings', '42');
    assert.equal(viewings.filename, 'intl-viewings.csv');
    assert.match(viewings.csv.split('\n')[0], /meeting_point/);
    assert.match(viewings.csv.split('\n')[0], /access_notes/);
    const leads = intl.exportCsv('leads', '42');
    assert.equal(leads.filename, 'intl-leads.csv');
    assert.match(leads.csv, new RegExp(leadId));
    assert.match(leads.csv, /Marina 2BR/);
  } finally { intl.close(); }
});

test('the swipe can be undone and the lead returns to the active list', async () => {
  const { intl } = open();
  try {
    const { leadId } = await withLead(intl);
    await intl.handled(leadId, '42');
    assert.equal(intl.lead(leadId, '42').bucket, 'awaiting');
    const back = await intl.unhandled(leadId, '42');
    assert.equal(back.status, 'pending_approval');
    assert.equal(intl.lead(leadId, '42').bucket, 'active');
    assert.equal(intl.audit(leadId).some((row) => row.action === 'unhandled'), true);
    const again = await intl.unhandled(leadId, '42');
    assert.equal(again.status, 409);
  } finally { intl.close(); }
});

test('both footer notes can be switched off by the broker', async () => {
  const { intl } = open();
  try {
    const { leadId } = await withLead(intl);
    await intl.saveDraft(leadId, { text: 'Hello Omar, Marina 2BR is available.', option_id: null });
    const { sent } = await intl.send(leadId, {
      manual: true,
      idempotency_key: 'honesty-send-1',
      draft_version: intl.lead(leadId, '42').draft.version,
    }, '42');
    assert.ok(sent || sent === undefined);
    const first = intl.store.all('SELECT text FROM i_message WHERE lead_id = ? AND direction = ?', [leadId, 'out']);
    const sentText = first.map((row) => row.text).join('\n');
    assert.match(sentText, /STOP/);
    assert.match(sentText, /AI-assisted|ИИ/);
    await intl.settings({ note_stop: false, note_ai: false }, '42');
    const settings = intl.getSettings();
    assert.equal(settings.note_stop, '0');
    assert.equal(settings.note_ai, '0');
  } finally { intl.close(); }
});

test('materials are sent as links, never as "attached files"', () => {
  assert.doesNotMatch(optionsSrc, /приложены/);
  assert.match(optionsSrc, /Ссылка на материалы/);
  assert.doesNotMatch(optionsSrc, /files are attached/);
  assert.match(optionsSrc, /Brochure and floor plan links/);
});

test('the UI is honest about channels and the AED default', () => {
  assert.doesNotMatch(app, /Отправить · WhatsApp/);
  assert.match(app, /t\('whatsapp'\)/);
  assert.match(app, /t\('simulator'\)/);
  assert.match(app, /<option>AED<\/option><option>USD<\/option>/);
  assert.ok(en.step1.includes('Telegram Business'));
  assert.ok(ru.step1.includes('Telegram Business'));
  assert.match(en.step1s, /official Meta Cloud API/);
  assert.match(ru.step1s, /официальный Cloud API Meta/);
});

test('the pilot page and the connection warnings exist in both languages', () => {
  for (const key of ['pilotTitle', 'pilotPrice', 'pilotWarning', 'pilotLang', 'pilotVoice', 'pilotExc1', 'pilotExc5']) {
    assert.equal(typeof en[key], 'string', `EN ${key}`);
    assert.equal(typeof ru[key], 'string', `RU ${key}`);
  }
  assert.match(en.pilotWarning, /One Business bot/);
  assert.match(ru.pilotWarning, /Один Business-бот/);
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ru).sort());
});

test('the lead card explains the next action and offers the confirmation draft', () => {
  assert.match(app, /t\('nextStep'\)/);
  assert.match(app, /t\('actionHot'\)/);
  assert.match(app, /id="confirmDraft"/);
  assert.match(app, /t\('confirmClientBtn'\)/);
  assert.match(app, /id="toggle-stop"/);
  assert.match(app, /id="toggle-ai"/);
  assert.match(app, /data-undo/);
});
