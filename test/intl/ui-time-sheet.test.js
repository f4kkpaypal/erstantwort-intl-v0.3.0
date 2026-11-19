'use strict';

// Lead card layout: proposed times sit under the reply, reply variants sit below them, and tapping
// a proposed time opens the "suggest a time" sheet (three variants + the full free-time list).
// These are source-level checks: the Mini App is a single HTML/JS file without a bundler, so the
// markup order and the wired handlers are exactly what ships to the broker.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const app = fs.readFileSync(path.join(root, 'ui-intl', 'app.js'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.join(root, 'ui-intl', 'i18n', 'en.json'), 'utf8'));
const ru = JSON.parse(fs.readFileSync(path.join(root, 'ui-intl', 'i18n', 'ru.json'), 'utf8'));

test('times come under the reply and reply variants come under the times', () => {
  const slotsAt = app.indexOf('const slotsUnderReply');
  const variantsAt = app.indexOf('const variantsHtml');
  assert.ok(slotsAt > 0, 'slotsUnderReply is built');
  assert.ok(variantsAt > slotsAt, 'variants are declared after the proposed times');

  // hydrateLead is declared before showLead, so slice to the end of the file instead.
  const leadMarkup = app.slice(app.indexOf('async function showLead'));
  // The slots live inside the answer card, the variants come right after it.
  const slotsMarkupAt = leadMarkup.indexOf('${slotsUnderReply}');
  const variantsMarkupAt = leadMarkup.indexOf('${variantsHtml}');
  assert.ok(slotsMarkupAt > 0 && variantsMarkupAt > slotsMarkupAt, 'rendered in this order');
  // The old bottom-of-page copies are gone: one owner per block, no duplicate ids.
  assert.equal((leadMarkup.match(/id="openPicker"/g) || []).length, 1);
  assert.equal((leadMarkup.match(/id="timeSheet"/g) || []).length, 1);
});

test('tapping a proposed time opens the suggest-a-time sheet, it does not dump text into the draft', () => {
  const handler = app.slice(app.indexOf("querySelectorAll('[data-insert]')"), app.indexOf("querySelectorAll('[data-time-opt]')"));
  assert.match(handler, /state\.pendingSlot = button\.dataset\.insert/);
  assert.match(handler, /state\.timeSheet = true/);
  assert.doesNotMatch(handler, /insertProposal\(/, 'the time is applied after picking a variant, not before');
});

test('the time sheet shows three variants and a fourth row with all free times', () => {
  const sheet = app.slice(app.indexOf('const timeSheetHtml'), app.indexOf("const sheet = state.sheet"));
  assert.match(sheet, /options\.slice\(0, 3\)/);
  assert.match(sheet, /data-time-opt/);
  assert.match(sheet, /id="allTimes"/);
  assert.match(sheet, /allFreeTimes/);
  assert.match(sheet, /id="timeSheetClose"/);

  const pick = app.slice(app.indexOf("querySelectorAll('[data-time-opt]')"), app.indexOf("const allTimes"));
  assert.match(pick, /state\.draftText = option\.text/);
  assert.match(pick, /insertProposal\(lead, replyLang, state\.pendingSlot\)/);
  assert.match(pick, /state\.timeSheet = false/);

  const all = app.slice(app.indexOf("const allTimes"), app.indexOf("const timeSheetClose"));
  assert.match(all, /state\.picker = true/);
});

test('the sheet keeps working with the existing picker and apply-slot flow', () => {
  const files = ['ui-intl/app.js', 'ui-intl/style.css'];
  const appJs = fs.readFileSync(path.join(root, files[0]), 'utf8');
  const css = fs.readFileSync(path.join(root, files[1]), 'utf8');
  assert.match(appJs, /id="timePicker"/);
  assert.match(appJs, /\/apply-slot/);
  assert.match(appJs, /function chooseSlot/);
  assert.match(css, /\.sheet\.timesheet\s*\.opts/);
});

test('the new strings exist in both dictionaries and the parity holds', () => {
  for (const key of ['timeSheetTitle', 'timeSheetSub', 'allFreeTimes']) {
    assert.equal(typeof en[key], 'string', `EN ${key}`);
    assert.equal(typeof ru[key], 'string', `RU ${key}`);
    assert.ok(en[key].trim().length > 0, `EN ${key} is not empty`);
    assert.ok(ru[key].trim().length > 0, `RU ${key} is not empty`);
  }
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ru).sort());
});

test('the language switch still exists on every screen and persists the choice', () => {
  const bar = app.slice(app.indexOf('function bar()'), app.indexOf('function isDemoSurface'));
  assert.match(bar, /data-lang="en"/);
  assert.match(bar, /data-lang="ru"/);
  assert.match(bar, /state\.lang === 'en'/);
  assert.match(bar, /state\.lang === 'ru'/);
  const shell = app.slice(app.indexOf('function shell'));
  assert.match(shell, /localStorage\.setItem\('intl-lang'/);
  assert.match(app, /document\.documentElement\.lang = state\.lang/);
});
