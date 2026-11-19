'use strict';

// The AI options must sound smart, but "smart" here means "specific to the property card", not
// "free to invent". These tests pin both halves: the prompt receives real card facts, and any
// option that contradicts the card (price / area / rooms) is dropped before a broker can send it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { factsBlock, factsOf, checkGroundedText, filterGrounded, GROUNDING_RULES } = require('../../core/intl/grounding');

const CARD = {
  id: 'P1',
  title: '2+1, Beşiktaş',
  kind: 'sale',
  price: 310000,
  currency: 'USD',
  price_period: 'total',
  area_value: 110,
  area_unit: 'м²',
  address: 'Sinanpaşa, Beşiktaş',
  district: 'Beşiktaş',
  bedrooms: 2,
  listing_url: 'https://example.invalid/listing/42',
  brochure_url: '/v1/intl/properties/P1/brochure.pdf',
  plan_url: 'https://example.invalid/plan.pdf',
  photos: JSON.stringify(['a.jpg', 'b.jpg', 'c.jpg']),
  facts: { floor: 4, view: 'город' },
};

test('factsBlock gives the model the real card fields and skips empty ones', () => {
  const block = factsBlock(CARD);
  assert.match(block, /Объект: 2\+1, Beşiktaş/);
  assert.match(block, /Цена: 310000 USD/);
  assert.match(block, /Площадь: 110 м²/);
  assert.match(block, /Адрес: Sinanpaşa, Beşiktaş/);
  assert.match(block, /Район: Beşiktaş/);
  assert.match(block, /Спальни: 2/);
  assert.match(block, /Ссылка на объявление: https:\/\/example\.invalid\/listing\/42/);
  assert.match(block, /Брошюра: есть/);
  assert.match(block, /Планировка: есть/);
  assert.match(block, /Фото: 3 шт\./);
  assert.match(block, /floor: 4/);
  assert.doesNotMatch(block, /undefined|null/);

  const minimal = factsBlock({ id: 'P2', title: 'Студия' });
  assert.match(minimal, /Объект: Студия/);
  assert.doesNotMatch(minimal, /Цена/);
});

test('an empty card tells the model that there are no facts to quote', () => {
  assert.match(factsBlock({ id: 'general' }), /не называйте цену/);
  assert.equal(factsOf({ id: 'general' }).length, 0);
});

test('a reply that matches the card passes', () => {
  const text = 'Игорь, объект «2+1, Beşiktaş» — 110 м², 310 000 $, 4 этаж, вид на город. Покажу в понедельник 16 ноября: 09:00 или 10:00?';
  const result = checkGroundedText(text, CARD);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

test('a wrong price is rejected', () => {
  const result = checkGroundedText('Цена — 350 000 $, торг возможен, покажу завтра.', CARD);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.startsWith('price_350000')));
});

test('a wrong area is rejected', () => {
  const result = checkGroundedText('Квартира 95 м², 2+1, цена 310 000 $.', CARD);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.startsWith('area_95')));
});

test('a wrong room count is rejected', () => {
  const result = checkGroundedText('Есть отличный вариант 3+1 за 310 000 $.', CARD);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.startsWith('rooms_3+1')));
});

test('a reply without numbers makes no false claims and passes', () => {
  const result = checkGroundedText('Игорь, добрый день! Да, объект в Бешикташе подходит под ваш запрос — расскажу детали и подберу время.', CARD);
  assert.equal(result.ok, true);
});

test('a general lead has no card, so number checks do not run', () => {
  const result = checkGroundedText('Цена 350 000 $, площадь 95 м².', { id: 'general' });
  assert.equal(result.ok, true);
});

test('filterGrounded keeps grounded options and reports the rest', () => {
  const options = [
    { id: 'good', text: 'Объект 2+1, 110 м², 310 000 $. Покажу в понедельник в 09:00 или 10:00.' },
    { id: 'bad_price', text: 'Объект 2+1, 110 м², всего 299 000 $.' },
    { id: 'bad_area', text: 'Объект 2+1, 125 м², 310 000 $.' },
  ];
  const result = filterGrounded(options, CARD);
  assert.deepEqual(result.kept.map((row) => row.id), ['good']);
  assert.deepEqual(result.rejected.map((row) => row.id).sort(), ['bad_area', 'bad_price']);
  assert.ok(result.rejected.find((row) => row.id === 'bad_price').violations.length > 0);
});

test('the grounding rules demand exact numbers and a non-dry tone', () => {
  assert.match(GROUNDING_RULES, /ТОЛЬКО факты/);
  assert.match(GROUNDING_RULES, /копируй/i);
  assert.match(GROUNDING_RULES, /Не пиши сухо/);
  assert.match(GROUNDING_RULES, /три варианта/i);
});

test('both AI prompts feed the model the grounded facts block, not loose rows', () => {
  const root = path.join(__dirname, '..', '..');
  const deepseek = fs.readFileSync(path.join(root, 'core', 'intl', 'deepseek.js'), 'utf8');
  const gemini = fs.readFileSync(path.join(root, 'core', 'intl', 'gemini.js'), 'utf8');
  assert.match(deepseek, /factsBlock\(\{ \.\.\.property/);
  assert.match(deepseek, /GROUNDING_RULES/);
  assert.match(gemini, /factsBlock\(\{ \.\.\.property/);
  assert.match(gemini, /GROUNDING_RULES_EN/);
  const intlServer = fs.readFileSync(path.join(root, 'engine', 'intlServer.js'), 'utf8');
  assert.match(intlServer, /filterGrounded\(/);
});

test('the Postgres migration adds the property profile columns the card needs', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'migrations', '006_intl_property_profile.sql'), 'utf8');
  for (const column of ['address', 'district', 'bedrooms', 'listing_url', 'brochure_url', 'plan_url', 'photos']) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column} `), column);
  }
});
