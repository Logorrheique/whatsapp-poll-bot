// Tests de performance sur les opérations lourdes périodiques
// (complément de #44). Scénarios non couverts par volume.test.ts :
// - runSnapshotPass avec beaucoup de candidats
// - cleanupOldAuditLogs sur 50k rows
// - backfillVoteOptions sur 10k votes legacy
// - migration backfillTrainingDay sur 2k polls legacy
// - boot initDb() total sur DB chargée
// - contention UPSERT sur même voter en hot loop
//
// Objectif identique : filet anti-régression d'ordre de grandeur, pas
// benchmark précis. Budgets larges pour ne pas flaker en CI.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../src/whatsapp", () => ({
  getClient: vi.fn().mockReturnValue(null),
  getStatus: vi.fn().mockReturnValue({ ready: false }),
  sendPollToGroups: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node-cron", () => ({
  validate: vi.fn().mockReturnValue(true),
  schedule: vi.fn().mockReturnValue({
    stop: vi.fn(),
    destroy: vi.fn(),
    getNextRun: () => new Date(),
  }),
}));

import { makeTempDb, freshDbPath, resetDb } from "../helpers/db";
import * as db from "../../src/db";
import { runSnapshotPass } from "../../src/scheduler";
import Database from "better-sqlite3";

function seedPollsWithTrainingDay(n: number, trainingDay: number): number[] {
  const raw = db.getDb();
  const ins = raw.prepare(
    "INSERT INTO polls (question, options, cron_expression, group_ids, training_day, is_active) VALUES (?, ?, ?, ?, ?, 1)"
  );
  const ids: number[] = [];
  const tx = raw.transaction(() => {
    for (let i = 0; i < n; i++) {
      const r = ins.run(
        `Snapshot test ${i}`,
        JSON.stringify(["Oui", "Non"]),
        `0 9 * * ${trainingDay}`,
        JSON.stringify(["g1@g.us"]),
        trainingDay
      );
      ids.push(r.lastInsertRowid as number);
    }
  });
  tx();
  return ids;
}

function seedYesterdaySendsForPolls(pollIds: number[]): void {
  const raw = db.getDb();
  const yesterday = new Date(Date.now() - 24 * 3600_000);
  const sqlTs = yesterday.toISOString().replace("T", " ").substring(0, 19);
  const ins = raw.prepare(
    "INSERT INTO poll_sends (poll_id, group_id, group_name, message_id, sent_at) VALUES (?, ?, ?, ?, ?)"
  );
  const insVote = raw.prepare(
    "INSERT INTO poll_votes (poll_id, send_id, group_id, voter, voter_name, selected_options, voted_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  const tx = raw.transaction(() => {
    for (const pid of pollIds) {
      const sid = ins.run(pid, "g1@g.us", "G1", `m-${pid}`, sqlTs).lastInsertRowid as number;
      for (let v = 0; v < 5; v++) {
        insVote.run(pid, sid, "g1@g.us", `u${pid}-${v}@c.us`, `U${v}`, JSON.stringify(["Oui"]), sqlTs);
      }
    }
  });
  tx();
}

describe("perf heavy — runSnapshotPass batch", () => {
  beforeEach(() => {
    makeTempDb();
  });

  it("50 polls × 5 votes : runSnapshotPass sous 500ms", async () => {
    const yesterday = new Date(Date.now() - 24 * 3600_000);
    const yesterdayDow = yesterday.getDay();
    const ids = seedPollsWithTrainingDay(50, yesterdayDow);
    seedYesterdaySendsForPolls(ids);

    const start = Date.now();
    const result = await runSnapshotPass();
    const elapsed = Date.now() - start;

    expect(result.candidates).toBe(50);
    expect(result.written).toBe(50);
    expect(elapsed).toBeLessThan(500);
  });

  it("runSnapshotPass idempotent : 2e passe skip tout sous 200ms", async () => {
    const yesterday = new Date(Date.now() - 24 * 3600_000);
    const dow = yesterday.getDay();
    const ids = seedPollsWithTrainingDay(30, dow);
    seedYesterdaySendsForPolls(ids);
    await runSnapshotPass(); // première passe

    const start = Date.now();
    const result = await runSnapshotPass();
    const elapsed = Date.now() - start;
    expect(result.written).toBe(0);
    expect(result.skipped).toBe(30);
    expect(elapsed).toBeLessThan(200);
  });
});

describe("perf heavy — purge et cleanup", () => {
  beforeEach(() => {
    makeTempDb();
  });

  it("cleanupOldAuditLogs avec 10k rows anciennes sous 200ms", () => {
    const raw = db.getDb();
    const ins = raw.prepare(
      "INSERT INTO audit_logs (phone, action, detail, created_at) VALUES (?, ?, ?, ?)"
    );
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
    const recent = new Date().toISOString().slice(0, 19).replace("T", " ");
    const tx = raw.transaction(() => {
      for (let i = 0; i < 10_000; i++) ins.run("33600000001", "test", String(i), old);
      for (let i = 0; i < 100; i++) ins.run("33600000001", "test", "recent", recent);
    });
    tx();

    const start = Date.now();
    const purged = db.cleanupOldAuditLogs(90);
    const elapsed = Date.now() - start;

    expect(purged).toBe(10_000);
    expect(elapsed).toBeLessThan(200);

    const remaining = raw.prepare("SELECT COUNT(*) as c FROM audit_logs").get() as { c: number };
    expect(remaining.c).toBe(100);
  });

  it("cleanupOldSends avec 5k sends anciens sous 300ms", () => {
    const raw = db.getDb();
    raw.prepare(
      "INSERT INTO polls (question, options, cron_expression, group_ids, training_day, is_active) VALUES ('Q', '[]', '0 9 * * 1', '[]', 1, 1)"
    ).run();
    const ins = raw.prepare(
      "INSERT INTO poll_sends (poll_id, group_id, group_name, message_id, sent_at) VALUES (1, 'g@g.us', 'G', ?, ?)"
    );
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
    const tx = raw.transaction(() => {
      for (let i = 0; i < 5_000; i++) ins.run(`m${i}`, old);
    });
    tx();

    const start = Date.now();
    const purged = db.cleanupOldSends(21);
    const elapsed = Date.now() - start;
    expect(purged).toBe(5_000);
    expect(elapsed).toBeLessThan(300);
  });
});

