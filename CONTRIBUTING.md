# Contribuer à Poll Bot

Merci de l'intérêt ! Ce guide couvre tout ce qu'il faut savoir pour contribuer.

## Avant de commencer

- **Bugs** : ouvre une issue avec un repro minimal (étapes, comportement attendu, comportement observé, version Node, OS).
- **Features** : ouvre d'abord une issue pour discuter du besoin avant d'écrire du code — ça évite les PR qui ne sont pas dans la direction du projet.
- **Vulnérabilités** : **n'ouvre pas d'issue publique**. Suis [`SECURITY.md`](SECURITY.md).

## Setup local

```bash
git clone https://github.com/<your-fork>/poll-bot.git
cd poll-bot
npm install
cp .env.example .env
# édite .env (ADMIN_PHONES + PAIR_SECRET suffisent)
npm run dev
```

## Workflow git

- Branche par défaut : `master` (= production)
- Branche d'intégration : `preproduction`
- **Ouvre les PR contre `preproduction`**, pas `master`.
- Branches de feature : `feat/<short-name>`, fixes : `fix/<short-name>`.

## Avant de soumettre une PR

```bash
npx tsc --noEmit       # type check strict — DOIT passer
npm test               # suite Vitest — DOIT passer (~290 tests)
npm run test:coverage  # optionnel, pour vérifier qu'on ne régresse pas
```

La CI (`.github/workflows/test.yml`) refait ces vérifications + build TypeScript. Une PR avec CI rouge ne sera pas mergée.

## Conventions

### Code TypeScript
- `tsconfig.json` est en mode `strict` — pas de `any` sauf cas justifié (parseurs SQL essentiellement).
- Types explicites sur les fonctions exportées.
- Prefer `import type { … }` pour les imports type-only.

### SQL
- **Toujours** des prepared statements (`db.prepare(…).run/get/all`).
- Jamais de concat avec input utilisateur.
- Migrations idempotentes dans `migrate()` (`hasCol()` guard).

### Frontend (`public/index.html`)
- Vanilla JS, pas de framework, pas de build step.
- Toute insertion DOM passe par `h()` (HTML escape).
- `api()` wrapper au lieu de `fetch` direct (gère token + 401).
- `setBtnLoading(btn, true, "...")` sur les actions longues.

### Commits
- Messages en français ou anglais, peu importe — lisibles, atomiques.
- Format : sujet court (≤ 72 chars), corps détaillé si nécessaire.
- Pas de squash imposé, mais évite les commits "wip" ou "fix typo" — rebase avant la PR.

### Tests
- Tout fix de bug doit être accompagné d'un test qui aurait attrapé le bug.
- Tout nouveau code dans `src/` doit être couvert par au moins un test.
- Tests dans `tests/{unit,db,routes,scheduler,e2e,perf}/<module>.test.ts`.

## Architecture

Vue d'ensemble dans le README. Pour le détail :
- `src/index.ts` — bootstrap Express + WhatsApp + scheduler
- `src/whatsapp.ts` — moteur Baileys (init, send, receive votes, lifecycle)
- `src/db.ts` — toutes les requêtes SQLite (prepared)
- `src/routes/` — un fichier par domaine fonctionnel
- `src/middleware/` — auth/admin/writer guards

## Questions ?

Ouvre une [Discussion GitHub](../../discussions) ou pingue sur l'issue concernée. Pas de canal Discord/Slack pour rester ouvert et asynchrone.
