// Tests routes non couvertes (issue #41) — whitelist, viewers, online,
// auth routes, groupsPublic, backupTrigger, stats.
// Les tests waAdmin et groups sont partiellement couverts : on se concentre
// sur les gates d'auth/permissions et les validations d'input.

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../src/whatsapp", () => ({
  initWhatsApp: vi.fn().mockResolvedValue(undefined),
  getClient: vi.fn().mockReturnValue({
    sendMessage: vi.fn().mockResolvedValue(undefined),
  }),
  getStatus: vi.fn().mockReturnValue({ ready: true, loading: false, qr_data_url: null }),
  requestPairingCode: vi.fn().mockResolvedValue("12345678"),
}));

vi.mock("node-cron", () => ({
  validate: vi.fn().mockReturnValue(true),
  schedule: vi.fn().mockReturnValue({
    stop: vi.fn(),
    destroy: vi.fn(),
    getNextRun: () => new Date(),
  }),
}));

vi.mock("../../src/backupStore", () => ({
  isBackupStoreReady: vi.fn().mockReturnValue(true),
  createBackup: vi.fn().mockResolvedValue({ id: 42, size: 1024 }),
  listBackups: vi.fn().mockResolvedValue([{ id: 42, created_at: "2026-04-16", size_bytes: 1024, label: "test" }]),
  getBackupBlob: vi.fn().mockResolvedValue(Buffer.from("fake-db-blob")),
  restoreBackup: vi.fn().mockResolvedValue(undefined),
}));

