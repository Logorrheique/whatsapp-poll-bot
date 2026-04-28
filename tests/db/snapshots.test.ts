import { describe, it, expect, beforeEach } from "vitest";
import { makeTempDb, rawExec } from "../helpers/db";
import * as db from "../../src/db";

describe("DB — poll_results_snapshot", () => {
  beforeEach(() => {
    makeTempDb();
  });

  it("createResultsSnapshot insère et retourne true", () => {
    const poll = db.createPoll({
      question: "q",
      options: ["A", "B"],
      cron_expression: "0 9 * * 2",
      group_ids: ["g1"],
      training_day: 2,
    });
    const sendId = db.recordSend(poll.id, "g1", "msg-1", "Groupe 1");
    const inserted = db.createResultsSnapshot({
      poll_id: poll.id,
      send_id: sendId,
      training_date: "2026-04-14",
      training_day: 2,
      summary: [
        { option: "A", count: 2, voters: ["Alice", "Bob"] },
        { option: "B", count: 1, voters: ["Charlie"] },
      ],
      total_votes: 3,
      display_title: "Entrainement Mardi",
    });
    expect(inserted).toBe(true);
    const list = db.listSnapshotsForPoll(poll.id);
    expect(list).toHaveLength(1);
    expect(list[0].summary[0].option).toBe("A");
    expect(list[0].total_votes).toBe(3);
    expect(list[0].display_title).toBe("Entrainement Mardi");
  });

  it("UNIQUE(poll_id, training_date) → second insert retourne false", () => {
    const poll = db.createPoll({
      question: "q",
      options: ["A", "B"],
      cron_expression: "0 9 * * 2",
      group_ids: ["g1"],
      training_day: 2,
    });
    const payload = {
      poll_id: poll.id,
      send_id: null,
      training_date: "2026-04-14",
      training_day: 2,
      summary: [{ option: "A", count: 0, voters: [] }],
      total_votes: 0,
      display_title: "Test",
    };
    expect(db.createResultsSnapshot(payload)).toBe(true);
    expect(db.createResultsSnapshot(payload)).toBe(false);
    expect(db.listSnapshotsForPoll(poll.id)).toHaveLength(1);
  });

  it("cleanupOldSends NE détruit PAS les snapshots (ON DELETE SET NULL)", () => {
    const poll = db.createPoll({
      question: "q",
      options: ["A", "B"],
      cron_expression: "0 9 * * 2",
      group_ids: ["g1"],
      training_day: 2,
    });
    const sendId = db.recordSend(poll.id, "g1", "msg-old", "Groupe 1");
    db.createResultsSnapshot({
      poll_id: poll.id,
      send_id: sendId,
      training_date: "2020-01-01",
      training_day: 3,
      summary: [{ option: "A", count: 1, voters: ["Alice"] }],
      total_votes: 1,
      display_title: "Historique",
    });

    // Simule un send ancien et purge à 0 jour
    rawExec(
      `UPDATE poll_sends SET sent_at = '2020-01-01 09:00:00' WHERE id = ${sendId}`
    );
    const deleted = db.cleanupOldSends(1);
    expect(deleted).toBeGreaterThanOrEqual(1);

    // Snapshot doit survivre, send_id doit être NULL
    const snaps = db.listSnapshotsForPoll(poll.id);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].send_id).toBeNull();
    expect(snaps[0].display_title).toBe("Historique");
  });

  it("deletePoll cascade sur snapshots (ON DELETE CASCADE)", () => {
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
      training_date: "2026-04-14",
      training_day: 2,
      summary: [],
      total_votes: 0,
      display_title: "x",
    });
    db.deletePoll(poll.id);
    expect(db.listSnapshotsForPoll(poll.id)).toHaveLength(0);
  });

  it("getLatestSendForPollOnDate retourne le dernier send du jour", () => {
    const poll = db.createPoll({
      question: "q",
      options: ["A", "B"],
      cron_expression: "0 9 * * 2",
      group_ids: ["g1"],
      training_day: 2,
    });
    const s1 = db.recordSend(poll.id, "g1", "msg-1", "Groupe 1");
    const s2 = db.recordSend(poll.id, "g1", "msg-2", "Groupe 1");
    rawExec(
      `UPDATE poll_sends SET sent_at = '2026-04-14 09:00:00' WHERE id = ${s1}`
    );
    rawExec(
      `UPDATE poll_sends SET sent_at = '2026-04-14 18:30:00' WHERE id = ${s2}`
    );
    const latest = db.getLatestSendForPollOnDate(poll.id, "2026-04-14");
    expect(latest?.id).toBe(s2);
  });

  it("getLatestSendForPollOnDate retourne undefined sans send", () => {
    const poll = db.createPoll({
      question: "q",
      options: ["A", "B"],
      cron_expression: "0 9 * * 2",
      group_ids: ["g1"],
      training_day: 2,
    });
    expect(db.getLatestSendForPollOnDate(poll.id, "2026-04-14")).toBeUndefined();
  });

  // Regression C1 — timezone bounds : sent_at est stocké en UTC mais la query
  // matche sur une date LOCALE. Un send fait à 00:30 Paris (= 22:30 UTC la
  // veille) ne doit PAS être attribué au jour d'hier Paris, mais au jour
  // courant Paris.
  describe("regression C1 — timezone bounds sur sent_at UTC vs date locale", () => {
    it("getLatestSendForPollOnDate: send à 22:30 UTC 19 juin (= 00:30 Paris 20 juin) n'est PAS attribué à Paris 19 juin", () => {
      const poll = db.createPoll({
        question: "q",
        options: ["A", "B"],
        cron_expression: "0 9 * * 4",
        group_ids: ["g1"],
        training_day: 4,
      });
      // Matin Paris 19 juin (envoi "du jour")
      const morning = db.recordSend(poll.id, "g1", "msg-morning", "G1");
      rawExec(
        `UPDATE poll_sends SET sent_at = '2024-06-19 06:00:00' WHERE id = ${morning}`
      );
      // 00:30 Paris 20 juin = 22:30 UTC 19 juin — pas un send du 19 juin Paris
      const latenight = db.recordSend(poll.id, "g1", "msg-late", "G1");
      rawExec(
        `UPDATE poll_sends SET sent_at = '2024-06-19 22:30:00' WHERE id = ${latenight}`
      );

      // Quand on demande "le dernier send du 19 juin Paris", on doit récupérer le matin
      // pas le late-night (qui appartient à Paris 20 juin).
      const resultParis = db.getLatestSendForPollOnDate(poll.id, "2024-06-19");
      expect(resultParis?.message_id).toBe("msg-morning");

      // Et le late-night doit être attribué à Paris 20 juin
      const result20 = db.getLatestSendForPollOnDate(poll.id, "2024-06-20");
      expect(result20?.message_id).toBe("msg-late");
    });

    it("getSendsByDate: même logique pour la route /sends/by-date", () => {
      const poll = db.createPoll({
        question: "q",
        options: ["A", "B"],
        cron_expression: "0 9 * * 4",
        group_ids: ["g1"],
        training_day: 4,
      });
      const latenight = db.recordSend(poll.id, "g1", "msg-late", "G1");
      rawExec(
        `UPDATE poll_sends SET sent_at = '2024-06-19 22:30:00' WHERE id = ${latenight}`
      );

      const june19Paris = db.getSendsByDate("2024-06-19");
      expect(june19Paris.find((s) => s.send_id === latenight)).toBeUndefined();

      const june20Paris = db.getSendsByDate("2024-06-20");
      expect(june20Paris.find((s) => s.send_id === latenight)).toBeDefined();
    });

    it("getLatestSendForPollOnDate hiver Paris : send à 23:30 UTC 14 déc (= 00:30 Paris 15 déc) attribué au 15 déc", () => {
      const poll = db.createPoll({
        question: "q",
        options: ["A", "B"],
        cron_expression: "0 9 * * 1",
        group_ids: ["g1"],
        training_day: 1,
      });
      const sendId = db.recordSend(poll.id, "g1", "msg-winter", "G1");
      // Hiver : Paris = UTC+1. 00:30 Paris 15 déc = 23:30 UTC 14 déc
      rawExec(
        `UPDATE poll_sends SET sent_at = '2024-12-14 23:30:00' WHERE id = ${sendId}`
      );

      // Doit apparaître sous Paris 15 déc, pas Paris 14 déc
      const dec14 = db.getLatestSendForPollOnDate(poll.id, "2024-12-14");
      expect(dec14).toBeUndefined();
      const dec15 = db.getLatestSendForPollOnDate(poll.id, "2024-12-15");
      expect(dec15?.message_id).toBe("msg-winter");
    });
  });
});
