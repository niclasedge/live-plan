#!/usr/bin/env node
// firstmate: gemeinsames Modul fuer die Sicht auf ein Firstmate-Home, genutzt vom Terminal-Cockpit
// (cockpit.ts) und vom Abschnitt Firstmate der Ansicht (server.ts). Laeuft mit node >= 22.18
// (eingebautes Type-Stripping) und bun.
//
//   firstmate.ts --json HOME [REGISTER]   einmal Worker, Captain-Inbox, Warteschlange, Projekte und
//                                         Flotte als JSON; REGISTER ist der Ordner der Sitzungsregister
//
// Den Aufruf mit --json nutzt der Server in einem eigenen Prozess, damit git und tmux seine
// Anfragen nicht aufhalten. Die Ausgabe enthaelt keine Zeilen aus tmux-Panes.
//
// Nur lesend: nichts wird in state/, data/, das Backlog oder die Klone unter projects/ geschrieben.
// git laeuft ohne optionale Index-Sperren, bin/fm-crew-state.sh wird nicht aufgerufen.

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
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

// --- Zustand ------------------------------------------------------------------------------

export type Zustand = "working" | "paused" | "blocked" | "needs-decision" | "done" | "failed" | "dead" | "unknown";

// Ein Zustand je Worker: offene Frage vor offenem Blocker vor letzter Statuszeile; ein fehlendes
// tmux-Fenster heisst "dead", solange der Worker nicht fertig oder gescheitert ist.
export function zustandAus(status: Worker["status"], lebt: boolean | null): Zustand {
  const offen = status.offen.map((o) => o.verb);
  const verb = status.letzte?.verb;
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
  if (lebt === false && z !== "done" && z !== "failed") z = "dead";
  return z;
}

export function zustand(w: Worker): Zustand {
  return zustandAus(w.status, w.fenster.lebt);
}

// https://github.com/o/r/pull/7 -> o/r#7, sonst die Adresse wie sie ist.
export function prKurz(pr: string): string {
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(pr);
  return m ? `${m[1]}#${m[2]}` : pr;
}

// --- Firstmate-Home erkennen ---------------------------------------------------------------

// Ein Home erkennt man am Aufbau, nicht am Namen: bin/fm-spawn.sh als Datei, state/ und data/ als Ordner.
export function istFirstmateHome(ordner: string): boolean {
  try {
    return statSync(path.join(ordner, "bin", "fm-spawn.sh")).isFile() && statSync(path.join(ordner, "state")).isDirectory() && statSync(path.join(ordner, "data")).isDirectory();
  } catch {
    return false;
  }
}

// Das Home aus der Umgebung wie im Cockpit: FM_HOME, sonst FIRSTMATE_HOME.
export function homeAusUmgebung(env: Record<string, string | undefined>): string | null {
  return env.FM_HOME || env.FIRSTMATE_HOME || null;
}

// --- Projekte ------------------------------------------------------------------------------

export interface Registereintrag {
  name: string;
  haltung: string | null;
  beschreibung: string;
  seit: string | null;
}

// data/projects.md: `- name [haltung] - beschreibung (added 2026-10-13)`; Haltung, Beschreibung
// und Datum duerfen fehlen.
export function parseProjekte(text: string): Registereintrag[] {
  const eintraege: Registereintrag[] = [];
  for (const zeile of text.split("\n")) {
    const m = /^- (\S+)(?: \[([^\]]*)\])?(?: - (.*?))?\s*$/.exec(zeile.replace(/\r$/, ""));
    if (!m) continue;
    let beschreibung = m[3] ?? "";
    const d = /\s*\(added (\d{4}-\d{2}-\d{2})\)$/.exec(beschreibung);
    if (d) beschreibung = beschreibung.slice(0, d.index);
    eintraege.push({ name: m[1], haltung: m[2]?.trim() || null, beschreibung: beschreibung.trim(), seit: d?.[1] ?? null });
  }
  return eintraege;
}

