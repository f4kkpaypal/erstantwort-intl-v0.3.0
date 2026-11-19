'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { loadConfig, listenHost, secretConfigured, intlDatabaseUrl } = require('../core/config');
const { verifyInitData, allowedTelegramIds } = require('../core/uiAuth');
const { createIntl } = require('../core/intl/service');
const { clientIp, rateAllow } = require('../core/clientIp');
const { generateRepliesWithGemini } = require('../core/intl/gemini');
const { generateRepliesWithDeepSeek } = require('../core/intl/deepseek');
const { filterGrounded } = require('../core/intl/grounding');
const { setWebhook, getWebhookInfo } = require('../core/intl/telegramSend');
const validation = require('../core/intl/validation');

const UI_ROOT = path.join(__dirname, '..', 'ui-intl');
const hits = new Map();

// External reply options (DeepSeek/Gemini) are an explicit opt-in: every call sends the lead name,
// the inbound text and the property card to a third party. Default is OFF (INTL_AI_OPTIONS=false).
const AI_CACHE_HARD_LIMIT = 2000;

function aiOptionsEnabled(config) {
  if (!config || config.INTL_AI_OPTIONS !== true) return false;
  if (!config.DEEPSEEK_API_KEY && !config.GEMINI_API_KEY) return false;
  // Real people on the live channel require the real-data opt-in as well.
  if (config.CHANNEL_MODE === 'live' && config.REAL_DATA_ALLOWED !== true) return false;
  return true;
}

// Bounded cache: TTL and size come from config, so a long-running process cannot grow without
// limit and cannot serve stale options whose free slots were booked months ago.
const aiOptionsCache = new Map();
const aiInFlight = new Set();

