// Sprengradius: refuses a risky Bash command until the user approved it, asked in the chat
// (by Claude, through AskUserQuestion) and in the live-plan view at once.
//
// Classification and measuring are taken from blast-radius (anthropics/claude-code-playground,
// claude-code/mods/blast-radius/hooks/blast-radius.mjs, Apache-2.0), ported to TypeScript.
// Deviations: the question goes through fragen.ts's channel (the live-plan browser view)
// instead of a pane, the command is refused at once and run again once approved, `but land`,
// `but discard` and `but push --force` are held too, and prisma is listed with `pnpm exec`.
//
// This file never touches `$`: the engine follows `$` only into functions of the same file,
// so the hook lives in fragen.ts beside `vorbereiten` and `browserAntwort`. Measuring is a
// generator of process calls (`messung`) that the hook runs and feeds the results back into.

import type { Frage } from './fragen'

type Art =
  | 'rm'
  | 'git-reset'
  | 'git-checkout'
  | 'git-clean'
  | 'git-push-force'
  | 'migration'
  | 'but-land'
  | 'but-push-force'
  | 'but-discard'

type Migrator = 'django' | 'alembic' | 'rails' | 'prisma' | 'unbekannt'

// The first risky part of a command line; `ordner` is where a `cd` or `-C` earlier on the
// line moved to (null: the session folder), `args` the words after the (sub)command.
export type Risiko = { art: Art; label: string; args: string[]; ordner: string | null; werkzeug?: Migrator }

type Wechsel = { cd: string | null }

export type Bericht = { zusammenfassung: string; zeilen: string[]; mehr: number; hinweis?: string }

// One process call of a measurement, and what it answered (null: it did not run).
export type Aufruf = { argv: string[]; cwd: string; timeoutMs: number; env?: Record<string, string> }
export type Lauf = { exitCode: number; stdout: string; stderr: string }
type Schritte<T> = Generator<Aufruf, T, Lauf | null>

export const AUSFUEHREN = 'Ausführen'
export const ABBRECHEN = 'Abbrechen'
const MESS_MS = 15_000
const ORDNER_MS = 5000
const LISTE_MAX = 10
const BEFEHL_MAX = 80

// ---------------------------------------------------------------------------
// What counts as risky.

// sudo options that take a value, so the value isn't read as the command.
const SUDO_WERT = new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-T', '-U'])
// Commands that only read, so a bare word "migrate" in them isn't a migration.
const NUR_LESEND = new Set(['ls', 'cat', 'echo', 'printf', 'grep', 'rg', 'find', 'less', 'head', 'tail', 'cd', 'git'])
// Words that can come before the real command without changing what it does.
const VORSATZ = new Set(['command', 'exec', 'env', 'nohup', 'time', 'then', 'do', 'else', '!'])
const ZUWEISUNG = /^[A-Za-z_][A-Za-z0-9_]*=/

// A folder a later `cd arg` moves to, given the folder so far (null: the session folder).
function verbinden(ordner: string | null, arg: string | undefined): string {
  if (arg === undefined || arg === '~' || arg.startsWith('/') || arg.startsWith('~/')) return arg ?? '~'
  return ordner ? `${ordner}/${arg}` : arg
}

// Splits one segment into words, honouring quotes. Good enough to read flags and paths.
function woerter(text: string): string[] {
  const liste: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) liste.push(m[1] ?? m[2] ?? m[3] ?? '')
  return liste
}

// Git's or but's own options before the subcommand; `-C dir` moves where it runs.
function unterbefehl(args: string[], ordner: string | null, mitWert: (a: string) => boolean) {
  let wo = ordner
  let i = 0
  while (i < args.length && args[i]!.startsWith('-')) {
    const a = args[i]!
    if ((a === '-C' || a === '--current-dir') && i + 1 < args.length) {
      wo = verbinden(wo, args[i + 1])
      i += 2
    } else if (a.startsWith('--current-dir=')) {
      wo = verbinden(wo, a.slice('--current-dir='.length))
      i += 1
    } else if (mitWert(a) && i + 1 < args.length) {
      i += 2
    } else {
      i += 1
    }
  }
  return { sub: args[i], rest: args.slice(i + 1), wo }
}

