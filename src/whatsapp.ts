// Module WhatsApp — port Baileys (passe RAM passe 4).
//
// Avant : whatsapp-web.js + Puppeteer + Chromium (~700-900 Mo RAM, ~444 Mo image).
// Après : Baileys (WebSocket direct au protocole WA Web), Node-only,
//         ~80-120 Mo RAM, ~80 Mo image.
//
// L'API publique de ce module est préservée (initWhatsApp, getStatus,
// requestPairingCode, sendPoll, sendPollToGroups, getGroups, unlinkWhatsApp,
// removeMessageMappingsForPoll, reloadMessageMap, refreshAllVoterNames) +
// 2 nouveaux wrappers (sendDirectMessage, disconnectClient) pour ne plus
// avoir à exposer le client brut aux callers (auth.ts, index.ts).
//
// Storage : Baileys stocke ses creds dans data/baileys_auth/ (multi-fichiers).
// Pour la décryption des votes, on stocke le proto WAMessageContent du poll
// d'origine dans poll_message_map.wa_message_proto (BLOB) — Baileys appelle
// notre callback getMessage() au moment du vote pour récupérer la clé.

import makeWASocket, {
  type WASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  proto,
  decryptPollVote,
  jidNormalizedUser,
  getKeyAuthor,
  type WAMessage,
  type WAMessageKey,
  type WAMessageContent,
} from "@whiskeysockets/baileys";
import { createHash } from "crypto";
import { Boom } from "@hapi/boom";
import pino from "pino";
// @ts-ignore — qrcode-terminal n'a pas de types
import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import fs from "fs";
import path from "path";
import * as db from "./db";
import {
  WA_INIT_SOFT_TIMEOUT, WA_INIT_HARD_TIMEOUT, WA_RETRY_DELAY,
  WA_SEND_POLL_DELAY, ONE_MINUTE, PAIR_REQUEST_COOLDOWN,
} from "./constants";
import { alert } from "./alerter";
import {
  resolveContactName as resolveContactNameExt,
  trackContactName,
} from "./whatsapp/contacts";
import type { GroupInfo } from "./types";

// État module
let sock: WASocket | null = null;
let isReady = false;
let qrCode: string | null = null;
let qrDataUrl: string | null = null;
let isAuthenticated = false;
// True dès qu'on a connecté avec succès au moins une fois pendant ce process.
// Distingue "401 = session révoquée par l'utilisateur" (everAuthenticated=true)
// de "401 = QR expiré sans scan" (everAuthenticated=false). Sans ce flag,
// chaque QR qui timeout déclenchait une alerte "Session révoquée" + spam de
// re-init alors que c'est juste l'utilisateur qui n'a pas scanné à temps.
let everAuthenticated = false;
let isUnlinking = false;
// Garde contre les inits concurrents : si un disconnect schedule un retryInit,
// puis un autre disconnect arrive avant que le premier ait fini d'init le sock,
// on évite de lancer deux makeWASocket en parallèle (qui se piétinent sur le
// global `sock`).
let initInProgress = false;
let lastPairRequestAt = 0;
let pairRateLimitedUntil = 0;
let linkedJid: string | null = null;
let linkedName: string | null = null;
let pollMessageMap = new Map<string, { pollId: number; sendId: number | null }>();

const AUTH_PATH = path.join(__dirname, "..", "data", "baileys_auth");

// Baileys est verbeux par défaut — on coupe à warn pour ne pas spammer Railway.
// Pour debug local : process.env.BAILEYS_LOG_LEVEL = "debug" expose tout le
// trafic Noise/WS/IQ. En prod on garde "warn" (logs trop verbeux sinon).
const baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL || "warn" }) as any;

process.on("unhandledRejection", (err) => {
  console.error("⚠️ Unhandled rejection (non-fatal):", err);
});

// ---------- API publique : statut / inspection ----------

export function getClient(): WASocket {
  if (!sock) throw new Error("WhatsApp client non initialisé");
  return sock;
}