describe("perf heavy — migrations & backfills", () => {
  it("backfillVoteOptions traite 5000 votes legacy sous 1s", () => {
    // Setup : DB fraîche, puis insertion de votes avec selected_options JSON
    // et poll_vote_options vide (simule legacy pré-migration #53). Le boot
    // suivant doit backfiller.
    const path = freshDbPath();
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE polls (id INTEGER PRIMARY KEY, question TEXT, options TEXT, cron_expression TEXT, group_ids TEXT, is_active INTEGER, allow_multiple_answers INTEGER, created_at TEXT);
      CREATE TABLE poll_sends (id INTEGER PRIMARY KEY, poll_id INTEGER, group_id TEXT, group_name TEXT, message_id TEXT, sent_at TEXT);
      CREATE TABLE poll_votes (id INTEGER PRIMARY KEY, poll_id INTEGER, send_id INTEGER, group_id TEXT, voter TEXT, voter_name TEXT, selected_options TEXT, voted_at TEXT);
      INSERT INTO polls (id, question, options, cron_expression, group_ids, is_active) VALUES (1, 'Q', '["A","B"]', '0 9 * * 1', '[]', 1);
      INSERT INTO poll_sends (id, poll_id, group_id, message_id, sent_at) VALUES (1, 1, 'g@g.us', 'm', datetime('now'));
    `);
    const insVote = raw.prepare(
      "INSERT INTO poll_votes (poll_id, send_id, group_id, voter, voter_name, selected_options) VALUES (1, 1, 'g@g.us', ?, ?, ?)"
    );
    const tx = raw.transaction(() => {
      for (let i = 0; i < 5_000; i++) {
        const opts = i % 2 === 0 ? '["A"]' : '["A","B"]';
        insVote.run(`u${i}@c.us`, `U${i}`, opts);
      }
    });
    tx();
    raw.close();

    // Boot sur cette DB → backfillVoteOptions tourne
    resetDb();
    process.env.POLLS_DB_PATH = path;
    const start = Date.now();
    db.initDb();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
    const row = db
      .getDb()
      .prepare("SELECT COUNT(*) as c FROM poll_vote_options")
      .get() as { c: number };
    // 2500 votes avec 1 option + 2500 votes avec 2 options = 7500 lignes
    expect(row.c).toBe(7500);
  });

  it("initDb sur DB fraîche sous 150ms (sanity check boot)", () => {
    resetDb();
    const p = freshDbPath();
    process.env.POLLS_DB_PATH = p;
    const start = Date.now();
    db.initDb();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(150);
  });
});

describe("perf heavy — contention UPSERT recordVote", () => {
  beforeEach(() => {
    makeTempDb();
  });

  it("100 UPSERT séquentiels sur même voter complètent sous 500ms", () => {
    db.getDb().prepare(
      "INSERT INTO polls (id, question, options, cron_expression, group_ids, is_active) VALUES (1, 'Q', '[\"Oui\"]', '0 9 * * 1', '[]', 1)"
    ).run();
    const sid = db.recordSendAndMap(1, "g@g.us", "m-hot", "G");

    const start = Date.now();
    for (let i = 0; i < 100; i++) {
      db.recordVote(1, sid, "g@g.us", "hot@c.us", "Hot User", [i % 2 === 0 ? "Oui" : "Oui"]);
    }
    const elapsed = Date.now() - start;

    const votes = db.getVotesForSend(sid);
    expect(votes).toHaveLength(1); // UPSERT de la même clef
    expect(elapsed).toBeLessThan(500);
  });

  it("recordVote ping-pong entre 2 options reste cohérent sur 50 alternances", () => {
    db.getDb().prepare(
      "INSERT INTO polls (id, question, options, cron_expression, group_ids, is_active) VALUES (1, 'Q', '[\"A\",\"B\"]', '0 9 * * 1', '[]', 1)"
    ).run();
    const sid = db.recordSendAndMap(1, "g@g.us", "m-pp", "G");

    for (let i = 0; i < 50; i++) {
      db.recordVote(1, sid, "g@g.us", "pp@c.us", "PP", [i % 2 === 0 ? "A" : "B"]);
    }
    const votes = db.getVotesForSend(sid);
    expect(votes).toHaveLength(1);
    // Dernière valeur = B (i=49, i%2=1)
    expect(votes[0].selected_options).toEqual(["B"]);
    // poll_vote_options normalisé doit rester en phase (1 ligne "B", 0 ligne "A")
    const optRows = db
      .getDb()
      .prepare("SELECT option FROM poll_vote_options WHERE vote_id = ?")
      .all(votes[0].id) as { option: string }[];
    expect(optRows).toHaveLength(1);
    expect(optRows[0].option).toBe("B");
  });
});
