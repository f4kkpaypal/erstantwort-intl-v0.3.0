# LAUNCH — как запустить эту сборку

Эта сборка — рабочая копия проекта на 2026-11-15 после раунда исправлений (см. `CHANGELOG-review.md`).
Проверено локально: тесты, `demo:intl`, `demo`, `holdout`, `office:check`; **не проверено**: Docker/Compose,
живой Telegram Business, Render, реальный IMAP/SMTP — у сборщика не было доступа к этим средам.

Два продукта в одном репозитории:

- **intl** (Дубай, Telegram Business, EN/RU Mini App) — актуальный, запускается первым;
- **de** (немецкие маклеры, ImapScout24, n8n + Google) — референс, не трогать.

## 0. Что нужно решить до запуска

1. Куда запускаем: **Render** (быстро, `render.yaml` уже есть) или **Hetzner** (полный контроль).
2. Канал: **Telegram Business** работает; **WhatsApp** в этой сборке только симулятор (`wa_sim`).
3. Реальные данные: включать только когда есть `AVV`/`Privacy Policy` с субпроцессорами (хотя бы Telegram,
   хостер БД; DeepSeek/Gemini — только если включаете AI).

## 1. Локальная проверка без ключей (15 минут)

Нужен Node 22.13+ (из-за `node:sqlite`) и Python 3 для `init_env.py`; Docker для локального стека опционален.

```bash
cd erstantwort-intl
npm ci
npm run check          # синтаксис 4 ключевых файлов
npm test               # полный набор тестов
npm run demo:intl      # сквозной intl-сценарий на фикстурах, без сети
npm run holdout        # проверка разбора на holdout-файле
```

Демо-интерфейс без Telegram:

```bash
python3 scripts/init_env.py     # создаст .env (или дозаполнит отсутствующие секреты)
DEMO_UI_NO_AUTH=true ENGINE_PORT=18788 UI_PUBLIC_BASE=http://127.0.0.1:18791 node engine/intlServer.js
# во втором терминале:
WEB_PORT=18791 node web/server.js
# открыть http://127.0.0.1:18791/
```

`DEMO_UI_NO_AUTH=true` работает только на loopback. На https он не запустится без `ALLOW_INSECURE_DEV=true`
(и это не для прода).

## 2. Запуск на Render (intl)

1. Запушьте репозиторий в GitHub (без `.env`, `node_modules`, `var/`, архивов сессий — `.gitignore` уже это
   закрывает; CI-workflow проверит, что запрещённое не попало в git).
2. Render → New → Blueprint → выберите репозиторий, `render.yaml` подхватится сам.
3. В Blueprint два сервиса: `erstantwort-intl-demo` (Free, витрина, засыпает) и `erstantwort-intl-pilot`
   (Starter + Postgres). Демо не трогайте, пилот — рабочий.
4. В сервисе `erstantwort-intl-pilot` заполните переменные (значения — из панели, не в git):
   `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_ALLOWED_USER_IDS`, `UI_PUBLIC_BASE`
   (`https://<сервис>.onrender.com`), `INTL_DATABASE_URL` (Internal Database URL), `HASH_SALT` (сгенерирует
   Blueprint, менять нельзя), `BROKER_TZ=Asia/Dubai`.
5. Остальные флаги на старте: `CHANNEL_MODE=sim`, `REAL_DATA_ALLOWED=false`, `ALLOW_REAL_DATA=false`,
   `INTL_AI_OPTIONS=false`, `DEMO_UI_NO_AUTH=false`, `MULTI_USER=false`.
6. Проверка: `https://<сервис>/healthz` → `ok`; `https://<сервис>/v1/health` → `product_mode:intl`,
   `channel_mode:sim`, `store:postgres`.
7. Telegram: BotFather → Business Mode → включить; брокер подключает бота в Telegram Business;
   вебхук ставится скриптом:

   ```bash
   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... node scripts/telegram_webhook.js
   # адрес вебхука: https://<сервис>/v1/intl/telegram
   ```

8. Проверить sim: второй аккаунт пишет брокеру → в Mini App появляется заявка, но наружу ничего не уходит.

## 3. День пилота: sim → live

1. В Render поставьте сразу три переменные: `CHANNEL_MODE=live`, `REAL_DATA_ALLOWED=true`,
   `ALLOW_REAL_DATA=true`. Без обоих флагов движок откажется стартовать с `real_data_required_for_live` —
   это защита, а не баг.
