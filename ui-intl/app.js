'use strict';

const app = document.getElementById('app');
const query = new URLSearchParams(location.search);
// Reactive UI store: error/online are the only global slices; screen data stays local to its render.
const uiStore = (typeof window !== 'undefined' && window.DSHStore)
  ? window.DSHStore.createStore({ error: null, online: typeof navigator === 'undefined' ? true : navigator.onLine !== false })
  : null;
let renderScheduled = false;
// Demo sign-in payload: harmless for production, where the server validates a real bot token.
const DEMO_TMA = 'auth_date=1794533308&user=%7B%22id%22%3A%2242%22%7D&hash=a5d87c5a84119d672ec6c9ae5e2ea69aa11f2dfb4d5fbd88fa2fc98a63d7e434';
const state = {
  lang: query.get('lang') === 'ru' || query.get('lang') === 'en' ? query.get('lang') : (localStorage.getItem('intl-lang') || 'en'),
  screen: 'inbox',
  leadId: '',
  dict: {},
  settings: {},
  tma: '',
  filter: 'ALL',
  sheet: query.get('sheet') === '1',
  draftText: '',
  option: null,
  manual: false,
  slotIds: [],
  ephemeral: false,
  propertyId: '',
  dayKey: '',
  addProperty: false,
  ask: null,
  notice: '',
  serverSettings: null,
  loadedLead: '',
  loadedStatus: '',
  picker: false,
  // ?time=1 opens the suggest-a-time sheet directly; handy for demos and screenshots (sheet=1 precedent).
  timeSheet: query.get('time') === '1',
  pendingSlot: '',
  attachments: [],
  editProperty: null,
  inboxView: '',
  openProperty: '',
  showPropertyLeads: '',
  propertyDrafts: {},
  photoDraft: [],
  calAnchor: '',
  pdfFor: '',
  sendKey: '',
  brokerTz: '',
  importing: false,
  channelMode: '',
  demoUi: false,
  waGateway: '',
  health: null,
  q: '',
  weekMode: false,
  auditOpen: false,
  workspaceId: localStorage.getItem('intl-workspace') || '',
  team: { members: [], workspaces: [], max_members: 5 },
  canWrite: true,
  myTelegramId: '',
  inviteTokenShown: '',
  initRetries: 0,
};
if (query.get('theme') === 'dark') document.documentElement.dataset.theme = 'dark';

function tg() {
  return window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
}

function haptic(kind) {
  const feedback = tg() && tg().HapticFeedback;
  if (!feedback) return;
  try {
    if (kind === 'success' || kind === 'error' || kind === 'warning') feedback.notificationOccurred(kind);
    else if (feedback.impactOccurred) feedback.impactOccurred('light');
  } catch { /* SDK optional */ }
}

function applyTelegramTheme() {
  const web = tg();
  if (!web) return;
  const params = web.themeParams || {};
  const root = document.documentElement;
  if (web.colorScheme === 'dark') root.dataset.theme = 'dark';
  else if (query.get('theme') !== 'dark') delete root.dataset.theme;
  if (params.bg_color) root.style.setProperty('--bg', params.bg_color);
  if (params.secondary_bg_color) root.style.setProperty('--bg2', params.secondary_bg_color);
  if (params.text_color) root.style.setProperty('--text', params.text_color);
  if (params.hint_color) root.style.setProperty('--hint', params.hint_color);
  if (params.button_color) root.style.setProperty('--btn', params.button_color);
  if (params.button_text_color) root.style.setProperty('--btn-text', params.button_text_color);
  if (web.setHeaderColor && params.bg_color) {
    try { web.setHeaderColor(params.bg_color); } catch { /* older clients */ }
  }
}

function initWebAppShell() {
  const web = tg();
  if (!web) return;
  try {
    if (web.ready) web.ready();
    if (web.expand) web.expand();
  } catch { /* ignore */ }
  applyTelegramTheme();
  if (web.onEvent) web.onEvent('themeChanged', applyTelegramTheme);
}

function onTelegramBack() {
  if (state.screen === 'lead') go(state.loadedStatus === 'archived' ? '#/archive' : '#/inbox');
  else if (state.screen === 'simulator' || state.screen === 'digest' || state.screen === 'whatsapp') go('#/setup');
else if (state.screen === 'processed' || state.screen === 'confirmed') go('#/inbox');
  else if (state.screen === 'archive' || state.screen === 'contacts') go('#/inbox');
  else go('#/inbox');
}

function syncBackButton() {
  const web = tg();
  const button = web && web.BackButton;
  if (!button) return;
  const nested = ['lead', 'simulator', 'digest', 'archive', 'contacts', 'processed', 'confirmed', 'pilot', 'whatsapp'].includes(state.screen);
  try {
    if (button.offClick) button.offClick(onTelegramBack);
    if (nested) {
      button.onClick(onTelegramBack);
      button.show();
    } else {
      button.hide();
    }
  } catch { /* ignore */ }
}

function clearMainButton() {
  const web = tg();
  const button = web && web.MainButton;
  if (!button) return;
  try {
    button.offClick();
    button.hide();
    if (button.disable) button.disable();
  } catch { /* ignore */ }
}

function syncMainButton(opts) {
  const web = tg();
  const button = web && web.MainButton;
  if (!button) return false;
  const { visible, text, enabled, onClick } = opts || {};
  try {
    button.offClick();
    if (!visible) {
      button.hide();
      return true;
    }
    button.setText(text || t('send'));
    if (enabled === false) {
      if (button.disable) button.disable();
    } else if (button.enable) button.enable();
    button.onClick(() => {
      if (typeof onClick === 'function') onClick();
    });
    button.show();
    return true;
  } catch {
    return false;
  }
}

const ICO = {
  wa: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 2a8 8 0 1 1-4.3 14.8l-.3-.2-2.7.7.7-2.6-.2-.3A8 8 0 0 1 12 4zm-3 3.5c-.3 0-.6.2-.8.5-.3.4-.8 1-.8 2.1s.8 2.3.9 2.4c.1.2 1.6 2.6 4 3.5 2 .8 2.4.6 2.8.6.5 0 1.4-.6 1.6-1.2.2-.6.2-1.1.1-1.2-.1-.1-.3-.2-.6-.3l-1.6-.8c-.2-.1-.4-.1-.6.1l-.7.9c-.1.2-.3.2-.6.1-.9-.4-1.7-1-2.4-2-.1-.2 0-.3.1-.4l.4-.5.2-.4c0-.1 0-.3 0-.4l-.7-1.7c-.2-.4-.4-.4-.5-.4z"/></svg>',
  tg: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.5 3.2 2.8 10.4c-.8.3-.8 1.4 0 1.7l4.6 1.5 1.8 5.6c.2.7 1 .9 1.5.4l2.6-2.4 4.8 3.5c.6.4 1.4.1 1.6-.6l3.1-15.3c.2-.9-.7-1.6-1.4-1.3zM9.8 14 17.5 8l-6.1 6.7-.3 3.2z"/></svg>',
  inbox: '<svg viewBox="0 0 24 24"><path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5l1 3h6l1-3h5"/></svg>',
  cal: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  home: '<svg viewBox="0 0 24 24"><path d="M3 11l9-7 9 7v9H3z"/><path d="M9 20v-6h6v6"/></svg>',
  start: '<svg viewBox="0 0 24 24"><path d="M12 3l2.4 5 5.6.8-4 3.9.9 5.6-4.9-2.6-4.9 2.6.9-5.6-4-3.9 5.6-.8z"/></svg>',
  box: '<svg viewBox="0 0 24 24"><path d="M3 7h18v12H3z"/><path d="M3 7l2.5-3h13L21 7"/><path d="M10 12h4"/></svg>',
};

function storageGet(key) {
  try { return sessionStorage.getItem(key) || localStorage.getItem(key) || ''; } catch { return ''; }
}

