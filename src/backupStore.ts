import { Pool } from "pg";
import fs from "fs";
import path from "path";
import { createBackupSnapshot, getDbPath, closeDb } from "./db";
import { config } from "./config";

import { BACKUP_KEEP_LAST_N } from "./constants";

let pool: Pool | null = null;

export interface BackupRow {
  id: number;
  created_at: string;
  size_bytes: number;
  label: string | null;
}

export async function initBackupStore(): Promise<boolean> {
  if (!config.DATABASE_URL) {
    console.log("⚠️  DATABASE_URL non défini — backup Postgres désactivé");
    return false;
  }

  try {
    pool = new Pool({
      connectionString: config.DATABASE_URL,
      // Railway Postgres uses SSL with self-signed certs
      ssl: { rejectUnauthorized: false },
      max: 3,
      min: 0,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS backups (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        size_bytes INTEGER NOT NULL,
        label TEXT,
        data BYTEA NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_backups_created ON backups(created_at DESC);
    `);

    console.log("✅ Backup store Postgres initialisé");
    return true;
  } catch (err) {
    console.error("Erreur init backup store:", err);
    pool = null;
    return false;
  }
}

export function isBackupStoreReady(): boolean {
  return pool !== null;
}

export async function createBackup(label?: string): Promise<{ id: number; size: number }> {
  if (!pool) throw new Error("Backup store non initialisé");

  // Create a fresh SQLite snapshot via online backup API
  const snapPath = await createBackupSnapshot();
  const data = fs.readFileSync(snapPath);
  try {
    fs.unlinkSync(snapPath);
  } catch {}

  // Insert the blob in Postgres
  const result = await pool.query(
    "INSERT INTO backups (size_bytes, label, data) VALUES ($1, $2, $3) RETURNING id",
    [data.length, label || null, data]
  );

  // Cleanup: keep only the N most recent
  await pool.query(
    `DELETE FROM backups WHERE id NOT IN (
      SELECT id FROM backups ORDER BY created_at DESC LIMIT ${BACKUP_KEEP_LAST_N}
    )`
  );

  return { id: result.rows[0].id, size: data.length };
}

export async function listBackups(): Promise<BackupRow[]> {
  if (!pool) return [];
  const result = await pool.query(
    "SELECT id, created_at, size_bytes, label FROM backups ORDER BY created_at DESC"
  );
  return result.rows.map((r) => ({
    id: r.id,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    size_bytes: r.size_bytes,
    label: r.label,
  }));
}

export async function getBackupBlob(id: number): Promise<Buffer | null> {
  if (!pool) return null;
  const result = await pool.query("SELECT data FROM backups WHERE id = $1", [id]);
  if (result.rows.length === 0) return null;
  return result.rows[0].data;
}

export async function deleteBackup(id: number): Promise<boolean> {
  if (!pool) return false;
  const result = await pool.query("DELETE FROM backups WHERE id = $1", [id]);
  return (result.rowCount ?? 0) > 0;
}

// Restore a backup: write the blob over the live SQLite file, then exit
// (the process restarts via Railway's auto-restart)
export async function restoreBackup(id: number): Promise<void> {
  if (!pool) throw new Error("Backup store non initialisé");

  // Fetch the blob first (uses Postgres, not the SQLite DB)
  const data = await getBackupBlob(id);
  if (!data) throw new Error("Backup introuvable");

  const dbPath = getDbPath();
  const tmpPath = dbPath + ".restore-" + Date.now();

  // Write to a TEMP file first — DB is still alive at this point,
  // so if write fails we haven't damaged anything
  try {
    fs.writeFileSync(tmpPath, data);
  } catch (err) {
    throw new Error(
      `Ecriture du fichier temp échouée: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Now commit: close SQLite, rename temp over the live DB, clean WAL/SHM
  // From this point on, the DB is unusable — the process MUST restart
  closeDb();

  try {
    fs.renameSync(tmpPath, dbPath);
  } catch (err) {
    // Rename failed — try to clean up the temp file but the DB is already closed
    try { fs.unlinkSync(tmpPath); } catch {}
    throw new Error(
      `Rename failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Stale WAL/SHM files would corrupt the restored DB — remove them
  try { fs.unlinkSync(dbPath + "-wal"); } catch {}
  try { fs.unlinkSync(dbPath + "-shm"); } catch {}

  console.log(`♻️  Backup #${id} restauré, redémarrage du processus...`);
}
