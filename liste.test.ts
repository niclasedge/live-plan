// live-plan: offene Fragen und Ansagen in der Liste der Sitzungen, `node --test liste.test.ts` (der Server-Test braucht bun).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { offeneFragen, offeneFragenZahl, pruefePlan } from "./logik.ts";

const FRAGE = (id: string, entscheidung: string) => ({ id, frage: `${id}?`, optionen: [{ label: "A" }, { label: "B" }], entscheidung });

test("offeneFragenZahl: nur Fragen ohne entscheidung zaehlen", () => {
  const roh = { titel: "t", schritte: [], fragen: [FRAGE("F1", ""), FRAGE("F2", "A"), FRAGE("F3", "")] };
  assert.equal(offeneFragenZahl(roh), 2);
  assert.deepEqual(offeneFragen(pruefePlan(roh).plan), ["F1", "F3"]);
});

test("offeneFragenZahl: alle entschieden oder keine Fragen ist 0", () => {
  assert.equal(offeneFragenZahl({ titel: "t", schritte: [], fragen: [FRAGE("F1", "B")] }), 0);
  assert.equal(offeneFragenZahl({ titel: "t" }), 0);
});

test("offeneFragenZahl: kein YAML-Objekt gibt keine Zahl", () => {
  assert.equal(offeneFragenZahl(null), null);
  assert.equal(offeneFragenZahl("titel: [kaputt"), null);
  assert.equal(offeneFragenZahl([1, 2]), null);
});

/** Laedt die Ansicht ohne Browser: ohne #lp zeichnet sie nichts und stellt nur LivePlanAnsicht bereit. */
interface Ansicht {
  fragenZelle: (zahl: unknown, href: string) => string;
  ansagenTeil: (liste: unknown, z: unknown) => string;
  ansageSprechtext: (a: unknown) => string;
  ansageStimmen: (stimmen: unknown) => { id: string; name: string; lang: string }[];
  setzeJetzt: (ms: number) => void;
}

function ansicht(): Ansicht {
  const g: Record<string, unknown> = {
    document: { getElementById: () => null, documentElement: { dataset: {} } },
    location: { pathname: "/", search: "" },
  };
  g.globalThis = g;
  vm.runInNewContext(readFileSync(path.join(import.meta.dirname, "ansicht", "live-plan.js"), "utf8"), g);
  return g.LivePlanAnsicht as Ansicht;
}

test("fragenZelle: Zahl als Verweis, 0 als Strich, ohne Zahl leer", () => {
  const { fragenZelle } = ansicht();
  assert.equal(fragenZelle(2, "/r/s"), '<td class="lp-fragenzahl"><a class="offen" href="/r/s" title="2 offene Fragen">2 offen</a></td>');
  assert.match(fragenZelle(1, "/r/s"), /title="1 offene Frage"/);
  assert.equal(fragenZelle(0, "/r/s"), '<td class="lp-fragenzahl klein">–</td>');
  assert.equal(fragenZelle(null, "/r/s"), '<td class="lp-fragenzahl"></td>');
  assert.equal(fragenZelle(undefined, "/r/s"), '<td class="lp-fragenzahl"></td>');
});

test("GET /api/liste: offeneFragen je Sitzung, eine kaputte YAML kostet nur ihre Zahl", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "live-plan-liste-"));
  const ordner = path.join(tmp, "wurzel", "repo", ".live-plan");
  mkdirSync(ordner, { recursive: true });
  mkdirSync(path.join(tmp, "cache"));
  writeFileSync(path.join(ordner, "offen.yaml"), "titel: Zwei offen\nschritte: []\nfragen:\n  - id: F1\n    frage: Eins?\n    optionen: [{ label: A }]\n    entscheidung: \"\"\n  - id: F2\n    frage: Zwei?\n    optionen: [{ label: A }]\n    entscheidung: A\n  - id: F3\n    frage: Drei?\n    optionen: [{ label: A }]\n");
  writeFileSync(path.join(ordner, "fertig.yaml"), "titel: Alles entschieden\nschritte: []\nfragen:\n  - id: F1\n    frage: Eins?\n    optionen: [{ label: A }]\n    entscheidung: A\n");
  writeFileSync(path.join(ordner, "kaputt.yaml"), "titel: [halb geschrieben\nfragen:\n  - id: F1\n");
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn("bun", [path.join(import.meta.dirname, "server.ts")], {
    env: { ...process.env, LIVE_PLAN_WURZEL: path.join(tmp, "wurzel"), LIVE_PLAN_PORT: String(port), LIVE_PLAN_CACHE: path.join(tmp, "cache") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((bereit, fehler) => {
      server.stdout.on("data", (d: Buffer) => d.toString().includes("live-plan: http") && bereit());
      server.on("exit", (code) => fehler(new Error(`server endete mit ${code}`)));
    });
    const antwort = await fetch(`http://127.0.0.1:${port}/api/liste`);
    assert.equal(antwort.status, 200);
    const { sitzungen } = (await antwort.json()) as { sitzungen: { slug: string; titel: string; offeneFragen: number | null }[] };
    const je = Object.fromEntries(sitzungen.map((s) => [s.slug, s]));
    assert.equal(je.offen?.offeneFragen, 2);
    assert.equal(je.fertig?.offeneFragen, 0);
    assert.equal(je.kaputt?.offeneFragen, null);
    assert.equal(je.kaputt?.titel, "kaputt");
  } finally {
    server.kill();
    rmSync(tmp, { recursive: true, force: true });
  }
});

