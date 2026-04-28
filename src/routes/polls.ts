import { Router, Request, Response } from "express";
import * as db from "../db";
import {
  createAndSchedulePoll,
  updateAndReschedulePoll,
  deleteAndUnschedulePoll,
} from "../services/pollService";
import { resolvePollContent, getStatusForPoll } from "../services/phraseService";
import { sendPollToGroups, refreshAllVoterNames } from "../whatsapp";
import { validate as cronValidate } from "node-cron";
import { requireWriter } from "../middleware/requireWriter";
import { getCallerPhone, DATE_REGEX, GROUP_ID_REGEX } from "../utils";
import { DEFAULT_DAYS_KEPT, DISPLAY_DAYS_KEPT } from "../constants";
import { pollDisplayTitle } from "../cronHelper";
import type { Poll, PollWithDisplay } from "../types";

const router = Router();

function enrichPoll<T extends Poll>(poll: T): T & { display_title: string } {
  return { ...poll, display_title: pollDisplayTitle(poll) };
}

function validateTrainingDay(value: unknown): number | null | "invalid" {
  if (value === undefined || value === null) return null;
  // Rejet strict : seuls number et string non vide sont acceptés.
  // Sans ce guard, Number("") === 0, Number([]) === 0, Number(true) === 1 passaient.
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || value > 6) return "invalid";
    return value;
  }
  if (typeof value === "string") {
    if (!/^[0-6]$/.test(value.trim())) return "invalid";
    return Number(value.trim());
  }
  return "invalid";
}

// Valide qu'un tableau est non vide et que chaque élément est une string non vide
// respectant la regex optionnelle. Évite les array-like objects, les strings, etc.
function validateStringArray(
  value: unknown,
  minLength: number,
  itemRegex?: RegExp
): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length < minLength) return null;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const trimmed = item.trim();
    if (!trimmed) return null;
    if (itemRegex && !itemRegex.test(trimmed)) return null;
    result.push(trimmed);
  }
  return result;
}

// GET /api/polls — list all polls
router.get("/", (_req: Request, res: Response) => {
  const polls = db.getAllPolls();
  res.json(polls.map(enrichPoll));
});

// POST /api/polls/refresh-names — rafraîchit les noms des votants existants
router.post("/refresh-names", requireWriter, async (_req: Request, res: Response) => {
  try {
    const result = await refreshAllVoterNames();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Erreur" });
  }
});

// Issue #66 : endpoint diagnostic — pourquoi un poll ne s'envoie pas ?
// Retourne can_send + raisons (library incomplète, training_day sans titre,
// poll inactif). À déclarer avant /:id pour ne pas être capturé.
router.get("/:id/diagnose", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const poll = db.getPoll(id);
  if (!poll) {
    res.status(404).json({ error: "Sondage non trouvé" });
    return;
  }
  const reasons: string[] = [];
  if (!poll.is_active) reasons.push("Le sondage est désactivé (is_active=false)");
  if (!poll.group_ids || poll.group_ids.length === 0) reasons.push("Aucun groupe assigné");
  let libraryStatus = null;
  if (poll.use_phrase_library) {
    const status = getStatusForPoll(poll.training_day);
    libraryStatus = status;
    if (!status.ready) {
      reasons.push(
        `Bibliothèque incomplète pour ce poll : manque ${status.missing.join(", ")}` +
          (poll.training_day !== null
            ? ` (training_day=${poll.training_day})`
            : "")
      );
    }
  }
  // Test final : appeler resolvePollContent pour valider de bout en bout
  const resolved = resolvePollContent(poll);
  if (!resolved) {
    if (reasons.length === 0) {
      reasons.push(
        "resolvePollContent a retourné null sans cause identifiable — vérifier les logs"
      );
    }
  }
  res.json({
    poll_id: id,
    can_send: reasons.length === 0,
    use_phrase_library: poll.use_phrase_library,
    training_day: poll.training_day,
    is_active: poll.is_active,
    group_count: poll.group_ids?.length ?? 0,
    library_status: libraryStatus,
    resolved_preview: resolved
      ? { question: resolved.question, options: resolved.options, source: resolved.source }
      : null,
    reasons,
  });
});

