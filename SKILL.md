---
name: live-plan
description: Fuehrt das lebende Dokument einer Sitzung (REPO/.live-plan/SLUG.yaml) mit eigener Browser-Ansicht - Fragen mit Optionen, Schritte in Bahnen und Wellen, Belege. Verwenden, sobald eine Planungs- oder Analysesitzung Entscheidungen des Menschen braucht oder mehrere Schritte und Agenten sichtbar fortschreiten sollen; statt einer HTML-Seite vom Agenten.
---

# Live-Plan

Eine Sitzung ist eine YAML-Datei im Repo. Der Server dieses Skills zeigt sie im Browser; ein
Klick des Menschen auf eine Option oder seine eigene Antwort schreibt `fragen[].entscheidung` in
die Datei. Alles andere schreiben Sie. Zeiten traegt der Server aus der Aenderungszeit der Datei
nach. Der Ordner dieses Skills ist in sich vollstaendig: er braucht nur `bun`.

## Skript

Das Startskript `live-plan` liegt neben dieser Datei. Rufen Sie es mit dem Pfad, unter dem Sie
diese Datei gelesen haben, aus dem Repo der Sitzung heraus:

```bash
LP=/pfad/zu/.claude/skills/live-plan/live-plan
$LP neu SLUG          # .live-plan/SLUG.yaml aus vorlage.yaml, .live-plan/ in .gitignore
$LP open SLUG         # Server starten falls noetig, URL ausgeben, Browser oeffnen
```

`open` gibt `http://localhost:4410/REPO/SLUG` aus. REPO ist der Ordnername der Git-Wurzel; der
Server sieht Repos direkt unter `~/git`, `~/GITHUB` und `~/GITHUB_DG`; `LIVE_PLAN_WURZEL` ersetzt
diese Liste (mehrere Wurzeln durch `:` getrennt, ein gleichnamiges Repo der ersten Wurzel geht vor).
Jeder Aufruf ist wiederholbar:
`neu` ueberschreibt keine Sitzung, `open` startet keinen zweiten Server. `$LP stop` beendet ihn,
nach 60 Minuten ohne Anfrage endet er selbst. SLUG aus `a-z`, `A-Z`, `0-9`, `-`, `_`, `.`.

## Register und Live-Block

Je Claude-Sitzung schreibt die Mod `live-plan-sitzung` eine JSON nach
`${LIVE_PLAN_CACHE:-~/.cache/live-plan}/sitzungen/<id>.json` (Vertrag v 1: Modell, Kontext,
Kosten, Zuege, `fortschritt`, `agenten`). Der Server liest sie nur; eine halbe oder kaputte Datei
ueberspringt er. Ihre `wurzel` macht auch Repos ausserhalb von `LIVE_PLAN_WURZEL` sichtbar: die
Sitzung steht in der Liste (Marke `live`) unter `/REPO/<id>`, aufgeloest ueber die Id, sodass zwei
gleichnamige Repos nicht kollidieren. Ohne `.live-plan/<id>.yaml` zeigt die Seite nur den
Live-Block; `/api/REPO/<id>` liefert die JSON zusaetzlich als `live`.

Seit Vertrag v1.1 traegt das Register optional `haupt.limits` (Rate-Limit-Fenster mit Prozent und
Reset), `haupt.limitsZeit`, `haupt.tokens` und `dateien` (von Claude gelesene und geschriebene
Pfade, hoechstens 400); der Server reicht sie unveraendert in `live` durch. `GET
/api/REPO/<id>/baum` liefert alle Dateien der Git-Wurzel der Sitzung (`git ls-files`, Status als
`M A D R ? U`, `+N -N` aus `git diff --numstat HEAD`, Zeilen fuer Unversioniertes), dazu Zweig,
Upstream und vor/zurueck; je Wurzel 3 s vorgehalten, ab 20000 Dateien `gekappt`, ohne Git-Wurzel 404.
Steht die Wurzel auf `gitbutler/workspace`, traegt die Antwort `but`: aus `but status --json` je
angewendetem Branch `{name, stack, basis, dateien}` -- committet gegen den Branch darunter im Stack
bzw. die mergeBase (`git diff`), dazu die dem Stack zugeordneten uncommitteten Aenderungen, je Datei
`committet`, `uncommittet` und `auch` (Branches anderer Stacks mit derselben Datei) -- und `ohne`
(nicht zugeordnet); sonst, ohne `but` oder bei einem Fehler `null`. Die Ansicht zeigt je Branch einen
aufklappbaren Abschnitt ueber dem Baum, mit Warnzeichen bei Ueberschneidung, danach "nicht zugeordnet".
`GET /api/REPO/<id>/diff?p=PFAD` liefert `{p, art, text, gekappt}` fuer eine Datei, die im Dateibaum
steht oder die das Register als gelesen oder geschrieben fuehrt (git-ignoriert: der Inhalt, nur fuer
Loopback, sonst 403, Regeln in README.md; sonst 404, ein Pfad mit `..` oder fuehrendem `/` 400):
geaendert oder geloescht `git diff HEAD`, unversioniert der Inhalt als neue Datei, ohne Marke der
Inhalt; Binaeres und Symlinks heissen `binaer` ohne Inhalt, der Text ist bei 512 KiB `gekappt`. Die Ansicht zeigt ihn im Diff-Modal.
Mit `&branch=NAME` gilt er einer Datei, die dieser but-Branch committet hat: `git diff` von seiner
Basis zum Branch; sonst 404.