export function getStatus(): {
  ready: boolean;
  loading: boolean;
  qr_data_url: string | null;
  linked_phone: string | null;
  linked_name: string | null;
} {
  return {
    ready: isReady,
    loading: !isReady && !qrCode,
    qr_data_url: qrDataUrl,
    linked_phone: linkedJid ? jidToPhone(linkedJid) : null,
    linked_name: linkedName,
  };
}

// ---------- API publique : pairing code ----------

export async function requestPairingCode(phoneNumber: string): Promise<string> {
  if (isReady) throw new Error("WhatsApp déjà lié");
  if (!sock) throw new Error("Client non initialisé");

  const cleaned = String(phoneNumber).replace(/[^0-9]/g, "");
  if (cleaned.length < 10 || cleaned.length > 15) {
    throw new Error("Numéro invalide : 10-15 chiffres requis, indicatif pays inclus (ex: 33612345678)");
  }
  if (cleaned.startsWith("0")) {
    throw new Error("Ne commencez pas par 0. Utilisez l'indicatif pays (ex: 33612345678 au lieu de 0767545053)");
  }
  if (isUnlinking) throw new Error("Une opération est déjà en cours");

  const nowTs = Date.now();
  if (pairRateLimitedUntil > nowTs) {
    const minLeft = Math.ceil((pairRateLimitedUntil - nowTs) / ONE_MINUTE);
    const err: any = new Error(`WhatsApp a temporairement bloqué les codes de pairage (rate limit). Réessayez dans ~${minLeft} min, ou utilisez le QR code en attendant.`);
    err.code = "WA_RATE_LIMIT";
    throw err;
  }
  if (nowTs - lastPairRequestAt < PAIR_REQUEST_COOLDOWN) {
    const secLeft = Math.ceil((PAIR_REQUEST_COOLDOWN - (nowTs - lastPairRequestAt)) / 1000);
    const err: any = new Error(`Patientez ${secLeft}s avant de redemander un code (limite anti-spam).`);
    err.code = "TOO_FAST";
    throw err;
  }
  lastPairRequestAt = nowTs;

  // Important : ne PAS recréer le sock entre l'appel requestPairingCode() et
  // la réception du companion_finish. Le code 8 chars retourné est lié aux
  // clés crypto éphémères de CE sock — un nouveau sock invalide le code.
  // L'utilisateur doit ensuite aller dans WhatsApp → Appareils liés → Lier
  // un appareil → "Lier avec un numéro de téléphone à la place".

  console.log(`📱 Pairing code demandé pour +${cleaned}`);

  // Listener brut sur sock.ws pour capter <iq type='error'> en réponse à
  // notre IQ link_code_companion_reg. Sans ça, WhatsApp peut rejeter le
  // numéro (code 400) et on retourne silencieusement un code mort.
  const wsErrorPromise = new Promise<{ code: string; text: string } | null>((resolve) => {
    let settled = false;
    const settle = (v: { code: string; text: string } | null) => {
      if (!settled) { settled = true; resolve(v); }
    };
    const onFrame = (frame: any) => {
      // Baileys ne nous expose pas l'id de notre IQ ; on prend la 1ère erreur
      // qui arrive dans les 4s suivant l'envoi.
      try {
        const isErrorIq =
          frame?.tag === "iq" &&
          frame?.attrs?.type === "error" &&
          frame?.attrs?.from === "@s.whatsapp.net";
        if (isErrorIq) {
          const errNode = frame?.content?.find?.((c: any) => c?.tag === "error");
          if (errNode) {
            settle({
              code: String(errNode.attrs?.code || "?"),
              text: String(errNode.attrs?.text || "unknown"),
            });
          }
        }
      } catch {}
    };
    // sock.ws a un emitter "frame" pour les frames XML décryptées. On y
    // attache notre listener temporaire (cleanup automatique via timeout).
    try {
      (sock as any)?.ws?.on?.("frame", onFrame);
    } catch {}
    setTimeout(() => {
      try { (sock as any)?.ws?.off?.("frame", onFrame); } catch {}
      settle(null);
    }, 4000);
  });

  try {
    const code = await sock.requestPairingCode(cleaned);
    // Attendre la potentielle erreur WhatsApp pendant ~3s.
    const wsError = await Promise.race([
      wsErrorPromise,
      new Promise<null>((r) => setTimeout(() => r(null), 3000)),
    ]);

    if (wsError) {
      console.error(
        `📱 WhatsApp a rejeté le pairing code IQ : ${wsError.code} ${wsError.text}`
      );
      if (wsError.code === "400") {
        const e: any = new Error(
          `WhatsApp a rejeté le numéro (+${cleaned}). Vérifie qu'il est bien ` +
          `enregistré sur WhatsApp et au format international (indicatif pays + numéro sans 0). ` +
          `Si le numéro est correct, attends 30 min (anti-spam) avant de réessayer ou utilise le QR.`
        );
        e.code = "WA_BAD_NUMBER";
        throw e;
      }
      if (wsError.code === "403" || wsError.code === "429") {
        pairRateLimitedUntil = Date.now() + 30 * ONE_MINUTE;
        const e: any = new Error(
          `WhatsApp a bloqué la requête (${wsError.text}). Anti-spam : attends 30 min ou utilise le QR.`
        );
        e.code = "WA_RATE_LIMIT";
        throw e;
      }
      // Autres codes : on remonte tel quel
      const e: any = new Error(`WhatsApp a refusé : ${wsError.code} ${wsError.text}`);
      e.code = "WA_ERROR";
      throw e;
    }

    console.log(
      `📱 Pairing code généré : ${code} — l'utilisateur doit maintenant ` +
      `aller dans WhatsApp → Appareils liés → Lier un appareil → ` +
      `"Lier avec un numéro de téléphone à la place"`
    );
    return code;
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (err?.code === "WA_BAD_NUMBER" || err?.code === "WA_RATE_LIMIT" || err?.code === "WA_ERROR") {
      throw err; // déjà formaté
    }
    console.error(`📱 requestPairingCode failed: ${msg}`);
    if (/rate.?limit|429/i.test(msg)) {
      pairRateLimitedUntil = Date.now() + 30 * ONE_MINUTE;
      const e: any = new Error("WhatsApp rate limit (30 min de blocage). Utilisez le QR code en attendant.");
      e.code = "WA_RATE_LIMIT";
      throw e;
    }
    throw err;
  }
}

