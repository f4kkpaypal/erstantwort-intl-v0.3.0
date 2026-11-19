'use strict';

const crypto = require('crypto');
const { DateTime } = require('luxon');
const { analyze } = require('./analyze');
const { scoreChat, sortLeads } = require('./score');
const { classifyReadiness, readinessRank } = require('./readiness');
const { parseProposal } = require('./when');
const { matchProperty } = require('./matchProperty');
const { brochurePdf } = require('./brochure');
const { createBrokerCalendar } = require('./calendar');
const { buildOptions, formatPrice, slotPhrase, rewriteReplyTime } = require('./options');
const { listFreeSlots, assertSlot } = require('./slots');
const { openIntlStore } = require('./store');
const { deliverMessage, getBusinessConnection } = require('./telegramSend');
const whatsapp = require('./whatsappSend');
const validation = require('./validation');
const retry = require('./retry');
const { processVoiceMessage } = require('./voice');
const { fetchListing } = require('./listingImport');
const { buildDigest: buildDigestModule, runDigest: runDigestModule } = require('./digest');
const { addSlot: addSlotModule, bookViewing: bookViewingModule, setViewing: setViewingModule } = require('./booking');
const {
  deliverDigest: deliverDigestModule,
  notifyBrokers,
  notifyNewLeadText,
  notifyRemindText,
  miniAppUrl,
} = require('./notify');
const desk = require('./desk');
const team = require('./team');

const AI_EN = 'AI-assisted message. Reply STOP to opt out.';
const AI_RU = 'Сообщение подготовлено с помощью ИИ. Напишите STOP, чтобы отписаться.';
const STOP_EN = 'Reply STOP to opt out.';
const STOP_RU = 'Напишите STOP, чтобы отписаться.';

const channel = {
  send(payload) {
    if (!payload || payload.live !== true) {
      return { ok: true, simulated: true, channel_msg_id: `sim-${Date.now()}` };
    }
    const lead = payload.lead || {};
    if (lead.channel === 'whatsapp') return whatsapp.deliverWhatsApp(payload, payload.fetchImpl);
    if (lead.channel === 'telegram') return deliverMessage(payload);
    return { ok: false, status: 409, error_code: 'cannot_reply' };
  },
};

const LEAD_STATUSES = Object.freeze(['pending_approval', 'review', 'sent', 'handled', 'stopped', 'archived']);
const VIEWING_STATUSES = Object.freeze(['unconfirmed', 'confirmed', 'cancelled']);

function channelLabel(name) {
  if (name === 'telegram') return 'Telegram';
  if (name === 'whatsapp') return 'WhatsApp';
  return name === 'wa_sim' ? 'Simulator' : String(name || 'Simulator');
}

function senderHash(salt, channelName, senderId) {
  return crypto.createHmac('sha256', String(salt)).update(`${channelName}:${senderId}`).digest('hex');
}

function createIntl(config, options = {}) {
  const store = options.store || openIntlStore(config, options);
  let clock = options.clock || (() => new Date());
  const calendar = options.calendar || createBrokerCalendar(config, {
    now: () => clock(),
    busy: options.busy,
    getBusy: options.getBusy,
    timeoutMs: options.timeoutMs,
    zone: config.BROKER_TZ,
    lunch: options.lunch,
  });
  let chain = Promise.resolve();
  const lock = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  };
  const api = {
    store,
    clock,
    calendar,
    fetch: options.fetch || null,
    close() { store.close(); },
    now() { return clock(); },
    setClock(fn) { clock = fn; },
    digestTick(reason, actorId) { return runDigest(api, config, reason, actorId); },
    deliverDigest(digest, actorId) {
      return deliverDigestModule(config, digest, api.fetch).then((delivery) => {
        audit(api.store, config, 'digest_telegram', null, {
          telegram_delivery: delivery.telegram_delivery === true,
          sent: delivery.sent || 0,
          actor: actorId || 'system',
        }, String(actorId || 'system'));
        return delivery;
      });
    },
    remind() { return remindBrokers(api, config); },
    hash: senderHash,
    ingest(input) { return lock(() => ingest(api, config, input)); },
    send(leadId, body, actor) { return lock(() => sendLead(api, config, leadId, body, actor)); },
    reject(leadId, actor) { return lock(() => rejectLead(api, config, leadId, actor)); },
    archive(leadId, actor) { return lock(() => archiveLead(api, config, leadId, actor)); },
    handled(leadId, actor) { return lock(() => markHandled(api, config, leadId, actor)); },
    unhandled(leadId, actor) { return lock(() => revertHandled(api, config, leadId, actor)); },
    applySlot(leadId, body) { return lock(() => applyChosenSlot(api, config, leadId, body)); },
    stop(leadId, actor) { return lock(() => stopLead(api, config, leadId, actor)); },
    saveDraft(leadId, body) { return lock(() => saveDraft(api, config, leadId, body)); },
    lead(id, brokerId) { return presentLead(api, config, id, brokerId); },
    leads(query) { return listPresent(api, query || {}); },
    exportCsv(kind, brokerId) { return exportCsv(api, kind, brokerId); },
    digest() { return buildDigest(api, config); },
    addProperty(body, actor) { return lock(() => addProperty(api, config, body, actor)); },
    importListing(url) { return fetchListing(url, { fetchImpl: api.fetch || undefined }); },
    photos(id) { return publicPhotos(store, id); },
    confirm(leadId, actor) { return lock(() => confirmLead(api, config, leadId, actor)); },
    brochure(id) { return brochureFor(api, id); },
    publicFile(id, exp, sig) { return openPublicFile(api, config, id, exp, sig); },
    addSlot(propertyId, body, actor) { return lock(() => addSlot(api, config, propertyId, body, actor)); },
    book(leadId, slotId, actor) { return lock(() => bookViewing(api, config, leadId, slotId, actor)); },
    setViewing(id, status, actor) { return lock(() => setViewing(api, config, id, status, actor)); },
    settings(body, actor) { return lock(() => updateSettings(api, config, body, actor)); },
    settleHot(leadId) { return lock(() => {
      const settled = settleHotTime(api, config, leadId);
      if (isPromise(settled)) return settled.then(() => ({ ok: true }));
      return { ok: true };
    }); },
    getSettings() { return publicSettings(store); },
    templates() { return { ok: true, templates: desk.getTemplates(store, setting) }; },
    saveTemplates(list, actor) {
      return lock(() => {
        const templates = desk.saveTemplates(store, setting, list);
        audit(store, config, 'templates_save', null, { count: templates.length }, actor || 'broker');
        return { ok: true, templates };
      });
    },
    metrics(brokerId) { return desk.computeMetrics(store, brokerId); },
    contacts(brokerId) { return { ok: true, contacts: desk.listContacts(store, brokerId) }; },
    connect(brokerId) { return desk.connectStatus(store, whatsapp.effectiveConfig(config, store, brokerId), { webhook: api.webhookState, brokerId }); },
    followups(brokerId) { return { ok: true, followups: desk.listFollowups(store, brokerId) }; },
    addFollowup(body, actor) {
      return lock(() => {
        const lead = loadLead(store, body.lead_id);
        if (!lead) return fail(404, 'not_found');
        const dueAt = body.due_at || new Date(api.now().getTime() + (Number(body.in_hours) || 24) * 3600000).toISOString();
        const row = desk.addFollowup(store, {
          id: `F-${crypto.randomBytes(3).toString('hex')}`,
          leadId: lead.id,
          brokerId: actor || lead.broker_id,
          dueAt,
          kind: body.kind || 'follow',
          note: String(body.note || '').slice(0, 200),
          createdAt: api.now().toISOString(),
        });
        audit(store, config, 'followup_add', lead.id, { due_at: dueAt }, actor || 'broker');
        return { ok: true, followup: row };
      });
    },
    closeFollowup(id, actor) {
      return lock(() => {
        const row = desk.closeFollowup(store, id, 'done');
        if (!row) return fail(404, 'not_found');
        audit(store, config, 'followup_done', row.lead_id, { id }, actor || 'broker');
        return { ok: true, followup: row };
      });
    },
    seed(messages, mode) { return lock(() => seedMessages(api, config, messages, mode)); },
    sweep() { return sweepSending(api, config); },
    compete() { return lock(() => settleOpenHot(api, config)); },
    retain() { return sweepRetention(api); },
    erase(leadId, actor) { return lock(() => eraseSender(api, config, leadId, actor)); },
    setPipeline(leadId, pipeline, actor) { return lock(() => setPipeline(api, config, leadId, pipeline, actor)); },
    telegram(update) { return lock(() => applyTelegram(api, config, update)); },
    whatsappVerify(query) { return whatsapp.verifyChallenge(config, query); },
    whatsappWebhook(rawBody, headers, queryToken) { return lock(() => applyWhatsApp(api, config, rawBody, headers, queryToken)); },
    whatsappPoll() { return lock(() => pollWhatsApp(api, config)); },
    whatsappStatus(brokerId) { return whatsappGatewayStatus(api, config, brokerId); },
    whatsappConnect(body, actor) { return lock(() => whatsappConnectGateway(api, config, body, actor)); },
    whatsappDisconnect(actor) { return lock(() => whatsappDisconnectGateway(api, config, actor)); },
    team(userId) { return team.teamSnapshot(store, userId); },
    inviteColleague(body, actor) {
      return lock(() => {
        const result = team.inviteMember(store, config, actor, body, api.now().toISOString());
        if (result.ok) {
          audit(store, config, 'team_invite', null, {
            member: result.telegram_id,
            role: result.role,
          }, actor || 'broker');
        }
        return result;
      });
    },
    acceptColleague(body, actor) {
      return lock(() => {
        const result = team.acceptInvite(store, config, actor, body, api.now().toISOString());
        if (result.ok && !result.already) {
          audit(store, config, 'team_accept', null, {
            owner: result.membership && result.membership.owner_broker_id,
          }, actor || 'broker');
        }
        return result;
      });
    },
    revokeColleague(body, actor) {
      return lock(() => {
        const result = team.revokeMember(store, actor, body);
        if (result.ok) {
          audit(store, config, 'team_revoke', null, { member: result.telegram_id }, actor || 'broker');
        }
        return result;
      });
    },
    resolveWorkspace(userId, workspaceId) {
      return team.resolveWorkspace(store, userId, workspaceId);
    },
    accessLead(leadBrokerId, userId, options) {
      return team.accessToLead(store, leadBrokerId, userId, options);
    },
    accessibleBrokerIds(userId) {
      return team.accessibleBrokerIds(store, userId);
    },
    idem(key) { return store.one('SELECT * FROM i_idem WHERE key = ?', [key]); },
    audit(leadId) {
      const rows = leadId
        ? store.all('SELECT * FROM i_audit WHERE lead_id = ? ORDER BY id', [leadId])
        : store.all('SELECT * FROM i_audit ORDER BY id');
      return rows.map((row) => ({ ...row, meta: JSON.parse(row.meta || '{}') }));
    },
  };
  desk.ensureFollowupSchema(store);
  sweepSending(api, config);
  sweepRetention(api);
  return api;
}

