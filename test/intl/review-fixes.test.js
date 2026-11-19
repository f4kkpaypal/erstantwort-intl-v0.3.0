'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const jpeg = require('jpeg-js');
const { loadConfig } = require('../../core/config');
const { signInitData } = require('../../core/uiAuth');
const { createIntl } = require('../../core/intl/service');
const { buildIntlServer } = require('../../engine/intlServer');
const { isPrivateAddress, parseListingHtml, fetchListing } = require('../../core/intl/listingImport');

const PG_TABLES = [
  'i_time_hold', 'i_audit', 'i_idem', 'i_message', 'i_draft', 'i_send', 'i_viewing',
  'i_slot', 'i_tg_update', 'i_tg_conn', 'i_lead', 'i_file', 'i_property', 'i_optout', 'i_settings',
];

const NOW = new Date('2026-10-28T04:30:00.000Z');

function openIntl(extra = {}, hooks = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
  const pgUrl = String(process.env.INTL_DATABASE_URL || '').trim();
  const config = loadConfig({
    PRODUCT_MODE: 'intl',
    CHANNEL_MODE: 'sim',
    HASH_SALT: 'intl-test-salt',
    ENGINE_TOKEN: 'intl-engine-token-0123456789',
    TELEGRAM_BOT_TOKEN: '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    TELEGRAM_ALLOWED_USER_IDS: '42',
    TELEGRAM_WEBHOOK_SECRET: 'hook-secret',
    TG_TEST_LEAD_IDS: '9300000001',
    DATA_DIR: dir,
    UI_PUBLIC_BASE: 'http://127.0.0.1:8791',
    REAL_DATA_ALLOWED: 'false',
    DEMO_UI_NO_AUTH: 'false',
    BROKER_TZ: 'Asia/Dubai',
    ...(pgUrl ? { INTL_DATABASE_URL: pgUrl, DATABASE_URL: pgUrl } : {}),
    ...extra,
  });
  const intl = createIntl(config, {
    ...(pgUrl ? {} : { file: path.join(dir, 'intl.sqlite') }),
    clock: () => NOW,
    fetch: hooks.fetch,
  });
  if (pgUrl) {
    for (const table of PG_TABLES) intl.store.run(`DELETE FROM ${table}`);
  }
  return { intl, config };
}

function conn(id = 'bc1') {
  return {
    business_connection: {
      id,
      is_enabled: true,
      rights: { can_reply: true },
      user: { id: 42 },
      user_chat_id: 7042,
    },
  };
}

function business(id, messageId, text, updateId) {
  return {
    update_id: updateId,
    business_message: {
      message_id: messageId,
      chat: { id: 555001, type: 'private' },
      text,
      date: Math.floor(NOW.getTime() / 1000),
      business_connection_id: id,
      from: { id: 555001, first_name: 'Nina' },
    },
  };
}

test('a fetch that throws after sendMessage is not retried and the button stays 409', async () => {
  let calls = 0;
  const fetch = async (url) => {
    if (String(url).includes('sendMessage')) {
      calls += 1;
      throw new Error('socket hang up');
    }
    throw new Error('unexpected');
  };
  const { intl } = openIntl({ CHANNEL_MODE: 'live' }, { fetch });
  await intl.addProperty({
    id: 'P1', title: 'Marina', kind: 'rent', price: 120000, currency: 'AED', price_period: 'year', tz: 'Asia/Dubai',
  }, '42');
  await intl.telegram(conn());
  const lead = await intl.telegram(business('bc1', 1, 'What is the price?', 41));
  const draft = await intl.saveDraft(lead.lead_id, { text: 'The price is listed.', option_id: 'price' });
  const sent = await intl.send(lead.lead_id, { draft_version: draft.version, idempotency_key: 'throw-1' }, '42');
  assert.equal(calls, 1);
  assert.equal(sent.status, 409);
  assert.equal(sent.error_code, 'unknown_delivery');
  const again = await intl.send(lead.lead_id, { draft_version: draft.version, idempotency_key: 'throw-1' }, '42');
  assert.equal(again.status, 409);
  const other = await intl.send(lead.lead_id, { draft_version: draft.version, idempotency_key: 'throw-2' }, '42');
  assert.equal(other.status, 409);
  assert.equal(calls, 1);
  const row = intl.store.one('SELECT status FROM i_send WHERE lead_id = ?', [lead.lead_id]);
  assert.equal(row.status, 'unknown_delivery');
  intl.close();
});