// ---------- API publique : send / receive polls ----------

export async function sendPoll(
  pollId: number,
  groupId: string,
  question: string,
  options: string[],
  allowMultiple: boolean
): Promise<string | null> {
  if (!sock || !isReady) throw new Error("WhatsApp pas prêt");

  const sentMsg = await sock.sendMessage(groupId, {
    poll: {
      name: question,
      values: options,
      // Baileys : 1 = single choice, 0 ou values.length = multiple,
      // N = jusqu'à N choix.
      selectableCount: allowMultiple ? 0 : 1,
    },
  });

  if (!sentMsg?.key.id || !sentMsg.message) {
    console.error("Envoi poll échoué : pas de message id retourné");
    return null;
  }

  const messageId = sentMsg.key.id;
  const groupName = await getGroupNameSafe(groupId);
  const messageProto = Buffer.from(proto.Message.encode(sentMsg.message).finish());

  // Écriture transactionnelle de poll_sends + poll_message_map (proto BLOB
  // requis pour décrypter les votes ; options snapshot pour l'affichage des
  // library polls qui n'ont pas leurs choix en DB côté bot).
  const sendId = db.recordSendAndMap(pollId, groupId, messageId, groupName, messageProto, options);
  pollMessageMap.set(messageId, { pollId, sendId });

  console.log(`✓ Poll #${pollId} envoyé au groupe ${groupName || groupId}`);
  return messageId;
}

