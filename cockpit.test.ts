// cockpit: Tests der reinen Logik, `node --test cockpit.test.ts`.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { alter, AUFTRAEGE_LIVE, backlogEintraege, backlogTitel, bild, breite, kasten, KASTEN_MIN, haltGrund, klartext, lagebild, lageZeilen, notizenText, offeneFragen, oeffnenKurz, paneZeilen, parseGitStatus, parseMeta, parseStatus, parseStatusZeile, passend, prKurz, q, raster, wartendeNotizen, warteschlange, zaehleBacklog, zustand } from "./cockpit.ts";
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

test("backlogEintraege: Tags, blocked-by und Bindestrich-Tags gehoeren nicht zum Titel", () => {
  const [e] = backlogEintraege("## Queued\n- [ ] a-1 - Titel (mit Klammer) blocked-by: b-2 blocked-by: c-3 (repo: r) (since 2026-10-12) (hold: x y) (hold-until: 2026-11-01)\n");
  assert.deepEqual(e, {
    id: "a-1",
    erledigt: false,
    abschnitt: "Queued",
    titel: "Titel (mit Klammer)",
    tags: { repo: "r", since: "2026-10-12", hold: "x y", "hold-until": "2026-11-01" },
    blockiertVon: ["b-2", "c-3"],
  });
  assert.equal(backlogTitel("- [ ] h-1 - Gehalten (repo: r) (hold: grund) (hold-kind: captain)", "h-1"), "Gehalten");
});

test("warteschlange: worauf jeder Auftrag wartet, wie tasks-axi es liest", () => {
  const text = [
    "## In flight",
    "- [ ] laeuft-a - Laeuft (repo: r) (since 2026-10-12)",
    "## Queued",
    "- [ ] dep-b - Haengt ab blocked-by: laeuft-a (repo: r) (since 2026-10-12)",
    "- [ ] frei-c - Abhaengigkeit fertig blocked-by: fertig-x blocked-by: archiviert-y (repo: r)",
    "- [ ] datum-d - Ab Datum (repo: r) (hold: nach dem Start) (hold-until: 2026-11-01)",
    "- [ ] alt-e - Datum vorbei (repo: r) (hold: x) (hold-until: 2026-10-12)",
    "- [ ] cap-f - Captain (repo: r) (hold: fm-hold-v1:RnJhZ2UgKG9mZmVuKQ==) (hold-kind: captain)",
    "- [ ] ext-g - Extern (repo: r) (hold: wartet auf Lieferant) (hold-kind: external)",
    "- [ ] beides-h - Beides blocked-by: dep-b (repo: r) (hold: y) (hold-kind: captain)",
    "- [ ] bereit-i - Bereit (repo: r) (priority: 1)",
    "## Held",
    "- [ ] alt-j - Alter Held-Abschnitt (repo: r)",
    "## Done",
    "- [x] fertig-x - Fertig (done 2026-10-12)",
  ].join("\n");
  const ws = warteschlange(text, "2026-10-12");
  assert.deepEqual(
    ws.map((a) => [a.id, a.wartet]),
    [
      ["dep-b", "wartet auf laeuft-a"],
      ["frei-c", "bereit"],
      ["datum-d", "bis 2026-11-01"],
      ["alt-e", "bereit"],
      ["cap-f", "fuer den Captain gehalten"],
      ["ext-g", "gehalten (external): wartet auf Lieferant"],
      ["beides-h", "wartet auf dep-b; fuer den Captain gehalten"],
      ["bereit-i", "bereit"],
      ["alt-j", "gehalten"],
    ],
  );
  assert.deepEqual(ws[4].halt, { grund: "Frage (offen)", art: "captain", bis: null });
  assert.equal(ws[1].titel, "Abhaengigkeit fertig");
  assert.equal(warteschlange("## In flight\n## Done\n", "2026-10-12").length, 0);
});

test("haltGrund: fm-hold-v1 dekodieren, alles andere wie es ist", () => {
  assert.equal(haltGrund(`fm-hold-v1:${Buffer.from("Zeile 1\nä").toString("base64")}`), "Zeile 1\nä");
  assert.equal(haltGrund("einfacher Grund"), "einfacher Grund");
  assert.equal(haltGrund("fm-hold-v1:kein base64!"), "fm-hold-v1:kein base64!");
  assert.equal(haltGrund(`fm-hold-v1:${Buffer.from([0xff, 0xfe]).toString("base64")}`), "fm-hold-v1://4=");
});

