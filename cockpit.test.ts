// cockpit: Tests der reinen Logik, `node --test cockpit.test.ts`.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { alter, backlogTitel, bild, breite, kasten, KASTEN_MIN, klartext, lagebild, offeneFragen, oeffnenKurz, paneZeilen, parseGitStatus, parseMeta, parseStatus, parseStatusZeile, passend, prKurz, q, raster, zaehleBacklog, zustand } from "./cockpit.ts";
import type { Lagebild, Rahmen, Worker } from "./cockpit.ts";

test("parseMeta: key=value, letzter Eintrag gilt, Wert darf = enthalten", () => {
  const meta = parseMeta("window=firstmate:fm-a\nkind=ship\npr=https://x/y?a=b\nkind=scout\nkaputt\n=leer\n");
  assert.deepEqual(meta, { window: "firstmate:fm-a", kind: "scout", pr: "https://x/y?a=b" });
});

test("parseStatusZeile: Verb, at, key und Text", () => {
  const z = parseStatusZeile("needs-decision [at=1791835796] [key=nm-1-review]: ask-user findings=a,b");
  assert.equal(z?.verb, "needs-decision");
  assert.equal(z?.at, 1791835796);
  assert.equal(z?.key, "nm-1-review");
  assert.equal(z?.text, "ask-user findings=a,b");
  const k = parseStatusZeile("resolved [key=api] [at=1788576000]: answered: use REST");
  assert.equal(k?.key, "api");
  assert.equal(k?.at, 1788576000);
  assert.equal(k?.text, "answered: use REST");
});

test("parseStatusZeile: ohne Zeit, kaputte Zeit, doppeltes at, Fortsetzungstext", () => {
  assert.equal(parseStatusZeile("done: PR https://github.com/o/r/pull/1 checks green")?.at, null);
  assert.equal(parseStatusZeile("working [at=<epoch>]: x")?.at, null);
  assert.equal(parseStatusZeile("working [at=1] [at=2]: x")?.at, null);
  assert.equal(parseStatusZeile("Reason: kein Verb"), null);
  assert.equal(parseStatusZeile("10:30 Uhr"), null);
  assert.equal(parseStatusZeile("blocked by flaky CI: retrying"), null);
  assert.equal(parseStatusZeile("working on X: details"), null);
  assert.equal(parseStatusZeile("[key=a] blocked [at=1] extra: x"), null);
  assert.equal(parseStatusZeile("[key=a] blocked [corr=c d]: x")?.key, "a");
  assert.equal(parseStatusZeile("ohne Doppelpunkt"), null);
});

test("offeneFragen: resolved schliesst nur den eigenen key", () => {
  const zeilen = parseStatus(
    [
      "working [at=1]: los",
      "needs-decision [at=2] [key=a]: Frage A",
      "blocked [at=3]: haengt",
      "needs-decision [at=4] [key=b]: Frage B",
      "resolved [at=5] [key=a]: A beantwortet",
      "done [at=6]: fertig",
    ].join("\n"),
  );
  assert.deepEqual(offeneFragen(zeilen).map((z) => z.text), ["haengt", "Frage B"]);
  assert.deepEqual(offeneFragen(parseStatus("blocked: x\nresolved: weiter")), []);
});

test("zaehleBacklog und backlogTitel", () => {
  const text = [
    "# Backlog",
    "## In flight",
    "- [ ] a-1 - Erste Aufgabe (repo: live-plan) (kind: ship) (since 2026-10-12)",
    "  Beschreibung",
    "- [ ] b-2 - Zweite (repo: x)",
    "## Queued",
    "## Held",
    "- [ ] c-3 - Gehalten",
    "## Done",
    "- [x] d-4 - Fertig (done 2026-10-12)",
  ].join("\n");
  assert.deepEqual(zaehleBacklog(text), { "In flight": 2, Queued: 0, Held: 1, Done: 1 });
  assert.equal(backlogTitel(text, "a-1"), "Erste Aufgabe");
  assert.equal(backlogTitel(text, "d-4"), "Fertig");
  assert.equal(backlogTitel(text, "fehlt"), null);
});