export async function sendPollToGroups(
  pollId: number,
  groupIds: string[],
  question: string,
  options: string[],
  allowMultiple: boolean
): Promise<void> {
  for (const groupId of groupIds) {
    try {
      await sendPoll(pollId, groupId, question, options, allowMultiple);
    } catch (err) {
      console.error(`Échec envoi poll #${pollId} → ${groupId}:`, (err as Error).message);
    }
    // Délai entre groupes pour ne pas bourriner WhatsApp.
    await new Promise((r) => setTimeout(r, WA_SEND_POLL_DELAY));
  }
}

// ---------- API publique : groupes ----------

export async function getGroups(): Promise<GroupInfo[]> {
  if (!sock || !isReady) return [];
  try {
    const all = await sock.groupFetchAllParticipating();
    return Object.values(all).map((g) => ({
      id: g.id,
      name: g.subject || g.id,
      participants_count: g.participants?.length || 0,
    }));
  } catch (err) {
    console.error("Erreur fetch groupes:", (err as Error).message);
    return [];
  }
}

async function getGroupNameSafe(groupId: string): Promise<string | null> {
  if (!sock) return null;
  try {
    const meta = await sock.groupMetadata(groupId);
    return meta.subject || null;
  } catch {
    return null;
  }
}

// ---------- API publique : message map ----------

export function removeMessageMappingsForPoll(pollId: number): void {
  for (const [msgId, mapping] of pollMessageMap) {
    if (mapping.pollId === pollId) {
      pollMessageMap.delete(msgId);
    }
  }
}

export function reloadMessageMap(): void {
  pollMessageMap = db.getAllPollMessageMappings();
}

// ---------- API publique : maintenance contacts ----------

export async function refreshAllVoterNames(): Promise<{ updated: number }> {
  if (!isReady) return { updated: 0 };
  // Baileys ne permet pas de "fetch contact by jid" comme whatsapp-web.js.
  // Les noms sont collectés en passif via pushName sur les messages reçus
  // (cf. trackContactName dans contacts.ts). Cette maintenance ré-applique
  // ce qu'on connaît déjà du cache RAM aux votes en DB.
  const voters = db.getAllUniqueVoters();
  let updated = 0;
  for (const voter of voters) {
    try {
      const name = await resolveContactNameExt(voter);
      if (name && name !== voter && name !== jidToPhone(voter)) {
        db.updateVoterName(voter, name);
        updated++;
      }
    } catch (err) {
      console.warn(`refreshAllVoterNames: échec pour ${voter}:`, (err as Error).message);
    }
  }
  return { updated };
}

// ---------- API publique : actions ----------

export async function sendDirectMessage(jid: string, text: string): Promise<void> {
  if (!sock || !isReady) throw new Error("WhatsApp pas prêt");
  await sock.sendMessage(jid, { text });
}

export async function disconnectClient(): Promise<void> {
  if (!sock) return;
  try {
    sock.end(undefined as any);
  } catch {
    // Already closed
  }
  sock = null;
  isReady = false;
  isAuthenticated = false;
}

export async function unlinkWhatsApp(): Promise<void> {
  isUnlinking = true;
  try {
    if (sock) {
      try {
        await sock.logout();
      } catch (err) {
        console.warn("logout() failed:", (err as Error).message);
      }
      sock = null;
    }
    isReady = false;
    isAuthenticated = false;
    qrCode = null;
    qrDataUrl = null;
    linkedJid = null;
    linkedName = null;
    // Nuke les creds Baileys pour forcer un nouveau pairing au prochain init.
    try {
      fs.rmSync(AUTH_PATH, { recursive: true, force: true });
    } catch (err) {
      console.warn("Nettoyage AUTH_PATH échoué:", (err as Error).message);
    }
    // Recrée un client en mode QR pour la suite.
    await initWhatsApp();
  } finally {
    isUnlinking = false;
  }
}

