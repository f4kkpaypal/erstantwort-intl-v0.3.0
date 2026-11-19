'use strict';

const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const ipaddr = require('ipaddr.js');

const HTML_LIMIT = 1500000;
const IMAGE_LIMIT = 800000;
const MAX_PHOTOS = 4;
const TIMEOUT_MS = 8000;
const MAX_HOPS = 4;
const IMPORT_DEADLINE_MS = 15000;
const TEXT_LIMIT = 100000;
const PARSE_LIMIT = 100 * 1024;
const PHOTO_MAX = 90000;
const MAX_PIXELS = 12000000;
const MAX_JPEG_SCANS = 64;
const FIT_TIMEOUT_MS = 3000;
const CURRENCIES = new Set(['USD', 'AED', 'EUR', 'GBP', 'TRY']);

const V4_BLOCK = new net.BlockList();
for (const [addr, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) V4_BLOCK.addSubnet(addr, bits, 'ipv4');

const V6_BLOCK = new net.BlockList();
V6_BLOCK.addAddress('::', 'ipv6');
V6_BLOCK.addAddress('::1', 'ipv6');
for (const [addr, bits] of [
  ['fe80::', 10],
  ['fc00::', 7],
  ['fec0::', 10],
  ['ff00::', 8],
  ['2002::', 16],
  ['64:ff9b::', 96],
]) V6_BLOCK.addSubnet(addr, bits, 'ipv6');

function fail(error_code) {
  return { ok: false, status: 422, error_code };
}

function isPrivateAddress(ip) {
  let addr;
  try { addr = ipaddr.parse(String(ip || '')); } catch { return true; }
  if (addr.kind() === 'ipv4') return V4_BLOCK.check(addr.toString(), 'ipv4');
  const bytes = addr.toByteArray();
  if (V6_BLOCK.check(addr.toNormalizedString(), 'ipv6')) return true;
  // v4-mapped (::ffff:0:0/96) and v4-compatible (::/96) both have the first 80 bits clear.
  // The last 32 bits are the embedded IPv4, including 0.0.0.0 and 0.0.0.1.
  if (bytes.slice(0, 10).every((b) => b === 0)) {
    return V4_BLOCK.check(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`, 'ipv4');
  }
  return false;
}

function pinAgent(address, timeoutMs) {
  const { Agent } = require('undici');
  const family = net.isIP(address);
  return new Agent({
    connect: {
      timeout: timeoutMs,
      lookup(hostname, options, callback) {
        if (!family || isPrivateAddress(address)) {
          callback(Object.assign(new Error('import_blocked'), { code: 'import_blocked' }));
          return;
        }
        if (options && options.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      },
    },
  });
}

function blockedHost(host) {
  const name = String(host || '').replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!name) return true;
  if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local') || name.endsWith('.internal')) return true;
  if (name === 'metadata.google.internal' || name === 'metadata.google' || name === 'instance-data') return true;
  return false;
}

async function assertPublicUrl(raw, lookup) {
  let url;
  try { url = new URL(String(raw || '')); } catch { return { ok: false, error_code: 'import_bad_url' }; }
  if (url.username || url.password) return { ok: false, error_code: 'import_bad_url' };
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error_code: 'import_bad_url' };
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (blockedHost(host)) return { ok: false, error_code: 'import_blocked' };
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) return { ok: false, error_code: 'import_blocked' };
    return { ok: true, url, address: host };
  }
  const resolve = lookup || ((name) => dns.lookup(name, { all: true }));
  let records;
  try { records = await resolve(host); } catch { return { ok: false, error_code: 'import_blocked' }; }
  const list = Array.isArray(records) ? records : [records];
  if (!list.length) return { ok: false, error_code: 'import_blocked' };
  let chosen = '';
  for (const record of list) {
    const address = typeof record === 'string' ? record : record && record.address;
    if (!address || isPrivateAddress(address)) return { ok: false, error_code: 'import_blocked' };
    if (!chosen) chosen = address;
  }
  return { ok: true, url, address: chosen };
}

function metaMap(html) {
  if (!html || !html.includes('<meta')) return {};
  const out = {};
  const re = /<meta\b([^<>]*)>/gi;
  let match;
  while ((match = re.exec(html))) {
    const tag = match[1];
    const key = (tag.match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const content = (tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i) || [])[1];
    if (key && content != null && out[key.toLowerCase()] == null) out[key.toLowerCase()] = decode(content);
  }
  return out;
}

function decode(value) {
  if (!value || !value.includes('&')) return String(value || '');
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => codePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => codePoint(parseInt(n, 16)))
    .trim();
}

function codePoint(cp) {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10FFFF) return '';
  return String.fromCodePoint(cp);
}

function jsonLdNodes(html) {
  if (!html || !html.includes('<script')) return [];
  const nodes = [];
  const openRe = /<script\b/gi;
  const closeRe = /<\/script\s*>/gi;
  let match;
  while ((match = openRe.exec(html))) {
    const gt = html.indexOf('>', match.index);
    if (gt < 0) break;
    const open = html.slice(match.index, gt + 1);
    if (!/type\s*=\s*["']application\/ld\+json["']/i.test(open)) {
      openRe.lastIndex = gt + 1;
      continue;
    }
    closeRe.lastIndex = gt + 1;
    const end = closeRe.exec(html);
    if (!end) break;
    try {
      const parsed = JSON.parse(html.slice(gt + 1, end.index).trim());
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of list) {
        if (item && Array.isArray(item['@graph'])) nodes.push(...item['@graph']);
        else if (item) nodes.push(item);
      }
    } catch { /* a broken block is skipped; other blocks can still fill the card */ }
    openRe.lastIndex = end.index + end[0].length;
  }
  return nodes;
}

function asList(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (typeof value === 'object') return textOf(value.name || value.value || value['@value'] || '');
  return '';
}

function currencyOf(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (raw === 'TL' || raw.includes('₺') || /\bTL\b/.test(raw)) return 'TRY';
  if (raw === '$' || raw.includes('$') || /\bUSD\b/.test(raw)) return 'USD';
  if (raw === '€' || raw.includes('€') || /\bEUR\b/.test(raw)) return 'EUR';
  if (raw === '£' || raw.includes('£') || /\bGBP\b/.test(raw)) return 'GBP';
  if (raw.includes('د.إ') || /\bAED\b/.test(raw) || /\bDHS?\b/.test(raw)) return 'AED';
  return CURRENCIES.has(raw) ? raw : '';
}

function numberOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  let text = String(value || '').trim();
  if (!text) return null;
  text = text.replace(/[^\d.,]/g, '');
  if (!text) return null;
  if (/^\d{1,3}(\.\d{3})+$/.test(text)) text = text.replace(/\./g, '');
  else if (/^\d{1,3}(,\d{3})+$/.test(text)) text = text.replace(/,/g, '');
  else text = text.replace(',', '.');
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function fromJsonLd(nodes) {
  const out = {};
  const images = [];
  for (const node of nodes) {
    const type = asList(node['@type']).join(' ').toLowerCase();
    const interesting = /listing|residence|apartment|house|product|offer|singlefamily|accommodation|place/.test(type) || node.offers || node.floorSize;
    if (!interesting && !node.name) continue;
    if (!out.title && node.name) out.title = textOf(node.name).slice(0, 120);
    if (!out.description && node.description) out.description = textOf(node.description).slice(0, 500);
    const rooms = node.numberOfBedrooms || node.numberOfRooms;
    if (out.rooms == null && rooms != null) out.rooms = numberOf(rooms);
    const size = node.floorSize || node.size;
    if (!out.area && size) {
      const value = numberOf(size.value != null ? size.value : size);
      const unit = String(size.unitCode || size.unitText || '').toUpperCase();
      if (value) {
        if (unit.includes('FT') || unit === 'FTK') {
          out.area = Math.round(value / 10.764);
        } else {
          out.area = value;
        }
        out.unit = 'sqm';
      }
    }
    const address = node.address || {};
    if (!out.address && (address.streetAddress || typeof address === 'string')) out.address = textOf(address.streetAddress || address).slice(0, 160);
    if (!out.district && address.addressLocality) out.district = textOf(address.addressLocality).slice(0, 80);
    const offer = asList(node.offers)[0] || {};
    if (!out.price && (offer.price != null || node.price != null)) out.price = numberOf(offer.price != null ? offer.price : node.price);
    if (!out.currency) out.currency = currencyOf(offer.priceCurrency || node.priceCurrency);
    for (const image of asList(node.image)) {
      const src = typeof image === 'string' ? image : (image && (image.url || image.contentUrl));
      if (src) images.push(src);
    }
  }
  if (images.length) out.images = images;
  return out;
}

function fromMeta(meta) {
  const out = {};
  out.title = (meta['og:title'] || meta['twitter:title'] || '').slice(0, 120);
  out.description = (meta['og:description'] || meta.description || meta['twitter:description'] || '').slice(0, 500);
  out.price = numberOf(meta['product:price:amount'] || meta['og:price:amount']);
  out.currency = currencyOf(meta['product:price:currency'] || meta['og:price:currency']);
  const image = meta['og:image'] || meta['twitter:image'];
  if (image) out.images = [image];
  return out;
}

function cutBlock(html, openSource, closeSource) {
  const open = new RegExp(openSource, 'gi');
  const close = new RegExp(closeSource, 'gi');
  let out = '';
  let i = 0;
  while (i < html.length) {
    open.lastIndex = i;
    const start = open.exec(html);
    if (!start) return out + html.slice(i);
    out += html.slice(i, start.index);
    close.lastIndex = start.index + start[0].length;
    const end = close.exec(html);
    if (!end) return out;
    i = end.index + end[0].length;
  }
  return out;
}

function titleTag(html) {
  const open = /<title\b/gi;
  const start = open.exec(html);
  if (!start) return '';
  const gt = html.indexOf('>', start.index);
  if (gt < 0) return '';
  const close = /<\/title\s*>/gi;
  close.lastIndex = gt + 1;
  const end = close.exec(html);
  const raw = end ? html.slice(gt + 1, end.index) : html.slice(gt + 1);
  return decode(raw).replace(/\s+/g, ' ').slice(0, 120);
}

function heuristics(html) {
  const stripped = cutBlock(cutBlock(String(html || ''), '<script\\b', '<\\/script\\s*>'), '<style\\b', '<\\/style\\s*>');
  const text = decode(stripped.replace(/<[^<>]*>/g, ' ')).replace(/\s+/g, ' ').slice(0, TEXT_LIMIT);
  const out = {};
  const price = text.match(/(?:AED|USD|EUR|GBP|TRY|TL|₺|€|£|\$)\s*(\d[\d.,]{2,20})|(\d[\d.,]{2,20})\s*(?:AED|USD|EUR|GBP|TRY|TL|₺)/i);
  if (price) {
    out.price = numberOf(price[1] || price[2]);
    out.currency = currencyOf(price[0]);
  }
  const rooms = text.match(/(\d{1,3})\s*(?:\+\s*1|bed(?:room)?s?|br\b|комн)/i) || text.match(/(\d{1,3})\s*\+\s*1/);
  if (rooms) out.rooms = numberOf(rooms[1]);
  const sqm = text.match(/(\d[\d.,]{0,20})\s*(?:sqm|m²|m2|м²)/i);
  const sqft = text.match(/(\d[\d.,]{0,20})\s*(?:sq\.?\s*ft|sqft)/i);
  if (sqm) {
    out.area = numberOf(sqm[1]);
    out.unit = 'sqm';
  } else if (sqft) {
    const feet = numberOf(sqft[1]);
    if (feet) {
      out.area = Math.max(1, Math.round(feet / 10.764));
      out.unit = 'sqm';
    }
  }
  if (/for rent|kiralık|в аренду|\/year|per year|в год/i.test(text)) out.kind = 'rent';
  if (/for sale|satılık|продаж/i.test(text)) out.kind = 'sale';
  return out;
}

function mergeField(target, source, key) {
  if (target[key] == null || target[key] === '') target[key] = source[key];
}

function parseListingHtml(html, pageUrl) {
  const full = String(html || '').slice(0, HTML_LIMIT);
  const head = full.slice(0, PARSE_LIMIT);
  const ld = fromJsonLd(jsonLdNodes(full));
  const meta = fromMeta(metaMap(full));
  const guess = heuristics(head);
  const fields = {};
  for (const key of ['title', 'description', 'price', 'currency', 'rooms', 'area', 'unit', 'address', 'district', 'kind']) {
    mergeField(fields, ld, key);
    mergeField(fields, meta, key);
    mergeField(fields, guess, key);
  }
  if (!fields.title) fields.title = titleTag(head) || titleTag(full);
  if (!fields.unit && fields.area) fields.unit = 'sqm';
  if (fields.kind === 'sale') fields.period = 'total';
  else if (fields.kind === 'rent') fields.period = 'year';
  const images = [];
  for (const src of [...(ld.images || []), ...(meta.images || [])]) {
    try {
      const absolute = new URL(src, pageUrl || undefined).href;
      if (/^https?:\/\//i.test(absolute) && !images.includes(absolute)) images.push(absolute);
    } catch { /* a relative image without a page URL is skipped */ }
  }
  const filled = Object.keys(fields).filter((key) => fields[key] != null && fields[key] !== '');
  return { fields, images: images.slice(0, MAX_PHOTOS), filled };
}

async function readBody(res, limit) {
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const step = await reader.read();
      if (step.done) break;
      size += step.value.length;
      if (size > limit) {
        try { await reader.cancel(); } catch { /* already closed */ }
        return null;
      }
      chunks.push(Buffer.from(step.value));
    }
    return Buffer.concat(chunks);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > limit) return null;
  return buf;
}

function imageKind(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png';
  return '';
}

function pngTooBig(buf) {
  if (buf.length < 24) return true;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!width || !height) return true;
  return width * height > MAX_PIXELS;
}

function jpegInfo(buf) {
  let scans = 0;
  let width = 0;
  let height = 0;
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return { scans: MAX_JPEG_SCANS + 1, width: 0, height: 0 };
  let i = 2;
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    while (i < buf.length && buf[i] === 0xff) i += 1;
    if (i >= buf.length) break;
    const marker = buf[i];
    i += 1;
    if (marker === 0xd9) break;
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (i + 1 >= buf.length) break;
    const len = buf.readUInt16BE(i);
    if (len < 2 || i + len > buf.length) break;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      height = buf.readUInt16BE(i + 3);
      width = buf.readUInt16BE(i + 5);
    }
    if (marker === 0xda) {
      scans += 1;
      i += len;
      while (i + 1 < buf.length) {
        if (buf[i] !== 0xff) {
          i += 1;
          continue;
        }
        if (buf[i + 1] === 0x00) {
          i += 2;
          continue;
        }
        break;
      }
      continue;
    }
    i += len;
  }
  return { scans, width, height };
}

function fitOffThread(buf, kind) {
  const { Worker } = require('worker_threads');
  return new Promise((resolve) => {
    const worker = new Worker(path.join(__dirname, 'imageFitWorker.js'));
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), FIT_TIMEOUT_MS);
    worker.once('message', (msg) => {
      if (!msg || !msg.ok || !msg.buffer) finish(null);
      else finish({ mime: msg.mime, buffer: Buffer.from(msg.buffer) });
    });
    worker.once('error', () => finish(null));
    worker.postMessage({ kind, buffer: buf });
  });
}

async function fitPhoto(buf, kind, deadline) {
  if (deadline && Date.now() > deadline) return null;
  if (kind === 'image/png' && pngTooBig(buf)) return null;
  if (kind === 'image/jpeg') {
    const info = jpegInfo(buf);
    if (!info.width || !info.height || info.width * info.height > MAX_PIXELS || info.scans > MAX_JPEG_SCANS) return null;
  }
  if (buf.length <= PHOTO_MAX) return { mime: kind, buffer: buf };
  return fitOffThread(buf, kind);
}

function closeAgent(agent) {
  if (!agent) return;
  if (typeof agent.destroy === 'function') {
    try { agent.destroy(); } catch { /* already closed */ }
    return;
  }
  if (typeof agent.close === 'function') {
    try { agent.close(); } catch { /* already closed */ }
  }
}

async function fetchChecked(raw, options, limit) {
  const fetchImpl = options.fetchImpl || global.fetch;
  const deadline = options.deadline || (Date.now() + (options.deadlineMs || IMPORT_DEADLINE_MS));
  const pin = fetchImpl === global.fetch;
  let current = String(raw);
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const left = deadline - Date.now();
    if (left <= 0) return fail('import_blocked');
    const checked = await assertPublicUrl(current, options.lookup);
    if (!checked.ok) return checked;
    const agent = pin && checked.address ? pinAgent(checked.address, Math.min(5000, left)) : null;
    let res;
    try {
      res = await fetchImpl(checked.url.href, {
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.min(options.timeoutMs || TIMEOUT_MS, left)),
        headers: { 'user-agent': 'ErstantwortPilot/1.0', accept: options.accept || 'text/html,application/xhtml+xml' },
        ...(agent ? { dispatcher: agent } : {}),
      });
    } catch {
      await closeAgent(agent);
      return fail('import_blocked');
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : '';
      await closeAgent(agent);
      if (!location) return fail('import_blocked');
      try { current = new URL(location, checked.url).href; } catch { return fail('import_blocked'); }
      continue;
    }
    if (!res.ok) {
      await closeAgent(agent);
      return fail('import_blocked');
    }
    let buf;
    try {
      buf = await readBody(res, limit);
    } catch {
      await closeAgent(agent);
      return fail('import_blocked');
    }
    await closeAgent(agent);
    if (!buf) return fail('import_blocked');
    const type = res.headers && typeof res.headers.get === 'function' ? String(res.headers.get('content-type') || '') : '';
    return { ok: true, buffer: buf, type, url: checked.url.href };
  }
  return fail('import_blocked');
}

async function fetchListing(raw, options = {}) {
  const deadline = Date.now() + (options.deadlineMs || IMPORT_DEADLINE_MS);
  const shared = { ...options, deadline };
  const page = await fetchChecked(raw, { ...shared, accept: 'text/html' }, HTML_LIMIT);
  if (!page.ok) return page;
  const parsed = parseListingHtml(page.buffer.toString('utf8'), page.url);
  if (!parsed.fields.title && !parsed.fields.price) return fail('import_empty');
  const photos = [];
  for (const imageUrl of parsed.images) {
    if (deadline - Date.now() <= 0) break;
    const image = await fetchChecked(imageUrl, { ...shared, accept: 'image/jpeg,image/png' }, IMAGE_LIMIT);
    if (!image.ok) continue;
    if (deadline - Date.now() <= 0) break;
    const kind = imageKind(image.buffer);
    if (!kind) continue;
    const fitted = await fitPhoto(image.buffer, kind, deadline);
    if (!fitted) continue;
    photos.push({ mime: fitted.mime, dataUrl: `data:${fitted.mime};base64,${fitted.buffer.toString('base64')}` });
    if (photos.length >= MAX_PHOTOS) break;
  }
  const fields = { ...parsed.fields };
  if (photos.length) fields.photos = photos;
  const filled = Object.keys(fields).filter((key) => fields[key] != null && fields[key] !== '' && !(Array.isArray(fields[key]) && !fields[key].length));
  return { ok: true, status: 200, url: page.url, fields, filled };
}

function mergeListingFields(found, draft, defaults = {}) {
  const next = { ...draft };
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
  const photos = found.photos || [];
  if (photos.length && !(draft.photos || []).length) {
    next.photos = photos;
    filled.push('photos');
  } else if (photos.length) conflicts.push('photos');
  return { next, filled, conflicts };
}

module.exports = {
  assertPublicUrl,
  parseListingHtml,
  fetchListing,
  mergeListingFields,
  isPrivateAddress,
  CURRENCIES,
};
