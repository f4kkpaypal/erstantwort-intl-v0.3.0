# Пилот Erstantwort intl — что сделать владельцу

Один брокер отвечает клиентам в Telegram от своего имени. Бот только принимает заявки и отправляет текст, который брокер нажал в Mini App. Сам бот ничего не пишет, пока вы явно не включите это позже.

Секреты вводите только в панели Render или в локальный `.env`. В чат и в git их не копируйте.

## 1. План Render без сна

В `render.yaml` пилот — отдельный сервис `erstantwort-intl-pilot` (план Starter, Postgres, `CHANNEL_MODE=sim`). Бесплатное демо `erstantwort-intl-demo` не трогайте.

1. Создайте стек из Blueprint или откройте сервис `erstantwort-intl-pilot`.
2. План оставьте платным (Starter или выше). Free засыпает, и Telegram перестаёт доставлять сообщения.
3. Регион оставьте Frankfurt.
4. `HOST=0.0.0.0` уже задан в Blueprint. Порт Render подставит сам (`PORT`).

## 2. Пустая база Postgres

1. В том же регионе создайте Postgres (план Basic достаточно). Старые данные из файла не переносятся — пилот начинается с пустой базы.
2. Скопируйте **Internal Database URL** в переменную `INTL_DATABASE_URL` сервиса. Если отдельного имени нет, подойдёт `DATABASE_URL` с той же строкой.
3. Файлы брошюр, планов и фото хранятся в самой базе (`i_file`, BLOB), а не на диске сервиса. Постоянный диск для них не нужен: они переживают перезапуск вместе с Postgres. `EPHEMERAL_DISK` — информационный флаг, на хранение файлов он не влияет.

## 3. Переменные

Поставьте в Render (имена именно такие):

| Имя | Значение на старте |
|---|---|
| `PRODUCT_MODE` | `intl` |
| `CHANNEL_MODE` | `sim` до дня пилота, в день пилота `live` |
| `REAL_DATA_ALLOWED` | `true` в день пилота (вместе с `ALLOW_REAL_DATA`) |
| `ALLOW_REAL_DATA` | `true` в день пилота; без обоих флагов `CHANNEL_MODE=live` не запустится (`real_data_required_for_live`) |
| `INTL_AI_OPTIONS` | `false` на старте. `true` — только если в AVV/Privacy Policy внесены DeepSeek и Gemini (имя и текст заявки уходят наружу) |
| `MULTI_USER` | `false`: вход по allowlist. `true` пускает любого с валидной подписью Telegram — включать только если так и задумано |
| `INTL_LIVE_AUTOSEND` | не задавайте, или `false` |
| `TELEGRAM_BOT_TOKEN` | токен от @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | случайная строка из `A–Z`, `a–z`, цифр, `_` и `-`, длина от 1 до 256. Другие символы сервис не примет |
| `TELEGRAM_ALLOWED_USER_IDS` | числовой id брокера (один) |
| `HASH_SALT` | длинная случайная строка, одна и та же после перезапусков |
| `INTL_DATABASE_URL` | строка Postgres из шага 2 |
| `UI_PUBLIC_BASE` | `https://` адрес сервиса, без `/` в конце |
| `BROKER_TZ` | `Asia/Dubai` или ваш часовой пояс |
| `MAX_REPLIES_PER_HOUR` | `30`, если не хотите другое |
| `MAX_REPLIES_PER_CHAT_HOUR` | `20` |
| `DATA_DIR` | `var` |
| `EPHEMERAL_DISK` | `true`, или `false` если есть постоянный диск |
| `UI_INITDATA_MAX_AGE_S` | `3600` |
| `AED_PER_USD` | `3.6725` |

`TG_TEST_LEAD_IDS` для боевых чатов не нужен. Не задавайте `INTL_SIMULATE_SEND` — такого переключателя нет.

Пока `CHANNEL_MODE` не `live`, наружу в Telegram ничего не уходит. `test_live` значит то же, что `live`.

## 4. Бот в Telegram

1. В @BotFather откройте бота → Bot Settings → Business Mode (Secretary Mode) и включите его.
2. У брокера в Telegram не должно быть другого подключённого бизнес-бота. На аккаунт можно подключить только одного: новый отключает старого.
3. Брокер: Настройки → Telegram Business → Чат-боты. Выберите этого бота и разрешите отвечать в личных чатах. Telegram Premium для этого шага не нужен.
4. На время пилота выключите у брокера родные приветствие и автоответ «я отошёл». Иначе клиент получит два сообщения.

## 5. Webhook

На своём компьютере, в папке проекта, с теми же переменными:

```bash
node scripts/telegram_webhook.js
```

Скрипт вызывает `setWebhook` и печатает `getWebhookInfo`. В списке должны быть `business_connection`, `business_message`, `edited_business_message`, `deleted_business_messages` и `message`. Очередь старых апдейтов скрипт не стирает.

Адрес webhook: `https://ВАШ-СЕРВИС/v1/intl/telegram`.

## 6. Проверка в день пилота

1. Поставьте `CHANNEL_MODE=live`, `REAL_DATA_ALLOWED=true`, `ALLOW_REAL_DATA=true`. `INTL_LIVE_AUTOSEND` по-прежнему не задан.
2. Дождитесь, пока Render перезапустит сервис. Откройте `https://ВАШ-СЕРВИС/healthz` — ответ `ok`. `https://ВАШ-СЕРВИС/v1/health` показывает `product_mode: intl`, `channel_mode: live`, `live_autosend: false`.
3. Второй аккаунт Telegram пишет брокеру в личку. В Mini App появляется заявка.
4. Брокер сам пишет этому клиенту. Новой заявки нет.
5. Брокер открывает заявку и жмёт «Отправить». Клиент видит текст от имени брокера, не от бота.
6. Повтор той же кнопки не присылает второе такое же сообщение.
7. Картинки и PDF в этом пилоте клиенту не уходят — только текст.

Если health не `live` или кнопка пишет «симуляция», в Telegram ничего не отправлялось. Это нормально, пока режим `sim`.
