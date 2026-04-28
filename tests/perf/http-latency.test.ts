// Tests de latence HTTP (complément de #44).
//
// Exerce les routes Express end-to-end via supertest, mesure la durée
// et impose un budget par endpoint. Couvre ce que tests/perf/volume.test.ts
// ne couvre pas : la couche routage + middleware + sérialisation JSON, pas
// seulement les queries DB brutes.
//
// Budgets larges comme volume.test.ts — on détecte les régressions d'ordre
// de grandeur, pas les variations à la milliseconde. Observé typiquement
// 5-20ms en local ; budget 200ms pour tolérer la CI lente.

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../src/whatsapp", () => ({
  initWhatsApp: vi.fn().mockResolvedValue(undefined),
  sendPollToGroups: vi.fn().mockResolvedValue(undefined),
  refreshAllVoterNames: vi.fn().mockResolvedValue({ refreshed: 0 }),
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
import pollsRouter from "../../src/routes/polls";
import statsRouter from "../../src/routes/stats";
import { requireAuth } from "../../src/middleware/requireAuth";
import { requireAdmin } from "../../src/middleware/requireAdmin";

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/polls", requireAuth, pollsRouter);
  app.use("/api/stats", requireAuth, requireAdmin, statsRouter);
  return app;
}

// Helper : exécute `fn` et retourne la durée en ms. Warm-up implicit du
// prepared statement cache SQLite avant la mesure (premier call toujours
// plus lent à cause de la compilation de la query).
async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - start };
}

function seedLotsOfData(polls: number, sendsPerPoll: number, votesPerSend: number): void {
  const raw = db.getDb();
  const insPoll = raw.prepare(
    "INSERT INTO polls (question, options, cron_expression, group_ids, training_day, is_active) VALUES (?, ?, ?, ?, ?, 1)"
  );
  const insSend = raw.prepare(
    "INSERT INTO poll_sends (poll_id, group_id, group_name, message_id, sent_at) VALUES (?, ?, ?, ?, datetime('now'))"
  );
  const insVote = raw.prepare(
    "INSERT INTO poll_votes (poll_id, send_id, group_id, voter, voter_name, selected_options) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const tx = raw.transaction(() => {
    for (let p = 1; p <= polls; p++) {
      insPoll.run(
        `Q${p}`,
        JSON.stringify(["Oui", "Non"]),
        "0 9 * * 2",
        JSON.stringify(["g1@g.us"]),
        p % 7
      );
      for (let s = 0; s < sendsPerPoll; s++) {
        const sid = insSend.run(p, "g1@g.us", "G1", `msg-${p}-${s}`).lastInsertRowid as number;
        for (let v = 0; v < votesPerSend; v++) {
          insVote.run(p, sid, "g1@g.us", `v${p}-${s}-${v}@c.us`, `V${v}`, JSON.stringify(["Oui"]));
        }
      }
    }
  });
  tx();
}

