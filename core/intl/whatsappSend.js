'use strict';

// Two WhatsApp providers behind one channel:
//   "cloud" — Meta WhatsApp Cloud API (official). Webhook GET verification + X-Hub-Signature-256,
//             outbound POST graph.facebook.com/{phoneNumberId}/messages.
//   "green" — Green API (green-api.com), a third-party bridge to WhatsApp. Webhook token in the URL,
//             outbound POST api.green-api.com/waInstance{id}/sendMessage/{token}.
//
// Honest limits for both: text only (no media/voice); WhatsApp itself enforces its own rules.
// Green API is not an official Meta product — the account works through WhatsApp Web protocol, so the
// operator accepts the usual risk of restrictions; the official Cloud API is the safer production path.

const crypto = require('crypto');

function apiVersion(config) {
  return String((config && config.WHATSAPP_API_VERSION) || 'v21.0');
}

function apiBase(config) {
  return String((config && config.WHATSAPP_API_BASE) || 'https://graph.facebook.com').replace(/\/$/, '');
}

function greenBase(config) {
  return String((config && config.GREENAPI_API_URL) || 'https://api.green-api.com').replace(/\/$/, '');
}

function cloudReady(config) {
  return Boolean(config && config.WHATSAPP_TOKEN && config.WHATSAPP_PHONE_NUMBER_ID);
}

function greenReady(config) {
  return Boolean(config && config.GREENAPI_ID_INSTANCE && config.GREENAPI_API_TOKEN);
}

function providerOf(config) {
  if (!config) return 'none';
  const explicit = String(config.WHATSAPP_PROVIDER || '').trim().toLowerCase();
  if (explicit === 'cloud') return cloudReady(config) ? 'cloud' : 'none';
  if (explicit === 'green') return greenReady(config) ? 'green' : 'none';
  if (greenReady(config)) return 'green';
  if (cloudReady(config)) return 'cloud';
  return 'none';
}

function whatsappConfigured(config) {
  return providerOf(config) !== 'none';
}

// The broker can connect a gateway from the Mini App. Those credentials live in i_settings and
// override the deployment env; every WhatsApp path (webhook, polling, sending, status) resolves
// the effective config through this function so a saved gateway works without a server restart.
function effectiveConfig(config, store, brokerId) {
  const base = config || {};
  const owner = String(
    base.OWNER_TELEGRAM_ID
    || (Array.isArray(base.TELEGRAM_ALLOWED_USER_IDS) ? base.TELEGRAM_ALLOWED_USER_IDS.map(String).find((id) => id && id !== '*') : '')
    || (base.MAKLER_PROFILE && base.MAKLER_PROFILE.telegram_user_id)
    || ''
  );
  const scoped = brokerId != null && String(brokerId) !== '' && String(brokerId) !== owner;
  const get = (key) => {
    try {
      if (brokerId != null && String(brokerId) !== '') {
        const row = store && store.one('SELECT value FROM i_settings WHERE key = ?', [key + '::' + String(brokerId)]);
        if (row && row.value != null) return String(row.value);
      }
      if (scoped) return '';
      const row = store && store.one('SELECT value FROM i_settings WHERE key = ?', [key]);
      return row && row.value != null ? String(row.value) : '';
    } catch {
      return '';
    }
  };
  const gateway = get('wa_gateway');
  const provider = gateway || (scoped ? '' : String(base.WHATSAPP_PROVIDER || ''));
  return {
    ...base,
    WHATSAPP_PROVIDER: provider,
    GREENAPI_ID_INSTANCE: get('wa_green_id') || (scoped ? '' : base.GREENAPI_ID_INSTANCE),
    GREENAPI_API_TOKEN: get('wa_green_token') || (scoped ? '' : base.GREENAPI_API_TOKEN),
    WHATSAPP_TOKEN: get('wa_cloud_token') || (scoped ? '' : base.WHATSAPP_TOKEN),
    WHATSAPP_PHONE_NUMBER_ID: get('wa_cloud_phone_id') || (scoped ? '' : base.WHATSAPP_PHONE_NUMBER_ID),
    WHATSAPP_VERIFY_TOKEN: get('wa_cloud_verify') || (scoped ? '' : base.WHATSAPP_VERIFY_TOKEN),
    WHATSAPP_APP_SECRET: get('wa_cloud_secret') || (scoped ? '' : base.WHATSAPP_APP_SECRET),
    GREENAPI_WEBHOOK_TOKEN: get('wa_webhook_token') || (scoped ? '' : base.GREENAPI_WEBHOOK_TOKEN),
  };
}

