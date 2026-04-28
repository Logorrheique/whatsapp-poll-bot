import Database from "better-sqlite3";
import path from "path";
import type {
  Poll,
  PollSend,
  PollVote,
  CreatePollInput,
  PollResultsSnapshot,
} from "./types";
import { DEFAULT_DAYS_KEPT, ONE_DAY } from "./constants";
import { localDateToUtcBoundsSqlite } from "./utils";
import { config, readEnv } from "./config";

function tz(): string {
  // Runtime read (cf issue #64 — exception documentée dans config.ts).
  return readEnv("TIMEZONE") || config.TIMEZONE;
}

function resolveDbPath(): string {
  return (
    readEnv("POLLS_DB_PATH") ||
    path.join(__dirname, "..", "data", "polls.db")
  );
}

let db: Database.Database;
let currentDbPath: string = "";

export function initDb(): void {
  currentDbPath = resolveDbPath();
  db = new Database(currentDbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  // Tight-RAM tuning (Railway Hobby 512 Mo) — cf. Concepts/Optimisations ressources :
  // temp_store=FILE pour ne pas garder les sorts/group_by en RAM,
  // cache_size=-4000 (4 Mo) au lieu de 32 Mo, mmap_size=16 Mo au lieu de 128 Mo.
  // Latence I/O négligeable pour le workload du bot (<100 req/min).
  db.pragma("temp_store = FILE");
  db.pragma("cache_size = -4000");
  db.pragma("mmap_size = 16777216");
  db.pragma("wal_autocheckpoint = 1000");
  db.pragma("journal_size_limit = 8388608");

  db.exec(`
    CREATE TABLE IF NOT EXISTS polls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL,
      options TEXT NOT NULL,
      cron_expression TEXT NOT NULL,
      group_ids TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      allow_multiple_answers INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS poll_sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      poll_id INTEGER NOT NULL,
      group_id TEXT NOT NULL,
      group_name TEXT,
      message_id TEXT,
      options_sent TEXT,
      sent_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS poll_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      poll_id INTEGER NOT NULL,
      send_id INTEGER,
      group_id TEXT NOT NULL,
      voter TEXT NOT NULL,
      voter_name TEXT DEFAULT '',
      selected_options TEXT NOT NULL,
      voted_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
      FOREIGN KEY (send_id) REFERENCES poll_sends(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      created_at TEXT DEFAULT (datetime('now')),
      last_seen_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS poll_message_map (
      message_id TEXT PRIMARY KEY,
      poll_id INTEGER NOT NULL,
      send_id INTEGER,
      wa_message_proto BLOB,
      FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
      FOREIGN KEY (send_id) REFERENCES poll_sends(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS viewers (
      phone TEXT PRIMARY KEY,
      added_at TEXT DEFAULT (datetime('now'))
    );

    -- Issue #53 : table normalisée des options sélectionnées par vote.
    -- Avant : selected_options stocké en TEXT JSON dans poll_votes, non
    -- queryable. Ici : une ligne par (vote, option), indexable, agrégations
    -- SQL natives. recordVote écrit dans les DEUX tables (la JSON reste
    -- pour les imports/restaurations, les queries analytiques doivent
    -- préférer poll_vote_options).
    CREATE TABLE IF NOT EXISTS poll_vote_options (
      vote_id INTEGER NOT NULL,
      option TEXT NOT NULL,
      PRIMARY KEY (vote_id, option),
      FOREIGN KEY (vote_id) REFERENCES poll_votes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS allowed_phones (
      phone TEXT PRIMARY KEY,
      added_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS poll_results_snapshot (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      poll_id INTEGER NOT NULL,
      send_id INTEGER,
      training_date TEXT NOT NULL,
      training_day INTEGER NOT NULL,
      summary TEXT NOT NULL,
      total_votes INTEGER NOT NULL DEFAULT 0,
      display_title TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      question_raw TEXT,
      cron_expression TEXT,
      group_ids TEXT,
      expected_count INTEGER,
      UNIQUE(poll_id, training_date),
      FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
      FOREIGN KEY (send_id) REFERENCES poll_sends(id) ON DELETE SET NULL
    );

    -- Bibliothèque de phrases : permet à un poll avec use_phrase_library=1
    -- de tirer aléatoirement son titre + ses options à chaque envoi parmi
    -- les phrases enregistrées par catégorie. Les catégories canoniques :
    -- 'title', 'yes', 'no', 'quit', 'injured'. training_day n'est utilisé
    -- que pour la catégorie 'title' (filtre par jour). Les autres catégories
    -- ignorent training_day. Cf src/db-phrases.ts.
    CREATE TABLE IF NOT EXISTS phrases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      text TEXT NOT NULL,
      training_day INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Migrations pour DB existantes (ajoute send_id, group_name, role, last_seen_at, training_day si absents)
  // Doit tourner AVANT la creation des index qui referencent des colonnes ajoutees par migration
  migrate();

  // Index crees APRES migrate() pour garantir que les colonnes (send_id, training_day, ...)
  // existent avant qu'on tente de les indexer. Sur une DB legacy v1.0, idx_votes_send ne peut
  // etre cree qu'apres l'ALTER TABLE poll_votes ADD COLUMN send_id.
  //
  // Issue #39 : ajout des 5 indexes manquants. Les requêtes ciblées faisaient
  // full scan : getPollsByTrainingDay (training_day sur polls, pas snapshot),
  // getVotesForPoll (poll_id + voted_at), getAuditLogs (ORDER BY created_at),
  // createSession/getOnlineUsers (phone, last_seen_at), et le FK
  // poll_message_map(send_id) utilisé dans la cascade de delete.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sends_poll_date ON poll_sends(poll_id, sent_at DESC);
    CREATE INDEX IF NOT EXISTS idx_votes_send ON poll_votes(send_id);
    CREATE INDEX IF NOT EXISTS idx_snapshot_poll_date ON poll_results_snapshot(poll_id, training_date DESC);
    CREATE INDEX IF NOT EXISTS idx_snapshot_training_day ON poll_results_snapshot(training_day);
    CREATE INDEX IF NOT EXISTS idx_polls_training_day ON polls(training_day) WHERE training_day IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_votes_poll_date ON poll_votes(poll_id, voted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_phone ON sessions(phone);
    CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_poll_message_map_send ON poll_message_map(send_id);
    CREATE INDEX IF NOT EXISTS idx_vote_options_option ON poll_vote_options(option);
    CREATE INDEX IF NOT EXISTS idx_phrases_category ON phrases(category);
  `);

  // Issue #53 : backfill one-shot de selected_options (JSON) vers
  // poll_vote_options (normalisé). Ne touche que les votes dont l'ID
  // n'a encore AUCUNE entrée dans poll_vote_options — idempotent, ré-entrant.
  backfillVoteOptions();
}

// Expose pour tests : copie chaque option JSON dans poll_vote_options.
// Safe à appeler plusieurs fois — INSERT OR IGNORE sur la PK (vote_id, option).
function backfillVoteOptions(): void {
  const rows = db
    .prepare(
      `SELECT v.id, v.selected_options
       FROM poll_votes v
       LEFT JOIN poll_vote_options pvo ON pvo.vote_id = v.id
       WHERE pvo.vote_id IS NULL`
    )
    .all() as { id: number; selected_options: string }[];
  if (rows.length === 0) return;
  const insert = db.prepare(
    "INSERT OR IGNORE INTO poll_vote_options (vote_id, option) VALUES (?, ?)"
  );
  const tx = db.transaction((batch: typeof rows) => {
    for (const r of batch) {
      const opts = safeJsonParse<string[]>(r.selected_options, [], `vote#${r.id}.selected_options`);
      for (const opt of opts) insert.run(r.id, opt);
    }
  });
  tx(rows);
  console.log(`🔁 Backfill poll_vote_options: ${rows.length} votes migrés`);
}

function migrate(): void {
  const hasCol = (table: string, col: string): boolean => {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
    return rows.some((r) => r.name === col);
  };

  // Issue #36 : tout ALTER TABLE + backfill emballé dans une transaction pour
  // éviter l'incohérence partielle si le process crash en plein milieu.
  // Sans ça, le backfillTrainingDay pouvait être interrompu après l'ALTER
  // (colonne ajoutée mais backfill partiel) → plus jamais re-tenté au boot
  // suivant puisque hasCol() retourne true. SQLite supporte ALTER TABLE ADD
  // COLUMN à l'intérieur d'une transaction depuis 3.7.11.
  db.exec("BEGIN");
  try {
    if (!hasCol("poll_votes", "send_id")) {
      db.exec("ALTER TABLE poll_votes ADD COLUMN send_id INTEGER");
    }
    if (!hasCol("poll_message_map", "send_id")) {
      db.exec("ALTER TABLE poll_message_map ADD COLUMN send_id INTEGER");
    }
    // Passe Baileys (port whatsapp-web.js → Baileys) : Baileys a besoin du
    // WAMessageContent original (proto-encodé) pour décrypter les votes.
    // On stocke ce blob ici pour que getMessage() puisse le restituer.
    if (!hasCol("poll_message_map", "wa_message_proto")) {
      db.exec("ALTER TABLE poll_message_map ADD COLUMN wa_message_proto BLOB");
    }
    // Issue display library : poll.options vaut ['[lib]','[lib]'] pour les polls
    // en mode bibliothèque. Sans ce snapshot, getResultsForSend() ne sait pas
    // quelles options ont vraiment été envoyées au moment du send et n'affiche
    // que [lib] sans matcher les votes (qui contiennent les vraies réponses
    // tirées). Stocké en TEXT JSON pour rester simple et backup-friendly.
    if (!hasCol("poll_sends", "options_sent")) {
      db.exec("ALTER TABLE poll_sends ADD COLUMN options_sent TEXT");
    }
    if (!hasCol("sessions", "last_seen_at")) {
      db.exec("ALTER TABLE sessions ADD COLUMN last_seen_at TEXT");
      db.exec("UPDATE sessions SET last_seen_at = created_at WHERE last_seen_at IS NULL");
    }
    if (!hasCol("sessions", "role")) {
      db.exec("ALTER TABLE sessions ADD COLUMN role TEXT DEFAULT 'user'");
      // Invalidate any pre-migration sessions: they predate the role choice flow
      // Users will need to re-login and pick their role explicitly
      db.exec("DELETE FROM sessions WHERE role IS NULL OR role = 'user'");
    }
    if (!hasCol("poll_sends", "group_name")) {
      db.exec("ALTER TABLE poll_sends ADD COLUMN group_name TEXT");
    }
    if (!hasCol("polls", "training_day")) {
      db.exec("ALTER TABLE polls ADD COLUMN training_day INTEGER");
      backfillTrainingDay();
    }
    // Issue #55 : métadonnées contextuelles sur les snapshots — sans elles
    // impossible de calculer un taux de participation ou de reconstruire le
    // contexte d'un poll modifié après le snapshot.
    if (!hasCol("poll_results_snapshot", "question_raw")) {
      db.exec("ALTER TABLE poll_results_snapshot ADD COLUMN question_raw TEXT");
    }
    if (!hasCol("poll_results_snapshot", "cron_expression")) {
      db.exec("ALTER TABLE poll_results_snapshot ADD COLUMN cron_expression TEXT");
    }
    if (!hasCol("poll_results_snapshot", "group_ids")) {
      db.exec("ALTER TABLE poll_results_snapshot ADD COLUMN group_ids TEXT");
    }
    if (!hasCol("poll_results_snapshot", "expected_count")) {
      db.exec("ALTER TABLE poll_results_snapshot ADD COLUMN expected_count INTEGER");
    }
    // Feature : bibliothèque de phrases — flag par poll qui active la
    // sélection aléatoire des phrases à chaque envoi (cf services/phraseService).
    if (!hasCol("polls", "use_phrase_library")) {
      db.exec("ALTER TABLE polls ADD COLUMN use_phrase_library INTEGER DEFAULT 0");
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function backfillTrainingDay(): void {
  const rows = db
    .prepare("SELECT id, cron_expression FROM polls WHERE training_day IS NULL")
    .all() as { id: number; cron_expression: string }[];
  const upd = db.prepare("UPDATE polls SET training_day = ? WHERE id = ? AND training_day IS NULL");
  // Le backfill ne remplit training_day que si la cron exprime un jour de semaine UNIQUE :
  // - pattern cron strict "min hour * * N" avec N ∈ [0..6]
  // Les patterns multi-jours (weekdays "1-5", weekend "0,6", custom "2,4",
  // biweekly "dom 1-7,15-21 * N", daily "*", monthly "dom * *") restent NULL,
  // car le mapping vers UN jour d'entraînement n'est pas sémantiquement exact.
  // `cronToSchedule` de cronHelper retourne `weekly` avec `parseInt("2,4")=2` ce qui
  // est incorrect — on fait ici une validation stricte pour éviter ce piège.
  const STRICT_WEEKLY = /^(\d{1,2}) (\d{1,2}) \* \* ([0-6])$/;
  let filled = 0;
  for (const row of rows) {
    const match = row.cron_expression?.match(STRICT_WEEKLY);
    if (match) {
      const day = Number(match[3]);
      upd.run(day, row.id);
      filled++;
    }
  }
  if (filled > 0) {
    console.log(`🔁 Backfill training_day: ${filled}/${rows.length} polls inferred from cron`);
  }
}

// Bibliothèque de phrases : module dédié src/db-phrases.ts (modèle issue #47).
export {
  listPhrases,
  getPhrase,
  addPhrase,
  deletePhrase,
  deletePhrasesByCategory,
  countPhrasesByCategory,
  countTitlesForDay,
  pickRandomFromCategory,
  CANONICAL_CATEGORIES,
  REQUIRED_CATEGORIES,
  OPTION_CATEGORIES_ORDERED,
} from "./db-phrases";
export type { CanonicalCategory, AddPhraseInput } from "./db-phrases";

// Issue #47 : sessions / whitelist / viewers / audit_logs extraits dans
// src/db-sessions.ts — db.ts re-exporte pour préserver les callers qui font
// `import * as db from "./db"`.
export {
  listViewers,
  addViewer,
  removeViewer,
  isViewerInDb,
  listAllowedPhones,
  addAllowedPhone,
  removeAllowedPhone,
  isPhoneInAllowedDb,
  countAllowedPhones,
  createSession,
  getSession,
  deleteSession,
  deleteExpiredSessions,
  touchSession,
  getOnlineUsers,
  addAuditLog,
  getAuditLogs,
} from "./db-sessions";

// --- Poll Message Map ---
export function savePollMessageMapping(
  messageId: string,
  pollId: number,
  sendId: number
): void {
  db.prepare(
    "INSERT OR REPLACE INTO poll_message_map (message_id, poll_id, send_id) VALUES (?, ?, ?)"
  ).run(messageId, pollId, sendId);
}

// Variante avec proto Baileys — utilisée par le port Baileys pour fournir
// le WAMessageContent à getMessage() lors de la décryption des votes.
// Préserve le proto existant si on appelle avec proto=null (ex: re-update
// pour ajouter le sendId une fois recordSend effectué).
export function savePollMessageMappingWithProto(
  messageId: string,
  pollId: number,
  sendId: number | null,
  waMessageProto: Buffer | null
): void {
  if (waMessageProto) {
    db.prepare(
      "INSERT OR REPLACE INTO poll_message_map (message_id, poll_id, send_id, wa_message_proto) VALUES (?, ?, ?, ?)"
    ).run(messageId, pollId, sendId, waMessageProto);
  } else {
    // sendId update sans toucher le proto déjà stocké.
    db.prepare(
      "UPDATE poll_message_map SET poll_id = ?, send_id = ? WHERE message_id = ?"
    ).run(pollId, sendId, messageId);
  }
}

export function getWaPollMessageProto(messageId: string): Buffer | null {
  const row = db
    .prepare("SELECT wa_message_proto FROM poll_message_map WHERE message_id = ?")
    .get(messageId) as { wa_message_proto: Buffer | null } | undefined;
  return row?.wa_message_proto || null;
}

export function getMappingByMessageId(
  messageId: string
): { poll_id: number; send_id: number | null } | undefined {
  return db
    .prepare("SELECT poll_id, send_id FROM poll_message_map WHERE message_id = ?")
    .get(messageId) as any;
}

// Charge uniquement les mappings dont le send est récent (DEFAULT_DAYS_KEPT).
// Au-delà, les sends sont déjà CASCADE-supprimés en DB par cleanupOldSends ;
// inutile de les garder en RAM. Les mappings sans send_id (cas legacy) sont
// conservés pour ne pas casser un éventuel vote tardif sur send orphelin.
export function getAllPollMessageMappings(daysKept: number = DEFAULT_DAYS_KEPT): Map<
  string,
  { pollId: number; sendId: number | null }
> {
  const cutoff = new Date(Date.now() - daysKept * ONE_DAY).toISOString();
  const rows = db.prepare(
    `SELECT m.message_id, m.poll_id, m.send_id
     FROM poll_message_map m
     LEFT JOIN poll_sends s ON s.id = m.send_id
     WHERE m.send_id IS NULL OR s.sent_at >= ?`
  ).all(cutoff) as any[];
  const map = new Map<string, { pollId: number; sendId: number | null }>();
  for (const row of rows) {
    map.set(row.message_id, { pollId: row.poll_id, sendId: row.send_id });
  }
  return map;
}

// --- DB Backup + Cleanup ---
let lastBackupAt: number | null = null;

export function backupDb(): void {
  const backupPath = currentDbPath + ".backup";
  db.backup(backupPath)
    .then(() => {
      lastBackupAt = Date.now();
    })
    .catch((err: any) => {
      console.error("Erreur backup DB:", err);
    });
}

export function getLastBackupAt(): number | null {
  return lastBackupAt;
}

// Create a fresh on-demand backup at a custom path; returns the path
export async function createBackupSnapshot(): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const snapPath = path.join(path.dirname(currentDbPath), `pollbot-backup-${ts}.db`);
  await db.backup(snapPath);
  lastBackupAt = Date.now();
  return snapPath;
}

export function getDbPath(): string {
  return currentDbPath;
}

// Close the SQLite connection cleanly (used before restore + exit).
// No-op si la connexion n'est pas (encore) ouverte.
// Expose pour stats.ts et toute consommation read-only qui n'a pas encore
// sa helper dédiée dans ce module. Ne pas abuser : préférer ajouter une
// fonction exportée explicite plutôt que d'appeler `getDb().prepare(...)`
// partout (l'objectif long-terme de #47 est de splitter ce god-file).
export function getDb(): Database.Database {
  return db;
}

export function closeDb(): void {
  if (!db) return;
  try {
    db.close();
  } catch (err) {
    console.error("Erreur fermeture DB:", err);
  }
}

export function cleanupOldSends(daysKept: number = DEFAULT_DAYS_KEPT): number {
  const cutoff = new Date(Date.now() - daysKept * ONE_DAY).toISOString();
  const result = db
    .prepare("DELETE FROM poll_sends WHERE sent_at < ?")
    .run(cutoff);
  return result.changes;
}

// Purge les audit_logs plus anciens que N jours. Sans ça la table croît
// indéfiniment (issue #38) — les logs sont utiles pour le forensic récent,
// pas pour l'archivage long terme.
export function cleanupOldAuditLogs(daysKept: number): number {
  const cutoff = new Date(Date.now() - daysKept * ONE_DAY).toISOString();
  const result = db
    .prepare("DELETE FROM audit_logs WHERE created_at < ?")
    .run(cutoff);
  return result.changes;
}

// Safe JSON parse wrapper: retourne `fallback` au lieu de throw si le JSON
// stocké en DB est corrompu. Protection defense-en-profondeur contre une
// ligne corrompue qui casserait GET /api/polls pour TOUT le monde.
// Exporté sous un nom distinct pour db-snapshots.ts qui en a besoin
// (rename interne pour ne pas entrer en collision dans les re-exports).
export function safeJsonParseForSnapshots<T>(value: unknown, fallback: T, context?: string): T {
  return safeJsonParse(value, fallback, context);
}

function safeJsonParse<T>(value: unknown, fallback: T, context?: string): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value);
  } catch (err) {
    if (context) {
      console.error(
        `⚠ JSON.parse failed on ${context}: ${(err as Error).message}`
      );
    }
    return fallback;
  }
}

