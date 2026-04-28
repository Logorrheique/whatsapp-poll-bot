// Bibliothèque de phrases — CRUD et tirage aléatoire des OPTIONS.
//
// Module extrait dès l'introduction pour ne pas re-grossir db.ts.
// Re-exporté depuis src/db.ts pour rester accessible via
// `import * as db from "./db"`.
//
// Modèle : table `phrases (id, category, text, training_day, created_at)`.
//
// Issue #67 : la bibliothèque ne sert plus qu'aux OPTIONS de réponse.
// Le titre d'un sondage est désormais saisi librement par l'admin dans
// le modal de création (avec subst {jour} via phraseService).
//
// Catégories canoniques utilisées par resolvePollContent :
// - yes      — phrase qui veut dire "oui" (REQUIRED)
// - no       — phrase qui veut dire "non" (REQUIRED)
// - quit     — "je ne veux plus venir" (REQUIRED)
// - injured  — "non je suis blessé" (OPTIONNEL — 4e option si présent)
//
// Catégorie legacy conservée pour compat DB des anciennes installations :
// - title    — ancien titre tiré aléatoirement. Conservé en DB mais
//              ignoré par resolvePollContent. Le champ `training_day`
//              n'est plus que pour cette catégorie legacy.

import { getDb } from "./db";
import type { Phrase } from "./types";

export type CanonicalCategory = "title" | "yes" | "no" | "quit" | "injured";

export const CANONICAL_CATEGORIES: CanonicalCategory[] = [
  "title",
  "yes",
  "no",
  "quit",
  "injured",
];

// Catégories sans lesquelles un poll en mode bibliothèque ne peut PAS être
// envoyé (cf phraseService.resolvePollContent qui retourne null si manque).
// Issue #67 : 'title' retiré — le titre est désormais saisi librement dans
// le modal de création de sondage, seules les options sont tirées.
export const REQUIRED_CATEGORIES: CanonicalCategory[] = ["yes", "no", "quit"];

// Catégories d'options (l'ordre détermine l'ordre dans le sondage WhatsApp).
// 'injured' est ajouté seulement si au moins une phrase existe.
export const OPTION_CATEGORIES_ORDERED: CanonicalCategory[] = [
  "yes",
  "no",
  "quit",
  "injured",
];

// Limite défensive pour empêcher un dictionnaire infini par catégorie.
// Suffisant pour 100+ variations par catégorie sans risque de DoS volume.
export const MAX_PHRASES_PER_CATEGORY = 500;
// Longueur max du texte — WhatsApp Poll limite ~100 chars par option.
export const MAX_PHRASE_LENGTH = 200;

function rowToPhrase(row: any): Phrase {
  return {
    id: row.id,
    category: row.category,
    text: row.text,
    training_day: row.training_day === null || row.training_day === undefined
      ? null
      : Number(row.training_day),
    created_at: row.created_at,
  };
}

export function listPhrases(category?: string): Phrase[] {
  const sql = category
    ? "SELECT * FROM phrases WHERE category = ? ORDER BY category, id DESC"
    : "SELECT * FROM phrases ORDER BY category, id DESC";
  const rows = (category
    ? getDb().prepare(sql).all(category)
    : getDb().prepare(sql).all()) as any[];
  return rows.map(rowToPhrase);
}

export function getPhrase(id: number): Phrase | undefined {
  const row = getDb().prepare("SELECT * FROM phrases WHERE id = ?").get(id) as any;
  return row ? rowToPhrase(row) : undefined;
}

export interface AddPhraseInput {
  category: string;
  text: string;
  training_day?: number | null;
}

