// cockpit: Tests der reinen Logik, `node --test cockpit.test.ts`.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { alter, backlogTitel, klartext, lagebild, offeneFragen, paneZeilen, parseGitStatus, parseMeta, parseStatus, parseStatusZeile, q, zaehleBacklog } from "./cockpit.ts";

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
