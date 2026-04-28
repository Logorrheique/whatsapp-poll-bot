// Tests budget HTML performance (skill addyosmani/web-quality-skills).
//
// Analyse statique de public/index.html :
// - Poids total
// - JS inline extrait
// - CSS inline extrait
// - Absence de script externe bloquant
// - Déclarations lazy/eager sur <img>
// - Patterns coûteux non-debounce (scroll/resize/input)
//
// Budgets adaptés à ce projet (SPA vanilla monofichier, dashboard interne).
// Plus laxes que les budgets "public-facing Lighthouse" du skill parce qu'on
// n'est pas sur une landing page. L'objectif est de détecter une régression
// grosse (ex: quelqu'un colle 500KB de JS d'une lib en inline) plutôt que
// d'optimiser pour Core Web Vitals qu'on n'audite pas en CI.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const HTML_PATH = path.join(__dirname, "..", "..", "public", "index.html");
const HTML = fs.readFileSync(HTML_PATH, "utf-8");
const HTML_BYTES = Buffer.byteLength(HTML, "utf-8");

function extractAll(regex: RegExp, source: string): string[] {
  return [...source.matchAll(regex)].map((m) => m[1] || "");
}

describe("perf — budget HTML total", () => {
  it("public/index.html pèse moins de 500 KB non compressé", () => {
    // Budget interne ; skill dit < 1.5MB pour toute une page. On prend 500KB
    // comme signal de régression (fichier actuel ~100KB).
    expect(HTML_BYTES).toBeLessThan(500 * 1024);
  });

  it("JS inline total < 300 KB (budget skill)", () => {
    const scripts = extractAll(
      /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g,
      HTML
    );
    const totalJs = scripts.reduce((n, s) => n + Buffer.byteLength(s, "utf-8"), 0);
    expect(totalJs).toBeLessThan(300 * 1024);
  });

  it("CSS inline total < 100 KB (budget skill)", () => {
    const styles = extractAll(/<style[^>]*>([\s\S]*?)<\/style>/g, HTML);
    const totalCss = styles.reduce((n, s) => n + Buffer.byteLength(s, "utf-8"), 0);
    expect(totalCss).toBeLessThan(100 * 1024);
  });
});

describe("perf — patterns de chargement", () => {
  it("aucun <script src='http(s)://..'> externe bloquant", () => {
    // Skill : tout script externe doit être async/defer/module. Ici on
    // n'accepte AUCUN script externe (politique self-contained) sauf si
    // explicitement marqué défer/async/module.
    const externalScripts = [
      ...HTML.matchAll(/<script[^>]*\bsrc=["']https?:\/\/[^"']*["'][^>]*>/g),
    ];
    for (const match of externalScripts) {
      const tag = match[0];
      const ok = /\b(defer|async|type\s*=\s*["']module["'])\b/.test(tag);
      expect(ok, `Script externe non-async détecté : ${tag}`).toBe(true);
    }
  });

  it("aucune feuille CSS externe bloquante (domaine tiers)", () => {
    // Tout <link rel="stylesheet" href="http..."> doit être soit self-hosted
    // soit déclaré via preload + onload swap (pattern critical CSS du skill).
    const thirdPartyCss = [
      ...HTML.matchAll(
        /<link[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']https?:\/\/[^"']*["'][^>]*>/g
      ),
    ];
    expect(thirdPartyCss.length).toBe(0);
  });

  it("toutes les <img> ont un attribut loading explicite (lazy ou eager)", () => {
    // Skill : images above-fold = eager + fetchpriority high,
    // below-fold = lazy. Ici le dashboard n'utilise quasiment pas d'<img>
    // (QR code est un <div> avec background ou un data: URL). On tolère 0
    // image sans loading jusqu'à 2 (marge pour le QR inline ou un logo futur).
    const imgs = [...HTML.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
    const missingLoading = imgs.filter((tag) => !/\bloading\s*=\s*["'](lazy|eager)["']/.test(tag));
    expect(missingLoading.length, `Images sans loading : ${missingLoading.join("\n")}`)
      .toBeLessThanOrEqual(2);
  });
});

describe("perf — patterns runtime coûteux", () => {
  // Heuristiques textuelles — on ne parse pas le JS mais on cherche les
  // signatures de risques listées par le skill (layout thrashing,
  // event listeners agressifs).

  it("listeners 'scroll' et 'resize' passent par debounce/throttle/requestAnimationFrame", () => {
    // Skill : \"Debounce scroll/resize handlers\"
    const scrollResizeListeners = [
      ...HTML.matchAll(/addEventListener\s*\(\s*['"](scroll|resize)['"][\s\S]*?\)/g),
    ];
    for (const match of scrollResizeListeners) {
      const call = match[0];
      const ok = /(debounce|throttle|requestAnimationFrame|requestIdleCallback)/.test(call);
      expect(ok, `scroll/resize listener sans débounce : ${call.slice(0, 200)}`).toBe(true);
    }
  });

  it("aucun setInterval à intervalle agressif (< 100ms)", () => {
    // Skill : \"Use requestAnimationFrame\" — setInterval(fn, 16) est un
    // anti-pattern. On cherche les valeurs numériques sous 100.
    const intervals = [...HTML.matchAll(/setInterval\s*\([^,]+,\s*(\d+)\s*[,)]/g)];
    for (const match of intervals) {
      const ms = Number(match[1]);
      expect(ms, `setInterval trop fréquent (${ms}ms) : ${match[0]}`).toBeGreaterThanOrEqual(100);
    }
  });

  it("pas de document.write (bloquant parser, banni par tous les navigateurs modernes)", () => {
    expect(HTML).not.toMatch(/document\s*\.\s*write\s*\(/);
  });

  it("pas de innerHTML en concat avec une variable (vecteur XSS + reflow coûteux)", () => {
    // Heuristique : innerHTML = 'string' + variable. Les template literals
    // passent par h() (déjà testé dans frontend/smoke.test.ts). On bloque
    // les concat string explicites qui seraient un red flag.
    const concatInnerHtml = [
      ...HTML.matchAll(/\.innerHTML\s*=\s*['"][^'"]*['"]\s*\+/g),
    ];
    expect(concatInnerHtml.length).toBe(0);
  });
});