function readSettings(store) {
  const rows = store.all('SELECT key, value FROM i_settings');
  const out = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

function setting(store, key, value) {
  if (value === undefined) return store.one('SELECT value FROM i_settings WHERE key = ?', [key])?.value || '';
  store.run(
    'INSERT INTO i_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, String(value)],
  );
  return String(value);
}

function audit(store, config, action, leadId, meta, actor) {
  store.run(
    'INSERT INTO i_audit (ts, actor, action, lead_id, meta) VALUES (?, ?, ?, ?, ?)',
    [new Date().toISOString(), actor || 'system', action, leadId || null, JSON.stringify(meta || {})],
  );
}

function catalog(store) {
  return store.all(`SELECT * FROM i_property WHERE active = 1 AND id != 'general'`).map((row) => ({
    ...row,
    facts: JSON.parse(row.facts || '{}'),
  }));
}

function propertyRow(store, id) {
  const row = store.one('SELECT * FROM i_property WHERE id = ?', [id]);
  if (!row) return null;
  return { ...row, facts: JSON.parse(row.facts || '{}') };
}

function ensureGeneral(store, now) {
  if (propertyRow(store, 'general')) return;
  store.run(
    `INSERT INTO i_property (id, title, kind, price, currency, price_period, tz, tz_label_en, tz_label_ru, ref_en, ref_ru, price_en, price_ru, facts, active, created_at)
     VALUES ('general', 'General', 'sale', 0, 'USD', 'total', 'Asia/Dubai', 'Dubai time', 'время Дубая', 'this request', 'этому запросу', '', '', '{}', 1, ?)`,
    [now.toISOString()],
  );
}

function ingest(api, config, input) {
  const now = api.now();
  const channel = input.channel;
  const senderId = String(input.sender_id || '');
  if (channel === 'telegram' && !input.fixture && !input.business && !allowedTestId(config, senderId)) {
    const n = Number(setting(api.store, 'dropped_non_test') || 0) + 1;
    setting(api.store, 'dropped_non_test', n);
    return { ok: true, stored: false, dropped: true };
  }
  const hash = senderHash(config.HASH_SALT, channel, senderId);
  const dedup = input.dedup_key;
  if (dedup && api.store.one('SELECT id FROM i_message WHERE dedup_key = ?', [dedup])) {
    return { ok: true, duplicate: true };
  }
  const opted = api.store.one('SELECT 1 AS n FROM i_optout WHERE channel = ? AND sender_hash = ?', [channel, hash]);
  const since = new Date(now.getTime() - 14 * 86400000).toISOString();
  let existing = null;
  if (input.append_open) {
    const params = [channel, hash, since];
    let sql = `SELECT * FROM i_lead WHERE channel = ? AND sender_hash = ? AND status NOT IN ('archived', 'stopped') AND COALESCE(last_client_at, last_msg_at, '') >= ?`;
    if (input.broker_id) {
      sql += ' AND broker_id = ?';
      params.push(String(input.broker_id));
    }
    sql += ' ORDER BY last_msg_at DESC LIMIT 1';
    existing = api.store.one(sql, params);
  }
  let propertyId = existing ? existing.property_id : (input.property_id || '');
  let titleMatched = false;
  if (!existing && !propertyId && input.kind !== 'non_text') {
    const matched = matchProperty(input.text || '', catalog(api.store));
    if (matched) {
      propertyId = matched.id;
      titleMatched = true;
    }
  }
  if (!propertyId) propertyId = 'general';
  if (propertyId === 'general') ensureGeneral(api.store, now);
  const property = propertyRow(api.store, propertyId);
  let analysis = analyze(
    { kind: input.kind || 'text', text: input.text || '', non_text_type: input.non_text_type },
    { propertyKind: property?.kind, propertyCurrency: property?.currency, senderName: input.sender_name },
  );
  let readiness = classifyReadiness(input.kind === 'non_text' ? '' : (input.text || ''), analysis);
  if (input.kind !== 'non_text' && analysis.language === 'other' && analysis.intent !== 'stop' && readiness.label !== 'COLD') {
    analysis = {
      ...analysis,
      intent: readiness.hits.includes('viewing') ? 'viewing' : analysis.intent,
      flags: (analysis.flags || []).filter((flag) => flag !== 'lang_other' && flag !== 'review'),
    };
  }
  const scored = scoreChat(analysis, property, config.AED_PER_USD);
  const proposed = input.kind === 'non_text'
    ? null
    : parseProposal(input.text || '', property?.tz || config.BROKER_TZ || 'Asia/Dubai', now);
  const flags = [...analysis.flags];
  if (scored.budget_low && !flags.includes('budget_low')) flags.push('budget_low');
  if (input.kind !== 'non_text' && analysis.language === 'other' && readiness.label === 'COLD' && analysis.intent !== 'stop' && !flags.includes('non_text')) {
    flags.push('lang_unsupported');
  }
  if (!existing) {
    existing = api.store.one(
      'SELECT * FROM i_lead WHERE channel = ? AND sender_hash = ? AND property_id = ?',
      [channel, hash, propertyId],
    );
  }
  const carried = carry(existing, analysis);
  const bound = propertyId !== 'general' && !flags.includes('link');
  const status = replyStatus(analysis, flags, opted, titleMatched || bound);
  const leadId = existing?.id || input.lead_id || `L-${crypto.randomBytes(4).toString('hex')}`;
  const msgId = `M-${crypto.randomBytes(4).toString('hex')}`;
  const when = input.received_at || now.toISOString();
  if (!existing) {
    api.store.run(
      `INSERT INTO i_lead (id, channel, sender_hash, sender_name, reply_target, property_id, language, intent, also_json, asks_discount,
        budget_amount, budget_currency, budget_period, timing_class, timing_label, cash, flags, non_text_type, score, grade, reasons,
        analysis_source, status, pipeline, optout, first_msg_at, last_msg_at, last_inbound_message_id, retention_until, business_connection_id, clean_name, readiness, proposed_utc, broker_id, last_client_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        leadId, channel, hash, input.sender_name || '', input.reply_target || null, propertyId,
        carried.language, carried.intent, JSON.stringify(carried.also), carried.asks_discount ? 1 : 0,
        moneyAmount(carried.budget?.amount), carried.budget?.currency || null, carried.budget?.period || null,
        carried.timing?.class || null, carried.timing?.label_en || null, carried.cash ? 1 : 0,
        JSON.stringify(flags), input.non_text_type || null, scored.score, scored.grade, JSON.stringify(scored.reasons),
        analysis.source, status, status === 'stopped' ? 1 : 0, when, when, msgId,
        retentionUntil(when, config),
        input.business_connection_id || null, analysis.name.name, readiness.label, proposed?.start_utc || null,
        input.broker_id ? String(input.broker_id) : null, when,
      ],
    );
  } else if (input.skip_reanalyze || isShortAck(input.text)) {
    api.store.run(
      'UPDATE i_lead SET last_msg_at = ?, last_client_at = ?, retention_until = ? WHERE id = ?',
      [when, when, retentionUntil(when, config), leadId],
    );
  } else {
    api.store.run(
      `UPDATE i_lead SET sender_name=?, language=?, intent=?, also_json=?, asks_discount=?, budget_amount=?, budget_currency=?, budget_period=?,
        timing_class=?, timing_label=?, cash=?, flags=?, non_text_type=?, analysis_source=?, status=?, optout=?,
        last_msg_at=?, last_client_at=?, last_inbound_message_id=?, retention_until=?, clean_name=?, business_connection_id=COALESCE(?, business_connection_id),
        broker_id=COALESCE(?, broker_id), proposed_utc=? WHERE id=?`,
      [
        input.sender_name || existing.sender_name, carried.language, carried.intent, JSON.stringify(carried.also),
        carried.asks_discount ? 1 : 0, moneyAmount(carried.budget?.amount), carried.budget?.currency || null, carried.budget?.period || null,
        carried.timing?.class || null, carried.timing?.label_en || null, carried.cash ? 1 : 0, JSON.stringify(flags),
        input.non_text_type || null, analysis.source,
        status, status === 'stopped' ? 1 : 0, when, when, msgId, retentionUntil(when, config), analysis.name.name, input.business_connection_id || null,
        input.broker_id ? String(input.broker_id) : null, proposed?.start_utc || null, leadId,
      ],
    );
    api.store.run('DELETE FROM i_draft WHERE lead_id = ?', [leadId]);
  }
  api.store.run(
    `INSERT INTO i_message (id, lead_id, direction, text, kind, channel_msg_id, dedup_key, created_at) VALUES (?, ?, 'in', ?, ?, ?, ?, ?)`,
    [msgId, leadId, input.text || '', input.kind || 'text', input.channel_msg_id || null, dedup || null, when],
  );
  if (analysis.intent === 'stop') {
    api.store.run(
      'INSERT INTO i_optout (channel, sender_hash, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      [channel, hash, now.toISOString()],
    );
    api.store.run('UPDATE i_lead SET status = ?, optout = 1 WHERE channel = ? AND sender_hash = ?', ['stopped', channel, hash]);
    audit(api.store, config, 'stop', leadId, { channel }, 'system');
  }
  if (analysis.intent !== 'stop') maybeConfirmFromReply(api, config, leadId, input.text || '');
  const stored = { ok: true, lead_id: leadId, message_id: msgId, status, duplicate: false, stored: true };
  queueBrokerNotify(api, config, {
    leadId,
    grade: scored.grade,
    status,
    propertyId,
    isNew: !existing,
  });
  if (!input.skip_reanalyze && !isShortAck(input.text) && status !== 'stopped') {
    const settled = settleHotTime(api, config, leadId);
    if (isPromise(settled)) {
      return settled.then(() => stored);
    }
  }
  return stored;
}

function queueBrokerNotify(api, config, { leadId, grade, status, propertyId, isNew }) {
  if (config.CHANNEL_MODE !== 'live') return;
  // Only the first message of a lead notifies the broker; follow-ups are visible in the Mini App.
  if (!isNew) return;
  if (status !== 'pending_approval' && status !== 'review') return;
  const app = miniAppUrl(config);
  if (!app) return;
  const lang = setting(api.store, 'lang') || 'ru';
  const text = notifyNewLeadText({ leadId, grade, status, propertyId, lang });
  const body = `${text}\n${app}`;
  deliverBrokerNotify(config, body, api.fetch)
    .then((result) => {
      if (result && result.telegram_delivery) {
        audit(api.store, config, 'notify_new_lead', leadId, { grade, status }, 'system');
      } else {
        const code = (result && result.error_code) || 'telegram_rejected';
        audit(api.store, config, 'notify_failed', leadId, { grade, status, error_code: code }, 'system');
        console.error('intl_notify_failed ' + code);
      }
    })
    .catch((err) => {
      console.error('intl_notify_failed ' + (err && err.message ? err.message : 'error'));
    });
}

async function remindBrokers(api, config) {
  if (config.CHANNEL_MODE !== 'live') return { ok: true, reminded: 0, simulated: true };
  // The broker asked for exactly one chat notification per lead: the first message with the grade.
  // Waiting reminders and follow-up pings stay inside the Mini App (audit + lists), not in Telegram,
  // so the chat is no longer spammed every INTL_REMIND_MINUTES.
  return { ok: true, reminded: 0, silent: true, simulated: false };
}

function deliverBrokerNotify(config, text, fetchImpl) {
  return retry.withRetry(async () => {
    const result = await notifyBrokers(config, text, fetchImpl);
    if (result && result.telegram_delivery) return result;
    const code = (result && result.error_code) || 'telegram_rejected';
    const retryable = code === 'telegram_rejected' || code === 'rate_limited' || (result && result.status === 429);
    if (!retryable) return result;
    throw Object.assign(new Error(code), { status: result && result.status === 429 ? 429 : 503 });
  }, { attempts: 2, baseMs: 300, jitter: 0.2 });
}

function isShortAck(text) {
  const compact = String(text || '').trim().toLowerCase().replace(/[!.,?،]+/gu, '').replace(/\s+/g, ' ').trim();
  return /^(ok|okay|ок|окей|да|yes|yeah|yep|👍|نعم|tamam|ok 👍)$/u.test(compact);
}

// Retention is measured from the last contact, not from the first message: an
// active conversation must not be wiped on day 30 just because it started then.
function retentionUntil(when, config) {
  const base = Date.parse(when);
  const days = Number(config && config.RETENTION_DAYS);
  if (!Number.isFinite(base)) return null;
  const span = (Number.isFinite(days) && days > 0 ? Math.trunc(days) : 30) * 86400000;
  return new Date(base + span).toISOString();
}

function replyStatus(analysis, flags, opted, titleMatched = false) {
  if (opted || analysis.intent === 'stop') return 'stopped';
  if (flags.includes('lang_unsupported')) return 'review';
  const otherScript = analysis.language === 'other' || flags.includes('lang_other');
  const blocked = flags.includes('non_text') || flags.includes('injection_suspect') || flags.includes('optout');
  if (otherScript && !blocked) return 'pending_approval';
  if (blocked) return 'review';
  if (titleMatched) return 'pending_approval';
  if (analysis.intent === 'unclear' || flags.includes('review')) return 'review';
  return 'pending_approval';
}

const HOT_BROKER = 'broker';
const COMPETE_MS = 45 * 1000;

function autoSendHot(store) {
  const value = setting(store, 'auto_send_hot');
  return value === '1' || value === 'true';
}

function sameInstant(a, b) {
  if (!a || !b) return false;
  return Date.parse(a) === Date.parse(b);
}

function claimHold(api, start, lead) {
  const row = api.store.one(
    `SELECT lead_id FROM i_time_hold WHERE broker_key = ? AND start_utc = ?`,
    [HOT_BROKER, start],
  );
  if (!row) {
    api.store.run(
      `INSERT INTO i_time_hold (broker_key, start_utc, lead_id, score, first_msg_at) VALUES (?, ?, ?, ?, ?)`,
      [HOT_BROKER, start, lead.id, lead.score || 0, lead.first_msg_at],
    );
    return true;
  }
  if (row.lead_id === lead.id) {
    api.store.run(
      `UPDATE i_time_hold SET score = ?, first_msg_at = ? WHERE broker_key = ? AND start_utc = ?`,
      [lead.score || 0, lead.first_msg_at, HOT_BROKER, start],
    );
    return true;
  }
  const holder = loadLead(api.store, row.lead_id);
  if (holder && (holder.status === 'sent' || holder.status === 'stopped' || holder.status === 'archived')) return false;
  api.store.run(
    `UPDATE i_time_hold SET lead_id = ?, score = ?, first_msg_at = ? WHERE broker_key = ? AND start_utc = ?`,
    [lead.id, lead.score || 0, lead.first_msg_at, HOT_BROKER, start],
  );
  return true;
}

function heldStarts(api) {
  return api.store.all(`SELECT start_utc FROM i_time_hold WHERE broker_key = ?`, [HOT_BROKER]).map((row) => row.start_utc);
}

function nextOpenSlot(api, lead, avoid) {
  const property = propertyRow(api.store, lead.property_id);
  const offered = offerFor(api, property, '');
  const pick = (slots) => {
    const blocked = new Set([...(avoid || []), ...heldStarts(api)].map((value) => Date.parse(value)));
    return (slots || []).find((slot) => !blocked.has(Date.parse(slot.start_utc))) || null;
  };
  if (isPromise(offered)) return offered.then((value) => pick(value.slots));
  return pick(offered.slots);
}

function writeHotDraft(api, config, lead, proposed) {
  const property = propertyRow(api.store, lead.property_id);
  const offered = offerFor(api, property, '');
  if (isPromise(offered)) return offered.then((value) => writeHotDraftFrom(api, config, lead, proposed, value.slots));
  return writeHotDraftFrom(api, config, lead, proposed, offered.slots);
}

function writeHotDraftFrom(api, config, lead, proposed, slotsIn) {
  const property = propertyRow(api.store, lead.property_id);
  let slots = slotsIn || [];
  if (proposed && proposed.free && proposed.start_utc && !slots.some((slot) => sameInstant(slot.start_utc, proposed.start_utc))) {
    slots = [{
      id: proposed.id || `client-${String(proposed.start_utc).replace(/[^0-9]/g, '').slice(0, 14)}`,
      start_utc: proposed.start_utc,
      duration_min: 45,
      source: 'client',
    }, ...slots];
  }
  const options = buildOptions({
    analysis: {
      intent: lead.intent,
      also: lead.also,
      language: lead.language,
      asks_discount: lead.asks_discount,
      budget: lead.budget,
      timing: lead.timing,
      cash: lead.cash,
      flags: lead.flags,
    },
    clean_name: lead.clean_name,
    proposed,
    title_match: false,
    force_ask: proposed && proposed.force_ask === true,
  }, property, slots);
  const pick = (proposed && proposed.free)
    ? (options.find((row) => row.id === 'confirm') || options[0])
    : (options.find((row) => row.id === 'ask') || options.find((row) => row.id === 'other') || options[0]);
  if (!pick || !pick.text) return null;
  return saveDraft(api, config, lead.id, {
    text: pick.text,
    option_id: pick.id,
    slot_ids: pick.slot_ids || [],
    edited: false,
    attachments: [],
  });
}

function settleHotTime(api, config, leadId) {
  if (!autoSendHot(api.store)) return;
  const lead = loadLead(api.store, leadId);
  if (!lead || lead.readiness !== 'HOT' || !lead.proposed_utc) return;
  return settleGroup(api, config, lead.proposed_utc);
}

function settleOpenHot(api, config) {
  if (!autoSendHot(api.store)) return;
  const starts = new Set();
  for (const row of api.store.all(
    `SELECT proposed_utc FROM i_lead WHERE readiness = 'HOT' AND proposed_utc IS NOT NULL AND status IN ('pending_approval', 'review')`,
  )) {
    if (row.proposed_utc) starts.add(row.proposed_utc);
  }
  for (const row of api.store.all(
    `SELECT start_utc FROM i_time_hold WHERE broker_key = ? AND competition_due_at IS NOT NULL`,
    [HOT_BROKER],
  )) {
    starts.add(row.start_utc);
  }
  let pending = null;
  for (const start of starts) {
    const result = settleGroup(api, config, start);
    if (isPromise(result)) pending = pending ? pending.then(() => result) : result;
  }
  return pending;
}

function cancelCompetitions(api) {
  const rows = api.store.all(
    `SELECT broker_key, start_utc, lead_id FROM i_time_hold WHERE broker_key = ? AND competition_due_at IS NOT NULL`,
    [HOT_BROKER],
  );
  for (const row of rows) {
    const lead = loadLead(api.store, row.lead_id);
    if (lead && lead.status === 'sent') {
      api.store.run(
        `UPDATE i_time_hold SET competition_due_at = NULL WHERE broker_key = ? AND start_utc = ?`,
        [row.broker_key, row.start_utc],
      );
    } else {
      api.store.run(`DELETE FROM i_time_hold WHERE broker_key = ? AND start_utc = ?`, [row.broker_key, row.start_utc]);
    }
  }
}

function hotPeers(api, start) {
  return api.store.all(
    `SELECT id FROM i_lead WHERE readiness = 'HOT' AND proposed_utc = ? AND status NOT IN ('stopped', 'archived')`,
    [start],
  ).map((row) => loadLead(api.store, row.id)).filter(Boolean);
}

function holdRow(api, start) {
  return api.store.one(
    `SELECT * FROM i_time_hold WHERE broker_key = ? AND start_utc = ?`,
    [HOT_BROKER, start],
  );
}

function rememberLeader(api, start, leader, due) {
  const row = holdRow(api, start);
  if (!row) {
    api.store.run(
      `INSERT INTO i_time_hold (broker_key, start_utc, lead_id, score, first_msg_at, competition_due_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [HOT_BROKER, start, leader.id, leader.score || 0, leader.first_msg_at, due],
    );
    return;
  }
  api.store.run(
    `UPDATE i_time_hold SET lead_id = ?, score = ?, first_msg_at = ?, competition_due_at = ? WHERE broker_key = ? AND start_utc = ?`,
    [leader.id, leader.score || 0, leader.first_msg_at, row.competition_due_at || due, HOT_BROKER, start],
  );
}

function clearDue(api, start) {
  api.store.run(
    `UPDATE i_time_hold SET competition_due_at = NULL WHERE broker_key = ? AND start_utc = ?`,
    [HOT_BROKER, start],
  );
}

function settleGroup(api, config, start) {
  const peers = hotPeers(api, start);
  const hold = holdRow(api, start);
  const holder = hold ? loadLead(api.store, hold.lead_id) : null;
  const pending = peers
    .filter((row) => row.status === 'pending_approval' || row.status === 'review')
    .sort((a, b) => (b.score || 0) - (a.score || 0) || String(a.first_msg_at).localeCompare(String(b.first_msg_at)));
  if (holder && holder.status === 'sent') return dispatchHot(api, config, null, pending, start);
  if (!pending.length) return;
  if (pending.length === 1) {
    clearDue(api, start);
    return dispatchHot(api, config, pending[0], [], start);
  }
  const due = hold?.competition_due_at || new Date(api.now().getTime() + COMPETE_MS).toISOString();
  rememberLeader(api, start, pending[0], due);
  if (api.now().getTime() < Date.parse(due)) return;
  clearDue(api, start);
  return dispatchHot(api, config, pending[0], pending.slice(1), start);
}

function dispatchHot(api, config, winner, losers, start) {
  if (winner && winner.status !== 'sent' && !claimHold(api, start, winner)) {
    return dispatchHot(api, config, null, [winner, ...losers], start);
  }
  if (api.calendar && api.calendar.async) return dispatchHotAsync(api, config, winner, losers, start);
  return dispatchHotSync(api, config, winner, losers, start);
}

function sendHot(api, config, leadId, version, start) {
  return sendLead(api, config, leadId, {
    idempotency_key: `hot-${leadId}-${start}`,
    draft_version: version,
  }, 'system');
}

function loserDraft(api, config, loser, alt) {
  if (alt) return writeHotDraft(api, config, loser, { start_utc: alt.start_utc, free: true, id: alt.id });
  return writeHotDraft(api, config, loser, { start_utc: loser.proposed_utc, free: false, force_ask: true });
}

function dispatchHotSync(api, config, winner, losers, start) {
  const avoid = [start];
  if (winner && winner.status !== 'sent') {
    const draft = writeHotDraft(api, config, winner, { start_utc: start, free: true });
    if (draft && draft.ok) sendHot(api, config, winner.id, draft.version, start);
  }
  for (const loser of losers) {
    const alt = nextOpenSlot(api, loser, avoid);
    let assigned = start;
    let draft = null;
    if (alt && claimHold(api, alt.start_utc, loser)) {
      avoid.push(alt.start_utc);
      assigned = alt.start_utc;
      draft = loserDraft(api, config, loser, alt);
    } else {
      draft = loserDraft(api, config, loser, null);
    }
    if (draft && draft.ok && (loser.status === 'pending_approval' || loser.status === 'review')) {
      sendHot(api, config, loser.id, draft.version, assigned);
    }
  }
}

async function dispatchHotAsync(api, config, winner, losers, start) {
  if (api.calendar && api.calendar.error) return;
  const avoid = [start];
  if (winner && winner.status !== 'sent') {
    const draft = await writeHotDraft(api, config, winner, { start_utc: start, free: true });
    if (api.calendar && api.calendar.error) return;
    if (draft && draft.ok) await sendHot(api, config, winner.id, draft.version, start);
  }
  for (const loser of losers) {
    const alt = await nextOpenSlot(api, loser, avoid);
    let assigned = start;
    let draft = null;
    if (alt && claimHold(api, alt.start_utc, loser)) {
      avoid.push(alt.start_utc);
      assigned = alt.start_utc;
      draft = await loserDraft(api, config, loser, alt);
    } else {
      draft = await loserDraft(api, config, loser, null);
    }
    if (draft && draft.ok && (loser.status === 'pending_approval' || loser.status === 'review')) {
      await sendHot(api, config, loser.id, draft.version, assigned);
    }
  }
}

function carry(existing, analysis) {
  if (!existing || analysis.intent === 'stop') return analysis;
  const next = { ...analysis, also: analysis.also || [] };
  if (!next.budget && existing.budget_amount != null) {
    next.budget = { amount: existing.budget_amount, currency: existing.budget_currency, period: existing.budget_period };
  }
  if (!next.timing && existing.timing_class) {
    next.timing = { class: existing.timing_class, label_en: existing.timing_label, label_ru: existing.timing_label };
  }
  if (!next.cash && existing.cash) next.cash = true;
  return next;
}

function loadLead(store, id) {
  const row = store.one('SELECT * FROM i_lead WHERE id = ?', [id]);
  if (!row) return null;
  return {
    ...row,
    also: JSON.parse(row.also_json || '[]'),
    flags: JSON.parse(row.flags || '[]'),
    reasons: JSON.parse(row.reasons || '[]'),
    asks_discount: row.asks_discount === 1,
    cash: row.cash === 1,
    optout: row.optout === 1,
    client_confirmed: row.client_confirmed === 1,
    budget: row.budget_amount == null ? null : { amount: row.budget_amount, currency: row.budget_currency, period: row.budget_period },
    timing: row.timing_class ? { class: row.timing_class, label_en: row.timing_label, label_ru: row.timing_label } : null,
  };
}

function propertyMatch(api, text, propertyId) {
  const matched = matchProperty(text, catalog(api.store));
  if (!matched || matched.id !== propertyId) return null;
  return { id: matched.id, score: matched.score, reasons: matched.reasons };
}

function latestInbound(store, leadId) {
  return store.one(
    `SELECT text FROM i_message WHERE lead_id = ? AND direction = 'in' AND deleted = 0 ORDER BY created_at DESC LIMIT 1`,
    [leadId],
  );
}

function isPromise(value) {
  return Boolean(value && typeof value.then === 'function');
}

function finishOffer(api, property, parsed, slots, free, error) {
  const zone = property?.tz || api.calendar?.zone || 'Asia/Dubai';
  let list = Array.isArray(slots) ? slots.slice() : [];
  if (error || (api.calendar && api.calendar.error)) {
    return { slots: [], proposed: null, error: error || api.calendar.error };
  }
  if (!list.length && property && !(api.calendar && api.calendar.mode === 'google')) {
    list = listFreeSlots(api.store, property, api.now());
  }
  let proposed = null;
  if (parsed) {
    const existing = list.find((slot) => Date.parse(slot.start_utc) === Date.parse(parsed.start_utc));
    const id = existing?.id || `client-${String(parsed.start_utc).replace(/[^0-9]/g, '').slice(0, 14)}`;
    proposed = { start_utc: parsed.start_utc, free: free !== false, id, zone: parsed.zone || zone };
    if (proposed.free && !existing) {
      list = [{ id, start_utc: parsed.start_utc, duration_min: 45, source: 'client' }, ...list];
    }
    if (!proposed.free) list = list.filter((slot) => Date.parse(slot.start_utc) !== Date.parse(parsed.start_utc));
  }
  return { slots: list, proposed: publicProposal(proposed, property), error: null };
}

function offerFor(api, property, text) {
  const zone = property?.tz || api.calendar?.zone || 'Asia/Dubai';
  const parsed = parseProposal(text || '', zone, api.now());
  const calendar = api.calendar;
  if (calendar && calendar.error) return finishOffer(api, property, parsed, [], false, calendar.error);
  const slotArgs = { now: api.now(), count: 8, zone: calendar?.zone || zone, durationMin: 45 };
  const slotsResult = calendar && typeof calendar.freeSlots === 'function' ? calendar.freeSlots(slotArgs) : [];
  const freeResult = parsed && calendar && typeof calendar.isFree === 'function'
    ? calendar.isFree(parsed.start_utc, 45)
    : true;
  if (isPromise(slotsResult) || isPromise(freeResult)) {
    return Promise.all([
      Promise.resolve(freeResult).catch(() => false),
      Promise.resolve(slotsResult).catch(() => []),
    ]).then(([free, slots]) => finishOffer(api, property, parsed, calendar && calendar.error ? [] : slots, free, calendar && calendar.error));
  }
  return finishOffer(api, property, parsed, slotsResult, freeResult, null);
}

function publicProposal(proposed, property) {
  if (!proposed) return null;
  const host = property || { tz: proposed.zone || 'Asia/Dubai' };
  return {
    start_utc: proposed.start_utc,
    free: proposed.free === true,
    id: proposed.id,
    label_en: slotPhrase({ start_utc: proposed.start_utc }, host, 'en').when,
    label_ru: slotPhrase({ start_utc: proposed.start_utc }, host, 'ru').when,
  };
}

function labelSlots(slots, property) {
  const host = property || { tz: 'Asia/Dubai' };
  return (slots || []).map((slot) => {
    const en = slotPhrase(slot, host, 'en');
    const ru = slotPhrase(slot, host, 'ru');
    return {
      ...slot,
      label_en: slot.label_en || en.when,
      label_ru: slot.label_ru || ru.when,
      proposal_en: slot.proposal_en || `${en.when}. ${en.note}`,
      proposal_ru: slot.proposal_ru || `${ru.when}. ${ru.note}`,
    };
  });
}

function viewingStatus(store, leadId) {
  const row = store.one(
    `SELECT status FROM i_viewing WHERE lead_id = ? AND status != 'cancelled' ORDER BY created_at DESC LIMIT 1`,
    [leadId],
  );
  return row ? row.status : null;
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function exportCsv(api, kind, brokerId) {
  const rows = [];
  if (kind === 'leads') {
    rows.push(['id', 'name', 'channel', 'status', 'grade', 'language', 'property', 'price', 'currency', 'first_msg_at', 'last_msg_at']);
    for (const row of api.store.all('SELECT * FROM i_lead WHERE COALESCE(broker_id, ?) = ? ORDER BY COALESCE(last_msg_at, first_msg_at) DESC', [brokerId, brokerId])) {
      const property = row.property_id ? propertyRow(api.store, row.property_id) : null;
      rows.push([row.id, row.clean_name || row.sender_name || '', row.channel, row.status, row.readiness || row.grade || '',
        row.language || '', property ? property.title : '', property ? property.price : '', property ? property.currency : '',
        row.first_msg_at || '', row.last_msg_at || '']);
    }
  } else {
    rows.push(['id', 'lead_id', 'client', 'property', 'address', 'meeting_point', 'access_notes', 'start_utc', 'status', 'channel']);
    for (const row of api.store.all('SELECT * FROM i_viewing ORDER BY start_utc')) {
      const lead = row.lead_id ? loadLead(api.store, row.lead_id) : null;
      const property = lead && lead.property_id ? propertyRow(api.store, lead.property_id) : null;
      const slot = api.store.one('SELECT * FROM i_slot WHERE id = ?', [row.slot_id]);
      rows.push([row.id, row.lead_id, lead ? (lead.clean_name || lead.sender_name || '') : '', property ? property.title : '',
        property ? property.address : '', property ? property.meeting_point : '', property ? property.access_notes : '',
        slot ? slot.start_utc : '', row.status, lead ? lead.channel : '']);
    }
  }
  return { filename: `intl-${kind}.csv`, csv: rows.map((cells) => cells.map(csvCell).join(',')).join('\n') };
}

function presentLead(api, config, id, brokerId) {
  const lead = loadLead(api.store, id);
  if (!lead) return null;
  if (brokerId) {
    const access = team.accessToLead(api.store, lead.broker_id, brokerId, { write: false });
    if (!access.ok) return null;
  }
  const property = propertyRow(api.store, lead.property_id);
  const analysis = {
    intent: lead.intent,
    also: lead.also,
    language: lead.language,
    asks_discount: lead.asks_discount,
    budget: lead.budget,
    timing: lead.timing,
    cash: lead.cash,
    flags: lead.flags,
  };
  const inbound = latestInbound(api.store, id);
  const matched = propertyMatch(api, inbound?.text || '', lead.property_id);
  const offered = offerFor(api, property, inbound?.text || '');
  if (isPromise(offered)) return offered.then((value) => presentWithOffer(api, config, lead, property, analysis, inbound, matched, value));
  return presentWithOffer(api, config, lead, property, analysis, inbound, matched, offered);
}

function presentWithOffer(api, config, lead, property, analysis, inbound, matched, offered) {
  const id = lead.id;
  const slots = labelSlots(offered.slots, property);
  const options = lead.status === 'stopped' ? [] : buildOptions({
    analysis,
    clean_name: lead.clean_name,
    proposed: offered.proposed,
    title_match: Boolean(matched) || Boolean(property && property.id && property.id !== 'general'),
  }, clientProperty(api, config, property), slots);
  const draft = api.store.one('SELECT * FROM i_draft WHERE lead_id = ?', [id]);
  const messages = api.store.all('SELECT id, direction, text, kind, created_at, deleted FROM i_message WHERE lead_id = ? ORDER BY created_at', [id]);
  const sends = api.store.all('SELECT status, fail_reason, idempotency_key FROM i_send WHERE lead_id = ?', [id]);
  const unknown = sends.find((row) => row.status === 'unknown_delivery');
  return {
    ...lead,
    property,
    options: lead.status === 'review' || lead.status === 'stopped' ? [] : options,
    manual_allowed: lead.status === 'review',
    draft,
    messages: messages.map((row) => ({ ...row, text: row.deleted ? '' : row.text })),
    slots,
    proposed: offered.proposed,
    readiness: lead.readiness || classifyReadiness(inbound?.text || '', analysis).label,
    calendar_mode: api.calendar?.mode || 'mock',
    calendar_source: api.calendar?.source || 'mock-schedule',
    calendar_error: offered.error || null,
    match: matched,
    stale_sending: sends.some((row) => row.fail_reason === 'stale_sending'),
    unknown_delivery: Boolean(unknown),
    unknown_key: unknown ? unknown.idempotency_key : '',
    events: humanEvents(api, lead),
    bucket: leadBucket(lead),
    viewing_status: viewingStatus(api.store, id),
  };
}

function leadBucket(lead) {
  if (!lead || lead.status === 'archived') return 'archive';
  if (lead.status === 'sent' && lead.client_confirmed) return 'confirmed';
  // "handled" means the broker replied outside the app (phone, WhatsApp by hand): the lead moves
  // out of the active list into the processed folder, same as an in-app reply.
  if (lead.status === 'sent' || lead.status === 'handled') return 'awaiting';
  return 'active';
}

function listPresent(api, query = {}) {
  const wantArchive = query.archived === true;
  let leads = api.store.all('SELECT id FROM i_lead')
    .map((row) => loadLead(api.store, row.id))
    .filter((lead) => (lead.status === 'archived') === wantArchive);
  if (query.property_id) leads = leads.filter((lead) => lead.property_id === query.property_id);
  if (query.broker_id) {
    const brokerId = String(query.broker_id);
    leads = leads.filter((lead) => lead.broker_id && String(lead.broker_id) === brokerId);
  }
  const q = String(query.q || '').trim().toLowerCase();
  if (q) {
    leads = leads.filter((lead) => {
      const hay = [
        lead.id,
        lead.clean_name,
        lead.sender_name,
        lead.property_id,
        lead.intent,
        lead.grade,
      ].join(' ').toLowerCase();
      if (hay.includes(q)) return true;
      const inbound = api.store.one(
        `SELECT text FROM i_message WHERE lead_id = ? AND direction = 'in' AND deleted = 0 ORDER BY created_at DESC LIMIT 1`,
        [lead.id],
      );
      return String(inbound?.text || '').toLowerCase().includes(q);
    });
  }
  const rank = (lead) => (lead.status === 'stopped' ? 2 : lead.status === 'sent' ? 1 : 0);
  return leads.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (readinessRank(a) !== readinessRank(b)) return readinessRank(a) - readinessRank(b);
    if (b.score !== a.score) return b.score - a.score;
    return String(a.first_msg_at).localeCompare(String(b.first_msg_at));
  }).map((lead) => ({ ...lead, bucket: leadBucket(lead), viewing_status: viewingStatus(api.store, lead.id) }));
}

function humanEvents(api, lead) {
  const rows = api.store.all('SELECT action, ts FROM i_audit WHERE lead_id = ? ORDER BY id', [lead.id]);
  const labels = {
    stop: 'Opted out with STOP',
    send: channelLabel(lead.channel) + ' (simulated)',
    manual_send: 'Reply sent manually',
    reject: 'Not sent',
    archive: 'Archived',
    viewing_book: 'Viewing booked (unconfirmed)',
    send_failed: 'Send failed, tried again',
  };
  const events = [{ action: 'inbound', label: 'Lead wrote on ' + channelLabel(lead.channel) }];
  events.push({ action: 'grade', label: `Marked ${lead.grade} ${lead.score}` });
  for (const row of rows) {
    if (labels[row.action]) events.push({ action: row.action, label: labels[row.action], ts: row.ts });
    if (row.action === 'send_failed') events.push({ action: 'stale', label: 'Previous attempt state unknown, check the chat' });
  }
  if (lead.flags?.includes('non_text')) events.push({ action: 'non_text', label: 'Client sent a photo. Open the chat.' });
  return events;
}

function saveDraft(api, config, leadId, body) {
  const lead = loadLead(api.store, leadId);
  if (!lead) return { ok: false, status: 404, error_code: 'not_found' };
  if (lead.status === 'stopped') return { ok: false, status: 409, error_code: 'lead_stopped' };
  if (!['pending_approval', 'review'].includes(lead.status)) return { ok: false, status: 409, error_code: 'not_pending' };
  const current = api.store.one('SELECT version FROM i_draft WHERE lead_id = ?', [leadId]);
  if (body.base_version != null && current && Number(body.base_version) !== current.version) {
    return { ok: false, status: 409, error_code: 'draft_changed' };
  }
  const text = String(body.text || '');
  if (text.length > 1000) return { ok: false, status: 400, error_code: 'draft_too_long' };
  const version = (current?.version || 0) + 1;
  api.store.run(
    `INSERT INTO i_draft (lead_id, option_id, text, slot_ids, edited, version, updated_at, attachments)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(lead_id) DO UPDATE SET option_id=excluded.option_id, text=excluded.text, slot_ids=excluded.slot_ids, edited=excluded.edited, version=excluded.version, updated_at=excluded.updated_at, attachments=excluded.attachments`,
    [leadId, body.option_id ?? null, text, JSON.stringify(body.slot_ids || []), body.edited ? 1 : 0, version, api.now().toISOString(), JSON.stringify(cleanAttachments(body.attachments, api, config))],
  );
  audit(api.store, config, 'draft', leadId, { edited: body.edited === true }, 'broker');
  return { ok: true, version };
}

function finalText(lead, text, _manual, config, settings) {
  const ru = lead.language === 'ru';
  const notes = settings || {};
  const stop = ru ? (config.STOP_NOTE_RU || STOP_RU) : (config.STOP_NOTE_EN || STOP_EN);
  const ai = ru ? (config.AI_NOTE_RU || AI_RU) : (config.AI_NOTE_EN || AI_EN);
  let body = String(text || '').trim();
  // Both lines are optional per broker: luxury brokers hate newsletter-like footers, but STOP is
  // needed for compliance on cold outreach, so stop defaults to on and the AI mark to on as well.
  if (notes.note_ai !== '0' && !body.includes(ai)) body = `${body}\n${ai}`;
  if (notes.note_stop !== '0' && !body.includes(stop)) body = `${body}\n${stop}`;
  return body;
}

function sendLead(api, config, leadId, body, actor) {
  const key = body.idempotency_key;
  if (!key) return { ok: false, status: 400, error_code: 'idempotency_required' };
  const prior = api.store.one('SELECT response FROM i_idem WHERE key = ?', [key]);
  if (prior) {
    const saved = JSON.parse(prior.response);
    if (!(body.force === true && saved && saved.error_code === 'unknown_delivery')) return saved;
  }
  if (actor === 'system' && config.CHANNEL_MODE === 'live' && config.INTL_LIVE_AUTOSEND !== true) {
    return { ok: true, status: 200, simulated: true, skipped: true, live_autosend: false, sent: false };
  }
  sweepSending(api, config);
  const reservedEarly = replaySend(api, key, body);
  if (reservedEarly) return reservedEarly;
  const lead = loadLead(api.store, leadId);
  if (!lead) return fail(404, 'not_found');
  if (lead.optout || lead.status === 'stopped') return fail(409, 'lead_stopped');
  if (lead.status === 'archived') return fail(409, 'not_pending');
  const draft = api.store.one('SELECT * FROM i_draft WHERE lead_id = ?', [leadId]);
  if (!draft || !String(draft.text || '').trim()) return fail(400, 'empty_draft');
  if (body.draft_version != null && Number(body.draft_version) !== draft.version) return fail(409, 'draft_changed');
  const manual = body.manual === true || draft.option_id == null;
  if (lead.status === 'review' && !manual) return fail(400, 'manual_required');
  if (draft.option_id == null && body.manual !== true) return fail(400, 'manual_required');
  const text = finalText(lead, draft.text, manual, config, readSettings(api.store));
  if (text.length > 1200) return fail(400, 'draft_too_long');
  const draftHash = crypto.createHash('sha256').update(text).digest('hex');
  const replyTo = lead.last_inbound_message_id;
  const clash = api.store.one(
    `SELECT status FROM i_send WHERE lead_id = ? AND reply_to_message_id = ? AND draft_hash = ?`,
    [leadId, replyTo, draftHash],
  );
  if (clash && clash.status === 'unknown_delivery' && body.force !== true) return fail(409, 'unknown_delivery');
  if (clash && clash.status !== 'failed' && !(clash.status === 'unknown_delivery' && body.force === true)) return fail(409, 'duplicate_send');
  const gate = businessGate(api, config, lead);
  if (!gate.ok) return fail(409, gate.error_code);
  if (!['pending_approval', 'review'].includes(lead.status)) return fail(409, 'not_pending');
  const limited = replyLimits(api, config, lead);
  if (limited) return limited;
  const property = propertyRow(api.store, lead.property_id);
  const inbound = latestInbound(api.store, leadId);
  const offered = offerFor(api, property, inbound?.text || '');
  const finish = (offeredValue) => sendResolved(api, config, {
    lead, draft, body, actor, text, draftHash, replyTo, clash, key, offered: offeredValue,
  });
  if (isPromise(offered)) return offered.then(finish);
  return finish(offered);
}

function replaySend(api, key, body) {
  const row = api.store.one('SELECT * FROM i_send WHERE idempotency_key = ?', [key]);
  if (row && row.status === 'unknown_delivery') {
    if (body && body.force === true) return null;
    const saved = api.store.one('SELECT response FROM i_idem WHERE key = ?', [key]);
    if (saved) return JSON.parse(saved.response);
    return { ok: false, status: 409, error_code: 'unknown_delivery', send_id: row.send_id, replay: true };
  }
  if (!row || !['sending', 'sent', 'simulated'].includes(row.status)) return null;
  const saved = api.store.one('SELECT response FROM i_idem WHERE key = ?', [key]);
  if (saved) return JSON.parse(saved.response);
  return {
    ok: row.status !== 'sending',
    status: row.status === 'sending' ? 409 : 200,
    error_code: row.status === 'sending' ? 'send_in_progress' : undefined,
    send_id: row.send_id,
    replay: true,
    simulated: row.status === 'simulated',
    lead_status: row.status === 'sending' ? undefined : 'sent',
  };
}

function replyLimits(api, config, lead) {
  const hourAgo = new Date(api.now().getTime() - 3600000).toISOString();
  const broker = lead.broker_id ? String(lead.broker_id) : '';
  const sentN = api.store.one(
    `SELECT COUNT(*) AS n FROM i_send s LEFT JOIN i_lead l ON l.id = s.lead_id
     WHERE s.created_at >= ? AND s.status IN ('simulated','sent','sending')
       AND ((? = '' AND (l.broker_id IS NULL OR l.broker_id = '')) OR (? != '' AND l.broker_id = ?))`,
    [hourAgo, broker, broker, broker],
  ).n;
  if (Number(sentN) >= config.MAX_REPLIES_PER_HOUR) return fail(429, 'rate_limited');
  const chat = String(lead.reply_target || '');
  if (!chat) return null;
  const chatN = api.store.one(
    `SELECT COUNT(*) AS n FROM i_send s JOIN i_lead l ON l.id = s.lead_id
     WHERE l.reply_target = ? AND s.created_at >= ? AND s.status IN ('simulated','sent','sending')`,
    [chat, hourAgo],
  ).n;
  if (Number(chatN) >= (config.MAX_REPLIES_PER_CHAT_HOUR || 20)) return fail(429, 'rate_limited');
  const last = api.store.one(
    `SELECT s.created_at FROM i_send s JOIN i_lead l ON l.id = s.lead_id
     WHERE l.reply_target = ? AND s.status IN ('simulated','sent','sending')
     ORDER BY s.created_at DESC LIMIT 1`,
    [chat],
  );
  if (config.CHANNEL_MODE === 'live' && last && api.now().getTime() - Date.parse(last.created_at) < 1000) return fail(429, 'rate_limited');
  return null;
}

function slotTaken(api, leadId, slotIds, offered) {
  for (const id of slotIds) {
    const offeredSlot = (offered.slots || []).find((slot) => slot.id === id);
    const row = api.store.one('SELECT start_utc, status FROM i_slot WHERE id = ?', [id]);
    if (row && row.status === 'booked') {
      // A slot reserved by the lead itself (bookViewing) is not "taken" for it.
      const mine = api.store.one(
        `SELECT id FROM i_viewing WHERE lead_id = ? AND slot_id = ? AND status IN ('unconfirmed', 'confirmed')`,
        [leadId, id],
      );
      if (!mine) return true;
    }
    const start = (row && row.start_utc) || (offeredSlot && offeredSlot.start_utc);
    if (!start) continue;
    const clash = api.store.one(
      `SELECT id FROM i_viewing WHERE lead_id != ? AND status IN ('unconfirmed', 'confirmed') AND start_utc = ?`,
      [leadId, start],
    );
    if (clash) return true;
  }
  return false;
}

function recordViewings(api, lead, slotIds, offered) {
  const now = api.now().toISOString();
  for (const id of slotIds) {
    const offeredSlot = (offered.slots || []).find((slot) => slot.id === id);
    const row = api.store.one('SELECT start_utc FROM i_slot WHERE id = ?', [id]);
    const start = (row && row.start_utc) || (offeredSlot && offeredSlot.start_utc);
    if (!start) continue;
    const exists = api.store.one(
      `SELECT id FROM i_viewing WHERE lead_id = ? AND status != 'cancelled' AND (slot_id = ? OR start_utc = ?)`,
      [lead.id, id, start],
    );
    if (exists) continue;
    try {
      api.store.run(
        `INSERT INTO i_viewing (id, lead_id, property_id, slot_id, start_utc, status, created_at) VALUES (?, ?, ?, ?, ?, 'unconfirmed', ?)`,
        [`V-${crypto.randomBytes(3).toString('hex')}`, lead.id, lead.property_id, id, start, now],
      );
    } catch (err) {
      // The UNIQUE(lead_id, slot_id) guard fires when another write already
      // reserved this pair. The send itself must not fail because of it.
      if (!/UNIQUE|duplicate/i.test(String(err && err.message))) throw err;
    }
  }
}

function sendResolved(api, config, ctx) {
  const { lead, draft, text, key, offered } = ctx;
  const wanted = JSON.parse(draft.slot_ids || '[]');
  if (offered.error && wanted.length) return fail(409, 'calendar_unavailable');
  const allowed = new Set((offered.slots || []).map((slot) => slot.id));
  if (!offered.error && wanted.length && wanted.some((id) => !allowed.has(id))) return fail(409, 'slot_unavailable');
  if (wanted.length && slotTaken(api, lead.id, wanted, offered)) return fail(409, 'slot_taken');
  const reserved = reserveSend(api, ctx);
  if (reserved.replay) return reserved.response;
  const attachments = cleanAttachments(JSON.parse(draft.attachments || '[]'), api, config);
  const outboundText = desk.attachLinksFooter(text, attachments);
  ctx.attachments = attachments;
  ctx.text = outboundText;
  const delivered = channel.send({
    lead,
    text: outboundText,
    live: config.CHANNEL_MODE === 'live',
    config: whatsapp.effectiveConfig(config, api.store, lead.broker_id),
    fetchImpl: api.fetch,
  });
  const unknown = {
    ok: false,
    status: 502,
    error_code: 'unknown_delivery',
    unknown: config.CHANNEL_MODE === 'live',
  };
  if (isPromise(delivered)) {
    return delivered.then(
      (value) => finishDelivery(api, config, ctx, reserved, value),
      () => finishDelivery(api, config, ctx, reserved, unknown),
    );
  }
  return finishDelivery(api, config, ctx, reserved, delivered);
}

function reserveSend(api, ctx) {
  const { lead, draft, key, draftHash, replyTo, clash } = ctx;
  const replay = replaySend(api, key, ctx.body);
  if (replay) return { replay: true, response: replay };
  const sendId = `S-${crypto.randomBytes(4).toString('hex')}`;
  const now = api.now().toISOString();
  const manual = ctx.body.manual === true || draft.option_id == null;
  const reusable = clash && (clash.status === 'failed' || (clash.status === 'unknown_delivery' && ctx.body.force === true));
  try {
    api.store.transaction(() => {
      if (reusable) {
        api.store.run(
          `UPDATE i_send SET status='sending', fail_reason=NULL, idempotency_key=?, updated_at=? WHERE lead_id=? AND reply_to_message_id=? AND draft_hash=?`,
          [key, now, lead.id, replyTo, draftHash],
        );
      } else {
        api.store.run(
          `INSERT INTO i_send (send_id, lead_id, reply_to_message_id, draft_hash, manual, idempotency_key, status, channel, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'sending', ?, ?, ?)`,
          [sendId, lead.id, replyTo, draftHash, manual ? 1 : 0, key, lead.channel, now, now],
        );
      }
    });
  } catch (err) {
    if (/UNIQUE/i.test(String(err && err.message))) {
      const again = replaySend(api, key, ctx.body);
      if (again) return { replay: true, response: again };
    }
    throw err;
  }
  const row = api.store.one('SELECT send_id FROM i_send WHERE idempotency_key = ?', [key]);
  return { replay: false, sendId: row ? row.send_id : sendId };
}

function finishDelivery(api, config, ctx, reserved, delivered) {
  const { lead, draft, actor, text, draftHash, replyTo, key, offered } = ctx;
  const now = api.now().toISOString();
  const manual = ctx.body.manual === true || draft.option_id == null;
  const wanted = JSON.parse(draft.slot_ids || '[]');
  if (!delivered || delivered.ok === false) {
    const unknownDelivery = Boolean(delivered && (delivered.unknown || delivered.error_code === 'unknown_delivery') && config.CHANNEL_MODE === 'live');
    if (unknownDelivery) {
      api.store.run(
        `UPDATE i_send SET status='unknown_delivery', fail_reason='unknown_delivery', updated_at=? WHERE lead_id=? AND reply_to_message_id=? AND draft_hash=?`,
        [now, lead.id, replyTo, draftHash],
      );
      const response = { ok: false, status: 409, error_code: 'unknown_delivery', send_id: reserved.sendId };
      api.store.run(
        `INSERT INTO i_idem (key, route, response, created_at) VALUES (?, 'send', ?, ?)
         ON CONFLICT(key) DO UPDATE SET response = excluded.response`,
        [key, JSON.stringify(response), now],
      );
      return response;
    }
    if (delivered && delivered.status === 429) {
      api.store.run(
        `UPDATE i_send SET status='failed', fail_reason='rate_limited', updated_at=? WHERE lead_id=? AND reply_to_message_id=? AND draft_hash=?`,
        [now, lead.id, replyTo, draftHash],
      );
      return {
        ok: false,
        status: 429,
        error_code: 'rate_limited',
        retry_after: delivered.retry_after,
        send_id: reserved.sendId,
      };
    }
    api.store.run(
      `UPDATE i_send SET status='failed', fail_reason=?, updated_at=? WHERE lead_id=? AND reply_to_message_id=? AND draft_hash=?`,
      [(delivered && delivered.error_code) || 'telegram_rejected', now, lead.id, replyTo, draftHash],
    );
    const response = {
      ok: false,
      status: (delivered && delivered.status) || 502,
      error_code: (delivered && delivered.error_code) || 'telegram_rejected',
      send_id: reserved.sendId,
    };
    api.store.run(
      `INSERT INTO i_idem (key, route, response, created_at) VALUES (?, 'send', ?, ?)
       ON CONFLICT(key) DO UPDATE SET response = excluded.response`,
      [key, JSON.stringify(response), now],
    );
    return response;
  }
  const simulated = config.CHANNEL_MODE !== 'live';
  const attachments = ctx.attachments || cleanAttachments(JSON.parse(draft.attachments || '[]'), api, config);
  const response = { ok: true, status: 200, simulated, send_id: reserved.sendId, lead_status: 'sent', attachments };
  try {
    api.store.transaction(() => {
      api.store.run(
        `UPDATE i_send SET status=?, updated_at=? WHERE lead_id=? AND reply_to_message_id=? AND draft_hash=?`,
        [simulated ? 'simulated' : 'sent', now, lead.id, replyTo, draftHash],
      );
      api.store.run(
        `INSERT INTO i_message (id, lead_id, direction, text, kind, option_id, created_at) VALUES (?, ?, 'out', ?, 'text', ?, ?)`,
        [`O-${crypto.randomBytes(3).toString('hex')}`, lead.id, text, draft.option_id, now],
      );
      api.store.run(`UPDATE i_lead SET status='sent' WHERE id=?`, [lead.id]);
      if (wanted.length && actor !== 'system') recordViewings(api, lead, wanted, offered);
      audit(api.store, config, manual ? 'manual_send' : 'send', lead.id, { simulated }, actor || 'broker');
      api.store.run(
        `INSERT INTO i_idem (key, route, response, created_at) VALUES (?, 'send', ?, ?)
         ON CONFLICT(key) DO UPDATE SET response = excluded.response`,
        [key, JSON.stringify(response), now],
      );
    });
  } catch (err) {
    if (config.CHANNEL_MODE !== 'live') {
      try { api.store.run('DELETE FROM i_send WHERE idempotency_key = ?', [key]); } catch { /* the original error stands */ }
      throw err;
    }
    try {
      api.store.run(
        `UPDATE i_send SET status='unknown_delivery', fail_reason='commit_failed', updated_at=? WHERE idempotency_key=?`,
        [now, key],
      );
    } catch { /* the row may already be gone */ }
    const response = { ok: false, status: 409, error_code: 'unknown_delivery', send_id: reserved.sendId };
    try {
      api.store.run(
        `INSERT INTO i_idem (key, route, response, created_at) VALUES (?, 'send', ?, ?)
         ON CONFLICT(key) DO UPDATE SET response = excluded.response`,
        [key, JSON.stringify(response), now],
      );
    } catch { /* the caller still hears unknown_delivery */ }
    return response;
  }
  return response;
}

function businessGate(api, config, lead) {
  config = whatsapp.effectiveConfig(config, api.store, lead.broker_id);
  if (lead.channel === 'whatsapp') {
    if (!whatsapp.whatsappConfigured(config)) return { ok: false, error_code: 'cannot_reply' };
    const anchor = lead.last_client_at || lead.last_msg_at;
    const age = api.now().getTime() - Date.parse(anchor || 0);
    if (config.CHANNEL_MODE === 'live' && (!anchor || age > 24 * 3600 * 1000)) return { ok: false, error_code: 'window_closed' };
    return { ok: true };
  }
  if (!lead.business_connection_id) {
    if (config.CHANNEL_MODE === 'live' && lead.channel === 'telegram') return { ok: false, error_code: 'cannot_reply' };
    return { ok: true };
  }
  const conn = api.store.one('SELECT * FROM i_tg_conn WHERE business_connection_id = ?', [lead.business_connection_id]);
  if (!conn || conn.can_reply !== 1 || conn.is_enabled === 0) return { ok: false, error_code: 'cannot_reply' };
  const anchor = lead.last_client_at || lead.last_msg_at;
  const age = api.now().getTime() - Date.parse(anchor || 0);
  if (!anchor || age > 24 * 3600 * 1000) return { ok: false, error_code: 'window_closed' };
  return { ok: true };
}

function maybeConfirmFromReply(api, config, leadId, text) {
  const viewings = api.store.all(
    `SELECT * FROM i_viewing WHERE lead_id = ? AND status = 'unconfirmed'`,
    [leadId],
  );
  if (!viewings.length) return;
  const lead = loadLead(api.store, leadId);
  if (!lead) return;
  const property = propertyRow(api.store, lead.property_id);
  const parsed = parseProposal(text || '', property?.tz || config.BROKER_TZ || 'Asia/Dubai', api.now());
  if (!parsed) return;
  const hit = viewings.find((row) => Date.parse(row.start_utc) === Date.parse(parsed.start_utc));
  if (!hit) return;
  api.store.run(`UPDATE i_viewing SET status = 'confirmed' WHERE id = ?`, [hit.id]);
  api.store.run('UPDATE i_lead SET client_confirmed = 1 WHERE id = ?', [leadId]);
  audit(api.store, config, 'viewing_confirm', leadId, { viewing_id: hit.id, by: 'client' }, 'system');
}

function fail(status, error_code) {
  return { ok: false, status, error_code };
}

function moneyAmount(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function markHandled(api, config, leadId, actor) {
  const lead = loadLead(api.store, leadId);
  if (!lead) return fail(404, 'not_found');
  if (lead.optout || lead.status === 'stopped') return fail(409, 'lead_stopped');
  if (lead.status === 'archived') return fail(409, 'not_pending');
  if (lead.status === 'sent' || lead.status === 'handled') return { ok: true, status: lead.status, already: true };
  api.store.run(`UPDATE i_lead SET status='handled' WHERE id=?`, [leadId]);
  api.store.run('DELETE FROM i_draft WHERE lead_id=?', [leadId]);
  audit(api.store, config, 'handled', leadId, {}, actor || 'broker');
  return { ok: true, status: 'handled', simulated: true };
}

function revertHandled(api, config, leadId, actor) {
  const lead = loadLead(api.store, leadId);
  if (!lead) return fail(404, 'not_found');
  if (lead.status !== 'handled') return fail(409, 'not_handled');
  api.store.run("UPDATE i_lead SET status = 'pending_approval' WHERE id = ?", [leadId]);
  audit(api.store, config, 'unhandled', leadId, {}, actor || 'broker');
  return { ok: true, status: 'pending_approval' };
}

function archiveLead(api, config, leadId, actor) {
  const lead = loadLead(api.store, leadId);
  if (!lead) return fail(404, 'not_found');
  if (lead.status === 'archived') return { ok: true, status: 'archived' };
  api.store.run(`UPDATE i_lead SET status='archived' WHERE id=?`, [leadId]);
  api.store.run('DELETE FROM i_draft WHERE lead_id=?', [leadId]);
  audit(api.store, config, 'archive', leadId, {}, actor || 'broker');
  return { ok: true, status: 'archived', simulated: true, sent: false };
}

function confirmLead(api, config, leadId, actor) {
  const lead = loadLead(api.store, leadId);
  if (!lead) return fail(404, 'not_found');
  if (lead.optout || lead.status === 'stopped') return fail(409, 'lead_stopped');
  if (lead.status === 'archived') return fail(409, 'not_pending');
  if (lead.status !== 'sent') return fail(409, 'not_replied');
  if (lead.client_confirmed) return { ok: true, status: 'sent', client_confirmed: true, simulated: true, sent: false };
  api.store.run('UPDATE i_lead SET client_confirmed = 1 WHERE id = ?', [leadId]);
  audit(api.store, config, 'lead_confirm', leadId, {}, actor || 'broker');
  return { ok: true, status: 'sent', client_confirmed: true, simulated: true, sent: false };
}

function applyChosenSlot(api, config, leadId, body) {
  const presented = presentLead(api, config, leadId);
  if (!presented) return fail(404, 'not_found');
  if (!['pending_approval', 'review'].includes(presented.status)) return fail(409, 'not_pending');
  const slot = (presented.slots || []).find((row) => row.id === body.slot_id);
  if (!slot) return fail(409, 'slot_unavailable');
  const lang = presented.language === 'ru' ? 'ru' : 'en';
  const when = lang === 'ru' ? slot.label_ru : slot.label_en;
  const current = (presented.draft && presented.draft.text) || presented.options?.[0]?.text || '';
  const text = rewriteReplyTime(current, when, lang);
  const saved = saveDraft(api, config, leadId, {
    text,
    option_id: presented.status === 'review' ? null : (presented.draft?.option_id || 'one'),
    edited: true,
    slot_ids: [slot.id],
    base_version: body.base_version,
  });
  if (!saved.ok) return saved;
  return { ok: true, text, version: saved.version, slot_ids: [slot.id] };
}

function rejectLead(api, config, leadId, actor) {
  const lead = loadLead(api.store, leadId);
  if (!lead) return fail(404, 'not_found');
  if (lead.status === 'stopped') return fail(409, 'lead_stopped');
  api.store.run(`UPDATE i_lead SET status='review' WHERE id=?`, [leadId]);
  api.store.run('DELETE FROM i_draft WHERE lead_id=?', [leadId]);
  audit(api.store, config, 'reject', leadId, {}, actor || 'broker');
  return { ok: true, status: 'review' };
}

function stopLead(api, config, leadId, actor) {
  const lead = loadLead(api.store, leadId);
  if (!lead) return fail(404, 'not_found');
  const now = api.now().toISOString();
  return api.store.transaction(() => {
    api.store.run(
      'INSERT INTO i_optout (channel, sender_hash, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      [lead.channel, lead.sender_hash, now],
    );
    const leads = api.store.all('SELECT id FROM i_lead WHERE channel = ? AND sender_hash = ?', [lead.channel, lead.sender_hash]);
    for (const row of leads) {
      api.store.run(`UPDATE i_lead SET status='stopped', optout=1 WHERE id=?`, [row.id]);
      api.store.run('DELETE FROM i_draft WHERE lead_id=?', [row.id]);
    }
    audit(api.store, config, 'stop', leadId, { by: 'broker' }, actor || 'broker');
    return { ok: true, status: 'stopped', leads: leads.length, sent: false, simulated: true };
  });
}

function validZone(tz) {
  if (!tz || typeof tz !== 'string' || tz.length > 64) return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function periodOf(value) {
  if (value === 'once') return 'total';
  return value;
}

function parseMoney(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  let text = String(value == null ? '' : value).trim().replace(/\s+/g, '');
  if (!text) return NaN;
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(text)) text = text.replace(/\./g, '').replace(',', '.');
  else if (text.includes(',') && !text.includes('.')) text = text.replace(',', '.');
  else text = text.replace(/,/g, '');
  const n = Number(text);
  return Number.isFinite(n) ? n : NaN;
}

function propertyError(body) {
  const period = periodOf(body.price_period);
  const price = parseMoney(body.price);
  if (!body.title || typeof body.title !== 'string') return 'invalid_property';
  if (!['rent', 'sale'].includes(body.kind)) return 'invalid_property';
  if (!Number.isFinite(price) || price <= 0) return 'invalid_property';
  if (!['USD', 'AED', 'EUR', 'GBP', 'TRY'].includes(body.currency)) return 'invalid_property';
  if (!['year', 'month', 'total'].includes(period)) return 'invalid_property';
  if (body.kind === 'sale' && period !== 'total') return 'invalid_property';
  if (body.kind === 'rent' && !['year', 'month'].includes(period)) return 'invalid_property';
  if (body.area_unit != null && body.area_unit !== '' && !['sqft', 'sqm'].includes(body.area_unit)) return 'invalid_property';
  if (!validZone(body.tz)) return 'invalid_timezone';
  return '';
}

const FILE_TTL_MS = 7 * 24 * 3600 * 1000;

function cleanUrl(value) {
  let text = String(value || '').trim();
  if (!text) return '';
  if (text.startsWith('file:')) return text;
  if (text.startsWith('/v1/intl/properties/') && text.endsWith('/brochure.pdf')) return text;
  if (text.startsWith('/v1/intl/public/files/')) return text;
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(text)) {
    if (text.length > 900000) return null;
    return text;
  }
  if (/^data:application\/pdf;base64,/i.test(text)) {
    if (text.length > 120000) return null;
    return text;
  }
  // Brokers often paste listing hosts without a scheme; treat as https.
  if (!/^https?:\/\//i.test(text) && /^[\w.-]+\.[a-z]{2,}([/:?#].*)?$/i.test(text)) {
    text = `https://${text}`;
  }
  if (/^https?:\/\//i.test(text) && text.length <= 500 && !/^javascript:/i.test(text)) return text;
  return null;
}

function fileSignature(config, id, exp) {
  return crypto.createHmac('sha256', String(config.HASH_SALT)).update(`${id}.${exp}`).digest('base64url');
}

function publicFileUrl(config, id) {
  const exp = Date.now() + FILE_TTL_MS;
  const sig = fileSignature(config, id, exp);
  return `/v1/intl/public/files/${encodeURIComponent(id)}?exp=${exp}&sig=${sig}`;
}

function fileIdFromPublic(url) {
  const match = String(url || '').match(/\/v1\/intl\/public\/files\/([^?]+)/);
  if (!match) return '';
  try { return decodeURIComponent(match[1]); } catch { return ''; }
}

function persistDataUrl(api, propertyId, kind, dataUrl) {
  const match = /^data:(image\/(?:png|jpeg|gif|webp)|application\/pdf);base64,([a-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
  if (!match) return '';
  const bytes = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!bytes.length || bytes.length > 90000) return '';
  const id = `F-${crypto.randomBytes(6).toString('hex')}`;
  api.store.run(
    `INSERT INTO i_file (id, property_id, kind, mime, name, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, propertyId || null, kind, match[1].toLowerCase(), kind, bytes, api.now().toISOString()],
  );
  return id;
}

function storedFileRef(api, propertyId, kind, url) {
  const text = String(url || '');
  if (!text.startsWith('data:')) return text;
  const id = persistDataUrl(api, propertyId, kind, text);
  return id ? `file:${id}` : '';
}

function resolveFileId(api, url, kind) {
  const text = String(url || '').trim();
  if (text.startsWith('file:')) return text.slice(5);
  const brochure = text.match(/^\/v1\/intl\/properties\/([^/]+)\/brochure\.pdf$/);
  if (brochure) return `brochure:${decodeURIComponent(brochure[1])}`;
  const existing = fileIdFromPublic(text);
  if (existing) return existing;
  if (text.startsWith('data:')) return persistDataUrl(api, null, kind || 'file', text);
  return '';
}

function publishUrl(api, config, url, kind) {
  const text = String(url || '').trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text.slice(0, 500);
  const id = resolveFileId(api, text, kind);
  if (!id || !config) return '';
  return publicFileUrl(config, id);
}

function clientProperty(api, config, property) {
  if (!property) return property;
  const copy = { ...property };
  if (copy.brochure_url) copy.brochure_url = publishUrl(api, config, copy.brochure_url, 'brochure') || copy.brochure_url;
  if (copy.plan_url) copy.plan_url = publishUrl(api, config, copy.plan_url, 'plan') || copy.plan_url;
  return copy;
}

function cleanAttachments(list, api, config) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 4).map((item) => {
    const kind = ['brochure', 'plan', 'link'].includes(item.kind) ? item.kind : 'link';
    const name = String(item.name || 'file').slice(0, 40);
    const fileId = item.file_id || resolveFileId(api, item.url, kind);
    const url = publishUrl(api, config, item.file_id ? `file:${item.file_id}` : item.url, kind);
    return { kind, name, url, file_id: fileId || fileIdFromPublic(url) || null };
  }).filter((item) => item.url);
}

async function openPublicFile(api, config, id, exp, sig) {
  const expN = Number(exp);
  const expected = fileSignature(config, id, exp);
  const given = Buffer.from(String(sig || ''));
  const want = Buffer.from(expected);
  const fresh = Number.isFinite(expN) && expN >= Date.now();
  const same = given.length === want.length && crypto.timingSafeEqual(given, want);
  if (!fresh || !same) return fail(403, 'file_forbidden');
  if (String(id).startsWith('brochure:')) {
    const propertyId = String(id).slice('brochure:'.length);
    const property = propertyRow(api.store, propertyId);
    if (!property || property.id === 'general') return fail(404, 'not_found');
    const bytes = await brochurePdf(property, brochureMeta(api, property));
    return fileResponse(bytes, 'application/pdf', `${propertyId}.pdf`);
  }
  const row = api.store.one('SELECT mime, name, bytes FROM i_file WHERE id = ?', [id]);
  if (!row || row.bytes == null) return fail(404, 'not_found');
  return fileResponse(Buffer.from(row.bytes), row.mime || 'application/octet-stream', row.name || 'file');
}

function fileResponse(bytes, mime, name) {
  return {
    ok: true,
    status: 200,
    body_bytes: bytes,
    headers: {
      'Content-Type': mime,
      'Content-Disposition': `inline; filename="${String(name).replace(/[^a-z0-9._-]+/gi, '_')}"`,
      'Cache-Control': 'private, max-age=300',
    },
  };
}

function photoIdList(store, propertyId) {
  const row = store.one('SELECT photos FROM i_property WHERE id = ?', [propertyId]);
  let ids = [];
  try { ids = JSON.parse((row && row.photos) || '[]'); } catch { ids = []; }
  return Array.isArray(ids) ? ids : [];
}

function publicPhotos(store, propertyId) {
  return photoIdList(store, propertyId).map((id) => {
    const file = store.one('SELECT id, mime, bytes FROM i_file WHERE id = ?', [id]);
    if (!file || file.bytes == null) return null;
    const bytes = Buffer.from(file.bytes);
    const mime = file.mime || 'image/jpeg';
    return { id: file.id, mime, data_url: `data:${mime};base64,${bytes.toString('base64')}` };
  }).filter(Boolean);
}

function photoBuffers(store, propertyId) {
  return photoIdList(store, propertyId).map((id) => {
    const file = store.one('SELECT mime, bytes FROM i_file WHERE id = ?', [id]);
    if (!file || file.bytes == null) return null;
    return { mime: file.mime || 'image/jpeg', bytes: Buffer.from(file.bytes) };
  }).filter(Boolean);
}

function planPhotos(api, propertyId, photos) {
  if (photos.length > 12) return { error: 'invalid_property' };
  const plan = [];
  for (const item of photos) {
    if (typeof item === 'string' && item.startsWith('file:')) {
      const id = item.slice('file:'.length);
      const row = api.store.one(
        'SELECT id FROM i_file WHERE id = ? AND property_id = ? AND kind = ?',
        [id, propertyId, 'photo'],
      );
      if (!row) return { error: 'invalid_property' };
      plan.push({ keep: id });
      continue;
    }
    if (typeof item !== 'string' || !/^data:image\/(?:png|jpeg|webp);base64,/i.test(item)) return { error: 'invalid_property' };
    if (cleanUrl(item) == null) return { error: 'invalid_property' };
    plan.push({ data: item });
  }
  return { plan };
}

function commitPhotos(api, propertyId, plan) {
  const ids = [];
  for (const item of plan) {
    if (item.keep) {
      ids.push(item.keep);
      continue;
    }
    const id = persistDataUrl(api, propertyId, 'photo', item.data);
    if (!id) return null;
    ids.push(id);
  }
  const existing = api.store.all(`SELECT id FROM i_file WHERE property_id = ? AND kind = 'photo'`, [propertyId]);
  for (const row of existing) {
    if (!ids.includes(row.id)) api.store.run('DELETE FROM i_file WHERE id = ?', [row.id]);
  }
  api.store.run('UPDATE i_property SET photos = ? WHERE id = ?', [JSON.stringify(ids), propertyId]);
  return ids;
}

function profileOf(body, id) {
  const address = String(body.address || '').trim().slice(0, 160);
  const meetingPoint = String(body.meeting_point || '').trim().slice(0, 160);
  const accessNotes = String(body.access_notes || '').trim().slice(0, 240);
  const district = String(body.district || '').trim().slice(0, 80);
  const bedrooms = body.bedrooms == null || body.bedrooms === '' ? null : Number(body.bedrooms);
  if (bedrooms != null && (!Number.isInteger(bedrooms) || bedrooms < 0 || bedrooms > 20)) return { error: 'invalid_property' };
  const listing = cleanUrl(body.listing_url);
  const plan = cleanUrl(body.plan_url);
  let brochure = cleanUrl(body.brochure_url);
  if (listing == null || plan == null || brochure == null) return { error: 'invalid_property' };
  if (body.make_brochure) brochure = `/v1/intl/properties/${id}/brochure.pdf`;
  return { address, meetingPoint, accessNotes, district, bedrooms, listing, plan, brochure };
}

function addProperty(api, config, body, actor) {
  const problem = propertyError(body);
  if (problem) return fail(400, problem);
  const period = periodOf(body.price_period);
  const priceAmount = parseMoney(body.price);
  const id = body.id || `P-${crypto.randomBytes(3).toString('hex')}`;
  const profile = profileOf(body, id);
  if (profile.error) return fail(400, profile.error);
  const photoPlan = Array.isArray(body.photos) ? planPhotos(api, id, body.photos) : null;
  if (photoPlan && photoPlan.error) return fail(400, photoPlan.error);
  let areaValue = null;
  if (body.area_value != null && body.area_value !== '') {
    const n = Number(body.area_value);
    if (!Number.isFinite(n) || n <= 0) return fail(400, 'invalid_property');
    areaValue = n;
  }
  const exists = Boolean(propertyRow(api.store, id));
  const invalid = () => Object.assign(new Error('invalid_property'), { code: 'invalid_property' });
  try {
    api.store.transaction(() => {
      if (String(profile.plan).startsWith('data:')) {
        profile.plan = storedFileRef(api, id, 'plan', profile.plan);
        if (!profile.plan) throw invalid();
      }
      if (String(profile.brochure).startsWith('data:')) {
        profile.brochure = storedFileRef(api, id, 'brochure', profile.brochure);
        if (!profile.brochure) throw invalid();
      }
      const price = formatPair({ ...body, price: priceAmount, price_period: period });
      const facts = { ...(body.facts || {}) };
      if (profile.bedrooms != null) facts.bedrooms = profile.bedrooms;
      if (profile.district) facts.district = profile.district;
      const fields = [body.title, body.kind, priceAmount, body.currency, period, body.tz, body.tz_label_en || null, body.tz_label_ru || null,
        areaValue, body.area_unit || null, body.ref_en || body.title, body.ref_ru || body.title,
        price.en, price.ru, JSON.stringify(facts), profile.address, profile.district, profile.bedrooms, profile.listing, profile.brochure, profile.plan,
        profile.meetingPoint, profile.accessNotes];
      const brokerId = actor ? String(actor) : null;
      if (exists) {
        api.store.run(
          `UPDATE i_property SET title=?, kind=?, price=?, currency=?, price_period=?, tz=?, tz_label_en=?, tz_label_ru=?, area_value=?, area_unit=?, ref_en=?, ref_ru=?, price_en=?, price_ru=?, facts=?, address=?, district=?, bedrooms=?, listing_url=?, brochure_url=?, plan_url=?, meeting_point=?, access_notes=?, broker_id=COALESCE(broker_id, ?) WHERE id=?`,
          [...fields, brokerId, id],
        );
        audit(api.store, config, 'property_add', null, { property_id: id, updated: true }, actor || 'broker');
      } else {
        const insertColumns = 'id, title, kind, price, currency, price_period, tz, tz_label_en, tz_label_ru, area_value, area_unit, ref_en, ref_ru, price_en, price_ru, facts, active, created_at, address, district, bedrooms, listing_url, brochure_url, plan_url, meeting_point, access_notes, broker_id';
        const insertValues = [id, ...fields.slice(0, 15), 1, api.now().toISOString(), ...fields.slice(15), brokerId];
        api.store.run(
          `INSERT INTO i_property (${insertColumns}) VALUES (${insertValues.map(() => '?').join(', ')})`,
          insertValues,
        );
        audit(api.store, config, 'property_add', null, { property_id: id }, actor || 'broker');
      }
      if (photoPlan && !commitPhotos(api, id, photoPlan.plan)) throw invalid();
    });
  } catch (err) {
    if (err && err.code === 'invalid_property') return fail(400, 'invalid_property');
    throw err;
  }
  return exists ? { ok: true, id, updated: true } : { ok: true, id };
}

function brochureMeta(api, property) {
  const settings = readSettings(api.store);
  return {
    brokerName: settings.broker_name || property.broker_name || property.agency || 'Broker',
    brokerPhone: settings.broker_phone || property.broker_phone || '',
    photos: photoBuffers(api.store, property.id),
  };
}

async function brochureFor(api, id) {
  const property = propertyRow(api.store, id);
  if (!property || property.id === 'general') return fail(404, 'not_found');
  const bytes = await brochurePdf(property, brochureMeta(api, property));
  return {
    ok: true,
    status: 200,
    body_bytes: bytes,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${id}.pdf"`,
      'Cache-Control': 'no-store',
    },
  };
}

function formatPair(body) {
  const property = { price: body.price, currency: body.currency, price_period: body.price_period };
  return { en: formatPrice(property, 'en'), ru: formatPrice(property, 'ru') };
}

function addSlot(api, config, propertyId, body, actor) {
  return addSlotModule(api, config, propertyId, body, actor, { propertyRow, audit, fail });
}

function bookViewing(api, config, leadId, slotId, actor) {
  return bookViewingModule(api, config, leadId, slotId, actor, { loadLead, audit, fail });
}

function setViewing(api, config, id, status, actor) {
  return setViewingModule(api, config, id, status, actor, { audit, fail });
}

function updateSettings(api, config, body, actor) {
  if (body.manual_approval === false) return fail(409, 'locked');
  let settled = null;
  if (body.auto_send_hot != null) {
    setting(api.store, 'auto_send_hot', body.auto_send_hot ? '1' : '0');
    settled = body.auto_send_hot ? settleOpenHot(api, config) : null;
    if (!body.auto_send_hot) cancelCompetitions(api);
  }
  if (body.note_stop != null) setting(api.store, 'note_stop', body.note_stop ? '1' : '0');
  if (body.note_ai != null) setting(api.store, 'note_ai', body.note_ai ? '1' : '0');
  if (body.lang != null && !['en', 'ru'].includes(body.lang)) return fail(400, 'invalid_settings');
  if (body.broker_tz != null && !validZone(body.broker_tz)) return fail(400, 'invalid_timezone');
  for (const key of ['lang', 'broker_name', 'broker_tz']) {
    if (body[key] != null) setting(api.store, key, String(body[key]));
  }
  if (body.reply_style != null) {
    if (!['business', 'short', 'warm', ''].includes(String(body.reply_style))) return fail(400, 'invalid_settings');
    setting(api.store, 'reply_style', String(body.reply_style));
  }
  if (body.digest_time != null) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(body.digest_time))) return fail(400, 'invalid_settings');
    setting(api.store, 'digest_time', String(body.digest_time));
  }
  if (body.digest_enabled != null) setting(api.store, 'digest_enabled', body.digest_enabled ? '1' : '0');
  if (body.reply_templates != null) desk.saveTemplates(api.store, setting, body.reply_templates);
  audit(api.store, config, 'settings_change', null, { keys: Object.keys(body) }, actor || 'broker');
  const response = {
    ok: true,
    settings: readSettings(api.store),
    templates: desk.getTemplates(api.store, setting),
  };
  if (isPromise(settled)) return settled.then(() => response);
  return response;
}

