import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { einordnen } from '../hooks/sprengradius'

const ID = 'sitzung-1'
const API = 'http://localhost:4410/api/repo/sitzung-1'
const URL_SEITE = 'http://localhost:4410/repo/sitzung-1'
const SKRIPT = '/opt/lp/live-plan'
const MIT_SKRIPT = { options: { skript: SKRIPT } }

type PlanFrage = { id: string; frage: string; optionen: { label: string }[]; entscheidung: string }
type Lauf = { exitCode?: number; stdout?: string; stderr?: string }
// What a measuring command answers: a run, 'wirft' for a call that rejects, undefined for exit 0.
type Messung = (argv: readonly string[], cwd: string | undefined, env: Record<string, string> | undefined) => Lauf | 'wirft' | undefined

const lauf = (l: Lauf = {}) => ({
  value: { exitCode: l.exitCode ?? 0, stdout: l.stdout ?? '', stderr: l.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false },
})
const antwort = (status: number, text: string) => ({ value: { status, ok: status < 300, headers: {}, text } })

// `rm -rf build` measured: 12 files, 3481 KB, one path; the first ten listed.
const RM_AUSGABE = `12 ${3481 * 1024} 1\n${Array.from({ length: 10 }, (_, i) => `./build/f${i}.js`).join('\n')}\n`
const RM_MESSUNG: Messung = argv => (argv[0] === 'bash' ? { stdout: RM_AUSGABE } : undefined)

// The world beneath the plugin, as in fragen.test.ts: the live-plan script and server in
// memory, a mocked clock, and the Bash tool itself, which records what it ran.
// chat: the chat dialog answers `wahl` after `nachMs`; without it the dialog never answers.
function welt(on: On, opts: { skriptDa?: boolean; messung?: Messung; chat?: { wahl: string; nachMs: number } } = {}) {
  const clock = mock.clock(on, { now: 10_000 })
  mock.env(on, { HOME: '/home/t' })
  mock.store(on)
  const plan = { fragen: [] as PlanFrage[], verlauf: 0 }
  const prozesse: { argv: string[]; cwd?: string; stdin?: string }[] = []
  const posts: { frage: string; wahl: string }[] = []
  const notizen: string[] = []
  const status: (string | undefined)[] = []
  const ausgefuehrt: string[] = []
  const dialog = { geoeffnet: 0, abgebrochen: 0, fragen: [] as unknown[] }
  let wecker: (() => void)[] = []

  const entscheiden = (id: string, wahl: string) => {
    const f = plan.fragen.find(x => x.id === id)
    if (f) f.entscheidung = wahl
    plan.verlauf += 1
    const w = wecker
    wecker = []
    for (const r of w) r()
  }

  on('fs.stat', ($, e) =>
    opts.skriptDa === false
      ? { deny: `ENOENT ${e.path}` }
      : { value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false } },
  )
  on('process.run', ($, e) => {
    prozesse.push({
      argv: [...e.argv],
      ...(e.init?.cwd !== undefined ? { cwd: e.init.cwd } : {}),
      ...(e.init?.stdin !== undefined ? { stdin: e.init.stdin } : {}),
    })
    if (e.argv[0] === 'bun' && e.argv[2] === 'frage') {
      const ein = JSON.parse(e.init?.stdin ?? '{}') as { fragen: { frage: string; optionen: { label: string }[] }[] }
      const ids = ein.fragen.map(f => {
        const id = `F${plan.fragen.length + 1}`
        plan.fragen.push({ id, frage: f.frage, optionen: f.optionen, entscheidung: '' })
        return id
      })
      return lauf({ stdout: `${JSON.stringify({ ids, url: URL_SEITE })}\n` })
    }
    if (e.argv[0] === 'bun') return lauf()
    const m = opts.messung?.(e.argv, e.init?.cwd, e.init?.env)
    return m === 'wirft' ? { deny: 'Zeitlimit' } : lauf(m)
  })
  on('http.fetch', async ($, e) => {
    if (e.init?.method === 'POST' && e.url === `${API}/entscheidung`) {
      const b = JSON.parse(e.init.body ?? '{}') as { frage: string; wahl: string }
      posts.push(b)
      entscheiden(b.frage, b.wahl)
      return antwort(200, '{"ok":true}')
    }
    if (e.url === API) return antwort(200, JSON.stringify({ verlauf: plan.verlauf, plan: { fragen: plan.fragen } }))
    if (e.url.startsWith(`${API}/warte?`)) {
      await Promise.race([clock.sleep(20_000), new Promise<void>(r => wecker.push(r))])
      return antwort(200, `seit=${plan.verlauf}\n`)
    }
    return antwort(404, '{}')
  })
  on('session.id', () => ({ value: ID }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.repo', () => ({ value: { root: '/repo', remote: null, internal: false, name: null } }))
  on('ui.notify', ($, e) => {
    notizen.push(e.text)
    return { value: { isSent: true as const, channel: 'kitty' as const } }
  })
  on('ui.status', ($, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  // The chat dialog of AskUserQuestion: counts what opened it and an abort from above.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    dialog.geoeffnet += 1
    dialog.fragen.push(...(e.questions as unknown[]))
    next.signal.addEventListener('abort', () => {
      dialog.abgebrochen += 1
    })
    if (!opts.chat) {
      await new Promise<void>(r => next.signal.addEventListener('abort', () => r()))
      return { deny: 'abgebrochen' }
    }
    await clock.sleep(opts.chat.nachMs)
    const frage = (e.questions as { question: string }[])[0]!.question
    return { result: { questions: e.questions, answers: { [frage]: opts.chat.wahl } } }
  })
  // The Bash tool: what reaches it ran.
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    ausgefuehrt.push(e.command)
    return { result: { stdout: 'gelaufen', stderr: '' } }
  })

  const frageEingabe = () => {
    const p = prozesse.find(x => x.argv[0] === 'bun' && x.argv[2] === 'frage')
    return p ? (JSON.parse(p.stdin ?? '{}') as { fragen: unknown[] }) : null
  }

  return { clock, plan, prozesse, posts, notizen, status, ausgefuehrt, dialog, entscheiden, frageEingabe }
}

