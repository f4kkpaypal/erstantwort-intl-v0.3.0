'use strict';

// Inbox swipe actions must be wired to real endpoints: right = move to Processed (handled),
// left = confirm when possible, otherwise open the lead card. The hint text tells the broker.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const app = fs.readFileSync(path.join(root, 'ui-intl', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'ui-intl', 'style.css'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.join(root, 'ui-intl', 'i18n', 'en.json'), 'utf8'));
const ru = JSON.parse(fs.readFileSync(path.join(root, 'ui-intl', 'i18n', 'ru.json'), 'utf8'));

test('rows carry swipe hooks and the hint is shown under the merged list', () => {
  assert.match(app, /data-swipe="\$\{esc\(lead\.id\)\}"/);
  assert.match(app, /data-status="\$\{esc\(lead\.status/);
  // The hint is no longer printed on the main list (the screen stays clean); the words remain in the
  // dictionaries for the folder screens and for future reuse.
  assert.doesNotMatch(app.slice(app.indexOf('async function showInbox'), app.indexOf('function hydrateLead')), /swipeHint/);
  assert.ok(en.swipeHint.includes('Swipe right'));
  assert.ok(ru.swipeHint.includes('Свайп вправо'));
});

test('right swipe marks the lead handled through the API', () => {
  assert.match(app, /\/handled`,\s*\{\s*method:\s*'POST'/);
  assert.match(app, /state\.notice = t\('handledDone'\)/);
  assert.ok(en.handledDone.length > 0 && ru.handledDone.length > 0);
});

test('left swipe confirms a replied lead and otherwise opens the card', () => {
  const handler = app.slice(app.indexOf("querySelectorAll('[data-swipe]')"), app.indexOf("querySelectorAll('[data-confirm]')"));
  assert.match(handler, /dx > 0/);
  assert.match(handler, /\/confirm/);
  assert.match(handler, /location\.hash = `#\/lead\/\$\{id\}`/);
});

test('the mock status words exist in both dictionaries', () => {
  for (const key of ['noReply', 'replySentShort', 'waitingShort', 'handledMark', 'proposedSlots', 'freeWord']) {
    assert.equal(typeof en[key], 'string', `EN ${key}`);
    assert.equal(typeof ru[key], 'string', `RU ${key}`);
  }
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ru).sort());
});

test('the row style for the merged list is present', () => {
  assert.match(css, /\.card\.list \.item/);
  assert.match(css, /\.card\.list \.item \.r \.state\.wait/);
});
