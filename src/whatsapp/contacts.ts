// Contact name cache & résolution — adapté Baileys.
//
// Baileys (contrairement à whatsapp-web.js) n'a pas d'API "getContactById".
// On collecte les pushName en passif depuis chaque message reçu via
// trackContactName() (appelé depuis whatsapp.ts dans le handler messages.upsert)
// et on retourne ce qu'on a en cache. À défaut on retourne le numéro de
// téléphone (extrait du JID).
//
// Sanitise (strip control chars + HTML-significatifs) pour défense XSS en
// profondeur (le frontend escape aussi via h()).

import { CONTACT_CACHE_TTL, CONTACT_NAME_MAX_LENGTH } from "../constants";

const contactNameCache = new Map<string, { name: string; cachedAt: number }>();
// Borne RAM : un envoi vers gros groupe pourrait gonfler le cache sans plafond
// (1 entrée ≈ 200 octets, 1000 entrées ≈ 200 Ko). FIFO simple — l'ordre
// d'insertion d'une Map JS est préservé, donc keys().next() = plus ancien.
const MAX_CONTACT_CACHE_SIZE = 1000;

export function clearContactCache(): void {
  contactNameCache.clear();
}

export function sanitizeContactName(raw: string | null | undefined, fallback: string): string {
  const name = String(raw || "")
    .replace(/[\x00-\x1F\x7F]/g, "") // control chars (regex hex escapes)
    .replace(/[<>"'&`]/g, "") // HTML/JS dangerous chars
    .trim()
    .substring(0, CONTACT_NAME_MAX_LENGTH);
  return name || fallback;
}

// Appelé depuis whatsapp.ts à chaque messages.upsert qui a un pushName.
// Met à jour ou rafraîchit le cache (TTL repart de zéro).
export function trackContactName(jid: string, pushName: string): void {
  const sanitized = sanitizeContactName(pushName, "");
  if (!sanitized) return;
  if (contactNameCache.size >= MAX_CONTACT_CACHE_SIZE && !contactNameCache.has(jid)) {
    const oldestKey = contactNameCache.keys().next().value;
    if (oldestKey) contactNameCache.delete(oldestKey);
  }
  contactNameCache.set(jid, { name: sanitized, cachedAt: Date.now() });
}

// Lookup synchrone : on a le nom OU on retourne le numéro depuis le JID.
// On garde une signature async pour ne pas casser les callers existants
// (whatsapp.ts itère + await dans refreshAllVoterNames).
export async function resolveContactName(jid: string): Promise<string> {
  const cached = contactNameCache.get(jid);
  if (cached && Date.now() - cached.cachedAt < CONTACT_CACHE_TTL) {
    return cached.name;
  }
  // Pas en cache (ou expiré) → numéro extrait du JID.
  const phone = jid.split("@")[0].split(":")[0];
  return phone || jid;
}