function storageSet(key, value) {
  try { sessionStorage.setItem(key, value); } catch { /* private mode */ }
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

function storageRemove(key) {
  try { sessionStorage.removeItem(key); } catch { /* ignore */ }
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

function isTelegramClient() {
  if (tg()) return true;
  try {
    if (window.TelegramWebviewProxy || window.TelegramWebview) return true;
  } catch { /* ignore */ }
  return /Telegram/i.test(String(navigator.userAgent || ''));
}

function applyHashRoute(hash) {
  const path = String(hash || '').replace(/^#\/?/, '').split('?')[0];
  const [screen, id] = path.split('/');
  if (screen === 'lead' && id) {
    const nextId = decodeURIComponent(id);
    if (state.leadId !== nextId) {
      state.loadedLead = '';
      state.loadedStatus = '';
      state.auditOpen = false;
    }
    state.screen = 'lead';
    state.leadId = nextId;
  } else if (['inbox', 'viewings', 'properties', 'setup', 'simulator', 'digest', 'archive', 'contacts', 'processed', 'confirmed', 'pilot', 'whatsapp'].includes(screen)) {
    state.screen = screen;
    state.loadedLead = '';
    state.loadedStatus = '';
  }
}

function captureLaunch() {
  const hash = location.hash || '';
  const params = new URLSearchParams(location.search);
  const fromQuery = params.get('tma') || '';
  const sdkInit = (tg() && tg().initData) || '';
  const resolved = (window.tgLaunch && window.tgLaunch.resolveInitData)
    ? window.tgLaunch.resolveInitData({ sdkInitData: sdkInit, hash })
    : { initData: '', source: '', startParam: '' };
  const parsed = (window.tgLaunch && window.tgLaunch.parseTelegramHash)
    ? window.tgLaunch.parseTelegramHash(hash)
    : { initData: '', startParam: '' };
  const match = hash.match(/tgWebAppData=([^&]+)/);
  const fromHash = match ? decodeURIComponent(match[1]) : '';
  // Prefer live SDK / launch hash over any cached token so reopen always picks a fresh session.
  const raw = resolved.initData || fromQuery || fromHash || parsed.initData || storageGet('intl-tma');
  if (raw) {
    state.tma = raw;
    storageSet('intl-tma', raw);
    state.initError = '';
    state.initRetries = 0;
  } else {
    state.tma = '';
  }
  // Telegram puts credentials in the fragment; rewrite to a normal app route so tabs keep working.
  if (/tgWebAppData=/.test(hash)) {
    const start = resolved.startParam || parsed.startParam || '';
    const next = start ? `#/lead/${encodeURIComponent(start)}` : '#/inbox';
    history.replaceState(null, '', `${location.pathname}${location.search}${next}`);
    applyHashRoute(next);
    return;
  }
  applyHashRoute(hash);
}

async function ensureInitData() {
  captureLaunch();
  if (state.tma) return;
  if (!isTelegramClient()) return;
  // Some Telegram clients populate WebApp.initData a tick after the first paint.
  for (let attempt = 0; attempt < 12 && !state.tma; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    captureLaunch();
  }
}

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function t(key) { return state.dict[key] || key; }
function fill(key, vars) {
  const bag = vars && typeof vars === 'object' ? vars : { n: vars };
  return t(key).replace(/\{(\w+)\}/g, (all, name) => (bag[name] == null ? all : String(bag[name])));
}

const NOTE = {
  en: {
    ai: 'AI-assisted message. Reply STOP to opt out.',
    stop: 'Reply STOP to opt out.',
  },
  ru: {
    ai: 'Сообщение подготовлено с помощью ИИ. Напишите STOP, чтобы отписаться.',
    stop: 'Напишите STOP, чтобы отписаться.',
  },
};

const TIMING_RU = {
  today: 'сегодня',
  tomorrow: 'завтра',
  weekend: 'на выходных',
  'this week': 'на этой неделе',
  Monday: 'понедельник',
  Tuesday: 'вторник',
  Wednesday: 'среда',
  Thursday: 'четверг',
  Friday: 'пятница',
  Saturday: 'суббота',
  Sunday: 'воскресенье',
  'long stay': 'длительное проживание',
  'stay length': 'срок аренды',
};

const MON_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MON_RU = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const WD_RU = { Sun: 'вс', Mon: 'пн', Tue: 'вт', Wed: 'ср', Thu: 'чт', Fri: 'пт', Sat: 'сб' };

function intentLabel(intent) {
  const map = {
    viewing: 'intentViewing', price: 'intentPrice', finance: 'intentFinance', docs: 'intentDocs',
    area: 'intentArea', avail: 'intentAvail', details: 'intentDetails', unclear: 'intentUnclear', stop: 'intentStop',
  };
  return t(map[intent] || 'notStated');
}

function periodLabel(period) {
  if (period === 'year') return t('perYear');
  if (period === 'month') return t('perMonth');
  if (period === 'total') return t('perTotal');
  return period || '';
}

function kindLabel(kind) { return kind === 'sale' ? t('sale') : t('rent'); }

function budgetText(lead) {
  if (lead.budget_amount == null) return t('notStated');
  const money = `${lead.budget_amount} ${lead.budget_currency || ''}`.trim();
  if (!lead.budget_period) return `${money} · ${t('periodUnclear')}`;
  return `${money} / ${periodLabel(lead.budget_period)}`;
}

async function report(err) {
  const el = document.getElementById('formError');
  const message = errText(err);
  if (el) el.textContent = message;
  else fail(err);
}

function moneyLine(row) {
  const n = Number(row.sum);
  const sum = Number.isFinite(n) ? Math.round(n * 100) / 100 : row.sum;
  return `${kindLabel(row.kind)}, ${row.currency} / ${periodLabel(row.period)}: ${sum}`;
}

const apiInflight = new Map();

function apiSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function apiBackoff(attempt) {
  const base = Math.min(2000, 200 * 2 ** Math.max(0, attempt - 1));
  return base * (1 + Math.random() * 0.3);
}

async function api(pathname, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const idempotent = method === 'GET' || method === 'PUT' || method === 'DELETE' || Boolean(options.headers && options.headers['Idempotency-Key']);
  const attempts = idempotent ? 3 : 1;
  const dedupeKey = method + ' ' + pathname + ' ' + (typeof options.body === 'string' ? options.body : '');
  if (method === 'GET' && !options.noDedupe && apiInflight.has(dedupeKey)) return apiInflight.get(dedupeKey);
  const run = async () => {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs || 20000) : null;
      try {
        const res = await fetch(pathname, {
          ...options,
          signal: controller ? controller.signal : options.signal,
          headers: {
            Accept: 'application/json',
            Authorization: state.tma ? `tma ${state.tma}` : '',
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...(options.headers || {}),
          },
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          const error = Object.assign(new Error(body.error_code || 'failed'), { status: res.status, body });
          const retryable = res.status === 429 || res.status >= 500;
          if (!retryable || attempt >= attempts) throw error;
          lastError = error;
          const retryAfter = Number(res.headers.get('retry-after') || 0);
          await apiSleep(retryAfter > 0 ? retryAfter * 1000 : apiBackoff(attempt));
          continue;
        }
        return body;
      } catch (error) {
        if (error && error.status) throw error;
        if (attempt >= attempts) throw error;
        lastError = error;
        await apiSleep(apiBackoff(attempt));
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw lastError;
  };
  const promise = run();
  if (method === 'GET' && !options.noDedupe) {
    apiInflight.set(dedupeKey, promise);
    promise.finally(() => apiInflight.delete(dedupeKey));
  }
  return promise;
}

function go(hash) {
  if (location.hash === hash) {
    requestRender();
    return;
  }
  location.hash = hash;
}

function draftPayload() {
  return {
    text: state.draftText,
    option_id: state.manual ? null : (state.option?.id || null),
    edited: true,
    slot_ids: state.slotIds || [],
    attachments: state.attachments || [],
  };
}

function errText(err) {
  const code = err.body?.error_code || err.message || 'failed';
  if (code === 'unknown_delivery') return t('unknownDelivery');
  if (code === 'slot_unavailable') return t('slotUnavailable');
  if (code === 'slot_property_mismatch') return t('slotPropertyMismatch');
  if (code === 'invalid_transition') return t('invalidTransition');
  if (code === 'instance_already_connected') return t('waInstanceTaken');
  if (code === 'viewer_readonly') return t('teamViewerReadonly');
  if (code === 'team_limit') return t('teamLimit');
  if (code === 'bad_telegram_id') return t('teamBadId');
  if (code === 'bad_token' || code === 'bad_invite' || code === 'invite_not_found' || code === 'wrong_member') return t('teamBadInvite');
  if (code === 'cannot_invite_self') return t('teamSelf');
  if (code === 'workspace_forbidden') return t('teamWorkspaceForbidden');
  if (code === 'invalid_property') return t('invalidProperty');
  if (code === 'invalid_timezone') return t('invalidTimezone');
  if (code === 'unauthorized') return t('initExpired');
  return code;
}

function parsePriceInput(raw) {
  let text = String(raw == null ? '' : raw).trim().replace(/\s+/g, '');
  if (!text) return NaN;
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(text)) text = text.replace(/\./g, '').replace(',', '.');
  else if (text.includes(',') && !text.includes('.')) text = text.replace(',', '.');
  else text = text.replace(/,/g, '');
  const n = Number(text);
  return Number.isFinite(n) ? n : NaN;
}

function normalizeListingUrl(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text.slice(0, 500);
  if (/^[\w.-]+\.[a-z]{2,}([/:?#].*)?$/i.test(text)) return `https://${text}`.slice(0, 500);
  return text.slice(0, 500);
}

function withWorkspace(path) {
  if (!state.workspaceId) return path;
  const join = path.includes('?') ? '&' : '?';
  return `${path}${join}workspace=${encodeURIComponent(state.workspaceId)}`;
}

function applyWorkspaceMeta(payload) {
  if (!payload || typeof payload !== 'object') return;
  if (payload.can_write != null) state.canWrite = payload.can_write !== false;
  if (payload.workspace_owner_id && !state.workspaceId) {
    /* own workspace — keep can_write true */
  }
}

function workspaceSwitchHtml() {
  const mine = state.myTelegramId || '';
  const workspaces = (state.team && state.team.workspaces) || [];
  if (!workspaces.length && !state.workspaceId) return '';
  const options = [`<option value="" ${!state.workspaceId ? 'selected' : ''}>${esc(t('teamMine'))}</option>`]
    .concat(workspaces.map((row) => {
      const id = row.owner_broker_id;
      const label = `${t('teamWorkspace')} ${id}`;
      return `<option value="${esc(id)}" ${state.workspaceId === id ? 'selected' : ''}>${esc(label)}</option>`;
    }));
  return `<label class="workspace-switch"><span>${esc(t('teamWorkspaceLabel'))}</span><select id="workspaceSelect">${options.join('')}</select></label>`;
}

function wireWorkspaceSelect() {
  const select = document.getElementById('workspaceSelect');
  if (!select) return;
  select.onchange = () => {
    state.workspaceId = select.value || '';
    localStorage.setItem('intl-workspace', state.workspaceId);
    state.canWrite = !state.workspaceId || ((state.team.workspaces || []).find((row) => row.owner_broker_id === state.workspaceId)?.role === 'editor');
    boot().catch(fail);
  };
}

function tabs(waiting) {
  const items = [
    { id: 'inbox', href: '#/inbox', icon: ICO.inbox, key: 'inbox' },
    { id: 'properties', href: '#/properties', icon: ICO.home, key: 'properties' },
    { id: 'viewings', href: '#/viewings', icon: ICO.cal, key: 'viewings' },
    { id: 'setup', href: '#/setup', icon: ICO.start, key: 'setup' },
  ];
  return `<nav class="tabs" aria-label="tabs">${items.map((item) => `<a href="${item.href}" class="${state.screen === item.id || (item.id === 'inbox' && state.screen === 'lead') ? 'on' : ''}">${item.icon}${esc(t(item.key))}${item.id === 'inbox' && waiting ? `<span class="bd">${waiting}</span>` : ''}</a>`).join('')}</nav>`;
}

function bar() {
  return `<div class="brandbar"><div class="brand"><i></i>Erstantwort</div><div class="tools"><div class="langsw"><button type="button" data-lang="en" class="${state.lang === 'en' ? 'on' : ''}">EN</button><button type="button" data-lang="ru" class="${state.lang === 'ru' ? 'on' : ''}">RU</button></div></div></div>`;
}

function langSwitchHtml() {
  return `<div class="langsw"><button type="button" data-lang="en" class="${state.lang === 'en' ? 'on' : ''}">EN</button><button type="button" data-lang="ru" class="${state.lang === 'ru' ? 'on' : ''}">RU</button></div>`;
}

function isDemoSurface() {
  return state.demoUi === true || state.channelMode === 'sim';
}

function shell(inner, waiting) {
  document.documentElement.lang = state.lang;
  app.classList.toggle('has-act', inner.includes('class="actbar"'));
  const reset = state.ephemeral ? `<p class="reset-banner">${esc(t('resets'))}</p>` : '';
  const demo = isDemoSurface() ? `<div class="demo" id="demoBanner">${esc(t('demoBar'))}</div>` : '';
  const undo = state.undo ? `<button class="undo" type="button" data-undo="${esc(state.undo.id)}">${esc(t('undo'))}</button>` : '';
  const note = state.notice || state.undo ? `<p class="toast" role="status">${esc(state.notice || t('handledDone'))}${undo}</p>` : '';
  state.notice = '';
  state.undo = null;
  const ask = state.ask ? `<div class="backdrop top" id="askBg"></div><div class="sheet confirm" role="dialog"><p>${esc(state.ask.message)}</p><div class="btnrow"><button class="btn sec" id="askNo" type="button">${esc(t('cancelView'))}</button><button class="btn" id="askYes" type="button">${esc(state.ask.yes || t('confirmView'))}</button></div></div>` : '';
  inner += ask;
  app.innerHTML = `${reset}${demo}${note}${inner}${tabs(waiting)}`;
  syncBackButton();
  renderGlobalErrorBanner(uiStore ? uiStore.get().error : null);
  const undoButton = app.querySelector('[data-undo]');
  if (undoButton) {
    undoButton.onclick = async () => {
      try {
        await api(`/v1/intl/leads/${encodeURIComponent(undoButton.dataset.undo)}/unhandled`, { method: 'POST', body: '{}' });
        state.notice = t('undoDone');
        haptic('success');
      } catch (err) { state.notice = errText(err); haptic('error'); }
      showInbox().catch(fail);
    };
  }
  app.querySelectorAll('[data-lang]').forEach((button) => {
    button.onclick = () => {
      state.lang = button.dataset.lang;
      localStorage.setItem('intl-lang', state.lang);
      boot().catch(fail);
    };
  });
  const no = document.getElementById('askNo');
  if (no) no.onclick = () => { state.ask = null; boot().catch(fail); };
  const yes = document.getElementById('askYes');
  if (yes) yes.onclick = () => {
    const run = state.ask && state.ask.run;
    state.ask = null;
    Promise.resolve(run && run()).catch((err) => { state.notice = errText(err); haptic('error'); boot().catch(fail); });
  };
  const askBg = document.getElementById('askBg');
  if (askBg) askBg.onclick = () => { state.ask = null; boot().catch(fail); };
}


function inspectInitData(raw) {
  if (!raw) return { ok: false, error: 'missing' };
  try {
    const params = new URLSearchParams(String(raw));
    const authDate = Number(params.get('auth_date') || 0);
    const user = JSON.parse(params.get('user') || 'null');
    if (!authDate || !user || !user.id) return { ok: false, error: 'malformed' };
    // Keep in sync with UI_INITDATA_MAX_AGE_S default (1h). Prefer a fresh SDK token over a stale cache.
    if (Date.now() / 1000 - authDate > 3600) return { ok: false, error: 'expired' };
    return { ok: true, user };
  } catch {
    return { ok: false, error: 'malformed' };
  }
}

function showGlobalError(message) {
  const text = String(message || 'Error').slice(0, 240);
  if (uiStore) uiStore.set({ error: { message: text, at: Date.now() } });
  else renderGlobalErrorBanner({ message: text });
}

function renderGlobalErrorBanner(error) {
  let node = document.getElementById('globalErr');
  if (!error) {
    if (node) node.remove();
    return;
  }
  if (!node) {
    node = document.createElement('div');
    node.id = 'globalErr';
    node.className = 'globalerr';
    node.setAttribute('role', 'alert');
    app.prepend(node);
  }
  node.innerHTML = `<span>${esc(error.message)}</span><button type="button" id="globalErrRetry">${esc(t('retry'))}</button><button type="button" id="globalErrClose" aria-label="close">×</button>`;
  const retry = node.querySelector('#globalErrRetry');
  if (retry) retry.onclick = () => { if (uiStore) uiStore.set({ error: null }); boot().catch(fail); };
  const close = node.querySelector('#globalErrClose');
  if (close) close.onclick = () => { if (uiStore) uiStore.set({ error: null }); };
}

function reportError(error, source) {
  const message = error && error.message ? error.message : String(error || 'Error');
  try { console.error('[intl]', source || 'error', message); } catch { /* noop */ }
  showGlobalError(message);
  try {
    fetch('/v1/intl/client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: String(message).slice(0, 300), screen: state.screen, source: source || '' }),
      keepalive: true,
    }).catch(() => {});
  } catch { /* noop */ }
}

function requestRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  Promise.resolve().then(() => {
    renderScheduled = false;
    boot().catch(fail);
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('error', (event) => reportError(event.error || event.message, 'window'));
  window.addEventListener('unhandledrejection', (event) => reportError(event.reason, 'promise'));
  window.addEventListener('offline', () => { if (uiStore) uiStore.set({ online: false }); });
  window.addEventListener('online', () => { if (uiStore) uiStore.set({ online: true }); });
}

function whatsappFieldError(selected, value) {
  if (selected === 'green') {
    if (!/^\d{3,20}$/.test(String(value('waIdInstance')).trim())) return t('waBadInstance');
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(String(value('waApiToken')).trim())) return t('waBadToken');
    return '';
  }
  if (!/^[A-Za-z0-9._-]{20,}$/.test(String(value('waCloudToken')).trim())) return t('waBadCloudToken');
  if (!/^\d{5,20}$/.test(String(value('waCloudPhone')).trim())) return t('waBadCloudPhone');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(value('waCloudVerify')).trim())) return t('waBadCloudVerify');
  if (!/^[A-Za-z0-9]{16,64}$/.test(String(value('waCloudSecret')).trim())) return t('waBadCloudSecret');
  return '';
}

function fail(err) {
  reportError(err, 'screen');
}

function channelChip(channel, iconOnly) {
  const kind = channel === 'telegram' ? 'tg' : channel === 'whatsapp' ? 'wa' : 'sim';
  const name = iconOnly ? '' : esc(kind === 'tg' ? t('telegram') : kind === 'wa' ? t('whatsapp') : t('simulator'));
  const icon = kind === 'tg' ? ICO.tg : kind === 'wa' ? ICO.wa : '';
  return `<span class="ch ${kind}">${icon}${name}</span>`;
}

function mark(lead) {
  return lead.readiness || lead.grade || 'COLD';
}

function statusLabel(lead) {
  if (lead.status === 'archived') return t('archiveTitle');
  if (lead.status === 'pending_approval') return t('needsOk');
  if (lead.status === 'review') return t('needsReview');
  if (lead.status === 'stopped') return t('optedOut');
  if (lead.bucket === 'confirmed' || (lead.status === 'sent' && lead.client_confirmed)) return t('confirmedMark');
  if (lead.bucket === 'awaiting' || lead.status === 'sent') return t('awaitingMark');
  if (lead.pipeline === 'viewing') return t('viewingBooked');
  return t('replied');
}

function inquiryMark(lead) {
  if (lead.status === 'stopped') return t('optedOut');
  if (lead.bucket === 'confirmed' || (lead.status === 'sent' && lead.client_confirmed)) return t('confirmedMark');
  if (lead.bucket === 'awaiting' || lead.status === 'sent') return t('awaitingMark');
  return t('unanswered');
}

function timingText(lead) {
  const label = lead.timing_label || '';
  if (!lead.timing_class && !label) return t('notStated');
  if (state.lang === 'ru') {
    if (TIMING_RU[label]) return TIMING_RU[label];
    const within = String(label).match(/within (\d+) months?/);
    if (within) return `в течение ${within[1]} мес.`;
    const words = { concrete: 'конкретный срок', months_le3: 'в течение 3 месяцев', other: 'другой срок' };
    return words[lead.timing_class] || t('notStated');
  }
  if (label) return label;
  const words = { concrete: 'a specific time', months_le3: 'within 3 months', other: 'another time' };
  return words[lead.timing_class] || t('notStated');
}

function clock(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat(state.lang === 'ru' ? 'ru-RU' : 'en-GB', {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Dubai',
  }).format(new Date(iso));
}

function place(title) {
  const text = String(title || '');
  const cut = text.split(',').slice(1).join(',').trim();
  return cut || text;
}

function propertyTitle(properties, id) {
  return place((properties.find((row) => row.id === id) || {}).title || id || '');
}

function zoned(iso, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz || 'Asia/Dubai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(iso)).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return { ...parts, key: `${parts.year}-${parts.month}-${parts.day}` };
}

function utcDate(key) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function shiftKey(key, days) {
  const date = utcDate(key);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function weekStartKey(key) {
  const start = utcDate(key);
  const weekday = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - weekday);
  return start.toISOString().slice(0, 10);
}

function weekDates(anchorKey) {
  const start = utcDate(weekStartKey(anchorKey));
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(start);
    day.setUTCDate(start.getUTCDate() + index);
    return day.toISOString().slice(0, 10);
  });
}

function isoWeek(key) {
  const date = utcDate(key);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}

function isMainListLead(lead, filter, propertyId) {
  const bucket = lead.bucket || (lead.status === 'archived' ? 'archive' : lead.status === 'sent' ? 'awaiting' : 'active');
  if (bucket !== 'active') return false;
  if (filter && filter !== 'ALL' && (lead.readiness || lead.grade) !== filter) return false;
  if (propertyId && lead.property_id !== propertyId) return false;
  return true;
}

function countMainList(leads, filter, propertyId) {
  return (leads || []).filter((lead) => isMainListLead(lead, filter, propertyId)).length;
}

function leadsQuery(extra = {}) {
  const params = new URLSearchParams();
  if (extra.archived) params.set('archived', '1');
  if (extra.property_id || state.propertyId) params.set('property_id', extra.property_id || state.propertyId);
  if (state.q) params.set('q', state.q);
  if (state.workspaceId) params.set('workspace', state.workspaceId);
  const qs = params.toString();
  return qs ? `/v1/intl/leads?${qs}` : '/v1/intl/leads';
}

async function refreshBadge() {
  const list = await api(leadsQuery());
  applyWorkspaceMeta(list);
  state.leadRows = list.leads || [];
  state.badge = countMainList(state.leadRows, state.filter, state.propertyId);
  return state.badge;
}

function leadLink(lead, props) {
  const name = lead.clean_name || lead.sender_name || lead.id;
  const initial = (String(name).trim()[0] || '•').toUpperCase();
  const grade = mark(lead);
  const pending = lead.status === 'pending_approval' || lead.status === 'review';
  const state = pending ? 'wait' : (lead.bucket === 'confirmed' ? 'ok' : 'sent');
  const stateText = pending ? t('noReply')
    : lead.status === 'handled' ? t('handledMark')
      : lead.bucket === 'confirmed' ? t('confirmedMark')
        : lead.status === 'sent' ? t('replySentShort') : t('waitingShort');
  return `<a class="item chev" href="#/lead/${esc(lead.id)}" data-swipe="${esc(lead.id)}" data-status="${esc(lead.status || '')}"><span class="av ${esc(grade)}">${esc(initial)}<i class="${esc(String(grade).toLowerCase())}"></i></span>
    <div class="main"><div class="t"><bdi dir="auto">${esc(name)}</bdi> <span class="g ${esc(grade)}">${esc(grade)}</span></div>
    <div class="s">${channelChip(lead.channel, true)} · ${esc(propertyTitle(props, lead.property_id))}</div></div>
    <div class="r"><span class="time">${esc(clock(lead.first_msg_at))}</span><span class="state ${state}">${esc(stateText)}</span></div></a>`;
}

async function showInbox() {
  const [list, props, team] = await Promise.all([
    api(leadsQuery()),
    api(withWorkspace('/v1/intl/properties')),
    api('/v1/intl/team').catch(() => state.team),
  ]);
  applyWorkspaceMeta(list);
  if (team && team.ok !== false) state.team = team;
  const leads = list.leads || [];
  const awaiting = leads.filter((lead) => lead.bucket === 'awaiting');
  const confirmed = leads.filter((lead) => lead.bucket === 'confirmed');
  const active = leads.filter((lead) => isMainListLead(lead, state.filter, state.propertyId));
  const mainCount = active.length;
  state.badge = mainCount;
  state.leadRows = leads;
  const properties = props.properties || [];
  const propName = state.propertyId ? propertyTitle(properties, state.propertyId) : '';
  const langSwitch = langSwitchHtml();
  const rows = active.map((lead) => leadLink(lead, properties)).join('');
  shell(`
    <div class="hd"><div class="hd-row"><h1>${esc(t('inbox'))}<span class="hd-count">${mainCount}</span></h1><div class="hd-tools"><a class="iconbtn hd-ico" id="openArchive" href="#/archive" aria-label="${esc(t('archive'))}">${ICO.box}</a>${langSwitch}</div></div></div>
    ${workspaceSwitchHtml()}
    <div class="folders"><a class="folder processed" id="openAwaiting" href="#/processed"><span class="fico">✓</span><b class="folder-title">${esc(t('processed'))}</b><span class="fnum">${awaiting.length}</span><small>${esc(t('processedSub'))}</small></a>
      <a class="folder confirmed" id="openConfirmed" href="#/confirmed"><span class="fico">📅</span><b class="folder-title">${esc(t('confirmed'))}</b><span class="fnum ok">${confirmed.length}</span><small>${esc(t('confirmedSub'))}</small></a></div>
    <div class="seg">${['ALL', 'HOT', 'WARM', 'COLD'].map((grade) => `<button type="button" data-f="${grade}" class="${state.filter === grade ? 'on' : ''}">${grade === 'ALL' ? esc(t('all')) : grade}</button>`).join('')}</div>
    ${propName ? `<div class="chips padchips"><button class="tslot on" id="clearProp" type="button">${esc(propName)} ×</button></div>` : ''}
    ${rows ? `<div class="card list">${rows}</div>` : `<p class="foot empty">${esc(t('filterEmpty'))}</p>`}`, mainCount);
  wireWorkspaceSelect();
  app.querySelectorAll('[data-f]').forEach((button) => {
    button.onclick = () => { state.filter = button.dataset.f; showInbox().catch(fail); };
  });
  app.querySelectorAll('[data-swipe]').forEach((row) => {
    let startX = null;
    let startY = null;
    row.addEventListener('touchstart', (event) => {
      if (event.touches.length === 1) {
        startX = event.touches[0].clientX;
        startY = event.touches[0].clientY;
      }
    }, { passive: true });
    row.addEventListener('touchend', (event) => {
      if (startX == null) return;
      const touch = event.changedTouches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      startX = null;
      startY = null;
      if (Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx)) return;
      event.preventDefault();
      const id = row.dataset.swipe;
      const run = async () => {
        if (dx > 0) {
          await api(`/v1/intl/leads/${encodeURIComponent(id)}/handled`, { method: 'POST', body: '{}' });
          state.notice = t('handledDone');
          state.undo = { id, kind: 'handled' };
        } else if (row.dataset.status === 'sent') {
          await api(`/v1/intl/leads/${encodeURIComponent(id)}/confirm`, { method: 'POST', body: '{}' });
          state.notice = t('confirmDone');
        } else {
          location.hash = `#/lead/${id}`;
          return;
        }
        haptic('success');
        showInbox().catch(fail);
      };
      run().catch((err) => { state.notice = errText(err); haptic('error'); showInbox().catch(fail); });
    }, { passive: false });
  });
  const clearProp = document.getElementById('clearProp');
  if (clearProp) clearProp.onclick = () => { state.propertyId = ''; showInbox().catch(fail); };
}

