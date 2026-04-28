// Service layer (issue #45) — starter.
//
// Avant : routes/polls.ts appelait db.createPoll puis schedulePoll
// directement, sans rien entre les deux. Ici on pose le pattern :
// un module `services/` qui orchestre plusieurs appels DB + effets de bord
// (scheduler, whatsapp) avec la transaction sémantique si besoin.
//
// Migration progressive : cette première fonction `createAndSchedule` sert
// de référence. Les PUT/DELETE/send devraient suivre le même pattern avant
// la prochaine release majeure — chaque mouvement est une PR séparée pour
// ne pas tout casser d'un coup.

import * as db from "../db";
import { schedulePoll, unschedulePoll } from "../scheduler";
import { removeMessageMappingsForPoll } from "../whatsapp";
import type { CreatePollInput, Poll } from "../types";

export function createAndSchedulePoll(input: CreatePollInput): Poll {
  // Création DB d'abord — si schedulePoll lève, on aura créé un poll
  // non-scheduled. Acceptable : un prochain boot rechargera tous les polls
  // actifs via initScheduler(). Pas de rollback explicite nécessaire.
  const poll = db.createPoll(input);
  if (poll.is_active) {
    schedulePoll(poll.id, poll.cron_expression);
  }
  return poll;
}

export function updateAndReschedulePoll(
  id: number,
  updates: Partial<CreatePollInput> & { is_active?: boolean }
): Poll | undefined {
  const next = db.updatePoll(id, updates);
  if (!next) return undefined;
  // Cas : désactivation → unschedule. Activation ou cron modifié →
  // re-schedule (remplace l'ancienne entrée).
  if (!next.is_active) {
    unschedulePoll(next.id);
  } else {
    schedulePoll(next.id, next.cron_expression);
  }
  return next;
}

export function deleteAndUnschedulePoll(id: number): boolean {
  unschedulePoll(id);
  // Issue #60 : purge les entrées pollMessageMap en RAM en MÊME temps que la
  // cascade DELETE SQL, sinon un vote tardif sur un message déjà envoyé
  // tenterait recordVote avec FK cassée (silencieusement eaten par le
  // .catch du listener vote_update).
  removeMessageMappingsForPoll(id);
  return db.deletePoll(id);
}
