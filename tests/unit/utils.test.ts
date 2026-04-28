import { describe, it, expect } from "vitest";
import {
  DATE_REGEX,
  GROUP_ID_REGEX,
  normalizePhone,
  localDateToUtcBoundsSqlite,
} from "../../src/utils";

describe("DATE_REGEX", () => {
  it("accepte YYYY-MM-DD", () => {
    expect(DATE_REGEX.test("2026-04-15")).toBe(true);
    expect(DATE_REGEX.test("1999-12-31")).toBe(true);
  });
  it("rejette les formats invalides", () => {
    expect(DATE_REGEX.test("2026-4-15")).toBe(false);
    expect(DATE_REGEX.test("2026/04/15")).toBe(false);
    expect(DATE_REGEX.test("")).toBe(false);
    expect(DATE_REGEX.test("abcd-ef-gh")).toBe(false);
  });
});

describe("GROUP_ID_REGEX", () => {
  it("accepte les IDs WA typiques", () => {
    expect(GROUP_ID_REGEX.test("120363000000000000@g.us")).toBe(true);
    expect(GROUP_ID_REGEX.test("test-group_1.name")).toBe(true);
  });
  it("rejette caractères interdits et longueurs extrêmes", () => {
    expect(GROUP_ID_REGEX.test("")).toBe(false);
    expect(GROUP_ID_REGEX.test("avec espace")).toBe(false);
    expect(GROUP_ID_REGEX.test("a".repeat(101))).toBe(false);
  });
});

describe("normalizePhone", () => {
  it("strip tous les non-digits", () => {
    expect(normalizePhone("+33 6 12 34 56 78")).toBe("33612345678");
    expect(normalizePhone("(555) 123-4567")).toBe("5551234567");
  });
  it("retourne chaine vide si aucun digit", () => {
    expect(normalizePhone("abc")).toBe("");
  });
});

// getCallerPhone couvert indirectement par les tests d'intégration routes —
// il dépend de la DB via validateSession (auth.ts).

// Regression C1 — localDateToUtcBoundsSqlite : conversion timezone-aware
// pour matcher les dates locales contre des timestamps UTC en DB.
describe("localDateToUtcBoundsSqlite", () => {
  it("Europe/Paris été (CEST UTC+2) : 2024-06-19 → [18 22:00, 19 22:00]", () => {
    const { startUtc, endUtc } = localDateToUtcBoundsSqlite(
      "2024-06-19",
      "Europe/Paris"
    );
    expect(startUtc).toBe("2024-06-18 22:00:00");
    expect(endUtc).toBe("2024-06-19 22:00:00");
  });

  it("Europe/Paris hiver (CET UTC+1) : 2024-12-15 → [14 23:00, 15 23:00]", () => {
    const { startUtc, endUtc } = localDateToUtcBoundsSqlite(
      "2024-12-15",
      "Europe/Paris"
    );
    expect(startUtc).toBe("2024-12-14 23:00:00");
    expect(endUtc).toBe("2024-12-15 23:00:00");
  });

  it("UTC : 2024-06-19 → [19 00:00, 20 00:00]", () => {
    const { startUtc, endUtc } = localDateToUtcBoundsSqlite(
      "2024-06-19",
      "UTC"
    );
    expect(startUtc).toBe("2024-06-19 00:00:00");
    expect(endUtc).toBe("2024-06-20 00:00:00");
  });

  it("America/New_York hiver (EST UTC-5) : 2024-12-15 → [15 05:00, 16 05:00]", () => {
    const { startUtc, endUtc } = localDateToUtcBoundsSqlite(
      "2024-12-15",
      "America/New_York"
    );
    expect(startUtc).toBe("2024-12-15 05:00:00");
    expect(endUtc).toBe("2024-12-16 05:00:00");
  });

  it("transition DST (Paris 2025-03-30, on saute 2h→3h) : 2025-03-30 → [29 23:00, 30 22:00]", () => {
    // Le 30 mars 2025 à Paris ne fait que 23h (on passe de 2h à 3h).
    // Le jour commence à 00:00 CET (= 2025-03-29 23:00 UTC)
    // et finit à 24:00 CEST (= 2025-03-30 22:00 UTC)
    const { startUtc, endUtc } = localDateToUtcBoundsSqlite(
      "2025-03-30",
      "Europe/Paris"
    );
    expect(startUtc).toBe("2025-03-29 23:00:00");
    expect(endUtc).toBe("2025-03-30 22:00:00");
  });

  it("rejette une date mal formée", () => {
    expect(() => localDateToUtcBoundsSqlite("2024-6-1", "Europe/Paris")).toThrow();
    expect(() => localDateToUtcBoundsSqlite("abc", "Europe/Paris")).toThrow();
  });
});