Der Live-Block steht unter der Jetzt-Zeile: oben der Verbrauch in zwei Zeilen, darunter der
Fortschritt, wenn gesetzt, und die Agenten -- laufend, fertig (einklappbar), geplant (Aufgaben
ohne Agenten gleicher Beschreibung) -- mit hoechstens sechs sichtbaren Zeilen, der Rest hinter
`+N`. Im Druck bleiben Verbrauch, Kopfzeile und Fortschritt.

- Zeile `Sitzung`: Kosten, Tokens (Hauptsitzung und Agenten), Laufzeit, `ctx %` mit Mini-Balken
  │ Modell · Zuege │ Reserve frei/knapp/voll (Namen im title), danach weitere Limits wie Budget.
- Zeile `5h`: das aktive Konto gekuerzt (`vorname.nachname@firma` ergibt `v.n@f`, voll im title)
  und ein breiter Balken: Fuellung = Nutzung, ein 1-px-Strich an der Zeitposition im Fenster
  (Beginn = Reset minus 5 h) mit der Laufzeit, bei Prognose `voll-um` eine Schraffur bis zur
  gestrichelten Linie mit `voll in …`, rechts `Reset in …`; Uhrzeiten nur im title. Daneben
  `55 % · 1,3× zu schnell ⚠` (Nutzung / Zeitanteil, sonst `reicht`) │ `7 T` │ `→` Wechselziel.
  Ohne Abo-Daten zeigt die Zeile `five_hour` und `seven_day` aus `haupt.limits`, ohne Konto, Prognose und Tempo.

Die Abo-Daten: `GET /api/abo` fragt tollgate `GET ${ANTHROPIC_BASE_URL}/status`
und liefert `{abo: {aktiv, reserve: {frei, knapp, voll}, wechsel, alt}}` -- den aktiven Account mit
5h-Prognose (`voll-um`, `reicht`) und 7d, die uebrigen als Reserve, ohne E-Mail. Der Server liest
`ANTHROPIC_BASE_URL` und `ANTHROPIC_AUTH_TOKEN` aus seiner eigenen Umgebung, haelt die Antwort 60 s
vor, folgt keiner Umleitung und nennt den Token nirgends; fehlt eine der beiden, ist `abo` null und
Reserve und Konto entfallen, ein Fehler steht ohne Token als `fehler` daneben. Die Ansicht holt
sie beim Laden und alle 60 s.

```bash
$LP neu --auto        # SLUG = CLAUDE_SESSION_ID, .live-plan/ in .git/info/exclude statt .gitignore,
                      # still, wenn die Sitzung schon besteht (fuer Hooks)
```

Mit `--auto` (auch bei der Anlage ueber `frage`) traegt die Datei keine Beispiele der Vorlage:
`titel` ist der SLUG, `ziel` und `stand.thema` sind leer, alle Listen `[]`, nur `bahnen` und
`wellen` bleiben, weil das Schema je eine verlangt.

`neu` ohne SLUG nimmt `CLAUDE_SESSION_ID`; fehlt beides, bricht es ab. Ist `CLAUDE_SESSION_ID`
gesetzt, brechen `neu` und `frage` mit jedem anderen SLUG ab: eine Claude-Sitzung legt ihren Plan
nur unter ihrer Session-Id an, sonst steht er in der Liste doppelt. `open` startet auf macOS
den Browser mit `open`.

## Fortschreiben

