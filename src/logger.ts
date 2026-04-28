// Logger structuré léger (issue #32).
//
// On n'ajoute PAS pino pour ne pas introduire de dépendance lourde ni
// de migration globale des 83 console.log — l'objectif ici est d'avoir
// un logger JSON correct, compatible Railway/Datadog/Loki, utilisable
// progressivement. Les console.log existants continuent de fonctionner
// (ils restent sur stdout), les nouveaux chemins critiques doivent
// passer par `log.*()`.
//
// Format : une ligne JSON par event, champs stables
//   { ts, level, component?, msg, ...extra }
// Niveau via LOG_LEVEL env (debug|info|warn|error), défaut info.

import { config } from "./config";

const LEVELS: Record<"debug" | "info" | "warn" | "error", number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const minLevel = LEVELS[config.LOG_LEVEL];

function emit(
  level: "debug" | "info" | "warn" | "error",
  extra: Record<string, unknown> | undefined,
  msg: string
): void {
  if (LEVELS[level] < minLevel) return;
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(extra || {}),
  };
  // Redaction défensive : si un appelant glisse un token Authorization,
  // on le masque avant serialisation.
  const redactKeys = ["authorization", "token", "password", "pair_secret"];
  for (const k of redactKeys) {
    if (k in line) line[k] = "[REDACTED]";
  }
  const serialized = JSON.stringify(line);
  if (level === "error" || level === "warn") {
    process.stderr.write(serialized + "\n");
  } else {
    process.stdout.write(serialized + "\n");
  }
}

export const log = {
  debug: (extra: Record<string, unknown> | string, msg?: string): void =>
    typeof extra === "string" ? emit("debug", undefined, extra) : emit("debug", extra, msg || ""),
  info: (extra: Record<string, unknown> | string, msg?: string): void =>
    typeof extra === "string" ? emit("info", undefined, extra) : emit("info", extra, msg || ""),
  warn: (extra: Record<string, unknown> | string, msg?: string): void =>
    typeof extra === "string" ? emit("warn", undefined, extra) : emit("warn", extra, msg || ""),
  error: (extra: Record<string, unknown> | string, msg?: string): void =>
    typeof extra === "string" ? emit("error", undefined, extra) : emit("error", extra, msg || ""),
};
