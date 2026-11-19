'use strict';

const { DateTime } = require('luxon');
const { sortLeads } = require('./score');

function buildDigest(api, config, { loadLead, propertyRow }) {
  const now = api.now();
  const zone = config.BROKER_TZ || 'Asia/Dubai';
  const leads = api.store.all('SELECT id FROM i_lead').map((row) => loadLead(api.store, row.id));
  const waiting = leads.filter((lead) => lead.status !== 'stopped' && lead.status !== 'sent' && lead.status !== 'archived' && !lead.optout);
  const ordered = sortLeads(waiting, 'digest');
  const writeFirst = ordered.map((lead) => ({
    id: lead.id,
    name: lead.clean_name || lead.sender_name,
    grade: lead.grade,
    property_id: lead.property_id,
    waiting_minutes: Math.round((now.getTime() - Date.parse(lead.first_msg_at)) / 60000),
  }));
  const today = DateTime.fromJSDate(now, { zone }).toISODate();
  const viewings = api.store.all(`SELECT * FROM i_viewing WHERE status != 'cancelled'`).filter((row) => {
    return DateTime.fromISO(row.start_utc, { setZone: true }).setZone(zone).toISODate() === today;
  });
  const hot = leads.filter((lead) => lead.grade === 'HOT' && lead.pipeline !== 'closed' && !lead.optout && lead.status !== 'stopped' && lead.status !== 'archived');
  const seen = new Set();
  const groups = {};
  for (const lead of hot) {
    if (seen.has(lead.property_id)) continue;
    seen.add(lead.property_id);
    const property = propertyRow(api.store, lead.property_id);
    if (!property || !property.price) continue;
    const key = `${property.kind}|${property.currency}|${property.price_period}`;
    groups[key] = groups[key] || { kind: property.kind, currency: property.currency, period: property.price_period, sum: 0 };
    groups[key].sum = Math.round((groups[key].sum + Number(property.price)) * 100) / 100;
  }
  return {
    ok: true,
    write_first: writeFirst.slice(0, 5),
    write_first_full: writeFirst,
    viewings_today: viewings,
    listed_value: Object.values(groups),
    note: 'Sum of listing prices, not revenue, commission or forecast',
    empty: writeFirst.length === 0,
  };
}

function runDigest(api, config, reason, actorId, { loadLead, propertyRow, setting, audit }) {
  const zone = config.BROKER_TZ || 'Asia/Dubai';
  const local = DateTime.fromJSDate(api.now(), { zone });
  const today = local.toISODate();
  const sentOn = setting(api.store, 'digest_last_sent_date');
  const count = Number(setting(api.store, 'digest_sent_count') || 0);
  if (reason === 'demand') {
    const allowed = new Set((config.TELEGRAM_ALLOWED_USER_IDS || []).map(String));
    if (!allowed.has('*') && !allowed.has(String(actorId || ''))) return { ok: false, digest_sent_on_demand: false };
    audit(api.store, config, 'digest_sent', null, { on_demand: true }, String(actorId));
    return { ok: true, digest_sent_on_demand: true, digest: buildDigest(api, config, { loadLead, propertyRow }) };
  }
  if (setting(api.store, 'digest_enabled') === '0') return { ok: true, digest_sent: count, disabled: true };
  const configuredTime = setting(api.store, 'digest_time') || config.DIGEST_TIME || '08:30';
  const [hour, minute] = String(configuredTime).split(':').map(Number);
  const due = local.hour > hour || (local.hour === hour && local.minute >= minute);
  if (!due || sentOn === today) return { ok: true, digest_sent: count, skipped: sentOn === today };
  const onTheMinute = local.hour === hour && local.minute === minute && reason === 'schedule';
  const label = onTheMinute ? '' : 'late';
  setting(api.store, 'digest_last_sent_date', today);
  setting(api.store, 'digest_sent_count', count + 1);
  setting(api.store, 'digest_last_label', label);
  audit(api.store, config, 'digest_sent', null, { label: label || 'on_time' }, 'system');
  return { ok: true, digest_sent: count + 1, label, digest: buildDigest(api, config, { loadLead, propertyRow }) };
}

module.exports = {
  buildDigest,
  runDigest,
};
