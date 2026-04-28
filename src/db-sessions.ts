// Sessions / whitelist / viewers / audit_logs (extrait de db.ts — issue #47).
//
// Regroupe les 4 domaines auth-adjacent qui partagent peu avec le reste de
// db.ts. Toutes les queries passent par des prepared statements, les
// signatures sont identiques à celles de db.ts avant extraction.

import { getDb } from "./db";

// --- Viewers (read-only role) ---

export function listViewers(): string[] {
  const rows = getDb().prepare("SELECT phone FROM viewers ORDER BY phone").all() as any[];
  return rows.map((r) => r.phone);
}

export function addViewer(phone: string): boolean {
  try {
    getDb().prepare("INSERT INTO viewers (phone) VALUES (?)").run(phone);
    return true;
  } catch {
    return false; // duplicate
  }
}

export function removeViewer(phone: string): boolean {
  const result = getDb().prepare("DELETE FROM viewers WHERE phone = ?").run(phone);
  return result.changes > 0;
}

export function isViewerInDb(phone: string): boolean {
  const row = getDb().prepare("SELECT 1 FROM viewers WHERE phone = ?").get(phone);
  return !!row;
}

// --- Allowed phones (whitelist for login) ---

export function listAllowedPhones(): string[] {
  const rows = getDb().prepare("SELECT phone FROM allowed_phones ORDER BY phone").all() as any[];
  return rows.map((r) => r.phone);
}

export function addAllowedPhone(phone: string): boolean {
  try {
    getDb().prepare("INSERT INTO allowed_phones (phone) VALUES (?)").run(phone);
    return true;
  } catch {
    return false;
  }
}

export function removeAllowedPhone(phone: string): boolean {
  const result = getDb().prepare("DELETE FROM allowed_phones WHERE phone = ?").run(phone);
  return result.changes > 0;
}

export function isPhoneInAllowedDb(phone: string): boolean {
  const row = getDb().prepare("SELECT 1 FROM allowed_phones WHERE phone = ?").get(phone);
  return !!row;
}

export function countAllowedPhones(): number {
  const row = getDb().prepare("SELECT COUNT(*) as c FROM allowed_phones").get() as { c: number };
  return row.c;
}

// --- Sessions dashboard ---

const MAX_SESSIONS_PER_PHONE = 3;

export function createSession(token: string, phone: string, role: string = "user"): void {
  const db = getDb();
  const count = db
    .prepare("SELECT COUNT(*) as c FROM sessions WHERE phone = ?")
    .get(phone) as { c: number };
  if (count.c >= MAX_SESSIONS_PER_PHONE) {
    db.prepare(
      "DELETE FROM sessions WHERE token = (SELECT token FROM sessions WHERE phone = ? ORDER BY created_at ASC LIMIT 1)"
    ).run(phone);
  }
  db.prepare("INSERT INTO sessions (token, phone, role) VALUES (?, ?, ?)").run(token, phone, role);
}

export function getSession(
  token: string
): { token: string; phone: string; role: string; created_at: string } | undefined {
  return getDb().prepare("SELECT * FROM sessions WHERE token = ?").get(token) as any;
}

export function deleteSession(token: string): void {
  getDb().prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function deleteExpiredSessions(maxAgeMs: number): void {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  getDb().prepare("DELETE FROM sessions WHERE created_at < ?").run(cutoff);
}

export function touchSession(token: string): void {
  getDb()
    .prepare("UPDATE sessions SET last_seen_at = datetime('now') WHERE token = ?")
    .run(token);
}

export function getOnlineUsers(
  withinMs: number = 5 * 60 * 1000
): { phone: string; role: string; last_seen_at: string }[] {
  const cutoff = new Date(Date.now() - withinMs).toISOString().replace("T", " ").substring(0, 19);
  return getDb()
    .prepare(
      `SELECT s.phone, s.role, s.last_seen_at
       FROM sessions s
       INNER JOIN (
         SELECT phone, MAX(last_seen_at) as max_seen
         FROM sessions
         WHERE last_seen_at >= ?
         GROUP BY phone
       ) latest ON latest.phone = s.phone AND latest.max_seen = s.last_seen_at
       ORDER BY s.last_seen_at DESC`
    )
    .all(cutoff) as any[];
}

// --- Audit logs ---

export function addAuditLog(phone: string, action: string, detail?: string): void {
  getDb()
    .prepare("INSERT INTO audit_logs (phone, action, detail) VALUES (?, ?, ?)")
    .run(phone, action, detail || null);
}

export function getAuditLogs(limit: number = 100): any[] {
  return getDb()
    .prepare("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?")
    .all(limit);
}
