# Intl pilot — paid Postgres host checklist

Free hosts that sleep are fine for a Loom showcase. A live Telegram Business pilot needs an always-on service plus Postgres. SQLite under `var/` is for local sim only.

## Must

1. **Paid compute** — Render Starter (or equivalent). Free Render sleeps; webhooks and the 60s digest/remind tick stop.
2. **Postgres in the same region** — set `INTL_DATABASE_URL` (or intl `DATABASE_URL` with a `postgres://` URL). Live boot refuses to start without it (`postgres_required` / `postgres_unavailable`).
3. **`CHANNEL_MODE=live`** only on the paid stack — keep `sim` until the day of the pilot. `test_live` is an alias of `live`.
4. **`INTL_LIVE_AUTOSEND=false`** (or unset) — broker approves every outbound reply.
5. **Secrets** — `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `HASH_SALT`, `TELEGRAM_ALLOWED_USER_IDS` (one broker id). Never commit them.
6. **`UI_PUBLIC_BASE=https://…`** — Mini App URL and notify deep-links. `DEMO_UI_NO_AUTH` must stay off when this is https (boot blocks it).
7. **Health** — `GET /healthz` → `ok postgres`. `GET /v1/health` → `channel_mode: live`, `live_autosend: false`, `demo_ui: false`.

## Schema

- Migrations live under `db/migrations/002_intl.sql` and `003_intl_numeric.sql`.
- `core/intl/storePg.js` opens the URL and applies the intl schema on boot. Empty DB is expected for a fresh pilot.

## Ops

- Brochure bytes stay on the service disk. Without a persistent disk set `EPHEMERAL_DISK=true` and accept that files reset on redeploy; lead rows in Postgres remain.
- Back up the Postgres instance from the host panel (daily is enough for a 1-broker pilot).
- Do not point a free showcase service at the same live DB.

## Related

- Owner steps: [`PILOT_SETUP.md`](../PILOT_SETUP.md)
- Render blueprint: `render.yaml` service `erstantwort-intl-pilot`
