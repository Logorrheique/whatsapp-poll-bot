import { Router, Request, Response } from "express";
import { getViewers, addToViewers, removeFromViewers, isValidPhone } from "../auth";
import { addAuditLog } from "../db";
import { getCallerPhone } from "../utils";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  res.json(getViewers());
});

router.post("/", (req: Request, res: Response) => {
  const { phone } = req.body;
  if (!phone || !isValidPhone(phone)) {
    res.status(400).json({ error: "Format de numéro invalide (8-15 chiffres)" });
    return;
  }

  const added = addToViewers(phone);
  if (!added) {
    res.status(409).json({ error: "Numéro déjà observateur" });
    return;
  }

  addAuditLog(getCallerPhone(req.headers.authorization), "viewer_add", phone);
  res.status(201).json({ success: true, viewers: getViewers() });
});

router.delete("/:phone", (req: Request, res: Response) => {
  const phoneToRemove = req.params.phone as string;
  if (!isValidPhone(phoneToRemove)) {
    res.status(400).json({ error: "Format invalide" });
    return;
  }

  const removed = removeFromViewers(phoneToRemove);
  if (!removed) {
    res.status(404).json({ error: "Numéro non trouvé" });
    return;
  }

  addAuditLog(getCallerPhone(req.headers.authorization), "viewer_remove", phoneToRemove);
  res.json({ success: true, viewers: getViewers() });
});

export default router;
