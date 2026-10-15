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
  sprechTeile: (text: unknown, zeichen?: number) => string[];
  teilZeichen: (zps?: number) => number;
  ansageDauer: (a: unknown, zps?: number) => number;
  dauerText: (s: number) => string;
  ansageZelle: (a: unknown, laeuft?: unknown, zps?: number) => string;
  letzteAnsagen: (liste: unknown) => Record<string, { zeit: number }>;
  einstellungenMenue: (z: unknown) => string;
  ansageLeiste: (z: unknown) => string;
  ansageInbox: (z: unknown) => string;
  woerterText: (text: unknown) => string;
  sollSprechen: (z: unknown) => boolean;
  stimmenListe: (stimmen: unknown) => { name: string; lang: string }[];
  stimmeWahl: (stimmen: unknown, name: unknown) => { name: string } | null;
  spracheVon: (text: unknown) => string;
  stimmeFuer: (stimmen: unknown, name: unknown, sprache: unknown) => { name: string; lang: string } | null;
  tonFreischalten: (sprache: unknown, aeusserung: unknown) => void;
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
const ANSAGE = (min: number, extra: Record<string, unknown> = {}) => ({ v: 1, zeit: JETZT - min * 60_000, id: "s-1", repo: "live-plan", text: `Ansage vor ${min} Minuten.`, quelle: "auto", kennung: `k${min}`, gelesen: false, ...extra });
const MENUE = { kann: true, vorlesen: true, frei: true, stimmen: [], stimme: null, auf: true, letzte: true, fehler: "" };
const STIMMEN = [{ name: "Daniel", lang: "en-GB" }, { name: "Petra", lang: "de-DE" }, { name: "Anna", lang: "de-AT" }, { name: "Petra", lang: "de-DE" }];

test("ansageSprechtext: erst das Repo, dann der Text", () => {
  const { ansageSprechtext } = ansicht();
  assert.equal(ansageSprechtext({ repo: "firstmate", text: "Der PR ist offen." }), "firstmate: Der PR ist offen.");
  assert.equal(ansageSprechtext({ repo: "", text: "Der PR ist offen." }), "Der PR ist offen.");
});

// Chrome bricht eine einzelne Aeusserung mit Netzstimmen nach etwa 15 s ab; eine lange Ansage spricht darum in Teilen.
// Die Felder kommen aus dem vm-Kontext; `[...x]` macht daraus Felder dieses Kontexts, sonst scheitert deepEqual am Prototyp.
test("sprechTeile: kurz bleibt ein Teil; lang in ganze Saetze bis 200 Zeichen, ohne Text zu verlieren", () => {
  const { sprechTeile } = ansicht();
  assert.deepEqual([...sprechTeile("r: Kurz.")], ["r: Kurz."]);
  assert.deepEqual([...sprechTeile("")], [""]);
  const satz = "Dieser Satz ist einer von vielen in einer langen Ansage am Ende des Zugs.";
  const lang = Array.from({ length: 40 }, () => satz).join(" ");
  const teile = sprechTeile(lang, 200);
  assert.ok(teile.length >= 15, String(teile.length));
  for (const t of teile) {
    assert.ok(Array.from(t).length <= 200, t);
    assert.ok(t.endsWith(satz), t);
  }
  assert.equal(teile.join(" "), lang);
});

test("sprechTeile: ein zu langer Satz am Komma oder an einer Wortgrenze, ein Wort ueber der Grenze hart; z. B. trennt nicht", () => {
  const { sprechTeile } = ansicht();
  const komma = "eins zwei drei vier, ".repeat(20).trim();
  const k = sprechTeile(komma, 200);
  assert.ok(k.length >= 3, String(k.length));
  for (const t of k) assert.ok(t.length <= 200 && t.endsWith(","), t);
  assert.equal(k.join(" "), komma);
  const woerter = `Das gilt z. B. für ${"wort ".repeat(80)}ende.`;
  const w = sprechTeile(woerter, 200);
  for (const t of w) {
    assert.ok(t.length <= 200, t);
    assert.doesNotMatch(t, /(^|\s)[zB]\.$/, t);
  }
  assert.equal(w.join(" "), woerter);
  assert.deepEqual([...sprechTeile("x".repeat(450), 200)].map((t) => t.length), [200, 200, 50]);
  assert.deepEqual([...sprechTeile("abc def ghi", 5)], ["abc", "def", "ghi"]);
});

test("teilZeichen: etwa 10 s Sprechzeit je Teil beim gemessenen Tempo, mindestens 80 und hoechstens 250 Zeichen", () => {
  const { teilZeichen, sprechTeile } = ansicht();
  assert.equal(teilZeichen(14), 140);
  assert.equal(teilZeichen(), 140, "ohne Messung die Vorgabe 14 Zeichen je Sekunde");
  assert.equal(teilZeichen(10), 100, "eine langsame Stimme bekommt kuerzere Teile");
  assert.equal(teilZeichen(22.4), 224);
  assert.equal(teilZeichen(4), 80, "nie kuerzer als 80");
  assert.equal(teilZeichen(40), 250, "nie laenger als 250");
  // Ohne Grenze teilt sprechTeile nach der Vorgabe: 140 Zeichen.
  assert.deepEqual([...sprechTeile("x".repeat(300))].map((t) => t.length), [140, 140, 20]);
});

test("letzteAnsagen: je Sitzung (Repo und Id) die neueste, ohne Id keine", () => {
  const { letzteAnsagen } = ansicht();
  const je = letzteAnsagen([ANSAGE(1), ANSAGE(5), ANSAGE(2, { id: "s-2" }), ANSAGE(3, { repo: "anderes" }), ANSAGE(0, { id: null })]);
  assert.deepEqual(Object.keys(je).sort(), ["anderes\u0000s-1", "live-plan\u0000s-1", "live-plan\u0000s-2"]);
  assert.equal(je["live-plan\u0000s-1"]!.zeit, JETZT - 60_000);
});

