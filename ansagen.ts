// live-plan: Ansagen, kurze gesprochene Zusammenfassungen am Ende eines Agenten-Zugs, ueber alle Sitzungen.
//
// Geschrieben werden sie nur auf diesem Rechner: von `live-plan sage` (ein Agent mit eigenem Text) und von
// `live-plan sage --auto`, das die Mod live-plan-sitzung am Ende jedes Zugs der Hauptsitzung mit der letzten
// Antwort ruft. Beide haengen eine Zeile an LIVE_PLAN_CACHE/ansagen.jsonl; der Server liest die Datei nur
// (GET /api/ansagen, GET /api/ereignisse) und die Uebersicht liest sie mit der Sprachausgabe des Browsers vor.
// Eine kaputte Zeile oder eine fehlende Datei ergibt weniger oder keine Ansagen, nie einen Fehler.

import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeSync } from "node:fs";
import path from "node:path";

export type Quelle = "auto" | "sage";

export interface Ansage {
  v: 1;
  /** Zeitpunkt in ms seit 1970. */
  zeit: number;
  /** Die Claude-Sitzung (Session-Id, zugleich SLUG), null ohne Sitzung. */
  id: string | null;
  /** Ordnername der Git-Wurzel, aus der die Ansage kommt. */
  repo: string;
  /** Der Sprechtext, ohne Markdown, Links und Code. */
  text: string;
  /** `sage`: vom Agenten selbst formuliert; `auto`: aus der letzten Antwort gekuerzt. */
  quelle: Quelle;
}

/** So viele Ansagen haelt die Datei; der Server liefert hoechstens so viele. */
export const ANSAGEN_HOECHSTENS = 200;
/** Erst bei so vielen Zeilen ueber der Grenze schreibt ein Schreiber die Datei gekuerzt neu, nicht bei jeder Ansage. */
const KUERZEN_PUFFER = 50;
/** Aus einer groesseren Datei liest der Server nur das Ende. */
const LESEN_HOECHSTENS = 1024 * 1024;
const TEXT_HOECHSTENS = 1000;
const REPO_HOECHSTENS = 200;
const ID = /^[A-Za-z0-9._-]+$/;

export const ansagenDatei = (cache: string) => path.join(cache, "ansagen.jsonl");

// --- Sprechtext ---------------------------------------------------------------------------------

/** Satzzeichen, nach denen eine Zeile als Satz endet; sonst haengt `sprechText` einen Punkt an. */
const SATZENDE = /[.!?…:;,]$/;
const ZAUN = /^\s*(`{3,}|~{3,})/;
const TABELLE = /^\s*\|/;
const LINIE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const UEBERSCHRIFT = /^\s*#{1,6}\s/;
/** "PR: <url>": ohne die URL bliebe nur das Etikett. */
const ETIKETT_URL = /^\s*(?:[-*+]\s+)?[^:\s][^:]{0,39}:\s*<?(?:(?:https?|ftp|file):\/\/|www\.)\S+\s*$/i;

const woerter = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/**
 * Ein Markdown-Text als Sprechtext: Codebloecke, Tabellen, Bilder, URLs, HTML und Emoji fallen weg, ein Link
 * wird zu seinem Text, Ueberschriften, Listen, Zitate und Hervorhebungen verlieren ihre Zeichen. Jede Zeile
 * endet als Satz; heraus kommt eine Zeile mit einfachen Leerzeichen.
 */
export function sprechText(roh: string): string {
  const zeilen: string[] = [];
  let zaun: string | null = null;
  for (const z of String(roh ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const m = ZAUN.exec(z);
    if (zaun !== null) {
      const zu = /^\s*(`{3,}|~{3,})\s*$/.exec(z)?.[1];
      if (zu && zu[0] === zaun[0] && zu.length >= zaun.length) zaun = null;
      continue;
    }
    if (m) {
      zaun = m[1]!;
      continue;
    }
    if (TABELLE.test(z) || LINIE.test(z) || UEBERSCHRIFT.test(z) || ETIKETT_URL.test(z)) continue;
    const zeile = inline(
      z
        .replace(/^\s*(>\s*)+/, "")
        .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/, "")
        .replace(/^\[[ xX]\]\s+/, ""),
    ).replace(/:$/, ".");
    if (!/[\p{L}\p{N}]/u.test(zeile)) continue;
    zeilen.push(SATZENDE.test(zeile) ? zeile : `${zeile}.`);
  }
  return zeilen.join(" ").replace(/\s+/g, " ").trim();
}

