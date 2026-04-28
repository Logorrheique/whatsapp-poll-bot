import { describe, it, expect } from "vitest";
import { computeYesterdayInTimezone } from "../../src/scheduler";

describe("computeYesterdayInTimezone", () => {
  it("retourne la veille en Europe/Paris (été, heure d'été)", () => {
    // 15 juillet 2026 à 08h00 Paris = 2026-07-15T06:00:00Z
    const now = new Date("2026-07-15T06:00:00Z");
    const { date, dow } = computeYesterdayInTimezone("Europe/Paris", now);
    expect(date).toBe("2026-07-14");
    // 14/07/2026 tombe un mardi → dow = 2
    expect(dow).toBe(2);
  });

  it("retourne la veille en Europe/Paris (hiver, heure normale)", () => {
    // 3 janvier 2026 à 08h00 Paris = 2026-01-03T07:00:00Z
    const now = new Date("2026-01-03T07:00:00Z");
    const { date, dow } = computeYesterdayInTimezone("Europe/Paris", now);
    expect(date).toBe("2026-01-02");
    // 02/01/2026 tombe un vendredi → dow = 5
    expect(dow).toBe(5);
  });

  it("gère le passage à l'heure d'été (dernier dimanche de mars)", () => {
    // Dimanche 29 mars 2026 à 03h30 Paris = 2026-03-29T01:30:00Z (DST en vigueur)
    // On teste le cron 8h → 2026-03-29T06:00:00Z
    const now = new Date("2026-03-29T06:00:00Z");
    const { date, dow } = computeYesterdayInTimezone("Europe/Paris", now);
    expect(date).toBe("2026-03-28");
    // Samedi 28 mars 2026 → dow = 6
    expect(dow).toBe(6);
  });

  it("après minuit Paris mais avant minuit UTC → veille Paris pas veille UTC", () => {
    // 14 avril 2026 à 00h30 Paris = 2026-04-13T22:30:00Z
    const now = new Date("2026-04-13T22:30:00Z");
    const { date } = computeYesterdayInTimezone("Europe/Paris", now);
    // Paris est le 14, donc hier Paris = 13
    expect(date).toBe("2026-04-13");
  });

  it("timezone UTC retourne la veille UTC", () => {
    const now = new Date("2026-04-15T08:00:00Z");
    const { date, dow } = computeYesterdayInTimezone("UTC", now);
    expect(date).toBe("2026-04-14");
    expect(dow).toBe(2); // mardi
  });
});
