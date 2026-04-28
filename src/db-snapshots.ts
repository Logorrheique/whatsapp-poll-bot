// Snapshots poll_results_snapshot (extrait de db.ts — issue #47).
//
// Regroupe tous les helpers autour de la table `poll_results_snapshot` :
// createResultsSnapshot, upsertResultsSnapshot (issue #56),
// listSnapshotsForPoll, listAllSnapshots (issue #54).
// La DB instance est obtenue via `getDb()` pour préserver l'invariant
// "initDb a été appelé avant".
//
// db.ts re-exporte depuis ce fichier — les callers `import * as db from "./db"`
// ne changent pas.

import { getDb, safeJsonParseForSnapshots } from "./db";
import type { PollResultsSnapshot } from "./types";

function rowToSnapshot(row: any): PollResultsSnapshot {
  return {
    id: row.id,
    poll_id: row.poll_id,
    send_id: row.send_id ?? null,
    training_date: row.training_date,
    training_day: Number(row.training_day),
    summary: safeJsonParseForSnapshots<PollResultsSnapshot["summary"]>(
      row.summary,
      [],
      `snapshot#${row.id}.summary`
    ),
    total_votes: Number(row.total_votes),
    display_title: row.display_title,
    created_at: row.created_at,
    question_raw: row.question_raw ?? null,
    cron_expression: row.cron_expression ?? null,
    group_ids: row.group_ids
      ? safeJsonParseForSnapshots<string[]>(row.group_ids, [], `snapshot#${row.id}.group_ids`)
      : null,
    expected_count: row.expected_count ?? null,
  };
}

export interface CreateSnapshotInput {
  poll_id: number;
  send_id: number | null;
  training_date: string;
  training_day: number;
  summary: { option: string; count: number; voters: string[] }[];
  total_votes: number;
  display_title: string;
  question_raw?: string | null;
  cron_expression?: string | null;
  group_ids?: string[] | null;
  expected_count?: number | null;
}

// Idempotent : INSERT OR IGNORE sur UNIQUE(poll_id, training_date).
// Retourne true si une ligne a été insérée, false si doublon.
export function createResultsSnapshot(input: CreateSnapshotInput): boolean {
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO poll_results_snapshot
       (poll_id, send_id, training_date, training_day, summary, total_votes, display_title,
        question_raw, cron_expression, group_ids, expected_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.poll_id,
      input.send_id,
      input.training_date,
      input.training_day,
      JSON.stringify(input.summary),
      input.total_votes,
      input.display_title,
      input.question_raw ?? null,
      input.cron_expression ?? null,
      input.group_ids ? JSON.stringify(input.group_ids) : null,
      input.expected_count ?? null
    );
  return result.changes > 0;
}

// Issue #56 : UPSERT pour re-figer un snapshot a posteriori (votes tardifs).
// Écrase les colonnes data mais garde `created_at` pour traçabilité.
export function upsertResultsSnapshot(input: CreateSnapshotInput): boolean {
  const result = getDb()
    .prepare(
      `INSERT INTO poll_results_snapshot
         (poll_id, send_id, training_date, training_day, summary, total_votes, display_title,
          question_raw, cron_expression, group_ids, expected_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(poll_id, training_date) DO UPDATE SET
         send_id = excluded.send_id,
         training_day = excluded.training_day,
         summary = excluded.summary,
         total_votes = excluded.total_votes,
         display_title = excluded.display_title,
         question_raw = excluded.question_raw,
         cron_expression = excluded.cron_expression,
         group_ids = excluded.group_ids,
         expected_count = excluded.expected_count`
    )
    .run(
      input.poll_id,
      input.send_id,
      input.training_date,
      input.training_day,
      JSON.stringify(input.summary),
      input.total_votes,
      input.display_title,
      input.question_raw ?? null,
      input.cron_expression ?? null,
      input.group_ids ? JSON.stringify(input.group_ids) : null,
      input.expected_count ?? null
    );
  return result.changes > 0;
}

export function listSnapshotsForPoll(pollId: number): PollResultsSnapshot[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM poll_results_snapshot WHERE poll_id = ? ORDER BY training_date DESC"
    )
    .all(pollId) as any[];
  return rows.map(rowToSnapshot);
}

// Issue #54 : liste sur une fenêtre date (optionnelle) pour export CSV/JSON.
// Bornes inclusives YYYY-MM-DD. La validation du format est faite côté route.
export function listAllSnapshots(
  fromDate?: string,
  toDate?: string
): PollResultsSnapshot[] {
  const db = getDb();
  if (fromDate && toDate) {
    return (db
      .prepare(
        "SELECT * FROM poll_results_snapshot WHERE training_date >= ? AND training_date <= ? ORDER BY training_date DESC, poll_id"
      )
      .all(fromDate, toDate) as any[]).map(rowToSnapshot);
  }
  if (fromDate) {
    return (db
      .prepare(
        "SELECT * FROM poll_results_snapshot WHERE training_date >= ? ORDER BY training_date DESC, poll_id"
      )
      .all(fromDate) as any[]).map(rowToSnapshot);
  }
  if (toDate) {
    return (db
      .prepare(
        "SELECT * FROM poll_results_snapshot WHERE training_date <= ? ORDER BY training_date DESC, poll_id"
      )
      .all(toDate) as any[]).map(rowToSnapshot);
  }
  return (db
    .prepare(
      "SELECT * FROM poll_results_snapshot ORDER BY training_date DESC, poll_id"
    )
    .all() as any[]).map(rowToSnapshot);
}