function mergeOptions(base, extra, limit = 3) {
  // Keep exactly three cards: grounded AI options first, rule-based ones fill the gap.
  const out = [];
  const seen = new Set();
  for (const row of [...(base || []), ...(extra || [])]) {
    const text = String((row && row.text) || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

function aiCacheGet(id, config) {
  const entry = aiOptionsCache.get(id);
  if (!entry) return null;
  const ttlMs = Math.max(1, Number(config && config.AI_OPTIONS_TTL_S) || 900) * 1000;
  if (Date.now() - entry.at > ttlMs) {
    aiOptionsCache.delete(id);
    return null;
  }
  return entry.options;
}

function aiCacheSet(id, options, config) {
  const limit = Math.min(Math.max(Number(config && config.AI_OPTIONS_MAX) || 200, 1), AI_CACHE_HARD_LIMIT);
  if (aiOptionsCache.size >= limit) {
    const oldest = aiOptionsCache.keys().next().value;
    if (oldest !== undefined) aiOptionsCache.delete(oldest);
  }
  aiOptionsCache.set(id, { at: Date.now(), options });
}

function aiCacheClear() {
  aiOptionsCache.clear();
  aiInFlight.clear();
}

function enrichLeadAiAsync(lead, user, config) {
  if (!lead || lead.status === 'stopped' || lead.status === 'review') return;
  if (!aiOptionsEnabled(config)) return;
  const leadId = lead.id;
  if (aiCacheGet(leadId, config) || aiInFlight.has(leadId)) return;
  const { lastInboundText, propertyGrounding } = require('../core/intl/desk');
  const grounded = propertyGrounding(lead.property || {});
  const leadPayload = {
    clean_name: lead.clean_name,
    sender_name: lead.sender_name,
    text: lastInboundText(lead),
    intent: lead.intent,
    score: lead.grade || (lead.score >= 70 ? 'HOT' : lead.score < 30 ? 'COLD' : 'WARM'),
    language: lead.language || 'ru',
  };
  const leadContext = {
    property: { ...(lead.property || {}), ...grounded, location: grounded.district },
    slots: lead.slots || [],
  };

  const dsKey = config.DEEPSEEK_API_KEY;
  if (dsKey) {
    aiInFlight.add(leadId);
    generateRepliesWithDeepSeek(dsKey, leadPayload, leadContext)
      .then(dsRes => {
        if (!dsRes.ok || !dsRes.options?.length) return;
        const grounded = filterGrounded(dsRes.options, lead.property || {});
        if (grounded.rejected.length) console.warn('ai_options_rejected', grounded.rejected.length);
        const merged = mergeOptions(grounded.kept, lead.options);
        if (merged.length) aiCacheSet(leadId, merged, config);
      })
      .catch(err => console.warn('Async DeepSeek error:', err.message))
      .finally(() => aiInFlight.delete(leadId));
    return;
  }
  const gemKey = config.GEMINI_API_KEY;
  if (gemKey) {
    aiInFlight.add(leadId);
    generateRepliesWithGemini(gemKey, leadPayload, leadContext)
      .then(gemRes => {
        if (!gemRes.ok || !gemRes.options?.length) return;
        const grounded = filterGrounded(gemRes.options, lead.property || {});
        if (grounded.rejected.length) console.warn('ai_options_rejected', grounded.rejected.length);
        const merged = mergeOptions(grounded.kept, lead.options);
        if (merged.length) aiCacheSet(leadId, merged, config);
      })
      .catch(err => console.warn('Async Gemini error:', err.message))
      .finally(() => aiInFlight.delete(leadId));
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; frame-src 'self' blob:; connect-src 'self'",
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 900000) {
        reject(Object.assign(new Error('body_too_large'), { code: 'body_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 900000) {
        reject(Object.assign(new Error('body_too_large'), { code: 'body_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(Object.assign(new Error('invalid_json'), { code: 'invalid_json' })); }
    });
    req.on('error', reject);
  });
}

function ownerTelegramId(config) {
  const explicit = String(config.OWNER_TELEGRAM_ID || '').trim();
  if (explicit) return explicit;
  const profile = String((config.MAKLER_PROFILE && config.MAKLER_PROFILE.telegram_user_id) || '').trim();
  if (profile) return profile;
  const ids = (config.TELEGRAM_ALLOWED_USER_IDS || []).map(String).filter((id) => id && id !== '*');
  return ids[0] || '';
}

function ownerOnlyRoute(req, pathname) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return false;
  return pathname === '/v1/intl/settings'
    || pathname === '/v1/intl/templates'
    || pathname === '/v1/intl/seed'
    || pathname === '/v1/intl/whatsapp/connect'
    || pathname === '/v1/intl/whatsapp/disconnect';
}

function authorize(req, config) {
  if (config.DEMO_UI_NO_AUTH === true || config.DEMO_UI_NO_AUTH === 'true') {
    return { ok: true, user: { id: 5031998736, first_name: 'Broker', owner: true } };
  }
  const header = String(req.headers.authorization || '');
  const initData = header.toLowerCase().startsWith('tma ') ? header.slice(4).trim() : '';
  const checked = verifyInitData(initData, config.TELEGRAM_BOT_TOKEN, { maxAgeS: config.UI_INITDATA_MAX_AGE_S });
  if (!checked.ok) return { ok: false, status: 401, error_code: 'unauthorized' };
  // Multi-user support: allow any verified Telegram user if '*' or MULTI_USER=true
  const allowed = allowedTelegramIds(config);
  if (config.MULTI_USER !== true && config.MULTI_USER !== 'true' && allowed.size > 0 && !allowed.has('*') && !allowed.has(checked.user.id)) {
    return { ok: false, status: 403, error_code: 'forbidden' };
  }
  const ownerId = ownerTelegramId(config);
  checked.user.owner = Boolean(ownerId) && String(checked.user.id) === ownerId;
  return { ok: true, user: checked.user };
}

const WEBHOOK_SECRET_RE = /^[A-Za-z0-9_-]{1,256}$/;

function bootError(config) {
  if (config.CHANNEL_MODE === 'invalid') return 'channel_mode_invalid';
  if (!secretConfigured(config.HASH_SALT)) return 'hash_salt_missing';
  if ((config.REAL_DATA_ALLOWED === true || config.REAL_DATA_ALLOWED === 'true') && !config.ALLOW_REAL_DATA) {
    return 'real_data_blocked';
  }
  if ((config.DEMO_UI_NO_AUTH === true || config.DEMO_UI_NO_AUTH === 'true') &&
      config.UI_PUBLIC_BASE &&
      String(config.UI_PUBLIC_BASE).startsWith('https://') &&
      !config.ALLOW_INSECURE_DEV) {
    return 'demo_ui_no_auth_blocked';
  }
  if (config.CHANNEL_MODE === 'live') {
    if (!intlDatabaseUrl(config) && !config.ALLOW_SQLITE_LIVE) return 'postgres_required';
    if (!secretConfigured(config.TELEGRAM_BOT_TOKEN)) return 'telegram_token_missing';
    if (!validation.isTelegramToken(config.TELEGRAM_BOT_TOKEN)) return 'telegram_token_invalid';
    if (config.TELEGRAM_WEBHOOK_SECRET && !WEBHOOK_SECRET_RE.test(config.TELEGRAM_WEBHOOK_SECRET)) {
      return 'webhook_secret_invalid';
    }
    if (config.MULTI_USER !== true && config.MULTI_USER !== 'true' && (!config.TELEGRAM_ALLOWED_USER_IDS || !config.TELEGRAM_ALLOWED_USER_IDS.length)) {
      return 'telegram_allowlist_missing';
    }
    const waProvider = String(config.WHATSAPP_PROVIDER || '').toLowerCase();
    const greenSelected = waProvider === 'green' || (!waProvider && config.GREENAPI_ID_INSTANCE && config.GREENAPI_API_TOKEN);
    if (greenSelected) {
      if (!config.GREENAPI_ID_INSTANCE || !config.GREENAPI_API_TOKEN) return 'whatsapp_config_incomplete';
      if (!validation.isGreenInstance(config.GREENAPI_ID_INSTANCE) || !validation.isGreenToken(config.GREENAPI_API_TOKEN)) return 'whatsapp_credentials_invalid';
      if (!config.GREENAPI_WEBHOOK_TOKEN) return 'whatsapp_webhook_token_missing';
    } else if (waProvider === 'cloud' || config.WHATSAPP_TOKEN) {
      if (!config.WHATSAPP_TOKEN || !config.WHATSAPP_PHONE_NUMBER_ID || !config.WHATSAPP_VERIFY_TOKEN || !config.WHATSAPP_APP_SECRET) {
        return 'whatsapp_config_incomplete';
      }
      const cloud = validation.validateCloudCredentials({
        cloud_token: config.WHATSAPP_TOKEN,
        cloud_phone_id: config.WHATSAPP_PHONE_NUMBER_ID,
        cloud_verify: config.WHATSAPP_VERIFY_TOKEN,
        cloud_secret: config.WHATSAPP_APP_SECRET,
      });
      if (!cloud.ok) return 'whatsapp_credentials_invalid';
    }
    // Real people on the live channel are real data. Both flags keep one honest switch:
    // either the operator accepts processing real leads, or the channel stays sim.
    if (config.REAL_DATA_ALLOWED !== true || config.ALLOW_REAL_DATA !== true) {
      return 'real_data_required_for_live';
    }
  }
  return '';
}

function storeName(intl) {
  return intl && intl.store && intl.store.url ? 'postgres' : 'sqlite';
}

function pingStore(intl) {
  const row = intl.store.one('SELECT 1 AS n');
  if (!row || Number(row.n) !== 1) throw new Error('store_unavailable');
}

function webhookSecretOk(expected, got) {
  const a = Buffer.from(String(expected || ''));
  const b = Buffer.from(String(got || ''));
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function applyHttpTimeouts(server) {
  // Bound slowloris / hung proxies; keepAlive below typical reverse-proxy idle.
  server.requestTimeout = 60_000;
  server.headersTimeout = 65_000;
  server.keepAliveTimeout = 65_000;
  server.timeout = 120_000;
  return server;
}

function listenPort(env = process.env) {
  // PaaS (Render) injects PORT; compose uses INTL_PORT. Prefer PORT when set.
  const raw = env.PORT || env.INTL_PORT || env.ENGINE_PORT || 8791;
  const port = Number(raw);
  return Number.isFinite(port) && port > 0 ? port : 8791;
}

function buildIntlServer(config, intl, options = {}) {
  const state = options.state || { draining: false };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://intl.local');
    const pathname = url.pathname.replace(/\/$/, '') || '/';
    try {
      if (req.method === 'GET' && (pathname === '/healthz' || pathname === '/readyz')) {
        if (state.draining) {
          res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('draining');
          return;
        }
        const store = storeName(intl);
        try {
          pingStore(intl);
        } catch {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('store_unavailable');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`ok ${store}`);
        return;
      }
      if (req.method === 'GET' && pathname === '/v1/health') {
        const store = storeName(intl);
        try {
          pingStore(intl);
        } catch {
          sendJson(res, 500, { ok: false, error_code: 'store_unavailable', store });
          return;
        }
        const webhook = intl.webhookState || {};
        sendJson(res, 200, {
          ok: true,
          product_mode: config.PRODUCT_MODE,
          channel_mode: config.CHANNEL_MODE,
          live_autosend: config.INTL_LIVE_AUTOSEND === true,
          demo_ui: config.DEMO_UI_NO_AUTH === true,
          store,
          whatsapp_ui: config.INTL_WHATSAPP_UI === true,
          webhook_url_set: webhook.url_set === true,
          ephemeral: config.EPHEMERAL_DISK === true,
          trust_proxy: config.TRUST_PROXY === true ? 1 : (Number(config.TRUST_PROXY) || 0),
        });
        return;
      }
      if (req.method === 'POST' && pathname === '/v1/intl/client-error') {
        let body;
        try {
          body = await readBody(req);
        } catch {
          sendJson(res, 400, { ok: false, error_code: 'invalid_json' });
          return;
        }
        const ip = clientIp(req, config.TRUST_PROXY);
        if (!rateAllow(hits, 'client-error:' + ip, Date.now(), { limit: 30, windowMs: 60000 })) {
          sendJson(res, 429, { ok: false, error_code: 'rate_limited' });
          return;
        }
        const message = String(body.message || '').slice(0, 300).replace(/[\r\n\t]+/g, ' ');
        const screen = String(body.screen || '').slice(0, 40).replace(/[^a-z0-9_-]/gi, '');
        console.error('intl_client_error screen=' + (screen || 'unknown') + ' message=' + message);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === 'GET' && !pathname.startsWith('/v1/')) {
        serveStatic(res, pathname);
        return;
      }
      const pub = pathname.match(/^\/v1\/intl\/public\/files\/([^/]+)$/);
      if (pub && req.method === 'GET') {
        const result = await intl.publicFile(decodeURIComponent(pub[1]), url.searchParams.get('exp'), url.searchParams.get('sig'));
        if (result && Buffer.isBuffer(result.body_bytes)) {
          res.writeHead(result.status || 200, result.headers || {});
          res.end(result.body_bytes);
          return;
        }
        sendJson(res, Number.isInteger(result.status) ? result.status : 404, result);
        return;
      }
      if (pathname === '/v1/intl/whatsapp' && req.method === 'GET') {
        const view = intl.whatsappVerify(url.searchParams);
        if (!view.ok) {
          res.writeHead(view.status || 403, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('forbidden');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(view.challenge);
        return;
      }
      if (pathname === '/v1/intl/whatsapp' && req.method === 'POST') {
        let raw = '';
        try {
          raw = await readRawBody(req);
        } catch (err) {
          sendJson(res, 400, { ok: false, error_code: err.code || 'invalid_json' });
          return;
        }
        console.log('whatsapp_webhook bytes=' + raw.length);
        const result = await intl.whatsappWebhook(raw, req.headers, url.searchParams.get('token'));
        const status = result && Number.isInteger(result.status) ? result.status : 200;
        sendJson(res, status, { ...result, whatsapp_delivery: false });
        return;
      }
      if (req.method === 'POST' && pathname === '/v1/intl/telegram') {
        if (!webhookSecretOk(config.TELEGRAM_WEBHOOK_SECRET, req.headers['x-telegram-bot-api-secret-token'])) {
          sendJson(res, 403, { ok: false, error_code: 'forbidden' });
          return;
        }
        let update;
        try {
          update = await readBody(req);
        } catch (err) {
          const code = err.code || 'invalid_json';
          console.error(code);
          sendJson(res, 200, { ok: false, error_code: code, telegram_delivery: false });
          return;
        }
        const result = await intl.telegram(update);
        if (result && (result.error_code === 'invalid_json' || result.error_code === 'chat_required')) console.error(result.error_code);
        const status = result && result.status === 500 ? 500 : 200;
        sendJson(res, status, { ...result, telegram_delivery: false });
        return;
      }
      const auth = authorize(req, config);
      if (!auth.ok) {
        sendJson(res, auth.status, { ok: false, error_code: auth.error_code, message: auth.status === 403 ? 'This bot is not public.' : 'Sign-in required.' });
        return;
      }
      const ip = clientIp(req, config.TRUST_PROXY);
      const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === 'local' || ip === 'localhost';
      if (!isLoopback && !config.DEMO_UI_NO_AUTH && !rateAllow(hits, ip, Date.now(), { limit: 1000, windowMs: 60 * 1000 })) {
        sendJson(res, 429, { ok: false, error_code: 'rate_limited', message: 'Too many requests.' });
        return;
      }
      const body = req.method === 'GET' ? {} : await readBody(req);
      const result = await route(intl, config, req, pathname, body, auth.user, url);
      if (result && Buffer.isBuffer(result.body_bytes)) {
        res.writeHead(result.status || 200, result.headers || {});
        res.end(result.body_bytes);
        return;
      }
      sendJson(res, Number.isInteger(result.status) ? result.status : (result.ok === false ? 400 : 200), result);
    } catch (err) {
      const code = err.code === 'invalid_json' || err.code === 'body_too_large' ? 400 : 500;
      if (code === 500) console.error('intl_request_failed method=' + req.method + ' path=' + pathname + ' code=' + (err.code || 'internal'));
      sendJson(res, code, { ok: false, error_code: err.code || 'internal', message: 'Request failed.' });
    }
  });
  return applyHttpTimeouts(server);
}

function accessLead(intl, id, user, { write = false } = {}) {
  const row = intl.store.one('SELECT id, broker_id FROM i_lead WHERE id = ?', [id]);
  if (!row) return { ok: false, status: 404, error_code: 'not_found' };
  const access = intl.accessLead(row.broker_id, user.id, { write });
  if (!access.ok) return access;
  return null;
}

function workspaceFrom(url, user, intl) {
  const requested = url.searchParams.get('workspace') || '';
  return intl.resolveWorkspace(user.id, requested);
}

async function route(intl, config, req, pathname, body, user, url) {
  if (req.method === 'POST' && pathname === '/v1/sim/wa/inbound') {
    if (config.CHANNEL_MODE !== 'sim') return { ok: false, status: 403, error_code: 'sim_only' };
    return intl.ingest({
      channel: 'wa_sim',
      sender_id: body.from_id,
      sender_name: body.name,
      text: body.text,
      property_id: body.property_id,
      kind: body.kind || 'text',
      non_text_type: body.non_text_type,
      dedup_key: `wa_sim:${body.session_id || 'local'}:${body.msg_id || Date.now()}`,
      reply_target: body.session_id || 'local',
      broker_id: String(user.id),
    });
  }
  if (req.method === 'GET' && pathname === '/v1/intl/leads') {
    const workspace = workspaceFrom(url, user, intl);
    if (!workspace.ok) return workspace;
    const list = intl.leads({
      archived: url.searchParams.get('archived') === '1',
      property_id: url.searchParams.get('property_id') || '',
      broker_id: workspace.broker_id,
      q: url.searchParams.get('q') || '',
    }).map((lead) => ({
      ...lead,
      workspace_owner_id: workspace.workspace_owner_id,
      workspace_role: workspace.role,
    }));
    // Pre-warm AI options in the background, but only when the operator opted in.
    if (aiOptionsEnabled(config) && workspace.can_write) {
      for (const item of list.slice(0, 5)) {
        if (!aiCacheGet(item.id, config)) {
          Promise.resolve(intl.lead(item.id, user.id)).then(l => {
            if (l) enrichLeadAiAsync(l, user, config);
          }).catch(() => {});
        }
      }
    }
    return {
      ok: true,
      leads: list,
      workspace_owner_id: workspace.workspace_owner_id,
      workspace_role: workspace.role,
      can_write: workspace.can_write,
    };
  }
  const one = pathname.match(/^\/v1\/intl\/leads\/([^/]+)$/);
  if (req.method === 'GET' && one) {
    const lead = await Promise.resolve(intl.lead(decodeURIComponent(one[1]), user.id));
    if (!lead) return { ok: false, status: 404, error_code: 'not_found' };
    const access = intl.accessLead(lead.broker_id, user.id, { write: false });
    lead.workspace_owner_id = access.ok ? access.workspace_owner_id : lead.broker_id;
    lead.workspace_role = access.ok ? access.role : 'owner';
    lead.can_write = access.ok ? access.can_write : true;
    
    const cachedOptions = aiCacheGet(lead.id, config);
    if (cachedOptions) {
      lead.options = cachedOptions;
      lead.ai_engine = 'deepseek-chat';
    } else if (aiOptionsEnabled(config)) {
      // Trigger background enrichment without blocking HTTP response.
      enrichLeadAiAsync(lead, user, config);
    }
    return { ok: true, lead };
  }
  const sub = pathname.match(/^\/v1\/intl\/leads\/([^/]+)\/(draft|send|reject|viewing|analyze|status|stop|archive|handled|unhandled|apply-slot|confirm|ai-drafts)$/);
  if (sub) {
    const id = decodeURIComponent(sub[1]);
    const writeActions = new Set(['draft', 'send', 'reject', 'viewing', 'status', 'stop', 'archive', 'handled', 'unhandled', 'apply-slot', 'confirm']);
    const denied = accessLead(intl, id, user, { write: writeActions.has(sub[2]) });
    if (denied) return denied;
    if (sub[2] === 'ai-drafts' && req.method === 'POST') {
      const lead = await Promise.resolve(intl.lead(id, user.id));
      if (!lead) return { ok: false, status: 404, error_code: 'not_found' };
      // Same opt-in gate as the background enrichment: without it the endpoint stays rule-based.
      if (!aiOptionsEnabled(config)) {
        return { ok: true, options: lead.options || [], engine: 'fallback', ai_enabled: false };
      }
      const { lastInboundText, propertyGrounding } = require('../core/intl/desk');
      const grounded = propertyGrounding(lead.property || {});
      const leadPayload = {
        clean_name: lead.clean_name,
        sender_name: lead.sender_name,
        text: lastInboundText(lead),
        intent: lead.intent,
        score: lead.grade || (lead.score >= 70 ? 'HOT' : lead.score < 30 ? 'COLD' : 'WARM'),
        language: lead.language || 'ru',
      };
      const leadContext = {
        property: { ...(lead.property || {}), ...grounded, location: grounded.district },
        slots: lead.slots || [],
        style: intl.getSettings().reply_style || 'business',
      };
      const dsKey = config.DEEPSEEK_API_KEY;
      if (dsKey) {
        const dsRes = await generateRepliesWithDeepSeek(dsKey, leadPayload, leadContext);
        if (dsRes.ok && dsRes.options?.length) {
          const grounded = filterGrounded(dsRes.options, lead.property || {});
          const merged = mergeOptions(grounded.kept, lead.options);
          if (merged.length) {
            aiCacheSet(id, merged, config);
            return { ok: true, options: merged, engine: 'deepseek-chat', ai_enabled: true, rejected: grounded.rejected.length };
          }
        }
      }
      const gemKey = config.GEMINI_API_KEY;
      if (gemKey) {
        const geminiRes = await generateRepliesWithGemini(gemKey, leadPayload, leadContext);
        if (geminiRes.ok && geminiRes.options?.length) {
          const grounded = filterGrounded(geminiRes.options, lead.property || {});
          const merged = mergeOptions(grounded.kept, lead.options);
          if (merged.length) {
            aiCacheSet(id, merged, config);
            return { ok: true, options: merged, engine: 'gemini-3.8-flash', ai_enabled: true, rejected: grounded.rejected.length };
          }
        }
      }
      return { ok: true, options: lead.options || [], engine: 'fallback', ai_enabled: true };
    }
    if (sub[2] === 'draft' && req.method === 'PUT') return intl.saveDraft(id, body);
    if (sub[2] === 'send' && req.method === 'POST') {
      return intl.send(id, { ...body, idempotency_key: req.headers['idempotency-key'] || body.idempotency_key }, user.id);
    }
    if (sub[2] === 'reject' && req.method === 'POST') return intl.reject(id, user.id);
    if (sub[2] === 'archive' && req.method === 'POST') return intl.archive(id, user.id);
    if (sub[2] === 'handled' && req.method === 'POST') return intl.handled(id, user.id);
    if (sub[2] === 'unhandled' && req.method === 'POST') return intl.unhandled(id, user.id);
    if (sub[2] === 'confirm' && req.method === 'POST') return intl.confirm(id, user.id);
    if (sub[2] === 'apply-slot' && req.method === 'POST') return intl.applySlot(id, body);
    if (sub[2] === 'stop' && req.method === 'POST') return intl.stop(id, user.id);
    if (sub[2] === 'viewing' && req.method === 'POST') return intl.book(id, body.slot_id, user.id);
    if (sub[2] === 'analyze' && req.method === 'POST') return { ok: true, lead: await Promise.resolve(intl.lead(id)) };
    if (sub[2] === 'status' && req.method === 'POST') return intl.setPipeline(id, body.pipeline, user.id);
  }
  const erase = pathname.match(/^\/v1\/intl\/leads\/([^/]+)\/erase$/);
  if (erase && req.method === 'POST') {
    const id = decodeURIComponent(erase[1]);
    const denied = accessLead(intl, id, user, { write: true });
    if (denied) return denied;
    return intl.erase(id, user.id);
  }
  if (req.method === 'GET' && pathname === '/v1/intl/digest') return intl.digest();
  if (req.method === 'POST' && pathname === '/v1/intl/digest/send') {
    const result = intl.digestTick('demand', user.id);
    if (result && result.ok === false) return result;
    if (config.CHANNEL_MODE === 'live' && result && result.digest) {
      const delivery = await intl.deliverDigest(result.digest, user.id);
      return { ...result, ...delivery };
    }
    return { ...result, sent: false, simulated: true, telegram_delivery: false };
  }
  if (req.method === 'GET' && pathname === '/v1/intl/export/leads.csv') {
    const workspace = workspaceFrom(url, user, intl);
    if (!workspace.ok) return workspace;
    return intl.exportCsv('leads', workspace.broker_id);
  }
  if (req.method === 'GET' && pathname === '/v1/intl/export/viewings.csv') {
    const workspace = workspaceFrom(url, user, intl);
    if (!workspace.ok) return workspace;
    return intl.exportCsv('viewings', workspace.broker_id);
  }
  if (req.method === 'GET' && pathname === '/v1/intl/properties') {
    const workspace = workspaceFrom(url, user, intl);
    if (!workspace.ok) return workspace;
    const properties = intl.store.all('SELECT * FROM i_property WHERE active = 1 AND id != ?', ['general'])
      .filter((row) => row.broker_id && String(row.broker_id) === String(workspace.broker_id))
      .map((row) => ({
        ...row,
        facts: JSON.parse(row.facts || '{}'),
        photos: intl.photos(row.id),
        slots: intl.store.all(`SELECT * FROM i_slot WHERE property_id = ? AND status != 'removed' ORDER BY start_utc`, [row.id]),
      }));
    return {
      ok: true,
      properties,
      workspace_owner_id: workspace.workspace_owner_id,
      can_write: workspace.can_write,
    };
  }
  if (req.method === 'POST' && pathname === '/v1/intl/properties/import') {
    const workspace = workspaceFrom(url, user, intl);
    if (!workspace.ok) return workspace;
    if (!workspace.can_write) return { ok: false, status: 403, error_code: 'viewer_readonly' };
    return intl.importListing(body.url);
  }
  if (req.method === 'POST' && pathname === '/v1/intl/properties') {
    const workspace = workspaceFrom(url, user, intl);
    if (!workspace.ok) return workspace;
    if (!workspace.can_write) return { ok: false, status: 403, error_code: 'viewer_readonly' };
    return intl.addProperty(body, workspace.broker_id);
  }
  const brochure = pathname.match(/^\/v1\/intl\/properties\/([^/]+)\/brochure\.pdf$/);
  if (brochure && req.method === 'GET') return intl.brochure(decodeURIComponent(brochure[1]));
  const slots = pathname.match(/^\/v1\/intl\/properties\/([^/]+)\/slots$/);
  if (slots && req.method === 'POST') return intl.addSlot(decodeURIComponent(slots[1]), body, user.id);
  if (slots && req.method === 'GET') {
    const property = intl.store.one('SELECT * FROM i_property WHERE id = ?', [decodeURIComponent(slots[1])]);
    const { listFreeSlots } = require('../core/intl/slots');
    return { ok: true, slots: property ? listFreeSlots(intl.store, property, intl.now()) : [] };
  }
  const viewing = pathname.match(/^\/v1\/intl\/viewings\/([^/]+)\/(confirm|cancel)$/);
  if (viewing && req.method === 'POST') {
    const row = intl.store.one('SELECT lead_id FROM i_viewing WHERE id = ?', [decodeURIComponent(viewing[1])]);
    if (!row) return { ok: false, status: 404, error_code: 'not_found' };
    const denied = accessLead(intl, row.lead_id, user, { write: true });
    if (denied) return denied;
    return intl.setViewing(decodeURIComponent(viewing[1]), viewing[2] === 'confirm' ? 'confirmed' : 'cancelled', user.id);
  }
  if (req.method === 'GET' && pathname === '/v1/intl/viewings') {
    const workspace = workspaceFrom(url, user, intl);
    if (!workspace.ok) return workspace;
    const viewings = intl.store.all(
      `SELECT v.*, l.sender_name, l.clean_name, l.channel, l.broker_id, p.title, p.tz, p.tz_label_en, p.tz_label_ru
       FROM i_viewing v
       LEFT JOIN i_lead l ON l.id = v.lead_id
       LEFT JOIN i_property p ON p.id = v.property_id
       ORDER BY v.start_utc`,
    ).filter((row) => row.broker_id && String(row.broker_id) === String(workspace.broker_id));
    return {
      ok: true,
      viewings,
      broker_tz: config.BROKER_TZ,
      workspace_owner_id: workspace.workspace_owner_id,
      workspace_role: workspace.role,
      can_write: workspace.can_write,
    };
  }
  if (req.method === 'GET' && pathname === '/v1/intl/team') return intl.team(user.id);
  if (req.method === 'POST' && pathname === '/v1/intl/team/invite') return intl.inviteColleague(body, user.id);
  if (req.method === 'POST' && pathname === '/v1/intl/team/accept') return intl.acceptColleague(body, user.id);
  if (req.method === 'POST' && pathname === '/v1/intl/team/revoke') return intl.revokeColleague(body, user.id);
  if (pathname === '/v1/intl/settings' && req.method === 'GET') {
    const saved = intl.getSettings();
    const teamInfo = intl.team(user.id);
    return {
      ok: true,
      settings: saved,
      manual_approval: true,
      is_owner: user.owner === true,
      auto_send_hot: saved.auto_send_hot === '1' || saved.auto_send_hot === 'true',
      ephemeral: config.EPHEMERAL_DISK === true,
      broker_tz: saved.broker_tz || config.BROKER_TZ,
      channel_mode: config.CHANNEL_MODE,
      demo_ui: config.DEMO_UI_NO_AUTH === true,
      whatsapp_ui: config.INTL_WHATSAPP_UI === true,
      telegram_user_id: String(user.id),
      team: teamInfo,
    };
  }
  if (pathname === '/v1/intl/settings' && req.method === 'POST') return intl.settings(body, user.id);
  if (req.method === 'GET' && pathname === '/v1/intl/templates') return intl.templates();
  if (req.method === 'POST' && pathname === '/v1/intl/templates') return intl.saveTemplates(body.templates || body, user.id);
  if (req.method === 'GET' && pathname === '/v1/intl/metrics') {
    const workspace = workspaceFrom(url, user, intl);
    if (!workspace.ok) return workspace;
    return intl.metrics(workspace.broker_id);
  }
  if (req.method === 'GET' && pathname === '/v1/intl/contacts') {
    const workspace = workspaceFrom(url, user, intl);
    if (!workspace.ok) return workspace;
    return intl.contacts(workspace.broker_id);
  }
  if (req.method === 'GET' && pathname === '/v1/intl/connect') return intl.connect(user.id);
  if (req.method === 'GET' && pathname === '/v1/intl/whatsapp/status') return intl.whatsappStatus(user.id);
  if (req.method === 'POST' && pathname === '/v1/intl/whatsapp/connect') return intl.whatsappConnect(body, user.id);
  if (req.method === 'POST' && pathname === '/v1/intl/whatsapp/disconnect') return intl.whatsappDisconnect(user.id);
  if (req.method === 'GET' && pathname === '/v1/intl/followups') {
    const workspace = workspaceFrom(url, user, intl);
    if (!workspace.ok) return workspace;
    return intl.followups(workspace.broker_id);
  }
  if (req.method === 'POST' && pathname === '/v1/intl/followups') {
    if (body && body.lead_id) {
      const denied = accessLead(intl, body.lead_id, user, { write: true });
      if (denied) return denied;
    }
    return intl.addFollowup(body, user.id);
  }
  const followClose = pathname.match(/^\/v1\/intl\/followups\/([^/]+)\/done$/);
  if (followClose && req.method === 'POST') return intl.closeFollowup(decodeURIComponent(followClose[1]), user.id);
  if (req.method === 'GET' && pathname === '/v1/intl/audit') {
    const rows = intl.audit(url.searchParams.get('lead_id') || '');
    const allowed = new Set(intl.accessibleBrokerIds(user.id));
    const owned = new Set(
      intl.store.all('SELECT id, broker_id FROM i_lead')
        .filter((row) => row.broker_id && allowed.has(String(row.broker_id)))
        .map((row) => row.id),
    );
    return { ok: true, rows: rows.filter((row) => row.lead_id && owned.has(row.lead_id)) };
  }
  if (req.method === 'POST' && pathname === '/v1/intl/seed') {
    if (config.CHANNEL_MODE === 'live') return { ok: false, status: 403, error_code: 'sim_only' };
    const pack = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'intl', 'testset.json'), 'utf8'));
    const counts = await intl.seed(pack, body.mode === 'minus_t06' ? 'minus_t06' : 'all');
    return { ok: true, counts };
  }
  return { ok: false, status: 404, error_code: 'not_found' };
}

function serveStatic(res, pathname) {
  if (pathname === '/favicon.ico') {
    pathname = '/favicon.svg';
  }
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(UI_ROOT, rel));
  if (!file.startsWith(UI_ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  const ext = path.extname(file);
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
  // HTML/i18n stay fresh; static assets can be cached at the edge/browser for a day.
  const cacheable = ext === '.js' || ext === '.css' || ext === '.svg';
  res.writeHead(200, {
    'Content-Type': types[ext] || 'application/octet-stream',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; frame-src 'self' blob:; connect-src 'self'",
    'Cache-Control': cacheable ? 'public, max-age=86400' : 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(file).pipe(res);
}

const DEMO_BROKER_ID = '5031998736'; // the same user authorize() hands out when DEMO_UI_NO_AUTH is on

async function seedIfEmpty(intl) {
  const count = intl.store.one('SELECT COUNT(*) AS n FROM i_lead').n;
  if (count > 0) return { seeded: false, count };
  const pack = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'intl', 'testset.json'), 'utf8'));
  const counts = await intl.seed(pack, 'all');
  // Seeded rows have no broker_id, and the inbox/properties lists are scoped to the current broker.
  // Without this the demo inbox would be empty for the very user authorize() returns.
  intl.store.run('UPDATE i_lead SET broker_id = ? WHERE broker_id IS NULL', [DEMO_BROKER_ID]);
  intl.store.run(
    `UPDATE i_property SET broker_id = ? WHERE broker_id IS NULL OR broker_id = '' OR broker_id = 'system'`,
    [DEMO_BROKER_ID],
  );
  // Fill the two folders so the demo shows real lists: two leads answered by hand, one confirmed.
  intl.store.run("UPDATE i_lead SET status = 'handled' WHERE id IN ('T11', 'T05')");
  intl.store.run("UPDATE i_lead SET status = 'sent', client_confirmed = 1 WHERE id = 'T20'");
  return { seeded: true, counts };
}

async function refreshWebhookState(intl, config, fetchImpl) {
  const info = await getWebhookInfo(config, fetchImpl);
  const result = info.ok && info.data && info.data.result ? info.data.result : {};
  intl.webhookState = {
    url_set: Boolean(result.url),
    pending_update_count: Number(result.pending_update_count || 0) || 0,
    last_error: result.last_error_message ? String(result.last_error_message).slice(0, 200) : '',
    checked_at: new Date().toISOString(),
  };
  return intl.webhookState;
}

async function ensureWebhook(intl, config, fetchImpl) {
  const base = String(config.UI_PUBLIC_BASE || '').replace(/\/$/, '');
  const live = config.CHANNEL_MODE === 'live';
  const auto = config.AUTO_SET_WEBHOOK === true;
  if (!live || !auto) {
    if (live && config.TELEGRAM_BOT_TOKEN) {
      try { await refreshWebhookState(intl, config, fetchImpl); } catch { /* ignore */ }
    }
    return { skipped: true };
  }
  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_WEBHOOK_SECRET || !/^https:\/\//i.test(base)) {
    console.error('webhook_auto_skip missing_token_or_https_base');
    return { ok: false, error_code: 'webhook_auto_skip' };
  }
  const webhookUrl = `${base}/v1/intl/telegram`;
  const set = await setWebhook(config, webhookUrl, fetchImpl);
  if (!set.ok) {
    console.error(`webhook_auto_failed ${set.error_code || set.status || 'error'}`);
    try { await refreshWebhookState(intl, config, fetchImpl); } catch { /* ignore */ }
    return { ok: false, error_code: set.error_code || 'webhook_auto_failed' };
  }
  const state = await refreshWebhookState(intl, config, fetchImpl);
  console.log(`webhook_auto_ok url_set=${state.url_set ? 'yes' : 'no'} pending=${state.pending_update_count}`);
  if (state.last_error) console.error(`webhook_last_error ${state.last_error}`);
  return { ok: true, ...state };
}

async function startIntl(env = process.env) {
  if (!process.__intlGuards) {
    process.__intlGuards = true;
    process.on('unhandledRejection', (reason) => {
      const message = reason && reason.message ? reason.message : String(reason);
      console.error('intl_unhandled_rejection ' + String(message).slice(0, 300));
    });
    process.on('uncaughtException', (err) => {
      const first = err && err.stack ? String(err.stack).split('\n')[0] : String(err);
      console.error('intl_uncaught_exception ' + first.slice(0, 300));
    });
  }
  const config = loadConfig(env);
  const problem = bootError(config);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  if (config.INTL_AI_OPTIONS === true) {
    console.log(`ai_options_enabled provider=${config.DEEPSEEK_API_KEY ? 'deepseek' : (config.GEMINI_API_KEY ? 'gemini' : 'none')}`);
  } else if (config.DEEPSEEK_API_KEY || config.GEMINI_API_KEY) {
    // Keys present but the feature is off: say so once, instead of leaking silently.
    console.warn('ai_options_disabled INTL_AI_OPTIONS=false; DeepSeek/Gemini are not called');
  }
  let intl;
  try {
    intl = createIntl(config);
    if (config.CHANNEL_MODE === 'live') {
      const row = intl.store.one('SELECT 1 AS n');
      if (!row || Number(row.n) !== 1) throw new Error('postgres_unavailable');
    }
  } catch (err) {
    if (config.CHANNEL_MODE === 'live') {
      console.error('postgres_unavailable');
      process.exit(1);
    }
    throw err;
  }
  if (config.CHANNEL_MODE !== 'live') await seedIfEmpty(intl);
  let waTimer = null;
  if (config.CHANNEL_MODE === 'live' && config.INTL_WHATSAPP_UI === true) {
    // pollWhatsApp resolves the effective config (env or Mini App settings) and no-ops for non-Green gateways.
    waTimer = setInterval(() => { intl.whatsappPoll().catch((err) => console.error('whatsapp_poll_failed ' + (err && err.message ? err.message : 'error'))); }, 5000);
    if (waTimer.unref) waTimer.unref();
  }
  intl.digestTick('startup');
  const runtime = { draining: false, shuttingDown: false };
  const timer = setInterval(() => {
    if (runtime.draining) return;
    try {
      const digest = intl.digestTick('schedule');
      if (config.CHANNEL_MODE === 'live' && digest && digest.digest && !digest.skipped) {
        Promise.resolve(intl.deliverDigest(digest.digest)).catch(() => {
          console.error('intl_digest_delivery_failed');
        });
      }
      Promise.resolve(intl.remind()).catch(() => {
        console.error('intl_remind_failed');
      });
      intl.retain();
      intl.sweep();
      intl.compete();
      if (config.CHANNEL_MODE === 'live' && config.TELEGRAM_BOT_TOKEN) {
        refreshWebhookState(intl, config).catch(() => {});
      }
    } catch {
      console.error('intl_tick_failed');
    }
  }, 60_000);
  if (typeof timer.unref === 'function') timer.unref();
  const server = buildIntlServer(config, intl, { state: runtime });
  const port = listenPort(env);
  await new Promise((resolve) => {
    server.listen(port, listenHost(env), () => {
      const bound = server.address();
      const actualPort = bound && typeof bound === 'object' && 'port' in bound ? bound.port : port;
      console.log(`intl_listening host=${listenHost(env)} port=${actualPort}`);
      resolve(undefined);
    });
  });
  await ensureWebhook(intl, config);

  function shutdown(signal) {
    if (runtime.shuttingDown) return;
    runtime.shuttingDown = true;
    runtime.draining = true;
    console.log(`intl_shutdown signal=${signal}`);
    clearInterval(timer);
    if (waTimer) clearInterval(waTimer);
    const force = setTimeout(() => {
      console.error('intl_shutdown_timeout');
      process.exit(1);
    }, 15_000);
    if (typeof force.unref === 'function') force.unref();
    server.close(() => {
      try { intl.close(); } catch { /* already closed */ }
      clearTimeout(force);
      console.log('intl_shutdown_done');
      process.exit(0);
    });
  }
  if (!process.__intlShutdownArmed) {
    process.__intlShutdownArmed = true;
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  return { server, intl, config, timer, shutdown, runtime };
}

if (require.main === module) startIntl();

module.exports = {
  buildIntlServer,
  startIntl,
  bootError,
  seedIfEmpty,
  ensureWebhook,
  refreshWebhookState,
  listenPort,
  applyHttpTimeouts,
  // Exported for tests: the AI opt-in gate and its bounded cache.
  aiOptionsEnabled,
  aiCacheGet,
  aiCacheSet,
  aiCacheClear,
};
