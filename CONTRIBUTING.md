# Contributing to Poll Bot

Thanks for your interest! This guide covers everything you need to know to contribute.

## Before you start

- **Bugs**: open an issue with a minimal repro (steps, expected behavior, actual behavior, Node version, OS).
- **Features**: open an issue first to discuss the need before writing code — avoids PRs that don't fit the project's direction.
- **Vulnerabilities**: **do not open a public issue**. Follow [`SECURITY.md`](SECURITY.md).

## Local setup

```bash
git clone https://github.com/<your-fork>/whatsapp-poll-bot.git
cd whatsapp-poll-bot
npm install
cp .env.example .env
# edit .env (ADMIN_PHONES + PAIR_SECRET are enough)
npm run dev
```

## Git workflow

- Default branch: `master` (= production)
- Integration branch: `preproduction`
- **Open PRs against `preproduction`**, not `master`.
- Feature branches: `feat/<short-name>`; fixes: `fix/<short-name>`.

## Before submitting a PR

```bash
npx tsc --noEmit       # strict type check — MUST pass
npm test               # Vitest suite — MUST pass (~290 tests)
npm run test:coverage  # optional, to check for regressions
```

CI (`.github/workflows/test.yml`) re-runs these checks + the TypeScript build. A PR with red CI won't be merged.

## Conventions

### TypeScript code
- `tsconfig.json` is in `strict` mode — no `any` except when justified (mostly SQL parsers).
- Explicit types on exported functions.
- Prefer `import type { … }` for type-only imports.

### SQL
- **Always** use prepared statements (`db.prepare(…).run/get/all`).
- Never concatenate user input.
- Idempotent migrations in `migrate()` (`hasCol()` guard).

### Frontend (`public/index.html`)
- Vanilla JS, no framework, no build step.
- All DOM insertions go through `h()` (HTML escape).
- Use the `api()` wrapper instead of `fetch` directly (handles token + 401).
- `setBtnLoading(btn, true, "...")` for long-running actions.

### Commits
- Messages in English (preferred) or French — atomic and readable.
- Format: short subject (≤ 72 chars), detailed body if needed.
- No mandatory squash, but avoid "wip" or "fix typo" commits — rebase before the PR.

### Tests
- Every bug fix must come with a test that would have caught the bug.
- Any new code in `src/` must be covered by at least one test.
- Tests live in `tests/{unit,db,routes,scheduler,e2e,perf}/<module>.test.ts`.

## Architecture

High-level view in the README. For details:
- `src/index.ts` — bootstrap Express + WhatsApp + scheduler
- `src/whatsapp.ts` — Baileys engine (init, send, receive votes, lifecycle)
- `src/db.ts` — all SQLite queries (prepared)
- `src/routes/` — one file per functional domain
- `src/middleware/` — auth/admin/writer guards

## Questions?

Open a [GitHub Discussion](../../discussions) or comment on the relevant issue. No Discord/Slack channel — keeps things open and asynchronous.
