#!/usr/bin/env node
// cockpit: Firstmate-Cockpit, zeigt die Worker eines Firstmate-Home mit allen greifbaren Details und
// je Worker fertige Befehle zum Oeffnen und Pruefen. Laeuft mit node >= 22.18 (eingebautes
// Type-Stripping) und bun.
//
//   cockpit [--home PFAD] [--json] [--watch [SEK]] [--keine-pane]
//
//   --home PFAD    Firstmate-Home; sonst FM_HOME, sonst /work/firstmate
//   --json         alles als JSON statt Klartext
//   --watch [SEK]  Anzeige alle SEK Sekunden (Vorgabe 5) neu aufbauen, Ende mit Strg-C
//   --keine-pane   die letzten Zeilen des tmux-Panes nicht lesen
//
// Nur lesend: das Skript schreibt nichts in state/, data/ oder das Backlog und sendet nichts an
// Worker. Es liest state/<id>.meta, state/<id>.status, state/<id>.busy-state, state/<id>.inbox/,
// data/<id>/ und data/backlog.md, fragt tmux nach Fenstern und Panes und git (ohne optionale
// Index-Sperren) nach dem Stand der Worktrees. bin/fm-crew-state.sh ruft es nicht selbst auf, denn
// das kann fuer muse-Worker einen Cache in state/ schreiben; der Befehl steht unter "Zustand".

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// --- reine Logik --------------------------------------------------------------------------

export type Meta = Record<string, string>;

// key=value je Zeile; der letzte Eintrag eines Schluessels gilt (wie meta_value in fm-crew-state.sh).
export function parseMeta(text: string): Meta {
  const meta: Meta = {};
  for (const zeile of text.split("\n")) {
    const i = zeile.indexOf("=");
    if (i <= 0) continue;
    const schluessel = zeile.slice(0, i).trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(schluessel)) continue;
    meta[schluessel] = zeile.slice(i + 1).replace(/\r$/, "");
  }
  return meta;
}

export interface StatusZeile {
  verb: string;
  at: number | null;
  key: string | null;
  text: string;
  roh: string;
}

const VERBEN = ["working", "paused", "blocked", "needs-decision", "resolved", "done", "failed", "captain-held"];

// `verb [at=<epoch>] [key=<slug>] [corr=...]: text`; Tags in beliebiger Reihenfolge, nur vor dem
// ersten Doppelpunkt. Eine Zeile, deren Kopf nicht genau ein Verb plus Tags ist, ist
// Fortsetzungstext und liefert null.
export function parseStatusZeile(roh: string): StatusZeile | null {
  const zeile = roh.replace(/\r$/, "");
  const i = zeile.indexOf(":");
  if (i < 0) return null;
  const kopf = zeile.slice(0, i).trim();
  const verb = kopf.replace(/\[[^\]]*\]/g, " ").trim();
  if (!VERBEN.includes(verb)) return null;
  let at: number | null = null;
  let key: string | null = null;
  let atZahl = 0;
  for (const m of kopf.matchAll(/\[(at|key)=([^\]]*)\]/g)) {
    if (m[1] === "at") {
      atZahl++;
      at = /^(0|[1-9][0-9]{0,11})$/.test(m[2]) ? Number(m[2]) : null;
    } else key = m[2];
  }
  if (atZahl > 1) at = null; // doppeltes at= heisst unbekannte Zeit (fm-classify-lib.sh)
  return { verb, at, key, text: zeile.slice(i + 1).trim(), roh: zeile };
}

export function parseStatus(text: string): StatusZeile[] {
  return text.split("\n").map(parseStatusZeile).filter((z): z is StatusZeile => z !== null);
}

// Offene Entscheidungen und Blocker: needs-decision/blocked bleibt offen, bis ein resolved mit
// demselben key folgt; ohne key gilt der gemeinsame Schluessel "" der schluessellosen Zeilen.
export function offeneFragen(zeilen: StatusZeile[]): StatusZeile[] {
  const offen = new Map<string, StatusZeile>();
  for (const z of zeilen) {
    const k = z.key ?? "";
    if (z.verb === "needs-decision" || z.verb === "blocked") offen.set(`${z.verb}\u0000${k}`, z);
    else if (z.verb === "resolved") {
      offen.delete(`needs-decision\u0000${k}`);
      offen.delete(`blocked\u0000${k}`);
    }
  }
  return [...offen.values()];
}