function buildDigest(api, config) {
  return buildDigestModule(api, config, { loadLead, propertyRow });
}

function runDigest(api, config, reason, actorId) {
  return runDigestModule(api, config, reason, actorId, { loadLead, propertyRow, setting, audit });
}

function configuredBrokerId(config) {
  const explicit = String((config && config.OWNER_TELEGRAM_ID) || '').trim();
  if (explicit) return explicit;
  const ids = config && config.TELEGRAM_ALLOWED_USER_IDS;
  if (Array.isArray(ids) && ids.length) {
    const first = ids.map(String).find((id) => id && id !== '*');
    if (first) return first;
  }
  const profile = config && config.MAKLER_PROFILE && config.MAKLER_PROFILE.telegram_user_id;
  return profile ? String(profile) : null;
}

function bget(store, key, brokerId) {
  if (brokerId == null || String(brokerId) === '') return '';
  try {
    const row = store.one('SELECT value FROM i_settings WHERE key = ?', [key + '::' + String(brokerId)]);
    return row && row.value != null ? String(row.value) : '';
  } catch {
    return '';
  }
}

function bset(store, key, brokerId, value) {
  if (brokerId == null || String(brokerId) === '') return;
  const k = key + '::' + String(brokerId);
  store.run('DELETE FROM i_settings WHERE key = ?', [k]);
  store.run('INSERT INTO i_settings (key, value) VALUES (?, ?)', [k, String(value)]);
}

