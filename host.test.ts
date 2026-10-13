// host: Tests der /proc-Parser und der sichtbarkeitsgesteuerten Abfrage, `node --test host.test.ts`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { befehlKurz, cpuProzent, cwdKurz, hostSicht, laufzeitKurz, oberste, parseLoadavg, parseMeminfo, parseProzessStat, parseSeitengroesse, parseStat, parseSwapMb } from "./host.ts";

test("parseStat und cpuProzent: Delta aus Summe und Leerlauf (idle + iowait)", () => {
  const a = parseStat("cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 50 0 50 350 50 0 0 0 0 0\n");
  const b = parseStat("cpu  200 0 200 760 140 0 0 0 0 0\n");
  assert.deepEqual(a, { gesamt: 1000, leer: 800 });
  assert.deepEqual(b, { gesamt: 1300, leer: 900 });
  assert.equal(cpuProzent(a!, b!), (200 / 300) * 100);
  assert.equal(cpuProzent(a!, a!), 0);
  assert.equal(parseStat("intr 1 2 3\n"), null);
  assert.equal(parseStat("cpu  a b c d\n"), null);
});

test("parseLoadavg: drei Zahlen, sonst null", () => {
  assert.deepEqual(parseLoadavg("0.52 1.25 0.03 2/411 98765\n"), [0.52, 1.25, 0.03]);
  assert.equal(parseLoadavg(""), null);
  assert.equal(parseLoadavg("x y z"), null);
});

test("parseMeminfo: benutzt = gesamt - verfuegbar, Swap aus SwapTotal und SwapFree, in MB", () => {
  const m = parseMeminfo("MemTotal:       16384000 kB\nMemFree:         1024000 kB\nMemAvailable:    8192000 kB\nSwapTotal:       4096000 kB\nSwapFree:        3072000 kB\n");
  assert.equal(m?.gesamtMb, 16000);
  assert.equal(m?.verfuegbarMb, 8000);
  assert.equal(m?.benutztMb, 8000);
  assert.equal(m?.swapGesamtMb, 4000);
  assert.equal(m?.swapBenutztMb, 1000);
  assert.equal(parseMeminfo("MemTotal: 2048 kB\nMemFree: 1024 kB\n")?.benutztMb, 1);
  assert.equal(parseMeminfo("Cached: 5 kB\n"), null);
});

test("parseProzessStat: Name mit Leerzeichen und Klammern, Felder 14, 15, 22, 24", () => {
  const rest = "S 1 4321 4321 0 -1 4194304 100 0 0 0 70 30 0 0 20 0 1 0 5000 123456789 2500 18446744073709551615";
  const st = parseProzessStat(`4321 (my (odd) proc) ${rest}\n`);
  assert.deepEqual(st, { pid: 4321, name: "my (odd) proc", ticks: 100, start: 5000, rssSeiten: 2500 });
  assert.equal(parseProzessStat("kaputt"), null);
  assert.equal(parseProzessStat("1 (x) S 1"), null);
});

test("parseSeitengroesse: KernelPageSize in Bytes, sonst 4096", () => {
  assert.equal(parseSeitengroesse("Size: 8 kB\nKernelPageSize:       64 kB\nMMUPageSize: 64 kB\n"), 65536);
  assert.equal(parseSeitengroesse("Size: 8 kB\n"), 4096);
  assert.equal(parseSeitengroesse(""), 4096);
});

test("parseSwapMb: VmSwap in MB, ohne Zeile 0", () => {
  assert.equal(parseSwapMb("Name:\tfoo\nVmRSS:\t  1000 kB\nVmSwap:\t    2048 kB\n"), 2);
  assert.equal(parseSwapMb("Name:\tkthreadd\n"), 0);
});

