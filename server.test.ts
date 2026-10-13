// live-plan: Tests der Endpunkte .../diff und .../bild (Pfadregeln, git-ignorierte Dateien, Bilder, eigene Plan-Datei) und der Ansagen (/api/ansagen, /api/ereignisse, /api/einstellungen), `node --test server.test.ts` (startet `bun server.ts`).

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { BILD_HOECHSTENS } from "./logik.ts";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { geheimerName, istLoopback, registerBeruehrt } from "./logik.ts";
import type { Register } from "./logik.ts";

test("geheimerName: typische Secret-Namen, auch in einem Ordner", () => {
  for (const p of [".env", "a/.env.local", "x.pem", "tls/server.KEY", ".ssh/id_rsa", "id_ed25519.pub", "aws/credentials", "my-secret.txt", "secrets/notiz.md"]) assert.equal(geheimerName(p), true, p);
  for (const p of ["data/brief.md", "README.md", "env.md", "keys.md", "src/pemmican.ts"]) assert.equal(geheimerName(p), false, p);
});

test("istLoopback: 127.0.0.0/8 und ::1, auch als IPv4 in IPv6, sonst nicht", () => {
  for (const ip of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1", "::FFFF:127.0.0.5"]) assert.equal(istLoopback(ip), true, ip);
  for (const ip of ["192.168.178.65", "10.0.0.1", "::ffff:192.168.0.1", "fe80::1", "128.0.0.1", "127.0.0.1.evil", "", null, undefined]) assert.equal(istLoopback(ip), false, String(ip));
});

test("registerBeruehrt: nur ein gelesener oder geschriebener Pfad, Kaputtes faellt weg", () => {
  const r = { dateien: [{ pfad: "a.md", gelesen: 1, n: 1 }, { pfad: "b.md", geschrieben: 2, n: 1 }, { pfad: "c.md", n: 1 }, null, "d.md"] } as unknown as Register;
  assert.equal(registerBeruehrt(r, "a.md"), true);
  assert.equal(registerBeruehrt(r, "b.md"), true);
  assert.equal(registerBeruehrt(r, "c.md"), false);
  assert.equal(registerBeruehrt(r, "d.md"), false);
  assert.equal(registerBeruehrt(null, "a.md"), false);
  assert.equal(registerBeruehrt({ dateien: "a.md" } as unknown as Register, "a.md"), false);
});

// --- GET .../diff?p= gegen einen echten Server -------------------------------------------------

const ID = "sitzung-1";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>window.top.document.title="x"</script><rect width="4" height="4"/></svg>';
let tmp: string;
let server: ChildProcess;
let basis: string;
let lanBasis: string | null;
let bildBasis: string;
let lanBild: string | null;
let seite: string;
let cacheOrdner: string;

function freierPort(): Promise<number> {
  return new Promise((ok, fehler) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => ok(port));
    });
    s.on("error", fehler);
  });
}

