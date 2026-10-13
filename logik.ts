// live-plan (#257): die reine Logik des lebenden Dokuments einer Sitzung, per `node --test` pruefbar.
//
// Eine Sitzung ist WURZEL/REPO/.live-plan/SLUG.yaml (Schema `v: 1`), ihre Belege liegen in
// WURZEL/REPO/.live-plan/SLUG/. Der Agent schreibt die Datei, der Browser nur
// `fragen[].entscheidung`. Zeitstempel schreibt niemand von Hand: der Server vergleicht jeden
// gelesenen Stand mit dem zuletzt gesehenen (`vergleiche`) und fuehrt daraus den Verlauf, aus
// dem `zeiten` die Uhrzeiten je Eintrag ableitet. Platte, Netz und Prozesse bleiben in
// server.ts; hier stehen nur `node:`-Importe.

import { realpathSync } from "node:fs";
import path from "node:path";

// --- Datenform --------------------------------------------------------------------------

export const STATUS = ["offen", "laeuft", "fertig", "verworfen"] as const;
export type Status = (typeof STATUS)[number];

export const ARTEN = ["bauen", "mensch", "neu"] as const;
export type Art = (typeof ARTEN)[number];

const istStatus = (wert: string): wert is Status => (STATUS as readonly string[]).includes(wert);
const istArt = (wert: string): wert is Art => (ARTEN as readonly string[]).includes(wert);

export interface Bahn {
  id: string;
  name: string;
}

export interface Welle {
  id: string;
  name: string;
  ziel?: string;
}

export interface Option {
  label: string;
  empfohlen?: boolean;
  beispiel?: string;
}

export interface Frage {
  id: string;
  frage: string;
  optionen: Option[];
  /** Schritt-Ids, die auf diese Frage warten. */
  blockiert: string[];
  /** Leer, solange nicht entschieden. */
  entscheidung: string;
  grund?: string;
}

/** Ein Beleg traegt genau eine Art; Pfade liegen im Belegordner der Sitzung. */
export type Beleg =
  | { art: "bild"; pfad: string }
  | { art: "html"; pfad: string }
  | { art: "test"; text: string }
  | { art: "diff"; text: string }
  | { art: "code"; text: string; ort?: string }
  | { art: "commit"; sha: string };

const BELEG_ARTEN = ["bild", "html", "test", "diff", "code", "commit"] as const;

export interface Umsetzung {
  wie?: string;
  dateien: string[];
  belege: Beleg[];
}

export interface Schritt {
  id: string;
  bahn: string;
  welle: string;
  titel: string;
  status: Status;
  art?: Art;
  /** Ids von Schritten oder Fragen, an denen dieser Schritt haengt. */
  haengt: string[];
  agent?: string;
  plan?: string;
  fertig_wenn?: string;
  umsetzung?: Umsetzung;
}

export const GATES = ["jetzt", "mensch", "spaeter"] as const;
export type Gate = (typeof GATES)[number];

/** Der Stand der Sitzung, wie das Status-Schaubild einer Antwort: vom Agenten mit jeder Antwort geschrieben. */
export interface Stand {
  thema?: string;
  erledigt: { text: string; beleg?: string }[];
  fragen: { text: string; wer?: string }[];
  offen: { text: string; gate: Gate; befehl?: string }[];
}

export const QUELLEN = ["Nutzer", "Agent", "Review"] as const;
export type Quelle = (typeof QUELLEN)[number];

/** Ein Punkt, den die Sitzung erfuellen soll; erfuellt ist er ueber seine Schritte, nie per Hand. */
export interface Anforderung {
  id: string;
  text: string;
  quelle?: Quelle;
  /** Schritt-Ids, die die Anforderung umsetzen. */
  erfuellt_mit: string[];
  /** Beweisbild (A20): Bildpfad relativ zum Belegordner; ohne ihn gilt das juengste Bild der Schritte. */
  beweis?: string;
}

/** Endungen eines Beweisbilds, dieselben, die der Server als Bild ausliefert. */
export const BILD_ENDUNGEN = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"] as const;

