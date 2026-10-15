// live-plan (#257): der Server des Skills, nur Bun und node:-Module, ohne Paket und ohne Build.
//
// Liest WURZEL/REPO/.live-plan/SLUG.yaml, fuehrt daneben Verlauf (SLUG.verlauf.jsonl) und den
// zuletzt gesehenen Stand (SLUG.stand.json), schreibt nur fragen[].entscheidung und (#27)
// fragen[].zurueckgezogen, dazu den Gelesen-Zustand der Ansagen (#28), und liefert die Ansicht aus ansicht/. Dazu liest er das Register der
// Claude-Sitzungen (LIVE_PLAN_CACHE/sitzungen, S5) und reicht es als `live` mit. Die Regeln stehen rein in logik.ts. Ohne Anfrage und ohne offene
// Verbindung beendet er sich nach LIVE_PLAN_LEERLAUF_MS (Vorgabe 60 Minuten).

import { execFile } from "node:child_process";
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, watch, writeFileSync, writeSync, type FSWatcher } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  aboLage,
  aboStatusUrl,
  abstandAus,
  anforderungsStand,
  baumDateien,
  belegPfad,
  butGruppen,
  butMessungen,
  butStatusAus,
  type ButCommittet,
  type ButGruppen,
  bildArtVon,
  BILD_HOECHSTENS,
  diffAntwort,
  eigenerPlanPfad,
  diffArtVon,
  diffPfadGueltig,
  DIFF_LESEN_HOECHSTENS,
  geheimerName,
  istLoopback,
  type BaumDatei,
  type DiffAntwort,
  gitStand,
  gueltigerName,
  jetzt,
  neueEntscheidungen,
  neuesteId,
  offeneFragenZahl,
  ORDNER,
  prozessLayout,
  pruefeEigeneAntwort,
  pruefePlan,
  raster,
  registerAus,
  registerBeruehrt,
  registerRepo,
  setzeEntscheidungImText,
  spurbild,
  ueberblick,
  vergleichbar,
  vergleiche,
  dokuOhneVerlauf,
  warteText,
  wurzeln,
  zeilenZahl,
  zeiten,
  zieheFrageZurueckImText,
  zurueckGrund,
  WORKSPACE,
  type Baum,
  type Fehler,
  type GitStand,
  type Plan,
  type Register,
  type Verlaufseintrag,
} from "./logik.ts";
import { ansagenDatei, einstellungenAus, einstellungenDatei, einstellungenMit, einstellungenYaml, gelesenDatei, KENNUNG, leseAnsagen, leseGelesen, markiereGelesen, type Einstellungen } from "./ansagen.ts";
import { hostSicht } from "./host.ts";
import { verlauf } from "./verlauf.ts";
import { aufgabeDetail, gueltigeAufgabenId, istFirstmateHome, prVorrat, type FirstmateSicht, type GhLauf } from "./firstmate.ts";

const WURZELN = wurzeln(process.env);
const PORT = Number.parseInt(process.env.LIVE_PLAN_PORT ?? "", 10) || 4410;
const LEERLAUF_MS = Number.parseInt(process.env.LIVE_PLAN_LEERLAUF_MS ?? "", 10) || 60 * 60_000;
const ANSICHT = path.join(import.meta.dir, "ansicht");
const GIT_VORHALTEN_MS = 30_000;
const GIT_ABBRUCH_MS = 5_000;
const WARTE_HOECHSTENS_MS = 10 * 60_000;
const TAKT_MS = 15_000;
const KOERPER_HOECHSTENS = 16 * 1024;
const CACHE = process.env.LIVE_PLAN_CACHE || path.join(os.homedir(), ".cache", "live-plan");
const PID_DATEI = path.join(CACHE, `server-${PORT}.pid`);
/** Das Register der Claude-Sitzungen (S5), ausserhalb jedes Repos; geschrieben von der Mod live-plan-sitzung. */
const REGISTER = path.join(CACHE, "sitzungen");
/** Die Ansagen aller Sitzungen (ansagen.ts), geschrieben von `live-plan sage` und der Mod; der Server liest nur. */
const ANSAGEN = ansagenDatei(CACHE);
/** Vorlesen und Stimme der Uebersicht (ansagen.ts), eine YAML daneben; geschrieben nur von POST /api/einstellungen. */
const EINSTELLUNGEN = einstellungenDatei(CACHE);
const EINSTELLUNGEN_HOECHSTENS = 2 * 1024;
/** Die als gelesen markierten Ansagen (ansagen.ts, #28); geschrieben vom Knopf gelesen (POST /api/ansagen/gelesen) und beim Kuerzen. */
const GELESEN = gelesenDatei(CACHE);
/** So lange wartet der Server hoechstens auf die Sperre von GELESEN; das Warten haelt ihn an (Atomics.wait). */
const GELESEN_WARTEN_MS = 2_000;

// --- Sicher lesen und schreiben (S1) -----------------------------------------------------------
//
// Im Sitzungsordner folgt der Server keinem Symlink: der Ordner .live-plan muss nach realpath im
// Repo liegen, Sitzung, Verlauf, Stand werden mit O_NOFOLLOW geoeffnet und muessen regulaere
// Dateien sein. Sonst endet die Anfrage mit einem Fehler, statt eine fremde Datei zu lesen oder
// zu beschreiben.

/** Ein Zugriff, den der Server verweigert; die Meldung geht als `fehler` an den Aufrufer. */
class Unsicher extends Error {}

function oeffneSicher(pfad: string, flags: number, modus?: number): number | null {
  try {
    return openSync(pfad, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, modus);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") throw new Unsicher(`${path.basename(pfad)} ist ein Symlink`);
    throw e;
  }
}

function mitDatei<T>(pfad: string, fd: number, fn: (fd: number) => T): T {
  try {
    if (!fstatSync(fd).isFile()) throw new Unsicher(`${path.basename(pfad)} ist keine regulaere Datei`);
    return fn(fd);
  } finally {
    closeSync(fd);
  }
}

/** Inhalt einer regulaeren Datei ohne Symlink, null wenn es sie nicht gibt. */
function liesSicher(pfad: string): string | null {
  const fd = oeffneSicher(pfad, constants.O_RDONLY);
  return fd === null ? null : mitDatei(pfad, fd, (f) => readFileSync(f, "utf8"));
}

function haengeSicher(pfad: string, inhalt: string): void {
  const fd = oeffneSicher(pfad, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o644);
  if (fd === null) throw new Unsicher(`${path.basename(pfad)} laesst sich nicht anlegen`);
  mitDatei(pfad, fd, (f) => writeSync(f, inhalt));
}

/** Der Sitzungsordner eines Repos (absolut), nur wenn er nach realpath genau REPO/.live-plan ist. */
function ordnerIn(repoPfad: string): string | null {
  try {
    const repoEcht = realpathSync(repoPfad);
    const ordner = path.join(repoEcht, ORDNER);
    return realpathSync(ordner) === ordner ? ordner : null;
  } catch {
    return null;
  }
}

/** Der Pfad einer Sitzung, nur wenn der Ordner im Repo liegt und die Datei kein Symlink ist. */
function sitzungDa(repoPfad: string, slug: string): string | null {
  const ordner = gueltigerName(slug) ? ordnerIn(repoPfad) : null;
  if (!ordner) return null;
  const pfad = path.join(ordner, `${slug}.yaml`);
  try {
    return lstatSync(pfad).isFile() ? pfad : null;
  } catch {
    return null;
  }
}

// --- Register (S5) ----------------------------------------------------------------------------
//
// Je Claude-Sitzung eine JSON unter REGISTER, ausserhalb der Repos. Der Ordner muss ein echter
// Ordner sein, jede Datei wird ohne Symlink gelesen; eine halbe oder kaputte gilt als nicht da und
// wird beim naechsten Mal neu gelesen. Ihre `wurzel` macht ein Repo ausserhalb von WURZEL sichtbar.

const registerDatei = (id: string) => path.join(REGISTER, `${id}.json`);

function registerDa(): boolean {
  try {
    return lstatSync(REGISTER).isDirectory();
  } catch {
    return false;
  }
}

/** Die Register-JSON zur Id, oder null. */
function liesRegister(id: string): Register | null {
  if (!gueltigerName(id) || !registerDa()) return null;
  try {
    const inhalt = liesSicher(registerDatei(id));
    return inhalt === null ? null : registerAus(inhalt, id);
  } catch {
    return null;
  }
}

interface Ort {
  repo: string;
  slug: string;
  repoPfad: string | null;
  yaml: string | null;
  live: Register | null;
}

/**
 * Wo eine Sitzung liegt. Nennt das Register zur Id dasselbe REPO, gilt seine Wurzel, auch ausserhalb
 * von WURZEL: so tragen zwei gleichnamige Repos (~/GITHUB/x, ~/GITHUB_DG/x) keine Kollision, denn die
 * Id gehoert genau einer Sitzung. Sonst WURZEL/REPO wie bisher. Null, wenn es weder YAML noch Register gibt.
 */
