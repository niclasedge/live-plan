// firstmate: Tests des gemeinsamen Moduls, `node --test firstmate.test.ts`.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import * as firstmate from "./firstmate.ts";
import { firstmateSicht, githubRepo, holePrs, istFirstmateHome, leseProjekte, parseProjekte, prVorrat, VERLAUF_N } from "./firstmate.ts";
import type { GhLauf } from "./firstmate.ts";
import * as cockpit from "./cockpit.ts";

// Ein leeres Home mit dem Aufbau, an dem man es erkennt.
function neuesHome(name = "fm-test-"): string {
  const home = mkdtempSync(path.join(os.tmpdir(), name));
  mkdirSync(path.join(home, "bin"), { recursive: true });
  mkdirSync(path.join(home, "state"), { recursive: true });
  mkdirSync(path.join(home, "data"), { recursive: true });
  writeFileSync(path.join(home, "bin", "fm-spawn.sh"), "#!/bin/sh\n");
  return home;
}

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

test("cockpit.ts reicht die gemeinsame Logik unveraendert weiter", () => {
  for (const name of ["parseMeta", "parseStatus", "offeneFragen", "warteschlange", "lagebild", "zustand", "prKurz", "istFirstmateHome"]) {
    assert.equal((cockpit as Record<string, unknown>)[name], (firstmate as Record<string, unknown>)[name], name);
  }
});

