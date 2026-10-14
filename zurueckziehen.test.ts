// live-plan (#27): zurueckgezogene Fragen, `bun test zurueckziehen.test.ts` (startet `bun server.ts` und das Skript).
//
// Eine Frage, die die Sitzung schliesst, ohne sie zu entscheiden (Esc im Dialog, Sitzungsende), traegt
// `zurueckgezogen: GRUND` und gilt nirgends mehr als offen: weder im Ueberblick noch in der Liste, im
// Stand fuer den System-Prompt oder in der Ansicht.

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import vm from "node:vm";
import {
  frageOffen,
  kurzStand,
  offeneFragen,
  offeneFragenZahl,
  pruefePlan,
  setzeEntscheidungImText,
  spurbild,
  ueberblick,
  zeiten,
  zieheFrageZurueckImText,
  zurueckGrund,
} from "./logik.ts";
import { ENTSCHIEDEN_EXIT, schonEntschieden } from "./mod/hooks/fragen.ts";

const FRAGE = (id: string, extra: Record<string, unknown> = {}) => ({ id, frage: `${id}?`, optionen: [{ label: "A" }, { label: "B" }], entscheidung: "", ...extra });
const PLAN = (fragen: unknown[]) => ({ v: 1, titel: "t", bahnen: [{ id: "b" }], wellen: [{ id: "w" }], schritte: [], fragen });

// --- Zustand und Praedikat --------------------------------------------------------------------

test("pruefePlan liest zurueckgezogen, frageOffen ist weder entschieden noch zurueckgezogen", () => {
  const { plan, fehler } = pruefePlan(PLAN([FRAGE("F1"), FRAGE("F2", { zurueckgezogen: "in der Sitzung abgebrochen" }), FRAGE("F3", { entscheidung: "A" })]));
  assert.deepEqual(fehler, []);
  assert.equal(plan.fragen[1]!.zurueckgezogen, "in der Sitzung abgebrochen");
  assert.equal(plan.fragen[0]!.zurueckgezogen, undefined);
  assert.deepEqual(plan.fragen.map(frageOffen), [true, false, false]);
  assert.deepEqual(offeneFragen(plan), ["F1"]);
});

// Review K5: Band und Mod lesen eine Entscheidung aus Leerraum als keine; pruefePlan genauso.
test("eine Entscheidung aus Leerraum ist keine: offen in pruefePlan, frageOffen, Liste und beim Zurueckziehen", () => {
  const { plan } = pruefePlan(PLAN([FRAGE("F1", { entscheidung: "  \t" }), FRAGE("F2", { entscheidung: " A " })]));
  assert.equal(plan.fragen[0]!.entscheidung, "");
  assert.deepEqual(plan.fragen.map(frageOffen), [true, false]);
  assert.deepEqual(offeneFragen(plan), ["F1"]);
  assert.equal(offeneFragenZahl(PLAN([FRAGE("F1", { entscheidung: " " })])), 1);
  const text = 'v: 1\nfragen:\n  - id: F1\n    frage: Eins?\n    optionen: [{ label: A }]\n    entscheidung: "  "\n';
  const r = zieheFrageZurueckImText(text, "F1", "Sitzung beendet");
  assert.equal(r.art, "ok");
  assert.equal(pruefePlan(Bun.YAML.parse((r as { text: string }).text)).plan.fragen[0]!.zurueckgezogen, "Sitzung beendet");
});

test("offeneFragenZahl (Liste) zaehlt eine zurueckgezogene Frage nicht", () => {
  assert.equal(offeneFragenZahl(PLAN([FRAGE("F1"), FRAGE("F2", { zurueckgezogen: "Sitzung beendet" })])), 1);
  assert.equal(offeneFragenZahl(PLAN([FRAGE("F1", { zurueckgezogen: "Sitzung beendet" })])), 0);
});

