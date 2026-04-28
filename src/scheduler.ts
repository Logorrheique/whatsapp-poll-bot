import { schedule, validate, type ScheduledTask } from "node-cron";
import * as db from "./db";
import { sendPollToGroups } from "./whatsapp";
import { SNAPSHOT_CRON } from "./constants";
import { pollDisplayTitle } from "./cronHelper";
import { config } from "./config";
import { alert } from "./alerter";
import { resolvePollContent } from "./services/phraseService";

const scheduledJobs = new Map<number, ScheduledTask>();
let snapshotTask: ScheduledTask | null = null;

const TIMEZONE = config.TIMEZONE;

export function initScheduler(): void {
  const polls = db.getActivePolls();
  console.log(`⏰ Chargement de ${polls.length} sondage(s) actif(s)...`);

  for (const poll of polls) {
    schedulePoll(poll.id, poll.cron_expression);
  }

  registerSnapshotTask();
}

function registerSnapshotTask(): void {
  if (snapshotTask) {
    // destroy() stop() + libere les listeners du task emitter + marque le task
    // comme detruit. stop() seul laisse l'objet vivant (leak sur hot-reload
    // repete). Voir node-cron v4 docs.
    try {
      snapshotTask.destroy();
    } catch {
      // Older versions may not have .destroy()
      try {
        snapshotTask.stop();
      } catch {
        // ignore
      }
    }
    snapshotTask = null;
  }
  snapshotTask = schedule(
    SNAPSHOT_CRON,
    async () => {
      try {
        await runSnapshotPass();
      } catch (err) {
        console.error("❌ Erreur cron snapshot résultats:", err);
        // Issue #33 : alerting critique pour qu'un crash du cron snapshot
        // ne passe pas silencieusement dans stdout Railway.
        void alert("critical", "Cron snapshot résultats a crashé", (err as Error)?.stack || String(err));
      }
    },
    { timezone: TIMEZONE, noOverlap: true }
  );
  const next = snapshotTask.getNextRun();
  console.log(
    `📸 Snapshot task programmé: ${SNAPSHOT_CRON} (${TIMEZONE}) — prochain: ${next?.toISOString() || "?"}`
  );
}

// Exported for manual trigger / tests
export async function runSnapshotPass(): Promise<{
  written: number;
  skipped: number;
  candidates: number;
}> {
  const { dow, date } = computeYesterdayInTimezone(TIMEZONE);
  const candidates = db.getPollsByTrainingDay(dow);
  let written = 0;
  let skipped = 0;
  for (const poll of candidates) {
    const send = db.getLatestSendForPollOnDate(poll.id, date);
    if (!send) {
      skipped++;
      continue;
    }
    const summary = db.getResultsForSend(send.id);
    const total = summary.reduce((acc, s) => acc + s.count, 0);
    // Issue #55 : populate les metadata contextuelles — question brute,
    // cron au moment du snapshot, groupes ciblés. Permet au data-analyste
    // de reconstruire le contexte même si le poll est modifié plus tard.
    const inserted = db.createResultsSnapshot({
      poll_id: poll.id,
      send_id: send.id,
      training_date: date,
      training_day: dow,
      summary,
      total_votes: total,
      display_title: pollDisplayTitle(poll),
      question_raw: poll.question,
      cron_expression: poll.cron_expression,
      group_ids: poll.group_ids,
      expected_count: null, // non-tracké pour l'instant (pas de table "attendus")
    });
    if (inserted) written++;
    else skipped++;
  }
  console.log(
    `📸 Snapshots résultats: ${written} écrits / ${skipped} skippés / ${candidates.length} candidats (training_day=${dow}, date=${date})`
  );
  return { written, skipped, candidates: candidates.length };
}