function rowToPoll(row: any): Poll {
  return {
    ...row,
    options: safeJsonParse<string[]>(row.options, [], `poll#${row.id}.options`),
    group_ids: safeJsonParse<string[]>(
      row.group_ids,
      [],
      `poll#${row.id}.group_ids`
    ),
    is_active: Boolean(row.is_active),
    allow_multiple_answers: Boolean(row.allow_multiple_answers),
    training_day:
      row.training_day === null || row.training_day === undefined
        ? null
        : Number(row.training_day),
    use_phrase_library: Boolean(row.use_phrase_library),
  };
}

// --- Polls ---
export function createPoll(input: CreatePollInput): Poll {
  const stmt = db.prepare(`
    INSERT INTO polls (question, options, cron_expression, group_ids, allow_multiple_answers, training_day, use_phrase_library)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    input.question,
    JSON.stringify(input.options),
    input.cron_expression,
    JSON.stringify(input.group_ids),
    input.allow_multiple_answers ? 1 : 0,
    input.training_day === undefined || input.training_day === null
      ? null
      : Number(input.training_day),
    input.use_phrase_library ? 1 : 0
  );
  return getPoll(result.lastInsertRowid as number)!;
}

export function getPoll(id: number): Poll | undefined {
  const row = db.prepare("SELECT * FROM polls WHERE id = ?").get(id);
  return row ? rowToPoll(row) : undefined;
}

export function getAllPolls(): (Poll & { last_sent_at?: string; last_send_total?: number })[] {
  // Issue #52 : une seule CTE pour agréger le dernier send + son nombre de
  // votes, au lieu de 3 sous-requêtes corrélées par row dont MAX(sent_at)
  // évalué 2x. Corrige aussi un bug latent : l'ancienne query matchait
  // plusieurs sends si deux envois partageaient le même sent_at à la
  // seconde près (cas admin "envoyer maintenant" dans 3 groupes) et
  // comptait les votes des 3 à la fois. On désambiguïse avec MAX(id)
  // comme "dernier send" canonique.
  const rows = db
    .prepare(
      `WITH last_sends AS (
         SELECT poll_id,
                MAX(sent_at) AS last_sent_at,
                MAX(id) AS last_send_id
         FROM poll_sends
         GROUP BY poll_id
       ),
       vote_counts AS (
         SELECT send_id, COUNT(*) AS cnt
         FROM poll_votes
         GROUP BY send_id
       )
       SELECT p.*,
              ls.last_sent_at AS last_sent_at,
              COALESCE(vc.cnt, 0) AS last_send_total
       FROM polls p
       LEFT JOIN last_sends ls ON ls.poll_id = p.id
       LEFT JOIN vote_counts vc ON vc.send_id = ls.last_send_id
       ORDER BY p.created_at DESC`
    )
    .all() as any[];
  return rows.map((r) => ({
    ...rowToPoll(r),
    last_sent_at: r.last_sent_at,
    last_send_total: r.last_send_total ?? 0,
  }));
}

export function getActivePolls(): Poll[] {
  const rows = db
    .prepare("SELECT * FROM polls WHERE is_active = 1 ORDER BY created_at DESC")
    .all();
  return rows.map(rowToPoll);
}

export function updatePoll(
  id: number,
  updates: Partial<CreatePollInput> & { is_active?: boolean }
): Poll | undefined {
  const current = getPoll(id);
  if (!current) return undefined;

  const nextTrainingDay =
    updates.training_day === undefined
      ? current.training_day
      : updates.training_day === null
      ? null
      : Number(updates.training_day);

  const nextLibrary =
    updates.use_phrase_library === undefined
      ? current.use_phrase_library
      : Boolean(updates.use_phrase_library);

  const stmt = db.prepare(`
    UPDATE polls SET
      question = ?,
      options = ?,
      cron_expression = ?,
      group_ids = ?,
      allow_multiple_answers = ?,
      is_active = ?,
      training_day = ?,
      use_phrase_library = ?
    WHERE id = ?
  `);
  stmt.run(
    updates.question ?? current.question,
    JSON.stringify(updates.options ?? current.options),
    updates.cron_expression ?? current.cron_expression,
    JSON.stringify(updates.group_ids ?? current.group_ids),
    (updates.allow_multiple_answers ?? current.allow_multiple_answers) ? 1 : 0,
    (updates.is_active ?? current.is_active) ? 1 : 0,
    nextTrainingDay,
    nextLibrary ? 1 : 0,
    id
  );
  return getPoll(id);
}

export function deletePoll(id: number): boolean {
  const result = db.prepare("DELETE FROM polls WHERE id = ?").run(id);
  return result.changes > 0;
}

// Supprime un envoi unique (une occurrence dans l'historique).
// Les FK CASCADE sur poll_votes + poll_message_map (cf schéma) nettoient
// automatiquement les votes et la map message_id → send associée.
// Le poll lui-même n'est pas affecté (autres envois préservés).
export function deleteSend(sendId: number): boolean {
  const result = db.prepare("DELETE FROM poll_sends WHERE id = ?").run(sendId);
  return result.changes > 0;
}

// --- Poll Sends ---
export function recordSend(
  pollId: number,
  groupId: string,
  messageId: string | null,
  groupName: string | null = null
): number {
  const result = db
    .prepare(
      "INSERT INTO poll_sends (poll_id, group_id, group_name, message_id) VALUES (?, ?, ?, ?)"
    )
    .run(pollId, groupId, groupName, messageId);
  return result.lastInsertRowid as number;
}

// Issue #37 : enregistre le send ET le mapping message_id → poll/send en une
// seule transaction atomique. Avant ce fix, un crash entre recordSend() et
// savePollMessageMapping() laissait un send sans mapping — tous les votes sur
// ce message passaient par le fallback send_id=NULL et n'étaient plus
// correctement attribués par le snapshot cron 8h.
export function recordSendAndMap(
  pollId: number,
  groupId: string,
  messageId: string | null,
  groupName: string | null = null,
  waMessageProto: Buffer | null = null,
  optionsSent: string[] | null = null
): number {
  const run = db.transaction(() => {
    const optionsJson = optionsSent && optionsSent.length > 0 ? JSON.stringify(optionsSent) : null;
    const result = db
      .prepare(
        "INSERT INTO poll_sends (poll_id, group_id, group_name, message_id, options_sent) VALUES (?, ?, ?, ?, ?)"
      )
      .run(pollId, groupId, groupName, messageId, optionsJson);
    const sendId = result.lastInsertRowid as number;
    if (messageId) {
      // Passe Baileys : si proto fourni, on l'écrit dans la même transaction
      // pour que la décryption des votes soit garantie atomiquement avec
      // l'enregistrement du send.
      if (waMessageProto) {
        db.prepare(
          "INSERT OR REPLACE INTO poll_message_map (message_id, poll_id, send_id, wa_message_proto) VALUES (?, ?, ?, ?)"
        ).run(messageId, pollId, sendId, waMessageProto);
      } else {
        db.prepare(
          "INSERT OR REPLACE INTO poll_message_map (message_id, poll_id, send_id) VALUES (?, ?, ?)"
        ).run(messageId, pollId, sendId);
      }
    }
    return sendId;
  });
  return run();
}

export function getSendsForPoll(
  pollId: number,
  daysKept: number = DEFAULT_DAYS_KEPT,
  groupId?: string
): PollSend[] {
  const cutoff = new Date(Date.now() - daysKept * ONE_DAY).toISOString();
  if (groupId) {
    return db
      .prepare(
        "SELECT * FROM poll_sends WHERE poll_id = ? AND sent_at >= ? AND group_id = ? ORDER BY sent_at DESC"
      )
      .all(pollId, cutoff, groupId) as PollSend[];
  }
  return db
    .prepare(
      "SELECT * FROM poll_sends WHERE poll_id = ? AND sent_at >= ? ORDER BY sent_at DESC"
    )
    .all(pollId, cutoff) as PollSend[];
}

// Group sends by date (for recurring polls, one poll = many sends)
export interface SendGroup {
  date: string; // YYYY-MM-DD
  sends: PollSend[];
  total_votes: number;
}

export function getSendGroupsForPoll(
  pollId: number,
  daysKept: number = DEFAULT_DAYS_KEPT,
  groupId?: string
): SendGroup[] {
  // Issue #50 : une seule query LEFT JOIN avec COUNT agrégé au lieu de
  // N+1 (un SELECT COUNT par send). Sur 3 polls × 30 sends × 31 requêtes
  // on passait à ~270 round-trips SQLite par GET /api/polls/by-training-day.
  // Maintenant : 1 query qui rend directement (send, vote_count) pour tous
  // les sends filtrés, groupés côté JS par date.
  const cutoff = new Date(Date.now() - daysKept * ONE_DAY).toISOString();
  const rows = groupId
    ? (db
        .prepare(
          `SELECT s.*, COALESCE(vc.cnt, 0) AS vote_count
           FROM poll_sends s
           LEFT JOIN (SELECT send_id, COUNT(*) AS cnt FROM poll_votes GROUP BY send_id) vc
             ON vc.send_id = s.id
           WHERE s.poll_id = ? AND s.sent_at >= ? AND s.group_id = ?
           ORDER BY s.sent_at DESC`
        )
        .all(pollId, cutoff, groupId) as any[])
    : (db
        .prepare(
          `SELECT s.*, COALESCE(vc.cnt, 0) AS vote_count
           FROM poll_sends s
           LEFT JOIN (SELECT send_id, COUNT(*) AS cnt FROM poll_votes GROUP BY send_id) vc
             ON vc.send_id = s.id
           WHERE s.poll_id = ? AND s.sent_at >= ?
           ORDER BY s.sent_at DESC`
        )
        .all(pollId, cutoff) as any[]);

  const groups = new Map<string, SendGroup>();
  for (const row of rows) {
    const date = row.sent_at.split(" ")[0] || row.sent_at.split("T")[0];
    if (!groups.has(date)) {
      groups.set(date, { date, sends: [], total_votes: 0 });
    }
    const g = groups.get(date)!;
    // On GARDE vote_count sur chaque send (au lieu de le destructurer out)
    // pour que le frontend puisse afficher le compteur PAR send et pas
    // seulement le total agrégé du jour. Bug : 2 sondages le même jour
    // dans le même groupe affichaient le même total_votes pour chaque send.
    g.sends.push(row as PollSend);
    g.total_votes += row.vote_count ?? 0;
  }

  return Array.from(groups.values()).sort((a, b) => b.date.localeCompare(a.date));
}

// Liste des groupes qui ont au moins un send dans la fenêtre de rétention
export function listActiveGroups(
  daysKept: number = DEFAULT_DAYS_KEPT
): { group_id: string; group_name: string | null; send_count: number }[] {
  const cutoff = new Date(Date.now() - daysKept * ONE_DAY).toISOString();
  return db
    .prepare(
      `SELECT group_id,
              MAX(group_name) AS group_name,
              COUNT(*) AS send_count
       FROM poll_sends
       WHERE sent_at >= ?
       GROUP BY group_id
       ORDER BY MAX(sent_at) DESC`
    )
    .all(cutoff) as any[];
}

// --- Voter name maintenance ---
export function getAllUniqueVoters(): string[] {
  const rows = db
    .prepare("SELECT DISTINCT voter FROM poll_votes")
    .all() as { voter: string }[];
  return rows.map((r) => r.voter);
}

export function updateVoterName(voter: string, name: string): void {
  db.prepare("UPDATE poll_votes SET voter_name = ? WHERE voter = ?").run(
    name,
    voter
  );
}

// --- Poll Votes ---
export function recordVote(
  pollId: number,
  sendId: number | null,
  groupId: string,
  voter: string,
  voterName: string,
  selectedOptions: string[]
): void {
  // Issue #53 : double-write — poll_votes garde la version JSON pour compat
  // (restore Postgres, imports externes) ET poll_vote_options reçoit une
  // ligne par option pour permettre les agrégations SQL natives. Les deux
  // INSERT/UPDATE dans une seule transaction pour éviter la divergence.
  const tx = db.transaction(() => {
    // If we have a send_id, vote is unique per (send_id, voter)
    // Otherwise fallback to (poll_id, group_id, voter)
    let existing: { id: number } | undefined;
    if (sendId !== null) {
      existing = db
        .prepare("SELECT id FROM poll_votes WHERE send_id = ? AND voter = ?")
        .get(sendId, voter) as any;
    } else {
      existing = db
        .prepare(
          "SELECT id FROM poll_votes WHERE poll_id = ? AND group_id = ? AND voter = ? AND send_id IS NULL"
        )
        .get(pollId, groupId, voter) as any;
    }

    let voteId: number;
    if (existing) {
      db.prepare(
        "UPDATE poll_votes SET selected_options = ?, voter_name = ?, voted_at = datetime('now') WHERE id = ?"
      ).run(JSON.stringify(selectedOptions), voterName, existing.id);
      voteId = existing.id;
      // Reset les options normalisées : un re-vote peut changer la sélection.
      db.prepare("DELETE FROM poll_vote_options WHERE vote_id = ?").run(voteId);
    } else {
      const result = db
        .prepare(
          "INSERT INTO poll_votes (poll_id, send_id, group_id, voter, voter_name, selected_options) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run(pollId, sendId, groupId, voter, voterName, JSON.stringify(selectedOptions));
      voteId = result.lastInsertRowid as number;
    }

    const insertOpt = db.prepare(
      "INSERT OR IGNORE INTO poll_vote_options (vote_id, option) VALUES (?, ?)"
    );
    for (const opt of selectedOptions) insertOpt.run(voteId, opt);
  });
  tx();
}

export function getVotesForSend(sendId: number): PollVote[] {
  const rows = db
    .prepare("SELECT * FROM poll_votes WHERE send_id = ? ORDER BY voted_at DESC")
    .all(sendId) as any[];
  return rows.map((r) => ({
    ...r,
    selected_options: safeJsonParse<string[]>(
      r.selected_options,
      [],
      `vote#${r.id}.selected_options`
    ),
  }));
}