test("ueberblick: nur zurueckgezogene Fragen sind keine Jetzt-Zeile Wartet auf Sie", () => {
  const { plan } = pruefePlan({ ...PLAN([FRAGE("F1", { zurueckgezogen: "Sitzung beendet" })]), stand: { thema: "Umbau", erledigt: [], fragen: [], offen: [] } });
  assert.deepEqual(ueberblick(plan, zeiten([])).jetzt, { art: "thema", text: "Umbau" });
});

test("kurzStand (System-Prompt) nennt eine zurueckgezogene Frage nicht unter Offene Fragen", () => {
  const { plan } = pruefePlan(PLAN([FRAGE("F1", { frage: "Bleibt?" }), FRAGE("F2", { frage: "Weg?", zurueckgezogen: "in der Sitzung abgebrochen" })]));
  const text = kurzStand(plan);
  assert.match(text, /- F1 Bleibt\?/);
  assert.doesNotMatch(text, /F2/);
});

test("spurbild: eine zurueckgezogene Frage ist verworfen, nicht offen; die Fragen-Zeile zaehlt sie als erledigt", () => {
  const { plan } = pruefePlan(PLAN([FRAGE("F1"), FRAGE("F2", { zurueckgezogen: "Sitzung beendet" }), FRAGE("F3", { entscheidung: "A" })]));
  const bild = spurbild(plan, zeiten([]));
  assert.deepEqual(bild.punkte.map((p) => [p.id, p.status]), [["F1", "offen"], ["F2", "verworfen"], ["F3", "entschieden"]]);
  assert.deepEqual(bild.zeilen.find((z) => z.id === "fragen"), { id: "fragen", name: "Fragen", y: bild.zeilen[0]!.y, fertig: 2, gesamt: 3 });
});

// --- Schreiben als Textfunktion ---------------------------------------------------------------

const YAML = [
  "v: 1",
  "titel: t",
  "fragen:",
  "  - id: F1",
  "    frage: Eins?",
  "    optionen:",
  "      - label: A",
  '    entscheidung: ""',
  "    # Kommentar bleibt",
  "",
  "  - id: F2",
  "    frage: Zwei?",
  "    optionen: [{ label: A }]",
  "    entscheidung: A # schon gewaehlt",
  "  - id: F3",
  "    frage: Drei?",
  "    optionen: [{ label: A }]",
  "    entscheidung: null",
  "schritte: []",
  "",
].join("\n");

test("zieheFrageZurueckImText: eine Zeile ans Ende des Frageblocks, jedes andere Byte bleibt", () => {
  const r = zieheFrageZurueckImText(YAML, "F1", "in der Sitzung abgebrochen");
  assert.equal(r.art, "ok");
  const neu = (r as { text: string }).text;
  const zeilen = YAML.split("\n");
  zeilen.splice(8, 0, "    zurueckgezogen: in der Sitzung abgebrochen"); // vor den Kommentar am Blockende, wie beim Entscheiden
  assert.equal(neu, zeilen.join("\n"));
  assert.equal(pruefePlan(Bun.YAML.parse(neu)).plan.fragen[0]!.zurueckgezogen, "in der Sitzung abgebrochen");
});

test("zieheFrageZurueckImText: eine entschiedene Frage wird nicht zurueckgezogen", () => {
  assert.deepEqual(zieheFrageZurueckImText(YAML, "F2", "Sitzung beendet"), { art: "entschieden", entscheidung: "A" });
});

test("zieheFrageZurueckImText: entscheidung null gilt als offen, wie pruefePlan sie liest", () => {
  const r = zieheFrageZurueckImText(YAML, "F3", "Sitzung beendet");
  assert.equal(r.art, "ok");
  assert.equal(pruefePlan(Bun.YAML.parse((r as { text: string }).text)).plan.fragen[2]!.zurueckgezogen, "Sitzung beendet");
});