// ---------------------------------------------------------------------------
// What counts as risky.

test('Klassifikation: riskante Befehle je Art, mit Ordner', () => {
  const faelle: [string, string, string | null][] = [
    ['rm -rf build', 'rm', null],
    ['rm -r a b', 'rm', null],
    ['rm -f notiz.txt', 'rm', null],
    ['rm --recursive alt', 'rm', null],
    ['\\rm -rf build', 'rm', null],
    ['/bin/rm -rf build', 'rm', null],
    ['sudo rm -rf /tmp/x', 'rm', null],
    ['sudo -u root rm -rf /tmp/x', 'rm', null],
    ['env FOO=1 rm -rf build', 'rm', null],
    ['FOO=1 BAR=2 rm -f x', 'rm', null],
    ['nice -n 5 rm -rf build', 'rm', null],
    ['echo los && rm -rf build', 'rm', null],
    ['ls; rm -rf build', 'rm', null],
    ['cd sub && rm -rf build', 'rm', 'sub'],
    ['cd /tmp/a && cd b && rm -rf c', 'rm', '/tmp/a/b'],
    ['(cd sub && make) && rm -rf build', 'rm', null],
    ['(cd sub && rm -rf build)', 'rm', 'sub'],
    ['git reset --hard', 'git-reset', null],
    ['git reset --hard HEAD~1', 'git-reset', null],
    ['git -C ../andere reset --hard', 'git-reset', '../andere'],
    ['git -c core.x=1 reset --hard', 'git-reset', null],
    ['git checkout -- .', 'git-checkout', null],
    ['git restore .', 'git-checkout', null],
    ['git clean -fdx', 'git-clean', null],
    ['git clean -n', 'git-clean', null],
    ['git push --force', 'git-push-force', null],
    ['git push -f origin main', 'git-push-force', null],
    ['git push --force-with-lease origin main', 'git-push-force', null],
    ['git push origin +main', 'git-push-force', null],
    ['python3 manage.py migrate', 'migration', null],
    ['bin/rails db:migrate', 'migration', null],
    ['alembic upgrade head', 'migration', null],
    ['pnpm exec prisma migrate deploy', 'migration', null],
    ['./werkzeug migrate', 'migration', null],
    ['but land ch', 'but-land', null],
    ['but discard oz tp', 'but-discard', null],
    ['but discard', 'but-discard', null],
    ['but push --force', 'but-push-force', null],
    ['but push -f ch', 'but-push-force', null],
    ['but push --with-force ch', 'but-push-force', null],
    ['but -C ../andere land ch', 'but-land', '../andere'],
    ['git status && but land ch', 'but-land', null],
  ]
  for (const [befehl, art, ordner] of faelle) {
    expect([befehl, einordnen(befehl)]).toMatchObject([befehl, { art, ordner }])
  }
})