const JETZT = new Date(2026, 9, 13, 15, 30).getTime();
const ANSAGE = (min: number, extra: Record<string, unknown> = {}) => ({ v: 1, zeit: JETZT - min * 60_000, id: "s-1", repo: "live-plan", text: `Ansage vor ${min} Minuten.`, quelle: "auto", ...extra });
const BEREIT = { kann: true, auto: true, frei: true, stimmen: [], stimme: "", alle: false };

test("ansageSprechtext: erst das Repo, dann der Text", () => {
  const { ansageSprechtext } = ansicht();
  assert.equal(ansageSprechtext({ repo: "firstmate", text: "Der PR ist offen." }), "firstmate: Der PR ist offen.");
  assert.equal(ansageSprechtext({ repo: "", text: "Vorlesen an." }), "Vorlesen an.");
});

test("ansagenTeil: je Ansage ein Abspielknopf, Uhrzeit, Alter, Repo und Text, neueste oben", () => {
  const a = ansicht();
  a.setzeJetzt(JETZT);
  const html = a.ansagenTeil([ANSAGE(5, { quelle: "sage" }), ANSAGE(2 * 24 * 60, { repo: "<x>" })], BEREIT);
  assert.match(html, /data-testid="ansagen"/);
  assert.match(html, /<button type="button" class="an-spiel" data-ansage-spiele="0"[^>]*aria-label="Vorlesen: live-plan 15:25">▶<\/button><span class="an-uhr mono"[^>]*>15:25<\/span><span class="an-alter"[^>]*>5m<\/span><b class="an-repo">live-plan<\/b><span class="an-text">Ansage vor 5 Minuten\.<\/span><span class="lv-marke"[^>]*>selbst<\/span>/);
  // An einem anderen Tag mit Datum; alles maskiert.
  assert.match(html, /data-ansage-spiele="1"[^>]*>▶<\/button><span class="an-uhr mono"[^>]*>11\.10\. 15:30<\/span>/);
  assert.match(html, /<b class="an-repo">&lt;x&gt;<\/b>/);
  assert.match(html, /aria-pressed="true"[^>]*>🔊 Vorlesen: an<\/button>/);
  assert.match(html, /<button type="button" data-ansage-letzte>▶ Letzte nochmal<\/button>/);
  assert.doesNotMatch(html, /an-hinweis/);
});

test("ansagenTeil: Hinweis vor dem ersten Klick, ohne Sprachausgabe alles aus, ohne Ansagen ein leerer Satz", () => {
  const a = ansicht();
  assert.match(a.ansagenTeil([ANSAGE(1)], { ...BEREIT, frei: false }), /an-hinweis">Ein Klick auf die Seite schaltet den Ton frei\./);
  assert.doesNotMatch(a.ansagenTeil([ANSAGE(1)], { ...BEREIT, auto: false, frei: false }), /an-hinweis/);
  const stumm = a.ansagenTeil([ANSAGE(1)], { ...BEREIT, kann: false });
  assert.match(stumm, /Dieser Browser kann nicht vorlesen/);
  assert.match(stumm, /data-ansage-auto[^>]* disabled/);
  assert.match(stumm, /data-ansage-letzte disabled/);
  assert.match(stumm, /data-ansage-spiele="0"[^>]* disabled/);
  const leer = a.ansagenTeil([], { ...BEREIT, auto: false });
  assert.match(leer, /aria-pressed="false"[^>]*>🔊 Vorlesen: aus/);
  assert.match(leer, /data-ansage-letzte disabled/);
  assert.match(leer, /Noch keine Ansage/);
});

test("ansagenTeil: acht ohne Aufklappen, dann alle; die gewaehlte Stimme ist ausgewaehlt", () => {
  const a = ansicht();
  const liste = Array.from({ length: 10 }, (_, i) => ANSAGE(i));
  const kurz = a.ansagenTeil(liste, BEREIT);
  assert.equal(kurz.match(/data-ansage-spiele=/g)?.length, 8);
  assert.match(kurz, /data-ansage-mehr aria-expanded="false">alle 10</);
  assert.equal(a.ansagenTeil(liste, { ...BEREIT, alle: true }).match(/data-ansage-spiele=/g)?.length, 10);
  const stimmen = a.ansageStimmen([{ voiceURI: "en", name: "Daniel", lang: "en-GB" }, { voiceURI: "de2", name: "Petra", lang: "de-DE" }, { voiceURI: "de1", name: "Anna", lang: "de-AT" }, { name: "ohne" }]);
  assert.deepEqual(stimmen.map((s) => s.id), ["de1", "de2", "en"]);
  const html = a.ansagenTeil(liste, { ...BEREIT, stimmen, stimme: "de2" });
  assert.match(html, /<option value="">Standard \(Deutsch\)<\/option><option value="de1">Anna · de-AT<\/option><option value="de2" selected>Petra · de-DE<\/option>/);
});
