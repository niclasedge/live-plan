// flotte: Tests der Flottenansicht im Abschnitt Firstmate, `node --test flotte.test.ts`.
// Nur erfundene Daten in einem Wegwerf-Home unter /tmp; nie das echte Home.
//
//   Gruppierung nach Repo, Zeitstrahl in Prozent, Schaetzung, Zuordnung der Sitzungsregister,
//   Markdown ohne rohes HTML (ansicht/live-plan.js), Pfadpruefung der Detail-Abfrage (firstmate.ts)
//   und derselbe Endpunkt gegen einen echten Server.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import vm from "node:vm";
import { abschnittAus, aufgabeDetail, balken, flotte, gueltigeAufgabenId, medianMinuten, prozent, schaetzungBis, sitzungZuordnen } from "./firstmate.ts";

const JETZT = 1_800_000_000;
const MIN = 60;

// --- reine Rechnung -----------------------------------------------------------------------

test("prozent: lineare Lage im Zeitfenster, ausserhalb auf 0 und 100 geklemmt", () => {
  assert.equal(prozent(1000, 1000, 2000), 0);
  assert.equal(prozent(1500, 1000, 2000), 50);
  assert.equal(prozent(2000, 1000, 2000), 100);
  assert.equal(prozent(900, 1000, 2000), 0);
  assert.equal(prozent(3000, 1000, 2000), 100);
  assert.equal(prozent(5, 10, 10), 0, "leeres Fenster teilt nicht durch null");
});

test("balken: Anfang und Breite; ein kurzer Auftrag bleibt sichtbar, der Balken ragt nie ueber den Rand", () => {
  assert.deepEqual(balken(1250, 1750, 1000, 2000), { von: 25, breit: 50 });
  const kurz = balken(1500, 1500, 1000, 2000);
  assert.equal(kurz.von, 50);
  assert.ok(kurz.breit >= 0.6, "Mindestbreite");
  const rand = balken(1999, 1999, 1000, 2000);
  assert.ok(rand.von + rand.breit <= 100 + 1e-9, "nicht ueber den rechten Rand");
});

test("medianMinuten: Median auf ganze Minuten, ohne Werte null", () => {
  assert.equal(medianMinuten([]), null);
  assert.equal(medianMinuten([40]), 40);
  assert.equal(medianMinuten([60, 45]), 53, "gerade Zahl: Mittel der beiden, gerundet");
  assert.equal(medianMinuten([10, 90, 30]), 30);
});

test("schaetzungBis: bis zum Median ab Start, mindestens 5 Minuten ab jetzt, ohne Median keine Schaetzung", () => {
  assert.equal(schaetzungBis(JETZT - 20 * MIN, JETZT, 53), JETZT + 33 * MIN);
  assert.equal(schaetzungBis(JETZT - 60 * MIN, JETZT, 53), JETZT + 5 * MIN, "schon laenger als der Median");
  assert.equal(schaetzungBis(JETZT - 20 * MIN, JETZT, null), null);
});

test("gueltigeAufgabenId: nur [A-Za-z0-9._-]+, nie nur Punkte", () => {
  for (const id of ["fs-153", "live-plan.flotte_2", "A1"]) assert.equal(gueltigeAufgabenId(id), true, id);
  for (const id of ["", ".", "..", "...", "a/b", "../x", "a b", "a\\b", "a\u0000b", "ä", "a%2fb", "a\n"]) assert.equal(gueltigeAufgabenId(id), false, JSON.stringify(id));
});

test("abschnittAus: Inhalt unter `## Name` bis zur naechsten Ueberschrift der Ebene 1 oder 2", () => {
  const brief = "# Task\n## Captain's intent\n\"mach es\"\n\nZweiter Absatz\n## Firstmate spec\nBauen.\n- a\n# Setup\nnichts\n";
  assert.equal(abschnittAus(brief, "Captain's intent"), '"mach es"\n\nZweiter Absatz');
  assert.equal(abschnittAus(brief, "Firstmate spec"), "Bauen.\n- a");
  assert.equal(abschnittAus(brief, "Gibt es nicht"), null);
  assert.equal(abschnittAus("", "x"), null);
});

