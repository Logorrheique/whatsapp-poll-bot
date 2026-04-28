import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import path from "path";
import { initDb, backupDb, cleanupOldSends, cleanupOldAuditLogs, closeDb } from "./db";
import { seedFromEnv } from "./auth";
import { initBackupStore, isBackupStoreReady } from "./backupStore";
import { initWhatsApp, getStatus as getWaStatus, disconnectClient, reloadMessageMap } from "./whatsapp";
import { initScheduler, stopScheduler } from "./scheduler";
import pollRoutes from "./routes/polls";
import groupRoutes from "./routes/groups";
import groupsPublicRoutes from "./routes/groupsPublic";
import authRoutes from "./routes/auth";
import whitelistRoutes from "./routes/whitelist";
import viewersRoutes from "./routes/viewers";
import onlineRoutes from "./routes/online";
import backupTriggerRoutes from "./routes/backupTrigger";
import waAdminRoutes from "./routes/waAdmin";
import statsRoutes from "./routes/stats";
import phrasesRoutes from "./routes/phrases";
import { requireAuth } from "./middleware/requireAuth";
import { requireAdmin } from "./middleware/requireAdmin";
import { version } from "../package.json";
import {
  AUTH_RATE_WINDOW, AUTH_RATE_MAX,
  API_RATE_WINDOW, API_RATE_MAX,
  QR_RATE_WINDOW, QR_RATE_MAX,
  DB_BACKUP_INTERVAL, OLD_SENDS_CLEANUP_INTERVAL,
  DEFAULT_DAYS_KEPT, AUDIT_LOGS_DAYS_KEPT,
} from "./constants";
import { config } from "./config";
import { alert } from "./alerter";

const PORT = config.PORT;

// Fail-fast: si les secrets obligatoires manquent, crash avant que le service
// ne soit exposé (issue #34). Sinon un deploy Railway sans config part avec
// un bot whitelist-vide + un PAIR_SECRET indéfini et personne ne remarque.
function validateRequiredEnv(): void {
  const missing: string[] = [];
  if (!config.ADMIN_PHONES) missing.push("ADMIN_PHONES");
  const pairSecret = config.PAIR_SECRET;
  if (!pairSecret || pairSecret.length < 16 || pairSecret === "changeme_generer_un_vrai_secret") {
    missing.push("PAIR_SECRET (absent, <16 chars, ou valeur par défaut)");
  }
  if (missing.length > 0) {
    console.error(`❌ Boot annulé — variables d'env manquantes/invalides: ${missing.join(", ")}`);
    process.exit(1);
  }
}