// Abschnitte `## Name` mit Zaehlung der Eintraege `- [ ]` / `- [x]` darunter.
export function zaehleBacklog(text: string): Record<string, number> {
  const zahl: Record<string, number> = {};
  let abschnitt: string | null = null;
  for (const zeile of text.split("\n")) {
    const kopf = /^##\s+(.+?)\s*$/.exec(zeile);
    if (kopf) {
      abschnitt = kopf[1];
      zahl[abschnitt] ??= 0;
    } else if (abschnitt && /^- \[[ xX]\] /.test(zeile)) zahl[abschnitt]++;
  }
  return zahl;
}

// Titel eines Backlog-Eintrags `- [ ] <id> - <titel> (repo: ...)`.
export function backlogTitel(text: string, id: string): string | null {
  for (const zeile of text.split("\n")) {
    const m = /^- \[[ xX]\] (\S+) - (.*)$/.exec(zeile);
    if (m && m[1] === id) return m[2].replace(/(\s+\([a-z]+[: ][^)]*\))+\s*$/, "").trim();
  }
  return null;
}

// `git status --porcelain=v2 --branch`: Zweig, ahead/behind, Upstream und Zahl geaenderter Pfade.
export function parseGitStatus(text: string): { zweig: string | null; upstream: string | null; ahead: number | null; behind: number | null; geaendert: number } {
  let zweig: string | null = null;
  let upstream: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;
  let geaendert = 0;
  for (const zeile of text.split("\n")) {
    if (zeile.startsWith("# branch.head ")) zweig = zeile.slice(14);
    else if (zeile.startsWith("# branch.upstream ")) upstream = zeile.slice(18);
    else if (zeile.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(zeile);
      if (m) [ahead, behind] = [Number(m[1]), Number(m[2])];
    } else if (zeile && !zeile.startsWith("#")) geaendert++;
  }
  return { zweig, upstream, ahead, behind, geaendert };
}

// Die letzten Zeilen eines Panes mit Inhalt: ohne Rahmen, leere Eingabezeile und Fusszeile der Harness.
export function paneZeilen(text: string, anzahl: number): string[] {
  return text
    .split("\n")
    .map((z) => z.trimEnd())
    .filter((z) => /[\p{L}\p{N}]/u.test(z) && !/^\s*(⏵|\? for shortcuts)/.test(z))
    .slice(-anzahl);
}

export function alter(sekunden: number): string {
  if (sekunden < 0) return "in der Zukunft";
  if (sekunden < 90) return `${Math.round(sekunden)}s`;
  if (sekunden < 5400) return `${Math.round(sekunden / 60)}m`;
  if (sekunden < 172800) return `${Math.round(sekunden / 3600)}h`;
  return `${Math.round(sekunden / 86400)}d`;
}

