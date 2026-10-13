#!/usr/bin/env node
// cockpit: Firstmate-Cockpit, zeigt die Worker eines Firstmate-Home. Vorgabe ist eine Live-Ansicht
// mit einem kleinen Kasten je Worker, alle 5 Sekunden neu aufgebaut; --once gibt einmal alle
// greifbaren Details und je Worker fertige Befehle zum Oeffnen und Pruefen aus. Laeuft mit
// node >= 22.18 (eingebautes Type-Stripping) und bun.
//
//   cockpit [--home PFAD] [--watch [SEK] | --once | --json] [--keine-pane]
//
//   --home PFAD    Firstmate-Home; sonst FM_HOME, sonst FIRSTMATE_HOME, sonst /work/firstmate
//   --watch [SEK]  Live-Ansicht alle SEK Sekunden (Vorgabe 5) neu aufbauen, Ende mit q oder Strg-C
//   --once         einmal alle Details und Befehle als Klartext (Vorgabe, wenn stdout kein Terminal ist)
//   --json         einmal alles als JSON
//   --keine-pane   bei --once die letzten Zeilen des tmux-Panes nicht lesen
//
// Kopf: Captain-Inbox (wartende Notizen in state/inbox/) und Warteschlange (Queued im Backlog) mit
// dem, worauf jeder Auftrag wartet; im Kasten zeigt "✉ N" ungelesene Nachrichten an den Worker.
//
// Nur lesend: das Skript schreibt nichts in state/, data/ oder das Backlog und sendet nichts an
// Worker. Es liest state/<id>.meta, state/<id>.status, state/<id>.busy-state, state/<id>.inbox/,
// state/inbox/, data/<id>/ und data/backlog.md, fragt tmux nach Sitzungen, Fenstern und Panes und
// git (ohne optionale Index-Sperren) nach dem Stand der Worktrees. bin/fm-crew-state.sh ruft es
// nicht selbst auf, denn das kann fuer muse-Worker einen Cache in state/ schreiben; der Befehl steht
// unter "Zustand".

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

export interface Eintrag {
  id: string;
  erledigt: boolean;
  abschnitt: string | null;
  titel: string;
  tags: Record<string, string>;
  blockiertVon: string[];
}

// Ein Backlog-Eintrag `- [ ] <id> - <titel> blocked-by: <id> (repo: r) (hold-until: 2026-11-01)`:
// angehaengte Tags `(name: wert)` / `(since 2026-...)` und `blocked-by:` gehoeren nicht zum Titel.
export function backlogEintraege(text: string): Eintrag[] {
  const eintraege: Eintrag[] = [];
  let abschnitt: string | null = null;
  for (const zeile of text.split("\n")) {
    const kopf = /^##\s+(.+?)\s*$/.exec(zeile);
    if (kopf) abschnitt = kopf[1];
    const m = /^- \[([ xX])\] (\S+) - (.*?)\s*$/.exec(zeile);
    if (!m) continue;
    let titel = m[3];
    const tags: Record<string, string> = {};
    const blockiertVon: string[] = [];
    // erst die Tags am Ende, davor die blocked-by; `(since 2026-...)` traegt ein Datum statt Doppelpunkt
    for (let t; (t = /\s+\(([a-z][a-z-]*)(?:: *([^)]*)| (\d[^)]*))\)$/.exec(titel)); titel = titel.slice(0, t.index)) tags[t[1]] ??= (t[2] ?? t[3]).trim();
    for (let b; (b = /\s+blocked-by: (\S+)$/.exec(titel)); titel = titel.slice(0, b.index)) blockiertVon.unshift(b[1]);
    eintraege.push({ id: m[2], erledigt: m[1] !== " ", abschnitt, titel: titel.trim(), tags, blockiertVon });
  }
  return eintraege;
}