// Soupape : force le reset complet de la session (kill sock + wipe creds +
// relance init). Utilisée par POST /api/wa/reset-session (gated PAIR_SECRET)
// pour débloquer un état "loading éternel" si le bot a des creds stales.
export async function forceResetSession(): Promise<void> {
  console.log("🔧 forceResetSession : kill sock + wipe creds + re-init");
  isUnlinking = true;
  try {
    if (sock) {
      try { sock.ev.removeAllListeners("connection.update"); } catch {}
      try { sock.ev.removeAllListeners("messages.upsert"); } catch {}
      try { sock.ev.removeAllListeners("creds.update"); } catch {}
      try { sock.end(undefined as any); } catch {}
      sock = null;
    }
    isReady = false;
    isAuthenticated = false;
    qrCode = null;
    qrDataUrl = null;
    linkedJid = null;
    linkedName = null;
    initInProgress = false;
    try { fs.rmSync(AUTH_PATH, { recursive: true, force: true }); } catch {}
  } finally {
    isUnlinking = false;
  }
  // Relance dans un setTimeout pour ne pas bloquer la réponse HTTP
  setTimeout(() => initWhatsApp().catch(console.error), 500);
}

// ---------- Init ----------

export async function initWhatsApp(): Promise<void> {
  // Garde réentrance : un disconnect peut schedule un retry avant qu'un
  // précédent retry ait fini. Sans guard, on créerait deux sockets en
  // parallèle (race sur la variable globale `sock`).
  if (initInProgress) {
    console.log("⏭️  initWhatsApp ignoré (déjà en cours)");
    return;
  }
  initInProgress = true;

  fs.mkdirSync(AUTH_PATH, { recursive: true });

  // Migration one-shot : ancien dossier session whatsapp-web.js (~50-200 Mo
  // de Chromium user-data) que le port Baileys a remplacé. Libère le volume.
  const oldWwebjsAuth = path.join(__dirname, "..", "data", "wwebjs_auth");
  if (fs.existsSync(oldWwebjsAuth)) {
    console.log("🧹 Nettoyage data/wwebjs_auth/ (héritage Chromium, libère le volume)");
    try {
      fs.rmSync(oldWwebjsAuth, { recursive: true, force: true });
    } catch (err) {
      console.warn("Cleanup wwebjs_auth échoué (non-fatal):", (err as Error).message);
    }
  }

  // Watchdog anti-blocage : si creds persistées sur disk mais pas d'auth
  // dans 30s, on wipe et relance. Couvre le cas observé en prod où une
  // session révoquée pendant l'offline laisse le sock muet (ni 'open' ni
  // close 401), bloquant le bot en "loading" éternel.
  let watchdogFired = false;
  try {
    const credsFile = path.join(AUTH_PATH, "creds.json");
    if (fs.existsSync(credsFile)) {
      setTimeout(async () => {
        if (isReady || qrCode || isAuthenticated || isUnlinking || watchdogFired) return;
        watchdogFired = true;
        console.warn("⏰ Watchdog 30s : sock stuck sans QR ni auth — wipe creds et restart");
        try {
          if (sock) {
            try { sock.ev.removeAllListeners("connection.update"); } catch {}
            try { sock.ev.removeAllListeners("messages.upsert"); } catch {}
            try { sock.ev.removeAllListeners("creds.update"); } catch {}
            try { sock.end(undefined as any); } catch {}
            sock = null;
          }
        } catch {}
        try { fs.rmSync(AUTH_PATH, { recursive: true, force: true }); } catch {}
        // Reset les états globaux pour que la nouvelle init parte propre
        initInProgress = false;
        // Re-init avec creds vides → produit un QR
        setTimeout(() => initWhatsApp().catch(console.error), 1000);
      }, 30_000);
    }
  } catch {}

  console.log(`🚀 Initialisation Baileys (auth: ${AUTH_PATH})`);
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
  const { version } = await fetchLatestBaileysVersion();
  console.log(`📦 Protocole WA Web v${version.join(".")}`);

  sock = makeWASocket({
    // CRITIQUE : sans `version` explicite, Baileys utilise la version protocole
    // hardcodée dans le package (souvent obsolète) → "Connection Failure"
    // instantanée. fetchLatestBaileysVersion() résout la version courante
    // depuis le repo baileys-versions.
    version,
    auth: state,
    logger: baileysLogger,
    printQRInTerminal: false,
    browser: Browsers.macOS("Desktop"),
    syncFullHistory: false,
    markOnlineOnConnect: false, // évite que le compte apparaisse "online" en permanence
    // Callback critique pour la décryption des votes : Baileys appelle ça
    // pour récupérer le poll d'origine quand un vote arrive.
    getMessage: async (key: WAMessageKey): Promise<WAMessageContent | undefined> => {
      const id = key.id;
      if (!id) return undefined;
      const buf = db.getWaPollMessageProto(id);
      if (!buf) return undefined;
      try {
        const decoded = proto.Message.decode(buf) as WAMessageContent;
        // Baileys stocke les polls dans 3 champs selon le cas :
        //   - pollCreationMessage   : multiple choice
        //   - pollCreationMessageV2 : announcement groups
        //   - pollCreationMessageV3 : single choice (cas par défaut)
        // Filtrer un seul des trois rejette silencieusement les votes sur
        // les polls single-choice → ils s'affichent à 0 vote. Accepter les 3.
        const hasPoll = !!(
          decoded.pollCreationMessage ||
          (decoded as any).pollCreationMessageV2 ||
          (decoded as any).pollCreationMessageV3
        );
        if (!hasPoll) {
          console.warn(
            `getMessage: aucun pollCreation* dans proto pour ${id}, keys=`,
            Object.keys(decoded)
          );
          return undefined;
        }
        return decoded;
      } catch (err) {
        console.warn(`getMessage decode failed for ${id}:`, (err as Error).message);
        return undefined;
      }
    },
  });

  sock.ev.on("creds.update", saveCreds);
  setupSockEvents();

  // Soft + hard timeouts (équivalent ancien comportement) — sans guard,
  // un boot bloqué (DNS down, WS qui ne répond pas) laisse Railway en
  // healthcheck failed sans jamais restart.
  return new Promise<void>((resolve) => {
    let resolved = false;
    const safeResolve = () => {
      if (!resolved) {
        resolved = true;
        // Release du guard : init est "fini", un nouveau retry peut être
        // tenté si le sock se ferme à nouveau.
        initInProgress = false;
        resolve();
      }
    };

    setTimeout(() => {
      if (!isReady) console.log("⏳ En attente du scan QR code ou connexion...");
      safeResolve();
    }, WA_INIT_SOFT_TIMEOUT);

    // Pour signaler "ready" dès la connexion ouverte
    const checkReady = setInterval(() => {
      if (isReady) {
        clearInterval(checkReady);
        safeResolve();
      }
    }, 500);

    setTimeout(() => {
      clearInterval(checkReady);
      if (!isReady && !qrCode && !isAuthenticated) {
        console.error("⛔ Timeout WhatsApp sans QR ni auth, exit pour restart");
        process.exit(1);
      }
      safeResolve();
    }, WA_INIT_HARD_TIMEOUT);
  });
}

