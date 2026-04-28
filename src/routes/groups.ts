import { Router, Request, Response } from "express";
import { getGroups, getStatus } from "../whatsapp";

const router = Router();

// GET /api/groups — list all WhatsApp groups (protected)
router.get("/", async (_req: Request, res: Response) => {
  const status = getStatus();
  if (!status.ready) {
    res.status(503).json({ error: "WhatsApp non connecté" });
    return;
  }

  const groups = await getGroups();
  res.json(groups);
});

export default router;
