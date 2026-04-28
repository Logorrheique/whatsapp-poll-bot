// Routes /api/phrases — auth, validations, CRUD.

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../src/whatsapp", () => ({
  initWhatsApp: vi.fn().mockResolvedValue(undefined),
  getClient: vi.fn().mockReturnValue(null),
  getStatus: vi.fn().mockReturnValue({ ready: false }),
  removeMessageMappingsForPoll: vi.fn(),
}));

vi.mock("node-cron", () => ({
  validate: vi.fn().mockReturnValue(true),
  schedule: vi.fn().mockReturnValue({
    stop: vi.fn(),
    destroy: vi.fn(),
    getNextRun: () => new Date(),
  }),
}));

import { makeTempDb } from "../helpers/db";
import * as db from "../../src/db";
import phrasesRouter from "../../src/routes/phrases";
import { requireAuth } from "../../src/middleware/requireAuth";

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/phrases", requireAuth, phrasesRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

function mkToken(role: "admin" | "viewer" | "user" = "admin"): string {
  const tok = `t-${role}-${Math.random().toString(36).slice(2, 8)}`;
  db.createSession(tok, "33600000001", role);
  return tok;
}

describe("routes/phrases — CRUD basique", () => {
  let app: express.Express;
  let adminTok: string;
  beforeEach(() => {
    process.env.ADMIN_PHONES = "33600000001";
    makeTempDb();
    app = buildApp();
    adminTok = mkToken("admin");
  });

  it("GET /api/phrases vide", async () => {
    const r = await request(app).get("/api/phrases").set("Authorization", `Bearer ${adminTok}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });

  it("POST crée une phrase, GET la liste", async () => {
    const r = await request(app)
      .post("/api/phrases")
      .set("Authorization", `Bearer ${adminTok}`)
      .send({ category: "yes", text: "Présent !" });
    expect(r.status).toBe(201);
    expect(r.body.id).toBeGreaterThan(0);
    expect(r.body.category).toBe("yes");
    expect(r.body.text).toBe("Présent !");

    const list = await request(app)
      .get("/api/phrases?category=yes")
      .set("Authorization", `Bearer ${adminTok}`);
    expect(list.body).toHaveLength(1);
  });

  it("POST title avec training_day", async () => {
    const r = await request(app)
      .post("/api/phrases")
      .set("Authorization", `Bearer ${adminTok}`)
      .send({ category: "title", text: "Mardi entraînement", training_day: 2 });
    expect(r.status).toBe(201);
    expect(r.body.training_day).toBe(2);
  });

  it("POST training_day invalide → 400", async () => {
    const r = await request(app)
      .post("/api/phrases")
      .set("Authorization", `Bearer ${adminTok}`)
      .send({ category: "title", text: "X", training_day: 8 });
    expect(r.status).toBe(400);
  });

  it("POST text vide → 400", async () => {
    const r = await request(app)
      .post("/api/phrases")
      .set("Authorization", `Bearer ${adminTok}`)
      .send({ category: "yes", text: "   " });
    expect(r.status).toBe(400);
  });

  it("DELETE /api/phrases/:id", async () => {
    const created = await request(app)
      .post("/api/phrases")
      .set("Authorization", `Bearer ${adminTok}`)
      .send({ category: "no", text: "Non" });
    const id = created.body.id;

    const del = await request(app)
      .delete(`/api/phrases/${id}`)
      .set("Authorization", `Bearer ${adminTok}`);
    expect(del.status).toBe(200);

    const del2 = await request(app)
      .delete(`/api/phrases/${id}`)
      .set("Authorization", `Bearer ${adminTok}`);
    expect(del2.status).toBe(404);
  });

  it("DELETE sur ID non numérique → 400", async () => {
    const r = await request(app)
      .delete("/api/phrases/abc")
      .set("Authorization", `Bearer ${adminTok}`);
    expect(r.status).toBe(400);
  });

  it("DELETE /category/:cat purge toutes les phrases d'une catégorie", async () => {
    db.addPhrase({ category: "title", text: "Legacy 1" });
    db.addPhrase({ category: "title", text: "Legacy 2" });
    db.addPhrase({ category: "title", text: "Legacy 3" });
    db.addPhrase({ category: "yes", text: "Oui" }); // ne doit pas être touchée

    const r = await request(app)
      .delete("/api/phrases/category/title")
      .set("Authorization", `Bearer ${adminTok}`);
    expect(r.status).toBe(200);
    expect(r.body.deleted).toBe(3);
    expect(r.body.category).toBe("title");

    // 'yes' intacte
    expect(db.listPhrases("yes")).toHaveLength(1);
    expect(db.listPhrases("title")).toHaveLength(0);
  });

  it("DELETE /category/:cat sur catégorie vide → deleted=0", async () => {
    const r = await request(app)
      .delete("/api/phrases/category/title")
      .set("Authorization", `Bearer ${adminTok}`);
    expect(r.status).toBe(200);
    expect(r.body.deleted).toBe(0);
  });

  it("DELETE /category/:cat refusé pour viewer (writer requis)", async () => {
    const viewerTok = mkToken("viewer");
    const r = await request(app)
      .delete("/api/phrases/category/title")
      .set("Authorization", `Bearer ${viewerTok}`);
    expect(r.status).toBe(403);
  });

  it("DELETE /category/yes : refusé (catégorie REQUIRED non purgeable)", async () => {
    db.addPhrase({ category: "yes", text: "Oui" });
    db.addPhrase({ category: "yes", text: "Présent" });
    const r = await request(app)
      .delete("/api/phrases/category/yes")
      .set("Authorization", `Bearer ${adminTok}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/requise/);
    // Phrases intactes
    expect(db.listPhrases("yes")).toHaveLength(2);
  });

  it("DELETE /category/no et /quit : refusés également", async () => {
    db.addPhrase({ category: "no", text: "Non" });
    db.addPhrase({ category: "quit", text: "Quit" });
    const rNo = await request(app)
      .delete("/api/phrases/category/no")
      .set("Authorization", `Bearer ${adminTok}`);
    expect(rNo.status).toBe(400);
    const rQuit = await request(app)
      .delete("/api/phrases/category/quit")
      .set("Authorization", `Bearer ${adminTok}`);
    expect(rQuit.status).toBe(400);
    expect(db.listPhrases("no")).toHaveLength(1);
    expect(db.listPhrases("quit")).toHaveLength(1);
  });

  it("DELETE /category/injured : autorisé (optionnel, pas REQUIRED)", async () => {
    db.addPhrase({ category: "injured", text: "Blessé" });
    const r = await request(app)
      .delete("/api/phrases/category/injured")
      .set("Authorization", `Bearer ${adminTok}`);
    expect(r.status).toBe(200);
    expect(r.body.deleted).toBe(1);
  });

  it("GET /api/phrases/status reflète le state library", async () => {
    let r = await request(app)
      .get("/api/phrases/status")
      .set("Authorization", `Bearer ${adminTok}`);
    expect(r.status).toBe(200);
    expect(r.body.ready).toBe(false);
    // Issue #67 : 'title' n'est plus required (saisi librement par l'admin)
    expect(r.body.missing).toEqual(["yes", "no", "quit"]);

    db.addPhrase({ category: "yes", text: "Y" });
    db.addPhrase({ category: "no", text: "N" });
    db.addPhrase({ category: "quit", text: "Q" });

    r = await request(app)
      .get("/api/phrases/status")
      .set("Authorization", `Bearer ${adminTok}`);
    expect(r.body.ready).toBe(true);
    expect(r.body.missing).toEqual([]);
  });
});

