// live-plan: Tests der Ansagen (Sprechtext, Kuerzen, Speicher, Sperre, Einstellungen, `live-plan sage`), `node --test ansagen.test.ts` (sage braucht bun).

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ANSAGEN_HOECHSTENS, EINSTELLUNGEN_VORGABE, LESEN_HOECHSTENS, TEXT_HOECHSTENS, einstellungenAus, einstellungenMit, einstellungenYaml, ansageText, ansagenAus, ansagenDatei, istTrivial, kappeText, kurzAnsage, leseAnsagen, saetze, schonAngesagt, schreibeAnsage, sprechText, type Ansage } from "./ansagen.ts";

const ANTWORT = `## Ergebnis

Ich habe **drei Dateien** geändert, z. B. \`server.ts\` und [die README](https://github.com/x/y). Die Tests laufen grün ✅.

\`\`\`bash
rm -rf /tmp/x
\`\`\`

| Datei | Zeilen |
|---|---|
| server.ts | 12 |

- PR: https://github.com/niclasedge/live-plan/pull/16
- Nächster Schritt -> Review am 13. Oktober
`;

test("sprechText: ohne Codeblock, Tabelle, URL, Ueberschrift, Emoji und Markdown-Zeichen; ein Link wird sein Text", () => {
  const t = sprechText(ANTWORT);
  assert.equal(t, "Ich habe drei Dateien geändert, z. B. server.ts und die README. Die Tests laufen grün. Nächster Schritt, Review am 13. Oktober.");
  for (const nie of ["http", "github.com", "rm -rf", "|", "*", "`", "#", "✅", "Ergebnis", "PR"]) assert.ok(!t.includes(nie), nie);
});

test("sprechText: Zitat, Liste, Hervorhebung, HTML und nackte www-Adresse", () => {
  assert.equal(sprechText("> Ein _wichtiger_ Hinweis\n1. erster Punkt\n* zweiter ~~alter~~ Punkt"), "Ein wichtiger Hinweis. erster Punkt. zweiter alter Punkt.");
  assert.equal(sprechText("Mehr unter www.example.com, danach <b>fett</b> (https://a.b/c) weiter!"), "Mehr unter, danach fett weiter!");
  assert.equal(sprechText("Siehe https://x.y/z. Dann weiter."), "Siehe. Dann weiter.");
  assert.equal(sprechText("snake_case_name bleibt lesbar"), "snake case name bleibt lesbar.");
});

test("sprechText: ein offener Codeblock verschluckt den Rest, Leeres bleibt leer", () => {
  assert.equal(sprechText("Vorher.\n~~~\ngeheim()\n"), "Vorher.");
  assert.equal(sprechText("```\nnur Code\n```"), "");
  assert.equal(sprechText(""), "");
});

test("saetze: Abkuerzungen und Datumsangaben trennen nicht", () => {
  assert.deepEqual(saetze("Das ist z. B. so. Am 13. Oktober bzw. danach. Version 2.1 kommt! Fertig?"), ["Das ist z. B. so.", "Am 13. Oktober bzw. danach.", "Version 2.1 kommt!", "Fertig?"]);
  assert.deepEqual(saetze("Es sind 3. Die Liste folgt."), ["Es sind 3.", "Die Liste folgt."]);
});

test("kurzAnsage: die ersten Saetze bis zur Grenze, ein zu langer erster an einer Wortgrenze mit …", () => {
  assert.equal(kurzAnsage("Eins. Zwei. Drei. Vier.", 3, 300), "Eins. Zwei. Drei.");
  assert.equal(kurzAnsage("Ein kurzer Satz. Ein deutlich laengerer zweiter Satz, der nicht mehr passt.", 3, 30), "Ein kurzer Satz.");
  const lang = kurzAnsage(`${"wort ".repeat(100)}ende.`, 3, 60);
  assert.ok(lang.length <= 60, lang);
  assert.match(lang, /^wort wort .*wort…$/);
});

test("istTrivial und ansageText: kurze Quittungen nicht, Antworten gekuerzt, eigene laenger", () => {
  assert.equal(istTrivial("Captain, shipshape."), true);
  assert.equal(istTrivial("Erledigt, der PR ist offen."), false);
  assert.equal(ansageText("Captain, shipshape.", "auto"), null);
  assert.equal(ansageText("```\ncode\n```", "auto"), null);
  // Selbst formuliert: auch kurz, bis sechs Saetze.
  assert.equal(ansageText("Build gruen.", "sage"), "Build gruen.");
  assert.equal(ansageText("A eins. B zwei. C drei. D vier. E fuenf. F sechs. G sieben.", "sage"), "A eins. B zwei. C drei. D vier. E fuenf. F sechs.");
});