export function getVotesForPoll(pollId: number, daysKept: number = DEFAULT_DAYS_KEPT): PollVote[] {
  const cutoff = new Date(Date.now() - daysKept * ONE_DAY).toISOString();
  const rows = db
    .prepare(
      "SELECT * FROM poll_votes WHERE poll_id = ? AND voted_at >= ? ORDER BY voted_at DESC"
    )
    .all(pollId, cutoff) as any[];
  return rows.map((r) => ({
    ...r,
    selected_options: safeJsonParse<string[]>(
      r.selected_options,
      [],
      `vote#${r.id}.selected_options`
    ),
  }));
}

// Get all sends across all polls for a specific date (YYYY-MM-DD)
// Returns each send with its poll info and full results — each is unique
export interface SendWithResults {
  send_id: number;
  poll_id: number;
  poll_question: string;
  poll_options: string[];
  group_id: string;
  group_name: string | null;
  sent_at: string;
  total_votes: number;
  summary: { option: string; count: number; voters: string[] }[];
}

export function getSendsByDate(
  dateStr: string,
  groupId?: string
): SendWithResults[] {
  // dateStr est interprete comme une date LOCALE dans le fuseau TIMEZONE
  // (defaut Europe/Paris). sent_at est stocke en UTC via datetime('now') de
  // SQLite, donc on convertit la date locale en bornes UTC pour eviter qu'un
  // send fait a 00:30 Paris soit attribue au mauvais jour.
  const { startUtc, endUtc } = localDateToUtcBoundsSqlite(dateStr, tz());

  let sends: any[];
  if (groupId) {
    sends = db
      .prepare(
        `SELECT s.id as send_id, s.poll_id, s.group_id, s.group_name, s.sent_at,
                p.question as poll_question, p.options as poll_options
         FROM poll_sends s
         JOIN polls p ON p.id = s.poll_id
         WHERE s.sent_at >= ? AND s.sent_at < ? AND s.group_id = ?
         ORDER BY s.sent_at DESC`
      )
      .all(startUtc, endUtc, groupId) as any[];
  } else {
    sends = db
      .prepare(
        `SELECT s.id as send_id, s.poll_id, s.group_id, s.group_name, s.sent_at,
                p.question as poll_question, p.options as poll_options
         FROM poll_sends s
         JOIN polls p ON p.id = s.poll_id
         WHERE s.sent_at >= ? AND s.sent_at < ?
         ORDER BY s.sent_at DESC`
      )
      .all(startUtc, endUtc) as any[];
  }

  if (sends.length === 0) return [];

  // Batch-fetch all votes for these send_ids in a single query (avoid N+1)
  const sendIds = sends.map((s) => s.send_id);
  const placeholders = sendIds.map(() => "?").join(",");
  const allVoteRows = db
    .prepare(
      `SELECT * FROM poll_votes WHERE send_id IN (${placeholders}) ORDER BY voted_at DESC`
    )
    .all(...sendIds) as any[];

  const votesBySendId = new Map<number, PollVote[]>();
  for (const r of allVoteRows) {
    const vote: PollVote = {
      ...r,
      selected_options: safeJsonParse<string[]>(
        r.selected_options,
        [],
        `vote#${r.id}.selected_options`
      ),
    };
    const list = votesBySendId.get(r.send_id);
    if (list) list.push(vote);
    else votesBySendId.set(r.send_id, [vote]);
  }

  return sends.map((s) => {
    const options: string[] = safeJsonParse<string[]>(
      s.poll_options,
      [],
      `poll#${s.poll_id}.options`
    );
    const votes = votesBySendId.get(s.send_id) || [];
    const summary = options.map((option) => {
      const voters = votes.filter((v) => v.selected_options.includes(option));
      return {
        option,
        count: voters.length,
        voters: voters.map((v) => v.voter_name || v.voter),
      };
    });
    return {
      send_id: s.send_id,
      poll_id: s.poll_id,
      poll_question: s.poll_question,
      poll_options: options,
      group_id: s.group_id,
      group_name: s.group_name || null,
      sent_at: s.sent_at,
      total_votes: votes.length,
      summary,
    };
  });
}