// Computes yesterday's date (YYYY-MM-DD) and day-of-week (0=Sun..6=Sat)
// in the given IANA timezone. Robust to DST because we anchor on a
// timezone-local "today" string then subtract one day via UTC midnight.
export function computeYesterdayInTimezone(
  timezone: string,
  now: Date = new Date()
): {
  dow: number;
  date: string;
} {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const todayStr = fmt.format(now); // YYYY-MM-DD
  const todayUtcMidnight = new Date(`${todayStr}T00:00:00Z`).getTime();
  const yesterdayUtcMidnight = new Date(todayUtcMidnight - 86400000);
  const y = yesterdayUtcMidnight.getUTCFullYear();
  const m = String(yesterdayUtcMidnight.getUTCMonth() + 1).padStart(2, "0");
  const d = String(yesterdayUtcMidnight.getUTCDate()).padStart(2, "0");
  const date = `${y}-${m}-${d}`;
  const dow = yesterdayUtcMidnight.getUTCDay();
  return { dow, date };
}

export function schedulePoll(pollId: number, cronExpression: string): boolean {
  if (!validate(cronExpression)) {
    console.error(`Expression cron invalide pour sondage #${pollId}: ${cronExpression}`);
    return false;
  }

  unschedulePoll(pollId);

  const task = schedule(
    cronExpression,
    async () => {
      const poll = db.getPoll(pollId);
      if (!poll || !poll.is_active) {
        unschedulePoll(pollId);
        return;
      }

      // Bibliothèque de phrases : si activée sur ce poll, tirage aléatoire
      // à chaque envoi. Si library incomplète → on annule l'envoi proprement
      // et on alerte (les autres sends programmés ne sont pas affectés).
      const resolved = resolvePollContent(poll);
      if (!resolved) {
        const msg = `Bibliothèque de phrases incomplète pour le poll #${pollId} (manque title/yes/no/quit pour training_day=${poll.training_day})`;
        console.error(`❌ ${msg}`);
        // Issue #66 : trace le skip dans audit_logs pour que l'admin
        // puisse voir POURQUOI un envoi prévu n'est jamais arrivé sans
        // avoir à fouiller les logs Railway.
        try {
          db.addAuditLog("scheduler", "poll_send_skipped", `#${pollId}: ${msg}`);
        } catch { /* audit non critique */ }
        void alert("error", `Envoi annulé poll #${pollId}`, msg);
        return;
      }

      const title = resolved.source === "library" ? resolved.question : pollDisplayTitle(poll);
      const options = resolved.options;
      console.log(`⏰ Envoi programmé du sondage #${pollId}: "${title}" (${resolved.source})`);
      try {
        await sendPollToGroups(
          poll.id,
          poll.group_ids,
          title,
          options,
          poll.allow_multiple_answers
        );
      } catch (err) {
        console.error(`❌ Erreur envoi programmé sondage #${pollId}:`, err);
      }
    },
    {
      timezone: TIMEZONE,
      noOverlap: true,
    }
  );

  scheduledJobs.set(pollId, task);
  const next = task.getNextRun();
  console.log(
    `📅 Sondage #${pollId} programmé: ${cronExpression} (${TIMEZONE}) — prochain: ${next?.toISOString() || "?"}`
  );
  return true;
}

export function unschedulePoll(pollId: number): void {
  const existing = scheduledJobs.get(pollId);
  if (existing) {
    try {
      existing.destroy();
    } catch {
      try {
        existing.stop();
      } catch {
        // ignore
      }
    }
    scheduledJobs.delete(pollId);
  }
}

// Stoppe tous les cron jobs (polls + snapshot). Appelé depuis le shutdown
// gracieux SIGTERM/SIGINT — sans ça, node-cron garde le process vivant.
export function stopScheduler(): void {
  for (const [pollId, task] of scheduledJobs) {
    try {
      task.destroy();
    } catch {
      try { task.stop(); } catch { /* ignore */ }
    }
    scheduledJobs.delete(pollId);
  }
  if (snapshotTask) {
    try {
      snapshotTask.destroy();
    } catch {
      try { snapshotTask.stop(); } catch { /* ignore */ }
    }
    snapshotTask = null;
  }
}