test("istFirstmateHome: am Aufbau erkannt, nicht am Namen", () => {
  const home = neuesHome("irgendwas-");
  const halb = mkdtempSync(path.join(os.tmpdir(), "firstmate-"));
  mkdirSync(path.join(halb, "state"));
  mkdirSync(path.join(halb, "data"));
  try {
    assert.equal(istFirstmateHome(home), true);
    assert.equal(istFirstmateHome(halb), false, "Name firstmate-* und state/ allein reichen nicht");
    mkdirSync(path.join(halb, "bin", "fm-spawn.sh"), { recursive: true });
    assert.equal(istFirstmateHome(halb), false, "fm-spawn.sh muss eine Datei sein");
    assert.equal(istFirstmateHome(path.join(home, "gibt-es-nicht")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(halb, { recursive: true, force: true });
  }
});

test("parseProjekte: Name, Haltung, Beschreibung und Datum aus data/projects.md", () => {
  const text = [
    "# Projects",
    "",
    "- live-plan [no-mistakes-prod-only] - public agent skill (niclasedge, via github-privat) (added 2026-10-13)",
    "- ops-lab [no-mistakes-prod-only +yolo] - gates, templates (DGK-Development) (added 2026-10-12)",
    "- nackt",
    "- ohne-haltung - nur Text",
    "Fliesstext - kein Eintrag",
  ].join("\n");
  assert.deepEqual(parseProjekte(text), [
    { name: "live-plan", haltung: "no-mistakes-prod-only", beschreibung: "public agent skill (niclasedge, via github-privat)", seit: "2026-10-13" },
    { name: "ops-lab", haltung: "no-mistakes-prod-only +yolo", beschreibung: "gates, templates (DGK-Development)", seit: "2026-10-12" },
    { name: "nackt", haltung: null, beschreibung: "", seit: null },
    { name: "ohne-haltung", haltung: null, beschreibung: "nur Text", seit: null },
  ]);
});

test("githubRepo: https, scp-Form, ssh:// und SSH-Alias; anderes ist kein GitHub", () => {
  const o = { owner: "o", repo: "r" };
  assert.deepEqual(githubRepo("https://github.com/o/r.git\n"), o);
  assert.deepEqual(githubRepo("https://github.com/o/r"), o);
  assert.deepEqual(githubRepo("git@github.com:o/r.git"), o);
  assert.deepEqual(githubRepo("ssh://git@github.com:22/o/r.git"), o);
  assert.deepEqual(githubRepo("git@github-privat:niclasedge/live-plan.git"), { owner: "niclasedge", repo: "live-plan" });
  assert.equal(githubRepo("https://gitlab.com/o/r.git"), null);
  assert.equal(githubRepo("/srv/git/r.git"), null);
  assert.equal(githubRepo("https://github.com/o/r/x"), null);
  assert.equal(githubRepo("git@github.com:o/..git"), null);
});

test("leseProjekte: Git-Stand, letzter Commit, letzter fetch, Register und Worker je Klon", () => {
  const home = neuesHome();
  try {
    const remote = path.join(home, "remote.git");
    git(home, "init", "-q", "--bare", "-b", "main", remote);
    const a = path.join(home, "projects", "alpha");
    mkdirSync(a, { recursive: true });
    git(a, "init", "-q", "-b", "main");
    writeFileSync(path.join(a, "x.txt"), "1\n");
    git(a, "add", "x.txt");
    git(a, "commit", "-q", "-m", "erster Stand");
    git(a, "remote", "add", "origin", remote);
    git(a, "push", "-q", "-u", "origin", "main");
    git(a, "fetch", "-q", "origin");
    utimesSync(path.join(a, ".git", "FETCH_HEAD"), 1_700_000_000, 1_700_000_000);
    writeFileSync(path.join(a, "x.txt"), "2\n");
    git(a, "commit", "-q", "-am", "zweiter Stand");
    writeFileSync(path.join(a, "neu.txt"), "n\n");
    git(a, "remote", "set-url", "origin", "git@github-privat:o/alpha.git");
    mkdirSync(path.join(home, "projects", "beta"), { recursive: true });
    writeFileSync(path.join(home, "data", "projects.md"), "- alpha [no-mistakes] - das Alpha-Projekt (added 2026-10-13)\n");

    const worker = [
      { id: "w-1", meta: { project: a } },
      { id: "w-2", meta: { project: "/anderswo/beta" } },
      { id: "w-3", meta: {} },
    ] as unknown as Parameters<typeof leseProjekte>[1];
    const [alpha, beta] = leseProjekte(home, worker);
    assert.equal(alpha.name, "alpha");
    assert.equal(alpha.git, true);
    assert.equal(alpha.zweig, "main");
    assert.equal(alpha.upstream, "origin/main");
    assert.equal(alpha.ahead, 1);
    assert.equal(alpha.behind, 0);
    assert.equal(alpha.geaendert, 1);
    assert.equal(alpha.commit?.betreff, "zweiter Stand");
    assert.ok(alpha.commit && Math.abs(alpha.commit.zeit - Date.now() / 1000) < 600);
    assert.equal(alpha.abgerufen, 1_700_000_000);
    assert.deepEqual(alpha.github, { owner: "o", repo: "alpha" });
    assert.deepEqual(alpha.register, { name: "alpha", haltung: "no-mistakes", beschreibung: "das Alpha-Projekt", seit: "2026-10-13" });
    assert.deepEqual(alpha.worker, ["w-1"]);

    assert.equal(beta.git, false);
    assert.equal(beta.register, null);
    assert.equal(beta.commit, null);
    assert.deepEqual(beta.worker, ["w-2"]);
    // nur lesend: keine Sperre und kein neuer Index-Stand im Klon
    assert.doesNotMatch(git(a, "status", "--porcelain"), /index\.lock/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// gh-Ersatz: zaehlt Aufrufe und merkt sich die Umgebung je Aufruf.
function ghMit(antwort: (args: string[]) => string | null) {
  const aufrufe: { args: string[]; env: Record<string, string> }[] = [];
  const gh: GhLauf = async (args, env) => {
    aufrufe.push({ args, env });
    return antwort(args);
  };
  return { gh, aufrufe };
}

test("holePrs: Token des Besitzers nur fuer den einen pr-Aufruf, sonst der aktive Login", async () => {
  const mitLogin = ghMit((args) =>
    args[0] === "auth" ? "tok-geheim\n" : JSON.stringify([{ number: 3, title: "Neu", url: "https://github.com/o/r/pull/3", isDraft: true, headRefName: "fm/x" }, { number: 4, url: "javascript:alert(1)" }]),
  );
  const prs = await holePrs(mitLogin.gh, { owner: "o", repo: "r" });
  assert.deepEqual(prs, [{ nummer: 3, titel: "Neu", url: "https://github.com/o/r/pull/3", entwurf: true, zweig: "fm/x" }]);
  assert.deepEqual(mitLogin.aufrufe[0], { args: ["auth", "token", "--user", "o"], env: {} });
  assert.deepEqual(mitLogin.aufrufe[1].env, { GH_TOKEN: "tok-geheim" });
  assert.ok(mitLogin.aufrufe[1].args.includes("o/r"));

  const ohneLogin = ghMit((args) => (args[0] === "auth" ? null : "[]"));
  assert.deepEqual(await holePrs(ohneLogin.gh, { owner: "fremd", repo: "r" }), []);
  assert.deepEqual(ohneLogin.aufrufe[1].env, {}, "ohne Login des Besitzers gilt der aktive");
});

test("prVorrat: laedt, dann Ergebnis; gh-Fehler heisst unbekannt; 60 s vorgehalten; kein Token im Stand", async () => {
  let uhr = 1_000_000;
  let kaputt = true;
  const g = ghMit((args) => (args[0] === "auth" ? "tok-geheim" : kaputt ? null : JSON.stringify([{ number: 1, title: "A", url: "https://github.com/o/r/pull/1" }])));
  const v = prVorrat(g.gh, 60_000, () => uhr);
  const r = { owner: "o", repo: "r" };
  assert.deepEqual(v.stand(r), { art: "laedt" });
  await v.fertig();
  assert.deepEqual(v.stand(r), { art: "unbekannt", um: 1_000_000 });
  assert.equal(g.aufrufe.length, 2, "ein Fehler wird nicht bei jeder Anfrage wiederholt");

  kaputt = false;
  uhr += 59_000;
  v.stand(r);
  await v.fertig();
  assert.equal(g.aufrufe.length, 2, "innerhalb der Frist kein neuer Aufruf");
  uhr += 2_000;
  assert.equal(v.stand(r).art, "unbekannt", "der alte Stand kommt sofort, gh laeuft im Hintergrund");
  await v.fertig();
  const stand = v.stand(r);
  assert.equal(stand.art, "ok");
  assert.equal(stand.art === "ok" && stand.prs[0].url, "https://github.com/o/r/pull/1");
  assert.doesNotMatch(JSON.stringify(stand), /tok-geheim/);

  // ein werfendes gh ist ebenfalls unbekannt, keine Ausnahme nach aussen
  const wirft = prVorrat(async () => {
    throw new Error("gh fehlt");
  });
  wirft.stand(r);
  await wirft.fertig();
  assert.equal(wirft.stand(r).art, "unbekannt");
});

test("firstmateSicht: Zustand, Verlauf, nur sichtbare Meta, Projekte; ohne tmux-Fenster", () => {
  const home = neuesHome();
  const alt = { TMUX_TMPDIR: process.env.TMUX_TMPDIR, TMUX: process.env.TMUX };
  try {
    const status = Array.from({ length: VERLAUF_N + 3 }, (_, i) => `working [at=${1000 + i}]: Schritt ${i}`);
    status.push("needs-decision [at=2000] [key=k]: welche Option?");
    writeFileSync(path.join(home, "state", "t-1.meta"), "project=/p/alpha\nkind=ship\nharness=claude\ntasktmp=/tmp/x\ngeheim=1\n");
    writeFileSync(path.join(home, "state", "t-1.status"), status.join("\n") + "\n");
    writeFileSync(path.join(home, "data", "backlog.md"), "## In flight\n- [ ] t-1 - Testaufgabe (repo: alpha)\n## Queued\n- [ ] q-2 - Danach blocked-by: t-1 (repo: alpha)\n");
    mkdirSync(path.join(home, "projects", "alpha"), { recursive: true });
    // ein eigener tmux-Ordner ohne Server: das Fenster ist unbekannt, nicht tot
    process.env.TMUX_TMPDIR = home;
    delete process.env.TMUX;
    const s = firstmateSicht(home);
    const [w] = s.worker;
    assert.equal(w.zustand, "needs-decision");
    assert.equal(w.titel, "Testaufgabe");
    assert.equal(w.verlauf.length, VERLAUF_N);
    assert.equal(w.verlauf.at(-1)?.text, "welche Option?");
    assert.deepEqual(w.meta, { project: "/p/alpha", kind: "ship", harness: "claude" });
    assert.equal("pane" in w.fenster, false);
    assert.deepEqual(s.warteschlange?.map((a) => [a.id, a.wartet]), [["q-2", "wartet auf t-1"]]);
    assert.deepEqual(s.projekte.map((p) => [p.name, p.worker]), [["alpha", ["t-1"]]]);
  } finally {
    for (const [k, v] of Object.entries(alt)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(home, { recursive: true, force: true });
  }
});

test("keine Pane-Zeilen in der Sicht und in der JSON fuer den Server", { skip: spawnSync("tmux", ["-V"]).status !== 0 && "tmux fehlt" }, () => {
  const home = neuesHome();
  const alt = { TMUX_TMPDIR: process.env.TMUX_TMPDIR, TMUX: process.env.TMUX };
  process.env.TMUX_TMPDIR = home;
  delete process.env.TMUX;
  try {
    assert.equal(spawnSync("tmux", ["new-session", "-d", "-s", "fm-pane-test", "-n", "fm-t-1", "sh -c 'echo pane-geheimnis-42; sleep 30'"]).status, 0);
    writeFileSync(path.join(home, "state", "t-1.meta"), "window=fm-pane-test:fm-t-1\n");
    // erst warten, bis das Pane den Text zeigt; das Cockpit mit Pane sieht ihn
    let mitPane = cockpit.lagebild({ home, pane: true });
    for (let i = 0; i < 20 && !mitPane.worker[0].fenster.pane?.includes("pane-geheimnis-42"); i++) {
      spawnSync("sleep", ["0.1"]);
      mitPane = cockpit.lagebild({ home, pane: true });
    }
    assert.ok(mitPane.worker[0].fenster.pane?.includes("pane-geheimnis-42"), "Vorbedingung: Pane traegt den Text");

    const s = firstmateSicht(home);
    assert.equal(s.worker[0].fenster.lebt, true);
    assert.doesNotMatch(JSON.stringify(s), /pane-geheimnis-42/);
    const r = spawnSync(process.execPath, [path.join(import.meta.dirname, "firstmate.ts"), "--json", home], { encoding: "utf8", env: process.env, timeout: 10000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).worker[0].id, "t-1");
    assert.doesNotMatch(r.stdout, /pane-geheimnis-42/);
  } finally {
    spawnSync("tmux", ["kill-server"]);
    for (const [k, v] of Object.entries(alt)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(home, { recursive: true, force: true });
  }
});

test("Aufruf: --json nur fuer ein Firstmate-Home", () => {
  const kein = mkdtempSync(path.join(os.tmpdir(), "fm-kein-"));
  const skript = path.join(import.meta.dirname, "firstmate.ts");
  try {
    assert.equal(spawnSync(process.execPath, [skript, "--json", kein]).status, 1);
    assert.equal(spawnSync(process.execPath, [skript]).status, 2);
  } finally {
    rmSync(kein, { recursive: true, force: true });
  }
});