test('Klassifikation: harmlose Befehle bleiben ungehalten', () => {
  const harmlos = [
    'rm notiz.txt',
    'ls -la',
    'echo "rm -rf /"',
    'git status',
    'git reset --soft HEAD~1',
    'git reset HEAD datei',
    'git checkout main',
    'git restore --staged .',
    'git push',
    'git push origin main',
    'bin/rails db:migrate:status',
    'grep migrate README.md',
    'but status --json',
    'but push',
    'but push ch',
    'but commit -m nachricht',
    'cd sub && ls',
    '',
  ]
  for (const befehl of harmlos) expect([befehl, einordnen(befehl)]).toEqual([befehl, null])
})

// ---------------------------------------------------------------------------
// Holding a risky command.

test('ein harmloser Befehl laeuft sofort, ohne Messung und ohne Frage', MIT_SKRIPT, async ($, on) => {
  const w = welt(on, { messung: RM_MESSUNG })
  const r = await $.tool.call({ tool: 'Bash', command: 'ls -la && git status' })
  expect(r).toMatchObject({ result: { stdout: 'gelaufen' } })
  expect(w.ausgefuehrt).toEqual(['ls -la && git status'])
  expect(w.prozesse).toEqual([])
  expect(w.status).toEqual([])
})

const FRAGE_RM = 'Sprengradius: `rm -rf build` würde 12 Dateien löschen (3,4 MB)'
type Antwort = { deny?: string; text?: string; result?: unknown }
const grundVon = (r: unknown): string => (r as Antwort).deny ?? (r as Antwort).text ?? ''

test('ein riskanter Befehl wird sofort verweigert: Frage im live-plan, Claude soll sie stellen', MIT_SKRIPT, async ($, on) => {
  const w = welt(on, { messung: RM_MESSUNG })
  const grund = grundVon(await $.tool.call({ tool: 'Bash', command: 'rm -rf build' }))

  // Measured in the session folder, the paths as arguments, never as source.
  const messung = w.prozesse.find(p => p.argv[0] === 'bash')!
  expect(messung.argv[1]).toBe('-c')
  expect(messung.argv.slice(3)).toEqual(['sprengradius', 'build'])
  expect(messung.cwd).toBe('/repo')

  const liste = [...Array.from({ length: 10 }, (_, i) => `build/f${i}.js`), '+ 2 weitere'].join(', ')
  expect(w.frageEingabe()).toMatchObject({
    fragen: [
      {
        frage: FRAGE_RM,
        kopf: 'Sprengradius',
        multi: false,
        optionen: [{ label: 'Ausführen', beschreibung: liste }, { label: 'Abbrechen' }],
      },
    ],
  })
  // Claude reads what to ask, word for word, and where it stands in the live-plan.
  expect(grund).toContain('Sprengradius hält den Befehl an: 12 Dateien löschen (3,4 MB)')
  expect(grund).toContain('AskUserQuestion')
  expect(grund).toContain(JSON.stringify(FRAGE_RM))
  expect(grund).toContain('F1')
  expect(grund).toContain(URL_SEITE)
  // No dialog of its own (a host like T3 never draws it), nothing ran, nothing waits.
  expect(w.dialog.geoeffnet).toBe(0)
  expect(w.ausgefuehrt).toEqual([])
  expect(w.posts).toEqual([])
})

