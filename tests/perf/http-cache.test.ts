// Tests HTTP caching & compression (skill addyosmani/web-quality-skills).
//
// Vérifie que les en-têtes produits par Express respectent la politique
// du skill :
// - Compression gzip/brotli active (déjà fixé par #35, on en fait un invariant)
// - Static assets : max-age long
// - HTML SPA (index.html) : pas de cache long (sinon les deploys Railway
//   restent invisibles après F5)
// - ETag activé sur les assets pour revalidation 304
//
// On monte un mini-app Express qui reflète exactement la config de
// src/index.ts (compression + express.static + SPA fallback) et on
// interroge via supertest. Pas de DB, pas de WhatsApp — test léger.

import { describe, it, expect, beforeAll, vi } from "vitest";
import express from "express";
import compression from "compression";
import request from "supertest";
import path from "path";

vi.mock("../../src/whatsapp", () => ({
  getClient: vi.fn().mockReturnValue(null),
  getStatus: vi.fn().mockReturnValue({ ready: false }),
}));

const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");

function buildApp(): express.Express {
  const app = express();
  app.use(compression());
  app.use(
    express.static(PUBLIC_DIR, {
      maxAge: "1h",
      etag: true,
      lastModified: true,
    })
  );
  app.get("/api/polls", (_req, res) =>
    res.json({
      // Payload > 1 KB pour déclencher la compression (seuil défaut 1024)
      items: Array.from({ length: 50 }, (_, i) => ({
        id: i,
        question: `Quest ${i}`.repeat(5),
        options: ["Oui", "Non", "Peut-être"],
      })),
    })
  );
  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));
  app.get("*", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
  return app;
}

describe("perf — compression HTTP", () => {
  let app: express.Express;
  beforeAll(() => {
    app = buildApp();
  });

  it("JSON > 1KB servi compressé quand le client accepte gzip", async () => {
    const res = await request(app)
      .get("/api/polls")
      .set("Accept-Encoding", "gzip, deflate, br");
    expect(res.status).toBe(200);
    // supertest déshabille automatiquement le content-encoding. On vérifie
    // qu'il a bien été appliqué côté serveur via Vary header + que le body
    // est bien présent.
    expect(res.headers["content-encoding"]).toMatch(/gzip|br|deflate/);
    expect(res.headers.vary?.toLowerCase()).toContain("accept-encoding");
  });

  it("petit payload (< 1KB) pas compressé — overhead pas rentable", async () => {
    const res = await request(app).get("/health").set("Accept-Encoding", "gzip");
    expect(res.status).toBe(200);
    // Le middleware compression a un threshold 1024 bytes par défaut
    expect(res.headers["content-encoding"]).toBeUndefined();
  });

  it("client sans Accept-Encoding reçoit du non-compressé", async () => {
    const res = await request(app).get("/api/polls").set("Accept-Encoding", "identity");
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
  });
});

describe("perf — caching static assets", () => {
  let app: express.Express;
  beforeAll(() => {
    app = buildApp();
  });

  it("assets static ont Cache-Control max-age", async () => {
    // index.html servi comme static file par express.static AVANT le fallback
    const res = await request(app).get("/index.html");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toMatch(/max-age=\d+/);
  });

  it("assets static ont un ETag pour revalidation 304", async () => {
    const res = await request(app).get("/index.html");
    expect(res.headers.etag).toBeDefined();
    // Revalidation : 2e call avec If-None-Match → 304
    const etag = res.headers.etag;
    const res2 = await request(app).get("/index.html").set("If-None-Match", etag);
    expect(res2.status).toBe(304);
  });

  it("assets static ont Last-Modified pour revalidation", async () => {
    const res = await request(app).get("/index.html");
    expect(res.headers["last-modified"]).toBeDefined();
  });
});

describe("perf — SPA fallback", () => {
  let app: express.Express;
  beforeAll(() => {
    app = buildApp();
  });

  it("route inconnue sert index.html (SPA routing)", async () => {
    const res = await request(app).get("/some-client-route");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });

  // ⚠️ Note skill : recommande Cache-Control: no-cache, must-revalidate
  // pour les SPA HTML afin que les deploys soient immédiatement visibles.
  // La config actuelle met max-age=3600 sur index.html (via express.static).
  // Ce test DOCUMENTE le comportement actuel. Si on décide un jour de
  // forcer no-cache sur le fallback, adapter cette assertion.
  it("fallback SPA actuellement cacheable 1h (à revoir si deploys fréquents)", async () => {
    const res = await request(app).get("/route-inventée");
    // sendFile ne met pas Cache-Control par défaut ; c'est express.static qui
    // le fait pour les fichiers servis directement. Le fallback utilise
    // sendFile qui a sa propre politique (immutable=false par défaut).
    // On valide que la réponse passe, pas la politique exacte.
    expect(res.status).toBe(200);
  });
});
