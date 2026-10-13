// verlauf: Tests des Ringpuffers fuer CPU und RAM, `node --test verlauf.test.ts`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { erzeugeVerlauf, VERLAUF_MAX, VERLAUF_RUHE_MS, VERLAUF_TAKT_MS } from "./verlauf.ts";

function umgebung() {
  let t = 1_000_000;
  let gesamt = 1000;
  let leer = 1000;
  const gelesen: string[] = [];
  let timer: (() => void) | null = null;
  let gesetzt = 0;
  let geloescht = 0;
  const q = {
    lies: (pfad: string) => {
      gelesen.push(pfad);
      if (pfad === "/proc/stat") return `cpu  ${gesamt - leer} 0 0 ${leer} 0 0 0 0 0 0\n`;
      if (pfad === "/proc/meminfo") return "MemTotal: 1000 kB\nMemAvailable: 750 kB\n";
      return null;
    },
    jetzt: () => t,
    setzeTakt: (f: () => void) => ((timer = f), ++gesetzt),
    loescheTakt: () => ((timer = null), void geloescht++),
  };
  return {
    q,
    gelesen,
    zaehler: () => ({ gesetzt, geloescht, laeuft: timer !== null }),
    /** Eine Taktlaenge weiter; die CPU war in dieser Zeit zu `cpuProz` Prozent ausgelastet. */
    tick(cpuProz = 50) {
      t += VERLAUF_TAKT_MS;
      gesamt += 100;
      leer += 100 - cpuProz;
      timer?.();
    },
    warte: (ms: number) => void (t += ms),
  };
}

test("lazy: ohne Anfrage kein Takt, die erste Anfrage startet ihn, die erste Probe setzt nur die Basis", () => {
  const u = umgebung();
  const v = erzeugeVerlauf(u.q);
  assert.equal(v.laeuft(), false);
  assert.equal(u.zaehler().gesetzt, 0);
  v.beruehre();
  assert.equal(v.laeuft(), true);
  assert.equal(v.anzahl(), 0);
  u.tick(40);
  assert.equal(v.anzahl(), 1);
  const s = v.sicht();
  assert.deepEqual([s.takt, s.cpu, s.ram, s.vor], [15, [40], [25], [0]]);
});

test("weitere Anfragen starten keinen zweiten Takt; ohne Anfrage endet er nach VERLAUF_RUHE_MS", () => {
  const u = umgebung();
  const v = erzeugeVerlauf(u.q);
  v.beruehre();
  v.beruehre();
  assert.equal(u.zaehler().gesetzt, 1);
  u.warte(VERLAUF_RUHE_MS - VERLAUF_TAKT_MS);
  u.tick();
  assert.equal(v.laeuft(), true);
  v.beruehre(); // eine Anfrage haelt ihn am Leben
  u.tick();
  assert.equal(v.laeuft(), true);
  u.warte(VERLAUF_RUHE_MS);
  u.tick();
  assert.equal(v.laeuft(), false);
  assert.equal(u.zaehler().geloescht, 1);
  const n = v.anzahl();
  u.tick(); // kein Takt mehr, keine Probe
  assert.equal(v.anzahl(), n);
  v.beruehre(); // neu starten
  assert.equal(v.laeuft(), true);
  assert.equal(u.zaehler().gesetzt, 2);
});

test("Ringpuffer: bei VERLAUF_MAX Schluss, danach ueberschreibt er die aeltesten, Reihenfolge bleibt", () => {
  assert.equal(VERLAUF_MAX, 240);
  const u = umgebung();
  const v = erzeugeVerlauf(u.q);
  v.beruehre();
  for (let i = 0; i < VERLAUF_MAX + 10; i++) {
    u.tick(i % 100);
    v.beruehre();
  }
  assert.equal(v.anzahl(), VERLAUF_MAX);
  const s = v.sicht();
  assert.equal(s.cpu.length, VERLAUF_MAX);
  assert.equal(s.vor.length, VERLAUF_MAX);
  // Die Proben 0..9 sind weg; die aelteste ist Probe 10, die neueste Probe 249.
  assert.equal(s.cpu[0], 10);
  assert.equal(s.cpu[VERLAUF_MAX - 1], 49);
  assert.equal(s.vor[VERLAUF_MAX - 1], 0);
  assert.equal(s.vor[0], (VERLAUF_MAX - 1) * 15);
  assert.ok(s.vor.every((x, i, a) => i === 0 || x < a[i - 1]!));
});

test("Proben lesen nur /proc/stat und /proc/meminfo, keine Prozessliste", () => {
  const u = umgebung();
  const v = erzeugeVerlauf(u.q);
  v.beruehre();
  for (let i = 0; i < 5; i++) u.tick();
  assert.ok(u.gelesen.length >= 10);
  assert.deepEqual([...new Set(u.gelesen)].sort(), ["/proc/meminfo", "/proc/stat"]);
});

test("fehlt /proc: keine Probe, kein Fehler", () => {
  const u = umgebung();
  const v = erzeugeVerlauf({ ...u.q, lies: () => null });
  v.beruehre();
  u.tick();
  assert.equal(v.anzahl(), 0);
  assert.deepEqual(v.sicht().cpu, []);
});
