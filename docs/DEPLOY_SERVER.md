# Запуск на сервере до старта Mini App

Пошаговый чек-лист для one-broker пилота: сервер → домен/HTTPS → Postgres → Telegram → WhatsApp → приёмка.
Версия проекта: v0.5.10+ (проверьте `package.json` → `"version"`). Краткая заливка: [`SERVER_UPLOAD.md`](../SERVER_UPLOAD.md).

## 0. Что должно быть готово

- Linux-сервер (Ubuntu 22.04/24.04), root/sudo, 2 GB RAM минимум.
- Домен и DNS: `A`-запись `app.вашдомен.ae` → IP сервера.
- Открыты порты 80 и 443; 8791 наружу НЕ открываем.
- Docker + Docker Compose.
- Telegram-бот (BotFather), включён **Business Mode**: BotFather → ваш бот → Bot Settings → Business → Turn on.
- Числовой Telegram ID владельца установки → `OWNER_TELEGRAM_ID` (узнать через @userinfobot).
- Старт **Telegram-only** (`INTL_WHATSAPP_UI=false`). WhatsApp — после отдельной приёмки и AVV.
- Multi-broker уже в compose: `MULTI_USER=true`, `TELEGRAM_ALLOWED_USER_IDS=*`. Коллега: [`TEAM_COLLEAGUE.md`](TEAM_COLLEAGUE.md).
- Юридика: privacy policy + AVV (хостер + Telegram) до `CHANNEL_MODE=live`.

## 1. Подготовка сервера

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y ca-certificates curl git ufw
# Docker Engine + compose plugin (официальный скрипт)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # перелогиниться
docker compose version

sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Caddy для HTTPS:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```caddyfile
app.вашдомен.ae {
  encode gzip
  reverse_proxy 127.0.0.1:8791
}
```

```bash
sudo systemctl reload caddy
```

Проверка после запуска приложения: `https://app.вашдомен.ae/healthz` → `ok`.

## 2. Секреты

Сгенерируйте на сервере (не храните в git, не кидайте в чат):

```bash
openssl rand -hex 32   # HASH_SALT
openssl rand -hex 32   # ENGINE_TOKEN
openssl rand -hex 32   # TELEGRAM_WEBHOOK_SECRET
openssl rand -hex 24   # POSTGRES_PASSWORD
openssl rand -hex 16   # GREENAPI_WEBHOOK_TOKEN (если Green API)
```

`HASH_SALT` после первых STOP у клиентов **не менять** — иначе сломаются хеши.

## 3. Папка проекта и `.env`

```bash
cd /opt
# zip распакован, например:
ls -la /opt/erstantwort-intl
cd /opt/erstantwort-intl
cp .env.server.example .env
nano .env
```

Минимальный `.env` на старте (**sim**, без реальных клиентов). Значения подставить свои:

```env
PRODUCT_MODE=intl
CHANNEL_MODE=sim
HOST=0.0.0.0
INTL_PORT=8791

HASH_SALT=<hex-32>
ENGINE_TOKEN=<hex-32>
POSTGRES_USER=intl
POSTGRES_PASSWORD=<hex-24>
POSTGRES_DB=intl

UI_PUBLIC_BASE=https://app.вашдомен.ae
BROKER_TZ=Asia/Dubai
TRUST_PROXY=1

TELEGRAM_BOT_TOKEN=123456:AA...
TELEGRAM_WEBHOOK_SECRET=<hex-32>
TELEGRAM_ALLOWED_USER_IDS=*
MULTI_USER=true
OWNER_TELEGRAM_ID=<ваш_telegram_id>
AUTO_SET_WEBHOOK=true

REAL_DATA_ALLOWED=false
ALLOW_REAL_DATA=false
DEMO_UI_NO_AUTH=false
EPHEMERAL_DISK=false
INTL_WHATSAPP_UI=false
INTL_AI_OPTIONS=false
LLM_MODE=mock
INTL_LIVE_AUTOSEND=false
```

День пилота (реальные заявки): `CHANNEL_MODE=live`, `REAL_DATA_ALLOWED=true`, `ALLOW_REAL_DATA=true`.

WhatsApp включайте только после AVV: `INTL_WHATSAPP_UI=true` + креды Green/Meta (см. [WHATSAPP.md](../WHATSAPP.md)).

## 4. Compose

Порт уже на loopback (`127.0.0.1:8791`). WhatsApp UI по умолчанию выключен. Менять compose не нужно для Telegram-пилота.

## 5. Запуск

```bash
cd /opt/erstantwort-intl
# optional on a host with Node: npm run preflight
docker compose -f docker-compose.intl.yml up -d --build
docker compose -f docker-compose.intl.yml ps
docker compose -f docker-compose.intl.yml logs -f intl
```

Caddy: шаблон [`Caddyfile.intl`](../Caddyfile.intl) — gzip, HSTS, health_uri `/healthz`, proxy на `127.0.0.1:8791`.

Проверки:

```bash
curl -s http://127.0.0.1:8791/healthz
# ok postgres

curl -s http://127.0.0.1:8791/readyz
# ok postgres  (503 draining при остановке контейнера)

curl -s http://127.0.0.1:8791/v1/health
# {"ok":true,"channel_mode":"sim|live","store":"postgres","whatsapp_ui":false,"webhook_url_set":true,...}

curl -s https://app.вашдомен.ae/healthz
```

`docker compose stop` даёт ~20s на graceful shutdown (SIGTERM → drain → закрытие Postgres worker).

Postgres-миграции применяются автоматически при старте (`db/migrations`). Офлайн-проверка миграций:

```bash
docker compose -f docker-compose.intl.yml exec intl npm run migrate:smoke
```

Если в логах ошибка старта — см. раздел 10.