/** Ein Bildpfad im Belegordner: relativ, ohne `..`, ohne Backslash, mit Bildendung. Ob die Datei liegt und kein Link ist, prueft der Server per belegPfad. */
export function istBildpfad(rel: string): boolean {
  if (!rel || rel.includes("\0") || rel.includes("\\") || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return false;
  if (rel.split("/").some((teil) => teil === ".." || teil === "")) return false;
  const klein = rel.toLowerCase();
  return BILD_ENDUNGEN.some((e) => klein.endsWith(e) && klein.length > e.length);
}

/** Eine Architektur- oder Vorgehensentscheidung mit Grund, verknuepft mit den Schritten, die sie tragen. */
export interface Entscheidung {
  id: string;
  titel: string;
  grund?: string;
  quelle?: Quelle;
  schritte: string[];
}

// --- Dokumentation (#328) -------------------------------------------------------------------
//
// Der optionale Abschnitt `doku:` erklaert, was die Sitzung gebaut hat: Ueberblick, Bausteine, ein
// Ablauf als Flowchart, Befehle und Regeln. Er dient dem Handout (`?handout=1`, `live-plan handout`).

export const DOKU_ROLLEN = ["agent", "helfer", "daten", "dienst", "mensch"] as const;
export type DokuRolle = (typeof DOKU_ROLLEN)[number];
export const DOKU_STATI = ["fertig", "laeuft", "wartet", "offen"] as const;
export type DokuStatus = (typeof DOKU_STATI)[number];
export const DOKU_ARTEN = ["start", "aktion", "frage", "daten", "ende"] as const;
export type DokuArt = (typeof DOKU_ARTEN)[number];
export const DOKU_REGELARTEN = ["immer", "nie", "tipp"] as const;
export type DokuRegelart = (typeof DOKU_REGELARTEN)[number];

export interface DokuBaustein {
  name: string;
  rolle?: DokuRolle;
  text?: string;
  ort?: string;
}

export interface DokuBahn {
  id: string;
  name: string;
  rolle?: DokuRolle;
}

export interface DokuSchritt {
  id: string;
  bahn: string;
  titel: string;
  /** Zweite, graue Zeile im Knoten. */
  detail?: string;
  /** Ohne Angabe gilt die Rolle der Bahn. */
  rolle?: DokuRolle;
  art?: DokuArt;
  status?: DokuStatus;
}

export interface DokuKante {
  von: string;
  nach: string;
  text?: string;
}

export interface DokuAblauf {
  titel?: string;
  bahnen: DokuBahn[];
  schritte: DokuSchritt[];
  kanten: DokuKante[];
}

export interface DokuBefehl {
  befehl: string;
  text?: string;
}

export interface DokuRegel {
  text: string;
  art: DokuRegelart;
}

/** Ueberblick als drei Karten; ein einfacher Text bleibt erlaubt. */
export interface DokuUeberblick {
  problem?: string;
  loesung?: string;
  fuer_wen?: string;
}

/** Ein Feld einer Datei: Schluessel und was darin steht. */
export interface DokuFeld {
  schluessel: string;
  inhalt?: string;
}

export interface DokuDatei {
  titel?: string;
  felder: DokuFeld[];
}

export interface DokuZone {
  name: string;
  text?: string;
}

export interface DokuAnsicht {
  titel?: string;
  zonen: DokuZone[];
  druck?: string;
}

export interface DokuRegister {
  titel?: string;
  text?: string;
  ort?: string;
  felder: DokuFeld[];
}

export interface Doku {
  /** Kopf: fetter Vorsatz, Kurztext statt des Ziels, Status und Tags als Chips. */
  untertitel?: string;
  kurz?: string;
  status?: string;
  tags?: string[];
  /** Fuss und Kopf von Teil 2. */
  stand?: string;
  version?: string;
  quelle?: string;
  ueberblick?: string | DokuUeberblick;
  bausteine: DokuBaustein[];
  ablauf?: DokuAblauf;
  befehle: DokuBefehl[];
  regeln: DokuRegel[];
  /** Aufbau der Sitzungsdatei, Was die Seite zeigt, Aufbau des Registers. */
  datei?: DokuDatei;
  ansicht?: DokuAnsicht;
  register?: DokuRegister;
}

export interface Plan {
  v: 1;
  titel: string;
  ziel: string;
  /** Branch der Sitzung unter GitButler; ohne ihn gilt der Workspace. */
  branch?: string;
  bahnen: Bahn[];
  wellen: Welle[];
  fragen: Frage[];
  schritte: Schritt[];
  anforderungen: Anforderung[];
  entscheidungen: Entscheidung[];
  stand?: Stand;
  /** Optional: Erklaerung des Gebauten fuer das Handout. */
  doku?: Doku;
}

export interface Fehler {
  pfad: string;
  grund: string;
}

// --- Plan pruefen ---------------------------------------------------------------------------

type Roh = Record<string, unknown>;

const istObjekt = (wert: unknown): wert is Roh => typeof wert === "object" && wert !== null && !Array.isArray(wert);

/**
 * Nur ein gelesenes YAML-Objekt darf mit dem gesehenen Stand verglichen werden. Leer, unlesbar oder
 * kein Objekt heisst: die Datei ist gerade halb geschrieben, nicht die Sitzung geleert.
 */
export const vergleichbar = (roh: unknown): boolean => istObjekt(roh);

/** Prueft eine gelesene Sitzungsdatei. Der Plan traegt alle gueltigen Teile, die Fehlerliste jeden Verstoss. */
export function pruefePlan(roh: unknown): { plan: Plan; fehler: Fehler[] } {
  const fehler: Fehler[] = [];
  const melde = (pfad: string, grund: string) => fehler.push({ pfad, grund });
  const plan: Plan = { v: 1, titel: "", ziel: "", bahnen: [], wellen: [], fragen: [], schritte: [], anforderungen: [], entscheidungen: [] };
  if (!istObjekt(roh)) {
    melde("", "die Sitzung ist kein YAML-Objekt");
    return { plan, fehler };
  }

  const text = (wert: unknown, pfad: string, pflicht: boolean): string | undefined => {
    if (wert === undefined || wert === null) {
      if (pflicht) melde(pfad, "fehlt");
      return undefined;
    }
    if (typeof wert === "string") return wert;
    if (typeof wert === "number" || typeof wert === "boolean") return String(wert);
    melde(pfad, "ist kein Text");
    return undefined;
  };
  const liste = (wert: unknown, pfad: string): unknown[] => {
    if (wert === undefined || wert === null) return [];
    if (Array.isArray(wert)) return wert;
    melde(pfad, "ist keine Liste");
    return [];
  };
  const texte = (wert: unknown, pfad: string): string[] =>
    liste(wert, pfad).flatMap((t, i) => {
      const s = text(t, `${pfad}[${i}]`, true);
      return s === undefined ? [] : [s];
    });

  if (roh.v !== 1) melde("v", "Schema `v: 1` erwartet");
  plan.titel = text(roh.titel, "titel", true) ?? "";
  plan.ziel = text(roh.ziel, "ziel", false) ?? "";
  const branch = text(roh.branch, "branch", false);
  if (branch) plan.branch = branch;

  const ids = new Set<string>();
  const kopfIds = (art: "bahnen" | "wellen") => {
    const gesehen = new Set<string>();
    return liste(roh[art], art).flatMap((eintrag, i) => {
      const pfad = `${art}[${i}]`;
      if (!istObjekt(eintrag)) {
        melde(pfad, "ist kein Objekt");
        return [];
      }
      const id = text(eintrag.id, `${pfad}.id`, true);
      if (id === undefined) return [];
      if (gesehen.has(id)) {
        melde(`${pfad}.id`, `doppelte Id ${id}`);
        return [];
      }
      gesehen.add(id);
      const name = text(eintrag.name, `${pfad}.name`, false) ?? id;
      const ziel = art === "wellen" ? text(eintrag.ziel, `${pfad}.ziel`, false) : undefined;
      return [ziel ? { id, name, ziel } : { id, name }];
    });
  };
  plan.bahnen = kopfIds("bahnen");
  plan.wellen = kopfIds("wellen");
  if (plan.bahnen.length === 0) melde("bahnen", "mindestens eine Bahn noetig");
  if (plan.wellen.length === 0) melde("wellen", "mindestens eine Welle noetig");

  const neueId = (id: string | undefined, pfad: string): id is string => {
    if (id === undefined) return false;
    if (ids.has(id)) {
      melde(pfad, `doppelte Id ${id}`);
      return false;
    }
    ids.add(id);
    return true;
  };

  liste(roh.fragen, "fragen").forEach((eintrag, i) => {
    const pfad = `fragen[${i}]`;
    if (!istObjekt(eintrag)) return melde(pfad, "ist kein Objekt");
    const id = text(eintrag.id, `${pfad}.id`, true);
    if (!neueId(id, `${pfad}.id`)) return;
    const optionen = liste(eintrag.optionen, `${pfad}.optionen`).flatMap((o, j): Option[] => {
      const opfad = `${pfad}.optionen[${j}]`;
      if (!istObjekt(o)) {
        melde(opfad, "ist kein Objekt mit label");
        return [];
      }
      const label = text(o.label, `${opfad}.label`, true);
      if (label === undefined) return [];
      const option: Option = { label };
      if (o.empfohlen === true) option.empfohlen = true;
      const beispiel = text(o.beispiel, `${opfad}.beispiel`, false);
      if (beispiel) option.beispiel = beispiel;
      return [option];
    });
    const frage: Frage = {
      id,
      frage: text(eintrag.frage, `${pfad}.frage`, true) ?? "",
      optionen,
      blockiert: texte(eintrag.blockiert, `${pfad}.blockiert`),
      entscheidung: text(eintrag.entscheidung, `${pfad}.entscheidung`, false) ?? "",
    };
    const grund = text(eintrag.grund, `${pfad}.grund`, false);
    if (grund) frage.grund = grund;
    plan.fragen.push(frage);
  });

  const bahnIds = new Set(plan.bahnen.map((b) => b.id));
  const wellenIds = new Set(plan.wellen.map((w) => w.id));
  liste(roh.schritte, "schritte").forEach((eintrag, i) => {
    const pfad = `schritte[${i}]`;
    if (!istObjekt(eintrag)) return melde(pfad, "ist kein Objekt");
    const id = text(eintrag.id, `${pfad}.id`, true);
    if (!neueId(id, `${pfad}.id`)) return;
    const bahn = text(eintrag.bahn, `${pfad}.bahn`, true) ?? "";
    if (bahn && !bahnIds.has(bahn)) melde(`${pfad}.bahn`, `unbekannte Bahn ${bahn}`);
    const welle = text(eintrag.welle, `${pfad}.welle`, true) ?? "";
    if (welle && !wellenIds.has(welle)) melde(`${pfad}.welle`, `unbekannte Welle ${welle}`);
    const statusText = text(eintrag.status, `${pfad}.status`, true);
    const status = statusText !== undefined && istStatus(statusText) ? statusText : undefined;
    if (statusText !== undefined && !status) melde(`${pfad}.status`, `unbekannter Status ${statusText}, erlaubt: ${STATUS.join(", ")}`);
    const schritt: Schritt = {
      id,
      bahn,
      welle,
      titel: text(eintrag.titel, `${pfad}.titel`, true) ?? id,
      status: status ?? "offen",
      haengt: texte(eintrag.haengt, `${pfad}.haengt`),
    };
    const art = text(eintrag.art, `${pfad}.art`, false);
    if (art !== undefined) {
      if (istArt(art)) schritt.art = art;
      else melde(`${pfad}.art`, `unbekannte Art ${art}, erlaubt: ${ARTEN.join(", ")}`);
    }
    for (const feld of ["agent", "plan", "fertig_wenn"] as const) {
      const wert = text(eintrag[feld], `${pfad}.${feld}`, false);
      if (wert) schritt[feld] = wert;
    }
    if (eintrag.umsetzung !== undefined && eintrag.umsetzung !== null) {
      const u = eintrag.umsetzung;
      if (!istObjekt(u)) melde(`${pfad}.umsetzung`, "ist kein Objekt");
      else {
        const umsetzung: Umsetzung = {
          dateien: texte(u.dateien, `${pfad}.umsetzung.dateien`),
          belege: liste(u.belege, `${pfad}.umsetzung.belege`).flatMap((b, j) => {
            const beleg = pruefeBeleg(b, `${pfad}.umsetzung.belege[${j}]`, melde);
            return beleg ? [beleg] : [];
          }),
        };
        const wie = text(u.wie, `${pfad}.umsetzung.wie`, false);
        if (wie) umsetzung.wie = wie;
        schritt.umsetzung = umsetzung;
      }
    }
    plan.schritte.push(schritt);
  });

  plan.schritte.forEach((s, i) =>
    s.haengt.forEach((ziel, j) => {
      if (!ids.has(ziel)) melde(`schritte[${i}].haengt[${j}]`, `unbekannte Id ${ziel}`);
    }),
  );
  plan.fragen.forEach((f, i) =>
    f.blockiert.forEach((ziel, j) => {
      if (!plan.schritte.some((s) => s.id === ziel)) melde(`fragen[${i}].blockiert[${j}]`, `unbekannter Schritt ${ziel}`);
    }),
  );

  // Anforderungen und Entscheidungen (S23): eigenes Id-Muster, keine Id eines Schritts oder einer
  // Frage, Verweise nur auf Schritte. Unbekannte Verweise fallen weg, der Eintrag bleibt.
  const schrittIds = new Set(plan.schritte.map((s) => s.id));
  const block = (art: "anforderungen" | "entscheidungen", muster: RegExp, hauptfeld: "text" | "titel", verweise: "erfuellt_mit" | "schritte") => {
    const gesehen = new Set<string>();
    return liste(roh[art], art).flatMap((eintrag, i) => {
      const pfad = `${art}[${i}]`;
      if (!istObjekt(eintrag)) {
        melde(pfad, "ist kein Objekt");
        return [];
      }
      const id = text(eintrag.id, `${pfad}.id`, true);
      if (id === undefined) return [];
      if (!muster.test(id)) {
        melde(`${pfad}.id`, `Id ${id} passt nicht zu ${muster.source}`);
        return [];
      }
      if (gesehen.has(id) || ids.has(id)) {
        melde(`${pfad}.id`, `doppelte Id ${id}`);
        return [];
      }
      gesehen.add(id);
      const haupt = text(eintrag[hauptfeld], `${pfad}.${hauptfeld}`, true);
      if (haupt === undefined) return [];
      const gefunden = texte(eintrag[verweise], `${pfad}.${verweise}`).filter((ziel, j) => {
        if (schrittIds.has(ziel)) return true;
        melde(`${pfad}.${verweise}[${j}]`, `unbekannter Schritt ${ziel}`);
        return false;
      });
      const quelle = text(eintrag.quelle, `${pfad}.quelle`, false);
      const gueltigeQuelle = quelle !== undefined && (QUELLEN as readonly string[]).includes(quelle) ? (quelle as Quelle) : undefined;
      if (quelle !== undefined && !gueltigeQuelle) melde(`${pfad}.quelle`, `unbekannte Quelle ${quelle}, erlaubt: ${QUELLEN.join(", ")}`);
      const grund = hauptfeld === "titel" ? text(eintrag.grund, `${pfad}.grund`, false) : undefined;
      let beweis = hauptfeld === "text" ? text(eintrag.beweis, `${pfad}.beweis`, false) : undefined;
      if (beweis !== undefined && !istBildpfad(beweis)) {
        melde(`${pfad}.beweis`, `kein Bildpfad im Belegordner: relativ, ohne .., Endung ${BILD_ENDUNGEN.join(", ")}`);
        beweis = undefined;
      }
      return [{ id, haupt, verweise: gefunden, quelle: gueltigeQuelle, grund, beweis }];
    });
  };
  const mitQuelle = (q: Quelle | undefined) => (q ? { quelle: q } : {});
  plan.anforderungen = block("anforderungen", /^A\d+$/, "text", "erfuellt_mit").map(
    (e): Anforderung => ({ id: e.id, text: e.haupt, ...mitQuelle(e.quelle), erfuellt_mit: e.verweise, ...(e.beweis ? { beweis: e.beweis } : {}) }),
  );
  plan.entscheidungen = block("entscheidungen", /^E\d+$/, "titel", "schritte").map(
    (e): Entscheidung => ({ id: e.id, titel: e.haupt, ...(e.grund ? { grund: e.grund } : {}), ...mitQuelle(e.quelle), schritte: e.verweise }),
  );

  if (roh.stand !== undefined && roh.stand !== null) {
    const st = roh.stand;
    if (!istObjekt(st)) melde("stand", "ist kein Objekt");
    else {
      /** Je Blatt ein Objekt mit Pflichtfeld text und einem optionalen Zusatz als Text. */
      const blaetter = (ast: "erledigt" | "fragen", zusatz: "beleg" | "wer") =>
        liste(st[ast], `stand.${ast}`).flatMap((b, i) => {
          const pfad = `stand.${ast}[${i}]`;
          if (!istObjekt(b)) {
            melde(pfad, "ist kein Objekt mit text");
            return [];
          }
          const t = text(b.text, `${pfad}.text`, true);
          if (t === undefined) return [];
          const wert = text(b[zusatz], `${pfad}.${zusatz}`, false);
          return [wert ? { text: t, [zusatz]: wert } : { text: t }];
        });
      const stand: Stand = { erledigt: blaetter("erledigt", "beleg"), fragen: blaetter("fragen", "wer"), offen: [] };
      const thema = text(st.thema, "stand.thema", false);
      if (thema) stand.thema = thema;
      liste(st.offen, "stand.offen").forEach((b, i) => {
        const pfad = `stand.offen[${i}]`;
        if (!istObjekt(b)) return melde(pfad, "ist kein Objekt mit text und gate");
        const t = text(b.text, `${pfad}.text`, true);
        const g = text(b.gate, `${pfad}.gate`, true);
        if (g !== undefined && !(GATES as readonly string[]).includes(g)) melde(`${pfad}.gate`, `unbekanntes Gate ${g}, erlaubt: ${GATES.join(", ")}`);
        if (t === undefined || g === undefined || !(GATES as readonly string[]).includes(g)) return;
        const blatt: Stand["offen"][number] = { text: t, gate: g as Gate };
        const befehl = text(b.befehl, `${pfad}.befehl`, false);
        if (befehl) blatt.befehl = befehl;
        stand.offen.push(blatt);
      });
      // Nutzerentscheid E8 (S29): hoechstens ein Blatt jetzt, vorher genau eines.
      const jetztZahl = stand.offen.filter((o) => o.gate === "jetzt").length;
      if (jetztZahl > 1) melde("stand.offen", `hoechstens ein Blatt mit gate: jetzt, hier ${jetztZahl}`);
      plan.stand = stand;
    }
  }
  if (roh.doku !== undefined && roh.doku !== null) {
    const d = pruefeDoku(roh.doku, { melde, text, liste });
    if (d) plan.doku = d;
  }
  return { plan, fehler };
}

/** Die Hilfen von pruefePlan, die auch die Dokumentation braucht. */
interface Pruefhilfen {
  melde: (pfad: string, grund: string) => void;
  text: (wert: unknown, pfad: string, pflicht: boolean) => string | undefined;
  liste: (wert: unknown, pfad: string) => unknown[];
}

/** Prueft `doku:`; ein Verstoss steht mit Pfad in der Fehlerliste, der gueltige Rest bleibt. */
function pruefeDoku(roh: unknown, h: Pruefhilfen): Doku | undefined {
  if (!istObjekt(roh)) {
    h.melde("doku", "ist kein Objekt");
    return undefined;
  }
  const doku: Doku = { bausteine: [], befehle: [], regeln: [] };
  const optional = <T extends object>(ziel: T, feld: keyof T, wert: unknown) => {
    if (wert !== undefined) (ziel as Record<keyof T, unknown>)[feld] = wert;
  };
  const wahl = <T extends string>(wert: unknown, erlaubt: readonly T[], pfad: string, was: string): T | undefined => {
    const t = h.text(wert, pfad, false);
    if (t === undefined) return undefined;
    if ((erlaubt as readonly string[]).includes(t)) return t as T;
    h.melde(pfad, `${was} ${t} unbekannt, erlaubt: ${erlaubt.join(", ")}`);
    return undefined;
  };
  /** Je Eintrag ein Objekt; `lies` gibt undefined zurueck, wenn der Eintrag wegfaellt. */
  const eintraege = <T>(wert: unknown, pfad: string, lies: (e: Roh, p: string) => T | undefined): T[] =>
    h.liste(wert, pfad).flatMap((e, i) => {
      const p = `${pfad}[${i}]`;
      if (!istObjekt(e)) {
        h.melde(p, "ist kein Objekt");
        return [];
      }
      const r = lies(e, p);
      return r === undefined ? [] : [r];
    });

  for (const feld of ["untertitel", "kurz", "status", "stand", "version", "quelle"] as const) optional(doku, feld, h.text(roh[feld], `doku.${feld}`, false));
  if (roh.tags !== undefined && roh.tags !== null) {
    doku.tags = h.liste(roh.tags, "doku.tags").flatMap((t, i) => {
      const x = h.text(t, `doku.tags[${i}]`, true);
      return x === undefined ? [] : [x];
    });
  }
  if (istObjekt(roh.ueberblick)) {
    const u: DokuUeberblick = {};
    for (const feld of ["problem", "loesung", "fuer_wen"] as const) optional(u, feld, h.text(roh.ueberblick[feld], `doku.ueberblick.${feld}`, false));
    doku.ueberblick = u;
  } else optional(doku, "ueberblick", h.text(roh.ueberblick, "doku.ueberblick", false));
  /** Ein optionaler Block als Objekt; sonst ein Fehler und kein Block. */
  const block = (wert: unknown, pfad: string): Roh | undefined => {
    if (wert === undefined || wert === null) return undefined;
    if (istObjekt(wert)) return wert;
    h.melde(pfad, "ist kein Objekt");
    return undefined;
  };
  const felder = (wert: unknown, pfad: string): DokuFeld[] =>
    eintraege(wert, pfad, (e, p): DokuFeld | undefined => {
      const schluessel = h.text(e.schluessel, `${p}.schluessel`, true);
      if (schluessel === undefined) return undefined;
      const f: DokuFeld = { schluessel };
      optional(f, "inhalt", h.text(e.inhalt, `${p}.inhalt`, false));
      return f;
    });
  const datei = block(roh.datei, "doku.datei");
  if (datei) {
    doku.datei = { felder: felder(datei.felder, "doku.datei.felder") };
    optional(doku.datei, "titel", h.text(datei.titel, "doku.datei.titel", false));
  }
  const ansicht = block(roh.ansicht, "doku.ansicht");
  if (ansicht) {
    doku.ansicht = {
      zonen: eintraege(ansicht.zonen, "doku.ansicht.zonen", (e, p): DokuZone | undefined => {
        const name = h.text(e.name, `${p}.name`, true);
        if (name === undefined) return undefined;
        const z: DokuZone = { name };
        optional(z, "text", h.text(e.text, `${p}.text`, false));
        return z;
      }),
    };
    optional(doku.ansicht, "titel", h.text(ansicht.titel, "doku.ansicht.titel", false));
    optional(doku.ansicht, "druck", h.text(ansicht.druck, "doku.ansicht.druck", false));
  }
  const register = block(roh.register, "doku.register");
  if (register) {
    doku.register = { felder: felder(register.felder, "doku.register.felder") };
    for (const feld of ["titel", "text", "ort"] as const) optional(doku.register, feld, h.text(register[feld], `doku.register.${feld}`, false));
  }
  doku.bausteine = eintraege(roh.bausteine, "doku.bausteine", (e, p): DokuBaustein | undefined => {
    const name = h.text(e.name, `${p}.name`, true);
    if (name === undefined) return undefined;
    const b: DokuBaustein = { name };
    optional(b, "rolle", wahl(e.rolle, DOKU_ROLLEN, `${p}.rolle`, "Rolle"));
    optional(b, "text", h.text(e.text, `${p}.text`, false));
    optional(b, "ort", h.text(e.ort, `${p}.ort`, false));
    return b;
  });
  doku.befehle = eintraege(roh.befehle, "doku.befehle", (e, p): DokuBefehl | undefined => {
    const befehl = h.text(e.befehl, `${p}.befehl`, true);
    if (befehl === undefined) return undefined;
    const b: DokuBefehl = { befehl };
    optional(b, "text", h.text(e.text, `${p}.text`, false));
    return b;
  });
  doku.regeln = eintraege(roh.regeln, "doku.regeln", (e, p): DokuRegel | undefined => {
    const text = h.text(e.text, `${p}.text`, true);
    const art = wahl(e.art, DOKU_REGELARTEN, `${p}.art`, "Art");
    if (art === undefined && e.art === undefined) h.melde(`${p}.art`, "fehlt");
    return text === undefined || art === undefined ? undefined : { text, art };
  });

  if (roh.ablauf !== undefined && roh.ablauf !== null) {
    if (!istObjekt(roh.ablauf)) h.melde("doku.ablauf", "ist kein Objekt");
    else {
      const ab = roh.ablauf;
      const ablauf: DokuAblauf = { bahnen: [], schritte: [], kanten: [] };
      optional(ablauf, "titel", h.text(ab.titel, "doku.ablauf.titel", false));
      const bahnIds = new Set<string>();
      ablauf.bahnen = eintraege(ab.bahnen, "doku.ablauf.bahnen", (e, p): DokuBahn | undefined => {
        const id = h.text(e.id, `${p}.id`, true);
        const name = h.text(e.name, `${p}.name`, true);
        if (id === undefined || name === undefined) return undefined;
        if (bahnIds.has(id)) {
          h.melde(`${p}.id`, `doppelte Id ${id}`);
          return undefined;
        }
        bahnIds.add(id);
        const b: DokuBahn = { id, name };
        optional(b, "rolle", wahl(e.rolle, DOKU_ROLLEN, `${p}.rolle`, "Rolle"));
        return b;
      });
      const schrittIds = new Set<string>();
      ablauf.schritte = eintraege(ab.schritte, "doku.ablauf.schritte", (e, p): DokuSchritt | undefined => {
        const id = h.text(e.id, `${p}.id`, true);
        const bahn = h.text(e.bahn, `${p}.bahn`, true);
        const titel = h.text(e.titel, `${p}.titel`, true);
        const rolle = wahl(e.rolle, DOKU_ROLLEN, `${p}.rolle`, "Rolle");
        const art = wahl(e.art, DOKU_ARTEN, `${p}.art`, "Art");
        const status = wahl(e.status, DOKU_STATI, `${p}.status`, "Status");
        const detail = h.text(e.detail, `${p}.detail`, false);
        if (id === undefined || bahn === undefined || titel === undefined) return undefined;
        if (schrittIds.has(id)) {
          h.melde(`${p}.id`, `doppelte Id ${id}`);
          return undefined;
        }
        if (!bahnIds.has(bahn)) {
          h.melde(`${p}.bahn`, `unbekannte Bahn ${bahn}`);
          return undefined;
        }
        schrittIds.add(id);
        const s: DokuSchritt = { id, bahn, titel };
        optional(s, "detail", detail);
        optional(s, "rolle", rolle);
        optional(s, "art", art);
        optional(s, "status", status);
        return s;
      });
      ablauf.kanten = eintraege(ab.kanten, "doku.ablauf.kanten", (e, p): DokuKante | undefined => {
        const von = h.text(e.von, `${p}.von`, true);
        const nach = h.text(e.nach, `${p}.nach`, true);
        const text = h.text(e.text, `${p}.text`, false);
        if (von === undefined || nach === undefined) return undefined;
        const unbekannt = [["von", von], ["nach", nach]].filter(([, id]) => !schrittIds.has(id as string));
        for (const [feld, id] of unbekannt) h.melde(`${p}.${feld}`, `unbekannter Schritt ${id}`);
        if (unbekannt.length) return undefined;
        const k: DokuKante = { von, nach };
        optional(k, "text", text);
        return k;
      });
      doku.ablauf = ablauf;
    }
  }
  return doku;
}

function pruefeBeleg(roh: unknown, pfad: string, melde: (pfad: string, grund: string) => void): Beleg | undefined {
  if (!istObjekt(roh)) {
    melde(pfad, "ist kein Objekt");
    return undefined;
  }
  const arten = BELEG_ARTEN.filter((a) => roh[a] !== undefined && roh[a] !== null);
  if (arten.length !== 1) {
    melde(pfad, `ein Beleg traegt genau eine Art (${BELEG_ARTEN.join(", ")}), hier ${arten.length}`);
    return undefined;
  }
  const art = arten[0]!;
  const wert = roh[art];
  if (typeof wert !== "string" || wert === "") {
    melde(`${pfad}.${art}`, "ist kein Text");
    return undefined;
  }
  switch (art) {
    case "bild":
    case "html":
      return { art, pfad: wert };
    case "test":
    case "diff":
      return { art, text: wert };
    case "code":
      return typeof roh.ort === "string" ? { art, text: wert, ort: roh.ort } : { art, text: wert };
    case "commit":
      return { art, sha: wert };
  }
}

// --- Verlauf und Zeiten -------------------------------------------------------------------

/**
 * Eine Zeile im Verlauf `SLUG.verlauf.jsonl`. `von` und `nach` nur, wenn der Wert Text ist; bei
 * `erfuellt_mit` die Liste als JSON-Text (E9, S31).
 */
export interface Verlaufseintrag {
  um: string;
  id: string;
  /** Feldname, `neu` beim ersten Auftauchen, `entfernt` beim Verschwinden. */
  feld: string;
  von?: string;
  nach?: string;
  /** Nur bei Anforderungen und Entscheidungen (S23); Schritte und Fragen tragen keins, wie vor S23. */
  art?: Eintragsart;
}

export type Eintragsart = "anforderung" | "entscheidung" | "doku";

const SCHRITT_FELDER = ["status", "titel", "bahn", "welle", "art", "agent", "plan", "fertig_wenn", "haengt", "umsetzung"] as const;
const FRAGE_FELDER = ["frage", "optionen", "blockiert", "entscheidung", "grund"] as const;
const ANFORDERUNG_FELDER = ["text", "quelle", "erfuellt_mit", "beweis"] as const;
const ENTSCHEIDUNG_FELDER = ["titel", "grund", "quelle", "schritte"] as const;

/** Je Id die verglichenen Felder, `erstes` fuer `nach` beim ersten Auftauchen, `art` nur ab S23. */
type Eintragswerte = Map<string, { werte: Record<string, unknown>; erstes: unknown; art?: Eintragsart }>;

/**
 * Kennung eines Doku-Punkts fuer Verlauf und Alter (Nutzerwunsch 2026-10-11): Liste und der Schluessel,
 * der den Punkt benennt. Aendert sich der Schluessel selbst, gilt der Punkt als neu. Die Ansicht bildet
 * die Kennung in live-plan.js gleich.
 */
export function dokuId(liste: string, schluessel: string): string {
  return `doku:${liste}:${schluessel}`;
}

/** Die Doku-Punkte als [Kennung, Inhalt]; ohne doku keine. */
function dokuPunkte(doku: Doku | undefined): [string, unknown][] {
  if (!doku) return [];
  const je = <T>(liste: string, punkte: T[] | undefined, name: (p: T) => string): [string, unknown][] =>
    (punkte ?? []).map((p) => [dokuId(liste, name(p)), p]);
  return [
    ...je("bausteine", doku.bausteine, (b) => b.name),
    ...je("befehle", doku.befehle, (b) => b.befehl),
    ...je("regeln", doku.regeln, (r) => r.text),
    ...je("datei", doku.datei?.felder, (f) => f.schluessel),
    ...je("ansicht", doku.ansicht?.zonen, (z) => z.name),
    ...je("register", doku.register?.felder, (f) => f.schluessel),
  ];
}

function eintraegeVon(plan: Plan): Eintragswerte {
  const werte: Eintragswerte = new Map();
  for (const s of plan.schritte) werte.set(s.id, { werte: Object.fromEntries(SCHRITT_FELDER.map((f) => [f, s[f]])), erstes: s.status });
  for (const f of plan.fragen) werte.set(f.id, { werte: Object.fromEntries(FRAGE_FELDER.map((k) => [k, f[k]])), erstes: f.entscheidung });
  // Ein gesehener Stand aus einer Fassung vor S23 hat keine der beiden Listen.
  for (const a of plan.anforderungen ?? []) werte.set(a.id, { werte: Object.fromEntries(ANFORDERUNG_FELDER.map((k) => [k, a[k]])), erstes: a.text, art: "anforderung" });
  for (const e of plan.entscheidungen ?? []) werte.set(e.id, { werte: Object.fromEntries(ENTSCHEIDUNG_FELDER.map((k) => [k, e[k]])), erstes: e.titel, art: "entscheidung" });
  for (const [id, inhalt] of dokuPunkte(plan.doku)) werte.set(id, { werte: { inhalt }, erstes: undefined, art: "doku" });
  return werte;
}

const gleich = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function mitWerten(eintrag: Verlaufseintrag, von: unknown, nach: unknown, art?: Eintragsart): Verlaufseintrag {
  if (typeof von === "string") eintrag.von = von;
  if (typeof nach === "string") eintrag.nach = nach;
  if (art) eintrag.art = art;
  return eintrag;
}

/** Die Unterschiede zwischen dem zuletzt gesehenen Stand (`null`: keiner) und dem neuen, alle zur Zeit `um`. */
export function vergleiche(alt: Plan | null, neu: Plan, um: string): Verlaufseintrag[] {
  const vorher: Eintragswerte = alt ? eintraegeVon(alt) : new Map();
  const nachher = eintraegeVon(neu);
  const ergebnis: Verlaufseintrag[] = [];
  for (const [id, { werte, erstes, art }] of nachher) {
    const alte = vorher.get(id)?.werte;
    if (!alte) {
      ergebnis.push(mitWerten({ um, id, feld: "neu" }, undefined, erstes, art));
      continue;
    }
    for (const feld of Object.keys(werte)) {
      if (gleich(alte[feld], werte[feld])) continue;
      const alsText = (w: unknown) => (feld === "erfuellt_mit" && Array.isArray(w) ? JSON.stringify(w) : w);
      ergebnis.push(mitWerten({ um, id, feld }, alsText(alte[feld]), alsText(werte[feld]), art));
    }
  }
  for (const [id, { art }] of vorher) if (!nachher.has(id)) ergebnis.push(mitWerten({ um, id, feld: "entfernt" }, undefined, undefined, art));
  return ergebnis;
}

/**
 * Doku-Punkte, die im Verlauf noch nie vorkamen, als `neu` zur Zeit `um`: so bekommt eine Doku, die schon
 * vor der Kennung je Punkt da war, einmal einen Startpunkt; danach zaehlen nur echte Aenderungen.
 */
export function dokuOhneVerlauf(verlauf: Verlaufseintrag[], plan: Plan, um: string): Verlaufseintrag[] {
  const da = new Set(verlauf.map((e) => e.id));
  return dokuPunkte(plan.doku).filter(([id]) => !da.has(id)).map(([id]) => ({ um, id, feld: "neu", art: "doku" as const }));
}

export interface Eintragszeiten {
  geaendert_um?: string;
  gestartet_um?: string;
  fertig_um?: string;
}

export interface Zeiten {
  je: Record<string, Eintragszeiten>;
  /** Der zuletzt geaenderte Eintrag samt Feld und Zeit. */
  zuletzt: Verlaufseintrag | null;
}

/** Zeiten je Eintrag und der zuletzt geaenderte Eintrag, abgeleitet aus dem Verlauf. */
export function zeiten(verlauf: Verlaufseintrag[]): Zeiten {
  const je: Record<string, Eintragszeiten> = Object.create(null);
  let zuletzt: Verlaufseintrag | null = null;
  for (const e of verlauf) {
    if (e.feld === "entfernt") {
      delete je[e.id];
      continue;
    }
    const z = (je[e.id] ??= {});
    z.geaendert_um = e.um;
    // Text oder Titel einer Anforderung ist kein Status, auch wenn er "fertig" lautet.
    if (!e.art && (e.feld === "status" || e.feld === "neu")) {
      if (e.nach === "laeuft") {
        z.gestartet_um = e.um;
        delete z.fertig_um;
      } else if (e.nach === "fertig" || e.nach === "verworfen") z.fertig_um = e.um;
      else if (e.nach === "offen") delete z.fertig_um;
    }
    // A doku point carries an age but is never the "last changed" entry of the session.
    if (e.art !== "doku" && (!zuletzt || e.um >= zuletzt.um)) zuletzt = e;
  }
  return { je, zuletzt };
}

/** HH:MM in Ortszeit; leer bei fehlender oder ungueltiger Zeit. */
export function uhrzeit(um: string | undefined): string {
  if (!um) return "";
  const d = new Date(um);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Die verstrichene Zeit seit `um` (A21): unter einer Minute `jetzt`, unter einer Stunde `13m`, unter
 * einem Tag `2h 13m`, sonst ganze Tage `3T`; leer bei fehlender oder ungueltiger Zeit. Eine Zeit in
 * der Zukunft gilt als `jetzt`. Die Ansicht rechnet in live-plan.js gleich.
 */
export function verstrichen(um: string | undefined, jetzt: Date | number = Date.now()): string {
  if (!um) return "";
  const t = new Date(um).getTime();
  const n = typeof jetzt === "number" ? jetzt : jetzt.getTime();
  if (Number.isNaN(t) || Number.isNaN(n)) return "";
  const minuten = Math.floor((n - t) / 60_000);
  if (minuten < 1) return "jetzt";
  if (minuten < 60) return `${minuten}m`;
  if (minuten < 24 * 60) return `${Math.floor(minuten / 60)}h ${minuten % 60}m`;
  return `${Math.floor(minuten / (24 * 60))}T`;
}

// --- Warten auf Entscheidungen ------------------------------------------------------------

export interface NeueEntscheidungen {
  entscheidungen: { frage: string; entscheidung: string }[];
  /** Die Position, ab der der Agent beim naechsten Warten liest. */
  seit: number;
}

/** Die Entscheidungen hinter Position `seit`; je Frage die letzte. */
export function neueEntscheidungen(verlauf: Verlaufseintrag[], seit: number): NeueEntscheidungen {
  // Hinter dem Verlauf heisst: nichts Neues. Nie wieder ab 0, sonst kaeme jede alte Entscheidung erneut.
  const ab = Number.isInteger(seit) && seit >= 0 ? Math.min(seit, verlauf.length) : 0;
  const letzte = new Map<string, string>();
  for (const e of verlauf.slice(ab)) {
    if (e.feld !== "entscheidung" || e.art) continue;
    letzte.delete(e.id);
    if (e.nach) letzte.set(e.id, e.nach);
  }
  return { entscheidungen: [...letzte].map(([frage, entscheidung]) => ({ frage, entscheidung })), seit: verlauf.length };
}

/** Die Antwort von `warte`: je Entscheidung `FRAGE = ENTSCHEIDUNG`, dann `seit=N`. */
export function warteText(ergebnis: NeueEntscheidungen): string {
  return ergebnis.entscheidungen.map((e) => `${e.frage} = ${e.entscheidung}\n`).join("") + `seit=${ergebnis.seit}\n`;
}

// --- Pfade --------------------------------------------------------------------------------

/** Der Ordner der Sitzungen in jedem Repo. */
export const ORDNER = ".live-plan";

/** Die Wurzeln der Repos: LIVE_PLAN_WURZEL (mehrere durch ":"), sonst ~/git, ~/GITHUB und ~/GITHUB_DG. */
export function wurzeln(env: Record<string, string | undefined>): string[] {
  const eigene = [...new Set((env.LIVE_PLAN_WURZEL ?? "").split(":").filter(Boolean))];
  return eigene.length ? eigene : ["git", "GITHUB", "GITHUB_DG"].map((d) => path.join(env.HOME ?? "", d));
}

const NAME = /^[A-Za-z0-9._-]+$/;

export function gueltigerName(name: string): boolean {
  return NAME.test(name) && name !== "." && name !== "..";
}

/** WURZEL/REPO/.live-plan/SLUG.yaml, oder null bei einem Namen, der den Ordner verlassen koennte. */
export function sitzungsPfad(wurzel: string, repo: string, slug: string): string | null {
  if (!gueltigerName(repo) || !gueltigerName(slug)) return null;
  return path.join(wurzel, repo, ORDNER, `${slug}.yaml`);
}

/** Der Belegordner WURZEL/REPO/.live-plan/SLUG, oder null. */
export function belegOrdner(wurzel: string, repo: string, slug: string): string | null {
  if (!gueltigerName(repo) || !gueltigerName(slug)) return null;
  return path.join(wurzel, repo, ORDNER, slug);
}

const echterPfad = (pfad: string): string | null => {
  try {
    return realpathSync(pfad);
  } catch {
    return null;
  }
};

/**
 * Der Pfad eines Belegs, nur ohne Symlink (S-2): .live-plan liegt nach realpath genau im Repo, der
 * Belegordner ist nach realpath genau .live-plan/SLUG, und der Beleg selbst bleibt nach realpath
 * derselbe Pfad. Ein Link auf .git, auf einen Nachbarordner oder innerhalb des Ordners ergibt null.
 */
export function belegPfad(wurzel: string, repo: string, slug: string, rel: string): string | null {
  const ordner = belegOrdner(wurzel, repo, slug);
  if (!ordner || !rel || rel.includes("\0") || path.isAbsolute(rel)) return null;
  const repoEcht = echterPfad(path.join(wurzel, repo));
  const sitzungen = echterPfad(path.join(wurzel, repo, ORDNER));
  if (!repoEcht || sitzungen !== path.join(repoEcht, ORDNER)) return null;
  const ordnerEcht = path.join(sitzungen, slug);
  if (echterPfad(ordner) !== ordnerEcht) return null;
  const ziel = path.resolve(ordnerEcht, rel);
  return ziel.startsWith(ordnerEcht + path.sep) && echterPfad(ziel) === ziel ? ziel : null;
}

// --- Register (S5): je Claude-Sitzung eine JSON, geschrieben von der Mod live-plan-sitzung -------
//
// Vertrag v 1: LIVE_PLAN_CACHE/sitzungen/<id>.json. Der Server liest sie nur; eine halbe oder
// kaputte Datei, eine fremde Fassung, eine Id, die nicht zum Dateinamen passt, oder eine Wurzel,
// die kein absoluter, normaler Pfad ist, gilt als nicht da. Den Rest prueft die Ansicht beim
// Zeichnen (jeder Wert wird escaped), damit ein neues Feld der Mod nichts bricht.

export interface RegisterAgent {
  id: string;
  typ: string;
  beschreibung: string;
  modell: string;
  effort?: string;
  status: "laeuft" | "fertig" | "fehler";
  gestartet: number;
  beendet?: number;
  kontext: number;
  kontextMax: number;
  tokens: number;
  kostenUsd: number;
  stepErledigt?: number;
  stepGesamt?: number;
  stepNotiz?: string;
}

export interface Register {
  v: 1;
  id: string;
  cwd: string;
  wurzel: string | null;
  repo: string | null;
  modell: string;
  gestartet: number;
  aktualisiert: number;
  beendet?: number;
  haupt: {
    kontext: { benutzt: number | null; max: number | null; prozent: number | null };
    kostenUsd: number | null;
    zuege: number;
    // Contract v1.1, optional and passed through unchanged (registerAus filters no fields).
    limits?: { art: string; prozent: number; reset?: number }[];
    limitsZeit?: number;
    tokens?: number;
  };
  fortschritt: null | { titel: string; phase: string; gesamt: number; erledigt: number; laufend: number; fertig: boolean; aufgaben: { titel: string; stufe?: string; nach: number[] }[] };
  agenten: RegisterAgent[];
  dateien?: { pfad: string; gelesen?: number; geschrieben?: number; agent?: string; n: number }[];
}

/** Die Register-JSON zur Id `id`, oder null, wenn sie halb, kaputt oder fremd ist. */
export function registerAus(text: string, id: string): Register | null {
  let roh: unknown;
  try {
    roh = JSON.parse(text);
  } catch {
    return null;
  }
  if (!istObjekt(roh) || roh.v !== 1 || roh.id !== id || !gueltigerName(id)) return null;
  const w = roh.wurzel;
  if (w !== null && !(typeof w === "string" && path.isAbsolute(w) && path.normalize(w) === w)) return null;
  const haupt: Roh = istObjekt(roh.haupt) ? roh.haupt : {};
  const f = roh.fortschritt;
  return {
    ...(roh as unknown as Register),
    haupt: { kostenUsd: null, zuege: 0, ...haupt, kontext: istObjekt(haupt.kontext) ? haupt.kontext : { benutzt: null, max: null, prozent: null } } as Register["haupt"],
    fortschritt: istObjekt(f) ? ({ ...f, aufgaben: Array.isArray(f.aufgaben) ? f.aufgaben.filter(istObjekt) : [] } as unknown as Register["fortschritt"]) : null,
    agenten: Array.isArray(roh.agenten) ? (roh.agenten.filter(istObjekt) as unknown as RegisterAgent[]) : [],
  };
}

/** Das REPO der URL einer Register-Sitzung: der Ordnername der Wurzel, `_` ohne Repo oder bei einem Namen, den die URL nicht traegt. */
export function registerRepo(r: Register): string {
  const name = r.wurzel ? path.basename(r.wurzel) : "";
  return gueltigerName(name) ? name : "_";
}

// --- Dateibaum (Vertrag v1.1): die Ausgaben von git als reine Textfunktionen -------------------
//
// Der Server ruft git ls-files, status --porcelain=v1 -z, diff --numstat -z und rev-list in der
// Wurzel der Sitzung; hier wird nur gelesen, was sie ausgeben. Pfade sind posix und relativ zur
// Git-Wurzel, so wie git sie mit -z ohne Quoting schreibt.

export type BaumStatus = "M" | "A" | "D" | "R" | "?" | "U";

export interface BaumDatei {
  p: string;
  s?: BaumStatus;
  plus?: number;
  minus?: number;
  t?: number;
}

export interface Baum {
  wurzel: string;
  zweig: string | null;
  upstream: string | null;
  vor: number;
  zurueck: number;
  dateien: BaumDatei[];
  gekappt: boolean;
  /** Unter GitButler je angewendetem Branch seine Dateien (E3); sonst und bei jedem Fehler null. */
  but: ButGruppen | null;
}

/** Hoechstens so viele Dateien gehen an die Ansicht. */
export const BAUM_HOECHSTENS = 20_000;

const UNVEREINT = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/** Ein Statuspaar XY aus porcelain v1 als eine Marke; null fuer ignorierte oder leere. */
export function statusMarke(xy: string): BaumStatus | null {
  if (xy === "??") return "?";
  if (xy === "!!" || xy.trim() === "") return null;
  if (UNVEREINT.has(xy)) return "U";
  if (xy.includes("R")) return "R";
  if (xy.includes("A") || xy.includes("C")) return "A";
  if (xy.includes("D")) return "D";
  return "M";
}

/** `git status --porcelain=v1 -z`: Pfad -> Marke. Bei R und C steht der neue Pfad vorn, der alte folgt als eigenes Feld. */
export function porcelainAus(text: string): Map<string, BaumStatus> {
  const marken = new Map<string, BaumStatus>();
  const felder = text.split("\0");
  for (let i = 0; i < felder.length; i++) {
    const f = felder[i]!;
    if (f.length < 4 || f[2] !== " ") continue;
    const xy = f.slice(0, 2);
    // The original path of a rename or copy follows as its own field; skip it.
    if (/[RC]/.test(xy)) i++;
    const marke = statusMarke(xy);
    if (marke) marken.set(f.slice(3), marke);
  }
  return marken;
}

/** `git diff --numstat -z`: Pfad -> Zeilen. Binaere Dateien (`-`) tragen keine Zahl, bei Umbenennung gilt der neue Pfad. */
export function numstatAus(text: string): Map<string, { plus: number; minus: number }> {
  const zahlen = new Map<string, { plus: number; minus: number }>();
  const felder = text.split("\0");
  for (let i = 0; i < felder.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(felder[i]!);
    if (!m) continue;
    let pfad = m[3]!;
    if (pfad === "") {
      // Rename: an empty path, then old and new path as two fields.
      pfad = felder[i + 2] ?? "";
      i += 2;
    }
    if (pfad && m[1] !== "-" && m[2] !== "-") zahlen.set(pfad, { plus: Number(m[1]), minus: Number(m[2]) });
  }
  return zahlen;
}

/** `git rev-list --left-right --count HEAD...@{u}`: vor und zurueck, 0 bei unlesbarer Ausgabe. */
export function abstandAus(text: string | null): { vor: number; zurueck: number } {
  const m = /^(\d+)\s+(\d+)\s*$/.exec(text ?? "");
  return m ? { vor: Number(m[1]), zurueck: Number(m[2]) } : { vor: 0, zurueck: 0 };
}

/** Zeilen eines Inhalts wie `wc -l`, eine letzte Zeile ohne Umbruch zaehlt mit; null fuer binaer (ein NUL-Byte). */
export function zeilenZahl(inhalt: Uint8Array): number | null {
  let n = 0;
  for (const b of inhalt) {
    if (b === 0) return null;
    if (b === 10) n++;
  }
  return inhalt.length > 0 && inhalt[inhalt.length - 1] !== 10 ? n + 1 : n;
}

/**
 * Alle Dateien aus `git ls-files -z` und den Pfaden des Status (so steht auch eine per `git rm`
 * geloeschte Datei darin), mit Marke und Zeilen, nach Pfad sortiert. Mehr als `grenze` Dateien:
 * gekappt, und geaenderte Dateien gehen vor unveraenderten.
 */
export function baumDateien(liste: string, porcelain: string, numstat: string, grenze = BAUM_HOECHSTENS): { dateien: BaumDatei[]; gekappt: boolean } {
  const marken = porcelainAus(porcelain);
  const zahlen = numstatAus(numstat);
  const pfade = new Set(liste.split("\0").filter((p) => p !== ""));
  for (const p of marken.keys()) pfade.add(p);
  const alle = [...pfade].sort().map((p): BaumDatei => {
    const d: BaumDatei = { p };
    const s = marken.get(p);
    if (s) d.s = s;
    const z = zahlen.get(p);
    if (z) Object.assign(d, z);
    return d;
  });
  if (alle.length <= grenze) return { dateien: alle, gekappt: false };
  let frei = grenze - alle.filter((d) => d.s).length;
  return { dateien: alle.filter((d) => d.s !== undefined || frei-- > 0).slice(0, grenze), gekappt: true };
}

// --- Diff einer Datei (GET .../diff?p=): was der Server gelesen hat, als Antwort fuer die Ansicht ---

export type DiffArt = "diff" | "neu" | "datei" | "binaer";

export interface DiffAntwort {
  p: string;
  art: DiffArt;
  text: string;
  gekappt: boolean;
}

/** Hoechstens so viele Bytes Text gehen an die Ansicht. */
export const DIFF_HOECHSTENS = 512 * 1024;
/** Von einer neuen oder unveraenderten Datei liest der Server hoechstens so viele Bytes. */
export const DIFF_LESEN_HOECHSTENS = 1024 * 1024;

/** Ein Pfad relativ zur Wurzel: nicht leer, ohne fuehrendes `/`, ohne NUL, kein Teil leer, `.` oder `..`. */
export function diffPfadGueltig(p: unknown): p is string {
  if (typeof p !== "string" || p === "" || p.length > 4096 || p.startsWith("/") || p.includes("\0")) return false;
  return p.split("/").every((t) => t !== "" && t !== "." && t !== "..");
}

/** Hoechstens so viele Bytes eines Bildes gehen an die Ansicht (GET .../bild?p=); groesser ist 413. */
export const BILD_HOECHSTENS = 10 * 1024 * 1024;

const BILD_ARTEN: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" };

/** Der Inhaltstyp eines Bildes nach der Endung (png, jpg, jpeg, gif, webp, svg), sonst null. */
export function bildArtVon(p: string): string | null {
  const i = p.lastIndexOf(".");
  return i < 0 ? null : (BILD_ARTEN[p.slice(i).toLowerCase()] ?? null);
}

/** Der Pfad der eigenen Plan-Datei einer Sitzung: sie gehoert ihr, auch wenn Git sie ignoriert. */
export function eigenerPlanPfad(slug: string): string {
  return `${ORDNER}/${slug}.yaml`;
}

/** Ob das Register der Sitzung den relativen Pfad `p` als gelesen oder geschrieben fuehrt. */
export function registerBeruehrt(r: Register | null, p: string): boolean {
  const dateien: unknown = r?.dateien;
  return Array.isArray(dateien) && dateien.some((d) => istObjekt(d) && d.pfad === p && (typeof d.gelesen === "number" || typeof d.geschrieben === "number"));
}

/** Namen, die typisch Secrets tragen: eine git-ignorierte Datei mit so einem Namen zeigt der Server nie. */
const GEHEIM = [/^\.env$/, /^\.env\./, /\.pem$/, /\.key$/, /^id_rsa/, /^id_ed25519/, /credentials/, /secret/];

/** Ob ein Teil von `p` wie eine Secret-Datei heisst (Gross- und Kleinschreibung egal). */
export function geheimerName(p: string): boolean {
  return p.split("/").some((t) => GEHEIM.some((m) => m.test(t.toLowerCase())));
}

/** Ob die Quell-IP `ip` einer Verbindung der eigene Rechner ist: 127.0.0.0/8 oder ::1, auch IPv4 in IPv6. */
export function istLoopback(ip: string | null | undefined): boolean {
  const v4 = ip?.toLowerCase().replace(/^::ffff:/, "");
  return v4 === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4 ?? "");
}

/** Unversioniert: neu; ohne Git-Marke: der Inhalt; sonst der Diff gegen HEAD. */
export function diffArtVon(s: BaumStatus | undefined): "diff" | "neu" | "datei" {
  return s === "?" ? "neu" : s ? "diff" : "datei";
}

/** Text auf hoechstens `grenze` Bytes UTF-8, am letzten Zeilenumbruch davor geschnitten. */
export function kappeText(text: string, grenze = DIFF_HOECHSTENS): { text: string; gekappt: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= grenze) return { text, gekappt: false };
  const teil = new TextDecoder().decode(bytes.subarray(0, grenze));
  const umbruch = teil.lastIndexOf("\n");
  // Without a line break, drop only a character cut in half.
  return { text: umbruch >= 0 ? teil.slice(0, umbruch + 1) : teil.replace(/�$/, ""), gekappt: true };
}