test("sitzungZuordnen: Register mit Start bis 240 s nach dem Auftrag, das frueheste, jedes nur einmal, nur Treehouse-Worktrees", () => {
  const reg = (id: string, gestartet: number, cwd = "/home/x/.treehouse/p-1/1/p") => ({ id, cwd, gestartet: gestartet * 1000 });
  const regs = [reg("fern", JETZT - 1000), reg("spaet", JETZT + 300), reg("a", JETZT + 100), reg("b", JETZT + 20), reg("kein-worktree", JETZT + 5, "/home/x/git/p")];
  const benutzt = new Set<string>();
  assert.equal(sitzungZuordnen(regs as never, JETZT, benutzt)?.id, "b");
  assert.equal(sitzungZuordnen(regs as never, JETZT, benutzt)?.id, "a", "b ist vergeben");
  assert.equal(sitzungZuordnen(regs as never, JETZT, benutzt), null);
  assert.equal(sitzungZuordnen(regs as never, JETZT - 5000, new Set()), null);
});

// --- flotte() gegen ein erfundenes Home ----------------------------------------------------

function setzeZeit(datei: string, sek: number) {
  utimesSync(datei, sek, sek);
}

/** Ein Home mit zwei Repos, Registereintraegen und alten Daten. */
function bauHome(): { home: string; register: string } {
  const home = mkdtempSync(path.join(os.tmpdir(), "flotte-home-"));
  const register = mkdtempSync(path.join(os.tmpdir(), "flotte-reg-"));
  for (const d of ["bin", "state", "data"]) mkdirSync(path.join(home, d), { recursive: true });
  writeFileSync(path.join(home, "bin", "fm-spawn.sh"), "#!/bin/sh\n");
  const aufgabe = (id: string, start: number, extra: Record<string, string> = {}, bis?: number) => {
    const ordner = path.join(home, "data", id);
    mkdirSync(ordner, { recursive: true });
    for (const [name, text] of Object.entries(extra)) writeFileSync(path.join(ordner, name), text);
    writeFileSync(path.join(ordner, "launch-brief.md"), "# Launch\n");
    setzeZeit(path.join(ordner, "launch-brief.md"), start);
    if (bis) for (const name of Object.keys(extra)) setzeZeit(path.join(ordner, name), bis);
  };
  writeFileSync(
    path.join(home, "data", "backlog.md"),
    [
      "# Backlog",
      "## In flight",
      "- [ ] a-live - alpha: laufende Umsetzung (repo: alpha) (kind: ship)",
      "## Queued",
      "## Done",
      "- [x] a-ship-1 - alpha: erste Umsetzung https://github.com/o/alpha/pull/11 (repo: alpha) (kind: ship) (merged 2027-01-15)",
      "- [x] a-ship-2 - alpha: zweite Umsetzung https://github.com/o/alpha/pull/12 blocked-by: a-ship-1 (repo: alpha) (kind: ship) (merged 2027-01-15)",
      "- [x] a-scout-1 - alpha: Analyse (repo: alpha) (kind: scout) (reported 2027-01-15)",
      "- [x] alt-1 - alpha: uralt (repo: alpha) (kind: ship) (merged 2027-01-11)",
      "- [x] cap-1 - Captain-Notiz (repo: alpha) (kind: captain) (done 2027-01-15)",
      "",
    ].join("\n"),
  );
  writeFileSync(path.join(home, "data", "done-archive.md"), "## Archived 2027-01-14\n- [x] a-arch - alpha: archiviert (repo: beta) (kind: ship) (merged 2027-01-15)\n");
  aufgabe("a-ship-1", JETZT - 180 * MIN, { "brief.md": "# Task\n## Captain's intent\nA\n", "report.md": "# Bericht\nok\n" });
  aufgabe("a-ship-2", JETZT - 120 * MIN, { "brief.md": "# Task\n" });
  aufgabe("a-scout-1", JETZT - 100 * MIN, { "brief.md": "# Task\n", "report.md": "# Bericht\n" }, JETZT - 90 * MIN);
  aufgabe("alt-1", JETZT - 3 * 86400, { "brief.md": "# Task\n" });
  aufgabe("cap-1", JETZT - 50 * MIN, { "brief.md": "# Task\n" });
  aufgabe("a-arch", JETZT - 30 * MIN, { "brief.md": "# Task\n" }, JETZT - 10 * MIN);
  // laufende Aufgaben: state/<id>.meta und .status, kein launch-brief noetig fuer a-live
  const live = (id: string, projekt: string, startEpoch: number, status: string[]) => {
    writeFileSync(path.join(home, "state", `${id}.meta`), `project=/h/projects/${projekt}\nkind=ship\nmodel=default\neffort=high\nspawn_gen=s${startEpoch}.123.456\n`);
    writeFileSync(path.join(home, "state", `${id}.status`), status.join("\n") + "\n");
  };
  live("a-live", "alpha", JETZT - 20 * MIN, [`working [at=${JETZT - 19 * MIN}]: Setup`, `working [at=${JETZT - 5 * MIN}]: baut`]);
  live("b-live", "beta", JETZT - 40 * MIN, [`working [at=${JETZT - 39 * MIN}]: Setup`, `blocked [at=${JETZT - 10 * MIN}] [key=k1]: wartet`]);
  // Sitzungsregister: a-ship-1 (60 min), a-ship-2 (45 min), a-live (laufend, 1,25 $)
  const eintrag = (id: string, start: number, ende: number | null, kosten: number, zuege: number, cwd = "/home/x/.treehouse/alpha-1/1/alpha") =>
    writeFileSync(path.join(register, `${id}.json`), JSON.stringify({ v: 1, id, cwd, modell: "claude-test-1", gestartet: (start + 30) * 1000, ...(ende ? { beendet: ende * 1000 } : {}), haupt: { kostenUsd: kosten, zuege } }));
  eintrag("r1", JETZT - 180 * MIN, JETZT - 120 * MIN, 3.5, 40);
  eintrag("r2", JETZT - 120 * MIN, JETZT - 75 * MIN, 2, 30);
  eintrag("r3", JETZT - 20 * MIN, null, 1.25, 12);
  writeFileSync(path.join(register, "kaputt.json"), "{nicht json");
  return { home, register };
}

