import { Request, Response, NextFunction } from "express";
import { validateSession } from "../auth";

export function requireWriter(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) {
    res.status(401).json({ error: "Authentification requise" });
    return;
  }

  const session = validateSession(token);
  if (!session) {
    res.status(401).json({ error: "Session invalide" });
    return;
  }

  if (session.role === "viewer") {
    res.status(403).json({ error: "Accès en lecture seule" });
    return;
  }

  next();
}