## 6. Telegram: вебхук, кнопка Mini App, Business

При `AUTO_SET_WEBHOOK=true` и `UI_PUBLIC_BASE=https://...` вебхук ставится сам при старте. Ручной повтор:

```bash
docker compose -f docker-compose.intl.yml exec intl node scripts/telegram_webhook.js
```

Проверка:

```bash
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"
# url = https://app.вашдомен.ae/v1/intl/telegram, pending_update_count = 0
```

Кнопка Mini App:

```bash
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setChatMenuButton" \
  -H 'Content-Type: application/json' \
  -d '{"menu_button":{"type":"web_app","text":"Erstantwort","web_app":{"url":"https://app.вашдомен.ae"}}}'
```

Подключение Telegram Business (делает брокер в своём Telegram):

1. Настройки → Telegram Business → Чат-боты → добавить `@ваш_бот`.
2. Разрешить боту отвечать на сообщения.
3. В Mini App: Настройки → канал Telegram → должен появиться статус «Подключен».

Откройте бота → кнопка «Erstantwort» → Mini App должен открыться без 401 (initData + allowlist).

## 7. WhatsApp

### Green API

1. Кабинет Green API → Instance → скопировать `idInstance` и `apiTokenInstance` в `.env`.
2. Перезапуск: `docker compose -f docker-compose.intl.yml up -d`.
3. Mini App → Настройки → WhatsApp → «Настроить» → ввести параметры → «Сканировать QR-код и активировать» → отсканировать с рабочего телефона (WhatsApp → Связанные устройства).
4. Вебхук Green API (желательно): `https://app.вашдомен.ae/v1/intl/whatsapp?token=<GREENAPI_WEBHOOK_TOKEN>`.
   Если вебхук не доходит, сервер всё равно забирает сообщения опросом каждые 5 секунд.

### Meta Cloud API

1. Meta for Developers → WhatsApp → API Setup: токен, Phone number ID, App Secret.
2. Webhook URL: `https://app.вашдомен.ae/v1/intl/whatsapp`, Verify token = `WHATSAPP_VERIFY_TOKEN`, подписать поле `messages`.
3. В Mini App → WhatsApp → выбрать «Meta Cloud API» → сохранить.
4. Номер должен быть «чистым» и пройти верификацию бизнеса.

## 8. Бэкап и uptime

`backup_intl.js` требует `pg_dump`. Проще всего бэкапить через контейнер Postgres:

```bash
mkdir -p /opt/backups
docker compose -f docker-compose.intl.yml exec -T postgres \
  pg_dump -U intl intl | gzip > /opt/backups/intl-$(date +%F-%H%M).sql.gz
```

Cron (каждый день 03:15):

```cron
15 3 * * * cd /opt/erstantwort-intl && docker compose -f docker-compose.intl.yml exec -T postgres pg_dump -U intl intl | gzip > /opt/backups/intl-$(date +\%F-\%H\%M).sql.gz
```

Внешний монитор (UptimeRobot) на `https://app.вашдомен.ae/healthz`, алерт вам в Telegram.

## 9. Приёмка до приглашения брокеров

Пройдите чек-лист `docs/DAILY_ACCEPTANCE.md`:

- [ ] Новый клиент пишет брокеру → заявка в Mini App, уведомление брокеру **одно** («Вам пришло новое сообщение от HOT/WARM/COLD лида»), без спама напоминаний.
- [ ] Брокер правит и отправляет ответ → клиент получает ровно одно сообщение; повтор кнопки не дублирует.
- [ ] Клиент пишет STOP → автоматика выключается, хеш сохраняется.
- [ ] Два клиента на один слот → второй получает `slot_unavailable`.
- [ ] Утренний дайджест приходит по расписанию.
- [ ] Перезапуск `docker compose restart intl` → вебхук и заявки живы.
- [ ] Бэкап создаётся и восстанавливается на тестовой БД.
- [ ] Проверка второго номера WhatsApp → уведомление, ответ, подтверждение просмотра.

Только после этого зовите брокеров.

## 10. Частые ошибки старта

| Код/симптом | Причина | Что делать |
|---|---|---|
| `postgres_required` | live без `INTL_DATABASE_URL` | запускать через compose (он подставляет URL) |
| `real_data_required_for_live` | live без двух флагов | `REAL_DATA_ALLOWED=true` и `ALLOW_REAL_DATA=true` |
| `telegram_token_missing/invalid` | пустой/битый токен | проверить `TELEGRAM_BOT_TOKEN` в `.env` |
| `whatsapp_credentials_invalid` | битые Green/Meta креды | проверить формат id/token |
| `webhook_auto_skip` | `UI_PUBLIC_BASE` не https | поставить https-домен |
| Mini App 401 | initData/allowlist | при `MULTI_USER` нужен `TELEGRAM_ALLOWED_USER_IDS=*`; открывать из Telegram |
| 502 от Caddy | приложение не слушает 8791 | `docker compose logs intl`, `/healthz` |
| Нет кнопки Mini App | URL не https | сначала HTTPS/Caddy, потом setChatMenuButton |
| Нет входящих WhatsApp | Green webhook/QR | проверить QR-статус, вебхук, опрос в логах |

## 11. Ограничение пилота

Одна инсталляция = один бот на VPS. С `MULTI_USER=true` каждый маклер получает свой кабинет по Telegram ID. Общий инбокс — через «Подключить коллегу» ([TEAM_COLLEAGUE.md](TEAM_COLLEAGUE.md)). WhatsApp-креды по-прежнему per-broker, если UI включён.

## 12. Откат

```bash
cd /opt/erstantwort-intl
docker compose -f docker-compose.intl.yml down
# распаковать предыдущий архив в отдельную папку и поднять его compose
```