// #26: die Zugende-Ansage nahm nur die ersten drei Saetze bis 300 Zeichen, oft blieb nur der erste.
const LANGE_ANTWORT = `Der Umbau der Ansagen ist fertig, die Zugende-Ansage liest jetzt den ganzen Antworttext vor und nicht nur den Anfang.

\`\`\`ts
const geheim = kurzAnsage(sauber, 3, 300);
\`\`\`

Alle Tests laufen gruen, die der Ansagen ebenso wie die der Leiste auf der Seite einer Sitzung.
In der Leiste steht der ganze Text, eingeklappt auf zwei Zeilen, und ein Klick klappt ihn auf.
Die geschaetzte Dauer rechnet weiter mit dem gesprochenen Text, also mit dem ganzen.
Offen bleibt nur das Review, danach kann der Pull Request gemergt werden.
`;
const LANGE_ANSAGE = [
  "Der Umbau der Ansagen ist fertig, die Zugende-Ansage liest jetzt den ganzen Antworttext vor und nicht nur den Anfang.",
  "Alle Tests laufen gruen, die der Ansagen ebenso wie die der Leiste auf der Seite einer Sitzung.",
  "In der Leiste steht der ganze Text, eingeklappt auf zwei Zeilen, und ein Klick klappt ihn auf.",
  "Die geschaetzte Dauer rechnet weiter mit dem gesprochenen Text, also mit dem ganzen.",
  "Offen bleibt nur das Review, danach kann der Pull Request gemergt werden.",
].join(" ");

test("ansageText auto: der ganze Sprechtext der Antwort, alle Saetze ueber 300 Zeichen hinaus, ohne Codeblock (#26)", () => {
  const text = ansageText(LANGE_ANTWORT, "auto");
  assert.equal(text, LANGE_ANSAGE);
  assert.ok(text!.length > 300, String(text!.length));
  assert.equal(saetze(text!).length, 5);
  for (const nie of ["geheim", "kurzAnsage", "const", "```"]) assert.ok(!text!.includes(nie), nie);
  // Vorher: "Eins ist fertig. Zwei ist fertig. Drei ist fertig." – der vierte Satz fiel weg.
  assert.equal(ansageText("Eins ist fertig. Zwei ist fertig. Drei ist fertig. Vier ist fertig.", "auto"), "Eins ist fertig. Zwei ist fertig. Drei ist fertig. Vier ist fertig.");
});

test("kappeText: kurz bleibt, lang endet am letzten ganzen Satz vor der Grenze, ein riesiger Satz an einer Wortgrenze mit …", () => {
  assert.equal(kappeText("Eins. Zwei.", 100), "Eins. Zwei.");
  assert.equal(kappeText("Eins ist fertig. Zwei ist fertig. Drei ist fertig.", 40), "Eins ist fertig. Zwei ist fertig.");
  // Ein kurzer Satz vor einem riesigen: nicht nur der kurze, sondern bis an die Grenze.
  const riese = kappeText(`Kurz. ${"wort ".repeat(100)}ende.`, 60);
  assert.ok(riese.length <= 60, riese);
  assert.match(riese, /^Kurz\. wort wort .*wort…$/);
});

test("ansageText auto: ein Sprechtext ueber TEXT_HOECHSTENS endet am letzten ganzen Satz davor", () => {
  assert.equal(TEXT_HOECHSTENS, 8000);
  const satz = "Dieser Satz ist ein Teil einer sehr langen Antwort am Ende eines Zugs.";
  const text = ansageText(Array.from({ length: 200 }, () => satz).join("\n"), "auto")!;
  assert.ok(text.length <= TEXT_HOECHSTENS && text.length > TEXT_HOECHSTENS - satz.length - 1, String(text.length));
  assert.ok(text.endsWith(satz), text.slice(-80));
});

const A = (zeit: number, extra: Partial<Ansage> = {}): Ansage => ({ v: 1, zeit, id: "s-1", repo: "proj", text: `Ansage ${zeit}.`, quelle: "auto", ...extra });