test("ansageZelle: ▶ mit der Ansage im title, ihre Uhrzeit und Wortzahl (#28), ohne Ansage leer", () => {
  const a = ansicht();
  a.setzeJetzt(JETZT);
  assert.equal(a.ansageZelle(undefined), '<td class="lp-ansage"></td>');
  const html = a.ansageZelle(ANSAGE(5, { text: 'Fertig, "PR" <offen>.' }));
  assert.match(html, new RegExp(`<button type="button" class="an-spiel" data-ansage="${JETZT - 300_000}" title="Fertig, &quot;PR&quot; &lt;offen&gt;\\." aria-label="Letzte Ansage vorlesen: live-plan 15:25">▶</button>`));
  assert.match(html, /<span class="an-uhr mono"[^>]*>15:25<\/span> <span class="an-woerter">\(3 Wörter\)<\/span> <span class="an-dauer">\(≈ 3 s\)<\/span><\/td>$/);
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

test("tonFreischalten: spricht eine leere, stumme Aeusserung und keine Ansage; ohne Sprachausgabe nichts", () => {
  const { tonFreischalten } = ansicht();
  const gesprochen: { text: string; volume: number }[] = [];
  class Aeusserung { volume = 1; text: string; constructor(text: string) { this.text = text; } }
  tonFreischalten({ speak: (u: Aeusserung) => gesprochen.push({ text: u.text, volume: u.volume }) }, Aeusserung);
  assert.deepEqual(gesprochen, [{ text: "", volume: 0 }]);
  assert.doesNotThrow(() => tonFreischalten(null, Aeusserung));
  assert.doesNotThrow(() => tonFreischalten({ speak: () => assert.fail("ohne Aeusserung kein Sprechen") }, undefined));
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

const STIMMEN_SPRACHEN = [{ name: "Petra", lang: "de-DE" }, { name: "Daniel", lang: "en-GB" }, { name: "Sam", lang: "en-US" }];

test("spracheVon: Englisch nur bei mehr englischen Stoppwoertern, sonst Deutsch; leerer Text ist Deutsch", () => {
  const a = ansicht();
  assert.equal(a.spracheVon("Captain, the shim is under way: a worker is building it"), "en");
  assert.equal(a.spracheVon("Der Lauf arbeitet noch: Er prüft gerade 8 Inhalte"), "de");
  assert.equal(a.spracheVon("═══ SPOC · ROLLE: PM ═══. INTENT: Slice 2 abnehmen, Schnittstelle an Slice 3. DISPATCH: in-session."), "de");
  assert.equal(a.spracheVon(""), "de");
  assert.equal(a.spracheVon(null), "de");
  assert.equal(a.spracheVon("the der"), "de"); // Gleichstand ist Deutsch
  assert.equal(a.spracheVon("the Größe"), "de"); // ein Wort mit ß zaehlt als Deutsch
});

test("spracheVon: nur die ersten zehn Woerter entscheiden", () => {
  // Unter den ersten zehn Woertern drei deutsche (prüft, hier, wird) und ein englisches (the); danach nur Englisch.
  assert.equal(ansicht().spracheVon("Lauf prüft gerade Inhalte sowie Ergebnis hier wird gemessen the is green and the tests are done"), "de");
});

test("spracheVon: das zehnte Wort zaehlt, das elfte nicht (Fenstergrenze genau)", () => {
  const a = ansicht();
  // Neun neutrale Woerter (in keiner Liste, ohne Umlaut), dann „the“ an Stelle 10: zaehlt noch.
  assert.equal(a.spracheVon("Slice PR Gate Build Lauf Test Merge Review Branch the"), "en");
  // Zehn neutrale Woerter, dann „the“ an Stelle 11: zaehlt nicht mehr.
  assert.equal(a.spracheVon("Slice PR Gate Build Lauf Test Merge Review Branch Commit the"), "de");
});

test("spracheVon: zerlegte Umlaute (u + Combining Diaeresis) zaehlen wie das zusammengesetzte Zeichen", () => {
  const a = ansicht();
  assert.equal(a.spracheVon("Prüfung the"), "de"); // zerlegtes ü: Wort bleibt zusammen und zaehlt als Deutsch
  assert.equal(a.spracheVon("Prüfung the"), "de");
});

test("Sprachcode mit _ (Android: en_GB, de_DE) zaehlt wie mit -: Wahl, Vorzug, Rueckfall und Sortierung", () => {
  const a = ansicht();
  assert.equal(a.stimmeWahl([{ name: "Petra", lang: "de_DE" }], null)!.name, "Petra");
  assert.equal(a.stimmeFuer([{ name: "Petra", lang: "de_DE" }, { name: "Daniel", lang: "en_GB" }, { name: "Sam", lang: "en_US" }], "Daniel", "en")!.name, "Daniel");
  assert.equal(a.stimmeFuer([{ name: "Daniel", lang: "en_GB" }], null, "en")!.name, "Daniel");
  assert.deepEqual(a.stimmenListe([{ name: "Daniel", lang: "en_GB" }, { name: "Petra", lang: "de_DE" }]).map((s) => s.name), ["Petra", "Daniel"]);
});

test("spracheVon: mehrdeutige Woerter (an, in, so, was, am, will) zaehlen fuer keine Sprache", () => {
  assert.equal(ansicht().spracheVon("an in so was am will"), "de");
});

test("spracheVon: typografische Apostrophe zaehlen wie ', damit „don't“ und „I've“ Stoppwoerter sind", () => {
  const a = ansicht();
  assert.equal(a.spracheVon("I’ve stopped before answering the gate"), "en");
  assert.equal(a.spracheVon("Don’t stop"), "en"); // nur mit normalisiertem Apostroph ist „don't“ ein Stoppwort
});

test("stimmeFuer: Deutsch bleibt die Wahl, wenn sie Deutsch spricht", () => {
  const a = ansicht();
  assert.equal(a.stimmeFuer(STIMMEN_SPRACHEN, null, "de")!.name, "Petra");
  assert.deepEqual(a.stimmeFuer([{ name: "Anna", lang: "de-AT" }, { name: "Petra", lang: "de-DE" }], "Anna", "de"), { name: "Anna", lang: "de-AT" });
});

test("stimmeFuer: Deutsch mit einer englischen Wahl nimmt de-DE vor de-*, sonst die erste de-*", () => {
  const a = ansicht();
  assert.equal(a.stimmeFuer(STIMMEN_SPRACHEN, "Daniel", "de")!.name, "Petra");
  assert.equal(a.stimmeFuer([{ name: "Anna", lang: "de-AT" }, { name: "Daniel", lang: "en-GB" }], "Daniel", "de")!.name, "Anna");
  assert.equal(a.stimmeFuer([{ name: "Anna", lang: "de-AT" }, { name: "Petra", lang: "de-DE" }, { name: "Daniel", lang: "en-GB" }], "Daniel", "de")!.name, "Petra");
});

test("stimmeFuer: Deutsch ohne deutsche Stimme bleibt die Wahl; ohne Wahl null", () => {
  const a = ansicht();
  const englisch = [{ name: "Daniel", lang: "en-GB" }, { name: "Sam", lang: "en-US" }];
  assert.equal(a.stimmeFuer(englisch, "Daniel", "de")!.name, "Daniel");
  assert.equal(a.stimmeFuer(englisch, null, "de"), null);
});

test("stimmeFuer: Englisch mit deutscher Basis nimmt en-US vor en-GB", () => {
  const a = ansicht();
  assert.equal(a.stimmeFuer(STIMMEN_SPRACHEN, null, "en")!.name, "Sam");
  assert.equal(a.stimmeFuer([{ name: "Petra", lang: "de-DE" }, { name: "Daniel", lang: "en-GB" }], null, "en")!.name, "Daniel");
});

test("stimmeFuer: Englisch ohne englische Stimme bleibt die Wahl; ohne Stimmen null", () => {
  const a = ansicht();
  assert.equal(a.stimmeFuer([{ name: "Petra", lang: "de-DE" }], null, "en")!.name, "Petra");
  assert.equal(a.stimmeFuer([], null, "en"), null);
  assert.equal(a.stimmeFuer([{ name: "Sam", lang: "en-US" }], null, "en")!.name, "Sam");
});

test("stimmeFuer: eine gewaehlte englische Stimme bleibt bei englischem Text, auch neben en-US", () => {
  assert.equal(ansicht().stimmeFuer(STIMMEN_SPRACHEN, "Daniel", "en")!.name, "Daniel");
});

const LEISTE = (ansagen: unknown[], extra: Record<string, unknown> = {}) => ({ ansagen, eigeneId: null, menue: MENUE, ...extra });

test("ansageLeiste: hoechstens fuenf Zeilen bei sieben Ansagen, die neueste zuerst", () => {
  const a = ansicht();
  a.setzeJetzt(JETZT);
  const sieben = [1, 2, 3, 4, 5, 6, 7].map((min) => ANSAGE(min, { id: `s-${min}` }));
  const html = a.ansageLeiste(LEISTE(sieben));
  assert.equal((html.match(/<li class="an-zeile/g) ?? []).length, 5);
  const zeiten = [...html.matchAll(/data-ansage="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(zeiten, [1, 2, 3, 4, 5].map((min) => JETZT - min * 60_000));
});

test("ansageLeiste: je Zeile ▶ mit der Zeit, Uhrzeit, Repo und Text; Text und Repo escaped", () => {
  const a = ansicht();
  a.setzeJetzt(JETZT);
  const html = a.ansageLeiste(LEISTE([ANSAGE(5, { repo: "firstmate", text: 'Fertig, "PR" <offen>.' })]));
  assert.match(html, new RegExp(`<button type="button" class="an-spiel" data-ansage="${JETZT - 300_000}" aria-label="Ansage vorlesen: firstmate 15:25">▶</button>`));
  assert.match(html, /<span class="an-uhr mono">15:25<\/span>/);
  assert.match(html, /<a class="an-repo" href="\/firstmate\/s-1" title="firstmate">firstmate<\/a>/);
  assert.match(html, new RegExp(`<button type="button" class="an-text" data-ansage-text="${JETZT - 300_000}" aria-expanded="false"><span>Fertig, &quot;PR&quot; &lt;offen&gt;\\.</span></button>`));
});

test("ansageLeiste: eigene Sitzung hervorgehoben ueber die Id; der Repo-Name darf aus einem Worktree abweichen", () => {
  const a = ansicht();
  a.setzeJetzt(JETZT);
  const ansagen = [ANSAGE(1, { id: "s-x", repo: "ops-lab" }), ANSAGE(2, { id: "s-1", repo: "live-plan" }), ANSAGE(3, { id: "s-1", repo: "live-plan.worktree" })];
  const html = a.ansageLeiste(LEISTE(ansagen, { eigeneId: "s-1" }));
  const zeilen = html.split('<li class="an-zeile').slice(1);
  assert.deepEqual(zeilen.map((z) => z.startsWith(" an-eigen")), [false, true, true]);
});

test("ansageLeiste: der ganze Text steht in der Zeile, eingeklappt; aufgeklappt aus z.aufgeklappt; die Dauer rechnet mit dem ganzen Text (#26)", () => {
  const a = ansicht();
  a.setzeJetzt(JETZT);
  const lang = "Wort ".repeat(300).trim();
  const x = ANSAGE(1, { text: lang });
  const html = a.ansageLeiste(LEISTE([x]));
  const text = /<button type="button" class="an-text" data-ansage-text="(\d+)" aria-expanded="false"><span>([^<]*)<\/span><\/button>/.exec(html)!;
  assert.equal(Number(text[1]), x.zeit);
  assert.equal(text[2], lang, "nicht mehr nach 90 Zeichen gekuerzt");
  assert.doesNotMatch(html, /…/);
  // Gesprochen wird "live-plan: " und der ganze Text, 1510 Zeichen; bei 14 je Sekunde 108 s.
  assert.match(html, /<span class="an-dauer">\(≈ 1:48 min\)<\/span>/);
  const auf = a.ansageLeiste(LEISTE([x, ANSAGE(2)], { aufgeklappt: { [x.zeit]: true } }));
  assert.deepEqual([...auf.matchAll(/data-ansage-text="(\d+)" aria-expanded="(true|false)"/g)].map((m) => [Number(m[1]), m[2]]), [[x.zeit, "true"], [JETZT - 120_000, "false"]]);
});

test("ansageLeiste: <script> im Text und im Repo wird escaped", () => {
  const a = ansicht();
  a.setzeJetzt(JETZT);
  const html = a.ansageLeiste(LEISTE([ANSAGE(1, { repo: "<img src=x>", text: "<script>alert(1)</script>" })]));
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x&gt;/);
});

test("ansageLeiste: ohne Ansage der Leerzustand; Kopf mit ⚙-Menue und Hinweis vor dem ersten Klick", () => {
  const a = ansicht();
  const html = a.ansageLeiste(LEISTE([], { menue: { ...MENUE, auf: false, frei: false } }));
  assert.match(html, /^<section class="an-leiste" data-testid="ansagen-leiste">/);
  assert.match(html, /<h2 tabindex="-1">Ansagen<\/h2>/);
  assert.match(html, /<p class="an-leer">Noch keine Ansage\.<\/p>/);
  assert.doesNotMatch(html, /<li/);
  assert.match(html, /data-einst-auf aria-expanded="false"/);
  assert.match(html, /an-hinweis">Ein Klick auf die Seite schaltet den Ton frei\./);
});

// --- Inbox, Gelesen und Wortzahl (#28) ----------------------------------------------------------

test("woerterText: Woerter mit Buchstabe oder Ziffer, in Klammern; Singular 1 Wort", () => {
  const { woerterText } = ansicht();
  assert.equal(woerterText("Der Build ist grün."), "(4 Wörter)");
  assert.equal(woerterText("Fertig."), "(1 Wort)");
  assert.equal(woerterText("Version 2.1 – fertig, 3 Tests."), "(5 Wörter)");
  assert.equal(woerterText(""), "(0 Wörter)");
  assert.equal(woerterText("wort ".repeat(183)), "(183 Wörter)");
});

const INBOX = (ansagen: unknown[], extra: Record<string, unknown> = {}) => ({ ansagen, ...extra });

test("ansageInbox: nur ungelesene, je Repo gruppiert, die Gruppe mit der neuesten zuerst; je Nachricht gelesen, je Gruppe und fuer alle 'alle als gelesen' (#28)", () => {
  const a = ansicht();
  a.setzeJetzt(JETZT);
  const ansagen = [
    ANSAGE(1, { repo: "ops-lab", id: "s-2" }),
    ANSAGE(2),
    ANSAGE(3, { gelesen: true }),
    ANSAGE(4, { repo: "ops-lab", id: "s-2", text: "Eins zwei drei vier fünf." }),
    ANSAGE(5),
  ];
  const html = a.ansageInbox(INBOX(ansagen));
  assert.match(html, /^<section class="an-leiste an-inbox" data-testid="ansagen-inbox">/);
  assert.match(html, /<h2 tabindex="-1">Inbox<\/h2><span class="an-zahl">4 ungelesen<\/span><button type="button" class="an-alle" data-ansage-gelesen="k1 k2 k4 k5"[^>]*>alle als gelesen<\/button>/);
  const gruppen = [...html.matchAll(/<div class="an-gruppe" data-ansage-gruppe="([^"]*)"><div class="an-gruppe-kopf"><h3>([^<]*)<\/h3><span class="an-zahl">(\d+)<\/span><button type="button" class="an-alle" data-ansage-gelesen="([^"]*)"[^>]*>alle als gelesen<\/button><\/div><ol>(.*?)<\/ol><\/div>/g)];
  assert.deepEqual(gruppen.map((g) => [g[1], g[2], g[3], g[4]]), [["ops-lab", "ops-lab", "2", "k1 k4"], ["live-plan", "live-plan", "2", "k2 k5"]]);
  // Je Zeile: der Knopf gelesen mit der Kennung, die Wortzahl neben der Uhrzeit, der Link zur Sitzung, der aufklappbare Text.
  assert.deepEqual([...gruppen[0]![5]!.matchAll(/data-ansage-gelesen="([^"]*)"/g)].map((m) => m[1]), ["k1", "k4"]);
  assert.match(gruppen[0]![5]!, /<span class="an-uhr mono">15:26<\/span> <span class="an-woerter">\(5 Wörter\)<\/span> <span class="an-dauer">/);
  assert.match(gruppen[0]![5]!, /<a class="an-repo" href="\/ops-lab\/s-2"/);
  assert.match(gruppen[0]![5]!, /data-ansage-text="\d+" aria-expanded="false"/);
  assert.doesNotMatch(html, /k3/, "gelesene stehen nicht in der Inbox");
  assert.doesNotMatch(html, /an-gelesen"/);
  // Die Gruppe kennt <script> nicht.
  assert.doesNotMatch(a.ansageInbox(INBOX([ANSAGE(1, { repo: "<script>x</script>" })])), /<script>/);
});

test("ansageInbox: ohne Ungelesenes der Leerzustand ohne 'alle als gelesen'; ein Fehler steht im Kopf (#28)", () => {
  const a = ansicht();
  const leer = a.ansageInbox(INBOX([ANSAGE(1, { gelesen: true })]));
  assert.match(leer, /<p class="an-leer">Keine ungelesene Ansage\.<\/p>/);
  assert.doesNotMatch(leer, /data-ansage-gelesen/);
  assert.match(leer, /<span class="an-zahl">0 ungelesen<\/span>/);
  assert.match(a.ansageInbox(INBOX([], { fehler: "Nicht gespeichert: HTTP 500" })), /an-fehler">Nicht gespeichert: HTTP 500</);
});

test("ansageLeiste: nur dieses Repo und die eigene Sitzung, die neuesten fuenf; gelesene ausgegraut ohne Knopf, ungelesene mit Knopf gelesen (#28)", () => {
  const a = ansicht();
  a.setzeJetzt(JETZT);
  const ansagen = [
    ANSAGE(1, { repo: "ops-lab", id: "s-x" }),
    ANSAGE(2, { gelesen: true }),
    ANSAGE(3, { repo: "live-plan.worktree" }),
    ANSAGE(4),
    ANSAGE(5, { repo: "ops-lab", id: "s-y" }),
    ANSAGE(6, { gelesen: true }),
    ANSAGE(7),
    ANSAGE(8),
  ];
  const html = a.ansageLeiste(LEISTE(ansagen, { repo: "live-plan", eigeneId: "s-1" }));
  const zeilen = html.split('<li class="an-zeile').slice(1);
  assert.deepEqual(zeilen.map((z) => Number(/data-ansage="(\d+)"/.exec(z)![1])), [2, 3, 4, 6, 7].map((min) => JETZT - min * 60_000));
  assert.deepEqual(zeilen.map((z) => z.startsWith(" an-eigen an-gelesen") || z.startsWith(" an-gelesen")), [true, false, false, true, false]);
  assert.deepEqual(zeilen.map((z) => /data-ansage-gelesen="([^"]*)"/.exec(z)?.[1] ?? null), [null, "k3", "k4", null, "k7"]);
  // Ohne Ansage dieses Repos der Leerzustand, auch wenn andere Repos etwas haben.
  assert.match(a.ansageLeiste(LEISTE([ANSAGE(1, { repo: "ops-lab", id: "s-x" })], { repo: "live-plan", eigeneId: "s-1" })), /<p class="an-leer">Noch keine Ansage\.<\/p>/);
});

/** Was gerade spricht: { zeit, pausiert } (der Zustand der Seite, s. laeuft in live-plan.js). */
const LAUF = (zeit: number, pausiert = false) => ({ zeit, pausiert });
/** Eine Leiste, in der die Ansage `laeuft` spricht; das Menue traegt denselben Zustand. */
const LEISTE_LAUF = (ansagen: unknown[], laeuft: { zeit: number; pausiert: boolean }) => LEISTE(ansagen, { laeuft, menue: { ...MENUE, stopp: true } });

test("ansageDauer: Zeichen je Sekunde (Vorgabe 14), aufgerundet, mindestens 1 s; der Repo-Name zaehlt mit", () => {
  const { ansageDauer } = ansicht();
  assert.equal(ansageDauer({ repo: "", text: "a".repeat(252) }), 18);
  assert.equal(ansageDauer({ repo: "", text: "a".repeat(253) }), 19);
  assert.equal(ansageDauer({ repo: "r", text: "a".repeat(249) }), 18);
  assert.equal(ansageDauer({ repo: "", text: "a".repeat(252) }, 7), 36);
  assert.equal(ansageDauer({ repo: "", text: "😀".repeat(14) }), 1, "ein Emoji ist ein Zeichen, kein Code-Einheiten-Paar");
  assert.equal(ansageDauer({ repo: "", text: "" }), 1);
});

test("dauerText: unter einer Minute in Sekunden, ab einer Minute als m:ss", () => {
  const { dauerText } = ansicht();
  assert.equal(dauerText(18), "≈ 18 s");
  assert.equal(dauerText(59), "≈ 59 s");
  assert.equal(dauerText(60), "≈ 1:00 min");
  assert.equal(dauerText(65), "≈ 1:05 min");
  assert.equal(dauerText(125), "≈ 2:05 min");
});

test("ansageZelle: ▶ ruhend, ⏸ waehrend diese Ansage spricht, ▶ mit an-pausiert wenn pausiert; die anderen bleiben ▶", () => {
  const a = ansicht();
  a.setzeJetzt(JETZT);
  const x = ANSAGE(5);
  assert.match(a.ansageZelle(x, null), /<button type="button" class="an-spiel" data-ansage="\d+" title="[^"]*" aria-label="Letzte Ansage vorlesen: live-plan 15:25">▶<\/button>/);
  assert.match(a.ansageZelle(x, LAUF(x.zeit)), /<button type="button" class="an-spiel an-laeuft" data-ansage="\d+" title="[^"]*" aria-label="Ansage anhalten: live-plan 15:25">⏸<\/button>/);
  assert.match(a.ansageZelle(x, LAUF(x.zeit, true)), /<button type="button" class="an-spiel an-pausiert" data-ansage="\d+" title="[^"]*" aria-label="Ansage fortsetzen: live-plan 15:25">▶<\/button>/);
  assert.doesNotMatch(a.ansageZelle(ANSAGE(1, { id: "s-2" }), LAUF(x.zeit)), /an-laeuft|an-pausiert/);
});

test("ansageZelle: die geschaetzte Dauer hinter der Uhrzeit, mit dem kalibrierten Wert", () => {
  const a = ansicht();
  a.setzeJetzt(JETZT);
  const x = ANSAGE(5, { repo: "firstmate", text: 'Fertig, "PR" <offen>.' });
  assert.match(a.ansageZelle(x), /<span class="an-uhr mono"[^>]*>15:25<\/span> <span class="an-woerter">\(3 Wörter\)<\/span> <span class="an-dauer">\(≈ 3 s\)<\/span><\/td>$/);
  assert.match(a.ansageZelle(x, null, 7), /<span class="an-dauer">\(≈ 5 s\)<\/span><\/td>$/);
});

test("ansageLeiste: hinter der Uhrzeit die geschaetzte Dauer in Klammern, mit dem zps der Leiste", () => {
  const a = ansicht();
  a.setzeJetzt(JETZT);
  const x = ANSAGE(5, { repo: "firstmate", text: 'Fertig, "PR" <offen>.' });
  assert.match(a.ansageLeiste(LEISTE([x])), /<span class="an-zeit"><span class="an-uhr mono">15:25<\/span> <span class="an-woerter">\(3 Wörter\)<\/span> <span class="an-dauer">\(≈ 3 s\)<\/span><\/span><a class="an-repo"/);
  assert.match(a.ansageLeiste(LEISTE([x], { zps: 7 })), /<span class="an-dauer">\(≈ 5 s\)<\/span>/);
});

test("ansageLeiste: fuenf Zellen je Zeile (Knopf, Zeit mit Wortzahl und Dauer, Repo, Text, gelesen), eine gelesene ohne den letzten Knopf (#28)", () => {
  const a = ansicht();
  a.setzeJetzt(JETZT);
  const html = a.ansageLeiste(LEISTE([ANSAGE(5, { repo: "Muster-Werkstatt-Archiv1", text: "Kurz." })]));
  assert.match(html, /<li class="an-zeile"><button [^>]*>▶<\/button><span class="an-zeit"><span class="an-uhr mono">15:25<\/span> <span class="an-woerter">\(1 Wort\)<\/span> <span class="an-dauer">\(≈ \d+ s\)<\/span><\/span><a class="an-repo" href="\/Muster-Werkstatt-Archiv1\/s-1" title="Muster-Werkstatt-Archiv1">Muster-Werkstatt-Archiv1<\/a><button type="button" class="an-text" data-ansage-text="\d+" aria-expanded="false"><span>Kurz\.<\/span><\/button><button type="button" class="an-gelesen-knopf" data-ansage-gelesen="k5" aria-label="Als gelesen markieren: Muster-Werkstatt-Archiv1 15:25">gelesen<\/button><\/li>/);
  const gelesen = a.ansageLeiste(LEISTE([ANSAGE(5, { text: "Kurz.", gelesen: true })]));
  assert.match(gelesen, /<li class="an-zeile an-gelesen">.*<span>Kurz\.<\/span><\/button><\/li>/);
  assert.doesNotMatch(gelesen, /data-ansage-gelesen/);
});

test("ansageLeiste: der Repo-Name verweist auf die Sitzung, die eigene mit aria-current; ohne Id oder Repo bleibt er Text", () => {
  const a = ansicht();
  a.setzeJetzt(JETZT);
  const html = a.ansageLeiste(LEISTE([
    ANSAGE(1, { id: "s-x", repo: "ops-lab" }), ANSAGE(2, { id: "s-1", repo: "live-plan" }), ANSAGE(3, { id: "s-2", repo: "ops lab" }),
    ANSAGE(4, { id: null, repo: "ohne" }), ANSAGE(5, { id: "s-3", repo: "" }),
  ], { eigeneId: "s-1" }));
  assert.match(html, /<a class="an-repo" href="\/ops-lab\/s-x" title="ops-lab">ops-lab<\/a>/);
  assert.match(html, /<a class="an-repo" href="\/live-plan\/s-1" aria-current="page" title="live-plan">live-plan<\/a>/);
  assert.match(html, /<a class="an-repo" href="\/ops%20lab\/s-2" title="ops lab">ops lab<\/a>/);
  assert.match(html, /<b class="an-repo" title="ohne">ohne<\/b>/);
  assert.match(html, /<b class="an-repo"><\/b>/);
  assert.equal((html.match(/aria-current/g) ?? []).length, 1);
});

test("ansageLeiste: der volle Repo-Name steht im title, verlinkt wie ohne Link, denn die Anzeige kuerzt ihn mit Ellipse", () => {
  const a = ansicht();
  a.setzeJetzt(JETZT);
  const lang = "Muster-Werkstatt-Archiv1-mit-einem-sehr-langen-Namen";
  const html = a.ansageLeiste(LEISTE([ANSAGE(1, { id: "s-1", repo: lang }), ANSAGE(2, { id: null, repo: `${lang}-zwei` })]));
  assert.match(html, new RegExp(`<a class="an-repo" href="/${lang}/s-1" title="${lang}">${lang}</a>`));
  assert.match(html, new RegExp(`<b class="an-repo" title="${lang}-zwei">${lang}-zwei</b>`));
});

test("ansageLeiste: laufende Zeile ⏸ mit an-laeuft, pausierte ▶ mit an-pausiert, Stopp nur solange etwas spricht oder pausiert ist", () => {
  const a = ansicht();
  a.setzeJetzt(JETZT);
  const eins = ANSAGE(1, { id: "s-1" }), zwei = ANSAGE(2, { id: "s-2" });
  const spielt = a.ansageLeiste(LEISTE_LAUF([eins, zwei], LAUF(eins.zeit)));
  assert.match(spielt, /<button type="button" class="an-spiel an-laeuft" data-ansage="\d+" aria-label="Ansage anhalten: live-plan 15:29">⏸<\/button>/);
  assert.match(spielt, /<button type="button" class="an-spiel" data-ansage="\d+" aria-label="Ansage vorlesen: live-plan 15:28">▶<\/button>/);
  assert.match(spielt, /<button type="button" class="an-stopp" data-ansage-stopp[^>]*>⏹ Stopp<\/button>/);
  const pausiert = a.ansageLeiste(LEISTE_LAUF([eins, zwei], LAUF(eins.zeit, true)));
  assert.match(pausiert, /<button type="button" class="an-spiel an-pausiert" data-ansage="\d+" aria-label="Ansage fortsetzen: live-plan 15:29">▶<\/button>/);
  assert.match(pausiert, /data-ansage-stopp/);
  const ruhend = a.ansageLeiste(LEISTE([eins, zwei]));
  assert.doesNotMatch(ruhend, /an-laeuft|an-pausiert|data-ansage-stopp/);
});

test("einstellungenMenue: Stopp neben ⚙ nur solange etwas spricht, auch bei zugeklapptem Menue", () => {
  const a = ansicht();
  assert.doesNotMatch(a.einstellungenMenue(MENUE), /data-ansage-stopp/);
  const zu = a.einstellungenMenue({ ...MENUE, auf: false, stopp: true });
  assert.match(zu, /data-einst-auf aria-expanded="false"[^>]*>⚙ 🔊<\/button><button type="button" class="an-stopp" data-ansage-stopp[^>]*>⏹ Stopp<\/button>/);
});

// Ein Tab spricht (#18, Runde 2): sollSprechen entscheidet je Tab, ob er eine neue Ansage vorliest.
const SPRECHEN = { vorlesen: true, frei: true, sprecher: null, tabId: "t-1", istLeiter: false, gesprochenBis: null, zeit: JETZT };

test("sollSprechen: spricht nur der Sprecher-Tab, auch wenn ein anderer Tab der Leiter ist", () => {
  const { sollSprechen } = ansicht();
  assert.equal(sollSprechen({ ...SPRECHEN, sprecher: "t-1" }), true);
  assert.equal(sollSprechen({ ...SPRECHEN, tabId: "t-2", istLeiter: true, sprecher: "t-1" }), false);
  assert.equal(sollSprechen({ ...SPRECHEN, tabId: "t-2", istLeiter: false, sprecher: "t-1" }), false);
});

test("sollSprechen: ohne Sprecher spricht der Leiter-Tab, ein Nicht-Leiter nicht", () => {
  const { sollSprechen } = ansicht();
  assert.equal(sollSprechen({ ...SPRECHEN, istLeiter: true, sprecher: null }), true);
  assert.equal(sollSprechen({ ...SPRECHEN, istLeiter: true, sprecher: "" }), true);
  assert.equal(sollSprechen({ ...SPRECHEN, istLeiter: false, sprecher: null }), false);
});

test("sollSprechen: eine schon gesprochene Ansage (zeit <= gesprochenBis) wird nicht noch einmal gesprochen", () => {
  const { sollSprechen } = ansicht();
  assert.equal(sollSprechen({ ...SPRECHEN, sprecher: "t-1", gesprochenBis: JETZT }), false);
  assert.equal(sollSprechen({ ...SPRECHEN, sprecher: "t-1", gesprochenBis: JETZT + 1 }), false);
  assert.equal(sollSprechen({ ...SPRECHEN, sprecher: "t-1", gesprochenBis: JETZT - 1 }), true);
});

test("sollSprechen: nur bei Vorlesen an und freigeschaltetem Ton, auch im Sprecher-Tab", () => {
  const { sollSprechen } = ansicht();
  assert.equal(sollSprechen({ ...SPRECHEN, sprecher: "t-1", vorlesen: false }), false);
  assert.equal(sollSprechen({ ...SPRECHEN, sprecher: "t-1", frei: false }), false);
  assert.equal(sollSprechen({ ...SPRECHEN, istLeiter: true, frei: false }), false);
});

test("sollSprechen: ohne localStorage (sprecher und gesprochenBis null) entscheidet allein der Leiter", () => {
  const { sollSprechen } = ansicht();
  assert.equal(sollSprechen({ ...SPRECHEN, istLeiter: true }), true);
  assert.equal(sollSprechen({ ...SPRECHEN, istLeiter: false }), false);
});

/** Eine Aeusserung der Attrappe: der Text und die Ereignisse, die der Browser ihr gibt (der Code setzt sie). */
interface Aeusserung { text: string; voice?: { name: string }; lang?: string; onstart?: () => void; onend?: () => void; onerror?: () => void }

/** Ein Klick-Ereignis wie vom Browser: ein Ziel, das `closest` fuer die Ansage-Auswahl kennt, mit den Attributen `attrs` (setAttribute schreibt hinein). */
const ereignis = (attrs: Record<string, string>) => ({
  target: { closest: (sel: string) => (sel.includes("data-ansage") ? { hasAttribute: (n: string) => n in attrs, getAttribute: (n: string) => attrs[n] ?? null, setAttribute: (n: string, v: unknown) => { attrs[n] = String(v); } } : null) },
});

/**
 * Startet die Uebersicht mit Attrappen fuer Sprachausgabe, Ereignisquelle, Speicher und Web Locks. `sperre` ist "fehlt"
 * (kein navigator.locks, der Fallback) oder "abgelehnt" (der Lock wird verweigert, der .catch-Zweig greift).
 * `startAnsagen` steht schon beim ersten Laden da (ohne Neuigkeit, also ohne Vorlesen); `vorher` ist der Speicher vor dem Start.
 */
/** Weitere Attrappen: `host` ist die Antwort von GET /api/host, `zurueck` haelt Antworten bis `freigeben(url)` zurueck, `stimmen` sind die Stimmen der Sprachausgabe. */
interface LaufOptionen { host?: unknown; zurueck?: string[]; stimmen?: unknown[]; stimme?: string; welt?: Welt; name?: string; speakWirft?: number }

/** Ein Tab, wie ihn die Welt sieht: wie viele Aeusserungen in seiner Sprachausgabe stehen, und seine Ereignisse. */
interface WeltTab { name: string; imBrowser: () => number; storage: (e: unknown) => void; geaendert: () => void; beende: () => void }

/**
 * Mehrere Tabs eines Browsers (#42): ein gemeinsamer localStorage (mit dem Ereignis storage in den anderen Tabs), Web Locks
 * (exklusiv, je Name eine Warteschlange, die Zusage kommt asynchron wie im Browser) und BroadcastChannel (Zustellung an die
 * anderen Tabs, asynchron). `verstoesse` haelt jeden Moment fest, in dem ein Tab spricht, waehrend ein anderer etwas in
 * seiner Sprachausgabe hat; `gesprochen` ist die Reihenfolge der Aeusserungen ueber alle Tabs.
 */
interface Welt {
  speicher: Map<string, string>; ansagen: unknown[]; tabs: WeltTab[]; verstoesse: string[]; gesprochen: string[];
  /** Je Tab seine Web Locks und sein BroadcastChannel; `Kanal` gehoert keinem Tab (eine fremde Seite). */
  locksFuer: (tab: string) => unknown; kanalFuer: (tab: string) => unknown; Kanal: unknown;
  /** Jede Anforderung eines Locks: "TAB:NAME", in der Reihenfolge. */
  anforderungen: string[];
  /** Anforderungen "TAB:NAME", die einmal mit AbortError scheitern (kein Verweigern des Browsers). */
  einmalAbbrechen: Set<string>;
  /** Ein Tab verschwindet: seine Locks gehen frei, seine Anforderungen und Kanaele fallen weg. */
  sterben: (tab: WeltTab) => void;
  neueAnsagen: (liste: unknown[]) => Promise<void>; abspielen: () => Promise<void>; warte: () => Promise<void>;
}
const warteAlles = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

function welt(): Welt {
  type Halt = { tab: string };
  const sperren = new Map<string, { halter: Halt | null; warten: Array<{ tab: string; los: () => void }> }>();
  const naechster = (s: { halter: Halt | null; warten: Array<{ tab: string; los: () => void }> }) => { s.halter = null; s.warten.shift()?.los(); };
  let kanaele: Array<{ tab: string; name: string; onmessage: ((e: { data: unknown }) => void) | null }> = [];
  const kanalFuer = (tab: string) => class {
    name: string; tab = tab; onmessage: ((e: { data: unknown }) => void) | null = null;
    constructor(name: string) { this.name = name; kanaele.push(this); }
    postMessage(data: unknown) {
      const kopie = structuredClone(data);
      kanaele.forEach((k) => { if (k !== this && k.name === this.name) setImmediate(() => { if (kanaele.includes(k)) k.onmessage?.({ data: kopie }); }); });
    }
    close() {}
  };
  const w: Welt = {
    speicher: new Map(), ansagen: [], tabs: [], verstoesse: [], gesprochen: [], anforderungen: [], einmalAbbrechen: new Set(),
    locksFuer: (tab) => ({
      request: (name: string, a: unknown, b?: unknown) => {
        const cb = (typeof a === "function" ? a : b) as (l: unknown) => unknown;
        const s = sperren.get(name) ?? { halter: null, warten: [] };
        sperren.set(name, s);
        w.anforderungen.push(`${tab}:${name}`);
        if (w.einmalAbbrechen.delete(`${tab}:${name}`)) return Promise.reject(Object.assign(new Error("abgebrochen"), { name: "AbortError" }));
        return new Promise((ok, fehler) => {
          const eintrag = {
            tab,
            los: () => {
              const halt = { tab };
              s.halter = halt;
              Promise.resolve().then(() => cb({ name })).then(ok, fehler).finally(() => { if (s.halter === halt) naechster(s); });
            },
          };
          if (!s.halter && !s.warten.length) eintrag.los(); else s.warten.push(eintrag);
        });
      },
    }),
    kanalFuer,
    Kanal: kanalFuer("extern"),
    sterben: (t) => {
      w.tabs = w.tabs.filter((x) => x !== t);
      kanaele = kanaele.filter((k) => k.tab !== t.name);
      sperren.forEach((s) => {
        s.warten = s.warten.filter((x) => x.tab !== t.name);
        if (s.halter?.tab === t.name) naechster(s);
      });
    },
    /** Der Server hat jetzt diese Ansagen (neueste zuerst); jede Ereignisquelle meldet geaendert. */
    neueAnsagen: async (liste) => { w.ansagen = liste; w.tabs.forEach((t) => t.geaendert()); await warteAlles(); },
    /** Beendet reihum, was in einer Sprachausgabe steht (Beginn und Ende), bis nirgends mehr etwas steht. */
    abspielen: async () => {
      for (let i = 0; i < 100; i++) {
        const t = w.tabs.find((x) => x.imBrowser() > 0);
        if (!t) return;
        t.beende();
        await warteAlles();
      }
      throw new Error("abspielen endet nicht");
    },
    warte: warteAlles,
  };
  return w;
}

async function ansagenLauf(sperre: "fehlt" | "abgelehnt" | "echt", startAnsagen: unknown[] = [], vorher: Record<string, string> = {}, gelesenStatus = 200, optionen: LaufOptionen = {}) {
  const gesprochen: string[] = [];
  const welt = optionen.welt;
  const tore = new Map((optionen.zurueck ?? []).map((url) => { let auf = () => {}; const p = new Promise<void>((r) => { auf = r; }); return [url, { p, auf }] as const; }));
  // Welcher Knopf den Fokus hat (K3): "gelesen:KENNUNG", "inbox" oder "leiste"; `aktiv` ist sein Knoten (document.activeElement).
  // Wie im Browser faellt der Fokus auf body (null), sobald innerHTML den Knoten ersetzt (S3: das SSE-Echo zeichnet neu).
  let fokus: string | null = null;
  type Knoten = { hasAttribute: (n: string) => boolean; getAttribute: (n: string) => string | null; matches: (sel: string) => boolean; focus: () => void };
  let aktiv: Knoten | null = null;
  const knoten = (name: string, attr: Record<string, string>, sel: string[] = []): Knoten => {
    const k: Knoten = {
      hasAttribute: (n) => n in attr, getAttribute: (n) => attr[n] ?? null, matches: (x) => sel.includes(x),
      focus: () => { fokus = name; aktiv = k; },
    };
    return k;
  };
  const gelesenKnopf = (kennung: string) => knoten(`gelesen:${kennung}`, { "data-ansage-gelesen": kennung });
  const alleKnopf = (kennungen: string) => knoten(`alle:${kennungen}`, { "data-ansage-gelesen": kennungen }, [".an-alle"]);
  // Was der Server als gelesen fuehrt: die Kennungen aus erfolgreichen POST /api/ansagen/gelesen.
  const markiert = new Set<string>();
  const anfragen: { url: string; methode: string; body: unknown }[] = [];
  const protokoll: string[] = [];
  const aeusserungen: Aeusserung[] = [];
  const klicks: Array<(e: unknown) => void> = [];
  const wurzelKlicks: Array<(e: unknown) => void> = [];
  const quellen: Array<Record<string, () => void>> = [];
  const speicher = welt?.speicher ?? new Map<string, string>(Object.entries(vorher));
  const name = optionen.name ?? `tab${welt ? welt.tabs.length + 1 : 1}`;
  // Was in der Sprachausgabe dieses Tabs steht: gesprochen und weder beendet noch abgebrochen (#42). `hoechstens` ist das Maximum.
  const imBrowser: Aeusserung[] = [];
  let hoechstens = 0;
  // Die Uhr fuer setTimeout: Wecker laufen nur, wenn der Test die Zeit vorstellt (zeitVor).
  let uhr = 0, weckerNr = 0;
  const wecker: Array<{ id: number; um: number; f: () => void }> = [];
  // Die Hoerer am Fenster (storage, pagehide).
  const fenster: Record<string, Array<(e: unknown) => void>> = {};
  let ansagen: unknown[] = startAnsagen;
  let pausiert = false;
  // Was cancel synchron ausloest, wie Chrome die Enden der abgebrochenen Aeusserungen meldet (s. beimAbbruch).
  let beimCancel: (() => void) | null = null;
  // Ein Stueck DOM fuer die zwei Knoten, die der Stopp-Zustand einfuegt und entfernt: das Menue (⚙) und der Stopp daneben.
  // innerHTML setzt, was im Markup steht; einfuegen und entfernen wirken auf denselben Zustand.
  let wurzelHtml = "", menueDa = false, stoppDa = false;
  const stoppKnoten = { remove: () => { stoppDa = false; }, focus: () => {} };
  const menueKnoten = { focus: () => {}, insertAdjacentHTML: (_lage: string, html: string) => { if (html.includes("data-ansage-stopp")) stoppDa = true; } };
  const wurzel = {
    get innerHTML() { return wurzelHtml; },
    set innerHTML(html: string) { wurzelHtml = html; fokus = null; aktiv = null; menueDa = html.includes("data-einst-auf"); stoppDa = html.includes("data-ansage-stopp"); },
    querySelector: (sel: string) => {
      if (sel === "[data-ansage-stopp]") return stoppDa ? stoppKnoten : null;
      if (sel === "[data-einst-auf]") return menueDa ? menueKnoten : null;
      // Der Block Rechner und die Stellen, hinter die zeichneHost ihn einfuegt, als Ausschnitte von wurzelHtml (S2).
      if (sel === '[data-testid="sitzung-host"]') {
        const a = wurzelHtml.indexOf('<section class="lp-host"');
        if (a < 0) return null;
        const e = wurzelHtml.indexOf("</section>", a) + "</section>".length;
        return { set outerHTML(html: string) { wurzelHtml = wurzelHtml.slice(0, a) + html + wurzelHtml.slice(e); }, remove: () => { wurzelHtml = wurzelHtml.slice(0, a) + wurzelHtml.slice(e); } };
      }
      const nach = (ende: number) => (ende < 0 ? null : { insertAdjacentHTML: (_lage: string, html: string) => { wurzelHtml = wurzelHtml.slice(0, ende) + html + wurzelHtml.slice(ende); } });
      if (sel === ".lp-kopf") return nach(wurzelHtml.indexOf("</header>") < 0 ? -1 : wurzelHtml.indexOf("</header>") + "</header>".length);
      if (sel === '[data-testid="ansagen-inbox"]') {
        const a = wurzelHtml.indexOf('data-testid="ansagen-inbox"');
        return nach(a < 0 ? -1 : wurzelHtml.indexOf("</section>", a) + "</section>".length);
      }
      if (sel === ".an-inbox h2") return wurzelHtml.includes("an-inbox") ? knoten("inbox", {}, [sel]) : null;
      if (sel === '[data-testid="ansagen-leiste"] h2') return wurzelHtml.includes("ansagen-leiste") ? knoten("leiste", {}, [sel]) : null;
      // Wie querySelector: der erste Knopf in Dokumentreihenfolge; "alle als gelesen" einer Gruppe mit einer Ansage
      // traegt dieselbe Kennung wie ihr Knopf gelesen und steht davor.
      const g = /^(?:\.(an-alle|an-gelesen-knopf))?\[data-ansage-gelesen="([^"]*)"\]$/.exec(sel);
      if (g) {
        const treffer = [...wurzelHtml.matchAll(/class="(an-alle|an-gelesen-knopf)" data-ansage-gelesen="([^"]*)"/g)].find((m) => m[2] === g[2] && (!g[1] || m[1] === g[1]));
        return treffer ? (treffer[1] === "an-alle" ? alleKnopf(treffer[2]!) : gelesenKnopf(treffer[2]!)) : null;
      }
      return null;
    },
    querySelectorAll: (sel: string) => sel === ".an-gelesen-knopf"
      ? [...wurzelHtml.matchAll(/class="an-gelesen-knopf" data-ansage-gelesen="([^"]*)"/g)].map((m) => gelesenKnopf(m[1]!))
      : [],
    contains: (x: unknown) => x != null && x === aktiv,
    addEventListener: (typ: string, f: (e: unknown) => void) => { if (typ === "click") wurzelKlicks.push(f); },
  };
  const doc = {
    getElementById: () => wurzel, documentElement: { dataset: {} }, visibilityState: "visible", get activeElement() { return aktiv; }, title: "",
    addEventListener: (typ: string, f: (e: unknown) => void) => { if (typ === "click") klicks.push(f); },
    removeEventListener: () => {}, querySelector: () => null, querySelectorAll: () => [],
  };
  const antwort = (b: unknown, ok = true, status = ok ? 200 : 404) => ({ ok, status, json: async () => b });
  const g: Record<string, unknown> = {
    document: doc,
    location: { pathname: "/", search: "" },
    localStorage: {
      getItem: (k: string) => speicher.get(k) ?? null,
      setItem: (k: string, v: string) => { const alt = speicher.get(k) ?? null; speicher.set(k, String(v)); melde(k, alt, String(v)); },
      removeItem: (k: string) => { const alt = speicher.get(k) ?? null; speicher.delete(k); melde(k, alt, null); },
    },
    speechSynthesis: {
      speak: (u: Aeusserung) => {
        if (u.text !== "" && optionen.speakWirft !== undefined && optionen.speakWirft-- === 0) throw new Error("speak scheitert");
        gesprochen.push(u.text);
        if (u.text === "") return; // die Freischaltung spricht stumm und bleibt im Protokoll außen vor
        protokoll.push("speak:" + u.text);
        aeusserungen.push(u);
        imBrowser.push(u);
        hoechstens = Math.max(hoechstens, imBrowser.length);
        if (welt) {
          welt.gesprochen.push(u.text);
          const andere = welt.tabs.filter((t) => t !== ich && t.imBrowser() > 0).map((t) => t.name);
          if (andere.length) welt.verstoesse.push(`${ich.name} spricht "${u.text}", waehrend ${andere.join(", ")} spricht`);
        }
      },
      get paused() { return pausiert; },
      cancel: () => { imBrowser.length = 0; protokoll.push("cancel"); beimCancel?.(); },
      pause: () => { protokoll.push("pause"); pausiert = true; },
      resume: () => { protokoll.push("resume"); pausiert = false; },
      getVoices: () => optionen.stimmen ?? [],
    },
    SpeechSynthesisUtterance: class { text: string; volume = 1; constructor(t: string) { this.text = t; } },
    EventSource: function () {
      const hoert: Record<string, () => void> = {};
      quellen.push(hoert);
      return { addEventListener: (typ: string, f: () => void) => { hoert[typ] = f; }, close: () => {} };
    },
    // Verweigert ein Browser den Lock, dann mit SecurityError (etwa ein Dokument mit opakem Ursprung).
    navigator: sperre === "fehlt" ? {} : sperre === "echt" && welt ? { locks: welt.locksFuer(name) } : { locks: { request: () => Promise.reject(Object.assign(new Error("verweigert"), { name: "SecurityError" })) } },
    BroadcastChannel: sperre === "echt" && welt ? welt.kanalFuer(name) : class { onmessage: unknown = null; postMessage() {} },
    setInterval: () => 1, clearInterval: () => {},
    setTimeout: (f: () => void, ms = 0) => { const id = ++weckerNr; wecker.push({ id, um: uhr + (Number(ms) || 0), f }); return id; },
    clearTimeout: (id: number) => { const i = wecker.findIndex((x) => x.id === id); if (i >= 0) wecker.splice(i, 1); },
    addEventListener: (typ: string, f: (e: unknown) => void) => { (fenster[typ] ??= []).push(f); },
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      await tore.get(url)?.p;
      if (url === "/api/host") return optionen.host ? antwort(optionen.host) : antwort(null, false);
      if (init?.method === "POST") anfragen.push({ url, methode: init.method, body: JSON.parse(init.body ?? "null") });
      if (url === "/api/ansagen/gelesen") {
        if (gelesenStatus !== 200) return antwort({ fehler: "kaputt" }, false, gelesenStatus);
        (JSON.parse(init?.body ?? "{}").kennungen as string[]).forEach((k) => markiert.add(k));
        return antwort({ gelesen: 1 });
      }
      if (url === "/api/ansagen") return antwort({ ansagen: ((welt ? welt.ansagen : ansagen) as { kennung?: string; gelesen?: boolean }[]).map((a) => (a.kennung && markiert.has(a.kennung) ? { ...a, gelesen: true } : a)) });
      if (url === "/api/einstellungen") return antwort({ vorlesen: true, stimme: optionen.stimme ?? null });
      if (url === "/api/liste") return antwort({ wurzel: "/w", sitzungen: [] });
      return antwort(null, false);
    },
  };
  // Dieser Tab in der Welt: das Ereignis storage geht an die anderen Tabs, asynchron wie im Browser.
  const ich: WeltTab = {
    name,
    imBrowser: () => imBrowser.length,
    storage: (e) => { (fenster.storage ?? []).forEach((f) => f(e)); },
    geaendert: () => { quellen.forEach((h) => h.geaendert?.()); },
    beende: () => { const u = imBrowser.shift(); u?.onstart?.(); u?.onend?.(); },
  };
  function melde(key: string, oldValue: string | null, newValue: string | null) {
    welt?.tabs.forEach((t) => { if (t !== ich) setImmediate(() => t.storage({ key, oldValue, newValue })); });
  }
  welt?.tabs.push(ich);
  g.globalThis = g;
  vm.runInNewContext(readFileSync(path.join(import.meta.dirname, "ansicht", "live-plan.js"), "utf8"), g);
  const warte = warteAlles;
  await warte();
  return {
    /** Gesprochene Texte; die Freischaltung spricht stumm einen leeren Text und zaehlt nicht. */
    gesprochen: () => gesprochen.filter((t) => t !== ""),
    sprecher: () => speicher.get("live-plan.sprecher") ?? null,
    /** Ein Klick auf die Seite: dieser Tab wird Sprecher und schaltet die Sprachausgabe frei. */
    klick: () => { klicks.forEach((f) => f({ target: { closest: () => null, hasAttribute: () => false } })); },
    /** Wie das Schliessen des Sprecher-Tabs: sein Schluessel verschwindet. */
    sprecherSchliessen: () => { speicher.delete("live-plan.sprecher"); },
    /** Eine neue Ansage kommt an: Ereignis geaendert, dann Laden und Sprechen. */
    neueAnsage: async (zeit: number) => {
      ansagen = [{ v: 1, zeit, id: `a${zeit}`, repo: "r", text: "Neu", quelle: "test" }];
      quellen.forEach((h) => h.geaendert?.());
      await warte();
    },
    /** Die Aufrufe an speechSynthesis in der Reihenfolge: cancel, pause, resume und speak:TEXT (ohne die Freischaltung). */
    protokoll: () => [...protokoll],
    /** Ein Klick auf den ▶- oder ⏸-Knopf der Ansage mit dieser Zeit. */
    klickeAnsage: (zeit: number) => { wurzelKlicks.forEach((f) => f(ereignis({ "data-ansage": String(zeit) }))); },
    /** Ein Klick auf den Schalter Vorlesen an/aus im Menue. */
    klickeAuto: () => { wurzelKlicks.forEach((f) => f(ereignis({ "data-ansage-auto": "" }))); },
    /** Ein Klick auf den Stopp-Knopf. */
    klickeStopp: () => { wurzelKlicks.forEach((f) => f(ereignis({ "data-ansage-stopp": "" }))); },
    /** Ein Klick auf den Text einer Zeile der Leiste; `attrs` sind die Attribute des Knopfs, der Klick schreibt hinein. */
    klickeText: (attrs: Record<string, string>) => { wurzelKlicks.forEach((f) => f(ereignis(attrs))); },
    /** Ein Klick auf einen Knopf gelesen oder "alle als gelesen" mit diesen Kennungen (durch Leerzeichen getrennt). */
    klickeGelesen: async (kennungen: string) => { wurzelKlicks.forEach((f) => f(ereignis({ "data-ansage-gelesen": kennungen }))); await warte(); },
    /** Die POST-Anfragen der Seite in ihrer Reihenfolge, mit dem gelesenen JSON-Koerper. */
    anfragen: () => anfragen.map((x) => ({ ...x })),
    /** Gibt eine zurueckgehaltene Antwort frei (LaufOptionen.zurueck) und wartet, bis die Seite sie verarbeitet hat. */
    freigeben: async (url: string) => { tore.get(url)!.auf(); await warte(); },
    /** Wer den Fokus hat (K3); null heisst body. */
    fokus: () => fokus,
    /** Das Echo des Servers nach einem Markieren (S3): gelesen.json aendert sich, der Strom meldet geaendert, die Seite laedt und zeichnet neu. */
    echo: async () => { quellen.forEach((h) => h.geaendert?.()); await warte(); },
    /** Das zuletzt gezeichnete Markup der Seite. */
    html: () => wurzelHtml,
    /** Ob der Stopp-Knopf im Markup steht. */
    stoppSichtbar: () => stoppDa,
    /** Die zuletzt gesprochene Aeusserung; ihre Ereignisse loest der Test selbst aus, wie der Browser es tut. */
    letzte: (): Aeusserung => aeusserungen[aeusserungen.length - 1]!,
    /** Alle gesprochenen Aeusserungen in der Reihenfolge der Warteschlange (ohne die Freischaltung). */
    aeusserungen: (): Aeusserung[] => [...aeusserungen],
    /** Die Uhr der Ansicht festsetzen (ms), damit eine Messung der Dauer deterministisch ist. */
    jetzt: (ms: number) => (g.LivePlanAnsicht as Ansicht).setzeJetzt(ms),
    speicher: () => speicher,
    /** Was cancel ab jetzt synchron ausloest, etwa das Ende der laufenden Aeusserung. */
    beimAbbruch: (f: (() => void) | null) => { beimCancel = f; },
    /** Wie viele Aeusserungen gerade in der Sprachausgabe dieses Tabs stehen, und wie viele es hoechstens waren (#42). */
    imBrowser: () => imBrowser.length,
    hoechstens: () => hoechstens,
    /** Die erste Aeusserung in der Sprachausgabe beginnt (onstart). */
    beginne: () => { imBrowser[0]?.onstart?.(); },
    /** Die erste Aeusserung in der Sprachausgabe beginnt und endet regulaer, wie der Browser es meldet. */
    beende: () => ich.beende(),
    /**
     * Der Tab verschwindet. Mit `pagehide` schliesst der Nutzer ihn (die Seite meldet sich ab); ohne stuerzt er ab. Danach
     * sind seine Locks frei, seine Sprachausgabe ist leer, und er hoert und sendet nichts mehr.
     */
    sterben: async (mitPagehide = true) => {
      if (mitPagehide) (fenster.pagehide ?? []).forEach((f) => f({}));
      welt?.sterben(ich);
      imBrowser.length = 0;
      await warte();
    },
    /** Stellt die Uhr der Wecker (setTimeout) um `ms` vor und laesst faellige Wecker in ihrer Reihenfolge laufen. */
    zeitVor: (ms: number) => {
      uhr += ms;
      for (;;) {
        const faellig = wecker.filter((x) => x.um <= uhr).sort((x, y) => x.um - y.um || x.id - y.id)[0];
        if (!faellig) return;
        wecker.splice(wecker.indexOf(faellig), 1);
        faellig.f();
      }
    },
  };
}

const SCHLUESSEL_ZPS = "live-plan.zeichen-je-sekunde";
const ANSAGE_EINS = { v: 1, zeit: 1000, id: "a", repo: "r", text: "Eins.", quelle: "test" };
const ANSAGE_ZWEI = { v: 1, zeit: 2000, id: "b", repo: "r", text: "Zwei.", quelle: "test" };

test("Klick: ▶ spielt sofort, ⏸ haelt an, ▶ setzt fort, eine andere Zeile bricht ab, Stopp hebt alles auf", async () => {
  const lauf = await ansagenLauf("fehlt", [ANSAGE_ZWEI, ANSAGE_EINS]);
  lauf.klickeAnsage(1000); // ruhend: spielt sofort (wie bisher, mit cancel davor)
  lauf.klickeAnsage(1000); // laeuft diese Ansage: anhalten
  lauf.klickeAnsage(1000); // pausiert diese Ansage: fortsetzen
  lauf.klickeAnsage(2000); // eine andere Zeile: aufheben, abbrechen, dann die neue sprechen
  lauf.klickeStopp();
  assert.deepEqual(lauf.protokoll(), [
    "cancel", "speak:r: Eins.",
    "pause",
    "resume",
    "resume", "cancel", "speak:r: Zwei.",
    "resume", "cancel",
  ]);
});

const ANSAGE_ENGLISCH = { v: 1, zeit: 5000, id: "e", repo: "r", text: "Captain, the shim is under way.", quelle: "test" };
const ANSAGE_DEUTSCH = { v: 1, zeit: 6000, id: "d", repo: "r", text: "Der Lauf arbeitet noch.", quelle: "test" };

test("Vorlesen: eine englische Ansage spricht die en-US-Stimme, eine deutsche die deutsche; die Sprache steht im Text, nicht im Repo", async () => {
  // Der Repo-Name „the“ ist englisch, der Text „Lauf gemessen.“ nicht: gezaehlt wird nur der Text.
  const repoEnglisch = { v: 1, zeit: 7000, id: "f", repo: "the", text: "Lauf gemessen.", quelle: "test" };
  const lauf = await ansagenLauf("fehlt", [ANSAGE_DEUTSCH, ANSAGE_ENGLISCH, repoEnglisch], {}, 200, { stimmen: STIMMEN_SPRACHEN });
  lauf.klickeAnsage(5000);
  assert.equal(lauf.letzte().text, "r: Captain, the shim is under way.");
  assert.equal(lauf.letzte().voice?.name, "Sam");
  assert.equal(lauf.letzte().lang, "en-US");
  lauf.klickeAnsage(6000);
  assert.equal(lauf.letzte().voice?.name, "Petra");
  assert.equal(lauf.letzte().lang, "de-DE");
  lauf.klickeAnsage(7000);
  assert.equal(lauf.letzte().voice?.name, "Petra");
  lauf.klickeStopp();
});

test("Vorlesen: eine gewaehlte englische Stimme spricht englische Texte, deutsche Texte nehmen de-DE", async () => {
  const lauf = await ansagenLauf("fehlt", [ANSAGE_DEUTSCH, ANSAGE_ENGLISCH], {}, 200, { stimmen: STIMMEN_SPRACHEN, stimme: "Daniel" });
  lauf.klickeAnsage(6000);
  assert.equal(lauf.letzte().voice?.name, "Petra");
  assert.equal(lauf.letzte().lang, "de-DE");
  lauf.klickeAnsage(5000);
  assert.equal(lauf.letzte().voice?.name, "Daniel");
  assert.equal(lauf.letzte().lang, "en-GB");
  lauf.klickeStopp();
});

test("Vorlesen ohne Stimmen: englisch mit lang en-US, deutsch mit de-DE", async () => {
  const lauf = await ansagenLauf("fehlt", [ANSAGE_DEUTSCH, ANSAGE_ENGLISCH]);
  lauf.klickeAnsage(5000);
  assert.equal(lauf.letzte().voice, undefined);
  assert.equal(lauf.letzte().lang, "en-US");
  lauf.klickeAnsage(6000);
  assert.equal(lauf.letzte().lang, "de-DE");
  lauf.klickeStopp();
});

/**
 * Eine Ansage ueber 140 Zeichen (ein Teil bei der Vorgabe 14 Zeichen je Sekunde): "r: " und drei Saetze sind 185 Zeichen,
 * also zwei Teile (zwei Saetze, dann einer).
 */
const LANG_SATZ = "Ein Satz einer langen Ansage, die in Teilen gesprochen wird.";
const ANSAGE_LANG = { v: 1, zeit: 3000, id: "c", repo: "r", text: Array.from({ length: 3 }, () => LANG_SATZ).join(" "), quelle: "test" };

test("Lange Ansage: ein Teil nach dem anderen in die Sprachausgabe (#42); Pause, Fortsetzen und Stopp gelten der ganzen Ansage, der Stopp bleibt bis zum letzten Teil", async () => {
  const lauf = await ansagenLauf("fehlt", [ANSAGE_LANG]);
  lauf.klickeAnsage(3000);
  assert.equal(lauf.aeusserungen().length, 1, "erst der erste Teil");
  const eins = lauf.letzte();
  eins.onstart?.();
  lauf.klickeAnsage(3000); // anhalten
  lauf.klickeAnsage(3000); // fortsetzen
  eins.onend?.(); // der erste Teil ist fertig, jetzt erst kommt der zweite
  const teile = lauf.aeusserungen();
  assert.equal(teile.length, 2);
  assert.equal(teile.map((u) => u.text).join(" "), `r: ${ANSAGE_LANG.text}`);
  const zwei = teile[1]!;
  assert.equal(lauf.stoppSichtbar(), true, "die Ansage laeuft noch");
  zwei.onstart?.();
  lauf.klickeAnsage(3000); // haelt die Ansage an, spricht sie nicht neu
  assert.deepEqual(lauf.protokoll().filter((x) => !x.startsWith("speak:")), ["cancel", "pause", "resume", "pause"]);
  lauf.klickeStopp();
  assert.deepEqual(lauf.protokoll().slice(-2), ["resume", "cancel"]);
  assert.equal(lauf.stoppSichtbar(), false);
});

test("Lange Ansage: erst das Ende des letzten Teils beendet sie; die Kalibrierung misst alle Teile vom ersten Beginn an", async () => {
  const lauf = await ansagenLauf("fehlt", [ANSAGE_LANG]);
  lauf.klickeAnsage(3000);
  const eins = lauf.letzte();
  lauf.jetzt(10_000);
  eins.onstart?.();
  lauf.jetzt(20_000);
  eins.onend?.();
  assert.equal(lauf.speicher().has(SCHLUESSEL_ZPS), false, "nach dem ersten Teil misst noch nichts");
  const zwei = lauf.letzte(); // der zweite Teil kommt erst nach dem Ende des ersten (#42)
  assert.notEqual(zwei, eins);
  zwei.onstart?.();
  lauf.jetzt(30_000);
  zwei.onend?.();
  assert.equal(lauf.stoppSichtbar(), false);
  // 185 Zeichen in 20 s: 9,25 je Sekunde, gleitend 0,7 * 14 + 0,3 * 9,25.
  assert.ok(Math.abs(Number(lauf.speicher().get(SCHLUESSEL_ZPS)) - (0.7 * 14 + 0.3 * (185 / 20))) < 1e-9);
});

test("Lange Ansage: ein Fehler in einem Teil beendet sie nicht vor dem letzten Teil, gemessen wird dann nicht", async () => {
  const lauf = await ansagenLauf("fehlt", [ANSAGE_LANG]);
  lauf.klickeAnsage(3000);
  const eins = lauf.letzte();
  lauf.jetzt(10_000);
  eins.onstart?.();
  eins.onerror?.();
  assert.equal(lauf.stoppSichtbar(), true, "der zweite Teil steht noch aus");
  const zwei = lauf.letzte(); // nach dem Fehler des ersten Teils folgt der zweite (#42)
  assert.notEqual(zwei, eins);
  zwei.onstart?.();
  lauf.jetzt(30_000);
  zwei.onend?.();
  assert.equal(lauf.stoppSichtbar(), false);
  assert.equal(lauf.speicher().has(SCHLUESSEL_ZPS), false);
});

/** Zwoelf Saetze zu 60 Zeichen: lang genug, dass jedes Tempo mehrere Teile ergibt. */
const ANSAGE_SEHR_LANG = { v: 1, zeit: 4000, id: "d", repo: "r", text: Array.from({ length: 12 }, () => LANG_SATZ).join(" "), quelle: "test" };

test("Lange Ansage: die Teile richten sich nach dem gemessenen Tempo, langsam kuerzer, schnell laenger, je hoechstens etwa 10 s", async () => {
  const laengen = async (zps: string) => {
    const lauf = await ansagenLauf("fehlt", [ANSAGE_SEHR_LANG], { [SCHLUESSEL_ZPS]: zps });
    lauf.klickeAnsage(4000);
    // Die Teile kommen nacheinander (#42): jedes Ende gibt den naechsten frei.
    for (let n = 0; n < 50 && lauf.imBrowser() > 0; n++) lauf.beende();
    const teile = lauf.aeusserungen().map((u) => u.text);
    assert.equal(teile.join(" "), `r: ${ANSAGE_SEHR_LANG.text}`);
    return teile.map((t) => Array.from(t).length);
  };
  const langsam = await laengen("8");
  assert.ok(langsam.every((n) => n <= 80), String(langsam));
  assert.ok(langsam.every((n) => n / 8 <= 10), "bei 8 Zeichen je Sekunde hoechstens 10 s je Teil");
  const schnell = await laengen("30");
  assert.ok(schnell.every((n) => n <= 250), String(schnell));
  assert.ok(Math.max(...schnell) > 200, `eine schnelle Stimme bekommt laengere Teile: ${schnell}`);
  assert.ok(schnell.length < langsam.length, `${schnell.length} Teile schnell, ${langsam.length} langsam`);
});

test("Abbruch: meldet cancel die Enden der abgebrochenen Ansage synchron, misst sie nicht (Stopp und andere Zeile)", async () => {
  const lauf = await ansagenLauf("fehlt", [ANSAGE_ZWEI, ANSAGE_EINS]);
  lauf.klickeAnsage(1000);
  const eins = lauf.letzte();
  lauf.jetzt(10_000);
  eins.onstart?.();
  lauf.jetzt(10_500);
  // Chrome meldet beim cancel das Ende der laufenden Aeusserung noch waehrend des Aufrufs.
  lauf.beimAbbruch(() => { eins.onend?.(); });
  lauf.klickeStopp();
  assert.equal(lauf.speicher().has(SCHLUESSEL_ZPS), false, "ein Stopp ist keine Messung");
  assert.equal(lauf.stoppSichtbar(), false);
  lauf.beimAbbruch(null);
  lauf.klickeAnsage(1000);
  const nochmal = lauf.letzte();
  lauf.jetzt(20_000);
  nochmal.onstart?.();
  lauf.jetzt(20_500);
  lauf.beimAbbruch(() => { nochmal.onend?.(); });
  lauf.klickeAnsage(2000); // eine andere Zeile bricht ab und spricht sie
  assert.equal(lauf.speicher().has(SCHLUESSEL_ZPS), false, "ein Wechsel der Zeile ist keine Messung");
  assert.equal(lauf.letzte().text, "r: Zwei.");
  assert.equal(lauf.stoppSichtbar(), true, "die neue Ansage laeuft");
});

test("Klick: der Stopp bei pausierter Ansage hebt die Pause vor dem Abbruch auf (Chrome haengt sonst)", async () => {
  const lauf = await ansagenLauf("fehlt", [ANSAGE_EINS]);
  lauf.klickeAnsage(1000);
  lauf.klickeAnsage(1000);
  lauf.klickeStopp();
  assert.deepEqual(lauf.protokoll(), ["cancel", "speak:r: Eins.", "pause", "resume", "cancel"]);
});

test("Klick auf den Text einer Zeile klappt ihn auf und wieder zu, ohne vorzulesen (#26)", async () => {
  const lauf = await ansagenLauf("fehlt", [ANSAGE_EINS]);
  const text = { "data-ansage-text": "1000", "aria-expanded": "false" };
  lauf.klickeText(text);
  assert.equal(text["aria-expanded"], "true");
  lauf.klickeText(text);
  assert.equal(text["aria-expanded"], "false");
  assert.deepEqual(lauf.protokoll(), [], "der Text spielt nicht ab");
});

test("Klick auf gelesen: POST mit der Kennung, kein Vorlesen; die Zeile verschwindet aus der Inbox, 'alle als gelesen' schickt alle (#28)", async () => {
  const lauf = await ansagenLauf("fehlt", [{ ...ANSAGE_ZWEI, kennung: "kb" }, { ...ANSAGE_EINS, kennung: "ka" }, { ...ANSAGE_EINS, zeit: 500, kennung: "kc", repo: "q" }]);
  assert.match(lauf.html(), /data-ansage-gelesen="ka"/);
  await lauf.klickeGelesen("ka");
  assert.deepEqual(lauf.anfragen(), [{ url: "/api/ansagen/gelesen", methode: "POST", body: { kennungen: ["ka"] } }]);
  assert.deepEqual(lauf.protokoll(), [], "gelesen liest nicht vor und bricht nichts ab");
  assert.doesNotMatch(lauf.html(), /data-ansage-gelesen="ka"/);
  assert.match(lauf.html(), /data-ansage-gelesen="kb"/);
  await lauf.klickeGelesen("kb kc");
  assert.deepEqual(lauf.anfragen()[1], { url: "/api/ansagen/gelesen", methode: "POST", body: { kennungen: ["kb", "kc"] } });
  assert.match(lauf.html(), /Keine ungelesene Ansage\./);
  assert.deepEqual(lauf.protokoll(), []);
});

test("Klick auf gelesen: scheitert das Speichern, laedt die Seite den Stand des Servers neu und meldet den Fehler (#28)", async () => {
  const lauf = await ansagenLauf("fehlt", [{ ...ANSAGE_EINS, kennung: "ka" }], {}, 500);
  await lauf.klickeGelesen("ka");
  assert.match(lauf.html(), /data-ansage-gelesen="ka"/, "der Server hat sie nicht als gelesen");
  assert.match(lauf.html(), /an-fehler">Nicht als gelesen gespeichert: kaputt</);
});

// --- Review #28: Repo-Namen wie Object-Schluessel, Reihenfolge Inbox/Rechner, Fokus -----------------

test("ansageInbox: ein Repo namens constructor, __proto__, toString oder hasOwnProperty bekommt seine Gruppe, ohne zu werfen (Review S1)", () => {
  const a = ansicht();
  a.setzeJetzt(JETZT);
  for (const repo of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    const html = a.ansageInbox(INBOX([ANSAGE(1, { repo }), ANSAGE(2, { repo, kennung: "k2" })]));
    assert.match(html, new RegExp(`data-ansage-gruppe="${repo}"><div class="an-gruppe-kopf"><h3>${repo}</h3><span class="an-zahl">2</span>`), repo);
  }
});

test("Klick auf gelesen: eine Ansage mit der Kennung constructor bleibt ungelesen, wenn eine andere markiert wird (Review S1)", async () => {
  const lauf = await ansagenLauf("fehlt", [{ ...ANSAGE_ZWEI, kennung: "constructor" }, { ...ANSAGE_EINS, kennung: "ka" }]);
  await lauf.klickeGelesen("ka");
  assert.match(lauf.html(), /data-ansage-gelesen="constructor"/);
  await lauf.klickeGelesen("constructor");
  assert.doesNotMatch(lauf.html(), /data-ansage-gelesen="constructor"/);
});

const HOST = {
  verfuegbar: true, cpu: 12, last: [0.5, 0.5, 0.5], kerne: 4,
  speicher: { gesamtMb: 16000, benutztMb: 8000, verfuegbarMb: 8000, swapGesamtMb: 0, swapBenutztMb: 0 },
  platten: [], topCpu: [], topRam: [],
};
const reihenfolge = (html: string) => ["ansagen-inbox", "sitzung-host", "tabelle-sitzungen"].map((t) => [t, html.indexOf(`data-testid="${t}"`)] as const).filter(([, i]) => i >= 0).sort((x, y) => x[1] - y[1]).map(([t]) => t);

test("Uebersicht: Inbox, Rechner, Tabelle in derselben Reihenfolge, gleich ob die Liste oder der Rechner zuerst ankommt und nach einer neuen Ansage (Review S2)", async () => {
  for (const zuerst of ["/api/liste", "/api/host"]) {
    const dann = zuerst === "/api/liste" ? "/api/host" : "/api/liste";
    const lauf = await ansagenLauf("fehlt", [{ ...ANSAGE_EINS, kennung: "ka" }], {}, 200, { host: HOST, zurueck: ["/api/liste", "/api/host"] });
    await lauf.freigeben(zuerst);
    await lauf.freigeben(dann);
    assert.deepEqual(reihenfolge(lauf.html()), ["ansagen-inbox", "sitzung-host", "tabelle-sitzungen"], `${zuerst} zuerst`);
    await lauf.neueAnsage(5000);
    assert.deepEqual(reihenfolge(lauf.html()), ["ansagen-inbox", "sitzung-host", "tabelle-sitzungen"], `${zuerst} zuerst, nach neuer Ansage`);
  }
});

test("Fokus nach gelesen: auf den naechsten Knopf gelesen, nach dem letzten auf den vorigen, ohne Knopf auf den Kopf der Inbox (Review K3)", async () => {
  const drei = [{ ...ANSAGE_ZWEI, kennung: "kb" }, { ...ANSAGE_EINS, kennung: "ka" }, { ...ANSAGE_EINS, zeit: 500, kennung: "kc" }];
  const lauf = await ansagenLauf("fehlt", drei);
  await lauf.klickeGelesen("kb");
  assert.equal(lauf.fokus(), "gelesen:ka", "der naechste rueckt an dieselbe Stelle");
  await lauf.klickeGelesen("kc");
  assert.equal(lauf.fokus(), "gelesen:ka", "nach dem letzten der davor");
  await lauf.klickeGelesen("ka");
  assert.equal(lauf.fokus(), "inbox", "ohne Knopf der Kopf der Inbox");
  const alle = await ansagenLauf("fehlt", drei);
  await alle.klickeGelesen("kb ka kc");
  assert.equal(alle.fokus(), "inbox");
});

test("Fokus nach gelesen: ein Knopf aus der Mitte gibt den Fokus an den Nachfolger an derselben Stelle (Review K5)", async () => {
  const drei = [{ ...ANSAGE_ZWEI, kennung: "kb" }, { ...ANSAGE_EINS, kennung: "ka" }, { ...ANSAGE_EINS, zeit: 500, kennung: "kc" }];
  const lauf = await ansagenLauf("fehlt", drei);
  await lauf.klickeGelesen("ka");
  assert.equal(lauf.fokus(), "gelesen:kc", "nicht der erste (kb), sondern der, der an Stelle 2 rueckt");
});

test("Fokus nach gelesen uebersteht das Echo des Servers: Neuzeichnen nach dem Markieren laesst ihn auf Knopf bzw. Kopf (Review S3)", async () => {
  const drei = [{ ...ANSAGE_ZWEI, kennung: "kb" }, { ...ANSAGE_EINS, kennung: "ka" }, { ...ANSAGE_EINS, zeit: 500, kennung: "kc" }];
  const lauf = await ansagenLauf("fehlt", drei);
  await lauf.klickeGelesen("kb");
  await lauf.echo();
  assert.equal(lauf.fokus(), "gelesen:ka", "nach dem Echo noch auf dem naechsten Knopf, nicht auf body");
  await lauf.klickeGelesen("ka"); // das zweite Enter
  await lauf.echo();
  assert.equal(lauf.fokus(), "gelesen:kc");
  await lauf.klickeGelesen("kc");
  await lauf.echo();
  assert.equal(lauf.fokus(), "inbox", "nach dem letzten der Kopf der Inbox, auch nach dem Echo");
  assert.doesNotMatch(lauf.html(), /an-gelesen-knopf/, "der Server fuehrt alle als gelesen");
  const alle = await ansagenLauf("fehlt", drei);
  await alle.klickeGelesen("kb ka kc");
  await alle.echo();
  assert.equal(alle.fokus(), "inbox", "alle als gelesen: der Kopf, auch nach dem Echo");
});

test("Fokus nach dem Echo bleibt auf dem Knopf gelesen, nicht auf 'alle als gelesen' seiner Gruppe mit derselben Kennung (Review S3)", async () => {
  // Zwei Gruppen; die zweite hat eine Ansage, ihr 'alle als gelesen' traegt also dieselbe Kennung wie ihr Knopf gelesen.
  const lauf = await ansagenLauf("fehlt", [{ ...ANSAGE_ZWEI, kennung: "kb" }, { ...ANSAGE_EINS, repo: "q", kennung: "kq" }]);
  await lauf.klickeGelesen("kb");
  assert.equal(lauf.fokus(), "gelesen:kq");
  await lauf.echo();
  assert.equal(lauf.fokus(), "gelesen:kq", "derselbe Knopf, nicht alle:kq davor");
});

test("Klick: nach dem Stopp spielt dieselbe Zeile wieder sofort, ohne Pause davor", async () => {
  const lauf = await ansagenLauf("fehlt", [ANSAGE_EINS]);
  lauf.klickeAnsage(1000);
  lauf.klickeStopp();
  lauf.klickeAnsage(1000);
  assert.deepEqual(lauf.protokoll(), ["cancel", "speak:r: Eins.", "resume", "cancel", "cancel", "speak:r: Eins."]);
});

test("Abbruch: das Ende der abgebrochenen Ansage setzt die neue nicht zurueck und misst nicht", async () => {
  const lauf = await ansagenLauf("fehlt", [ANSAGE_ZWEI, ANSAGE_EINS]);
  lauf.klickeAnsage(1000);
  const alt = lauf.letzte();
  lauf.jetzt(10_000);
  alt.onstart?.();
  lauf.klickeAnsage(2000); // bricht Eins ab und spricht Zwei
  lauf.jetzt(10_800);
  alt.onend?.(); // der Browser meldet das Ende der abgebrochenen Ansage nach
  lauf.klickeAnsage(2000); // Zwei laeuft noch: anhalten, nicht neu sprechen
  assert.deepEqual(lauf.protokoll().slice(-2), ["speak:r: Zwei.", "pause"]);
  assert.equal(lauf.speicher().has(SCHLUESSEL_ZPS), false);
});

test("Abbruch: das Fehler-Ende der abgebrochenen Ansage (onerror, Chrome: interrupted) setzt die neue nicht zurueck", async () => {
  const lauf = await ansagenLauf("fehlt", [ANSAGE_ZWEI, ANSAGE_EINS]);
  lauf.klickeAnsage(1000);
  const alt = lauf.letzte();
  alt.onstart?.();
  lauf.klickeAnsage(2000); // bricht Eins ab und spricht Zwei
  alt.onerror?.(); // die abgebrochene Ansage meldet ihren Abbruch als Fehler
  lauf.klickeAnsage(2000); // Zwei laeuft noch: anhalten, nicht neu sprechen
  assert.deepEqual(lauf.protokoll().slice(-2), ["speak:r: Zwei.", "pause"]);
  assert.equal(lauf.speicher().has(SCHLUESSEL_ZPS), false);
});

test("Abbruch: ein verspaetet gemeldeter Beginn der abgebrochenen Ansage setzt den Lauf nicht auf sie", async () => {
  const lauf = await ansagenLauf("fehlt", [ANSAGE_ZWEI, ANSAGE_EINS]);
  lauf.klickeAnsage(1000);
  const alt = lauf.letzte();
  lauf.klickeAnsage(2000); // bricht Eins ab, Zwei laeuft
  alt.onstart?.(); // der Browser meldet den Beginn von Eins erst jetzt
  lauf.klickeAnsage(2000); // Zwei haelt an, nicht neu sprechen
  assert.deepEqual(lauf.protokoll().slice(-2), ["speak:r: Zwei.", "pause"]);
});

test("Vorlesen von selbst: die naechste Ansage wartet in der Seite hinter der laufenden, ohne Abbruch, und wird erst mit ihrem Beginn die laufende", async () => {
  const lauf = await ansagenLauf("fehlt", [ANSAGE_EINS]);
  lauf.klick(); // dieser Tab wird Sprecher
  lauf.klickeAnsage(1000); // Eins spricht
  const eins = lauf.letzte();
  eins.onstart?.();
  await lauf.neueAnsage(3000); // Neu kommt automatisch
  assert.deepEqual(lauf.protokoll(), ["cancel", "speak:r: Eins."], "Neu wartet in der Seite, nicht in der Sprachausgabe (#42)");
  lauf.klickeAnsage(1000); // der Knopf ist noch bei Eins: anhalten
  lauf.klickeAnsage(1000); // und fortsetzen
  eins.onend?.(); // Eins ist fertig: jetzt erst geht Neu an die Sprachausgabe
  assert.deepEqual(lauf.protokoll().slice(-1), ["speak:r: Neu"]);
  assert.doesNotMatch(lauf.html(), /an-laeuft/, "vor ihrem Beginn ist Neu noch nicht die laufende");
  lauf.letzte().onstart?.(); // Neu beginnt: ab jetzt ist sie die laufende
  assert.match(lauf.html(), /an-laeuft/);
  lauf.klickeAnsage(3000); // Neu haelt an
  assert.deepEqual(lauf.protokoll().slice(-4), ["pause", "resume", "speak:r: Neu", "pause"]);
});

test("Vorlesen aus stoppt eine laufende Ansage und leert die Warteschlange (stoppen)", async () => {
  const lauf = await ansagenLauf("fehlt", [ANSAGE_EINS]);
  lauf.klick();
  lauf.klickeAnsage(1000);
  lauf.letzte().onstart?.();
  lauf.klickeAuto();
  assert.deepEqual(lauf.protokoll(), ["cancel", "speak:r: Eins.", "resume", "cancel"]);
});

test("Vorlesen aus hebt eine Pause auf, die kein Ende mehr meldet, bevor der Abbruch kommt (Chrome haengt sonst)", async () => {
  const lauf = await ansagenLauf("fehlt", [ANSAGE_EINS]);
  lauf.klick();
  lauf.klickeAnsage(1000);
  lauf.letzte().onstart?.();
  lauf.klickeAnsage(1000); // anhalten
  lauf.letzte().onerror?.(); // der Browser beendet die pausierte Ansage mit einem Fehler; endeLauf hebt die Pause auf, der Abbruch den Rest
  lauf.klickeAuto();
  assert.deepEqual(lauf.protokoll().slice(-3), ["pause", "resume", "cancel"]);
});

test("Fehler-Ende: die laufende Ansage meldet onerror, der Stopp geht, und ein Klick auf die Zeile spielt neu statt zu pausieren", async () => {
  const lauf = await ansagenLauf("fehlt", [ANSAGE_EINS]);
  lauf.klickeAnsage(1000); // Eins spricht
  lauf.letzte().onstart?.();
  assert.equal(lauf.stoppSichtbar(), true, "Eins spricht");
  lauf.letzte().onerror?.(); // der Browser beendet Eins mit einem Fehler
  assert.equal(lauf.stoppSichtbar(), false, "nichts spricht und wartet mehr");
  lauf.klickeAnsage(1000); // dieselbe Zeile: spielt neu, pausiert nicht
  assert.deepEqual(lauf.protokoll(), ["cancel", "speak:r: Eins.", "cancel", "speak:r: Eins."]);
});

test("Fehler-Ende einer wartenden Ansage: sie steht erst nach A in der Sprachausgabe; ihr Fehler vor dem Beginn laesst nichts haengen", async () => {
  const lauf = await ansagenLauf("fehlt", [ANSAGE_EINS]);
  lauf.klick(); // dieser Tab spricht, Neues wird von selbst vorgelesen
  lauf.klickeAnsage(1000); // A spricht
  const a = lauf.letzte();
  a.onstart?.();
  await lauf.neueAnsage(3000); // B wartet hinter A, in der Seite (#42): ein Fehler von B kann A nicht mehr treffen
  assert.equal(lauf.aeusserungen().length, 1, "nur A in der Sprachausgabe");
  lauf.klickeAnsage(1000); // A anhalten: A bleibt die laufende
  assert.deepEqual(lauf.protokoll().slice(-1), ["pause"]);
  lauf.klickeAnsage(1000); // fortsetzen
  a.onend?.(); // A fertig, B geht an die Sprachausgabe
  const b = lauf.letzte();
  assert.notEqual(b, a);
  b.onerror?.(); // B meldet einen Fehler, bevor sie begonnen hat
  assert.equal(lauf.stoppSichtbar(), false, "nichts spricht und wartet mehr");
});

test("Pausiert und mit onerror beendet: endeLauf hebt die Pause auf, damit die naechste Ansage spricht", async () => {
  const lauf = await ansagenLauf("fehlt", [ANSAGE_EINS]);
  lauf.klick(); // dieser Tab spricht, Neues wird von selbst vorgelesen
  lauf.klickeAnsage(1000); // Eins spricht
  lauf.letzte().onstart?.();
  lauf.klickeAnsage(1000); // anhalten
  lauf.letzte().onerror?.(); // der Browser beendet die pausierte Ansage mit einem Fehler
  await lauf.neueAnsage(3000); // Neu kommt von selbst und soll sprechen
  assert.deepEqual(lauf.protokoll(), ["cancel", "speak:r: Eins.", "pause", "resume", "speak:r: Neu"]);
});

test("Stopp: bleibt, solange eine Ansage wartet, auch wenn die laufende endet und die naechste noch nicht begonnen hat", async () => {
  const lauf = await ansagenLauf("fehlt", [ANSAGE_EINS]);
  assert.equal(lauf.stoppSichtbar(), false, "ruhend kein Stopp");
  lauf.klick(); // dieser Tab spricht, Neues wird von selbst vorgelesen
  lauf.klickeAnsage(1000); // A spricht
  const a = lauf.letzte();
  a.onstart?.();
  await lauf.neueAnsage(3000); // B wartet hinter A, in der Seite (#42)
  assert.equal(lauf.stoppSichtbar(), true, "A laeuft, B wartet");
  a.onend?.(); // A ist fertig, B geht an die Sprachausgabe und hat noch keinen Beginn gemeldet
  const b = lauf.letzte();
  assert.notEqual(b, a);
  assert.equal(lauf.stoppSichtbar(), true, "B wartet noch");
  b.onend?.(); // B endet, ohne dass ein Beginn kam
  assert.equal(lauf.stoppSichtbar(), false, "nichts wartet mehr");
});

test("Stopp: das Ende einer abgebrochenen Ansage veraendert den Zaehler der neuen Warteschlange nicht", async () => {
  const lauf = await ansagenLauf("fehlt", [ANSAGE_ZWEI, ANSAGE_EINS]);
  lauf.klick();
  lauf.klickeAnsage(1000); // Eins spricht
  const alt = lauf.letzte();
  lauf.klickeAnsage(2000); // bricht Eins ab, Zwei spricht
  const zwei = lauf.letzte();
  await lauf.neueAnsage(3000); // Neu wartet hinter Zwei, in der Seite (#42)
  alt.onend?.(); // das fremde Ende von Eins zaehlt nicht und gibt Neu nicht frei
  assert.equal(lauf.letzte(), zwei, "das fremde Ende startet nichts");
  assert.equal(lauf.stoppSichtbar(), true, "Zwei spricht, Neu wartet");
  zwei.onend?.(); // Zwei ist fertig, Neu geht an die Sprachausgabe
  const neu = lauf.letzte();
  assert.notEqual(neu, zwei);
  assert.equal(lauf.stoppSichtbar(), true, "Neu wartet noch, obwohl das fremde Ende kam");
  neu.onend?.();
  assert.equal(lauf.stoppSichtbar(), false);
});

test("Stopp: eine Ansage zaehlt hoechstens einmal, auch wenn Ende und Fehler beide kommen", async () => {
  const lauf = await ansagenLauf("fehlt", [ANSAGE_EINS]);
  lauf.klick();
  lauf.klickeAnsage(1000); // A spricht
  const a = lauf.letzte();
  await lauf.neueAnsage(3000); // B wartet
  a.onend?.();
  a.onerror?.(); // dasselbe Ende noch einmal: zaehlt nicht doppelt
  assert.equal(lauf.stoppSichtbar(), true, "B wartet noch");
  lauf.letzte().onend?.();
  assert.equal(lauf.stoppSichtbar(), false);
});

test("Stopp: der Stopp-Knopf leert die Warteschlange; die Ereignisse der abgebrochenen Ansagen danach lassen den Stopp weg", async () => {
  const lauf = await ansagenLauf("fehlt", [ANSAGE_EINS]);
  lauf.klick();
  lauf.klickeAnsage(1000);
  const a = lauf.letzte();
  await lauf.neueAnsage(3000); // B wartet in der Seite (#42)
  lauf.klickeStopp();
  assert.equal(lauf.stoppSichtbar(), false, "nach dem Stopp kein Knopf");
  a.onend?.(); // das alte Ende gibt B nicht mehr frei
  a.onerror?.();
  assert.equal(lauf.stoppSichtbar(), false, "die alten Enden zaehlen nicht");
  assert.equal(lauf.aeusserungen().length, 1, "B kommt nach dem Stopp nicht mehr an die Sprachausgabe");
});

test("Kalibrierung: eine regulaer zu Ende gesprochene Ansage mischt ihre Zeichen je Sekunde gleitend ein (0,7 alt, 0,3 gemessen)", async () => {
  const lauf = await ansagenLauf("fehlt", [ANSAGE_EINS]);
  lauf.klickeAnsage(1000);
  lauf.jetzt(10_000);
  lauf.letzte().onstart?.();
  lauf.jetzt(10_800);
  lauf.letzte().onend?.(); // "r: Eins." sind 8 Zeichen in 0,8 s, also 10 je Sekunde: 0,7 * 14 + 0,3 * 10 = 12,8
  assert.ok(Math.abs(Number(lauf.speicher().get(SCHLUESSEL_ZPS)) - 12.8) < 1e-9);
});

test("Kalibrierung: eine pausierte Ansage misst nicht", async () => {
  const lauf = await ansagenLauf("fehlt", [ANSAGE_EINS]);
  lauf.klickeAnsage(1000);
  lauf.jetzt(10_000);
  lauf.letzte().onstart?.();
  lauf.klickeAnsage(1000); // anhalten
  lauf.klickeAnsage(1000); // fortsetzen
  lauf.jetzt(10_800);
  lauf.letzte().onend?.();
  assert.equal(lauf.speicher().has(SCHLUESSEL_ZPS), false);
});

test("Kalibrierung: Messwerte ausserhalb von 4 bis 40 Zeichen je Sekunde werden verworfen", async () => {
  const lauf = await ansagenLauf("fehlt", [ANSAGE_EINS]);
  lauf.klickeAnsage(1000); // 8 Zeichen in 3 s: 2,7 je Sekunde, zu langsam
  lauf.jetzt(10_000);
  lauf.letzte().onstart?.();
  lauf.jetzt(13_000);
  lauf.letzte().onend?.();
  lauf.klickeAnsage(1000); // 8 Zeichen in 0,1 s: 80 je Sekunde, zu schnell
  lauf.jetzt(20_000);
  lauf.letzte().onstart?.();
  lauf.jetzt(20_100);
  lauf.letzte().onend?.();
  assert.equal(lauf.speicher().has(SCHLUESSEL_ZPS), false);
});

test("Kalibrierung: ein gespeicherter Wert gilt nur innerhalb von 4 bis 40 (die Grenzen selbst zaehlen), sonst die Vorgabe 14", async () => {
  const faelle: Array<[string, number]> = [["2", 14], ["41", 14], ["abc", 14], ["", 14], ["4", 4], ["40", 40]];
  for (const [gespeichert, basis] of faelle) {
    const lauf = await ansagenLauf("fehlt", [ANSAGE_EINS], { [SCHLUESSEL_ZPS]: gespeichert });
    lauf.klickeAnsage(1000);
    lauf.jetzt(10_000);
    lauf.letzte().onstart?.();
    lauf.jetzt(10_800);
    lauf.letzte().onend?.(); // 8 Zeichen in 0,8 s: 10 je Sekunde gemessen
    assert.ok(Math.abs(Number(lauf.speicher().get(SCHLUESSEL_ZPS)) - (0.7 * basis + 0.3 * 10)) < 1e-9, `gespeichert "${gespeichert}"`);
  }
});

// Ein Tab ohne Web Locks lauscht selbst, leitet aber nicht (#18, Runde 3, R1): ohne Sprecher-Tab spricht keiner.
test("Fallback ohne Lock: der zuletzt geklickte Tab spricht die neue Ansage (Gegenprobe)", async () => {
  for (const sperre of ["fehlt", "abgelehnt"] as const) {
    const lauf = await ansagenLauf(sperre);
    lauf.klick();
    assert.notEqual(lauf.sprecher(), null, sperre);
    await lauf.neueAnsage(1000);
    assert.equal(lauf.gesprochen().length, 1, sperre);
  }
});

test("Fallback ohne Lock: ohne Sprecher-Tab spricht kein Tab, auch nicht der freigeschaltete", async () => {
  for (const sperre of ["fehlt", "abgelehnt"] as const) {
    const lauf = await ansagenLauf(sperre);
    lauf.klick();
    lauf.sprecherSchliessen();
    await lauf.neueAnsage(1000);
    assert.deepEqual(lauf.gesprochen(), [], sperre);
  }
});

// Ansagen strikt nacheinander, ein Sprecher ueber alle Tabs (#42): je Tab steht hoechstens ein Teil in der Sprachausgabe,
// der naechste folgt erst auf das Ende des vorigen; gesprochen wird nur unter dem Web Lock live-plan-sprache.
const NEU = (zeit: number, text: string) => ({ v: 1, zeit, id: `n${zeit}`, repo: "r", text, quelle: "test" });

/** Zwei Tabs derselben Welt, beide freigeschaltet; A ist Sprecher (zuletzt geklickt) und Leiter (zuerst geoeffnet). */
async function zweiTabs(sperre: "echt" | "fehlt" = "echt") {
  const w = welt();
  const a = await ansagenLauf(sperre, [], {}, 200, { welt: w, name: "A" });
  const b = await ansagenLauf(sperre, [], {}, 200, { welt: w, name: "B" });
  b.klick();
  a.klick();
  await w.warte();
  return { w, a, b };
}

test("Zwei Tabs: Sprecherwechsel mitten in einer Ansage, zu keinem Zeitpunkt sprechen beide, kein Satz verschraenkt (#42)", async () => {
  const { w, a, b } = await zweiTabs();
  await w.neueAnsagen([ANSAGE_LANG]); // zwei Teile, A spricht
  assert.equal(a.imBrowser(), 1, "A hat genau den ersten Teil in der Sprachausgabe");
  b.klick(); // B wird Sprecher, waehrend A mitten in der Ansage ist
  await w.neueAnsagen([NEU(4000, "Später."), ANSAGE_LANG]);
  assert.equal(b.imBrowser(), 0, "B wartet, bis A fertig ist");
  await w.abspielen();
  assert.deepEqual(w.verstoesse, []);
  const [t1, t2, t3] = w.gesprochen;
  assert.equal(w.gesprochen.length, 3, String(w.gesprochen));
  assert.equal(`${t1} ${t2}`, `r: ${ANSAGE_LANG.text}`, "die Teile der langen Ansage stehen zusammen");
  assert.equal(t3, "r: Später.");
});

test("Drei Ansagen in einem Tab: speak je Teil erst nach dem Ende des vorigen, die Reihenfolge bleibt (#42)", async () => {
  for (const sperre of ["echt", "fehlt"] as const) {
    const w = welt();
    const t = await ansagenLauf(sperre, [], {}, 200, { welt: w });
    t.klick();
    await w.neueAnsagen([ANSAGE_LANG, ANSAGE_ZWEI, ANSAGE_EINS]); // neueste zuerst, wie der Server sie liefert
    for (let i = 0; i < 4; i++) {
      assert.equal(t.imBrowser(), 1, `${sperre}: Schritt ${i}, genau ein Teil in der Sprachausgabe`);
      assert.equal(t.gesprochen().length, i + 1, `${sperre}: Schritt ${i}, der naechste Teil erst nach dem Ende des vorigen`);
      t.beende();
      await w.warte();
    }
    assert.equal(t.imBrowser(), 0, sperre);
    assert.equal(t.hoechstens(), 1, sperre);
    const [eins, zwei, ...lang] = t.gesprochen();
    assert.deepEqual([eins, zwei, lang.join(" ")], ["r: Eins.", "r: Zwei.", `r: ${ANSAGE_LANG.text}`], sperre);
  }
});

test("Zwei Tabs: jede Ansage genau einmal und in ihrer Reihenfolge, auch wenn der Sprecher hin und her wechselt (#42)", async () => {
  const { w, a, b } = await zweiTabs();
  const liste: unknown[] = [];
  const kommt = async (zeit: number) => { liste.unshift(NEU(zeit, `Nummer ${zeit}.`)); await w.neueAnsagen([...liste]); };
  await kommt(1000); // A spricht 1
  b.klick();
  await kommt(2000); // B ist Sprecher, A spricht noch
  await kommt(3000);
  a.klick();
  await kommt(4000); // A wieder Sprecher, haelt noch die Sperre
  await w.abspielen();
  assert.deepEqual(w.gesprochen, ["r: Nummer 1000.", "r: Nummer 2000.", "r: Nummer 3000.", "r: Nummer 4000."]);
  assert.deepEqual(w.verstoesse, []);
  assert.equal(a.imBrowser() + b.imBrowser(), 0);
});

test("Wachhund: meldet der Browser das Ende nicht, geht es nach dem Zeitlimit weiter (Zeichen / 4 je Sekunde, mindestens 10 s) (#42)", async () => {
  const w = welt();
  const t = await ansagenLauf("echt", [], {}, 200, { welt: w });
  t.klick();
  await w.neueAnsagen([ANSAGE_ZWEI, ANSAGE_EINS]);
  t.beginne(); // Eins beginnt und meldet nie ihr Ende
  t.zeitVor(9_999);
  assert.deepEqual(t.gesprochen(), ["r: Eins."], "vor der Untergrenze von 10 s geschieht nichts");
  t.zeitVor(1);
  assert.deepEqual(t.protokoll().slice(-2), ["cancel", "speak:r: Zwei."], "abgebrochen und weiter");
  assert.equal(t.imBrowser(), 1);
  t.beende();
  await w.warte();
  // Ein langer Teil: das Limit waechst mit der Laenge, gerechnet mit dem langsamsten gueltigen Tempo (4 Zeichen je Sekunde).
  await w.neueAnsagen([ANSAGE_LANG, ANSAGE_ZWEI, ANSAGE_EINS]);
  const erster = t.letzte().text, limit = Array.from(erster).length * 250;
  assert.ok(limit > 10_000, String(limit));
  t.beginne();
  t.klickeAnsage(3000); // angehalten: der Wachhund schweigt, solange die Pause dauert
  t.zeitVor(10 * limit);
  assert.equal(t.letzte().text, erster, "die Pause bricht nicht ab");
  t.klickeAnsage(3000); // fortsetzen: das Limit beginnt neu
  t.zeitVor(limit - 1);
  assert.equal(t.letzte().text, erster);
  t.zeitVor(1);
  assert.equal(`${erster} ${t.letzte().text}`, `r: ${ANSAGE_LANG.text}`, "der zweite Teil folgt");
  assert.equal(t.speicher().has(SCHLUESSEL_ZPS), false, "ein Abbruch durch den Wachhund misst nicht");
});

test("Stopp und Pause aus Tab B wirken auf die Ansage, die Tab A spricht (#42)", async () => {
  const { w, a, b } = await zweiTabs();
  await w.neueAnsagen([ANSAGE_EINS]);
  a.beginne();
  await w.warte();
  assert.equal(b.stoppSichtbar(), true, "B zeigt den Stopp, solange A spricht");
  assert.match(b.html() + a.html(), /an-laeuft/);
  b.klickeAnsage(1000); // ⏸ in B haelt A an
  await w.warte();
  assert.deepEqual(a.protokoll().slice(-1), ["pause"]);
  b.klickeAnsage(1000); // ▶ in B setzt A fort
  await w.warte();
  assert.deepEqual(a.protokoll().slice(-1), ["resume"]);
  b.klickeStopp();
  await w.warte();
  assert.deepEqual(a.protokoll().slice(-1), ["cancel"]);
  assert.equal(a.imBrowser(), 0);
  assert.equal(a.stoppSichtbar(), false);
  assert.equal(b.stoppSichtbar(), false);
  await w.neueAnsagen([ANSAGE_ZWEI, ANSAGE_EINS]); // danach spricht A wieder
  assert.deepEqual(a.gesprochen(), ["r: Eins.", "r: Zwei."]);
  assert.deepEqual(w.verstoesse, []);
});

test("Fallback ohne Lock: verliert ein Tab die Sprecherrolle, bricht er seine Warteschlange ab (storage) (#42)", async () => {
  const { w, a, b } = await zweiTabs("fehlt");
  await w.neueAnsagen([ANSAGE_LANG]);
  assert.equal(a.imBrowser(), 1, "A spricht");
  b.klick(); // B wird Sprecher: A erfaehrt es ueber das Ereignis storage
  await w.warte();
  assert.equal(a.imBrowser(), 0, "A hat abgebrochen");
  assert.equal(a.stoppSichtbar(), false);
  await w.neueAnsagen([NEU(4000, "Später."), ANSAGE_LANG]);
  assert.deepEqual(b.gesprochen(), ["r: Später."]);
  assert.deepEqual(w.verstoesse, []);
});

// Review #42: Befunde F1 bis F5 und die Testluecken (Proben T1 bis T4 des Reviewers).
test("Review F4/T1: der Leiter wartet mit seiner neuen Ansage, waehrend ein anderer Tab die Sperre haelt (#42)", async () => {
  const { w, a, b } = await zweiTabs();
  await w.neueAnsagen([ANSAGE_EINS]);
  await w.abspielen();
  b.klick();
  b.klickeAnsage(1000); // B spielt Eins nochmal und haelt die Sperre
  await w.warte();
  assert.equal(b.imBrowser(), 1);
  a.klick(); // A (Leiter) wird Sprecher, B spricht noch
  await w.warte();
  await w.neueAnsagen([NEU(4000, "Vier."), ANSAGE_EINS]);
  assert.equal(a.imBrowser(), 0, "A wartet auf die Sperre");
  await w.abspielen();
  assert.deepEqual(w.gesprochen, ["r: Eins.", "r: Eins.", "r: Vier."]);
  assert.deepEqual(w.verstoesse, []);
});

test("Review F4/T2: ▶ einer anderen Zeile in B, waehrend A spricht: A hoert auf, bevor B beginnt (#42)", async () => {
  const { w, a, b } = await zweiTabs();
  await w.neueAnsagen([ANSAGE_LANG, ANSAGE_EINS]);
  await w.abspielen();
  await w.neueAnsagen([NEU(4000, `Vier. ${LANG_SATZ} ${LANG_SATZ}`), ANSAGE_LANG, ANSAGE_EINS]);
  assert.equal(a.imBrowser(), 1, "A spricht Vier");
  b.klick();
  b.klickeAnsage(1000);
  await w.warte();
  await w.abspielen();
  assert.deepEqual(w.verstoesse, []);
  assert.equal(w.gesprochen.at(-1), "r: Eins.");
});

test("Review F1/T3: fehlt der Sprecher-Schluessel, waehrend ein Nicht-Leiter spricht, geht keine Ansage verloren (#42)", async () => {
  const w = welt();
  const a = await ansagenLauf("echt", [], {}, 200, { welt: w, name: "A" });
  const c = await ansagenLauf("echt", [], {}, 200, { welt: w, name: "C" });
  const d = await ansagenLauf("echt", [], {}, 200, { welt: w, name: "D" });
  d.klick(); c.klick(); a.klick();
  await w.warte();
  await w.neueAnsagen([ANSAGE_LANG]);
  await w.abspielen();
  c.klick(); c.klickeAnsage(3000); // C spricht die lange Ansage nochmal und haelt die Sperre
  await w.warte();
  d.klick(); await w.warte();
  d.sprecherSchliessen(); // D schliesst, der Schluessel ist weg
  await w.warte();
  await w.neueAnsagen([NEU(4000, "Vier."), ANSAGE_LANG]); // nur der Leiter A ist dran und wartet auf die Sperre
  c.klick(); await w.warte(); // der Nutzer kehrt zu C zurueck
  await w.neueAnsagen([NEU(5000, "Fuenf."), NEU(4000, "Vier."), ANSAGE_LANG]);
  await w.abspielen();
  assert.deepEqual(w.gesprochen.filter((t) => /Vier|Fuenf/.test(t)), ["r: Vier.", "r: Fuenf."]);
  assert.deepEqual(w.verstoesse, []);
});

test("Review F2: schliesst der Nutzer den sprechenden Tab, liest ein anderer Tab den ungesprochenen Rest, die laufende von vorn (#42)", async () => {
  const { w, a, b } = await zweiTabs();
  await w.neueAnsagen([ANSAGE_ZWEI, ANSAGE_EINS]); // A spricht Eins, Zwei wartet in A
  a.beginne();
  assert.deepEqual(a.gesprochen(), ["r: Eins."]);
  await a.sterben(); // pagehide, dann ist A weg: Sperre frei, Warteschlange verloren
  await w.abspielen();
  assert.deepEqual(b.gesprochen(), ["r: Eins.", "r: Zwei."]);
  assert.deepEqual(w.verstoesse, []);
  assert.equal(w.speicher.get("live-plan.gesprochen"), "2000", "das Merkmal steht erst nach dem Ende");
});

test("Review F2: das Gesprochen-Merkmal steht erst nach dem Ende einer Ansage, ein Stopp verwirft die wartenden (#42)", async () => {
  const { w, a } = await zweiTabs();
  await w.neueAnsagen([ANSAGE_ZWEI, ANSAGE_EINS]);
  assert.equal(w.speicher.has("live-plan.gesprochen"), false, "Eins spricht noch");
  a.beende();
  await w.warte();
  assert.equal(w.speicher.get("live-plan.gesprochen"), "1000");
  a.klickeStopp(); // Zwei laeuft und wird verworfen: sie gilt als erledigt, kein anderer Tab liest sie nach
  await w.warte();
  assert.equal(w.speicher.get("live-plan.gesprochen"), "2000");
});

test("Review F3/T4: ein Tab meldet Sprechen und verschwindet ohne pagehide: Stopp raeumt die Anzeige, ▶ spielt wieder (#42)", async () => {
  const { w, b } = await zweiTabs();
  await w.neueAnsagen([ANSAGE_EINS]);
  await w.abspielen();
  const geist = new (w.Kanal as new (n: string) => { postMessage: (d: unknown) => void })("live-plan-ansagen");
  geist.postMessage({ art: "zustand", tab: "geist", laeuft: { zeit: 1000, pausiert: false }, wartet: true });
  await w.warte();
  assert.equal(b.stoppSichtbar(), true);
  b.klick();
  b.klickeStopp();
  await w.warte();
  assert.equal(b.stoppSichtbar(), false, "der Stopp raeumt auch den gespiegelten Zustand");
  const vorher = w.gesprochen.length;
  b.klickeAnsage(1000);
  await w.warte();
  await w.abspielen();
  assert.equal(w.gesprochen.length - vorher, 1, "▶ spielt, statt an einen Geist zu senden");
});

test("Review F5: ein Fehler beim Sprechen unter der Sperre ist kein Rueckfall, der Tab spricht weiter nur unter der Sperre (#42)", async () => {
  const w = welt();
  const a = await ansagenLauf("echt", [], {}, 200, { welt: w, name: "A", speakWirft: 0 });
  a.klick();
  await w.neueAnsagen([ANSAGE_EINS]); // speak wirft: Eins gilt als mit Fehler beendet
  assert.deepEqual(a.gesprochen(), []);
  assert.equal(a.stoppSichtbar(), false, "nichts haengt");
  const zaehle = () => w.anforderungen.filter((x) => x === "A:live-plan-sprache").length;
  const vorher = zaehle();
  await w.neueAnsagen([ANSAGE_ZWEI, ANSAGE_EINS]);
  assert.equal(zaehle(), vorher + 1, "Zwei spricht wieder unter der Sperre");
  assert.deepEqual(a.gesprochen(), ["r: Zwei."]);
});

test("Review F5: scheitert die Anforderung ohne Verweigern (AbortError), bleibt es bei der Sperre; die naechste Ansage holt sie (#42)", async () => {
  const w = welt();
  const a = await ansagenLauf("echt", [], {}, 200, { welt: w, name: "A" });
  const b = await ansagenLauf("echt", [], {}, 200, { welt: w, name: "B" });
  b.klick();
  a.klick();
  await w.warte();
  w.einmalAbbrechen.add("A:live-plan-sprache");
  await w.neueAnsagen([ANSAGE_EINS]); // die Anforderung scheitert, A spricht nicht ohne Sperre
  assert.equal(a.imBrowser(), 0);
  b.klick();
  b.klickeAnsage(1000); // B haelt jetzt die Sperre und spricht
  await w.warte();
  a.klick();
  await w.neueAnsagen([ANSAGE_ZWEI, ANSAGE_EINS]); // A fordert neu an und wartet auf B
  assert.equal(a.imBrowser(), 0, "A wartet auf die Sperre");
  await w.abspielen();
  assert.deepEqual(w.verstoesse, []);
  // Der Halter B nimmt Zwei mit (nimmNeue); A spricht nicht ohne Sperre daneben, sondern hat sie neu angefordert.
  assert.deepEqual(w.gesprochen, ["r: Eins.", "r: Zwei."]);
  assert.equal(w.anforderungen.filter((x) => x === "A:live-plan-sprache").length, 2);
});

test("Review: beginnt ein Teil, waehrend die Ansage angehalten ist, schweigt der Wachhund bis zum Fortsetzen (#42)", async () => {
  const w = welt();
  const t = await ansagenLauf("echt", [], {}, 200, { welt: w });
  t.klick();
  await w.neueAnsagen([ANSAGE_LANG]);
  const eins = t.letzte();
  eins.onstart?.();
  t.klickeAnsage(3000); // anhalten
  eins.onerror?.(); // der Browser beendet den angehaltenen ersten Teil mit einem Fehler: der zweite geht an die Sprachausgabe
  const zwei = t.letzte();
  assert.notEqual(zwei, eins);
  const limit = Array.from(zwei.text).length * 250;
  t.zeitVor(10 * Math.max(limit, 10_000));
  assert.equal(t.protokoll().filter((x) => x === "cancel").length, 0, "kein Abbruch waehrend der Pause");
  t.klickeAnsage(3000); // fortsetzen: jetzt laeuft das Limit
  t.zeitVor(Math.max(limit, 10_000));
  assert.deepEqual(t.protokoll().slice(-1), ["cancel"]);
});

test("Review F2: stuerzt der sprechende Tab ohne pagehide ab, kommt sein Rest mit der naechsten neuen Ansage (#42)", async () => {
  const { w, a, b } = await zweiTabs();
  await w.neueAnsagen([ANSAGE_ZWEI, ANSAGE_EINS]);
  a.beginne();
  await a.sterben(false); // kein pagehide: niemand erfaehrt es, die Sperre ist nur frei
  assert.deepEqual(b.gesprochen(), [], "bis zur naechsten Ansage bleibt es still");
  b.klick();
  await w.neueAnsagen([NEU(4000, "Vier."), ANSAGE_ZWEI, ANSAGE_EINS]);
  await w.abspielen();
  assert.deepEqual(b.gesprochen(), ["r: Eins.", "r: Zwei.", "r: Vier."]);
  assert.deepEqual(w.verstoesse, []);
});