function hydrateLead(lead) {
  const options = lead.options || [];
  const draft = lead.draft;
  let slotIds = [];
  if (draft && draft.slot_ids) {
    try {
      const parsed = JSON.parse(draft.slot_ids);
      slotIds = Array.isArray(parsed) ? parsed : [];
    } catch { slotIds = []; }
  }
  if (draft && String(draft.text || '').trim()) {
    state.draftText = draft.text;
    state.slotIds = slotIds;
    state.manual = draft.option_id == null;
    state.option = options.find((row) => row.id === draft.option_id) || (draft.option_id == null ? { id: null, text: draft.text } : null);
  } else {
    state.option = options[0] || null;
    state.draftText = state.option ? state.option.text : '';
    state.slotIds = [...(state.option?.slot_ids || [])];
    state.manual = lead.status === 'review';
  }
  state.attachments = attachmentList(draft, state.option);
  state.sheet = query.get('sheet') === '1';
}

function propertyMaterials(property) {
  if (!property || property.id === 'general') return [];
  const items = [];
  if (property.brochure_url) items.push({ kind: 'brochure', name: 'PDF', url: property.brochure_url });
  if (property.plan_url) items.push({ kind: 'plan', name: 'plan', url: property.plan_url });
  if (property.listing_url) items.push({ kind: 'link', name: 'listing', url: property.listing_url });
  return items;
}

function hasAttachment(kind, url) {
  return (state.attachments || []).some((item) => item.kind === kind && item.url === url);
}

async function showLead() {
  const [data, badge, templatesRes, auditRes] = await Promise.all([
    api(`/v1/intl/leads/${encodeURIComponent(state.leadId)}`),
    refreshBadge(),
    api('/v1/intl/templates').catch(() => ({ templates: [] })),
    state.auditOpen
      ? api(`/v1/intl/audit?lead_id=${encodeURIComponent(state.leadId)}`).catch(() => ({ rows: [] }))
      : Promise.resolve({ rows: [] }),
  ]);
  const lead = data.lead;
  if (lead.can_write != null) state.canWrite = lead.can_write !== false;
  if (state.loadedLead !== lead.id || state.loadedStatus !== lead.status) {
    if (state.fileUrl) URL.revokeObjectURL(state.fileUrl);
    state.fileUrl = '';
    hydrateLead(lead);
    state.loadedLead = lead.id;
    state.loadedStatus = lead.status;
  }
  const stopped = lead.status === 'stopped';
  const review = lead.status === 'review';
  const writable = state.canWrite !== false;
  const editable = writable && (lead.status === 'pending_approval' || lead.status === 'review');
  const options = editable ? (lead.options || []) : [];
  const slots = editable ? (lead.slots || []) : [];
  const replyLang = lead.language === 'ru' ? 'ru' : 'en';
  const timeline = (lead.messages || []).filter((row) => row.direction === 'in' || row.direction === 'out');
  const note = NOTE[replyLang];
  const templates = templatesRes.templates || [];
  const auditRows = auditRes.rows || [];
  const materials = propertyMaterials(lead.property);
  const slotButtons = (attr, list = slots) => list.map((slot) => `<button class="tslot ${(state.slotIds || []).includes(slot.id) ? 'on' : ''}" type="button" ${attr}="${esc(slot.id)}">${esc((attr === 'data-insert' ? '✓ ' : '') + ((replyLang === 'ru' ? slot.label_ru : slot.label_en) || slot.start_utc || '').split(' (')[0])}</button>`).join('');
  const optionCards = (list, attr) => list.map((row) => `<button class="opt ${state.option && state.option.id === row.id ? 'on' : ''}" type="button" ${attr}="${esc(row.id)}"><b>${esc(state.lang === 'ru' ? row.label_ru : row.label_en)}</b><span>${esc(row.text)}</span></button>`).join('');
  const leadName = lead.clean_name || lead.sender_name || lead.id;
  const leadInitial = (String(leadName).trim()[0] || '•').toUpperCase();
  const channelName = lead.channel === 'telegram' ? 'Telegram' : lead.channel === 'whatsapp' ? 'WhatsApp' : t('simulator');
  const langLabel = lead.language === 'ru' ? 'RU' : lead.language === 'en' ? 'EN' : String(lead.language || '').toUpperCase();
  const slotLabel = (slot) => String((replyLang === 'ru' ? slot.label_ru : slot.label_en) || slot.start_utc || '').split(' (')[0];
  const optionSlots = (row) => (row.slot_ids || []).map((id) => slots.find((slot) => slot.id === id)).filter(Boolean);
  const optionSlotChips = (row) => optionSlots(row).map((slot) => `<button class="tslot ${(state.slotIds || []).includes(slot.id) ? 'on' : ''}" type="button" data-optslot="${esc(slot.id)}" data-opt-id="${esc(row.id)}">${esc(slotLabel(slot))}</button>`).join('');
  const cityLabel = (() => {
    const tz = String(lead.property?.tz || '');
    const city = tz.split('/').pop() || '';
    if (replyLang !== 'ru') return city;
    return ({ Istanbul: 'Стамбул', Dubai: 'Дубай' })[city] || city;
  })();
  const aiPicked = options.some((row) => /^(ds_|gemini_)/.test(String(row.id || '')));
  const recommended = (state.option && options.includes(state.option)) ? state.option : (options.find((row) => (row.slot_ids || []).length) || options[0]);
  const optionTag = (row) => {
    const id = String(row.id || '');
    if ((row.slot_ids || []).length) return t('tagTime');
    if (/price|budget/.test(id)) return t('tagBudget');
    if (/pay|finance|install/.test(id)) return t('tagPayment');
    if (/details|answer|property/.test(id)) return t('tagDetails');
    return t('tagShort');
  };
  const optionSlotList = (state.option && optionSlots(state.option).length) ? optionSlots(state.option) : slots.slice(0, 3);
  const slotsUnderReply = slots.length
    ? `<div class="slots"><div class="lbl">${esc(t('proposedSlots'))}${cityLabel ? ` · ${esc(cityLabel)}` : ''}, ${esc(t('freeWord'))}</div><div class="chips">${slotButtons('data-insert', optionSlotList)}</div><button class="btn sec sm" id="openPicker" type="button">${esc(t('pickTime'))}</button></div>`
    : '';
  const variantsHtml = options.length
    ? `<div class="vhead"><h2>${esc(t('optsTitle'))}</h2>${aiPicked ? `<span class="aibadge">${esc(t('aiPicked'))}</span>` : ''}</div><p class="vsub">${esc(aiPicked ? t('aiPickedSub') : t('rulePickedSub'))}</p><div class="optcards">${options.map((row) => {
      const on = state.option && state.option.id === row.id;
      const chips = optionSlotChips(row);
      return `<div class="optcard ${on ? 'on' : ''}"><button class="optmain" type="button" data-opt="${esc(row.id)}"><span class="oh"><b>${esc(state.lang === 'ru' ? row.label_ru : row.label_en)}</b><span class="tag">${esc(optionTag(row))}</span>${recommended === row ? `<span class="rec">${esc(t('recommended'))}</span>` : ''}</span><span class="otext">${esc(row.text || '')}</span></button>${chips ? `<div class="optimes"><div class="lbl">${esc(t('timeToInsert'))}</div><div class="chips">${chips}</div></div>` : ''}</div>`;
    }).join('')}</div>`
    : '';
  const timeSheetHtml = state.timeSheet
    ? `<div class="backdrop top" id="timeSheetBg"></div><div class="sheet picker timesheet" id="timeSheet" role="dialog"><div class="grab"></div><div class="sheethd"><b>${esc(t('timeSheetTitle'))}</b><button class="link" id="timeSheetClose" type="button">${esc(t('doneBtn'))}</button></div><p class="sheetsub">${esc(t('timeSheetSub'))}</p><div class="opts">${optionCards(options.slice(0, 3), 'data-time-opt')}</div><button class="btn sec" id="allTimes" type="button">${esc(t('allFreeTimes'))}</button></div>`
    : '';
  const sheet = state.sheet ? `<div class="backdrop" id="sheetBg"></div><div class="sheet" role="dialog"><div class="grab"></div>
    <div class="sheethd"><b>${esc(t('editReply'))}</b><button class="link" id="sheetDone" type="button">${esc(t('doneBtn'))}</button></div>
    <textarea id="ta" lang="${replyLang}">${esc(state.draftText || '')}</textarea>
    <p class="sheetsub">${esc(t('insertSlot'))}</p>
    <div class="chips">${slotButtons('data-slot')}</div>
    <p class="sheetai">${esc(t('sheetAi'))}</p>
    <p class="sheetai"><i>${esc(note.ai)}</i></p>
    <p class="sheetai">${esc(t('stopLineLabel'))}: <i>${esc(note.stop)}</i></p>
    <button class="btn sec sm" id="reset" type="button">${esc(t('returnOriginal'))}</button></div>` : '';
  const picker = state.picker ? pickerSheet(slots, replyLang, lead.property?.tz) : '';
  const proposedNote = lead.proposed
    ? `<p class="foot">${esc(lead.proposed.free ? t('clientTimeFree') : t('clientTimeBusy'))}: ${esc(replyLang === 'ru' ? lead.proposed.label_ru : lead.proposed.label_en)}</p>`
    : '';
  const attachName = { brochure: `${t('brochure')} · ${t('linkWord')}`, plan: `${t('floorPlan')} · ${t('linkWord')}`, link: t('linkPh') };
  const attachRow = (state.attachments || []).length
    ? `<div class="attach" id="attachList">${state.attachments.map((item) => `<button type="button" class="tslot" data-attach="${esc(item.kind)}" data-url="${esc(item.url)}">${esc(t('attached'))}: ${esc(attachName[item.kind] || item.name)}</button>`).join('')}</div>${state.fileUrl ? `<iframe id="filePreview" class="fileview" title="${esc(t('brochure'))}" src="${esc(state.fileUrl)}"></iframe>` : ''}`
    : '';
  const historyHtml = timeline.map((row) => {
    const gone = row.deleted || !row.text;
    const body = gone ? esc(t('msgRemoved')) : esc(row.text);
    return `<div class="msg ${esc(row.direction)}${gone ? ' gone' : ''}" data-msg="${esc(row.id || '')}"><bdi dir="auto">${body}</bdi></div>`;
  }).join('');
  const draftHtml = `<div class="draftmsg" id="replyText" ${editable ? 'contenteditable="true" role="textbox" spellcheck="true"' : ''}><bdi dir="auto">${esc(state.draftText || '')}</bdi></div>`;
  const property = lead.property || {};
  const hasProperty = Boolean(property.id && property.id !== 'general');
  const inBudget = hasProperty && lead.budget_amount != null && property.price != null && Number(property.price) <= Number(lead.budget_amount);
  const groupNum = (value) => Number(value).toLocaleString(state.lang === 'ru' ? 'ru-RU' : 'en-US');
  const moneyShort = (amount, currency) => (amount == null || amount === '' ? '' : `${groupNum(amount)} ${currency === 'USD' ? '$' : (currency || '')}`.trim());
  const unitLabel = (unit) => (unit === 'sqm' || !unit ? 'м²' : unit === 'sqft' ? 'ft²' : unit);
  const propertyCard = hasProperty
    ? `<div class="propcard"><small>${esc(t('matchedProperty'))}</small><div class="prow"><b>${esc(property.title || '')}</b>${inBudget ? `<span class="pill ok">${esc(t('inBudget'))}</span>` : ''}</div><p>${esc([property.area_value ? `${property.area_value} ${unitLabel(property.area_unit)}` : '', moneyShort(property.price, property.currency)].filter(Boolean).join(' · '))}</p></div>`
    : '';
  const actionHint = mark(lead) === 'HOT' ? t('actionHot') : mark(lead) === 'WARM' ? t('actionWarm') : t('actionCold');
  const nextAction = `<div class="nextaction"><small>${esc(t('nextStep'))}</small><b>${esc(actionHint)}</b></div>`;
  const langWarn = ['en', 'ru'].includes(String(lead.language || 'en')) ? '' : `<div class="card pad warnbox"><b>${esc(t('langWarnTitle'))}</b><p>${esc(fill('langWarn', { lang: String(lead.language || '').toUpperCase() }))}</p></div>`;
  const factCards = `<div class="facts"><div class="fact"><small>${esc(t('wants'))}</small><b>${esc(intentLabel(lead.intent))}</b></div><div class="fact"><small>${esc(t('budget'))}</small><b>${esc(moneyShort(lead.budget_amount, lead.budget_currency) || budgetText(lead))}</b></div><div class="fact"><small>${esc(t('paymentLabel'))}</small><b>${esc(lead.cash ? t('cashPayment') : t('paymentUnknown'))}</b></div><div class="fact"><small>${esc(t('districtLabel'))}</small><b>${esc(property.district || property.title || '—')}</b></div></div>`;
  const confirmClientCard = (lead.status === 'sent' && lead.client_confirmed)
    ? `<div class="card pad confirmbox"><b>${esc(t('confirmClientTitle'))}</b><p>${esc(t('confirmClientSub'))}</p><button class="btn" id="confirmDraft" type="button">${esc(t('confirmClientBtn'))}</button></div>`
    : '';
  const closeChips = `<div class="closes">${esc(t('closes'))}: <span class="${hasProperty ? 'ok' : ''}">${hasProperty ? '✓' : '·'} ${esc(t('closesObject'))}</span> <span class="${lead.budget_amount != null ? 'ok' : ''}">${lead.budget_amount != null ? '✓' : '·'} ${esc(t('closesBudget'))}</span> <span class="${(state.slotIds || []).length ? 'ok' : ''}">${(state.slotIds || []).length ? '✓' : '·'} ${esc(t('closesTime'))}</span></div>`;
  const nativeMain = Boolean(tg() && tg().MainButton);
  const tplHtml = templates.length
    ? `<div class="sh"><span>${esc(t('templatesTitle'))}</span></div><div class="chips padchips">${templates.map((row) => {
      const label = replyLang === 'ru' ? (row.label_ru || row.label_en) : (row.label_en || row.label_ru);
      return `<button class="tslot" type="button" data-tpl="${esc(row.id)}">${esc(label)}</button>`;
    }).join('')}</div>`
    : '';
  const materialsHtml = materials.length && editable
    ? `<div class="sh"><span>${esc(t('attachMaterials'))}</span></div><div class="chips padchips">${materials.map((item) => {
      const on = hasAttachment(item.kind, item.url);
      return `<button class="tslot ${on ? 'on' : ''}" type="button" data-mat="${esc(item.kind)}" data-url="${esc(item.url)}" data-name="${esc(item.name || '')}">${esc(attachName[item.kind] || item.name)}</button>`;
    }).join('')}</div>`
    : '';
  const auditHtml = state.auditOpen
    ? (auditRows.length
      ? `<div class="card audit">${auditRows.map((row) => `<div class="auditrow"><b>${esc(row.action || '')}</b><span>${esc(clock(row.ts) || row.ts || '')}</span></div>`).join('')}</div>`
      : `<p class="foot">${esc(t('auditEmpty'))}</p>`)
    : '';
  shell(`<div class="backrow"><a class="back" href="${lead.status === 'archived' ? '#/archive' : '#/inbox'}">‹ ${esc(lead.status === 'archived' ? t('archiveTitle') : t('inbox'))}</a><span class="spacer"></span><button class="iconbtn" id="moreLead" type="button">⋯</button></div>
    <div class="leadhead"><span class="lav">${esc(leadInitial)}</span><div class="main"><div class="nm"><bdi dir="auto">${esc(leadName)}</bdi><span class="g ${esc(mark(lead))}">${esc(mark(lead))}</span></div><div class="sub">${channelChip(lead.channel)} · ${esc(place(property.district || property.title || ''))} · ${esc(t('language'))} ${esc(langLabel)}</div></div></div>
    <div class="thread" id="threadTimeline">${historyHtml}</div>
    ${factCards}
    ${nextAction}
    ${langWarn}
    ${propertyCard}
    <div class="card answer"><div class="bh"><span class="lbl">${esc(t('answerLabel'))} · ${esc(channelName)}</span><span class="spacer"></span><button class="link" id="edit" type="button">${esc(t('editText'))}</button></div>
      ${draftHtml}
      ${attachRow}
      ${slotsUnderReply}
      ${closeChips}
    </div>
    ${confirmClientCard}
    ${variantsHtml}
    ${writable ? '' : `<p class="foot">${esc(t('teamViewerReadonly'))}</p>`}
    <div class="actbar"><div class="sendbar"><button class="iconbtn" id="archive" type="button" title="${esc(t('archiveBtn'))}" ${writable ? '' : 'disabled'}>${ICO.box}</button><button class="iconbtn" id="toggleAudit2" type="button" title="${esc(t('auditShow'))}">⋯</button>${nativeMain || !writable ? '' : `<button class="btn go sendprimary" id="send" type="button" ${stopped ? 'disabled' : ''}>➤ ${esc(t('send'))} · ${esc(channelName)}</button>`}</div></div>
    ${tplHtml}
    ${materialsHtml}
    <div class="card pad"><div class="btnrow">
      <button class="btn sec" id="followUp" type="button">${esc(t('followUp24'))}</button>
      <button class="btn sec" id="toggleAudit" type="button">${esc(state.auditOpen ? t('auditHide') : t('auditShow'))}</button>
    </div></div>
    ${auditHtml}
    <div class="card pad"><div class="btnrow">
      <button class="btn sec" id="stop" type="button" ${stopped || !writable ? 'disabled' : ''}>${esc(t('stopBtn'))}</button>
      <button class="btn danger" id="erase" type="button" ${writable ? '' : 'disabled'}>${esc(t('eraseBtn'))}</button>
    </div></div>
    ${stopped ? `<p class="foot">${esc(t('optedOut'))}</p>` : ''}
    ${lead.status === 'sent' ? `<p class="foot">${esc(t('sentSim'))}</p>` : ''}
    ${lead.status === 'sent' && !lead.client_confirmed ? `<button class="btn midbtn" id="confirmLead" type="button">${esc(t('markConfirmed'))}</button>` : ''}
    ${lead.status === 'sent' && lead.client_confirmed ? `<p class="foot">${esc(t('confirmedMark'))}</p>` : ''}
    ${review ? `<p class="foot">${esc(t('notUnderstood'))}</p><button class="btn" id="manual" type="button">${esc(t('replyManually'))}</button>` : ''}
    ${lead.stale_sending ? `<p class="foot">${esc(t('stale'))}</p>` : ''}
    ${lead.unknown_delivery ? `<p class="foot">${esc(t('unknownDelivery'))}</p><button class="btn sec" id="forceSend" type="button">${esc(t('forceSend'))}</button>` : ''}
    ${lead.calendar_error ? `<p class="foot" id="calendarError">${esc(t('calendarUnavailable'))}</p>` : ''}
    ${timeSheetHtml}
    ${picker}
    ${sheet}
    <p class="foot" id="formError" role="alert"></p>
`, badge);
  const send = document.getElementById('send');
  if (send) send.disabled = !editable || !String(state.draftText || '').trim();
  app.querySelectorAll('[data-opt]').forEach((button) => {
    button.onclick = async () => {
      state.option = options.find((row) => row.id === button.dataset.opt);
      if (!state.option) return;
      state.draftText = state.option.text;
      state.slotIds = [...(state.option.slot_ids || [])];
      state.attachments = state.option.attachments || [];
      state.manual = false;
      state.sheet = false;
      if (state.option.id === 'other') state.picker = true;
      try {
        await api(`/v1/intl/leads/${encodeURIComponent(lead.id)}/draft`, { method: 'PUT', body: JSON.stringify(draftPayload()) });
      } catch (err) {
        state.notice = errText(err);
      }
      showLead().catch(fail);
    };
  });
  app.querySelectorAll('[data-optslot]').forEach((button) => {
    button.onclick = async () => {
      const option = options.find((row) => row.id === button.dataset.optId);
      if (!option) return;
      state.option = option;
      state.draftText = option.text;
      state.slotIds = [...(option.slot_ids || [])];
      state.attachments = option.attachments || [];
      state.manual = false;
      insertProposal(lead, replyLang, button.dataset.optslot);
      try {
        await api(`/v1/intl/leads/${encodeURIComponent(lead.id)}/draft`, { method: 'PUT', body: JSON.stringify(draftPayload()) });
      } catch (err) {
        state.notice = errText(err);
      }
      showLead().catch(fail);
    };
  });
  const moreLead = document.getElementById('moreLead');
  if (moreLead) moreLead.onclick = () => { state.auditOpen = !state.auditOpen; showLead().catch(fail); };
  const audit2 = document.getElementById('toggleAudit2');
  if (audit2) audit2.onclick = () => { state.auditOpen = !state.auditOpen; showLead().catch(fail); };
  const confirmDraft = document.getElementById('confirmDraft');
  if (confirmDraft) {
    confirmDraft.onclick = async () => {
      const name = String(lead.clean_name || lead.sender_name || '').trim();
      const chosen = (state.slotIds || []).map((slotId) => slots.find((slot) => slot.id === slotId)).filter(Boolean)[0] || slots[0];
      const when = chosen ? slotLabel(chosen) : '';
      const lines = replyLang === 'ru'
        ? ['Здравствуйте, ' + name + '! Подтверждаю показ: ' + (property.title || '') + (when ? ', ' + when : '') + '.',
          property.address ? 'Адрес: ' + property.address + '.' : '',
          property.meeting_point ? 'Встреча: ' + property.meeting_point + '.' : '',
          property.access_notes ? property.access_notes + '.' : '',
          'Подтвердите, пожалуйста, что время удобно. До встречи!']
        : ['Hello ' + name + '! Confirming the viewing: ' + (property.title || '') + (when ? ', ' + when : '') + '.',
          property.address ? 'Address: ' + property.address + '.' : '',
          property.meeting_point ? 'Meeting point: ' + property.meeting_point + '.' : '',
          property.access_notes ? property.access_notes + '.' : '',
          'Please confirm the time works for you. See you!'];
      state.draftText = lines.filter(Boolean).join(' ');
      state.option = null;
      state.manual = true;
      state.slotIds = chosen ? [chosen.id] : [];
      try {
        await api(`/v1/intl/leads/${encodeURIComponent(lead.id)}/draft`, { method: 'PUT', body: JSON.stringify(draftPayload()) });
      } catch (err) { state.notice = errText(err); }
      showLead().catch(fail);
    };
  }
  app.querySelectorAll('[data-tpl]').forEach((button) => {
    button.onclick = () => {
      const row = templates.find((item) => item.id === button.dataset.tpl);
      if (!row) return;
      const text = replyLang === 'ru' ? (row.text_ru || row.text_en) : (row.text_en || row.text_ru);
      if (!text) return;
      state.draftText = text;
      state.manual = true;
      state.option = { id: null, text };
      showLead().catch(fail);
    };
  });
  app.querySelectorAll('[data-mat]').forEach((button) => {
    button.onclick = async () => {
      const kind = button.dataset.mat;
      const url = button.dataset.url;
      const name = button.dataset.name || kind;
      if (hasAttachment(kind, url)) {
        state.attachments = (state.attachments || []).filter((item) => !(item.kind === kind && item.url === url));
      } else {
        state.attachments = [...(state.attachments || []), { kind, name, url }];
      }
      try {
        await api(`/v1/intl/leads/${encodeURIComponent(lead.id)}/draft`, { method: 'PUT', body: JSON.stringify(draftPayload()) });
      } catch (err) {
        state.notice = errText(err);
      }
      showLead().catch(fail);
    };
  });
  const followUp = document.getElementById('followUp');
  if (followUp) followUp.onclick = async () => {
    try {
      await api('/v1/intl/followups', { method: 'POST', body: JSON.stringify({ lead_id: lead.id, in_hours: 24 }) });
      state.notice = t('followUpDone');
      haptic('success');
    } catch (err) {
      state.notice = errText(err);
      haptic('error');
    }
    showLead().catch(fail);
  };
  const toggleAudit = document.getElementById('toggleAudit');
  if (toggleAudit) toggleAudit.onclick = () => { state.auditOpen = !state.auditOpen; showLead().catch(fail); };
  const edit = document.getElementById('edit');
  if (edit) edit.onclick = () => { openSendSheet(); showLead().catch(fail); };
  app.querySelectorAll('[data-insert]').forEach((button) => {
    button.onclick = () => {
      // A proposed time is not just text to insert: it opens the "suggest a time" sheet with the
      // three reply variants and the full list of free times from the connected calendar.
      state.pendingSlot = button.dataset.insert;
      state.timeSheet = true;
      showLead().catch(fail);
    };
  });
  app.querySelectorAll('[data-time-opt]').forEach((button) => {
    button.onclick = async () => {
      const option = options.find((row) => row.id === button.dataset.timeOpt);
      if (!option) return;
      state.option = option;
      state.draftText = option.text;
      state.slotIds = [...(option.slot_ids || [])];
      state.attachments = option.attachments || [];
      state.manual = false;
      if (state.pendingSlot) insertProposal(lead, replyLang, state.pendingSlot);
      state.timeSheet = false;
      state.pendingSlot = '';
      try {
        await api(`/v1/intl/leads/${encodeURIComponent(lead.id)}/draft`, { method: 'PUT', body: JSON.stringify(draftPayload()) });
      } catch (err) {
        state.notice = errText(err);
      }
      showLead().catch(fail);
    };
  });
  const allTimes = document.getElementById('allTimes');
  if (allTimes) allTimes.onclick = () => { state.timeSheet = false; state.pendingSlot = ''; state.picker = true; showLead().catch(fail); };
  const timeSheetClose = document.getElementById('timeSheetClose');
  if (timeSheetClose) timeSheetClose.onclick = () => { state.timeSheet = false; state.pendingSlot = ''; showLead().catch(fail); };
  const timeSheetBg = document.getElementById('timeSheetBg');
  if (timeSheetBg) timeSheetBg.onclick = () => { state.timeSheet = false; state.pendingSlot = ''; showLead().catch(fail); };
  const manual = document.getElementById('manual');
  if (manual) manual.onclick = () => { state.option = { id: null, text: '' }; state.draftText = ''; state.slotIds = []; state.manual = true; openSendSheet(); showLead().catch(report); };
  const archive = document.getElementById('archive');
  if (archive) archive.onclick = async () => {
    try {
      await api(`/v1/intl/leads/${encodeURIComponent(lead.id)}/archive`, { method: 'POST', body: '{}' });
      state.sheet = false;
      state.picker = false;
      state.loadedLead = '';
      state.notice = t('archivedSim');
      clearMainButton();
      go('#/inbox');
    } catch (err) {
      report(err);
    }
  };
  app.querySelectorAll('[data-attach]').forEach((button) => {
    button.onclick = () => showAttached(button.dataset.url, button.dataset.attach).catch((err) => { state.notice = errText(err); showLead().catch(fail); });
  });
  const openPicker = document.getElementById('openPicker');
  if (openPicker) openPicker.onclick = () => { state.picker = true; showLead().catch(fail); };
  app.querySelectorAll('[data-pick]').forEach((button) => {
    button.onclick = () => chooseSlot(lead, button.dataset.pick).catch((err) => { state.notice = errText(err); showLead().catch(fail); });
  });
  const pickerClose = document.getElementById('pickerClose');
  if (pickerClose) pickerClose.onclick = () => { state.picker = false; showLead().catch(fail); };
  const pickerBg = document.getElementById('pickerBg');
  if (pickerBg) pickerBg.onclick = () => { state.picker = false; showLead().catch(fail); };
  const stop = document.getElementById('stop');
  if (stop) stop.onclick = () => {
    if (stopped) return;
    state.sheet = false;
    state.ask = {
      message: t('stopHint'),
      yes: t('stopBtn'),
      run: async () => {
        await api(`/v1/intl/leads/${encodeURIComponent(lead.id)}/stop`, { method: 'POST', body: '{}' });
        state.loadedLead = '';
        state.loadedStatus = '';
        state.notice = t('stopDone');
        showLead().catch(fail);
      },
    };
    showLead().catch(fail);
  };
  const erase = document.getElementById('erase');
  if (erase) erase.onclick = () => {
    state.sheet = false;
    state.ask = {
      message: t('eraseHint'),
      yes: t('eraseBtn'),
      run: async () => {
        const result = await api(`/v1/intl/leads/${encodeURIComponent(lead.id)}/erase`, { method: 'POST', body: '{}' });
        state.loadedLead = '';
        state.notice = result.optout_kept ? `${t('eraseDone')} ${t('eraseKept')}` : t('eraseDone');
        clearMainButton();
        go('#/inbox');
      },
    };
    showLead().catch(fail);
  };
  wireSheet(lead, replyLang);
  wireInline(lead);
  const forceSend = document.getElementById('forceSend');
  if (forceSend) forceSend.onclick = () => {
    state.ask = {
      message: t('forceSendHint'),
      yes: t('forceSend'),
      run: async () => {
        const key = lead.unknown_key || state.sendKey;
        await api(`/v1/intl/leads/${encodeURIComponent(lead.id)}/send`, {
          method: 'POST',
          headers: { 'Idempotency-Key': key },
          body: JSON.stringify({
            draft_version: lead.draft ? lead.draft.version : undefined,
            manual: !lead.draft || lead.draft.option_id == null,
            force: true,
          }),
        });
        state.sendKey = '';
        state.loadedLead = '';
        state.notice = t('sendDone');
        haptic('success');
        showLead().catch(fail);
      },
    };
    showLead().catch(fail);
  };
  const runSend = () => {
    const bubble = document.getElementById('replyText');
    if (bubble && bubble.isContentEditable) state.draftText = bubble.innerText.trim();
    if (send) send.disabled = true;
    saveAndSend(lead).catch((err) => {
      state.notice = errText(err);
      haptic('error');
      showLead().catch(fail);
    });
  };
  if (send) send.onclick = runSend;
  syncMainButton({
    visible: editable && !stopped,
    text: t('send'),
    enabled: editable && !stopped && Boolean(String(state.draftText || '').trim()),
    onClick: runSend,
  });
  const confirmLead = document.getElementById('confirmLead');
  if (confirmLead) confirmLead.onclick = async () => {
    try {
      await api(`/v1/intl/leads/${encodeURIComponent(lead.id)}/confirm`, { method: 'POST', body: '{}' });
      state.loadedLead = '';
      state.notice = t('confirmDone');
      haptic('success');
      showLead().catch(fail);
    } catch (err) {
      report(err);
    }
  };
}

