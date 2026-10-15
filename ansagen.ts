// live-plan: Ansagen, gesprochene Zusammenfassungen am Ende eines Agenten-Zugs, ueber alle Sitzungen.
//
// Geschrieben werden sie nur auf diesem Rechner: von `live-plan sage` (ein Agent mit eigenem Text) und von
// `live-plan sage --auto`, das die Mod live-plan-sitzung am Ende jedes Zugs der Hauptsitzung mit der letzten
// Antwort ruft. Beide haengen eine Zeile an LIVE_PLAN_CACHE/ansagen.jsonl; der Server liest die Datei nur
// (GET /api/ansagen, GET /api/ereignisse) und die Uebersicht liest sie mit der Sprachausgabe des Browsers vor.
// Eine kaputte Zeile oder eine fehlende Datei ergibt weniger oder keine Ansagen, nie einen Fehler.
//
// Daneben liegen die Einstellungen der Sprachausgabe (LIVE_PLAN_CACHE/einstellungen.yaml): Vorlesen an oder aus
// und die Stimme. Die Uebersicht liest sie mit GET und schreibt sie mit POST /api/einstellungen.

import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
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
  /** `sage`: vom Agenten selbst formuliert; `auto`: der Sprechtext der letzten Antwort. */
  quelle: Quelle;
}

/** So viele Ansagen haelt die Datei; der Server liefert hoechstens so viele. */
export const ANSAGEN_HOECHSTENS = 200;
/** Erst bei so vielen Zeilen ueber der Grenze schreibt ein Schreiber die Datei gekuerzt neu, nicht bei jeder Ansage. */
const KUERZEN_PUFFER = 50;
/** Aus einer groesseren Datei liest der Server nur das Ende. */
export const LESEN_HOECHSTENS = 1024 * 1024;
/**
 * Erst so viele Bytes ueber LESEN_HOECHSTENS schreibt ein Schreiber die Datei gekuerzt neu, dann auf drei Viertel von
 * LESEN_HOECHSTENS; ohne den Abstand schriebe bei langen Ansagen jeder Anhang die ganze Datei neu.
 */
const KUERZEN_BYTES_PUFFER = 256 * 1024;
/**
 * Laengster Text einer Ansage, bei 14 Zeichen je Sekunde gut neun Minuten Sprechzeit. Laengere kappt das Schreiben
 * und das Lesen nach dem letzten ganzen Satz, bei einem riesigen Satz an einer Wortgrenze mit … (kappeText);
 * verworfen wird keiner.
 */
export const TEXT_HOECHSTENS = 8000;
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

/**
 * Ein Sprechtext von hoechstens `zeichen`: ganze Saetze, solange sie passen. Reichen die nicht bis zur Haelfte
 * (ein riesiger Satz), endet er an einer Wortgrenze mit `…`.
 */