// One segment: a risk, a folder change, or null.
function segment(text: string, ordner: string | null, gestapelt: (string | null)[]): Risiko | Wechsel | null {
  const w = woerter(text.trim().replace(/^[({]+\s*/, '').replace(/\s*[)}]+$/, ''))
  while (w.length && ZUWEISUNG.test(w[0]!)) w.shift()
  if (w[0] === 'sudo') {
    w.shift()
    while (w.length && w[0]!.startsWith('-')) {
      const o = w.shift()!
      if (SUDO_WERT.has(o)) w.shift()
    }
  }
  while (w.length && (VORSATZ.has(w[0]!) || ZUWEISUNG.test(w[0]!))) w.shift()
  if (w[0] === 'nice') {
    w.shift()
    if (w.at(0) === '-n') w.splice(0, 2)
    else if (/^-\d+$/.test(w.at(0) ?? '')) w.shift()
  }
  const [erstes, ...args] = w
  if (erstes === undefined) return null
  const cmd = erstes.replace(/^\\/, '') // \rm skips aliases; it's still rm
  if (cmd === 'cd') return { cd: args[0] === '-' ? '-' : verbinden(ordner, args[0]) }
  if (cmd === 'pushd') {
    gestapelt.push(ordner)
    return { cd: verbinden(ordner, args[0]) }
  }
  if (cmd === 'popd') return { cd: gestapelt.length ? (gestapelt.pop() ?? null) : '-' }

  if (cmd === 'rm' || cmd.endsWith('/rm')) {
    const flags = args.filter(a => a.startsWith('-'))
    const rekursiv = flags.some(f => f === '--recursive' || (/^-[^-]/.test(f) && /[rR]/.test(f)))
    const erzwungen = flags.some(f => f === '--force' || (/^-[^-]/.test(f) && f.includes('f')))
    if (rekursiv || erzwungen) {
      const ziele = args.filter(a => !a.startsWith('-') || a === '-')
      return { art: 'rm', label: `rm ${flags.join(' ')}`.trim(), args: ziele, ordner }
    }
  }
  if (cmd === 'git') {
    const { sub, rest, wo } = unterbefehl(args, ordner, a => a === '-c')
    if (sub === 'reset' && rest.includes('--hard')) return { art: 'git-reset', label: 'git reset --hard', args: rest, ordner: wo }
    if (sub === 'clean') return { art: 'git-clean', label: 'git clean', args: rest, ordner: wo }
    if (sub === 'push' && rest.some(a => a === '--force' || a === '-f' || a.startsWith('--force-with-lease') || a.startsWith('+'))) {
      return { art: 'git-push-force', label: 'git push --force', args: rest, ordner: wo }
    }
    const nurIndex = sub === 'restore' && rest.includes('--staged') && !rest.includes('--worktree') && !rest.includes('-W')
    if ((sub === 'checkout' || sub === 'restore') && rest.includes('.') && !nurIndex) {
      return { art: 'git-checkout', label: `git ${sub} -- .`, args: rest, ordner: wo }
    }
  }
  if (cmd === 'but') {
    const { sub, rest, wo } = unterbefehl(args, ordner, () => false)
    if (sub === 'land') return { art: 'but-land', label: 'but land', args: rest, ordner: wo }
    if (sub === 'discard') return { art: 'but-discard', label: 'but discard', args: rest, ordner: wo }
    if (sub === 'push' && rest.some(a => a === '--force' || a === '-f' || a === '--with-force')) {
      return { art: 'but-push-force', label: 'but push --force', args: rest, ordner: wo }
    }
  }
  const satz = w.join(' ')
  const migration = (werkzeug: Migrator, label: string): Risiko => ({ art: 'migration', werkzeug, label, args: [], ordner })
  if (/\balembic\s+upgrade\b/.test(satz)) return migration('alembic', 'alembic upgrade')
  if (/\bdb:migrate(?!:status\b)/.test(satz)) return migration('rails', 'db:migrate')
  if (/\bprisma\s+migrate\b/.test(satz)) return migration('prisma', 'prisma migrate')
  if (/\bmanage\.py\s+migrate\b/.test(satz)) return migration('django', 'manage.py migrate')
  if (!NUR_LESEND.has(cmd) && args.includes('migrate')) return migration('unbekannt', 'migrate')
  return null
}