function attachmentList(draft, option) {
  if (draft && draft.attachments) {
    try {
      const parsed = JSON.parse(draft.attachments);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch { /* use the selected option */ }
  }
  return (option && option.attachments) || [];
}

function propertyBlurb(lead) {
  const property = lead.property;
  if (!property || property.id === 'general') return '';
  const facts = property.facts || {};
  const rooms = property.bedrooms != null && property.bedrooms !== '' ? property.bedrooms : facts.bedrooms;
  const bits = [
    property.district,
    property.address,
    rooms != null && rooms !== '' ? `${rooms} ${state.lang === 'ru' ? 'комн.' : 'bd'}` : '',
    property.area_value ? `${property.area_value} ${property.area_unit || ''}`.trim() : '',
    state.lang === 'ru' ? (property.price_ru || '') : (property.price_en || ''),
  ].filter(Boolean);
  const why = ((lead.match && lead.match.reasons) || []).map((reason) => t(`match_${reason}`)).filter((label) => label && !label.startsWith('match_')).join(', ');
  return `<div class="card pad" id="propertyMatch"><b>${esc(property.title || '')}</b><p>${esc(bits.join(' · '))}</p>${why ? `<small>${esc(t('matchedBy'))}: ${esc(why)}</small>` : ''}</div>`;
}

async function showAttached(url, kind) {
  const headers = {};
  if (String(url || '').startsWith('/v1/') && !String(url).includes('/public/')) {
    headers.Authorization = state.tma ? `tma ${state.tma}` : '';
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw Object.assign(new Error('not_found'), { body: { error_code: 'not_found' } });
  const buf = await res.arrayBuffer();
  const type = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0];
  if (state.fileUrl) URL.revokeObjectURL(state.fileUrl);
  state.fileUrl = URL.createObjectURL(new Blob([buf], { type }));
  state.notice = type === 'application/pdf' ? `${t('brochure')} PDF · ${buf.byteLength}` : `${t('attached')}: ${kind || 'file'}`;
  showLead().catch(fail);
}

function pickerSheet(slots, replyLang, tz) {
  const groups = new Map();
  for (const slot of slots) {
    const zone = zoned(slot.start_utc, tz || 'Asia/Dubai');
    if (!groups.has(zone.key)) groups.set(zone.key, { zone, list: [] });
    groups.get(zone.key).list.push(slot);
  }
  const days = [...groups.values()].sort((a, b) => a.zone.key.localeCompare(b.zone.key)).map(({ zone, list }) => {
    list.sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc));
    const times = list.map((slot) => {
      const time = zoned(slot.start_utc, tz || 'Asia/Dubai');
      return `<button class="tslot" type="button" data-pick="${esc(slot.id)}">${esc(`${time.hour}:${time.minute}`)}</button>`;
    }).join('');
    return `<div class="picker-day"><b>${esc(dayHeading(zone))}</b><div class="chips">${times}</div></div>`;
  }).join('');
  return `<div class="backdrop top" id="pickerBg"></div><div class="sheet picker" id="timePicker" role="dialog"><div class="grab"></div><div class="sheethd"><b>${esc(t('pickTime'))}</b><button class="link" id="pickerClose" type="button">${esc(t('doneBtn'))}</button></div>${days}</div>`;
}

async function chooseSlot(lead, slotId) {
  const result = await api(`/v1/intl/leads/${encodeURIComponent(lead.id)}/apply-slot`, {
    method: 'POST',
    body: JSON.stringify({ slot_id: slotId }),
  });
  state.draftText = result.text;
  state.slotIds = result.slot_ids || [slotId];
  state.picker = false;
  state.loadedLead = '';
  state.notice = t('pickedTime');
  await showLead();
}

function wireInline(lead) {
  const bubble = document.getElementById('replyText');
  if (!bubble || !bubble.isContentEditable) return;
  bubble.addEventListener('input', () => { state.draftText = bubble.innerText; });
  bubble.addEventListener('blur', () => {
    state.draftText = bubble.innerText.trim();
    api(`/v1/intl/leads/${encodeURIComponent(lead.id)}/draft`, {
      method: 'PUT',
      body: JSON.stringify(draftPayload()),
    }).catch((err) => { state.notice = errText(err); });
  });
}

function insertProposal(lead, replyLang, slotId) {
  const slot = (lead.slots || []).find((row) => row.id === slotId);
  if (!slot) return;
  const line = replyLang === 'ru' ? slot.proposal_ru : slot.proposal_en;
  if (!line || state.draftText.includes(line)) return;
  state.draftText = `${state.draftText.trim()} ${line}`.trim();
  if (slot.id && !(state.slotIds || []).includes(slot.id)) state.slotIds = [...(state.slotIds || []), slot.id];
}

