# Politique de sécurité

## Versions supportées

Seule la branche `master` reçoit des correctifs de sécurité. Les forks sont responsables de leurs propres déploiements.

## Signaler une vulnérabilité

**N'ouvre pas d'issue GitHub publique pour une vulnérabilité.**

Utilise plutôt l'une de ces options :

- **GitHub Security Advisories** : onglet *Security* du repo → *Report a vulnerability*. Recommandé — le rapport reste privé tant que la fix n'est pas publiée.
- **Email** : si tu n'as pas de compte GitHub, contacte le mainteneur via les coordonnées affichées sur son profil.

## Délais

- **Accusé de réception** : sous 72h.
- **Triage** : sous 7 jours (sévérité, scope, faisabilité d'un fix).
- **Correctif** : variable selon la sévérité. Critique = au plus vite, en coordination avec toi sur la timeline de divulgation.

## Périmètre

Ce qui est dans le scope :
- Authentification / sessions (`src/auth.ts`, `src/middleware/`)
- Endpoints HTTP (toutes les routes `src/routes/`)
- Validation des inputs (`src/utils.ts`, `src/db.ts`)
- Gestion des secrets (`PAIR_SECRET`, `BACKUP_TRIGGER_SECRET`, tokens session)
- Stockage SQLite et backups Postgres
- Le frontend (XSS, CSP, auth flow)

Hors scope (mais tout signalement reste apprécié) :
- Vulnérabilités dans Baileys, Express, ou autres dépendances upstream — signale-les directement chez l'éditeur.
- Limitations connues du protocole WhatsApp Web (ex: session perdue après 14 jours, QR éphémère).
- Configurations utilisateur non-sécurisées (`PAIR_SECRET=changeme`, port exposé sans HTTPS, etc.) — c'est documenté.

## Reconnaissance

Toute personne signalant responsablement une vulnérabilité valide sera créditée dans le commit de fix et dans le CHANGELOG (si tu le souhaites).

## Hygiène recommandée pour les opérateurs

- `PAIR_SECRET` ≥ 24 caractères aléatoires
- `BACKUP_TRIGGER_SECRET` ≥ 24 caractères aléatoires si exposé
- HTTPS obligatoire en production (Railway le fournit par défaut)
- Volume Railway monté sur `/app/data` pour isoler les sessions
- Postgres sur service séparé (Railway le sépare par défaut)
- Audit `audit_logs` régulièrement (table SQLite — voir `docs/SECURITE.md` pour les requêtes)