// Détermine la liste d'options à afficher pour un send. Pour un poll en mode
// library (poll.options = ['[lib]', '[lib]']), poll.options ne reflète pas
// ce qui a réellement été envoyé. Ordre de préférence :
//   1. options_sent stocké au moment du send (la vérité, depuis le port Baileys)
//   2. Pour les sends legacy sans options_sent, dérivation depuis les votes
//      reçus (lossy : options à 0 vote sont perdues)
//   3. Fallback poll.options (placeholders [lib] si library)
function effectiveOptionsForSend(
  optionsSentJson: string | null,
  pollOptions: string[],
  votes: PollVote[]
): string[] {
  if (optionsSentJson) {
    const parsed = safeJsonParse<string[]>(optionsSentJson, [], "poll_sends.options_sent");
    if (parsed.length > 0) return parsed;
  }
  // Detection des placeholders [lib] sur les polls library-mode legacy.
  const isPlaceholder = pollOptions.length > 0 && pollOptions.every((o) => o === "[lib]" || !o);
  if (isPlaceholder) {
    const fromVotes = new Set<string>();
    for (const v of votes) for (const opt of v.selected_options) fromVotes.add(opt);
    if (fromVotes.size > 0) return Array.from(fromVotes);
  }
  return pollOptions;
}

