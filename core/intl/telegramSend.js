'use strict';

// Live Telegram send for one business connection. Text only.
// Sim mode never calls this. The token stays in the request URL and is not logged.
// sendMessage is one attempt. Retries are only for getBusinessConnection and getWebhookInfo.

const WEBHOOK_UPDATES = Object.freeze([
  'message',
  'business_connection',
  'business_message',
  'edited_business_message',
  'deleted_business_messages',
]);
const FETCH_TIMEOUT_MS = 10000;

function apiUrl(token, method) {
  return `https://api.telegram.org/bot${token}/${method}`;
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function postTelegram(token, method, body, fetchImpl, retry) {
  const fetchFn = fetchImpl || global.fetch;
  const attempts = retry ? 3 : 1;
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    let res;
    try {
      res = await fetchFn(apiUrl(token, method), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      last = {
        ok: false,
        status: 502,
        error_code: retry ? 'telegram_unavailable' : 'unknown_delivery',
        unknown: !retry,
      };
      if (retry && i < attempts - 1) continue;
      return last;
    }
    const data = await readJson(res);
    if (res.ok && data && data.ok === true) return { ok: true, status: 200, data };
    const retryAfter = Number(data && data.parameters && data.parameters.retry_after);
    if (res.status === 429) {
      return {
        ok: false,
        status: 429,
        error_code: 'rate_limited',
        retry_after: Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : 1,
      };
    }
    if (res.status >= 500) {
      last = {
        ok: false,
        status: res.status,
        error_code: retry ? 'telegram_unavailable' : 'unknown_delivery',
        unknown: !retry,
      };
      if (retry && i < attempts - 1) continue;
      return last;
    }
    return { ok: false, status: res.status || 400, error_code: 'telegram_rejected' };
  }
  return last || { ok: false, status: 502, error_code: 'telegram_unavailable', unknown: !retry };
}

async function deliverMessage(payload) {
  const config = payload.config || {};
  const token = config.TELEGRAM_BOT_TOKEN;
  const lead = payload.lead || {};
  const chatId = lead.reply_target || payload.chatId;
  const businessConnectionId = payload.businessConnectionId || lead.business_connection_id;
  if (!token || !chatId) {
    return { ok: false, status: 409, error_code: 'cannot_reply' };
  }
  const body = {
    chat_id: chatId,
    text: String(payload.text || ''),
  };
  if (businessConnectionId) {
    body.business_connection_id = businessConnectionId;
  }
  const sent = await postTelegram(token, 'sendMessage', body, payload.fetchImpl, false);
  if (!sent.ok) return sent;
  const message = sent.data && sent.data.result;
  return {
    ok: true,
    status: 200,
    simulated: false,
    channel_msg_id: message && message.message_id != null ? String(message.message_id) : '',
  };
}

async function getBusinessConnection(config, id, fetchImpl) {
  const token = config && config.TELEGRAM_BOT_TOKEN;
  if (!token || !id) return { ok: false, status: 502, unknown: true };
  const result = await postTelegram(token, 'getBusinessConnection', {
    business_connection_id: id,
  }, fetchImpl, true);
  if (result.ok && result.data && result.data.result) return { ok: true, connection: result.data.result };
  const status = result.status || 0;
  if (status === 401 || status === 403) {
    console.error('telegram_auth_failed');
    return { ok: false, status, unknown: true, error_code: 'telegram_auth_failed' };
  }
  return {
    ok: false,
    status,
    unknown: Boolean(result.unknown) || status >= 500 || status === 429 || status === 0,
  };
}

async function setWebhook(config, webhookUrl, fetchImpl) {
  const token = config && config.TELEGRAM_BOT_TOKEN;
  if (!token || !webhookUrl) return { ok: false, error_code: 'webhook_config_missing' };
  const body = {
    url: webhookUrl,
    allowed_updates: [...WEBHOOK_UPDATES],
    drop_pending_updates: false,
  };
  if (config.TELEGRAM_WEBHOOK_SECRET) body.secret_token = config.TELEGRAM_WEBHOOK_SECRET;
  return postTelegram(token, 'setWebhook', body, fetchImpl, false);
}

async function getWebhookInfo(config, fetchImpl) {
  const token = config && config.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, error_code: 'webhook_config_missing' };
  return postTelegram(token, 'getWebhookInfo', {}, fetchImpl, true);
}

async function sendBrokerMessage(config, chatId, text, fetchImpl) {
  const token = config && config.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) {
    return { ok: false, status: 409, error_code: 'cannot_reply' };
  }
  const body = {
    chat_id: String(chatId),
    text: String(text || ''),
  };
  return postTelegram(token, 'sendMessage', body, fetchImpl, false);
}

module.exports = {
  WEBHOOK_UPDATES,
  deliverMessage,
  sendBrokerMessage,
  getBusinessConnection,
  setWebhook,
  getWebhookInfo,
};
