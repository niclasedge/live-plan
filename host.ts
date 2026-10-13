// live-plan: Last des Rechners, auf dem der Server laeuft, direkt aus /proc gelesen (kein top, ps oder Shell).
// Die Parser nehmen Text und sind per `node --test host.test.ts` pruefbar; hostSicht liest die Platte
// und haelt das Ergebnis HOST_VORHALTEN_MS lang, damit mehrere offene Tabs eine Messung teilen.

import { readdirSync, readFileSync, readlinkSync, statfsSync } from "node:fs";
import os from "node:os";

export const HOST_VORHALTEN_MS = 5000;
export const HOST_TOP = 5;
const TICKS = 100; // CLK_TCK; auf Linux praktisch immer 100
const BASIS_MAX_MS = 3 * HOST_VORHALTEN_MS; // aelter, und das CPU-Delta waere ein Mittel ueber die ganze Pause

export type Cpu = { gesamt: number; leer: number };
export type Speicher = { gesamtMb: number; benutztMb: number; verfuegbarMb: number; swapGesamtMb: number; swapBenutztMb: number };
export type Platte = { pfad: string; gesamtMb: number; benutztMb: number; prozent: number };
export type Prozess = { pid: number; cpu: number; rssMb: number; swapMb: number; laufzeit: string; cwd: string; befehl: string };
export type HostSicht =
  | { verfuegbar: false }
  | { verfuegbar: true; um: number; cpu: number; last: [number, number, number]; kerne: number; speicher: Speicher; platten: Platte[]; topCpu: Prozess[]; topRam: Prozess[] };

/** Die erste Zeile `cpu ...` aus /proc/stat: Summe aller Zaehler und davon die Leerlaufzeit (idle + iowait). */
export function parseStat(text: string): Cpu | null {
  const zeile = text.split("\n").find((z) => z.startsWith("cpu "));
  if (!zeile) return null;
  const z = zeile.trim().split(/\s+/).slice(1).map(Number);
  if (z.length < 4 || z.some((n) => !Number.isFinite(n))) return null;
  // guest und guest_nice sind schon in user und nice enthalten.
  return { gesamt: z.slice(0, 8).reduce((a, b) => a + b, 0), leer: z[3]! + (z[4] ?? 0) };
}

/** CPU-Auslastung in Prozent zwischen zwei Staenden; ohne Fortschritt 0. */
export function cpuProzent(vorher: Cpu, jetzt: Cpu): number {
  const d = jetzt.gesamt - vorher.gesamt;
  if (d <= 0) return 0;
  return Math.max(0, Math.min(100, ((d - (jetzt.leer - vorher.leer)) / d) * 100));
}

export function parseLoadavg(text: string): [number, number, number] | null {
  const z = text.trim().split(/\s+/).slice(0, 3).map(Number);
  return z.length === 3 && z.every(Number.isFinite) ? [z[0]!, z[1]!, z[2]!] : null;
}

/** /proc/meminfo in MB (die Werte stehen in kB). Ohne MemAvailable gilt MemFree. */
export function parseMeminfo(text: string): Speicher | null {
  const kb: Record<string, number> = {};
  for (const m of text.matchAll(/^(\w+):\s+(\d+)/gm)) kb[m[1]!] = Number(m[2]);
  if (kb.MemTotal === undefined) return null;
  const mb = (k: number) => k / 1024;
  const verfuegbar = kb.MemAvailable ?? kb.MemFree ?? 0;
  const swapGesamt = kb.SwapTotal ?? 0;
  return {
    gesamtMb: mb(kb.MemTotal),
    benutztMb: mb(kb.MemTotal - verfuegbar),
    verfuegbarMb: mb(verfuegbar),
    swapGesamtMb: mb(swapGesamt),
    swapBenutztMb: mb(swapGesamt - (kb.SwapFree ?? swapGesamt)),
  };
}