function wireSheet(lead, replyLang) {
  const ta = document.getElementById('ta');
  if (!ta) return;
  ta.oninput = () => { state.draftText = ta.value; };
  document.getElementById('reset').onclick = () => {
    state.draftText = state.option?.text || '';
    state.slotIds = [...(state.option?.slot_ids || [])];
    ta.value = state.draftText;
  };
  app.querySelectorAll('[data-slot]').forEach((button) => {
    button.onclick = () => {
      insertProposal(lead, replyLang, button.dataset.slot);
      ta.value = state.draftText;
    };
  });
  document.getElementById('sheetDone').onclick = async () => {
    state.draftText = ta.value;
    try {
      await api(`/v1/intl/leads/${encodeURIComponent(lead.id)}/draft`, {
        method: 'PUT',
        body: JSON.stringify(draftPayload()),
      });
      state.sheet = false;
      state.notice = t('saved');
      showLead().catch(report);
    } catch (err) {
      report(err);
    }
  };
  document.getElementById('sheetBg').onclick = () => { state.sheet = false; state.sendKey = ''; showLead().catch(fail); };
}

function openSendSheet() {
  if (!state.sheet || !state.sendKey) {
    state.sendKey = (globalThis.crypto && typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : `ui-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  state.sheet = true;
}

function sameDraft(payload, draft) {
  if (!draft) return false;
  let slots = [];
  let attachments = [];
  try { slots = JSON.parse(draft.slot_ids || '[]'); } catch { slots = []; }
  try { attachments = JSON.parse(draft.attachments || '[]'); } catch { attachments = []; }
  const option = payload.option_id == null ? null : payload.option_id;
  const storedOption = draft.option_id == null ? null : draft.option_id;
  return String(payload.text || '') === String(draft.text || '')
    && String(option) === String(storedOption)
    && JSON.stringify(payload.slot_ids || []) === JSON.stringify(slots)
    && JSON.stringify(payload.attachments || []) === JSON.stringify(attachments);
}

async function saveAndSend(lead) {
  const payload = draftPayload();
  let version = lead.draft ? lead.draft.version : undefined;
  if (!sameDraft(payload, lead.draft)) {
    const saved = await api(`/v1/intl/leads/${encodeURIComponent(lead.id)}/draft`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    version = saved.version;
  }
  if (!state.sendKey) openSendSheet();
  const result = await api(`/v1/intl/leads/${encodeURIComponent(lead.id)}/send`, {
    method: 'POST',
    headers: { 'Idempotency-Key': state.sendKey },
    body: JSON.stringify({ draft_version: version, manual: state.manual }),
  });
  state.sheet = false;
  state.sendKey = '';
  state.loadedLead = '';
  state.notice = result.simulated === false ? t('sendDone') : t('sentSim');
  clearMainButton();
  haptic('success');
  go('#/inbox');
}

function dayHeading(zone) {
  const month = state.lang === 'ru' ? MON_RU[Number(zone.month) - 1] : MON_EN[Number(zone.month) - 1];
  const weekday = state.lang === 'ru' ? (WD_RU[zone.weekday] || zone.weekday) : zone.weekday;
  return `${weekday} ${Number(zone.day)} ${month}`;
}

function todayKey() {
  return zoned(new Date().toISOString(), state.brokerTz || 'Asia/Dubai').key;
}

function keyZone(key) {
  const day = utcDate(key);
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return { weekday: names[day.getUTCDay()], day: String(day.getUTCDate()), month: String(day.getUTCMonth() + 1) };
}

function dateKeys(items) {
  const today = todayKey();
  const zone = state.brokerTz || 'Asia/Dubai';
  const floor = shiftKey(today, -90);
  const ceil = shiftKey(today, 365);
  let start = shiftKey(today, -14);
  let end = shiftKey(today, 61);
  for (const row of items) {
    const key = zoned(row.start_utc, row.tz || zone).key;
    if (key < start) start = key;
    if (key > end) end = key;
  }
  if (start < floor) start = floor;
  if (end > ceil) end = ceil;
  const keys = [];
  for (let key = start; key <= end; key = shiftKey(key, 1)) keys.push(key);
  return keys;
}

function nearestViewingKey(items, selected) {
  const zone = state.brokerTz || 'Asia/Dubai';
  let best = '';
  let bestDist = Infinity;
  const origin = utcDate(selected).getTime();
  for (const row of items) {
    const key = zoned(row.start_utc, row.tz || zone).key;
    if (key === selected) return '';
    const dist = Math.abs(utcDate(key).getTime() - origin);
    if (dist < bestDist) {
      best = key;
      bestDist = dist;
    }
  }
  return best;
}

function nearestHint(items) {
  const nearest = nearestViewingKey(items, state.dayKey);
  if (!nearest) return '';
  return `<p class="foot">${esc(fill('nearestViewing', { day: dayHeading(keyZone(nearest)) }))}</p>`;
}

function dateStrip(items) {
  const today = todayKey();
  const zone = state.brokerTz || 'Asia/Dubai';
  const labels = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  const labelsRu = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const counts = new Map();
  for (const row of items) {
    const key = zoned(row.start_utc, row.tz || zone).key;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const keys = dateKeys(items);
  return `<div class="datescroll" id="dateScroll">${keys.map((key) => {
    const day = utcDate(key);
    const label = state.lang === 'ru' ? labelsRu[day.getUTCDay()] : labels[day.getUTCDay()];
    const month = state.lang === 'ru' ? MON_RU[day.getUTCMonth()] : MON_EN[day.getUTCMonth()];
    const count = counts.get(key) || 0;
    const marked = count > 0;
    const selected = state.dayKey === key;
    const isToday = key === today;
    const word = state.lang === 'ru' ? 'показов' : 'viewings';
    const aria = `${label} ${day.getUTCDate()} ${month}, ${count} ${word}`;
    const current = isToday || selected ? ' aria-current="date"' : '';
    return `<button class="day ${selected ? 'on' : ''} ${isToday ? 'today' : ''}" type="button" data-day="${key}" aria-label="${esc(aria)}"${current}>${label}<b>${day.getUTCDate()}</b><i class="${marked ? '' : 'no'}"></i></button>`;
  }).join('')}</div>`;
}

function viewingLabel(status) {
  if (status === 'confirmed') return t('confirmed');
  if (status === 'cancelled') return t('cancelled');
  return t('awaiting');
}

async function showFolder(kind) {
  const [list, propsRes, badge] = await Promise.all([
    api('/v1/intl/leads'),
    api('/v1/intl/properties').catch(() => ({ properties: [] })),
    refreshBadge(),
  ]);
  const properties = propsRes.properties || [];
  const want = kind === 'processed' ? 'awaiting' : 'confirmed';
  const leads = (list.leads || []).filter((lead) => lead.bucket === want);
  const title = kind === 'processed' ? t('processed') : t('confirmed');
  const sub = kind === 'processed' ? t('processedSub') : t('confirmedSub');
  const rows = leads.map((lead) => {
    const link = leadLink(lead, properties);
    return kind === 'processed'
      ? `<div class="confirmrow">${link}<button class="btn sm" type="button" data-confirm="${esc(lead.id)}">${esc(t('markConfirmed'))}</button></div>`
      : link;
  }).join('');
  shell(`<div class="backrow"><a class="back" href="#/inbox">‹ ${esc(t('inbox'))}</a></div>
    <div class="hd"><div class="hd-row"><h1>${esc(title)}<span class="hd-count">${leads.length}</span></h1></div><p>${esc(sub)}</p></div>
    ${rows ? `<div class="card list">${rows}</div>` : `<p class="foot">${esc(kind === 'processed' ? t('awaitingEmpty') : t('confirmedEmpty'))}</p>`}`, badge);
  app.querySelectorAll('[data-confirm]').forEach((button) => {
    button.onclick = async () => {
      try {
        await api(`/v1/intl/leads/${encodeURIComponent(button.dataset.confirm)}/confirm`, { method: 'POST', body: '{}' });
        state.notice = t('confirmDone');
        haptic('success');
      } catch (err) {
        state.notice = errText(err);
        haptic('error');
      }
      showFolder(kind).catch(fail);
    };
  });
}

async function showPilot() {
  const badge = await refreshBadge();
  const include = [t('pilotInc1'), t('pilotInc2'), t('pilotInc3'), t('pilotInc4')];
  const exclude = [t('pilotExc1'), t('pilotExc2'), t('pilotExc3'), t('pilotExc4'), t('pilotExc5'), t('pilotExc6')];
  shell(`<div class="backrow"><a class="back" href="#/setup">‹ ${esc(t('setupTitle'))}</a></div>
    <div class="hd"><h1>${esc(t('pilotTitle'))}</h1><p class="hd-sub">${esc(t('pilotPrice'))}</p></div>
    <div class="card pad"><p class="pilot-intro">${esc(t('pilotIntro'))}</p></div>
    <div class="sh"><span>${esc(t('pilotIncludes'))}</span></div>
    <div class="card pad"><ul class="ticks ok">${include.map((item) => `<li>${esc(item)}</li>`).join('')}</ul></div>
    <div class="sh"><span>${esc(t('pilotExcludes'))}</span></div>
    <div class="card pad"><ul class="ticks no">${exclude.map((item) => `<li>${esc(item)}</li>`).join('')}</ul></div>
    <div class="card pad warnbox"><b>${esc(t('pilotWarnTitle'))}</b><p>${esc(t('pilotWarning'))}</p><p>${esc(t('pilotGreen'))}</p><p>${esc(t('pilotLang'))}</p><p>${esc(t('pilotVoice'))}</p></div>`, badge);
}

async function showArchive() {
  const [list, badge] = await Promise.all([
    api('/v1/intl/leads?archived=1'),
    refreshBadge(),
  ]);
  const leads = list.leads || [];
  const row = (lead) => `<a class="item chev" href="#/lead/${esc(lead.id)}"><span class="dot ${esc(mark(lead))}"></span>
    <div class="main"><div class="t"><bdi dir="auto">${esc(lead.clean_name || lead.sender_name || lead.id)}</bdi> <span class="g ${esc(mark(lead))}">${esc(mark(lead))}</span></div>
    <div class="s">${channelChip(lead.channel, true)}</div></div>
    <div class="r">${esc(clock(lead.first_msg_at))}</div></a>`;
  shell(`<a class="back" href="#/inbox">‹ ${esc(t('inbox'))}</a>
    ${bar()}
    <div class="hd"><h1>${esc(t('archiveTitle'))}</h1><p>${esc(fill('leadsLine', leads.length))}</p></div>
    ${leads.length ? `<div class="card">${leads.map(row).join('')}</div>` : `<p class="foot">${esc(t('archiveEmpty'))}</p>`}`, badge);
}

async function showViewings() {
  const [data, badge] = await Promise.all([api('/v1/intl/viewings'), refreshBadge()]);
  const rows = data.viewings || [];
  if (data.broker_tz) state.brokerTz = data.broker_tz;
  if (!state.dayKey) state.dayKey = todayKey();
  const shown = rows.filter((row) => zoned(row.start_utc, row.tz).key === state.dayKey);
  const groups = new Map();
  for (const row of shown) {
    const zone = zoned(row.start_utc, row.tz);
    if (!groups.has(zone.key)) groups.set(zone.key, { zone, list: [] });
    groups.get(zone.key).list.push(row);
  }
  const cards = [...groups.values()].map(({ zone, list }) => `<div class="sh"><span>${esc(dayHeading(zone))}</span></div>${list.map((row) => {
    const time = zoned(row.start_utc, row.tz);
    const ok = row.status === 'confirmed';
    const actions = [];
    if (row.status !== 'confirmed' && row.status !== 'cancelled') {
      actions.push(`<button class="btn sm" type="button" data-view="${esc(row.id)}" data-act="confirm">${esc(t('confirmView'))}</button>`);
    }
    if (row.status === 'confirmed') {
      actions.push(`<button class="btn sec sm" type="button" data-remind="${esc(row.lead_id)}">${esc(t('remind'))}</button>`);
    }
    if (row.status !== 'cancelled') {
      actions.push(`<button class="btn sec sm" type="button" data-view="${esc(row.id)}" data-act="cancel">${esc(t('cancelView'))}</button>`);
    }
    return `<div class="ev"><div class="tm">${esc(`${time.hour}:${time.minute}`)}<small>${esc(t('minutes'))}</small></div><div class="card"><a href="#/lead/${esc(row.lead_id)}"><div class="kind">${esc(t('viewingWord'))}</div><h3>${esc(place(row.title || ''))}</h3><p><bdi dir="auto">${esc(row.clean_name || row.sender_name || '')}</bdi> · <span class="${ok ? 'state-ok' : ''}">${esc(viewingLabel(row.status))}</span></p>${channelChip(row.channel)}</a>${actions.length ? `<div class="btnrow">${actions.join('')}</div>` : ''}</div></div>`;
  }).join('')}`).join('');
  const dayLabel = `${dayHeading(keyZone(state.dayKey))} · ${shown.length}`;
  shell(`
    <div class="hd"><div class="hd-row"><h1>${esc(t('viewings'))}<span class="hd-count">${shown.length}</span></h1>${langSwitchHtml()}</div></div>
    <p class="hd-sub">${esc(dayLabel)}</p></div>
    ${dateStrip(rows)}
    ${shown.length ? '' : nearestHint(rows)}
    ${cards || `<p class="foot empty">${esc(t('filterEmpty'))}</p>`}
    <p class="foot" id="formError" role="alert"></p>`, badge);
  const scroller = document.getElementById('dateScroll');
  const current = scroller && scroller.querySelector('.day.on');
  if (scroller && current) scroller.scrollLeft = current.offsetLeft - (scroller.clientWidth - current.clientWidth) / 2;
  app.querySelectorAll('[data-day]').forEach((button) => {
    button.onclick = () => {
      state.dayKey = button.dataset.day;
      showViewings().catch(fail);
    };
  });
  app.querySelectorAll('[data-remind]').forEach((button) => {
    button.onclick = async () => {
      const leadId = button.dataset.remind;
      try {
        const lead = await api(`/v1/intl/leads/${encodeURIComponent(leadId)}`);
        hydrateLead(lead);
        const property = lead.property || {};
        const chosen = (lead.slots || [])[0];
        const when = chosen ? (replyLang === 'ru' ? chosen.label_ru : chosen.label_en) : '';
        const name = String(lead.clean_name || lead.sender_name || '').trim();
        const tail = replyLang === 'ru'
          ? 'Подтвердите, пожалуйста, что всё в силе.'
          : 'Please confirm it still works.';
        state.draftText = replyLang === 'ru'
          ? 'Здравствуйте, ' + name + '! Напоминаю о показе' + (when ? ' ' + when : '') + ': ' + (property.title || '') + '. ' + (property.address ? 'Адрес: ' + property.address + '. ' : '') + (property.meeting_point ? 'Встреча: ' + property.meeting_point + '. ' : '') + tail
          : 'Hello ' + name + '! A reminder about the viewing' + (when ? ' ' + when : '') + ': ' + (property.title || '') + '. ' + (property.address ? 'Address: ' + property.address + '. ' : '') + (property.meeting_point ? 'Meeting point: ' + property.meeting_point + '. ' : '') + tail;
        state.option = null;
        state.manual = true;
        await api(`/v1/intl/leads/${encodeURIComponent(leadId)}/draft`, { method: 'PUT', body: JSON.stringify(draftPayload()) });
        go(`#/lead/${encodeURIComponent(leadId)}`);
      } catch (err) { state.notice = errText(err); showViewings().catch(fail); }
    };
  });
  app.querySelectorAll('[data-view]').forEach((button) => {
    button.onclick = () => {
      const id = button.dataset.view;
      const act = button.dataset.act;
      const post = async () => {
        await api(`/v1/intl/viewings/${encodeURIComponent(id)}/${act}`, { method: 'POST', body: '{}' });
        state.notice = act === 'confirm' ? t('confirmed') : t('cancelled');
        haptic('success');
        showViewings().catch(fail);
      };
      if (act === 'cancel') {
        state.ask = { message: t('cancelHint'), yes: t('cancelView'), run: post };
        showViewings().catch(fail);
        return;
      }
      post().catch((err) => { state.notice = errText(err); haptic('error'); showViewings().catch(fail); });
    };
  });
}

function roomsOf(row) {
  if (row.bedrooms != null && row.bedrooms !== '') return row.bedrooms;
  return row.facts && row.facts.bedrooms != null ? row.facts.bedrooms : '';
}