test("befehlKurz: Programm ohne Pfad, Argumente, auf eine Zeile gekuerzt; ohne cmdline der Name in Klammern", () => {
  assert.equal(befehlKurz("/usr/bin/node\0--max-old\0app.js\0", "node"), "node --max-old app.js");
  assert.equal(befehlKurz("", "kworker/0:1"), "[kworker/0:1]");
  const lang = befehlKurz("/bin/x\0" + "a".repeat(100) + "\0", "x", 20);
  assert.equal(lang.length, 20);
  assert.ok(lang.endsWith("…"));
  assert.equal(befehlKurz("sh\0-c\0a\nb\0", "sh"), "sh -c a b");
});

test("cwdKurz: $HOME als ~, lange Pfade behalten das Ende", () => {
  assert.equal(cwdKurz("/home/ada/git/proj", "/home/ada"), "~/git/proj");
  assert.equal(cwdKurz("/home/ada", "/home/ada"), "~");
  assert.equal(cwdKurz("/home/adam/x", "/home/ada"), "/home/adam/x");
  assert.equal(cwdKurz("/", "/"), "/");
  assert.equal(cwdKurz("/a/b/c/d/e/f/g", "/home/ada", 8), "…d/e/f/g");
});

test("laufzeitKurz: s, m, h, T", () => {
  assert.deepEqual([45, 720, 11100, 183600].map(laufzeitKurz), ["45s", "12m", "3h 05m", "2T 3h"]);
  assert.equal(laufzeitKurz(-5), "0s");
});

test("oberste: absteigend, bei Gleichstand die kleinere PID, hoechstens n", () => {
  const l = [{ pid: 3, v: 5 }, { pid: 1, v: 5 }, { pid: 2, v: 9 }, { pid: 4, v: 1 }];
  assert.deepEqual(oberste(l, (x) => x.v, 3).map((x) => x.pid), [2, 1, 3]);
});

test("hostSicht: auf Linux gemessen und fuer die Vorhaltezeit dieselbe Antwort", { skip: process.platform !== "linux" }, async () => {
  const a = await hostSicht();
  assert.equal(a.verfuegbar, true);
  if (!a.verfuegbar) return;
  assert.ok(a.topCpu.length <= 5 && a.topRam.length <= 5 && a.topRam.length > 0);
  assert.ok(a.cpu >= 0 && a.cpu <= 100);
  assert.equal(await hostSicht(), a);
});

// --- Abfrage nur bei sichtbarer Seite -----------------------------------------------------------

function ansicht(): { sichtbarTakt: (d: unknown, ms: number, lade: () => void, zeit: unknown) => { start(): void; stopp(): void; ende(): void; laeuft(): boolean }; hostTeil: (auf: boolean) => string; setzeHost: (h: unknown) => void } {
  const g: Record<string, unknown> = {
    document: { getElementById: () => null, documentElement: { dataset: {} } },
    location: { pathname: "/", search: "" },
  };
  g.globalThis = g;
  vm.runInNewContext(readFileSync(path.join(import.meta.dirname, "ansicht", "live-plan.js"), "utf8"), g);
  return g.LivePlanAnsicht as ReturnType<typeof ansicht>;
}

function falscheUhr() {
  const laeufe = new Map<number, () => void>();
  let n = 0;
  return {
    laeufe,
    zeit: { setze: (f: () => void) => (laeufe.set(++n, f), n), loesche: (id: number) => void laeufe.delete(id) },
    tick: () => laeufe.forEach((f) => f()),
  };
}

function falschesDokument(zustand: string) {
  const hoerer: Record<string, () => void> = {};
  return {
    visibilityState: zustand,
    addEventListener: (art: string, f: () => void) => void (hoerer[art] = f),
    removeEventListener: (art: string) => void delete hoerer[art],
    hoerer,
    wechsle(neu: string) {
      this.visibilityState = neu;
      hoerer.visibilitychange?.();
    },
  };
}

test("sichtbarTakt: sichtbar laedt sofort und im Takt; verborgen stoppt; Sichtbarwerden laedt sofort", () => {
  const { sichtbarTakt } = ansicht();
  const uhr = falscheUhr();
  const d = falschesDokument("visible");
  let n = 0;
  const t = sichtbarTakt(d, 10000, () => n++, uhr.zeit);
  t.start();
  assert.equal(n, 1);
  uhr.tick();
  assert.equal(n, 2);
  d.wechsle("hidden");
  assert.equal(t.laeuft(), false);
  uhr.tick();
  assert.equal(n, 2);
  d.wechsle("visible");
  assert.equal(n, 3);
  assert.equal(t.laeuft(), true);
  assert.equal(uhr.laeufe.size, 1);
});