test("parseGitStatus: Zweig, Upstream, ahead/behind, geaenderte Pfade", () => {
  const st = parseGitStatus("# branch.oid abc\n# branch.head fm/x\n# branch.upstream origin/fm/x\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 a b f.ts\n? neu.ts\n");
  assert.deepEqual(st, { zweig: "fm/x", upstream: "origin/fm/x", ahead: 2, behind: 1, geaendert: 2 });
  assert.deepEqual(parseGitStatus("# branch.head (detached)\n"), { zweig: "(detached)", upstream: null, ahead: null, behind: null, geaendert: 0 });
});

test("paneZeilen: Rahmen, leere Eingabe und Fusszeile fallen weg", () => {
  const pane = ["Erste", "──────", "❯ ", "──────", "  ⏵⏵ bypass permissions on", "", "Zweite"].join("\n");
  assert.deepEqual(paneZeilen(pane, 4), ["Erste", "Zweite"]);
});

test("alter und q", () => {
  assert.equal(alter(30), "30s");
  assert.equal(alter(600), "10m");
  assert.equal(alter(7200), "2h");
  assert.equal(alter(3 * 86400), "3d");
  assert.equal(q("/work/firstmate"), "/work/firstmate");
  assert.equal(q("a b'c"), `'a b'\\''c'`);
});

test("lagebild und klartext auf einem Beispiel-Home ohne tmux-Fenster", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "cockpit-test-"));
  mkdirSync(path.join(home, "state", "t-1.inbox", "handled"), { recursive: true });
  mkdirSync(path.join(home, "data", "t-1"), { recursive: true });
  writeFileSync(path.join(home, "state", "t-1.meta"), "window=cockpit-test-gibt-es-nicht:fm-t-1\nworktree=/gibt/es/nicht\nproject=/p\nkind=ship\nmode=no-mistakes\nharness=claude\nbranch=fm/t-1\npr=https://github.com/o/r/pull/7\nspawn_gen=s1000.1.2\n");
  writeFileSync(path.join(home, "state", "t-1.status"), "working [at=1000]: los\nneeds-decision [at=1100] [key=k]: welche Option?\n");
  writeFileSync(path.join(home, "state", "t-1.inbox", "001.msg"), "x");
  writeFileSync(path.join(home, "data", "t-1", "brief.md"), "# Brief");
  writeFileSync(path.join(home, "data", "backlog.md"), "## In flight\n- [ ] t-1 - Testaufgabe (repo: r)\n## Queued\n");

  const l = lagebild({ home, pane: false });
  assert.equal(l.worker.length, 1);
  const w = l.worker[0];
  assert.equal(w.titel, "Testaufgabe");
  assert.equal(w.gestartet, 1000);
  assert.equal(w.status.letzte?.verb, "needs-decision");
  assert.equal(w.status.offen.length, 1);
  assert.deepEqual(w.inbox, { wartend: ["001.msg"], erledigt: 0 });
  assert.equal(w.worktree?.da, false);
  assert.deepEqual(l.backlog, { "In flight": 1, Queued: 0 });
  const zwecke = w.befehle.map((b) => b.zweck);
  assert.ok(zwecke.includes("oeffnen") && zwecke.includes("PR") && zwecke.includes("brief"));
  assert.ok(!zwecke.includes("Worktree"));

  const text = klartext(l);
  assert.match(text, /Worker: 1 {3}Backlog: In flight 1, Queued 0/);
  assert.match(text, /ENTSCHEID +\[k\] .*welche Option\?/);
  assert.match(text, /PR: +gh pr view https:\/\/github.com\/o\/r\/pull\/7 --web/);
  rmSync(home, { recursive: true, force: true });
});

test("lagebild erkennt ein lebendes tmux-Fenster samt Pane-Zeilen", { skip: spawnSync("tmux", ["-V"]).status !== 0 && "tmux fehlt" }, () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "cockpit-test-"));
  const alt = { TMUX_TMPDIR: process.env.TMUX_TMPDIR, TMUX: process.env.TMUX };
  process.env.TMUX_TMPDIR = home;
  delete process.env.TMUX;
  try {
    assert.equal(spawnSync("tmux", ["new-session", "-d", "-s", "cockpit-test", "-n", "fm-t-1", "sh -c 'echo hallo-pane; sleep 30'"]).status, 0);
    mkdirSync(path.join(home, "state"), { recursive: true });
    writeFileSync(path.join(home, "state", "t-1.meta"), "window=cockpit-test:fm-t-1\n");
    let w = lagebild({ home, pane: true }).worker[0];
    for (let i = 0; i < 20 && !w.fenster.pane?.includes("hallo-pane"); i++) {
      spawnSync("sleep", ["0.1"]);
      w = lagebild({ home, pane: true }).worker[0];
    }
    assert.equal(w.fenster.lebt, true);
    assert.ok(w.fenster.befehl);
    assert.ok(w.fenster.aktivitaet && w.fenster.aktivitaet > 0);
    assert.ok(w.fenster.pane?.includes("hallo-pane"));
  } finally {
    spawnSync("tmux", ["kill-server"]);
    for (const [k, v] of Object.entries(alt)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(home, { recursive: true, force: true });
  }
});

