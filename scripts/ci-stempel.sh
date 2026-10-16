#!/usr/bin/env bash
# Quelle: ops-lab tools/ci-stempel.sh, Fassung 1
#
# Lokale CI mit Inhalts-Stempel (#378).
#   ci-stempel.sh KOMPONENTE PFADSPEC... -- BEFEHL...
#
# Der Schluessel ist sha256 ueber "Blob-Hash Pfad" aller Eingabedateien der Komponente
# (getrackt, geaendert, neu: git ls-files -co --exclude-standard), die Gitlinks der Submodule
# im Pfadspec, die Fassungen der vorhandenen Werkzeuge und den Befehl. Lockfiles, Manifeste,
# justfile, .no-mistakes.yaml, tools/gate.projekt.json und dieses Skript gehen immer ein.
# Ablage ~/.cache/local-ci/<owner__repo>/<komponente>/<schluessel>.ok, ausserhalb des
# Arbeitsbaums. Nur Gruen wird gestempelt; Rot laeuft immer neu.
#
# Umgebung:  LOCAL_CI_FORCE=1     Lauf erzwingen
#            LOCAL_CI_TTL_MIN     Lebensdauer eines Stempels in Minuten (1440)
#            LOCAL_CI_NICE        nice-Stufe um den Lauf (10)
# Exit:      0 gruen, 1 rot (Exit des Befehls wird durchgereicht, auch 128+n),
#            2 Aufruf-, Konfigurations- oder Werkzeugfehler.
set -u

fehler() { echo "ci-stempel: $*" >&2; exit 2; }

[ $# -ge 4 ] || fehler "Aufruf: ci-stempel.sh KOMPONENTE PFADSPEC... -- BEFEHL..."
komp=$1; shift
case $komp in */*|.*|"") fehler "ungueltiger Komponentenname: $komp" ;; esac
spec=()
while [ $# -gt 0 ] && [ "$1" != "--" ]; do spec+=("$1"); shift; done
[ "${1:-}" = "--" ] || fehler "Trennzeichen -- fehlt"
shift
[ ${#spec[@]} -gt 0 ] || fehler "kein Pfadspec"
[ $# -gt 0 ] || fehler "kein Befehl"
for w in git sha256sum flock; do command -v "$w" >/dev/null 2>&1 || fehler "$w fehlt"; done
command -v "$1" >/dev/null 2>&1 || fehler "Werkzeug fehlt: $1"

skript=$(readlink -f "${BASH_SOURCE[0]}")
root=$(git rev-parse --show-toplevel 2>/dev/null) || fehler "kein Git-Repo"
cd "$root" || fehler "Wurzel nicht erreichbar"

# <owner__repo> aus der origin-URL (https://h/o/r.git, git@h:o/r.git), sonst Ordnernamen
url=$(git remote get-url origin 2>/dev/null || true)
url=${url%/}; url=${url%.git}
repo=${url##*[/:]}
rest=${url%"$repo"}; rest=${rest%[/:]}
owner=${rest##*[/:]}
if [ -n "$repo" ] && [ -n "$owner" ]; then id="${owner}__${repo}"; else id="lokal__$(basename "$root")"; fi
id=${id//[^A-Za-z0-9._-]/_}

basis="${HOME:?HOME fehlt}/.cache/local-ci"
dir="$basis/$id/$komp"
mkdir -p "$dir" || fehler "Ablage nicht anlegbar: $dir"

immer=(
  ':(glob)**/uv.lock' ':(glob)**/pyproject.toml' ':(glob)**/pnpm-lock.yaml' ':(glob)**/package.json'
  ':(glob)**/Cargo.lock' ':(glob)**/Cargo.toml' 'justfile' '.no-mistakes.yaml' 'tools/gate.projekt.json'
)

versionen=""
for w in node uv python3 bun cargo just; do
  if command -v "$w" >/dev/null 2>&1; then v=$("$w" --version 2>&1 | head -n1); else v=fehlt; fi
  versionen+="$w=$v;"
done

schluessel=$({
  LC_ALL=C git ls-files -z -co --exclude-standard -- "${spec[@]}" "${immer[@]}" | LC_ALL=C sort -zu |
    while IFS= read -r -d '' f; do
      [ -f "$f" ] && [ ! -L "$f" ] && printf '%s %s\n' "$(git hash-object -- "$f")" "$f"
    done
  git ls-files -s -z -- "${spec[@]}" | tr '\0' '\n' | LC_ALL=C sort |
    while read -r modus sha _ pfad; do
      [ "$modus" = 160000 ] || continue
      aktuell=$(git -C "$pfad" rev-parse HEAD 2>/dev/null || echo ohne-checkout)
      printf 'gitlink %s %s %s\n' "$pfad" "$sha" "$aktuell"
    done
  printf 'skript %s\n' "$(sha256sum < "$skript" | cut -c1-64)"
  printf 'versionen %s\nbefehl %s\n' "$versionen" "$*"
} | sha256sum | cut -c1-32)
[ ${#schluessel} -eq 32 ] || fehler "Schluessel nicht berechenbar"
kurz=${schluessel:0:12}
stempel="$dir/$schluessel.ok"

ttl=${LOCAL_CI_TTL_MIN:-1440}
find "$dir" -maxdepth 1 -name '*.ok' -mmin +"$ttl" -delete 2>/dev/null

if [ "${LOCAL_CI_FORCE:-0}" != 1 ] && [ -f "$stempel" ]; then
  echo "[$komp] uebersprungen, gruen am $(cat "$stempel") fuer Schluessel $kurz"
  exit 0
fi

echo "[$komp] laeuft (Schluessel $kurz)"
if [ "${LOCAL_CI_LOCK_GEHALTEN:-0}" != 1 ]; then
  exec 9>"$basis/lauf.lock" || fehler "Sperrdatei nicht anlegbar"
  flock 9
  export LOCAL_CI_LOCK_GEHALTEN=1
fi
nice -n "${LOCAL_CI_NICE:-10}" "$@" 9>&-
rc=$?
if [ $rc -eq 0 ]; then
  tmp=$(mktemp "$dir/.neu.XXXXXX") || fehler "Stempel nicht schreibbar"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$tmp" && mv -f "$tmp" "$stempel"
else
  echo "[$komp] rot (Exit $rc), kein Stempel"
fi
exit $rc
