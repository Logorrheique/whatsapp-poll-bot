// Human-friendly scheduling → cron expression conversion

export interface Schedule {
  frequency: "daily" | "weekdays" | "weekly" | "monthly";
  day?: number; // 0=Sun, 1=Mon... 6=Sat (for weekly)
  monthDay?: number; // 1-28 (for monthly)
  hour: number; // 0-23
  minute: number; // 0-59
}

export const DAY_NAMES = [
  "Dimanche",
  "Lundi",
  "Mardi",
  "Mercredi",
  "Jeudi",
  "Vendredi",
  "Samedi",
];

export function pollDisplayTitle(poll: {
  question: string;
  training_day: number | null;
}): string {
  const q = (poll.question || "").trim();
  if (q) return q;
  const day = poll.training_day;
  if (day === null || day === undefined) return "Entrainement";
  return `Entrainement ${DAY_NAMES[day]}`;
}

export function scheduleToCron(s: Schedule): string {
  const min = s.minute;
  const hr = s.hour;

  switch (s.frequency) {
    case "daily":
      return `${min} ${hr} * * *`;
    case "weekdays":
      return `${min} ${hr} * * 1-5`;
    case "weekly":
      return `${min} ${hr} * * ${s.day ?? 1}`;
    case "monthly":
      return `${min} ${hr} ${s.monthDay ?? 1} * *`;
    default:
      return `${min} ${hr} * * *`;
  }
}

// Parse une expression cron en Schedule "humain" si elle correspond à un
// pattern simple connu (daily, weekdays, weekly single day, monthly single day).
// Retourne null pour toute cron ambigüe (multi-jours, ranges, steps, */N, …)
// afin d'éviter les classifications silencieusement fausses — par exemple
// `0 18 * * 2,4` NE DOIT PAS être classé weekly-Mardi via parseInt("2,4")=2.
export function cronToSchedule(cron: string): Schedule | null {
  if (typeof cron !== "string") return null;
  const parts = cron.split(" ");
  if (parts.length !== 5) return null;

  const [minRaw, hrRaw, dom, month, dow] = parts;

  // Les minutes et heures doivent être des entiers purs (pas "*/5", pas "*")
  if (!/^\d{1,2}$/.test(minRaw)) return null;
  if (!/^\d{1,2}$/.test(hrRaw)) return null;
  const minute = Number(minRaw);
  const hour = Number(hrRaw);
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return null;

  // On ne supporte que month = "*"
  if (month !== "*") return null;

  // weekdays (lun-ven) : dow strict "1-5" + dom "*"
  if (dom === "*" && dow === "1-5") {
    return { frequency: "weekdays", hour, minute };
  }

  // weekly single day : dow ∈ [0..6] + dom "*"
  if (dom === "*" && /^[0-6]$/.test(dow)) {
    return { frequency: "weekly", day: Number(dow), hour, minute };
  }

  // daily : dow "*" + dom "*"
  if (dom === "*" && dow === "*") {
    return { frequency: "daily", hour, minute };
  }

  // monthly : dom entier 1-31 + dow "*"
  if (/^(?:[1-9]|[12]\d|3[01])$/.test(dom) && dow === "*") {
    return { frequency: "monthly", monthDay: Number(dom), hour, minute };
  }

  // Tout le reste (weekend "0,6", custom "2,4", biweekly "dom 1-7,15-21", */N, …)
  return null;
}

export function scheduleToHuman(s: Schedule): string {
  const time = `${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}`;

  switch (s.frequency) {
    case "daily":
      return `Tous les jours a ${time}`;
    case "weekdays":
      return `Du lundi au vendredi a ${time}`;
    case "weekly":
      return `Chaque ${DAY_NAMES[s.day ?? 1]} a ${time}`;
    case "monthly":
      return `Le ${s.monthDay ?? 1} de chaque mois a ${time}`;
    default:
      return `Planifie`;
  }
}

export function cronToHuman(cronExpression: string): string {
  const s = cronToSchedule(cronExpression);
  if (!s) return cronExpression;
  return scheduleToHuman(s);
}