/** Der Inhalt einer neuen Datei als Diff gegen /dev/null, so wie `git diff --no-index` ihn schreibt. */
export function neuAlsDiff(p: string, inhalt: string): string {
  const kopf = `--- /dev/null\n+++ b/${p}\n`;
  if (inhalt === "") return kopf;
  const zeilen = inhalt.split("\n");
  const ohneEnde = zeilen[zeilen.length - 1] !== "";
  if (!ohneEnde) zeilen.pop();
  return `${kopf}@@ -0,0 +1${zeilen.length === 1 ? "" : `,${zeilen.length}`} @@\n` + zeilen.map((z) => `+${z}\n`).join("") + (ohneEnde ? "\\ No newline at end of file\n" : "");
}

/** Ob git einen Diff als binaer meldet. */
export function diffBinaer(text: string): boolean {
  return /^Binary files .* differ$/m.test(text) || /^GIT binary patch$/m.test(text);
}

/**
 * Die Antwort aus dem, was der Server gelesen hat: die Ausgabe von git diff (Text) oder den Anfang
 * einer Datei (Bytes). Ein NUL-Byte oder ein binaerer git-Diff gibt nur einen Hinweis; der Text geht
 * auf hoechstens DIFF_HOECHSTENS Bytes.
 */
export function diffAntwort(p: string, art: "diff" | "neu" | "datei", inhalt: string | Uint8Array, gelesenGekappt = false): DiffAntwort {
  const binaer = typeof inhalt === "string" ? inhalt.includes("\0") || (art === "diff" && diffBinaer(inhalt)) : inhalt.includes(0);
  if (binaer) return { p, art: "binaer", text: "Binaerdatei, Inhalt nicht gezeigt", gekappt: false };
  const roh = typeof inhalt === "string" ? inhalt : new TextDecoder().decode(inhalt);
  const k = kappeText(art === "neu" ? neuAlsDiff(p, roh) : roh);
  return { p, art, text: k.text, gekappt: k.gekappt || gelesenGekappt };
}

