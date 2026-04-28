// Test helpers: spin up a fresh SQLite DB per test via POLLS_DB_PATH
// override (supported by src/db.ts since the test pipeline was added).
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import * as db from "../../src/db";

const tmpDir = path.join(os.tmpdir(), "pollbot-tests");

export function freshDbPath(): string {
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  return path.join(
    tmpDir,
    `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`
  );
}

// Open a fresh DB file and run initDb() against it. Closes any previous
// connection first. Returns the path to allow further manipulation.
export function makeTempDb(): string {
  try {
    db.closeDb();
  } catch {
    // pas encore ouvert
  }
  const p = freshDbPath();
  process.env.POLLS_DB_PATH = p;
  db.initDb();
  return p;
}

export function resetDb(): void {
  try {
    db.closeDb();
  } catch {
    // pas d'erreur
  }
  delete process.env.POLLS_DB_PATH;
}

// Open a second connection to the current test DB for low-level manipulation.
// Automatically closed by caller via .close().
export function rawConnection(): Database.Database {
  const p = process.env.POLLS_DB_PATH;
  if (!p) throw new Error("POLLS_DB_PATH non défini — appeler makeTempDb() d'abord");
  return new Database(p);
}

// Exécute un SQL arbitraire sur une connexion secondaire (pratique pour
// ageifier des lignes dans les tests de cleanup).
export function rawExec(sql: string): void {
  const raw = rawConnection();
  try {
    raw.exec(sql);
  } finally {
    raw.close();
  }
}
