// CRUD bibliothèque de phrases.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../src/whatsapp", () => ({
  getClient: vi.fn().mockReturnValue(null),
  getStatus: vi.fn().mockReturnValue({ ready: false }),
}));

import { makeTempDb } from "../helpers/db";
import * as db from "../../src/db";

describe("db-phrases — CRUD", () => {
  beforeEach(() => {
    makeTempDb();
  });

  it("addPhrase + listPhrases retourne la phrase", () => {
    const p = db.addPhrase({ category: "yes", text: "Présent !" });
    expect(p.id).toBeGreaterThan(0);
    expect(p.category).toBe("yes");
    expect(p.text).toBe("Présent !");
    expect(p.training_day).toBeNull();

    const list = db.listPhrases("yes");
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(p.id);
  });

  it("normalise category en lowercase et trim", () => {
    const p = db.addPhrase({ category: "  YES  ", text: "  Oui  " });
    expect(p.category).toBe("yes");
    expect(p.text).toBe("Oui");
  });

  it("rejette text vide", () => {
    expect(() => db.addPhrase({ category: "yes", text: "   " })).toThrow();
  });

  it("rejette category vide", () => {
    expect(() => db.addPhrase({ category: "", text: "Présent" })).toThrow();
  });

  // Issue #67 : 'title' est legacy mais l'API DB doit rester compatible
  // pour ne pas casser les installations qui ont déjà des phrases title.
  it("training_day n'est gardé que pour category=title (legacy compat)", () => {
    const yes = db.addPhrase({ category: "yes", text: "Oui", training_day: 3 });
    expect(yes.training_day).toBeNull();
    const title = db.addPhrase({ category: "title", text: "Mardi", training_day: 2 });
    expect(title.training_day).toBe(2);
  });

  it("rejette training_day hors borne (legacy compat)", () => {
    expect(() =>
      db.addPhrase({ category: "title", text: "X", training_day: 7 })
    ).toThrow();
    expect(() =>
      db.addPhrase({ category: "title", text: "X", training_day: -1 })
    ).toThrow();
  });

  it("deletePhrase retourne true puis false", () => {
    const p = db.addPhrase({ category: "no", text: "Non" });
    expect(db.deletePhrase(p.id)).toBe(true);
    expect(db.deletePhrase(p.id)).toBe(false);
    expect(db.listPhrases("no")).toHaveLength(0);
  });

  it("countPhrasesByCategory aggrège correctement", () => {
    db.addPhrase({ category: "yes", text: "A" });
    db.addPhrase({ category: "yes", text: "B" });
    db.addPhrase({ category: "no", text: "Non" });
    const counts = db.countPhrasesByCategory();
    expect(counts.yes).toBe(2);
    expect(counts.no).toBe(1);
    expect(counts.quit).toBeUndefined();
  });

  it("countTitlesForDay : matche jour spécifique OU générique (legacy)", () => {
    // Issue #67 : countTitlesForDay n'est plus appelé par le runtime mais
    // reste exporté + testé pour valider le filtre SQL au cas où on
    // réintroduirait un mode "titre via library".
    db.addPhrase({ category: "title", text: "Mardi spé", training_day: 2 });
    db.addPhrase({ category: "title", text: "Générique" }); // training_day = null
    db.addPhrase({ category: "title", text: "Lundi spé", training_day: 1 });

    expect(db.countTitlesForDay(2)).toBe(2); // mardi + générique
    expect(db.countTitlesForDay(1)).toBe(2); // lundi + générique
    expect(db.countTitlesForDay(3)).toBe(1); // seulement générique
    expect(db.countTitlesForDay(null)).toBe(3); // tous
  });

  it("pickRandomFromCategory : retourne null si vide", () => {
    expect(db.pickRandomFromCategory("yes")).toBeNull();
  });

  it("pickRandomFromCategory : tirage déterministe avec une seule phrase", () => {
    db.addPhrase({ category: "yes", text: "Solo" });
    const r = db.pickRandomFromCategory("yes");
    expect(r?.text).toBe("Solo");
  });

  // Issue #67 : tests de filtre training_day sur 'title' conservés
  // (legacy compat — pickRandomFromCategory garde sa signature). Si plus
  // tard 'title' est totalement supprimé, retirer ces deux tests.
  it("pickRandomFromCategory pour 'title' filtre par training_day (legacy)", () => {
    db.addPhrase({ category: "title", text: "Mardi exclusif", training_day: 2 });
    db.addPhrase({ category: "title", text: "Lundi exclusif", training_day: 1 });

    for (let i = 0; i < 5; i++) {
      const r = db.pickRandomFromCategory("title", 2);
      expect(r?.text).toBe("Mardi exclusif");
    }
  });

  it("pickRandomFromCategory pour 'title' inclut les génériques (legacy)", () => {
    db.addPhrase({ category: "title", text: "Mardi", training_day: 2 });
    db.addPhrase({ category: "title", text: "Générique" }); // null

    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const r = db.pickRandomFromCategory("title", 2);
      if (r) seen.add(r.text);
    }
    expect(seen.has("Mardi")).toBe(true);
    expect(seen.has("Générique")).toBe(true);
  });

  it("limite défensive MAX_PHRASE_LENGTH", () => {
    const longText = "x".repeat(500);
    expect(() => db.addPhrase({ category: "yes", text: longText })).toThrow(/trop long/i);
  });
});