test('live unknown connection is 500 and does not record update_id', async () => {
  const fetch = async () => { throw new Error('telegram down'); };
  const { intl } = openIntl({ CHANNEL_MODE: 'live' }, { fetch });
  const result = await intl.telegram(business('missing', 9, 'Hello', 501));
  assert.equal(result.status, 500);
  assert.equal(result.error_code, 'connection_unknown');
  assert.equal(intl.store.one('SELECT update_id FROM i_tg_update WHERE update_id = ?', [501]), null);
  intl.close();
});

test('private, mapped, and special-purpose addresses are blocked', () => {
  const blocked = [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.5',
    '169.254.169.254',
    '0.0.0.0',
    '0.1.2.3',
    '100.64.0.1',
    '198.18.0.1',
    '192.0.0.1',
    '224.0.0.1',
    '240.0.0.1',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd00::1',
    'fec0::1',
    'ff02::1',
    '::ffff:7f00:1',
    '::ffff:127.0.0.1',
    '::ffff:a9fe:a9fe',
    '::ffff:0.0.0.0',
    '::ffff:0:0',
    '::0.0.0.0',
    '::ffff:0.0.0.1',
    '::ffff:0:1',
    '::7f00:1',
    '64:ff9b::7f00:1',
    '64:ff9b::8.8.8.8',
    '2002:7f00:1::',
    '2002:0808:0808::',
  ];
  for (const ip of blocked) assert.equal(isPrivateAddress(ip), true, ip);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('1.1.1.1'), false);
  assert.equal(isPrivateAddress('2001:4860:4860::8888'), false);
  assert.equal(isPrivateAddress('::ffff:8.8.8.8'), false);
});

test('a redirect to an IPv4-mapped loopback is not fetched', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: false,
      status: 302,
      headers: { get: (name) => (name === 'location' ? 'http://[::ffff:7f00:1]/secret' : '') },
      arrayBuffer: async () => Buffer.from('nope'),
    };
  };
  const result = await fetchListing('https://example.com/listing', {
    fetchImpl,
    lookup: async () => [{ address: '93.184.216.34' }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error_code, 'import_blocked');
  assert.equal(calls, 1);
  let mapped = 0;
  const mappedFetch = async () => {
    mapped += 1;
    return {
      ok: false,
      status: 302,
      headers: { get: (name) => (name === 'location' ? 'http://[::ffff:0.0.0.0]/secret' : '') },
      arrayBuffer: async () => Buffer.from('nope'),
    };
  };
  const redirected = await fetchListing('https://example.com/listing', {
    fetchImpl: mappedFetch,
    lookup: async () => [{ address: '93.184.216.34' }],
  });
  assert.equal(redirected.ok, false);
  assert.equal(redirected.error_code, 'import_blocked');
  assert.equal(mapped, 1);
});

test('1.5 MB of digits parses quickly and a code point past unicode is skipped', () => {
  const html = `<title>&#99999999; Loft</title>${'1'.repeat(1500000)}`;
  const start = Date.now();
  let parsed;
  assert.doesNotThrow(() => { parsed = parseListingHtml(html); });
  assert.ok(Date.now() - start < 200, String(Date.now() - start));
  assert.equal(parsed.fields.title, 'Loft');
  assert.doesNotThrow(() => parseListingHtml('&#99999999;&#x110000;'));
});