// GET /api/polls/by-training-day?day=N[&group_id=xxx]
// Doit être déclaré avant /:id (Express route ordering)
router.get("/by-training-day", (req: Request, res: Response) => {
  const dayRaw = req.query.day;
  const parsed = validateTrainingDay(dayRaw);
  if (parsed === "invalid" || parsed === null) {
    res.status(400).json({ error: "Paramètre day=0..6 requis" });
    return;
  }
  const day = parsed;

  const groupIdRaw = req.query.group_id ? String(req.query.group_id) : undefined;
  const groupId =
    groupIdRaw && GROUP_ID_REGEX.test(groupIdRaw) ? groupIdRaw : undefined;

  const polls = db.getPollsByTrainingDay(day);
  const send_groups_by_poll: Record<number, db.SendGroup[]> = {};
  for (const poll of polls) {
    send_groups_by_poll[poll.id] = db.getSendGroupsForPoll(
      poll.id,
      DISPLAY_DAYS_KEPT,
      groupId
    );
  }

  res.json({
    day,
    polls: polls.map(enrichPoll),
    send_groups_by_poll,
  });
});

// GET /api/polls/sends/by-date?date=YYYY-MM-DD[&group_id=xxx]
// Conservé pour rétro-compat (ancien frontend), fenêtre DISPLAY_DAYS_KEPT non appliquée ici
// car on filtre par date explicite.
router.get("/sends/by-date", (req: Request, res: Response) => {
  const date = String(req.query.date || "");
  if (!DATE_REGEX.test(date)) {
    res.status(400).json({ error: "Date YYYY-MM-DD requise" });
    return;
  }
  const groupIdRaw = req.query.group_id ? String(req.query.group_id) : undefined;
  const groupId =
    groupIdRaw && GROUP_ID_REGEX.test(groupIdRaw) ? groupIdRaw : undefined;

  const sends = db.getSendsByDate(date, groupId);
  res.json({ date, sends });
});

// GET /api/polls/groups/active — groupes ayant au moins un send dans la fenêtre UI (9j)
router.get("/groups/active", (_req: Request, res: Response) => {
  const groups = db.listActiveGroups(DISPLAY_DAYS_KEPT);
  res.json(groups);
});

// GET /api/polls/snapshots/export?format=csv&from=YYYY-MM-DD&to=YYYY-MM-DD
// Issue #54 : export flat data-science. Déclaré AVANT /:id pour que l'URL
// statique "snapshots" ne soit pas capturée comme paramètre :id.
router.get("/snapshots/export", (req: Request, res: Response) => {
  const format = String(req.query.format || "csv").toLowerCase();
  const from = req.query.from ? String(req.query.from) : undefined;
  const to = req.query.to ? String(req.query.to) : undefined;
  if (from && !DATE_REGEX.test(from)) {
    res.status(400).json({ error: "from invalide (attendu YYYY-MM-DD)" });
    return;
  }
  if (to && !DATE_REGEX.test(to)) {
    res.status(400).json({ error: "to invalide (attendu YYYY-MM-DD)" });
    return;
  }
  if (format !== "csv" && format !== "json") {
    res.status(400).json({ error: "format invalide (csv ou json)" });
    return;
  }
  const snapshots = db.listAllSnapshots(from, to);

  if (format === "json") {
    res.json(snapshots);
    return;
  }

  // CSV flat : une ligne par voter (colonne option). Directement pandas-friendly.
  // CRLF et quoting RFC 4180 : guillemets doublés dans les chaînes, tout
  // champ contenant guillemet/virgule/newline est quoted.
  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? "" : String(v);
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const header = [
    "poll_id",
    "training_date",
    "training_day",
    "display_title",
    "total_votes",
    "option",
    "option_count",
    "voter",
  ];
  const lines: string[] = [header.join(",")];
  for (const snap of snapshots) {
    for (const opt of snap.summary) {
      if (opt.voters.length === 0) {
        lines.push([
          snap.poll_id,
          snap.training_date,
          snap.training_day,
          esc(snap.display_title),
          snap.total_votes,
          esc(opt.option),
          opt.count,
          "",
        ].join(","));
      } else {
        for (const voter of opt.voters) {
          lines.push([
            snap.poll_id,
            snap.training_date,
            snap.training_day,
            esc(snap.display_title),
            snap.total_votes,
            esc(opt.option),
            opt.count,
            esc(voter),
          ].join(","));
        }
      }
    }
  }
  res.type("text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="snapshots${from ? `_${from}` : ""}${to ? `_${to}` : ""}.csv"`
  );
  res.send(lines.join("\r\n") + "\r\n");
});