const heimat = bauHome();
after(() => {
  rmSync(heimat.home, { recursive: true, force: true });
  rmSync(heimat.register, { recursive: true, force: true });
});

const sicht = () => flotte(heimat.home, { register: heimat.register, jetzt: JETZT, seit: JETZT - 86400 });

test("flotte: gruppiert nach Repo-Tag des Backlogs, sonst Meta project=; Captain und alte Aufgaben fehlen", () => {
  const f = sicht();
  const repos = Object.fromEntries(f.repos.map((r) => [r.repo, r.aufgaben.map((a) => a.id).sort()]));
  assert.deepEqual(repos, {
    alpha: ["a-live", "a-scout-1", "a-ship-1", "a-ship-2"],
    beta: ["a-arch", "b-live"],
  });
  assert.equal(f.repos.some((r) => r.aufgaben.some((a) => a.id === "alt-1" || a.id === "cap-1")), false);
});

test("flotte: Start, Ende und Dauer; Ende aus dem Register, sonst letzte Aenderung in data/<id>/", () => {
  const a = Object.fromEntries(sicht().repos.flatMap((r) => r.aufgaben).map((x) => [x.id, x]));
  assert.equal(a["a-ship-1"].start, JETZT - 180 * MIN);
  assert.equal(a["a-ship-1"].ende, JETZT - 120 * MIN, "Ende laut Register");
  assert.equal(a["a-ship-1"].minuten, 60);
  assert.equal(a["a-ship-2"].minuten, 45);
  assert.equal(a["a-scout-1"].ende, JETZT - 90 * MIN, "ohne Register die letzte Aenderung");
  assert.equal(a["a-scout-1"].minuten, 10);
  assert.equal(a["a-live"].ende, null, "laeuft");
  assert.equal(a["a-live"].start, JETZT - 20 * MIN, "Start aus spawn_gen");
  assert.equal(a["a-live"].minuten, 20);
});