async function main() {
  console.log(`🚀 Démarrage du WhatsApp Poll Bot v${version}...\n`);

  validateRequiredEnv();

  // 1. Initialize database
  initDb();
  console.log("💾 Base de données initialisée");

  // 1b. Seed from env vars (only fills DB tables if empty)
  seedFromEnv();

  // 1c. Init Postgres backup store (optional, requires DATABASE_URL)
  await initBackupStore();

  // 2. Setup Express
  const app = express();

  // Trust proxy (Railway, etc.)
  app.set("trust proxy", 1);

  // Probes Railway / orchestrateur — déclarées AVANT tout middleware pour
  // qu'aucune couche (HTTPS redirect, helmet, rate-limit, CSP) ne puisse
  // renvoyer autre chose que 200 sur /health. Issue spécifique Railway : le
  // healthcheck interne n'envoie pas `x-forwarded-proto: https`, donc le
  // redirect HTTPS en prod renvoyait 301 → Railway compte "unavailable".
  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));
  app.get("/ready", (_req, res) => {
    const wa = getWaStatus();
    const dbOk = true;
    const ready = wa.ready && dbOk;
    res.status(ready ? 200 : 503).json({
      ready,
      wa_ready: wa.ready,
      wa_loading: wa.loading,
      db_ok: dbOk,
    });
  });

  // Compression gzip/brotli — issue #35. Gros gain sur les réponses JSON du
  // dashboard mobile (listes de sondages / historique 21j font facilement
  // 50-200 kB non compressés).
  app.use(compression());

  // Security headers
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          scriptSrcAttr: ["'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
        },
      },
    })
  );

  // Explicit minimal Permissions-Policy to silence Chrome's default-feature warnings
  // (origin trials, attribution reporting, etc. — all disabled for this app)
  app.use((_req, res, next) => {
    res.setHeader(
      "Permissions-Policy",
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()"
    );
    next();
  });

  // HTTPS redirect in production
  app.use((req, res, next) => {
    if (
      config.NODE_ENV === "production" &&
      req.headers["x-forwarded-proto"] !== "https"
    ) {
      return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    next();
  });

  // CORS — restrict to own origin in production
  const corsOrigin: boolean | string =
    config.CORS_ORIGIN || (config.NODE_ENV === "production" ? false : true);
  app.use(cors({ origin: corsOrigin }));

  app.use(express.json({ limit: "64kb" }));
  app.use(
    express.static(path.join(__dirname, "..", "public"), {
      maxAge: "1h",
      etag: true,
      lastModified: true,
    })
  );

  // Rate limiters
  const authLimiter = rateLimit({
    windowMs: AUTH_RATE_WINDOW,
    max: AUTH_RATE_MAX,
    message: { error: "Trop de tentatives, réessayez dans 15 minutes" },
    standardHeaders: true,
    legacyHeaders: false,
  });

  const apiLimiter = rateLimit({
    windowMs: API_RATE_WINDOW,
    max: API_RATE_MAX,
    message: { error: "Trop de requêtes, ralentissez" },
    standardHeaders: true,
    legacyHeaders: false,
  });

  const qrLimiter = rateLimit({
    windowMs: QR_RATE_WINDOW,
    max: QR_RATE_MAX,
    message: { error: "Trop de tentatives, réessayez plus tard" },
    standardHeaders: true,
    legacyHeaders: false,
  });

  // /health et /ready sont déclarés en haut du fichier (avant le redirect
  // HTTPS + middlewares) pour que Railway et Docker HEALTHCHECK puissent
  // les atteindre en HTTP pur.

  // Lightweight session ping — MUST be declared before the /api/auth mount
  // so it bypasses authLimiter (otherwise the 15s frontend polling saturates
  // the auth rate limit and locks users out of login). Fixes #12.
  app.get("/api/auth/check", apiLimiter, requireAuth, (_req, res) => res.json({ ok: true }));

  // Public routes
  app.use("/api/auth", authLimiter, authRoutes);
  app.post("/api/wa/qr", qrLimiter); // mount limiter before router
  app.use("/api/wa", groupsPublicRoutes);
  // External-cron backup trigger (gated by BACKUP_TRIGGER_SECRET, no admin session needed)
  app.use("/api/backup-trigger", backupTriggerRoutes);

  // Protected routes (lightweight)
  app.get("/api/version", requireAuth, (_req, res) => res.json({ version }));

  app.use("/api/groups", requireAuth, apiLimiter, groupRoutes);
  app.use("/api/polls", requireAuth, apiLimiter, pollRoutes);
  app.use("/api/whitelist", requireAuth, requireAdmin, whitelistRoutes);
  app.use("/api/viewers", requireAuth, requireAdmin, viewersRoutes);
  app.use("/api/online", requireAuth, requireAdmin, onlineRoutes);
  app.use("/api/wa-admin", requireAuth, requireAdmin, waAdminRoutes);
  app.use("/api/stats", requireAuth, requireAdmin, statsRoutes);
  app.use("/api/phrases", requireAuth, apiLimiter, phrasesRoutes);

  // SPA fallback
  app.get("*", (_req, res) => {
    res.sendFile(path.join(__dirname, "..", "public", "index.html"));
  });

  // 3. Start server
  const server = app.listen(PORT, () => {
    console.log(`🌐 Serveur web: http://localhost:${PORT}`);
  });

  // Shutdown gracieux — issue #30. Railway envoie SIGTERM avant de killer le
  // container : sans ce handler on perd les requêtes en vol et la session
  // Baileys ne ferme pas proprement son WebSocket vers WhatsApp.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n🛑 ${signal} reçu — shutdown gracieux...`);
    const forceExit = setTimeout(() => {
      console.error("⏰ Shutdown trop long — exit forcé");
      process.exit(1);
    }, 10_000);
    forceExit.unref();
    try {
      stopScheduler();
      server.close();
      try {
        await disconnectClient();
      } catch { /* client peut ne pas être prêt */ }
      closeDb();
      console.log("✅ Shutdown propre");
      process.exit(0);
    } catch (err) {
      console.error("Erreur pendant shutdown:", err);
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // 4. Initialize WhatsApp
  console.log("\n📱 Connexion à WhatsApp...");
  await initWhatsApp();

  // 5. Start scheduler
  initScheduler();

  // 6. Periodic DB backup
  setInterval(() => {
    backupDb();
    console.log("💾 Backup DB effectué");
  }, DB_BACKUP_INTERVAL);

  // 7. Periodic cleanup of old sends
  setInterval(() => {
    const deleted = cleanupOldSends(DEFAULT_DAYS_KEPT);
    if (deleted > 0) {
      console.log(`🗑️ ${deleted} anciens envois supprimés`);
      // CASCADE a déjà nettoyé poll_message_map en DB ; resync la Map RAM
      // pour que pollMessageMap ne grossisse pas indéfiniment.
      reloadMessageMap();
    }
  }, OLD_SENDS_CLEANUP_INTERVAL);

  // 7b. Periodic cleanup of old audit_logs — issue #38. Sans purge la table
  // croît indéfiniment (chaque login/action y écrit une ligne).
  setInterval(() => {
    const deleted = cleanupOldAuditLogs(AUDIT_LOGS_DAYS_KEPT);
    if (deleted > 0) console.log(`🗑️ ${deleted} audit_logs purgés (> ${AUDIT_LOGS_DAYS_KEPT}j)`);
  }, OLD_SENDS_CLEANUP_INTERVAL);
  if (isBackupStoreReady()) {
    console.log("☁️  Backup store Postgres prêt — déclenchement externe via POST /api/backup-trigger");
  }

  console.log("\n✅ Bot prêt !");
}

main().catch((err) => {
  console.error("Erreur fatale:", err);
  // Issue #33 : alerte au boot-fail pour qu'un crash au démarrage soit
  // visible hors Railway logs. Best-effort : si l'alerte elle-même échoue
  // on exit quand même.
  void alert("critical", "Service crash au boot", (err as Error)?.stack || String(err)).finally(() => {
    process.exit(1);
  });
});
