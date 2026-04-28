import crypto from "crypto";
import { sendDirectMessage, getStatus } from "./whatsapp";
import * as db from "./db";
import { normalizePhone } from "./utils";
import { config } from "./config";
import {
  VERIFICATION_CODE_EXPIRY,
  VERIFICATION_CODE_LENGTH,
  VERIFICATION_MAX_ATTEMPTS,
  VERIFICATION_RATE_LIMIT,
  SESSION_EXPIRY,
  SESSION_CLEANUP_INTERVAL,
  PHONE_MIN_DIGITS,
  PHONE_MAX_DIGITS,
  ONE_MINUTE,
} from "./constants";

// --- Whitelist (SQLite, persistent) ---
export function getWhitelist(): string[] {
  return db.listAllowedPhones();
}

// --- Viewers (read-only role, SQLite) ---
export function getViewers(): string[] {
  return db.listViewers();
}

export function addToViewers(phone: string): boolean {
  return db.addViewer(normalizePhone(phone));
}

export function removeFromViewers(phone: string): boolean {
  return db.removeViewer(normalizePhone(phone));
}

export function isViewer(phone: string): boolean {
  return db.isViewerInDb(normalizePhone(phone));
}

// Lit ADMIN_PHONES au runtime (pas via config figé) pour que les tests
// qui mutent process.env voient l'effet — config capture les valeurs au
// boot, ce qui est bien pour la prod mais piège les tests. Même pattern
// que resolveDbPath() / tz() dans db.ts.
function readAdminsFromEnv(): string[] {
  const raw = process.env.ADMIN_PHONES || process.env.ADMIN_PHONE || config.ADMIN_PHONES || "";
  return raw
    .split(",")
    .map((p) => normalizePhone(p))
    .filter(Boolean);
}

export function isAdmin(phone: string): boolean {
  const normalized = normalizePhone(phone);
  if (!normalized) return false;
  return readAdminsFromEnv().includes(normalized);
}

export function getAdminPhones(): string[] {
  return readAdminsFromEnv();
}

// --- Seed from env on first boot (only if DB tables are empty) ---
export function seedFromEnv(): void {
  // Lecture runtime (pas via config figé) pour faciliter les tests.
  const allowedRaw = process.env.ALLOWED_PHONES || config.ALLOWED_PHONES;
  const viewerRaw = process.env.VIEWER_PHONES || config.VIEWER_PHONES;
  if (db.countAllowedPhones() === 0 && allowedRaw) {
    const phones = allowedRaw.split(",").map((p) => normalizePhone(p)).filter(Boolean);
    for (const p of phones) db.addAllowedPhone(p);
    if (phones.length) console.log(`📥 Seed: ${phones.length} numéro(s) ajoutés à la whitelist depuis ALLOWED_PHONES`);
  }
  if (db.listViewers().length === 0 && viewerRaw) {
    const phones = viewerRaw.split(",").map((p) => normalizePhone(p)).filter(Boolean);
    for (const p of phones) db.addViewer(p);
    if (phones.length) console.log(`📥 Seed: ${phones.length} observateur(s) ajoutés depuis VIEWER_PHONES`);
  }
}

export function removeFromWhitelist(phone: string): boolean {
  return db.removeAllowedPhone(normalizePhone(phone));
}

// --- Config (from constants.ts) ---

// --- In-memory pending codes (short-lived, no need to persist) ---
interface PendingCode {
  code: string;
  phone: string;
  attempts: number;
  createdAt: number;
  lastRequestAt: number;
}

const pendingCodes = new Map<string, PendingCode>();
const MAX_PENDING_CODES = 500;

const PHONE_REGEX = new RegExp(`^[0-9]{${PHONE_MIN_DIGITS},${PHONE_MAX_DIGITS}}$`);

export function isValidPhone(phone: string): boolean {
  return PHONE_REGEX.test(normalizePhone(phone));
}

function phoneToWhatsAppId(phone: string): string {
  // Baileys utilise @s.whatsapp.net (auparavant @c.us en whatsapp-web.js).
  return `${normalizePhone(phone)}@s.whatsapp.net`;
}

// --- Public API ---

export function isPhoneAllowed(phone: string): boolean {
  const normalized = normalizePhone(phone);
  if (db.isViewerInDb(normalized)) return true;
  if (isAdmin(normalized)) return true;
  // If whitelist is empty (no restriction), allow everyone
  if (db.countAllowedPhones() === 0) return true;
  return db.isPhoneInAllowedDb(normalized);
}

