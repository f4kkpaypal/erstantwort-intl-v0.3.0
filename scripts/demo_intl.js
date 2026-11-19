'use strict';

const fs = require('fs');
const path = require('path');
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const k = trimmed.slice(0, idx).trim();
      const v = trimmed.slice(idx + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
  }
}
const { loadConfig } = require('../core/config');
const { createIntl } = require('../core/intl/service');
const { buildIntlServer } = require('../engine/intlServer');
const { signInitData } = require('../core/uiAuth');
const pack = require('../fixtures/intl/testset.json');

const config = loadConfig({
  PRODUCT_MODE: 'intl',
  CHANNEL_MODE: 'sim',
  REAL_DATA_ALLOWED: 'false',
  DEMO_UI_NO_AUTH: 'true',
  LLM_MODE: 'mock',
  ...process.env,
});
const intl = createIntl(config);
intl.seed(pack, 'all').then((counts) => {
  const server = buildIntlServer(config, intl);
  const port = Number(process.env.INTL_PORT || 8791);
  server.listen(port, '127.0.0.1', () => {
    console.log(`intl_demo http://127.0.0.1:${port}/`);
    console.log(`${counts.HOT} HOT / ${counts.WARM} WARM / ${counts.COLD} COLD`);
    if (process.env.DEMO_INTL_EXIT === '1') {
      server.close();
      intl.close();
      process.exit(0);
    }
    const id = (config.TELEGRAM_ALLOWED_USER_IDS || [])[0];
    if (id && config.TELEGRAM_BOT_TOKEN) {
      const tma = signInitData({
        auth_date: String(Math.floor(Date.now() / 1000)),
        user: JSON.stringify({ id }),
      }, config.TELEGRAM_BOT_TOKEN);
      console.log(`open http://127.0.0.1:${port}/?tma=${encodeURIComponent(tma)}`);
    }
  });
});