function inline(s: string): string {
  return s
    .replace(/<(?:https?|ftp|file|mailto):[^>]*>/gi, "")
    .replace(/<\/?[A-Za-z][^>]*>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/`+([^`]*)`+/g, "$1")
    // Eine URL endet vor einem Satzzeichen; das bleibt als Ende des Satzes stehen.
    .replace(/\b(?:(?:https?|ftp|file):\/\/|www\.)[^\s<>()\]]*[^\s<>()\].,;:!?'"]/gi, "")
    .replace(/(\*\*|__|~~)(?=\S)(.+?)\1/g, "$2")
    .replace(/(^|[^\p{L}\p{N}*])\*(?=\S)([^*]+?)\*(?![\p{L}\p{N}])/gu, "$1$2")
    .replace(/(^|[^\p{L}\p{N}_])_(?=\S)([^_]+?)_(?![\p{L}\p{N}])/gu, "$1$2")
    .replace(/\p{Extended_Pictographic}️?/gu, "")
    .replace(/\s*(?:->|=>|→|⇒)\s*/g, ", ")
    .replace(/[*_`#|~<>^\\[\]{}]/g, " ")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Abkuerzungen, nach deren Punkt kein Satz endet (klein geschrieben, ohne Punkt). */
const ABKUERZUNGEN = new Set(["z", "b", "d", "h", "u", "a", "s", "o", "bzw", "ca", "vgl", "usw", "etc", "nr", "dr", "ggf", "inkl", "evtl", "zb", "eg", "ie", "vs", "bspw", "max", "min"]);

