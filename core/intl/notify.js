'use strict';

const { sendBrokerMessage } = require('./telegramSend');

function miniAppUrl(config) {
  const raw = String(config?.UI_PUBLIC_BASE || '').trim();
  if (!raw.startsWith('https://')) return '';
  try {
    const url = new URL(raw);
    if (url.username || url.password) return '';
    const path = url.pathname.replace(/\/$/, '');
    return `${url.origin}${path}`;
  } catch {
    return '';
  }
}

function brokerChatIds(config) {
  const ids = new Set();
  for (const id of config.TELEGRAM_ALLOWED_USER_IDS || []) {
    if (id && id !== '*') ids.add(String(id));
  }
  const chat = String(config.TELEGRAM_CHAT_ID || '').trim();
  if (chat) ids.add(chat);
  return [...ids];
}

function notifyNewLeadText({ grade, lang = 'en' }) {
  const ru = lang === 'ru';
  const hot = String(grade || 'COLD').toUpperCase();
  return ru
    ? `Вам пришло новое сообщение от ${hot} лида`
    : `You got a new message from a ${hot} lead`;
}

function notifyRemindText({ leadId, grade, waitingMinutes, lang = 'en' }) {
  const ru = lang === 'ru';
  const wait = Number.isFinite(waitingMinutes) ? waitingMinutes : '?';
  return ru
    ? `Напоминание ${leadId} · ${grade || '—'} · ждёт OK уже ${wait} мин`
    : `Reminder ${leadId} · ${grade || '—'} · waiting for OK ${wait} min`;
}

function formatDigestText(digest, config) {
  const zone = config.BROKER_TZ || 'Asia/Dubai';
  const write = digest.write_first || [];
  const viewings = digest.viewings_today || [];
  const lines = [
    `Morning digest · ${zone}`,
    write.length ? `Write first: ${write.length}` : 'Write first: none',
  ];
  for (const row of write.slice(0, 5)) {
    lines.push(`· ${row.grade || '—'} ${row.id}${row.waiting_minutes != null ? ` · ${row.waiting_minutes}m` : ''}`);
  }
  if (viewings.length) lines.push(`Viewings today: ${viewings.length}`);
  const app = miniAppUrl(config);
  if (app) lines.push(app);
  return lines.join('\n');
}

async function notifyBrokers(config, text, fetchImpl) {
  if (config.CHANNEL_MODE !== 'live') {
    return { ok: true, simulated: true, telegram_delivery: false, sent: 0 };
  }
  const ids = brokerChatIds(config);
  if (!ids.length || !config.TELEGRAM_BOT_TOKEN) {
    return { ok: false, telegram_delivery: false, sent: 0, error_code: 'no_broker_chat' };
  }
  let sent = 0;
  let last = null;
  for (const chatId of ids) {
    last = await sendBrokerMessage(config, chatId, text, fetchImpl);
    if (last.ok) sent += 1;
  }
  return {
    ok: sent > 0,
    telegram_delivery: sent > 0,
    simulated: false,
    sent,
    error_code: sent > 0 ? undefined : (last && last.error_code) || 'telegram_rejected',
  };
}

async function deliverDigest(config, digest, fetchImpl) {
  const text = formatDigestText(digest || {}, config);
  const result = await notifyBrokers(config, text, fetchImpl);
  return {
    ...result,
    sent: result.telegram_delivery === true,
  };
}

module.exports = {
  miniAppUrl,
  brokerChatIds,
  notifyNewLeadText,
  notifyRemindText,
  formatDigestText,
  notifyBrokers,
  deliverDigest,
};