function ortVon(repo: string, slug: string): Ort | null {
  if (!gueltigerName(repo) || !gueltigerName(slug)) return null;
  const reg = liesRegister(slug);
  const live = reg && registerRepo(reg) === repo ? reg : null;
  // Without a register the first root that holds the session wins.
  const repoPfad = live ? live.wurzel : (WURZELN.map((w) => path.join(w, repo)).find((p) => sitzungDa(p, slug)) ?? path.join(WURZELN[0]!, repo));
  const yaml = repoPfad ? sitzungDa(repoPfad, slug) : null;
  return yaml || live ? { repo, slug, repoPfad, yaml, live } : null;
}

/** Der Pfad eines Belegs der Sitzung, mit denselben Regeln wie belegPfad (S-2). */
function belegVon(ort: Ort, rel: string): string | null {
  return ort.repoPfad ? belegPfad(path.dirname(ort.repoPfad), path.basename(ort.repoPfad), ort.slug, rel) : null;
}

// --- Nur die eigene Seite (B1) ------------------------------------------------------------------
//
// Ohne Anmeldung ist die Grenze der Host: localhost, Loopback, Rechnername samt .local, jede eigene
// Adresse und LIVE_PLAN_HOSTS (durch Komma getrennt). Ein fremder Host-Kopf (DNS-Rebinding) ist
// 403. Unter /api/ muss ein Origin-Kopf, wenn er kommt, denselben Host nennen; "null" (Sandbox,
// Datei) ist fremd.

let hostVorrat: { um: number; namen: Set<string> } | null = null;

function eigeneHosts(): Set<string> {
  if (hostVorrat && Date.now() - hostVorrat.um < 10_000) return hostVorrat.namen;
  const namen = new Set(["localhost", "127.0.0.1", "::1"]);
  const rechner = os.hostname().toLowerCase();
  if (rechner) {
    namen.add(rechner);
    namen.add(`${rechner}.local`);
  }
  for (const liste of Object.values(os.networkInterfaces())) {
    for (const a of liste ?? []) namen.add(a.address.toLowerCase().replace(/%.*$/, ""));
  }
  for (const h of (process.env.LIVE_PLAN_HOSTS ?? "").split(",")) if (h.trim()) namen.add(h.trim().toLowerCase());
  hostVorrat = { um: Date.now(), namen };
  return namen;
}

/** Der Name aus einem Host-Kopf ohne Port, IPv6 ohne Klammern. */
function hostName(kopf: string): string {
  const k = kopf.trim().toLowerCase();
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(k);
  if (v6) return v6[1]!;
  return k.replace(/:\d+$/, "");
}

function herkunftAbgelehnt(req: Request, api: boolean): string | null {
  const host = req.headers.get("host");
  if (!host || !eigeneHosts().has(hostName(host))) return `Host ${JSON.stringify(host ?? "")} ist nicht dieser Rechner`;
  const herkunft = req.headers.get("origin");
  if (!api || herkunft === null) return null;
  try {
    if (new URL(herkunft).host.toLowerCase() === host.trim().toLowerCase()) return null;
  } catch {
    /* "null" und Unlesbares sind fremd */
  }
  return `Herkunft ${JSON.stringify(herkunft)} ist nicht diese Seite`;
}

/** Der Koerper als Text, null wenn er groesser als `grenze` Bytes ist. */
async function liesKoerper(req: Request, grenze: number): Promise<string | null> {
  const angesagt = Number.parseInt(req.headers.get("content-length") ?? "", 10);
  if (angesagt > grenze) return null;
  if (!req.body) return "";
  const leser = req.body.getReader();
  const teile: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { value, done } = await leser.read();
    if (done) break;
    n += value.byteLength;
    if (n > grenze) {
      await leser.cancel().catch(() => undefined);
      return null;
    }
    teile.push(value);
  }
  return Buffer.concat(teile).toString("utf8");
}

// --- Liste ----------------------------------------------------------------------------------

const SITZUNGSDATEI = /^([A-Za-z0-9._-]+)\.yaml$/;

/** Titel und Zahl der offenen Fragen aus einem Lesen; eine kaputte Datei gibt den Slug und keine Zahl, nie einen Fehler. */
function kopfVon(pfad: string, slug: string): { titel: string; offeneFragen: number | null } {
  try {
    const roh = Bun.YAML.parse(liesSicher(pfad) ?? "") as { titel?: unknown } | null;
    return { titel: roh && typeof roh === "object" && typeof roh.titel === "string" ? roh.titel : slug, offeneFragen: offeneFragenZahl(roh) };
  } catch {
    return { titel: slug, offeneFragen: null };
  }
}

const REGISTERDATEI = /^([A-Za-z0-9._-]+)\.json$/;

function listeSitzungen() {
  const eintraege: { repo: string; slug: string; titel: string; offeneFragen: number | null; geaendert: string; pfad: string | null; live: boolean; beendet: boolean }[] = [];
  const repos: { wurzel: string; repo: string }[] = [];
  for (const wurzel of WURZELN) {
    try {
      for (const repo of readdirSync(wurzel)) repos.push({ wurzel, repo });
    } catch {
      /* ohne Wurzel bleibt das Register */
    }
  }
  for (const { wurzel, repo } of repos) {
    const ordner = gueltigerName(repo) ? ordnerIn(path.join(wurzel, repo)) : null;
    if (!ordner) continue;
    let dateien: string[];
    try {
      dateien = readdirSync(ordner);
    } catch {
      continue;
    }
    for (const datei of dateien) {
      const slug = SITZUNGSDATEI.exec(datei)?.[1];
      if (!slug || !gueltigerName(slug)) continue;
      const pfad = path.join(ordner, datei);
      let geaendert: string;
      try {
        const st = lstatSync(pfad);
        if (!st.isFile()) continue;
        geaendert = st.mtime.toISOString();
      } catch {
        continue;
      }
      // The same repo name under a later root is shadowed, as in ortVon.
      if (eintraege.some((e) => e.repo === repo && e.slug === slug)) continue;
      eintraege.push({ repo, slug, ...kopfVon(pfad, slug), geaendert, pfad: path.join(wurzel, repo), live: false, beendet: false });
    }
  }
  let ids: string[] = [];
  try {
    if (registerDa()) ids = readdirSync(REGISTER).flatMap((d) => REGISTERDATEI.exec(d)?.[1] ?? []);
  } catch {
    /* Register nicht lesbar: nur die YAML-Sitzungen */
  }
  for (const id of ids) {
    const gelesen = liesRegister(id);
    const ort = gelesen ? ortVon(registerRepo(gelesen), id) : null;
    const r = ort?.live;
    if (!ort || !r) continue;
    const um = Number.isFinite(r.aktualisiert) ? new Date(r.aktualisiert).toISOString() : "";
    const da = eintraege.find((e) => e.repo === ort.repo && e.slug === id);
    if (da) {
      Object.assign(da, { pfad: ort.repoPfad, live: true, beendet: r.beendet !== undefined, geaendert: um > da.geaendert ? um : da.geaendert });
      continue;
    }
    const kopf = ort.yaml ? kopfVon(ort.yaml, id) : { titel: typeof r.fortschritt?.titel === "string" && r.fortschritt.titel ? r.fortschritt.titel : id, offeneFragen: null };
    eintraege.push({ repo: ort.repo, slug: id, ...kopf, geaendert: um, pfad: ort.repoPfad, live: true, beendet: r.beendet !== undefined });
  }
  return eintraege.sort((a, b) => (a.geaendert < b.geaendert ? 1 : a.geaendert > b.geaendert ? -1 : 0));
}

// --- Lesen samt Verlauf -----------------------------------------------------------------------

const verlaufPfad = (pfad: string) => pfad.replace(/\.yaml$/, ".verlauf.jsonl");
const standPfad = (pfad: string) => pfad.replace(/\.yaml$/, ".stand.json");

function liesVerlauf(pfad: string): Verlaufseintrag[] {
  return (liesSicher(pfad) ?? "")
    .split("\n")
    .filter((z) => z.trim() !== "")
    .flatMap((z) => {
      try {
        return [JSON.parse(z) as Verlaufseintrag];
      } catch {
        return [];
      }
    });
}

/** Der zuletzt gesehene Stand ist der gepruefte Plan als JSON, nicht die Rohform. */
function liesStand(pfad: string): Plan | null {
  const inhalt = liesSicher(pfad);
  if (inhalt === null) return null;
  try {
    const d = JSON.parse(inhalt) as Partial<Plan> | null;
    return d && Array.isArray(d.schritte) && Array.isArray(d.fragen) ? (d as Plan) : null;
  } catch {
    return null;
  }
}