// Fuer die Shell gequotet, nur wenn noetig.
export function q(wert: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(wert) ? wert : `'${wert.replace(/'/g, `'\\''`)}'`;
}

// --- Lesen ---------------------------------------------------------------------------------

function lies(datei: string): string | null {
  try {
    return readFileSync(datei, "utf8");
  } catch {
    return null;
  }
}

function lauf(befehl: string, args: string[], cwd?: string): string | null {
  const r = spawnSync(befehl, args, { cwd, encoding: "utf8", timeout: 5000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  return r.status === 0 ? r.stdout : null;
}

interface Fenster {
  name: string;
  befehl: string;
  pid: string;
  aktivitaet: number;
  tot: boolean;
}

function tmuxFenster(sitzung: string): Map<string, Fenster> | null {
  const aus = lauf("tmux", ["list-windows", "-t", sitzung, "-F", "#{window_name}\t#{pane_current_command}\t#{pane_pid}\t#{window_activity}\t#{pane_dead}"]);
  if (aus === null) return null;
  const fenster = new Map<string, Fenster>();
  for (const zeile of aus.split("\n").filter(Boolean)) {
    const [name, befehl, pid, akt, tot] = zeile.split("\t");
    fenster.set(name, { name, befehl, pid, aktivitaet: Number(akt), tot: tot === "1" });
  }
  return fenster;
}

export interface Worker {
  id: string;
  titel: string | null;
  meta: Meta;
  gestartet: number | null;
  fenster: { ziel: string | null; lebt: boolean | null; befehl: string | null; aktivitaet: number | null; pane: string[] | null };
  busy: { zustand: string; quelle: string | null; ts: number | null } | null;
  status: { letzte: StatusZeile | null; zeilen: number; offen: StatusZeile[] };
  inbox: { wartend: string[]; erledigt: number } | null;
  worktree: { pfad: string | null; da: boolean; zweig: string | null; upstream: string | null; ahead: number | null; behind: number | null; geaendert: number | null; letzterCommit: string | null } | null;
  daten: { ordner: string; dateien: string[] };
  befehle: { zweck: string; befehl: string }[];
}

export interface Lagebild {
  home: string;
  zeit: number;
  tmux: boolean;
  backlog: Record<string, number> | null;
  worker: Worker[];
}

export interface Optionen {
  home: string;
  pane: boolean;
}

function leseWorker(o: Optionen, id: string, fenster: Map<string, Fenster> | null, backlog: string | null): Worker {
  const state = path.join(o.home, "state");
  const meta = parseMeta(lies(path.join(state, `${id}.meta`)) ?? "");
  const gen = /^s(\d+)\./.exec(meta.spawn_gen ?? "");

  const backend = meta.backend || "tmux";
  const ziel = meta.window || meta.terminal || null;
  const [sitzung, fensterName] = ziel && ziel.includes(":") ? [ziel.slice(0, ziel.indexOf(":")), ziel.slice(ziel.indexOf(":") + 1)] : [null, ziel];
  const f = backend === "tmux" && fenster && fensterName ? fenster.get(fensterName) : undefined;
  let pane: string[] | null = null;
  if (o.pane && f && ziel) {
    const aus = lauf("tmux", ["capture-pane", "-p", "-t", ziel]);
    if (aus !== null) pane = paneZeilen(aus, 4);
  }

  const busyRoh = lies(path.join(state, `${id}.busy-state`));
  const busyFelder = busyRoh ? parseMeta(busyRoh.trim().split(/\s+/).join("\n")) : null;
  const busy = busyFelder?.state ? { zustand: busyFelder.state, quelle: busyFelder.source ?? null, ts: busyFelder.ts ? Number(busyFelder.ts) : null } : null;

  const zeilen = parseStatus(lies(path.join(state, `${id}.status`)) ?? "");

  let inbox: Worker["inbox"] = null;
  try {
    const ordner = path.join(state, `${id}.inbox`);
    const wartend = readdirSync(ordner).filter((n) => n.endsWith(".msg")).sort();
    const erledigt = existsSync(path.join(ordner, "handled")) ? readdirSync(path.join(ordner, "handled")).length : 0;
    inbox = { wartend, erledigt };
  } catch {}

  let worktree: Worker["worktree"] = null;
  if (meta.worktree) {
    const da = !meta.remote_host && existsSync(meta.worktree);
    worktree = { pfad: meta.worktree, da, zweig: null, upstream: null, ahead: null, behind: null, geaendert: null, letzterCommit: null };
    if (da) {
      const st = lauf("git", ["status", "--porcelain=v2", "--branch"], meta.worktree);
      if (st !== null) Object.assign(worktree, parseGitStatus(st));
      // ohne Upstream gegen den Standardzweig des Remote zaehlen
      const basis = worktree.upstream === null ? lauf("git", ["rev-parse", "--abbrev-ref", "origin/HEAD"], meta.worktree)?.trim() : null;
      const lr = basis ? lauf("git", ["rev-list", "--left-right", "--count", `${basis}...HEAD`], meta.worktree) : null;
      const m = lr ? /^(\d+)\s+(\d+)/.exec(lr) : null;
      if (basis && m) Object.assign(worktree, { upstream: basis, behind: Number(m[1]), ahead: Number(m[2]) });
      worktree.letzterCommit = lauf("git", ["log", "-1", "--format=%h %cr: %s"], meta.worktree)?.trim() || null;
    }
  }

  const ordner = path.join(o.home, "data", id);
  let dateien: string[] = [];
  try {
    dateien = readdirSync(ordner).sort();
  } catch {}

  const w: Worker = {
    id,
    titel: backlog ? backlogTitel(backlog, id) : null,
    meta,
    gestartet: gen ? Number(gen[1]) : null,
    fenster: { ziel, lebt: backend === "tmux" && fenster ? (f ? !f.tot : false) : null, befehl: f?.befehl ?? null, aktivitaet: f ? f.aktivitaet : null, pane },
    busy,
    status: { letzte: zeilen.at(-1) ?? null, zeilen: zeilen.length, offen: offeneFragen(zeilen) },
    inbox,
    worktree,
    daten: { ordner, dateien },
    befehle: [],
  };
  w.befehle = befehle(o.home, w, backend, sitzung);
  return w;
}

function befehle(home: string, w: Worker, backend: string, sitzung: string | null): { zweck: string; befehl: string }[] {
  const b: { zweck: string; befehl: string }[] = [];
  const state = path.join(home, "state");
  const ziel = w.fenster.ziel;
  if (backend === "tmux" && ziel) {
    b.push({ zweck: "oeffnen", befehl: `tmux switch-client -t ${q(ziel)} 2>/dev/null || tmux attach -t ${q(ziel)}` });
    b.push({ zweck: "Pane lesen", befehl: `tmux capture-pane -p -J -t ${q(ziel)} -S -200 | less -R +G` });
  } else if (ziel) b.push({ zweck: `oeffnen (${backend})`, befehl: `# Backend ${backend}, Ziel ${ziel}` });
  b.push({ zweck: "Status", befehl: `tail -n 20 -f ${q(path.join(state, `${w.id}.status`))}` });
  b.push({ zweck: "Zustand", befehl: `FM_HOME=${q(home)} ${q(path.join(home, "bin", "fm-crew-state.sh"))} ${q(w.id)}` });
  b.push({ zweck: "Meta", befehl: `cat ${q(path.join(state, `${w.id}.meta`))}` });
  b.push({ zweck: "Inbox", befehl: `ls -l ${q(path.join(state, `${w.id}.inbox`))}` });
  for (const name of ["brief.md", "report.md"]) {
    if (w.daten.dateien.includes(name)) b.push({ zweck: name.replace(".md", ""), befehl: `less ${q(path.join(w.daten.ordner, name))}` });
  }
  if (w.daten.dateien.length) b.push({ zweck: "Daten", befehl: `ls -l ${q(w.daten.ordner)}` });
  if (w.worktree?.da && w.worktree.pfad) {
    const wt = q(w.worktree.pfad);
    b.push({ zweck: "Worktree", befehl: `cd ${wt} && git status -sb && git log --oneline -10` });
    const basis = w.worktree.upstream || "origin/HEAD";
    b.push({ zweck: "Diff", befehl: `git -C ${wt} diff --stat ${q(basis)}...HEAD` });
  }
  if (w.meta.pr) b.push({ zweck: "PR", befehl: `gh pr view ${q(w.meta.pr)} --web` });
  return b;
}

