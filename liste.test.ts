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
  ansageDauer: (a: unknown, zps?: number) => number;
  dauerText: (s: number) => string;
  ansageZelle: (a: unknown, laeuft?: unknown, zps?: number) => string;
  letzteAnsagen: (liste: unknown) => Record<string, { zeit: number }>;
  einstellungenMenue: (z: unknown) => string;
  ansageLeiste: (z: unknown) => string;
  sollSprechen: (z: unknown) => boolean;
  stimmenListe: (stimmen: unknown) => { name: string; lang: string }[];
  stimmeWahl: (stimmen: unknown, name: unknown) => { name: string } | null;
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
const ANSAGE = (min: number, extra: Record<string, unknown> = {}) => ({ v: 1, zeit: JETZT - min * 60_000, id: "s-1", repo: "live-plan", text: `Ansage vor ${min} Minuten.`, quelle: "auto", ...extra });
const MENUE = { kann: true, vorlesen: true, frei: true, stimmen: [], stimme: null, auf: true, letzte: true, fehler: "" };
const STIMMEN = [{ name: "Daniel", lang: "en-GB" }, { name: "Petra", lang: "de-DE" }, { name: "Anna", lang: "de-AT" }, { name: "Petra", lang: "de-DE" }];

test("ansageSprechtext: erst das Repo, dann der Text", () => {
  const { ansageSprechtext } = ansicht();
  assert.equal(ansageSprechtext({ repo: "firstmate", text: "Der PR ist offen." }), "firstmate: Der PR ist offen.");
  assert.equal(ansageSprechtext({ repo: "", text: "Der PR ist offen." }), "Der PR ist offen.");
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
  assert.match(html, /<span class="an-uhr mono"[^>]*>15:25<\/span> <span class="an-dauer">\(≈ 3 s\)<\/span><\/td>$/);
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
  assert.match(html, /<h2>Ansagen<\/h2>/);
  assert.match(html, /<p class="an-leer">Noch keine Ansage\.<\/p>/);
  assert.doesNotMatch(html, /<li/);
  assert.match(html, /data-einst-auf aria-expanded="false"/);
  assert.match(html, /an-hinweis">Ein Klick auf die Seite schaltet den Ton frei\./);
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
  assert.match(a.ansageZelle(x), /<span class="an-uhr mono"[^>]*>15:25<\/span> <span class="an-dauer">\(≈ 3 s\)<\/span><\/td>$/);
  assert.match(a.ansageZelle(x, null, 7), /<span class="an-dauer">\(≈ 5 s\)<\/span><\/td>$/);
});

test("ansageLeiste: hinter der Uhrzeit die geschaetzte Dauer in Klammern, mit dem zps der Leiste", () => {
  const a = ansicht();
  a.setzeJetzt(JETZT);
  const x = ANSAGE(5, { repo: "firstmate", text: 'Fertig, "PR" <offen>.' });
  assert.match(a.ansageLeiste(LEISTE([x])), /<span class="an-zeit"><span class="an-uhr mono">15:25<\/span> <span class="an-dauer">\(≈ 3 s\)<\/span><\/span><a class="an-repo"/);
  assert.match(a.ansageLeiste(LEISTE([x], { zps: 7 })), /<span class="an-dauer">\(≈ 5 s\)<\/span>/);
});

test("ansageLeiste: vier Zellen je Zeile (Knopf, Zeit mit Dauer, Repo, Text), damit das Raster auf 390 px passt", () => {
  const a = ansicht();
  a.setzeJetzt(JETZT);
  const html = a.ansageLeiste(LEISTE([ANSAGE(5, { repo: "Muster-Werkstatt-Archiv1", text: "Kurz." })]));
  assert.match(html, /<li class="an-zeile"><button [^>]*>▶<\/button><span class="an-zeit"><span class="an-uhr mono">15:25<\/span> <span class="an-dauer">\(≈ \d+ s\)<\/span><\/span><a class="an-repo" href="\/Muster-Werkstatt-Archiv1\/s-1" title="Muster-Werkstatt-Archiv1">Muster-Werkstatt-Archiv1<\/a><button type="button" class="an-text" data-ansage-text="\d+" aria-expanded="false"><span>Kurz\.<\/span><\/button><\/li>/);
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
interface Aeusserung { text: string; onstart?: () => void; onend?: () => void; onerror?: () => void }

/** Ein Klick-Ereignis wie vom Browser: ein Ziel, das `closest` fuer die Ansage-Auswahl kennt, mit den Attributen `attrs` (setAttribute schreibt hinein). */
const ereignis = (attrs: Record<string, string>) => ({
  target: { closest: (sel: string) => (sel.includes("data-ansage") ? { hasAttribute: (n: string) => n in attrs, getAttribute: (n: string) => attrs[n] ?? null, setAttribute: (n: string, v: unknown) => { attrs[n] = String(v); } } : null) },
});

/**
 * Startet die Uebersicht mit Attrappen fuer Sprachausgabe, Ereignisquelle, Speicher und Web Locks. `sperre` ist "fehlt"
 * (kein navigator.locks, der Fallback) oder "abgelehnt" (der Lock wird verweigert, der .catch-Zweig greift).
 * `startAnsagen` steht schon beim ersten Laden da (ohne Neuigkeit, also ohne Vorlesen); `vorher` ist der Speicher vor dem Start.
 */
async function ansagenLauf(sperre: "fehlt" | "abgelehnt", startAnsagen: unknown[] = [], vorher: Record<string, string> = {}) {
  const gesprochen: string[] = [];
  const protokoll: string[] = [];
  const aeusserungen: Aeusserung[] = [];
  const klicks: Array<(e: unknown) => void> = [];
  const wurzelKlicks: Array<(e: unknown) => void> = [];
  const quellen: Array<Record<string, () => void>> = [];
  const speicher = new Map<string, string>(Object.entries(vorher));
  let ansagen: unknown[] = startAnsagen;
  let pausiert = false;
  // Ein Stueck DOM fuer die zwei Knoten, die der Stopp-Zustand einfuegt und entfernt: das Menue (⚙) und der Stopp daneben.
  // innerHTML setzt, was im Markup steht; einfuegen und entfernen wirken auf denselben Zustand.
  let wurzelHtml = "", menueDa = false, stoppDa = false;
  const stoppKnoten = { remove: () => { stoppDa = false; }, focus: () => {} };
  const menueKnoten = { focus: () => {}, insertAdjacentHTML: (_lage: string, html: string) => { if (html.includes("data-ansage-stopp")) stoppDa = true; } };
  const wurzel = {
    get innerHTML() { return wurzelHtml; },
    set innerHTML(html: string) { wurzelHtml = html; menueDa = html.includes("data-einst-auf"); stoppDa = html.includes("data-ansage-stopp"); },
    querySelector: (sel: string) => (sel === "[data-ansage-stopp]" && stoppDa ? stoppKnoten : sel === "[data-einst-auf]" && menueDa ? menueKnoten : null),
    querySelectorAll: () => [], contains: () => false,
    addEventListener: (typ: string, f: (e: unknown) => void) => { if (typ === "click") wurzelKlicks.push(f); },
  };
  const doc = {
    getElementById: () => wurzel, documentElement: { dataset: {} }, visibilityState: "visible", activeElement: null, title: "",
    addEventListener: (typ: string, f: (e: unknown) => void) => { if (typ === "click") klicks.push(f); },
    removeEventListener: () => {}, querySelector: () => null, querySelectorAll: () => [],
  };
  const antwort = (b: unknown, ok = true) => ({ ok, status: ok ? 200 : 404, json: async () => b });
  const g: Record<string, unknown> = {
    document: doc,
    location: { pathname: "/", search: "" },
    localStorage: {
      getItem: (k: string) => speicher.get(k) ?? null,
      setItem: (k: string, v: string) => { speicher.set(k, String(v)); },
      removeItem: (k: string) => { speicher.delete(k); },
    },
    speechSynthesis: {
      speak: (u: Aeusserung) => {
        gesprochen.push(u.text);
        if (u.text === "") return; // die Freischaltung spricht stumm und bleibt im Protokoll außen vor
        protokoll.push("speak:" + u.text);
        aeusserungen.push(u);
      },
      get paused() { return pausiert; },
      cancel: () => { protokoll.push("cancel"); },
      pause: () => { protokoll.push("pause"); pausiert = true; },
      resume: () => { protokoll.push("resume"); pausiert = false; },
      getVoices: () => [],
    },
    SpeechSynthesisUtterance: class { text: string; volume = 1; constructor(t: string) { this.text = t; } },
    EventSource: function () {
      const hoert: Record<string, () => void> = {};
      quellen.push(hoert);
      return { addEventListener: (typ: string, f: () => void) => { hoert[typ] = f; }, close: () => {} };
    },
    navigator: sperre === "fehlt" ? {} : { locks: { request: () => Promise.reject(new Error("verweigert")) } },
    BroadcastChannel: class { onmessage: unknown = null; postMessage() {} },
    setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1,
    addEventListener: () => {},
    fetch: async (url: string) => {
      if (url === "/api/ansagen") return antwort({ ansagen });
      if (url === "/api/einstellungen") return antwort({ vorlesen: true, stimme: null });
      if (url === "/api/liste") return antwort({ wurzel: "/w", sitzungen: [] });
      return antwort(null, false);
    },
  };
  g.globalThis = g;
  vm.runInNewContext(readFileSync(path.join(import.meta.dirname, "ansicht", "live-plan.js"), "utf8"), g);
  const warte = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
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
    /** Ob der Stopp-Knopf im Markup steht. */
    stoppSichtbar: () => stoppDa,
    /** Die zuletzt gesprochene Aeusserung; ihre Ereignisse loest der Test selbst aus, wie der Browser es tut. */
    letzte: (): Aeusserung => aeusserungen[aeusserungen.length - 1]!,
    /** Die Uhr der Ansicht festsetzen (ms), damit eine Messung der Dauer deterministisch ist. */
    jetzt: (ms: number) => (g.LivePlanAnsicht as Ansicht).setzeJetzt(ms),
    speicher: () => speicher,
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

test("Vorlesen von selbst: die naechste Ansage wartet hinter der laufenden, ohne Abbruch, und wird erst mit ihrem Beginn die laufende", async () => {
  const lauf = await ansagenLauf("fehlt", [ANSAGE_EINS]);
  lauf.klick(); // dieser Tab wird Sprecher
  lauf.klickeAnsage(1000); // Eins spricht
  lauf.letzte().onstart?.();
  await lauf.neueAnsage(3000); // Neu kommt automatisch
  const neu = lauf.letzte();
  assert.deepEqual(lauf.protokoll(), ["cancel", "speak:r: Eins.", "speak:r: Neu"]);
  lauf.klickeAnsage(1000); // der Knopf ist noch bei Eins: anhalten
  lauf.klickeAnsage(1000); // und fortsetzen
  neu.onstart?.(); // Neu beginnt: ab jetzt ist sie die laufende
  lauf.klickeAnsage(3000); // Neu haelt an
  assert.deepEqual(lauf.protokoll().slice(-3), ["pause", "resume", "pause"]);
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

test("Fehler-Ende einer wartenden Ansage: die laufende bleibt laufend, ein Klick auf sie pausiert weiter", async () => {
  const lauf = await ansagenLauf("fehlt", [ANSAGE_EINS]);
  lauf.klick(); // dieser Tab spricht, Neues wird von selbst vorgelesen
  lauf.klickeAnsage(1000); // A spricht
  lauf.letzte().onstart?.();
  await lauf.neueAnsage(3000); // B wartet hinter A
  lauf.letzte().onerror?.(); // B meldet einen Fehler, bevor sie begonnen hat
  assert.equal(lauf.stoppSichtbar(), true, "A spricht noch");
  lauf.klickeAnsage(1000); // A anhalten
  assert.deepEqual(lauf.protokoll().slice(-1), ["pause"]);
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
  await lauf.neueAnsage(3000); // B wartet hinter A
  const b = lauf.letzte();
  assert.equal(lauf.stoppSichtbar(), true, "A laeuft, B wartet");
  a.onend?.(); // A ist fertig, B hat noch keinen Beginn gemeldet
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
  await lauf.neueAnsage(3000); // Neu wartet hinter Zwei
  const neu = lauf.letzte();
  alt.onend?.(); // das fremde Ende von Eins zaehlt nicht
  assert.equal(lauf.stoppSichtbar(), true, "Zwei spricht, Neu wartet");
  zwei.onend?.(); // Zwei ist fertig, Neu wartet noch
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
  await lauf.neueAnsage(3000);
  const b = lauf.letzte();
  lauf.klickeStopp();
  assert.equal(lauf.stoppSichtbar(), false, "nach dem Stopp kein Knopf");
  a.onend?.();
  b.onend?.();
  assert.equal(lauf.stoppSichtbar(), false, "die alten Enden zaehlen nicht");
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
