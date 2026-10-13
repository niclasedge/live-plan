// live-plan: Tests des Diff-Modals der Ansicht, `node --test ansicht.test.ts` (laedt ansicht/live-plan.js ohne Browser).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";

interface Ansicht {
  diffModal: (z: unknown) => string;
}

/** Laedt die Ansicht ohne Browser: ohne #lp zeichnet sie nichts und stellt nur LivePlanAnsicht bereit. */
function ansicht(): Ansicht {
  const g: Record<string, unknown> = {
    document: { getElementById: () => null, documentElement: { dataset: {} } },
    location: { pathname: "/", search: "" },
  };
  g.globalThis = g;
  vm.runInNewContext(readFileSync(path.join(import.meta.dirname, "ansicht", "live-plan.js"), "utf8"), g);
  return g.LivePlanAnsicht as Ansicht;
}

test("diffModal: ein Bild wird als <img> gezeigt, nicht als Hinweis oder Text", () => {
  const html = ansicht().diffModal({ p: "assets/banner.png", daten: { p: "assets/banner.png", art: "bild", text: "", gekappt: false, url: "blob:http://x/1" } });
  assert.match(html, /<img src="blob:http:\/\/x\/1" alt="assets\/banner\.png">/);
  assert.match(html, /Bild/);
  assert.doesNotMatch(html, /Binaerdatei/);
});

test("diffModal: eine YAML zeigt ihren Text mit Zeilennummern", () => {
  const html = ansicht().diffModal({ p: "conf/app.yaml", daten: { p: "conf/app.yaml", art: "datei", text: "name: demo\nitems:\n  - a\n", gekappt: false } });
  assert.match(html, /<code>name: demo<\/code>/);
  assert.match(html, /<code>  - a<\/code>/);
  assert.doesNotMatch(html, /<img/);
});

test("diffModal: eine andere Binaerdatei zeigt weiter nur den Hinweis", () => {
  const html = ansicht().diffModal({ p: "a.bin", daten: { p: "a.bin", art: "binaer", text: "Binaerdatei, Inhalt nicht gezeigt", gekappt: false } });
  assert.match(html, /Binaerdatei, Inhalt nicht gezeigt/);
  assert.doesNotMatch(html, /<img/);
});

test("diffModal: ein Fehler beim Bild steht als Fehler da, nicht als leeres <img>", () => {
  const html = ansicht().diffModal({ p: "data/bild.png", fehler: "Git-ignorierte Datei, Inhalt nur fuer Aufrufe vom eigenen Rechner" });
  assert.match(html, /Fehler: Git-ignorierte Datei/);
  assert.doesNotMatch(html, /<img/);
});
