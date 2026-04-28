import { Router, Request, Response } from "express";
import { getWhitelist, removeFromWhitelist, isValidPhone, getAdminPhones } from "../auth";
import { addAuditLog } from "../db";
import { normalizePhone, getCallerPhone } from "../utils";

const router = Router();

// GET /api/whitelist — list all whitelisted phones
router.get("/", (_req: Request, res: Response) => {
  res.json(getWhitelist());
});

// DELETE /api/whitelist/:phone — remove a phone number
router.delete("/:phone", (req: Request, res: Response) => {
  const rawPhone = req.params.phone as string;
  if (!isValidPhone(rawPhone)) {
    res.status(400).json({ error: "Format invalide" });
    return;
  }

  const normalized = normalizePhone(rawPhone);
  if (getAdminPhones().includes(normalized)) {
    res.status(403).json({ error: "Impossible de retirer un admin de la whitelist" });
    return;
  }

  const removed = removeFromWhitelist(rawPhone);
  if (!removed) {
    res.status(404).json({ error: "Numéro non trouvé dans la whitelist" });
    return;
  }

  addAuditLog(getCallerPhone(req.headers.authorization), "whitelist_remove", normalized);
  res.json({ success: true, whitelist: getWhitelist() });
});

export default router;
