// Routes CRUD bibliothèque de phrases. Lecture pour tout authentifié,
// écriture réservée aux writers (admin + user). Pattern aligné sur
// routes/viewers.ts (cf middleware/requireWriter).

import { Router, Request, Response } from "express";
import * as db from "../db";
import { getCallerPhone } from "../utils";
import { requireWriter } from "../middleware/requireWriter";
import { getPhraseLibraryStatus } from "../services/phraseService";
import type { CanonicalCategory } from "../db-phrases";

const router = Router();

// GET /api/phrases?category=yes — liste filtrée optionnellement
router.get("/", (req: Request, res: Response) => {
  const cat = req.query.category ? String(req.query.category) : undefined;
  res.json(db.listPhrases(cat));
});

// GET /api/phrases/status — vue d'ensemble pour l'UI (counts + missing)
router.get("/status", (_req: Request, res: Response) => {
  res.json(getPhraseLibraryStatus());
});

// POST /api/phrases — { category, text, training_day? }
router.post("/", requireWriter, (req: Request, res: Response) => {
  const { category, text, training_day } = req.body || {};
  if (!category || typeof category !== "string") {
    res.status(400).json({ error: "category requis" });
    return;
  }
  if (!text || typeof text !== "string" || !text.trim()) {
    res.status(400).json({ error: "text requis" });
    return;
  }
  // training_day n'est exploité que pour 'title' (cf db-phrases.addPhrase
  // qui force null pour les autres catégories). Validation 0..6 si fourni.
  let day: number | null = null;
  if (training_day !== undefined && training_day !== null && training_day !== "") {
    const d = Number(training_day);
    if (!Number.isInteger(d) || d < 0 || d > 6) {
      res.status(400).json({ error: "training_day invalide (0-6)" });
      return;
    }
    day = d;
  }
  try {
    const created = db.addPhrase({
      category: category as CanonicalCategory,
      text,
      training_day: day,
    });
    db.addAuditLog(
      getCallerPhone(req.headers.authorization),
      "phrase_add",
      `${created.category}#${created.id}: ${created.text.slice(0, 60)}`
    );
    res.status(201).json(created);
  } catch (err: any) {
    res.status(400).json({ error: err.message || "Erreur insertion phrase" });
  }
});

// DELETE /api/phrases/category/:category — purge toutes les phrases d'une
// catégorie. Utilisé pour nettoyer les phrases legacy 'title' (issue #67).
// :id étant numérique, le routing Express ne confond pas avec /:id.
//
// Garde-fou : interdit la purge des catégories REQUIRED (yes/no/quit) qui
// sont indispensables au tirage des options. Sans ça, un appel direct à
// l'API par un writer pourrait casser tous les sondages d'un coup.
router.delete("/category/:category", requireWriter, (req: Request, res: Response) => {
  const cat = String(req.params.category || "").trim().toLowerCase();
  if (!cat) {
    res.status(400).json({ error: "Catégorie requise" });
    return;
  }
  if ((db.REQUIRED_CATEGORIES as readonly string[]).includes(cat)) {
    res.status(400).json({
      error: `Impossible de purger '${cat}' : catégorie requise pour les envois. Supprime les phrases une par une si vraiment nécessaire.`,
    });
    return;
  }
  const count = db.deletePhrasesByCategory(cat);
  db.addAuditLog(
    getCallerPhone(req.headers.authorization),
    "phrase_purge_category",
    `${cat}: ${count} phrase(s) supprimée(s)`
  );
  res.json({ success: true, category: cat, deleted: count });
});

// DELETE /api/phrases/:id
router.delete("/:id", requireWriter, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "ID invalide" });
    return;
  }
  const existing = db.getPhrase(id);
  if (!existing) {
    res.status(404).json({ error: "Phrase introuvable" });
    return;
  }
  const ok = db.deletePhrase(id);
  if (!ok) {
    res.status(404).json({ error: "Phrase introuvable" });
    return;
  }
  db.addAuditLog(
    getCallerPhone(req.headers.authorization),
    "phrase_delete",
    `${existing.category}#${id}`
  );
  res.json({ success: true });
});

export default router;