export interface GithubRepo {
  owner: string;
  repo: string;
}

// owner/repo aus der Adresse von origin: https://github.com/o/r(.git), git@github.com:o/r.git,
// ssh://git@github.com/o/r.git und SSH-Aliase wie git@github-privat:o/r.git (Host mit "github").
export function githubRepo(url: string): GithubRepo | null {
  const u = url.trim();
  const m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(u) ?? /^(?:[^@/:]+@)?([^/:]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(u);
  if (!m || !/github/i.test(m[1])) return null;
  const name = /^[A-Za-z0-9_.-]+$/;
  return name.test(m[2]) && name.test(m[3]) && !/^\.+$/.test(m[3]) ? { owner: m[2], repo: m[3] } : null;
}

export interface Projekt {
  name: string;
  pfad: string;
  register: Registereintrag | null;
  git: boolean;
  zweig: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  geaendert: number | null;
  commit: { hash: string; zeit: number; betreff: string } | null;
  abgerufen: number | null;
  github: GithubRepo | null;
  worker: string[];
}

// Ein Klon unter projects/: Zweig, ahead/behind, geaenderte Dateien, letzter Commit, Zeit des
// letzten fetch (mtime von FETCH_HEAD) und das GitHub-Repo von origin. Die Worker, deren Meta
// project= diesen Klon nennt (oder einen gleichnamigen Ordner), gehoeren dazu.
function leseProjekt(pfad: string, register: Registereintrag | null, worker: Worker[]): Projekt {
  const name = path.basename(pfad);
  const git = (...args: string[]) => lauf("git", ["--no-optional-locks", ...args], pfad);
  const p: Projekt = { name, pfad, register, git: false, zweig: null, upstream: null, ahead: null, behind: null, geaendert: null, commit: null, abgerufen: null, github: null, worker: [] };
  p.worker = worker.filter((w) => w.meta.project && (w.meta.project === pfad || path.basename(w.meta.project) === name)).map((w) => w.id);
  const spitze = git("rev-parse", "--show-toplevel")?.trim();
  try {
    if (!spitze || realpathSync(spitze) !== realpathSync(pfad)) return p;
  } catch {
    return p;
  }
  const st = git("status", "--porcelain=v2", "--branch");
  if (st === null) return p;
  p.git = true;
  Object.assign(p, parseGitStatus(st));
  if (p.zweig === "(detached)") p.zweig = null;
  const log = git("log", "-1", "--format=%h%x09%ct%x09%s")?.replace(/\n$/, "");
  const [hash, zeit, ...betreff] = log ? log.split("\t") : [];
  if (hash && /^\d+$/.test(zeit ?? "")) p.commit = { hash, zeit: Number(zeit), betreff: betreff.join("\t") };
  const fetchHead = git("rev-parse", "--git-path", "FETCH_HEAD")?.trim();
  if (fetchHead) {
    try {
      p.abgerufen = Math.floor(statSync(path.resolve(pfad, fetchHead)).mtimeMs / 1000);
    } catch {}
  }
  const origin = git("remote", "get-url", "origin");
  p.github = origin ? githubRepo(origin) : null;
  return p;
}

export function leseProjekte(home: string, worker: Worker[]): Projekt[] {
  const register = parseProjekte(lies(path.join(home, "data", "projects.md")) ?? "");
  const ordner = path.join(home, "projects");
  let namen: string[] = [];
  try {
    namen = readdirSync(ordner, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {}
  return namen.map((name) => leseProjekt(path.join(ordner, name), register.find((r) => r.name === name) ?? null, worker));
}

// --- Sicht fuer die Ansicht ----------------------------------------------------------------

// Was die Ansicht von der Meta eines Workers zeigt; alles andere bleibt im Home.
const META_SICHTBAR = ["project", "kind", "mode", "yolo", "harness", "model", "effort", "backend", "remote_host", "window", "terminal", "worktree", "branch", "pr"];
export const VERLAUF_N = 12;

export interface WorkerSicht extends Omit<Worker, "fenster"> {
  zustand: Zustand;
  fenster: Omit<Worker["fenster"], "pane">;
  verlauf: StatusZeile[];
}

export interface FirstmateSicht extends Omit<Lagebild, "worker"> {
  worker: WorkerSicht[];
  projekte: Projekt[];
  flotte: Flotte;
}

// Worker samt Zustand und den letzten VERLAUF_N Statuszeilen, ohne Pane-Zeilen und ohne Meta
// ausserhalb von META_SICHTBAR, dazu die Projekte und die Flotte (Aufgaben des Tages je Repo). Fragt tmux nie nach dem Inhalt eines Panes.
export function firstmateSicht(home: string, o: { register?: string } = {}): FirstmateSicht {
  const l = lagebild({ home, pane: false });
  const worker = l.worker.map((w): WorkerSicht => {
    const { pane: _, ...fenster } = w.fenster;
    const meta: Meta = {};
    for (const k of META_SICHTBAR) if (w.meta[k]) meta[k] = w.meta[k];
    const verlauf = parseStatus(lies(path.join(home, "state", `${w.id}.status`)) ?? "").slice(-VERLAUF_N);
    return { ...w, meta, fenster, zustand: zustand(w), verlauf };
  });
  const zustaende = new Map(worker.map((w) => [w.id, w.zustand] as const));
  return { ...l, worker, projekte: leseProjekte(home, l.worker), flotte: flotte(home, { register: o.register, jetzt: l.zeit, zustaende }) };
}

// --- Flotte: die Aufgaben des Tages je Repo auf einem Zeitstrahl ---------------------------------

// Lage auf dem Zeitstrahl in Prozent, ausserhalb des Fensters auf 0 und 100 geklemmt.
export function prozent(t: number, t0: number, t1: number): number {
  if (!(t1 > t0)) return 0;
  return Math.max(0, Math.min(100, ((t - t0) / (t1 - t0)) * 100));
}

const MIN_BREITE = 0.6;

// Anfang und Breite eines Balkens; ein kurzer Auftrag bleibt sichtbar, der Balken ragt nie ueber den Rand.
export function balken(von: number, bis: number, t0: number, t1: number): { von: number; breit: number } {
  const v = prozent(von, t0, t1);
  const breit = Math.max(MIN_BREITE, prozent(bis, t0, t1) - v);
  return { von: Math.min(v, 100 - breit), breit };
}

// Median in ganzen Minuten; ohne Werte null.
export function medianMinuten(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}

// Wann ein laufender Auftrag nach dem Median seines Repos fertig waere: Start plus Median, mindestens
// 5 Minuten ab jetzt. Ohne Median keine Schaetzung.
export function schaetzungBis(start: number, jetzt: number, median: number | null): number | null {
  if (median === null) return null;
  return jetzt + Math.max(5 * 60, median * 60 - (jetzt - start));
}

// Ordner- und Dateiname einer Aufgabe unter data/ und state/.
export function gueltigeAufgabenId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && !/^\.+$/.test(id);
}

// Der Inhalt unter `## Name` bis zur naechsten Ueberschrift der Ebene 1 oder 2; null ohne den Abschnitt.
export function abschnittAus(text: string, kopf: string): string | null {
  const zeilen = text.split("\n");
  const i = zeilen.findIndex((z) => z.replace(/\r$/, "").trimEnd() === `## ${kopf}`);
  if (i < 0) return null;
  let j = i + 1;
  while (j < zeilen.length && !/^#{1,2} /.test(zeilen[j])) j++;
  return zeilen.slice(i + 1, j).join("\n").trim();
}

export interface Sitzungsregister {
  id: string;
  cwd: string;
  gestartet: number;
  beendet: number | null;
  modell: string | null;
  kostenUsd: number | null;
  zuege: number | null;
}

// Das Register der Claude-Sitzungen (LIVE_PLAN_CACHE/sitzungen/*.json), nur die Felder der Flotte;
// Kaputtes und Fremdes faellt weg.
export function leseRegister(ordner: string | undefined): Sitzungsregister[] {
  if (!ordner) return [];
  let namen: string[] = [];
  try {
    namen = readdirSync(ordner).filter((n) => n.endsWith(".json") && !n.startsWith("."));
  } catch {
    return [];
  }
  const aus: Sitzungsregister[] = [];
  for (const n of namen) {
    try {
      const d = JSON.parse(readFileSync(path.join(ordner, n), "utf8")) as Record<string, unknown>;
      if (!d || typeof d !== "object" || typeof d.cwd !== "string" || typeof d.gestartet !== "number") continue;
      const haupt = d.haupt && typeof d.haupt === "object" ? (d.haupt as Record<string, unknown>) : {};
      aus.push({
        id: typeof d.id === "string" ? d.id : n,
        cwd: d.cwd,
        gestartet: d.gestartet,
        beendet: typeof d.beendet === "number" ? d.beendet : null,
        modell: typeof d.modell === "string" ? d.modell : null,
        kostenUsd: typeof haupt.kostenUsd === "number" ? haupt.kostenUsd : null,
        zuege: typeof haupt.zuege === "number" ? haupt.zuege : null,
      });
    } catch {}
  }
  return aus;
}

// Die Sitzung eines Auftrags: ein Treehouse-Worktree, der bis 240 s nach dem Start des Auftrags
// begann, die fruehste; jede Sitzung gehoert nur einem Auftrag (`benutzt`).
export function sitzungZuordnen(regs: Sitzungsregister[], start: number, benutzt: Set<string>): Sitzungsregister | null {
  let beste: Sitzungsregister | null = null;
  for (const r of regs) {
    if (benutzt.has(r.id) || !r.cwd.includes(".treehouse/")) continue;
    const diff = r.gestartet / 1000 - start;
    if (diff >= 0 && diff < 240 && (!beste || r.gestartet < beste.gestartet)) beste = r;
  }
  if (beste) benutzt.add(beste.id);
  return beste;
}

export interface Aufgabe {
  id: string;
  repo: string;
  kind: string;
  titel: string | null;
  zustand: "lauf" | "stopp" | "fertig";
  zustandText: string;
  start: number;
  ende: number | null;
  minuten: number;
  von: number;
  breit: number;
  schaetzung: { von: number; breit: number; bis: number; minuten: number; median: number } | null;
  pr: string | null;
  ausgang: string | null;
  kosten: number | null;
  zuege: number | null;
  modell: string | null;
  effort: string | null;
  live: boolean;
  zeitleiste: boolean;
  dateien: number;
}

export interface FlottenRepo {
  repo: string;
  aufgaben: Aufgabe[];
  median: number | null;
  gemergt: number;
  laeuft: string[];
}

export interface Flotte {
  jetzt: number;
  t0: number;
  t1: number;
  jetztProzent: number;
  achse: { t: number; prozent: number }[];
  repos: FlottenRepo[];
}

export interface FlotteOptionen {
  register?: string;
  jetzt?: number;
  // Beginn des Tages (Epoche in s); aeltere abgeschlossene Aufgaben fehlen, laufende bleiben.
  seit?: number;
  // Zustaende der Worker mit tmux-Wissen (Fenster fehlt); ohne sie zaehlt nur die Statusdatei.
  zustaende?: Map<string, Zustand>;
}

const AUSGAENGE = ["merged", "reported", "done", "cancelled", "failed"];
const AUSGANG_TEXT: Record<string, string> = { merged: "gemergt", reported: "Bericht", done: "fertig", cancelled: "abgebrochen", failed: "fehlgeschlagen" };
const STOPP_TEXT: Partial<Record<Zustand, string>> = { paused: "pausiert", blocked: "blockiert", "needs-decision": "wartet auf Entscheidung", dead: "Fenster fehlt" };

function tagesbeginn(jetzt: number): number {
  const d = new Date(jetzt * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function mtimeSek(datei: string): number | null {
  try {
    return Math.floor(statSync(datei).mtimeMs / 1000);
  } catch {
    return null;
  }
}

// Eine Achsenmarke je Stunde (bei kurzem Fenster je halbe, bei langem je zwei oder vier), nach Ortszeit.
function achseFuer(t0: number, t1: number): { t: number; prozent: number }[] {
  const spanne = t1 - t0;
  const schritt = [1800, 3600, 7200, 14400].find((s) => spanne / s <= 12) ?? 14400;
  const versatz = -new Date(t0 * 1000).getTimezoneOffset() * 60;
  const marken: { t: number; prozent: number }[] = [];
  for (let t = Math.ceil((t0 + versatz) / schritt) * schritt - versatz; t < t1; t += schritt) marken.push({ t, prozent: prozent(t, t0, t1) });
  return marken;
}

// Die Aufgaben des Tages je Repo: laufende aus state/<id>.meta (+ .status), abgeschlossene aus dem
// Backlog (Done, Archiv) und data/<id>/ (Start = Aenderungszeit von launch-brief.md). Kosten, Zuege
// und Modell aus dem Sitzungsregister, soweit eine Sitzung zum Start passt. Nur lesend.
export function flotte(home: string, o: FlotteOptionen = {}): Flotte {
  const jetzt = o.jetzt ?? Math.floor(Date.now() / 1000);
  const seit = o.seit ?? tagesbeginn(jetzt);
  const state = path.join(home, "state");
  const daten = path.join(home, "data");
  const eintraege = new Map<string, Eintrag>();
  for (const datei of ["backlog.md", "done-archive.md"]) for (const e of backlogEintraege(lies(path.join(daten, datei)) ?? "")) if (!eintraege.has(e.id)) eintraege.set(e.id, e);

  const metas = new Map<string, Meta>();
  try {
    for (const n of readdirSync(state)) if (n.endsWith(".meta") && !n.startsWith(".")) metas.set(n.slice(0, -5), parseMeta(lies(path.join(state, n)) ?? ""));
  } catch {}
  const ids = new Set(metas.keys());
  try {
    for (const d of readdirSync(daten, { withFileTypes: true })) if (d.isDirectory() && gueltigeAufgabenId(d.name) && existsSync(path.join(daten, d.name, "launch-brief.md"))) ids.add(d.name);
  } catch {}

  const regs = leseRegister(o.register);
  const benutzt = new Set<string>();
  type Roh = Omit<Aufgabe, "von" | "breit" | "schaetzung" | "minuten"> & { endeBis: number };
  const roh: Roh[] = [];
  for (const id of [...ids].sort()) {
    const meta = metas.get(id) ?? null;
    const e = eintraege.get(id) ?? null;
    const kind = meta?.kind || e?.tags.kind || "?";
    if (kind === "captain") continue;
    const statusText = meta ? lies(path.join(state, `${id}.status`)) : null;
    const zeilen = parseStatus(statusText ?? "");
    const briefZeit = mtimeSek(path.join(daten, id, "launch-brief.md"));
    const gen = /^s(\d+)\./.exec(meta?.spawn_gen ?? "");
    const start = (gen ? Number(gen[1]) : null) ?? briefZeit ?? (meta ? mtimeSek(path.join(state, `${id}.meta`)) : null);
    if (start === null) continue;
    const z = meta ? o.zustaende?.get(id) ?? zustandAus({ letzte: zeilen.at(-1) ?? null, zeilen: zeilen.length, offen: offeneFragen(zeilen) }, null) : null;
    const laeuftNoch = z !== null && z !== "done" && z !== "failed";
    if (!laeuftNoch && start < seit) continue;
    const reg = sitzungZuordnen(regs, start, benutzt);
    const ausgang = AUSGAENGE.find((a) => e?.tags[a] !== undefined) ?? null;
    const pr = /https:\/\/github\.com\/\S+\/pull\/\d+/.exec(e?.titel ?? "")?.[0] ?? null;
    const titel = e ? e.titel.replace(/\s*https:\/\/\S+/g, "").trim() || null : null;

    let zustandArt: Aufgabe["zustand"] = "fertig";
    let text = ausgang ? AUSGANG_TEXT[ausgang] : "fertig";
    let ende: number | null = null;
    if (laeuftNoch) {
      zustandArt = z === "working" || z === "unknown" ? "lauf" : "stopp";
      text = zustandArt === "lauf" ? "läuft" : STOPP_TEXT[z!] ?? "angehalten";
    } else if (z === "done" || z === "failed") {
      text = ausgang ? AUSGANG_TEXT[ausgang] : z === "done" ? "fertig" : "fehlgeschlagen";
      ende = reg?.beendet ? Math.floor(reg.beendet / 1000) : (zeilen.at(-1)?.at ?? jetzt);
    }
    let dateien: string[] = [];
    try {
      dateien = readdirSync(path.join(daten, id));
    } catch {}
    if (zustandArt === "fertig" && ende === null) {
      ende = reg?.beendet ? Math.floor(reg.beendet / 1000) : Math.max(start, ...dateien.map((n) => mtimeSek(path.join(daten, id, n)) ?? 0));
    }
    const modell = meta?.model && meta.model !== "default" ? meta.model : (reg?.modell ?? null);
    roh.push({
      id, repo: e?.tags.repo?.trim() || (meta?.project ? path.basename(meta.project) : "") || "(ohne Repo)", kind, titel, zustand: zustandArt, zustandText: text,
      start, ende, endeBis: ende ?? jetzt, pr, ausgang, kosten: reg?.kostenUsd ?? null, zuege: reg?.zuege ?? null, modell,
      effort: meta?.effort || null, live: meta !== null, zeitleiste: statusText !== null, dateien: dateien.length,
    });
  }

  // Median je Repo aus den abgeschlossenen Umsetzungen, die weder abgebrochen noch gescheitert sind.
  const mediane = new Map<string, number | null>();
  for (const repo of new Set(roh.map((r) => r.repo))) {
    mediane.set(repo, medianMinuten(roh.filter((r) => r.repo === repo && r.kind === "ship" && r.zustand === "fertig" && r.ausgang !== "cancelled" && r.ausgang !== "failed").map((r) => Math.round((r.endeBis - r.start) / 60))));
  }
  const bis = new Map<string, number>();
  for (const r of roh) if (r.zustand === "lauf") {
    const b = schaetzungBis(r.start, jetzt, mediane.get(r.repo) ?? null);
    if (b !== null) bis.set(r.id, b);
  }
  const t0 = Math.min(jetzt - 60 * 60, ...roh.map((r) => r.start)) - (roh.length ? 10 * 60 : 0);
  const t1 = Math.max(jetzt + 15 * 60, ...bis.values(), ...roh.map((r) => r.endeBis)) + 5 * 60;
  const aufgaben = roh.map(({ endeBis, ...r }): Aufgabe => {
    const b = balken(r.start, endeBis, t0, t1);
    const sb = bis.get(r.id);
    const median = mediane.get(r.repo) ?? null;
    const sg = sb !== undefined && median !== null ? balken(jetzt, sb, t0, t1) : null;
    return { ...r, minuten: Math.round((endeBis - r.start) / 60), von: b.von, breit: b.breit, schaetzung: sg && sb !== undefined && median !== null ? { ...sg, bis: sb, minuten: Math.round((sb - jetzt) / 60), median } : null };
  });
  const repos: FlottenRepo[] = [...new Set(aufgaben.map((a) => a.repo))].map((repo) => {
    const as = aufgaben.filter((a) => a.repo === repo).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    return { repo, aufgaben: as, median: mediane.get(repo) ?? null, gemergt: as.filter((a) => a.ausgang === "merged").length, laeuft: as.filter((a) => a.zustand === "lauf").map((a) => a.id) };
  });
  repos.sort((a, b) => a.aufgaben[0].start - b.aufgaben[0].start || a.repo.localeCompare(b.repo));
  return { jetzt, t0, t1, jetztProzent: prozent(jetzt, t0, t1), achse: achseFuer(t0, t1), repos };
}

// --- Detail einer Aufgabe -------------------------------------------------------------------

export const BERICHT_MAX = 9000;
const BRIEF_MAX = 60_000;
const ZEITLEISTE_MAX = 500;

export interface AufgabeDetail {
  id: string;
  brief: string | null;
  briefGekuerzt: boolean;
  intent: string | null;
  spec: string | null;
  bericht: string | null;
  berichtGekuerzt: boolean;
  zeitleiste: StatusZeile[] | null;
  dateien: string[];
}

// Eine Textdatei im echten Ordner der Aufgabe: kein Symlink, eine Datei, hoechstens `max` Zeichen.
function liesImOrdner(ordner: string, name: string, max: number): { text: string; gekuerzt: boolean } | null {
  const pfad = path.join(ordner, name);
  try {
    if (!lstatSync(pfad).isFile()) return null;
    const text = readFileSync(pfad, "utf8");
    if (text.length <= max) return { text, gekuerzt: false };
    const schnitt = text.lastIndexOf("\n", max);
    return { text: text.slice(0, schnitt > max * 0.8 ? schnitt : max), gekuerzt: true };
  } catch {
    return null;
  }
}

// Brief, Bericht, Zeitleiste und Dateiliste einer Aufgabe, nur aus data/<id>/ und state/<id>.status;
// null bei ungueltiger Id, unbekannter Aufgabe oder einem data/<id>, das nach realpath ausserhalb von
// data/ liegt. Schreibt nichts.
export function aufgabeDetail(home: string, id: string): AufgabeDetail | null {
  if (!gueltigeAufgabenId(id)) return null;
  const daten = path.join(home, "data");
  const ordner = path.join(daten, id);
  let echt: string | null = null;
  try {
    const wurzel = realpathSync(daten);
    const r = realpathSync(ordner);
    if (path.dirname(r) === wurzel && path.basename(r) === id && statSync(r).isDirectory() && !lstatSync(ordner).isSymbolicLink()) echt = r;
  } catch {}
  const statusPfad = path.join(home, "state", `${id}.status`);
  const status = existsSync(path.join(home, "state", `${id}.meta`)) || echt ? lies(statusPfad) : null;
  if (!echt && !existsSync(path.join(home, "state", `${id}.meta`))) return null;
  const brief = echt ? liesImOrdner(echt, "brief.md", BRIEF_MAX) : null;
  const bericht = echt ? liesImOrdner(echt, "report.md", BERICHT_MAX) : null;
  let dateien: string[] = [];
  if (echt) {
    try {
      dateien = readdirSync(echt).sort();
    } catch {}
  }
  return {
    id,
    brief: brief?.text ?? null,
    briefGekuerzt: brief?.gekuerzt ?? false,
    intent: brief ? abschnittAus(brief.text, "Captain's intent") : null,
    spec: brief ? abschnittAus(brief.text, "Firstmate spec") : null,
    bericht: bericht?.text ?? null,
    berichtGekuerzt: bericht?.gekuerzt ?? false,
    zeitleiste: status === null ? null : parseStatus(status).slice(-ZEITLEISTE_MAX),
    dateien,
  };
}

// --- Offene PRs ----------------------------------------------------------------------------

export interface Pr {
  nummer: number;
  titel: string;
  url: string;
  entwurf: boolean;
  zweig: string;
}

export type PrStand = { art: "ok"; prs: Pr[]; um: number } | { art: "unbekannt"; um: number } | { art: "laedt" };

// Ein Aufruf von gh mit zusaetzlicher Umgebung nur fuer diesen Prozess; stdout oder null.
export type GhLauf = (args: string[], env: Record<string, string>) => Promise<string | null>;

// Die offenen PRs eines Repos, null wenn gh scheitert. Hat gh einen Login, dessen Name der Besitzer
// ist, geht dessen Token als GH_TOKEN nur in den Aufruf von `gh pr list`, sonst gilt der aktive
// Login. Das Token bleibt in dieser Funktion.
export async function holePrs(gh: GhLauf, r: GithubRepo): Promise<Pr[] | null> {
  const token = (await gh(["auth", "token", "--user", r.owner], {}).catch(() => null))?.trim();
  const env: Record<string, string> = token ? { GH_TOKEN: token } : {};
  const aus = await gh(["pr", "list", "--repo", `${r.owner}/${r.repo}`, "--state", "open", "--limit", "50", "--json", "number,title,url,isDraft,headRefName"], env).catch(() => null);
  if (aus === null) return null;
  let roh: unknown;
  try {
    roh = JSON.parse(aus);
  } catch {
    return null;
  }
  if (!Array.isArray(roh)) return null;
  return roh.flatMap((x): Pr[] => {
    if (!x || typeof x !== "object") return [];
    const { number, title, url, isDraft, headRefName } = x as Record<string, unknown>;
    if (typeof number !== "number" || typeof url !== "string" || !/^https:\/\//.test(url)) return [];
    return [{ nummer: number, titel: typeof title === "string" ? title : "", url, entwurf: isDraft === true, zweig: typeof headRefName === "string" ? headRefName : "" }];
  });
}

export interface PrVorrat {
  // Der bekannte Stand sofort; fehlt er oder ist er aelter als die Frist, fragt gh im Hintergrund.
  stand(r: GithubRepo): PrStand;
  // Wartet auf alle laufenden Abfragen.
  fertig(): Promise<void>;
}

// Haelt je Repo das Ergebnis `vorhaltenMs`; ein Fehler gilt als "unbekannt" und ebenso lange.
export function prVorrat(gh: GhLauf, vorhaltenMs = 60_000, uhr: () => number = Date.now): PrVorrat {
  const eintraege = new Map<string, { stand: PrStand; laeuft: Promise<void> | null }>();
  return {
    stand(r) {
      const schluessel = `${r.owner}/${r.repo}`;
      let e = eintraege.get(schluessel);
      if (!e) eintraege.set(schluessel, (e = { stand: { art: "laedt" }, laeuft: null }));
      const eintrag = e;
      const alt = eintrag.stand.art === "laedt" || uhr() - eintrag.stand.um >= vorhaltenMs;
      if (alt && !eintrag.laeuft) {
        eintrag.laeuft = holePrs(gh, r)
          .catch(() => null)
          .then((prs) => {
            eintrag.stand = prs === null ? { art: "unbekannt", um: uhr() } : { art: "ok", prs, um: uhr() };
            eintrag.laeuft = null;
          });
      }
      return eintrag.stand;
    },
    async fertig() {
      await Promise.all([...eintraege.values()].map((e) => e.laeuft));
    },
  };
}

// --- Aufruf --------------------------------------------------------------------------------

const selbst = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (selbst) {
  const [art, home, register] = process.argv.slice(2);
  if (art !== "--json" || !home) {
    console.error("firstmate: Aufruf firstmate.ts --json HOME [REGISTER]");
    process.exit(2);
  }
  if (!istFirstmateHome(home)) {
    console.error(`firstmate: ${home} ist kein Firstmate-Home`);
    process.exit(1);
  }
  console.log(JSON.stringify(firstmateSicht(home, { register })));
}