// POST /api/polls/:id/snapshots/recompute?date=YYYY-MM-DD
// Issue #56 : permet de re-figer un snapshot a posteriori quand des votes
// tardifs (arrivés après le cron 8h) ont été enregistrés dans poll_votes
// mais pas inclus dans le snapshot. Writer only — modification data durable.
router.post("/:id/snapshots/recompute", requireWriter, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const date = req.query.date ? String(req.query.date) : "";
  if (!DATE_REGEX.test(date)) {
    res.status(400).json({ error: "date requise (YYYY-MM-DD)" });
    return;
  }
  const poll = db.getPoll(id);
  if (!poll) {
    res.status(404).json({ error: "Sondage non trouvé" });
    return;
  }
  const send = db.getLatestSendForPollOnDate(id, date);
  if (!send) {
    res.status(404).json({ error: "Aucun envoi trouvé pour cette date" });
    return;
  }
  const summary = db.getResultsForSend(send.id);
  const total = summary.reduce((acc, s) => acc + s.count, 0);
  const dow = new Date(date + "T12:00:00Z").getUTCDay();
  db.upsertResultsSnapshot({
    poll_id: id,
    send_id: send.id,
    training_date: date,
    training_day: poll.training_day ?? dow,
    summary,
    total_votes: total,
    display_title: pollDisplayTitle(poll),
    // Issue #55 : propager les metadata contextuelles à chaque recompute
    // pour garder les lignes cohérentes avec le cron automatique.
    question_raw: poll.question,
    cron_expression: poll.cron_expression,
    group_ids: poll.group_ids,
    expected_count: null,
  });
  db.addAuditLog(
    getCallerPhone(req.headers.authorization) || "unknown",
    "snapshot_recompute",
    `poll_id=${id} date=${date} total=${total}`
  );
  res.json({ ok: true, poll_id: id, training_date: date, total_votes: total });
});

// GET /api/polls/:id/snapshots — liste durable des snapshots data science
// Déclaré avant /:id pour éviter conflit de routing
router.get("/:id/snapshots", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const poll = db.getPoll(id);
  if (!poll) {
    res.status(404).json({ error: "Sondage non trouvé" });
    return;
  }
  const snapshots = db.listSnapshotsForPoll(id);
  res.json({ poll: enrichPoll(poll), snapshots });
});

// DELETE /api/polls/:id/sends/:sendId — supprime un envoi unique (et ses
// votes via FK CASCADE). Le poll lui-même reste intact, seule cette
// occurrence dans l'historique disparaît.
router.delete("/:id/sends/:sendId", requireWriter, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const sendId = Number(req.params.sendId);
  if (!Number.isInteger(id) || id < 1 || !Number.isInteger(sendId) || sendId < 1) {
    res.status(400).json({ error: "ID invalide" });
    return;
  }
  const poll = db.getPoll(id);
  if (!poll) {
    res.status(404).json({ error: "Sondage non trouvé" });
    return;
  }
  const ok = db.deleteSend(sendId);
  if (!ok) {
    res.status(404).json({ error: "Envoi non trouvé" });
    return;
  }
  db.addAuditLog(
    getCallerPhone(req.headers.authorization) || "unknown",
    "send_deleted",
    `poll_id=${id} send_id=${sendId}`
  );
  res.json({ ok: true, poll_id: id, send_id: sendId });
});

// GET /api/polls/:id/sends/:sendId/results — résultats d'un envoi spécifique
router.get("/:id/sends/:sendId/results", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const sendId = Number(req.params.sendId);
  const poll = db.getPoll(id);
  if (!poll) {
    res.status(404).json({ error: "Sondage non trouvé" });
    return;
  }

  const summary = db.getResultsForSend(sendId);
  const votes = db.getVotesForSend(sendId);

  res.json({
    poll: enrichPoll(poll),
    send_id: sendId,
    summary,
    total_votes: votes.length,
    votes,
  });
});

// GET /api/polls/:id/history[?group_id=xxx][&include=results] — groupes de sends par date.
// Issue #51 : avec ?include=results, attache les résultats détaillés de chaque
// send dans un seul appel (au lieu de N fetches /sends/:id/results côté front
// qui saturaient l'apiLimiter).
router.get("/:id/history", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const poll = db.getPoll(id);
  if (!poll) {
    res.status(404).json({ error: "Sondage non trouvé" });
    return;
  }

  const groupIdRaw = req.query.group_id ? String(req.query.group_id) : undefined;
  const groupId =
    groupIdRaw && GROUP_ID_REGEX.test(groupIdRaw) ? groupIdRaw : undefined;

  const groups = db.getSendGroupsForPoll(id, DISPLAY_DAYS_KEPT, groupId);

  if (req.query.include === "results") {
    const allSendIds = groups.flatMap((g) => g.sends.map((s) => s.id));
    const resultsBySend = db.getResultsForSendIds(id, allSendIds);
    const groupsWithResults = groups.map((g) => ({
      ...g,
      sends: g.sends.map((s) => ({
        ...s,
        summary: resultsBySend.get(s.id) ?? [],
      })),
    }));
    res.json({ poll: enrichPoll(poll), groups: groupsWithResults });
    return;
  }

  res.json({ poll: enrichPoll(poll), groups });
});