export async function requestVerificationCode(
  phone: string
): Promise<{ success: boolean; error?: string }> {
  const normalized = normalizePhone(phone);

  if (!isPhoneAllowed(normalized)) {
    db.addAuditLog(normalized, "auth_rejected", "Numéro non whitelisté");
    return { success: false, error: "Numéro non autorisé" };
  }

  const status = getStatus();
  if (!status.ready) {
    return { success: false, error: "WhatsApp non connecté" };
  }

  const existing = pendingCodes.get(normalized);
  if (existing && Date.now() - existing.lastRequestAt < VERIFICATION_RATE_LIMIT) {
    const waitSec = Math.ceil(
      (VERIFICATION_RATE_LIMIT - (Date.now() - existing.lastRequestAt)) / 1000
    );
    return { success: false, error: `Attendez ${waitSec}s avant de redemander un code` };
  }

  const codeSpace = Math.pow(10, VERIFICATION_CODE_LENGTH);
  const code = String(crypto.randomInt(0, codeSpace)).padStart(VERIFICATION_CODE_LENGTH, "0");

  if (pendingCodes.size >= MAX_PENDING_CODES && !pendingCodes.has(normalized)) {
    const now = Date.now();
    for (const [key, pending] of pendingCodes) {
      if (now - pending.createdAt > VERIFICATION_CODE_EXPIRY) pendingCodes.delete(key);
    }
    if (pendingCodes.size >= MAX_PENDING_CODES) {
      const oldestKey = pendingCodes.keys().next().value;
      if (oldestKey) pendingCodes.delete(oldestKey);
    }
  }

  pendingCodes.set(normalized, {
    code,
    phone: normalized,
    attempts: 0,
    createdAt: Date.now(),
    lastRequestAt: Date.now(),
  });

  try {
    const expiryMin = Math.round(VERIFICATION_CODE_EXPIRY / ONE_MINUTE);
    await sendDirectMessage(
      phoneToWhatsAppId(normalized),
      `🔐 *Code de vérification Poll Bot*\n\nVotre code : *${code}*\n\nCe code expire dans ${expiryMin} minutes.\nNe partagez ce code avec personne.`
    );
    db.addAuditLog(normalized, "code_sent");
    return { success: true };
  } catch (err) {
    pendingCodes.delete(normalized);
    return { success: false, error: "Impossible d'envoyer le code WhatsApp" };
  }
}

export type Role = "admin" | "viewer" | "user";

function computeRole(phone: string, asViewer: boolean): Role | null {
  // If user explicitly chose viewer mode, force viewer
  if (asViewer) return "viewer";
  // User chose admin mode → must be in ADMIN_PHONE, otherwise reject
  if (isAdmin(phone)) return "admin";
  // Not admin and didn't pick viewer → reject so they don't end up downgraded silently
  return null;
}

export function verifyCode(
  phone: string,
  code: string,
  asViewer: boolean = false
): { success: boolean; token?: string; role?: Role; error?: string } {
  const normalized = normalizePhone(phone);
  const pending = pendingCodes.get(normalized);

  if (!pending) {
    return { success: false, error: "Aucun code en attente pour ce numéro" };
  }

  if (Date.now() - pending.createdAt > VERIFICATION_CODE_EXPIRY) {
    pendingCodes.delete(normalized);
    return { success: false, error: "Code expiré, redemandez un nouveau code" };
  }

  if (pending.attempts >= VERIFICATION_MAX_ATTEMPTS) {
    pendingCodes.delete(normalized);
    db.addAuditLog(normalized, "auth_max_attempts");
    return { success: false, error: "Trop de tentatives, redemandez un nouveau code" };
  }

  pending.attempts++;

  // Constant-time comparison to prevent timing attacks
  const codeBuffer = Buffer.from(code);
  const pendingBuffer = Buffer.from(pending.code);
  if (
    codeBuffer.length !== pendingBuffer.length ||
    !crypto.timingSafeEqual(codeBuffer, pendingBuffer)
  ) {
    const remaining = VERIFICATION_MAX_ATTEMPTS - pending.attempts;
    return { success: false, error: `Code incorrect (${remaining} tentative(s) restante(s))` };
  }

  // Success — compute effective role
  const role = computeRole(normalized, asViewer);
  if (role === null) {
    // User picked admin mode but isn't admin
    pendingCodes.delete(normalized);
    db.addAuditLog(normalized, "admin_login_rejected");
    return {
      success: false,
      error: "Vous n'êtes pas administrateur. Reconnectez-vous en mode Observateur ou contactez l'admin.",
    };
  }

  pendingCodes.delete(normalized);
  const token = crypto.randomBytes(32).toString("hex");

  db.createSession(token, normalized, role);
  db.addAuditLog(normalized, "login_success", `role=${role}`);

  return { success: true, token, role };
}

export interface SessionInfo {
  token: string;
  phone: string;
  role: Role;
  created_at: string;
}

export function validateSession(token: string): SessionInfo | null {
  const session = db.getSession(token);
  if (!session) return null;

  const createdAt = new Date(session.created_at + "Z").getTime();
  if (Date.now() - createdAt > SESSION_EXPIRY) {
    db.deleteSession(token);
    return null;
  }

  return { ...session, role: (session.role as Role) || "user" };
}

export function destroySession(token: string): void {
  db.deleteSession(token);
}

/**
 * Extract caller phone from a Bearer Authorization header for audit logging.
 * Returns "unknown" if the token is missing or invalid.
 */
export function getCallerPhone(authHeader: string | undefined): string {
  const token = authHeader?.replace("Bearer ", "") || "";
  const session = validateSession(token);
  return session?.phone || "unknown";
}

// Cleanup expired codes periodically
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, pending] of pendingCodes) {
    if (now - pending.createdAt > VERIFICATION_CODE_EXPIRY) pendingCodes.delete(key);
  }
  db.deleteExpiredSessions(SESSION_EXPIRY);
}, SESSION_CLEANUP_INTERVAL);
// unref : ne garde pas le process vivant pour lui seul (utile en tests)
cleanupTimer.unref();

// Surface utilisée exclusivement par les tests unit (auth.test.ts) — on expose
// ce que la Map pending cache pour pouvoir vérifier les flows sans hack
// d'interception de `client.sendMessage`. Ne PAS consommer ailleurs.
export const _testing = {
  getPendingCode(phone: string): string | undefined {
    const normalized = normalizePhone(phone);
    return pendingCodes.get(normalized)?.code;
  },
};