test("flotte: Zustand, PR, Ausgang, Art, Kosten und Modell aus Backlog und Register", () => {
  const a = Object.fromEntries(sicht().repos.flatMap((r) => r.aufgaben).map((x) => [x.id, x]));
  assert.equal(a["a-ship-1"].zustand, "fertig");
  assert.equal(a["a-ship-1"].ausgang, "merged");
  assert.equal(a["a-ship-1"].pr, "https://github.com/o/alpha/pull/11");
  assert.equal(a["a-ship-1"].kosten, 3.5);
  assert.equal(a["a-ship-1"].zuege, 40);
  assert.equal(a["a-ship-1"].modell, "claude-test-1");
  assert.equal(a["a-ship-1"].titel, "alpha: erste Umsetzung", "ohne PR-Adresse und blocked-by");
  assert.equal(a["a-scout-1"].kind, "scout");
  assert.equal(a["a-scout-1"].ausgang, "reported");
  assert.equal(a["a-scout-1"].kosten, null, "ohne Register fehlt es, es wird nichts erfunden");
  assert.equal(a["a-live"].zustand, "lauf");
  assert.equal(a["a-live"].kosten, 1.25);
  assert.equal(a["a-live"].effort, "high");
  assert.equal(a["a-live"].modell, "claude-test-1", "Meta model=default zaehlt nicht, das Register nennt das Modell");
  assert.equal(a["b-live"].zustand, "stopp", "offener Blocker heisst angehalten");
  assert.equal(a["b-live"].zustandText, "blockiert");
  assert.equal(a["a-arch"].ausgang, "merged", "auch aus done-archive.md");
});

test("flotte: Zeitleiste nur fuer Aufgaben mit state/<id>.status, die uebrigen sind abgeraeumt", () => {
  const a = Object.fromEntries(sicht().repos.flatMap((r) => r.aufgaben).map((x) => [x.id, x]));
  assert.equal(a["a-live"].zeitleiste, true);
  assert.equal(a["a-ship-1"].zeitleiste, false);
});

test("flotte: Schaetzung nur fuer laufende (nicht angehaltene) Aufgaben, aus dem Median der fertigen Umsetzungen des Repos", () => {
  const f = sicht();
  const alpha = f.repos.find((r) => r.repo === "alpha")!;
  assert.equal(alpha.median, 53, "Median aus 60 und 45 min, der Scout zaehlt nicht");
  const live = alpha.aufgaben.find((x) => x.id === "a-live")!;
  assert.deepEqual(live.schaetzung && { bis: live.schaetzung.bis, minuten: live.schaetzung.minuten }, { bis: JETZT + 33 * MIN, minuten: 33 });
  assert.equal(alpha.aufgaben.find((x) => x.id === "a-ship-1")!.schaetzung, null);
  const beta = f.repos.find((r) => r.repo === "beta")!;
  assert.equal(beta.median, 20, "a-arch: 20 min, Ende aus der letzten Aenderung");
  assert.equal(beta.aufgaben.find((x) => x.id === "b-live")!.schaetzung, null, "angehalten: keine Schaetzung");
});

test("flotte: Zeitfenster und Lage in Prozent; jetzt liegt im Fenster, die Schaetzung auch", () => {
  const f = sicht();
  assert.ok(f.t0 <= JETZT - 180 * MIN, "Fenster beginnt vor dem ersten Start");
  assert.ok(f.t1 >= JETZT + 33 * MIN, "Fenster reicht ueber die Schaetzung");
  assert.equal(f.jetzt, JETZT);
  assert.equal(f.jetztProzent, prozent(JETZT, f.t0, f.t1));
  for (const r of f.repos) for (const a of r.aufgaben) {
    assert.ok(a.von >= 0 && a.von + a.breit <= 100 + 1e-9, `${a.id} liegt im Fenster`);
    assert.equal(a.von, prozent(a.start, f.t0, f.t1));
  }
  const live = f.repos[0].aufgaben.concat(f.repos[1].aufgaben).find((x) => x.id === "a-live")!;
  assert.ok(live.schaetzung && live.schaetzung.von >= live.von && live.schaetzung.von + live.schaetzung.breit <= 100 + 1e-9);
  assert.ok(f.achse.length >= 2 && f.achse.every((m) => m.prozent >= 0 && m.prozent <= 100));
});

test("flotte: Repos sortiert nach der ersten Aufgabe; Kennzahlen je Repo", () => {
  const f = sicht();
  assert.deepEqual(f.repos.map((r) => r.repo), ["alpha", "beta"]);
  const alpha = f.repos[0];
  assert.equal(alpha.gemergt, 2);
  assert.deepEqual(alpha.laeuft, ["a-live"]);
});

test("flotte: ohne Register und ohne Backlog bleibt es lesbar, nichts wird erfunden", () => {
  const leer = mkdtempSync(path.join(os.tmpdir(), "flotte-leer-"));
  try {
    for (const d of ["bin", "state", "data"]) mkdirSync(path.join(leer, d));
    writeFileSync(path.join(leer, "bin", "fm-spawn.sh"), "");
    const f = flotte(leer, { register: path.join(leer, "gibt-es-nicht"), jetzt: JETZT, seit: JETZT - 86400 });
    assert.deepEqual(f.repos, []);
    assert.ok(f.t1 > f.t0);
  } finally {
    rmSync(leer, { recursive: true, force: true });
  }
});