Das Schema steht als Kommentar in `vorlage.yaml`. Aendern Sie einzelne Schluessel mit Edit, nie
die ganze Datei: `status: laeuft` beim Beginn, `status: fertig` samt `umsetzung` am Ende.
Schlaegt Edit fehl, weil die Datei sich geaendert hat, hat der Browser entschieden: neu lesen,
Edit wiederholen. Schemafehler zeigt die Seite oben rot mit Pfad; die gueltigen Teile bleiben
sichtbar. Die Seite laedt bei jeder Aenderung selbst neu.

## Ziel, Anforderungen, Entscheidungen

`ziel` steht im Kopf, auf zwei Zeilen gekuerzt (ein Klick zeigt alles). Zwei Bloecke pflegen Sie:

- `anforderungen`: was der Nutzer will, je Punkt `id: A<n>`, `text`, `quelle` (Nutzer, Agent,
  Review) und `erfuellt_mit: [S4, S7]`. Kommt eine neue Anforderung dazu, haengen Sie sie hinten
  an. Erfuellt ist sie, wenn alle genannten Schritte fertig sind (verworfene zaehlen nicht).
  Optional `beweis: shots/a7.png`: ein Bild in `.live-plan/SLUG/` (png, jpg, jpeg, gif, webp,
  svg), relativ und ohne `..`. Ohne `beweis` gilt das juengste `bild` aus den Belegen der
  Schritte in `erfuellt_mit`. Eine erfuellte Anforderung mit Bild traegt ein Bild-Icon: Zeigen
  oeffnet eine Vorschau, ein Klick das Bild gross (Esc schliesst).
- `entscheidungen`: Architektur- und Wegentscheidungen, je Punkt `id: E<n>`, `titel`, `grund`,
  `quelle` und `schritte`.

Der Kopf traegt Torte (Anteil fertiger Schritte) und Titel, rechts daneben klein den Git-Stand (Branch,
Dateien gegen `origin/main`, GitButler; der Pfad der Sitzungsdatei im title), darunter `doku.kurz` mit
`doku.untertitel` fett davor oder sonst das Ziel, dann `doku.status` und `doku.tags` als Marken.

Die Seite folgt der Vorlage (Things-Handout), von oben nach unten:

1. **Ueberblick**: `doku.ueberblick` als drei Karten Problem, Loesung, Fuer wen (ein Text als Absatz).
2. **Teil 1 Sitzung und Fortschritt** (rechts das Thema): Verbrauch aus dem Register; Fortschritt mit den
   fuenf Phasen und einem Segment je Aufgabe (`x / y erledigt · % · n laufen`); vier Kacheln (Geplant,
   Erledigt, Laeuft jetzt, Wartet auf Sie); genau eine Jetzt-Zeile (offene Fragen als Verweis, sonst
   laufende Schritte, sonst das Blatt `jetzt`, sonst das Thema); dann zwei Spalten -- links Agenten,
   Offen (Gate als Marke) und Anforderungen (Zustand als Marke), rechts Fragen an Sie (offene als Karte
   mit Optionen und eigener Antwort, entschiedene als Zeile mit der Wahl) und Entscheidungen (Quelle als
   Marke). Je Abschnitt die fuenf neuesten Eintraege; `+N aeltere` klappt den Rest an Ort und Stelle auf.
3. **Teil 2 Dokumentation** (nur mit `doku:`, siehe unten).
4. **Dateien**: der Baum des Repos mit dem, was Claude gelesen und geschrieben hat.
5. **Fuss**: `doku.quelle` und `doku.stand`, rechts die Sitzungsdatei.

Zeiten zeigt die Seite als verstrichene Zeit (`jetzt`, `13m`, `2h 13m`, `3T`), die volle Ortszeit beim
Zeigen; sie aktualisieren sich alle 30 Sekunden. Gedruckt (`Strg-P`) passt die Sitzung auf A4 quer: hell,
ohne Agentenzeilen und Dateien, je Abschnitt fuenf Eintraege und `+N aeltere` als Text.

## Stand

Der Block `stand` oben in der Datei haelt den Stand wie das Schaubild am Ende der Antwort.
Schreiben Sie ihn **mit jeder Antwort** fort. Die Seite zeigt davon nur `thema` und `offen`
(seit S26 keine feste Leiste mehr): das Blatt `jetzt` steht in der Jetzt-Zeile, sobald keine Frage
offen ist und kein Schritt laeuft, die uebrigen Blaetter im Abschnitt Offen, wartet auf Mensch
zuerst; dort steht das Gate als Zeichen (Wort beim Zeigen) und ein `befehl` nur als Kopierknopf,
damit der Text Platz hat. `erledigt` und `fragen` bleiben gueltig, erscheinen aber nicht -- Erledigtes zeigen
Kacheln und Fortschritt, Fragen der Abschnitt Fragen an Sie.