// The first risky segment of a command line, or null.
export function einordnen(befehl: string): Risiko | null {
  let ordner: string | null = null
  const ebenen: (string | null)[] = [] // folder to restore when a ( subshell ) closes
  const gestapelt: (string | null)[] = [] // pushd stack, for popd
  for (const roh of befehl.split(/&&|\|\||;|\||\n/)) {
    const auf = roh.match(/^\s*\(+/)?.[0].trim().length ?? 0
    // Trailing redirects and & don't hide a closing ) : `(cd sub && make) > log`.
    const ohneUmleitung = roh.replace(/(?:\s*(?:\d*>>?|&>>?|<)\s*\S+|\s*&)+\s*$/, '')
    const zu = ohneUmleitung.match(/\)+\s*$/)?.[0].trim().length ?? 0
    for (let k = 0; k < auf; k += 1) ebenen.push(ordner)
    const r = segment(roh, ordner, gestapelt)
    if (r && 'art' in r) return r
    if (r) ordner = r.cd
    // A cd inside ( ... ) doesn't outlive it.
    for (let k = 0; k < zu && ebenen.length; k += 1) ordner = ebenen.pop() ?? null
  }
  return null
}

// ---------------------------------------------------------------------------
// Measuring. Paths go to bash as arguments, never as source, so nothing in them runs.

const CD_SKRIPT = `unset CDPATH; d="$1"; case "$d" in "~") d="$HOME";; "~/"*) d="$HOME/\${d#\\~/}";; esac; cd -- "$d" 2>/dev/null && pwd -P`

// compgen -G expands a glob without command substitution; a relative path gets ./ in front,
// so find never reads a name like -delete as an action.
const RM_SKRIPT = `
shopt -s nullglob dotglob
paths=()
for p in "$@"; do
  case "$p" in "~"|"~/"*) p="$HOME\${p#\\~}";; esac
  if [[ "$p" == *[*?[]* ]]; then
    while IFS= read -r m; do paths+=("$m"); done < <(compgen -G "$p")
  elif [[ -e "$p" || -L "$p" ]]; then
    paths+=("$p")
  fi
done
if (( \${#paths[@]} == 0 )); then echo "0 0 0"; exit 0; fi
for i in "\${!paths[@]}"; do case "\${paths[$i]}" in /*) ;; *) paths[$i]="./\${paths[$i]}";; esac; done
files=$(find "\${paths[@]}" \\( -type f -o -type l \\) 2>/dev/null | wc -l | tr -d ' ')
kb=$(du -skc "\${paths[@]}" 2>/dev/null | tail -n1 | cut -f1)
echo "$files $(( \${kb:-0} * 1024 )) \${#paths[@]}"
find "\${paths[@]}" \\( -type f -o -type l \\) 2>/dev/null | head -n ${LISTE_MAX}
`

const MIGRATIONEN: Record<Exclude<Migrator, 'unbekannt'>, { argv: string[]; offen: (l: string) => boolean; text: (l: string) => string }> = {
  django: { argv: ['python3', 'manage.py', 'showmigrations', '--plan'], offen: l => l.startsWith('[ ]'), text: l => l.slice(4) },
  alembic: { argv: ['alembic', 'history', '-r', 'current:head'], offen: l => l.includes('->'), text: l => l },
  rails: { argv: ['bin/rails', 'db:migrate:status'], offen: l => /^\s*down\b/.test(l), text: l => l.trim() },
  prisma: { argv: ['pnpm', 'exec', 'prisma', 'migrate', 'status'], offen: l => /^\s{2}\S/.test(l), text: l => l.trim() },
}

const anzahl = (n: number, eins: string, viele: string): string => `${n} ${n === 1 ? eins : viele}`