export function getResultsForSend(
  sendId: number
): { option: string; count: number; voters: string[] }[] {
  const send = db
    .prepare("SELECT poll_id, options_sent FROM poll_sends WHERE id = ?")
    .get(sendId) as { poll_id: number; options_sent: string | null } | undefined;
  if (!send) return [];

  const poll = getPoll(send.poll_id);
  if (!poll) return [];

  const votes = getVotesForSend(sendId);
  const options = effectiveOptionsForSend(send.options_sent, poll.options, votes);
  return options.map((option) => {
    const voters = votes.filter((v) => v.selected_options.includes(option));
    return {
      option,
      count: voters.length,
      voters: voters.map((v) => v.voter_name || v.voter),
    };
  });
}

// Issue #51 : batch-fetch des résultats pour N send_ids en une seule query.
// Utilisé par GET /api/polls/:id/history?include=results pour éviter que le
// frontend fasse N fetches parallèles (consommation d'apiLimiter et UX lente).
// Retourne une Map sendId → [{option, count, voters}] basée sur les options
// du poll parent.
export function getResultsForSendIds(
  pollId: number,
  sendIds: number[]
): Map<number, { option: string; count: number; voters: string[] }[]> {
  const out = new Map<number, { option: string; count: number; voters: string[] }[]>();
  if (sendIds.length === 0) return out;
  const poll = getPoll(pollId);
  if (!poll) return out;

  // WHERE send_id IN (?, ?, ...) — placeholders générés dynamiquement mais
  // jamais avec du user input (sendIds sont des number déjà validés).
  const placeholders = sendIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT * FROM poll_votes WHERE send_id IN (${placeholders}) ORDER BY voted_at DESC`
    )
    .all(...sendIds) as any[];

  const bySend = new Map<number, PollVote[]>();
  for (const r of rows) {
    const vote: PollVote = {
      ...r,
      selected_options: safeJsonParse<string[]>(
        r.selected_options,
        [],
        `vote#${r.id}.selected_options`
      ),
    };
    const list = bySend.get(vote.send_id!) ?? [];
    list.push(vote);
    bySend.set(vote.send_id!, list);
  }

  // Récupère options_sent pour chaque send en une seule query (évite N reads).
  const sendsRows = db
    .prepare(
      `SELECT id, options_sent FROM poll_sends WHERE id IN (${placeholders})`
    )
    .all(...sendIds) as { id: number; options_sent: string | null }[];
  const optionsSentBySend = new Map<number, string | null>();
  for (const s of sendsRows) optionsSentBySend.set(s.id, s.options_sent);

  for (const sendId of sendIds) {
    const votes = bySend.get(sendId) ?? [];
    const options = effectiveOptionsForSend(
      optionsSentBySend.get(sendId) ?? null,
      poll.options,
      votes
    );
    out.set(
      sendId,
      options.map((option) => {
        const voters = votes.filter((v) => v.selected_options.includes(option));
        return {
          option,
          count: voters.length,
          voters: voters.map((v) => v.voter_name || v.voter),
        };
      })
    );
  }
  return out;
}