test("zieheFrageZurueckImText: schon zurueckgezogen bleibt beim ersten Grund, unbekannt und Flow-Form wie beim Entscheiden", () => {
  const einmal = zieheFrageZurueckImText(YAML, "F1", "erster Grund");
  assert.equal(einmal.art, "ok");
  const text = (einmal as { text: string }).text;
  assert.deepEqual(zieheFrageZurueckImText(text, "F1", "zweiter Grund"), { art: "ok", text });
  assert.deepEqual(zieheFrageZurueckImText(YAML, "F9", "x"), { art: "unbekannt" });
  assert.equal(zieheFrageZurueckImText("fragen:\n  - { id: F1, frage: x }\n", "F1", "x").art, "fehler");
  assert.equal(zieheFrageZurueckImText(YAML.replaceAll("\n", "\r\n"), "F1", "x").art, "fehler");
});

test("setzeEntscheidungImText bleibt wie vor dem Zurueckziehen: ersetzt die Zeile, ergaenzt eine fehlende", () => {
  const r = setzeEntscheidungImText(YAML, "F2", "B");
  assert.equal(r.art, "ok");
  assert.match((r as { text: string }).text, /\n {4}entscheidung: B # schon gewaehlt\n/);
  const ohne = "fragen:\n  - id: F1\n    frage: x\n    optionen: [{ label: A }]\n";
  assert.deepEqual(setzeEntscheidungImText(ohne, "F1", "A"), { art: "ok", text: "fragen:\n  - id: F1\n    frage: x\n    optionen: [{ label: A }]\n    entscheidung: A\n" });
  assert.deepEqual(setzeEntscheidungImText(YAML, "F9", "A"), { art: "unbekannt" });
});

test("zurueckGrund: eine Zeile ohne Steuer- und Bidi-Zeichen, hoechstens 200 Zeichen, leer wird ohne Angabe", () => {
  assert.equal(zurueckGrund("  Sitzung\nbeendet‮ "), "Sitzung beendet");
  assert.equal([...zurueckGrund("x".repeat(300))].length, 200);
  assert.equal(zurueckGrund(""), "ohne Angabe");
  assert.equal(zurueckGrund(undefined), "ohne Angabe");
  assert.equal(zurueckGrund(42), "ohne Angabe");
});

// --- Server: POST .../zurueckziehen und die Liste --------------------------------------------

let tmp: string;
let server: ChildProcess;
let basis: string;
let repo: string;

function freierPort(): Promise<number> {
  return new Promise((ok, fehler) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => ok(port));
    });
    s.on("error", fehler);
  });
}

const SITZUNG = (fragen: string) => `v: 1\ntitel: Sitzung\nbahnen: [{ id: b }]\nwellen: [{ id: w }]\nschritte: []\nfragen:\n${fragen}`;
const BLOCK = (id: string, entscheidung = '""') => `  - id: ${id}\n    frage: ${id}?\n    optionen:\n      - label: A\n    entscheidung: ${entscheidung}\n`;
const REGISTER = (id: string, beendet?: number) =>
  JSON.stringify({ v: 1, id, cwd: repo, wurzel: repo, repo: "repo", modell: "m", gestartet: 1, aktualisiert: 2, ...(beendet ? { beendet } : {}), haupt: { kontext: { benutzt: null, max: null, prozent: null }, kostenUsd: null, zuege: 0 }, fortschritt: null, agenten: [] });