export function lagebild(o: Optionen): Lagebild {
  const state = path.join(o.home, "state");
  let ids: string[] = [];
  try {
    ids = readdirSync(state).filter((n) => n.endsWith(".meta") && !n.startsWith(".")).map((n) => n.slice(0, -5)).sort();
  } catch {}
  const backlog = lies(path.join(o.home, "data", "backlog.md"));
  const sitzungen = new Set(ids.map((id) => parseMeta(lies(path.join(state, `${id}.meta`)) ?? "").window?.split(":")[0]).filter((s): s is string => !!s));
  const fenster = new Map<string, Fenster>();
  let tmux = false;
  for (const s of sitzungen) {
    const f = tmuxFenster(s);
    if (f) {
      tmux = true;
      for (const [n, w] of f) fenster.set(n, w);
    }
  }
  return {
    home: o.home,
    zeit: Math.floor(Date.now() / 1000),
    tmux,
    backlog: backlog === null ? null : zaehleBacklog(backlog),
    worker: ids.map((id) => leseWorker(o, id, tmux ? fenster : null, backlog)),
  };
}

// --- Ausgabe -------------------------------------------------------------------------------

function seit(jetzt: number, ts: number | null): string {
  return ts === null ? "Zeit unbekannt" : `vor ${alter(jetzt - ts)}`;
}