async function showProperties() {
  const [data, badge] = await Promise.all([api(withWorkspace('/v1/intl/properties')), refreshBadge()]);
  const properties = data.properties || [];
  if (state.addProperty) {
    const key = propertyDraftKey();
    if (!state.propertyDrafts[key]) state.propertyDrafts[key] = draftFromRow(state.editProperty);
    state.photoDraft = (state.propertyDrafts[key].photos || []).map((photo) => ({ ...photo }));
  }
  const editing = state.editProperty;
  const formFor = (row) => {
    const key = row?.id || 'new';
    const fields = state.propertyDrafts[key] || draftFromRow(row);
    const thumbs = (fields.photos || []).map((photo, index) => `<figure><img src="${esc(photo.dataUrl)}" alt=""><button type="button" data-rm="${index}">${esc(t('removePhoto'))}</button></figure>`).join('');
    const preview = state.pdfFor && state.pdfFor === (row?.id || '') && state.fileUrl
      ? `<iframe class="fileview" title="${esc(t('makePdf'))}" src="${esc(state.fileUrl)}"></iframe>`
      : '';
    return `<form class="card form" id="propForm">
      <input id="ptitle" maxlength="120" placeholder="${esc(t('titlePh'))}" value="${esc(fields.title || '')}">
      <input id="paddress" maxlength="160" placeholder="${esc(t('addressPh'))}" value="${esc(fields.address || '')}">
      <input id="pdistrict" maxlength="80" placeholder="${esc(t('districtPh'))}" value="${esc(fields.district || '')}">
      <input id="pmeeting" maxlength="160" placeholder="${esc(t('meetingLabel'))}" value="${esc(fields.meetingPoint || '')}">
      <input id="paccess" maxlength="240" placeholder="${esc(t('accessLabel'))}" value="${esc(fields.accessNotes || '')}">
      <select id="pkind"><option value="rent">${esc(t('rent'))}</option><option value="sale">${esc(t('sale'))}</option></select>
      <select id="pcurrency"><option>AED</option><option>USD</option><option>EUR</option><option>GBP</option><option>TRY</option></select>
      <select id="pperiod"></select>
      <input id="pprice" inputmode="decimal" placeholder="${esc(t('pricePh'))}" value="${esc(fields.price ?? '')}">
      <input id="prooms" inputmode="numeric" placeholder="${esc(t('roomsPh'))}" value="${esc(fields.rooms ?? '')}">
      <input id="parea" inputmode="decimal" placeholder="${esc(t('areaPh'))}" value="${esc(fields.area ?? '')}">
      <select id="punit"><option value="sqft">sqft</option><option value="sqm">sqm</option></select>
      <input id="plink" maxlength="500" placeholder="${esc(t('linkPh'))}" value="${esc(fields.link || '')}">
      <button class="btn sec" id="importLink" type="button" ${state.importing ? 'disabled' : ''}>${esc(t('importListing'))}</button>
      <textarea id="pdesc" maxlength="500" placeholder="${esc(t('descriptionPh'))}">${esc(fields.description || '')}</textarea>
      ${state.importNote ? `<p class="foot" id="importNote">${esc(state.importNote)}</p>` : ''}
      ${state.importOffer ? `<div class="btnrow"><button class="btn sec sm" id="importReplace" type="button">${esc(t('importReplace'))}</button><button class="btn sec sm" id="importKeep" type="button">${esc(t('importKeep'))}</button></div>` : ''}
      <label class="btn sec filebtn" id="addPhotos">${esc(t('addPhotos'))}<input id="pphotos" type="file" accept="image/*" multiple></label>
      ${thumbs ? `<div class="thumbs">${thumbs}</div>` : ''}
      <button class="btn sec" id="makePdf" type="button">${esc(t('makePdf'))}</button>
      ${preview}
      <label class="check"><input id="pbrochure" type="checkbox" ${fields.brochure ? 'checked' : ''}> ${esc(t('makeBrochure'))}</label>
      <p id="formError" class="formerr" role="alert"></p>
      <button class="btn sec" id="backProp" type="button">${esc(t('backNav'))}</button>
    </form>`;
  };
  const newForm = state.addProperty && !editing ? formFor(null) : '';
  const saveBar = state.addProperty
    ? `<div class="actbar prop-act"><div class="btnrow"><button class="btn go" id="saveProp" type="button">${esc(t('saveProperty'))}</button></div></div>`
    : '';
  const cards = properties.map((row) => {
    const open = state.openProperty === row.id;
    const price = state.lang === 'ru' ? (row.price_ru || '') : (row.price_en || '');
    const meta = kindLabel(row.kind);
    const rooms = roomsOf(row);
    const bits = [
      row.address,
      row.district,
      rooms !== '' ? `${rooms} ${state.lang === 'ru' ? 'комн.' : 'bd'}` : '',
      row.area_value ? `${row.area_value} ${row.area_unit || ''}`.trim() : '',
      (row.photos || []).length ? fill('photoCount', row.photos.length) : '',
    ].filter(Boolean);
    const files = [
      row.brochure_url ? t('brochure') : '',
      row.listing_url ? t('linkPh') : '',
    ].filter(Boolean);
    const asked = (state.leadRows || []).filter((lead) => lead.property_id === row.id);
    const leadsHtml = state.showPropertyLeads === row.id
      ? (asked.length
        ? `<div class="card">${asked.map((lead) => `<a class="item chev" href="#/lead/${esc(lead.id)}"><span class="dot ${esc(mark(lead))}"></span><div class="main"><div class="t"><bdi dir="auto">${esc(lead.clean_name || lead.sender_name || lead.id)}</bdi></div><div class="s">${esc(inquiryMark(lead))}</div></div></a>`).join('')}</div>`
        : `<p class="foot">${esc(t('propertyLeadsEmpty'))}</p>`)
      : '';
    const editor = open && state.addProperty && editing && editing.id === row.id ? formFor(row) : '';
    return `<article class="propcard ${open ? 'open' : ''}"><button class="prophead" type="button" data-acc="${esc(row.id)}"><span class="oi">${ICO.home}</span><span class="prophead-tx"><h3>${esc(row.title || '')}</h3><p>${esc(meta)}${price ? ` · ${esc(price)}` : ''}</p></span><span class="acc">${open ? '▾' : '›'}</span></button>${open ? `<div class="propbody">${bits.length ? `<p>${esc(bits.join(' · '))}</p>` : ''}${files.length ? `<p class="files">${esc(files.join(' · '))}</p>` : ''}<div class="btnrow"><button class="btn sec sm" type="button" data-prop="${esc(row.id)}">${esc(t('openLeads'))}</button><button class="btn sec sm" type="button" data-edit="${esc(row.id)}">${esc(t('editProperty'))}</button></div>${leadsHtml}${editor}</div>` : ''}</article>`;
  }).join('');
  shell(`
    <div class="hd"><div class="hd-row"><h1>${esc(t('properties'))}</h1>${langSwitchHtml()}</div></div>
    ${newForm || `<button class="btn sec queuebtn" id="addProp" type="button">${esc(t('addProperty'))}</button>`}
    <div class="proplist">${cards}</div>${saveBar}`, badge);
  const fields = state.addProperty ? (state.propertyDrafts[propertyDraftKey()] || draftFromRow(editing)) : null;
  const closePropertyPanels = () => {
    state.showPropertyLeads = '';
    state.addProperty = false;
    state.editProperty = null;
    state.pdfFor = '';
    state.importOffer = null;
    state.importNote = '';
  };
  const showPropFail = (message) => {
    const text = String(message || t('invalidProperty'));
    const errEl = document.getElementById('formError');
    if (errEl) {
      errEl.textContent = text;
      try { errEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* ignore */ }
    }
    state.notice = text;
    const toast = document.querySelector('.toast');
    if (!toast) {
      const node = document.createElement('p');
      node.className = 'toast';
      node.setAttribute('role', 'status');
      node.textContent = text;
      app.appendChild(node);
      setTimeout(() => node.remove(), 3200);
    }
    haptic('error');
  };
  const savePropertyNow = async () => {
    const saveBtn = document.getElementById('saveProp');
    if (saveBtn && saveBtn.dataset.busy === '1') return;
    if (saveBtn) {
      saveBtn.dataset.busy = '1';
      saveBtn.disabled = true;
      saveBtn.textContent = state.lang === 'ru' ? 'Сохранение…' : 'Saving…';
    }
    const errEl = document.getElementById('formError');
    if (errEl) errEl.textContent = '';
    try {
      if (!document.getElementById('propForm')) throw Object.assign(new Error('invalid_property'), { body: { error_code: 'invalid_property' } });
      rememberPropertyDraft();
      const kindEl = document.getElementById('pkind');
      const periodEl = document.getElementById('pperiod');
      const kind = (kindEl && kindEl.value) || 'rent';
      let period = periodEl && periodEl.value;
      if (!period) period = kind === 'sale' ? 'total' : 'year';
      if (periodEl && !periodEl.value) periodEl.value = period;
      const roomsRaw = (document.getElementById('prooms') || {}).value || '';
      const areaRaw = (document.getElementById('parea') || {}).value || '';
      const rooms = String(roomsRaw).trim();
      const area = String(areaRaw).trim();
      const key = propertyDraftKey();
      const title = String((document.getElementById('ptitle') || {}).value || '').trim();
      const price = parsePriceInput((document.getElementById('pprice') || {}).value || '');
      const listingUrl = normalizeListingUrl((document.getElementById('plink') || {}).value || '');
      if (!title) {
        showPropFail(t('propertyNeedTitle'));
        return;
      }
      if (!Number.isFinite(price) || price <= 0) {
        showPropFail(t('propertyNeedPrice'));
        return;
      }
      if (listingUrl && !/^https?:\/\//i.test(listingUrl) && !listingUrl.startsWith('/')) {
        showPropFail(t('propertyBadLink'));
        return;
      }
      const photos = (state.photoDraft || [])
        .map((photo) => (photo.id ? `file:${photo.id}` : photo.dataUrl))
        .filter((item) => typeof item === 'string' && item);
      const currency = (document.getElementById('pcurrency') || {}).value || 'AED';
      const result = await api(withWorkspace('/v1/intl/properties'), {
        method: 'POST',
        body: JSON.stringify({
          id: editing?.id,
          title,
          address: String((document.getElementById('paddress') || {}).value || '').trim(),
          district: String((document.getElementById('pdistrict') || {}).value || '').trim(),
          meeting_point: String((document.getElementById('pmeeting') || {}).value || '').trim(),
          access_notes: String((document.getElementById('paccess') || {}).value || '').trim(),
          kind,
          price,
          currency,
          price_period: period,
          bedrooms: rooms === '' ? null : Number(rooms),
          area_value: area === '' ? null : Number(area),
          area_unit: area === '' ? '' : ((document.getElementById('punit') || {}).value || 'sqft'),
          listing_url: listingUrl,
          facts: { description: String((document.getElementById('pdesc') || {}).value || '').trim() },
          plan_url: editing?.plan_url || '',
          photos,
          make_brochure: Boolean(document.getElementById('pbrochure') && document.getElementById('pbrochure').checked),
          tz: editing?.tz || state.brokerTz || 'Asia/Dubai',
          tz_label_en: editing?.tz_label_en || 'Dubai time',
          tz_label_ru: editing?.tz_label_ru || 'время Дубая',
        }),
      });
      if (!result || result.ok === false) {
        throw Object.assign(new Error(result?.error_code || 'invalid_property'), { body: result || { error_code: 'invalid_property' } });
      }
      delete state.propertyDrafts[key];
      state.photoDraft = [];
      state.addProperty = false;
      state.editProperty = null;
      state.pdfFor = '';
      state.importOffer = null;
      state.importNote = '';
      state.openProperty = result.id || editing?.id || '';
      state.notice = t('propertySaved');
      haptic('success');
      await showProperties();
    } catch (err) {
      showPropFail(errText(err));
    } finally {
      const btn = document.getElementById('saveProp');
      if (btn) {
        btn.dataset.busy = '0';
        btn.disabled = false;
        btn.textContent = t('saveProperty');
      }
    }
  };
  app.querySelectorAll('[data-acc]').forEach((button) => {
    button.onclick = () => {
      rememberPropertyDraft();
      const id = button.dataset.acc;
      const next = state.openProperty === id ? '' : id;
      closePropertyPanels();
      state.openProperty = next;
      showProperties().catch(fail);
    };
  });
  app.querySelectorAll('[data-prop]').forEach((button) => {
    button.onclick = () => {
      rememberPropertyDraft();
      const id = button.dataset.prop;
      const same = state.showPropertyLeads === id && !state.addProperty;
      closePropertyPanels();
      state.openProperty = id;
      state.showPropertyLeads = same ? '' : id;
      showProperties().catch(fail);
    };
  });
  app.querySelectorAll('[data-edit]').forEach((button) => {
    button.onclick = () => {
      rememberPropertyDraft();
      const row = properties.find((item) => item.id === button.dataset.edit) || null;
      const same = state.addProperty && editing && editing.id === button.dataset.edit;
      closePropertyPanels();
      if (!same && row) {
        state.editProperty = row;
        state.addProperty = true;
        state.openProperty = row.id;
        if (!state.propertyDrafts[row.id]) state.propertyDrafts[row.id] = draftFromRow(row);
      }
      showProperties().catch(fail);
    };
  });
  const add = document.getElementById('addProp');
  if (add) add.onclick = () => {
    rememberPropertyDraft();
    closePropertyPanels();
    state.editProperty = null;
    state.addProperty = true;
    state.openProperty = '';
    if (!state.propertyDrafts.new) state.propertyDrafts.new = blankDraft();
    showProperties().catch(fail);
  };
  const back = document.getElementById('backProp');
  if (back) back.onclick = () => {
    rememberPropertyDraft();
    const key = propertyDraftKey();
    const dirty = draftIsDirty(key, state.editProperty);
    state.addProperty = false;
    if (dirty) state.notice = t('draftKept');
    showProperties().catch(fail);
  };
  const saveBtn = document.getElementById('saveProp');
  if (saveBtn) {
    saveBtn.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      savePropertyNow().catch((err) => showPropFail(errText(err)));
    };
  }
  const formEl = document.getElementById('propForm');
  if (formEl) {
    formEl.onsubmit = (event) => {
      event.preventDefault();
      savePropertyNow().catch((err) => showPropFail(errText(err)));
    };
  }
  if (formEl && fields) {
    const fillPeriods = () => {
      const kind = document.getElementById('pkind').value;
      const options = kind === 'sale' ? [['total', t('perTotal')]] : [['year', t('perYear')], ['month', t('perMonth')]];
      const current = document.getElementById('pperiod').value || fields.period;
      document.getElementById('pperiod').innerHTML = options.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('');
      const allowed = options.some(([value]) => value === current);
      document.getElementById('pperiod').value = allowed ? current : options[0][0];
    };
    try {
      document.getElementById('pkind').value = fields.kind || 'rent';
      fillPeriods();
      document.getElementById('pcurrency').value = fields.currency || 'AED';
      if (fields.unit) document.getElementById('punit').value = fields.unit;
      document.getElementById('pkind').onchange = fillPeriods;
    } catch (err) {
      showPropFail(errText(err));
    }
    const importLink = document.getElementById('importLink');
    if (importLink) importLink.onclick = () => {
      importLink.disabled = true;
      importPropertyLink().catch((err) => {
        state.importNote = importErrorText(err);
        state.importing = false;
        showProperties().catch(fail);
      });
    };
    const importReplace = document.getElementById('importReplace');
    if (importReplace) importReplace.onclick = () => {
      applyImportOffer(true);
      showProperties().catch(fail);
    };
    const importKeep = document.getElementById('importKeep');
    if (importKeep) importKeep.onclick = () => {
      state.importOffer = null;
      showProperties().catch(fail);
    };
    const photos = document.getElementById('pphotos');
    if (photos) photos.onchange = async () => {
      const files = [...(photos.files || [])];
      rememberPropertyDraft();
      try {
        const added = [];
        for (const file of files) added.push({ dataUrl: await readPhoto(file) });
        const key = propertyDraftKey();
        const next = [...(state.propertyDrafts[key].photos || []), ...added];
        if (next.length > 12) {
          state.notice = t('photoLimit');
          showProperties().catch(fail);
          return;
        }
        state.propertyDrafts[key].photos = next;
        state.photoDraft = next;
        showProperties().catch(fail);
      } catch (err) {
        report(err);
      }
    };
    app.querySelectorAll('[data-rm]').forEach((button) => {
      button.onclick = () => {
        rememberPropertyDraft();
        const key = propertyDraftKey();
        state.propertyDrafts[key].photos = (state.propertyDrafts[key].photos || []).filter((_, index) => String(index) !== button.dataset.rm);
        state.photoDraft = state.propertyDrafts[key].photos;
        showProperties().catch(fail);
      };
    });
    const makePdf = document.getElementById('makePdf');
    if (makePdf) makePdf.onclick = () => {
      rememberPropertyDraft();
      const row = state.editProperty;
      if (!row || !row.id || draftIsDirty(row.id, row)) {
        state.notice = t('pdfNeedsSave');
        showProperties().catch(fail);
        return;
      }
      openPropertyPdf(row.id).catch((err) => { state.notice = errText(err); showProperties().catch(fail); });
    };
  }
}

function importErrorText(err) {
  const code = err && err.body && err.body.error_code;
  if (code === 'import_blocked') return t('importBlocked');
  if (code === 'import_empty') return t('importEmpty');
  if (code === 'import_bad_url') return t('importBadUrl');
  return t('importBlocked');
}

function importFieldLabel(key) {
  const labels = {
    title: 'titlePh', address: 'addressPh', district: 'districtPh', price: 'pricePh',
    rooms: 'roomsPh', area: 'areaPh', description: 'descriptionPh', photos: 'addPhotos',
  };
  return t(labels[key] || key);
}

function mergeImport(found, draft) {
  const defaults = blankDraft();
  const next = { ...draft, photos: (draft.photos || []).map((photo) => ({ ...photo })) };
  const filled = [];
  const conflicts = [];
  for (const key of ['title', 'address', 'district', 'price', 'currency', 'rooms', 'area', 'unit', 'description', 'kind', 'period']) {
    const value = found[key];
    if (value == null || value === '') continue;
    const current = String(draft[key] ?? '').trim();
    const incoming = String(value);
    if (current === incoming) continue;
    const untouched = ['currency', 'kind', 'period', 'unit'].includes(key) && current === String(defaults[key] ?? '');
    if (!current || untouched) {
      next[key] = incoming;
      filled.push(key);
    } else conflicts.push(key);
  }
  const photos = (found.photos || []).map((photo) => ({ dataUrl: photo.dataUrl }));
  if (photos.length && !(draft.photos || []).length) {
    next.photos = photos;
    filled.push('photos');
  } else if (photos.length) conflicts.push('photos');
  return { next, filled, conflicts, incoming: found };
}