function brokerForWebhookToken(store, token) {
  if (!token) return '';
  try {
    const row = store.one("SELECT key FROM i_settings WHERE key LIKE 'wa_webhook_token::%' AND value = ?", [String(token)]);
    return row && row.key ? String(row.key).slice('wa_webhook_token::'.length) : '';
  } catch {
    return '';
  }
}

function ingestWhatsAppInbound(api, config, payload, brokerId) {
  const messages = whatsapp.inboundMessages(payload, whatsapp.providerOf(config));
  let stored = 0;
  for (const message of messages) {
    const result = ingest(api, config, {
      channel: 'whatsapp',
      sender_id: message.sender_id,
      sender_name: message.sender_name,
      text: message.text,
      kind: message.kind,
      received_at: message.received_at || undefined,
      dedup_key: message.message_id ? `wa:${message.message_id}` : undefined,
      reply_target: message.sender_id,
      broker_id: brokerId || configuredBrokerId(config),
    });
    if (result && !result.duplicate) stored += 1;
  }
  return { received: messages.length, stored };
}

function seedMessages(api, config, pack, mode) {
  const skip = new Set(mode === 'minus_t06' ? ['T06'] : []);
  const brokerId = configuredBrokerId(config);
  api.config = config;
  for (const [id, property] of Object.entries(pack.meta.properties)) addFixtureProperty(api, { ...property, id }, brokerId);
  addFixtureSlots(api, pack, api.now());
  for (const message of pack.messages) {
    if (skip.has(message.id)) continue;
    ingest(api, config, {
      channel: message.channel,
      sender_id: message.sender_id,
      sender_name: message.sender_name,
      text: message.text,
      property_id: message.property_id,
      received_at: message.received_at,
      dedup_key: `seed:${message.id}`,
      reply_target: message.channel === 'wa_sim' ? message.sender_id : null,
      fixture: true,
      lead_id: message.id,
      broker_id: brokerId,
    });
  }
  // Legacy seeds used actor "system"; re-home them so the Mini App list (broker-scoped) is not empty.
  if (brokerId) {
    api.store.run(
      `UPDATE i_property SET broker_id = ? WHERE broker_id IS NULL OR broker_id = '' OR broker_id = 'system'`,
      [brokerId],
    );
  }
  addDemoViewings(api);
  const counts = { HOT: 0, WARM: 0, COLD: 0 };
  for (const message of pack.messages) {
    if (skip.has(message.id)) continue;
    const row = api.store.one('SELECT grade FROM i_lead WHERE id = ?', [message.id]);
    if (row && counts[row.grade] != null) counts[row.grade] += 1;
  }
  return counts;
}