// Ein Worker fuer die Live-Ansicht, ohne Dateien und tmux.
function beispiel(id: string, statusText: string, mehr: Partial<Worker> = {}): Worker {
  const zeilen = parseStatus(statusText);
  return {
    id,
    titel: null,
    meta: { project: "/src/live-plan", kind: "ship", mode: "no-mistakes", harness: "claude", model: "opus", window: `firstmate:fm-${id}`, pr: "https://github.com/o/r/pull/7" },
    gestartet: 1000,
    fenster: { ziel: `firstmate:fm-${id}`, lebt: true, befehl: "claude", aktivitaet: 1900, pane: null },
    busy: null,
    status: { letzte: zeilen.at(-1) ?? null, zeilen: zeilen.length, offen: offeneFragen(zeilen) },
    inbox: null,
    worktree: { pfad: "/wt", da: true, zweig: `fm/${id}`, upstream: "origin/main", ahead: 2, behind: 1, geaendert: 3, letzterCommit: null },
    daten: { ordner: "/d", dateien: [] },
    befehle: [],
    ...mehr,
  };
}

const ohneFarbe: Rahmen = { spalten: 100, zeilen: 30, farbe: false, inTmux: false, takt: 5 };

test("breite und passend: kuerzen mit …, auffuellen, breite Zeichen, kein Umbruch", () => {
  assert.equal(breite("abc"), 3);
  assert.equal(breite("\x1b[31mab\x1b[0m"), 2);
  assert.equal(breite("日本"), 4);
  assert.equal(breite("é"), 1);
  assert.equal(passend("abc", 5), "abc  ");
  assert.equal(passend("abcdef", 4), "abc…");
  assert.equal(passend("a\nb", 3), "a b");
  assert.equal(passend("日本語", 4), "日… ");
  assert.equal(breite(passend("日本語", 4)), 4);
  assert.equal(passend("x", 0), "");
});

test("raster: Kaesten je Zeile nach Terminalbreite, nie breiter als das Terminal", () => {
  assert.deepEqual(raster(80, 3), { proZeile: 1, breite: 64 });
  assert.deepEqual(raster(120, 3), { proZeile: 2, breite: 59 });
  assert.deepEqual(raster(200, 3), { proZeile: 3, breite: 64 });
  assert.deepEqual(raster(200, 1), { proZeile: 1, breite: 64 });
  assert.equal(raster(30, 2).breite, 30);
  for (const sp of [20, KASTEN_MIN, 81, 123, 250]) {
    const r = raster(sp, 9);
    assert.ok(r.proZeile * r.breite + r.proZeile - 1 <= sp, `spalten ${sp}`);
  }
});

test("zustand: offene Frage, Blocker, letzte Zeile, totes Fenster", () => {
  assert.equal(zustand(beispiel("a", "working [at=1]: los")), "working");
  assert.equal(zustand(beispiel("a", "needs-decision [at=1] [key=k]: ?\nworking [at=2]: weiter")), "needs-decision");
  assert.equal(zustand(beispiel("a", "blocked [at=1]: x\nresolved [at=2]: ok")), "working");
  assert.equal(zustand(beispiel("a", "blocked [at=1]: x")), "blocked");
  assert.equal(zustand(beispiel("a", "paused [at=1]: wartet")), "paused");
  assert.equal(zustand(beispiel("a", "failed [at=1]: aus")), "failed");
  const tot = { ziel: "s:w", lebt: false, befehl: null, aktivitaet: null, pane: null };
  assert.equal(zustand(beispiel("a", "working [at=1]: los", { fenster: tot })), "dead");
  assert.equal(zustand(beispiel("a", "done [at=1]: fertig", { fenster: tot })), "done");
  assert.equal(zustand(beispiel("a", "")), "unknown");
});

