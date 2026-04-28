# Security policy

## Supported versions

Only the `master` branch receives security fixes. Forks are responsible for their own deployments.

## Reporting a vulnerability

**Do not open a public GitHub issue for a vulnerability.**

Use one of these options instead:

- **GitHub Security Advisories**: *Security* tab of the repo → *Report a vulnerability*. Recommended — the report stays private until the fix is published.
- **Email**: if you don't have a GitHub account, contact the maintainer via the address listed on their profile.

## Response times

- **Acknowledgement**: within 72 hours.
- **Triage**: within 7 days (severity, scope, feasibility of a fix).
- **Patch**: depends on severity. Critical = as fast as possible, coordinated with you on the disclosure timeline.

## Scope

In scope:
- Authentication / sessions (`src/auth.ts`, `src/middleware/`)
- HTTP endpoints (all routes under `src/routes/`)
- Input validation (`src/utils.ts`, `src/db.ts`)
- Secret handling (`PAIR_SECRET`, `BACKUP_TRIGGER_SECRET`, session tokens)
- SQLite storage and Postgres backups
- The frontend (XSS, CSP, auth flow)

Out of scope (but reports still appreciated):
- Vulnerabilities in Baileys, Express, or other upstream dependencies — report directly to the upstream maintainer.
- Known WhatsApp Web protocol limitations (e.g. session lost after 14 days, ephemeral QR).
- Insecure user configurations (`PAIR_SECRET=changeme`, port exposed without HTTPS, etc.) — these are documented.

## Recognition

Anyone who responsibly reports a valid vulnerability will be credited in the fix commit and in the CHANGELOG (if you want to be).

## Recommended operator hygiene

- `PAIR_SECRET` ≥ 24 random characters
- `BACKUP_TRIGGER_SECRET` ≥ 24 random characters if exposed
- HTTPS required in production (Railway provides it by default)
- Railway volume mounted on `/app/data` to isolate sessions
- Postgres on a separate service (Railway does this by default)
- Review the `audit_logs` SQLite table regularly
