// Tests resolvePollContent + getPhraseLibraryStatus + getStatusForPoll.
// Couvre les chemins critiques : poll static (pas de library), poll
// library complet, poll library avec catégorie REQUIRED manquante,
// title manquant pour le training_day spécifique, injured optionnel.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../src/whatsapp", () => ({
  getClient: vi.fn().mockReturnValue(null),
  getStatus: vi.fn().mockReturnValue({ ready: false }),
}));

import { makeTempDb } from "../helpers/db";
import * as db from "../../src/db";
import {
  resolvePollContent,
  getPhraseLibraryStatus,
  getStatusForPoll,
  applyDayPlaceholder,
  hasDayPlaceholder,
} from "../../src/services/phraseService";
import type { Poll } from "../../src/types";

function basePoll(overrides: Partial<Poll> = {}): Poll {
  return {
    id: 1,
    question: "Question figée",
    options: ["O1", "O2"],
    cron_expression: "0 9 * * 1",
    group_ids: ["g1@g.us"],
    is_active: true,
    allow_multiple_answers: false,
    training_day: 1,
    created_at: "2026-04-16",
    use_phrase_library: false,
    ...overrides,
  };
}

describe("phraseService — resolvePollContent (mode static)", () => {
  beforeEach(() => {
    makeTempDb();
  });

  it("retourne le contenu figé si use_phrase_library=false", () => {
    const r = resolvePollContent(basePoll());
    expect(r).not.toBeNull();
    expect(r!.source).toBe("static");
    expect(r!.question).toBe("Question figée");
    expect(r!.options).toEqual(["O1", "O2"]);
  });
});

describe("phraseService — resolvePollContent (mode library)", () => {
  beforeEach(() => {
    makeTempDb();
  });

  // Issue #67 : la library ne tire plus que les options. La question vient
  // du poll lui-même (saisie par l'admin). REQUIRED = yes/no/quit, plus title.
  function seedFullOptions(): void {
    db.addPhrase({ category: "yes", text: "Oui je suis là" });
    db.addPhrase({ category: "no", text: "Non" });
    db.addPhrase({ category: "quit", text: "Je quitte le groupe" });
  }

  it("library vide → null", () => {
    const r = resolvePollContent(basePoll({ use_phrase_library: true }));
    expect(r).toBeNull();
  });

  it("manque yes → null", () => {
    db.addPhrase({ category: "no", text: "Non" });
    db.addPhrase({ category: "quit", text: "Quit" });
    const r = resolvePollContent(basePoll({ use_phrase_library: true }));
    expect(r).toBeNull();
  });

  it("manque quit → null", () => {
    db.addPhrase({ category: "yes", text: "Oui" });
    db.addPhrase({ category: "no", text: "Non" });
    const r = resolvePollContent(basePoll({ use_phrase_library: true }));
    expect(r).toBeNull();
  });

  it("question vide → null (même si options présentes)", () => {
    seedFullOptions();
    const r = resolvePollContent(basePoll({ use_phrase_library: true, question: "  " }));
    expect(r).toBeNull();
  });

  it("library complète : question vient du poll, options de la lib", () => {
    seedFullOptions();
    const r = resolvePollContent(
      basePoll({ use_phrase_library: true, question: "Présent ce mardi ?" })
    );
    expect(r).not.toBeNull();
    expect(r!.source).toBe("library");
    expect(r!.question).toBe("Présent ce mardi ?");
    expect(r!.options).toEqual(["Oui je suis là", "Non", "Je quitte le groupe"]);
  });

  it("ajoute injured comme 4e option si présent", () => {
    seedFullOptions();
    db.addPhrase({ category: "injured", text: "Blessé" });
    const r = resolvePollContent(basePoll({ use_phrase_library: true }));
    expect(r).not.toBeNull();
    expect(r!.options).toHaveLength(4);
    expect(r!.options[3]).toBe("Blessé");
  });

  it("question avec {jour} substitué selon training_day du poll", () => {
    seedFullOptions();
    const r2 = resolvePollContent(
      basePoll({ use_phrase_library: true, question: "Es-tu là {jour} ?", training_day: 2 })
    );
    expect(r2?.question).toBe("Es-tu là Mardi ?");
    const r5 = resolvePollContent(
      basePoll({ use_phrase_library: true, question: "Es-tu là {jour} ?", training_day: 5 })
    );
    expect(r5?.question).toBe("Es-tu là Vendredi ?");
  });

  it("picks contient question + phrases utilisées (traçabilité)", () => {
    seedFullOptions();
    const r = resolvePollContent(
      basePoll({ use_phrase_library: true, question: "Test ?" })
    );
    expect(r?.picks?.question).toBe("Test ?");
    expect(r?.picks?.yes).toBe("Oui je suis là");
    expect(r?.picks?.no).toBe("Non");
    expect(r?.picks?.quit).toBe("Je quitte le groupe");
  });
});

