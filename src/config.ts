// Configuration centralisée (issue #49).
//
// Avant ce module, `process.env.XXX` était lu dans 7 fichiers différents
// sans schéma ni typage ni fail-fast. Ici on parse une fois au boot, on
// expose un objet typé et figé. Tout nouveau fichier qui a besoin d'une
// variable d'env l'ajoute au schéma ET consomme `config.XXX`.
//
// Pas de zod pour ne pas ajouter de dépendance — la validation nécessaire
// est suffisamment simple pour tenir en TS pur. Si un champ required manque,
// on throw au boot (validateRequiredEnv de src/index.ts vérifie ensuite les
// contraintes fonctionnelles sur ADMIN_PHONES / PAIR_SECRET).
//
// ⚠️ EXCEPTIONS RUNTIME (issue #64) :
//
// 5 champs ne sont PAS lus depuis `config` dans leur code de référence
// mais via `readEnv()` helper ci-dessous, pour permettre aux tests qui
// mutent `process.env` entre suites de voir leur override. En prod ces
// valeurs sont figées au boot de toute façon — aucune différence de
// comportement entre `config.X` et `readEnv("X")`.
//
// Liste des exceptions :
//   - POLLS_DB_PATH         (src/db.ts — isolation DB par test)
//   - TIMEZONE              (src/db.ts, src/scheduler.ts)
//   - ADMIN_PHONES          (src/auth.ts — tests unitaires isAdmin)
//   - ALLOWED_PHONES        (src/auth.ts — tests seedFromEnv)
//   - VIEWER_PHONES         (src/auth.ts — tests seedFromEnv)
//   - PAIR_SECRET           (src/routes/groupsPublic.ts — tests QR gate)
//   - BACKUP_TRIGGER_SECRET (src/routes/backupTrigger.ts — tests gate)
//
// Règle pour contributeur : si tu ajoutes un champ dont les tests doivent
// pouvoir override la valeur sans redémarrer le process, lis via
// `readEnv("TON_CHAMP")` au lieu de `config.TON_CHAMP`. Sinon, préfère
// `config.TON_CHAMP` qui reste la voie canonique.

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return undefined;
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return fallback;
  return n;
}

function parseLogLevel(value: string | undefined): "debug" | "info" | "warn" | "error" {
  const v = (value || "").toLowerCase();
  if (v === "debug" || v === "info" || v === "warn" || v === "error") return v;
  return "info";
}

export interface AppConfig {
  readonly NODE_ENV: "development" | "production" | "test";
  readonly PORT: number;
  readonly TIMEZONE: string;
  readonly LOG_LEVEL: "debug" | "info" | "warn" | "error";

  readonly ADMIN_PHONES: string | undefined;
  readonly PAIR_SECRET: string | undefined;
  readonly BACKUP_TRIGGER_SECRET: string | undefined;

  readonly ALLOWED_PHONES: string | undefined;
  readonly VIEWER_PHONES: string | undefined;

  readonly POLLS_DB_PATH: string | undefined;
  readonly DATABASE_URL: string | undefined;
  readonly CORS_ORIGIN: string | undefined;

  readonly ALERT_WEBHOOK_URL: string | undefined;
  readonly ALERT_WEBHOOK_KIND: "discord" | "slack" | "generic";
}

function buildConfig(env: NodeJS.ProcessEnv): AppConfig {
  const nodeEnv = (env.NODE_ENV as AppConfig["NODE_ENV"]) || "development";
  const webhookKind = (env.ALERT_WEBHOOK_KIND || "").toLowerCase();
  return Object.freeze({
    NODE_ENV: nodeEnv === "production" || nodeEnv === "test" ? nodeEnv : "development",
    PORT: parsePort(env.PORT, 3000),
    TIMEZONE: env.TIMEZONE && env.TIMEZONE.trim() ? env.TIMEZONE.trim() : "Europe/Paris",
    LOG_LEVEL: parseLogLevel(env.LOG_LEVEL),

    ADMIN_PHONES: firstNonEmpty(env.ADMIN_PHONES, env.ADMIN_PHONE),
    PAIR_SECRET: firstNonEmpty(env.PAIR_SECRET),
    BACKUP_TRIGGER_SECRET: firstNonEmpty(env.BACKUP_TRIGGER_SECRET),

    ALLOWED_PHONES: firstNonEmpty(env.ALLOWED_PHONES),
    VIEWER_PHONES: firstNonEmpty(env.VIEWER_PHONES),

    POLLS_DB_PATH: firstNonEmpty(env.POLLS_DB_PATH),
    DATABASE_URL: firstNonEmpty(env.DATABASE_URL),
    CORS_ORIGIN: firstNonEmpty(env.CORS_ORIGIN),

    ALERT_WEBHOOK_URL: firstNonEmpty(env.ALERT_WEBHOOK_URL),
    ALERT_WEBHOOK_KIND:
      webhookKind === "discord" || webhookKind === "slack" ? webhookKind : "generic",
  });
}

export const config: AppConfig = buildConfig(process.env);

// Issue #64 : helper runtime pour les champs dont les tests doivent pouvoir
// override la valeur entre suites (cf commentaire d'en-tête). Fallback vers
// le config figé pour les cas où process.env n'a pas la clef.
export function readEnv(key: keyof NodeJS.ProcessEnv & string): string | undefined {
  const runtime = process.env[key];
  if (runtime !== undefined && runtime !== "") return runtime;
  const frozen = (config as unknown as Record<string, string | undefined>)[key];
  return frozen;
}