/** Schreibt ueber eine neue Nachbardatei und rename; der Dateimodus der alten Datei bleibt (K3). */
function schreibeAtomar(pfad: string, inhalt: string): void {
  let modus = 0o644;
  try {
    const st = lstatSync(pfad);
    if (st.isSymbolicLink()) throw new Unsicher(`${path.basename(pfad)} ist ein Symlink`);
    if (!st.isFile()) throw new Unsicher(`${path.basename(pfad)} ist keine regulaere Datei`);
    modus = st.mode & 0o7777;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const tmp = `${pfad}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, inhalt, { flag: "wx", mode: modus });
  try {
    chmodSync(tmp, modus);
    renameSync(tmp, pfad);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

// Lesen vergleicht und schreibt Verlauf und Stand, Entscheiden schreibt die Datei: alles an
// derselben Datei laeuft nacheinander.
const reihen = new Map<string, Promise<unknown>>();

async function inReihe<T>(schluessel: string, fn: () => T): Promise<T> {
  const vorher = reihen.get(schluessel) ?? Promise.resolve();
  const eigene = vorher.then(fn, fn);
  reihen.set(schluessel, eigene.catch(() => undefined));
  try {
    return await eigene;
  } finally {
    if (reihen.get(schluessel) === eigene) reihen.delete(schluessel);
  }
}

interface Gelesen {
  plan: Plan;
  fehler: Fehler[];
  verlauf: Verlaufseintrag[];
}

function liesSitzung(pfad: string): Promise<Gelesen> {
  return inReihe(pfad, () => {
    const fehler: Fehler[] = [];
    let roh: unknown = null;
    const inhalt = liesSicher(pfad);
    if (inhalt === null) throw new Unsicher(`${path.basename(pfad)} fehlt`);
    try {
      roh = Bun.YAML.parse(inhalt);
    } catch (e) {
      fehler.push({ pfad: "", grund: `YAML nicht lesbar: ${(e as Error).message.split("\n")[0]}` });
    }
    const geprueft = pruefePlan(roh);
    fehler.push(...geprueft.fehler);
    const verlauf = liesVerlauf(verlaufPfad(pfad));
    let um: string;
    try {
      um = lstatSync(pfad).mtime.toISOString();
    } catch {
      um = new Date().toISOString();
    }
    // Eine leere oder halb geschriebene Datei ist kein neuer Stand: sonst stuende jeder Eintrag
    // als `entfernt` und gleich darauf als `neu` im Verlauf, und alle Zeiten waeren weg.
    const alt = liesStand(standPfad(pfad));
    const neu = vergleichbar(roh) ? vergleiche(alt, geprueft.plan, um) : [];
    if (vergleichbar(roh)) neu.push(...dokuOhneVerlauf([...verlauf, ...neu], geprueft.plan, um));
    if (neu.length > 0) {
      haengeSicher(verlaufPfad(pfad), neu.map((e) => JSON.stringify(e) + "\n").join(""));
      schreibeAtomar(standPfad(pfad), JSON.stringify(geprueft.plan));
      verlauf.push(...neu);
    }
    return { plan: geprueft.plan, fehler, verlauf };
  });
}

// --- Git-Stand --------------------------------------------------------------------------------

type Ausgabe = { art: "ok"; text: string } | { art: "fehler"; grund: string };

function befehl(cwd: string, datei: string, args: string[], puffer = 8 * 1024 * 1024): Promise<Ausgabe> {
  return new Promise((resolve) => {
    execFile(datei, args, { cwd, timeout: GIT_ABBRUCH_MS, encoding: "utf8", maxBuffer: puffer },(fehler, stdout, stderr) => {
      if (fehler) resolve({ art: "fehler", grund: (stderr || fehler.message).trim().split("\n")[0] ?? "" });
      else resolve({ art: "ok", text: stdout });
    });
  });
}

const gitVorrat = new Map<string, { um: number; stand: GitStand }>();

/** 30 s vorgehalten; jeder Befehl bricht nach 5 s ab, unbekannt bleibt unbekannt. */
async function gitStandVon(repoPfad: string, kopfBranch?: string): Promise<GitStand> {
  const schluessel = `${repoPfad}\0${kopfBranch ?? ""}`;
  const alt = gitVorrat.get(schluessel);
  if (alt && Date.now() - alt.um < GIT_VORHALTEN_MS) return alt.stand;
  const aktuell = await befehl(repoPfad, "git", ["branch", "--show-current"]);
  const aktuellText = aktuell.art === "ok" ? aktuell.text.trim() : null;
  const branch = aktuellText === WORKSPACE ? kopfBranch?.trim() || WORKSPACE : aktuellText;
  const diff = branch ? await befehl(repoPfad, "git", ["diff", "--name-only", `origin/main...${branch}`]) : ({ art: "fehler", grund: "kein Branch" } as const);
  const but = aktuellText === WORKSPACE ? await befehl(repoPfad, "but", ["status", "--json"]) : null;
  const stand = gitStand({
    aktuell: aktuellText,
    kopfBranch,
    diff: diff.art === "ok" ? { art: "ok", namen: diff.text } : { art: "fehler", grund: diff.grund },
    butStatusJson: but?.art === "ok" ? but.text : null,
  });
  gitVorrat.set(schluessel, { um: Date.now(), stand });
  return stand;
}

// --- Dateibaum (Vertrag v1.1) -----------------------------------------------------------------
//
// Alle Dateien der Wurzel mit Git-Marke und Zeilen, fuer den Abschnitt Dateien der Ansicht. Jeder
// git-Aufruf bricht nach 5 s ab; das Ergebnis gilt 3 s je Wurzel, auch fuer gleichzeitige Anfragen.
// Ohne Git-Wurzel ist das Ergebnis null.

const BAUM_VORHALTEN_MS = 3_000;
const BAUM_PUFFER = 64 * 1024 * 1024;
const ZEILEN_HOECHSTENS = 1024 * 1024;
const zeilenPuffer = Buffer.allocUnsafe(ZEILEN_HOECHSTENS);
const baumVorrat = new Map<string, { um: number; baum: Promise<Baum | null> }>();

/** Zeilen einer unversionierten Datei aus hoechstens 1 MB; nur regulaere Dateien, keinem Symlink nach. */
function zeilenVon(pfad: string): number | undefined {
  let fd: number;
  try {
    fd = openSync(pfad, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    if (!fstatSync(fd).isFile()) return undefined;
    return zeilenZahl(zeilenPuffer.subarray(0, readSync(fd, zeilenPuffer, 0, ZEILEN_HOECHSTENS, 0))) ?? undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

async function baumLesen(repoPfad: string): Promise<Baum | null> {
  // --no-optional-locks: reading must not take index.lock away from the session's own git calls.
  const git = (...args: string[]) => befehl(repoPfad, "git", ["--no-optional-locks", ...args], BAUM_PUFFER);
  const [liste, status, zahlen, zweig, upstream, abstand] = await Promise.all([
    git("ls-files", "-z", "--full-name", "--cached", "--others", "--exclude-standard"),
    git("status", "--porcelain=v1", "-z", "--untracked-files=all"),
    git("diff", "--numstat", "-z", "HEAD"),
    git("rev-parse", "--abbrev-ref", "HEAD"),
    git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"),
    git("rev-list", "--left-right", "--count", "HEAD...@{u}"),
  ]);
  if (liste.art !== "ok" || status.art !== "ok") return null;
  const { dateien, gekappt } = baumDateien(liste.text, status.text, zahlen.art === "ok" ? zahlen.text : "");
  for (const d of dateien) {
    if (!d.s || d.s === "D") continue;
    const voll = path.join(repoPfad, d.p);
    if (d.s === "?") {
      const n = zeilenVon(voll);
      if (n !== undefined) d.plus = n;
    }
    try {
      d.t = lstatSync(voll).mtimeMs;
    } catch {
      /* gone meanwhile: no time */
    }
  }
  const mitUpstream = upstream.art === "ok" && upstream.text.trim() !== "";
  const zweigName = zweig.art === "ok" ? zweig.text.trim() || null : null;
  return {
    wurzel: path.basename(repoPfad),
    zweig: zweigName,
    upstream: mitUpstream ? upstream.text.trim() : null,
    ...(mitUpstream ? abstandAus(abstand.art === "ok" ? abstand.text : null) : { vor: 0, zurueck: 0 }),
    dateien,
    gekappt,
    but: zweigName === WORKSPACE ? await butVon(repoPfad, dateien) : null,
  };
}

/**
 * Unter GitButler (E3): `but status --json` und je angewendetem Branch seine committeten Dateien
 * gegen seine Basis. Branchnamen gehen nur geprueft und als `refs/heads/NAME` an git. Fehlt `but`
 * oder scheitert es, ist das Ergebnis null; ein Branch, dessen git diff scheitert, bleibt ohne
 * committete Dateien.
 */
async function butVon(repoPfad: string, dateien: Baum["dateien"]): Promise<ButGruppen | null> {
  const aus = await befehl(repoPfad, "but", ["status", "--json"], BAUM_PUFFER);
  const status = aus.art === "ok" ? butStatusAus(aus.text) : null;
  if (!status) return null;
  const git = (...args: string[]) => befehl(repoPfad, "git", ["--no-optional-locks", "diff", "--no-renames", ...args], BAUM_PUFFER);
  const committet = new Map<string, ButCommittet>();
  await Promise.all(
    butMessungen(status).map(async ({ name, basis }) => {
      const [namen, zahlen] = await Promise.all([git("--name-status", "-z", basis, `refs/heads/${name}`, "--"), git("--numstat", "-z", basis, `refs/heads/${name}`, "--")]);
      if (namen.art === "ok") committet.set(name, { namen: namen.text, zahlen: zahlen.art === "ok" ? zahlen.text : "" });
    }),
  );
  return butGruppen(status, committet, dateien);
}

function baumVon(repoPfad: string): Promise<Baum | null> {
  const alt = baumVorrat.get(repoPfad);
  if (alt && Date.now() - alt.um < BAUM_VORHALTEN_MS) return alt.baum;
  for (const [w, e] of baumVorrat) if (Date.now() - e.um >= BAUM_VORHALTEN_MS) baumVorrat.delete(w);
  const baum = baumLesen(repoPfad).catch(() => null);
  baumVorrat.set(repoPfad, { um: Date.now(), baum });
  return baum;
}

// --- Diff einer Datei (GET .../diff?p=) -------------------------------------------------------
//
// Nur fuer einen Pfad aus dem Dateibaum: so liest der Server nichts ausserhalb der Wurzel. Geaendert
// oder geloescht: git diff HEAD; unversioniert: der Inhalt als neue Datei; ohne Marke: der Inhalt.
// Mit branch= (E3) nur eine Datei, die dieser but-Branch committet hat: der Diff gegen seine Basis.
// Ausserhalb des Baums (git-ignoriert) nur eine Datei, die das Register dieser Sitzung als gelesen
// oder geschrieben fuehrt, nur an eine Verbindung vom eigenen Rechner (Loopback), nach realpath in
// der Wurzel und nicht mit einem Secret-Namen.

const DIFF_PUFFER = 32 * 1024 * 1024;
const diffPuffer = Buffer.allocUnsafe(DIFF_LESEN_HOECHSTENS);

/** Hoechstens DIFF_LESEN_HOECHSTENS Bytes einer regulaeren Datei, keinem Symlink nach; null, wenn das nicht geht. */
function liesAnfang(pfad: string): { inhalt: Uint8Array; gekappt: boolean } | null {
  let fd: number;
  try {
    fd = openSync(pfad, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const n = readSync(fd, diffPuffer, 0, DIFF_LESEN_HOECHSTENS, 0);
    return { inhalt: Uint8Array.from(diffPuffer.subarray(0, n)), gekappt: st.size > n };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

async function diffVon(repoPfad: string, d: BaumDatei): Promise<DiffAntwort | null> {
  const art = diffArtVon(d.s);
  if (art === "diff") {
    // Literal pathspec: a name like ':(glob)*' stays a name. No external diff or textconv runs.
    const aus = await befehl(repoPfad, "git", ["--no-optional-locks", "--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "HEAD", "--", d.p], DIFF_PUFFER);
    return aus.art === "ok" ? diffAntwort(d.p, art, aus.text) : null;
  }
  const datei = liesAnfang(path.join(repoPfad, d.p));
  if (!datei) return { p: d.p, art: "binaer", text: "Keine regulaere Datei (Symlink oder nicht lesbar), Inhalt nicht gelesen", gekappt: false };
  return diffAntwort(d.p, art, datei.inhalt, datei.gekappt);
}

/** Der Inhalt einer Datei ausserhalb des Baums; null, wenn sie nach realpath nicht in der Wurzel liegt. */
function ignoriertVon(repoPfad: string, p: string): DiffAntwort | null {
  const voll = ignorierterPfad(repoPfad, p);
  if (!voll) return null;
  const datei = liesAnfang(voll);
  if (!datei) return { p, art: "binaer", text: "Keine regulaere Datei (Symlink oder nicht lesbar), Inhalt nicht gelesen", gekappt: false };
  return diffAntwort(p, "datei", datei.inhalt, datei.gekappt);
}

/** Ein Bild bis BILD_HOECHSTENS, keinem Symlink nach: Bytes, "gross" oder null (nicht lesbar). */
function liesBild(pfad: string): Uint8Array | "gross" | null {
  let fd: number;
  try {
    fd = openSync(pfad, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    if (st.size > BILD_HOECHSTENS) return "gross";
    const puffer = Buffer.allocUnsafe(st.size);
    const n = readSync(fd, puffer, 0, st.size, 0);
    return Uint8Array.from(puffer.subarray(0, n));
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Der Pfad einer git-ignorierten Datei nach realpath in der Wurzel; null, wenn er sie verlaesst. */
function ignorierterPfad(repoPfad: string, p: string): string | null {
  try {
    const wurzel = realpathSync(repoPfad);
    // The last part stays unresolved: the readers refuse a symlink there themselves.
    const ordner = realpathSync(path.dirname(path.join(wurzel, p)));
    if (ordner !== wurzel && !ordner.startsWith(wurzel + path.sep)) return null;
    return path.join(ordner, path.basename(p));
  } catch {
    return null;
  }
}

/** Die Antwort mit den Rohbytes eines Bildes: Inhaltstyp nach Endung, nie als Seite lesbar (SVG fuehrt kein Skript aus). */
function bildAntwort(p: string, bytes: Uint8Array | "gross" | null): Response {
  if (bytes === "gross") return json({ fehler: `Bild groesser als ${BILD_HOECHSTENS} Bytes` }, 413);
  if (!bytes) return json({ fehler: "Datei nicht lesbar oder nicht in der Wurzel der Sitzung" }, 404);
  return new Response(bytes, {
    headers: {
      "content-type": bildArtVon(p)!,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}

/**
 * Die Regeln fuer eine Datei ohne branch=, gemeinsam fuer .../diff und .../bild: im Baum, oder (git-ignoriert)
 * vom Register der Sitzung als gelesen oder geschrieben gefuehrt, nur fuer Loopback und ohne Secret-Namen.
 * Die eigene Plan-Datei der Sitzung gehoert ihr und braucht keinen Registereintrag. Sonst eine Fehlerantwort.
 */
function dateiZugang(ort: Ort, baum: Baum, p: string, req: Request, server: Bun.Server): Response | { eintrag?: BaumDatei; ignoriert: boolean } {
  const eintrag = baum.dateien.find((x) => x.p === p);
  if (eintrag) return { eintrag, ignoriert: false };
  if (p === eigenerPlanPfad(ort.slug)) return { ignoriert: true };
  if (!registerBeruehrt(ort.live, p)) return json({ fehler: "Datei steht nicht im Dateibaum" }, 404);
  if (!istLoopback(server.requestIP(req)?.address)) return json({ fehler: "Git-ignorierte Datei, Inhalt nur fuer Aufrufe vom eigenen Rechner" }, 403);
  if (geheimerName(p)) return json({ fehler: "Git-ignorierte Datei mit Secret-Namen, Inhalt wird nicht gezeigt" }, 403);
  return { ignoriert: true };
}

/** Die Bytes eines in einem but-Branch committeten Bildes (git show); "gross" ueber BILD_HOECHSTENS, null bei Fehler. */
function branchBild(repoPfad: string, branch: string, p: string): Promise<Uint8Array | "gross" | null> {
  return new Promise((resolve) => {
    execFile("git", ["--no-optional-locks", "--literal-pathspecs", "show", `refs/heads/${branch}:${p}`], { cwd: repoPfad, timeout: GIT_ABBRUCH_MS, encoding: "buffer", maxBuffer: BILD_HOECHSTENS }, (fehler, stdout) => {
      if (!fehler) resolve(Uint8Array.from(stdout));
      else resolve((fehler as { code?: string }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "gross" : null);
    });
  });
}

/** Eine in einem but-Branch committete Datei (E3): git diff zwischen seiner Basis und dem Branch. */
async function branchDiffVon(repoPfad: string, basis: string, branch: string, p: string): Promise<DiffAntwort | null> {
  const aus = await befehl(repoPfad, "git", ["--no-optional-locks", "--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", basis, `refs/heads/${branch}`, "--", p], DIFF_PUFFER);
  return aus.art === "ok" ? diffAntwort(p, "diff", aus.text) : null;
}

// --- Abo-Zeile (tollgate GET /status, #140) -----------------------------------------------------
//
// ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN come from this server's own environment. The token
// goes only into the Authorization header of this one request to the base URL: http(s) only, no
// redirect followed, aborted after 5 s. No answer, message or log line names it; an error says
// the HTTP status or "nicht erreichbar". Without either variable the answer is `abo: null`.
// Kept 60 s (tollgate caches 5 min itself); aboLage runs per request with the current clock.

const ABO_VORHALTEN_MS = 60_000;
const ABO_ABBRUCH_MS = 5_000;
const ABO_HOECHSTENS = 256 * 1024;

type AboRoh = { art: "ok"; status: unknown } | { art: "aus" } | { art: "fehler"; grund: string };
let aboVorrat: { um: number; roh: Promise<AboRoh> } | null = null;

async function aboHolen(): Promise<AboRoh> {
  const basis = (process.env.ANTHROPIC_BASE_URL ?? "").trim();
  const token = (process.env.ANTHROPIC_AUTH_TOKEN ?? "").trim();
  if (!basis || !token) return { art: "aus" };
  const url = aboStatusUrl(basis);
  if (!url) return { art: "fehler", grund: "ANTHROPIC_BASE_URL ist keine http(s)-Adresse" };
  let text: string;
  try {
    const r = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(ABO_ABBRUCH_MS),
    });
    if (r.status !== 200) {
      await r.body?.cancel().catch(() => undefined);
      return { art: "fehler", grund: `tollgate antwortet HTTP ${r.status}` };
    }
    text = await r.text();
  } catch {
    return { art: "fehler", grund: "tollgate nicht erreichbar" };
  }
  if (text.length > ABO_HOECHSTENS) return { art: "fehler", grund: "tollgate-Antwort zu gross" };
  try {
    return { art: "ok", status: JSON.parse(text) };
  } catch {
    return { art: "fehler", grund: "tollgate-Antwort ist kein JSON" };
  }
}

async function aboAntwort(): Promise<{ abo: ReturnType<typeof aboLage> | null; fehler?: string }> {
  if (!aboVorrat || Date.now() - aboVorrat.um >= ABO_VORHALTEN_MS) {
    aboVorrat = { um: Date.now(), roh: aboHolen().catch((): AboRoh => ({ art: "fehler", grund: "tollgate nicht erreichbar" })) };
  }
  const roh = await aboVorrat.roh;
  if (roh.art === "aus") return { abo: null };
  if (roh.art === "fehler") return { abo: null, fehler: roh.grund };
  return { abo: aboLage(roh.status, Date.now()) };
}

// --- Firstmate (GET .../firstmate) ---------------------------------------------------------------
//
// Ist die Wurzel der Sitzung ein Firstmate-Home, liest firstmate.ts in einem eigenen Prozess Worker,
// Captain-Inbox, Warteschlange und Projekte; so halten git und tmux keine Anfrage auf. Das Ergebnis
// gilt FM_VORHALTEN_MS, danach liefert die Anfrage den alten Stand und ein neuer entsteht im
// Hintergrund; nur der allererste wird abgewartet. Die offenen
// PRs je Projekt fragt gh ebenfalls im Hintergrund (je Aufruf 10 s, 60 s vorgehalten); was noch
// fehlt, heisst `laedt`, ein Fehler `unbekannt`. Pane-Inhalte liest firstmate.ts nie. Die Flotte
// (Aufgaben des Tages je Repo) liest dazu das Sitzungsregister; die Details einer Aufgabe holt
// GET .../firstmate/aufgabe/ID einzeln (nur data/ID/, nur vom eigenen Rechner). Ein Token aus
// `gh auth token` geht nur in die Umgebung des einen gh-Aufrufs, nie in eine Antwort oder ein Log.

const FM_SKRIPT = path.join(import.meta.dir, "firstmate.ts");
const FM_VORHALTEN_MS = 10_000;
const FM_ABBRUCH_MS = 30_000;
const GH_ABBRUCH_MS = 10_000;

const ghLauf: GhLauf = (args, env) =>
  new Promise((resolve) => {
    execFile("gh", args, { timeout: GH_ABBRUCH_MS, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1", ...env } }, (fehler, stdout) => resolve(fehler ? null : stdout));
  });
const prs = prVorrat(ghLauf);

function fmLesen(home: string): Promise<FirstmateSicht | null> {
  return new Promise((resolve) => {
    execFile(process.execPath, [FM_SKRIPT, "--json", home, REGISTER], { timeout: FM_ABBRUCH_MS, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }, (fehler, stdout) => {
      if (fehler) return resolve(null);
      try {
        resolve(JSON.parse(stdout) as FirstmateSicht);
      } catch {
        resolve(null);
      }
    });
  });
}

const fmVorrat = new Map<string, { um: number; sicht: FirstmateSicht | null; laeuft: Promise<void> | null }>();

async function firstmateDaten(home: string) {
  let e = fmVorrat.get(home);
  if (!e) fmVorrat.set(home, (e = { um: 0, sicht: null, laeuft: null }));
  const eintrag = e;
  if (!eintrag.laeuft && Date.now() - eintrag.um >= FM_VORHALTEN_MS) {
    eintrag.laeuft = fmLesen(home).then((sicht) => {
      if (sicht) eintrag.sicht = sicht;
      eintrag.um = Date.now();
      eintrag.laeuft = null;
    });
  }
  if (!eintrag.sicht && eintrag.laeuft) await eintrag.laeuft;
  if (!eintrag.sicht) return { home, fehler: "Firstmate-Home nicht lesbar" };
  const projekte = eintrag.sicht.projekte.map((p) => ({ ...p, prs: p.github ? prs.stand(p.github) : null }));
  return { ...eintrag.sicht, projekte };
}

// --- Entscheidung -----------------------------------------------------------------------------

type Entscheidungsergebnis =
  | { art: "ok" }
  | { art: "unbekannt" }
  | { art: "ungueltig"; grund: string }
  | { art: "nicht-aenderbar"; grund: string }
  | { art: "fehler"; grund: string };

/**
 * Aendert genau die Zeile entscheidung der Frage, liest das Ergebnis gegen und schreibt atomar.
 * Ohne `eigen` muss die Wahl ein label der Optionen dieser Frage sein. Mit `eigen` ist sie eine
 * eigene Antwort: freier Text aus dem Netz gelangt damit in die Datei, die der Agent liest, aber
 * begrenzt (pruefeEigeneAntwort: eine Zeile, 1 bis 500 Zeichen, ohne Steuer- und Bidi-Zeichen) und
 * markiert: Ansicht und Meldung im Chat zeigen eine Entscheidung, die kein label ist, als eigene
 * Antwort. Die Grenze gegen fremde Seiten bleibt die Pruefung von Host und Herkunft (B1).
 */
function setzeEntscheidung(pfad: string, frage: string, roh: string, eigen: boolean): Promise<Entscheidungsergebnis> {
  return inReihe(pfad, (): Entscheidungsergebnis => {
    const text = liesSicher(pfad);
    if (text === null) return { art: "unbekannt" };
    let jetzt: unknown;
    try {
      jetzt = Bun.YAML.parse(text);
    } catch (e) {
      return { art: "nicht-aenderbar", grund: `YAML nicht lesbar: ${(e as Error).message.split("\n")[0]}` };
    }
    const f = pruefePlan(jetzt).plan.fragen.find((x) => x.id === frage);
    if (!f) return { art: "unbekannt" };
    let wahl = roh;
    if (eigen) {
      const geprueft = pruefeEigeneAntwort(roh);
      if (geprueft.art === "ungueltig") return geprueft;
      wahl = geprueft.text;
    } else if (!f.optionen.some((o) => o.label === wahl)) {
      return { art: "ungueltig", grund: `${JSON.stringify(wahl)} ist keine Option von ${frage}` };
    }
    const ergebnis = setzeEntscheidungImText(text, frage, wahl);
    if (ergebnis.art === "unbekannt") return { art: "nicht-aenderbar", grund: `entscheidung von ${frage} steht nicht als eigene Zeile in der Datei` };
    if (ergebnis.art === "fehler") return { art: "nicht-aenderbar", grund: ergebnis.grund };
    let gelesen: unknown;
    try {
      gelesen = Bun.YAML.parse(ergebnis.text);
    } catch (e) {
      return { art: "fehler", grund: `Ergebnis nicht lesbar: ${(e as Error).message.split("\n")[0]}` };
    }
    const fragen = (gelesen as { fragen?: unknown } | null)?.fragen;
    const treffer = Array.isArray(fragen) ? fragen.find((f) => f && typeof f === "object" && String((f as { id?: unknown }).id) === frage) : undefined;
    if (!treffer || (treffer as { entscheidung?: unknown }).entscheidung !== wahl) {
      return { art: "fehler", grund: `entscheidung von ${frage} liesse sich nicht unveraendert zuruecklesen` };
    }
    schreibeAtomar(pfad, ergebnis.text);
    return { art: "ok" };
  });
}

// --- Zurueckziehen (#27) ----------------------------------------------------------------------

type Zurueckziehergebnis =
  | { art: "ok" }
  | { art: "unbekannt" }
  | { art: "entschieden"; entscheidung: string }
  | { art: "nicht-aenderbar"; grund: string }
  | { art: "fehler"; grund: string };

/**
 * Setzt `zurueckgezogen: GRUND` der Frage als eine Zeile, liest das Ergebnis gegen und schreibt
 * atomar. Eine entschiedene Frage bleibt, wie sie ist; eine schon zurueckgezogene behaelt ihren
 * ersten Grund. Der Grund ist begrenzt wie eine eigene Antwort (zurueckGrund: eine Zeile, hoechstens
 * 200 Zeichen, ohne Steuer- und Bidi-Zeichen).
 */
function zieheZurueck(pfad: string, frage: string, roh: unknown): Promise<Zurueckziehergebnis> {
  return inReihe(pfad, (): Zurueckziehergebnis => {
    const text = liesSicher(pfad);
    if (text === null) return { art: "unbekannt" };
    let jetzt: unknown;
    try {
      jetzt = Bun.YAML.parse(text);
    } catch (e) {
      return { art: "nicht-aenderbar", grund: `YAML nicht lesbar: ${(e as Error).message.split("\n")[0]}` };
    }
    const f = pruefePlan(jetzt).plan.fragen.find((x) => x.id === frage);
    if (!f) return { art: "unbekannt" };
    if (f.entscheidung) return { art: "entschieden", entscheidung: f.entscheidung };
    if (f.zurueckgezogen) return { art: "ok" };
    const grund = zurueckGrund(roh);
    const ergebnis = zieheFrageZurueckImText(text, frage, grund);
    if (ergebnis.art === "unbekannt") return { art: "nicht-aenderbar", grund: `${frage} steht nicht als Block in der Datei` };
    if (ergebnis.art === "fehler") return { art: "nicht-aenderbar", grund: ergebnis.grund };
    if (ergebnis.art === "entschieden") return ergebnis;
    let gelesen: unknown;
    try {
      gelesen = Bun.YAML.parse(ergebnis.text);
    } catch (e) {
      return { art: "fehler", grund: `Ergebnis nicht lesbar: ${(e as Error).message.split("\n")[0]}` };
    }
    const neu = pruefePlan(gelesen).plan.fragen.find((x) => x.id === frage);
    if (neu?.zurueckgezogen !== grund || neu.entscheidung) {
      return { art: "fehler", grund: `zurueckgezogen von ${frage} liesse sich nicht unveraendert zuruecklesen` };
    }
    schreibeAtomar(pfad, ergebnis.text);
    return { art: "ok" };
  });
}

// --- Einstellungen der Sprachausgabe ------------------------------------------------------------

/** Die Einstellungen aus EINSTELLUNGEN; eine fehlende, kaputte oder unsichere Datei ergibt die Vorgabe. */
function liesEinstellungen(): Einstellungen {
  try {
    return einstellungenAus(Bun.YAML.parse(liesSicher(EINSTELLUNGEN) ?? ""));
  } catch {
    return einstellungenAus(null);
  }
}

/** Uebernimmt eine Aenderung aus dem Browser und schreibt die YAML neu; null, wenn sie nicht passt. */
function setzeEinstellungen(aenderung: unknown): Promise<Einstellungen | null> {
  return inReihe(EINSTELLUNGEN, () => {
    const neu = einstellungenMit(liesEinstellungen(), aenderung);
    if (!neu) return null;
    mkdirSync(CACHE, { recursive: true });
    schreibeAtomar(EINSTELLUNGEN, einstellungenYaml(neu));
    return neu;
  });
}

// --- Beobachten -------------------------------------------------------------------------------

/**
 * Beobachtet die Ordner der Dateien, weil rename eine Datei ersetzt; dazu ein Rueckfall alle 5 s.
 * Eine Datei, die erst spaeter entsteht (die Register-JSON, S5), meldet der Takt, sobald es sie gibt.
 */
function beobachte(pfade: string[], cb: () => void): () => void {
  const namen = new Map<string, Set<string>>();
  for (const p of pfade) namen.set(path.dirname(p), (namen.get(path.dirname(p)) ?? new Set()).add(path.basename(p)));
  const watcher: FSWatcher[] = [];
  for (const [ordner, je] of namen) {
    try {
      const w = watch(ordner, (_, datei) => {
        if (!datei || je.has(String(datei))) cb();
      });
      w.on("error", () => undefined);
      watcher.push(w);
    } catch {
      /* Ordner fehlt: der Takt sieht die Datei, sobald es sie gibt */
    }
  }
  const stempel = (p: string) => {
    try {
      return String(statSync(p).mtimeMs);
    } catch {
      return null;
    }
  };
  const letzte = new Map(pfade.map((p) => [p, stempel(p)]));
  const takt = setInterval(() => {
    let neu = false;
    for (const p of pfade) {
      const m = stempel(p);
      // Fehlt die Datei gerade (ersetzt), sieht der naechste Takt sie wieder.
      if (m !== null && m !== letzte.get(p)) neu = true;
      if (m !== null) letzte.set(p, m);
    }
    if (neu) cb();
  }, 5_000);
  return () => {
    for (const w of watcher) w.close();
    clearInterval(takt);
  };
}

// --- Daten fuer die Ansicht -------------------------------------------------------------------

/** Ein Beleg, der als regulaere Datei vorliegt; ein Ordner oder ein fehlender Pfad nicht. */
function istBelegDatei(ziel: string | null): boolean {
  if (!ziel) return false;
  try {
    return statSync(ziel).isFile();
  } catch {
    return false;
  }
}

async function sitzungsDaten(ort: Ort) {
  const { repo, slug, yaml: pfad, live } = ort;
  // Nur im Register, ohne YAML (S5): die Seite zeigt allein den Live-Block.
  if (!pfad) return { repo, slug, pfad: null, repoPfad: ort.repoPfad, nurLive: true, live };
  const gelesen = await liesSitzung(pfad);
  const z = zeiten(gelesen.verlauf);
  // S26: Jetzt-Zeile, drei Abschnitte und Spurbild; ein Beweisbild (A20) nur, wenn es im
  // Belegordner liegt, kein Link und eine regulaere Datei ist (K1) -- dieselbe Pruefung wie die Route /beleg.
  const u = ueberblick(gelesen.plan, z);
  for (const a of [...u.anforderungen.sichtbar, ...u.anforderungen.aelter]) {
    if (a.beweis && !istBelegDatei(belegVon(ort, a.beweis))) a.beweis = null;
  }
  return {
    repo,
    slug,
    pfad,
    repoPfad: ort.repoPfad,
    live,
    plan: gelesen.plan,
    fehler: gelesen.fehler,
    zeiten: z,
    verlauf: gelesen.verlauf.length,
    git: await gitStandVon(ort.repoPfad!, gelesen.plan.branch),
    raster: raster(gelesen.plan, z),
    jetzt: jetzt(gelesen.plan, z),
    prozess: prozessLayout(gelesen.plan),
    erfuellung: anforderungsStand(gelesen.plan),
    neueste: {
      anforderung: neuesteId(gelesen.plan.anforderungen.map((a) => a.id), z),
      entscheidung: neuesteId(gelesen.plan.entscheidungen.map((e) => e.id), z),
    },
    ueberblick: u,
    spurbild: spurbild(gelesen.plan, z),
  };
}

function warte(pfad: string, ab: number, frist: number, signal: AbortSignal): Promise<string> {
  const ende = Date.now() + frist;
  return new Promise((resolve, reject) => {
    let fertig = false;
    let laeuft = false;
    let nochmal = false;
    const schliesse = (t: string) => {
      if (fertig) return;
      fertig = true;
      halt();
      clearTimeout(uhr);
      resolve(t);
    };
    const pruefe = async () => {
      if (fertig) return;
      if (laeuft) {
        nochmal = true;
        return;
      }
      laeuft = true;
      try {
        const neu = neueEntscheidungen((await liesSitzung(pfad)).verlauf, ab);
        if (neu.entscheidungen.length > 0 || Date.now() >= ende) schliesse(warteText(neu));
      } catch (e) {
        if (!fertig) {
          fertig = true;
          halt();
          clearTimeout(uhr);
          reject(e);
        }
      } finally {
        laeuft = false;
        if (nochmal) {
          nochmal = false;
          void pruefe();
        }
      }
    };
    const halt = beobachte([pfad], () => void pruefe());
    const uhr = setTimeout(() => void pruefe(), frist);
    signal.addEventListener("abort", () => schliesse(""));
    void pruefe();
  });
}

// --- Leerlauf ---------------------------------------------------------------------------------

let offen = 0;
let zuletzt = Date.now();

function belegt(): () => void {
  offen++;
  let frei = false;
  return () => {
    if (frei) return;
    frei = true;
    offen--;
    zuletzt = Date.now();
  };
}

/** Die PID-Datei des Startskripts geht mit, aber nur wenn sie diesen Prozess nennt (S2). */
function raeumePidDatei(): void {
  try {
    if (Number.parseInt(readFileSync(PID_DATEI, "utf8"), 10) === process.pid) rmSync(PID_DATEI, { force: true });
  } catch {
    /* keine PID-Datei: nichts zu raeumen */
  }
}

function beende(grund: string, code = 0): never {
  console.log(`live-plan: ${grund}, beende`);
  raeumePidDatei();
  process.exit(code);
}

setInterval(() => {
  if (offen === 0 && Date.now() - zuletzt >= LEERLAUF_MS) beende(`${LEERLAUF_MS} ms ohne Anfrage`);
}, Math.min(Math.max(LEERLAUF_MS / 4, 50), 60_000));
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => beende(signal, 0));

// --- Antworten --------------------------------------------------------------------------------

const INHALTSART: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
};

const json = (daten: unknown, status = 200) => Response.json(daten, { status });
const text = (inhalt: string, status = 200) => new Response(inhalt, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

function datei(pfad: string, status = 200, kopf: Record<string, string> = {}): Response {
  const art = INHALTSART[path.extname(pfad).toLowerCase()] ?? "application/octet-stream";
  return new Response(Bun.file(pfad), { status, headers: { "content-type": art, "cache-control": "no-cache", ...kopf } });
}

/**
 * Ein Beleg laeuft auch direkt aufgerufen in einem eigenen, undurchsichtigen Ursprung (K2). Einbetten
 * darf ihn nur die eigene Seite, in deren Seitenleiste er im Rahmen steht (S-1).
 */
const BELEG_KOPF = { "content-security-policy": "sandbox allow-scripts; frame-ancestors 'self'", "x-content-type-options": "nosniff" };
/** A raster image runs no script; without sandbox, embedded previews that refuse a sandboxed image load it too. */
const RASTER_KOPF = { "content-security-policy": "frame-ancestors 'self'", "x-content-type-options": "nosniff" };
const RASTER = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** Keine fremde Seite bettet die Ansicht ein und greift einen Klick als Entscheidung ab (S-1). */
const SEITE_KOPF = { "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" };

const seite = (status = 200) => datei(path.join(ANSICHT, "index.html"), status, SEITE_KOPF);

/** Ob eine Anfrage der API gilt; ein Host-Kopf, aus dem keine URL wird, gilt keiner (K-1). */
function istApi(req: Request): boolean {
  try {
    return new URL(req.url).pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

/** Meldet jede Aenderung an den Dateien (YAML und Register-JSON, in der Uebersicht Ansagen und Einstellungen); Schreibschuebe fasst sie zu einer Meldung je 250 ms zusammen. */
function ereignisse(pfade: string[], req: Request): Response {
  const frei = belegt();
  let halt = () => {};
  let uhr: ReturnType<typeof setInterval> | undefined;
  let gleich: ReturnType<typeof setTimeout> | undefined;
  const ende = () => {
    halt();
    clearInterval(uhr);
    clearTimeout(gleich);
    frei();
  };
  const strom = new ReadableStream<string>({
    start(steuerung) {
      const sende = (art: string, daten: string) => {
        try {
          steuerung.enqueue(`event: ${art}\ndata: ${daten}\n\n`);
        } catch {
          ende();
        }
      };
      halt = beobachte(pfade, () => {
        gleich ??= setTimeout(() => {
          gleich = undefined;
          sende("geaendert", new Date().toISOString());
        }, 250);
      });
      uhr = setInterval(() => sende("takt", ""), TAKT_MS);
      req.signal.addEventListener("abort", ende);
      sende("bereit", new Date().toISOString());
    },
    cancel: ende,
  });
  return new Response(strom, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

async function antworte(req: Request, server: Bun.Server): Promise<Response> {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return text("Host-Kopf ergibt keine gueltige Adresse\n", 400);
  }
  let teile: string[];
  try {
    teile = url.pathname.split("/").filter((t) => t !== "").map(decodeURIComponent);
  } catch {
    return text("Nicht gefunden\n", 404);
  }
  const [a, b, c, d] = teile;
  const lesen = req.method === "GET" || req.method === "HEAD";
  const abgelehnt = herkunftAbgelehnt(req, a === "api");
  if (abgelehnt) return a === "api" ? json({ fehler: abgelehnt }, 403) : text(`${abgelehnt}\n`, 403);

  if (lesen && teile.length === 0) return seite();
  if (lesen && a === "ansicht" && teile.length === 2) {
    const name = b!;
    const pfad = path.join(ANSICHT, name);
    if (!gueltigerName(name) || !existsSync(pfad) || !statSync(pfad).isFile()) return text("Nicht gefunden\n", 404);
    return datei(pfad, 200, path.extname(pfad).toLowerCase() === ".html" ? SEITE_KOPF : {});
  }
  if (a === "api") {
    if (lesen && b === "gesund" && teile.length === 2) return json({ pid: process.pid, wurzel: WURZELN[0], wurzeln: WURZELN, port: PORT });
    if (lesen && b === "liste" && teile.length === 2) return json({ wurzel: WURZELN[0], wurzeln: WURZELN, sitzungen: listeSitzungen() });
    if (lesen && b === "abo" && teile.length === 2) return json(await aboAntwort());
    // Die Ansagen aller Sitzungen, neueste zuerst, je mit `gelesen` (#28); der Strom der Uebersicht meldet jede neue,
    // jede Gelesen-Marke und jede Aenderung der Einstellungen.
    if (lesen && b === "ansagen" && teile.length === 2) {
      const gelesen = leseGelesen(GELESEN);
      return json({ ansagen: leseAnsagen(ANSAGEN).reverse().map((x) => ({ ...x, gelesen: gelesen.has(x.kennung) })) });
    }
    if (lesen && b === "ereignisse" && teile.length === 2) {
      server.timeout(req, 0);
      return ereignisse([ANSAGEN, EINSTELLUNGEN, GELESEN], req);
    }
    // Der Knopf gelesen, je Repo oder fuer alle: der Browser schickt die Kennungen, die er zeigt; eine Ansage, die erst
    // danach kam, bleibt ungelesen. Schreiben wie bei den Einstellungen: nur JSON, klein, nur von der eigenen Seite.
    if (req.method === "POST" && b === "ansagen" && c === "gelesen" && teile.length === 3) {
      const art = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (art !== "application/json") return json({ fehler: "Inhaltstyp application/json erwartet" }, 415);
      const roh = await liesKoerper(req, KOERPER_HOECHSTENS);
      if (roh === null) return json({ fehler: `Koerper groesser als ${KOERPER_HOECHSTENS} Bytes` }, 413);
      let kennungen: unknown;
      try {
        const koerper: unknown = JSON.parse(roh);
        kennungen = koerper && typeof koerper === "object" && "kennungen" in koerper ? koerper.kennungen : null;
      } catch {
        return json({ fehler: "JSON mit kennungen erwartet" }, 400);
      }
      const liste: unknown[] = Array.isArray(kennungen) ? kennungen : [];
      const gueltig = liste.filter((k): k is string => typeof k === "string" && KENNUNG.test(k));
      if (gueltig.length === 0 || gueltig.length !== liste.length) {
        return json({ fehler: "kennungen muss eine nicht leere Liste von Kennungen sein (A-Z a-z 0-9 _ -, bis 64 Zeichen)" }, 400);
      }
      const zahl = markiereGelesen(GELESEN, ANSAGEN, gueltig, GELESEN_WARTEN_MS);
      return zahl > 0 ? json({ gelesen: zahl }) : json({ fehler: "Ansage unbekannt (vielleicht schon gekuerzt)" }, 404);
    }
    if (lesen && b === "einstellungen" && teile.length === 2) return json(liesEinstellungen());
    // Schreiben wie eine Entscheidung: nur JSON, klein, und nur von der eigenen Seite (herkunftAbgelehnt oben).
    if (req.method === "POST" && b === "einstellungen" && teile.length === 2) {
      const art = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (art !== "application/json") return json({ fehler: "Inhaltstyp application/json erwartet" }, 415);
      const roh = await liesKoerper(req, EINSTELLUNGEN_HOECHSTENS);
      if (roh === null) return json({ fehler: `Koerper groesser als ${EINSTELLUNGEN_HOECHSTENS} Bytes` }, 413);
      let aenderung: unknown;
      try {
        aenderung = JSON.parse(roh);
      } catch {
        return json({ fehler: "JSON mit vorlesen und/oder stimme erwartet" }, 400);
      }
      const neu = await setzeEinstellungen(aenderung);
      return neu ? json(neu) : json({ fehler: "vorlesen muss true oder false sein, stimme ein Name bis 200 Zeichen oder null" }, 422);
    }
    if (lesen && b === "host" && teile.length === 2) {
      try {
        const sicht = await hostSicht();
        if (!sicht.verfuegbar) return json(sicht);
        verlauf.beruehre(); // startet den Takt der Verlaufsproben, falls er ruht
        return json({ ...sicht, verlauf: verlauf.sicht() });
      } catch (e) {
        return json({ fehler: `Messung fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}` }, 503);
      }
    }
    const ort = b && c ? ortVon(b, c) : null;
    if (!ort) return json({ fehler: "Sitzung nicht gefunden" }, 404);
    if (lesen && teile.length === 3) return json(await sitzungsDaten(ort));
    if (lesen && d === "ereignisse" && teile.length === 4) {
      server.timeout(req, 0);
      // Without a YAML yet, watch where `frage` will create it, or the page never sees the first
      // question. Watching only signals a reload; reading still goes through sitzungDa.
      const yaml = ort.yaml ?? (ort.repoPfad ? path.join(ort.repoPfad, ORDNER, `${ort.slug}.yaml`) : null);
      return ereignisse([...(yaml ? [yaml] : []), registerDatei(ort.slug)], req);
    }
    if (lesen && d === "baum" && teile.length === 4) {
      const baum = ort.repoPfad ? await baumVon(ort.repoPfad) : null;
      return baum ? json(baum) : json({ fehler: "Sitzung ohne Git-Wurzel" }, 404);
    }
    if (lesen && d === "firstmate" && teile.length === 4) {
      const home = ort.repoPfad && istFirstmateHome(ort.repoPfad) ? ort.repoPfad : null;
      return json(home ? await firstmateDaten(home) : { home: null });
    }
    if (lesen && d === "bild" && teile.length === 4) {
      const p = url.searchParams.get("p");
      if (!diffPfadGueltig(p)) return json({ fehler: "p muss ein relativer Pfad ohne .. sein" }, 400);
      if (!bildArtVon(p)) return json({ fehler: "Kein Bild (png, jpg, jpeg, gif, webp, svg)" }, 415);
      const baum = ort.repoPfad ? await baumVon(ort.repoPfad) : null;
      if (!baum) return json({ fehler: "Sitzung ohne Git-Wurzel" }, 404);
      const branch = url.searchParams.get("branch");
      if (branch !== null) {
        const b = baum.but?.branches.find((x) => x.name === branch);
        if (!b?.basis || !b.dateien.some((x) => x.p === p && x.committet)) return json({ fehler: "Datei ist in diesem Branch nicht committet" }, 404);
        return bildAntwort(p, await branchBild(ort.repoPfad!, b.name, p));
      }
      const zugang = dateiZugang(ort, baum, p, req, server);
      if (zugang instanceof Response) return zugang;
      if (zugang.eintrag?.s === "D") return json({ fehler: "Datei ist geloescht" }, 404);
      const voll = zugang.ignoriert ? ignorierterPfad(ort.repoPfad!, p) : path.join(ort.repoPfad!, p);
      return bildAntwort(p, voll ? liesBild(voll) : null);
    }
    // Brief, Bericht, Zeitleiste und Dateiliste einer Aufgabe; Anweisungen und Berichte sind mehr als
    // der Status im Kopf der Seite, daher nur fuer Aufrufe vom eigenen Rechner (wie git-ignorierte Dateien).
    if (lesen && d === "firstmate" && teile.length === 6 && teile[4] === "aufgabe") {
      const home = ort.repoPfad && istFirstmateHome(ort.repoPfad) ? ort.repoPfad : null;
      if (!home) return json({ fehler: "Sitzung ohne Firstmate-Home" }, 404);
      if (!istLoopback(server.requestIP(req)?.address)) return json({ fehler: "Anweisungen und Berichte nur fuer Aufrufe vom eigenen Rechner" }, 403);
      if (!gueltigeAufgabenId(teile[5]!)) return json({ fehler: "Id darf nur aus A-Z a-z 0-9 . _ - bestehen" }, 400);
      const detail = aufgabeDetail(home, teile[5]!);
      return detail ? json(detail) : json({ fehler: "Aufgabe unbekannt" }, 404);
    }
    if (lesen && d === "diff" && teile.length === 4) {
      const p = url.searchParams.get("p");
      if (!diffPfadGueltig(p)) return json({ fehler: "p muss ein relativer Pfad ohne .. sein" }, 400);
      const baum = ort.repoPfad ? await baumVon(ort.repoPfad) : null;
      if (!baum) return json({ fehler: "Sitzung ohne Git-Wurzel" }, 404);
      const branch = url.searchParams.get("branch");
      if (branch !== null) {
        // Only a branch and a committed file from the tree's but groups; a measured branch has a valid name and basis.
        const b = baum.but?.branches.find((x) => x.name === branch);
        if (!b?.basis || !b.dateien.some((x) => x.p === p && x.committet)) return json({ fehler: "Datei ist in diesem Branch nicht committet" }, 404);
        const antwort = await branchDiffVon(ort.repoPfad!, b.basis, b.name, p);
        return antwort ? json(antwort) : json({ fehler: "git diff fehlgeschlagen" }, 500);
      }
      const zugang = dateiZugang(ort, baum, p, req, server);
      if (zugang instanceof Response) return zugang;
      if (zugang.ignoriert) {
        const antwort = ignoriertVon(ort.repoPfad!, p);
        return antwort ? json(antwort) : json({ fehler: "Datei nicht lesbar oder nicht in der Wurzel der Sitzung" }, 404);
      }
      const eintrag = zugang.eintrag!;
      const antwort = await diffVon(ort.repoPfad!, eintrag);
      return antwort ? json(antwort) : json({ fehler: "git diff fehlgeschlagen" }, 500);
    }
    // Entscheiden und Warten brauchen die YAML; eine Sitzung nur im Register hat keine.
    const pfad = ort.yaml;
    if (!pfad) return json({ fehler: "Sitzung ohne .live-plan/SLUG.yaml" }, 404);
    if (req.method === "POST" && d === "entscheidung" && teile.length === 4) {
      const art = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (art !== "application/json") return json({ fehler: "Inhaltstyp application/json erwartet" }, 415);
      const roh = await liesKoerper(req, KOERPER_HOECHSTENS);
      if (roh === null) return json({ fehler: `Koerper groesser als ${KOERPER_HOECHSTENS} Bytes` }, 413);
      let koerper: { frage?: unknown; wahl?: unknown; eigen?: unknown };
      try {
        koerper = JSON.parse(roh) as { frage?: unknown; wahl?: unknown; eigen?: unknown };
      } catch {
        return json({ fehler: "JSON mit frage und wahl erwartet" }, 400);
      }
      if (typeof koerper?.frage !== "string" || typeof koerper?.wahl !== "string") return json({ fehler: "frage und wahl muessen Text sein" }, 400);
      // Only the boolean true makes `wahl` free text; anything else keeps the label rule.
      const ergebnis = await setzeEntscheidung(pfad, koerper.frage, koerper.wahl, koerper.eigen === true);
      if (ergebnis.art === "unbekannt") return json({ fehler: `Frage ${koerper.frage} unbekannt` }, 404);
      if (ergebnis.art === "ungueltig") return json({ fehler: ergebnis.grund }, 422);
      if (ergebnis.art === "nicht-aenderbar") return json({ fehler: ergebnis.grund }, 409);
      if (ergebnis.art === "fehler") return json({ fehler: ergebnis.grund }, 500);
      await liesSitzung(pfad);
      return json({ ok: true });
    }
    // Die Mod zieht eine Frage zurueck, die die Sitzung ohne Entscheidung geschlossen hat (#27).
    if (req.method === "POST" && d === "zurueckziehen" && teile.length === 4) {
      const art = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (art !== "application/json") return json({ fehler: "Inhaltstyp application/json erwartet" }, 415);
      const roh = await liesKoerper(req, KOERPER_HOECHSTENS);
      if (roh === null) return json({ fehler: `Koerper groesser als ${KOERPER_HOECHSTENS} Bytes` }, 413);
      let koerper: { frage?: unknown; grund?: unknown };
      try {
        koerper = JSON.parse(roh) as { frage?: unknown; grund?: unknown };
      } catch {
        return json({ fehler: "JSON mit frage und grund erwartet" }, 400);
      }
      if (typeof koerper?.frage !== "string") return json({ fehler: "frage muss Text sein" }, 400);
      const ergebnis = await zieheZurueck(pfad, koerper.frage, koerper.grund);
      if (ergebnis.art === "unbekannt") return json({ fehler: `Frage ${koerper.frage} unbekannt` }, 404);
      // Das Feld `entschieden` sagt es der Mod (schonEntschieden), `fehler` dem Menschen.
      if (ergebnis.art === "entschieden") return json({ fehler: `${koerper.frage} ist schon entschieden (${ergebnis.entscheidung})`, entschieden: ergebnis.entscheidung }, 409);
      if (ergebnis.art === "nicht-aenderbar") return json({ fehler: ergebnis.grund }, 409);
      if (ergebnis.art === "fehler") return json({ fehler: ergebnis.grund }, 500);
      await liesSitzung(pfad);
      return json({ ok: true });
    }
    if (lesen && d === "warte" && teile.length === 4) {
      server.timeout(req, 0);
      const seit = Number.parseInt(url.searchParams.get("seit") ?? "0", 10);
      const hoechstens = Number.parseInt(url.searchParams.get("hoechstens_ms") ?? "", 10);
      const frist = Number.isInteger(hoechstens) && hoechstens > 0 ? Math.min(hoechstens, WARTE_HOECHSTENS_MS) : WARTE_HOECHSTENS_MS;
      return text(await warte(pfad, Number.isInteger(seit) && seit >= 0 ? seit : 0, frist, req.signal));
    }
    return json({ fehler: "Nicht gefunden" }, 404);
  }
  if (lesen && a === "beleg" && teile.length >= 4) {
    // Belege nur zu einer bestehenden Sitzung, aus ihrem echten Belegordner, ohne Symlink (S-2).
    const ort = ortVon(b!, c!);
    if (!ort?.yaml) return text("Beleg nicht gefunden\n", 404);
    const ziel = belegVon(ort, teile.slice(3).join("/"));
    return istBelegDatei(ziel) ? datei(ziel!, 200, RASTER.has(path.extname(ziel!).toLowerCase()) ? RASTER_KOPF : BELEG_KOPF) : text("Beleg nicht gefunden\n", 404);
  }
  if (lesen && teile.length === 2) return seite(ortVon(a!, b!) ? 200 : 404);
  return text("Nicht gefunden\n", 404);
}

const server = Bun.serve({
  hostname: "0.0.0.0",
  port: PORT,
  // Ohne Entwicklerseite: ein unerwarteter Fehler zeigt dem Browser keinen Stacktrace (K-1).
  development: false,
  async fetch(req, srv) {
    const frei = belegt();
    try {
      return await antworte(req, srv);
    } catch (e) {
      if (!(e instanceof Unsicher)) console.error(e);
      const meldung = (e as Error).message;
      return istApi(req) ? json({ fehler: meldung }, 500) : text(`Fehler: ${meldung}\n`, 500);
    } finally {
      frei();
    }
  },
});

console.log(`live-plan: http://${server.hostname}:${server.port} wurzel=${WURZELN.join(":")} pid=${process.pid} leerlauf_ms=${LEERLAUF_MS}`);