import { makeTempDb } from "../helpers/db";
import * as db from "../../src/db";
import whitelistRouter from "../../src/routes/whitelist";
import viewersRouter from "../../src/routes/viewers";
import onlineRouter from "../../src/routes/online";
import authRouter from "../../src/routes/auth";
import groupsPublicRouter from "../../src/routes/groupsPublic";
import backupTriggerRouter from "../../src/routes/backupTrigger";
import statsRouter from "../../src/routes/stats";
import { requireAuth } from "../../src/middleware/requireAuth";
import { requireAdmin } from "../../src/middleware/requireAdmin";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  app.use("/api/wa", groupsPublicRouter);
  app.use("/api/backup-trigger", backupTriggerRouter);
  app.use("/api/whitelist", requireAuth, requireAdmin, whitelistRouter);
  app.use("/api/viewers", requireAuth, requireAdmin, viewersRouter);
  app.use("/api/online", requireAuth, requireAdmin, onlineRouter);
  app.use("/api/stats", requireAuth, requireAdmin, statsRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

function mkToken(phone: string, role: "admin" | "viewer" | "user"): string {
  const tok = `t-${role}-${Math.random().toString(36).slice(2, 8)}`;
  db.createSession(tok, phone, role);
  return tok;
}

describe("routes/whitelist — auth gates et validations", () => {
  let app: express.Express;
  beforeEach(() => {
    process.env.ADMIN_PHONES = "33600000001";
    makeTempDb();
    app = buildApp();
  });

  it("401 sans token", async () => {
    const r = await request(app).get("/api/whitelist");
    expect(r.status).toBe(401);
  });

  it("403 pour un viewer", async () => {
    const tok = mkToken("33600000100", "viewer");
    const r = await request(app).get("/api/whitelist").set("Authorization", `Bearer ${tok}`);
    expect(r.status).toBe(403);
  });

  it("200 et liste pour un admin", async () => {
    db.addAllowedPhone("33600000500");
    const tok = mkToken("33600000001", "admin");
    const r = await request(app).get("/api/whitelist").set("Authorization", `Bearer ${tok}`);
    expect(r.status).toBe(200);
    expect(r.body).toContain("33600000500");
  });

  it("DELETE rejette format invalide", async () => {
    const tok = mkToken("33600000001", "admin");
    const r = await request(app)
      .delete("/api/whitelist/abc")
      .set("Authorization", `Bearer ${tok}`);
    expect(r.status).toBe(400);
  });

  it("DELETE refuse de retirer un admin", async () => {
    db.addAllowedPhone("33600000001");
    const tok = mkToken("33600000001", "admin");
    const r = await request(app)
      .delete("/api/whitelist/33600000001")
      .set("Authorization", `Bearer ${tok}`);
    expect(r.status).toBe(403);
  });

  it("DELETE 404 si numéro inexistant dans whitelist", async () => {
    const tok = mkToken("33600000001", "admin");
    const r = await request(app)
      .delete("/api/whitelist/33600000999")
      .set("Authorization", `Bearer ${tok}`);
    expect(r.status).toBe(404);
  });

  it("DELETE succès et retour liste mise à jour", async () => {
    db.addAllowedPhone("33600000500");
    const tok = mkToken("33600000001", "admin");
    const r = await request(app)
      .delete("/api/whitelist/33600000500")
      .set("Authorization", `Bearer ${tok}`);
    expect(r.status).toBe(200);
    expect(r.body.whitelist).not.toContain("33600000500");
  });
});

describe("routes/viewers — CRUD et gates", () => {
  let app: express.Express;
  beforeEach(() => {
    process.env.ADMIN_PHONES = "33600000001";
    makeTempDb();
    app = buildApp();
  });

  it("POST crée un viewer", async () => {
    const tok = mkToken("33600000001", "admin");
    const r = await request(app)
      .post("/api/viewers")
      .set("Authorization", `Bearer ${tok}`)
      .send({ phone: "33600000200" });
    expect(r.status).toBe(201);
    expect(r.body.viewers).toContain("33600000200");
  });

  it("POST rejette format invalide", async () => {
    const tok = mkToken("33600000001", "admin");
    const r = await request(app)
      .post("/api/viewers")
      .set("Authorization", `Bearer ${tok}`)
      .send({ phone: "abc" });
    expect(r.status).toBe(400);
  });

  it("POST 409 si déjà présent", async () => {
    const tok = mkToken("33600000001", "admin");
    db.addViewer("33600000200");
    const r = await request(app)
      .post("/api/viewers")
      .set("Authorization", `Bearer ${tok}`)
      .send({ phone: "33600000200" });
    expect(r.status).toBe(409);
  });

  it("DELETE retire un viewer", async () => {
    const tok = mkToken("33600000001", "admin");
    db.addViewer("33600000200");
    const r = await request(app)
      .delete("/api/viewers/33600000200")
      .set("Authorization", `Bearer ${tok}`);
    expect(r.status).toBe(200);
    expect(r.body.viewers).not.toContain("33600000200");
  });

  it("DELETE 404 si inconnu", async () => {
    const tok = mkToken("33600000001", "admin");
    const r = await request(app)
      .delete("/api/viewers/33600000999")
      .set("Authorization", `Bearer ${tok}`);
    expect(r.status).toBe(404);
  });

  it("non-admin bloqué 403", async () => {
    const tok = mkToken("33600000100", "viewer");
    const r = await request(app)
      .post("/api/viewers")
      .set("Authorization", `Bearer ${tok}`)
      .send({ phone: "33600000200" });
    expect(r.status).toBe(403);
  });
});

describe("routes/online — session actives admin only", () => {
  let app: express.Express;
  beforeEach(() => {
    process.env.ADMIN_PHONES = "33600000001";
    makeTempDb();
    app = buildApp();
  });

  it("retourne les sessions actives récentes", async () => {
    const tok = mkToken("33600000001", "admin");
    const r = await request(app).get("/api/online").set("Authorization", `Bearer ${tok}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    // on inclut au moins notre propre session
    expect(r.body.some((u: any) => u.phone === "33600000001")).toBe(true);
  });

  it("bloque un viewer", async () => {
    const tok = mkToken("33600000100", "viewer");
    const r = await request(app).get("/api/online").set("Authorization", `Bearer ${tok}`);
    expect(r.status).toBe(403);
  });
});

describe("routes/stats — admin only", () => {
  let app: express.Express;
  beforeEach(() => {
    process.env.ADMIN_PHONES = "33600000001";
    makeTempDb();
    app = buildApp();
  });

  it("retourne les compteurs sur DB fraîche", async () => {
    const tok = mkToken("33600000001", "admin");
    const r = await request(app).get("/api/stats").set("Authorization", `Bearer ${tok}`);
    expect(r.status).toBe(200);
    expect(r.body.polls_total).toBe(0);
    expect(r.body.polls_active).toBe(0);
    expect(r.body.votes_total_30d).toBe(0);
    expect(r.body.whitelist_total).toBe(0);
    expect(r.body.online_now).toBeGreaterThanOrEqual(1);
  });

  it("bloque non-admin", async () => {
    const tok = mkToken("33600000100", "viewer");
    const r = await request(app).get("/api/stats").set("Authorization", `Bearer ${tok}`);
    expect(r.status).toBe(403);
  });
});

describe("routes/auth — flow login/logout/me", () => {
  let app: express.Express;
  beforeEach(() => {
    process.env.ADMIN_PHONES = "33600000001";
    makeTempDb();
    app = buildApp();
  });

  it("POST /request-code 400 si phone invalide", async () => {
    const r = await request(app).post("/api/auth/request-code").send({ phone: "abc" });
    expect(r.status).toBe(400);
  });

  it("POST /verify 400 si phone/code manquant", async () => {
    const r = await request(app).post("/api/auth/verify").send({ phone: "33600000001" });
    expect(r.status).toBe(400);
  });

  it("POST /verify 401 si aucun code en attente", async () => {
    const r = await request(app)
      .post("/api/auth/verify")
      .send({ phone: "33600000001", code: "123456" });
    expect(r.status).toBe(401);
  });

  it("GET /me 401 sans token", async () => {
    const r = await request(app).get("/api/auth/me");
    expect(r.status).toBe(401);
  });

  it("GET /me retourne role admin", async () => {
    const tok = mkToken("33600000001", "admin");
    const r = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${tok}`);
    expect(r.status).toBe(200);
    expect(r.body.role).toBe("admin");
    expect(r.body.is_admin).toBe(true);
    expect(r.body.is_viewer).toBe(false);
  });

  it("POST /logout 200 et session détruite", async () => {
    const tok = mkToken("33600000001", "admin");
    const r = await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${tok}`);
    expect(r.status).toBe(200);
    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${tok}`);
    expect(me.status).toBe(401);
  });
});

