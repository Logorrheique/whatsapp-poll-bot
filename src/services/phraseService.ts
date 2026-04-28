// Service de résolution de contenu poll — bibliothèque de phrases.
//
// Mode static (use_phrase_library=false) : retourne le contenu figé du poll.
// Mode library (use_phrase_library=true) :
//   - question : celle du poll, avec subst du placeholder {jour} → nom du jour FR
//   - options  : tirées aléatoirement dans la bibliothèque (yes/no/quit + injured)
//
// Issue #67 : auparavant la catégorie 'title' de la bibliothèque servait
// pour le titre du sondage. Le titre est désormais saisi librement par
// l'admin dans le modal de création — la bibliothèque ne sert plus que
// pour les options de réponse.
//
// Si une catégorie REQUIRED (yes/no/quit) manque OU si la question est
// vide, resolvePollContent retourne null. Le caller (scheduler ou route
// /send) doit logger + alerter sans crasher.

import {
  pickRandomFromCategory,
  countPhrasesByCategory,
  REQUIRED_CATEGORIES,
  OPTION_CATEGORIES_ORDERED,
  type CanonicalCategory,
} from "../db-phrases";
import type { Poll } from "../types";

// Substitution dynamique du jour d'entraînement dans la question.
// Permet à UNE question ("Es-tu là {jour} ?") de servir pour tous les jours.
// Match insensible à la casse pour absorber {Jour}, {JOUR}, {jour}.
const DAY_NAMES_FR = [
  "Dimanche",
  "Lundi",
  "Mardi",
  "Mercredi",
  "Jeudi",
  "Vendredi",
  "Samedi",
];

// Pas de regex `/g` partagée : `RegExp.test` avec /g garde lastIndex
// entre appels et alterne true/false. Chaque call instancie sa regex.
export function applyDayPlaceholder(
  text: string,
  trainingDay: number | null
): string {
  if (trainingDay === null || trainingDay === undefined) return text;
  const name = DAY_NAMES_FR[trainingDay];
  if (!name) return text;
  return text.replace(/\{jour\}/gi, name);
}

export function hasDayPlaceholder(text: string): boolean {
  return /\{jour\}/i.test(text);
}

export interface ResolvedPollContent {
  question: string;
  options: string[];
  source: "static" | "library";
  /** Phrases utilisées par catégorie — utile pour traçabilité dans les logs */
  picks?: Record<string, string>;
}

export interface PhraseLibraryStatus {
  /** True si toutes les catégories REQUIRED ont au moins une phrase */
  ready: boolean;
  /** Catégories REQUIRED vides (bloquantes pour l'envoi) */
  missing: CanonicalCategory[];
  /** Compteurs par catégorie pour affichage UI */
  counts: Record<string, number>;
}

export function getPhraseLibraryStatus(): PhraseLibraryStatus {
  const counts = countPhrasesByCategory();
  const missing = REQUIRED_CATEGORIES.filter((cat) => !counts[cat] || counts[cat] === 0);
  return {
    ready: missing.length === 0,
    missing,
    counts,
  };
}

// Issue #67 : 'title' n'est plus filtré par jour (saisi librement par
// l'admin). Cette fonction reste pour compat avec les callers
// (route /diagnose, modal sondage status indicator).
export function getStatusForPoll(_trainingDay: number | null): PhraseLibraryStatus {
  return getPhraseLibraryStatus();
}

export function resolvePollContent(poll: Poll): ResolvedPollContent | null {
  if (!poll.use_phrase_library) {
    return {
      question: poll.question,
      options: poll.options,
      source: "static",
    };
  }

  // Mode library : la question vient du poll (subst {jour}), les options
  // sont tirées dans la bibliothèque.
  const question = applyDayPlaceholder(poll.question || "", poll.training_day).trim();
  if (!question) return null;

  const picks: Record<string, string> = { question };
  const options: string[] = [];

  for (const cat of OPTION_CATEGORIES_ORDERED) {
    const phrase = pickRandomFromCategory(cat);
    if (!phrase) {
      if ((REQUIRED_CATEGORIES as string[]).includes(cat)) return null;
      continue;
    }
    picks[cat] = phrase.text;
    options.push(phrase.text);
  }

  if (options.length < 2) return null;

  return {
    question,
    options,
    source: "library",
    picks,
  };
}