// Titel eines Backlog-Eintrags ohne Tags.
export function backlogTitel(text: string, id: string): string | null {
  return backlogEintraege(text).find((e) => e.id === id)?.titel ?? null;
}

// Gruende einer Captain-Haltung kann fm-captain-hold.sh als `fm-hold-v1:<base64>` ablegen.
export function haltGrund(roh: string): string {
  const m = /^fm-hold-v1:([A-Za-z0-9+/]*={0,2})$/.exec(roh);
  if (!m) return roh;
  const bytes = Buffer.from(m[1], "base64");
  if (bytes.toString("base64") !== m[1]) return roh;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return roh;
  }
}

export interface Auftrag {
  id: string;
  titel: string;
  blockiertVon: string[];
  halt: { grund: string; art: string | null; bis: string | null } | null;
  wartet: string;
}

// Auftraege der Warteschlange (Abschnitte Queued und Held) mit dem, worauf sie warten, wie
// tasks-axi es liest: blocked-by zaehlt nur, solange der andere Eintrag offen im Backlog steht
// (erledigt oder archiviert gibt frei); eine Haltung mit hold-until gilt bis vor diesem Tag.
// `heute` ist YYYY-MM-DD.
export function warteschlange(text: string, heute: string): Auftrag[] {
  const eintraege = backlogEintraege(text);
  const offen = new Set(eintraege.filter((e) => !e.erledigt && !/^done$/i.test(e.abschnitt ?? "")).map((e) => e.id));
  return eintraege
    .filter((e) => !e.erledigt && /^(queued|held)$/i.test(e.abschnitt ?? ""))
    .map((e) => {
      const blockiertVon = e.blockiertVon.filter((id) => offen.has(id));
      const bis = e.tags["hold-until"] ?? null;
      const art = e.tags["hold-kind"] ?? null;
      const gehalten = (e.tags.hold !== undefined || /^held$/i.test(e.abschnitt ?? "")) && !(bis && heute >= bis);
      const halt = gehalten ? { grund: haltGrund(e.tags.hold ?? ""), art, bis } : null;
      const gruende: string[] = [];
      if (blockiertVon.length) gruende.push(`wartet auf ${blockiertVon.join(", ")}`);
      if (halt?.bis) gruende.push(`bis ${halt.bis}`);
      else if (halt?.art === "captain") gruende.push("fuer den Captain gehalten");
      else if (halt) gruende.push(`gehalten${halt.art ? ` (${halt.art})` : ""}${halt.grund ? `: ${halt.grund}` : ""}`);
      return { id: e.id, titel: e.titel, blockiertVon, halt, wartet: gruende.join("; ") || "bereit" };
    });
}

// Wartende Notizen der Captain-Inbox: state/inbox/*.note ohne Punktdateien (wie
// `fm-inbox.sh status` und `receipts`); handled/ und die versteckten Ordner zaehlen nicht.
export function wartendeNotizen(namen: { name: string; datei: boolean }[]): string[] {
  return namen.filter((n) => n.datei && n.name.endsWith(".note") && !n.name.startsWith(".")).map((n) => n.name.slice(0, -5)).sort();
}

