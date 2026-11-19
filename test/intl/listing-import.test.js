'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseListingHtml, assertPublicUrl, fetchListing, mergeListingFields } = require('../../core/intl/listingImport');

const root = path.join(__dirname, '..', '..', 'fixtures', 'intl', 'listings');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function page(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

test('JSON-LD fills the card before the page title', () => {
  const parsed = parseListingHtml(page('jsonld.html'), 'https://example.test/marina');
  assert.equal(parsed.fields.title, '2BR Marina Gate');
  assert.equal(parsed.fields.price, 185000);
  assert.equal(parsed.fields.currency, 'AED');
  assert.equal(parsed.fields.rooms, 2);
  assert.equal(parsed.fields.address, 'Marina Gate, Al Sufouh');
  assert.equal(parsed.fields.district, 'Dubai Marina');
  assert.equal(parsed.fields.unit, 'sqm');
  assert.ok(parsed.fields.area > 0 && parsed.fields.area < 200);
  assert.match(parsed.fields.description, /Sea view/);
  assert.deepEqual(parsed.images, ['https://cdn.example.test/marina.jpg']);
});

test('Open Graph fills a page that has no JSON-LD', () => {
  const parsed = parseListingHtml(page('opengraph.html'), 'https://example.test/jbr');
  assert.equal(parsed.fields.title, 'Studio, JBR');
  assert.equal(parsed.fields.price, 90000);
  assert.equal(parsed.fields.currency, 'AED');
  assert.match(parsed.fields.description, /Bright studio/);
});

test('plain text still finds a Turkish price, rooms and size', () => {
  const parsed = parseListingHtml(page('heuristic.html'), 'https://example.test/tr');
  assert.equal(parsed.fields.title, 'Kadıköy daire');
  assert.equal(parsed.fields.price, 2450000);
  assert.equal(parsed.fields.currency, 'TRY');
  assert.equal(parsed.fields.rooms, 3);
  assert.equal(parsed.fields.area, 145);
  assert.equal(parsed.fields.unit, 'sqm');
  assert.equal(parsed.fields.kind, 'sale');
});

test('typed fields stay put until the broker confirms a replacement', () => {
  const found = { title: 'Imported', price: 10, currency: 'AED', photos: [{ dataUrl: 'data:image/png;base64,aa' }] };
  const draft = { title: 'Mine', price: '', currency: 'USD', photos: [] };
  const merged = mergeListingFields(found, draft, { currency: 'USD' });
  assert.equal(merged.next.title, 'Mine');
  assert.equal(merged.next.price, '10');
  assert.equal(merged.next.currency, 'AED');
  assert.deepEqual(merged.conflicts, ['title']);
  assert.ok(merged.filled.includes('price'));
  assert.ok(merged.filled.includes('photos'));
});

test('private and non-http links are refused before any fetch', async () => {
  const lookup = async () => [{ address: '93.184.216.34' }];
  for (const url of [
    'file:///etc/passwd',
    'http://127.0.0.1/latest',
    'http://10.1.2.3/admin',
    'http://192.168.1.5/',
    'http://169.254.169.254/latest/meta-data',
    'http://localhost/secret',
    'http://user:pass@example.com/',
    'ftp://example.com/file',
  ]) {
    const result = await assertPublicUrl(url, lookup);
    assert.equal(result.ok, false, url);
  }
  const rebind = await assertPublicUrl('http://example.com/listing', async () => [{ address: '10.0.0.5' }]);
  assert.equal(rebind.ok, false);
  const open = await assertPublicUrl('https://example.com/listing', lookup);
  assert.equal(open.ok, true);
});

test('a blocked host never downloads a page and a public page can attach a photo', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (String(url).endsWith('.jpg')) {
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name === 'content-type' ? 'image/jpeg' : '') },
        arrayBuffer: async () => PNG,
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'text/html' },
      arrayBuffer: async () => Buffer.from(page('jsonld.html')),
    };
  };
  const blocked = await fetchListing('http://127.0.0.1/listing', { fetchImpl });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error_code, 'import_blocked');
  assert.equal(calls, 0);
  const loaded = await fetchListing('https://example.com/marina', {
    fetchImpl,
    lookup: async () => [{ address: '93.184.216.34' }],
  });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.fields.title, '2BR Marina Gate');
  assert.equal(loaded.fields.photos.length, 1);
  assert.match(loaded.fields.photos[0].dataUrl, /^data:image\/png;base64,/);
  assert.ok(calls >= 2);
});
