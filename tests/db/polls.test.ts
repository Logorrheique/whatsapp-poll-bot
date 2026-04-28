import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { makeTempDb, resetDb } from "../helpers/db";
import * as db from "../../src/db";

describe("DB — polls CRUD avec training_day", () => {
  beforeEach(() => {
    makeTempDb();
  });

  afterAll(() => {
    resetDb();
  });

  it("createPoll accepte training_day et question", () => {
    const poll = db.createPoll({
      question: "Dispo cette semaine ?",
      options: ["Oui", "Non"],
      cron_expression: "0 9 * * 2",
      group_ids: ["g1@g.us"],
      allow_multiple_answers: false,
      training_day: 2,
    });
    expect(poll.id).toBeGreaterThan(0);
    expect(poll.training_day).toBe(2);
    expect(poll.question).toBe("Dispo cette semaine ?");
    expect(poll.is_active).toBe(true);
    expect(poll.options).toEqual(["Oui", "Non"]);
    expect(poll.group_ids).toEqual(["g1@g.us"]);
  });

  it("createPoll accepte une question vide et training_day null", () => {
    const poll = db.createPoll({
      question: "",
      options: ["A", "B"],
      cron_expression: "0 9 * * *",
      group_ids: ["g1@g.us"],
      training_day: null,
    });
    expect(poll.question).toBe("");
    expect(poll.training_day).toBeNull();
  });

  it("getPoll retourne le poll persisté avec JSON parsé", () => {
    const created = db.createPoll({
      question: "Q?",
      options: ["a", "b", "c"],
      cron_expression: "0 9 * * 1",
      group_ids: ["x", "y"],
      training_day: 1,
    });
    const fetched = db.getPoll(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.options).toEqual(["a", "b", "c"]);
    expect(fetched!.group_ids).toEqual(["x", "y"]);
  });

  it("updatePoll propage training_day et question", () => {
    const poll = db.createPoll({
      question: "original",
      options: ["A", "B"],
      cron_expression: "0 9 * * 1",
      group_ids: ["g1"],
      training_day: 1,
    });
    const updated = db.updatePoll(poll.id, {
      question: "nouveau",
      training_day: 3,
    });
    expect(updated!.question).toBe("nouveau");
    expect(updated!.training_day).toBe(3);
  });

  it("updatePoll sans training_day conserve la valeur actuelle", () => {
    const poll = db.createPoll({
      question: "q",
      options: ["A", "B"],
      cron_expression: "0 9 * * 2",
      group_ids: ["g1"],
      training_day: 2,
    });
    const updated = db.updatePoll(poll.id, { question: "nouvelle question" });
    expect(updated!.training_day).toBe(2);
  });

  it("updatePoll avec training_day explicite null met à null", () => {
    const poll = db.createPoll({
      question: "q",
      options: ["A", "B"],
      cron_expression: "0 9 * * 2",
      group_ids: ["g1"],
      training_day: 2,
    });
    const updated = db.updatePoll(poll.id, { training_day: null });
    expect(updated!.training_day).toBeNull();
  });

  it("getPollsByTrainingDay retourne uniquement les polls matching", () => {
    db.createPoll({
      question: "lundi",
      options: ["A", "B"],
      cron_expression: "0 9 * * 1",
      group_ids: ["g1"],
      training_day: 1,
    });
    db.createPoll({
      question: "mardi",
      options: ["A", "B"],
      cron_expression: "0 9 * * 2",
      group_ids: ["g1"],
      training_day: 2,
    });
    db.createPoll({
      question: "mardi2",
      options: ["A", "B"],
      cron_expression: "0 18 * * 2",
      group_ids: ["g2"],
      training_day: 2,
    });
    const mardiPolls = db.getPollsByTrainingDay(2);
    expect(mardiPolls).toHaveLength(2);
    expect(mardiPolls.map((p) => p.question).sort()).toEqual(["mardi", "mardi2"]);
  });

  it("getPollsByTrainingDay ignore les polls avec training_day NULL", () => {
    db.createPoll({
      question: "sans",
      options: ["A", "B"],
      cron_expression: "0 9 * * *",
      group_ids: ["g1"],
      training_day: null,
    });
    expect(db.getPollsByTrainingDay(1)).toHaveLength(0);
  });

  it("deletePoll cascade sur poll_sends et poll_votes", () => {
    const poll = db.createPoll({
      question: "q",
      options: ["A", "B"],
      cron_expression: "0 9 * * 1",
      group_ids: ["g1"],
      training_day: 1,
    });
    const sendId = db.recordSend(poll.id, "g1", "msg-1", "Groupe 1");
    db.recordVote(poll.id, sendId, "g1", "voter1", "Alice", ["A"]);
    expect(db.getSendsForPoll(poll.id)).toHaveLength(1);
    db.deletePoll(poll.id);
    expect(db.getPoll(poll.id)).toBeUndefined();
    expect(db.getSendsForPoll(poll.id)).toHaveLength(0);
    expect(db.getVotesForSend(sendId)).toHaveLength(0);
  });
});
