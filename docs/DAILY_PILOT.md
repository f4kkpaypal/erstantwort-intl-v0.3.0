# Ежедневный «бесплатный» пилот (не Render Free)

Цель: маклер пользуется каждый день за €0; инфра always-on платите вы (~€5–15/мес).  
**Render Free — только витрина** (`Dockerfile.free` / `scripts/free_host.js`). Реальные заявки туда не класть.

## Стек

| Слой | Что |
|---|---|
| Образ | [`Dockerfile.intl`](../Dockerfile.intl) → `node engine/intlServer.js` |
| Compose | [`docker-compose.intl.yml`](../docker-compose.intl.yml) |
| Render pilot | [`render.yaml`](../render.yaml) сервис `erstantwort-intl-pilot` (Starter + Postgres, **не** Free) |
| Канал | Telegram Business only (`INTL_WHATSAPP_UI=false`) |
| Доступ | `MULTI_USER=true`, `TELEGRAM_ALLOWED_USER_IDS=*` — кабинет на каждого маклера; коллега через Mini App ([`TEAM_COLLEAGUE.md`](TEAM_COLLEAGUE.md)) |
| AI | `INTL_AI_OPTIONS=false` |
| Автоотправка | `INTL_LIVE_AUTOSEND=false` |

## Локально / Hetzner

```bash
python3 scripts/init_env.py
# В .env: PRODUCT_MODE=intl, HASH_SALT, ENGINE_TOKEN, POSTGRES_PASSWORD,
# UI_PUBLIC_BASE=https://…, TELEGRAM_*, TRUST_PROXY=1 (проверьте hops на хосте)
docker compose -f docker-compose.intl.yml up -d --build
curl -s http://127.0.0.1:8791/healthz
curl -s http://127.0.0.1:8791/v1/health
npm run migrate:smoke          # без URL — только файлы; с INTL_DATABASE_URL — живой apply
```

День пилота (реальные люди):

```env
CHANNEL_MODE=live
REAL_DATA_ALLOWED=true
ALLOW_REAL_DATA=true
AUTO_SET_WEBHOOK=true
EPHEMERAL_DISK=false
INTL_WHATSAPP_UI=false
INTL_AI_OPTIONS=false
MULTI_USER=true
TELEGRAM_ALLOWED_USER_IDS=*
```

При старте live+https процесс сам вызывает `setWebhook` на `$UI_PUBLIC_BASE/v1/intl/telegram`.  
Ручной повтор: `node scripts/telegram_webhook.js`.

## Backup

```bash
# cron nightly, на хосте с pg_dump:
INTL_DATABASE_URL=postgres://… npm run ops:backup-intl
```

`HASH_SALT` и `ENGINE_TOKEN` только из env / password manager. Не ротировать `HASH_SALT` после первых STOP.

## Uptime

Внешний монитор (например UptimeRobot) на `https://<host>/healthz` → алерт вам в Telegram, не маклеру.

## TRUST_PROXY

На Hetzner за Caddy обычно `1`. На Render Starter тоже часто `1`. После деплоя сверьте client IP в логах rate-limit: если все видят IP прокси — увеличьте hops.

## Юридика до первой заявки

См. [`AVV_CHECKLIST.md`](AVV_CHECKLIST.md) и [`DAILY_ACCEPTANCE.md`](DAILY_ACCEPTANCE.md). Субпроцессоры пилота: хостер + Telegram (+ Postgres host). DeepSeek/Gemini не включать.

## WhatsApp

Код канала остаётся в репозитории. В ежедневном пилоте UI скрыт (`INTL_WHATSAPP_UI=false`). Включать только после отдельной приёмки и записи в AVV.
