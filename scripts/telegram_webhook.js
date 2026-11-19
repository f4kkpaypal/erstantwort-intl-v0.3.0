'use strict';

// Point the bot webhook at this service and ask Telegram which updates it will send.
// Run from the repo root after the env vars are set. The bot token is not printed.

const { loadConfig } = require('../core/config');
const { setWebhook, getWebhookInfo, WEBHOOK_UPDATES } = require('../core/intl/telegramSend');

async function main() {
  const config = loadConfig(process.env);
  const base = String(process.env.UI_PUBLIC_BASE || '').replace(/\/$/, '');
  const webhookUrl = process.argv[2] || (base ? `${base}/v1/intl/telegram` : '');
  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_WEBHOOK_SECRET || !webhookUrl) {
    console.error('Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and UI_PUBLIC_BASE (or pass the webhook URL).');
    process.exit(1);
  }
  if (!/^https:\/\//i.test(webhookUrl)) {
    console.error('The webhook URL has to start with https://');
    process.exit(1);
  }
  const set = await setWebhook(config, webhookUrl);
  if (!set.ok) {
    console.error(`setWebhook failed (${set.error_code || set.status || 'error'})`);
    process.exit(1);
  }
  const info = await getWebhookInfo(config);
  const result = info.ok && info.data && info.data.result ? info.data.result : {};
  const allowed = Array.isArray(result.allowed_updates) ? result.allowed_updates : [];
  const missing = WEBHOOK_UPDATES.filter((name) => !allowed.includes(name));
  console.log(`webhook_url_set=${result.url ? 'yes' : 'no'}`);
  console.log(`pending_update_count=${result.pending_update_count || 0}`);
  console.log(`allowed_updates=${allowed.join(',')}`);
  if (result.last_error_message) console.log(`last_error=${result.last_error_message}`);
  if (missing.length) {
    console.error(`missing_updates=${missing.join(',')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err && err.message ? err.message : 'webhook_failed');
  process.exit(1);
});