// --- Fluss, Raster, Jetzt ----------------------------------------------------------------

/** Vorgaenger (Haengt an, wartende Fragen) und Nachfolger (Entsperrt) eines Schritts oder einer Frage. */
export function fluss(plan: Plan, id: string): { vor: string[]; nach: string[] } {
  const vor = new Set<string>();
  const nach = new Set<string>();
  const schritt = plan.schritte.find((s) => s.id === id);
  if (schritt) for (const h of schritt.haengt) vor.add(h);
  for (const f of plan.fragen) if (f.blockiert.includes(id)) vor.add(f.id);
  for (const s of plan.schritte) if (s.haengt.includes(id)) nach.add(s.id);
  const frage = plan.fragen.find((f) => f.id === id);
  if (frage) for (const b of frage.blockiert) nach.add(b);
  return { vor: [...vor], nach: [...nach] };
}

export type Stufe = "voll" | "mittel" | "klein" | "punkt";

/** Ab so vielen Schritten ist die Ansicht kompakt. */
export const KOMPAKT_AB = 24;

/** Rang 1 bis 5 voll, 6 bis 10 mittel, 11 bis 20 klein, danach Punkt. */
const STUFEN: [bis: number, stufe: Stufe][] = [
  [5, "voll"],
  [10, "mittel"],
  [20, "klein"],
];

export interface Raster {
  kompakt: boolean;
  zellen: { bahn: string; welle: string; schritte: string[] }[];
  stufe: Record<string, Stufe>;
  /** Je Bahn fertig durch alle Schritte der Bahn, 0 bis 1. */
  spuren: Record<string, number>;
  agenten: string[];
}

export const erledigt = (status: Status) => status === "fertig" || status === "verworfen";

export function raster(plan: Plan, z: Zeiten): Raster {
  const kompakt = plan.schritte.length >= KOMPAKT_AB;
  const stufe: Record<string, Stufe> = Object.create(null);
  for (const s of plan.schritte) stufe[s.id] = "voll";
  if (kompakt) {
    const zeit = (id: string) => z.je[id]?.fertig_um ?? z.je[id]?.geaendert_um ?? "";
    const geschlossen = plan.schritte.filter((s) => erledigt(s.status)).sort((a, b) => (zeit(a.id) < zeit(b.id) ? 1 : zeit(a.id) > zeit(b.id) ? -1 : 0));
    geschlossen.forEach((s, rang) => {
      stufe[s.id] = STUFEN.find(([bis]) => rang < bis)?.[1] ?? "punkt";
    });
  }
  const zellen = plan.bahnen.flatMap((b) =>
    plan.wellen.map((w) => ({ bahn: b.id, welle: w.id, schritte: plan.schritte.filter((s) => s.bahn === b.id && s.welle === w.id).map((s) => s.id) })),
  );
  const spuren: Record<string, number> = Object.create(null);
  for (const b of plan.bahnen) {
    const alle = plan.schritte.filter((s) => s.bahn === b.id);
    spuren[b.id] = alle.length === 0 ? 0 : alle.filter((s) => s.status === "fertig").length / alle.length;
  }
  const agenten = [...new Set(plan.schritte.flatMap((s) => (s.agent ? [s.agent] : [])))];
  return { kompakt, zellen, stufe, spuren, agenten };
}

export interface InArbeit {
  id: string;
  titel: string;
  agent?: string;
  seit?: string;
}

/** Jeder Schritt auf `laeuft`, mit dem Beginn aus dem Verlauf. */
export function jetzt(plan: Plan, z: Zeiten): InArbeit[] {
  return plan.schritte
    .filter((s) => s.status === "laeuft")
    .map((s) => {
      const e: InArbeit = { id: s.id, titel: s.titel };
      if (s.agent) e.agent = s.agent;
      const seit = z.je[s.id]?.gestartet_um;
      if (seit) e.seit = seit;
      return e;
    });
}

// --- Anforderungen (S23) ------------------------------------------------------------------

/** Abgeleitet aus den Schritten einer Anforderung, nie aus der Datei. */
export type Erfuellung = "erfuellt" | "in-arbeit" | "offen";

export interface Anforderungsstand {
  je: Record<string, Erfuellung>;
  erfuellt: number;
  gesamt: number;
}

/**
 * Die eine Regel fuer den Zustand einer Anforderung in `anforderungsStand()`: alle genannten Schritte
 * ausser den verworfenen und unbekannten fertig (und mindestens einer bleibt): erfuellt. Mindestens
 * einer fertig oder laeuft: in Arbeit. Sonst, auch ohne Schritte: offen.
 */
function erfuellungVon(erfuelltMit: string[], status: (id: string) => Status | undefined): Erfuellung {
  const zaehlt = erfuelltMit.flatMap((id) => {
    const s = status(id);
    return s && s !== "verworfen" ? [s] : [];
  });
  if (zaehlt.length > 0 && zaehlt.every((s) => s === "fertig")) return "erfuellt";
  return zaehlt.some((s) => s === "fertig" || s === "laeuft") ? "in-arbeit" : "offen";
}

/** Der Zustand je Anforderung aus dem Status der Schritte im Plan. */
export function anforderungsStand(plan: Plan): Anforderungsstand {
  const status = new Map(plan.schritte.map((s) => [s.id, s.status]));
  const je: Record<string, Erfuellung> = {};
  for (const a of plan.anforderungen) je[a.id] = erfuellungVon(a.erfuellt_mit, (id) => status.get(id));
  return { je, erfuellt: Object.values(je).filter((z) => z === "erfuellt").length, gesamt: plan.anforderungen.length };
}

/** Die zuletzt geaenderte der Ids laut Verlauf; bei gleicher Zeit die hintere, weil Neues hinten angehaengt wird. */
export function neuesteId(ids: string[], z: Zeiten): string | null {
  let beste: string | null = null;
  let bisher = "";
  for (const id of ids) {
    const um = z.je[id]?.geaendert_um;
    if (um && um >= bisher) {
      beste = id;
      bisher = um;
    }
  }
  return beste;
}

const kuerze = (text: string, n: number) => (text.length > n ? text.slice(0, n - 1).trimEnd() + "…" : text);

// --- Alles auf einen Blick (S26, Nutzerentscheid E7) und Beweisbild (A20) --------------------
//
// Eine Jetzt-Zeile, drei Abschnitte zu hoechstens UEBERBLICK_N Eintraegen und das Spurbild. Was die
// Jetzt-Zeile zeigt, steht nirgends sonst; aeltere Eintraege liegen hinter einem Knopf.

/** So viele Eintraege zeigt ein Abschnitt, der Rest liegt hinter `+N aeltere`. */
export const UEBERBLICK_N = 5;

export interface Teil<T> {
  sichtbar: T[];
  aelter: T[];
}

const teile = <T>(liste: T[]): Teil<T> => ({ sichtbar: liste.slice(0, UEBERBLICK_N), aelter: liste.slice(UEBERBLICK_N) });

export type Blatt = Stand["offen"][number];

/** Genau eine Jetzt-Zeile: offene Fragen vor laufenden Schritten vor dem Blatt jetzt vor dem Thema. */
export type JetztZeile =
  | { art: "fragen"; fragen: string[] }
  | { art: "laeuft"; schritte: InArbeit[] }
  | { art: "offen"; blatt: Blatt }
  | { art: "thema"; text: string }
  | { art: "nichts" };

export interface UeberblickAnforderung {
  id: string;
  zustand: Erfuellung;
  /** Beweisbild relativ zum Belegordner oder null. */
  beweis: string | null;
}

export interface Ueberblick {
  jetzt: JetztZeile;
  anforderungen: Teil<UeberblickAnforderung> & { erfuellt: number; gesamt: number };
  entscheidungen: Teil<{ id: string }>;
  offen: Teil<Blatt>;
}

const GATE_RANG: Record<Gate, number> = { mensch: 0, jetzt: 1, spaeter: 2 };

/**
 * Das Beweisbild einer Anforderung: `beweis` aus der Datei, sonst das juengste Bild aus den Belegen
 * der Schritte in `erfuellt_mit` (nach fertig_um, sonst geaendert_um; im Schritt das letzte Bild).
 * Verworfene Schritte zaehlen nicht. Ohne Bild null.
 */
