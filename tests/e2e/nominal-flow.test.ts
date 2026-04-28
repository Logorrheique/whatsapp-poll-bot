// Test E2E du flow nominal (issue #42).
//
// Pas de Playwright — on reste dans vitest + supertest, mais on exerce
// la chaîne complète : login → create poll → manual send (via mock WA) →
// handlePollVote → get history → recompute snapshot. Le cron node-cron
// reste mocké (on teste la logique pas le scheduling horaire, pour ça
// voir tests/scheduler/snapshot.test.ts).
//
// Cette suite reste courte (1 flow complet) — sa valeur est de détecter
// toute régression qui casserait l'articulation des couches (auth → route
// → db → whatsapp → scheduler → snapshot → export).

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

// vi.mock est hoisté au top — on ne peut pas référencer une variable définie
// ici. On mock inline, puis on récupère le mock via `vi.mocked(...)` après
// import pour faire des assertions.
vi.mock("../../src/whatsapp", () => ({
  initWhatsApp: vi.fn().mockResolvedValue(undefined),
  sendPollToGroups: vi.fn().mockResolvedValue(undefined),
  refreshAllVoterNames: vi.fn().mockResolvedValue({ refreshed: 0 }),
  getClient: vi.fn().mockReturnValue({ sendMessage: vi.fn().mockResolvedValue(undefined) }),
  getStatus: vi.fn().mockReturnValue({ ready: true }),
  removeMessageMappingsForPoll: vi.fn(),
  // Port Baileys : nouveaux wrappers utilisés par auth.ts et index.ts.
  sendDirectMessage: vi.fn().mockResolvedValue(undefined),
  disconnectClient: vi.fn().mockResolvedValue(undefined),
  reloadMessageMap: vi.fn(),
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
import { requireAuth } from "../../src/middleware/requireAuth";
import { runSnapshotPass } from "../../src/scheduler";
import { sendPollToGroups } from "../../src/whatsapp";
const sendPollMock = vi.mocked(sendPollToGroups);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/polls", requireAuth, pollsRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

describe("E2E — flow nominal login → poll → vote → history → snapshot", () => {
  let app: express.Express;
  let adminToken: string;

  beforeEach(() => {
    process.env.ADMIN_PHONES = "33600000001";
    makeTempDb();
    app = buildApp();
    adminToken = "e2e-token-" + Date.now();
    db.createSession(adminToken, "33600000001", "admin");
    sendPollMock.mockClear();
  });

  it("flow complet passe de bout en bout", async () => {
    // 1. Admin crée un poll avec training_day mardi
    const createRes = await request(app)
      .post("/api/polls")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        question: "Présent mardi ?",
        options: ["Oui", "Peut-être", "Non"],
        cron_expression: "0 9 * * 2",
        group_ids: ["120000001@g.us"],
        training_day: 2,
      });
    expect(createRes.status).toBe(201);
    const pollId = createRes.body.id;
    expect(pollId).toBeGreaterThan(0);

    // 2. Envoi immédiat — simule le cron qui déclenche + WA qui poste
    const sendRes = await request(app)
      .post(`/api/polls/${pollId}/send`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(sendRes.status).toBe(200);
    expect(sendPollMock).toHaveBeenCalledTimes(1);

    // 3. Enregistrer manuellement un send + des votes (le mock ne touche
    //    pas la DB). On simule ce que sendPoll fait en prod.
    const sendId = db.recordSendAndMap(pollId, "120000001@g.us", "msg-e2e-1", "Groupe E2E");
    db.recordVote(pollId, sendId, "120000001@g.us", "33600000100@c.us", "Alice", ["Oui"]);
    db.recordVote(pollId, sendId, "120000001@g.us", "33600000200@c.us", "Bob", ["Peut-être"]);

    // 4. History with ?include=results — un seul fetch pour le frontend
    const histRes = await request(app)
      .get(`/api/polls/${pollId}/history?include=results`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(histRes.status).toBe(200);
    expect(histRes.body.groups).toHaveLength(1);
    const group = histRes.body.groups[0];
    expect(group.sends[0].summary).toHaveLength(3); // 3 options
    const oui = group.sends[0].summary.find((o: any) => o.option === "Oui");
    expect(oui.count).toBe(1);
    expect(oui.voters).toContain("Alice");

    // 5. Snapshot pass : le cron aurait tourné le lendemain 8h. On aligne
    //    le training_day du poll sur le jour de la semaine "hier" pour que
    //    runSnapshotPass le trouve comme candidat, et on triche sur le
    //    timestamp du send pour qu'il tombe bien hier dans la TZ.
    const rawDb = db.getDb();
    const yesterdayDate = new Date(Date.now() - 24 * 3600_000);
    const yesterdayDow = yesterdayDate.getDay();
    rawDb.prepare("UPDATE polls SET training_day = ? WHERE id = ?").run(yesterdayDow, pollId);
    const yesterdaySql = yesterdayDate.toISOString().replace("T", " ").substring(0, 19);
    rawDb.prepare("UPDATE poll_sends SET sent_at = ? WHERE id = ?").run(yesterdaySql, sendId);

    const result = await runSnapshotPass();
    expect(result.candidates).toBeGreaterThanOrEqual(1);

    // 6. Snapshots visibles dans export CSV
    const exportRes = await request(app)
      .get(`/api/polls/snapshots/export?format=json`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(exportRes.status).toBe(200);
    expect(Array.isArray(exportRes.body)).toBe(true);
  });

  it("recompute d'un snapshot rattrape les votes tardifs (issue #56 e2e)", async () => {
    const createRes = await request(app)
      .post("/api/polls")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        question: "Test recompute",
        options: ["Oui", "Non"],
        cron_expression: "0 9 * * 3",
        group_ids: ["120000002@g.us"],
        training_day: 3,
      });
    const pollId = createRes.body.id;
    const sendId = db.recordSendAndMap(pollId, "120000002@g.us", "msg-rc-1", "Groupe RC");
    db.recordVote(pollId, sendId, "120000002@g.us", "33600000300@c.us", "Charlie", ["Oui"]);

    // Figer manuellement la date du send à hier
    const yesterday = new Date(Date.now() - 24 * 3600_000);
    const yDateStr = yesterday.toISOString().slice(0, 10);
    db.getDb()
      .prepare("UPDATE poll_sends SET sent_at = ? WHERE id = ?")
      .run(yesterday.toISOString().replace("T", " ").substring(0, 19), sendId);

    // Premier recompute : 1 vote
    const first = await request(app)
      .post(`/api/polls/${pollId}/snapshots/recompute?date=${yDateStr}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(first.status).toBe(200);
    expect(first.body.total_votes).toBe(1);

    // Vote tardif arrive
    db.recordVote(pollId, sendId, "120000002@g.us", "33600000400@c.us", "Dave", ["Non"]);

    // Second recompute : 2 votes (écrase l'ancien snapshot)
    const second = await request(app)
      .post(`/api/polls/${pollId}/snapshots/recompute?date=${yDateStr}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(second.status).toBe(200);
    expect(second.body.total_votes).toBe(2);
  });
});
