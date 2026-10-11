import { expect, mock, test, type TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

const ID = 'sitzung-1'
const API = 'http://localhost:4410/api/repo/sitzung-1'
const URL_SEITE = 'http://localhost:4410/repo/sitzung-1'
const SKRIPT = '/opt/lp/live-plan'
const MIT_SKRIPT = { options: { skript: SKRIPT } }

type PlanFrage = { id: string; frage: string; optionen: { label: string }[]; entscheidung: string }

const FRAGE = {
  question: 'Welche Datenbank?',
  header: 'DB',
  multiSelect: false,
  options: [
    { label: 'Postgres', description: 'Server' },
    { label: 'SQLite', description: 'Datei' },
  ],
}

const ok = (stdout = '') => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})
const antwort = (status: number, text: string) => ({ value: { status, ok: status < 300, headers: {}, text } })

// The world beneath the plugin: the live-plan script and server in memory, a mocked clock.
// `live-plan frage` appends F<n>; `/warte` answers once a decision lands or after 20 s.
function welt(on: On, opts: { fragen?: PlanFrage[]; server?: boolean; startHilft?: boolean; skriptDa?: boolean; store?: Record<string, unknown> } = {}) {
  const clock = mock.clock(on, { now: 10_000 })
  mock.env(on, { HOME: '/home/t' })
  mock.store(on, opts.store)
  const plan = { fragen: [...(opts.fragen ?? [])], verlauf: 0, server: opts.server ?? true }
  const prozesse: { argv: string[]; stdin?: string }[] = []
  const posts: { frage: string; wahl: string; eigen?: boolean }[] = []
  const notizen: string[] = []
  const prompts: string[] = []
  const status: (string | undefined)[] = []
  const dialog = { geoeffnet: 0, abgebrochen: 0 }
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
  on('fs.write', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    prozesse.push({ argv: [...e.argv], ...(e.init?.stdin !== undefined ? { stdin: e.init.stdin } : {}) })
    if (e.argv[2] === 'frage') {
      const ein = JSON.parse(e.init?.stdin ?? '{}') as { fragen: { frage: string; optionen: { label: string }[] }[] }
      const ids = ein.fragen.map(f => {
        const id = `F${plan.fragen.length + 1}`
        plan.fragen.push({ id, frage: f.frage, optionen: f.optionen, entscheidung: '' })
        return id
      })
      return ok(`${JSON.stringify({ ids, url: URL_SEITE })}\n`)
    }
    if (e.argv[2] === 'start' && opts.startHilft !== false) plan.server = true
    return ok()
  })
  on('http.fetch', async ($, e) => {
    if (!plan.server) return { deny: 'ECONNREFUSED' }
    if (e.init?.method === 'POST' && e.url === `${API}/entscheidung`) {
      const b = JSON.parse(e.init.body ?? '{}') as { frage: string; wahl: string; eigen?: boolean }
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
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('ui.notify', ($, e) => {
    notizen.push(e.text)
    return { value: { isSent: true as const, channel: 'kitty' as const } }
  })
  on('ui.status', ($, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))

  // The chat dialog: answers `wahl` after `nachMs`, or never; counts an abort from above.
  const chat = (wahl?: string, nachMs = 5_000) =>
    on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
      dialog.geoeffnet += 1
      next.signal.addEventListener('abort', () => {
        dialog.abgebrochen += 1
      })
      if (wahl === undefined) {
        await new Promise<void>(r => next.signal.addEventListener('abort', () => r()))
        return { deny: 'abgebrochen' }
      }
      await clock.sleep(nachMs)
      return { result: { questions: e.questions, answers: { [FRAGE.question]: wahl } } }
    })

  return { clock, plan, prozesse, posts, notizen, prompts, status, dialog, entscheiden, chat }
}

// A main-loop turn: turn.start, then turn.complete unless `laufen` keeps it open.
async function zug($: Parameters<TestBody>[0], turnId: string) {
  await $.turn.start({ text: 'hallo', turnId })
  return () => $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId, reason: 'answer' })
}

test('Browser-Antwort wird zum Ergebnis von AskUserQuestion, der Dialog wird abgebrochen', MIT_SKRIPT, async ($, on) => {
  const w = welt(on)
  w.chat()
  const lauf = $.tool.call({ tool: 'AskUserQuestion', questions: [FRAGE] })
  await w.clock.settle()

  expect(w.prozesse[0]!.argv).toEqual(['bun', SKRIPT, 'frage', ID])
  expect(JSON.parse(w.prozesse[0]!.stdin!)).toEqual({
    quelle: 'AskUserQuestion',
    fragen: [
      {
        frage: 'Welche Datenbank?',
        kopf: 'DB',
        multi: false,
        optionen: [
          { label: 'Postgres', beschreibung: 'Server' },
          { label: 'SQLite', beschreibung: 'Datei' },
        ],
      },
    ],
  })
  expect(w.status).toEqual([`Frage offen im live-plan: ${URL_SEITE}`])
  expect(w.dialog.geoeffnet).toBe(1)

  w.entscheiden('F1', 'SQLite')
  const r = await lauf
  expect(r).toMatchObject({ result: { questions: [FRAGE], answers: { 'Welche Datenbank?': 'SQLite' } } })
  expect(w.dialog.abgebrochen).toBe(1)
  expect(w.status).toEqual([`Frage offen im live-plan: ${URL_SEITE}`, undefined])
  expect(w.posts).toEqual([])

  // Its own question never wakes the session.
  await w.clock.advance(9_000)
  expect(w.prompts).toEqual([])
})

