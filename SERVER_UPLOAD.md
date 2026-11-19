# Перед заливкой на сервер (v0.5.11)

Архив для переноса: `dist/erstantwort-intl-0.5.11.zip` (без `node_modules`, `.env`, баз).

## Что взять с собой

1. Zip из `dist/`
2. Домен с DNS A → IP VPS
3. Токен бота (BotFather, **Business Mode** включён)
4. Свой Telegram ID → `OWNER_TELEGRAM_ID`
5. Юридика: Privacy + AVV (хостер + Telegram) до `CHANNEL_MODE=live`

## На сервере (кратко)

```bash
sudo mkdir -p /opt/erstantwort-intl
cd /opt
sudo unzip erstantwort-intl-0.5.11.zip -d erstantwort-intl
cd /opt/erstantwort-intl

cp .env.server.example .env
# заполнить секреты:
#   openssl rand -hex 32   → HASH_SALT, ENGINE_TOKEN, TELEGRAM_WEBHOOK_SECRET
#   openssl rand -hex 24   → POSTGRES_PASSWORD
#   TELEGRAM_BOT_TOKEN, OWNER_TELEGRAM_ID, UI_PUBLIC_BASE=https://…

npm run preflight   # на машине с Node, или проверьте .env вручную

# Caddy: см. Caddyfile.intl (скопировать в /etc/caddy/Caddyfile, подставить домен)

docker compose -f docker-compose.intl.yml up -d --build
curl -s http://127.0.0.1:8791/healthz
curl -s http://127.0.0.1:8791/readyz
curl -s http://127.0.0.1:8791/v1/health
```

Серверные оптимизации уже в zip: multi-stage Docker, graceful SIGTERM, лимит логов/RAM, Postgres tuned, кэш статики, `/readyz`.

Старт в `CHANNEL_MODE=sim`. День пилота: `live` + `REAL_DATA_ALLOWED=true` + `ALLOW_REAL_DATA=true`.

## Multi-broker + коллега

- Уже включено: `MULTI_USER=true`, `TELEGRAM_ALLOWED_USER_IDS=*`
- Каждый маклер открывает Mini App своим Telegram → свой кабинет
- Коллега: Настройки → «Подключить коллегу» ([docs/TEAM_COLLEAGUE.md](docs/TEAM_COLLEAGUE.md))

## Проверки

| Команда | Ожидание |
|---|---|
| `curl /healthz` | `ok postgres` |
| `curl /v1/health` | `product_mode:intl`, webhook set |
| `npm run smoke:team` (локально до заливки) | `team_smoke ok` |
| 7 дней | [docs/DAILY_ACCEPTANCE.md](docs/DAILY_ACCEPTANCE.md) |

Полный чек-лист: [docs/DEPLOY_SERVER.md](docs/DEPLOY_SERVER.md), [docs/DAILY_PILOT.md](docs/DAILY_PILOT.md).