/** /proc/PID/stat: der Name steht in Klammern und darf Leerzeichen und Klammern enthalten, also ab der letzten `)`. */
export function parseProzessStat(text: string): { pid: number; name: string; ticks: number; start: number; rssSeiten: number } | null {
  const auf = text.indexOf("(");
  const zu = text.lastIndexOf(")");
  if (auf < 0 || zu < auf) return null;
  const f = text.slice(zu + 2).trim().split(/\s+/); // f[0] ist Feld 3 (state)
  const feld = (n: number) => Number(f[n - 3]);
  const [utime, stime, start, rss, pid] = [feld(14), feld(15), feld(22), feld(24), Number(text.slice(0, auf))];
  if (![utime, stime, start, rss, pid].every(Number.isFinite)) return null;
  return { pid, name: text.slice(auf + 1, zu), ticks: utime + stime, start, rssSeiten: rss };
}

/** KernelPageSize (kB) aus /proc/PID/smaps in Bytes; ohne die Zeile 4096. */
export function parseSeitengroesse(smaps: string): number {
  const m = /^KernelPageSize:\s+(\d+)\s*kB/m.exec(smaps);
  return m && Number(m[1]) > 0 ? Number(m[1]) * 1024 : 4096;
}

/** VmSwap aus /proc/PID/status in MB; fehlt die Zeile (Kernel-Thread), 0. */
export function parseSwapMb(status: string): number {
  const m = /^VmSwap:\s+(\d+)/m.exec(status);
  return m ? Number(m[1]) / 1024 : 0;
}

/** /proc/PID/cmdline (durch NUL getrennt) als eine Zeile: Programm ohne Pfad, dann die Argumente, auf `breite` gekuerzt. */
export function befehlKurz(cmdline: string, name: string, breite = 60): string {
  const teile = cmdline.split("\0").filter((t) => t !== "");
  const text = teile.length ? [teile[0]!.split("/").pop()!, ...teile.slice(1)].join(" ") : `[${name}]`;
  const ein = text.replace(/\s+/g, " ").trim();
  return ein.length > breite ? ein.slice(0, breite - 1) + "…" : ein;
}

/** $HOME als ~; ein langer Pfad behaelt seinen Anfang mit ~ und sein Ende. */
export function cwdKurz(cwd: string, home: string, breite = 32): string {
  let p = cwd;
  if (home && home !== "/" && (p === home || p.startsWith(home + "/"))) p = "~" + p.slice(home.length);
  return p.length > breite ? "…" + p.slice(p.length - (breite - 1)) : p;
}

/** Laufzeit wie ps: 45s, 12m, 3h 05m, 2T 4h. */
export function laufzeitKurz(sek: number): string {
  const s = Math.max(0, Math.floor(sek));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  return `${Math.floor(s / 86400)}T ${Math.floor((s % 86400) / 3600)}h`;
}

type Roh = { pid: number; name: string; ticks: number; start: number; rssMb: number };

/** Die obersten n nach `schluessel`, absteigend; bei Gleichstand die kleinere PID. */
export function oberste<T extends { pid: number }>(liste: T[], schluessel: (x: T) => number, n = HOST_TOP): T[] {
  return [...liste].sort((a, b) => schluessel(b) - schluessel(a) || a.pid - b.pid).slice(0, n);
}

function lies(pfad: string): string | null {
  try {
    return readFileSync(pfad, "utf8");
  } catch {
    return null; // der Prozess ist weg oder gehoert niemandem, den wir lesen duerfen
  }
}

function plattenLage(pfad: string): Platte | null {
  try {
    const s = statfsSync(pfad);
    const gesamt = (s.blocks * s.bsize) / 1048576;
    const benutzt = ((s.blocks - s.bfree) * s.bsize) / 1048576;
    return { pfad, gesamtMb: gesamt, benutztMb: benutzt, prozent: gesamt > 0 ? (benutzt / gesamt) * 100 : 0 };
  } catch {
    return null;
  }
}

let seite = 0;
let vorherCpu: Cpu | null = null;
let vorherProzess = new Map<number, number>();
let vorherUm = 0;
let vorrat: { um: number; sicht: Promise<HostSicht> } | null = null;