before(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "live-plan-diff-"));
  const repo = path.join(tmp, "wurzel", "proj");
  const draussen = path.join(tmp, "draussen");
  mkdirSync(path.join(repo, "data"), { recursive: true });
  mkdirSync(path.join(repo, "assets"));
  mkdirSync(path.join(repo, ".live-plan"));
  mkdirSync(draussen);
  const git = (...args: string[]) => assert.equal(spawnSync("git", args, { cwd: repo }).status, 0, `git ${args.join(" ")}`);
  git("init", "-q");
  writeFileSync(path.join(repo, ".gitignore"), "data/\n.live-plan/\n");
  writeFileSync(path.join(repo, "assets", "pixel.png"), PNG);
  writeFileSync(path.join(repo, "assets", "logo.svg"), SVG);
  writeFileSync(path.join(repo, "config.yaml"), "name: demo\n");
  writeFileSync(path.join(repo, "README.md"), "# proj\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  writeFileSync(path.join(repo, "data", "brief.md"), "# Brief\nInhalt\n");
  writeFileSync(path.join(repo, "data", "andere.md"), "nicht beruehrt\n");
  writeFileSync(path.join(repo, "data", ".env"), "TOKEN=nicht-zeigen\n");
  writeFileSync(path.join(draussen, "notiz.md"), "ausserhalb\n");
  writeFileSync(path.join(repo, "config.yaml"), "name: demo\nneu: ja\n");
  writeFileSync(path.join(repo, "data", "bild.png"), PNG);
  writeFileSync(path.join(repo, "data", "unberuehrt.png"), PNG);
  writeFileSync(path.join(repo, "data", "secret.png"), PNG);
  writeFileSync(path.join(repo, "assets", "gross.png"), Buffer.alloc(BILD_HOECHSTENS + 1));
  writeFileSync(path.join(repo, "assets", "text.png"), "kein Bild, aber lesbar");
  symlinkSync(path.join(repo, "assets", "pixel.png"), path.join(repo, "assets", "link.png"));
  writeFileSync(path.join(draussen, "fremd.png"), PNG);
  writeFileSync(path.join(repo, ".live-plan", `${ID}.yaml`), "titel: Eigene Sitzung\n");
  writeFileSync(path.join(repo, ".live-plan", "andere.yaml"), "titel: Fremde Sitzung\n");
  symlinkSync(draussen, path.join(repo, "data", "raus"));

  const cache = path.join(tmp, "cache");
  cacheOrdner = cache;
  mkdirSync(path.join(cache, "sitzungen"), { recursive: true });
  const dateien = ["data/brief.md", "data/.env", "data/raus/notiz.md", "data/bild.png", "data/secret.png", "data/raus/fremd.png"].map((pfad) => ({ pfad, gelesen: 1, n: 1 }));
  const register = { v: 1, id: ID, cwd: repo, wurzel: repo, repo: "proj", modell: "m", gestartet: 0, aktualisiert: 0, haupt: { zuege: 0 }, fortschritt: null, agenten: [], dateien };
  writeFileSync(path.join(cache, "sitzungen", `${ID}.json`), JSON.stringify(register));

  const port = await freierPort();
  basis = `http://localhost:${port}/api/proj/${ID}/diff?p=`;
  bildBasis = `http://localhost:${port}/api/proj/${ID}/bild?p=`;
  seite = `http://localhost:${port}`;
  const lan = Object.values(os.networkInterfaces()).flat().find((n) => n && n.family === "IPv4" && !n.internal);
  lanBasis = lan ? `http://${lan.address}:${port}/api/proj/${ID}/diff?p=` : null;
  lanBild = lan ? `http://${lan.address}:${port}/api/proj/${ID}/bild?p=` : null;
  server = spawn("bun", [path.join(import.meta.dirname, "server.ts")], {
    env: { ...process.env, LIVE_PLAN_PORT: String(port), LIVE_PLAN_CACHE: cache, LIVE_PLAN_WURZEL: path.join(tmp, "wurzel") },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://localhost:${port}/api/gesund`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Server startet nicht");
});

after(() => {
  server?.kill();
  rmSync(tmp, { recursive: true, force: true });
});

const hole = async (p: string, von = basis, kopf: Record<string, string> = {}) => {
  const r = await fetch(von + encodeURIComponent(p), { headers: kopf });
  return { status: r.status, body: (await r.json()) as { art?: string; text?: string; fehler?: string } };
};

test("diff: eine git-ignorierte Datei, die die Sitzung gelesen hat, zeigt ihren Inhalt", async () => {
  const { status, body } = await hole("data/brief.md");
  assert.equal(status, 200);
  assert.equal(body.art, "datei");
  assert.equal(body.text, "# Brief\nInhalt\n");
});

test("diff: eine git-ignorierte Datei von einem anderen Rechner wird verweigert, auch mit X-Forwarded-For", async (t) => {
  if (!lanBasis) return t.skip("keine Nicht-Loopback-Adresse an diesem Rechner");
  for (const kopf of [{}, { "X-Forwarded-For": "127.0.0.1", "X-Real-IP": "127.0.0.1" }]) {
    const { status, body } = await hole("data/brief.md", lanBasis, kopf);
    assert.equal(status, 403);
    assert.match(body.fehler ?? "", /eigenen Rechner/);
    assert.doesNotMatch(JSON.stringify(body), /Inhalt\n/);
  }
  const imBaum = await hole("README.md", lanBasis);
  assert.equal(imBaum.status, 200);
});

test("diff: eine git-ignorierte Datei ohne Eintrag im Register bleibt 404", async () => {
  const { status, body } = await hole("data/andere.md");
  assert.equal(status, 404);
  assert.equal(body.fehler, "Datei steht nicht im Dateibaum");
});

test("diff: eine beruehrte Datei mit Secret-Namen wird verweigert", async () => {
  const { status, body } = await hole("data/.env");
  assert.equal(status, 403);
  assert.match(body.fehler ?? "", /Secret/);
  assert.doesNotMatch(JSON.stringify(body), /nicht-zeigen/);
});

test("diff: ein Pfad, der die Wurzel verlaesst, wird verweigert", async () => {
  const raus = await hole("data/raus/notiz.md");
  assert.equal(raus.status, 404);
  assert.doesNotMatch(JSON.stringify(raus.body), /ausserhalb/);
  const oben = await hole("../draussen/notiz.md");
  assert.equal(oben.status, 400);
});

test("diff: eine Datei im Baum bleibt wie bisher", async () => {
  const { status, body } = await hole("README.md");
  assert.equal(status, 200);
  assert.equal(body.text, "# proj\n");
});

// --- YAML und die eigene Plan-Datei -------------------------------------------------------------

test("diff: eine YAML im Baum zeigt ihren Text wie jede Textdatei", async () => {
  const { status, body } = await hole("config.yaml");
  assert.equal(status, 200);
  assert.equal(body.art, "diff");
  assert.match(body.text ?? "", /\+neu: ja/);
});

test("diff: die eigene Plan-Datei der Sitzung zeigt ihren Text, auch ohne Eintrag im Register", async () => {
  const { status, body } = await hole(`.live-plan/${ID}.yaml`);
  assert.equal(status, 200);
  assert.equal(body.art, "datei");
  assert.equal(body.text, "titel: Eigene Sitzung\n");
});

test("diff: die Plan-Datei einer anderen Sitzung bleibt 404", async () => {
  const { status, body } = await hole(".live-plan/andere.yaml");
  assert.equal(status, 404);
  assert.equal(body.fehler, "Datei steht nicht im Dateibaum");
});

// --- GET .../bild?p= ----------------------------------------------------------------------------

const holeBild = async (p: string, von = bildBasis, kopf: Record<string, string> = {}) => {
  const r = await fetch(von + encodeURIComponent(p), { headers: kopf });
  return { status: r.status, kopf: r.headers, bytes: Buffer.from(await r.arrayBuffer()) };
};
const fehlerVon = (b: Buffer) => (JSON.parse(b.toString()) as { fehler?: string }).fehler ?? "";

test("bild: ein PNG im Baum kommt als Rohbytes mit seinem Inhaltstyp", async () => {
  const { status, kopf, bytes } = await holeBild("assets/pixel.png");
  assert.equal(status, 200);
  assert.equal(kopf.get("content-type"), "image/png");
  assert.equal(kopf.get("x-content-type-options"), "nosniff");
  assert.deepEqual(bytes, PNG);
});

test("bild: der Inhaltstyp folgt der Endung (svg als image/svg+xml, nie als Seite)", async () => {
  const { status, kopf, bytes } = await holeBild("assets/logo.svg");
  assert.equal(status, 200);
  assert.equal(kopf.get("content-type"), "image/svg+xml");
  assert.match(kopf.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(kopf.get("content-security-policy") ?? "", /sandbox/);
  assert.equal(bytes.toString(), SVG);
});

test("bild: eine Endung, die kein Bild ist, wird verweigert", async () => {
  for (const p of ["config.yaml", "README.md", "assets"]) {
    const { status, bytes } = await holeBild(p);
    assert.equal(status, 415, p);
    assert.match(fehlerVon(bytes), /Kein Bild/);
  }
});

test("bild: .. und fuehrender Schraegstrich werden verweigert", async () => {
  for (const p of ["../draussen/fremd.png", "/etc/x.png", "assets/../assets/pixel.png"]) assert.equal((await holeBild(p)).status, 400, p);
});

test("bild: ein Bild ueber dem Deckel gibt 413", async () => {
  const { status, bytes } = await holeBild("assets/gross.png");
  assert.equal(status, 413);
  assert.match(fehlerVon(bytes), /groesser/);
});

test("bild: ein Symlink wird nicht gefolgt", async () => {
  const { status } = await holeBild("assets/link.png");
  assert.equal(status, 404);
});

test("bild: ein git-ignoriertes Bild, das die Sitzung beruehrt hat, kommt nur vom eigenen Rechner", async (t) => {
  const ok = await holeBild("data/bild.png");
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.bytes, PNG);
  if (!lanBild) return t.skip("keine Nicht-Loopback-Adresse an diesem Rechner");
  for (const kopf of [{}, { "X-Forwarded-For": "127.0.0.1" }]) {
    const fremd = await holeBild("data/bild.png", lanBild, kopf);
    assert.equal(fremd.status, 403);
    assert.match(fehlerVon(fremd.bytes), /eigenen Rechner/);
  }
});

test("bild: ein git-ignoriertes Bild ohne Registereintrag bleibt 404, eines mit Secret-Namen 403", async () => {
  const frei = await holeBild("data/unberuehrt.png");
  assert.equal(frei.status, 404);
  assert.equal(fehlerVon(frei.bytes), "Datei steht nicht im Dateibaum");
  const geheim = await holeBild("data/secret.png");
  assert.equal(geheim.status, 403);
});

test("bild: ein Bild ueber einen Symlink-Ordner aus der Wurzel heraus wird nicht geliefert", async () => {
  const { status, bytes } = await holeBild("data/raus/fremd.png");
  assert.equal(status, 404);
  assert.notDeepEqual(bytes, PNG);
});

// --- GET /api/ansagen und der Strom der Uebersicht GET /api/ereignisse --------------------------------

/** Liest den Strom, bis `bis` im Text steht oder `ms` um sind; gibt den gelesenen Text. */
async function liesStrom(antwort: Response, bis: string, ms: number): Promise<string> {
  const leser = antwort.body!.getReader();
  const dekoder = new TextDecoder();
  let text = "";
  const ende = Date.now() + ms;
  while (!text.includes(bis) && Date.now() < ende) {
    const teil = await Promise.race([leser.read(), new Promise<null>((ok) => setTimeout(() => ok(null), Math.max(0, ende - Date.now())))]);
    if (!teil || teil.done) break;
    text += dekoder.decode(teil.value, { stream: true });
  }
  await leser.cancel().catch(() => undefined);
  return text;
}

test("ansagen: ohne Datei leer; eine neue Ansage meldet der Strom, die Liste kommt neueste zuerst und ohne URL", async () => {
  const leer = await fetch(`${seite}/api/ansagen`);
  assert.equal(leer.status, 200);
  assert.deepEqual(await leer.json(), { ansagen: [] });

  const strom = await fetch(`${seite}/api/ereignisse`);
  assert.equal(strom.headers.get("content-type"), "text/event-stream");
  const a = (zeit: number, text: string, quelle = "auto") => JSON.stringify({ v: 1, zeit, id: ID, repo: "proj", text, quelle });
  const gelesen = liesStrom(strom, "event: geaendert", 8000);
  await new Promise((r) => setTimeout(r, 300));
  writeFileSync(path.join(cacheOrdner, "ansagen.jsonl"), [a(1000, "Erste Ansage."), "{kaputt", a(2000, "Siehe https://geheim.example/x bitte.", "sage")].join("\n") + "\n");
  const text = await gelesen;
  assert.match(text, /event: bereit/);
  assert.match(text, /event: geaendert/);

  const r = await fetch(`${seite}/api/ansagen`);
  const body = (await r.json()) as { ansagen: { zeit: number; text: string; quelle: string; repo: string; id: string }[] };
  assert.deepEqual(body.ansagen.map((x) => [x.zeit, x.quelle, x.repo, x.id, x.text]), [
    [2000, "sage", "proj", ID, "Siehe bitte."],
    [1000, "auto", "proj", ID, "Erste Ansage."],
  ]);
});

test("ansagen: nur lesen, fremde Herkunft 403, Schreiben gibt es nicht", async () => {
  const fremd = await fetch(`${seite}/api/ansagen`, { headers: { Origin: "http://evil.example" } });
  assert.equal(fremd.status, 403);
  const fremdStrom = await fetch(`${seite}/api/ereignisse`, { headers: { Origin: "http://evil.example" } });
  assert.equal(fremdStrom.status, 403);
  const post = await fetch(`${seite}/api/ansagen`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(post.status, 404);
});

// --- GET und POST /api/einstellungen: Vorlesen und Stimme in LIVE_PLAN_CACHE/einstellungen.yaml -------------

const einstellungen = (body: unknown, kopf: Record<string, string> = {}) =>
  fetch(`${seite}/api/einstellungen`, { method: "POST", headers: { "content-type": "application/json", ...kopf }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("einstellungen: Vorgabe ohne Datei, POST schreibt die YAML, GET und der Strom sehen sie", async () => {
  assert.deepEqual(await (await fetch(`${seite}/api/einstellungen`)).json(), { vorlesen: false, stimme: null });
  const strom = await fetch(`${seite}/api/ereignisse`);
  const gelesen = liesStrom(strom, "event: geaendert", 8000);
  await new Promise((r) => setTimeout(r, 300));
  const r = await einstellungen({ vorlesen: true, stimme: 'Anna "de"' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { vorlesen: true, stimme: 'Anna "de"' });
  assert.match(await gelesen, /event: geaendert/);
  const yaml = readFileSync(path.join(cacheOrdner, "einstellungen.yaml"), "utf8");
  assert.match(yaml, /^vorlesen: true$/m);
  assert.match(yaml, /^stimme: "Anna \\"de\\""$/m);
  // Ein Feld allein aendert nur sich.
  assert.deepEqual(await (await einstellungen({ vorlesen: false })).json(), { vorlesen: false, stimme: 'Anna "de"' });
  assert.deepEqual(await (await fetch(`${seite}/api/einstellungen`)).json(), { vorlesen: false, stimme: 'Anna "de"' });
  assert.deepEqual(await (await einstellungen({ stimme: null })).json(), { vorlesen: false, stimme: null });
});

test("einstellungen: falsche Felder 422, kein JSON 400 oder 415, fremde Herkunft 403, alles ohne Schreiben", async () => {
  await einstellungen({ vorlesen: true, stimme: "Petra" });
  for (const falsch of [{ vorlesen: "ja" }, { stimme: 7 }, [], "null"]) assert.equal((await einstellungen(falsch)).status, 422, JSON.stringify(falsch));
  assert.equal((await einstellungen("{kaputt")).status, 400);
  assert.equal((await fetch(`${seite}/api/einstellungen`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, 415);
  assert.equal((await einstellungen({ stimme: "x".repeat(3000) })).status, 413);
  assert.equal((await einstellungen({ vorlesen: false }, { Origin: "http://evil.example" })).status, 403);
  assert.deepEqual(await (await fetch(`${seite}/api/einstellungen`)).json(), { vorlesen: true, stimme: "Petra" });
});

test("einstellungen: eine kaputte YAML gilt als Vorgabe und wird beim naechsten POST ersetzt", async () => {
  writeFileSync(path.join(cacheOrdner, "einstellungen.yaml"), "vorlesen: [kaputt\n");
  assert.deepEqual(await (await fetch(`${seite}/api/einstellungen`)).json(), { vorlesen: false, stimme: null });
  assert.deepEqual(await (await einstellungen({ vorlesen: true })).json(), { vorlesen: true, stimme: null });
  assert.match(readFileSync(path.join(cacheOrdner, "einstellungen.yaml"), "utf8"), /^vorlesen: true$/m);
});