// Aggregated results for all sends of a poll (last N days)
export function getResultsSummary(
  pollId: number,
  daysKept: number = DEFAULT_DAYS_KEPT
): { option: string; count: number; voters: string[] }[] {
  const poll = getPoll(pollId);
  if (!poll) return [];

  const votes = getVotesForPoll(pollId, daysKept);
  return poll.options.map((option) => {
    const voters = votes.filter((v) => v.selected_options.includes(option));
    return {
      option,
      count: voters.length,
      voters: voters.map((v) => v.voter_name || v.voter),
    };
  });
}

// --- Training day queries ---
export function getPollsByTrainingDay(trainingDay: number): Poll[] {
  const rows = db
    .prepare(
      "SELECT * FROM polls WHERE training_day = ? ORDER BY created_at DESC"
    )
    .all(trainingDay) as any[];
  return rows.map(rowToPoll);
}

// Returns the most recent poll_send for a given poll on a specific date (YYYY-MM-DD),
// interprete comme une date LOCALE dans le fuseau TIMEZONE. Conversion en bornes
// UTC pour matcher correctement `sent_at` (stocke en UTC). Sans ce fix, un send
// a 00:30 Paris (= 22:30 UTC la veille) etait attribue au mauvais jour par le
// cron snapshot 8h. Voir issue #22.
export function getLatestSendForPollOnDate(
  pollId: number,
  dateStr: string
): PollSend | undefined {
  const { startUtc, endUtc } = localDateToUtcBoundsSqlite(dateStr, tz());
  const row = db
    .prepare(
      `SELECT * FROM poll_sends
       WHERE poll_id = ? AND sent_at >= ? AND sent_at < ?
       ORDER BY sent_at DESC
       LIMIT 1`
    )
    .get(pollId, startUtc, endUtc) as PollSend | undefined;
  return row;
}

// Issue #47 : snapshots extraits dans src/db-snapshots.ts — db.ts re-exporte
// pour préserver l'API `import * as db from "./db"` des callers.
export {
  createResultsSnapshot,
  upsertResultsSnapshot,
  listSnapshotsForPoll,
  listAllSnapshots,
} from "./db-snapshots";
export type { CreateSnapshotInput } from "./db-snapshots";