async function importPropertyLink() {
  if (state.importing) return;
  state.importing = true;
  const button = document.getElementById('importLink');
  if (button) button.disabled = true;
  try {
    rememberPropertyDraft();
    const key = propertyDraftKey();
    const draft = state.propertyDrafts[key] || blankDraft();
    const url = String(draft.link || '').trim();
    const result = await api(withWorkspace('/v1/intl/properties/import'), { method: 'POST', body: JSON.stringify({ url }) });
    const merged = mergeImport(result.fields || {}, draft);
    state.propertyDrafts[key] = merged.next;
    state.photoDraft = merged.next.photos || [];
    state.importOffer = merged.conflicts.length ? { conflicts: merged.conflicts, incoming: result.fields } : null;
    const names = merged.filled.map(importFieldLabel).join(', ');
    state.importNote = names ? fill('importFilled', { fields: names }) : t('importEmpty');
    if (!draft.link) state.propertyDrafts[key].link = url;
  } finally {
    state.importing = false;
  }
  await showProperties();
}

function applyImportOffer(replace) {
  const offer = state.importOffer;
  const key = propertyDraftKey();
  const draft = state.propertyDrafts[key] || blankDraft();
  if (replace && offer) {
    for (const field of offer.conflicts) {
      if (field === 'photos') draft.photos = (offer.incoming.photos || []).map((photo) => ({ dataUrl: photo.dataUrl }));
      else if (offer.incoming[field] != null) draft[field] = String(offer.incoming[field]);
    }
    state.propertyDrafts[key] = draft;
    state.photoDraft = draft.photos || [];
    state.importNote = fill('importFilled', { fields: offer.conflicts.map(importFieldLabel).join(', ') });
  }
  state.importOffer = null;
}

function blankDraft() {
  return {
    title: '', address: '', district: '', meetingPoint: '', accessNotes: '', kind: 'rent', currency: 'AED', period: 'year',
    price: '', rooms: '', area: '', unit: 'sqft', link: '', description: '', brochure: false, photos: [],
  };
}

function draftFromRow(row) {
  if (!row) return blankDraft();
  const rooms = roomsOf(row);
  return {
    title: row.title || '',
    address: row.address || '',
    district: row.district || '',
    meetingPoint: row.meeting_point || '',
    accessNotes: row.access_notes || '',
    kind: row.kind || 'rent',
    currency: row.currency || 'AED',
    period: row.price_period || (row.kind === 'sale' ? 'total' : 'year'),
    price: row.price != null ? String(row.price) : '',
    rooms: rooms === '' || rooms == null ? '' : String(rooms),
    area: row.area_value != null && row.area_value !== '' ? String(row.area_value) : '',
    unit: row.area_unit || 'sqft',
    link: row.listing_url || '',
    description: (row.facts && row.facts.description) || '',
    brochure: Boolean(row.brochure_url),
    photos: (row.photos || []).map((photo) => ({ id: photo.id, dataUrl: photo.data_url })),
  };
}

function propertyDraftKey() {
  return state.editProperty && state.editProperty.id ? state.editProperty.id : 'new';
}

function normalizeDraft(draft) {
  return {
    title: draft.title || '',
    address: draft.address || '',
    district: draft.district || '',
    kind: draft.kind || 'rent',
    currency: draft.currency || 'USD',
    period: draft.period || 'year',
    price: String(draft.price ?? ''),
    rooms: String(draft.rooms ?? ''),
    area: String(draft.area ?? ''),
    unit: draft.unit || 'sqft',
    link: draft.link || '',
    description: draft.description || '',
    brochure: Boolean(draft.brochure),
    photos: (draft.photos || []).map((photo) => photo.id || photo.dataUrl || ''),
  };
}

function draftIsDirty(key, row) {
  const draft = state.propertyDrafts[key];
  if (!draft) return false;
  return JSON.stringify(normalizeDraft(draft)) !== JSON.stringify(normalizeDraft(draftFromRow(row)));
}

function rememberPropertyDraft() {
  const form = document.getElementById('propForm');
  if (!form) return;
  const key = propertyDraftKey();
  const meeting = document.getElementById('pmeeting');
  const access = document.getElementById('paccess');
  state.propertyDrafts[key] = {
    title: document.getElementById('ptitle').value,
    address: document.getElementById('paddress').value,
    district: document.getElementById('pdistrict').value,
    meetingPoint: meeting ? meeting.value : '',
    accessNotes: access ? access.value : '',
    kind: document.getElementById('pkind').value,
    currency: document.getElementById('pcurrency').value,
    period: document.getElementById('pperiod').value,
    price: document.getElementById('pprice').value,
    rooms: document.getElementById('prooms').value,
    area: document.getElementById('parea').value,
    unit: document.getElementById('punit').value,
    link: document.getElementById('plink').value,
    description: document.getElementById('pdesc') ? document.getElementById('pdesc').value : '',
    brochure: Boolean(document.getElementById('pbrochure').checked),
    photos: (state.photoDraft || []).map((photo) => ({ id: photo.id, dataUrl: photo.dataUrl })),
  };
}

function readPhoto(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    const failPhoto = () => {
      URL.revokeObjectURL(url);
      reject(Object.assign(new Error('invalid_property'), { body: { error_code: 'invalid_property' } }));
    };
    img.onload = () => {
      const scale = Math.min(1, 1280 / Math.max(img.width || 1, img.height || 1));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round((img.width || 1) * scale));
      canvas.height = Math.max(1, Math.round((img.height || 1) * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      let quality = 0.72;
      let data = canvas.toDataURL('image/jpeg', quality);
      while (data.length > 48000 && quality > 0.42) {
        quality -= 0.08;
        data = canvas.toDataURL('image/jpeg', quality);
      }
      URL.revokeObjectURL(url);
      if (!data.startsWith('data:image/jpeg') || data.length > 120000) {
        reject(Object.assign(new Error('invalid_property'), { body: { error_code: 'invalid_property' } }));
        return;
      }
      resolve(data);
    };
    img.onerror = failPhoto;
    img.src = url;
  });
}

async function openPropertyPdf(id) {
  const res = await fetch(`/v1/intl/properties/${encodeURIComponent(id)}/brochure.pdf`, {
    headers: { Authorization: state.tma ? `tma ${state.tma}` : '' },
  });
  if (!res.ok) throw Object.assign(new Error('not_found'), { body: { error_code: 'not_found' } });
  const buf = await res.arrayBuffer();
  if (state.fileUrl) URL.revokeObjectURL(state.fileUrl);
  state.fileUrl = URL.createObjectURL(new Blob([buf], { type: 'application/pdf' }));
  state.pdfFor = id;
  state.notice = t('pdfReady');
  showProperties().catch(fail);
}

async function pokeSetting(body, lockedText) {
  try {
    await api('/v1/intl/settings', { method: 'POST', body: JSON.stringify(body) });
    state.notice = t('saved');
  } catch (err) {
    state.notice = err.body?.error_code === 'locked' ? lockedText : errText(err);
  }
  showSetup().catch(fail);
}

async function showSetup() {
  const [badge, connect, metrics, waStatus] = await Promise.all([
    refreshBadge(),
    api('/v1/intl/connect').catch(() => ({})),
    api('/v1/intl/metrics').catch(() => ({})),
    api('/v1/intl/whatsapp/status').catch(() => ({ configured: false, gateway: '' })),
  ]);
  try { state.serverSettings = await api('/v1/intl/settings'); } catch { /* keep the last settings */ }
  const response = state.serverSettings || {};
  const saved = response.settings || response;
  const autoOn = response.auto_send_hot === true || saved.auto_send_hot === '1' || saved.auto_send_hot === true;
  const aiNote = saved.note_ai !== '0';
  const stopNote = saved.note_stop !== '0';
  const digestOn = saved.digest_enabled !== '0';
  const digestTime = saved.digest_time || '09:00';
  const replyStyle = saved.reply_style || 'business';
  const live = state.channelMode === 'live';
  const online = live ? t('online') : t('demoModeLabel');
  const telegramConnected = Number(connect.ready_connections || 0) > 0;
  const wa = waStatus || {};
  const waConfigured = wa.configured === true || (connect.whatsapp && connect.whatsapp.configured === true);
  const waProvider = wa.gateway || (connect.whatsapp && connect.whatsapp.provider) || '';
  const waName = waProvider === 'cloud' ? 'Meta Cloud API' : waProvider === 'green' ? 'Green API' : '';
  const waiting = metrics.waiting == null ? '—' : String(metrics.waiting);
  const replyRate = metrics.reply_rate == null ? '—' : `${metrics.reply_rate}%`;
  const planned = metrics.viewings_planned == null ? '—' : String(metrics.viewings_planned);
  const styleOptions = [['business', t('styleBusiness')], ['short', t('styleShort')], ['warm', t('styleWarm')]]
    .map(([value, label]) => `<option value="${value}" ${replyStyle === value ? 'selected' : ''}>${esc(label)}</option>`).join('');
  shell(`
    <div class="topbar"><div class="brand"><i></i>Erstantwort <span class="brand-chip">${esc(t('setupTitle'))}</span></div><div class="topbar-tools"><span class="online-pill ${live ? 'on' : ''}"><i></i>${esc(online)}</span>${langSwitchHtml()}</div></div>
    <a class="analytics" id="openSummary" href="#/digest">
      <div class="an-head"><span>${esc(t('anTitle'))}</span><span class="an-open">${esc(t('anOpen'))} →</span></div>
      <div class="an-stats">
        <div><b>${esc(waiting)}</b><small>${esc(t('anLeads'))}</small></div>
        <div><b>${esc(replyRate)}</b><small>${esc(t('anReply'))}</small></div>
        <div><b>${esc(planned)}</b><small>${esc(t('anViewings'))}</small></div>
      </div>
    </a>
    <div class="section-label">${esc(t('channelsTitle'))}</div>
    <div class="card channel-list">
      <button class="channel-row" id="step-connect" type="button">
        <span class="ch-ico tg">${ICO.tg}</span>
        <span class="ch-tx"><b>Telegram Business API</b><small class="${telegramConnected ? 'ok' : 'warn'}">${esc(telegramConnected ? t('connected') : t('notConnected'))}</small></span>
        <span class="ch-arrow">›</span>
      </button>
      <a class="channel-row ${waConfigured ? '' : 'needs'}" id="whatsappRow" href="#/whatsapp">
        <span class="ch-ico wa">${ICO.wa}</span>
        <span class="ch-tx"><b>WhatsApp API</b><small class="${waConfigured ? 'ok' : 'warn'}">${esc(waConfigured ? `${t('connected')}${waName ? ` · ${waName}` : ''}` : t('waNeedsSetup'))}</small></span>
        <span class="ch-act">${esc(waConfigured ? '' : `${t('waConfigure')} ›`)}</span>
      </a>
    </div>
    <div class="section-label">${esc(t('processingTitle'))}</div>
    <div class="card setting-list">
      <button class="setting-row" id="toggle-manual" type="button" aria-pressed="true">
        <span class="set-tx"><b><span class="num">1</span>${esc(t('manualTitle'))}</b><small>${esc(t('manualSub'))}</small></span>
        <span class="sw on"></span>
      </button>
      <button class="setting-row" id="toggle-auto" type="button" aria-pressed="${autoOn ? 'true' : 'false'}">
        <span class="set-tx"><b><span class="num">2</span>🔥 ${esc(t('autoTitle'))}</b><small>${esc(live ? t('autoSub') : t('autoLiveOnly'))}</small></span>
        <span class="sw ${autoOn && live ? 'on' : ''}"></span>
      </button>
      <div class="setting-row col">
        <span class="set-tx"><b><span class="num">3</span>${esc(t('styleTitle'))}</b><small>${esc(t('styleSub'))}</small></span>
        <select id="replyStyle" class="set-select">${styleOptions}</select>
      </div>
      <div class="setting-row">
        <span class="set-tx"><b><span class="num">4</span>${esc(t('digestTitle2'))}</b><small>${esc(t('digestSub'))}</small></span>
        <span class="set-tail"><input id="digestTime" type="time" class="set-time" value="${esc(digestTime)}" aria-label="${esc(t('digestTitle2'))}"><button class="sw-btn" id="toggle-digest" type="button" aria-pressed="${digestOn ? 'true' : 'false'}"><span class="sw ${digestOn ? 'on' : ''}"></span></button></span>
      </div>
      <button class="setting-row" id="toggle-ai" type="button" aria-pressed="${aiNote ? 'true' : 'false'}">
        <span class="set-tx"><b><span class="num">5</span>${esc(t('noteAi'))}</b><small>${esc(t('noteAiSub'))}</small></span>
        <span class="sw ${aiNote ? 'on' : ''}"></span>
      </button>
      <button class="setting-row" id="toggle-stop" type="button" aria-pressed="${stopNote ? 'true' : 'false'}">
        <span class="set-tx"><b><span class="num">6</span>${esc(t('noteStop'))}</b><small>${esc(t('noteStopSub'))}</small></span>
        <span class="sw ${stopNote ? 'on' : ''}"></span>
      </button>
    </div>
    <div class="section-label">${esc(t('teamTitle'))}</div>
    <div class="card pad team-card">
      <p class="foot">${esc(t('teamInviteSub'))}${response.telegram_user_id ? ` · ID: ${esc(String(response.telegram_user_id))}` : ''}</p>
      <label class="set-tx"><b>${esc(t('teamColleagueId'))}</b></label>
      <input id="teamMemberId" class="set-input" inputmode="numeric" autocomplete="off" placeholder="123456789" />
      <label class="set-tx"><b>${esc(t('teamRole'))}</b></label>
      <select id="teamRole" class="set-select">
        <option value="viewer">${esc(t('teamRoleViewer'))}</option>
        <option value="editor">${esc(t('teamRoleEditor'))}</option>
      </select>
      <button class="btn" id="teamInvite" type="button">${esc(t('teamCreate'))}</button>
      ${state.inviteTokenShown ? `<p class="foot" id="teamTokenBox"><b>${esc(t('teamTokenOnce'))}</b><br><code>${esc(state.inviteTokenShown)}</code><br><button class="btn sec sm" id="teamCopyToken" type="button">${esc(t('teamCopy'))}</button></p>` : ''}
      <div class="team-list">${((response.team && response.team.members) || []).map((row) => `
        <div class="setting-row"><span class="set-tx"><b>${esc(row.member_telegram_id)}</b><small>${esc(row.role)} · ${esc(row.status)}</small></span>
        <button class="btn sec sm" type="button" data-revoke="${esc(row.member_telegram_id)}">${esc(t('teamRevoke'))}</button></div>`).join('') || `<p class="foot">${esc(t('teamEmpty'))}</p>`}</div>
      <hr class="soft" />
      <p class="foot">${esc(t('teamAcceptSub'))}</p>
      <label class="set-tx"><b>${esc(t('teamOwnerId'))}</b></label>
      <input id="teamOwnerId" class="set-input" inputmode="numeric" autocomplete="off" placeholder="123456789" />
      <label class="set-tx"><b>${esc(t('teamToken'))}</b></label>
      <input id="teamToken" class="set-input" autocomplete="off" />
      <button class="btn sec" id="teamAccept" type="button">${esc(t('teamAccept'))}</button>
    </div>

  `, badge);
  document.getElementById('toggle-manual').onclick = () => { state.notice = t('manualLocked'); showSetup().catch(fail); };
  document.getElementById('toggle-auto').onclick = () => {
    if (!live) { state.notice = t('autoLiveOnly'); showSetup().catch(fail); return; }
    pokeSetting({ auto_send_hot: !autoOn }, t('autoLiveOnly'));
  };
  document.getElementById('toggle-ai').onclick = () => pokeSetting({ note_ai: !aiNote }, t('noteAiSub'));
  document.getElementById('toggle-stop').onclick = () => pokeSetting({ note_stop: !stopNote }, t('noteStopSub'));
  document.getElementById('toggle-digest').onclick = () => pokeSetting({ digest_enabled: !digestOn }, t('digestSub'));
  const styleSelect = document.getElementById('replyStyle');
  if (styleSelect) styleSelect.onchange = () => pokeSetting({ reply_style: styleSelect.value }, t('styleSaved'));
  const timeInput = document.getElementById('digestTime');
  if (timeInput) timeInput.onchange = () => pokeSetting({ digest_time: timeInput.value }, t('digestSub'));
  document.getElementById('step-connect').onclick = () => { state.notice = telegramConnected ? t('connectTelegramOk') : t('connectHint'); showSetup().catch(fail); };
  const inviteBtn = document.getElementById('teamInvite');
  if (inviteBtn) inviteBtn.onclick = async () => {
    try {
      const result = await api('/v1/intl/team/invite', {
        method: 'POST',
        body: JSON.stringify({
          telegram_id: document.getElementById('teamMemberId').value,
          role: document.getElementById('teamRole').value,
        }),
      });
      state.inviteTokenShown = result.invite_token || '';
      state.notice = t('teamInviteCreated');
      showSetup().catch(fail);
    } catch (err) {
      state.notice = errText(err);
      showSetup().catch(fail);
    }
  };
  const copyBtn = document.getElementById('teamCopyToken');
  if (copyBtn) copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(state.inviteTokenShown);
      state.notice = t('teamCopied');
    } catch {
      state.notice = state.inviteTokenShown;
    }
    showSetup().catch(fail);
  };
  app.querySelectorAll('[data-revoke]').forEach((button) => {
    button.onclick = async () => {
      try {
        await api('/v1/intl/team/revoke', { method: 'POST', body: JSON.stringify({ telegram_id: button.dataset.revoke }) });
        state.notice = t('teamRevoked');
        state.inviteTokenShown = '';
        showSetup().catch(fail);
      } catch (err) {
        state.notice = errText(err);
        showSetup().catch(fail);
      }
    };
  });
  const acceptBtn = document.getElementById('teamAccept');
  if (acceptBtn) acceptBtn.onclick = async () => {
    try {
      const result = await api('/v1/intl/team/accept', {
        method: 'POST',
        body: JSON.stringify({
          owner_id: document.getElementById('teamOwnerId').value,
          token: document.getElementById('teamToken').value,
        }),
      });
      state.notice = t('teamAccepted');
      state.inviteTokenShown = '';
      if (result.membership && result.membership.owner_broker_id) {
        state.workspaceId = result.membership.owner_broker_id;
        localStorage.setItem('intl-workspace', state.workspaceId);
        state.canWrite = result.membership.role === 'editor';
      }
      try { state.team = await api('/v1/intl/team'); } catch { /* keep */ }
      showSetup().catch(fail);
    } catch (err) {
      state.notice = errText(err);
      showSetup().catch(fail);
    }
  };
}