// GET /api/polls/:id/results — get poll results
router.get("/:id/results", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const poll = db.getPoll(id);
  if (!poll) {
    res.status(404).json({ error: "Sondage non trouvé" });
    return;
  }

  const summary = db.getResultsSummary(id, DISPLAY_DAYS_KEPT);
  const votes = db.getVotesForPoll(id, DISPLAY_DAYS_KEPT);
  const sends = db.getSendsForPoll(id, DISPLAY_DAYS_KEPT);

  res.json({
    poll: enrichPoll(poll),
    summary,
    total_votes: votes.length,
    votes,
    sends,
  });
});

// GET /api/polls/:id — get single poll
router.get("/:id", (req: Request, res: Response) => {
  const poll = db.getPoll(Number(req.params.id));
  if (!poll) {
    res.status(404).json({ error: "Sondage non trouvé" });
    return;
  }
  res.json(enrichPoll(poll));
});

// POST /api/polls — create poll
router.post("/", requireWriter, (req: Request, res: Response) => {
  const {
    question,
    options,
    cron_expression,
    group_ids,
    allow_multiple_answers,
    training_day,
  } = req.body;

  // Validation stricte des tableaux — rejet des array-like objects qui
  // corrompraient la DB en sérialisant du JSON non-array.
  const validatedOptions = validateStringArray(options, 2);
  if (!validatedOptions) {
    res.status(400).json({
      error: "options doit être un tableau de 2+ strings non vides",
    });
    return;
  }

  const validatedGroupIds = validateStringArray(group_ids, 1, GROUP_ID_REGEX);
  if (!validatedGroupIds) {
    res.status(400).json({
      error: "group_ids doit être un tableau d'IDs de groupes valides",
    });
    return;
  }

  if (typeof cron_expression !== "string" || !cron_expression) {
    res.status(400).json({ error: "cron_expression requise" });
    return;
  }

  const parsedDay = validateTrainingDay(training_day);
  if (parsedDay === "invalid") {
    res.status(400).json({ error: "training_day doit être entre 0 et 6" });
    return;
  }

  const trimmedQuestion = typeof question === "string" ? question.trim() : "";
  if (!trimmedQuestion && parsedDay === null) {
    res.status(400).json({
      error: "Question requise si aucun jour d'entraînement n'est défini",
    });
    return;
  }

  if (!cronValidate(cron_expression)) {
    res.status(400).json({ error: "Expression cron invalide" });
    return;
  }

  // Bibliothèque de phrases : flag opt-in. Si true, question/options sont
  // ignorés à l'envoi (tirage aléatoire à chaque send). On n'invalide PAS
  // la création même si la library est encore vide — l'erreur remonte au
  // moment du send (resolvePollContent → null → alert).
  const useLibrary = Boolean((req.body as any).use_phrase_library);

  // Issue #45 — service layer : orchestration create + schedule factorisée
  // dans pollService.createAndSchedulePoll.
  const poll = createAndSchedulePoll({
    question: trimmedQuestion,
    options: validatedOptions,
    cron_expression,
    group_ids: validatedGroupIds,
    allow_multiple_answers: Boolean(allow_multiple_answers),
    training_day: parsedDay,
    use_phrase_library: useLibrary,
  });
  const title = pollDisplayTitle(poll);
  db.addAuditLog(
    getCallerPhone(req.headers.authorization),
    "poll_create",
    `#${poll.id}: ${title}`
  );
  res.status(201).json(enrichPoll(poll));
});