describe("routes/groupsPublic — PAIR_SECRET gate", () => {
  let app: express.Express;
  const OLD_ENV = { ...process.env };
  beforeEach(() => {
    process.env = { ...OLD_ENV, PAIR_SECRET: "un_secret_long_de_au_moins_16_caracteres" };
    makeTempDb();
    app = buildApp();
  });

  it("GET /status est public", async () => {
    const r = await request(app).get("/api/wa/status");
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty("ready");
  });

  it("POST /qr 403 sans secret", async () => {
    const r = await request(app).post("/api/wa/qr").send({ secret: "mauvais" });
    expect(r.status).toBe(403);
  });

  it("POST /reset-session 403 sans secret", async () => {
    const r = await request(app)
      .post("/api/wa/reset-session")
      .send({ secret: "mauvais" });
    expect(r.status).toBe(403);
  });
});

describe("routes/backupTrigger — secret gate", () => {
  let app: express.Express;
  const OLD_ENV = { ...process.env };
  beforeEach(() => {
    process.env = { ...OLD_ENV, BACKUP_TRIGGER_SECRET: "backup-secret-at-least-16-chars" };
    makeTempDb();
    app = buildApp();
  });

  it("POST / 403 sans secret", async () => {
    const r = await request(app).post("/api/backup-trigger").send({});
    expect(r.status).toBe(403);
  });

  it("POST / 403 avec mauvais secret", async () => {
    const r = await request(app)
      .post("/api/backup-trigger")
      .set("x-backup-secret", "mauvais")
      .send({});
    expect(r.status).toBe(403);
  });

  it("GET /list 403 sans secret", async () => {
    const r = await request(app).get("/api/backup-trigger/list");
    expect(r.status).toBe(403);
  });

  it("GET /:id/download 400 sur ID non numérique", async () => {
    const r = await request(app)
      .get("/api/backup-trigger/abc/download")
      .set("x-backup-secret", "backup-secret-at-least-16-chars");
    expect(r.status).toBe(400);
  });

  it("POST /:id/restore 400 sur ID non numérique", async () => {
    const r = await request(app)
      .post("/api/backup-trigger/abc/restore")
      .set("x-backup-secret", "backup-secret-at-least-16-chars")
      .send({});
    expect(r.status).toBe(400);
  });
});
