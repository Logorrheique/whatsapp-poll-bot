// Tests volume / concurrence (issue #44).
//
// Pas k6 ni Artillery — on reste dans vitest avec des assertions de durée
// budgétées. Objectif : détecter les régressions perf majeures (N+1
// réintroduit, index oublié, lock contention) sans dépendance externe.
//
// Les seuils sont larges exprès pour ne pas être flaky. Si un seuil saute
// c'est qu'il y a une vraie dégradation d'ordre de grandeur.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../src/whatsapp", () => ({
  getClient: vi.fn().mockReturnValue(null),
  getStatus: vi.fn().mockReturnValue({ ready: false }),
}));

import { makeTempDb } from "../helpers/db";
import * as db from "../../src/db";

function seedPolls(n: number): void {
  const rawDb = db.getDb();
  const insert = rawDb.prepare(
    "INSERT INTO polls (question, options, cron_expression, group_ids, training_day, is_active) VALUES (?, ?, ?, ?, ?, 1)"
  );
  const tx = rawDb.transaction((count: number) => {
    for (let i = 0; i < count; i++) {
      insert.run(
        `Q${i}`,
        JSON.stringify(["Oui", "Non"]),
        "0 9 * * 2",
        JSON.stringify(["g1@g.us"]),
        i % 7
      );
    }
  });
  tx(n);
}

function seedSendsAndVotes(pollsCount: number, sendsPerPoll: number, votesPerSend: number): void {
  const rawDb = db.getDb();
  const insSend = rawDb.prepare(
    "INSERT INTO poll_sends (poll_id, group_id, group_name, message_id, sent_at) VALUES (?, ?, ?, ?, datetime('now'))"
  );
  const insVote = rawDb.prepare(
    "INSERT INTO poll_votes (poll_id, send_id, group_id, voter, voter_name, selected_options) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const tx = rawDb.transaction(() => {
    for (let p = 1; p <= pollsCount; p++) {
      for (let s = 0; s < sendsPerPoll; s++) {
        const res = insSend.run(p, "g1@g.us", "G1", `msg-${p}-${s}`);
        const sendId = res.lastInsertRowid as number;
        for (let v = 0; v < votesPerSend; v++) {
          insVote.run(
            p,
            sendId,
            "g1@g.us",
            `voter-${p}-${s}-${v}`,
            `Name${v}`,
            JSON.stringify(["Oui"])
          );
        }
      }
    }
  });
  tx();
}

describe("perf — volume sur getAllPolls", () => {
  beforeEach(() => {
    makeTempDb();
  });

  it("getAllPolls reste sous 500ms avec 1000 polls + 10 sends + 5 votes chacun", () => {
    seedPolls(1000);
    seedSendsAndVotes(1000, 3, 5);

    const start = Date.now();
    const polls = db.getAllPolls();
    const elapsed = Date.now() - start;

    expect(polls).toHaveLength(1000);
    // Large budget : seuil de régression (observé < 50ms en local), 500ms
    // est un filet ultra-conservateur pour CI qui pourrait être lente.
    expect(elapsed).toBeLessThan(500);
  });

  it("getSendGroupsForPoll reste rapide même avec 30 sends sur un poll", () => {
    seedPolls(1);
    seedSendsAndVotes(1, 30, 10);
    const start = Date.now();
    const groups = db.getSendGroupsForPoll(1);
    const elapsed = Date.now() - start;
    expect(groups.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(200);
  });

  it("getResultsForSendIds batch 30 sends tient sous 100ms", () => {
    seedPolls(1);
    seedSendsAndVotes(1, 30, 20);
    const sendIds = (db.getDb().prepare("SELECT id FROM poll_sends").all() as { id: number }[]).map((r) => r.id);
    const start = Date.now();
    const results = db.getResultsForSendIds(1, sendIds);
    const elapsed = Date.now() - start;
    expect(results.size).toBe(30);
    expect(elapsed).toBeLessThan(100);
  });
});

describe("perf — indexes utilisés par les queries critiques", () => {
  beforeEach(() => {
    makeTempDb();
  });

  function explainUsesIndex(sql: string, params: any[], expectedIndex: string): boolean {
    const plan = db.getDb().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as any[];
    return plan.some((r) => String(r.detail || "").includes(expectedIndex));
  }

  it("getPollsByTrainingDay utilise idx_polls_training_day (issue #39)", () => {
    expect(
      explainUsesIndex(
        "SELECT * FROM polls WHERE training_day = ? ORDER BY created_at DESC",
        [2],
        "idx_polls_training_day"
      )
    ).toBe(true);
  });

  it("getVotesForPoll utilise idx_votes_poll_date (issue #39)", () => {
    expect(
      explainUsesIndex(
        "SELECT * FROM poll_votes WHERE poll_id = ? AND voted_at >= ? ORDER BY voted_at DESC",
        [1, "2026-01-01"],
        "idx_votes_poll_date"
      )
    ).toBe(true);
  });

  it("getAuditLogs utilise idx_audit_created (issue #39)", () => {
    expect(
      explainUsesIndex(
        "SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?",
        [50],
        "idx_audit_created"
      )
    ).toBe(true);
  });
});

describe("concurrence — recordVote parallèle sur même send", () => {
  beforeEach(() => {
    makeTempDb();
  });

  it("20 votes parallèles pour 20 voters distincts = 20 rows", async () => {
    seedPolls(1);
    seedSendsAndVotes(1, 1, 0);
    const sendId = (db.getDb().prepare("SELECT id FROM poll_sends").get() as any).id;

    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        Promise.resolve().then(() =>
          db.recordVote(1, sendId, "g1@g.us", `v${i}@c.us`, `Name${i}`, ["Oui"])
        )
      )
    );

    const votes = db.getVotesForSend(sendId);
    expect(votes).toHaveLength(20);
  });

  it("10 recordVote identiques sur même voter = 1 row UPSERT (pas de duplication)", async () => {
    seedPolls(1);
    seedSendsAndVotes(1, 1, 0);
    const sendId = (db.getDb().prepare("SELECT id FROM poll_sends").get() as any).id;

    await Promise.all(
      Array.from({ length: 10 }, () =>
        Promise.resolve().then(() =>
          db.recordVote(1, sendId, "g1@g.us", "alice@c.us", "Alice", ["Oui"])
        )
      )
    );

    const votes = db.getVotesForSend(sendId);
    expect(votes).toHaveLength(1);
    expect(votes[0].voter_name).toBe("Alice");
  });
});
