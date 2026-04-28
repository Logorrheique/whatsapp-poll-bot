import { Router, Request, Response } from "express";
import {
  requestVerificationCode,
  verifyCode,
  destroySession,
  validateSession,
  isValidPhone,
} from "../auth";
import { invalidateSessionCache } from "../middleware/requireAuth";

const router = Router();

// POST /api/auth/request-code — send verification code via WhatsApp
router.post("/request-code", async (req: Request, res: Response) => {
  const { phone } = req.body;

  if (!phone || !isValidPhone(phone)) {
    res.status(400).json({ error: "Numéro invalide (8-15 chiffres avec indicatif pays)" });
    return;
  }

  const result = await requestVerificationCode(phone);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json({ success: true, message: "Code envoyé via WhatsApp" });
});

// POST /api/auth/verify — verify code and get session token
router.post("/verify", (req: Request, res: Response) => {
  const { phone, code, as_viewer } = req.body;

  if (!phone || !code || !isValidPhone(phone) || !/^[0-9]{6}$/.test(String(code))) {
    res.status(400).json({ error: "Numéro et code (6 chiffres) requis" });
    return;
  }

  const result = verifyCode(phone, code, !!as_viewer);
  if (!result.success) {
    res.status(401).json({ error: result.error });
    return;
  }

  res.json({ success: true, token: result.token, role: result.role });
});

// POST /api/auth/logout — destroy session
router.post("/logout", (req: Request, res: Response) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token) {
    destroySession(token);
    invalidateSessionCache(token);
  }
  res.json({ success: true });
});

// GET /api/auth/me — check current session
router.get("/me", (req: Request, res: Response) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) {
    res.status(401).json({ error: "Non authentifié" });
    return;
  }

  const session = validateSession(token);
  if (!session) {
    res.status(401).json({ error: "Session expirée" });
    return;
  }

  // Use session role (chosen at login) — not phone-based
  res.json({
    phone: session.phone,
    role: session.role,
    is_admin: session.role === "admin",
    is_viewer: session.role === "viewer",
  });
});

export default router;
