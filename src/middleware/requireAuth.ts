import { Request, Response, NextFunction } from "express";
import { validateSession } from "../auth";
import { touchSession } from "../db";

const SESSION_CACHE_TTL = 60_000;
const SESSION_TOUCH_INTERVAL = 30_000;
const SESSION_CACHE_MAX = 2000;

type CachedSession = { session: any; cachedAt: number; lastTouchedAt: number };
const sessionCache = new Map<string, CachedSession>();

export function invalidateSessionCache(token: string): void {
  sessionCache.delete(token);
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.replace("Bearer ", "");

  if (!token) {
    res.status(401).json({ error: "Authentification requise" });
    return;
  }

  const now = Date.now();
  let entry = sessionCache.get(token);

  if (!entry || now - entry.cachedAt > SESSION_CACHE_TTL) {
    const session = validateSession(token);
    if (!session) {
      sessionCache.delete(token);
      res.status(401).json({ error: "Session invalide ou expirée" });
      return;
    }
    if (sessionCache.size >= SESSION_CACHE_MAX) {
      const firstKey = sessionCache.keys().next().value;
      if (firstKey) sessionCache.delete(firstKey);
    }
    entry = { session, cachedAt: now, lastTouchedAt: 0 };
    sessionCache.set(token, entry);
  } else {
    // Vraie LRU : sur hit cache, on re-insere la cle pour la remettre en fin
    // de l'ordre d'iteration. Les Map JS preservent l'ordre d'insertion, donc
    // l'eviction via keys().next().value devient effectivement LRU au lieu
    // de FIFO. Coût : 2 ops Map sur le hit path, negligeable.
    sessionCache.delete(token);
    sessionCache.set(token, entry);
  }

  if (now - entry.lastTouchedAt > SESSION_TOUCH_INTERVAL) {
    touchSession(token);
    entry.lastTouchedAt = now;
  }

  next();
}
