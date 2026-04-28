# Poll Bot

> Self-hosted WhatsApp bot to schedule recurring polls across multiple groups, with a mobile-first web dashboard. ~80 MB RAM, no headless browser.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-22%2B-brightgreen)](package.json)
[![TypeScript](https://img.shields.io/badge/typescript-5.7-blue)](tsconfig.json)

## Features

- **Recurring polls** scheduled via cron (daily, weekdays, weekly, monthly, custom)
- **Multi-group**: one poll can target N groups in parallel
- **Real-time vote collection** via the WhatsApp Web protocol ([Baileys](https://github.com/WhiskeySockets/Baileys))
- **21-day history** with day-of-week filter
- **3 roles**: admin, user (poll creation), viewer (read-only)
- **Authentication** via 6-digit code sent over WhatsApp
- **Backup / restore** to PostgreSQL
- **Mobile-first dashboard** in vanilla JS, single HTML file, no build step

## Getting started

Two paths: **local development** (quick, for testing) or **production deployment** (Railway, Docker, or any Node host).

### Prerequisites

- **Node.js ≥ 22** (LTS recommended)
- A **phone with WhatsApp** whose account the bot will use (secondary account strongly recommended — NEVER use your personal account)
- (Optional) **PostgreSQL** locally to test backups in dev

### 1. Clone and install

```bash
git clone https://github.com/Logorrheique/whatsapp-poll-bot.git
cd whatsapp-poll-bot
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env` — at minimum:

```env
ADMIN_PHONES=33612345678          # your number, international format without the +
PAIR_SECRET=<24+ chars random>    # generate with: openssl rand -hex 24
```

All available env variables are documented in `.env.example`.

### 3. Run in dev mode

```bash
npm run dev    # tsx watch on src/index.ts, port 3000
```

Open http://localhost:3000.

### 4. Link the WhatsApp account

1. On the login page, choose **Admin mode**
2. Enter your `PAIR_SECRET`
3. A QR code is displayed
4. On the **bot's phone** (not yours): open WhatsApp → **Settings** → **Linked Devices** → **Link a Device**
5. Scan the QR with the camera
6. Connection established in 2-5s — the dashboard now asks for your number to authenticate you

> ⚠️ **First connection**: you need two devices — one to display the QR and another to scan it with WhatsApp.

### 5. Sign in to the dashboard

1. On the login page, enter your number (one listed in `ADMIN_PHONES`)
2. You'll receive a 6-digit code on WhatsApp from the bot's account
3. Enter the code → signed in

You can now create your first poll.

## Production deployment

### Railway (recommended — magic Docker auto-deploy)

1. **Fork this repo** on GitHub
2. On [Railway](https://railway.app/): *New Project* → *Deploy from GitHub*, pick your fork
3. Add a **PostgreSQL** service (Railway marketplace) — `DATABASE_URL` is auto-injected
4. Create a **Volume**: *Settings → Volumes → Add Volume*, mount path `/app/data`, size 1 GB
   - **Critical**: without a volume, the WhatsApp session and SQLite DB are wiped on every redeploy
5. Environment variables: `ADMIN_PHONES`, `PAIR_SECRET`, `NODE_ENV=production`
6. The first boot creates the SQLite DB and emits a QR — open the Railway URL and scan with the bot's phone

### Docker (anywhere)

```bash
docker build -t poll-bot .
docker run -d \
  -p 3000:3000 \
  -v /path/to/persistent/data:/app/data \
  -e ADMIN_PHONES=33612345678 \
  -e PAIR_SECRET=$(openssl rand -hex 24) \
  -e NODE_ENV=production \
  poll-bot
```

The `Dockerfile` (Node 22 slim) builds, then runs `node dist/index.js` with `--max-old-space-size=256` (matches Railway's RAM budget).

### Plain self-hosting

```bash
npm run build       # compile TypeScript → dist/
npm start           # run dist/index.js
```

Serve behind nginx/caddy with HTTPS in production (the bot redirects HTTP → HTTPS when `NODE_ENV=production`).

## Tech stack

| Layer | Tech |
|---|---|
| Runtime | Node.js 22 + TypeScript |
| Web | Express 4 + Helmet + express-rate-limit |
| WhatsApp | [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys) — pure WebSocket, no Chromium |
| Primary DB | SQLite via `better-sqlite3` (WAL mode) |
| Backup DB | PostgreSQL via `pg` |
| Scheduler | `node-cron` (timezone-aware) |
| Frontend | Vanilla HTML/CSS/JS, single file (no framework, no build) |
| Tests | Vitest — ~290 tests (unit, DB, HTTP routes, scheduler, e2e, perf) |

## Architecture

Three subsystems co-routined inside a single process:

1. **Express HTTP** (`src/index.ts`): public routes (auth, WhatsApp status), authenticated (polls, groups), admin (whitelist, viewers, backups). Helmet + CSP, rate limiting on `/api/auth/*`, `/api/wa/*`, and general endpoints.
2. **Baileys** (`src/whatsapp.ts`): WhatsApp Web WS init, `getMessage()` callback to decrypt votes, passive `pushName` capture to resolve voter names. 30s anti-stuck watchdog + escape hatch `POST /api/wa/reset-session`.
3. **node-cron** (`src/scheduler.ts`): reads active polls from SQLite, schedules sends in `Europe/Paris` (override with `TIMEZONE`).

Data:
- **SQLite** (`data/polls.db`, WAL): tables `polls`, `poll_sends`, `poll_votes`, `poll_message_map` (persistent message → poll mapping), `sessions`, `allowed_phones`, `viewers`, `audit_logs`. Idempotent migrations at boot.
- **PostgreSQL** (optional, via `DATABASE_URL`): `backups` table storing full SQLite snapshots as `BYTEA`.

## Tests

```bash
npm test                # full Vitest suite (~290 tests)
npm run test:unit       # unit tests only
npm run test:db         # DB tests only
npm run test:routes     # HTTP route tests
npm run test:scheduler  # scheduler tests
npm run test:coverage   # with coverage report
npx tsc --noEmit        # strict type check
```

GitHub Actions CI runs on push/PR: TypeScript build + 4 parallel test jobs.

## Known limitations

- **One linked WhatsApp account at a time** (WA Web protocol limitation)
- **Session lost after ~14 days** if the source phone never opens WhatsApp (Meta limit)
- **QR rotates every ~20s** during pairing (Meta limit)
- **Native WhatsApp polls only** — Meta's official Cloud API doesn't support native polls, so there's no managed alternative
- **No multi-tenant mode** — one deployment = one organization

## Security & responsibility

This project uses the unofficial WhatsApp Web protocol (Baileys), which technically violates Meta's ToS — like any third-party client (web, desktop). Practical risk: Meta may ban a WhatsApp account if it's detected as automated. To minimize risk:

- Use a **secondary** WhatsApp account dedicated to the bot
- Stay within normal sending volumes (≤ a few polls per group per day)
- Keep the bot's phone alive (open WhatsApp on it regularly)

To report a vulnerability in the code: see [`SECURITY.md`](SECURITY.md).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). In short: fork → branch → PR against `preproduction`. All tests must pass + `tsc --noEmit` clean.

## License

[MIT](LICENSE) — use, fork, modify, redistribute freely.