2. Убедитесь, что в AVV/Privacy Policy перечислены: Telegram, хостер БД, и — только если включите —
   DeepSeek/Gemini.
3. Перезапустите сервис, проверьте `/v1/health`: `channel_mode:live`, `live_autosend:false`.
4. Пройдите приёмку (раздел 4) на трёх реальных заявках, при владельце, в режиме ручной отправки.

## 4. Приёмка перед реальными клиентами

- **Заявка:** клиент пишет брокеру → заявка в Mini App, в уведомлении брокеру нет имени/телефона клиента.
- **Черновик:** брокер открывает заявку → видит варианты ответа; без `INTL_AI_OPTIONS=true` они
  правило-основанные, и никакие данные никуда не уходят (проверьте это, отключив ключи AI).
- **Отправка:** кнопка «Отправить» → клиент получает ровно одно сообщение от имени брокера; повтор кнопки
  не дублирует (идемпотентность по `idempotency-key`).
- **Бронь:** два клиента на один слот → второй получает `slot_unavailable`; подтверждение меняет статус один раз;
  отмена освобождает слот (см. `test/intl/booking-atomic.test.js`).
- **STOP:** «STOP» от клиента → автоматика выключается, хеш сохраняется; `erase` удаляет данные, хеш оставляет.
- **Retention:** после `intl.retain()` в `i_message` не остаётся `dedup_key` с Telegram chat id
  (см. `test/intl/retention-keys.test.js`).
- **Логи:** в логах нет имени, почты, телефона клиента и текста заявки.

## 5. Что осознанно не поддерживается в этой сборке

- **WhatsApp** — только симулятор (`/v1/sim/wa/inbound`, `CHANNEL_MODE=sim`). Реальный канал — Telegram Business.
- **Вложения клиенту в live** — только текст; картинки/PDF в пилоте не уходят.
- **Follow-up / no-show / «Interesse weiterhin?»** — отправщиков нет, флаги выключены (UWG §7).
- **Propstack** — `NOT_IMPLEMENTED`, клиента API нет.
- **n8n** — немецкая ветка; для intl не требуется.
- **AI-варианты (DeepSeek/Gemini)** — выключены по умолчанию; включаются флагом и требуют записи в AVV.

## 6. Безопасность: что не делать

- Не выставлять `DEMO_UI_NO_AUTH=true` на публичный адрес — это вход без авторизации (loopback-only).
- Не включать `MULTI_USER=true`, если не готовы пускать любого с валидной подписью Telegram.
- Не коммитить `.env`, ключи и БД — `.gitignore` + CI-guard уже настроены.
- Не включать `INTL_AI_OPTIONS=true` без AVV/DPA: имя и текст заявки уходят в DeepSeek (Китай) или Gemini.
- `HASH_SALT` не менять после первого запуска: старые opt-out-хеши станут нечитаемыми.

## 7. Обновление и откат

- Сборка — zip из `scripts/pack.ps1` (Windows) или `scripts/pack.sh` (Linux). Внутри только исходники.
- Перед обновлением: `node scripts/ops.js backup` (если используете Postgres из compose) и экспорт
  `INTL_DATABASE_URL`-базы средствами хоста.
- Откат: предыдущий zip + тот же `.env` (секреты и `HASH_SALT` не меняются).

## 8. Что проверено в этой сборке

- Тесты: актуальный прогон — `npm run test:local` (см. число в выводе; в v0.5.9+ порядка 339+).
- Демо без ключей: `demo:intl` (6 HOT / 8 WARM / 11 COLD), `demo` (de), `landing`, `holdout` (pass), `office:check`.
- Multi-broker: `MULTI_USER=true` + `TELEGRAM_ALLOWED_USER_IDS=*`; коллега — [docs/TEAM_COLLEAGUE.md](docs/TEAM_COLLEAGUE.md).
- Подробности и список непроверенного (Docker, живой Telegram, Render, Postgres) — `RELEASE-CHECKLIST.md`.
- Что и почему изменено в этом раунде — `CHANGELOG-review.md`.
- WhatsApp Cloud API / Green API: [WHATSAPP.md](WHATSAPP.md). В ежедневном пилоте UI скрыт (`INTL_WHATSAPP_UI=false`), пока нет отдельной приёмки и AVV.