export function kappeText(text: string, zeichen: number): string {
  if (text.length <= zeichen) return text;
  const ganz = kurzAnsage(text, Infinity, zeichen);
  return ganz.length > zeichen / 2 ? ganz : kappe(text, zeichen);
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
 * Der Sprechtext einer Ansage, null wenn es keine gibt. `auto` (die letzte Antwort): der ganze Sprechtext, bis
 * TEXT_HOECHSTENS gekappt (kappeText: nach dem letzten ganzen Satz, sonst an einer Wortgrenze mit …), eine triviale
 * Antwort nicht. `sage` (vom Agenten selbst): bis sechs
 * Saetze und 600 Zeichen.
 */
export function ansageText(roh: string, quelle: Quelle): string | null {
  const sauber = sprechText(roh);
  const text = quelle === "auto" ? kappeText(sauber, TEXT_HOECHSTENS) : kurzAnsage(sauber, 6, 600);
  if (!text || (quelle === "auto" && istTrivial(text))) return null;
  return text;
}

// --- Speicher -----------------------------------------------------------------------------------

/**
 * Eine Zeile der Datei als Ansage, null wenn sie nicht passt; der Text wird beim Lesen noch einmal gesaeubert und
 * ein zu langer gekappt, nicht verworfen.
 */
export function ansageAus(zeile: unknown): Ansage | null {
  if (!zeile || typeof zeile !== "object") return null;
  const a = zeile as Record<string, unknown>;
  if (a.v !== 1 || typeof a.zeit !== "number" || !Number.isFinite(a.zeit) || a.zeit < 0) return null;
  if (a.quelle !== "auto" && a.quelle !== "sage") return null;
  if (typeof a.repo !== "string" || a.repo.length > REPO_HOECHSTENS) return null;
  if (a.id !== null && (typeof a.id !== "string" || !ID.test(a.id))) return null;
  if (typeof a.text !== "string") return null;
  const text = kappeText(sprechText(a.text), TEXT_HOECHSTENS);
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
 * Eine Sperre, aelter als SPERRE_VERWAIST_MS, gilt als verwaist. Ein Schreiber wartet laenger als das (SPERRE_WARTEN_MS),
 * damit er eine verwaiste Sperre sicher noch nimmt; ohne Sperre bleibt nur der Fehler.
 */
const SPERRE_VERWAIST_MS = 10_000;
const SPERRE_WARTEN_MS = 12_000;

const schlafe = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Die Sperre `DATEI.sperre` (O_EXCL), wartend bis `wartenMs`; eine verwaiste nimmt sie weg. Gibt die
 * Freigabe zurueck, null ohne Sperre.
 */
function sperre(datei: string, wartenMs: number): (() => void) | null {
  const pfad = `${datei}.sperre`;
  const bis = Date.now() + wartenMs;
  for (;;) {
    try {
      closeSync(openSync(pfad, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644));
      return () => rmSync(pfad, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return null;
    }
    try {
      if (Date.now() - statSync(pfad).mtimeMs > SPERRE_VERWAIST_MS) rmSync(pfad, { force: true });
    } catch {
      /* eben freigegeben */
    }
    if (Date.now() >= bis) return null;
    schlafe(10);
  }
}

/**
 * Haengt eine Ansage an (O_APPEND, eine Zeile in einem write, ohne Symlink). Hat die Datei danach mehr als
 * `n + KUERZEN_PUFFER` Zeilen oder mehr als LESEN_HOECHSTENS + KUERZEN_BYTES_PUFFER Bytes, ersetzt sie eine Fassung
 * mit den letzten `n` aus ihrem lesbaren Ende, vorne weiter gekuerzt auf drei Viertel von LESEN_HOECHSTENS (neue
 * Datei, dann rename); lange Ansagen halten so weniger als `n`.
 * Anhaengen und Kuerzen laufen unter der Sperre: ein Anhang neben einem Kuerzen ginge mit dem rename verloren.
 * Bekommt sie die Sperre nicht binnen `wartenMs`, haengt sie nichts an und wirft einen Fehler.
 */
export function schreibeAnsage(datei: string, a: Ansage, n = ANSAGEN_HOECHSTENS, wartenMs = SPERRE_WARTEN_MS): void {
  mkdirSync(path.dirname(datei), { recursive: true });
  const frei = sperre(datei, wartenMs);
  if (!frei) throw new Error(`Ansage nicht gespeichert: die Sperre ${datei}.sperre ist seit ${wartenMs} ms besetzt`);
  try {
    let groesse = 0;
    const fd = openSync(datei, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o644);
    try {
      if (!fstatSync(fd).isFile()) throw new Error(`${datei} ist keine regulaere Datei`);
      writeSync(fd, `${JSON.stringify(a)}\n`);
      groesse = fstatSync(fd).size;
    } finally {
      closeSync(fd);
    }
    const inhalt = liesEnde(datei);
    if (inhalt === null) return;
    // Ueber LESEN_HOECHSTENS saehe das Zaehlen nur das Ende, und die Datei wuechse ohne Grenze.
    const zuGross = groesse > LESEN_HOECHSTENS + KUERZEN_BYTES_PUFFER;
    if (!zuGross && inhalt.split("\n").filter((z) => z.trim()).length <= n + KUERZEN_PUFFER) return;
    const zeilen = ansagenAus(inhalt, n).map((x) => `${JSON.stringify(x)}\n`);
    let bytes = zeilen.reduce((s, z) => s + Buffer.byteLength(z), 0);
    let ab = 0;
    while (bytes > (LESEN_HOECHSTENS * 3) / 4 && ab < zeilen.length - 1) bytes -= Buffer.byteLength(zeilen[ab++]);
    const neu = `${datei}.${process.pid}.neu`;
    try {
      const tmp = openSync(neu, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
      try {
        writeSync(tmp, zeilen.slice(ab).join(""));
      } finally {
        closeSync(tmp);
      }
      renameSync(neu, datei);
    } catch {
      rmSync(neu, { force: true });
    }
  } finally {
    frei();
  }
}

/** Ob die Sitzung `id` seit `seit` (ms) selbst etwas angesagt hat; dann entfaellt die automatische Ansage dieses Zugs. */
export function schonAngesagt(liste: readonly Ansage[], id: string, seit: number): boolean {
  return liste.some((a) => a.quelle === "sage" && a.id === id && a.zeit >= seit);
}

// --- Einstellungen der Sprachausgabe ---------------------------------------------------------------

export interface Einstellungen {
  /** Neue Ansagen automatisch vorlesen. */
  vorlesen: boolean;
  /** Name der Stimme; null oder eine Stimme, die der Browser nicht hat: die deutsche Vorgabe. */
  stimme: string | null;
}

export const EINSTELLUNGEN_VORGABE: Einstellungen = { vorlesen: false, stimme: null };
const STIMME_HOECHSTENS = 200;

export const einstellungenDatei = (cache: string) => path.join(cache, "einstellungen.yaml");

const stimmeAus = (x: unknown): string | null => (typeof x === "string" && x.trim() && x.length <= STIMME_HOECHSTENS && !/[\u0000-\u001f\u007f]/.test(x) ? x.trim() : null);

/** Die Einstellungen aus einer gelesenen YAML; was fehlt oder nicht passt, gilt als Vorgabe. */
export function einstellungenAus(roh: unknown): Einstellungen {
  const r = roh && typeof roh === "object" && !Array.isArray(roh) ? (roh as Record<string, unknown>) : {};
  return { vorlesen: r.vorlesen === true, stimme: stimmeAus(r.stimme) };
}

/**
 * Eine Aenderung aus dem Browser (`{ vorlesen?, stimme? }`) ueber die bisherigen Einstellungen; null, wenn ein
 * Feld da ist, aber nicht passt. `stimme: null` oder `""` setzt die Vorgabe.
 */
export function einstellungenMit(alt: Einstellungen, aenderung: unknown): Einstellungen | null {
  if (!aenderung || typeof aenderung !== "object" || Array.isArray(aenderung)) return null;
  const a = aenderung as Record<string, unknown>;
  const neu = { ...alt };
  if ("vorlesen" in a) {
    if (typeof a.vorlesen !== "boolean") return null;
    neu.vorlesen = a.vorlesen;
  }
  if ("stimme" in a) {
    if (a.stimme === null || a.stimme === "") neu.stimme = null;
    else if (stimmeAus(a.stimme) === null) return null;
    else neu.stimme = stimmeAus(a.stimme);
  }
  return neu;
}

/** Die Einstellungen als YAML; Texte als JSON-Strings, die YAML ebenso liest. */
export function einstellungenYaml(e: Einstellungen): string {
  return [
    "# live-plan: Sprachausgabe der Uebersicht, geschrieben vom Server (POST /api/einstellungen)",
    `vorlesen: ${e.vorlesen ? "true" : "false"}`,
    `stimme: ${e.stimme === null ? "null" : JSON.stringify(e.stimme)}`,
    "",
  ].join("\n");
}
