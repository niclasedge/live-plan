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

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { alter, homeAusUmgebung, lagebild, notizenText, prKurz, q, zustand } from "./firstmate.ts";
import type { Lagebild, Optionen, Worker, Zustand } from "./firstmate.ts";

// Die reine Logik und das Lesen des Home liegen in firstmate.ts, das auch der Server nutzt.
export * from "./firstmate.ts";

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
  const text = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const zeilen = text.split("\n").slice(1);
  const ende = zeilen.findIndex((z) => !z.startsWith("//"));
  const kopf = zeilen.slice(0, ende).map((z) => z.replace(/^\/\/ ?/, ""));
  (code ? console.error : console.log)(kopf.join("\n"));
  process.exit(code);
}

async function main(argv: string[]): Promise<void> {
  let home = homeAusUmgebung(process.env) ?? "/work/firstmate";
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
