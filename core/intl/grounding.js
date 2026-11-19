'use strict';

// Grounding for AI reply options.
//
// Rule of the house: the model may only state facts that live on the property card. Two layers:
//   1. factsBlock()  — the prompt gets a compact, labelled list of real card fields (no guessing).
//   2. checkGroundedText() — after the model answers, every price / area / room count it wrote is
//      compared with the card; an option that contradicts the card is dropped instead of sent.
// This keeps the reply specific ("2+1, 110 м², 310 000 $") without letting it invent numbers.

const CURRENCY_PERIOD = {
  year: { ru: 'в год', en: 'per year' },
  month: { ru: 'в месяц', en: 'per month' },
  total: { ru: '', en: '' },
};

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseFacts(property) {
  const raw = property && property.facts;
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function priceText(property, lang) {
  const price = toNumber(property.price);
  if (price == null || price <= 0) return '';
  const currency = property.currency || '';
  const period = CURRENCY_PERIOD[property.price_period] || CURRENCY_PERIOD.total;
  return `${price} ${currency} ${(lang === 'en' ? period.en : period.ru)}`.replace(/\s+/g, ' ').trim();
}

function areaText(property) {
  const area = toNumber(property.area_value);
  if (area == null || area <= 0) return '';
  return `${area} ${property.area_unit || 'м²'}`.trim();
}

function photoCount(property) {
  const raw = property.photos;
  if (!raw) return 0;
  if (Array.isArray(raw)) return raw.length;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

// Labelled facts in the order a broker would say them. Empty fields are simply omitted, so the
// model never sees "not stated" rows it could fill with guesses.
function factsOf(property = {}) {
  const facts = parseFacts(property);
  const lang = property.__lang === 'en' ? 'en' : 'ru';
  const rows = [];
  const push = (label, value) => {
    if (value == null) return;
    const text = String(value).trim();
    if (!text) return;
    rows.push([label, text]);
  };

  push('Объект', property.title);
  push('Тип сделки', property.kind === 'rent' ? 'аренда' : property.kind === 'sale' ? 'продажа' : property.kind);
  push('Адрес', property.address || facts.address);
  push('Район', property.district || facts.district);
  push('Цена', priceText(property, lang));
  push('Площадь', areaText(property));
  const bedrooms = property.bedrooms != null ? property.bedrooms : facts.bedrooms;
  push('Спальни', bedrooms);
  push('Ссылка на объявление', property.listing_url || facts.listing_url);
  if (property.brochure_url) push('Брошюра', 'есть');
  if (property.plan_url) push('Планировка', 'есть');
  const photos = photoCount(property);
  if (photos > 0) push('Фото', `${photos} шт.`);

  for (const [key, value] of Object.entries(facts)) {
    if (['address', 'district', 'bedrooms', 'listing_url'].includes(key)) continue;
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    push(key, value);
  }
  return rows;
}

function factsBlock(property = {}) {
  const rows = factsOf(property);
  if (!rows.length) return '- (карточка объекта пуста: не называйте цену, площадь, этаж, удобства и наличие)';
  return rows.map(([label, value]) => `- ${label}: ${value}`).join('\n');
}

const GROUNDING_RULES = Object.freeze([
  'Используй ТОЛЬКО факты из блока «ДАННЫЕ ОБЪЕКТА». Ничего не выдумывай: цену, площадь, комнаты, этаж, вид, мебель, парковку, документы, наличие и сроки.',
  'Числа (цена, площадь, комнаты) копируй из карточки дословно, не округляй и не меняй валюту или период.',
  'Если клиент спрашивает то, чего в карточке нет — честно скажи, что уточнишь, и не подставляй цифру.',
  'Не пиши сухо и шаблонно: обращайся по имени, опирайся на конкретику карточки (район, планировка, площадь, цена), ответь на те вопросы, которые клиент реально задал.',
  'Три варианта должны отличаться углом, а не пересказывать друг друга: 1) ответ + приглашение на просмотр со слотами, 2) подробный ответ по фактам карточки, 3) ответ + уточняющий вопрос по сделке.',
].join('\n'));

const GROUNDING_RULES_EN = Object.freeze([
  'Use ONLY the facts in the PROPERTY block. Never invent price, area, rooms, floor, view, furniture, parking, documents, availability or timing.',
  'Copy numbers (price, area, rooms) exactly from the card: do not round, do not change currency or period.',
  'If the client asks for something the card does not state, say you will confirm it, and do not fill in a number.',
  'Do not sound dry or templated: address the client by name, use the card specifics (district, layout, area, price), answer the questions the client actually asked.',
  'The three options must differ in angle: 1) answer + invitation to view with slots, 2) detailed answer grounded in card facts, 3) answer + one qualifying question about the deal.',
].join('\n'));

// --- validation -------------------------------------------------------------------------------

// Thousands separators are either groups of three digits after a space ("310 000") or after a
// punctuation mark ("310,000"). A comma followed by a space is NOT a separator, so "2+1, 110 м²"
// is read as two numbers (1 and 110), not as 1110.
const NUMBER_CORE = '\\d{1,3}(?:[ \\u00a0]\\d{3}|[,.\'’]\\d{3})*|\\d+';
const MONEY_AFTER_NUMBER = new RegExp(
  `(${NUMBER_CORE})\\s*(?:\\$|€|₽|£|usd|aed|eur|rub|try|gbp|доллар\\w*|дирхам\\w*)`,
  'gi',
);
const MONEY_BEFORE_NUMBER = new RegExp(`(?:\\$|€|₽|£)\\s*(${NUMBER_CORE})`, 'g');
const AREA_WITH_UNIT = new RegExp(
  `(${NUMBER_CORE})\\s*(?:м²|м2|кв\\.?\\s?м|sqm|sq\\.?\\s?m|sqft|фут\\w*)`,
  'gi',
);
const ROOMS_PATTERN = /\b(\d{1,2})\s*\+\s*(\d{1,2})\b/g;

function toAmount(raw) {
  return toNumber(String(raw).replace(/[\s\u00a0.,'’]/g, ''));
}

function moneyAmounts(text) {
  const source = String(text || '');
  const found = [];
  let match;
  while ((match = MONEY_AFTER_NUMBER.exec(source)) !== null) {
    const amount = toAmount(match[1]);
    if (amount != null) found.push(amount);
  }
  while ((match = MONEY_BEFORE_NUMBER.exec(source)) !== null) {
    const amount = toAmount(match[1]);
    if (amount != null) found.push(amount);
  }
  return found;
}

function areaAmounts(text) {
  const source = String(text || '');
  const found = [];
  let match;
  while ((match = AREA_WITH_UNIT.exec(source)) !== null) {
    const amount = toAmount(match[1]);
    if (amount != null) found.push(amount);
  }
  return found;
}

function roomPatterns(text) {
  const found = [];
  let match;
  while ((match = ROOMS_PATTERN.exec(String(text || ''))) !== null) {
    found.push(`${Number(match[1])}+${Number(match[2])}`);
  }
  return found;
}

function expectedPrice(property) {
  const price = toNumber(property.price);
  return price != null && price > 0 ? price : null;
}

function expectedArea(property) {
  const area = toNumber(property.area_value);
  return area != null && area > 0 ? area : null;
}

function expectedRooms(property) {
  const title = String(property.title || '');
  const fromTitle = title.match(/\b(\d{1,2})\s*\+\s*(\d{1,2})\b/);
  if (fromTitle) return `${Number(fromTitle[1])}+${Number(fromTitle[2])}`;
  const bedrooms = toNumber(property.bedrooms);
  if (bedrooms != null && bedrooms > 0) return `${bedrooms}+1`;
  return null;
}

function isGeneral(property) {
  return !property || property.id === 'general';
}

// Returns { ok, violations }. A text with no numbers at all is allowed (it makes no false claims).
function checkGroundedText(text, property = {}) {
  const violations = [];
  if (isGeneral(property)) return { ok: true, violations };

  const price = expectedPrice(property);
  if (price != null) {
    for (const amount of moneyAmounts(text)) {
      if (Math.abs(amount - price) > 0.5) violations.push(`price_${amount}_expected_${price}`);
    }
  }
  const area = expectedArea(property);
  if (area != null) {
    for (const amount of areaAmounts(text)) {
      if (Math.abs(amount - area) > 0.5) violations.push(`area_${amount}_expected_${area}`);
    }
  }
  const rooms = expectedRooms(property);
  if (rooms) {
    for (const pattern of roomPatterns(text)) {
      if (pattern !== rooms) violations.push(`rooms_${pattern}_expected_${rooms}`);
    }
  }
  return { ok: violations.length === 0, violations };
}

function filterGrounded(options, property = {}) {
  const kept = [];
  const rejected = [];
  for (const option of options || []) {
    if (!option || !option.text) continue;
    const check = checkGroundedText(option.text, property);
    if (check.ok) kept.push(option);
    else rejected.push({ id: option.id, violations: check.violations });
  }
  return { kept, rejected };
}

module.exports = {
  factsOf,
  factsBlock,
  checkGroundedText,
  filterGrounded,
  GROUNDING_RULES,
  GROUNDING_RULES_EN,
  moneyAmounts,
  areaAmounts,
  roomPatterns,
};