describe("phraseService — getPhraseLibraryStatus", () => {
  beforeEach(() => {
    makeTempDb();
  });

  it("library vide : ready=false, missing=[yes,no,quit] (issue #67)", () => {
    const s = getPhraseLibraryStatus();
    expect(s.ready).toBe(false);
    expect(s.missing).toEqual(["yes", "no", "quit"]);
  });

  it("library complète : ready=true, missing=[] (3 catégories suffisent)", () => {
    db.addPhrase({ category: "yes", text: "Y" });
    db.addPhrase({ category: "no", text: "N" });
    db.addPhrase({ category: "quit", text: "Q" });
    const s = getPhraseLibraryStatus();
    expect(s.ready).toBe(true);
    expect(s.missing).toEqual([]);
    expect(s.counts.yes).toBe(1);
  });

  it("partiellement remplie : missing liste les manquantes", () => {
    db.addPhrase({ category: "yes", text: "Y" });
    const s = getPhraseLibraryStatus();
    expect(s.ready).toBe(false);
    expect(s.missing).toEqual(["no", "quit"]);
  });

  it("phrases title autorisées en DB mais ignorées (legacy)", () => {
    db.addPhrase({ category: "title", text: "Legacy title" });
    db.addPhrase({ category: "yes", text: "Y" });
    db.addPhrase({ category: "no", text: "N" });
    db.addPhrase({ category: "quit", text: "Q" });
    const s = getPhraseLibraryStatus();
    expect(s.ready).toBe(true); // pas de title required
    expect(s.counts.title).toBe(1); // mais comptabilisé
  });
});

describe("phraseService — applyDayPlaceholder", () => {
  it("substitue {jour} par le nom du jour FR", () => {
    expect(applyDayPlaceholder("Es-tu là {jour} ?", 2)).toBe("Es-tu là Mardi ?");
    expect(applyDayPlaceholder("Présent {jour} ?", 0)).toBe("Présent Dimanche ?");
    expect(applyDayPlaceholder("Match {jour}", 6)).toBe("Match Samedi");
  });

  it("matche insensiblement à la casse", () => {
    expect(applyDayPlaceholder("{Jour}", 1)).toBe("Lundi");
    expect(applyDayPlaceholder("{JOUR}", 1)).toBe("Lundi");
    expect(applyDayPlaceholder("{jour}", 1)).toBe("Lundi");
  });

  it("substitue plusieurs occurrences", () => {
    expect(applyDayPlaceholder("{jour} ou pas {jour} ?", 5)).toBe(
      "Vendredi ou pas Vendredi ?"
    );
  });

  it("no-op si trainingDay null", () => {
    expect(applyDayPlaceholder("Es-tu là {jour} ?", null)).toBe(
      "Es-tu là {jour} ?"
    );
  });

  it("no-op si pas de placeholder dans le texte", () => {
    expect(applyDayPlaceholder("Pas de placeholder", 2)).toBe("Pas de placeholder");
  });

  it("hasDayPlaceholder détecte la présence", () => {
    expect(hasDayPlaceholder("Es-tu là {jour} ?")).toBe(true);
    expect(hasDayPlaceholder("{Jour}")).toBe(true);
    expect(hasDayPlaceholder("Pas de placeholder")).toBe(false);
  });
});

describe("phraseService — getStatusForPoll (alias de getPhraseLibraryStatus depuis #67)", () => {
  beforeEach(() => {
    makeTempDb();
  });

  it("identique à getPhraseLibraryStatus quel que soit training_day", () => {
    db.addPhrase({ category: "yes", text: "Y" });
    db.addPhrase({ category: "no", text: "N" });
    db.addPhrase({ category: "quit", text: "Q" });
    expect(getStatusForPoll(2).ready).toBe(true);
    expect(getStatusForPoll(5).ready).toBe(true);
    expect(getStatusForPoll(null).ready).toBe(true);
  });

  it("library vide : missing identique pour tous les jours", () => {
    expect(getStatusForPoll(2).missing).toEqual(["yes", "no", "quit"]);
    expect(getStatusForPoll(5).missing).toEqual(["yes", "no", "quit"]);
  });
});
