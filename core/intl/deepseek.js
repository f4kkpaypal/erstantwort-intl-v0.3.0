'use strict';

const { request } = require('undici');
const { factsBlock, GROUNDING_RULES } = require('./grounding');

const DEEPSEEK_API_BASE = 'https://api.deepseek.com/v1';

/**
 * Clean and parse JSON from LLM response
 */
function parseJsonSafe(text) {
  if (!text || typeof text !== 'string') return null;
  const cleaned = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/i, '$1').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {}
    }
    return null;
  }
}

/**
 * Call DeepSeek (deepseek-chat) via OpenAI-compatible endpoint
 */
async function callDeepSeek(apiKey, messages, options = {}) {
  const model = options.model || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  const url = `${DEEPSEEK_API_BASE}/chat/completions`;

  const payload = {
    model,
    messages,
    temperature: options.temperature ?? 0.3,
    max_tokens: options.max_tokens || 1000,
  };

  if (options.json) {
    payload.response_format = { type: 'json_object' };
  }

  const response = await request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey.trim()}`,
    },
    body: JSON.stringify(payload),
    headersTimeout: 15000,
    bodyTimeout: 30000,
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const errorText = await response.body.text();
    throw new Error(`DeepSeek API error [${response.statusCode}]: ${errorText.slice(0, 300)}`);
  }

  const data = /** @type {any} */ (await response.body.json());
  const choice = data.choices?.[0];
  return choice?.message?.content?.trim() || '';
}

/**
 * Generate 3 tailored broker reply options deeply analyzing the client's specific questions
 */
async function generateRepliesWithDeepSeek(apiKey, leadData, context = {}) {
  const property = context.property || {};
  const slots = context.slots || [];
  const lang = leadData.language === 'ru' ? 'ru' : 'en';

  const slotsText = slots.length > 0
    ? slots.slice(0, 3).map((s, i) => `${i + 1}. ${s.label || s.start_utc || s} (id: ${s.id || ''})`).join('\n')
    : 'Свободных слотов в базе нет. Предложите клиенту назвать удобный ему день и время.';

  const slotIds = slots.slice(0, 2).map(s => s.id).filter(Boolean);

  const system = `Ты — топовый лицензированный риелтор (маклер) с 10-летним стажем.
Твоя задача — внимательно проанализировать входящее сообщение потенциального клиента, ПОЛНОСТЬЮ понять, КАКИЕ ИМЕННО вопросы и сомнения озвучивает клиент (цена, торг, этаж, документы, вид, рассрочка, мебель, парковка, просмотр, условия сделки), и составить 3 профессиональных, живых варианта ответа от первого лица.

Язык ответа: ${lang === 'ru' ? 'РУССКИЙ' : 'ENGLISH'}.
Тон: уверенный, вежливый, заботливый, экспертный. Без канцелярщины и без роботизированных шаблонных фраз.
Стиль диалога: ${({ business: 'Деловой эксперт: фокус на бюджете и записи на просмотр.', short: 'Кратко: 2-3 предложения без воды.', warm: 'Дружелюбно и тепло, но без панибратства.' }[context.style] || 'Деловой эксперт: фокус на бюджете и записи на просмотр.')}

ПРАВИЛА ФАКТОВ:


ВАЖНО:
1. Внимательно ответь на ВСЕ прямые и косвенные вопросы клиента.
2. Если клиент спрашивает цену, скидку, условия — дай точный ответ, отталкиваясь от данных объекта.
3. Вариант 1 (Запись на просмотр): Отвечает на вопросы и сразу мягко приглашает на просмотр со слотами времени.
4. Вариант 2 (Подробный экспертный ответ): Максимально развернуто отвечает на все вопросы, рассказывает об объекте и предлагает прислать брошюру/документы.
5. Вариант 3 (Ответ и уточнение): Отвечает на главный вопрос и задает встречный вежливый вопрос для квалификации (срок выхода на сделку, форма оплаты, для себя или инвестиция).

Верни СТРОГО JSON-объект следующего формата:
{
  "client_questions": ["список обнаруженных вопросов клиента"],
  "options": [
    {
      "id": "ds_viewing",
      "label_ru": "Ответ и просмотр",
      "label_en": "Answer & Viewing",
      "text": "Текст сообщения 1"
    },
    {
      "id": "ds_answer",
      "label_ru": "Подробный ответ",
      "label_en": "Detailed Answer",
      "text": "Текст сообщения 2"
    },
    {
      "id": "ds_qualify",
      "label_ru": "Ответ и уточнение",
      "label_en": "Answer & Qualify",
      "text": "Текст сообщения 3"
    }
  ]
}`;

  const userMsg = `ДАННЫЕ КЛИЕНТА:
Имя: ${leadData.clean_name || leadData.sender_name || 'Клиент'}
Входящее сообщение: "${leadData.text || ''}"
Интент: ${leadData.intent || 'general'}
Температура лида: ${leadData.score || 'WARM'}

ДАННЫЕ ОБЪЕКТА (единственный источник фактов; других цифр не называй):
${factsBlock({ ...property, __lang: lang })}

СВОБОДНЫЕ СЛОТЫ ДЛЯ ПОКАЗА:
${slotsText}`;

  try {
    const raw = await callDeepSeek(apiKey, [
      { role: 'system', content: system },
      { role: 'user', content: userMsg },
    ], { json: true, temperature: 0.3 });
    const result = parseJsonSafe(raw);
    if (!result || !Array.isArray(result.options)) throw new Error('invalid_deepseek_options');
    
    // Attach slots to options
    const enriched = result.options.map(opt => ({
      ...opt,
      slot_ids: slotIds,
    }));
    return { ok: true, questions: result.client_questions, options: enriched };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  callDeepSeek,
  generateRepliesWithDeepSeek,
};