export function addPhrase(input: AddPhraseInput): Phrase {
  const cleanCat = String(input.category || "").trim().toLowerCase();
  const cleanText = String(input.text || "").trim();
  if (!cleanCat) throw new Error("Catégorie requise");
  if (!cleanText) throw new Error("Texte requis");
  if (cleanText.length > MAX_PHRASE_LENGTH) {
    throw new Error(`Texte trop long (max ${MAX_PHRASE_LENGTH} caractères)`);
  }
  // training_day uniquement pour 'title' — pour les autres on force null,
  // sinon un dev pourrait croire que ça filtre les options par jour.
  let day: number | null = null;
  if (cleanCat === "title" && input.training_day !== undefined && input.training_day !== null) {
    const d = Number(input.training_day);
    if (!Number.isInteger(d) || d < 0 || d > 6) {
      throw new Error("training_day invalide (0-6 attendu)");
    }
    day = d;
  }

  // Garde-fou volume : refuse si on est déjà à la limite par catégorie.
  const count = (getDb()
    .prepare("SELECT COUNT(*) as c FROM phrases WHERE category = ?")
    .get(cleanCat) as { c: number }).c;
  if (count >= MAX_PHRASES_PER_CATEGORY) {
    throw new Error(`Trop de phrases dans '${cleanCat}' (max ${MAX_PHRASES_PER_CATEGORY})`);
  }

  const result = getDb()
    .prepare(
      "INSERT INTO phrases (category, text, training_day) VALUES (?, ?, ?)"
    )
    .run(cleanCat, cleanText, day);
  const created = getPhrase(result.lastInsertRowid as number);
  if (!created) throw new Error("Insertion phrase échouée");
  return created;
}

export function deletePhrase(id: number): boolean {
  const r = getDb().prepare("DELETE FROM phrases WHERE id = ?").run(id);
  return r.changes > 0;
}

// Issue #67 (cleanup) : supprime toutes les phrases d'une catégorie en une
// fois. Utilisé par l'UI pour purger les phrases legacy 'title' sans avoir
// à les supprimer une par une. Retourne le nombre de phrases supprimées.
export function deletePhrasesByCategory(category: string): number {
  const cleanCat = String(category || "").trim().toLowerCase();
  if (!cleanCat) return 0;
  const r = getDb().prepare("DELETE FROM phrases WHERE category = ?").run(cleanCat);
  return r.changes;
}

// Compte par catégorie — sert à `getPhraseLibraryStatus` pour vérifier si
// les catégories requises sont peuplées avant un envoi avec library.
export function countPhrasesByCategory(): Record<string, number> {
  const rows = getDb()
    .prepare("SELECT category, COUNT(*) as c FROM phrases GROUP BY category")
    .all() as { category: string; c: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.category] = r.c;
  return out;
}

// Compte des titres effectivement disponibles pour un training_day donné :
// titres avec training_day = day OU training_day IS NULL (génériques).
// Sert à valider qu'un poll training_day=2 a au moins UN titre exploitable.
export function countTitlesForDay(trainingDay: number | null): number {
  if (trainingDay === null) {
    return (getDb()
      .prepare("SELECT COUNT(*) as c FROM phrases WHERE category = 'title'")
      .get() as { c: number }).c;
  }
  return (getDb()
    .prepare(
      "SELECT COUNT(*) as c FROM phrases WHERE category = 'title' AND (training_day = ? OR training_day IS NULL)"
    )
    .get(trainingDay) as { c: number }).c;
}

// Tire UNE phrase aléatoire d'une catégorie. Pour 'title' on filtre par
// training_day (matche jour spécifique OU générique sans jour). Retourne
// null si aucune phrase candidate. ORDER BY RANDOM() est OK sur petits
// volumes (< 1000 lignes par catégorie).
export function pickRandomFromCategory(
  category: string,
  trainingDay?: number | null
): Phrase | null {
  let row: any;
  if (category === "title" && trainingDay !== null && trainingDay !== undefined) {
    row = getDb()
      .prepare(
        "SELECT * FROM phrases WHERE category = 'title' AND (training_day = ? OR training_day IS NULL) ORDER BY RANDOM() LIMIT 1"
      )
      .get(trainingDay);
  } else {
    row = getDb()
      .prepare("SELECT * FROM phrases WHERE category = ? ORDER BY RANDOM() LIMIT 1")
      .get(category);
  }
  return row ? rowToPhrase(row) : null;
}
