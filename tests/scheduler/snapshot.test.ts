import { describe, it, expect, beforeEach, vi } from "vitest";

// Mocker whatsapp pour éviter l'init du client WA
vi.mock("../../src/whatsapp", () => ({
  initWhatsApp: vi.fn().mockResolvedValue(undefined),
  sendPollToGroups: vi.fn().mockResolvedValue(undefined),
  refreshAllVoterNames: vi.fn().mockResolvedValue({ refreshed: 0 }),
  getClient: vi.fn().mockReturnValue(null),
  getStatus: vi.fn().mockReturnValue({ ready: false }),
}));

// Mocker node-cron : les tests ne doivent jamais creer de vrais tasks
// qui leak des timers ou s'executent en arriere-plan.
vi.mock("node-cron", () => ({
  validate: vi.fn().mockReturnValue(true),
  schedule: vi.fn().mockReturnValue({
    stop: vi.fn(),
    destroy: vi.fn(),
    getNextRun: () => new Date(),
  }),
}));

import { makeTempDb, rawExec } from "../helpers/db";
import * as db from "../../src/db";
import { runSnapshotPass, computeYesterdayInTimezone } from "../../src/scheduler";

describe("scheduler — runSnapshotPass", () => {
  beforeEach(() => {
    makeTempDb();
  });

  it("no-op si aucun poll n'a un training_day correspondant à hier", async () => {
    db.createPoll({
      question: "lundi",
      options: ["A", "B"],
      cron_expression: "0 9 * * 1",
      group_ids: ["g1"],
      training_day: 1,
    });
    const result = await runSnapshotPass();
    expect(result.written).toBe(0);
  });

  it("skip si le poll n'a pas de send pour la date hier", async () => {
    const { dow } = computeYesterdayInTimezone("Europe/Paris");
    db.createPoll({
      question: "q",
      options: ["A", "B"],
      cron_expression: "0 9 * * " + dow,
      group_ids: ["g1"],
      training_day: dow,
    });
    const result = await runSnapshotPass();
    expect(result.candidates).toBe(1);
    expect(result.written).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("écrit un snapshot pour le poll dont le send date d'hier", async () => {
    const { dow, date } = computeYesterdayInTimezone("Europe/Paris");
    const poll = db.createPoll({
      question: "",
      options: ["Oui", "Non"],
      cron_expression: "0 9 * * " + dow,
      group_ids: ["g1"],
      training_day: dow,
    });
    const sendId = db.recordSend(poll.id, "g1", "msg-1", "Groupe 1");
    // Anti-date le send à hier 9h
    rawExec(
      `UPDATE poll_sends SET sent_at = '${date} 09:00:00' WHERE id = ${sendId}`
    );
    // Ajoute 2 votes
    db.recordVote(poll.id, sendId, "g1", "v1", "Alice", ["Oui"]);
    db.recordVote(poll.id, sendId, "g1", "v2", "Bob", ["Non"]);

    const result = await runSnapshotPass();
    expect(result.candidates).toBe(1);
    expect(result.written).toBe(1);

    const snaps = db.listSnapshotsForPoll(poll.id);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].training_date).toBe(date);
    expect(snaps[0].training_day).toBe(dow);
    expect(snaps[0].total_votes).toBe(2);
    expect(snaps[0].summary.map((s) => s.option).sort()).toEqual(["Non", "Oui"]);
    expect(snaps[0].display_title).toContain("Entrainement");
  });

  it("idempotent : deuxième run ne ré-écrit pas", async () => {
    const { dow, date } = computeYesterdayInTimezone("Europe/Paris");
    const poll = db.createPoll({
      question: "",
      options: ["A", "B"],
      cron_expression: "0 9 * * " + dow,
      group_ids: ["g1"],
      training_day: dow,
    });
    const sendId = db.recordSend(poll.id, "g1", "msg-1", "Groupe 1");
    rawExec(
      `UPDATE poll_sends SET sent_at = '${date} 09:00:00' WHERE id = ${sendId}`
    );

    const r1 = await runSnapshotPass();
    expect(r1.written).toBe(1);

    const r2 = await runSnapshotPass();
    expect(r2.written).toBe(0);
    expect(r2.skipped).toBe(1); // poll match mais INSERT OR IGNORE ignore

    expect(db.listSnapshotsForPoll(poll.id)).toHaveLength(1);
  });

  it("display_title reflète poll.question si non-vide", async () => {
    const { dow, date } = computeYesterdayInTimezone("Europe/Paris");
    const poll = db.createPoll({
      question: "Dispo custom ?",
      options: ["A", "B"],
      cron_expression: "0 9 * * " + dow,
      group_ids: ["g1"],
      training_day: dow,
    });
    const sendId = db.recordSend(poll.id, "g1", "msg-1", "Groupe 1");
    rawExec(
      `UPDATE poll_sends SET sent_at = '${date} 09:00:00' WHERE id = ${sendId}`
    );

    await runSnapshotPass();
    const snaps = db.listSnapshotsForPoll(poll.id);
    expect(snaps[0].display_title).toBe("Dispo custom ?");
  });
});