describe("routes/phrases — auth gates", () => {
  let app: express.Express;
  beforeEach(() => {
    process.env.ADMIN_PHONES = "33600000001";
    makeTempDb();
    app = buildApp();
  });

  it("401 sans token", async () => {
    const r = await request(app).get("/api/phrases");
    expect(r.status).toBe(401);
  });

  it("viewer peut LIRE", async () => {
    const tok = mkToken("viewer");
    db.addPhrase({ category: "yes", text: "Y" });
    const r = await request(app).get("/api/phrases").set("Authorization", `Bearer ${tok}`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
  });

  it("viewer ne peut PAS écrire (POST → 403)", async () => {
    const tok = mkToken("viewer");
    const r = await request(app)
      .post("/api/phrases")
      .set("Authorization", `Bearer ${tok}`)
      .send({ category: "yes", text: "X" });
    expect(r.status).toBe(403);
  });

  it("viewer ne peut PAS supprimer (DELETE → 403)", async () => {
    const adminTok = mkToken("admin");
    const created = await request(app)
      .post("/api/phrases")
      .set("Authorization", `Bearer ${adminTok}`)
      .send({ category: "yes", text: "X" });
    const viewerTok = mkToken("viewer");
    const r = await request(app)
      .delete(`/api/phrases/${created.body.id}`)
      .set("Authorization", `Bearer ${viewerTok}`);
    expect(r.status).toBe(403);
  });
});