test("ansagenAus: kaputte und fremde Zeilen fallen weg, ein zu langer Text wird gekappt statt verworfen, URLs auch im gespeicherten Text, die letzten n", () => {
  const zeilen = [
    JSON.stringify(A(1)),
    "{kaputt",
    JSON.stringify({ ...A(2), v: 2 }),
    JSON.stringify({ ...A(3), id: "../x" }),
    JSON.stringify({ ...A(4), quelle: "fremd" }),
    JSON.stringify({ ...A(5), text: "Ein Satz. ".repeat(1000) }),
    JSON.stringify({ ...A(6), text: "Siehe https://geheim.example/pfad bitte." }),
    JSON.stringify({ ...A(7), id: null, quelle: "sage" }),
    "",
  ].join("\n");
  const liste = ansagenAus(zeilen);
  assert.deepEqual(liste.map((a) => a.zeit), [1, 5, 6, 7]);
  assert.ok(liste[1]!.text.length <= TEXT_HOECHSTENS && liste[1]!.text.endsWith("Ein Satz."), String(liste[1]!.text.length));
  assert.equal(liste[2]!.text, "Siehe bitte.");
  assert.deepEqual(ansagenAus(zeilen, 2).map((a) => a.zeit), [6, 7]);
  assert.deepEqual(ansagenAus(""), []);
});