test('Chat-Antwort gewinnt und wird in die YAML gespiegelt', MIT_SKRIPT, async ($, on) => {
  const w = welt(on)
  w.chat('Postgres')
  const lauf = $.tool.call({ tool: 'AskUserQuestion', questions: [FRAGE] })
  await w.clock.settle()
  await w.clock.advance(5_000)
  const r = await lauf
  expect(r).toMatchObject({ result: { answers: { 'Welche Datenbank?': 'Postgres' } } })
  expect(w.posts).toEqual([{ frage: 'F1', wahl: 'Postgres' }])
  expect(w.dialog.abgebrochen).toBe(0)
  expect(w.status.at(-1)).toBeUndefined()
})

test('eigene Antwort aus dem Chat (Other) wird mit eigen gespiegelt', MIT_SKRIPT, async ($, on) => {
  const w = welt(on)
  w.chat('etwas ganz anderes')
  const lauf = $.tool.call({ tool: 'AskUserQuestion', questions: [FRAGE] })
  await w.clock.settle()
  await w.clock.advance(5_000)
  expect(await lauf).toMatchObject({ result: { answers: { 'Welche Datenbank?': 'etwas ganz anderes' } } })
  expect(w.posts).toEqual([{ frage: 'F1', wahl: 'etwas ganz anderes', eigen: true }])
  expect(w.plan.fragen[0]!.entscheidung).toBe('etwas ganz anderes')
})