export function beweisbild(plan: Plan, anforderung: string, z: Zeiten): string | null {
  const a = plan.anforderungen.find((x) => x.id === anforderung);
  if (!a) return null;
  if (a.beweis) return a.beweis;
  let bild: string | null = null;
  let bisher = "";
  for (const id of a.erfuellt_mit) {
    const s = plan.schritte.find((x) => x.id === id);
    if (!s || s.status === "verworfen") continue;
    // K1 (S29): nur ein Bildpfad zaehlt, kein Text ohne Bildendung und kein Pfad mit `..`.
    const bilder = (s.umsetzung?.belege ?? []).flatMap((b) => (b.art === "bild" && istBildpfad(b.pfad) ? [b.pfad] : []));
    if (bilder.length === 0) continue;
    const um = z.je[id]?.fertig_um ?? z.je[id]?.geaendert_um ?? "";
    if (bild === null || um >= bisher) {
      bild = bilder.at(-1)!;
      bisher = um;
    }
  }
  return bild;
}

/** Juengste zuerst nach geaendert_um; bei gleicher oder fehlender Zeit der hintere Eintrag der Datei zuerst. */
function juengsteZuerst<T extends { id: string }>(liste: T[], z: Zeiten): T[] {
  return liste
    .map((e, i) => ({ e, i, um: z.je[e.id]?.geaendert_um ?? "" }))
    .sort((a, b) => (a.um < b.um ? 1 : a.um > b.um ? -1 : b.i - a.i))
    .map((x) => x.e);
}

/** Offen ist eine Frage ohne entscheidung, auch eine aus AskUserQuestion oder Sprengradius (die Mod schreibt sie in die YAML). */
export function offeneFragen(plan: Plan): string[] {
  return plan.fragen.filter((f) => !f.entscheidung).map((f) => f.id);
}

/** Zahl der offenen Fragen fuer die Liste; null, wenn die Datei kein YAML-Objekt ist (kaputt, halb geschrieben, leer). */
export function offeneFragenZahl(roh: unknown): number | null {
  return vergleichbar(roh) ? offeneFragen(pruefePlan(roh).plan).length : null;
}

export function ueberblick(plan: Plan, z: Zeiten): Ueberblick {
  const wartend = offeneFragen(plan);
  const laufend = jetzt(plan, z);
  const offen = plan.stand?.offen ?? [];
  const blattJetzt = offen.find((b) => b.gate === "jetzt");
  const zeile: JetztZeile =
    wartend.length > 0
      ? { art: "fragen", fragen: wartend }
      : laufend.length > 0
        ? { art: "laeuft", schritte: laufend }
        : blattJetzt
          ? { art: "offen", blatt: blattJetzt }
          : plan.stand?.thema
            ? { art: "thema", text: plan.stand.thema }
            : { art: "nichts" };

  const stand = anforderungsStand(plan);
  const anforderungen = juengsteZuerst(plan.anforderungen, z)
    .map((a): UeberblickAnforderung => ({ id: a.id, zustand: stand.je[a.id] ?? "offen", beweis: beweisbild(plan, a.id, z) }))
    // stabil: erst alle nicht erfuellten, dann die erfuellten, je in der Reihenfolge von oben
    .sort((a, b) => Number(a.zustand === "erfuellt") - Number(b.zustand === "erfuellt"));
  const blaetter = offen
    .filter((b) => !(zeile.art === "offen" && b === blattJetzt))
    .map((b, i) => ({ b, i }))
    .sort((a, b) => GATE_RANG[a.b.gate] - GATE_RANG[b.b.gate] || a.i - b.i)
    .map((x) => x.b);
  return {
    jetzt: zeile,
    anforderungen: { ...teile(anforderungen), erfuellt: stand.erfuellt, gesamt: stand.gesamt },
    entscheidungen: teile(juengsteZuerst(plan.entscheidungen, z).map((e) => ({ id: e.id }))),
    offen: teile(blaetter),
  };
}

// --- Spurbild (S26) ---------------------------------------------------------------------------
//
// Ein schmales Punktbild wie hiro fortschritt.html: eine Zeile je Bahn und oben eine fuer die
// Fragen, eine Spalte je Welle, ein Punkt je Schritt. Spaltenbreite nach der vollsten Zelle der
// Welle. Kanten als Bezier-Kurven, im selben Strang als Bogen ueber der Zeile.

/** Die laengste verstrichene Zeit, fuer die das Spurbild Platz haelt. */
const LAENGSTE_ANGABE = "23h 59m";

/** Masse des Spurbilds in Pixeln; `zeichen` ist die geschaetzte Breite eines Zeichens der Beschriftung. */
export const SPUR = { kopf: 22, zeile: 30, r: 5, links: 150, luecke: 10, zeichen: 6.2, spalteMin: 48, rand: 10, bogen: 16 } as const;

export interface SpurZeile {
  id: string;
  name: string;
  y: number;
  fertig: number;
  gesamt: number;
}

export interface SpurSpalte {
  id: string;
  name: string;
  ziel?: string;
  x: number;
  w: number;
}

export interface SpurPunkt {
  id: string;
  art: "schritt" | "frage";
  status: Status | "entschieden";
  titel: string;
  x: number;
  y: number;
  welle: string;
  zeile: string;
  /** Beschriftung nach Stufe: voll Id und kurzer Titel, mittel Id, klein und Punkt leer. */
  label: string;
  mensch?: boolean;
  zuletzt?: boolean;
  /** ISO-Zeit am zuletzt geaenderten Punkt; die Ansicht zeigt daraus die verstrichene Zeit (A21). */
  um?: string;
  /** HH:MM am zuletzt geaenderten Punkt, in der Ansicht nur im title. */
  uhr?: string;
}

export interface SpurKante {
  von: string;
  nach: string;
  art: Kantenart;
  /** Beide Enden in derselben Zeile: Bogen ueber der Zeile. */
  bogen: boolean;
  d: string;
}

export interface Spurbild {
  breite: number;
  hoehe: number;
  zeilen: SpurZeile[];
  spalten: SpurSpalte[];
  punkte: SpurPunkt[];
  kanten: SpurKante[];
}

export function spurbild(plan: Plan, z: Zeiten): Spurbild {
  const S = SPUR;
  const r = raster(plan, z);
  const zeileY = (i: number) => S.kopf + i * S.zeile + S.zeile / 2;
  const wellenIndex = new Map(plan.wellen.map((w, i) => [w.id, i]));
  const zuletzt = z.zuletzt?.id;

  // Eine Frage steht in der Spalte des fruehesten Schritts, der auf sie wartet.
  const welleDerFrage = (f: Frage): string => {
    const wartende = plan.schritte.filter((s) => f.blockiert.includes(s.id) || s.haengt.includes(f.id));
    const idx = wartende.map((s) => wellenIndex.get(s.welle) ?? Infinity).filter((i) => i !== Infinity);
    return plan.wellen[idx.length > 0 ? Math.min(...idx) : 0]?.id ?? "";
  };

  type Roh = Omit<SpurPunkt, "x" | "y">;
  const roh: Roh[] = [];
  for (const f of plan.fragen) {
    const p: Roh = { id: f.id, art: "frage", status: f.entscheidung ? "entschieden" : "offen", titel: f.frage, welle: welleDerFrage(f), zeile: "fragen", label: f.id };
    if (zuletzt === f.id) Object.assign(p, { zuletzt: true, um: z.zuletzt!.um, uhr: uhrzeit(z.zuletzt!.um) });
    roh.push(p);
  }
  const bahnen = new Set(plan.bahnen.map((b) => b.id));
  for (const s of plan.schritte) {
    if (!bahnen.has(s.bahn) || !wellenIndex.has(s.welle)) continue;
    const stufe = r.stufe[s.id] ?? "voll";
    const label = stufe === "voll" ? `${s.id} ${kuerze(s.titel, 20)}` : stufe === "mittel" ? s.id : "";
    const p: Roh = { id: s.id, art: "schritt", status: s.status, titel: s.titel, welle: s.welle, zeile: s.bahn, label };
    if (s.art === "mensch") p.mensch = true;
    if (zuletzt === s.id) Object.assign(p, { zuletzt: true, um: z.zuletzt!.um, uhr: uhrzeit(z.zuletzt!.um) });
    roh.push(p);
  }

  // Am zuletzt geaenderten Punkt Platz fuer die laengste Angabe unter einem Tag (A21).
  const breiteVon = (p: Roh) => 2 * S.r + S.luecke + ((p.label ? p.label.length + 1 : 0) + (p.um ? LAENGSTE_ANGABE.length + 1 : 0)) * S.zeichen;
  const zeilenIds = ["fragen", ...plan.bahnen.map((b) => b.id)];
  const spalten: SpurSpalte[] = [];
  let x = S.links;
  for (const w of plan.wellen) {
    const voll = Math.max(0, ...zeilenIds.map((zid) => roh.filter((p) => p.welle === w.id && p.zeile === zid).reduce((n, p) => n + breiteVon(p), 0)));
    const breite = Math.max(S.spalteMin, voll) + 2 * S.rand;
    spalten.push({ id: w.id, name: w.name, ...(w.ziel ? { ziel: w.ziel } : {}), x: rund(x), w: rund(breite) });
    x += breite;
  }
  const spalteVon = new Map(spalten.map((s) => [s.id, s]));
  const punkte: SpurPunkt[] = [];
  for (const zid of zeilenIds) {
    const y = zeileY(zeilenIds.indexOf(zid));
    for (const sp of spalten) {
      let px = sp.x + S.rand;
      for (const p of roh.filter((q) => q.welle === sp.id && q.zeile === zid)) {
        punkte.push({ ...p, x: rund(px + S.r), y });
        px += breiteVon(p);
      }
    }
  }
  // In der Reihenfolge der Datei: erst Fragen, dann Schritte.
  const reihenfolge = new Map(roh.map((p, i) => [p.id, i]));
  punkte.sort((a, b) => reihenfolge.get(a.id)! - reihenfolge.get(b.id)!);

  const zeilen: SpurZeile[] = zeilenIds.map((zid, i) => {
    if (zid === "fragen") return { id: zid, name: "Fragen", y: zeileY(i), fertig: plan.fragen.filter((f) => f.entscheidung).length, gesamt: plan.fragen.length };
    const alle = plan.schritte.filter((s) => s.bahn === zid);
    return { id: zid, name: plan.bahnen[i - 1]!.name, y: zeileY(i), fertig: alle.filter((s) => s.status === "fertig").length, gesamt: alle.length };
  });

  const pos = new Map(punkte.map((p) => [p.id, p]));
  const kanten: SpurKante[] = [];
  const gesehen = new Set<string>();
  for (const s of plan.schritte) {
    const vor = [...s.haengt, ...plan.fragen.filter((f) => f.blockiert.includes(s.id)).map((f) => f.id)];
    for (const v of vor) {
      const a = pos.get(v);
      const b = pos.get(s.id);
      if (!a || !b || gesehen.has(`${v}>${s.id}`)) continue;
      gesehen.add(`${v}>${s.id}`);
      const fertigVorher = a.art === "frage" ? a.status === "entschieden" : a.status === "fertig";
      const art: Kantenart = b.status === "laeuft" ? "lauf" : fertigVorher && b.status === "fertig" ? "fertig" : "offen";
      const bogen = a.y === b.y;
      let d: string;
      if (bogen) {
        const h = Math.min(S.zeile * 0.8, S.bogen + Math.abs(b.x - a.x) * 0.1);
        d = `M${a.x},${a.y} C${a.x},${rund(a.y - h)} ${b.x},${rund(b.y - h)} ${b.x},${b.y}`;
      } else {
        const mx = rund((a.x + b.x) / 2);
        d = `M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`;
      }
      kanten.push({ von: v, nach: s.id, art, bogen, d });
    }
  }
  const breite = rund(Math.max(x, S.links + S.spalteMin) + S.rand);
  return { breite, hoehe: S.kopf + zeilenIds.length * S.zeile, zeilen, spalten, punkte, kanten };
}

// --- Prozesslayout -------------------------------------------------------------------------
//
// Bahnen als Spalten, Wellen als waagerechte Baender, in einer Welle Zeilen nach lokalem Rang
// (laengster Pfad ueber `haengt` innerhalb der Welle). Kein Layout-Paket: Bahn und Welle sind fest
// vorgegeben, nur der Rang wird gerechnet. Kanten orthogonal mit runden Ecken und aufgefaecherten
// Ports nach tt-a1i/archify (MIT), siehe ~/.claude/knowledge/insights/svg-diagramme/archify-muster.md.

/** Masse der Prozessansicht in Pixeln. */
export const PROZESS = { knotenB: 196, knotenH: 50, abstandX: 14, abstandY: 48, kopf: 40, fragenB: 118, wellenKopf: 24, bahnLuecke: 6, stummel: 16, faecher: 14, rand: 8, kreis: 6 } as const;