test('a 300 KB photo is compressed and saved with the property', async () => {
  const width = 640;
  const height = 480;
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = i % 251;
    data[i + 1] = (i * 3) % 251;
    data[i + 2] = (i * 7) % 251;
    data[i + 3] = 255;
  }
  const raw = Buffer.from(jpeg.encode({ data, width, height }, 90).data);
  assert.ok(raw.length >= 300 * 1024, String(raw.length));
  const html = '<html><head><title>Loft</title><meta property="og:image" content="https://cdn.example.com/photo.jpg"></head></html>';
  const fetchImpl = async (url) => {
    if (String(url).includes('photo')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => raw,
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'text/html' },
      arrayBuffer: async () => Buffer.from(html),
    };
  };
  const loaded = await fetchListing('https://example.com/loft', {
    fetchImpl,
    lookup: async () => [{ address: '93.184.216.34' }],
  });
  assert.equal(loaded.ok, true);
  const photo = loaded.fields.photos[0];
  const bytes = Buffer.from(photo.dataUrl.split(',')[1], 'base64');
  assert.ok(bytes.length <= 90000, String(bytes.length));
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1], 0xd8);
  const { intl } = openIntl();
  const saved = await intl.addProperty({
    title: 'Loft',
    kind: 'rent',
    price: 1000,
    currency: 'USD',
    price_period: 'year',
    tz: 'Asia/Dubai',
    photos: [photo.dataUrl],
  }, '42');
  assert.equal(saved.ok, true);
  const row = intl.store.one('SELECT bytes, length(bytes) AS n FROM i_file WHERE property_id = ?', [saved.id]);
  const stored = Buffer.isBuffer(row.bytes) ? row.bytes : Buffer.from(row.bytes);
  assert.ok(stored.length > 0);
  assert.ok(stored.length <= 90000);
  assert.equal(intl.store.one('SELECT id FROM i_property WHERE id = ?', [saved.id]).id, saved.id);
  intl.close();
});