test('eigene Antwort aus dem Chat wird auf eine Zeile und 500 Zeichen gekuerzt statt verworfen', MIT_SKRIPT, async ($, on) => {
  const w = welt(on)
  const lang = `  erste Zeile\nzweite\tZeile \u202Edreh ${'x'.repeat(600)}`
  w.chat(lang)
  const lauf = $.tool.call({ tool: 'AskUserQuestion', questions: [FRAGE] })
  await w.clock.settle()
  await w.clock.advance(5_000)
  // The chat keeps its own answer; only the mirror is shortened.
  expect(await lauf).toMatchObject({ result: { answers: { 'Welche Datenbank?': lang } } })
  expect(w.posts).toHaveLength(1)
  const { wahl, eigen } = w.posts[0]!
  expect(eigen).toBe(true)
  expect([...wahl].length).toBe(500)
  expect(wahl.startsWith('erste Zeile zweite Zeile dreh x')).toBe(true)
  expect(/[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u.test(wahl)).toBe(false)
  expect(wahl).toBe(wahl.trim())
})

test('eine eigene Antwort im Browser schliesst AskUserQuestion mit genau diesem Text', MIT_SKRIPT, async ($, on) => {
  const w = welt(on)
  w.chat()
  const lauf = $.tool.call({ tool: 'AskUserQuestion', questions: [FRAGE] })
  await w.clock.settle()
  w.entscheiden('F1', 'Lieber DuckDB, "embedded"')
  const r = await lauf
  expect(r).toMatchObject({ result: { questions: [FRAGE], answers: { 'Welche Datenbank?': 'Lieber DuckDB, "embedded"' } } })
  expect(w.dialog.abgebrochen).toBe(1)
  expect(w.posts).toEqual([])
})

test('Rueckfall ohne Skript: nur der Chat, kein Prozess', MIT_SKRIPT, async ($, on) => {
  const w = welt(on, { skriptDa: false })
  w.chat('SQLite', 1_000)
  const lauf = $.tool.call({ tool: 'AskUserQuestion', questions: [FRAGE] })
  await w.clock.settle()
  await w.clock.advance(1_000)
  expect(await lauf).toMatchObject({ result: { answers: { 'Welche Datenbank?': 'SQLite' } } })
  expect(w.prozesse).toEqual([])
  expect(w.status).toEqual([])
})

test('Rueckfall, wenn der Server auch nach start nicht antwortet', MIT_SKRIPT, async ($, on) => {
  const w = welt(on, { server: false, startHilft: false })
  w.chat('SQLite', 1_000)
  const lauf = $.tool.call({ tool: 'AskUserQuestion', questions: [FRAGE] })
  await w.clock.settle()
  await w.clock.advance(1_000)
  expect(await lauf).toMatchObject({ result: { answers: { 'Welche Datenbank?': 'SQLite' } } })
  expect(w.prozesse.map(p => p.argv[2])).toEqual(['frage', 'start'])
  expect(w.status).toEqual([])
})

test('ein gestarteter Server traegt die Frage in den Browser', MIT_SKRIPT, async ($, on) => {
  const w = welt(on, { server: false })
  w.chat()
  const lauf = $.tool.call({ tool: 'AskUserQuestion', questions: [FRAGE] })
  await w.clock.settle()
  expect(w.prozesse.map(p => p.argv[2])).toEqual(['frage', 'start'])
  w.entscheiden('F1', 'Postgres')
  expect(await lauf).toMatchObject({ result: { answers: { 'Welche Datenbank?': 'Postgres' } } })
})

const OFFEN: PlanFrage = { id: 'F2', frage: 'Welcher Port?', optionen: [{ label: '4410' }, { label: '8080' }], entscheidung: '' }

test('eine Entscheidung im Browser weckt die ruhende Sitzung genau einmal', async ($, on) => {
  const w = welt(on, { fragen: [{ ...OFFEN }] })
  const ende = await zug($, 't-1')
  await ende()
  await w.clock.advance(3_000)
  expect(w.notizen).toEqual(['live-plan: F2 offen — Welcher Port?'])
  expect(w.prompts).toEqual([])

  w.entscheiden('F2', '8080')
  await w.clock.advance(3_000)
  expect(w.prompts).toEqual(['live-plan: F2 = 8080'])
  await w.clock.advance(9_000)
  expect(w.prompts).toEqual(['live-plan: F2 = 8080'])
  expect(w.notizen).toHaveLength(1)
})

test('eine eigene Antwort im Browser meldet sich markiert und in Anfuehrungszeichen', async ($, on) => {
  const w = welt(on, { fragen: [{ ...OFFEN }, { ...OFFEN, id: 'F3', frage: 'Welche Farbe?' }] })
  const ende = await zug($, 't-6')
  await ende()
  await w.clock.advance(3_000)
  w.entscheiden('F2', 'lieber 9000, sag "bitte"')
  w.entscheiden('F3', '8080')
  await w.clock.advance(3_000)
  expect(w.prompts).toEqual(['live-plan: F2 = (eigene Antwort) "lieber 9000, sag \\"bitte\\""\nlive-plan: F3 = 8080'])
})

test('eine eigene Antwort mit Zeilenumbruch (vom Agenten geschrieben) meldet sich in einer Zeile', async ($, on) => {
  const w = welt(on, { fragen: [{ ...OFFEN }] })
  const ende = await zug($, 't-7')
  await ende()
  await w.clock.advance(3_000)
  w.entscheiden('F2', 'zwei\nZeilen')
  await w.clock.advance(3_000)
  expect(w.prompts).toEqual(['live-plan: F2 = (eigene Antwort) "zwei Zeilen"'])
})

test('waehrend eines Zuges gesammelt, beim Zugende gemeldet', async ($, on) => {
  const w = welt(on, { fragen: [{ ...OFFEN }, { ...OFFEN, id: 'F3', frage: 'Welche Farbe?' }] })
  const ende = await zug($, 't-2')
  await w.clock.advance(3_000)
  expect(w.notizen).toEqual(['live-plan: F2 offen — Welcher Port?', 'live-plan: F3 offen — Welche Farbe?'])

  w.entscheiden('F2', '4410')
  w.entscheiden('F3', '8080')
  await w.clock.advance(6_000)
  expect(w.prompts).toEqual([])

  await ende()
  expect(w.prompts).toEqual(['live-plan: F2 = 4410\nlive-plan: F3 = 8080'])
  await w.clock.advance(6_000)
  expect(w.prompts).toHaveLength(1)
})

test('schon gemeldete Fragen bleiben nach einem Neuladen still', async ($, on) => {
  const w = welt(on, {
    fragen: [{ ...OFFEN, entscheidung: '8080' }],
    store: { [`fragen:${ID}`]: { offen: ['F2'], gemeldet: ['F2'] } },
  })
  const ende = await zug($, 't-3')
  await ende()
  await w.clock.advance(6_000)
  expect(w.prompts).toEqual([])
  expect(w.notizen).toEqual([])
})

test('Entscheidungen von Fragen, die nie offen gesehen wurden, wecken nicht', async ($, on) => {
  const w = welt(on, { fragen: [{ ...OFFEN, entscheidung: '4410' }] })
  const ende = await zug($, 't-4')
  await ende()
  await w.clock.advance(6_000)
  expect(w.prompts).toEqual([])
  expect(w.notizen).toEqual([])
})

test('ohne Server bleibt der Takt still', async ($, on) => {
  const w = welt(on, { fragen: [{ ...OFFEN }], server: false })
  const ende = await zug($, 't-5')
  await ende()
  await w.clock.advance(6_000)
  expect(w.prompts).toEqual([])
  expect(w.notizen).toEqual([])
})
