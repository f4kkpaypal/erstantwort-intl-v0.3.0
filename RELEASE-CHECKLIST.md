# RELEASE-CHECKLIST — что проверено в этой сборке

Снимок: 2026-11-15, рабочая копия `work/erstantwort-intl` (основа — экспорт 20:46).
Среда сборщика: Windows, Node v26.13.0, npm 11.20.0, Python 3.15, DSH sandbox (workspace-write).
Чего в среде не было: Docker, живые Telegram/IMAP/SMTP, доступ к Render/Hetzner/Postgres.

## 1. Тесты

| Прогон | Результат |
|---|---|
| `node scripts/local-test.js` (весь набор, каждый файл отдельным процессом) | Актуальный прогон при сборке: **54 файла / 339 тестов** (растёт с фичами; сверяйте вывод `npm run test:local`) |
| `node test/intl/booking-atomic.test.js` | 8/8 pass (двойная бронь, идемпотентность, чужой объект, подтверждение/отмена) |
| `node test/intl/retention-keys.test.js` | 4/4 pass (chat id и message id не остаются, срок продлевается) |
| `node test/intl/ai-options.test.js` | 5/5 pass (флаг off → 0 сетевых вызовов; флаг on → вызов и fallback; TTL/лимит кэша) |
| `node test/intl/pilot.test.js` | 17/17 pass (включая live-гейт: оба флага реальных данных) |
| `node --check` по изменённым файлам | чисто |

`npm test` (канонический `node --test`) в песочнице не запускается: 39/39 файлов падают `spawn EPERM`
до первого теста — ограничение песочницы, не кода. В CI (`.github/workflows/ci.yml`) используется именно
`npm test`; локальный фолбэк — `npm run test:local`.

**Архив проверен end-to-end** из чистой распаковки: `npm ci` (exit 0) → `npm run check` (exit 0) →
`node scripts/local-test.js` (**289/289**) → `demo_intl.js` (exit 0, `6 HOT / 8 WARM / 11 COLD`).

## 2. Демо и скрипты (без ключей и сети)

| Команда | Результат |
|---|---|
| `DEMO_INTL_EXIT=1 INTL_PORT=<свободный> node scripts/demo_intl.js` | exit 0, `6 HOT / 8 WARM / 11 COLD` |
| `node scripts/demo_local.js` (`npm run demo`, de) | exit 0, письмо E01 собрано, STOP-строка на месте |
| `node landing/render.js` (`npm run landing`) | exit 0, лендинг отрендерен |
| `node scripts/holdout.js <file>` | exit 0, `pass:true`; без файла — аккуратный exit 2 |
| `node scripts/office.js check` без slug | exit 1, `bad_slug` (раньше — `TypeError`) |
| `python3 scripts/init_env.py` | создаёт `.env`; повторный запуск дозаполняет только заглушки, остальное не трогает |

## 3. Безопасность (проверено статически и тестами)

- AI-варианты выключены по умолчанию: тест доказывает **ноль** запросов к DeepSeek/Gemini при
  `INTL_AI_OPTIONS=false`, даже если ключи в окружении.
- Ключ Gemini не передаётся в query string (заголовок `x-goog-api-key`), голосовой модуль не подключён.
- `CHANNEL_MODE=live` без `REAL_DATA_ALLOWED=true` + `ALLOW_REAL_DATA=true` не стартует.
- Webhook-секрет сравнивается constant-time; статика ограничена каталогом `ui-intl`; SQL параметризован.
- В поставке нет реальных секретов: `.env` — заглушки (`YOUR…_HERE`, `dev_…`); в архив `.env` не попадает.

## 4. Зависимости и сборка

- `package.json`: `engines.node >= 22.13.0` (первый релиз, где `node:sqlite` работает без флага), версия из `package.json` (линейка 0.5.x).
- `package-lock.json` синхронизирован с `package.json` (включая workspace-пакеты `packages/*`); версии не разъехались
  (drift 0), `npm ci --dry-run` проходит.
- `npm audit --omit=dev`: 1 high severity — `nodemailer` (диапазон `>=3.0.0 <=10.0.9`), **fixAvailable: false**.
  Затрагивает только немецкую e-mail ветку (нет поллинга/парсинга вложений из недоверенных писем в intl-пути);
  для intl-пилота не блокер, но перед de-пилотом проверить advisory и обновить/заменить библиотеку.
- Docker-сборка и `npm ci` в контейнере не проверялись (Docker отсутствует), но `npm ci` проверен на хосте.

## 5. Что НЕ проверено (нужно на вашей стороне)

1. `npm test` на чистом CI-раннере (ожидается зелёный; локальный аналог — 264/264).
2. Docker-сборка и `docker compose config` / `caddy validate` — Docker в среде сборщика отсутствует.
3. Render Blueprint на живом аккаунте, `/healthz`, `/v1/health` в облаке.
4. Telegram Business: вебхук, приём заявки, отправка от имени брокера, повтор без дубля.
5. Postgres-путь (миграции 002→005, `UNIQUE INDEX`, retention) — локально только SQLite.
   Проверка: `INTL_DATABASE_URL=postgres://... node test/intl/pilot.test.js` (два PG-теста).
6. Реальный IMAP/SMTP de-ветки, реальные письма портала.
7. Telegram-вложения: в live наружу уходит только текст (заявленное ограничение).

## 6. Быстрый smoke после деплоя

```bash
curl -s https://<host>/healthz                      # ok <store>
curl -s https://<host>/v1/health                    # product_mode, channel_mode, live_autosend, store
# в Mini App: заявка → черновик → отправка; второй клиент на тот же слот → slot_unavailable
```

Если `/v1/health` показывает `channel_mode:sim`, наружу ничего не уходит — это ожидаемо до дня пилота.