before(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "live-plan-zurueck-"));
  repo = path.join(tmp, "wurzel", "repo");
  const ordner = path.join(repo, ".live-plan");
  mkdirSync(ordner, { recursive: true });
  mkdirSync(path.join(tmp, "cache", "sitzungen"), { recursive: true });
  writeFileSync(path.join(ordner, "s1.yaml"), SITZUNG(BLOCK("F1") + BLOCK("F2", "A") + BLOCK("F3")));
  writeFileSync(path.join(ordner, "liste.yaml"), SITZUNG(BLOCK("F1") + BLOCK("F2") + "    zurueckgezogen: in der Sitzung abgebrochen\n"));
  writeFileSync(path.join(ordner, "aus.yaml"), SITZUNG(BLOCK("F1") + BLOCK("F2")));
  writeFileSync(path.join(ordner, "an.yaml"), SITZUNG(BLOCK("F1")));
  writeFileSync(path.join(ordner, "flow.yaml"), SITZUNG('  - { id: F1, frage: "F1?", optionen: [{ label: A }], entscheidung: "" }\n'));
  writeFileSync(path.join(tmp, "cache", "sitzungen", "aus.json"), REGISTER("aus", 5));
  writeFileSync(path.join(tmp, "cache", "sitzungen", "an.json"), REGISTER("an"));
  const port = await freierPort();
  basis = `http://127.0.0.1:${port}`;
  server = spawn("bun", [path.join(import.meta.dirname, "server.ts")], {
    env: { ...process.env, LIVE_PLAN_WURZEL: path.join(tmp, "wurzel"), LIVE_PLAN_PORT: String(port), LIVE_PLAN_CACHE: path.join(tmp, "cache") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((bereit, fehler) => {
    server.stdout!.on("data", (d: Buffer) => d.toString().includes("live-plan: http") && bereit());
    server.on("exit", (code) => fehler(new Error(`server endete mit ${code}`)));
  });
});

after(() => {
  server?.kill();
  rmSync(tmp, { recursive: true, force: true });
});

const zurueck = (slug: string, koerper: unknown, art = "application/json") =>
  fetch(`${basis}/api/repo/${slug}/zurueckziehen`, { method: "POST", headers: { "content-type": art }, body: JSON.stringify(koerper) });

test("POST zurueckziehen: schreibt die Zeile, die Sitzung zeigt die Frage nicht mehr als wartend", async () => {
  const r = await zurueck("s1", { frage: "F1", grund: "in der Sitzung abgebrochen" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  const yaml = readFileSync(path.join(repo, ".live-plan", "s1.yaml"), "utf8");
  assert.match(yaml, /- id: F1\n {4}frage: F1\?\n {4}optionen:\n {6}- label: A\n {4}entscheidung: ""\n {4}zurueckgezogen: in der Sitzung abgebrochen\n/);
  const d = (await (await fetch(`${basis}/api/repo/s1`)).json()) as { plan: { fragen: { id: string; zurueckgezogen?: string }[] }; ueberblick: { jetzt: { art: string; fragen?: string[] } } };
  assert.equal(d.plan.fragen[0]!.zurueckgezogen, "in der Sitzung abgebrochen");
  assert.deepEqual(d.ueberblick.jetzt, { art: "fragen", fragen: ["F3"] });
});

test("POST zurueckziehen: entschieden 409, unbekannt 404, ohne frage 400, falscher Inhaltstyp 415, ohne Grund ohne Angabe", async () => {
  const entschieden = await zurueck("s1", { frage: "F2", grund: "x" });
  assert.equal(entschieden.status, 409);
  assert.match(((await entschieden.json()) as { fehler: string }).fehler, /F2 ist schon entschieden/);
  assert.equal((await zurueck("s1", { frage: "F9" })).status, 404);
  assert.equal((await zurueck("s1", { grund: "x" })).status, 400);
  assert.equal((await zurueck("s1", { frage: "F3" }, "text/plain")).status, 415);
  assert.equal((await zurueck("s1", { frage: "F3" })).status, 200);
  assert.match(readFileSync(path.join(repo, ".live-plan", "s1.yaml"), "utf8"), /- id: F3\n(?: {4}.*\n)*? {4}zurueckgezogen: ohne Angabe\n/);
  assert.doesNotMatch(readFileSync(path.join(repo, ".live-plan", "s1.yaml"), "utf8"), /- id: F2\n(?: {4}.*\n)*? {4}zurueckgezogen/);
});

// Review B1: die Liste kennt keine Sonderregel fuer beendete Sitzungen. Sie zaehlt wie die Seite; die
// Fragen einer beendeten Sitzung schliesst die Mod am Sitzungsende (`Sitzung beendet`).
test("GET /api/liste zaehlt offene Fragen wie die Seite, auch fuer eine beendete Sitzung", async () => {
  const liste = async () => {
    const { sitzungen } = (await (await fetch(`${basis}/api/liste`)).json()) as { sitzungen: { slug: string; offeneFragen: number | null; beendet: boolean }[] };
    return Object.fromEntries(sitzungen.map((s) => [s.slug, s]));
  };
  // Was die Seite unter Fragen an Sie zaehlt, aus denselben Daten, die der Browser bekommt.
  const seite = async (slug: string) => {
    const a = ansicht();
    a.setze(await (await fetch(`${basis}/api/repo/${slug}`)).json());
    return Number(/<span class="zaehler">(\d+) offen<\/span>/.exec(a.fragenAnSie())?.[1]);
  };
  const je = await liste();
  assert.equal(je.aus?.beendet, true);
  assert.equal(je.an?.beendet, false);
  for (const slug of ["liste", "aus", "an"]) assert.equal(je[slug]?.offeneFragen, await seite(slug), slug);
  assert.deepEqual(["liste", "aus", "an"].map((slug) => je[slug]?.offeneFragen), [1, 2, 1]);
  for (const frage of ["F1", "F2"]) assert.equal((await zurueck("aus", { frage, grund: "Sitzung beendet" })).status, 200);
  assert.equal((await liste()).aus?.offeneFragen, 0);
  assert.equal(await seite("aus"), 0);
});

// Review K2: "schon entschieden" steht im Feld `entschieden` des 409 und im Exit-Code des Skripts,
// nicht im Wortlaut. Die Mod liest beides mit schonEntschieden und ENTSCHIEDEN_EXIT; dieser Test
// fuehrt sie gegen den echten Server und das echte Skript.
test("schon entschieden ist maschinenlesbar: Feld im 409 des Servers, eigener Exit-Code des Skripts, die Mod liest beides", async () => {
  const entschieden = await zurueck("s1", { frage: "F2", grund: "x" });
  const text = await entschieden.text();
  assert.equal(entschieden.status, 409);
  assert.equal((JSON.parse(text) as { entschieden?: unknown }).entschieden, "A");
  assert.equal(schonEntschieden({ status: entschieden.status, text }), true);
  const flow = await zurueck("flow", { frage: "F1", grund: "x" });
  assert.equal(flow.status, 409);
  assert.equal(schonEntschieden({ status: flow.status, text: await flow.text() }), false);
  const unbekannt = await zurueck("s1", { frage: "F9" });
  assert.equal(schonEntschieden({ status: unbekannt.status, text: await unbekannt.text() }), false);
  const projekt = path.join(tmp, "projekt-k2");
  mkdirSync(path.join(projekt, ".live-plan"), { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: projekt }).status, 0);
  writeFileSync(path.join(projekt, ".live-plan", "s.yaml"), SITZUNG(BLOCK("F1") + BLOCK("F2", "A")));
  const skriptEntschieden = skript(projekt, "frage-zurueck", "F2", "--sitzung", "s");
  assert.equal(skriptEntschieden.status, ENTSCHIEDEN_EXIT, skriptEntschieden.stderr);
  assert.notEqual(skript(projekt, "frage-zurueck", "F9", "--sitzung", "s").status, ENTSCHIEDEN_EXIT);
});

// --- Skript: live-plan frage-zurueck ----------------------------------------------------------

function skript(cwd: string, ...args: string[]) {
  const env: Record<string, string | undefined> = { ...process.env, LIVE_PLAN_PORT: "1", LIVE_PLAN_CACHE: path.join(tmp, "cache") };
  delete env.CLAUDE_SESSION_ID;
  return spawnSync("bun", [path.join(import.meta.dirname, "live-plan"), ...args], { cwd, env, encoding: "utf8" });
}

test("live-plan frage-zurueck ID GRUND --sitzung SLUG schreibt ohne Server, ein zweites Mal bleibt der erste Grund", () => {
  const projekt = path.join(tmp, "projekt");
  mkdirSync(path.join(projekt, ".live-plan"), { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: projekt }).status, 0);
  const datei = path.join(projekt, ".live-plan", "s.yaml");
  writeFileSync(datei, SITZUNG(BLOCK("F1") + BLOCK("F2", "A")));
  const r = skript(projekt, "frage-zurueck", "F1", "in", "der", "Sitzung", "beendet", "--sitzung", "s");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /F1 zurueckgezogen: in der Sitzung beendet/);
  assert.match(readFileSync(datei, "utf8"), / {4}entscheidung: ""\n {4}zurueckgezogen: in der Sitzung beendet\n/);
  const nochmal = skript(projekt, "frage-zurueck", "F1", "anders", "--sitzung", "s");
  assert.equal(nochmal.status, 0, nochmal.stderr);
  assert.match(nochmal.stdout, /F1 war schon zurueckgezogen/);
  assert.doesNotMatch(readFileSync(datei, "utf8"), /anders/);
  const entschieden = skript(projekt, "frage-zurueck", "F2", "--sitzung", "s");
  assert.equal(entschieden.status, 3);
  assert.match(entschieden.stderr, /F2 ist schon entschieden/);
  const unbekannt = skript(projekt, "frage-zurueck", "F9", "--sitzung", "s");
  assert.equal(unbekannt.status, 1);
  assert.match(unbekannt.stderr, /Frage F9 unbekannt/);
  assert.equal(skript(projekt, "frage-zurueck", "--sitzung", "s").status, 1);
});

