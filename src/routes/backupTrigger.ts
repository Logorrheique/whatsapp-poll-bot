import { Router, Request, Response } from "express";
import { createBackup, listBackups, getBackupBlob, restoreBackup, isBackupStoreReady } from "../backupStore";
import { addAuditLog } from "../db";
import { checkSecret } from "../utils";
import { config } from "../config";

const router = Router();

function checkBackupSecret(req: Request) {
  const provided = String(req.headers["x-backup-secret"] || req.body?.secret || "");
  // Runtime read idem groupsPublic (tests > config figé au boot).
  const expected = process.env.BACKUP_TRIGGER_SECRET || config.BACKUP_TRIGGER_SECRET;
  return checkSecret(provided, expected, "BACKUP_TRIGGER_SECRET");
}

// POST /api/backup-trigger — external-cron endpoint to trigger a backup.
// Designed to be called from GitHub Actions, cron-job.org, or similar.
// The dashboard has NO backup UI anymore — all backup operations go through
// this external surface gated by BACKUP_TRIGGER_SECRET.
router.post("/", async (req: Request, res: Response) => {
  const check = checkBackupSecret(req);
  if (!check.ok) {
    res.status(check.status).json({ error: check.error });
    return;
  }
  if (!isBackupStoreReady()) {
    res.status(503).json({ error: "Backup store (Postgres) non disponible" });
    return;
  }

  try {
    const rawLabel = String(req.body?.label || "auto-external");
    const label = rawLabel.replace(/[^\w\s-]/g, "").substring(0, 100);
    const result = await createBackup(label);
    addAuditLog("external-trigger", "backup_create", `id=${result.id} size=${result.size}`);
    res.json({ success: true, id: result.id, size: result.size, label });
  } catch (err: any) {
    console.error("Erreur backup trigger externe:", err);
    res.status(500).json({ error: err?.message || "Erreur création backup" });
  }
});

// GET /api/backup-trigger/list — list all existing backups (metadata only, no blob).
// Useful to find the ID of a specific backup before calling /restore.
router.get("/list", async (req: Request, res: Response) => {
  const check = checkBackupSecret(req);
  if (!check.ok) {
    res.status(check.status).json({ error: check.error });
    return;
  }
  if (!isBackupStoreReady()) {
    res.status(503).json({ error: "Backup store (Postgres) non disponible" });
    return;
  }
  try {
    const backups = await listBackups();
    res.json(backups);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Erreur listing backups" });
  }
});

// GET /api/backup-trigger/:id/download — download a specific backup .db file
router.get("/:id/download", async (req: Request, res: Response) => {
  const check = checkBackupSecret(req);
  if (!check.ok) {
    res.status(check.status).json({ error: check.error });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "ID invalide" });
    return;
  }
  if (!isBackupStoreReady()) {
    res.status(503).json({ error: "Backup store non disponible" });
    return;
  }
  try {
    const data = await getBackupBlob(id);
    if (!data) {
      res.status(404).json({ error: "Backup introuvable" });
      return;
    }
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="pollbot-backup-${id}.db"`);
    res.setHeader("Content-Length", data.length.toString());
    res.end(data);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Erreur download" });
  }
});

// POST /api/backup-trigger/:id/restore — restore a specific backup.
// DESTRUCTIVE: replaces the live SQLite DB and kills the process so Railway
// restarts it. Must be called deliberately with the shared secret.
router.post("/:id/restore", async (req: Request, res: Response) => {
  const check = checkBackupSecret(req);
  if (!check.ok) {
    res.status(check.status).json({ error: check.error });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "ID invalide" });
    return;
  }
  if (!isBackupStoreReady()) {
    res.status(503).json({ error: "Backup store non disponible" });
    return;
  }

  // Log audit BEFORE restore (restore closes the SQLite connection)
  try { addAuditLog("external-trigger", "backup_restore", `#${id}`); } catch (e) { console.error("audit log err:", e); }

  try {
    await restoreBackup(id);
    res.json({ success: true, message: "Restauration réussie, redémarrage..." });
    setTimeout(() => {
      console.log("👋 Exit pour redémarrage post-restauration (external trigger)");
      process.exit(1);
    }, 500);
  } catch (err: any) {
    console.error("Erreur restore externe:", err);
    res.status(500).json({ error: err?.message || "Erreur restauration" });
    // If the DB is already closed, force a restart
    setTimeout(() => {
      console.log("👋 Exit forcé après erreur restore externe");
      process.exit(1);
    }, 500);
  }
});

export default router;
