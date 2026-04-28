# Poll Bot

> Bot WhatsApp pour programmer des sondages récurrents dans plusieurs groupes, avec un dashboard web mobile-first. Auto-hébergeable, ~80 Mo RAM, pas de browser headless.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-22%2B-brightgreen)](package.json)
[![TypeScript](https://img.shields.io/badge/typescript-5.7-blue)](tsconfig.json)

## Fonctionnalités

- **Sondages récurrents** programmés via cron (quotidien, jours ouvrés, hebdo, mensuel, custom)
- **Multi-groupes** : un sondage peut viser N groupes en parallèle
- **Collecte des votes en temps réel** via le protocole WhatsApp Web ([Baileys](https://github.com/WhiskeySockets/Baileys))
- **Historique 21 jours** avec filtre par jour de la semaine
- **3 rôles** : admin, utilisateur (création de sondages), observateur (lecture seule)
- **Authentification** par code 6 chiffres envoyé sur WhatsApp
- **Backup / restore** dans PostgreSQL
- **Dashboard mobile-first** vanilla JS, fichier HTML unique, pas de build step

## Mise en place

Deux chemins : **développement local** (rapide, pour tester) ou **déploiement production** (Railway, Docker, ou n'importe quel hébergeur Node).

### Prérequis

- **Node.js ≥ 22** (LTS recommandé)
- Un **téléphone avec WhatsApp** dont le compte sera utilisé par le bot (compte secondaire fortement recommandé — ne JAMAIS utiliser ton compte perso)
- (Optionnel) **PostgreSQL** local pour tester les backups en dev

### 1. Cloner et installer

```bash
git clone https://github.com/Logorrheique/whatsapp-poll-bot.git
cd whatsapp-poll-bot
npm install
```

### 2. Configurer

```bash
cp .env.example .env
```

Édite `.env` — au minimum :

```env
ADMIN_PHONES=33612345678          # ton numéro, format international sans le +
PAIR_SECRET=<24+ chars random>    # génère avec : openssl rand -hex 24
```

Toutes les variables d'env disponibles sont documentées dans `.env.example`.

### 3. Lancer en dev

```bash
npm run dev    # tsx watch sur src/index.ts, port 3000
```

Ouvre http://localhost:3000.

### 4. Lier le compte WhatsApp

1. Sur la page de login, choisis **Mode Admin**
2. Entre ton `PAIR_SECRET`
3. Un QR code s'affiche
4. Sur le **téléphone du bot** (pas le tien) : ouvre WhatsApp → **Paramètres** → **Appareils liés** → **Lier un appareil**
5. Scanne le QR avec la caméra
6. Connexion établie en 2-5s — le dashboard te demande maintenant ton numéro pour t'authentifier

> ⚠️ **Première connexion** : il te faut deux appareils — un pour afficher ce QR et un autre pour scanner avec WhatsApp.

### 5. Te connecter au dashboard

1. Sur la page de login, entre ton numéro (celui de `ADMIN_PHONES`)
2. Tu reçois un code 6 chiffres sur WhatsApp depuis le compte du bot
3. Entre le code → connecté

Tu peux maintenant créer ton premier sondage.

## Déploiement production

### Railway (recommandé — déploiement Docker auto-magique)

1. **Fork ce repo** sur GitHub
2. Sur [Railway](https://railway.app/) : *New Project* → *Deploy from GitHub*, sélectionne ton fork
3. Ajoute un service **PostgreSQL** (marketplace Railway) — `DATABASE_URL` sera auto-injectée
4. Crée un **Volume** : *Settings → Volumes → Add Volume*, mount path `/app/data`, taille 1 GB
   - **Critique** : sans volume, la session WhatsApp et la DB SQLite sont perdues à chaque redeploy
5. Variables d'environnement : `ADMIN_PHONES`, `PAIR_SECRET`, `NODE_ENV=production`
6. Le premier boot crée la DB SQLite et émet un QR — ouvre l'URL Railway et scanne avec ton téléphone bot

### Docker (n'importe où)

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

Le `Dockerfile` (Node 22 slim) build, puis lance `node dist/index.js` avec `--max-old-space-size=256` (réserve la RAM Railway).

### Auto-hébergement classique

```bash
npm run build       # compile TypeScript → dist/
npm start           # lance dist/index.js
```

Sers derrière nginx/caddy en HTTPS pour la prod (le bot redirect HTTP → HTTPS si `NODE_ENV=production`).

## Stack technique

| Couche | Techno |
|---|---|
| Runtime | Node.js 22 + TypeScript |
| Web | Express 4 + Helmet + express-rate-limit |
| WhatsApp | [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys) — WebSocket pur, pas de Chromium |
| DB primaire | SQLite via `better-sqlite3` (WAL mode) |
| DB backups | PostgreSQL via `pg` |
| Scheduler | `node-cron` (timezone-aware) |
| Frontend | HTML/CSS/JS vanilla, fichier unique (pas de framework, pas de build) |
| Tests | Vitest — ~290 tests (unit, DB, routes HTTP, scheduler, e2e, perf) |

## Architecture

Trois subsystèmes co-routinés dans un seul process :

1. **Express HTTP** (`src/index.ts`) : routes publiques (auth, status WhatsApp), authentifiées (sondages, groupes), admin (whitelist, observateurs, backups). Helmet + CSP, rate limiting sur `/api/auth/*`, `/api/wa/*`, et endpoints généraux.
2. **Baileys** (`src/whatsapp.ts`) : init WS WhatsApp Web, callback `getMessage()` pour décrypter les votes, capture passive des `pushName` pour résoudre les noms de votants. Watchdog 30s anti-blocage + soupape `POST /api/wa/reset-session`.
3. **node-cron** (`src/scheduler.ts`) : lit les sondages actifs depuis SQLite, programme leur envoi en `Europe/Paris` (override avec `TIMEZONE`).

Données :
- **SQLite** (`data/polls.db`, WAL) : tables `polls`, `poll_sends`, `poll_votes`, `poll_message_map` (mapping persistant message → sondage), `sessions`, `allowed_phones`, `viewers`, `audit_logs`. Migrations idempotentes au boot.
- **PostgreSQL** (optionnel, via `DATABASE_URL`) : table `backups` qui stocke des snapshots SQLite complets en `BYTEA`.

## Tests

```bash
npm test                # Suite Vitest complète (~290 tests)
npm run test:unit       # Unit tests seulement
npm run test:db         # Tests DB seulement
npm run test:routes     # Tests routes HTTP
npm run test:scheduler  # Tests scheduler
npm run test:coverage   # Avec rapport de couverture
npx tsc --noEmit        # Type check strict
```

CI GitHub Actions sur push/PR : build TypeScript + 4 jobs de tests parallèles.

## Limitations connues

- **Un seul compte WhatsApp lié** à la fois (limitation du protocole WA Web)
- **Session perdue après ~14 jours** si le téléphone source n'ouvre pas WhatsApp (limite Meta)
- **QR change toutes les ~20s** pendant le pairing (limite Meta)
- **Sondages natifs WhatsApp uniquement** — la Cloud API officielle Meta ne supporte pas les sondages natifs, donc pas d'alternative managée
- **Pas de mode multi-tenant** — un déploiement = une organisation

## Sécurité & responsabilité

Ce projet utilise le protocole WhatsApp Web non-officiel (Baileys), ce qui techniquement viole les ToS de Meta — comme tout client tiers (web, desktop). Risque pratique : un compte WhatsApp peut être banni par Meta s'il est détecté comme automatisé. Pour minimiser le risque :

- Utilise un compte WhatsApp **secondaire** dédié au bot
- Ne dépasse pas un volume normal d'envois (≤ quelques sondages par groupe par jour)
- Garde le téléphone du bot vivant (ouvre WhatsApp dessus régulièrement)

Pour signaler une vulnérabilité dans le code : voir [`SECURITY.md`](SECURITY.md).

## Contribuer

Voir [`CONTRIBUTING.md`](CONTRIBUTING.md). En bref : fork → branche → PR vers `preproduction`. Tous les tests doivent passer + `tsc --noEmit` clean.

## Licence

[MIT](LICENSE) — utilise, fork, modifie, redistribue librement.