test("prKurz und oeffnenKurz", () => {
  assert.equal(prKurz("https://github.com/o/r/pull/7"), "o/r#7");
  assert.equal(prKurz("https://gitlab.example/x/-/merge_requests/3"), "https://gitlab.example/x/-/merge_requests/3");
  const w = beispiel("a", "");
  assert.equal(oeffnenKurz(w, false), "tmux attach -t firstmate:fm-a");
  assert.equal(oeffnenKurz(w, true), "tmux switch-client -t firstmate:fm-a");
  assert.equal(oeffnenKurz(beispiel("a", "", { fenster: { ziel: null, lebt: null, befehl: null, aktivitaet: null, pane: null } }), false), null);
});

test("kasten: Titel mit Zustand, dichte Zeilen, alle gleich breit, gekuerzt statt umbrochen", () => {
  const w = beispiel("ein-sehr-langer-auftragsname-der-nicht-passt", `working [at=1700]: ${"lang ".repeat(30)}`);
  const k = kasten(w, 2000, 44, 6, ohneFarbe);
  assert.equal(k.length, 8);
  for (const z of k) assert.equal(breite(z), 44, z);
  assert.match(k[0], /^┌─ ● ein-sehr-langer.*… ─+ working ─┐$/);
  assert.equal(k[1], `│ ${passend("live-plan · ship/no-mistakes", 40)} │`);
  assert.match(k[2], /claude\/opus/);
  assert.match(k[3], /^│ 5m lang lang .*… │$/);
  assert.match(k[4], /PR o\/r#7/);
  assert.match(k[5], /fm\/ein-sehr-langer.*…/);
  assert.match(k[6], /\$ tmux attach -t firstmate:fm-ein-sehr/);
  assert.match(k[7], /^└─+┘$/);
  const bunt = kasten(w, 2000, 44, 6, { ...ohneFarbe, farbe: true });
  assert.match(bunt[0], /^\x1b\[32m┌/);
  assert.ok(bunt.every((z) => breite(z) === 44));
});

test("bild: Kopf, Raster, Fusszeile, passt in das Terminal und zaehlt was nicht passt", () => {
  const l: Lagebild = {
    home: "/work/firstmate",
    zeit: 2000,
    tmux: true,
    backlog: { "In flight": 3, Queued: 1 },
    worker: [beispiel("a", "working [at=1990]: los"), beispiel("b", "needs-decision [at=1500] [key=k]: welche?"), beispiel("c", "done [at=1900]: fertig")],
  };
  const voll = bild(l, ohneFarbe);
  assert.match(voll[0], /^Firstmate-Cockpit {2}\/work\/firstmate {2}3 Worker {2}In flight 3, Queued 1 {2}00:33:20Z$/);
  assert.match(voll.at(-1) ?? "", /alle 5s · q\/Strg-C beenden · --once/);
  assert.equal(voll.length, 2 + 2 * 8 + 1);
  assert.match(voll[2], /┌─ ● a .* working ─┐ ┌─ \? b .* needs-decision ─┐$/);
  assert.match(voll[10], /┌─ ✓ c .* done ─┐$/);
  for (const z of voll) assert.ok(breite(z) <= 100, z);

  const eng = bild(l, { ...ohneFarbe, spalten: 50, zeilen: 14 });
  assert.equal(eng.length, 2 + 8 + 1);
  assert.match(eng.at(-1) ?? "", /^\+2 Worker passen nicht/);
  for (const z of eng) assert.ok(breite(z) <= 50, z);

  assert.match(bild({ ...l, worker: [] }, ohneFarbe).join("\n"), /keine Worker/);
});

test("Aufruf ohne Terminal und mit --once/--json gibt einmal aus und endet", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "cockpit-test-"));
  mkdirSync(path.join(home, "state"), { recursive: true });
  writeFileSync(path.join(home, "state", "t-1.meta"), "kind=ship\n");
  const skript = path.join(import.meta.dirname, "cockpit.ts");
  try {
    for (const args of [[], ["--once"], ["--json"]]) {
      const r = spawnSync(process.execPath, [skript, "--home", home, ...args], { encoding: "utf8", timeout: 10000 });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, args[0] === "--json" ? /"id": "t-1"/ : /== t-1/);
      assert.doesNotMatch(r.stdout, /\x1b\[\?1049h/);
    }
    assert.equal(spawnSync(process.execPath, [skript, "--home", home, "--once", "--json"]).status, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
