// live-plan: Verlauf von CPU und RAM des Rechners, die letzten 60 Minuten, im Speicher des Servers.
// Ein Ringpuffer fester Groesse (VERLAUF_MAX Proben im Abstand VERLAUF_TAKT_MS), gefuellt nur aus
// /proc/stat und /proc/meminfo, nie aus der Prozessliste. Der Takt startet bei der ersten Anfrage und
// endet, wenn VERLAUF_RUHE_MS lang keine mehr kam; geschrieben wird nichts auf die Platte.

import { readFileSync } from "node:fs";
import { cpuProzent, parseMeminfo, parseStat, type Cpu } from "./host.ts";

export const VERLAUF_TAKT_MS = 15_000;
export const VERLAUF_MAX = 240; // 240 x 15 s = 60 min
export const VERLAUF_RUHE_MS = 5 * 60_000; // so lange ohne Anfrage, dann hoert das Messen auf

export type Probe = { um: number; cpu: number; ram: number };
export type VerlaufSicht = { takt: number; vor: number[]; cpu: number[]; ram: number[] };

export type VerlaufQuellen = {
  lies: (pfad: string) => string | null;
  jetzt: () => number;
  setzeTakt: (f: () => void, ms: number) => unknown;
  loescheTakt: (id: unknown) => void;
};

const echt: VerlaufQuellen = {
  lies: (pfad) => {
    try {
      return readFileSync(pfad, "utf8");
    } catch {
      return null;
    }
  },
  jetzt: () => Date.now(),
  setzeTakt: (f, ms) => {
    const t = setInterval(f, ms);
    t.unref?.(); // der Takt allein haelt den Server nicht am Leben
    return t;
  },
  loescheTakt: (id) => clearInterval(id as ReturnType<typeof setInterval>),
};

const eine = (x: number) => Math.round(x * 10) / 10;

export function erzeugeVerlauf(q: VerlaufQuellen = echt) {
  const um = new Float64Array(VERLAUF_MAX);
  const cpu = new Float32Array(VERLAUF_MAX);
  const ram = new Float32Array(VERLAUF_MAX);
  let kopf = 0; // naechster Schreibplatz
  let anzahl = 0;
  let basis: Cpu | null = null;
  let zuletzt = 0;
  let takt: unknown = null;

  function probe(): void {
    const stat = parseStat(q.lies("/proc/stat") ?? "");
    const mem = parseMeminfo(q.lies("/proc/meminfo") ?? "");
    if (!stat || !mem) return;
    const davor = basis;
    basis = stat;
    if (!davor || mem.gesamtMb <= 0) return; // die erste Probe setzt nur die CPU-Basis
    um[kopf] = q.jetzt();
    cpu[kopf] = cpuProzent(davor, stat);
    ram[kopf] = (mem.benutztMb / mem.gesamtMb) * 100;
    kopf = (kopf + 1) % VERLAUF_MAX;
    anzahl = Math.min(anzahl + 1, VERLAUF_MAX);
  }

  function tick(): void {
    if (q.jetzt() - zuletzt > VERLAUF_RUHE_MS) halte();
    else probe();
  }

  function halte(): void {
    if (takt === null) return;
    q.loescheTakt(takt);
    takt = null;
    basis = null; // nach der Pause waere ein CPU-Delta ein Mittel ueber die ganze Luecke
  }

  /** Jede Anfrage ruft das: merkt sich den Zeitpunkt und startet den Takt, falls er ruht. */
  function beruehre(): void {
    zuletzt = q.jetzt();
    if (takt !== null) return;
    probe();
    takt = q.setzeTakt(tick, VERLAUF_TAKT_MS);
  }

  /** Die Proben, aelteste zuerst; `vor` sind Sekunden vor jetzt. Ohne Proben leere Felder. */
  function sicht(): VerlaufSicht {
    const jetzt = q.jetzt();
    const s: VerlaufSicht = { takt: VERLAUF_TAKT_MS / 1000, vor: [], cpu: [], ram: [] };
    for (let i = 0; i < anzahl; i++) {
      const k = (kopf - anzahl + i + VERLAUF_MAX) % VERLAUF_MAX;
      s.vor.push(Math.max(0, Math.round((jetzt - um[k]!) / 1000)));
      s.cpu.push(eine(cpu[k]!));
      s.ram.push(eine(ram[k]!));
    }
    return s;
  }

  return { beruehre, sicht, probe, laeuft: () => takt !== null, anzahl: () => anzahl };
}

export const verlauf = erzeugeVerlauf();
