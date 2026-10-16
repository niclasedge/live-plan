# Lokale CI (statt GitHub Actions): `just ci`; ohne Änderung am Code wird übersprungen.
# mod/** braucht das Test-Harness des Claude-Code-Plugin-Runners und läuft hier nicht.
test:
    bun test --path-ignore-patterns 'mod/**'

lint:
    @echo "lint: kein tsconfig/package.json im Repo, nichts zu prüfen"

ci:
    #!/usr/bin/env bash
    set -uo pipefail
    eing=(. ':(exclude)*.md' ':(exclude)*.png' ':(exclude)docs/**')
    s=scripts/ci-stempel.sh
    bash "$s" lint "${eing[@]}" -- just lint || exit $?
    bash "$s" test "${eing[@]}" -- just test || exit $?

ci-voll:
    #!/usr/bin/env bash
    set -uo pipefail
    export LOCAL_CI_FORCE=1
    just ci || exit $?