// --- Ansicht -----------------------------------------------------------------------------------

interface Ansicht {
  setze: (d: unknown) => void;
  fragenAnSie: () => string;
  blick: () => string;
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

const DATEN = (fragen: unknown[]) => ({
  plan: { ...pruefePlan(PLAN(fragen)).plan },
  zeiten: { je: {}, zuletzt: null },
  neueste: {},
});

test("Ansicht: eine zurueckgezogene Frage steht nicht unter Wartet auf Sie, sondern ausgegraut mit Grund", () => {
  const a = ansicht();
  a.setze(DATEN([FRAGE("F1", { frage: "Offen?" }), FRAGE("F2", { frage: "Weg?", zurueckgezogen: "in der Sitzung abgebrochen" })]));
  const html = a.fragenAnSie();
  assert.match(html, /<span class="zaehler">1 offen<\/span>/);
  assert.match(html, /<div class="lp-frage" data-frage="F1">/);
  assert.doesNotMatch(html, /data-frage="F2"/);
  assert.match(html, /<div class="lp-az fr-zurueck" data-zurueck="F2">/);
  assert.match(html, /zurückgezogen: in der Sitzung abgebrochen/);
  const blick = a.blick();
  assert.match(blick, /Wartet auf Sie<\/span> <b class="w">1 <small>Frage<\/small>/);
});

test("Ansicht: Mehrfachauswahl aus Labels (mit Komma verbunden) ist keine eigene Antwort", () => {
  const a = ansicht();
  a.setze(DATEN([FRAGE("F1", { entscheidung: "A, B" }), FRAGE("F2", { entscheidung: "A, C" })]));
  const html = a.fragenAnSie();
  const zeile = (id: string) => html.split('data-entschieden="').find((t) => t.startsWith(`${id}"`)) ?? "";
  assert.doesNotMatch(zeile("F1"), /eigene Antwort/);
  assert.match(zeile("F2"), /eigene Antwort/);
});
