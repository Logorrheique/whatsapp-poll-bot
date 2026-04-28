import { Router, Request, Response } from "express";
import { getStatus, unlinkWhatsApp, requestPairingCode } from "../whatsapp";
import { addAuditLog } from "../db";
import { getCallerPhone } from "../utils";

const router = Router();

// GET /api/wa-admin/info — which WhatsApp account is currently linked (admin only)
router.get("/info", (_req: Request, res: Response) => {
  const status = getStatus();
  res.json({
    ready: status.ready,
    loading: status.loading,
    linked_phone: status.linked_phone,
    linked_name: status.linked_name,
    has_qr: !!status.qr_data_url,
  });
});

// GET /api/wa-admin/qr — get the current QR code (admin only, no PAIR_SECRET needed)
router.get("/qr", (_req: Request, res: Response) => {
  const status = getStatus();
  if (!status.qr_data_url) {
    res.status(404).json({ error: "Pas de QR disponible" });
    return;
  }
  res.json({ qr_data_url: status.qr_data_url });
});

// POST /api/wa-admin/pairing-code — generate a pairing code (admin only, no PAIR_SECRET needed)
router.post("/pairing-code", async (req: Request, res: Response) => {
  const phone = String(req.body?.phone || "");
  try {
    const code = await requestPairingCode(phone);
    addAuditLog(getCallerPhone(req.headers.authorization), "whatsapp_pairing_code", phone);
    res.json({ code });
  } catch (err: any) {
    const msg = err?.message || "Erreur génération code";
    const code = err?.code || null;
    let status = 500;
    if (code === "WA_RATE_LIMIT") status = 429;
    else if (code === "TOO_FAST") status = 429;
    else if (/invalide|déjà lié|non initialisé|commencez/i.test(msg)) status = 400;
    res.status(status).json({ error: msg, code: code });
  }
});

// POST /api/wa-admin/unlink — unlink the current WhatsApp account (admin only)
router.post("/unlink", async (req: Request, res: Response) => {
  try {
    await unlinkWhatsApp();
    addAuditLog(getCallerPhone(req.headers.authorization), "whatsapp_unlink");
    res.json({ success: true, message: "Compte WhatsApp délié. Un nouveau QR code va apparaître." });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Erreur" });
  }
});

export default router;