test("wartendeNotizen und notizenText: nur *.note-Dateien direkt in state/inbox/", () => {
  const namen = [
    { name: "20261012-a.note", datei: true },
    { name: "handled", datei: false },
    { name: ".announced", datei: false },
    { name: ".versteckt.note", datei: true },
    { name: "ordner.note", datei: false },
    { name: "x.tmp", datei: true },
    { name: "20261011-b.note", datei: true },
  ];
  assert.deepEqual(wartendeNotizen(namen), ["20261011-b", "20261012-a"]);
  assert.equal(notizenText(0), "keine Notiz wartet");
  assert.equal(notizenText(1), "1 Notiz wartet");
  assert.equal(notizenText(2), "2 Notizen warten");
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
  writeFileSync(path.join(home, "data", "backlog.md"), "## In flight\n- [ ] t-1 - Testaufgabe (repo: r)\n## Queued\n- [ ] q-2 - Danach blocked-by: t-1 (repo: r)\n");
  mkdirSync(path.join(home, "state", "inbox", "handled"), { recursive: true });
  writeFileSync(path.join(home, "state", "inbox", "n1.note"), "x");
  writeFileSync(path.join(home, "state", "inbox", "handled", "n0.note"), "x");

  const l = lagebild({ home, pane: false });
  assert.equal(l.worker.length, 1);
  const w = l.worker[0];
  assert.equal(w.titel, "Testaufgabe");
  assert.equal(w.gestartet, 1000);
  assert.equal(w.status.letzte?.verb, "needs-decision");
  assert.equal(w.status.offen.length, 1);
  assert.deepEqual(w.inbox, { wartend: ["001.msg"], erledigt: 0 });
  assert.equal(w.worktree?.da, false);
  assert.deepEqual(l.backlog, { "In flight": 1, Queued: 1 });
  assert.deepEqual(l.notizen, ["n1"]);
  assert.deepEqual(l.warteschlange?.map((a) => [a.id, a.wartet]), [["q-2", "wartet auf t-1"]]);
  const zwecke = w.befehle.map((b) => b.zweck);
  assert.ok(zwecke.includes("oeffnen") && zwecke.includes("PR") && zwecke.includes("brief"));
  assert.ok(!zwecke.includes("Worktree"));

  const text = klartext(l);
  assert.match(text, /Worker: 1 {3}Backlog: In flight 1, Queued 1/);
  assert.match(text, /^Captain-Inbox: 1 Notiz wartet \(n1\)$/m);
  assert.match(text, /^Warteschlange: 1\n {3}q-2 {2}\[wartet auf t-1\] {2}Danach$/m);
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

test("lagebild: tmux erreichbar heisst Server antwortet, auch ohne Worker", { skip: spawnSync("tmux", ["-V"]).status !== 0 && "tmux fehlt" }, () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "cockpit-test-"));
  const alt = { TMUX_TMPDIR: process.env.TMUX_TMPDIR, TMUX: process.env.TMUX };
  process.env.TMUX_TMPDIR = home;
  delete process.env.TMUX;
  try {
    mkdirSync(path.join(home, "state"), { recursive: true });
    assert.equal(lagebild({ home, pane: false }).tmux, false, "kein Server");
    assert.equal(spawnSync("tmux", ["new-session", "-d", "-s", "cockpit-leer", "sleep 30"]).status, 0);
    const l = lagebild({ home, pane: false });
    assert.equal(l.worker.length, 0);
    assert.equal(l.tmux, true);
    assert.doesNotMatch(klartext(l), /tmux nicht erreichbar/);
    assert.doesNotMatch(bild(l, { spalten: 100, zeilen: 30, farbe: false, inTmux: false, takt: 5 })[0], /tmux nicht erreichbar/);
    // Sitzung eines Workers fehlt, Server laeuft: das Fenster gilt als weg, nicht als unbekannt
    writeFileSync(path.join(home, "state", "t-1.meta"), "window=gibt-es-nicht:fm-t-1\n");
    assert.equal(lagebild({ home, pane: false }).worker[0].fenster.lebt, false);
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
  const post = kasten(beispiel("a", "working [at=1]: los", { inbox: { wartend: ["001.msg", "002.msg"], erledigt: 1 } }), 2000, 44, 6, ohneFarbe);
  assert.match(post[0], /^┌─ ● a ─+ ✉ 2 working ─┐$/);
  assert.equal(breite(post[0]), 44);
  assert.doesNotMatch(kasten(beispiel("a", "", { inbox: { wartend: [], erledigt: 3 } }), 2000, 44, 6, ohneFarbe)[0], /✉/);
  assert.match(kasten(beispiel("ein-sehr-langer-auftragsname-der-nicht-passt", "", { inbox: { wartend: ["1.msg"], erledigt: 0 } }), 2000, 44, 6, ohneFarbe)[0], /….* ✉ 1 unknown ─┐$/);
  for (const b of [24, 25, 26, 30]) {
    for (const n of [1, 12]) {
      const eng = kasten(beispiel("a", "needs-decision [at=1]: frage", { inbox: { wartend: Array.from({ length: n }, (_, i) => `${i}.msg`), erledigt: 0 } }), 2000, b, 3, ohneFarbe);
      for (const z of eng) assert.equal(breite(z), b, `b=${b} n=${n}: ${z}`);
      assert.match(eng[0], / needs-decision ─┐$/);
    }
  }
  assert.doesNotMatch(kasten(beispiel("a", "needs-decision [at=1]: frage", { inbox: { wartend: ["1.msg"], erledigt: 0 } }), 2000, 24, 3, ohneFarbe)[0], /✉/);
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
    notizen: [],
    warteschlange: [],
    worker: [beispiel("a", "working [at=1990]: los"), beispiel("b", "needs-decision [at=1500] [key=k]: welche?"), beispiel("c", "done [at=1900]: fertig")],
  };
  const voll = bild(l, ohneFarbe);
  assert.match(voll[0], /^Firstmate-Cockpit {2}\/work\/firstmate {2}3 Worker {2}In flight 3, Queued 1 {2}00:33:20Z$/);
  assert.equal(voll[1], "Captain-Inbox: keine Notiz wartet · Warteschlange: leer");
  assert.match(voll.at(-1) ?? "", /alle 5s · q\/Strg-C beenden · --once/);
  assert.equal(voll.length, 3 + 2 * 8 + 1);
  assert.match(voll[3], /┌─ ● a .* working ─┐ ┌─ \? b .* needs-decision ─┐$/);
  assert.match(voll[11], /┌─ ✓ c .* done ─┐$/);
  for (const z of voll) assert.ok(breite(z) <= 100, z);

  const eng = bild(l, { ...ohneFarbe, spalten: 50, zeilen: 14 });
  assert.equal(eng.length, 3 + 8 + 1);
  assert.match(eng.at(-1) ?? "", /^\+2 Worker passen nicht/);
  for (const z of eng) assert.ok(breite(z) <= 50, z);

  assert.match(bild({ ...l, worker: [] }, ohneFarbe).join("\n"), /keine Worker/);
});

