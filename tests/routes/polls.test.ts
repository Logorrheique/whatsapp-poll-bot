import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

// Mocker whatsapp.ts AVANT les imports qui l'utilisent (scheduler, routes)
vi.mock("../../src/whatsapp", () => ({
  initWhatsApp: vi.fn().mockResolvedValue(undefined),
  sendPollToGroups: vi.fn().mockResolvedValue(undefined),
  refreshAllVoterNames: vi.fn().mockResolvedValue({ refreshed: 0 }),
  getClient: vi.fn().mockReturnValue(null),
  getStatus: vi.fn().mockReturnValue({ ready: false }),
  // Issue #60 : pollService.deleteAndUnschedulePoll purge la Map RAM via
  // removeMessageMappingsForPoll → doit être exposé par le mock sinon
  // l'appel throw "is not a function".
  removeMessageMappingsForPoll: vi.fn(),
  // Port Baileys : nouveaux wrappers utilisés par auth.ts et index.ts.
  sendDirectMessage: vi.fn().mockResolvedValue(undefined),
  disconnectClient: vi.fn().mockResolvedValue(undefined),
  reloadMessageMap: vi.fn(),
}));

// Mocker node-cron pour éviter l'enregistrement de tasks pendant les tests
vi.mock("node-cron", () => ({
  validate: vi.fn().mockReturnValue(true),
  schedule: vi.fn().mockReturnValue({
    stop: vi.fn(),
    getNextRun: () => new Date(),
  }),
}));

import { makeTempDb, rawExec } from "../helpers/db";
import * as db from "../../src/db";
import * as whatsapp from "../../src/whatsapp";
import pollsRouter from "../../src/routes/polls";
import { requireAuth } from "../../src/middleware/requireAuth";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/polls", requireAuth, pollsRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    console.error("[TEST ERROR HANDLER]", err.message, err.stack);
    res.status(500).json({ error: err.message, stack: err.stack });
  });
  return app;
}

function seedAdminSession(): string {
  const token = "test-admin-token-" + Date.now();
  db.createSession(token, "33600000001", "admin");
  return token;
}

function seedViewerSession(): string {
  const token = "test-viewer-token-" + Date.now();
  db.createSession(token, "33600000002", "viewer");
  return token;
}

