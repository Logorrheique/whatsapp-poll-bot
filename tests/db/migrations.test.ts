import { describe, it, expect, beforeEach } from "vitest";
import { makeTempDb, freshDbPath } from "../helpers/db";
import * as db from "../../src/db";
import Database from "better-sqlite3";

describe("DB — migrations", () => {
  beforeEach(() => {
    makeTempDb();
  });

  it("polls a la colonne training_day après initDb", () => {
    const dbPath = process.env.POLLS_DB_PATH!;
    const raw = new Database(dbPath);
    const cols = raw.prepare("PRAGMA table_info(polls)").all() as any[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("training_day");
    raw.close();
  });

  it("table poll_results_snapshot existe avec contrainte UNIQUE", () => {
    const dbPath = process.env.POLLS_DB_PATH!;
    const raw = new Database(dbPath);
    const cols = raw.prepare("PRAGMA table_info(poll_results_snapshot)").all() as any[];
    expect(cols.length).toBeGreaterThan(0);
    const idxList = raw.prepare("PRAGMA index_list(poll_results_snapshot)").all() as any[];
    const hasUnique = idxList.some((i) => i.unique === 1);
    expect(hasUnique).toBe(true);
    raw.close();
  });

  it("initDb est idempotent (re-run sans erreur)", () => {
    db.closeDb();
    db.initDb();
    db.closeDb();
    db.initDb();
    // Doit pouvoir interroger après ré-init
    expect(db.getAllPolls()).toEqual([]);
  });

  it("migration depuis une DB legacy v1.1 (sans training_day) ajoute la colonne", () => {
    const legacyPath = freshDbPath();
    const legacy = new Database(legacyPath);
    legacy.exec(`
      CREATE TABLE polls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        question TEXT NOT NULL,
        options TEXT NOT NULL,
        cron_expression TEXT NOT NULL,
        group_ids TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        allow_multiple_answers INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO polls (question, options, cron_expression, group_ids)
      VALUES ('Legacy Q', '["A","B"]', '0 9 * * 2', '["g1"]'),
             ('Daily', '["A","B"]', '0 9 * * *', '["g1"]');
    `);
    legacy.close();

    db.closeDb();
    process.env.POLLS_DB_PATH = legacyPath;
    db.initDb();

    const verif = new Database(legacyPath);
    const cols = verif.prepare("PRAGMA table_info(polls)").all() as any[];
    verif.close();
    expect(cols.map((c) => c.name)).toContain("training_day");

    const polls = db.getAllPolls();
    const weekly = polls.find((p) => p.question === "Legacy Q");
    const daily = polls.find((p) => p.question === "Daily");
    expect(weekly?.training_day).toBe(2);
    expect(daily?.training_day).toBeNull();
  });

  // Regression : initDb doit tourner sur une DB v1.0 qui n'a AUCUNE des colonnes
  // ajoutees par migrations successives (send_id, group_name, role, last_seen_at,
  // training_day). Bug reel : CREATE INDEX idx_votes_send exécuté avant migrate()
  // crashait "no such column: send_id" sur une telle DB.
  it("migration depuis une DB legacy v1.0 complete (sans send_id, group_name, role, training_day)", () => {
    const legacyPath = freshDbPath();
    const legacy = new Database(legacyPath);
    // Schema minimal pre-toutes-migrations : pas de send_id sur poll_votes,
    // pas de group_name sur poll_sends, pas de role/last_seen_at sur sessions,
    // pas de training_day sur polls.
    legacy.exec(`
      CREATE TABLE polls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        question TEXT NOT NULL,
        options TEXT NOT NULL,
        cron_expression TEXT NOT NULL,
        group_ids TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        allow_multiple_answers INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE poll_sends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        poll_id INTEGER NOT NULL,
        group_id TEXT NOT NULL,
        message_id TEXT,
        sent_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
      );
      CREATE TABLE poll_votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        poll_id INTEGER NOT NULL,
        group_id TEXT NOT NULL,
        voter TEXT NOT NULL,
        voter_name TEXT DEFAULT '',
        selected_options TEXT NOT NULL,
        voted_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
      );
      CREATE TABLE sessions (
        token TEXT PRIMARY KEY,
        phone TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE poll_message_map (
        message_id TEXT PRIMARY KEY,
        poll_id INTEGER NOT NULL,
        FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
      );
      INSERT INTO polls (question, options, cron_expression, group_ids)
      VALUES ('Weekly Mardi', '["Oui","Non"]', '0 9 * * 2', '["g1"]'),
             ('Weekdays', '["Oui","Non"]', '0 9 * * 1-5', '["g1"]'),
             ('Daily', '["Oui","Non"]', '0 8 * * *', '["g1"]'),
             ('Custom 2,4', '["Oui","Non"]', '0 18 * * 2,4', '["g1"]'),
             ('Biweekly', '["Oui","Non"]', '0 9 1-7,15-21 * 2', '["g1"]');
      INSERT INTO poll_sends (poll_id, group_id, message_id) VALUES (1, 'g1', 'msg1');
      INSERT INTO poll_votes (poll_id, group_id, voter, voter_name, selected_options)
      VALUES (1, 'g1', 'v1@c.us', 'Alice', '["Oui"]');
    `);
    legacy.close();

    db.closeDb();
    process.env.POLLS_DB_PATH = legacyPath;
    expect(() => db.initDb()).not.toThrow();

    const verif = new Database(legacyPath);
    const pollCols = verif.prepare("PRAGMA table_info(polls)").all() as any[];
    const sendCols = verif.prepare("PRAGMA table_info(poll_sends)").all() as any[];
    const voteCols = verif.prepare("PRAGMA table_info(poll_votes)").all() as any[];
    const sessionCols = verif.prepare("PRAGMA table_info(sessions)").all() as any[];
    expect(pollCols.map((c) => c.name)).toContain("training_day");
    expect(sendCols.map((c) => c.name)).toContain("group_name");
    expect(voteCols.map((c) => c.name)).toContain("send_id");
    expect(sessionCols.map((c) => c.name)).toContain("role");
    expect(sessionCols.map((c) => c.name)).toContain("last_seen_at");

    // L'index idx_votes_send doit maintenant exister (create apres migrate)
    const indexes = verif.prepare("PRAGMA index_list(poll_votes)").all() as any[];
    expect(indexes.some((i) => i.name === "idx_votes_send")).toBe(true);
    // Les autres indexes du bloc post-migrate doivent aussi etre presents
    const sendIndexes = verif.prepare("PRAGMA index_list(poll_sends)").all() as any[];
    expect(sendIndexes.some((i) => i.name === "idx_sends_poll_date")).toBe(true);
    const snapIndexes = verif
      .prepare("PRAGMA index_list(poll_results_snapshot)")
      .all() as any[];
    expect(snapIndexes.some((i) => i.name === "idx_snapshot_poll_date")).toBe(true);
    expect(snapIndexes.some((i) => i.name === "idx_snapshot_training_day")).toBe(true);
    verif.close();

    // Les donnees existantes survivent et restent lisibles
    const polls = db.getAllPolls();
    expect(polls).toHaveLength(5);
    // Backfill strict : seul "Weekly Mardi" (pattern strict "N") est remplie
    expect(polls.find((p) => p.question === "Weekly Mardi")?.training_day).toBe(2);
    expect(polls.find((p) => p.question === "Weekdays")?.training_day).toBeNull();
    expect(polls.find((p) => p.question === "Daily")?.training_day).toBeNull();
    // "Custom 2,4" ne doit PAS etre silencieusement classé Mardi (bug parseInt("2,4")=2)
    expect(polls.find((p) => p.question === "Custom 2,4")?.training_day).toBeNull();
    // "Biweekly" (dom != *) ne doit pas etre classé comme weekly simple
    expect(polls.find((p) => p.question === "Biweekly")?.training_day).toBeNull();
  });

  // Regression : le re-run de initDb sur une DB deja migree doit etre idempotent
  // meme si elle contient des donnees — la verif de colonne precedente ne doit pas
  // retenter les ALTER TABLE et l'index doit etre deja present.
  it("re-run idempotent apres migration sur DB avec donnees", () => {
    const legacyPath = freshDbPath();
    const legacy = new Database(legacyPath);
    legacy.exec(`
      CREATE TABLE polls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        question TEXT NOT NULL,
        options TEXT NOT NULL,
        cron_expression TEXT NOT NULL,
        group_ids TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        allow_multiple_answers INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO polls (question, options, cron_expression, group_ids)
      VALUES ('P1', '["A","B"]', '0 9 * * 2', '["g1"]');
    `);
    legacy.close();

    db.closeDb();
    process.env.POLLS_DB_PATH = legacyPath;
    db.initDb();
    const first = db.getAllPolls();

    db.closeDb();
    db.initDb();
    const second = db.getAllPolls();

    expect(second).toHaveLength(first.length);
    expect(second[0].id).toBe(first[0].id);
    expect(second[0].training_day).toBe(first[0].training_day);
  });
});