// --- Detail einer Aufgabe: Pfadpruefung ------------------------------------------------------

test("aufgabeDetail: Anweisungen, Bericht, Zeitleiste und Dateiliste aus data/<id>/", () => {
  const d = aufgabeDetail(heimat.home, "a-ship-1")!;
  assert.equal(d.id, "a-ship-1");
  assert.equal(d.intent, "A");
  assert.match(d.brief ?? "", /^# Task/);
  assert.match(d.bericht ?? "", /^# Bericht/);
  assert.equal(d.berichtGekuerzt, false);
  assert.equal(d.zeitleiste, null, "abgeraeumt: kein state/<id>.status");
  assert.deepEqual(d.dateien, ["brief.md", "launch-brief.md", "report.md"]);
  const live = aufgabeDetail(heimat.home, "a-live")!;
  assert.equal(live.zeitleiste?.length, 2);
  assert.equal(live.zeitleiste?.[1].verb, "working");
  assert.equal(live.brief, null);
  assert.deepEqual(live.dateien, []);
});

test("aufgabeDetail: ein Bericht ueber 9000 Zeichen wird gekuerzt und als gekuerzt gemeldet", () => {
  const id = "lang-1";
  mkdirSync(path.join(heimat.home, "data", id));
  writeFileSync(path.join(heimat.home, "data", id, "report.md"), "x".repeat(20000));
  const d = aufgabeDetail(heimat.home, id)!;
  assert.equal(d.berichtGekuerzt, true);
  assert.ok((d.bericht ?? "").length <= 9000 && (d.bericht ?? "").length > 8000);
});

test("aufgabeDetail: ungueltige oder unbekannte Id gibt null, nie etwas ausserhalb von data/<id>/", () => {
  const geheim = path.join(path.dirname(heimat.home), "flotte-geheim.txt");
  writeFileSync(geheim, "GEHEIM");
  try {
    for (const id of ["..", ".", "../" + path.basename(heimat.home), "a/b", "../state/a-live", "", "nicht-da", "a-live/../a-ship-1"]) {
      assert.equal(aufgabeDetail(heimat.home, id), null, JSON.stringify(id));
    }
    // Symlink-Ordner data/<id> auf einen Ort ausserhalb von data/
    const ausserhalb = mkdtempSync(path.join(os.tmpdir(), "flotte-aus-"));
    writeFileSync(path.join(ausserhalb, "brief.md"), "GEHEIM");
    symlinkSync(ausserhalb, path.join(heimat.home, "data", "link-ordner"));
    assert.equal(aufgabeDetail(heimat.home, "link-ordner"), null);
    // Symlink-Datei brief.md im echten Ordner
    mkdirSync(path.join(heimat.home, "data", "link-datei"));
    symlinkSync(geheim, path.join(heimat.home, "data", "link-datei", "brief.md"));
    symlinkSync(geheim, path.join(heimat.home, "data", "link-datei", "report.md"));
    const d = aufgabeDetail(heimat.home, "link-datei")!;
    assert.equal(d.brief, null);
    assert.equal(d.bericht, null);
    assert.doesNotMatch(JSON.stringify(d), /GEHEIM/);
    rmSync(ausserhalb, { recursive: true, force: true });
  } finally {
    rmSync(geheim, { force: true });
  }
});

// --- Markdown ohne rohes HTML (ansicht/live-plan.js) ----------------------------------------

type Ansicht = {
  mdHtml: (t: string) => string;
  setzeFirstmate: (f: unknown) => void;
  setzeAufgabeDetail: (id: string, d: unknown) => void;
  flotteTeil: () => string;
  flAufgabeModal: (id: string) => string;
};
function ansicht(): Ansicht {
  const g: Record<string, unknown> = {
    document: { getElementById: () => null, documentElement: { dataset: {} } },
    location: { pathname: "/", search: "" },
  };
  g.globalThis = g;
  vm.runInNewContext(readFileSync(path.join(import.meta.dirname, "ansicht", "live-plan.js"), "utf8"), g);
  return g.LivePlanAnsicht as Ansicht;
}

test("mdHtml: <script>, Ereignis-Attribute und rohes HTML erscheinen als Text, nie als Element", () => {
  const { mdHtml } = ansicht();
  const boese = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "text <b onclick=\"x()\">fett</b> und <iframe src=//e></iframe>",
    "# <script>x</script>",
    "- <svg onload=alert(1)>",
    "| <a href=x> | b |\n|---|---|\n| <script> | <style> |",
    "```\n<script>alert(1)</script>\n```",
    "`<script>`",
    "**<img src=x onerror=1>**",
    "> <script>",
  ];
  for (const t of boese) {
    const h = mdHtml(t);
    assert.doesNotMatch(h, /<(script|img|iframe|svg|style|b |a href=x)/i, t);
    assert.match(h, /&lt;/, t);
  }
  assert.match(mdHtml("<script>alert(1)</script>"), /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("mdHtml: Links nur auf https, javascript: und data: bleiben Text; Anfuehrungszeichen brechen nicht aus", () => {
  const { mdHtml } = ansicht();
  assert.match(mdHtml("[Doku](https://example.org/a?b=1)"), /<a href="https:\/\/example\.org\/a\?b=1" target="_blank" rel="noopener noreferrer">Doku<\/a>/);
  assert.match(mdHtml("siehe https://github.com/o/r/pull/7."), /<a href="https:\/\/github\.com\/o\/r\/pull\/7"[^>]*>https:\/\/github\.com\/o\/r\/pull\/7<\/a>\./);
  for (const t of ["[x](javascript:alert(1))", "[x](data:text/html,<script>1</script>)", "[x](  javascript:alert(1))", "[x](JaVaScRiPt:alert(1))", "[x](http://example.org)"]) {
    assert.doesNotMatch(mdHtml(t), /<a /, t);
  }
  const h = mdHtml('[a](https://e.org/"onmouseover="x)');
  assert.doesNotMatch(h, /onmouseover="x/, "das Anfuehrungszeichen ist maskiert");
});

test("mdHtml: die benoetigte Teilmenge: Ueberschriften, Listen, Code, Tabellen, Hervorhebung", () => {
  const { mdHtml } = ansicht();
  const h = mdHtml("# Eins\n## Zwei\n\nAbsatz mit **fett**, *schief* und `code`.\n\n- a\n- b\n  - b1\n\n1. x\n2. y\n\n```ts\nconst a = 1 < 2;\n```\n\n| K | W |\n|---|---|\n| a | 1 |\n\n> Zitat\n");
  assert.match(h, /<h1>Eins<\/h1>/);
  assert.match(h, /<h2>Zwei<\/h2>/);
  assert.match(h, /<strong>fett<\/strong>/);
  assert.match(h, /<em>schief<\/em>/);
  assert.match(h, /<code>code<\/code>/);
  assert.match(h, /<ul>\s*<li>a<\/li>\s*<li>b\s*<ul>\s*<li>b1<\/li>\s*<\/ul>\s*<\/li>\s*<\/ul>/);
  assert.match(h, /<ol>\s*<li>x<\/li>\s*<li>y<\/li>\s*<\/ol>/);
  assert.match(h, /<pre><code>const a = 1 &lt; 2;\n<\/code><\/pre>/);
  assert.match(h, /<table>[\s\S]*<th>K<\/th>[\s\S]*<td>a<\/td>[\s\S]*<\/table>/);
  assert.match(h, /<blockquote>[\s\S]*Zitat[\s\S]*<\/blockquote>/);
});

test("mdHtml: snake_case und Sternchen im Wort werden nicht zu Hervorhebung; Leeres bleibt leer", () => {
  const { mdHtml } = ansicht();
  assert.doesNotMatch(mdHtml("fm_spawn_gen und a*b*c"), /<em>/);
  assert.equal(mdHtml(""), "");
  assert.equal(mdHtml(null as never), "");
});

// --- Zeichnen der Flotte und des Aufgaben-Modals ----------------------------------------------

const BOESE = '<img src=x onerror=alert(1)>"\'';
function aufgabeFuerAnsicht(extra: Record<string, unknown> = {}) {
  return { id: "t-" + BOESE, repo: "r-" + BOESE, kind: "ship", titel: "titel " + BOESE, zustand: "fertig", zustandText: "gemergt", start: JETZT - 3600, ende: JETZT - 1800, minuten: 30, von: 10, breit: 20, schaetzung: null, pr: "javascript:alert(1)", ausgang: "merged", kosten: 1.5, zuege: 3, modell: "m-" + BOESE, effort: null, live: false, zeitleiste: false, dateien: 1, ...extra };
}
function flottenSicht(aufgaben: unknown[]) {
  return { home: "/h", zeit: JETZT, flotte: { jetzt: JETZT, t0: JETZT - 7200, t1: JETZT + 1800, jetztProzent: 80, achse: [{ t: JETZT - 3600, prozent: 30 }], repos: [{ repo: "r-" + BOESE, aufgaben, median: 40, gemergt: 1, laeuft: [] }] }, worker: [], projekte: [] };
}

test("flotteTeil: eine Linie je Repo mit Balken in Prozent; Ids, Titel und Repo-Namen sind maskiert, javascript:-PR ist kein Link", () => {
  const a = ansicht();
  a.setzeFirstmate(flottenSicht([aufgabeFuerAnsicht()]));
  const h = a.flotteTeil();
  assert.match(h, /data-fl-linie/);
  assert.match(h, /style="left:10%;width:20%"/);
  assert.match(h, /left:80%/, "Marke fuer jetzt");
  assert.match(h, /1 Aufgabe ·/);
  assert.doesNotMatch(h, /<img/i);
  assert.doesNotMatch(h, /href="javascript/i);
  assert.match(h, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("flAufgabeModal: Zeitleiste fehlt -> Hinweis; Anweisungen, Bericht und Zeitleiste ohne rohes HTML; lazy: ohne Detail steht lädt", () => {
  const a = ansicht();
  const t = aufgabeFuerAnsicht();
  a.setzeFirstmate(flottenSicht([t]));
  assert.match(a.flAufgabeModal(t.id), /lädt …/);
  a.setzeAufgabeDetail(t.id, { id: t.id, intent: "Mach <script>alert(1)</script> bitte", spec: "Spec <b>fett</b>", brief: "# Brief\n<iframe src=x>", briefGekuerzt: false, bericht: "Bericht <svg onload=1>", berichtGekuerzt: true, zeitleiste: null, dateien: ["brief.md", "<x>.md"] });
  const h = a.flAufgabeModal(t.id);
  assert.match(h, /Zeitleiste beim Abräumen gelöscht/);
  assert.match(h, /gekürzt, der volle Bericht liegt in/);
  assert.doesNotMatch(h, /<(script|iframe|svg|img)\b|<b>fett/i);
  assert.match(h, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  a.setzeAufgabeDetail(t.id, { id: t.id, intent: null, spec: null, brief: null, bericht: null, zeitleiste: [{ verb: "working", at: JETZT, key: null, text: "<b>x</b>", roh: "" }], dateien: [] });
  const h2 = a.flAufgabeModal(t.id);
  assert.match(h2, /Kein Abschnitt/);
  assert.match(h2, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(h2, /Zeitleiste beim Abräumen/);
  assert.doesNotMatch(h2, /<b>x/);
});

// --- derselbe Endpunkt gegen einen echten Server ----------------------------------------------

const ID = "fm-sitzung";
let tmp: string;
let server: ChildProcess;
let apiBasis: string;
let lanBasis: string | null;

function freierPort(): Promise<number> {
  return new Promise((ok, fehler) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => ok(port));
    });
    s.on("error", fehler);
  });
}

before(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "flotte-server-"));
  const wurzel = path.join(tmp, "wurzel");
  const home = path.join(wurzel, "fmhome");
  for (const d of ["bin", "state", "data"]) mkdirSync(path.join(home, d), { recursive: true });
  writeFileSync(path.join(home, "bin", "fm-spawn.sh"), "#!/bin/sh\n");
  mkdirSync(path.join(home, "data", "t-eins"));
  writeFileSync(path.join(home, "data", "t-eins", "launch-brief.md"), "x");
  writeFileSync(path.join(home, "data", "t-eins", "brief.md"), "# Task\n## Captain's intent\nSichtbar <script>x</script>\n");
  writeFileSync(path.join(wurzel, "geheim.txt"), "GEHEIM");
  const cache = path.join(tmp, "cache");
  mkdirSync(path.join(cache, "sitzungen"), { recursive: true });
  const register = { v: 1, id: ID, cwd: home, wurzel: home, repo: "fmhome", modell: "m", gestartet: 0, aktualisiert: 0, haupt: { zuege: 0 }, fortschritt: null, agenten: [], dateien: [] };
  writeFileSync(path.join(cache, "sitzungen", `${ID}.json`), JSON.stringify(register));
  const port = await freierPort();
  apiBasis = `http://localhost:${port}/api/fmhome/${ID}/firstmate`;
  const lan = Object.values(os.networkInterfaces()).flat().find((n) => n && n.family === "IPv4" && !n.internal);
  lanBasis = lan ? `http://${lan.address}:${port}/api/fmhome/${ID}/firstmate` : null;
  server = spawn("bun", [path.join(import.meta.dirname, "server.ts")], {
    env: { ...process.env, LIVE_PLAN_PORT: String(port), LIVE_PLAN_CACHE: cache, LIVE_PLAN_WURZEL: wurzel },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://localhost:${port}/api/gesund`)).ok) return;
    } catch {
      /* noch nicht oben */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Server startet nicht");
});

after(() => {
  server?.kill();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const hole = async (url: string, kopf: Record<string, string> = {}) => {
  const r = await fetch(url, { headers: kopf });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

test("Endpunkt: GET .../firstmate liefert die Flotte neben den Workern", async () => {
  const { status, body } = await hole(apiBasis);
  assert.equal(status, 200);
  const f = body.flotte as { repos: { aufgaben: { id: string }[] }[] };
  assert.ok(f.repos.flatMap((r) => r.aufgaben).some((a) => a.id === "t-eins"));
});

test("Endpunkt: GET .../firstmate/aufgabe/<id> liest nur data/<id>/", async () => {
  const { status, body } = await hole(`${apiBasis}/aufgabe/t-eins`);
  assert.equal(status, 200);
  assert.equal(body.id, "t-eins");
  assert.match(String(body.intent), /Sichtbar/);
});

test("Endpunkt: eine ungueltige Id ist 400, eine unbekannte 404, nie eine Datei von ausserhalb", async () => {
  // Der URL-Parser des Clients loest ".." und %2e%2e schon vor dem Senden auf; dort kommt eine andere Route an.
  for (const id of ["a%2fb", "..%2f..%2fgeheim.txt", "%2e%2e%2fgeheim.txt", "a%00b", "a%5cb", "%252e%252e"]) {
    const { status, body } = await hole(`${apiBasis}/aufgabe/${id}`);
    assert.ok(status === 400 || status === 404, `${id}: ${status}`);
    assert.doesNotMatch(JSON.stringify(body), /GEHEIM/);
  }
  assert.equal((await hole(`${apiBasis}/aufgabe/a%2fb`)).status, 400);
  assert.equal((await hole(`${apiBasis}/aufgabe/gibt-es-nicht`)).status, 404);
  const roh = await fetch(`${apiBasis}/aufgabe/t-eins/../../geheim.txt`);
  assert.doesNotMatch(await roh.text(), /GEHEIM/);
});

test("Endpunkt: fremder Origin ist 403, von einem anderen Rechner nur der Host-Kopf-Schutz wie bisher plus Loopback", async (t) => {
  const fremd = await hole(`${apiBasis}/aufgabe/t-eins`, { Origin: "http://evil.example" });
  assert.equal(fremd.status, 403);
  // fetch darf den Host-Kopf nicht setzen; ein roher Aufruf schon (DNS-Rebinding)
  const rebind = await new Promise<number>((ok, fehler) => {
    const u = new URL(`${apiBasis}/aufgabe/t-eins`);
    http.get({ host: u.hostname, port: u.port, path: u.pathname, headers: { Host: "evil.example" } }, (r) => { r.resume(); ok(r.statusCode ?? 0); }).on("error", fehler);
  });
  assert.equal(rebind, 403);
  if (!lanBasis) return t.skip("keine Nicht-Loopback-Adresse an diesem Rechner");
  for (const kopf of [{}, { "X-Forwarded-For": "127.0.0.1", "X-Real-IP": "127.0.0.1" }]) {
    const lan = await hole(`${lanBasis}/aufgabe/t-eins`, kopf);
    assert.equal(lan.status, 403);
    assert.doesNotMatch(JSON.stringify(lan.body), /Sichtbar/);
  }
  assert.equal((await hole(lanBasis)).status, 200, "die Flotte selbst bleibt wie die bisherige Firstmate-Abfrage");
});
