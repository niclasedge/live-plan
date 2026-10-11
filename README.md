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

## Lizenz

MIT, siehe [LICENSE](LICENSE).
