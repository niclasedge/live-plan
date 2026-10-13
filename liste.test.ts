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
  ansageSprechtext: (a: unknown) => string;
  ansageZelle: (a: unknown) => string;
  letzteAnsagen: (liste: unknown) => Record<string, { zeit: number }>;
  einstellungenMenue: (z: unknown) => string;
  stimmenListe: (stimmen: unknown) => { name: string; lang: string }[];
  stimmeWahl: (stimmen: unknown, name: unknown) => { name: string } | null;
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
const MENUE = { kann: true, vorlesen: true, frei: true, stimmen: [], stimme: null, auf: true, letzte: true, fehler: "" };
const STIMMEN = [{ name: "Daniel", lang: "en-GB" }, { name: "Petra", lang: "de-DE" }, { name: "Anna", lang: "de-AT" }, { name: "Petra", lang: "de-DE" }];

test("ansageSprechtext: erst das Repo, dann der Text", () => {
  const { ansageSprechtext } = ansicht();
  assert.equal(ansageSprechtext({ repo: "firstmate", text: "Der PR ist offen." }), "firstmate: Der PR ist offen.");
  assert.equal(ansageSprechtext({ repo: "", text: "Vorlesen an." }), "Vorlesen an.");
});

test("letzteAnsagen: je Sitzung (Repo und Id) die neueste, ohne Id keine", () => {
  const { letzteAnsagen } = ansicht();
  const je = letzteAnsagen([ANSAGE(1), ANSAGE(5), ANSAGE(2, { id: "s-2" }), ANSAGE(3, { repo: "anderes" }), ANSAGE(0, { id: null })]);
  assert.deepEqual(Object.keys(je).sort(), ["anderes\u0000s-1", "live-plan\u0000s-1", "live-plan\u0000s-2"]);
  assert.equal(je["live-plan\u0000s-1"]!.zeit, JETZT - 60_000);
});

test("ansageZelle: ▶ mit der Ansage im title und ihre Uhrzeit, ohne Ansage leer", () => {
  const a = ansicht();
  a.setzeJetzt(JETZT);
  assert.equal(a.ansageZelle(undefined), '<td class="lp-ansage"></td>');
  const html = a.ansageZelle(ANSAGE(5, { text: 'Fertig, "PR" <offen>.' }));
  assert.match(html, new RegExp(`<button type="button" class="an-spiel" data-ansage="${JETZT - 300_000}" title="Fertig, &quot;PR&quot; &lt;offen&gt;\\." aria-label="Letzte Ansage vorlesen: live-plan 15:25">▶</button>`));
  assert.match(html, /<span class="an-uhr mono"[^>]*>15:25<\/span><\/td>$/);
  assert.match(a.ansageZelle(ANSAGE(2 * 24 * 60)), />11\.10\. 15:30</);
});

test("einstellungenMenue: zu nur ⚙, auf mit Vorlesen, Stimme und letzter Ansage", () => {
  const a = ansicht();
  const zu = a.einstellungenMenue({ ...MENUE, auf: false });
  assert.match(zu, /data-einst-auf aria-expanded="false"[^>]*>⚙ 🔊<\/button><\/div>$/);
  assert.doesNotMatch(zu, /data-ansage-auto/);
  const auf = a.einstellungenMenue(MENUE);
  assert.match(auf, /aria-expanded="true"/);
  assert.match(auf, /data-ansage-auto aria-pressed="true"[^>]*>🔊 Vorlesen: an<\/button>/);
  assert.match(auf, /<button type="button" data-ansage-letzte>▶ Letzte Ansage nochmal<\/button>/);
  assert.match(a.einstellungenMenue({ ...MENUE, vorlesen: false }), /aria-pressed="false"[^>]*>🔊 Vorlesen: aus/);
  assert.match(a.einstellungenMenue({ ...MENUE, letzte: false }), /data-ansage-letzte disabled/);
  assert.match(a.einstellungenMenue({ ...MENUE, fehler: "Nicht gespeichert: HTTP 403" }), /an-fehler">Nicht gespeichert: HTTP 403</);
});

test("einstellungenMenue: Hinweis vor dem ersten Klick oder ohne Sprachausgabe, nur bei Vorlesen an", () => {
  const a = ansicht();
  assert.match(a.einstellungenMenue({ ...MENUE, auf: false, frei: false }), /an-hinweis">Ein Klick auf die Seite schaltet den Ton frei\./);
  assert.doesNotMatch(a.einstellungenMenue({ ...MENUE, auf: false, frei: false, vorlesen: false }), /an-hinweis/);
  const stumm = a.einstellungenMenue({ ...MENUE, kann: false });
  assert.match(stumm, /Dieser Browser kann nicht vorlesen/);
  assert.match(stumm, /data-ansage-stimme disabled/);
  assert.match(stumm, /data-ansage-letzte disabled/);
});

test("Stimmen: deutsche zuerst ohne Doppel; gespeicherter Name, sonst die erste deutsche, die Wahl ist ausgewaehlt", () => {
  const a = ansicht();
  assert.deepEqual(a.stimmenListe(STIMMEN).map((s) => s.name), ["Anna", "Petra", "Daniel"]);
  assert.equal(a.stimmeWahl(STIMMEN, "Daniel")!.name, "Daniel");
  assert.equal(a.stimmeWahl(STIMMEN, "Fehlt")!.name, "Petra");
  assert.equal(a.stimmeWahl(STIMMEN, null)!.name, "Petra");
  assert.equal(a.stimmeWahl([{ name: "Daniel", lang: "en-GB" }], null), null);
  const html = a.einstellungenMenue({ ...MENUE, stimmen: STIMMEN, stimme: "Petra" });
  assert.match(html, /<option value="">Standard \(Deutsch\)<\/option><option value="Anna">Anna · de-AT<\/option><option value="Petra" selected>Petra · de-DE<\/option>/);
  const fehlt = a.einstellungenMenue({ ...MENUE, stimmen: STIMMEN, stimme: "Hal" });
  assert.match(fehlt, /<option value="" selected>Standard/);
  assert.match(fehlt, /„Hal“ fehlt in diesem Browser, es gilt die deutsche Vorgabe\./);
});