test("lageZeilen und bild: Captain-Inbox und Warteschlange mit +N weitere", () => {
  const auftrag = (id: string, wartet: string) => ({ id, titel: `Titel ${id}`, blockiertVon: [], halt: null, wartet });
  const ws = [auftrag("a", "wartet auf x"), auftrag("b", "bis 2026-11-01"), auftrag("c", "fuer den Captain gehalten"), auftrag("d", "bereit"), auftrag("e", "bereit")];
  const l: Lagebild = { home: "/h", zeit: 2000, tmux: true, backlog: { Queued: 5 }, notizen: ["n1", "n2"], warteschlange: ws, worker: [beispiel("w", "working [at=1990]: los")] };
  assert.deepEqual(lageZeilen(l, AUFTRAEGE_LIVE), [
    "Captain-Inbox: 2 Notizen warten · Warteschlange: 5",
    "  a  [wartet auf x]  Titel a",
    "  b  [bis 2026-11-01]  Titel b",
    "  c  [fuer den Captain gehalten]  Titel c",
    "  +2 weitere (--once)",
  ]);
  assert.deepEqual(lageZeilen({ ...l, warteschlange: ws.slice(0, 3) }, 3).length, 4);
  assert.deepEqual(lageZeilen({ ...l, notizen: [], warteschlange: null }, 3), ["Captain-Inbox: keine Notiz wartet · Warteschlange: kein Backlog"]);
  const b = bild(l, ohneFarbe);
  assert.deepEqual(b.slice(1, 6), lageZeilen(l, AUFTRAEGE_LIVE));
  assert.equal(b[6], "");
  assert.match(b[7], /^┌─ ● w /);
  assert.match(bild(l, { ...ohneFarbe, farbe: true })[1], /^\x1b\[33mCaptain-Inbox: 2 Notizen warten/);
  // ein kurzes Terminal kuerzt die Lage, statt ueber den Rand zu laufen
  const kurz = bild(l, { ...ohneFarbe, zeilen: 6 });
  assert.ok(kurz.length <= 6, String(kurz.length));
  assert.match(kurz.at(-1) ?? "", /^\+1 Worker passen nicht/);
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