// ---------- Meta Cloud API: inbound ----------

function verifyChallenge(config, query) {
  if (providerOf(config) !== 'cloud') {
    return { ok: false, status: 404, error_code: 'not_supported' };
  }
  const mode = query.get('hub.mode');
  const token = query.get('hub.verify_token');
  const challenge = query.get('hub.challenge') || '';
  if (mode !== 'subscribe') return { ok: false, status: 403, error_code: 'forbidden' };
  if (!config.WHATSAPP_VERIFY_TOKEN || String(token || '') !== String(config.WHATSAPP_VERIFY_TOKEN)) {
    return { ok: false, status: 403, error_code: 'forbidden' };
  }
  return { ok: true, status: 200, challenge };
}

function verifySignature(config, rawBody, headers) {
  const secret = config && config.WHATSAPP_APP_SECRET;
  if (!secret) return { ok: false, status: 503, error_code: 'whatsapp_not_configured' };
  const header = String((headers && headers['x-hub-signature-256']) || '');
  if (!header.startsWith('sha256=')) return { ok: false, status: 403, error_code: 'forbidden' };
  const expected = `sha256=${crypto.createHmac('sha256', String(secret)).update(String(rawBody || '')).digest('hex')}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, status: 403, error_code: 'forbidden' };
  return { ok: true, status: 200 };
}

// Green API has no request signature: the shared secret is the webhook URL token we configure
// in the Green API console (and verify here on every POST).
function verifyWebhookToken(config, token) {
  const expected = String((config && config.GREENAPI_WEBHOOK_TOKEN) || '');
  const got = String(token || '');
  if (!expected) return { ok: false, status: 503, error_code: 'whatsapp_not_configured' };
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, status: 403, error_code: 'forbidden' };
  return { ok: true, status: 200 };
}

// ---------- Meta Cloud API: parser ----------

function textOfCloudMessage(message) {
  if (!message || typeof message !== 'object') return '';
  if (message.type === 'text') return String((message.text && message.text.body) || '');
  if (message.type === 'button') return String((message.button && message.button.text) || '');
  if (message.type === 'interactive') {
    const reply = message.interactive && message.interactive.button_reply;
    const list = message.interactive && message.interactive.list_reply;
    return String((reply && reply.title) || (list && list.title) || '');
  }
  if (message.type === 'reaction') return String((message.reaction && message.reaction.emoji) || '');
  return '';
}

function inboundCloud(payload) {
  const out = [];
  for (const entry of (payload && payload.entry) || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const names = new Map();
      for (const contact of value.contacts || []) {
        if (contact && contact.wa_id) names.set(String(contact.wa_id), (contact.profile && contact.profile.name) || '');
      }
      for (const message of value.messages || []) {
        const from = String(message.from || '');
        if (!from) continue;
        const text = textOfCloudMessage(message).trim();
        const receivedAt = message.timestamp ? new Date(Number(message.timestamp) * 1000).toISOString() : '';
        out.push({
          channel: 'whatsapp',
          sender_id: from,
          sender_name: names.get(from) || '',
          text,
          kind: text ? 'text' : 'non_text',
          received_at: receivedAt,
          message_id: String(message.id || ''),
          media_type: text ? '' : String(message.type || ''),
        });
      }
    }
  }
  return out;
}

// ---------- Green API: parser ----------

function textOfGreenMessage(data) {
  if (!data || typeof data !== 'object') return '';
  switch (data.typeMessage) {
    case 'textMessage':
      return String((data.textMessageData && data.textMessageData.textMessage) || '');
    case 'extendedTextMessage':
      return String((data.extendedTextMessageData && data.extendedTextMessageData.text) || '');
    case 'buttonsResponseMessage':
      return String((data.buttonsResponseMessage && data.buttonsResponseMessage.selectedButtonText) || '');
    case 'listResponseMessage':
      return String((data.listResponseMessage && data.listResponseMessage.title) || '');
    case 'templateMessage':
      return String((data.templateMessage && data.templateMessage.templateId) || '');
    default:
      return '';
  }
}

function inboundGreen(payload) {
  if (!payload || payload.typeWebhook !== 'incomingMessageReceived') return [];
  const sender = payload.senderData || {};
  const chatId = String(sender.chatId || '');
  if (!chatId) return [];
  // Groups, channels and broadcasts are out of scope for a broker's direct chats.
  if (chatId.endsWith('@g.us') || chatId.endsWith('@broadcast') || chatId.endsWith('@newsletter')) return [];
  const data = payload.messageData || {};
  const text = textOfGreenMessage(data).trim();
  const timestamp = Number(payload.timestamp) || 0;
  return [{
    channel: 'whatsapp',
    sender_id: chatId,
    sender_name: String(sender.senderName || sender.senderContactName || '').trim(),
    text,
    kind: text ? 'text' : 'non_text',
    received_at: timestamp ? new Date(timestamp * 1000).toISOString() : '',
    message_id: String(payload.idMessage || ''),
    media_type: text ? '' : String(data.typeMessage || ''),
  }];
}

function inboundMessages(payload, provider) {
  if (provider === 'green') return inboundGreen(payload);
  if (provider === 'cloud') return inboundCloud(payload);
  // Shape detection keeps the parser usable even without an explicit provider.
  if (payload && payload.typeWebhook) return inboundGreen(payload);
  return inboundCloud(payload);
}

// ---------- outbound ----------

function errorCodeForCloud(httpStatus, apiError) {
  const code = Number(apiError && apiError.code);
  if (code === 131047 || code === 131026) return 'template_required';
  if (code === 190) return 'whatsapp_token_invalid';
  if (code === 131056) return 'rate_limited';
  if (httpStatus === 401 || httpStatus === 403) return 'whatsapp_token_invalid';
  return 'send_failed';
}

async function sendCloud(payload, fetchImpl) {
  const config = (payload && payload.config) || {};
  const lead = (payload && payload.lead) || {};
  const token = config.WHATSAPP_TOKEN;
  const phoneId = config.WHATSAPP_PHONE_NUMBER_ID;
  const to = String(lead.reply_target || lead.sender_id || '');
  if (!token || !phoneId || !to || to.startsWith('sim:')) {
    return { ok: false, status: 409, error_code: 'cannot_reply' };
  }
  const url = `${apiBase(config)}/${apiVersion(config)}/${encodeURIComponent(phoneId)}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { preview_url: false, body: String((payload && payload.text) || '') },
  };
  const doFetch = fetchImpl || fetch;
  let response;
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 502, error_code: 'unknown_delivery', unknown: true };
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ok: false, status: response.status || 502, error_code: errorCodeForCloud(response.status, data && data.error), retryable: false };
  }
  const sent = data && data.messages && data.messages[0];
  return { ok: true, status: 200, simulated: false, channel_msg_id: (sent && sent.id) || '' };
}