test('Ausfuehren im live-plan: der wiederholte Befehl laeuft, die Freigabe gilt einmal', MIT_SKRIPT, async ($, on) => {
  const w = welt(on, { messung: RM_MESSUNG })
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  w.entscheiden('F1', 'Ausführen')
  expect(await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })).toMatchObject({ result: { stdout: 'gelaufen' } })
  expect(w.ausgefuehrt).toEqual(['rm -rf build'])
  expect(w.plan.fragen).toHaveLength(1)

  // Used up: the next run asks anew.
  expect(grundVon(await $.tool.call({ tool: 'Bash', command: 'rm -rf build' }))).toContain('AskUserQuestion')
  expect(w.plan.fragen.map(f => f.id)).toEqual(['F1', 'F2'])
  expect(w.ausgefuehrt).toEqual(['rm -rf build'])
})

test('Claude stellt die Frage: dieselbe Frage im live-plan, Ausfuehren im Chat gibt den Befehl frei', MIT_SKRIPT, async ($, on) => {
  const w = welt(on, { messung: RM_MESSUNG, chat: { wahl: 'Ausführen', nachMs: 3_000 } })
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  const frage = {
    question: FRAGE_RM,
    header: 'Sprengradius',
    multiSelect: false,
    options: [{ label: 'Ausführen' }, { label: 'Abbrechen' }],
  }
  const gefragt = $.tool.call({ tool: 'AskUserQuestion', questions: [frage] })
  await w.clock.settle()
  await w.clock.advance(3_000)
  await gefragt
  expect(w.dialog.geoeffnet).toBe(1)
  // Taken up, not asked twice; the chat's choice goes into the live-plan.
  expect(w.plan.fragen).toHaveLength(1)
  expect(w.posts).toEqual([{ frage: 'F1', wahl: 'Ausführen' }])

  expect(await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })).toMatchObject({ result: { stdout: 'gelaufen' } })
  expect(w.ausgefuehrt).toEqual(['rm -rf build'])
})

test('Abbrechen: der wiederholte Befehl wird mit der Wahl verweigert, danach fragt er neu', MIT_SKRIPT, async ($, on) => {
  const w = welt(on, { messung: RM_MESSUNG })
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  w.entscheiden('F1', 'Abbrechen')
  const grund = grundVon(await $.tool.call({ tool: 'Bash', command: 'rm -rf build' }))
  expect(grund).toContain('Sprengradius hat den Befehl angehalten und nicht ausgeführt')
  expect(grund).toContain('„Abbrechen“')
  expect(grund).toContain('Er hätte: 12 Dateien löschen (3,4 MB)')
  expect(grund).toContain('Nicht erneut versuchen, außer der Nutzer verlangt es.')
  expect(w.plan.fragen).toHaveLength(1)

  expect(grundVon(await $.tool.call({ tool: 'Bash', command: 'rm -rf build' }))).toContain('AskUserQuestion')
  expect(w.plan.fragen.map(f => f.id)).toEqual(['F1', 'F2'])
  expect(w.ausgefuehrt).toEqual([])
})

test('eine offene Frage wird beim Wiederholen nicht doppelt angelegt', MIT_SKRIPT, async ($, on) => {
  const w = welt(on, { messung: RM_MESSUNG })
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  const grund = grundVon(await $.tool.call({ tool: 'Bash', command: 'rm -rf build' }))
  expect(grund).toContain('F1')
  expect(w.plan.fragen).toHaveLength(1)
  expect(w.ausgefuehrt).toEqual([])
})