test('unspecified mapped addresses are blocked, including a live request and a redirect', async () => {
  for (const ip of ['::ffff:0.0.0.0', '::ffff:0:0', '::0.0.0.0', '::ffff:0.0.0.1', '::ffff:0:1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    res.end('<title>INTERNAL-ADMIN</title>');
  });
  await new Promise((resolve) => server.listen(0, '::', resolve));
  try {
    const port = server.address().port;
    const result = await fetchListing(`http://[::ffff:0.0.0.0]:${port}/`);
    assert.equal(result.ok, false);
    assert.equal(result.error_code, 'import_blocked');
    assert.equal(hits, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('tag stripping stays fast on a long run of angle brackets', () => {
  const prefixes = ['<', '<a', '<script', '<style', '<meta ', '<img src=', '<title'];
  for (const prefix of prefixes) {
    const html = prefix.repeat(Math.ceil(1500000 / prefix.length)).slice(0, 1500000);
    const start = Date.now();
    assert.doesNotThrow(() => parseListingHtml(html));
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 300, `${prefix} ${elapsed}`);
  }
  const narrow = '<'.repeat(320 * 1024);
  const start = Date.now();
  parseListingHtml(narrow);
  assert.ok(Date.now() - start < 200, String(Date.now() - start));
});

test('a 12000x12000 PNG is skipped before it is decoded', async () => {
  const width = 12000;
  const height = 12000;
  const row = Buffer.alloc(1 + width);
  const deflate = zlib.createDeflate({ level: 1 });
  const parts = [];
  const idat = await new Promise((resolve, reject) => {
    deflate.on('data', (chunk) => parts.push(chunk));
    deflate.on('error', reject);
    deflate.on('end', () => resolve(Buffer.concat(parts)));
    for (let y = 0; y < height; y += 1) deflate.write(row);
    deflate.end();
  });
  function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  const html = '<html><head><title>Loft</title><meta property="og:image" content="https://cdn.example.com/bomb.png"></head></html>';
  const fetchImpl = async (url) => {
    if (String(url).includes('bomb')) {
      return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => png };
    }
    return { ok: true, status: 200, headers: { get: () => 'text/html' }, arrayBuffer: async () => Buffer.from(html) };
  };
  const start = Date.now();
  const loaded = await fetchListing('https://example.com/loft', {
    fetchImpl,
    lookup: async () => [{ address: '93.184.216.34' }],
  });
  assert.ok(Date.now() - start < 200, String(Date.now() - start));
  assert.equal(loaded.ok, true);
  assert.equal(loaded.fields.photos, undefined);
});

test('an unreachable pinned address does not stretch the import deadline', async () => {
  const start = Date.now();
  const result = await fetchListing('http://example.com/listing', {
    lookup: async () => [{ address: '192.0.2.1' }],
    deadlineMs: 2000,
  });
  const elapsed = Date.now() - start;
  assert.equal(result.ok, false);
  assert.ok(elapsed < 3000, String(elapsed));
});

test('force with the same key sends once, and another key does not', async () => {
  let calls = 0;
  const fetch = async (url) => {
    if (!String(url).includes('sendMessage')) throw new Error('unexpected');
    calls += 1;
    if (calls === 1) throw new Error('socket hang up');
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 9 } }) };
  };
  const { intl } = openIntl({ CHANNEL_MODE: 'live' }, { fetch });
  await intl.addProperty({
    id: 'P1', title: 'Marina', kind: 'rent', price: 120000, currency: 'AED', price_period: 'year', tz: 'Asia/Dubai',
  }, '42');
  await intl.telegram(conn());
  const lead = await intl.telegram(business('bc1', 1, 'What is the price?', 41));
  const draft = await intl.saveDraft(lead.lead_id, { text: 'The price is listed.', option_id: 'price' });
  const sent = await intl.send(lead.lead_id, { draft_version: draft.version, idempotency_key: 'force-1' }, '42');
  assert.equal(sent.status, 409);
  assert.equal(sent.error_code, 'unknown_delivery');
  const again = await intl.send(lead.lead_id, {
    draft_version: draft.version,
    idempotency_key: 'force-1',
    force: true,
  }, '42');
  assert.equal(again.ok, true);
  assert.equal(again.lead_status, 'sent');
  assert.equal(calls, 2);
  const other = await intl.send(lead.lead_id, {
    draft_version: draft.version,
    idempotency_key: 'force-2',
    force: true,
  }, '42');
  assert.equal(other.status, 409);
  assert.equal(other.error_code, 'duplicate_send');
  assert.equal(calls, 2);
  intl.close();
});

test('a Telegram 404 for an unknown connection is not retried by the webhook', async () => {
  const fetch = async () => ({
    ok: false,
    status: 404,
    json: async () => ({ ok: false, description: 'Bad Request: connection not found' }),
  });
  const { intl } = openIntl({ CHANNEL_MODE: 'live' }, { fetch });
  const result = await intl.telegram(business('gone', 3, 'Hello', 801));
  assert.equal(result.reason, 'connection_gone');
  assert.notEqual(result.status, 500);
  assert.equal(intl.store.one('SELECT update_id FROM i_tg_update WHERE update_id = ?', [801]).update_id, 801);
  assert.equal(intl.store.one(`SELECT action FROM i_audit WHERE action = 'connection_gone'`).action, 'connection_gone');
  intl.close();
});

test('a lead with no broker is hidden from the list', async () => {
  const { intl } = openIntl();
  const created = await intl.ingest({
    channel: 'wa_sim', sender_id: 'sim:none', sender_name: 'None', text: 'Hello',
    property_id: 'general', dedup_key: 'no-broker', fixture: true,
  });
  assert.equal(intl.lead(created.lead_id).broker_id, null);
  assert.equal(intl.leads({ broker_id: '42' }).some((row) => row.id === created.lead_id), false);
  intl.close();
});