test("schreibeAnsage: haengt an, haelt die Datei bei hoechstens n plus Puffer, liest das Ende", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "live-plan-ansagen-"));
  try {
    const datei = ansagenDatei(path.join(tmp, "cache"));
    assert.deepEqual(leseAnsagen(datei), []);
    for (let i = 1; i <= 80; i++) schreibeAnsage(datei, A(i), 20);
    const zeilen = readFileSync(datei, "utf8").trim().split("\n");
    assert.ok(zeilen.length <= 20 + 50, String(zeilen.length));
    assert.ok(zeilen.length >= 20, String(zeilen.length));
    assert.deepEqual(leseAnsagen(datei, 20).map((a) => a.zeit), Array.from({ length: 20 }, (_, i) => 61 + i));
    assert.equal(ANSAGEN_HOECHSTENS, 200);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("schreibeAnsage: lange Ansagen halten die Datei bei hoechstens LESEN_HOECHSTENS, auch unter n plus Puffer Zeilen", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "live-plan-ansagen-"));
  try {
    const datei = ansagenDatei(tmp);
    // Gut 7 700 Zeichen je Ansage: 150 davon sind ueber 1 MiB, aber weniger Zeilen als n plus Puffer.
    const text = "Ein langer Satz einer langen Ansage. ".repeat(210).trim();
    for (let i = 1; i <= 150; i++) schreibeAnsage(datei, A(i, { text }));
    assert.ok(statSync(datei).size <= LESEN_HOECHSTENS, String(statSync(datei).size));
    // Gekuerzt wird nur vorne: die gelesenen enden mit der letzten und sind lueckenlos.
    const zeiten = leseAnsagen(datei).map((a) => a.zeit);
    assert.ok(zeiten.length >= 100, String(zeiten.length));
    assert.deepEqual(zeiten, Array.from({ length: zeiten.length }, (_, i) => 151 - zeiten.length + i));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("leseAnsagen und schreibeAnsage: ein Symlink wird weder gelesen noch beschrieben", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "live-plan-ansagen-"));
  try {
    const fremd = path.join(tmp, "fremd.jsonl");
    writeFileSync(fremd, `${JSON.stringify(A(1))}\n`);
    const datei = ansagenDatei(tmp);
    symlinkSync(fremd, datei);
    assert.deepEqual(leseAnsagen(datei), []);
    assert.throws(() => schreibeAnsage(datei, A(2)));
    assert.equal(readFileSync(fremd, "utf8"), `${JSON.stringify(A(1))}\n`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("schonAngesagt: nur eine eigene Ansage derselben Sitzung seit dem Start des Zugs", () => {
  const liste = [A(100, { quelle: "sage" }), A(200), A(300, { quelle: "sage", id: "s-2" })];
  assert.equal(schonAngesagt(liste, "s-1", 50), true);
  assert.equal(schonAngesagt(liste, "s-1", 150), false);
  assert.equal(schonAngesagt(liste, "s-2", 250), true);
  assert.equal(schonAngesagt(liste, "s-3", 0), false);
});

test("schreibeAnsage: wartet auf eine besetzte Sperre, haengt danach ohne Kuerzen an und gibt sie frei", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "live-plan-ansagen-"));
  try {
    const datei = ansagenDatei(tmp);
    for (let i = 1; i <= 75; i++) schreibeAnsage(datei, A(i), 20);
    const vorher = readFileSync(datei, "utf8").trim().split("\n").length;
    writeFileSync(`${datei}.sperre`, "");
    const start = Date.now();
    schreibeAnsage(datei, A(76), 20);
    assert.ok(Date.now() - start >= 1500, "wartet auf die Sperre");
    // Angehaengt, aber nicht gekuerzt; die fremde Sperre bleibt.
    assert.equal(readFileSync(datei, "utf8").trim().split("\n").length, vorher + 1);
    assert.ok(existsSync(`${datei}.sperre`));
    // Eine verwaiste Sperre (aelter als 10 s) wird genommen und wieder freigegeben; nichts ging verloren.
    utimesSync(`${datei}.sperre`, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    schreibeAnsage(datei, A(77), 20);
    assert.ok(!existsSync(`${datei}.sperre`));
    assert.deepEqual(leseAnsagen(datei, 100).map((a) => a.zeit), Array.from({ length: 26 }, (_, i) => 52 + i));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("schreibeAnsage: gleichzeitige Schreiber verlieren beim Kuerzen keine Ansage", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "live-plan-ansagen-"));
  try {
    const datei = ansagenDatei(tmp);
    const modul = path.join(import.meta.dirname, "ansagen.ts");
    const schreiber = (p: number) =>
      new Promise<void>((ok, fehler) => {
        const code = `const m = await import(${JSON.stringify(modul)}); for (let i = 0; i < 60; i++) m.schreibeAnsage(${JSON.stringify(datei)}, { v: 1, zeit: Date.now(), id: "p${p}", repo: "proj", text: "Nummer " + i + ".", quelle: "auto" }, 20);`;
        const k = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "inherit" });
        k.on("exit", (c) => (c === 0 ? ok() : fehler(new Error(`Schreiber ${p}: Exit ${c}`))));
      });
    await Promise.all([1, 2, 3, 4].map(schreiber));
    // Kuerzen nimmt nur vorne weg: je Schreiber bleibt eine lueckenlose Folge, die mit seiner letzten Nummer endet.
    // Ohne die Sperre faellt der Test nicht jedes Mal (das Fenster ist kurz), aber oft.
    const liste = leseAnsagen(datei, 1000);
    assert.ok(liste.length >= 20, String(liste.length));
    for (const p of [1, 2, 3, 4]) {
      const nummern = liste.filter((a) => a.id === `p${p}`).map((a) => Number(/Nummer (\d+)/.exec(a.text)![1]));
      nummern.forEach((n, i) => assert.equal(n, nummern[0]! + i, `p${p}: ${nummern.join(",")}`));
      if (nummern.length) assert.equal(nummern.at(-1), 59, `p${p}: ${nummern.join(",")}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("Einstellungen: Vorgabe bei Fehlendem und Kaputtem, Aenderung nur mit passenden Feldern, YAML", () => {
  assert.deepEqual(EINSTELLUNGEN_VORGABE, { vorlesen: false, stimme: null });
  for (const roh of [null, undefined, "kaputt", [1], {}, { vorlesen: "ja", stimme: 3 }]) assert.deepEqual(einstellungenAus(roh), EINSTELLUNGEN_VORGABE, JSON.stringify(roh));
  assert.deepEqual(einstellungenAus({ vorlesen: true, stimme: " Anna " }), { vorlesen: true, stimme: "Anna" });
  assert.deepEqual(einstellungenAus({ stimme: "x".repeat(201) }), EINSTELLUNGEN_VORGABE);
  const alt = { vorlesen: true, stimme: "Anna" };
  assert.deepEqual(einstellungenMit(alt, { vorlesen: false }), { vorlesen: false, stimme: "Anna" });
  assert.deepEqual(einstellungenMit(alt, { stimme: "Petra" }), { vorlesen: true, stimme: "Petra" });
  assert.deepEqual(einstellungenMit(alt, { stimme: null }), { vorlesen: true, stimme: null });
  assert.deepEqual(einstellungenMit(alt, { stimme: "" }), { vorlesen: true, stimme: null });
  for (const falsch of [null, [], "x", { vorlesen: 1 }, { stimme: 5 }, { stimme: "a\nb" }]) assert.equal(einstellungenMit(alt, falsch), null, JSON.stringify(falsch));
  assert.equal(einstellungenYaml({ vorlesen: true, stimme: 'Anna "de"' }).split("\n").slice(1).join("\n"), 'vorlesen: true\nstimme: "Anna \\"de\\""\n');
  assert.match(einstellungenYaml(EINSTELLUNGEN_VORGABE), /^vorlesen: false\nstimme: null$/m);
});

// --- live-plan sage gegen echte Dateien (bun) ---------------------------------------------------

function sage(cache: string, args: string[], opts: { stdin?: string; env?: Record<string, string> } = {}) {
  const env: Record<string, string | undefined> = { ...process.env, LIVE_PLAN_CACHE: cache, CLAUDE_SESSION_ID: "", ...opts.env };
  return spawnSync("bun", [path.join(import.meta.dirname, "live-plan"), "sage", ...args], { cwd: import.meta.dirname, env, input: opts.stdin ?? "", encoding: "utf8" });
}

/** Das Repo, das sage ohne --repo nennt: der Ordnername der Git-Wurzel dieses Checkouts (nicht immer "live-plan"). */
function eigenesRepo(): string {
  const lauf = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: import.meta.dirname, encoding: "utf8" });
  return path.basename(lauf.status === 0 && lauf.stdout.trim() ? lauf.stdout.trim() : import.meta.dirname);
}

test("live-plan sage: eigene Ansage mit Sitzung und Repo; danach entfaellt die automatische dieses Zugs", (t) => {
  if (spawnSync("bun", ["--version"]).status !== 0) return t.skip("bun fehlt");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "live-plan-sage-"));
  try {
    const seit = Date.now() - 1000;
    const eigen = sage(tmp, ["Der **Build** ist grün, siehe https://x.y/z."], { env: { CLAUDE_SESSION_ID: "s-1" } });
    assert.equal(eigen.status, 0, eigen.stderr);
    const repo = eigenesRepo();
    assert.ok(eigen.stdout.split("\n").includes(`angesagt: ${repo}: Der Build ist grün, siehe.`), eigen.stdout);
    const antwort = "Die Arbeit ist erledigt und der PR wartet. Zweiter Satz der Antwort.";
    assert.equal(sage(tmp, ["--auto", "--id", "s-1", "--seit", String(seit), "--repo", "proj"], { stdin: antwort }).status, 0);
    assert.equal(sage(tmp, ["--auto", "--id", "s-2", "--seit", String(seit), "--repo", "proj"], { stdin: antwort }).status, 0);
    assert.equal(sage(tmp, ["--auto", "--id", "s-3", "--seit", String(seit)], { stdin: "Captain, shipshape." }).status, 0);
    const liste = leseAnsagen(ansagenDatei(tmp));
    assert.deepEqual(liste.map((a) => [a.id, a.repo, a.quelle, a.text]), [
      ["s-1", repo, "sage", "Der Build ist grün, siehe."],
      ["s-2", "proj", "auto", antwort],
    ]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("live-plan sage --auto: speichert den ganzen Sprechtext einer langen Antwort, ohne Codeblock (#26)", (t) => {
  if (spawnSync("bun", ["--version"]).status !== 0) return t.skip("bun fehlt");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "live-plan-sage-"));
  try {
    const lauf = sage(tmp, ["--auto", "--id", "s-1", "--seit", String(Date.now() - 1000), "--repo", "proj"], { stdin: LANGE_ANTWORT });
    assert.equal(lauf.status, 0, lauf.stderr);
    assert.deepEqual(leseAnsagen(ansagenDatei(tmp)).map((a) => [a.quelle, a.text]), [["auto", LANGE_ANSAGE]]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("live-plan sage: ohne Text oder mit falscher Sitzung Exit 1, --auto ohne --seit auch", (t) => {
  if (spawnSync("bun", ["--version"]).status !== 0) return t.skip("bun fehlt");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "live-plan-sage-"));
  try {
    assert.equal(sage(tmp, []).status, 1);
    assert.equal(sage(tmp, ["`nur code`"]).status, 0);
    assert.equal(sage(tmp, ["```\ncode\n```"]).status, 1);
    assert.equal(sage(tmp, ["Hallo Welt"], { env: { CLAUDE_SESSION_ID: "../x" } }).status, 1);
    assert.equal(sage(tmp, ["--auto", "--id", "s-1"], { stdin: "Eine Antwort mit genug Worten." }).status, 1);
    assert.deepEqual(leseAnsagen(ansagenDatei(tmp)).map((a) => [a.id, a.text]), [[null, "nur code."]]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