test('eine Freigabe gilt nur fuer dieselbe Wirkung: eine andere Messung fragt neu', MIT_SKRIPT, async ($, on) => {
  let ausgabe = RM_AUSGABE
  const w = welt(on, { messung: argv => (argv[0] === 'bash' ? { stdout: ausgabe } : undefined) })
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  w.entscheiden('F1', 'Ausführen')
  ausgabe = RM_AUSGABE.replace(/^12 /, '13 ')
  const grund = grundVon(await $.tool.call({ tool: 'Bash', command: 'rm -rf build' }))
  expect(grund).toContain('13 Dateien löschen')
  expect(w.plan.fragen.map(f => f.frage)).toEqual([FRAGE_RM, 'Sprengradius: `rm -rf build` würde 13 Dateien löschen (3,4 MB)'])
  expect(w.ausgefuehrt).toEqual([])
})

test('ohne live-plan wird nicht gehalten: Hinweis und der Befehl laeuft', MIT_SKRIPT, async ($, on) => {
  const w = welt(on, { skriptDa: false, messung: RM_MESSUNG })
  const r = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  expect(r).toMatchObject({ result: { stdout: 'gelaufen' } })
  expect(w.ausgefuehrt).toEqual(['rm -rf build'])
  expect(w.notizen).toEqual(['Sprengradius: 12 Dateien löschen (3,4 MB) — ohne live-plan nicht gehalten'])
  expect(w.frageEingabe()).toBeNull()
})

test('eine Messung, die scheitert, haelt trotzdem: Wirkung unbekannt', MIT_SKRIPT, async ($, on) => {
  const w = welt(on, { messung: () => 'wirft' })
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  const ein = w.frageEingabe() as { fragen: { frage: string }[] }
  expect(ein.fragen[0]!.frage).toContain('Wirkung unbekannt')
  expect(w.ausgefuehrt).toEqual([])
  w.entscheiden('F1', 'Ausführen')
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  expect(w.ausgefuehrt).toEqual(['rm -rf build'])
})

test('cd und git -C: gemessen wird im aufgeloesten Ordner', MIT_SKRIPT, async ($, on) => {
  const w = welt(on, {
    messung: (argv, cwd) => {
      // The cd resolver: target as argument, answered with the absolute folder.
      if (argv[0] === 'bash' && argv[3] === 'sprengradius' && argv[2]?.includes('pwd -P')) return { stdout: '/andere\n' }
      if (argv[0] === 'git' && argv[1] === 'status' && cwd === '/andere') return { stdout: ' M a.txt\nM  b.txt\n?? neu.txt\n' }
      return { exitCode: 1 }
    },
  })
  const lauf = $.tool.call({ tool: 'Bash', command: 'git -C ../andere reset --hard' })
  await w.clock.settle()
  const aufloesen = w.prozesse.find(p => p.argv[0] === 'bash')!
  expect(aufloesen.argv.slice(3)).toEqual(['sprengradius', '../andere'])
  expect(aufloesen.cwd).toBe('/repo')
  expect(w.frageEingabe()).toMatchObject({
    fragen: [
      {
        frage: 'Sprengradius: `git -C ../andere reset --hard` würde offene Änderungen in 2 Dateien verwerfen',
        optionen: [{ label: 'Ausführen', beschreibung: 'M a.txt, M b.txt' }, { label: 'Abbrechen' }],
      },
    ],
  })
  w.entscheiden('F1', 'Abbrechen')
  await lauf
})

