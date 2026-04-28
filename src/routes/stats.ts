// Stats d'usage (issue #57) — visibles admin uniquement.
//
// Chiffres agrégés pour piloter la roadmap (cf. ROADMAP.md / SLA.md) :
// combien de polls on a, combien partent par semaine, combien de votes on
// a reçus sur 30 jours, qui est actif. Toutes les requêtes passent par
// des prepared statements dans db.ts quand elles existent, sinon on les
// fait ici avec des statements préparés inline pour ne pas polluer le
// module DB avec un cas d'agrégation.

import { Router, Request, Response } from "express";
import * as db from "../db";
import { ONE_DAY, ONLINE_WINDOW } from "../constants";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  const rawDb = db.getDb();
  const now = Date.now();
  const cutoff30d = new Date(now - 30 * ONE_DAY).toISOString();
  const cutoff4w = new Date(now - 28 * ONE_DAY).toISOString();

  const polls_total = (rawDb.prepare("SELECT COUNT(*) AS c FROM polls").get() as any).c;
  const polls_active = (rawDb
    .prepare("SELECT COUNT(*) AS c FROM polls WHERE is_active = 1")
    .get() as any).c;

  const sends_4w = (rawDb
    .prepare("SELECT COUNT(*) AS c FROM poll_sends WHERE sent_at >= ?")
    .get(cutoff4w) as any).c;
  const polls_per_week_avg = Number((sends_4w / 4).toFixed(2));

  const votes_total_30d = (rawDb
    .prepare("SELECT COUNT(*) AS c FROM poll_votes WHERE voted_at >= ?")
    .get(cutoff30d) as any).c;

  const admins_active_30d = (rawDb
    .prepare(
      `SELECT COUNT(DISTINCT phone) AS c FROM sessions
       WHERE role = 'admin' AND last_seen_at >= ?`
    )
    .get(cutoff30d) as any).c;

  const viewers_total = db.listViewers().length;
  const whitelist_total = db.countAllowedPhones();
  const online_now = db.getOnlineUsers(ONLINE_WINDOW).length;

  // Taux de participation moyen = sum(total_votes) / sum(group_size or votes) sur les 4 dernières semaines.
  // On n'a pas de notion de "attendus" (cf. #55), donc on approxime :
  // moyenne du total_votes par snapshot sur 30 jours. Si zéro snapshot, null.
  const snapRow = rawDb
    .prepare(
      `SELECT AVG(total_votes) AS avg_votes, COUNT(*) AS n
       FROM poll_results_snapshot WHERE training_date >= ?`
    )
    .get(
      new Date(now - 30 * ONE_DAY).toISOString().slice(0, 10)
    ) as { avg_votes: number | null; n: number };
  const avg_votes_per_snapshot_30d =
    snapRow && snapRow.n > 0 && snapRow.avg_votes !== null
      ? Number(snapRow.avg_votes.toFixed(2))
      : null;

  res.json({
    polls_total,
    polls_active,
    polls_per_week_avg,
    votes_total_30d,
    admins_active_30d,
    viewers_total,
    whitelist_total,
    online_now,
    avg_votes_per_snapshot_30d,
  });
});

export default router;