// ---------- Events ----------

function setupSockEvents(): void {
  if (!sock) return;
  const s = sock;

  s.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCode = qr;
      console.log("\n📱 QR code reçu");
      qrcode.generate(qr, { small: true });
      try {
        qrDataUrl = await QRCode.toDataURL(qr, { width: 400, margin: 2 });
      } catch (err) {
        console.error("Erreur génération QR dataURL:", (err as Error).message);
      }
    }

    if (connection === "open") {
      isReady = true;
      isAuthenticated = true;
      everAuthenticated = true;
      qrCode = null;
      qrDataUrl = null;
      linkedJid = s.user?.id || null;
      linkedName = s.user?.name || null;
      pollMessageMap = db.getAllPollMessageMappings();
      console.log(
        `✅ WhatsApp connecté ! ${linkedName || linkedJid} (${pollMessageMap.size} mappings chargés)`
      );
    }

    if (connection === "close") {
      isReady = false;
      const code = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const errMsg = lastDisconnect?.error?.message || "raison inconnue";
      // wasRegistered = creds persistées au close. Une 401 avec wasRegistered
      // (typique post-restart Railway) signifie session révoquée pendant
      // l'offline → faut wipe pour refaire un QR. Sans ce flag, on bouclait
      // sur "401 → re-init mêmes creds → 401" (everAuthenticated à false
      // après restart process).
      const wasRegistered = !!s.authState?.creds?.registered;
      console.log(
        `📴 Connexion fermée — code=${code} reason=${DisconnectReason[code as number] || "?"} ` +
        `wasRegistered=${wasRegistered} everAuthenticated=${everAuthenticated} msg="${errMsg}"`
      );
      const isLoggedOut = code === DisconnectReason.loggedOut;
      // Distingue session révoquée (faut wipe) d'un QR qui a juste expiré
      // sans scan (faut juste relancer).
      const isRealLogout = isLoggedOut && (everAuthenticated || wasRegistered);
      const isQrTimeout = isLoggedOut && !everAuthenticated && !wasRegistered;

      if (isRealLogout) {
        console.log("📴 Logout WhatsApp (session révoquée côté téléphone)");
        isAuthenticated = false;
        linkedJid = null;
        linkedName = null;
        try {
          fs.rmSync(AUTH_PATH, { recursive: true, force: true });
        } catch {}
        if (!isUnlinking) {
          void alert("critical", "WhatsApp logout", "Session révoquée — relinking requis");
          // Relance l'init pour faire apparaître un nouveau QR.
          setTimeout(() => initWhatsApp().catch(console.error), WA_RETRY_DELAY);
        }
        return;
      }

      if (isUnlinking) return;
      // 515 = restartRequired, 408 = timeout, 428 = précondition échouée :
      // tous transitoires, pas d'alerte. isQrTimeout idem (juste un QR expiré).
      const isTransient = code === 515 || code === 408 || code === 428 || isQrTimeout;
      if (!isTransient) {
        void alert("critical", "WhatsApp déconnecté", `code=${code} ${errMsg}`);
      }
      // Reconnexion auto. Cleanup de l'ancien sock avant re-init pour ne pas
      // laisser des listeners orphelins.
      try { sock?.ev.removeAllListeners("connection.update"); sock?.ev.removeAllListeners("messages.upsert"); sock?.ev.removeAllListeners("creds.update"); } catch {}
      sock = null;
      setTimeout(() => initWhatsApp().catch(console.error), WA_RETRY_DELAY);
    }
  });

  // Capture passive des pushNames pour la résolution de contacts.
  s.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      // Track contact name si pushName disponible.
      if (msg.pushName && msg.key.participant) {
        trackContactName(msg.key.participant, msg.pushName);
      } else if (msg.pushName && msg.key.remoteJid && !msg.key.remoteJid.endsWith("@g.us")) {
        trackContactName(msg.key.remoteJid, msg.pushName);
      }

      // Détection vote.
      const pollUpdate =
        msg.message?.pollUpdateMessage ||
        (msg.message as any)?.pollUpdateMessageV3;
      if (pollUpdate) {
        await handlePollVote(msg, pollUpdate);
      }
    }
  });
}