test('git clean: Trockenlauf mit LC_ALL=C, damit lokalisiertes git lesbar bleibt', MIT_SKRIPT, async ($, on) => {
  const w = welt(on, {
    messung: (argv, cwd, env) => {
      if (argv[0] !== 'git' || argv[1] !== 'clean') return { exitCode: 1 }
      // A German git says "Würde neu.txt löschen" unless the locale is C.
      return { stdout: env?.LC_ALL === 'C' ? 'Would remove neu.txt\nWould remove tmp/\n' : 'Würde neu.txt löschen\nWürde tmp/ löschen\n' }
    },
  })
  const lauf = $.tool.call({ tool: 'Bash', command: 'git clean -fd' })
  await w.clock.settle()
  expect(w.prozesse.find(p => p.argv[0] === 'git')!.argv).toEqual(['git', 'clean', '-n', '-d', '--'])
  expect(w.frageEingabe()).toMatchObject({
    fragen: [
      {
        frage: 'Sprengradius: `git clean -fd` würde 2 unversionierte Pfade entfernen',
        optionen: [{ label: 'Ausführen', beschreibung: 'neu.txt, tmp/' }, { label: 'Abbrechen' }],
      },
    ],
  })
  w.entscheiden('F1', 'Abbrechen')
  await lauf
})

const BUT_STATUS = JSON.stringify({
  uncommittedChanges: [
    { cliId: 'oz', filePath: 'a.txt', changeType: 'modified' },
    { cliId: 'tp', filePath: 'b.txt', changeType: 'added' },
  ],
  stacks: [
    {
      cliId: 'x2',
      assignedChanges: [{ cliId: 'qq', filePath: 'c.txt', changeType: 'modified' }],
      branches: [
        {
          cliId: 'ch',
          name: 'change/demo',
          commits: [
            { cliId: 'c1', commitId: '1111111aaaa', message: 'zweiter\n\nText' },
            { cliId: 'c2', commitId: '2222222bbbb', message: 'erster' },
          ],
        },
      ],
    },
  ],
})
const BUT_MESSUNG: Messung = argv => (argv[0] === 'but' && argv[1] === 'status' ? { stdout: BUT_STATUS } : { exitCode: 1 })

test('but discard: betroffene Pfade aus but status --json', MIT_SKRIPT, async ($, on) => {
  const w = welt(on, { messung: BUT_MESSUNG })
  const lauf = $.tool.call({ tool: 'Bash', command: 'but discard oz qq' })
  await w.clock.settle()
  expect(w.prozesse.find(p => p.argv[0] === 'but')!.argv).toEqual(['but', 'status', '--json'])
  expect(w.frageEingabe()).toMatchObject({
    fragen: [
      {
        frage: 'Sprengradius: `but discard oz qq` würde Änderungen in 2 Dateien verwerfen',
        optionen: [{ label: 'Ausführen', beschreibung: 'a.txt, c.txt' }, { label: 'Abbrechen' }],
      },
    ],
  })
  w.entscheiden('F1', 'Abbrechen')
  await lauf
})

test('but land: Branch und Zahl der Commits aus but status --json', MIT_SKRIPT, async ($, on) => {
  const w = welt(on, { messung: BUT_MESSUNG })
  const lauf = $.tool.call({ tool: 'Bash', command: 'but land ch' })
  await w.clock.settle()
  expect(w.frageEingabe()).toMatchObject({
    fragen: [
      {
        frage: 'Sprengradius: `but land ch` würde Branch change/demo mit 2 Commits direkt auf den Zielbranch bringen',
        optionen: [{ label: 'Ausführen', beschreibung: '1111111 zweiter, 2222222 erster' }, { label: 'Abbrechen' }],
      },
    ],
  })
  w.entscheiden('F1', 'Abbrechen')
  await lauf
})

test('but discard mit unbekannter Id: gehalten, Wirkung unbekannt', MIT_SKRIPT, async ($, on) => {
  const w = welt(on, { messung: BUT_MESSUNG })
  const lauf = $.tool.call({ tool: 'Bash', command: 'but discard zz9' })
  await w.clock.settle()
  const ein = w.frageEingabe() as { fragen: { frage: string }[] }
  expect(ein.fragen[0]!.frage).toContain('Wirkung unbekannt')
  w.entscheiden('F1', 'Abbrechen')
  await lauf
  expect(w.ausgefuehrt).toEqual([])
})