describe("routes/polls — CRUD avec training_day et display_title", () => {
  let app: express.Express;
  let adminToken: string;

  beforeEach(() => {
    makeTempDb();
    app = buildApp();
    adminToken = seedAdminSession();
  });

  it("POST /api/polls crée un poll avec training_day et renvoie display_title", async () => {
    const res = await request(app)
      .post("/api/polls")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        question: "",
        options: ["Oui", "Non"],
        cron_expression: "0 9 * * 2",
        group_ids: ["g1@g.us"],
        training_day: 2,
      });
    expect(res.status).toBe(201);
    expect(res.body.training_day).toBe(2);
    expect(res.body.question).toBe("");
    expect(res.body.display_title).toBe("Entrainement Mardi");
    expect(res.body.id).toBeGreaterThan(0);
  });

  it("POST /api/polls rejette si question vide ET training_day absent", async () => {
    const res = await request(app)
      .post("/api/polls")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        question: "",
        options: ["Oui", "Non"],
        cron_expression: "0 9 * * *",
        group_ids: ["g1@g.us"],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Question requise/);
  });

  it("POST /api/polls rejette training_day hors bornes", async () => {
    const res = await request(app)
      .post("/api/polls")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        question: "Q",
        options: ["A", "B"],
        cron_expression: "0 9 * * 1",
        group_ids: ["g1"],
        training_day: 7,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/training_day/);
  });

  // Regression C4 — validateTrainingDay strict
  describe("regression C4 — validateTrainingDay strict", () => {
    const tryBody = (training_day: unknown) => ({
      question: "Q",
      options: ["A", "B"],
      cron_expression: "0 9 * * 1",
      group_ids: ["g1"],
      training_day,
    });

    it("rejette training_day = '' (empty string)", async () => {
      const res = await request(app)
        .post("/api/polls")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(tryBody(""));
      expect(res.status).toBe(400);
    });

    it("rejette training_day = '   ' (whitespace)", async () => {
      const res = await request(app)
        .post("/api/polls")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(tryBody("   "));
      expect(res.status).toBe(400);
    });

    it("rejette training_day = true", async () => {
      const res = await request(app)
        .post("/api/polls")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(tryBody(true));
      expect(res.status).toBe(400);
    });

    it("rejette training_day = [] (array vide)", async () => {
      const res = await request(app)
        .post("/api/polls")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(tryBody([]));
      expect(res.status).toBe(400);
    });

    it("rejette training_day = '2.5'", async () => {
      const res = await request(app)
        .post("/api/polls")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(tryBody("2.5"));
      expect(res.status).toBe(400);
    });

    it("accepte training_day = 3 (entier)", async () => {
      const res = await request(app)
        .post("/api/polls")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(tryBody(3));
      expect(res.status).toBe(201);
    });

    it("accepte training_day = '3' (string numerique)", async () => {
      const res = await request(app)
        .post("/api/polls")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(tryBody("3"));
      expect(res.status).toBe(201);
    });
  });

  // Regression C3 — validation types options et group_ids
  describe("regression C3 — validation stricte options/group_ids", () => {
    it("rejette options non-array (array-like object)", async () => {
      const res = await request(app)
        .post("/api/polls")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          question: "Q",
          options: { length: 3, 0: "a", 1: "b", 2: "c" },
          cron_expression: "0 9 * * 1",
          group_ids: ["g1"],
          training_day: 1,
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/options/);
    });

    it("rejette options contenant autre chose que des strings", async () => {
      const res = await request(app)
        .post("/api/polls")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          question: "Q",
          options: ["a", 42, "c"],
          cron_expression: "0 9 * * 1",
          group_ids: ["g1"],
          training_day: 1,
        });
      expect(res.status).toBe(400);
    });

    it("rejette options avec string vide", async () => {
      const res = await request(app)
        .post("/api/polls")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          question: "Q",
          options: ["a", "   "],
          cron_expression: "0 9 * * 1",
          group_ids: ["g1"],
          training_day: 1,
        });
      expect(res.status).toBe(400);
    });

    it("rejette group_ids non-array", async () => {
      const res = await request(app)
        .post("/api/polls")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          question: "Q",
          options: ["a", "b"],
          cron_expression: "0 9 * * 1",
          group_ids: { length: 1, 0: "g1" },
          training_day: 1,
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/group_ids/);
    });

    it("rejette group_ids contenant un ID qui ne matche pas GROUP_ID_REGEX", async () => {
      const res = await request(app)
        .post("/api/polls")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          question: "Q",
          options: ["a", "b"],
          cron_expression: "0 9 * * 1",
          group_ids: ["groupe avec espace"],
          training_day: 1,
        });
      expect(res.status).toBe(400);
    });

    it("accepte group_ids avec IDs WhatsApp valides", async () => {
      const res = await request(app)
        .post("/api/polls")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          question: "Q",
          options: ["a", "b"],
          cron_expression: "0 9 * * 1",
          group_ids: ["120363000000000000@g.us"],
          training_day: 1,
        });
      expect(res.status).toBe(201);
    });

    it("PUT rejette aussi les options non-array", async () => {
      const poll = db.createPoll({
        question: "q",
        options: ["A", "B"],
        cron_expression: "0 9 * * 1",
        group_ids: ["g1"],
        training_day: 1,
      });
      const res = await request(app)
        .put(`/api/polls/${poll.id}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ options: "not-an-array" });
      expect(res.status).toBe(400);
    });
  });

  // Coverage PUT : exercer toutes les branches de validation/update
  describe("PUT branches validation", () => {
    let poll: any;
    beforeEach(() => {
      poll = db.createPoll({
        question: "q",
        options: ["A", "B"],
        cron_expression: "0 9 * * 1",
        group_ids: ["120363000000000000@g.us"],
        training_day: 1,
      });
    });

    it("rejette cron_expression non-string", async () => {
      const res = await request(app)
        .put(`/api/polls/${poll.id}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ cron_expression: 42 });
      expect(res.status).toBe(400);
    });

    it("rejette group_ids non-array", async () => {
      const res = await request(app)
        .put(`/api/polls/${poll.id}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ group_ids: "g1" });
      expect(res.status).toBe(400);
    });

    it("rejette question non-string", async () => {
      const res = await request(app)
        .put(`/api/polls/${poll.id}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ question: 42 });
      expect(res.status).toBe(400);
    });

    it("rejette question vide si training_day devient null", async () => {
      const res = await request(app)
        .put(`/api/polls/${poll.id}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ question: "", training_day: null });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Question requise/);
    });

    it("accepte question vide si training_day reste défini", async () => {
      const res = await request(app)
        .put(`/api/polls/${poll.id}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ question: "", training_day: 2 });
      expect(res.status).toBe(200);
      expect(res.body.display_title).toBe("Entrainement Mardi");
    });

    it("rejette training_day invalide", async () => {
      const res = await request(app)
        .put(`/api/polls/${poll.id}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ training_day: 42 });
      expect(res.status).toBe(400);
    });

    it("accepte allow_multiple_answers toggle", async () => {
      const res = await request(app)
        .put(`/api/polls/${poll.id}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ allow_multiple_answers: true });
      expect(res.status).toBe(200);
      expect(res.body.allow_multiple_answers).toBe(true);
    });

    it("accepte is_active toggle (pause)", async () => {
      const res = await request(app)
        .put(`/api/polls/${poll.id}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ is_active: false });
      expect(res.status).toBe(200);
      expect(res.body.is_active).toBe(false);
    });

    it("404 sur poll inexistant", async () => {
      const res = await request(app)
        .put("/api/polls/99999")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ question: "new" });
      expect(res.status).toBe(404);
    });
  });

  it("POST /api/polls rejette moins de 2 options", async () => {
    const res = await request(app)
      .post("/api/polls")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        question: "Q",
        options: ["A"],
        cron_expression: "0 9 * * 1",
        group_ids: ["g1"],
        training_day: 1,
      });
    expect(res.status).toBe(400);
  });

  it("GET /api/polls enrichit chaque poll avec display_title", async () => {
    db.createPoll({
      question: "Original",
      options: ["A", "B"],
      cron_expression: "0 9 * * 1",
      group_ids: ["g1"],
      training_day: 1,
    });
    db.createPoll({
      question: "",
      options: ["A", "B"],
      cron_expression: "0 9 * * 4",
      group_ids: ["g1"],
      training_day: 4,
    });
    const res = await request(app)
      .get("/api/polls")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const titles = res.body.map((p: any) => p.display_title).sort();
    expect(titles).toEqual(["Entrainement Jeudi", "Original"]);
  });

  it("PUT /api/polls/:id met à jour training_day", async () => {
    const poll = db.createPoll({
      question: "",
      options: ["A", "B"],
      cron_expression: "0 9 * * 1",
      group_ids: ["g1"],
      training_day: 1,
    });
    const res = await request(app)
      .put(`/api/polls/${poll.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ training_day: 3 });
    expect(res.status).toBe(200);
    expect(res.body.training_day).toBe(3);
    expect(res.body.display_title).toBe("Entrainement Mercredi");
  });

  it("DELETE /api/polls/:id supprime le poll", async () => {
    const poll = db.createPoll({
      question: "q",
      options: ["A", "B"],
      cron_expression: "0 9 * * 1",
      group_ids: ["g1"],
      training_day: 1,
    });
    const res = await request(app)
      .delete(`/api/polls/${poll.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(db.getPoll(poll.id)).toBeUndefined();
  });
});

describe("routes/polls — auth gates", () => {
  let app: express.Express;

  beforeEach(() => {
    makeTempDb();
    app = buildApp();
  });

  it("rejette sans token", async () => {
    const res = await request(app).get("/api/polls");
    expect(res.status).toBe(401);
  });

  it("rejette token invalide", async () => {
    const res = await request(app)
      .get("/api/polls")
      .set("Authorization", "Bearer token-inexistant");
    expect(res.status).toBe(401);
  });

  it("viewer ne peut pas créer un poll", async () => {
    const viewerToken = seedViewerSession();
    const res = await request(app)
      .post("/api/polls")
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({
        question: "Q",
        options: ["A", "B"],
        cron_expression: "0 9 * * 1",
        group_ids: ["g1"],
        training_day: 1,
      });
    expect(res.status).toBe(403);
  });

  it("viewer peut lire les polls", async () => {
    const viewerToken = seedViewerSession();
    const res = await request(app)
      .get("/api/polls")
      .set("Authorization", `Bearer ${viewerToken}`);
    expect(res.status).toBe(200);
  });
});

describe("routes/polls — /by-training-day", () => {
  let app: express.Express;
  let adminToken: string;

  beforeEach(() => {
    makeTempDb();
    app = buildApp();
    adminToken = seedAdminSession();
  });

  it("retourne polls filtrés par jour + send_groups", async () => {
    const mardiPoll = db.createPoll({
      question: "mardi",
      options: ["A", "B"],
      cron_expression: "0 9 * * 2",
      group_ids: ["g1"],
      training_day: 2,
    });
    db.createPoll({
      question: "lundi",
      options: ["A", "B"],
      cron_expression: "0 9 * * 1",
      group_ids: ["g1"],
      training_day: 1,
    });
    // Créer un send récent pour le poll mardi
    db.recordSend(mardiPoll.id, "g1", "msg-1", "Groupe 1");

    const res = await request(app)
      .get("/api/polls/by-training-day?day=2")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.day).toBe(2);
    expect(res.body.polls).toHaveLength(1);
    expect(res.body.polls[0].question).toBe("mardi");
    expect(res.body.send_groups_by_poll[mardiPoll.id]).toBeDefined();
  });

  it("rejette day invalide", async () => {
    const res = await request(app)
      .get("/api/polls/by-training-day?day=9")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it("day manquant → 400", async () => {
    const res = await request(app)
      .get("/api/polls/by-training-day")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });
});

describe("routes/polls — routes lecture additionnelles", () => {
  let app: express.Express;
  let adminToken: string;

  beforeEach(() => {
    makeTempDb();
    app = buildApp();
    adminToken = seedAdminSession();
  });

  it("GET /:id retourne un poll avec display_title", async () => {
    const poll = db.createPoll({
      question: "",
      options: ["A", "B"],
      cron_expression: "0 9 * * 3",
      group_ids: ["g1"],
      training_day: 3,
    });
    const res = await request(app)
      .get(`/api/polls/${poll.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.display_title).toBe("Entrainement Mercredi");
  });

  it("GET /:id 404 sur poll inexistant", async () => {
    const res = await request(app)
      .get("/api/polls/99999")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("GET /:id/history retourne poll + groups", async () => {
    const poll = db.createPoll({
      question: "q",
      options: ["A", "B"],
      cron_expression: "0 9 * * 2",
      group_ids: ["g1"],
      training_day: 2,
    });
    db.recordSend(poll.id, "g1", "m1", "Groupe 1");
    const res = await request(app)
      .get(`/api/polls/${poll.id}/history`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.poll.display_title).toBe("q");
    expect(res.body.groups.length).toBeGreaterThan(0);
  });

  it("GET /:id/history?group_id filtre par groupe", async () => {
    const poll = db.createPoll({
      question: "q",
      options: ["A", "B"],
      cron_expression: "0 9 * * 2",
      group_ids: ["g1", "g2"],
      training_day: 2,
    });
    db.recordSend(poll.id, "g1", "m1", "G1");
    db.recordSend(poll.id, "g2", "m2", "G2");
    const res = await request(app)
      .get(`/api/polls/${poll.id}/history?group_id=g1`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    // Un seul groupe de sends retourné
    const allSends = res.body.groups.flatMap((g: any) => g.sends);
    expect(allSends.every((s: any) => s.group_id === "g1")).toBe(true);
  });

  it("GET /:id/results agrège les votes", async () => {
    const poll = db.createPoll({
      question: "q",
      options: ["Oui", "Non"],
      cron_expression: "0 9 * * 2",
      group_ids: ["g1"],
      training_day: 2,
    });
    const sendId = db.recordSend(poll.id, "g1", "m1", "G1");
    db.recordVote(poll.id, sendId, "g1", "v1", "Alice", ["Oui"]);
    db.recordVote(poll.id, sendId, "g1", "v2", "Bob", ["Oui"]);
    db.recordVote(poll.id, sendId, "g1", "v3", "Charlie", ["Non"]);

    const res = await request(app)
      .get(`/api/polls/${poll.id}/results`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total_votes).toBe(3);
    const oui = res.body.summary.find((s: any) => s.option === "Oui");
    expect(oui.count).toBe(2);
  });

  it("GET /:id/sends/:sendId/results pour un envoi spécifique", async () => {
    const poll = db.createPoll({
      question: "q",
      options: ["A", "B"],
      cron_expression: "0 9 * * 2",
      group_ids: ["g1"],
      training_day: 2,
    });
    const sendId = db.recordSend(poll.id, "g1", "m1", "G1");
    db.recordVote(poll.id, sendId, "g1", "v1", "Alice", ["A"]);
    const res = await request(app)
      .get(`/api/polls/${poll.id}/sends/${sendId}/results`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total_votes).toBe(1);
  });

  it("GET /sends/by-date valide le format date", async () => {
    const res = await request(app)
      .get("/api/polls/sends/by-date?date=pas-une-date")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it("GET /sends/by-date retourne les sends du jour", async () => {
    const poll = db.createPoll({
      question: "q",
      options: ["A", "B"],
      cron_expression: "0 9 * * 2",
      group_ids: ["g1"],
      training_day: 2,
    });
    const sendId = db.recordSend(poll.id, "g1", "m1", "G1");
    rawExec(
      `UPDATE poll_sends SET sent_at = '2026-04-14 09:00:00' WHERE id = ${sendId}`
    );
    const res = await request(app)
      .get("/api/polls/sends/by-date?date=2026-04-14")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.date).toBe("2026-04-14");
    expect(res.body.sends).toHaveLength(1);
  });

  it("GET /groups/active retourne groupes récents", async () => {
    const poll = db.createPoll({
      question: "q",
      options: ["A", "B"],
      cron_expression: "0 9 * * 2",
      group_ids: ["g1"],
      training_day: 2,
    });
    db.recordSend(poll.id, "g1", "m1", "Groupe 1");
    const res = await request(app)
      .get("/api/polls/groups/active")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].group_id).toBe("g1");
  });

  it("POST /:id/send déclenche un envoi manuel", async () => {
    const poll = db.createPoll({
      question: "q",
      options: ["A", "B"],
      cron_expression: "0 9 * * 2",
      group_ids: ["g1"],
      training_day: 2,
    });
    const res = await request(app)
      .post(`/api/polls/${poll.id}/send`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("POST /refresh-names délègue à whatsapp mock", async () => {
    const res = await request(app)
      .post("/api/polls/refresh-names")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });
});

describe("routes/polls — /:id/snapshots", () => {
  let app: express.Express;
  let adminToken: string;

  beforeEach(() => {
    makeTempDb();
    app = buildApp();
    adminToken = seedAdminSession();
  });

  it("retourne liste (vide) des snapshots d'un poll", async () => {
    const poll = db.createPoll({
      question: "q",
      options: ["A", "B"],
      cron_expression: "0 9 * * 1",
      group_ids: ["g1"],
      training_day: 1,
    });
    const res = await request(app)
      .get(`/api/polls/${poll.id}/snapshots`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.snapshots).toEqual([]);
  });

  it("retourne snapshots existants triés DESC", async () => {
    const poll = db.createPoll({
      question: "q",
      options: ["A", "B"],
      cron_expression: "0 9 * * 2",
      group_ids: ["g1"],
      training_day: 2,
    });
    db.createResultsSnapshot({
      poll_id: poll.id,
      send_id: null,
      training_date: "2026-04-07",
      training_day: 2,
      summary: [],
      total_votes: 0,
      display_title: "Entrainement Mardi",
    });
    db.createResultsSnapshot({
      poll_id: poll.id,
      send_id: null,
      training_date: "2026-04-14",
      training_day: 2,
      summary: [],
      total_votes: 3,
      display_title: "Entrainement Mardi",
    });
    const res = await request(app)
      .get(`/api/polls/${poll.id}/snapshots`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.snapshots).toHaveLength(2);
    expect(res.body.snapshots[0].training_date).toBe("2026-04-14");
    expect(res.body.snapshots[1].training_date).toBe("2026-04-07");
  });

  it("404 sur poll inexistant", async () => {
    const res = await request(app)
      .get("/api/polls/99999/snapshots")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});

describe("routes/polls — issues #60 et #61 (pollService integration)", () => {
  let app: express.Express;
  let adminToken: string;

  beforeEach(() => {
    makeTempDb();
    app = buildApp();
    adminToken = seedAdminSession();
    vi.mocked(whatsapp.removeMessageMappingsForPoll).mockClear();
  });

  it("#61 — DELETE /api/polls/:id passe par pollService (removeMessageMappingsForPoll appelé)", async () => {
    const created = await request(app)
      .post("/api/polls")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        question: "Test",
        options: ["Oui", "Non"],
        cron_expression: "0 9 * * 1",
        group_ids: ["g1@g.us"],
        training_day: 1,
      });
    const pollId = created.body.id;

    const res = await request(app)
      .delete(`/api/polls/${pollId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    // Issue #60 : pollService.deleteAndUnschedulePoll doit appeler le helper
    // qui purge la Map RAM avant la cascade DB.
    expect(whatsapp.removeMessageMappingsForPoll).toHaveBeenCalledWith(pollId);
    expect(whatsapp.removeMessageMappingsForPoll).toHaveBeenCalledTimes(1);
  });

  it("#61 — PUT désactivation passe par pollService et unschedule", async () => {
    const created = await request(app)
      .post("/api/polls")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        question: "Test update",
        options: ["A", "B"],
        cron_expression: "0 9 * * 2",
        group_ids: ["g1@g.us"],
        training_day: 2,
      });
    const pollId = created.body.id;

    const res = await request(app)
      .put(`/api/polls/${pollId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ is_active: false });
    expect(res.status).toBe(200);
    // Poll doit avoir été désactivé en DB.
    const fresh = db.getPoll(pollId);
    expect(fresh?.is_active).toBe(false);
  });
});

describe("routes/polls — #66 diagnose + send 422", () => {
  let app: express.Express;
  let adminToken: string;

  beforeEach(() => {
    makeTempDb();
    app = buildApp();
    adminToken = seedAdminSession();
  });

  it("GET /:id/diagnose : poll legacy (static) → can_send=true", async () => {
    const created = await request(app)
      .post("/api/polls")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        question: "Q?",
        options: ["A", "B"],
        cron_expression: "0 9 * * 1",
        group_ids: ["g1@g.us"],
        training_day: 1,
      });
    const r = await request(app)
      .get(`/api/polls/${created.body.id}/diagnose`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.can_send).toBe(true);
    expect(r.body.use_phrase_library).toBe(false);
    expect(r.body.reasons).toEqual([]);
    expect(r.body.resolved_preview).toEqual({
      question: "Q?",
      options: ["A", "B"],
      source: "static",
    });
  });

  it("GET /:id/diagnose : poll library + lib vide → can_send=false + raisons", async () => {
    // PUT use_phrase_library=true sur un poll existant
    const created = await request(app)
      .post("/api/polls")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        question: "Q?",
        options: ["A", "B"],
        cron_expression: "0 9 * * 2",
        group_ids: ["g1@g.us"],
        training_day: 2,
      });
    await request(app)
      .put(`/api/polls/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ use_phrase_library: true });

    const r = await request(app)
      .get(`/api/polls/${created.body.id}/diagnose`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.can_send).toBe(false);
    expect(r.body.use_phrase_library).toBe(true);
    expect(r.body.library_status.ready).toBe(false);
    // Issue #67 : 'title' n'est plus required, seulement les options
    expect(r.body.library_status.missing).toEqual(["yes", "no", "quit"]);
    expect(r.body.reasons.length).toBeGreaterThan(0);
    expect(r.body.resolved_preview).toBeNull();
  });

  it("GET /:id/diagnose : poll library + lib OK → can_send=true + preview", async () => {
    db.addPhrase({ category: "yes", text: "Oui" });
    db.addPhrase({ category: "no", text: "Non" });
    db.addPhrase({ category: "quit", text: "Quit" });

    const created = await request(app)
      .post("/api/polls")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        question: "Es-tu là {jour} ?",
        options: ["[lib]", "[lib]"],
        cron_expression: "0 9 * * 2",
        group_ids: ["g1@g.us"],
        training_day: 2,
        use_phrase_library: true,
      });

    const r = await request(app)
      .get(`/api/polls/${created.body.id}/diagnose`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.can_send).toBe(true);
    expect(r.body.resolved_preview.source).toBe("library");
    // Issue #67 : la question vient du poll (avec subst {jour}), pas de la lib
    expect(r.body.resolved_preview.question).toBe("Es-tu là Mardi ?");
    expect(r.body.resolved_preview.options).toEqual(["Oui", "Non", "Quit"]);
  });

  it("POST /:id/send : library incomplète → 422 avec diagnose_url", async () => {
    const created = await request(app)
      .post("/api/polls")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        question: "Q?",
        options: ["A", "B"],
        cron_expression: "0 9 * * 2",
        group_ids: ["g1@g.us"],
        training_day: 2,
        use_phrase_library: true,
      });

    const r = await request(app)
      .post(`/api/polls/${created.body.id}/send`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/Bibliothèque/);
    expect(r.body.diagnose_url).toBe(`/api/polls/${created.body.id}/diagnose`);
  });
});
