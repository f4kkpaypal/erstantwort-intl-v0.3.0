#!/usr/bin/env node
'use strict';

// Fail fast before docker compose up when required server env is incomplete.
// Usage: node scripts/preflight_server.js
// Optional: CHANNEL_MODE=live node scripts/preflight_server.js

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env');

function parseEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

function isPlaceholder(value) {
  const v = String(value || '').trim();
  return !v || /^change-me/i.test(v) || /^YOUR/i.test(v) || /REPLACE_ME/i.test(v);
}

function main() {
  if (!fs.existsSync(envPath)) {
    console.error('preflight_fail missing_.env — cp .env.server.example .env');
    process.exit(1);
  }
  const env = { ...parseEnv(fs.readFileSync(envPath, 'utf8')), ...process.env };
  const required = ['HASH_SALT', 'ENGINE_TOKEN', 'POSTGRES_PASSWORD'];
  const missing = required.filter((key) => isPlaceholder(env[key]));
  if (missing.length) {
    console.error('preflight_fail placeholders ' + missing.join(','));
    process.exit(1);
  }

  const mode = String(env.CHANNEL_MODE || 'sim').toLowerCase();
  if (mode === 'live' || mode === 'test_live') {
    const liveKeys = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'UI_PUBLIC_BASE'];
    const bad = liveKeys.filter((key) => isPlaceholder(env[key]));
    if (bad.length) {
      console.error('preflight_fail live_missing ' + bad.join(','));
      process.exit(1);
    }
    if (!/^https:\/\//i.test(String(env.UI_PUBLIC_BASE || ''))) {
      console.error('preflight_fail UI_PUBLIC_BASE_must_be_https');
      process.exit(1);
    }
    if (String(env.DEMO_UI_NO_AUTH || '').toLowerCase() === 'true') {
      console.error('preflight_fail DEMO_UI_NO_AUTH_forbidden_on_live');
      process.exit(1);
    }
  }

  console.log(`preflight_ok channel_mode=${mode} multi_user=${env.MULTI_USER || 'unset'}`);
}

main();