// PUT /api/polls/:id — update poll
router.put("/:id", requireWriter, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const body = req.body || {};
  const updates: Partial<import("../types").CreatePollInput> & {
    is_active?: boolean;
  } = {};

  if ("cron_expression" in body) {
    if (typeof body.cron_expression !== "string" || !cronValidate(body.cron_expression)) {
      res.status(400).json({ error: "Expression cron invalide" });
      return;
    }
    updates.cron_expression = body.cron_expression;
  }

  if ("options" in body) {
    const validated = validateStringArray(body.options, 2);
    if (!validated) {
      res.status(400).json({
        error: "options doit être un tableau de 2+ strings non vides",
      });
      return;
    }
    updates.options = validated;
  }

  if ("group_ids" in body) {
    const validated = validateStringArray(body.group_ids, 1, GROUP_ID_REGEX);
    if (!validated) {
      res.status(400).json({
        error: "group_ids doit être un tableau d'IDs de groupes valides",
      });
      return;
    }
    updates.group_ids = validated;
  }

  if ("allow_multiple_answers" in body) {
    updates.allow_multiple_answers = Boolean(body.allow_multiple_answers);
  }

  if ("is_active" in body) {
    updates.is_active = Boolean(body.is_active);
  }

  if ("training_day" in body) {
    const parsedDay = validateTrainingDay(body.training_day);
    if (parsedDay === "invalid") {
      res.status(400).json({ error: "training_day doit être entre 0 et 6" });
      return;
    }
    updates.training_day = parsedDay;
  }

  if ("use_phrase_library" in body) {
    updates.use_phrase_library = Boolean(body.use_phrase_library);
  }

  if ("question" in body) {
    if (typeof body.question !== "string") {
      res.status(400).json({ error: "question doit être une string" });
      return;
    }
    const trimmed = body.question.trim();
    const current = db.getPoll(id);
    const effectiveDay =
      "training_day" in updates ? updates.training_day : current?.training_day ?? null;
    if (!trimmed && effectiveDay === null) {
      res.status(400).json({
        error: "Question requise si aucun jour d'entraînement n'est défini",
      });
      return;
    }
    updates.question = trimmed;
  }

  // Issue #61 : route passe par pollService pour rester cohérente avec
  // POST. Le service gère l'update + (un)schedule en une opération.
  const poll = updateAndReschedulePoll(id, updates);
  if (!poll) {
    res.status(404).json({ error: "Sondage non trouvé" });
    return;
  }

  db.addAuditLog(
    getCallerPhone(req.headers.authorization),
    "poll_update",
    `#${poll.id}: ${pollDisplayTitle(poll)}`
  );
  res.json(enrichPoll(poll));
});

// DELETE /api/polls/:id — delete poll
router.delete("/:id", requireWriter, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  // Issue #61 : délègue unschedule + delete au service. Issue #60 : le
  // service purge aussi pollMessageMap en RAM pour éviter les votes
  // orphelins post-delete.
  const deleted = deleteAndUnschedulePoll(id);
  if (!deleted) {
    res.status(404).json({ error: "Sondage non trouvé" });
    return;
  }
  db.addAuditLog(getCallerPhone(req.headers.authorization), "poll_delete", `#${id}`);
  res.json({ success: true });
});

// POST /api/polls/:id/send — send poll now (manual trigger)
router.post("/:id/send", requireWriter, async (req: Request, res: Response) => {
  const poll = db.getPoll(Number(req.params.id));
  if (!poll) {
    res.status(404).json({ error: "Sondage non trouvé" });
    return;
  }

  // Résolution via phraseService : si poll.use_phrase_library, tirage
  // aléatoire ; sinon contenu figé. 422 si library incomplète (pas 500
  // pour distinguer du vrai crash).
  const resolved = resolvePollContent(poll);
  if (!resolved) {
    // Issue #66 : audit log + détails (training_day) pour faciliter le
    // debug quand l'admin ne comprend pas pourquoi un envoi manuel échoue.
    try {
      db.addAuditLog(
        getCallerPhone(req.headers.authorization),
        "poll_send_skipped",
        `#${poll.id}: library incomplete (training_day=${poll.training_day})`
      );
    } catch { /* audit non critique */ }
    res.status(422).json({
      error:
        "Bibliothèque incomplète : il manque au moins une phrase dans yes / no / quit. (Le titre est saisi dans le modal du sondage, pas dans la bibliothèque.)",
      training_day: poll.training_day,
      diagnose_url: `/api/polls/${poll.id}/diagnose`,
    });
    return;
  }

  const title = resolved.source === "library" ? resolved.question : pollDisplayTitle(poll);
  await sendPollToGroups(
    poll.id,
    poll.group_ids,
    title,
    resolved.options,
    poll.allow_multiple_answers
  );

  db.addAuditLog(
    getCallerPhone(req.headers.authorization),
    "poll_send",
    `#${poll.id}: ${title} (${resolved.source})`
  );
  res.json({ success: true, message: "Sondage envoyé", source: resolved.source });
});

export default router;