export function notizenText(n: number): string {
  return n === 0 ? "keine Notiz wartet" : n === 1 ? "1 Notiz wartet" : `${n} Notizen warten`;
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
  // tmux gibt Steuerzeichen wie Tab als "_" aus, daher "|" als Trenner und der freie Fenstername zuletzt
  const aus = lauf("tmux", ["list-windows", "-t", sitzung, "-F", "#{pane_current_command}|#{pane_pid}|#{window_activity}|#{pane_dead}|#{window_name}"]);
  if (aus === null) return null;
  const fenster = new Map<string, Fenster>();
  for (const zeile of aus.split("\n").filter(Boolean)) {
    const [befehl, pid, akt, tot, ...rest] = zeile.split("|");
    const name = rest.join("|");
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
  notizen: string[];
  warteschlange: Auftrag[] | null;
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
  // erreichbar ist tmux, wenn der Server antwortet, auch ohne eine Sitzung eines Workers
  const laufend = lauf("tmux", ["list-sessions", "-F", "#{session_name}"]);
  const tmux = laufend !== null;
  const sitzungen = new Set(ids.map((id) => parseMeta(lies(path.join(state, `${id}.meta`)) ?? "").window?.split(":")[0]).filter((s): s is string => !!s && !!laufend?.split("\n").includes(s)));
  const fenster = new Map<string, Fenster>();
  for (const s of sitzungen) for (const [n, w] of tmuxFenster(s) ?? []) fenster.set(n, w);
  let notizen: string[] = [];
  try {
    notizen = wartendeNotizen(readdirSync(path.join(state, "inbox"), { withFileTypes: true }).map((d) => ({ name: d.name, datei: d.isFile() })));
  } catch {}
  const jetzt = new Date();
  const heute = `${jetzt.getFullYear()}-${String(jetzt.getMonth() + 1).padStart(2, "0")}-${String(jetzt.getDate()).padStart(2, "0")}`;
  return {
    home: o.home,
    zeit: Math.floor(jetzt.getTime() / 1000),
    tmux,
    backlog: backlog === null ? null : zaehleBacklog(backlog),
    notizen,
    warteschlange: backlog === null ? null : warteschlange(backlog, heute),
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
  aus.push(`Captain-Inbox: ${notizenText(l.notizen.length)}${l.notizen.length ? ` (${l.notizen.join(", ")})` : ""}`);
  if (l.warteschlange) {
    aus.push(`Warteschlange: ${l.warteschlange.length ? l.warteschlange.length : "leer"}`);
    for (const a of l.warteschlange) aus.push(`   ${a.id}  [${a.wartet}]  ${a.titel}`);
  }
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

// --- Live-Ansicht --------------------------------------------------------------------------

// Spalten, die ein Zeichen im Terminal belegt: Kombinationszeichen 0, breite Zeichen und Emoji 2.
function zeichenBreite(z: string): number {
  if (/^[\p{Mn}\p{Me}\u200b-\u200f\ufe0f]$/u.test(z)) return 0;
  const c = z.codePointAt(0) ?? 0;
  if (c < 0x20 || (c >= 0x7f && c < 0xa0)) return 0;
  if (/^\p{Extended_Pictographic}$/u.test(z) && c >= 0x1f000) return 2;
  if ((c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3fffd)) return 2;
  return 1;
}

export function breite(text: string): number {
  let b = 0;
  for (const z of text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")) b += zeichenBreite(z);
  return b;
}

// Auf hoechstens `max` Spalten kuerzen (mit "…") und mit Leerzeichen auf genau `max` auffuellen;
// Steuerzeichen und Zeilenumbrueche werden zu Leerzeichen, denn ein Kasten bricht nie um.
export function passend(text: string, max: number): string {
  if (max <= 0) return "";
  const sauber = text.replace(/[\x00-\x1f\x7f]+/g, " ");
  if (breite(sauber) <= max) return sauber + " ".repeat(max - breite(sauber));
  let aus = "";
  let b = 0;
  for (const z of sauber) {
    const zb = zeichenBreite(z);
    if (b + zb > max - 1) break;
    aus += z;
    b += zb;
  }
  return `${aus}…${" ".repeat(max - 1 - b)}`;
}

export type Zustand = "working" | "paused" | "blocked" | "needs-decision" | "done" | "failed" | "dead" | "unknown";

// Ein Zustand je Worker: offene Frage vor offenem Blocker vor letzter Statuszeile; ein fehlendes
// tmux-Fenster heisst "dead", solange der Worker nicht fertig oder gescheitert ist.
export function zustand(w: Worker): Zustand {
  const offen = w.status.offen.map((o) => o.verb);
  const verb = w.status.letzte?.verb;
  let z: Zustand = offen.includes("needs-decision")
    ? "needs-decision"
    : offen.includes("blocked")
      ? "blocked"
      : verb === "done" || verb === "failed" || verb === "paused" || verb === "working"
        ? verb
        : verb === "captain-held"
          ? "paused"
          : verb === "resolved"
            ? "working"
            : "unknown";
  if (w.fenster.lebt === false && z !== "done" && z !== "failed") z = "dead";
  return z;
}

const ZUSTAND: Record<Zustand, { zeichen: string; farbe: string }> = {
  working: { zeichen: "●", farbe: "32" },
  paused: { zeichen: "‖", farbe: "34" },
  blocked: { zeichen: "■", farbe: "31" },
  "needs-decision": { zeichen: "?", farbe: "33" },
  done: { zeichen: "✓", farbe: "36" },
  failed: { zeichen: "✗", farbe: "31" },
  dead: { zeichen: "†", farbe: "35" },
  unknown: { zeichen: "·", farbe: "90" },
};

// https://github.com/o/r/pull/7 -> o/r#7, sonst die Adresse wie sie ist.
export function prKurz(pr: string): string {
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(pr);
  return m ? `${m[1]}#${m[2]}` : pr;
}

// Der eine Befehl im Kasten: das tmux-Fenster oeffnen (in tmux umschalten, sonst anhaengen).
export function oeffnenKurz(w: Worker, inTmux: boolean): string | null {
  const ziel = w.fenster.ziel;
  if (!ziel) return null;
  if ((w.meta.backend || "tmux") !== "tmux") return `# ${w.meta.backend} ${ziel}`;
  return `tmux ${inTmux ? "switch-client" : "attach"} -t ${q(ziel)}`;
}

// Innenzeilen eines Kastens ohne Farbe; die Titelzeile steht im oberen Rand.
export function kastenZeilen(w: Worker, jetzt: number, inTmux: boolean): string[] {
  const m = w.meta;
  const z: string[] = [];
  const projekt = m.project ? path.basename(m.project) : null;
  z.push([projekt, [m.kind, m.mode].filter(Boolean).join("/")].filter(Boolean).join(" · ") || "-");
  z.push([m.harness, m.model, m.effort].filter(Boolean).join("/") || "-");
  const s = w.status.letzte;
  z.push(s ? `${s.at === null ? "?" : alter(jetzt - s.at)} ${s.text}` : "noch keine Statuszeile");
  if (m.pr) z.push(`PR ${prKurz(m.pr)}`);
  const wt = w.worktree;
  if (wt?.da) {
    const ab = wt.ahead === null ? "" : ` ↑${wt.ahead} ↓${wt.behind}`;
    z.push(`${wt.zweig ?? "?"}${ab}${wt.geaendert ? ` ±${wt.geaendert}` : ""}`);
  } else if (m.branch) z.push(`${m.branch}${wt ? " (kein Worktree)" : ""}`);
  const b = oeffnenKurz(w, inTmux);
  if (b) z.push(`$ ${b}`);
  return z;
}

export interface Rahmen {
  spalten: number;
  zeilen: number;
  farbe: boolean;
  inTmux: boolean;
  takt: number;
}

export const KASTEN_MIN = 40;
export const KASTEN_MAX = 64;

// Wie viele Kaesten nebeneinander passen und wie breit jeder ist (Abstand eine Spalte).
export function raster(spalten: number, anzahl: number): { proZeile: number; breite: number } {
  const proZeile = Math.max(1, Math.min(anzahl || 1, Math.floor((spalten + 1) / (KASTEN_MIN + 1))));
  const b = Math.min(KASTEN_MAX, Math.floor((spalten + 1) / proZeile) - 1);
  return { proZeile, breite: Math.max(4, Math.min(b, spalten)) };
}

// Ein Kasten als Zeilen gleicher Breite, auf `hoehe` Innenzeilen aufgefuellt.
export function kasten(w: Worker, jetzt: number, b: number, hoehe: number, r: Rahmen): string[] {
  const zs = ZUSTAND[zustand(w)];
  const farbe = (t: string, code: string) => (r.farbe ? `\x1b[${code}m${t}\x1b[0m` : t);
  const innen = b - 4;
  // `┌─ ● id ──── ✉ 2 zustand ─┐`: ungelesene Inbox-Nachrichten und Zustand bleiben stehen, die id
  // wird gekuerzt
  const post = w.inbox?.wartend.length ? `✉ ${w.inbox.wartend.length} ` : "";
  const mitPost = ` ${post}${zustand(w)} `;
  const rechts = b < 24 ? "" : breite(mitPost) <= b - 5 ? mitPost : ` ${zustand(w)} `;
  const links = `${passend(` ${zs.zeichen} ${w.id}`, Math.max(0, b - 6 - breite(rechts))).trimEnd()} `;
  const oben = `┌─${links}${"─".repeat(Math.max(0, b - 4 - breite(links) - breite(rechts)))}${rechts}─┐`;
  const zeilen = kastenZeilen(w, jetzt, r.inTmux);
  while (zeilen.length < hoehe) zeilen.push("");
  const rand = farbe("│", zs.farbe);
  return [
    farbe(oben, zs.farbe),
    ...zeilen.slice(0, hoehe).map((z) => {
      const t = passend(z, innen);
      return `${rand} ${z.startsWith("$ ") ? farbe(t, "2") : t} ${rand}`;
    }),
    farbe(`└${"─".repeat(b - 2)}┘`, zs.farbe),
  ];
}

export const AUFTRAEGE_LIVE = 3;

// Zeilen unter dem Kopf der Live-Ansicht: Captain-Inbox und Warteschlange, davon hoechstens `max`
// Auftraege mit dem, worauf sie warten, der Rest als "+N weitere".
export function lageZeilen(l: Lagebild, max: number): string[] {
  const ws = l.warteschlange;
  const z = [`Captain-Inbox: ${notizenText(l.notizen.length)} · Warteschlange: ${ws === null ? "kein Backlog" : ws.length || "leer"}`];
  for (const a of (ws ?? []).slice(0, max)) z.push(`  ${a.id}  [${a.wartet}]  ${a.titel}`);
  if (ws && ws.length > max) z.push(`  +${ws.length - max} weitere (--once)`);
  return z;
}

// Ein ganzes Bild der Live-Ansicht: Kopfzeile, Inbox und Warteschlange, Kaesten im Raster, Fusszeile;
// jede Zeile hoechstens `r.spalten` breit und hoechstens `r.zeilen` Zeilen, nicht passende Kaesten
// zaehlt die Fusszeile.
export function bild(l: Lagebild, r: Rahmen): string[] {
  const jetzt = l.zeit;
  const uhr = new Date(jetzt * 1000).toISOString().slice(11, 19);
  const zahlen = l.backlog ? Object.entries(l.backlog).map(([k, v]) => `${k} ${v}`).join(", ") : "kein Backlog";
  const kopf = passend(`Firstmate-Cockpit  ${l.home}  ${l.worker.length} Worker  ${zahlen}${l.tmux ? "" : "  tmux nicht erreichbar"}  ${uhr}Z`, r.spalten).trimEnd();
  const lage = lageZeilen(l, AUFTRAEGE_LIVE).slice(0, Math.max(0, r.zeilen - 3)).map((z) => passend(z, r.spalten).trimEnd());
  if (r.farbe && l.notizen.length && lage.length) lage[0] = `\x1b[33m${lage[0]}\x1b[0m`;
  const { proZeile, breite: b } = raster(r.spalten, l.worker.length);
  const koerper: string[] = [];
  let gezeigt = 0;
  const platz = r.zeilen - 3 - lage.length; // Kopf, Lage, Leerzeile, Fuss
  for (let i = 0; i < l.worker.length; i += proZeile) {
    const reihe = l.worker.slice(i, i + proZeile);
    const hoehe = Math.max(...reihe.map((w) => kastenZeilen(w, jetzt, r.inTmux).length));
    if (koerper.length + hoehe + 2 > platz) break;
    const kaesten = reihe.map((w) => kasten(w, jetzt, b, hoehe, r));
    for (let z = 0; z < hoehe + 2; z++) koerper.push(kaesten.map((k) => k[z]).join(" "));
    gezeigt += reihe.length;
  }
  if (!l.worker.length) koerper.push("keine Worker (kein state/*.meta)");
  const rest = l.worker.length - gezeigt;
  const fuss = passend(`${rest > 0 ? `+${rest} Worker passen nicht  ` : ""}alle ${r.takt}s · q/Strg-C beenden · --once alle Details und Befehle · --json`, r.spalten).trimEnd();
  return [r.farbe ? `\x1b[1m${kopf}\x1b[0m` : kopf, ...lage, "", ...koerper, r.farbe ? `\x1b[2m${fuss}\x1b[0m` : fuss];
}

// Live-Ansicht im alternativen Bildschirm; jedes Bild ueberschreibt das vorige an Ort und Stelle
// (Cursor nach oben links, je Zeile Rest loeschen, danach alles darunter), ohne Flackern.
async function live(o: Optionen, takt: number): Promise<void> {
  const aus = process.stdout;
  const tty = !!aus.isTTY;
  const rahmen = (): Rahmen => ({
    spalten: aus.columns || 80,
    zeilen: aus.rows || 24,
    farbe: tty && process.env.NO_COLOR === undefined,
    inTmux: !!process.env.TMUX,
    takt,
  });
  let l = lagebild(o);
  const zeichne = () => aus.write(`\x1b[H${bild(l, rahmen()).map((z) => `${z}\x1b[K`).join("\r\n")}\x1b[J`);
  let fertig = () => {};
  const ende = new Promise<void>((r) => (fertig = r));
  const aufraeumen = () => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    aus.write("\x1b[0m\x1b[?25h\x1b[?1049l");
  };
  process.on("exit", aufraeumen);
  const beenden = () => fertig();
  process.on("SIGINT", beenden);
  process.on("SIGTERM", beenden);
  aus.on("resize", zeichne);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.on("data", (d) => {
      if (/[q\x03\x04]/.test(d.toString())) beenden();
    });
  }
  aus.write("\x1b[?1049h\x1b[?25l\x1b[2J");
  zeichne();
  const uhr = setInterval(() => {
    l = lagebild(o);
    zeichne();
  }, takt * 1000);
  await ende;
  clearInterval(uhr);
  aufraeumen();
  process.removeListener("exit", aufraeumen);
  process.exit(0);
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
  let home = process.env.FM_HOME || process.env.FIRSTMATE_HOME || "/work/firstmate";
  let json = false;
  let once = false;
  let watch: number | null = null;
  const o = { pane: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--home") home = argv[++i] ?? hilfe(2);
    else if (a.startsWith("--home=")) home = a.slice(7);
    else if (a === "--json") json = true;
    else if (a === "--once") once = true;
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
  if ([json, once, watch !== null].filter(Boolean).length > 1) {
    console.error("cockpit: --watch, --once und --json schliessen sich aus");
    hilfe(2);
  }
  if (json || once || (watch === null && !process.stdout.isTTY)) {
    const l = lagebild({ home, ...o });
    console.log(json ? JSON.stringify(l, null, 2) : klartext(l));
    return;
  }
  // die Kaesten zeigen keine Pane-Zeilen, also tmux nicht danach fragen
  await live({ home, pane: false }, watch ?? 5);
}

const selbst = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (selbst) await main(process.argv.slice(2));
