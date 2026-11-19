'use strict';

const DEFAULT_TEMPLATES = Object.freeze([
  {
    id: 'tpl_viewing',
    label_en: 'Offer viewing',
    label_ru: 'Предложить просмотр',
    text_en: 'Happy to arrange a viewing. Which day and time suit you?',
    text_ru: 'Могу предложить просмотр. Какой день и время вам удобны?',
  },
  {
    id: 'tpl_price',
    label_en: 'Confirm price',
    label_ru: 'Подтвердить цену',
    text_en: 'The listed price is current. I can also send the brochure and floor plan.',
    text_ru: 'Актуальная цена — как в объявлении. Могу прислать брошюру и планировку.',
  },
  {
    id: 'tpl_materials',
    label_en: 'Send materials',
    label_ru: 'Прислать материалы',
    text_en: 'Sending the brochure and key details now. Tell me if you want viewing slots too.',
    text_ru: 'Отправляю брошюру и ключевые детали. Напишите, если нужны слоты на просмотр.',
  },
  {
    id: 'tpl_follow',
    label_en: 'Soft follow-up',
    label_ru: 'Мягкий follow-up',
    text_en: 'Just checking in — still interested in this property? Happy to help with next steps.',
    text_ru: 'Напоминаю о себе — объект ещё интересен? Могу помочь со следующим шагом.',
  },
]);

function parseTemplates(raw) {
  if (!raw) return [...DEFAULT_TEMPLATES];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length) return [...DEFAULT_TEMPLATES];
    return parsed.slice(0, 20).map((row, index) => ({
      id: String(row.id || `tpl_${index + 1}`).slice(0, 40),
      label_en: String(row.label_en || row.label || row.id || 'Template').slice(0, 60),
      label_ru: String(row.label_ru || row.label_en || row.label || row.id || 'Шаблон').slice(0, 60),
      text_en: String(row.text_en || row.text || '').slice(0, 900),
      text_ru: String(row.text_ru || row.text_en || row.text || '').slice(0, 900),
    })).filter((row) => row.text_en || row.text_ru);
  } catch {
    return [...DEFAULT_TEMPLATES];
  }
}

function getTemplates(store, setting) {
  return parseTemplates(setting(store, 'reply_templates_json'));
}

function saveTemplates(store, setting, list) {
  const cleaned = parseTemplates(JSON.stringify(Array.isArray(list) ? list : []));
  setting(store, 'reply_templates_json', JSON.stringify(cleaned));
  return cleaned;
}

function attachLinksFooter(text, attachments) {
  const links = (attachments || [])
    .filter((item) => item && item.url)
    .map((item) => {
      const label = item.kind === 'brochure' ? 'Brochure' : item.kind === 'plan' ? 'Floor plan' : (item.name || 'Link');
      return `${label}: ${item.url}`;
    });
  if (!links.length) return String(text || '');
  const body = String(text || '').trim();
  const block = links.join('\n');
  if (body.includes(links[0])) return body;
  return `${body}\n\n${block}`.trim();
}

function propertyGrounding(property) {
  if (!property || property.id === 'general') {
    return {
      title: '',
      district: '',
      address: '',
      price: '',
      area: '',
      bedrooms: '',
      listing_url: '',
      brochure: false,
      plan: false,
      facts: '',
    };
  }
  const facts = property.facts && typeof property.facts === 'object'
    ? property.facts
    : (() => { try { return JSON.parse(property.facts || '{}'); } catch { return {}; } })();
  return {
    title: property.title || '',
    district: property.district || facts.district || '',
    address: property.address || '',
    price: property.price != null ? `${property.price} ${property.currency || ''} / ${property.price_period || ''}`.trim() : '',
    area: property.area_value ? `${property.area_value} ${property.area_unit || ''}`.trim() : '',
    bedrooms: property.bedrooms != null ? String(property.bedrooms) : (facts.bedrooms != null ? String(facts.bedrooms) : ''),
    listing_url: property.listing_url || '',
    brochure: Boolean(property.brochure_url),
    plan: Boolean(property.plan_url),
    facts: Object.keys(facts).length ? JSON.stringify(facts) : '',
  };
}

function lastInboundText(lead) {
  const messages = lead && Array.isArray(lead.messages) ? lead.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const row = messages[i];
    if (row && row.direction === 'in' && row.text && !row.deleted) return row.text;
  }
  return lead && (lead.inbound_text || lead.last_msg || '') || '';
}