test('JSON-LD and Open Graph after 100 KB still fill the card', () => {
  const pad = `<script>${'x'.repeat(150 * 1024)}</script>`;
  const html = `${pad}<meta property="og:title" content="After"><meta property="og:image" content="https://cdn.example.com/a.jpg"><script type="application/ld+json">{"@type":"Apartment","name":"Far","offers":{"price":"1000","priceCurrency":"USD"}}</script>`;
  const parsed = parseListingHtml(html, 'https://example.com/far');
  assert.equal(parsed.fields.title, 'Far');
  assert.equal(parsed.fields.price, 1000);
  assert.equal(parsed.fields.currency, 'USD');
  assert.equal(parsed.images[0], 'https://cdn.example.com/a.jpg');
});

test('Turkish I does not hide a later JSON-LD block', () => {
  const html = '<p>İstanbul İzmir</p><script type="application/ld+json">{"@type":"Apartment","name":"X","offers":{"price":"8500000","priceCurrency":"TRY"}}</script>';
  const parsed = parseListingHtml(html);
  assert.equal(parsed.fields.price, 8500000);
  assert.equal(parsed.fields.currency, 'TRY');
  assert.equal(parsed.fields.title, 'X');
});

test('a progressive JPEG with thousands of scans and a tiny huge SOF are skipped', async () => {
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc2;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(3992, 5);
  sof.writeUInt16BE(3992, 7);
  sof[9] = 3;
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  const parts = [Buffer.from([0xff, 0xd8]), sof];
  for (let n = 0; n < 20000; n += 1) parts.push(sos);
  parts.push(Buffer.from([0xff, 0xd9]));
  const bomb = Buffer.concat(parts);
  assert.ok(bomb.length < 800 * 1024);
  const huge = Buffer.alloc(40 * 1024);
  huge[0] = 0xff;
  huge[1] = 0xd8;
  huge[2] = 0xff;
  huge[3] = 0xc0;
  huge.writeUInt16BE(11, 4);
  huge[6] = 8;
  huge.writeUInt16BE(65535, 7);
  huge.writeUInt16BE(65535, 9);
  const html = '<html><head><title>Loft</title><meta property="og:image" content="https://cdn.example.com/scan.jpg"></head></html>';
  const fetchImpl = async (url) => {
    const body = String(url).includes('huge') ? huge : (String(url).includes('scan') ? bomb : Buffer.from(html));
    const type = String(url).includes('.jpg') ? 'image/jpeg' : 'text/html';
    return { ok: true, status: 200, headers: { get: () => type }, arrayBuffer: async () => body };
  };
  const start = Date.now();
  const scanned = await fetchListing('https://example.com/loft', {
    fetchImpl,
    lookup: async () => [{ address: '93.184.216.34' }],
  });
  assert.ok(Date.now() - start < 300, String(Date.now() - start));
  assert.equal(scanned.fields.photos, undefined);
  const wide = await fetchListing('https://example.com/other', {
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      headers: { get: () => (String(url).includes('wide') ? 'image/jpeg' : 'text/html') },
      arrayBuffer: async () => (String(url).includes('wide') ? huge : Buffer.from('<html><head><title>Loft</title><meta property="og:image" content="https://cdn.example.com/wide.jpg"></head></html>')),
    }),
    lookup: async () => [{ address: '93.184.216.34' }],
  });
  assert.equal(wide.fields.photos, undefined);
});

test('a body that times out is a blocked import, not a server error', async () => {
  const result = await fetchListing('https://example.com/drip', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html' },
      body: { getReader: () => ({ read: async () => { throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }); } }) },
    }),
    lookup: async () => [{ address: '93.184.216.34' }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 422);
  assert.equal(result.error_code, 'import_blocked');
});