describe("perf HTTP — latence end-to-end sur routes critiques", () => {
  let app: express.Express;
  let adminToken: string;

  beforeEach(() => {
    process.env.ADMIN_PHONES = "33600000001";
    makeTempDb();
    app = buildApp();
    adminToken = "perf-token-" + Math.random().toString(36).slice(2, 8);
    db.createSession(adminToken, "33600000001", "admin");
  });

  it("GET /api/polls tient sous 200ms avec 200 polls + 5 sends chacun", async () => {
    seedLotsOfData(200, 5, 3);
    // Warm-up : premier call fait la compilation de la CTE
    await request(app).get("/api/polls").set("Authorization", `Bearer ${adminToken}`);

    const { result, ms } = await timed(() =>
      request(app).get("/api/polls").set("Authorization", `Bearer ${adminToken}`)
    );
    expect(result.status).toBe(200);
    expect(result.body).toHaveLength(200);
    expect(ms).toBeLessThan(200);
  });

  it("GET /api/polls/:id/history?include=results batch 30 sends sous 150ms", async () => {
    seedLotsOfData(1, 30, 10);
    await request(app)
      .get("/api/polls/1/history?include=results")
      .set("Authorization", `Bearer ${adminToken}`); // warm-up

    const { result, ms } = await timed(() =>
      request(app)
        .get("/api/polls/1/history?include=results")
        .set("Authorization", `Bearer ${adminToken}`)
    );
    expect(result.status).toBe(200);
    expect(result.body.groups[0].sends).toHaveLength(30);
    expect(result.body.groups[0].sends[0].summary).toBeDefined();
    expect(ms).toBeLessThan(150);
  });

  it("GET /api/polls/snapshots/export format=csv sur 500 snapshots sous 300ms", async () => {
    const raw = db.getDb();
    raw.prepare("INSERT INTO polls (question, options, cron_expression, group_ids, training_day, is_active) VALUES ('Q', '[\"A\"]', '0 9 * * 1', '[\"g@g.us\"]', 1, 1)").run();
    const ins = raw.prepare(
      `INSERT INTO poll_results_snapshot
       (poll_id, send_id, training_date, training_day, summary, total_votes, display_title)
       VALUES (1, NULL, ?, 1, ?, 10, 'T')`
    );
    const tx = raw.transaction(() => {
      for (let i = 0; i < 500; i++) {
        const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
        // Chaque snapshot a 2 options × 5 voters = 10 lignes CSV → 5000 lignes total
        const summary = JSON.stringify([
          { option: "A", count: 5, voters: ["u1", "u2", "u3", "u4", "u5"] },
          { option: "B", count: 5, voters: ["u6", "u7", "u8", "u9", "u10"] },
        ]);
        ins.run(d, summary);
      }
    });
    tx();
    await request(app)
      .get("/api/polls/snapshots/export?format=csv")
      .set("Authorization", `Bearer ${adminToken}`); // warm-up

    const { result, ms } = await timed(() =>
      request(app)
        .get("/api/polls/snapshots/export?format=csv")
        .set("Authorization", `Bearer ${adminToken}`)
    );
    expect(result.status).toBe(200);
    // 500 snapshots × (2 options × 5 voters) = 5000 lignes + header = 5001
    expect(result.text.split("\r\n").filter(Boolean).length).toBeGreaterThan(4000);
    expect(ms).toBeLessThan(300);
  });

  it("GET /api/stats agrège les compteurs sous 100ms sur DB moyenne", async () => {
    seedLotsOfData(100, 3, 5);
    await request(app).get("/api/stats").set("Authorization", `Bearer ${adminToken}`);

    const { result, ms } = await timed(() =>
      request(app).get("/api/stats").set("Authorization", `Bearer ${adminToken}`)
    );
    expect(result.status).toBe(200);
    expect(result.body.polls_total).toBe(100);
    expect(ms).toBeLessThan(100);
  });

  it("POST /api/polls création reste sous 80ms (transaction schedule + audit)", async () => {
    // Création a déjà tourné une fois dans beforeEach implicite ? Non, DB neuve.
    // Warm-up manuel pour charger les prepared statements
    await request(app)
      .post("/api/polls")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        question: "warmup",
        options: ["A", "B"],
        cron_expression: "0 9 * * 1",
        group_ids: ["g1@g.us"],
        training_day: 1,
      });

    const { result, ms } = await timed(() =>
      request(app)
        .post("/api/polls")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          question: "perf test",
          options: ["Oui", "Non"],
          cron_expression: "0 9 * * 2",
          group_ids: ["g1@g.us"],
          training_day: 2,
        })
    );
    expect(result.status).toBe(201);
    expect(ms).toBeLessThan(80);
  });
});

describe("perf HTTP — throughput sur requêtes parallèles", () => {
  let app: express.Express;
  let adminToken: string;

  beforeEach(() => {
    process.env.ADMIN_PHONES = "33600000001";
    makeTempDb();
    app = buildApp();
    adminToken = "perf-p-" + Math.random().toString(36).slice(2, 8);
    db.createSession(adminToken, "33600000001", "admin");
  });

  it("50 GET /api/polls parallèles complètent sous 1000ms", async () => {
    seedLotsOfData(50, 2, 2);
    // Warm-up
    await request(app).get("/api/polls").set("Authorization", `Bearer ${adminToken}`);

    const { ms } = await timed(async () => {
      const results = await Promise.all(
        Array.from({ length: 50 }, () =>
          request(app).get("/api/polls").set("Authorization", `Bearer ${adminToken}`)
        )
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      return results;
    });
    expect(ms).toBeLessThan(1000);
  });

  it("30 GET /api/polls/:id/history parallèles sans erreur ni 429", async () => {
    seedLotsOfData(1, 10, 3);
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        request(app)
          .get("/api/polls/1/history")
          .set("Authorization", `Bearer ${adminToken}`)
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});