function computeMetrics(store, brokerId) {
  const broker = brokerId ? String(brokerId) : '';
  let leads = store.all('SELECT id, broker_id, first_msg_at, status, grade FROM i_lead');
  if (broker) leads = leads.filter((row) => row.broker_id && String(row.broker_id) === broker);
  const sends = store.all(`SELECT lead_id, created_at, status FROM i_send WHERE status IN ('sent', 'simulated') ORDER BY created_at`);
  const firstSend = new Map();
  for (const row of sends) {
    if (!firstSend.has(row.lead_id)) firstSend.set(row.lead_id, row.created_at);
  }
  let replied = 0;
  let totalTtfr = 0;
  let ttfrCount = 0;
  let hot = 0;
  let waiting = 0;
  let viewingsPlanned = 0;
  try {
    const nowIso = new Date().toISOString();
    viewingsPlanned = store.all("SELECT id FROM i_viewing WHERE status IN ('unconfirmed', 'confirmed') AND start_utc >= ?", [nowIso]).length;
  } catch { viewingsPlanned = 0; }
  for (const lead of leads) {
    if (lead.grade === 'HOT') hot += 1;
    if (lead.status === 'pending_approval' || lead.status === 'review') waiting += 1;
    const sentAt = firstSend.get(lead.id);
    if (!sentAt || !lead.first_msg_at) continue;
    const ms = Date.parse(sentAt) - Date.parse(lead.first_msg_at);
    if (!Number.isFinite(ms) || ms < 0) continue;
    replied += 1;
    totalTtfr += ms;
    ttfrCount += 1;
  }
  return {
    ok: true,
    leads: leads.length,
    waiting,
    hot,
    replied,
    avg_ttfr_minutes: ttfrCount ? Math.round((totalTtfr / ttfrCount) / 60000) : null,
    reply_rate: leads.length ? Math.round((replied / leads.length) * 100) : 0,
    viewings_planned: viewingsPlanned,
  };
}

function listContacts(store, brokerId) {
  const broker = brokerId ? String(brokerId) : '';
  let leads = store.all(
    `SELECT id, channel, sender_hash, sender_name, clean_name, property_id, grade, status, first_msg_at, last_msg_at, broker_id
     FROM i_lead ORDER BY last_msg_at DESC`,
  );
  if (broker) leads = leads.filter((row) => row.broker_id && String(row.broker_id) === broker);
  const map = new Map();
  for (const lead of leads) {
    const key = `${lead.channel}:${lead.sender_hash}`;
    const cur = map.get(key);
    if (!cur) {
      map.set(key, {
        channel: lead.channel,
        sender_hash: lead.sender_hash,
        name: lead.clean_name || lead.sender_name || lead.id,
        grade: lead.grade,
        lead_count: 1,
        property_ids: lead.property_id ? [lead.property_id] : [],
        last_msg_at: lead.last_msg_at,
        lead_ids: [lead.id],
      });
      continue;
    }
    cur.lead_count += 1;
    cur.lead_ids.push(lead.id);
    if (lead.property_id && !cur.property_ids.includes(lead.property_id)) cur.property_ids.push(lead.property_id);
    if (String(lead.last_msg_at || '') > String(cur.last_msg_at || '')) {
      cur.last_msg_at = lead.last_msg_at;
      cur.name = lead.clean_name || lead.sender_name || cur.name;
      cur.grade = lead.grade || cur.grade;
    }
  }
  return [...map.values()].sort((a, b) => String(b.last_msg_at || '').localeCompare(String(a.last_msg_at || '')));
}

function lastInboundAt(store) {
  try {
    const row = store.one(
      `SELECT MAX(created_at) AS at FROM i_message WHERE direction = 'in' AND COALESCE(deleted, 0) = 0`,
    );
    return row && row.at ? String(row.at) : '';
  } catch {
    return '';
  }
}