export interface ProzessKnoten {
  id: string;
  art: "schritt" | "frage";
  /** Status des Schritts; bei einer Frage `entschieden` oder `offen`. */
  status: string;
  /** Index der Bahn, -1 fuer die Spalte der Fragen. */
  spalte: number;
  zeile: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Kantenart = "fertig" | "lauf" | "offen";

export interface ProzessKante {
  von: string;
  nach: string;
  art: Kantenart;
  punkte: [number, number][];
  /** SVG-Pfad mit abgerundeten Ecken. */
  d: string;
  /** Reihenfolge fuer den Einlauf, auf 12 gekappt. */
  schritt: number;
}

export interface ProzessRand {
  art: "start" | "ende";
  zu: string;
  cx: number;
  cy: number;
  r: number;
  /** Stummel zwischen Kreis und Knoten. */
  d: string;
}

export interface Prozess {
  breite: number;
  hoehe: number;
  fragenSpalte: { x: number; w: number } | null;
  bahnen: { id: string; name: string; x: number; w: number }[];
  wellen: { id: string; name: string; ziel?: string; y: number; h: number }[];
  knoten: ProzessKnoten[];
  kanten: ProzessKante[];
  raender: ProzessRand[];
}

const rund = (n: number) => Math.round(n * 10) / 10;

/** Ein orthogonaler Linienzug als SVG-Pfad, jede Ecke als Viertelbogen mit hoechstens `radius`. */
export function rundePfad(punkte: [number, number][], radius = 8): string {
  if (punkte.length === 0) return "";
  const [x0, y0] = punkte[0]!;
  let d = `M${rund(x0)},${rund(y0)}`;
  for (let i = 1; i < punkte.length - 1; i++) {
    const [ax, ay] = punkte[i - 1]!;
    const [ex, ey] = punkte[i]!;
    const [bx, by] = punkte[i + 1]!;
    const l1 = Math.hypot(ex - ax, ey - ay);
    const l2 = Math.hypot(bx - ex, by - ey);
    const r = Math.min(radius, l1 / 2, l2 / 2);
    const vor: [number, number] = [ex - ((ex - ax) / (l1 || 1)) * r, ey - ((ey - ay) / (l1 || 1)) * r];
    const nach: [number, number] = [ex + ((bx - ex) / (l2 || 1)) * r, ey + ((by - ey) / (l2 || 1)) * r];
    d += ` L${rund(vor[0])},${rund(vor[1])} Q${rund(ex)},${rund(ey)} ${rund(nach[0])},${rund(nach[1])}`;
  }
  if (punkte.length > 1) {
    const [xn, yn] = punkte[punkte.length - 1]!;
    d += ` L${rund(xn)},${rund(yn)}`;
  }
  return d;
}

/** Doppelte und in einer Linie liegende Zwischenpunkte fallen weg. */
function glatt(punkte: [number, number][]): [number, number][] {
  const ohneDoppelte = punkte.filter((p, i) => i === 0 || p[0] !== punkte[i - 1]![0] || p[1] !== punkte[i - 1]![1]);
  return ohneDoppelte.filter((p, i, a) => {
    if (i === 0 || i === a.length - 1) return true;
    const [ax, ay] = a[i - 1]!;
    const [bx, by] = a[i + 1]!;
    return !((ax === p[0] && p[0] === bx) || (ay === p[1] && p[1] === by));
  });
}

/** Die Prozessansicht eines Plans: Knoten mit Spalte, Zeile und Koordinaten, Kanten mit Punkten. */
export function prozessLayout(plan: Plan): Prozess {
  const P = PROZESS;
  const bahnIndex = new Map(plan.bahnen.map((b, i) => [b.id, i]));
  const wellenIds = new Set(plan.wellen.map((w) => w.id));
  const schritte = plan.schritte.filter((s) => bahnIndex.has(s.bahn) && wellenIds.has(s.welle));
  const jeId = new Map(schritte.map((s) => [s.id, s]));

  // Lokaler Rang: laengster Pfad ueber haengt innerhalb derselben Welle; ein Kreis bricht ab.
  const rang = new Map<string, number>();
  const unterwegs = new Set<string>();
  const rangVon = (id: string): number => {
    const bekannt = rang.get(id);
    if (bekannt !== undefined) return bekannt;
    if (unterwegs.has(id)) return 0;
    unterwegs.add(id);
    const s = jeId.get(id)!;
    const vor = s.haengt.filter((h) => jeId.get(h)?.welle === s.welle);
    const r = vor.length ? 1 + Math.max(...vor.map(rangVon)) : 0;
    unterwegs.delete(id);
    rang.set(id, r);
    return r;
  };
  for (const s of schritte) rangVon(s.id);

  // Wellen untereinander, je Welle so viele Zeilen wie ihr hoechster Rang plus eins.
  const zeileY: number[] = [];
  const ersteZeile = new Map<string, number>();
  const wellen: Prozess["wellen"] = [];
  let y = P.kopf;
  for (const w of plan.wellen) {
    const raenge = schritte.filter((s) => s.welle === w.id).map((s) => rang.get(s.id)!);
    const n = raenge.length ? 1 + Math.max(...raenge) : 1;
    const oben = y;
    ersteZeile.set(w.id, zeileY.length);
    y += P.wellenKopf + 24;
    for (let i = 0; i < n; i++) {
      zeileY.push(y);
      y += P.knotenH + P.abstandY;
    }
    const unten = y - P.abstandY + 28;
    wellen.push(w.ziel ? { id: w.id, name: w.name, ziel: w.ziel, y: oben, h: unten - oben } : { id: w.id, name: w.name, y: oben, h: unten - oben });
    y = unten + 10;
  }
  const hoehe = y + P.rand;
  const zeileVon = (id: string) => ersteZeile.get(jeId.get(id)!.welle)! + rang.get(id)!;

  // Zellen aus Bahn und Zeile; die Bahn ist so breit wie ihre vollste Zelle.
  const zellen = new Map<string, string[]>();
  for (const s of schritte) {
    const schluessel = `${s.bahn}|${zeileVon(s.id)}`;
    zellen.set(schluessel, [...(zellen.get(schluessel) ?? []), s.id]);
  }
  const fragenSpalte = plan.fragen.length ? { x: P.rand, w: P.fragenB } : null;
  let x = fragenSpalte ? fragenSpalte.x + fragenSpalte.w + P.abstandX : P.rand;
  const bahnen: Prozess["bahnen"] = plan.bahnen.map((b) => {
    let meiste = 1;
    for (const [schluessel, ids] of zellen) if (schluessel.startsWith(`${b.id}|`)) meiste = Math.max(meiste, ids.length);
    const w = meiste * P.knotenB + (meiste - 1) * P.abstandX + 2 * P.abstandX;
    const bahn = { id: b.id, name: b.name, x, w };
    x += w + P.bahnLuecke;
    return bahn;
  });
  const breite = x - P.bahnLuecke + P.rand;
  const bahnVon = new Map(bahnen.map((b) => [b.id, b]));

  const knoten: ProzessKnoten[] = [];
  const pos = new Map<string, ProzessKnoten>();
  for (const s of schritte) {
    const zeile = zeileVon(s.id);
    const zelle = zellen.get(`${s.bahn}|${zeile}`)!;
    const i = zelle.indexOf(s.id);
    const b = bahnVon.get(s.bahn)!;
    const gesamt = zelle.length * P.knotenB + (zelle.length - 1) * P.abstandX;
    const k: ProzessKnoten = { id: s.id, art: "schritt", status: s.status, spalte: bahnIndex.get(s.bahn)!, zeile, x: b.x + (b.w - gesamt) / 2 + i * (P.knotenB + P.abstandX), y: zeileY[zeile]!, w: P.knotenB, h: P.knotenH };
    knoten.push(k);
    pos.set(s.id, k);
  }

  // Fragen als Raute links, auf Hoehe des ersten Schritts, der auf sie wartet.
  const belegt = new Set<number>();
  for (const f of plan.fragen) {
    const ziele = schritte.filter((s) => f.blockiert.includes(s.id) || s.haengt.includes(f.id)).map((s) => pos.get(s.id)!.y);
    let fy = ziele.length ? Math.min(...ziele) : (zeileY[0] ?? P.kopf);
    while (belegt.has(fy)) fy += P.knotenH + 10;
    belegt.add(fy);
    const k: ProzessKnoten = { id: f.id, art: "frage", status: f.entscheidung ? "entschieden" : "offen", spalte: -1, zeile: -1, x: P.rand, y: fy, w: P.fragenB - 14, h: P.knotenH };
    knoten.push(k);
    pos.set(f.id, k);
  }

  // Kanten: haengt und blockiert, jede einmal.
  const paare: [string, string][] = [];
  const gesehen = new Set<string>();
  for (const s of schritte) {
    const vor = [...s.haengt, ...plan.fragen.filter((f) => f.blockiert.includes(s.id)).map((f) => f.id)];
    for (const v of vor) {
      if (!pos.has(v) || gesehen.has(`${v}>${s.id}`)) continue;
      gesehen.add(`${v}>${s.id}`);
      paare.push([v, s.id]);
    }
  }
  type Seite = "unten" | "oben" | "links" | "rechts";
  const seiten = paare.map(([v, n]): [Seite, Seite] => {
    const a = pos.get(v)!;
    const b = pos.get(n)!;
    if (a.art === "frage") return ["rechts", "links"];
    return b.y > a.y ? ["unten", "oben"] : ["rechts", "rechts"];
  });
  // Ports auffaechern: je Knoten und Seite nach der Lage des anderen Endes sortiert.
  const anker = new Map<string, number>();
  const gruppen = new Map<string, { kante: number; ende: 0 | 1; gegen: number }[]>();
  paare.forEach(([v, n], i) => {
    const [sa, sb] = seiten[i]!;
    const a = pos.get(v)!;
    const b = pos.get(n)!;
    const quer = (k: ProzessKnoten, seite: Seite) => (seite === "unten" || seite === "oben" ? k.x + k.w / 2 : k.y + k.h / 2);
    for (const [ende, id, seite, gegen] of [[0, v, sa, quer(b, sa)], [1, n, sb, quer(a, sb)]] as const) {
      const schluessel = `${id}|${seite}`;
      gruppen.set(schluessel, [...(gruppen.get(schluessel) ?? []), { kante: i, ende, gegen }]);
    }
  });
  for (const [schluessel, liste] of gruppen) {
    const [id, seite] = schluessel.split("|") as [string, Seite];
    const k = pos.get(id)!;
    liste.sort((p, q) => p.gegen - q.gegen || p.kante - q.kante);
    const waagerecht = seite === "unten" || seite === "oben";
    const laenge = waagerecht ? k.w : k.h;
    const platz = laenge - 2 * P.stummel;
    const schritt = liste.length > 1 ? Math.min(P.faecher, platz / (liste.length - 1)) : 0;
    const mitte = waagerecht ? k.x + k.w / 2 : k.y + k.h / 2;
    liste.forEach((p, j) => anker.set(`${p.kante}|${p.ende}`, k.art === "frage" ? mitte : mitte + (j - (liste.length - 1) / 2) * schritt));
  }

  const erledigtVon = (id: string) => {
    const k = pos.get(id)!;
    return k.art === "frage" ? k.status === "entschieden" : k.status === "fertig";
  };
  const reihenfolge = paare.map((_, i) => i).sort((p, q) => {
    const a = pos.get(paare[p]![1])!;
    const b = pos.get(paare[q]![1])!;
    return a.y - b.y || a.x - b.x;
  });
  const kanten: ProzessKante[] = paare.map(([v, n], i) => {
    const a = pos.get(v)!;
    const b = pos.get(n)!;
    const [sa] = seiten[i]!;
    const p0 = anker.get(`${i}|0`)!;
    const p1 = anker.get(`${i}|1`)!;
    let punkte: [number, number][];
    if (sa === "unten") {
      const y1 = a.y + a.h;
      const y2 = b.y;
      const ym = y2 - P.abstandY / 2;
      punkte = [[p0, y1], [p0, ym], [p1, ym], [p1, y2]];
    } else if (a.art === "frage") {
      const x1 = a.x + a.w;
      const x2 = b.x;
      const xm = x2 - P.stummel;
      punkte = [[x1, p0], [xm, p0], [xm, p1], [x2, p1]];
    } else {
      const x1 = a.x + a.w;
      const x2 = b.x + b.w;
      const xr = Math.max(x1, x2) + P.stummel;
      punkte = [[x1, p0], [xr, p0], [xr, p1], [x2, p1]];
    }
    punkte = glatt(punkte.map(([px, py]) => [rund(px), rund(py)]));
    const art: Kantenart = b.status === "laeuft" ? "lauf" : erledigtVon(v) && b.status === "fertig" ? "fertig" : "offen";
    return { von: v, nach: n, art, punkte, d: rundePfad(punkte), schritt: Math.min(reihenfolge.indexOf(i), 12) };
  });

  // Start- und Endkreise: Schritte ohne Vorgaenger und ohne Nachfolger.
  const hatVor = new Set(paare.map(([, n]) => n));
  const hatNach = new Set(paare.map(([v]) => v));
  const raender: ProzessRand[] = [];
  for (const s of schritte) {
    const k = pos.get(s.id)!;
    const cx = rund(k.x + k.w / 2);
    if (!hatVor.has(s.id)) raender.push({ art: "start", zu: s.id, cx, cy: k.y - 16, r: P.kreis, d: `M${cx},${k.y - 16 + P.kreis} L${cx},${k.y}` });
    if (!hatNach.has(s.id)) raender.push({ art: "ende", zu: s.id, cx, cy: k.y + k.h + 16, r: P.kreis, d: `M${cx},${k.y + k.h} L${cx},${k.y + k.h + 16 - P.kreis}` });
  }

  return { breite: rund(breite), hoehe: rund(hoehe), fragenSpalte, bahnen, wellen, knoten, kanten, raender };
}

// --- Git-Stand ----------------------------------------------------------------------------

export const WORKSPACE = "gitbutler/workspace";

export interface GitEingabe {
  /** Ausgabe von `git branch --show-current`; null, wenn der Befehl scheiterte. */
  aktuell: string | null;
  /** Kopfschluessel `branch` der Sitzung. */
  kopfBranch?: string;
  /** Ausgabe von `git diff --name-only origin/main...BRANCH`. */
  diff: { art: "ok"; namen: string } | { art: "fehler"; grund: string };
  /** Ausgabe von `but status --json`; nur unter GitButler gelesen. */
  butStatusJson?: string | null;
}

/** null heisst unbekannt, nie 0. */
export interface GitStand {
  branch: string | null;
  gitbutler: boolean | null;
  dateien: number | null;
  branches: string[] | null;
}

/** Der Branch, gegen den die Sitzung misst: unter GitButler der Kopfschluessel, sonst der aktuelle. */
export function sitzungsBranch(aktuell: string | null, kopfBranch?: string): string | null {
  const a = aktuell?.trim() || null;
  if (a === WORKSPACE) return kopfBranch?.trim() || WORKSPACE;
  return a;
}

function angewendeteBranches(json: string | null | undefined): string[] | null {
  return butStatusAus(json)?.stacks.flatMap((s) => s.branches) ?? null;
}

export function gitStand(eingabe: GitEingabe): GitStand {
  const aktuell = eingabe.aktuell?.trim() || null;
  const gitbutler = aktuell === null ? null : aktuell === WORKSPACE;
  return {
    branch: sitzungsBranch(aktuell, eingabe.kopfBranch),
    gitbutler,
    dateien: eingabe.diff.art === "ok" ? eingabe.diff.namen.split("\n").filter((z) => z.trim() !== "").length : null,
    branches: gitbutler ? angewendeteBranches(eingabe.butStatusJson) : null,
  };
}

// --- GitButler im Dateibaum (E3): je angewendetem Branch seine Dateien ------------------------
//
// Der Server liest `but status --json` und je Branch `git diff --name-status -z` und `--numstat -z`
// gegen seine Basis; hier wird nur gelesen und gruppiert. Zugeordnete uncommittete Aenderungen
// stehen je Stack in `assignedChanges`, nicht zugeordnete in `uncommittedChanges`. Committete
// Dateien stehen nicht in der JSON.

/** Eine uncommittete Aenderung aus `but status --json`. */
export interface ButAenderung {
  p: string;
  art: string;
}

/** Was aus `but status --json` gelesen wird; Kaputtes faellt einzeln weg. */
export interface ButStatus {
  /** `mergeBase.commitId`, nur als Commit-Id; sonst null. */
  basis: string | null;
  /** Je Stack seine Branches von oben nach unten und die ihm zugeordneten Aenderungen. */
  stacks: { id: string; branches: string[]; zugeordnet: ButAenderung[] }[];
  ohne: ButAenderung[];
}

export interface ButDatei {
  p: string;
  s?: BaumStatus;
  plus?: number;
  minus?: number;
  committet: boolean;
  uncommittet: boolean;
  /** Branches anderer Stacks mit derselben Datei: Konfliktrisiko. */
  auch?: string[];
}

export interface ButBranch {
  name: string;
  stack: string;
  /** Wogegen die committeten Dateien gemessen sind; null, wenn sie nicht gemessen werden. */
  basis: string | null;
  dateien: ButDatei[];
}

export interface ButGruppen {
  branches: ButBranch[];
  /** Uncommittete Aenderungen ohne Branch. */
  ohne: ButDatei[];
}

/** `git diff --name-status -z` und `--numstat -z` eines Branches gegen seine Basis. */
export interface ButCommittet {
  namen: string;
  zahlen: string;
}

const COMMIT_ID = /^[0-9a-f]{7,64}$/;

/**
 * Ein Branchname, den der Server git als `refs/heads/NAME` geben darf: die Regeln von
 * git check-ref-format, dazu kein fuehrendes `-`. Alles andere wird nicht gemessen.
 */
export function butBranchGueltig(name: unknown): name is string {
  if (typeof name !== "string" || name === "" || name.length > 255) return false;
  if (name.startsWith("-") || name.startsWith(".") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) return false;
  if (name.includes("..") || name.includes("//") || name.includes("@{") || name.includes("/.")) return false;
  return !/[\x00-\x20\x7f~^:?*[\\]/.test(name);
}

/** `but status --json` gelesen; null, wenn es kein Objekt mit `stacks` als Liste ist. */
export function butStatusAus(json: string | null | undefined): ButStatus | null {
  if (!json) return null;
  let daten: unknown;
  try {
    daten = JSON.parse(json);
  } catch {
    return null;
  }
  if (!istObjekt(daten) || !Array.isArray(daten.stacks)) return null;
  const aenderungen = (liste: unknown): ButAenderung[] =>
    Array.isArray(liste)
      ? liste.flatMap((a) => (istObjekt(a) && typeof a.filePath === "string" && a.filePath !== "" ? [{ p: a.filePath, art: typeof a.changeType === "string" ? a.changeType : "" }] : []))
      : [];
  const stacks = daten.stacks.flatMap((stack, i) => {
    if (!istObjekt(stack)) return [];
    const branches = Array.isArray(stack.branches) ? stack.branches.flatMap((b) => (istObjekt(b) && typeof b.name === "string" ? [b.name] : [])) : [];
    return [{ id: typeof stack.cliId === "string" && stack.cliId ? stack.cliId : String(i), branches, zugeordnet: aenderungen(stack.assignedChanges) }];
  });
  const basis = istObjekt(daten.mergeBase) && typeof daten.mergeBase.commitId === "string" && COMMIT_ID.test(daten.mergeBase.commitId) ? daten.mergeBase.commitId : null;
  return { basis, stacks, ohne: aenderungen(daten.uncommittedChanges) };
}

/** Die Basis des i-ten Branches eines Stacks: der Branch darunter, beim untersten die mergeBase. */
function butBasis(status: ButStatus, branches: string[], i: number): string | null {
  if (!butBranchGueltig(branches[i])) return null;
  if (i + 1 < branches.length) return butBranchGueltig(branches[i + 1]) ? `refs/heads/${branches[i + 1]}` : null;
  return status.basis;
}

/** Welche Branches der Server mit git misst, und wogegen. */
export function butMessungen(status: ButStatus): { name: string; basis: string }[] {
  return status.stacks.flatMap((s) =>
    s.branches.flatMap((name, i) => {
      const basis = butBasis(status, s.branches, i);
      return basis ? [{ name, basis }] : [];
    }),
  );
}

/** `git diff --name-status -z`: Pfad -> Marke; bei R und C gilt der neue Pfad. */
export function nameStatusAus(text: string): Map<string, BaumStatus> {
  const marken = new Map<string, BaumStatus>();
  const felder = text.split("\0");
  for (let i = 0; i < felder.length; i++) {
    const st = felder[i]!;
    if (!/^[A-Z][0-9]*$/.test(st)) continue;
    if (st[0] === "R" || st[0] === "C") {
      const neu = felder[i + 2];
      if (neu) marken.set(neu, st[0] === "R" ? "R" : "A");
      i += 2;
      continue;
    }
    const p = felder[++i];
    if (p) marken.set(p, st[0] === "A" ? "A" : st[0] === "D" ? "D" : st[0] === "U" ? "U" : "M");
  }
  return marken;
}

const AENDERUNGSART: Record<string, BaumStatus> = { added: "A", deleted: "D", removed: "D", renamed: "R" };

/**
 * Je angewendetem Branch seine Dateien: committet aus `committet` (je Branchname), zugeordnet aus
 * dem Stack (beim obersten Branch), mit Status und Zeilen aus dem Dateibaum. Liegt eine Datei auch
 * in einem Branch eines anderen Stacks, nennt `auch` ihn. Nicht Zugeordnetes steht in `ohne`.
 */
export function butGruppen(status: ButStatus, committet: Map<string, ButCommittet>, dateien: BaumDatei[]): ButGruppen {
  const imBaum = new Map(dateien.map((d) => [d.p, d]));
  const offen = (a: ButAenderung): ButDatei => {
    const d = imBaum.get(a.p);
    const datei: ButDatei = { p: a.p, s: d?.s ?? AENDERUNGSART[a.art] ?? "M", committet: false, uncommittet: true };
    if (d?.plus !== undefined) datei.plus = d.plus;
    if (d?.minus !== undefined) datei.minus = d.minus;
    return datei;
  };
  const nachPfad = (a: ButDatei, b: ButDatei) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0);
  const branches: ButBranch[] = [];
  const ohne = [...status.ohne];
  for (const stack of status.stacks) {
    if (stack.branches.length === 0) ohne.push(...stack.zugeordnet);
    stack.branches.forEach((name, i) => {
      const je = new Map<string, ButDatei>();
      const c = committet.get(name);
      if (c) {
        const zahlen = numstatAus(c.zahlen);
        for (const [p, s] of nameStatusAus(c.namen)) je.set(p, { p, s, ...zahlen.get(p), committet: true, uncommittet: false });
      }
      if (i === 0) for (const a of stack.zugeordnet) je.set(a.p, { ...offen(a), committet: je.has(a.p) });
      branches.push({ name, stack: stack.id, basis: butBasis(status, stack.branches, i), dateien: [...je.values()].sort(nachPfad) });
    });
  }
  const wo = new Map<string, ButBranch[]>();
  for (const b of branches) for (const d of b.dateien) wo.set(d.p, [...(wo.get(d.p) ?? []), b]);
  for (const b of branches) {
    for (const d of b.dateien) {
      const auch = wo.get(d.p)!.filter((x) => x.stack !== b.stack).map((x) => x.name);
      if (auch.length) d.auch = auch;
    }
  }
  return {
    branches,
    ohne: ohne.map((a) => {
      const d = offen(a);
      const auch = (wo.get(a.p) ?? []).map((x) => x.name);
      if (auch.length) d.auch = auch;
      return d;
    }).sort(nachPfad),
  };
}

// --- Entscheidung im Text -----------------------------------------------------------------

export type Textergebnis = { art: "ok"; text: string } | { art: "unbekannt" } | { art: "fehler"; grund: string };

const RESERVIERT = /^(?:y|n|yes|no|on|off|true|false|null)$/i;
const SCHLICHT = /^\p{L}[\p{L}\p{N} _.,()/+-]*$/u;

/** Ein Wert als YAML-Skalar: schlicht, wenn jeder Leser ihn als denselben Text liest, sonst als JSON-Zeichenkette. */
export function yamlWert(wert: string): string {
  if (SCHLICHT.test(wert) && !wert.endsWith(" ") && !RESERVIERT.test(wert)) return wert;
  return JSON.stringify(wert).replace(/[\u007f-\u009f\u2028\u2029\ufeff]/g, (z) => `\\u${z.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Hoechstens so viele Zeichen (Codepoints) hat eine eigene Antwort. */
export const EIGEN_HOECHSTENS = 500;

const U = (n: number) => `U+${n.toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * Prueft eine eigene Antwort (Freitext statt Option): nach trim 1 bis 500 Codepoints, eine Zeile,
 * ohne Steuerzeichen (C0, DEL, C1), ohne Bidi-Override und ohne einzelne Surrogate. Der Text ist,
 * was in die Datei kommt.
 */
export function pruefeEigeneAntwort(roh: string): { art: "ok"; text: string } | { art: "ungueltig"; grund: string } {
  const text = roh.trim();
  const zeichen = [...text];
  if (zeichen.length === 0) return { art: "ungueltig", grund: "eigene Antwort ist leer" };
  if (zeichen.length > EIGEN_HOECHSTENS) return { art: "ungueltig", grund: `eigene Antwort hat ${zeichen.length} Zeichen, erlaubt sind hoechstens ${EIGEN_HOECHSTENS}` };
  const umbruch = /[\n\r\u0085\u2028\u2029]/.exec(text);
  if (umbruch) return { art: "ungueltig", grund: `eigene Antwort enthaelt einen Zeilenumbruch (${U(umbruch[0].charCodeAt(0))}), erlaubt ist eine Zeile` };
  const steuer = /\p{Cc}/u.exec(text);
  if (steuer) return { art: "ungueltig", grund: `eigene Antwort enthaelt ein Steuerzeichen (${U(steuer[0].charCodeAt(0))})` };
  const bidi = /[\u202A-\u202E\u2066-\u2069]/.exec(text);
  if (bidi) return { art: "ungueltig", grund: `eigene Antwort enthaelt ein Bidi-Steuerzeichen (${U(bidi[0].charCodeAt(0))})` };
  if (/\p{Cs}/u.test(text)) return { art: "ungueltig", grund: "eigene Antwort ist kein gueltiges Unicode (einzelnes Surrogat)" };
  return { art: "ok", text };
}

const einzug = (zeile: string) => zeile.length - zeile.trimStart().length;
const leerOderKommentar = (zeile: string) => zeile.trim() === "" || zeile.trimStart().startsWith("#");

/** Wo der Wert hinter `schluessel:` steht: Anfang und Ende in der Zeile, ohne Leerraum und Kommentar dahinter. */
function wertBereich(zeile: string, ab: number): { von: number; bis: number } | null {
  let von = ab;
  while (zeile[von] === " ") von++;
  const z = zeile[von];
  if (z === '"' || z === "'") {
    let i = von + 1;
    while (i < zeile.length) {
      if (z === '"' && zeile[i] === "\\") i += 2;
      else if (zeile[i] === z && z === "'" && zeile[i + 1] === "'") i += 2;
      else if (zeile[i] === z) return { von, bis: i + 1 };
      else i++;
    }
    return null;
  }
  if (z === "|" || z === ">" || z === "[" || z === "{" || z === "&" || z === "*" || z === "!") return null;
  const kommentar = zeile.slice(von).search(/(^|\s)#/);
  const ende = kommentar < 0 ? zeile.length : von + kommentar;
  let bis = ende;
  while (bis > von && zeile[bis - 1] === " ") bis--;
  return { von, bis };
}

/** Der Text eines Skalars in einer Zeile, Anfuehrungszeichen abgenommen. */
function skalarText(zeile: string, ab: number): string | null {
  const b = wertBereich(zeile, ab);
  if (!b) return null;
  const roh = zeile.slice(b.von, b.bis);
  if (roh.startsWith('"')) {
    try {
      return JSON.parse(roh) as string;
    } catch {
      return null;
    }
  }
  if (roh.startsWith("'")) return roh.slice(1, -1).replaceAll("''", "'");
  return roh;
}

interface Schluessel {
  zeile: number;
  /** Spalte hinter dem Doppelpunkt. */
  wertAb: number;
}

/** Die Schluessel einer Frage im Bereich [von, bis) auf der Einrueckung `spalte`. */
function schluesselIn(zeilen: string[], von: number, bis: number, spalte: number, erste: string): Map<string, Schluessel> {
  const gefunden = new Map<string, Schluessel>();
  const nimm = (name: string, zeile: number, wertAb: number) => {
    if (!gefunden.has(name)) gefunden.set(name, { zeile, wertAb });
  };
  const m = /^([A-Za-z_][A-Za-z0-9_]*):(?=\s|$)/.exec(erste);
  if (m) nimm(m[1]!, von, spalte + m[0].length);
  for (let i = von + 1; i < bis; i++) {
    const zeile = zeilen[i]!;
    if (leerOderKommentar(zeile) || einzug(zeile) !== spalte) continue;
    const k = /^([A-Za-z_][A-Za-z0-9_]*):(?=\s|$)/.exec(zeile.slice(spalte));
    if (k) nimm(k[1]!, i, spalte + k[0].length);
  }
  return gefunden;
}

/**
 * Setzt `entscheidung` der Frage `frage` als Aenderung genau einer Zeile: Kommentare, Reihenfolge
 * und jedes andere Byte bleiben. Fehlt der Schluessel, kommt eine Zeile ans Ende des Frageblocks.
 * Was sich nicht sicher als Blockliste lesen laesst, ist ein Fehler, keine Vermutung.
 */
export function setzeEntscheidungImText(text: string, frage: string, wahl: string): Textergebnis {
  if (text.includes("\r")) return { art: "fehler", grund: "Zeilenende CRLF: die Datei wird nicht zeilenweise geaendert, bitte LF verwenden" };
  const zeilen = text.split("\n");
  const kopf = zeilen.findIndex((z) => /^fragen:\s*(#.*)?$/.test(z));
  if (kopf < 0) {
    if (zeilen.some((z) => /^fragen:/.test(z))) return { art: "fehler", grund: "fragen ist keine Blockliste" };
    return { art: "unbekannt" };
  }
  let ende = kopf + 1;
  while (ende < zeilen.length && (leerOderKommentar(zeilen[ende]!) || einzug(zeilen[ende]!) > 0)) ende++;

  let listenSpalte = -1;
  const anfaenge: number[] = [];
  for (let i = kopf + 1; i < ende; i++) {
    const zeile = zeilen[i]!;
    if (leerOderKommentar(zeile)) continue;
    if (listenSpalte < 0) listenSpalte = einzug(zeile);
    if (einzug(zeile) === listenSpalte && /^-(\s|$)/.test(zeile.slice(listenSpalte))) anfaenge.push(i);
  }

  let flow = false;
  for (const [n, anfang] of anfaenge.entries()) {
    let blockEnde = n + 1 < anfaenge.length ? anfaenge[n + 1]! : ende;
    const strich = zeilen[anfang]!.slice(listenSpalte + 1);
    const nachStrich = strich.length - strich.trimStart().length;
    if (/^[{[]/.test(strich.trimStart())) {
      flow = true;
      continue;
    }
    let spalte: number;
    let erste: string;
    if (strich.trim() === "" || strich.trimStart().startsWith("#")) {
      const naechste = zeilen.slice(anfang + 1, blockEnde).findIndex((z) => !leerOderKommentar(z));
      if (naechste < 0) continue;
      spalte = einzug(zeilen[anfang + 1 + naechste]!);
      erste = "";
    } else {
      spalte = listenSpalte + 1 + nachStrich;
      erste = zeilen[anfang]!.slice(spalte);
    }
    const schluessel = schluesselIn(zeilen, anfang, blockEnde, spalte, erste);
    const id = schluessel.get("id");
    if (!id || skalarText(zeilen[id.zeile]!, id.wertAb) !== frage) continue;

    const wert = yamlWert(wahl);
    const alt = schluessel.get("entscheidung");
    if (alt) {
      const zeile = zeilen[alt.zeile]!;
      const b = wertBereich(zeile, alt.wertAb);
      const folgt = zeilen[alt.zeile + 1];
      if (!b || (folgt !== undefined && alt.zeile + 1 < blockEnde && !leerOderKommentar(folgt) && einzug(folgt) > spalte)) {
        return { art: "fehler", grund: `entscheidung von ${frage} ist kein einzeiliger Wert` };
      }
      const trenner = b.von === alt.wertAb ? " " : "";
      const rest = zeile.slice(b.bis);
      // Stand vor dem Kommentar kein Wert, fehlt sonst das Leerzeichen: `Bei Bedarf# offen` laese YAML als einen Wert.
      const abstand = rest.startsWith("#") ? " " : "";
      zeilen[alt.zeile] = zeile.slice(0, b.von) + trenner + wert + abstand + rest;
      return { art: "ok", text: zeilen.join("\n") };
    }
    while (blockEnde > anfang + 1 && leerOderKommentar(zeilen[blockEnde - 1]!)) blockEnde--;
    zeilen.splice(blockEnde, 0, `${" ".repeat(spalte)}entscheidung: ${wert}`);
    return { art: "ok", text: zeilen.join("\n") };
  }
  if (flow) return { art: "fehler", grund: "eine Frage steht in Flow-Form ({...}); nur Blockform ist zeilenweise aenderbar" };
  return { art: "unbekannt" };
}

// --- Fragen-Kanal: Fragen anhaengen (Vertrag v3, A1) ------------------------------------------

/** Eine Frage, wie `live-plan frage` sie auf stdin bekommt (Form von AskUserQuestion). */
export interface NeueFrage {
  frage: string;
  kopf?: string;
  grund?: string;
  multi?: boolean;
  optionen: { label: string; beschreibung?: string; empfohlen?: boolean }[];
}

/** Prueft die Eingabe von `live-plan frage`: `{ fragen: [...], quelle? }`. */
export function fragenEingabe(roh: unknown): { art: "ok"; fragen: NeueFrage[] } | { art: "fehler"; grund: string } {
  const fehler = (grund: string) => ({ art: "fehler" as const, grund });
  const textOderNichts = (wert: unknown) => wert === undefined || typeof wert === "string";
  if (!istObjekt(roh)) return fehler("Eingabe ist kein JSON-Objekt");
  if (!textOderNichts(roh.quelle)) return fehler("quelle ist kein Text");
  if (!Array.isArray(roh.fragen) || roh.fragen.length === 0) return fehler("fragen fehlt oder ist leer");
  const fragen: NeueFrage[] = [];
  for (const [i, f] of roh.fragen.entries()) {
    const pfad = `fragen[${i}]`;
    if (!istObjekt(f)) return fehler(`${pfad} ist kein Objekt`);
    if (typeof f.frage !== "string" || f.frage.trim() === "") return fehler(`${pfad}.frage fehlt`);
    if (!textOderNichts(f.kopf)) return fehler(`${pfad}.kopf ist kein Text`);
    if (!textOderNichts(f.grund)) return fehler(`${pfad}.grund ist kein Text`);
    if (f.multi !== undefined && typeof f.multi !== "boolean") return fehler(`${pfad}.multi ist kein Wahrheitswert`);
    if (!Array.isArray(f.optionen) || f.optionen.length === 0) return fehler(`${pfad}.optionen fehlt oder ist leer`);
    const labels = new Set<string>();
    const optionen: NeueFrage["optionen"] = [];
    for (const [j, o] of f.optionen.entries()) {
      const opfad = `${pfad}.optionen[${j}]`;
      if (!istObjekt(o)) return fehler(`${opfad} ist kein Objekt`);
      if (typeof o.label !== "string" || o.label.trim() === "") return fehler(`${opfad}.label fehlt`);
      if (labels.has(o.label)) return fehler(`${opfad}.label ${JSON.stringify(o.label)} doppelt`);
      if (!textOderNichts(o.beschreibung)) return fehler(`${opfad}.beschreibung ist kein Text`);
      if (o.empfohlen !== undefined && typeof o.empfohlen !== "boolean") return fehler(`${opfad}.empfohlen ist kein Wahrheitswert`);
      labels.add(o.label);
      optionen.push({ label: o.label, ...(o.beschreibung ? { beschreibung: o.beschreibung } : {}), ...(o.empfohlen ? { empfohlen: true } : {}) });
    }
    fragen.push({
      frage: f.frage,
      ...(f.kopf ? { kopf: f.kopf as string } : {}),
      ...(f.grund ? { grund: f.grund as string } : {}),
      ...(f.multi ? { multi: true } : {}),
      optionen,
    });
  }
  return { art: "ok", fragen };
}

/** Die naechsten `n` freien Ids `F<n>` hinter der hoechsten F-Id; belegt zaehlt jede Id im Dokument. */
export function naechsteFrageIds(roh: unknown, n: number): string[] {
  const belegt = new Set<string>();
  if (istObjekt(roh)) {
    for (const art of ["fragen", "schritte", "anforderungen", "entscheidungen", "bahnen", "wellen"]) {
      const liste = roh[art];
      if (!Array.isArray(liste)) continue;
      for (const e of liste) if (istObjekt(e) && e.id !== undefined && e.id !== null) belegt.add(String(e.id));
    }
  }
  let hoechste = 0;
  for (const id of belegt) {
    const m = /^F(\d+)$/.exec(id);
    if (m) hoechste = Math.max(hoechste, Number(m[1]));
  }
  const ids: string[] = [];
  for (let k = hoechste + 1; ids.length < n; k++) if (!belegt.has(`F${k}`)) ids.push(`F${k}`);
  return ids;
}

/** Die Zeilen einer Frage in Blockform, Listenstrich auf Spalte `spalte`; jeder Text per yamlWert. */
function frageZeilen(id: string, f: NeueFrage, spalte: number): string[] {
  const e = " ".repeat(spalte);
  const zeilen = [`${e}- id: ${id}`, `${e}  frage: ${yamlWert(f.frage)}`, `${e}  optionen:`];
  for (const o of f.optionen) {
    zeilen.push(`${e}    - label: ${yamlWert(o.label)}`);
    if (o.beschreibung) zeilen.push(`${e}      beispiel: ${yamlWert(o.beschreibung)}`);
    if (o.empfohlen) zeilen.push(`${e}      empfohlen: true`);
  }
  zeilen.push(`${e}  entscheidung: ""`);
  const grund = f.grund || f.kopf;
  if (grund) zeilen.push(`${e}  grund: ${yamlWert(grund)}`);
  return zeilen;
}

/**
 * Haengt Fragen hinten an die Blockliste `fragen:` an; jedes andere Byte bleibt. `fragen: []` wird
 * zur Blockliste, ohne Schluessel kommt er ans Ende. Eine Flow-Liste mit Inhalt ist ein Fehler.
 */
export function fuegeFragenAnImText(text: string, neu: { id: string; frage: NeueFrage }[]): Textergebnis {
  if (text.includes("\r")) return { art: "fehler", grund: "Zeilenende CRLF: die Datei wird nicht zeilenweise geaendert, bitte LF verwenden" };
  const zeilen = text.split("\n");
  const kopf = zeilen.findIndex((z) => /^fragen:\s*(#.*)?$/.test(z));
  if (kopf >= 0) {
    let ende = kopf + 1;
    while (ende < zeilen.length && (leerOderKommentar(zeilen[ende]!) || einzug(zeilen[ende]!) > 0)) ende++;
    const erste = zeilen.slice(kopf + 1, ende).find((z) => !leerOderKommentar(z));
    const spalte = erste === undefined ? 2 : einzug(erste);
    if (erste !== undefined && !/^-(\s|$)/.test(erste.slice(spalte))) return { art: "fehler", grund: "fragen ist keine Blockliste" };
    let an = ende;
    while (an > kopf + 1 && leerOderKommentar(zeilen[an - 1]!)) an--;
    zeilen.splice(an, 0, ...neu.flatMap((n) => frageZeilen(n.id, n.frage, spalte)));
    return { art: "ok", text: zeilen.join("\n") };
  }
  const leer = zeilen.findIndex((z) => /^fragen:\s*\[\s*\]\s*(#.*)?$/.test(z));
  if (leer >= 0) {
    const kommentar = /#.*$/.exec(zeilen[leer]!.replace(/^fragen:\s*\[\s*\]/, ""));
    zeilen.splice(leer, 1, `fragen:${kommentar ? ` ${kommentar[0]}` : ""}`, ...neu.flatMap((n) => frageZeilen(n.id, n.frage, 2)));
    return { art: "ok", text: zeilen.join("\n") };
  }
  if (zeilen.some((z) => /^fragen:/.test(z))) return { art: "fehler", grund: "fragen ist keine Blockliste" };
  const rumpf = text === "" || text.endsWith("\n") ? text : `${text}\n`;
  return { art: "ok", text: `${rumpf}${["fragen:", ...neu.flatMap((n) => frageZeilen(n.id, n.frage, 2))].join("\n")}\n` };
}

/**
 * Prueft das Ergebnis gegen: jede neue Frage steht so im Plan, wie sie gemeint war, und es gibt
 * keinen Schemafehler, den es vorher nicht gab. Null heisst gueltig, sonst der Grund.
 */
export function pruefeAngehaengt(vorher: unknown, nachher: unknown, neu: { id: string; frage: NeueFrage }[]): string | null {
  const alt = new Set(pruefePlan(vorher).fehler.map((f) => `${f.pfad}: ${f.grund}`));
  const geprueft = pruefePlan(nachher);
  const dazu = geprueft.fehler.map((f) => `${f.pfad}: ${f.grund}`).filter((f) => !alt.has(f));
  if (dazu.length > 0) return `Schemafehler nach dem Anhaengen: ${dazu.join("; ")}`;
  for (const { id, frage } of neu) {
    const f = geprueft.plan.fragen.find((x) => x.id === id);
    const soll: Frage = {
      id,
      frage: frage.frage,
      optionen: frage.optionen.map((o) => ({ label: o.label, ...(o.empfohlen ? { empfohlen: true } : {}), ...(o.beschreibung ? { beispiel: o.beschreibung } : {}) })),
      blockiert: [],
      entscheidung: "",
      ...(frage.grund || frage.kopf ? { grund: frage.grund || frage.kopf } : {}),
    };
    if (!f || !gleich(f, soll)) return `${id} liesse sich nicht unveraendert zuruecklesen`;
  }
  return null;
}

// --- Kurzer Stand fuer den System-Prompt (Vertrag v3, A2) -------------------------------------

export const KURZ_HOECHSTENS = 1500;

const einzeilig = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Der Stand der Sitzung als Klartext, hoechstens KURZ_HOECHSTENS Zeichen: Titel, Thema, Blatt
 * jetzt, offene Fragen samt Optionen (empfohlene markiert), laufende Schritte, die uebrigen
 * Blaetter in Offen mit Gate. Wichtiges zuerst, gekuerzt wird hinten.
 */
export function kurzStand(plan: Plan): string {
  const z: string[] = [];
  if (plan.titel) z.push(`Titel: ${kuerze(einzeilig(plan.titel), 160)}`);
  if (plan.stand?.thema) z.push(`Thema: ${kuerze(einzeilig(plan.stand.thema), 160)}`);
  const offen = plan.stand?.offen ?? [];
  const blattJetzt = offen.find((b) => b.gate === "jetzt");
  if (blattJetzt) z.push(`Jetzt: ${kuerze(einzeilig(blattJetzt.text), 200)}${blattJetzt.befehl ? ` (${kuerze(einzeilig(blattJetzt.befehl), 120)})` : ""}`);
  const fragen = plan.fragen.filter((f) => !f.entscheidung);
  if (fragen.length > 0) {
    z.push("Offene Fragen:");
    for (const f of fragen) {
      const optionen = f.optionen.map((o) => `${kuerze(einzeilig(o.label), 60)}${o.empfohlen ? " (empfohlen)" : ""}`).join(" | ");
      z.push(`- ${f.id} ${kuerze(einzeilig(f.frage), 200)}${optionen ? ` Optionen: ${optionen}` : ""}`);
    }
  }
  const laufend = plan.schritte.filter((s) => s.status === "laeuft");
  if (laufend.length > 0) {
    z.push("Laufende Schritte:");
    for (const s of laufend) z.push(`- ${s.id} ${kuerze(einzeilig(s.titel), 120)}${s.agent ? ` (${kuerze(einzeilig(s.agent), 40)})` : ""}`);
  }
  const uebrige = offen.filter((b) => b !== blattJetzt);
  if (uebrige.length > 0) {
    z.push("Offen:");
    for (const b of uebrige) z.push(`- [${b.gate}] ${kuerze(einzeilig(b.text), 160)}`);
  }
  const text = z.join("\n");
  return text.length <= KURZ_HOECHSTENS ? text : kuerze(text, KURZ_HOECHSTENS);
}

// --- Abo-Zeile: usage of several Claude subscription accounts from tollgate GET /status (#140) ---
//
// Pure: the server fetches /status and passes the parsed JSON with its clock. An account with a
// broken or missing field is dropped; nothing here throws.

const FUENF_H_MS = 5 * 3_600_000;
/** Below this elapsed share of the 5 h window a forecast says nothing yet. */
export const ABO_ZU_FRUEH = 0.05;
/** From this usage on a window is not usable any more (the account is `voll`), and forecasts aim here. */
export const ABO_VOLL = 0.98;
/** From this 7 d usage on, a free reserve account counts as `knapp`. */
export const ABO_KNAPP = 0.9;
/** A reserve account observed longer ago than this is marked `veraltet`. */
export const ABO_VERALTET_MS = 6 * 3_600_000;
/** The active account observed longer ago than this marks the whole line `alt`. */
export const ABO_ALT_MS = 10 * 60_000;

export type AboPrognose = "voll" | "voll-um" | "reicht" | "zu-frueh";
export type AboAmpel = "gruen" | "gelb" | "rot";

export interface AboFuenf {
  /** utilization / 100; 0 once the window has reset. */
  nutzung: number;
  /** End of the running window (ISO); null when unknown or already past. */
  reset: string | null;
  /** Elapsed share of the running window, 0..1; null without one. */
  zeitAnteil: number | null;
  /** nutzung - zeitAnteil: above 0 is faster than even. */
  tempo: number | null;
  prognose: AboPrognose | null;
  /** With `voll-um`: when the linear rate reaches 100 % (ISO). */
  vollUm: string | null;
}

export interface AboAktiv {
  name: string;
  kurz: string;
  fuenf: AboFuenf;
  sieben: { nutzung: number; reset: string | null };
  ampel: AboAmpel;
  beobachtet: string | null;
}

export interface AboReserve {
  name: string;
  kurz: string;
  /** Usage now, 0..1; a window past its reset counts 0. */
  fuenf: number;
  sieben: number;
  /** Only in `voll`: when every blocking window has reset (ISO); null when unknown or a new login is needed. */
  freiAb: string | null;
  relogin: boolean;
  veraltet: boolean;
  beobachtet: string | null;
}

export interface AboLage {
  aktiv: AboAktiv | null;
  reserve: { frei: AboReserve[]; knapp: AboReserve[]; voll: AboReserve[] };
  /** The free account to switch to, when the active one is full or runs full before its reset. */
  wechsel: AboReserve | null;
  /** The full reserve account usable again first; `vorReset` when that is before the active 5 h reset. */
  naechster: (AboReserve & { vorReset: boolean }) | null;
  alt: boolean;
}

interface AboFenster {
  nutzung: number;
  resetMs: number | null;
}

interface AboKonto {
  name: string;
  fuenf: AboFenster;
  sieben: AboFenster;
  relogin: boolean;
  beobachtetMs: number | null;
}

const isoVon = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
const zeitVon = (wert: unknown): number | null => {
  const ms = typeof wert === "string" ? Date.parse(wert) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
};

/** A window needs a finite utilization; resets_at may be null (no running window), but not garbage. */
function aboFenster(roh: unknown): AboFenster | null {
  if (!istObjekt(roh) || typeof roh.utilization !== "number" || !Number.isFinite(roh.utilization) || roh.utilization < 0) return null;
  const resetMs = zeitVon(roh.resets_at);
  if (resetMs === null && roh.resets_at !== null && roh.resets_at !== undefined) return null;
  return { nutzung: roh.utilization / 100, resetMs };
}

function aboKonto(roh: unknown): AboKonto | null {
  if (!istObjekt(roh) || typeof roh.name !== "string" || !roh.name.trim()) return null;
  const fuenf = aboFenster(roh.five_hour);
  const sieben = aboFenster(roh.seven_day);
  if (!fuenf || !sieben) return null;
  return { name: roh.name.trim(), fuenf, sieben, relogin: roh.relogin_required === true || roh.auth === "relogin", beobachtetMs: zeitVon(roh.observed_at) };
}

/** Usage now: a window whose reset has passed is a new one at 0 %. */
const nutzungJetzt = (f: AboFenster, jetzt: number) => (f.resetMs !== null && f.resetMs <= jetzt ? 0 : f.nutzung);

/** The part before `@`, at most 16 characters. */
export function aboKurz(name: string): string {
  const vor = name.split("@")[0] || name;
  return vor.length > 16 ? `${vor.slice(0, 15)}…` : vor;
}

function aboFuenf(f: AboFenster, jetzt: number): AboFuenf {
  if (f.resetMs === null || f.resetMs <= jetzt) {
    return { nutzung: nutzungJetzt(f, jetzt), reset: null, zeitAnteil: null, tempo: null, prognose: null, vollUm: null };
  }
  const beginn = f.resetMs - FUENF_H_MS;
  const zeitAnteil = Math.min(1, Math.max(0, (jetzt - beginn) / FUENF_H_MS));
  let prognose: AboPrognose = "reicht";
  let vollUm: string | null = null;
  if (f.nutzung >= ABO_VOLL) prognose = "voll";
  else if (zeitAnteil < ABO_ZU_FRUEH) prognose = "zu-frueh";
  else {
    // Linear rate: at the reset the window would stand at rate * 100 %.
    const rate = f.nutzung / zeitAnteil;
    const um = beginn + (FUENF_H_MS * ABO_VOLL) / rate;
    if (rate > ABO_VOLL && um < f.resetMs) {
      prognose = "voll-um";
      vollUm = isoVon(um);
    }
  }
  return { nutzung: f.nutzung, reset: isoVon(f.resetMs), zeitAnteil, tempo: f.nutzung - zeitAnteil, prognose, vollUm };
}

function aboAktiv(k: AboKonto, jetzt: number): AboAktiv {
  const fuenf = aboFuenf(k.fuenf, jetzt);
  const sieben = nutzungJetzt(k.sieben, jetzt);
  const rot = fuenf.nutzung >= ABO_VOLL || sieben >= ABO_VOLL || fuenf.prognose === "voll-um";
  return {
    name: k.name,
    kurz: aboKurz(k.name),
    fuenf,
    sieben: { nutzung: sieben, reset: k.sieben.resetMs !== null && k.sieben.resetMs > jetzt ? isoVon(k.sieben.resetMs) : null },
    ampel: rot ? "rot" : (fuenf.tempo ?? 0) > 0.1 ? "gelb" : "gruen",
    beobachtet: isoVon(k.beobachtetMs),
  };
}

function aboReserve(k: AboKonto, jetzt: number): { gruppe: keyof AboLage["reserve"]; konto: AboReserve } {
  const fuenf = nutzungJetzt(k.fuenf, jetzt);
  const sieben = nutzungJetzt(k.sieben, jetzt);
  const sperren = [k.fuenf, k.sieben].filter((f) => nutzungJetzt(f, jetzt) >= ABO_VOLL);
  const gruppe = k.relogin || sperren.length > 0 ? "voll" : sieben >= ABO_KNAPP ? "knapp" : "frei";
  // Usable again only once every blocking window has reset.
  const resets = sperren.map((f) => f.resetMs);
  const freiAb = gruppe === "voll" && !k.relogin && resets.every((ms) => ms !== null) ? isoVon(Math.max(...(resets as number[]))) : null;
  return {
    gruppe,
    konto: {
      name: k.name,
      kurz: aboKurz(k.name),
      fuenf,
      sieben,
      freiAb,
      relogin: k.relogin,
      veraltet: k.beobachtetMs !== null && jetzt - k.beobachtetMs > ABO_VERALTET_MS,
      beobachtet: isoVon(k.beobachtetMs),
    },
  };
}

/** The Abo-Zeile from tollgate's /status at `jetzt`: active account with forecast, reserve in three groups. */
export function aboLage(status: unknown, jetzt: number): AboLage {
  const reserve: AboLage["reserve"] = { frei: [], knapp: [], voll: [] };
  if (!istObjekt(status)) return { aktiv: null, reserve, wechsel: null, naechster: null, alt: false };
  const a = aboKonto(status.active);
  const aktiv = a ? aboAktiv(a, jetzt) : null;
  for (const roh of Array.isArray(status.inactive) ? status.inactive : []) {
    const k = aboKonto(roh);
    if (!k) continue;
    const { gruppe, konto } = aboReserve(k, jetzt);
    reserve[gruppe].push(konto);
  }
  const nachSieben = (x: AboReserve, y: AboReserve) => x.sieben - y.sieben || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0);
  reserve.frei.sort(nachSieben);
  reserve.knapp.sort(nachSieben);
  reserve.voll.sort((x, y) => (x.freiAb ?? "~").localeCompare(y.freiAb ?? "~"));
  const erster = reserve.voll.find((k) => k.freiAb !== null);
  const knapp = aktiv && (aktiv.fuenf.nutzung >= ABO_VOLL || aktiv.sieben.nutzung >= ABO_VOLL || aktiv.fuenf.prognose === "voll-um");
  return {
    aktiv,
    reserve,
    wechsel: knapp ? (reserve.frei[0] ?? null) : null,
    naechster: erster ? { ...erster, vorReset: aktiv?.fuenf.reset != null && erster.freiAb! < aktiv.fuenf.reset } : null,
    alt: a !== null && a.beobachtetMs !== null && jetzt - a.beobachtetMs > ABO_ALT_MS,
  };
}

/** `${basis}/status` for an http(s) base without credentials, query or fragment; else null. */
export function aboStatusUrl(basis: string): string | null {
  let url: URL;
  try {
    url = new URL(basis);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) return null;
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/status`;
  return url.href;
}

// --- Handout (#328) -------------------------------------------------------------------------
//
// Die reinen Teile von `live-plan handout`: wie die Dateien heissen und welcher Chrome gerufen wird.
// Das Startskript (bun) steuert Chrome selbst; hier steht nur, was ohne Chrome pruefbar ist.

/** Wo Chrome unter macOS liegt. */
export const CHROME_MAC = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Die Namen, unter denen Chrome im PATH liegen kann, in dieser Reihenfolge. */
export const CHROME_IM_PFAD = ["google-chrome", "chromium"] as const;

/** `JJJJ-MM-TT-HHMM-TITEL` in Ortszeit; der Titel klein, Umlaute ausgeschrieben, nur a-z, 0-9 und Bindestrich. */
export function handoutName(titel: string, zeit: Date): string {
  const zwei = (n: number) => String(n).padStart(2, "0");
  const stempel = `${zeit.getFullYear()}-${zwei(zeit.getMonth() + 1)}-${zwei(zeit.getDate())}-${zwei(zeit.getHours())}${zwei(zeit.getMinutes())}`;
  const slug = titel
    .normalize("NFC")
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${stempel}-${slug || "sitzung"}`;
}

export interface ChromeEingabe {
  env: Record<string, string | undefined>;
  platform: string;
  /** Gibt es diese Datei? */
  vorhanden: (pfad: string) => boolean;
  /** Der volle Pfad eines Programms im PATH, sonst null. */
  imPfad: (name: string) => string | null;
}

/**
 * Der Chrome fuer das Handout: `LIVE_PLAN_CHROME` vor allem anderen (und ohne Rueckfall, wenn er ins
 * Leere zeigt), sonst unter macOS die App, sonst `google-chrome` oder `chromium` im PATH; null ohne Treffer.
 */
export function chromePfad(e: ChromeEingabe): string | null {
  const vorgabe = e.env.LIVE_PLAN_CHROME?.trim();
  if (vorgabe) return e.vorhanden(vorgabe) ? vorgabe : null;
  if (e.platform === "darwin" && e.vorhanden(CHROME_MAC)) return CHROME_MAC;
  for (const name of CHROME_IM_PFAD) {
    const pfad = e.imPfad(name);
    if (pfad) return pfad;
  }
  return null;
}
