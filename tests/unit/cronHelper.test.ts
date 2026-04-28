import { describe, it, expect } from "vitest";
import {
  scheduleToCron,
  cronToSchedule,
  scheduleToHuman,
  cronToHuman,
  pollDisplayTitle,
  DAY_NAMES,
} from "../../src/cronHelper";

describe("DAY_NAMES", () => {
  it("exporte les noms de jours français dans l'ordre cron 0=Dim..6=Sam", () => {
    expect(DAY_NAMES).toEqual([
      "Dimanche",
      "Lundi",
      "Mardi",
      "Mercredi",
      "Jeudi",
      "Vendredi",
      "Samedi",
    ]);
  });
});

describe("scheduleToCron", () => {
  it("daily → minute hour * * *", () => {
    expect(scheduleToCron({ frequency: "daily", hour: 9, minute: 0 })).toBe("0 9 * * *");
  });
  it("weekdays → minute hour * * 1-5", () => {
    expect(scheduleToCron({ frequency: "weekdays", hour: 8, minute: 30 })).toBe(
      "30 8 * * 1-5"
    );
  });
  it("weekly → minute hour * * day", () => {
    expect(scheduleToCron({ frequency: "weekly", day: 2, hour: 18, minute: 0 })).toBe(
      "0 18 * * 2"
    );
  });
  it("weekly avec day manquant → défaut Lundi (1)", () => {
    expect(scheduleToCron({ frequency: "weekly", hour: 9, minute: 0 })).toBe("0 9 * * 1");
  });
  it("monthly → minute hour monthDay * *", () => {
    expect(
      scheduleToCron({ frequency: "monthly", monthDay: 15, hour: 10, minute: 45 })
    ).toBe("45 10 15 * *");
  });
});

describe("cronToSchedule", () => {
  it("parse daily", () => {
    expect(cronToSchedule("0 9 * * *")).toEqual({ frequency: "daily", hour: 9, minute: 0 });
  });
  it("parse weekdays", () => {
    expect(cronToSchedule("30 8 * * 1-5")).toEqual({
      frequency: "weekdays",
      hour: 8,
      minute: 30,
    });
  });
  it("parse weekly", () => {
    expect(cronToSchedule("0 18 * * 2")).toEqual({
      frequency: "weekly",
      day: 2,
      hour: 18,
      minute: 0,
    });
  });
  it("parse monthly", () => {
    expect(cronToSchedule("45 10 15 * *")).toEqual({
      frequency: "monthly",
      monthDay: 15,
      hour: 10,
      minute: 45,
    });
  });
  it("retourne null sur cron malformée (< 5 parties)", () => {
    expect(cronToSchedule("0 9 * *")).toBeNull();
  });

  // Regression #19 : cronToSchedule ne doit PAS classer silencieusement les
  // patterns multi-jours via parseInt tronqué.
  describe("regression #19 — ne classe pas faussement les multi-jours", () => {
    it("weekend 0,6 retourne null", () => {
      expect(cronToSchedule("0 9 * * 0,6")).toBeNull();
    });
    it("custom_days 2,4 retourne null (pas weekly-Mardi)", () => {
      expect(cronToSchedule("0 18 * * 2,4")).toBeNull();
    });
    it("custom_days 1,3,5 retourne null", () => {
      expect(cronToSchedule("0 18 * * 1,3,5")).toBeNull();
    });
    it("biweekly 1-7,15-21 * 2 retourne null (dom != *)", () => {
      expect(cronToSchedule("0 9 1-7,15-21 * 2")).toBeNull();
    });
    it("test pattern */5 retourne null (minute non entière)", () => {
      expect(cronToSchedule("*/5 * * * *")).toBeNull();
    });
    it("hour */2 retourne null", () => {
      expect(cronToSchedule("0 */2 * * *")).toBeNull();
    });
    it("month != * retourne null", () => {
      expect(cronToSchedule("0 9 * 6 2")).toBeNull();
    });
    it("dow > 6 retourne null", () => {
      expect(cronToSchedule("0 9 * * 7")).toBeNull();
    });
    it("dom 32 retourne null (invalide)", () => {
      expect(cronToSchedule("0 9 32 * *")).toBeNull();
    });
  });
});

describe("scheduleToHuman", () => {
  it("daily lisible", () => {
    expect(scheduleToHuman({ frequency: "daily", hour: 9, minute: 0 })).toBe(
      "Tous les jours a 09:00"
    );
  });
  it("weekly injecte le bon jour", () => {
    expect(
      scheduleToHuman({ frequency: "weekly", day: 2, hour: 18, minute: 30 })
    ).toBe("Chaque Mardi a 18:30");
  });
});

describe("cronToHuman", () => {
  it("fallback sur la cron brute si non reconnue (moins de 5 parties)", () => {
    const weirdCron = "0 9 * *";
    expect(cronToHuman(weirdCron)).toBe(weirdCron);
  });
});

describe("pollDisplayTitle", () => {
  it("retourne la question non-vide telle quelle", () => {
    expect(
      pollDisplayTitle({ question: "Dispo cette semaine ?", training_day: 2 })
    ).toBe("Dispo cette semaine ?");
  });
  it("trim les espaces et garde la question si non vide", () => {
    expect(pollDisplayTitle({ question: "  Salut  ", training_day: 1 })).toBe("Salut");
  });
  it('question vide + training_day → "Entrainement {jour}"', () => {
    expect(pollDisplayTitle({ question: "", training_day: 2 })).toBe("Entrainement Mardi");
    expect(pollDisplayTitle({ question: "   ", training_day: 4 })).toBe(
      "Entrainement Jeudi"
    );
  });
  it('question vide + training_day null → "Entrainement" sans jour', () => {
    expect(pollDisplayTitle({ question: "", training_day: null })).toBe("Entrainement");
  });
});