function greenChatId(lead) {
  let chatId = String((lead && (lead.reply_target || lead.sender_id)) || '').trim();
  if (!chatId) return '';
  if (!chatId.includes('@')) chatId = chatId.replace(/\D/g, '') + '@c.us';
  return chatId;
}

function errorCodeForGreen(httpStatus, data) {
  const head = Number(data && (data.code || data.statusCode));
  if (httpStatus === 401 || httpStatus === 403) return 'whatsapp_token_invalid';
  if (httpStatus === 429 || head === 429) return 'rate_limited';
  if (head === 466 || head === 467) return 'instance_not_authorized';
  return 'send_failed';
}

async function sendGreen(payload, fetchImpl) {
  const config = (payload && payload.config) || {};
  const instance = config.GREENAPI_ID_INSTANCE;
  const token = config.GREENAPI_API_TOKEN;
  const chatId = greenChatId(payload && payload.lead);
  if (!instance || !token || !chatId) return { ok: false, status: 409, error_code: 'cannot_reply' };
  const url = `${greenBase(config)}/waInstance${encodeURIComponent(instance)}/sendMessage/${encodeURIComponent(token)}`;
  const body = { chatId, message: String((payload && payload.text) || '') };
  const doFetch = fetchImpl || fetch;
  let response;
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 502, error_code: 'unknown_delivery', unknown: true };
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ok: false, status: response.status || 502, error_code: errorCodeForGreen(response.status, data), retryable: false };
  }
  return { ok: true, status: 200, simulated: false, channel_msg_id: String((data && data.idMessage) || '') };
}

function deliverWhatsApp(payload, fetchImpl) {
  const config = payload && payload.config;
  const provider = providerOf(config);
  if (provider === 'green') return sendGreen(payload, fetchImpl);
  if (provider === 'cloud') return sendCloud(payload, fetchImpl);
  return { ok: false, status: 409, error_code: 'cannot_reply' };
}

module.exports = {
  apiBase,
  apiVersion,
  greenBase,
  providerOf,
  whatsappConfigured,
  effectiveConfig,
  verifyChallenge,
  verifySignature,
  verifyWebhookToken,
  inboundMessages,
  inboundGreen,
  deliverWhatsApp,
  sendCloud,
  sendGreen,
};
