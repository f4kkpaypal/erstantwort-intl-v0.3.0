# Приёмка ежедневного пилота (7 дней)

Не закрывается одним прогоном unit-тестов. Владелец ставит галочки на живом Telegram Business + always-on хосте ([`DAILY_PILOT.md`](DAILY_PILOT.md)).

## День 0 — до реальных клиентов

- [ ] Образ `Dockerfile.intl` (не `Dockerfile.free`)
- [ ] Postgres + `INTL_DATABASE_URL`; `npm run migrate:smoke` с URL → ok
- [ ] `HASH_SALT` / `ENGINE_TOKEN` / `TELEGRAM_WEBHOOK_SECRET` стабильны в env
- [ ] `CHANNEL_MODE=live`, `REAL_DATA_ALLOWED=true`, `ALLOW_REAL_DATA=true`
- [ ] `INTL_LIVE_AUTOSEND=false`, `INTL_AI_OPTIONS=false`, `INTL_WHATSAPP_UI=false`
- [ ] `MULTI_USER=true`, `TELEGRAM_ALLOWED_USER_IDS=*`
- [ ] `/healthz` → `ok postgres`; `/v1/health` → `channel_mode:live`, `webhook_url_set:true`
- [ ] Mini App Setup: webhook OK, Business connection ready
- [ ] `MULTI_USER=true` и `npm run smoke:team` → `team_smoke ok`
- [ ] Privacy / Impressum с реквизитами; AVV с маклером подписан (или письменный отказ зафиксирован)
- [ ] Внешний uptime на `/healthz`
- [ ] Cron `npm run ops:backup-intl`
- [ ] Коллега: invite → accept → shared inbox; revoke (см. [`TEAM_COLLEAGUE.md`](TEAM_COLLEAGUE.md))

## Дни 1–7 — must pass каждый день

| Проверка | Ожидание |
|---|---|
| Клиент пишет брокеру в личку | Заявка в Mini App без ПДн в логах |
| Брокер жмёт «Отправить» | Клиент получает ровно одно сообщение от имени брокера |
| Повтор той же кнопки | Нет дубля (idempotency) |
| Два клиента на один слот | Второй → `slot_unavailable` |
| Клиент пишет STOP | Автоматика off; хеш живёт после рестарта сервиса |
| `erase` по контакту | Карточка стёрта, STOP-хеш остаётся |
| Деплой / рестарт mid-day | Webhook снова ok (`AUTO_SET_WEBHOOK`); inbound не теряется |
| Утренний digest (если включён) | Считается по `BROKER_TZ`; без утечки имени/телефона в лог |
| Коллега (раз в пилот) | Invite → accept → видит leads; revoke → больше не видит ([`TEAM_COLLEAGUE.md`](TEAM_COLLEAGUE.md)) |

Отметьте дату каждого дня:

| День | Дата | Inbound ok | Send ok | Restart ok | Подпись |
|---|---|---|---|---|---|
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |
| 4 | | | | | |
| 5 | | | | | |
| 6 | | | | | |
| 7 | | | | | |

## Критерий «10/10 ежедневный»

Все строки дней 1–7 заполнены, юридика дня 0 закрыта, цена для маклера €0, ваш cost известен.  
Без 7-дневной таблицы пилот не считать принятым.
