# WhatsApp Cloud API (Meta) — подключение

В проекте есть официальный канал **WhatsApp Cloud API**. Это не WhatsApp Web и не автоматизация
личного номера: сообщения идут через Graph API Meta, по правилам платформы.

## Что поддерживается сейчас

- Входящие **текстовые** сообщения → заявки в Mini App (с дедупликацией по `message.id`).
- Кнопки/интерактивные ответы приводятся к тексту.
- Исходящие **текстовые** ответы через `POST https://graph.facebook.com/v21.0/{phone_number_id}/messages`.
- Проверка подписи вебхука (`X-Hub-Signature-256`), проверка verify-token при подписке.
- STOP-опт-аут обрабатывается как обычно (по тексту клиента).

## Чего нет (осознанно, честно)

- Вложения: PDF/фото/видео — **не отправляются и не принимаются** (текст и ссылки).
- Голосовые — не распознаются (см. `pilot`-ограничения в приложении).
- **Шаблоны сообщений (templates)**: вне 24-часового окна Meta отклоняет свободный текст с кодом
  `131047`; приложение вернёт `template_required`, а не сделает вид, что отправило.
- Группы, каталоги, статусы, реакции — обрабатываются только как текст (реакции отбрасываются).
- Один номер на WABA; смена номера требует перенастройки.

## Настройка Meta (один раз)

1. Создайте приложение на <https://developers.facebook.com/> → добавьте продукт **WhatsApp**.
2. Получите номер (тестовый номер Meta подходит для пилота, но писать можно только 5 получателям,
   которых вы добавите). Для реального бизнеса — собственный номер и верификация Business.
3. Возьмите **Permanent access token** (System User) и **Phone number ID**.
4. Возьмите **App secret** (Settings → Basic → App secret) — он нужен для проверки подписи.
5. Придумайте **Verify token** (любая строка) — его вы впишете и в Meta, и в `.env`.

## Переменные окружения

```env
WHATSAPP_TOKEN=EAAG...                # permanent token
WHATSAPP_PHONE_NUMBER_ID=111222333    # Phone number ID из Meta
WHATSAPP_VERIFY_TOKEN=my-verify-token # придумать; вписать в Meta Webhook
WHATSAPP_APP_SECRET=abc123...         # App secret (обязательно)
# опционально:
WHATSAPP_API_VERSION=v21.0
WHATSAPP_API_BASE=https://graph.facebook.com
```

## Вебхук

- URL для Meta: `https://<ваш-домен>/v1/intl/whatsapp`
- Подписка: `messages` (поле `messages` в WhatsApp → Configuration → Webhook).
- Meta сначала дергает `GET` с `hub.mode=subscribe&hub.verify_token=...&hub.challenge=...`
  — приложение отвечает `challenge` только при совпадении verify-token.
- Каждое событие `POST` проверяется по HMAC-SHA256 от **сырого тела** с `WHATSAPP_APP_SECRET`.
  Неверная подпись → `403`, тело не разбирается.
- Входящие принимаются **только в `CHANNEL_MODE=live`** (реальные люди = реальные данные).

## Требования к режиму

```
CHANNEL_MODE=live
ALLOW_SQLITE_LIVE=true        # для пилота; в проде — Postgres
REAL_DATA_ALLOWED=true
ALLOW_REAL_DATA=true
TELEGRAM_BOT_TOKEN=...        # нужен для входа в Mini App
TELEGRAM_ALLOWED_USER_IDS=... # ваш Telegram ID
```

Запуск: `npm start` (или `node engine/intlServer.js`). В Setup появится строка
«WhatsApp Cloud API configured»; пока не настроено — канал в интерфейсе отсутствует, и приложение
честно пишет, что WhatsApp доступен только в live.

## Проверка

1. Запустите сервер и приложение, откройте `GET /v1/intl/whatsapp?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=ping` — должен вернуться `ping`.
2. Напишите с телефона на подключённый номер: «Hi, can I view …». В Mini App появится заявка с каналом **WhatsApp**.
3. Соберите ответ и отправьте. В Meta → WhatsApp → API Setup видно исходящее сообщение.
4. Проверка 24-часового окна: ответьте через сутки — вернётся `window_closed`/`template_required`, это ожидаемо.

## Безопасность

- Токены только в `.env`, не в коде и не в архиве сборки.
- Логи не содержат тела сообщений и токенов.
- Подпись обязательна; без `WHATSAPP_APP_SECRET` в live режим не включается (вебхук вернёт 503).
- Вебхук отвечает `200` и не ретраится Meta'ой при дубликатах: дедупликация по `message.id`.

## Ограничения Meta, о которых нужно помнить брокеру

- 24-часовое окно на свободный текст; вне окна — только заранее одобренные шаблоны (пока не поддержаны).
- opt-in: клиент должен ожидать сообщения, иначе жалобы/блокировка номера.
- Лимиты отправки зависят от статуса номера (tier).
- Один Business-бот/номер — это операционный налог, как и с Telegram.

# Green API (green-api.com) — альтернативный провайдер

Green API — сторонний сервис, который подключает WhatsApp через протокол WhatsApp Web. Это **не** официальный
Meta Cloud API: аккаунт может получить ограничения. Для продакшена предпочтителен Cloud API; для быстрого
теста Green API удобен (не нужна верификация Business и шаблоны, но правила WhatsApp всё равно действуют).

## Переменные

```env
WHATSAPP_PROVIDER=green
GREENAPI_ID_INSTANCE=710722803004
GREENAPI_API_TOKEN=...
GREENAPI_WEBHOOK_TOKEN=<придумать>
# GREENAPI_API_URL=https://api.green-api.com
```

`GREENAPI_WEBHOOK_TOKEN` — общий секрет: он вставляется в URL вебхука, который вы задаёте в консоли Green API:
`https://<домен>/v1/intl/whatsapp?token=<GREENAPI_WEBHOOK_TOKEN>`.
Каждый POST проверяется по этому токену (у Green API нет подписи запроса).

## Настройка

1. В консоли Green API создайте инстанс и отсканируйте QR своим WhatsApp (**Linked devices**).
2. Скопируйте `idInstance` и `apiTokenInstance`.
3. В консоли Green API → Инстанс → Настройки → **Webhook URL** вставьте URL с токеном (см. выше),
   включите **incoming** webhook и выключите outgoing.
4. Заполните `.env` и перезапустите сервер в live-режиме.
5. Проверка: напишите с другого телефона на номер инстанса — заявка появится в Mini App с каналом WhatsApp.
   Ответ из Mini App уйдёт через `POST /waInstance{id}/sendMessage/{token}`.

## Ограничения Green API

- Только текст (медиа/голос не поддержаны).
- Сторонний протокол → риск ограничения номера; не для критичного бизнес-номера без теста.
- Нет шаблонов/24-часовой политики Meta, но спам-политика WhatsApp действует: не писать первым без повода.
- Группы игнорируются; direct-чаты только.