function connectStatus(store, config, extras = {}) {
  const live = config.CHANNEL_MODE === 'live';
  const brokerScope = extras.brokerId == null ? '' : String(extras.brokerId);
  const rows = brokerScope
    ? store.all('SELECT business_connection_id, can_reply, is_enabled, broker_id, updated_at FROM i_tg_conn WHERE broker_id = ?', [brokerScope])
    : store.all('SELECT business_connection_id, can_reply, is_enabled, broker_id, updated_at FROM i_tg_conn');
  const enabled = rows.filter((row) => Number(row.is_enabled) === 1 && Number(row.can_reply) === 1);
  const whatsappUi = config.INTL_WHATSAPP_UI === true;
  const webhook = extras.webhook || {};
  return {
    ok: true,
    channel_mode: config.CHANNEL_MODE,
    live,
    live_autosend: config.INTL_LIVE_AUTOSEND === true,
    has_token: Boolean(config.TELEGRAM_BOT_TOKEN),
    has_webhook_secret: Boolean(config.TELEGRAM_WEBHOOK_SECRET),
    public_https: String(config.UI_PUBLIC_BASE || '').startsWith('https://'),
    connections: rows.length,
    ready_connections: enabled.length,
    last_inbound_at: lastInboundAt(store),
    webhook_url_set: webhook.url_set === true,
    webhook_pending_update_count: Number(webhook.pending_update_count || 0) || 0,
    webhook_last_error: webhook.last_error ? String(webhook.last_error).slice(0, 200) : '',
    webhook_checked_at: webhook.checked_at || '',
    whatsapp_ui: whatsappUi,
    whatsapp: (() => {
      if (!whatsappUi) {
        return { provider: '', configured: false, ui_enabled: false };
      }
      const provider = String(config.WHATSAPP_PROVIDER || '').toLowerCase()
        || (config.GREENAPI_ID_INSTANCE && config.GREENAPI_API_TOKEN ? 'green' : (config.WHATSAPP_TOKEN && config.WHATSAPP_PHONE_NUMBER_ID ? 'cloud' : ''));
      const configured = provider === 'green'
        ? Boolean(config.GREENAPI_ID_INSTANCE && config.GREENAPI_API_TOKEN)
        : Boolean(config.WHATSAPP_TOKEN && config.WHATSAPP_PHONE_NUMBER_ID);
      return {
        provider,
        configured,
        ui_enabled: true,
        verify_token: Boolean(config.WHATSAPP_VERIFY_TOKEN),
        app_secret: Boolean(config.WHATSAPP_APP_SECRET),
        instance_authorized_hint: provider === 'green',
      };
    })(),
    checklist: [
      { id: 'https', ok: String(config.UI_PUBLIC_BASE || '').startsWith('https://'), label: 'UI_PUBLIC_BASE is https' },
      ...(whatsappUi ? [{
        id: 'whatsapp',
        ok: config.WHATSAPP_TOKEN
          ? Boolean(config.WHATSAPP_TOKEN && config.WHATSAPP_PHONE_NUMBER_ID && config.WHATSAPP_VERIFY_TOKEN && config.WHATSAPP_APP_SECRET)
          : Boolean(config.GREENAPI_ID_INSTANCE && config.GREENAPI_API_TOKEN && config.GREENAPI_WEBHOOK_TOKEN),
        label: 'WhatsApp channel configured',
      }] : []),
      { id: 'token', ok: Boolean(config.TELEGRAM_BOT_TOKEN), label: 'Bot token set' },
      { id: 'webhook', ok: Boolean(config.TELEGRAM_WEBHOOK_SECRET), label: 'Webhook secret set' },
      { id: 'webhook_url', ok: webhook.url_set === true || !live, label: 'Telegram webhook URL set' },
      { id: 'mode', ok: live, label: 'CHANNEL_MODE=live' },
      { id: 'autosend_off', ok: config.INTL_LIVE_AUTOSEND !== true, label: 'INTL_LIVE_AUTOSEND off' },
      { id: 'business', ok: enabled.length > 0, label: 'Telegram Business connection ready' },
    ],
  };
}

function ensureFollowupSchema(store) {
  try {
    store.run(`CREATE TABLE IF NOT EXISTS i_followup (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      broker_id TEXT,
      due_at TEXT NOT NULL,
      kind TEXT,
      note TEXT,
      status TEXT,
      created_at TEXT
    )`);
  } catch { /* store may be read-only in exotic tests */ }
}

function listFollowups(store, brokerId) {
  ensureFollowupSchema(store);
  let rows = store.all(`SELECT * FROM i_followup WHERE status = 'open' ORDER BY due_at`);
  if (brokerId) rows = rows.filter((row) => !row.broker_id || String(row.broker_id) === String(brokerId));
  return rows;
}

function addFollowup(store, { id, leadId, brokerId, dueAt, kind, note, createdAt }) {
  ensureFollowupSchema(store);
  store.run(
    `INSERT INTO i_followup (id, lead_id, broker_id, due_at, kind, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
    [id, leadId, brokerId ? String(brokerId) : null, dueAt, kind || 'follow', note || '', createdAt],
  );
  return store.one('SELECT * FROM i_followup WHERE id = ?', [id]);
}

function closeFollowup(store, id, status = 'done') {
  ensureFollowupSchema(store);
  store.run(`UPDATE i_followup SET status = ? WHERE id = ?`, [status, id]);
  return store.one('SELECT * FROM i_followup WHERE id = ?', [id]);
}

function dueFollowups(store, nowIso) {
  ensureFollowupSchema(store);
  return store.all(`SELECT * FROM i_followup WHERE status = 'open' AND due_at <= ? ORDER BY due_at`, [nowIso]);
}

module.exports = {
  DEFAULT_TEMPLATES,
  getTemplates,
  saveTemplates,
  parseTemplates,
  attachLinksFooter,
  propertyGrounding,
  lastInboundText,
  computeMetrics,
  listContacts,
  connectStatus,
  ensureFollowupSchema,
  listFollowups,
  addFollowup,
  closeFollowup,
  dueFollowups,
};
