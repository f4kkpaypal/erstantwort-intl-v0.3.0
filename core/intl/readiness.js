'use strict';

// Keyword readiness for the inbox. Independent of the published numeric grade
// (fixtures/intl/testset.json): that score stays the digest contract.
// HOT wins over WARM. A message with no concrete ask is COLD.

const READY_RANK = { HOT: 0, WARM: 1, COLD: 2 };

// A viewing is the strongest broker signal: the person wants to be in the unit.
// Bare "view" is a verb here. "sea view" and "virtual tour" are not a request.
const HOT_VIEW = /(?<![\p{L}\p{N}])(view(?:ing)?s?|visit(?:ing)?|appointment|open house|come (?:by|over)|see (?:it|the (?:apartment|flat|place|property|unit)))(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(посмотреть|просмотр|осмотр|записаться|приехать|приеду)(?![\p{L}\p{N}])/iu;
const VIEW_NOUN = /(?:sea|city|pool|garden|street|lake|ocean|marina|mountain|night|side|front|rear|virtual|panoramic)\s+$/iu;

// Today / tomorrow / asap means they are scheduling, not browsing.
const HOT_URGENT = /(?<![\p{L}\p{N}])(today|tomorrow|tonight|asap|as soon as possible|right away|urgent(?:ly)?|this weekend)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(сегодня|завтра|срочно|как можно скорее|на выходных)(?![\p{L}\p{N}])/iu;

// Naming cash or a decision to buy/sign is commitment, not a price question.
const HOT_PAY = /(?<![\p{L}\p{N}])(cash|ready to buy|ready to sign|ready to pay|want to buy|i(?:'|’)ll take it|i will take it)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(наличн\p{L}*|хочу купить|готов(?:а|ы)? купить|готов(?:а|ы)? подписать|готов(?:а|ы)? оплатить)(?![\p{L}\p{N}])/iu;

// "What is the deposit?" stays a question. Paying or putting a deposit does not.
const HOT_DEPOSIT = /(?<![\p{L}\p{N}])(?:pay(?:ing)?|put(?:ting)?|transfer(?:ring)?)(?:\s+\p{L}+){0,3}\s+deposit(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])deposit\s+(?:ready|today|tomorrow)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(внес(?:у|ти|ём)|задаток)(?![\p{L}\p{N}])/iu;

// A clock or a named day is a concrete slot, not small talk.
const HOT_CLOCK = /(?<![\p{L}\p{N}])\d{1,2}[:.]\d{2}\s*(?:am|pm)?(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])\d{1,2}\s*(?:am|pm)(?![\p{L}\p{N}])/iu;
const HOT_DAY = /(?<![\p{L}\p{N}])(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(понедельник|вторник|сред[ауы]|четверг|пятниц[ауи]|суббот[ауи]|воскресень\p{L}*)(?![\p{L}\p{N}])/iu;
const HOT_DATE = /(?<![\p{L}\p{N}])\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(?:январ\p{L}*|феврал\p{L}*|марта|апрел\p{L}*|мая|июн\p{L}*|июл\p{L}*|август\p{L}*|сентябр\p{L}*|октябр\p{L}*|ноябр\p{L}*|декабр\p{L}*)\s+\d{1,2}(?![\d])/iu;

// Clarifying questions: interest without a decision.
const WARM_EN = /(?<![\p{L}\p{N}])(price|prices|cost|how much|how many|bedrooms?|rooms?|where|location|neighbourhood|neighborhood|area|district|available|mortgage|installments?|instalments?|documents?|deposit|size|sqft|sqm|floor|balcony)(?![\p{L}\p{N}])/iu;
const WARM_RU = /(какая цен|сколько стоит|сколько комнат|сколько спал|где(?:\s+это|\s+находится|\s+район)?|район|локац|наличи|ипотек|документ|депозит|площад|этаж|балкон)/iu;
const PROPERTY_NOUN = /(?<![\p{L}\p{N}])(apartment|flat|villa|property|unit|house|studio)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(квартир\p{L}*|апартамент\p{L}*|вилл\p{L}*|объект\p{L}*|студи\p{L}*)(?![\p{L}\p{N}])/iu;

const AR_VIEW = /معاينة|مشاهدة|زيارة/;
const AR_WHEN = /غداً|غدًا|غدا|اليوم|بكرة/;
const TR_VIEW = /görmek|göreyim|randevu/;
const TR_WHEN = /yarın|bugün/;
const NEGATION = /(?:^|[^\p{L}\p{N}])(not|no|never|n't|не|нет)(?:\s+\p{L}+){0,2}\s*$/iu;
const TODAY_ACTION = /view|visit|call|come|посмотр|приед|позвон|запис|осмотр|приехать/iu;

function negatedBefore(clean, index) {
  return NEGATION.test(clean.slice(Math.max(0, index - 32), index));
}

function eachMatch(re, clean, accept) {
  const copy = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let match;
  while ((match = copy.exec(clean))) {
    if (accept(match)) return true;
    if (match.index === copy.lastIndex) copy.lastIndex += 1;
  }
  return false;
}

function positiveView(clean) {
  return eachMatch(HOT_VIEW, clean, (match) => {
    if (negatedBefore(clean, match.index)) return false;
    const word = String(match[1] || match[2] || match[0]);
    if (/^views?$/iu.test(word)) {
      const before = clean.slice(Math.max(0, match.index - 24), match.index);
      if (VIEW_NOUN.test(before)) return false;
    }
    return true;
  });
}

function positiveUrgent(clean) {
  return eachMatch(HOT_URGENT, clean, (match) => {
    if (negatedBefore(clean, match.index)) return false;
    const word = String(match[0]);
    if (/today|сегодня/iu.test(word) && !TODAY_ACTION.test(clean)) return false;
    return true;
  });
}

function positive(re, clean) {
  return eachMatch(re, clean, (match) => !negatedBefore(clean, match.index));
}

function stripMoney(clean) {
  return clean
    .replace(/(?:aed|usd|\$|€|£|дирхам\p{L}*|доллар\p{L}*|бюджет|budget)\s*\d+(?:[.,]\d+)?(?:\s*(?:million|millions|mln|млн|k|тыс\p{L}*))?/giu, ' ')
    .replace(/\d+(?:[.,]\d+)?\s*(?:million|millions|mln|млн|тысяч\p{L}*|тыс\p{L}*|k|aed|usd|sqm|sqft|м2)/giu, ' ');
}

function arTrReadiness(clean) {
  const view = AR_VIEW.test(clean) || TR_VIEW.test(clean);
  const when = AR_WHEN.test(clean) || TR_WHEN.test(clean);
  if (view && when) return { label: 'HOT', hits: ['viewing', 'urgent', 'ar_tr'] };
  if (view) return { label: 'WARM', hits: ['viewing', 'ar_tr'] };
  if (when) return { label: 'WARM', hits: ['urgent', 'ar_tr'] };
  return null;
}

function classifyReadiness(text, analysis) {
  if (analysis && analysis.intent === 'stop') return { label: 'COLD', hits: ['optout'] };
  const clean = String(text || '').toLowerCase().trim();
  if (!clean) return { label: 'COLD', hits: ['empty'] };
  const arTr = arTrReadiness(clean);
  if (arTr) return arTr;
  const hits = [];
  const timed = stripMoney(clean);
  if (positiveView(clean)) hits.push('viewing');
  if (positiveUrgent(clean)) hits.push('urgent');
  if (positive(HOT_PAY, clean)) hits.push('payment');
  if (positive(HOT_DEPOSIT, clean)) hits.push('deposit');
  if (positive(HOT_CLOCK, timed)) hits.push('clock');
  if (positive(HOT_DAY, clean)) hits.push('day');
  if (positive(HOT_DATE, timed)) hits.push('date');
  if (hits.length) return { label: 'HOT', hits };
  const warm = [];
  if (WARM_EN.test(clean)) warm.push('question');
  if (WARM_RU.test(clean)) warm.push('question_ru');
  if (clean.includes('?') && PROPERTY_NOUN.test(clean)) warm.push('property_question');
  if (warm.length) return { label: 'WARM', hits: warm };
  return { label: 'COLD', hits: ['no_signal'] };
}

function readinessRank(lead) {
  return READY_RANK[lead && lead.readiness] ?? READY_RANK[lead && lead.grade] ?? 9;
}

module.exports = {
  classifyReadiness,
  readinessRank,
  READY_RANK,
  HOT_VIEW,
  HOT_URGENT,
  HOT_PAY,
  HOT_DEPOSIT,
  HOT_CLOCK,
  HOT_DAY,
  HOT_DATE,
  WARM_EN,
  WARM_RU,
};