function groesse(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes || 0} B`
  const einheiten = ['KB', 'MB', 'GB', 'TB']
  let n = bytes
  let i = -1
  while (n >= 1024 && i < einheiten.length - 1) {
    n /= 1024
    i += 1
  }
  return `${n.toFixed(n < 10 ? 1 : 0).replace('.', ',')} ${einheiten[i]}`
}

export const unbekannt = (r: Risiko, hinweis?: string): Bericht => ({
  zusammenfassung: `${r.label} ausführen (Wirkung unbekannt)`,
  zeilen: [],
  mehr: 0,
  ...(hinweis ? { hinweis } : {}),
})

const liste = (alle: string[], gesamt = alle.length) => ({
  zeilen: alle.slice(0, LISTE_MAX),
  mehr: Math.max(0, gesamt - Math.min(alle.length, LISTE_MAX)),
})

// One process call; a call that did not run ends the measurement as "Wirkung unbekannt".
function* aufruf(argv: string[], cwd: string, timeoutMs = MESS_MS, env?: Record<string, string>): Schritte<Lauf> {
  const lauf = yield { argv, cwd, timeoutMs, ...(env ? { env } : {}) }
  if (!lauf) throw new Error(`${argv[0]} lief nicht`)
  return lauf
}

// Resolves a `cd` target to an absolute folder, or null if it doesn't exist.
function* ordnerAufloesen(sitzung: string, ordner: string): Schritte<string | null> {
  if (ordner === '-') return null // `cd -` depends on the shell's history
  const r = yield* aufruf(['bash', '-c', CD_SKRIPT, 'sprengradius', ordner], sitzung, ORDNER_MS)
  const aus = r.stdout.trim()
  return r.exitCode === 0 && aus ? aus : null
}

function* rmMessen(r: Risiko, cwd: string): Schritte<Bericht> {
  if (!r.args.length) return { zusammenfassung: 'nichts löschen: rm ohne Pfade', zeilen: [], mehr: 0 }
  const lauf = yield* aufruf(['bash', '-c', RM_SKRIPT, 'sprengradius', ...r.args], cwd)
  if (lauf.exitCode !== 0) return unbekannt(r)
  const [kopf, ...rest] = lauf.stdout.split('\n').filter(l => l !== '')
  const [dateien = 0, bytes = 0, gefunden = 0] = (kopf ?? '0 0 0').split(' ').map(Number)
  if (!gefunden) return { zusammenfassung: `nichts löschen: nichts passt auf ${r.args.join(' ')}`, zeilen: [], mehr: 0 }
  if (!dateien) {
    return { zusammenfassung: `${anzahl(gefunden, 'Pfad', 'Pfade')} ohne Dateien löschen`, zeilen: [], mehr: 0, hinweis: r.args.join(' ') }
  }
  return {
    zusammenfassung: `${anzahl(dateien, 'Datei', 'Dateien')} löschen (${groesse(bytes)})`,
    ...liste(rest.map(l => l.replace(/^\.\//, '')), dateien),
  }
}

function* cleanMessen(r: Risiko, cwd: string): Schritte<Bericht> {
  const flags: string[] = []
  const pfade: string[] = []
  for (let i = 0; i < r.args.length; i += 1) {
    const a = r.args[i]!
    if (a === '--') {
      pfade.push(...r.args.slice(i + 1))
      break
    }
    if (a === '-e' || a === '--exclude') {
      flags.push(a, r.args[i + 1] ?? '')
      i += 1
    } else if (a.startsWith('--exclude=') || /^-e./.test(a)) {
      flags.push(a)
    } else if (/^-[a-zA-Z]+$/.test(a)) {
      const behalten = a.replace(/[finq]/g, '') // -n is added below; -f, -i and -q would change the dry run
      if (behalten !== '-') flags.push(behalten)
    } else if (!a.startsWith('-')) {
      pfade.push(a)
    }
  }
  // "Would remove" is git's English: a localized git says it otherwise.
  const lauf = yield* aufruf(['git', 'clean', '-n', ...flags, '--', ...pfade], cwd, MESS_MS, { LC_ALL: 'C' })
  if (lauf.exitCode !== 0) return unbekannt(r, lauf.stderr.trim().slice(0, 200))
  const weg = lauf.stdout.split('\n').filter(l => l.startsWith('Would remove ')).map(l => l.slice('Would remove '.length))
  if (!weg.length) return { zusammenfassung: 'nichts entfernen: keine unversionierte Datei passt', zeilen: [], mehr: 0 }
  return { zusammenfassung: `${anzahl(weg.length, 'unversionierten Pfad', 'unversionierte Pfade')} entfernen`, ...liste(weg) }
}

function* verwerfenMessen(r: Risiko, cwd: string): Schritte<Bericht> {
  const lauf = yield* aufruf(['git', 'status', '--porcelain'], cwd)
  if (lauf.exitCode !== 0) return unbekannt(r, lauf.stderr.trim().slice(0, 200))
  const zeilen = lauf.stdout.split('\n').filter(l => l.length > 3 && !l.startsWith('??'))
  // reset --hard drops staged and unstaged changes; checkout -- . drops unstaged ones.
  const weg = r.art === 'git-reset' ? zeilen : zeilen.filter(l => l[1] !== ' ')
  if (!weg.length) return { zusammenfassung: 'nichts verwerfen: keine offenen Änderungen', zeilen: [], mehr: 0 }
  return {
    zusammenfassung: `offene Änderungen in ${anzahl(weg.length, 'Datei', 'Dateien')} verwerfen`,
    ...liste(weg.map(l => `${l.slice(0, 2).trim()} ${l.slice(3)}`)),
  }
}

function* pushMessen(r: Risiko, cwd: string): Schritte<Bericht> {
  const positionen = r.args.filter(a => !a.startsWith('-'))
  const remote = positionen[0] ?? 'origin'
  // A refspec is src:dst. With no colon, the local branch of the same name is pushed.
  const spec = (positionen[1] ?? '').replace(/^\+/, '')
  let [quelle, zweig] = spec.includes(':') ? spec.split(':') : [spec, spec]
  zweig = (zweig ?? '').replace(/^refs\/heads\//, '')
  if (!zweig || zweig === 'HEAD') {
    zweig = (yield* aufruf(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], cwd)).stdout.trim()
    quelle = 'HEAD'
  }
  quelle = quelle || 'HEAD'
  const ref = `${remote}/${zweig}`
  const bekannt = yield* aufruf(['git', 'rev-parse', '--verify', '--quiet', ref], cwd)
  if (bekannt.exitCode !== 0) {
    return { zusammenfassung: `${ref} per Force-Push überschreiben (Wirkung unbekannt)`, zeilen: [], mehr: 0, hinweis: `kein lokaler Stand von ${ref}, erst git fetch` }
  }
  const log = yield* aufruf(['git', 'log', '--oneline', '--no-decorate', `${quelle}..${ref}`], cwd)
  const weg = log.stdout.split('\n').filter(l => l !== '')
  if (!weg.length) return { zusammenfassung: `${ref} per Force-Push überschreiben, ohne Commits zu verwerfen`, zeilen: [], mehr: 0 }
  return { zusammenfassung: `per Force-Push auf ${ref} ${anzahl(weg.length, 'Commit', 'Commits')} verwerfen`, ...liste(weg) }
}

function* migrationMessen(r: Risiko, cwd: string): Schritte<Bericht> {
  const lister = r.werkzeug && r.werkzeug !== 'unbekannt' ? MIGRATIONEN[r.werkzeug] : undefined
  if (!lister) return { zusammenfassung: 'Migrationen ausführen (Wirkung unbekannt)', zeilen: [], mehr: 0 }
  const lauf = yield* aufruf(lister.argv, cwd)
  if (lauf.exitCode !== 0) return unbekannt(r, `${lister.argv.join(' ')} scheiterte`)
  const offen = lauf.stdout.split('\n').filter(lister.offen).map(lister.text)
  if (!offen.length) return { zusammenfassung: `${r.label} ausführen: nichts ausstehend`, zeilen: [], mehr: 0 }
  return { zusammenfassung: `${anzahl(offen.length, 'ausstehende Migration', 'ausstehende Migrationen')} anwenden`, ...liste(offen) }
}

type ButAenderung = { cliId?: unknown; filePath?: unknown }
type ButCommit = { commitId?: unknown; message?: unknown }
type ButZweig = { cliId?: unknown; name?: unknown; commits?: ButCommit[] }
type ButStatus = { uncommittedChanges?: ButAenderung[]; stacks?: { assignedChanges?: ButAenderung[]; branches?: ButZweig[] }[] }

const feld = <T>(v: T[] | undefined): T[] => (Array.isArray(v) ? v : [])

function* butMessen(r: Risiko, cwd: string): Schritte<Bericht> {
  const lauf = yield* aufruf(['but', 'status', '--json'], cwd)
  if (lauf.exitCode !== 0) return unbekannt(r, lauf.stderr.trim().slice(0, 200))
  const s = JSON.parse(lauf.stdout) as ButStatus
  const stapel = feld(s.stacks)
  const ids = r.args.filter(a => !a.startsWith('-'))

  if (r.art === 'but-discard') {
    const aenderungen = [...feld(s.uncommittedChanges), ...stapel.flatMap(x => feld(x.assignedChanges))]
    // zz, or no ids at all, discards every uncommitted change.
    const alle = !ids.length || ids.includes('zz')
    const getroffen = alle ? aenderungen : aenderungen.filter(c => ids.includes(String(c.cliId)))
    const fremd = alle ? [] : ids.filter(id => !aenderungen.some(c => c.cliId === id))
    if (fremd.length && !getroffen.length) return unbekannt(r, `nicht zugeordnet: ${fremd.join(', ')}`)
    const pfade = [...new Set(getroffen.map(c => String(c.filePath)))]
    if (!pfade.length) return { zusammenfassung: 'nichts verwerfen: keine offenen Änderungen', zeilen: [], mehr: 0 }
    const rest = fremd.length ? ` (Wirkung von ${fremd.join(', ')} unbekannt)` : ''
    return { zusammenfassung: `Änderungen in ${anzahl(pfade.length, 'Datei', 'Dateien')} verwerfen${rest}`, ...liste(pfade) }
  }

  const zweige = stapel.flatMap(x => feld(x.branches))
  const ziel = ids[0]
  const gewaehlt = ziel ? zweige.filter(b => b.name === ziel || b.cliId === ziel) : zweige
  if (!gewaehlt.length) return unbekannt(r, ziel ? `kein Branch ${ziel} in but status` : 'keine Branches in but status')
  const commits = gewaehlt.flatMap(b => feld(b.commits))
  const wer = gewaehlt.length === 1 ? `Branch ${String(gewaehlt[0]!.name)}` : anzahl(gewaehlt.length, 'Branch', 'Branches')
  const wie = r.art === 'but-land' ? 'direkt auf den Zielbranch bringen' : 'per Force-Push auf den Remote schreiben'
  return {
    zusammenfassung: `${wer} mit ${anzahl(commits.length, 'Commit', 'Commits')} ${wie}`,
    ...liste(commits.map(c => `${String(c.commitId).slice(0, 7)} ${String(c.message ?? '').split('\n')[0]}`)),
  }
}

// What the command would change, measured where it runs: the process calls to make, then
// the report. Never throws: what can't be measured is said ("Wirkung unbekannt").
export function* messung(r: Risiko, sitzung: string): Schritte<Bericht> {
  try {
    const cwd = r.ordner === null ? sitzung : yield* ordnerAufloesen(sitzung, r.ordner)
    if (cwd === null) return unbekannt(r, `Ordner ${r.ordner} nicht gefunden`)
    if (r.art === 'rm') return yield* rmMessen(r, cwd)
    if (r.art === 'git-clean') return yield* cleanMessen(r, cwd)
    if (r.art === 'git-reset' || r.art === 'git-checkout') return yield* verwerfenMessen(r, cwd)
    if (r.art === 'git-push-force') return yield* pushMessen(r, cwd)
    if (r.art === 'migration') return yield* migrationMessen(r, cwd)
    return yield* butMessen(r, cwd)
  } catch {
    return unbekannt(r)
  }
}

// ---------------------------------------------------------------------------
// The question and what Claude reads when the command is refused.

export const kuerzen = (befehl: string, max = BEFEHL_MAX): string => {
  const zeile = befehl.replace(/\s+/g, ' ').trim()
  return zeile.length > max ? `${zeile.slice(0, max - 1)}…` : zeile
}

export function frageVon(befehl: string, b: Bericht): Frage {
  const eintraege = b.zeilen.length ? [...b.zeilen, ...(b.mehr ? [`+ ${b.mehr} weitere`] : [])].join(', ') : b.hinweis
  return {
    question: `Sprengradius: \`${kuerzen(befehl)}\` würde ${b.zusammenfassung}`,
    header: 'Sprengradius',
    multiSelect: false,
    options: [{ label: AUSFUEHREN, ...(eintraege ? { description: eintraege } : {}) }, { label: ABBRECHEN }],
  }
}

// The refusal Claude reads while the question is open: ask it word for word, then run again.
export function anfrage(f: Frage, id: string, url: string, b: Bericht): string {
  return (
    `Sprengradius hält den Befehl an: ${b.zusammenfassung}. Er läuft erst nach Freigabe. ` +
    `Stellen Sie dem Nutzer jetzt per AskUserQuestion genau diese Frage, Wortlaut unverändert ` +
    `(sie steht als ${id} auch im live-plan: ${url}): ${JSON.stringify(f)}. ` +
    `Wählt er „${AUSFUEHREN}“, rufen Sie denselben Befehl unverändert erneut auf; sonst nicht.`
  )
}

// The refusal Claude reads after the user chose anything but "Ausführen".
export function ablehnung(wahl: string, b: Bericht): string {
  return `Sprengradius hat den Befehl angehalten und nicht ausgeführt: der Nutzer hat „${wahl}“ gewählt. Er hätte: ${b.zusammenfassung}. Nicht erneut versuchen, außer der Nutzer verlangt es.`
}