test("sichtbarTakt: verborgen beim Start fragt nichts; ende loest den Hoerer und startet nie wieder", () => {
  const { sichtbarTakt } = ansicht();
  const uhr = falscheUhr();
  const d = falschesDokument("hidden");
  let n = 0;
  const t = sichtbarTakt(d, 10000, () => n++, uhr.zeit);
  t.start();
  assert.equal(n, 0);
  assert.equal(uhr.laeufe.size, 0);
  d.wechsle("visible");
  assert.equal(n, 1);
  t.ende();
  assert.equal(uhr.laeufe.size, 0);
  assert.equal(d.hoerer.visibilitychange, undefined);
  t.start();
  assert.equal(n, 1);
});

test("hostTeil: ohne verfuegbare Daten leer, sonst dicht mit ~ und Top-Listen", () => {
  const a = ansicht();
  assert.equal(a.hostTeil(false), "");
  a.setzeHost({ verfuegbar: false });
  assert.equal(a.hostTeil(false), "");
  a.setzeHost({
    verfuegbar: true, cpu: 37.4, last: [1.5, 1.25, 0.75], kerne: 8,
    speicher: { gesamtMb: 16000, benutztMb: 8000, verfuegbarMb: 8000, swapGesamtMb: 4000, swapBenutztMb: 1000 },
    platten: [{ pfad: "/tmp", gesamtMb: 2000, benutztMb: 500, prozent: 25 }],
    topCpu: [{ pid: 42, cpu: 88, rssMb: 300, swapMb: 0, laufzeit: "3h 05m", cwd: "~/git/<x>", befehl: "node app.js" }],
    topRam: [],
  });
  const h = a.hostTeil(true);
  assert.match(h, /data-testid="sitzung-host"/);
  assert.match(h, /37 %/);
  assert.match(h, /title="Last 1\.50 1\.25 0\.75"/);
  assert.match(h, /8000 MB|7\.8 \/ 15\.6 GB/);
  assert.match(h, /\/tmp/);
  assert.match(h, /<details class="hw-details" open>/);
  assert.match(h, /~\/git\/&lt;x&gt;/);
  assert.doesNotMatch(a.hostTeil(false), /details class="hw-details" open/);
});

test("hostTeil: vier Balken, gelb ab 60 %, rot ab 80 %", () => {
  const a = ansicht();
  a.setzeHost({
    verfuegbar: true, cpu: 17, last: [0.5, 1, 2], kerne: 8,
    speicher: { gesamtMb: 16000, benutztMb: 9600, verfuegbarMb: 6400, swapGesamtMb: 4000, swapBenutztMb: 1000 },
    platten: [{ pfad: "/tmp", gesamtMb: 4000, benutztMb: 21, prozent: 1 }, { pfad: "/", gesamtMb: 128000, benutztMb: 105000, prozent: 82 }],
    topCpu: [], topRam: [],
  });
  const h = a.hostTeil(false);
  const reihen = h.match(/<div class="hw-reihe[^"]*"/g) ?? [];
  assert.deepEqual(reihen, ['<div class="hw-reihe"', '<div class="hw-reihe gelb"', '<div class="hw-reihe"', '<div class="hw-reihe rot"']);
  assert.match(h, /<span class="k">CPU<\/span>/);
  assert.match(h, /<span class="k">Platte<\/span>/);
  assert.match(h, /17 %/);
  assert.match(h, /9\.4 \/ 15\.6 GB/);
  assert.match(h, /21 MB \/ 3\.9 GB/);
  assert.match(h, /102\.5 \/ 125 GB/);
  assert.match(h, /title="Swap 1\.0 GB|title="Swap 1000 MB/);
  assert.match(h, /style="width:82%"/);
});
