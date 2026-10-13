# live-plan

Agent-Skill für Claude Code und andere Coding-Agenten: Eine Sitzung führt ein lebendes Dokument
(`REPO/.live-plan/SLUG.yaml`) mit eigener Browser-Ansicht. Die Ansicht zeigt Fragen mit Optionen,
Schritte in Bahnen und Wellen sowie Belege. Ein Klick auf eine Option schreibt die Entscheidung
zurück in die Datei.

## Beispiel

Die Plan-Ansicht im Browser (`live-plan open SLUG`): Fortschritt, offene Fragen mit Optionen,
Anforderungen und Entscheidungen.

![Plan-Ansicht einer Beispiel-Sitzung](docs/plan.png)

Das Handout derselben Sitzung (`live-plan handout SLUG`): Kopf, Anforderungen, Entscheidungen und
Dokumentation als PNG und eigenständiges HTML unter `.live-plan/handouts/`.

<img src="docs/handout.png" alt="Handout einer Beispiel-Sitzung" width="800">

## Installation

Mit dem [skills-Installer](https://skills.sh):

```bash
pnpm dlx skills add niclasedge/live-plan        # ins aktuelle Projekt (.claude/skills/live-plan)
pnpm dlx skills add niclasedge/live-plan -g     # global für alle Projekte
```

`npx skills add niclasedge/live-plan` funktioniert ebenso.

Von Hand:

```bash
git clone https://github.com/niclasedge/live-plan ~/.claude/skills/live-plan
```

### Mod `live-plan-sitzung` (Claude Code)

Der Mod verbindet jede Claude-Code-Sitzung mit dem live-plan. Er legt beim Sitzungsstart per
`live-plan neu --auto` die Sitzung an und führt ein Register nach
`~/.cache/live-plan/sitzungen/<id>.json` (Kontext, Kosten, Subagenten, Fortschritt), das die
Ansicht als Live-Block zeigt. Dazu kommen die Werkzeuge `progress` und `step`, Antworten auf
`AskUserQuestion` direkt im Browser, der Stand im System-Prompt und der Sprengradius, der riskante
Bash-Befehle bis zur Freigabe anhält. In einer Terminal-Sitzung:

```
/plugin install live-plan-sitzung --marketplace niclasedge/live-plan
```

Mit `y` den Marketplace hinzufügen, dann den Scope wählen. Der Mod sucht das Skript unter
`~/.claude/skills/live-plan/live-plan` (bzw. unter `$CLAUDE_CONFIG_DIR`); ein anderer Pfad geht
über die Option `skript` oder `LIVE_PLAN_SKRIPT`. Quelltext und Tests liegen unter [`mod/`](mod/)
(`claude plugin test mod`).

## Voraussetzungen

- [bun](https://bun.sh) für Server und Startskript
- optional Chrome oder Chromium für `live-plan handout`

## Benutzung

Die Anleitung für den Agenten steht in [`SKILL.md`](SKILL.md). Kurz:

```bash
LP=~/.claude/skills/live-plan/live-plan
$LP neu SLUG      # Sitzung aus vorlage.yaml anlegen
$LP open SLUG     # Server starten, Ansicht im Browser öffnen
$LP stop          # Server beenden
```

Der Server lauscht auf Port 4410 (`LIVE_PLAN_PORT`) und hat keine Anmeldung. Er ist im LAN
erreichbar; legen Sie keine Secrets in die Sitzungsdatei.

Der Diff im Abschnitt Dateien zeigt auch eine git-ignorierte Datei, aber nur, wenn die Sitzung sie
laut Register gelesen oder geschrieben hat, sie in der Wurzel liegt und der Aufruf vom eigenen Rechner
kommt (Quell-IP der Verbindung 127.0.0.0/8 oder ::1, kein Header). Jedem anderen Aufruf, etwa aus dem LAN,
meldet er für eine git-ignorierte Datei eine Ablehnung (403) statt des Inhalts. Typische Secret-Namen
(`.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `*credentials*`, `*secret*`) zeigt er
dabei nie, sondern meldet eine Ablehnung. Tests: `node --test server.test.ts` (startet `bun server.ts`).

## Firstmate-Cockpit

`cockpit.ts` zeigt die Worker eines [Firstmate](https://github.com/kunchenguid/firstmate)-Home.
Ohne Optionen startet eine Live-Ansicht, die sich alle 5 Sekunden neu aufbaut: je Worker ein
kleiner Kasten mit Rahmen, im Raster nach Breite des Terminals angeordnet (bei Größenänderung neu).
Der Rand trägt die id und den Zustand (working, paused, blocked, needs-decision, done, failed, dead
für ein fehlendes tmux-Fenster) samt Farbe; darin stehen Projekt · Art/Modus, Harness/Modell, die
letzte Statuszeile mit Alter, der PR, Zweig mit ahead/behind und Zahl geänderter Dateien und der
Befehl zum Öffnen des tmux-Fensters. Liegen ungelesene Nachrichten von Firstmate an den Worker
(`state/<id>.inbox/*.msg`), steht `✉ N` vor dem Zustand, wenn der Rand Platz hat. Zu Langes wird
gekürzt. Kopfzeile: Home, Zahl der Worker, Abschnitte des Backlogs, `tmux nicht erreichbar`, wenn
der tmux-Server nicht antwortet. Darunter die Captain-Inbox (wartende Notizen in `state/inbox/`, wie `fm-inbox.sh status`
sie zählt) und die Warteschlange (`## Queued`, in älteren Backlogs auch `## Held`, in
`data/backlog.md`): die ersten drei Aufträge mit dem, worauf sie warten (`wartet auf <id>`, solange
der Eintrag offen ist, `bis <Datum>`, `fuer den Captain gehalten`, `gehalten` oder `bereit`), der
Rest als `+N weitere`. Ende mit `q` oder Strg-C. Farbe nur im Terminal und ohne `NO_COLOR`.

```
Firstmate-Cockpit  /work/firstmate  1 Worker  In flight 1, Queued 5, Done 7  21:36:24Z
Captain-Inbox: 2 Notizen warten · Warteschlange: 5
  cockpit-folge-a1  [wartet auf live-plan-cockpit-inbox]  Cockpit: Notizen im --once lesbar
  airlock-dns-b2  [bis 2026-11-01]  airlock: DNS-Override pruefen
  fm-hold-c3  [fuer den Captain gehalten]  Firstmate: Wake-Queue entschlacken
  +2 weitere (--once)

┌─ ● live-plan-cockpit-inbox ──────────────────── ✉ 2 working ─┐
│ live-plan · ship/no-mistakes                                 │
│ claude/default/medium                                        │
│ 3m setup done on fm/live-plan-cockpit-inbox; backlog wait-r… │
│ fm/live-plan-cockpit-inbox ↑0 ↓0 ±2                          │
│ $ tmux attach -t firstmate:fm-live-plan-cockpit-inbox        │
└──────────────────────────────────────────────────────────────┘
```

`--once` gibt einmal alle Details aus: die wartenden Notizen mit Namen, die ganze Warteschlange und
je Worker Projekt, Art, Modus, Harness, Modell, tmux-Fenster und ob es lebt, letzte Statuszeile mit
Alter, offene Entscheidungen und Blocker, Inbox, PR, Stand des Worktrees (Zweig, ahead/behind,
geänderte Dateien, letzter Commit), Brief, die letzten Zeilen des Panes und darunter fertige Befehle
zum Öffnen des Fensters und zum Prüfen von Hand. Das gilt auch, wenn die Ausgabe in eine Pipe oder
Datei geht. `--json` enthält dasselbe (`notizen`, `warteschlange`, je Worker `inbox`). Das
Skript liest nur; es braucht node >= 22.18 (eingebautes Type-Stripping) oder bun.

```bash
./cockpit.ts                       # Live-Ansicht, Home aus FM_HOME, sonst FIRSTMATE_HOME, sonst /work/firstmate
./cockpit.ts --home ~/firstmate --watch 10
./cockpit.ts --once                # alle Details und Befehle je Worker
./cockpit.ts --json
```

Tests: `node --test cockpit.test.ts firstmate.test.ts`.

### Firstmate in der Ansicht

Liegt die Wurzel einer Sitzung in einem Firstmate-Home, zeigt ihre Seite im Browser
(`http://localhost:4410/firstmate/<sitzung>`) zusätzlich zu Verbrauch, Fortschritt und Dateien den
Abschnitt Firstmate. Ein Home erkennt die Ansicht am Aufbau (`bin/fm-spawn.sh`, `state/`, `data/`),
nicht am Namen; `FM_HOME` und `FIRSTMATE_HOME` aus der Umgebung des Servers gelten hier nicht, nur
im Cockpit.

![Abschnitt Firstmate einer Beispiel-Sitzung](docs/firstmate.png)

- **Kopf:** Home, Zahl der Worker, Abschnitte des Backlogs, Captain-Inbox und die Warteschlange mit
  dem, worauf jeder Auftrag wartet.
- **Aktive Worker:** eine Karte je Worker wie ein Kasten des Cockpits (id, Zustand mit Farbe, Projekt,
  Art/Modus, Harness/Modell, letzte Statuszeile mit Alter, PR, Zweig mit ahead/behind und geänderten
  Dateien, `✉ N` für ungelesene Nachrichten). Ein Klick (oder Enter) öffnet die Details wie
  `cockpit --once`: Statusverlauf, offene Entscheidungen und Blocker, Worktree, letzter Commit,
  Inbox und die Befehle zum Kopieren.
- **Projekte:** je Klon unter `projects/` Beschreibung und Haltung aus `data/projects.md`, Zweig,
  sauber oder geändert, ahead/behind, letzter Commit, „zuletzt aktualisiert“ (letzter `git fetch`,
  mtime von `FETCH_HEAD`), die Worker auf dem Projekt und die offenen PRs.

Die Daten kommen aus `GET /api/REPO/SLUG/firstmate`; die Seite fragt alle 15 Sekunden. Der Server
liest das Home mit `firstmate.ts` in einem eigenen Prozess (10 s vorgehalten) und fragt `gh pr list`
je Projekt im Hintergrund (10 s Abbruch, 60 s vorgehalten); was fehlschlägt, steht als
„PRs unbekannt“ da, ohne die übrige Seite aufzuhalten. Gehört das Repo einem Konto, für das `gh`
einen Login hat, geht dessen Token (`gh auth token --user <owner>`) nur in die Umgebung dieses einen
Aufrufs; sonst gilt der aktive Login. Kein Token landet in einer Antwort, einem Log oder auf der
Platte. Wie das Cockpit liest die Ansicht nur (git ohne optionale Sperren, kein
`bin/fm-crew-state.sh`).

Weil der Server ohne Anmeldung im LAN erreichbar ist, zeigt die Ansicht **keine Inhalte der
tmux-Panes**; die letzten Pane-Zeilen gibt es nur im Terminal (`cockpit --once`). Statuszeilen,
PR-Adressen, Zweige und Titel aus dem Backlog stehen dagegen jedem offen, der die Seite erreicht.

## Lizenz

MIT, siehe [LICENSE](LICENSE).