export function klartext(l: Lagebild): string {
  const aus: string[] = [];
  const jetzt = l.zeit;
  const zahlen = l.backlog ? Object.entries(l.backlog).map(([k, v]) => `${k} ${v}`).join(", ") : "kein data/backlog.md";
  aus.push(`Firstmate-Cockpit  ${l.home}  ${new Date(jetzt * 1000).toISOString().replace(/\.\d+Z$/, "Z")}`);
  aus.push(`Worker: ${l.worker.length}   Backlog: ${zahlen}${l.tmux ? "" : "   (tmux nicht erreichbar)"}`);
  for (const w of l.worker) {
    const m = w.meta;
    aus.push("");
    aus.push(`== ${w.id}${w.titel ? ` - ${w.titel}` : ""}`);
    const feld = (name: string, wert: string | null | undefined) => {
      if (wert) aus.push(`   ${name.padEnd(11)} ${wert}`);
    };
    feld("Projekt", [m.project, m.kind && `kind=${m.kind}`, m.mode && `mode=${m.mode}`, m.yolo && `yolo=${m.yolo}`].filter(Boolean).join("  "));
    feld("Harness", [m.harness, m.model && `model=${m.model}`, m.effort && `effort=${m.effort}`, m.backend && `backend=${m.backend}`, m.remote_host && `remote=${m.remote_host}`].filter(Boolean).join("  "));
    feld("Gestartet", w.gestartet ? `${new Date(w.gestartet * 1000).toISOString().replace(/\.\d+Z$/, "Z")} (vor ${alter(jetzt - w.gestartet)})` : null);
    const fe = w.fenster;
    const lebt = fe.lebt === null ? "?" : fe.lebt ? "lebt" : "FEHLT";
    feld("Fenster", fe.ziel ? `${fe.ziel}  ${lebt}${fe.befehl ? `  ${fe.befehl}` : ""}${fe.aktivitaet ? `  aktiv vor ${alter(jetzt - fe.aktivitaet)}` : ""}` : "keins");
    feld("Busy", w.busy ? `${w.busy.zustand}${w.busy.quelle ? ` (${w.busy.quelle})` : ""} ${seit(jetzt, w.busy.ts)}` : null);
    const s = w.status.letzte;
    feld("Status", s ? `${s.verb}${s.key ? ` [${s.key}]` : ""} ${seit(jetzt, s.at)}: ${s.text}` : "noch keine Statuszeile");
    for (const o of w.status.offen) feld(o.verb === "blocked" ? "BLOCKIERT" : "ENTSCHEID", `${o.key ? `[${o.key}] ` : ""}${seit(jetzt, o.at)}: ${o.text}`);
    if (w.inbox) feld("Inbox", `${w.inbox.wartend.length} wartend${w.inbox.wartend.length ? ` (${w.inbox.wartend.join(", ")})` : ""}, ${w.inbox.erledigt} erledigt`);
    feld("PR", m.pr);
    const wt = w.worktree;
    if (wt) {
      feld("Worktree", `${wt.pfad}${wt.da ? "" : "  (nicht da)"}`);
      if (wt.da) {
        const ab = wt.ahead === null ? "kein Upstream" : `${wt.upstream} +${wt.ahead} -${wt.behind}`;
        feld("Git", `${wt.zweig ?? "?"}${m.branch && wt.zweig !== m.branch ? ` (Meta: ${m.branch})` : ""}  ${ab}  ${wt.geaendert} geaendert`);
        feld("Commit", wt.letzterCommit);
      }
    } else feld("Zweig", m.branch);
    feld("Daten", w.daten.dateien.length ? `${w.daten.ordner}/ (${w.daten.dateien.join(", ")})` : null);
    if (w.fenster.pane?.length) {
      aus.push("   Pane:");
      for (const z of w.fenster.pane) aus.push(`     | ${z.length > 110 ? `${z.slice(0, 109)}…` : z}`);
    }
    aus.push("   Befehle:");
    for (const b of w.befehle) aus.push(`     ${(b.zweck + ":").padEnd(12)} ${b.befehl}`);
  }
  return aus.join("\n");
}

// --- Aufruf --------------------------------------------------------------------------------

function hilfe(code: number): never {
  const text = lies(fileURLToPath(import.meta.url)) ?? "";
  const zeilen = text.split("\n").slice(1);
  const ende = zeilen.findIndex((z) => !z.startsWith("//"));
  const kopf = zeilen.slice(0, ende).map((z) => z.replace(/^\/\/ ?/, ""));
  (code ? console.error : console.log)(kopf.join("\n"));
  process.exit(code);
}

async function main(argv: string[]): Promise<void> {
  let home = process.env.FM_HOME || "/work/firstmate";
  let json = false;
  let watch: number | null = null;
  const o = { pane: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--home") home = argv[++i] ?? hilfe(2);
    else if (a.startsWith("--home=")) home = a.slice(7);
    else if (a === "--json") json = true;
    else if (a === "--watch") watch = /^\d+$/.test(argv[i + 1] ?? "") ? Math.max(1, Number(argv[++i])) : 5;
    else if (a === "--keine-pane") o.pane = false;
    else if (a === "-h" || a === "--help") hilfe(0);
    else {
      console.error(`cockpit: unbekannte Option ${a}`);
      hilfe(2);
    }
  }
  if (!existsSync(path.join(home, "state")) || !statSync(path.join(home, "state")).isDirectory()) {
    console.error(`cockpit: ${home} ist kein Firstmate-Home (kein state/)`);
    process.exit(1);
  }
  const optionen: Optionen = { home, ...o };
  for (;;) {
    const l = lagebild(optionen);
    const text = json ? JSON.stringify(l, null, 2) : klartext(l);
    if (watch === null) {
      console.log(text);
      return;
    }
    process.stdout.write(`\x1b[H\x1b[2J${text}\n`);
    await new Promise((r) => setTimeout(r, watch * 1000));
  }
}

const selbst = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (selbst) await main(process.argv.slice(2));