async function showWhatsApp() {
  const [badge, status] = await Promise.all([
    refreshBadge(),
    api('/v1/intl/whatsapp/status').catch(() => ({ configured: false, gateway: '' })),
  ]);
  const selected = state.waGateway || (status.gateway === 'cloud' ? 'cloud' : 'green');
  const configured = status.configured === true;
  const providerName = status.gateway === 'cloud' ? 'Meta Cloud API' : status.gateway === 'green' ? 'Green API' : '';
  shell(`
    <div class="backrow"><a class="back" href="#/setup">‹ ${esc(t('setupTitle'))}</a></div>
    <div class="hd"><h1>${esc(t('waTitle'))}</h1><p class="hd-sub">${esc(t('waSubtitle'))}</p></div>
    ${configured
      ? `<div class="statusbox ok"><b>${esc(t('waConnectedTitle'))}</b><span>${esc(providerName)}</span></div>`
      : `<div class="statusbox warn"><b>${esc(t('waNotConnectedTitle'))}</b><span>${esc(t('waNotConnectedSub'))}</span></div>`}
    <div class="gw-list">
      <button class="gw-card ${selected === 'green' ? 'on' : ''}" id="gwGreen" type="button">
        <span class="gw-top"><span class="gw-ico qr">QR</span><span class="gw-name">Green API</span><span class="badge soft">${esc(t('waGreenBadge'))}</span><span class="radio ${selected === 'green' ? 'on' : ''}"></span></span>
        <p class="gw-desc">${esc(t('waGreenDesc'))}</p>
        <ul class="ticks ok"><li>${esc(t('waGreenB1'))}</li><li>${esc(t('waGreenB2'))}</li></ul>
      </button>
      <button class="gw-card ${selected === 'cloud' ? 'on' : ''}" id="gwCloud" type="button">
        <span class="gw-top"><span class="gw-ico meta">M</span><span class="gw-name">Meta Cloud API</span><span class="badge official">${esc(t('waMetaBadge'))}</span><span class="badge rec">${esc(t('waMetaRecommended'))}</span><span class="radio ${selected === 'cloud' ? 'on' : ''}"></span></span>
        <p class="gw-desc">${esc(t('waMetaDesc'))}</p>
        <ul class="ticks ok"><li>${esc(t('waMetaB1'))}</li><li>${esc(t('waMetaB2'))}</li></ul>
        <p class="gw-warn">${esc(t('waMetaWarn'))}</p>
      </button>
    </div>
    ${selected === 'green'
      ? `<div class="section-label">${esc(t('waGreenParams'))}</div>
        <div class="card form">
          <input id="waIdInstance" placeholder="${esc(t('waIdInstancePh'))}" autocomplete="off" inputmode="numeric">
          <input id="waApiToken" type="password" placeholder="${esc(t('waApiTokenPh'))}" autocomplete="off">
          <button class="btn" id="waConnect" type="button">${esc(t('waGreenBtn'))}</button>
        </div>
        <div class="card qrbox" id="waQrBox">
          <b>${esc(t('waQrTitle'))}</b>
          <img id="waQr" alt="${esc(t('waQrTitle'))}" src="" hidden>
          <p class="foot">${esc(t('waQrHint'))}</p>
          <button class="btn sec sm" id="waRefresh" type="button">${esc(t('waRefresh'))}</button>
        </div>`
      : `<div class="section-label">${esc(t('waMetaParams'))}</div>
        <div class="card form">
          <input id="waCloudToken" type="password" placeholder="${esc(t('waCloudTokenPh'))}" autocomplete="off">
          <input id="waCloudPhone" placeholder="${esc(t('waCloudPhonePh'))}" autocomplete="off">
          <input id="waCloudVerify" placeholder="${esc(t('waCloudVerifyPh'))}" autocomplete="off">
          <input id="waCloudSecret" type="password" placeholder="${esc(t('waCloudSecretPh'))}" autocomplete="off">
          <button class="btn" id="waConnect" type="button">${esc(t('waMetaBtn'))}</button>
        </div>
        <div class="card pad webhookbox" id="waWebhookBox">
          <b>${esc(t('waWebhookTitle'))}</b>
          <p class="mono" id="waWebhookUrl">${esc(status.webhook_url || '')}</p>
          <p class="foot">${esc(t('waWebhookHint'))}</p>
        </div>`}
    <p class="foot" id="waHint"></p>
    ${configured ? `<button class="btn sec" id="waDisconnect" type="button">${esc(t('waDisconnect'))}</button>` : ''}
  `, badge);
  document.getElementById('gwGreen').onclick = () => { state.waGateway = 'green'; showWhatsApp().catch(fail); };
  document.getElementById('gwCloud').onclick = () => { state.waGateway = 'cloud'; showWhatsApp().catch(fail); };
  const connectButton = document.getElementById('waConnect');
  connectButton.onclick = async () => {
    const value = (id) => (document.getElementById(id) || {}).value || '';
    const hint = document.getElementById('waHint');
    const invalid = whatsappFieldError(selected, value);
    if (invalid) {
      if (hint) hint.textContent = invalid;
      connectButton.disabled = false;
      haptic('error');
      return;
    }
    connectButton.disabled = true;
    try {
      const body = selected === 'green'
        ? { gateway: 'green', id_instance: value('waIdInstance'), api_token: value('waApiToken') }
        : { gateway: 'cloud', token: value('waCloudToken'), phone_number_id: value('waCloudPhone'), verify_token: value('waCloudVerify'), app_secret: value('waCloudSecret') };
      const result = await api('/v1/intl/whatsapp/connect', { method: 'POST', body: JSON.stringify(body) });
      haptic('success');
      if (result.qr && hint) {
        const img = document.getElementById('waQr');
        const box = document.getElementById('waQrBox');
        if (img) { img.src = result.qr; img.hidden = false; }
        if (box) box.hidden = false;
        hint.textContent = t('waScanQr');
        return;
      }
      if (result.gateway === 'cloud' && hint) {
        const box = document.getElementById('waWebhookBox');
        const url = document.getElementById('waWebhookUrl');
        if (box) box.hidden = false;
        if (url) url.textContent = result.webhook_url || '';
        hint.textContent = t('waCloudSaved');
        return;
      }
      state.notice = result.authorized ? t('waConnectedDone') : t('waSaved');
      showWhatsApp().catch(fail);
    } catch (err) {
      if (hint) hint.textContent = errText(err);
      haptic('error');
    } finally {
      connectButton.disabled = false;
    }
  };
  const refreshStatus = document.getElementById('waRefresh');
  if (refreshStatus) refreshStatus.onclick = () => { showWhatsApp().catch(fail); };
  const disconnect = document.getElementById('waDisconnect');
  if (disconnect) disconnect.onclick = async () => {
    try {
      await api('/v1/intl/whatsapp/disconnect', { method: 'POST', body: '{}' });
      state.notice = t('waDisconnected');
      haptic('success');
    } catch (err) { state.notice = errText(err); }
    showWhatsApp().catch(fail);
  };
}

async function showContacts() {

  const [data, badge] = await Promise.all([
    api('/v1/intl/contacts').catch(() => ({ contacts: [] })),
    refreshBadge(),
  ]);
  const contacts = data.contacts || [];
  const rows = contacts.map((row) => {
    const leadId = (row.lead_ids && row.lead_ids[0]) || '';
    const href = leadId ? `#/lead/${esc(leadId)}` : '#/contacts';
    return `<a class="item chev" href="${href}"><span class="dot ${esc(row.grade || 'COLD')}"></span>
      <div class="main"><div class="t"><bdi dir="auto">${esc(row.name || '')}</bdi> <span class="g ${esc(row.grade || 'COLD')}">${esc(row.grade || '')}</span></div>
      <div class="s">${channelChip(row.channel, true)} · ${esc(fill('leadsCnt', row.lead_count || 1))}</div></div>
      <div class="r">${esc(clock(row.last_msg_at))}</div></a>`;
  }).join('');
  shell(`<a class="back" href="#/inbox">‹ ${esc(t('inbox'))}</a>
    ${bar()}
    <div class="hd"><h1>${esc(t('contactsTitle'))}</h1><p>${esc(fill('contactsLine', contacts.length))}</p></div>
    ${contacts.length ? `<div class="card">${rows}</div>` : `<p class="foot">${esc(t('contactsEmpty'))}</p>`}`, badge);
}

async function showSimulator() {
  const [props, badge] = await Promise.all([api('/v1/intl/properties'), refreshBadge()]);
  shell(`<a class="back" href="#/setup">‹ ${esc(t('setup'))}</a>
    ${bar()}
    <div class="hd"><h1>${esc(t('simulator'))}</h1></div>
    <div class="card form">
      <select id="prop">${props.properties.map((row) => `<option value="${esc(row.id)}">${esc(row.title)}</option>`).join('')}</select>
      <input id="name" placeholder="Igor">
      <textarea id="msg"></textarea>
      <button class="btn" id="as-client" type="button">${esc(t('sendAsClient'))}</button>
      <button class="btn sec" id="seed-minus" type="button">${esc(t('seedMinus'))}</button>
      <button class="btn sec" id="seed-all" type="button">${esc(t('seedAll'))}</button>
      <p id="formError" role="alert"></p>
    </div>`, badge);
  document.getElementById('as-client').onclick = async () => {
    try {
      const result = await api('/v1/sim/wa/inbound', {
        method: 'POST',
        body: JSON.stringify({
          from_id: `sim:${Date.now()}`,
          name: document.getElementById('name').value,
          text: document.getElementById('msg').value,
          property_id: document.getElementById('prop').value,
          msg_id: String(Date.now()),
        }),
      });
      state.loadedLead = '';
      go(`#/lead/${result.lead_id}`);
    } catch (err) {
      report(err);
    }
  };
  const seed = (mode) => api('/v1/intl/seed', { method: 'POST', body: JSON.stringify({ mode }) })
    .then(() => { state.notice = t('saved'); go('#/inbox'); })
    .catch((err) => { state.notice = errText(err); showSimulator().catch(fail); });
  document.getElementById('seed-minus').onclick = () => seed('minus_t06');
  document.getElementById('seed-all').onclick = () => seed('all');
}

async function showDigest() {
  const [digest, props, badge] = await Promise.all([
    api('/v1/intl/digest'),
    api('/v1/intl/properties'),
    refreshBadge(),
  ]);
  const rows = digest.write_first || [];
  const list = rows.map((row) => `<a class="item chev" href="#/lead/${esc(row.id)}"><div class="main"><div class="t"><bdi dir="auto">${esc(row.name || row.id)}</bdi> <span class="g ${esc(row.grade)}">${esc(row.grade || '')}</span></div><div class="s">${esc(propertyTitle(props.properties || [], row.property_id))}</div></div></a>`).join('');
  const today = (digest.viewings_today || []).map((row) => `<a class="item chev" href="#/lead/${esc(row.lead_id)}"><div class="main"><div class="t">${esc(viewingLabel(row.status))}</div><div class="s">${esc(propertyTitle(props.properties || [], row.property_id))}</div></div></a>`).join('');
  const value = (digest.listed_value || []).map(moneyLine).join(' · ');
  shell(`<a class="back" href="#/inbox">‹ ${esc(t('inbox'))}</a>
    ${bar()}
    <div class="hd"><h1>${esc(t('digestTitle'))}</h1></div>
    <button class="btn queuebtn" id="digestSend" type="button">${esc(t('digestSend'))}</button>
    ${rows.length ? `<div class="sh"><span>${esc(t('writeFirst'))} · ${rows.length}</span></div><div class="card">${list}</div>` : `<p class="foot">${esc(t('digestEmpty'))}</p>`}
    ${today ? `<div class="sh"><span>${esc(t('todayWord'))}</span></div><div class="card">${today}</div>` : ''}
    <p class="foot" id="formError" role="alert"></p>`, badge);
  document.getElementById('digestSend').onclick = async () => {
    try {
      const result = await api('/v1/intl/digest/send', { method: 'POST', body: '{}' });
      state.notice = result.digest_sent_on_demand === false
        ? t('digestDenied')
        : (result.telegram_delivery === false ? t('digestSim') : t('digestLive'));
      if (result.telegram_delivery) haptic('success');
      else haptic('warning');
    } catch (err) {
      state.notice = err.body?.digest_sent_on_demand === false ? t('digestDenied') : errText(err);
      haptic('error');
    }
    showDigest().catch(fail);
  };
}

async function loadHealth() {
  try {
    const res = await fetch('/v1/health');
    const body = await res.json().catch(() => ({}));
    state.health = body;
    state.channelMode = body.channel_mode || '';
    state.demoUi = body.demo_ui === true;
  } catch {
    state.health = null;
  }
}

async function boot() {
  rememberPropertyDraft();
  initWebAppShell();
  await ensureInitData();
  state.dict = await fetch(`i18n/${state.lang}.json`).then((res) => res.json());
  await loadHealth();
  // Drop only clearly broken cached tokens; always re-read a fresh SDK payload first.
  if (state.tma && state.channelMode === 'live') {
    const freshSdk = (tg() && tg().initData) || '';
    if (freshSdk && freshSdk !== state.tma) {
      state.tma = freshSdk;
      storageSet('intl-tma', freshSdk);
    }
    const launch = inspectInitData(state.tma);
    if (!launch.ok) {
      storageRemove('intl-tma');
      state.tma = freshSdk || '';
      if (state.tma) storageSet('intl-tma', state.tma);
      else state.initError = launch.error;
    }
  }
  // ?demo=1 is the same demo sign-in as the button below, only reachable on a sim/demo surface.
  if (!state.tma && query.get('demo') === '1' && state.demoUi === true && state.channelMode !== 'live') {
    state.tma = DEMO_TMA;
    storageSet('intl-tma', DEMO_TMA);
  }
  if (!state.tma) {
    clearMainButton();
    const allowDemo = state.demoUi === true && state.channelMode !== 'live';
    if (allowDemo) {
      const demoTma = DEMO_TMA;
      shell(`${bar()}<div class="card pad"><p>${esc(t('signIn'))}</p><p><button id="demoLoginBtn" class="btn">${state.lang === 'ru' ? 'Войти как Демо-Брокер' : 'Sign in as Demo Broker'}</button></p></div>`, 0);
      const demoBtn = document.getElementById('demoLoginBtn');
      if (demoBtn) {
        demoBtn.onclick = () => {
          state.tma = demoTma;
          storageSet('intl-tma', demoTma);
          state.lang = 'ru';
          localStorage.setItem('intl-lang', 'ru');
          boot().catch(fail);
        };
      }
      return;
    }
    // Inside Telegram: never show the false "open from Telegram" wall — keep retrying initData.
    if (isTelegramClient()) {
      shell(`${bar()}<div class="card pad"><p>${esc(t('initWaiting'))}</p><p class="foot">${esc(t('initWaitingHint'))}</p><p><button id="retryInitBtn" class="btn" type="button">${esc(t('retry'))}</button></p></div>`, 0);
      const retry = document.getElementById('retryInitBtn');
      if (retry) retry.onclick = () => { state.initRetries = 0; boot().catch(fail); };
      if (state.initRetries < 8) {
        state.initRetries += 1;
        setTimeout(() => { if (!state.tma) boot().catch(fail); }, 1000);
      }
      return;
    }
    const reason = state.initError === 'expired' ? t('initExpired') : state.initError === 'malformed' ? t('initMalformed') : t('initOpenTelegram');
    shell(`${bar()}<div class="card pad"><p>${esc(t('signInLive'))}</p><p class="foot">${esc(reason)}</p></div>`, 0);
    return;
  }
  try {
    const settings = await api('/v1/intl/settings');
    state.serverSettings = settings;
    state.ephemeral = settings.ephemeral === true;
    if (settings.broker_tz) state.brokerTz = settings.broker_tz;
    if (settings.channel_mode) state.channelMode = settings.channel_mode;
    if (settings.demo_ui != null) state.demoUi = settings.demo_ui === true;
    if (settings.telegram_user_id) state.myTelegramId = String(settings.telegram_user_id);
    if (settings.team) state.team = settings.team;
    if (state.workspaceId && state.workspaceId === state.myTelegramId) {
      state.workspaceId = '';
      localStorage.setItem('intl-workspace', '');
    }
    if (state.workspaceId) {
      const shared = (state.team.workspaces || []).find((row) => row.owner_broker_id === state.workspaceId);
      if (!shared) {
        state.workspaceId = '';
        localStorage.setItem('intl-workspace', '');
        state.canWrite = true;
      } else {
        state.canWrite = shared.role === 'editor';
      }
    } else {
      state.canWrite = true;
    }
  } catch {
    state.ephemeral = false;
  }
  if (state.screen !== 'lead') clearMainButton();
  if (state.screen === 'lead' && state.leadId) return showLead();
  if (state.screen === 'viewings') return showViewings();
  if (state.screen === 'properties') return showProperties();
  if (state.screen === 'setup') return showSetup();
  if (state.screen === 'simulator') return showSimulator();
  if (state.screen === 'digest') return showDigest();
  if (state.screen === 'processed') return showFolder('processed');
  if (state.screen === 'confirmed') return showFolder('confirmed');
  if (state.screen === 'pilot') return showPilot();
  if (state.screen === 'whatsapp') return showWhatsApp();
  if (state.screen === 'archive') return showArchive();
  if (state.screen === 'contacts') return showContacts();
  return showInbox();
}

addEventListener('hashchange', () => { state.sheet = query.get('sheet') === '1'; requestRender(); });
boot().catch(fail);
