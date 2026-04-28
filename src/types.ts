export interface Poll {
  id: number;
  question: string;
  options: string[];
  cron_expression: string;
  group_ids: string[];
  is_active: boolean;
  allow_multiple_answers: boolean;
  training_day: number | null;
  created_at: string;
  // Si true, question/options sont ignorés à l'envoi : phraseService tire
  // aléatoirement le titre + les options dans la bibliothèque de phrases.
  use_phrase_library: boolean;
}

export interface Phrase {
  id: number;
  category: string;
  text: string;
  training_day: number | null;
  created_at: string;
}

export interface PollWithDisplay extends Poll {
  display_title: string;
  last_sent_at?: string | null;
  last_send_total?: number;
}

export interface PollSend {
  id: number;
  poll_id: number;
  group_id: string;
  group_name: string | null;
  message_id: string | null;
  sent_at: string;
  // Optionnel : peuplé par getSendGroupsForPoll via LEFT JOIN. Permet au
  // frontend d'afficher le nombre de votes PAR SEND (pas la somme du jour).
  // undefined sur les chemins qui n'utilisent pas l'agrégation.
  vote_count?: number;
}

export interface PollVote {
  id: number;
  poll_id: number;
  send_id: number | null;
  group_id: string;
  voter: string;
  voter_name: string;
  selected_options: string[];
  voted_at: string;
}

export interface GroupInfo {
  id: string;
  name: string;
  participants_count: number;
}

export interface CreatePollInput {
  question: string;
  options: string[];
  cron_expression: string;
  group_ids: string[];
  allow_multiple_answers?: boolean;
  training_day?: number | null;
  use_phrase_library?: boolean;
}

export interface PollResultsSnapshot {
  id: number;
  poll_id: number;
  send_id: number | null;
  training_date: string;
  training_day: number;
  summary: { option: string; count: number; voters: string[] }[];
  total_votes: number;
  display_title: string;
  created_at: string;
  // Métadonnées contextuelles (issue #55) — nullable pour compat
  // avec les lignes pré-migration.
  question_raw?: string | null;
  cron_expression?: string | null;
  group_ids?: string[] | null;
  expected_count?: number | null;
}