/** Misst jetzt (ohne Vorrat). Die CPU-Werte sind das Delta zur letzten Messung; die erste Messung wartet kurz. */
async function messe(): Promise<HostSicht> {
  const stat = parseStat(lies("/proc/stat") ?? "");
  const last = parseLoadavg(lies("/proc/loadavg") ?? "");
  const speicher = parseMeminfo(lies("/proc/meminfo") ?? "");
  if (!stat || !last || !speicher) return { verfuegbar: false };
  if (!seite) seite = parseSeitengroesse(lies("/proc/self/smaps") ?? "");
  if (!vorherCpu || Date.now() - vorherUm > BASIS_MAX_MS) {
    vorherCpu = stat;
    vorherUm = Date.now();
    vorherProzess = new Map();
    for (const n of readdirSync("/proc")) {
      const st = /^\d+$/.test(n) ? parseProzessStat(lies(`/proc/${n}/stat`) ?? "") : null;
      if (st) vorherProzess.set(st.pid, st.ticks);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  const jetztStat = parseStat(lies("/proc/stat") ?? "") ?? stat;
  const jetztUm = Date.now();
  const sek = Math.max((jetztUm - vorherUm) / 1000, 0.001);
  const cpu = cpuProzent(vorherCpu, jetztStat);
  const hoch = Number(/^\S+/.exec(lies("/proc/uptime") ?? "")?.[0] ?? 0);
  const roh: (Roh & { cpu: number })[] = [];
  const jetztProzess = new Map<number, number>();
  for (const n of readdirSync("/proc")) {
    if (!/^\d+$/.test(n)) continue;
    const st = parseProzessStat(lies(`/proc/${n}/stat`) ?? "");
    if (!st) continue;
    jetztProzess.set(st.pid, st.ticks);
    const davor = vorherProzess.get(st.pid);
    const lebt = hoch - st.start / TICKS;
    // Neu seit der letzten Messung: Anteil an der bisherigen Lebenszeit, wie ps.
    const proz = davor !== undefined ? ((st.ticks - davor) / TICKS / sek) * 100 : lebt > 0 ? (st.ticks / TICKS / lebt) * 100 : 0;
    roh.push({ pid: st.pid, name: st.name, ticks: st.ticks, start: st.start, rssMb: (st.rssSeiten * seite) / 1048576, cpu: Math.max(0, proz) });
  }
  vorherCpu = jetztStat;
  vorherProzess = jetztProzess;
  vorherUm = jetztUm;

  const home = os.homedir();
  const ausbauen = (r: Roh & { cpu: number }): Prozess => {
    const pid = r.pid;
    let cwd = "";
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      /* fremder Prozess */
    }
    return {
      pid,
      cpu: r.cpu,
      rssMb: r.rssMb,
      swapMb: parseSwapMb(lies(`/proc/${pid}/status`) ?? ""),
      laufzeit: laufzeitKurz(hoch - r.start / TICKS),
      cwd: cwdKurz(cwd, home),
      befehl: befehlKurz(lies(`/proc/${pid}/cmdline`) ?? "", r.name),
    };
  };
  return {
    verfuegbar: true,
    um: jetztUm,
    cpu,
    last,
    kerne: os.cpus().length,
    speicher,
    platten: ["/tmp", "/"].map(plattenLage).filter((p): p is Platte => p !== null),
    topCpu: oberste(roh, (r) => r.cpu).map(ausbauen),
    topRam: oberste(roh, (r) => r.rssMb).map(ausbauen),
  };
}

/** Die Sicht fuer GET /api/host; Aufrufer innerhalb von HOST_VORHALTEN_MS bekommen dieselbe. Ohne /proc: verfuegbar false; ein Messfehler wirft. */
export async function hostSicht(): Promise<HostSicht> {
  if (process.platform !== "linux") return { verfuegbar: false };
  if (vorrat && Date.now() - vorrat.um < HOST_VORHALTEN_MS) return vorrat.sicht;
  // Das Versprechen selbst liegt im Vorrat, damit gleichzeitige Aufrufe nicht doppelt messen.
  const eintrag = { um: Date.now(), sicht: messe() };
  vorrat = eintrag;
  // Ein Messfehler ist kein "nicht verfuegbar": nicht vorhalten, der Aufrufer sieht den Fehler.
  eintrag.sicht.catch(() => {
    if (vorrat === eintrag) vorrat = null;
  });
  return eintrag.sicht;
}
