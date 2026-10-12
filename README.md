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

## Firstmate-Cockpit

`cockpit.ts` zeigt die Worker eines [Firstmate](https://github.com/kunchenguid/firstmate)-Home.
Ohne Optionen startet eine Live-Ansicht, die sich alle 5 Sekunden neu aufbaut: je Worker ein
kleiner Kasten mit Rahmen, im Raster nach Breite des Terminals angeordnet (bei Größenänderung neu).
Der Rand trägt die id und den Zustand (working, paused, blocked, needs-decision, done, failed, dead
für ein fehlendes tmux-Fenster) samt Farbe; darin stehen Projekt · Art/Modus, Harness/Modell, die
letzte Statuszeile mit Alter, der PR, Zweig mit ahead/behind und Zahl geänderter Dateien und der
Befehl zum Öffnen des tmux-Fensters. Zu Langes wird gekürzt. Kopfzeile: Home, Zahl der Worker,
Abschnitte des Backlogs; Ende mit `q` oder Strg-C. Farbe nur im Terminal und ohne `NO_COLOR`.

```
┌─ ● live-plan-cockpit-tui ────────────── working ─┐
│ live-plan · ship/no-mistakes                     │
│ claude/default/medium                            │
│ 2m setup done, branch fm/live-plan-cockpit-tui,… │
│ fm/live-plan-cockpit-tui ↑0 ↓0 ±1                │
│ $ tmux attach -t firstmate:fm-live-plan-cockpit… │
└──────────────────────────────────────────────────┘
```

`--once` gibt einmal alle Details aus: Projekt, Art, Modus, Harness, Modell, tmux-Fenster und ob es
lebt, letzte Statuszeile mit Alter, offene Entscheidungen und Blocker, Inbox, PR, Stand des
Worktrees (Zweig, ahead/behind, geänderte Dateien, letzter Commit), Brief, die letzten Zeilen des
Panes und darunter fertige Befehle zum Öffnen des Fensters und zum Prüfen von Hand. Das gilt auch,
wenn die Ausgabe in eine Pipe oder Datei geht. Das Skript liest nur; es braucht node >= 22.18
(eingebautes Type-Stripping) oder bun.

```bash
./cockpit.ts                       # Live-Ansicht, Home aus FM_HOME, sonst /work/firstmate
./cockpit.ts --home ~/firstmate --watch 10
./cockpit.ts --once                # alle Details und Befehle je Worker
./cockpit.ts --json
```

Tests: `node --test cockpit.test.ts`.

## Lizenz

MIT, siehe [LICENSE](LICENSE).