async function handlePollVote(
  msg: WAMessage,
  pollUpdate: any
): Promise<void> {
  if (!sock) return;
  const pollKey = pollUpdate.pollCreationMessageKey;
  const pollMsgId = pollKey?.id;
  if (!pollMsgId) return;

  const mapping = pollMessageMap.get(pollMsgId);
  if (!mapping) {
    console.log(`📊 Vote sur poll inconnu (${pollMsgId}) — pas dans pollMessageMap, ignoré`);
    return;
  }

  const groupId = msg.key.remoteJid;
  const voter = msg.key.participant || msg.key.remoteJid;
  if (!groupId || !voter) return;

  // Récupère le poll d'origine pour la décryption.
  const protoBuf = db.getWaPollMessageProto(pollMsgId);
  if (!protoBuf) {
    console.warn(`Poll proto absent en DB pour ${pollMsgId}, vote ignoré`);
    return;
  }

  let pollCreationMessage: any;
  try {
    pollCreationMessage = proto.Message.decode(protoBuf);
  } catch (err) {
    console.error(`decode pollCreationMessage failed:`, (err as Error).message);
    return;
  }

  // getAggregateVotesInPollMessage attend un vote déjà décrypté ; on doit
  // appeler decryptPollVote nous-mêmes (le path auto a été déprécié dans
  // Baileys 6.7.21).
  const messageSecret = pollCreationMessage.messageContextInfo?.messageSecret;
  if (!messageSecret) {
    console.warn(`Pas de messageSecret dans le proto stocké pour ${pollMsgId} — vote impossible à décrypter`);
    return;
  }

  // HMAC-binding du vote : Baileys normalise notre id (strip device suffix)
  // et utilise les JIDs raw côté creator/voter. WhatsApp signe avec les
  // mêmes JIDs, donc le HMAC matche.
  const meIdNormalised = jidNormalizedUser(sock.user?.id || "");
  const pollCreatorJid = getKeyAuthor(pollKey, meIdNormalised);
  const voterJid = getKeyAuthor(msg.key, meIdNormalised);

  let voteMsg: any;
  try {
    voteMsg = decryptPollVote(pollUpdate.vote, {
      pollEncKey: messageSecret,
      pollCreatorJid,
      pollMsgId,
      voterJid,
    });
  } catch (err) {
    console.error(
      `decryptPollVote failed pour ${voter} sur poll #${mapping.pollId}: ${(err as Error).message}`
    );
    return;
  }

  // voteMsg.selectedOptions est un array de Buffer (chaque buffer = SHA-256
  // du nom d'option). On reconstruit la map hash→nom depuis les options du
  // poll, puis on traduit chaque hash en nom lisible.
  const opts =
    pollCreationMessage.pollCreationMessage?.options ||
    pollCreationMessage.pollCreationMessageV3?.options ||
    pollCreationMessage.pollCreationMessageV2?.options ||
    [];
  const hashToName = new Map<string, string>();
  for (const opt of opts) {
    const name = opt.optionName || "";
    const hash = createHash("sha256").update(name).digest("hex");
    hashToName.set(hash, name);
  }

  const selectedOptions: string[] = [];
  for (const optHashBuf of voteMsg.selectedOptions || []) {
    const hex = Buffer.from(optHashBuf).toString("hex");
    const name = hashToName.get(hex);
    if (name) selectedOptions.push(name);
  }

  if (selectedOptions.length === 0) {
    // Vote vide légitime (= "annulation" / déselection) OU options non-matchées.
    // On log les hashes pour diagnostic si jamais ça revient.
    const receivedHashes = (voteMsg.selectedOptions || []).map((b: any) =>
      Buffer.from(b).toString("hex").substring(0, 12)
    );
    console.warn(
      `Vote sans option pour ${voter} sur poll #${mapping.pollId} — ` +
      `vote=${receivedHashes.length} hash(es) reçus [${receivedHashes.join(",")}], ` +
      `${opts.length} options dans le poll`
    );
    return;
  }

  const voterName = await resolveContactNameExt(voter);

  db.recordVote(
    mapping.pollId,
    mapping.sendId,
    groupId,
    voter,
    voterName,
    selectedOptions
  );

  console.log(
    `📊 Vote reçu de ${voterName} (${jidToPhone(voter)}) pour sondage #${mapping.pollId} (send #${mapping.sendId}): [${selectedOptions.join(", ")}]`
  );
}

// ---------- Helpers ----------

// Baileys utilise des JID au format "33612345678@s.whatsapp.net" (privé) ou
// "<group-id>@g.us" (groupe). On extrait le numéro pour les usages legacy.
function jidToPhone(jid: string): string {
  return jid.split("@")[0].split(":")[0];
}