test('Telegram 401 is surfaced instead of ignored', async () => {
  const errors = [];
  const original = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };
  try {
    const fetch = async () => ({ ok: false, status: 401, json: async () => ({ ok: false, description: 'Unauthorized' }) });
    const { intl } = openIntl({ CHANNEL_MODE: 'live' }, { fetch });
    const result = await intl.telegram(business('bc-auth', 4, 'Hello', 901));
    assert.equal(result.status, 500);
    assert.equal(result.error_code, 'telegram_auth_failed');
    assert.equal(intl.store.one('SELECT update_id FROM i_tg_update WHERE update_id = ?', [901]), null);
    assert.ok(errors.some((line) => line.includes('telegram_auth_failed')));
    intl.close();
  } finally {
    console.error = original;
  }
});

test('seeded leads belong to the broker and sim inbound does too', async () => {
  const { intl, config } = openIntl({ TELEGRAM_ALLOWED_USER_IDS: '42,99' });
  const pack = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'intl', 'testset.json'), 'utf8'));
  await intl.seed(pack, 'all');
  const server = buildIntlServer(config, intl);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const headersFor = (id) => ({
    Authorization: `tma ${signInitData({
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id }),
    }, config.TELEGRAM_BOT_TOKEN)}`,
    'Content-Type': 'application/json',
  });
  try {
    const listed = await fetch(`http://127.0.0.1:${port}/v1/intl/leads`, { headers: headersFor(42) });
    const body = await listed.json();
    assert.equal(listed.status, 200);
    assert.equal(body.leads.length, 25);
    const own = await fetch(`http://127.0.0.1:${port}/v1/intl/leads/T01`, { headers: headersFor(42) });
    assert.equal(own.status, 200);
    const hidden = await fetch(`http://127.0.0.1:${port}/v1/intl/leads/T01`, { headers: headersFor(99) });
    assert.equal(hidden.status, 404);
    const stray = await intl.ingest({
      channel: 'wa_sim', sender_id: 'sim:stray', sender_name: 'Stray', text: 'Hello',
      property_id: 'P1', dedup_key: 'stray-1', fixture: true,
    });
    const unseen = await fetch(`http://127.0.0.1:${port}/v1/intl/leads/${stray.lead_id}`, { headers: headersFor(42) });
    assert.equal(unseen.status, 404);
    const draft = await fetch(`http://127.0.0.1:${port}/v1/intl/leads/T01/draft`, {
      method: 'PUT',
      headers: headersFor(42),
      body: JSON.stringify({ text: 'Hello from the broker.', option_id: 'two' }),
    });
    const saved = await draft.json();
    assert.equal(draft.status, 200);
    assert.equal(saved.ok, true);
    const sent = await fetch(`http://127.0.0.1:${port}/v1/intl/leads/T01/send`, {
      method: 'POST',
      headers: { ...headersFor(42), 'Idempotency-Key': 'seed-send-1' },
      body: JSON.stringify({ draft_version: saved.version }),
    });
    const sentBody = await sent.json();
    assert.notEqual(sent.status, 404);
    assert.equal(sentBody.ok, true);
    const archived = await fetch(`http://127.0.0.1:${port}/v1/intl/leads/T02/archive`, {
      method: 'POST',
      headers: headersFor(42),
      body: '{}',
    });
    const archivedBody = await archived.json();
    assert.notEqual(archived.status, 404);
    assert.equal(archivedBody.ok, true);
    const inbound = await fetch(`http://127.0.0.1:${port}/v1/sim/wa/inbound`, {
      method: 'POST',
      headers: headersFor(42),
      body: JSON.stringify({ from_id: 'sim:new', name: 'Ada', text: 'Can I view it tomorrow?', property_id: 'P1', msg_id: 'm-new' }),
    });
    const inboundBody = await inbound.json();
    assert.equal(inbound.status, 200);
    assert.equal(intl.lead(inboundBody.lead_id).broker_id, '42');
    const again = await fetch(`http://127.0.0.1:${port}/v1/intl/leads`, { headers: headersFor(42) });
    const againBody = await again.json();
    assert.ok(againBody.leads.some((row) => row.id === inboundBody.lead_id));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    intl.close();
  }
});
