// Shared utility functions — DRYs up code duplicated across modules.

import crypto from "crypto";

/**
 * Strip everything that isn't a digit from a phone string.
 * Shared by auth.ts, whitelist routes, viewer routes, etc.
 */
export function normalizePhone(phone: string): string {
  return String(phone || "").replace(/[^0-9]/g, "");
}

/**
 * Timing-safe comparison of a provided secret against an expected one.
 * Returns a discriminated union so callers can send the right HTTP status.
 */
export function checkSecret(
  provided: string,
  expected: string | undefined,
  label: string
): { ok: true } | { ok: false; status: number; error: string } {
  if (!expected || expected === "") {
    return { ok: false, status: 503, error: `${label} non configuré côté serveur` };
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, status: 403, error: "Secret invalide" };
  }
  return { ok: true };
}

/**
 * Validate a YYYY-MM-DD date string.
 */
export const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate a WhatsApp group ID (e.g. 120363...@g.us).
 */
export const GROUP_ID_REGEX = /^[0-9A-Za-z@._-]{1,100}$/;

/**
 * Extract caller phone from a Bearer token for audit logs.
 * Re-exported from auth.ts to break the circular dependency utils.ts ↔ auth.ts.
 */
export { getCallerPhone } from "./auth";

/**
 * Convert a local date string (YYYY-MM-DD) in the given IANA timezone to UTC
 * bounds formatted as SQLite datetime strings ("YYYY-MM-DD HH:MM:SS").
 *
 * Returns `[startInclusive, endExclusive]` so the caller can query with
 * `sent_at >= start AND sent_at < end`.
 *
 * This exists because SQLite's `datetime('now')` stores UTC timestamps but
 * users think in their local timezone. A naïve `BETWEEN 'YYYY-MM-DD 00:00:00'
 * AND 'YYYY-MM-DD 23:59:59'` against a UTC column miscategorizes sends made
 * near local midnight (e.g. 00:30 Paris = 22:30 UTC the previous day).
 *
 * Robust to DST because :
 * 1. On calcule l'offset local au jour demandé via Intl.DateTimeFormat
 * 2. endUtc = début du jour SUIVANT en local (pas start + 24h) — le jour de
 *    transition DST fait 23h ou 25h, pas 24h.
 */
export function localDateToUtcBoundsSqlite(
  localDateStr: string,
  timezone: string
): { startUtc: string; endUtc: string } {
  if (!DATE_REGEX.test(localDateStr)) {
    throw new Error(`localDateToUtcBoundsSqlite: invalid date ${localDateStr}`);
  }
  const nextDateStr = addOneDay(localDateStr);
  const startUtcMs = localMidnightToUtcMs(localDateStr, timezone);
  const endUtcMs = localMidnightToUtcMs(nextDateStr, timezone);
  const toSqliteStr = (ms: number): string =>
    new Date(ms).toISOString().replace("T", " ").substring(0, 19);
  return { startUtc: toSqliteStr(startUtcMs), endUtc: toSqliteStr(endUtcMs) };
}

function localMidnightToUtcMs(localDateStr: string, timezone: string): number {
  const [y, m, d] = localDateStr.split("-").map(Number);
  const asUtc = Date.UTC(y, m - 1, d, 0, 0, 0);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(asUtc));
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  const clockAsUtcMs = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") === 24 ? 0 : get("hour"),
    get("minute"),
    get("second")
  );
  const offsetMs = clockAsUtcMs - asUtc;
  return asUtc - offsetMs;
}

function addOneDay(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const yy = next.getUTCFullYear();
  const mm = String(next.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(next.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
