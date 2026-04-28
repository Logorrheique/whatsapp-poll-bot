// Alerting via webhook (issue #33).
//
// Poste un message sur un webhook Discord/Slack/générique quand un évent
// critique survient : runSnapshotPass crash, WhatsApp déconnecté, service
// crash, etc. Gratuit (free-tier webhooks) et zéro setup externe au-delà
// de coller l'URL dans ALERT_WEBHOOK_URL.
//
// Best-effort : si le webhook est absent ou échoue, on log l'erreur mais
// on ne la propage pas — un alerteur cassé ne doit jamais crasher le
// service qu'il surveille.

import { config } from "./config";
import { log } from "./logger";

type AlertLevel = "warn" | "error" | "critical";

function formatPayload(level: AlertLevel, title: string, detail?: string): unknown {
  const emoji = level === "critical" ? "🚨" : level === "error" ? "❌" : "⚠️";
  const full = `${emoji} ${title}${detail ? `\n\`\`\`\n${detail.slice(0, 1500)}\n\`\`\`` : ""}`;
  if (config.ALERT_WEBHOOK_KIND === "discord") {
    return { content: full };
  }
  if (config.ALERT_WEBHOOK_KIND === "slack") {
    return { text: full };
  }
  // Generic : payload explicite pour un consumer maison
  return { level, title, detail: detail || null, ts: new Date().toISOString() };
}

// Throttling minimal : ne spam pas plus d'une alerte identique / 5 min.
const recentAlerts = new Map<string, number>();
const ALERT_DEDUP_WINDOW_MS = 5 * 60_000;

export async function alert(
  level: AlertLevel,
  title: string,
  detail?: string
): Promise<void> {
  const key = `${level}:${title}`;
  const last = recentAlerts.get(key);
  const now = Date.now();
  if (last && now - last < ALERT_DEDUP_WINDOW_MS) {
    return;
  }
  // Purge en passant les entrées plus utiles à dédupliquer (au-delà de la
  // fenêtre) — sans ça la Map croît au rythme de chaque (level, title) unique.
  for (const [k, ts] of recentAlerts) {
    if (now - ts >= ALERT_DEDUP_WINDOW_MS) recentAlerts.delete(k);
  }
  recentAlerts.set(key, now);

  // Log structuré systématique même si le webhook n'est pas configuré —
  // comme ça l'alerte est au moins visible dans les logs Railway.
  log.error({ component: "alerter", level, title }, detail || title);

  if (!config.ALERT_WEBHOOK_URL) return;

  try {
    const payload = formatPayload(level, title, detail);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      await fetch(config.ALERT_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    log.warn(
      { component: "alerter", error: (err as Error).message },
      "Échec envoi webhook alerting"
    );
  }
}