```yaml
stand:
  thema: live-plan als eigener Skill
  erledigt:
    - text: Tests 52/52 gruen
      beleg: d5cc01bf          # optional
  fragen:
    - text: Wer merged?
      wer: Mensch              # optional
  offen:
    - text: Review
      gate: jetzt              # jetzt | mensch | spaeter
      befehl: just pr kennung  # optional; Jetzt-Zeile: Code mit Kopierknopf, Offen: nur Kopierknopf
    - text: Merge freigeben
      gate: mensch             # erscheint als "wartet auf Mensch"
```

Hoechstens ein Blatt in `offen` traegt `gate: jetzt` (E8); `text` ist in jedem Blatt Pflicht. Verstoesse
stehen mit Pfad in der Fehlerliste der Seite, die gueltigen Blaetter bleiben sichtbar. Ohne
`stand` bleibt der Abschnitt Offen leer.

## Belege

Kopieren Sie Belege nach `.live-plan/SLUG/` und nennen Sie sie im Schritt relativ:

```yaml
    umsetzung:
      wie: Was gebaut wurde, in einem Satz
      dateien: [src/x.ts]
      belege:
        - bild: raster.png       # Datei in .live-plan/SLUG/
        - html: bericht.html     # erscheint im Sandbox-Rahmen
        - test: "14/14 gruen"
        - commit: 25ee5af3
```

## Auf Entscheidungen warten

```bash
$LP warte SLUG        # als Bash im Hintergrund starten und weiterarbeiten
```

Blockiert bis zur ersten neuen Entscheidung und gibt je Entscheidung `F1 = Bei Bedarf` aus,
dann `seit=M`. Die Position `M` merkt das Skript in `.live-plan/SLUG.seit`; der naechste Aufruf
liest ab dort. `--hoechstens MS` begrenzt das Warten, danach kommt nur `seit=M`. `grund` der
Frage duerfen Sie nachtragen.

## Fragen-Kanal

Mit der Mod `live-plan-sitzung` erscheint jedes AskUserQuestion als Frage im Browser, und ein
Klick dort beantwortet es. Entscheidet der Mensch eine Frage, die Sie selbst in die Datei
geschrieben haben, kommt die Wahl als Nachricht `live-plan: F2 = …` in die Sitzung. Ohne Mod
bleibt `warte` der Weg.

Eigene Antwort: Unter den Optionen jeder offenen Frage (ausser einer Sprengradius-Freigabe, Frage beginnt mit `Sprengradius:`) steht ein Feld „Eigene Antwort…“ mit
„Senden“, wie „Other“ in AskUserQuestion. Es schickt `{frage, wahl, eigen: true}`; der Server
nimmt den Text nach `trim` mit 1 bis 500 Zeichen, in einer Zeile, ohne Steuer- und Bidi-Zeichen,
sonst 422 mit Grund. In der Datei steht er nur in `entscheidung`, als JSON-Zeichenkette gequotet,
wo er sonst anders gelesen wuerde (`entscheidung: "123"`). Ein eigenes Feld `eigen` gibt es in
der Datei nicht: eine eigene Antwort ist eine Entscheidung, die kein `label` der Optionen ist. Die
Ansicht zeigt sie mit der Marke „eigene Antwort“, die Mod meldet sie als
`live-plan: F2 = (eigene Antwort) "…"` und spiegelt eine Chat-Antwort ausserhalb der Optionen
gekuerzt auf eine Zeile und 500 Zeichen.

```bash
echo '{"fragen":[{"frage":"Welche Variante?","kopf":"Variante","optionen":[{"label":"A","beschreibung":"billig","empfohlen":true},{"label":"B"}]}]}' \
  | $LP frage [SLUG]  # haengt F<n> an fragen: an, gibt {"ids":["F2"],"url":"..."} aus
$LP stand [SLUG] --kurz   # Stand als Klartext, hoechstens 1500 Zeichen; ohne Sitzung leer
```

`frage` vergibt die naechsten freien `F<n>`, schreibt `beschreibung` als `beispiel` und `grund`
(sonst `kopf`) als `grund`, liest das Ergebnis gegen und schreibt atomar; fehlt die Sitzung, legt
es sie wie `neu --auto` an. Bei einem Fehler endet es mit Exit 1 und Meldung auf stderr, die
Datei bleibt dann unveraendert. `stand --kurz` nennt Titel, Thema, das Blatt `jetzt`, offene
Fragen samt Optionen, laufende Schritte und die uebrigen Blaetter in Offen; die Mod setzt es in
den System-Prompt.

