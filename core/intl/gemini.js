'use strict';

const { request } = require('undici');
const { factsBlock, GROUNDING_RULES_EN } = require('./grounding');

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Clean and parse JSON from LLM response (handling markdown fences if any)
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
 * Call Gemini 3.8 Flash / Gemini 2.5 Flash via REST API
 */
async function callGemini(apiKey, prompt, options = {}) {
  const model = options.model || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const url = `${GEMINI_API_BASE}/models/${model}:generateContent?key=${apiKey}`;

  const payload = {
    contents: [
      {
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature: options.temperature ?? 0.3,
      maxOutputTokens: options.maxOutputTokens || 1200,
      responseMimeType: options.json ? 'application/json' : 'text/plain',
    },
  };

  const response = await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    headersTimeout: 10000,
    bodyTimeout: 15000,
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const errorText = await response.body.text();
    throw new Error(`Gemini API error [${response.statusCode}]: ${errorText.slice(0, 300)}`);
  }

  const data = /** @type {any} */ (await response.body.json());
  const candidate = data.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text || '';
  return text.trim();
}

/**
 * Full deep analysis of an incoming lead message using Gemini
 */
async function analyzeLeadWithGemini(apiKey, input, context = {}) {
  const property = context.property || {};
  const brokerTz = context.brokerTz || 'Asia/Dubai';

  const systemPrompt = `
You are an expert Real Estate Lead Intelligence Agent working worldwide (Dubai, Europe, CIS, US, Bali, etc.).
Analyze the following buyer/renter inquiry for a real estate broker.

PROPERTY CONTEXT:
- Title: ${property.title || 'General Real Estate Inquiry'}
- Location: ${property.location || property.city || 'International'}
- Price: ${property.price ? `${property.price} ${property.currency || 'USD'}` : 'Not specified'}
- Kind: ${property.kind || 'sale'}

BROKER INFO:
- Timezone: ${brokerTz}

INQUIRY:
Sender: ${input.sender_name || 'Client'}
Text: "${input.text || ''}"

Return ONLY a valid JSON object matching this schema:
{
  "intent": "viewing" | "price" | "finance" | "docs" | "area" | "avail" | "details" | "unclear" | "stop",
  "score": "HOT" | "WARM" | "COLD",
  "score_reason": "brief 1-sentence reason for this score",
  "language": "en" | "ru" | "ar" | "de" | "es" | "fr" | "other",
  "urgency": "high" | "medium" | "low",
  "clean_name": "extracted client first name if identifiable, or null",
  "budget": {
    "amount": number or null,
    "currency": "AED" | "USD" | "EUR" | "RUB" | "GBP" | null,
    "period": "year" | "month" | "total" | null
  },
  "specific_requirements": ["string list of features asked, e.g. 'sea view', '2 cheques', 'parking'"],
  "asks_discount": boolean,
  "is_stop": boolean,
  "summary": "1 concise sentence summarizing what the client wants in Russian or English based on lead language"
}
`;

  try {
    const raw = await callGemini(apiKey, systemPrompt, { json: true, temperature: 0.1 });
    const result = parseJsonSafe(raw);
    if (!result || !result.intent) throw new Error('invalid_gemini_json');
    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Generate 3 tailored, high-converting broker replies using Gemini
 */
async function generateRepliesWithGemini(apiKey, leadData, context = {}) {
  const property = context.property || {};
  const slots = context.slots || [];
  const brokerName = context.brokerName || 'Your Broker';
  const lang = leadData.language === 'ru' ? 'ru' : 'en';

  const slotsText = slots.length > 0
    ? slots.slice(0, 3).map((s, i) => `${i + 1}. ${s.label || s.start_utc || s}`).join('\n')
    : 'No pre-set slots. Ask the client when it is convenient.';

  const prompt = `
You are writing real-time response options for a top real estate broker to send to a lead on Telegram/WhatsApp.
Tone: Professional, friendly, helpful, concise, confident, human (NEVER robotic or corporate).
Style: ${({ business: 'Business expert: focus on budget and booking a viewing.', short: 'Short: 2-3 sentences, no fluff.', warm: 'Warm and friendly, but professional.' }[context.style] || 'Business expert: focus on budget and booking a viewing.')}
Write in ${lang === 'ru' ? 'RUSSIAN' : 'ENGLISH'}.

LEAD INFO:
- Client: ${leadData.clean_name || leadData.sender_name || 'Client'}
- Message: "${leadData.text || ''}"
- Intent: ${leadData.intent || 'general'}
- Score: ${leadData.score || 'WARM'}
- Summary: ${leadData.summary || ''}

PROPERTY (the only source of facts; never invent numbers):
${factsBlock({ ...property, __lang: lang })}

GROUNDING RULES (hard):
${GROUNDING_RULES_EN}

AVAILABLE VIEWING SLOTS:
${slotsText}

Produce exactly 3 distinct response options:
- Option 1 (Direct to Viewing): Push directly to schedule a viewing or call, suggesting the available slots.
- Option 2 (Consultative & Answer): Directly answer their specific question (price, layout, documents, amenities) with high value and warmth.
- Option 3 (Qualification & Discovery): Acknowledge their message, provide basic info, and ask a smart qualifying question (move-in date, budget range, investment vs living).

Return ONLY a JSON object:
{
  "options": [
    {
      "id": "gemini_viewing",
      "title": "Booking / Viewing",
      "text": "Full text of message 1 ready to send"
    },
    {
      "id": "gemini_answer",
      "title": "Informative Answer",
      "text": "Full text of message 2 ready to send"
    },
    {
      "id": "gemini_qualify",
      "title": "Qualification & Discovery",
      "text": "Full text of message 3 ready to send"
    }
  ]
}
`;

  try {
    const raw = await callGemini(apiKey, prompt, { json: true, temperature: 0.4 });
    const result = parseJsonSafe(raw);
    if (!result || !Array.isArray(result.options)) throw new Error('invalid_gemini_options');
    return { ok: true, options: result.options };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  callGemini,
  analyzeLeadWithGemini,
  generateRepliesWithGemini,
};
