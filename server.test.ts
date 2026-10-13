// live-plan: Tests des Diff-Endpunkts fuer git-ignorierte Dateien, `node --test server.test.ts` (startet `bun server.ts`).

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
let tmp: string;
let server: ChildProcess;
let basis: string;
let lanBasis: string | null;

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
  mkdirSync(draussen);
  const git = (...args: string[]) => assert.equal(spawnSync("git", args, { cwd: repo }).status, 0, `git ${args.join(" ")}`);
  git("init", "-q");
  writeFileSync(path.join(repo, ".gitignore"), "data/\n");
  writeFileSync(path.join(repo, "README.md"), "# proj\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  writeFileSync(path.join(repo, "data", "brief.md"), "# Brief\nInhalt\n");
  writeFileSync(path.join(repo, "data", "andere.md"), "nicht beruehrt\n");
  writeFileSync(path.join(repo, "data", ".env"), "TOKEN=nicht-zeigen\n");
  writeFileSync(path.join(draussen, "notiz.md"), "ausserhalb\n");
  symlinkSync(draussen, path.join(repo, "data", "raus"));

  const cache = path.join(tmp, "cache");
  mkdirSync(path.join(cache, "sitzungen"), { recursive: true });
  const dateien = ["data/brief.md", "data/.env", "data/raus/notiz.md"].map((pfad) => ({ pfad, gelesen: 1, n: 1 }));
  const register = { v: 1, id: ID, cwd: repo, wurzel: repo, repo: "proj", modell: "m", gestartet: 0, aktualisiert: 0, haupt: { zuege: 0 }, fortschritt: null, agenten: [], dateien };
  writeFileSync(path.join(cache, "sitzungen", `${ID}.json`), JSON.stringify(register));

  const port = await freierPort();
  basis = `http://localhost:${port}/api/proj/${ID}/diff?p=`;
  const lan = Object.values(os.networkInterfaces()).flat().find((n) => n && n.family === "IPv4" && !n.internal);
  lanBasis = lan ? `http://${lan.address}:${port}/api/proj/${ID}/diff?p=` : null;
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