/** Nach "13." beginnt mit einem Monat kein neuer Satz. */
const MONATE = /^(Januar|Februar|März|Maerz|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\b/;

/** Die Saetze eines Sprechtexts; ein Punkt nach einer Abkuerzung, einem Buchstaben oder einem Datum trennt nicht. */
export function saetze(text: string): string[] {
  const aus: string[] = [];
  let start = 0;
  const ende = /[.!?…]+["“”'»«)]*\s+/g;
  for (let m = ende.exec(text); m; m = ende.exec(text)) {
    const vorher = text.slice(start, m.index);
    const wort = /([\p{L}\p{N}.]+)$/u.exec(vorher)?.[1] ?? "";
    const danach = text.slice(m.index + m[0].length, m.index + m[0].length + 12);
    if (m[0][0] === ".") {
      const kern = wort.toLowerCase().replace(/\./g, "");
      if (ABKUERZUNGEN.has(kern) || /^\p{L}$/u.test(kern)) continue;
      if (/^\d+$/.test(kern) && (!/\p{Lu}/u.test(danach[0] ?? "") || MONATE.test(danach))) continue;
    }
    aus.push(text.slice(start, m.index + m[0].length).trim());
    start = m.index + m[0].length;
  }
  if (text.slice(start).trim()) aus.push(text.slice(start).trim());
  return aus;
}

/**
 * Die ersten `n` Saetze, zusammen hoechstens `zeichen` lang; mindestens der erste, der zu lange an einer
 * Wortgrenze mit `…` gekuerzt.
 */
export function kurzAnsage(text: string, n = 3, zeichen = 300): string {
  let aus = "";
  for (const s of saetze(text).slice(0, n)) {
    const neu = aus ? `${aus} ${s}` : s;
    if (neu.length > zeichen) {
      if (!aus) aus = kappe(s, zeichen);
      break;
    }
    aus = neu;
  }
  return aus;
}

function kappe(s: string, zeichen: number): string {
  if (s.length <= zeichen) return s;
  const schnitt = s.slice(0, zeichen - 1);
  const wort = schnitt.lastIndexOf(" ");
  return `${(wort > zeichen / 2 ? schnitt.slice(0, wort) : schnitt).replace(/[\s,;:.-]+$/, "")}…`;
}

/** Eine Antwort aus weniger als vier Woertern ("Captain, shipshape.") liest niemand vor. */
export function istTrivial(text: string): boolean {
  return woerter(text) < 4;
}

/**
 * Der Sprechtext einer Ansage, null wenn es keine gibt. `auto` (die letzte Antwort): die ersten drei Saetze bis
 * 300 Zeichen, eine triviale Antwort nicht. `sage` (vom Agenten selbst): bis sechs Saetze und 600 Zeichen.
 */
export function ansageText(roh: string, quelle: Quelle): string | null {
  const sauber = sprechText(roh);
  const text = quelle === "auto" ? kurzAnsage(sauber, 3, 300) : kurzAnsage(sauber, 6, 600);
  if (!text || (quelle === "auto" && istTrivial(text))) return null;
  return text;
}

// --- Speicher -----------------------------------------------------------------------------------

/** Eine Zeile der Datei als Ansage, null wenn sie nicht passt; der Text wird beim Lesen noch einmal gesaeubert. */
export function ansageAus(zeile: unknown): Ansage | null {
  if (!zeile || typeof zeile !== "object") return null;
  const a = zeile as Record<string, unknown>;
  if (a.v !== 1 || typeof a.zeit !== "number" || !Number.isFinite(a.zeit) || a.zeit < 0) return null;
  if (a.quelle !== "auto" && a.quelle !== "sage") return null;
  if (typeof a.repo !== "string" || a.repo.length > REPO_HOECHSTENS) return null;
  if (a.id !== null && (typeof a.id !== "string" || !ID.test(a.id))) return null;
  if (typeof a.text !== "string" || a.text.length > TEXT_HOECHSTENS) return null;
  const text = sprechText(a.text);
  if (!text) return null;
  return { v: 1, zeit: a.zeit, id: a.id, repo: a.repo.replace(/[\u0000-\u001f\u007f]/g, "").trim(), text, quelle: a.quelle };
}

/** Die Ansagen eines Dateiinhalts, aelteste zuerst, die letzten `n`; kaputte Zeilen fallen weg. */
export function ansagenAus(inhalt: string, n = ANSAGEN_HOECHSTENS): Ansage[] {
  const aus: Ansage[] = [];
  for (const z of inhalt.split("\n")) {
    if (!z.trim()) continue;
    try {
      const a = ansageAus(JSON.parse(z));
      if (a) aus.push(a);
    } catch {
      /* kaputte Zeile */
    }
  }
  return aus.slice(-n);
}

/** Das Ende der Datei, hoechstens LESEN_HOECHSTENS Bytes, ohne Symlink; null, wenn es keine regulaere Datei gibt. */
function liesEnde(datei: string): string | null {
  let fd: number;
  try {
    fd = openSync(datei, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const laenge = Math.min(st.size, LESEN_HOECHSTENS);
    const puffer = Buffer.alloc(laenge);
    let gelesen = 0;
    while (gelesen < laenge) {
      const n = readSync(fd, puffer, gelesen, laenge - gelesen, st.size - laenge + gelesen);
      if (n <= 0) break;
      gelesen += n;
    }
    const text = puffer.subarray(0, gelesen).toString("utf8");
    // Mitten in der Datei angefangen: die erste, angeschnittene Zeile faellt weg.
    return st.size > laenge ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Die gespeicherten Ansagen, aelteste zuerst; ohne lesbare Datei keine. */
export function leseAnsagen(datei: string, n = ANSAGEN_HOECHSTENS): Ansage[] {
  const inhalt = liesEnde(datei);
  return inhalt === null ? [] : ansagenAus(inhalt, n);
}

/**
 * Haengt eine Ansage an (O_APPEND, eine Zeile in einem write, ohne Symlink). Hat die Datei danach mehr als
 * `n + KUERZEN_PUFFER` Zeilen, ersetzt sie eine Fassung mit den letzten `n` (neue Datei, dann rename).
 */
export function schreibeAnsage(datei: string, a: Ansage, n = ANSAGEN_HOECHSTENS): void {
  mkdirSync(path.dirname(datei), { recursive: true });
  const fd = openSync(datei, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o644);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${datei} ist keine regulaere Datei`);
    writeSync(fd, `${JSON.stringify(a)}\n`);
  } finally {
    closeSync(fd);
  }
  const inhalt = liesEnde(datei);
  if (inhalt === null || inhalt.split("\n").filter((z) => z.trim()).length <= n + KUERZEN_PUFFER) return;
  const neu = `${datei}.${process.pid}.neu`;
  try {
    const tmp = openSync(neu, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try {
      writeSync(tmp, ansagenAus(inhalt, n).map((x) => `${JSON.stringify(x)}\n`).join(""));
    } finally {
      closeSync(tmp);
    }
    renameSync(neu, datei);
  } catch {
    rmSync(neu, { force: true });
  }
}

/** Ob die Sitzung `id` seit `seit` (ms) selbst etwas angesagt hat; dann entfaellt die automatische Ansage dieses Zugs. */
export function schonAngesagt(liste: readonly Ansage[], id: string, seit: number): boolean {
  return liste.some((a) => a.quelle === "sage" && a.id === id && a.zeit >= seit);
}
