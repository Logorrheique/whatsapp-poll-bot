// Centralized constants — no magic numbers scattered across the codebase.

// --- Time durations (milliseconds) ---
export const ONE_SECOND = 1_000;
export const ONE_MINUTE = 60 * ONE_SECOND;
export const ONE_HOUR = 60 * ONE_MINUTE;
export const ONE_DAY = 24 * ONE_HOUR;

// --- Auth ---
export const VERIFICATION_CODE_EXPIRY = 15 * ONE_MINUTE;
export const VERIFICATION_CODE_LENGTH = 6;
export const VERIFICATION_MAX_ATTEMPTS = 5;
export const VERIFICATION_RATE_LIMIT = ONE_MINUTE;
export const SESSION_EXPIRY = ONE_DAY;
export const SESSION_CLEANUP_INTERVAL = ONE_MINUTE;

// --- Rate limiters (Express) ---
export const AUTH_RATE_WINDOW = 15 * ONE_MINUTE;
export const AUTH_RATE_MAX = 10;
export const API_RATE_WINDOW = ONE_MINUTE;
export const API_RATE_MAX = 60;
export const QR_RATE_WINDOW = ONE_HOUR;
export const QR_RATE_MAX = 5;

// --- Data retention ---
export const DEFAULT_DAYS_KEPT = 21;
export const DISPLAY_DAYS_KEPT = 9;
export const AUDIT_LOGS_DAYS_KEPT = 90;

// --- Periodic tasks ---
export const DB_BACKUP_INTERVAL = 6 * ONE_HOUR;
export const OLD_SENDS_CLEANUP_INTERVAL = ONE_DAY;
export const SNAPSHOT_CRON = "0 8 * * *";

// --- WhatsApp ---
export const CONTACT_CACHE_TTL = ONE_HOUR;
export const CONTACT_NAME_MAX_LENGTH = 80;
export const PAIR_REQUEST_COOLDOWN = ONE_MINUTE;
export const PAIR_RATE_LIMIT_LOCKOUT = ONE_HOUR;
export const WA_INIT_SOFT_TIMEOUT = 5 * ONE_SECOND;
export const WA_INIT_HARD_TIMEOUT = 150 * ONE_SECOND;
export const WA_RETRY_DELAY = 10 * ONE_SECOND;
export const WA_SEND_POLL_DELAY = ONE_SECOND;

// --- Backup store ---
export const BACKUP_KEEP_LAST_N = 30;

// --- Online presence ---
export const ONLINE_WINDOW = 5 * ONE_MINUTE;

// --- Phone validation ---
export const PHONE_MIN_DIGITS = 8;
export const PHONE_MAX_DIGITS = 15;

// --- Default timezone ---
export const DEFAULT_TIMEZONE = "Europe/Paris";