## Dokumentation und Handout

Ein optionaler Schluessel `doku:` in der Sitzungsdatei beschreibt, was die Sitzung gebaut hat:
`ueberblick` (Text, oder Objekt mit `problem`, `loesung`, `fuer_wen` fuer die drei Karten),
`bausteine[]` (`name`, `rolle` agent | helfer | daten | dienst | mensch, `text`, `ort`),
`ablauf` (`bahnen[]`, `schritte[]` mit `id`, `bahn`, `titel`, `detail`, `art`, `status` fertig | laeuft |
wartet | offen, dazu `kanten[]` mit `von`, `nach`, optional `text`), `befehle[]` (`befehl`, `text`) und
`regeln[]` (`text`, `art` immer | nie | tipp). Dazu, alle optional:

| Schluessel | Wo |
|---|---|
| `untertitel`, `kurz` | Kopf: Untertitel fett, dann der Kurztext statt des Ziels (das Ziel rueckt unter Teil 1) |
| `status`, `tags[]` | Kopf: Status als blaue Marke, Tags als graue |
| `stand`, `version` | Kopf von Teil 2; `stand` auch im Fuss |
| `quelle` | Fuss |
| `datei` (`titel`, `felder[]` mit `schluessel`, `inhalt`) | Teil 2 links: Aufbau der Sitzungsdatei |
| `ansicht` (`titel`, `zonen[]` mit `name`, `text`; `druck`) | Teil 2 rechts: Was die Seite zeigt |
| `register` (`titel`, `text`, `ort`, `felder[]`) | Teil 2 rechts: Aufbau des Registers |

Ein Beispiel steht auskommentiert am Ende von `vorlage.yaml`. Verstoesse stehen mit Pfad `doku...` in
der Fehlerliste, die gueltigen Teile bleiben. Teil 2 zeigt Ablauf mit Flowchart, links Bausteine,
Sitzungsdatei und Regeln, rechts Seite, Befehle und Register; ohne `doku:` erscheint nichts davon.

```bash
$LP handout [SLUG]    # PNG und HTML unter REPO/.live-plan/handouts/JJJJ-MM-TT-HHMM-TITEL.png/.html
```

`live-plan handout` oeffnet `/REPO/SLUG?handout=1` in Chrome headless: aufgebaut wie die Seite, aber nur Kopf,
Ueberblick, Teil 1 mit Anforderungen und Entscheidungen, Teil 2 und Fuss -- ohne Verbrauch, Fortschritt,
Agenten, Fragen, Offen und Dateien --, dunkel, 1600 px breit. Das PNG hat Faktor 2, das HTML ist eigenstaendig (CSS inline, keine
Skripte, Bilder als Data-URL). Chrome kommt aus `LIVE_PLAN_CHROME`, sonst unter macOS die App, sonst
`google-chrome` oder `chromium` im PATH; ohne Treffer endet der Befehl mit Exit 1 und einer Meldung. Beide
Pfade stehen auf stdout. Den Browser steuert das Skript ueber CDP mit dem WebSocket von bun, der Server
schreibt dafuer nichts.

## Grenzen

- Der Browser schreibt nur `fragen[].entscheidung`. Status, Schritte, Belege: nur Sie.
- Keine Anmeldung; der Server lauscht auf `0.0.0.0` und ist im LAN erreichbar. Keine Secrets in die Datei.
  Er antwortet nur unter einem Host dieses Rechners (localhost, Rechnername, eigene Adresse,
  dazu `LIVE_PLAN_HOSTS`, durch Komma getrennt), `/api/` nur ohne fremden `Origin`, und eine
  Entscheidung nur als JSON bis 16 KB mit einem `label` der Optionen oder, mit `eigen: true`, als
  eigene Antwort in den Grenzen oben.
- Der Ordner `.live-plan` muss im Repo liegen; Symlinks darin liest und schreibt der Server nicht,
  auch nicht im Belegordner und nicht als Belegordner selbst. Belege liefert er nur, solange
  `SLUG.yaml` besteht. Kopieren Sie Belege, statt sie zu verlinken. `neu` legt nichts durch einen
  Symlink an.
- Die Ansicht laesst sich nicht in fremde Seiten einbetten; Belege nur in die eigene.
- `SLUG.verlauf.jsonl`, `SLUG.stand.json` und `SLUG.seit` daneben gehoeren Server und Skript. Nicht anfassen.
- `frage` schreibt nur neue Eintraege hinten an `fragen:`, nie durch einen Symlink und nie in eine
  Flow-Liste mit Inhalt.