function addDemoViewings(api) {
  const plan = [
    { leadId: 'T02', status: 'confirmed', nth: 0 },
    { leadId: 'T20', status: 'unconfirmed', nth: 1 },
  ];
  for (const item of plan) {
    const id = `V-demo-${item.leadId}`;
    const existing = api.store.one('SELECT slot_id FROM i_viewing WHERE id = ?', [id]);
    if (existing) {
      api.store.run(`UPDATE i_slot SET status = 'free' WHERE id = ? AND status = 'booked'`, [existing.slot_id]);
      api.store.run('DELETE FROM i_viewing WHERE id = ?', [id]);
    }
    const lead = api.store.one('SELECT id, property_id FROM i_lead WHERE id = ?', [item.leadId]);
    if (!lead) continue;
    const slot = api.store.all(
      `SELECT * FROM i_slot WHERE property_id = ? AND status != 'removed' ORDER BY start_utc`,
      [lead.property_id],
    )[item.nth];
    if (!slot) continue;
    api.store.run(
      `INSERT INTO i_viewing (id, lead_id, property_id, slot_id, start_utc, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, lead.id, lead.property_id, slot.id, slot.start_utc, item.status, api.now().toISOString()],
    );
    if (item.status === 'confirmed') api.store.run(`UPDATE i_slot SET status = 'booked' WHERE id = ?`, [slot.id]);
  }
}

function addFixtureProperty(api, property, brokerId) {
  if (propertyRow(api.store, property.id)) return;
  const owner = brokerId || configuredBrokerId(api.config || {}) || '42';
  addProperty(api, {}, {
    id: property.id,
    title: property.title,
    kind: property.kind,
    price: property.price,
    currency: property.cur,
    price_period: property.period,
    tz: property.tz,
    tz_label_en: property.tz_label_en,
    tz_label_ru: property.tz_label_ru,
    ref_en: property.ref_en,
    ref_ru: property.ref_ru,
    area_value: property.facts?.area_value,
    area_unit: property.facts?.area_unit,
    facts: property.facts || {},
  }, owner);
  api.store.run('UPDATE i_property SET price_en=?, price_ru=?, broker_id=COALESCE(broker_id, ?) WHERE id=?', [property.price_en, property.price_ru, owner, property.id]);
}

function addFixtureSlots(api, pack, now) {
  for (const [id, property] of Object.entries(pack.meta.properties)) {
    const zone = property.tz || 'Asia/Dubai';
    const templates = (property.slots || [])
      .map((start) => DateTime.fromISO(start, { setZone: true }).setZone(zone))
      .filter((value) => value.isValid);
    if (!templates.length) continue;
    const firstDay = templates[0].startOf('day');
    const base = DateTime.fromJSDate(now instanceof Date ? now : new Date(now), { zone });
    let anchor = base.set({
      hour: templates[0].hour,
      minute: templates[0].minute,
      second: 0,
      millisecond: 0,
    });
    if (anchor <= base) anchor = anchor.plus({ days: 1 });
    for (const template of templates) {
      const delta = Math.round(template.startOf('day').diff(firstDay, 'days').days);
      const shifted = anchor.plus({ days: Math.max(0, delta) }).set({
        hour: template.hour,
        minute: template.minute,
        second: 0,
        millisecond: 0,
      });
      if (shifted.toMillis() <= base.toMillis()) continue;
      const iso = shifted.toUTC().toISO();
      const slotId = `SL-${id}-${template.toFormat('MMdd-HHmm')}`;
      if (api.store.one('SELECT id FROM i_slot WHERE id=?', [slotId])) continue;
      if (api.store.one('SELECT id FROM i_slot WHERE property_id=? AND start_utc=?', [id, iso])) continue;
      api.store.run(
        `INSERT INTO i_slot (id, property_id, start_utc, duration_min, status, created_at) VALUES (?, ?, ?, 45, 'free', ?)`,
        [slotId, id, iso, base.toUTC().toISO()],
      );
    }
  }
}

function setPipeline(api, config, leadId, pipeline, actor) {
  if (!['open', 'viewing', 'closed'].includes(pipeline)) return fail(400, 'invalid_pipeline');
  const lead = loadLead(api.store, leadId);
  if (!lead) return fail(404, 'not_found');
  api.store.run('UPDATE i_lead SET pipeline = ? WHERE id = ?', [pipeline, leadId]);
  audit(api.store, config, 'status', leadId, { pipeline }, actor || 'broker');
  return { ok: true, pipeline };
}

function sweepRetention(api) {
  const now = api.now().toISOString();
  const leads = api.store.all(
    `SELECT id FROM i_lead WHERE retention_until IS NOT NULL AND retention_until < ?`,
    [now],
  );
  for (const lead of leads) {
    // The Telegram chat id and the platform message id are personal data too:
    // clear the dedup key so `telegram:<chatId>:<messageId>` does not outlive
    // the retention window. NULL (not '') keeps the UNIQUE(dedup_key) index happy.
    api.store.run(
      `UPDATE i_message SET text = '', dedup_key = NULL, channel_msg_id = NULL, deleted = 1 WHERE lead_id = ?`,
      [lead.id],
    );
    api.store.run(`UPDATE i_lead SET sender_name = '', clean_name = '', reply_target = NULL WHERE id = ?`, [lead.id]);
    api.store.run('DELETE FROM i_draft WHERE lead_id = ?', [lead.id]);
  }
  return leads.length;
}

function eraseSender(api, config, leadId, actor) {
  const lead = loadLead(api.store, leadId);
  if (!lead) return fail(404, 'not_found');
  const leads = api.store.all('SELECT id FROM i_lead WHERE channel = ? AND sender_hash = ?', [lead.channel, lead.sender_hash]);
  for (const row of leads) {
    api.store.run('DELETE FROM i_message WHERE lead_id = ?', [row.id]);
    api.store.run('DELETE FROM i_draft WHERE lead_id = ?', [row.id]);
    api.store.run('DELETE FROM i_send WHERE lead_id = ?', [row.id]);
    api.store.run('DELETE FROM i_viewing WHERE lead_id = ?', [row.id]);
    api.store.run('DELETE FROM i_lead WHERE id = ?', [row.id]);
    audit(api.store, config, 'erase', row.id, {}, actor || 'broker');
  }
  const kept = api.store.one('SELECT channel FROM i_optout WHERE channel = ? AND sender_hash = ?', [lead.channel, lead.sender_hash]);
  return { ok: true, erased: leads.length, optout_kept: Boolean(kept) };
}

function sweepSending(api, config) {
  const ttl = (config.SENDING_TTL_SEC || 120) * 1000;
  const cutoff = new Date(api.now().getTime() - ttl).toISOString();
  const rows = api.store.all(`SELECT send_id, lead_id FROM i_send WHERE status='sending' AND created_at < ?`, [cutoff]);
  const live = config.CHANNEL_MODE === 'live';
  const status = live ? 'unknown_delivery' : 'failed';
  const reason = live ? 'unknown_delivery' : 'stale_sending';
  for (const row of rows) {
    api.store.run(`UPDATE i_send SET status=?, fail_reason=?, updated_at=? WHERE send_id=?`, [status, reason, api.now().toISOString(), row.send_id]);
    audit(api.store, config, 'send_failed', row.lead_id, { reason }, 'system');
  }
  return rows.length;
}

function allowedTestId(config, senderId) {
  const ids = new Set((config.TG_TEST_LEAD_IDS || []).map(String));
  return ids.has(String(senderId));
}

function upsertConnection(api, row) {
  const userId = row.user && row.user.id != null ? String(row.user.id) : null;
  const userChat = row.user_chat_id != null ? String(row.user_chat_id) : null;
  api.store.run(
    `INSERT INTO i_tg_conn (business_connection_id, can_reply, is_enabled, updated_at, user_id, user_chat_id, broker_id, rights_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(business_connection_id) DO UPDATE SET
       can_reply=excluded.can_reply,
       is_enabled=excluded.is_enabled,
       updated_at=excluded.updated_at,
       user_id=COALESCE(excluded.user_id, i_tg_conn.user_id),
       user_chat_id=COALESCE(excluded.user_chat_id, i_tg_conn.user_chat_id),
       broker_id=COALESCE(excluded.broker_id, i_tg_conn.broker_id),
       rights_json=COALESCE(excluded.rights_json, i_tg_conn.rights_json)`,
    [
      row.id,
      row.rights && row.rights.can_reply ? 1 : 0,
      row.is_enabled ? 1 : 0,
      api.now().toISOString(),
      userId,
      userChat,
      userId,
      row.rights ? JSON.stringify(row.rights) : null,
    ],
  );
}

async function ensureConnection(api, config, id) {
  const row = api.store.one('SELECT * FROM i_tg_conn WHERE business_connection_id = ?', [id]);
  if (row && row.user_id) return { row };
  if (config.CHANNEL_MODE !== 'live') return { row };
  let remote = null;
  try {
    remote = await getBusinessConnection(config, id, api.fetch);
  } catch {
    return { error: true };
  }
  if (!remote || !remote.ok) {
    if (remote && remote.error_code === 'telegram_auth_failed') return { error: true, error_code: 'telegram_auth_failed' };
    return remote && remote.unknown ? { error: true } : { gone: true };
  }
  const connection = remote.connection;
  if (!connection || !connection.user || connection.user.id == null) return { gone: true };
  upsertConnection(api, connection);
  const saved = api.store.one('SELECT * FROM i_tg_conn WHERE business_connection_id = ?', [id]);
  if (!saved || !saved.user_id) return { error: true };
  return { row: saved };
}

function brokerOutbound(message, conn) {
  if (!message) return false;
  if (message.sender_business_bot) return true;
  if (message.from && message.from.is_bot) return true;
  if (message.is_from_offline) return true;
  if (conn && conn.user_id && message.from && String(message.from.id) === String(conn.user_id)) return true;
  return false;
}

function ingestWhatsAppInbound(api, config, payload) {
  const messages = whatsapp.inboundMessages(payload, whatsapp.providerOf(config));
  let stored = 0;
  for (const message of messages) {
    const result = ingest(api, config, {
      channel: 'whatsapp',
      sender_id: message.sender_id,
      sender_name: message.sender_name,
      text: message.text,
      kind: message.kind,
      received_at: message.received_at || undefined,
      dedup_key: message.message_id ? `wa:${message.message_id}` : undefined,
      reply_target: message.sender_id,
      broker_id: configuredBrokerId(config),
    });
    if (result && !result.duplicate) stored += 1;
  }
  return { received: messages.length, stored };
}

// Green API queues incoming events when the webhook cannot be called. Polling the queue is the
// fallback: same ingest path, dedupe by idMessage makes webhook+polling safe to run together.
async function pollWhatsApp(api, config) {
  const owner = configuredBrokerId(config);
  const brokers = new Set();
  try {
    for (const row of api.store.all("SELECT key FROM i_settings WHERE key LIKE 'wa_green_id::%'")) {
      brokers.add(String(row.key).slice('wa_green_id::'.length));
    }
  } catch { /* table may be empty */ }
  if (owner) brokers.add(String(owner));
  let received = 0;
  let stored = 0;
  let polled = 0;
  for (const broker of brokers) {
    const cfg = whatsapp.effectiveConfig(config, api.store, broker);
    if (whatsapp.providerOf(cfg) !== 'green') continue;
    polled += 1;
    const id = cfg.GREENAPI_ID_INSTANCE;
    const token = cfg.GREENAPI_API_TOKEN;
    const doFetch = api.fetch || fetch;
    const base = whatsapp.greenBase(cfg);
    for (let i = 0; i < 10; i += 1) {
      let response;
      try {
        response = await retry.fetchWithRetry(doFetch, `${base}/waInstance${encodeURIComponent(id)}/receiveNotification/${encodeURIComponent(token)}`, { method: 'GET' }, { attempts: 2, baseMs: 150, jitter: 0.2 });
      } catch {
        return { ok: false, error_code: 'poll_failed', received, stored };
      }
      if (!response || !response.ok) return { ok: false, error_code: 'poll_failed', received, stored };
      const data = await response.json().catch(() => null);
      if (!data || data.receiptId == null) break;
      if (data.body) {
        const part = ingestWhatsAppInbound(api, cfg, data.body, broker);
        received += part.received;
        stored += part.stored;
      }
      try {
        await doFetch(`${base}/waInstance${encodeURIComponent(id)}/deleteNotification/${encodeURIComponent(token)}/${encodeURIComponent(data.receiptId)}`, { method: 'DELETE' });
      } catch { /* the event is deduped on the next poll */ }
    }
  }
  return { ok: true, received, stored, polled };
}

function publicSettings(store) {
  const all = readSettings(store);
  for (const key of Object.keys(all)) {
    if (/^(wa_green_token|wa_cloud_token|wa_cloud_secret|wa_cloud_verify|wa_webhook_token)(::.*)?$/.test(key)) delete all[key];
  }
  return all;
}

function whatsappWebhookUrl(config, token) {
  const base = String((config && config.UI_PUBLIC_BASE) || '').replace(/\/$/, '');
  if (!base) return '';
  return `${base}/v1/intl/whatsapp${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}

function whatsappGatewayStatus(api, config, brokerId) {
  const eff = whatsapp.effectiveConfig(config, api.store, brokerId);
  const provider = whatsapp.providerOf(eff);
  const owner = configuredBrokerId(config);
  const ownScope = brokerId == null || String(brokerId) === '' || String(brokerId) === String(owner || '');
  const configured = provider !== 'none';
  const token = configured
    ? (bget(api.store, 'wa_webhook_token', brokerId)
      || (ownScope ? (setting(api.store, 'wa_webhook_token') || config.GREENAPI_WEBHOOK_TOKEN || '') : ''))
    : '';
  return {
    ok: true,
    gateway: provider,
    configured,
    webhook_url: configured ? whatsappWebhookUrl(eff, token) : '',
    green_id: Boolean(eff.GREENAPI_ID_INSTANCE),
    cloud_phone: Boolean(eff.WHATSAPP_PHONE_NUMBER_ID),
    cloud_verify: Boolean(eff.WHATSAPP_VERIFY_TOKEN),
    cloud_secret: Boolean(eff.WHATSAPP_APP_SECRET),
    live: config.CHANNEL_MODE === 'live',
  };
}

function whatsappTokenPayload(body) {
  return {
    gateway: body && body.gateway === 'cloud' ? 'cloud' : body && body.gateway === 'green' ? 'green' : '',
    id_instance: String((body && (body.id_instance || body.idInstance)) || '').trim(),
    api_token: String((body && (body.api_token || body.apiToken || body.apiTokenInstance)) || '').trim(),
    cloud_token: String((body && (body.cloud_token || body.access_token || body.token)) || '').trim(),
    cloud_phone_id: String((body && (body.phone_number_id || body.cloud_phone_id)) || '').trim(),
    cloud_verify: String((body && (body.verify_token || body.cloud_verify)) || '').trim(),
    cloud_secret: String((body && (body.app_secret || body.cloud_secret)) || '').trim(),
  };
}

async function whatsappConnectGateway(api, config, body, actor) {
  const input = whatsappTokenPayload(body);
  const checked = validation.validateGatewayPayload(input);
  if (!checked.ok) return { ok: false, status: 400, error_code: checked.error || 'invalid_credentials', field: checked.field || '' };
  const doFetch = api.fetch || fetch;
  const owner = configuredBrokerId(config);
  const isOwner = String(actor || '') === String(owner || '');
  const readKey = (key) => bget(api.store, key, actor) || (isOwner ? setting(api.store, key) : '');
  const writeKey = (key, value) => {
    bset(api.store, key, actor, value);
    if (isOwner) setting(api.store, key, value);
  };
  if (input.gateway === 'green') {
    const rows = api.store.all("SELECT key FROM i_settings WHERE key LIKE 'wa_green_id%' AND value = ?", [input.id_instance]);
    const conflict = rows.some((row) => {
      const key = String(row.key || '');
      if (!key.includes('::')) return String(actor || '') !== String(owner || '');
      return key.slice(key.indexOf('::') + 2) !== String(actor || '');
    });
    if (conflict) return { ok: false, status: 409, error_code: 'instance_already_connected' };
  }
  const webhookToken = readKey('wa_webhook_token') || crypto.randomBytes(16).toString('hex');
  writeKey('wa_webhook_token', webhookToken);

  if (input.gateway === 'green') {
    writeKey('wa_gateway', 'green');
    writeKey('wa_green_id', input.id_instance);
    writeKey('wa_green_token', input.api_token);
    const eff = whatsapp.effectiveConfig(config, api.store, actor);
    const baseUrl = whatsapp.greenBase(eff);
    const inst = encodeURIComponent(input.id_instance);
    const tok = encodeURIComponent(input.api_token);
    let state = 'unknown';
    try {
      const stateRes = await retry.fetchWithRetry(doFetch, `${baseUrl}/waInstance${inst}/getStateInstance/${tok}`, { method: 'GET' }, { attempts: 2, baseMs: 150, jitter: 0.2 });
      const stateData = await stateRes.json().catch(() => ({}));
      if (stateData && stateData.stateInstance) state = String(stateData.stateInstance);
    } catch { /* state is optional */ }
    const webhookUrl = whatsappWebhookUrl(eff, webhookToken);
    let webhookSet = false;
    if (webhookUrl) {
      try {
        const hookRes = await retry.fetchWithRetry(doFetch, `${baseUrl}/waInstance${inst}/setSettings/${tok}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ webhookUrl, incomingWebhook: 'yes', outgoingMessageWebhook: 'no', outgoingAPIMessageWebhook: 'no', stateWebhook: 'no' }),
        }, { attempts: 2, baseMs: 150, jitter: 0.2 });
        const hookData = await hookRes.json().catch(() => ({}));
        webhookSet = Boolean(hookData && hookData.saveSettings);
      } catch { /* the polling fallback keeps inbound working */ }
    }
    let qr = null;
    if (state !== 'authorized') {
      try {
        const qrRes = await retry.fetchWithRetry(doFetch, `${baseUrl}/waInstance${inst}/qr/${tok}`, { method: 'GET' }, { attempts: 2, baseMs: 150, jitter: 0.2 });
        const qrData = await qrRes.json().catch(() => ({}));
        if (qrRes.ok && qrData && qrData.message) {
          const message = String(qrData.message);
          qr = message.startsWith('data:') ? message : `data:image/png;base64,${message}`;
        }
      } catch { /* the broker can also scan inside the Green API console */ }
    }
    audit(api.store, config, 'whatsapp_connect', null, { gateway: 'green', broker: String(actor || ''), webhook_set: webhookSet }, actor || 'broker');
    return { ...whatsappGatewayStatus(api, config, actor), state, authorized: state === 'authorized', webhook_set: webhookSet, qr };
  }

  writeKey('wa_gateway', 'cloud');
  writeKey('wa_cloud_token', input.cloud_token);
  writeKey('wa_cloud_phone_id', input.cloud_phone_id);
  writeKey('wa_cloud_verify', input.cloud_verify);
  writeKey('wa_cloud_secret', input.cloud_secret);
  audit(api.store, config, 'whatsapp_connect', null, { gateway: 'cloud', broker: String(actor || '') }, actor || 'broker');
  return {
    ...whatsappGatewayStatus(api, config, actor),
    state: 'configured',
    authorized: true,
    webhook_set: false,
    meta_note: 'set_webhook_in_meta',
    verify_token: input.cloud_verify,
  };
}

function whatsappDisconnectGateway(api, config, actor) {
  const keys = ['wa_gateway', 'wa_green_id', 'wa_green_token', 'wa_cloud_token', 'wa_cloud_phone_id', 'wa_cloud_verify', 'wa_cloud_secret', 'wa_webhook_token'];
  for (const key of keys) {
    api.store.run('DELETE FROM i_settings WHERE key = ?', [key + '::' + String(actor || '')]);
    if (String(actor || '') === String(configuredBrokerId(config) || '')) {
      api.store.run('DELETE FROM i_settings WHERE key = ?', [key]);
    }
  }
  audit(api.store, config, 'whatsapp_disconnect', null, { broker: String(actor || '') }, actor || 'broker');
  return { ...whatsappGatewayStatus(api, config, actor), disconnected: true };
}

function applyWhatsApp(api, config, rawBody, headers, queryToken) {
  const token = String(queryToken || '');
  let brokerId = brokerForWebhookToken(api.store, token);
  if (!brokerId) {
    const globalToken = setting(api.store, 'wa_webhook_token') || '';
    if (!globalToken || token === globalToken) brokerId = configuredBrokerId(config) || '';
    else return { ok: false, status: 403, error_code: 'forbidden' };
  }
  config = whatsapp.effectiveConfig(config, api.store, brokerId);
  if (config.CHANNEL_MODE !== 'live') return { ok: false, status: 403, error_code: 'sim_only' };
  const provider = whatsapp.providerOf(config);
  if (!provider) return { ok: false, status: 503, error_code: 'whatsapp_not_configured' };
  if (provider === 'cloud') {
    if (!config.WHATSAPP_VERIFY_TOKEN || !config.WHATSAPP_APP_SECRET) return { ok: false, status: 503, error_code: 'whatsapp_not_configured' };
    const checked = whatsapp.verifySignature(config, rawBody, headers);
    if (!checked.ok) return checked;
  } else {
    const checked = whatsapp.verifyWebhookToken(config, queryToken);
    if (!checked.ok) return checked;
  }
  let payload = null;
  try { payload = JSON.parse(String(rawBody || '{}')); } catch { return { ok: false, status: 400, error_code: 'invalid_json' }; }
  return { ok: true, status: 200, ...ingestWhatsAppInbound(api, config, payload, brokerId) };
}

async function applyTelegram(api, config, update) {
  if (update.update_id != null) {
    const seen = api.store.one('SELECT update_id FROM i_tg_update WHERE update_id=?', [update.update_id]);
    if (seen) return { ok: true, duplicate: true };
  }
  let result;
  try {
    result = await dispatchTelegram(api, config, update);
    if (isPromise(result)) result = await result;
  } catch {
    return { ok: false, status: 500, error_code: 'ingest_failed' };
  }
  if (update.update_id != null && result && result.ok !== false && result.status !== 500) {
    try {
      api.store.run('INSERT INTO i_tg_update (update_id) VALUES (?)', [update.update_id]);
    } catch (err) {
      if (/UNIQUE/i.test(String(err && err.message))) return { ok: true, duplicate: true };
      throw err;
    }
  }
  return result;
}

async function dispatchTelegram(api, config, update) {
  if (update.business_connection) upsertConnection(api, update.business_connection);
  if (update.edited_business_message) return editBusiness(api, config, update.edited_business_message);
  if (update.deleted_business_messages) {
    const deleted = update.deleted_business_messages;
    const chatId = String(deleted.chat?.id || '');
    if (!chatId) return { ok: false, status: 400, error_code: 'chat_required' };
    for (const id of deleted.message_ids || []) {
      api.store.run(`UPDATE i_message SET text = '', deleted = 1 WHERE dedup_key = ?`, [`telegram:${chatId}:${id}`]);
    }
    return { ok: true, deleted: true };
  }
  if (update.business_message) return ingestBusinessMessage(api, config, update.business_message);
  return ingestPlainMessage(api, config, update.message);
}

function ingestPlainMessage(api, config, message) {
  if (!message) return { ok: true, ignored: true };
  const chatId = String(message.chat?.id || '');
  const text = String(message.text || '').trim();
  if (text === '/digest') {
    const allowed = new Set((config.TELEGRAM_ALLOWED_USER_IDS || []).map(String));
    if (!allowed.has(chatId) && !allowed.has('*')) return { ok: false, error_code: 'forbidden', digest_sent_on_demand: false };
    const result = runDigest(api, config, 'demand', chatId);
    if (config.CHANNEL_MODE === 'live' && result && result.digest) {
      return deliverDigestModule(config, result.digest, api.fetch).then((delivery) => ({
        ...result,
        ...delivery,
      }));
    }
    return { ...result, sent: false, telegram_delivery: false };
  }
  if (text.startsWith('/start')) {
    return {
      ok: true,
      text: 'Добро пожаловать в FastCRM! Откройте веб-приложение для управления заявками, объектами и расписанием показов.',
    };
  }
  return ingestFixtureMessage(api, config, message, {
    business: false,
    brokerId: (config.TELEGRAM_ALLOWED_USER_IDS || [])[0] || 'admin',
    senderId: message.from && message.from.id != null ? String(message.from.id) : chatId,
  });
}

async function ingestBusinessMessage(api, config, message) {
  const connId = message.business_connection_id;
  if (!connId) {
    if (config.CHANNEL_MODE === 'live') return { ok: false, status: 500, error_code: 'connection_unknown' };
    return { ok: true, stored: false, ignored: true, reason: 'connection_unknown' };
  }
  const looked = await ensureConnection(api, config, connId);
  if (looked.gone) {
    audit(api.store, config, 'connection_gone', null, { business_connection_id: connId }, 'system');
    return { ok: true, stored: false, ignored: true, reason: 'connection_gone' };
  }
  if (looked.error || !looked.row || !looked.row.user_id) {
    if (config.CHANNEL_MODE === 'live') {
      return { ok: false, status: 500, error_code: looked.error_code || 'connection_unknown' };
    }
    return { ok: true, stored: false, ignored: true, reason: 'connection_unknown' };
  }
  const conn = looked.row;
  const chat = message.chat || {};
  if (chat.type && chat.type !== 'private') return { ok: true, stored: false, ignored: true };
  if (brokerOutbound(message, conn)) return { ok: true, stored: false, ignored: true, reason: 'outbound' };
  return ingestFixtureMessage(api, config, message, {
    business: true,
    brokerId: String(conn.user_id),
    senderId: message.from && message.from.id != null ? String(message.from.id) : String(chat.id || ''),
  });
}

async function ingestFixtureMessage(api, config, message, mode) {
  const chatId = String(message.chat?.id || '');
  let text = message.text || message.caption || '';
  if (!text && (message.voice || message.audio)) {
    const token = config.TELEGRAM_BOT_TOKEN;
    const gemKey = process.env.GEMINI_API_KEY;
    if (token && gemKey) {
      try {
        const transcript = await processVoiceMessage(token, gemKey, message);
        if (transcript) {
          text = `🎙 [Голосовое]: ${transcript}`;
        }
      } catch (err) {
        console.warn('Voice transcription failed:', err.message);
      }
    }
  }
  const leadCmd = String(message.text || '').match(/^\/lead\s+(P\d+)\s+([\s\S]+)$/);
  const propertyId = leadCmd ? leadCmd[1] : (message.property_id || '');
  const body = leadCmd ? leadCmd[2] : text;
  const hasMedia = Boolean(message.photo || message.voice || message.document || message.video || message.location || message.sticker);
  const kind = hasMedia && !String(body).trim() ? 'non_text' : 'text';
  const received = message.date ? new Date(message.date * 1000) : api.now();
  return ingest(api, config, {
    channel: 'telegram',
    sender_id: mode.senderId || chatId,
    sender_name: message.from?.first_name || 'Telegram',
    text: body,
    property_id: propertyId,
    kind,
    non_text_type: message.photo ? 'photo' : message.voice ? 'voice' : message.document ? 'document' : message.video ? 'video' : message.location ? 'location' : null,
    dedup_key: `telegram:${chatId}:${message.message_id}`,
    channel_msg_id: String(message.message_id),
    reply_target: chatId,
    business_connection_id: message.business_connection_id || null,
    received_at: received.toISOString(),
    business: mode.business === true,
    append_open: mode.business === true,
    broker_id: mode.brokerId || null,
  });
}

function editBusiness(api, config, message) {
  const chatId = String(message.chat?.id || '');
  const row = api.store.one('SELECT * FROM i_message WHERE dedup_key = ?', [`telegram:${chatId}:${message.message_id}`]);
  if (!row) return { ok: true, missing: true };
  const text = message.text || message.caption || '';
  api.store.run('UPDATE i_message SET text=?, edited=1 WHERE id=?', [text, row.id]);
  const lead = loadLead(api.store, row.lead_id);
  return { ok: true, same_lead: true, lead_id: lead ? lead.id : row.lead_id, status: lead ? lead.status : null, edited: true };
}


module.exports = {
  createIntl,
  senderHash,
  AI_EN,
  AI_RU,
  STOP_EN,
  STOP_RU,
  LEAD_STATUSES,
  VIEWING_STATUSES,
};
