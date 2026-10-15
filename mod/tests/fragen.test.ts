import { expect, mock, test, type TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

const ID = 'sitzung-1'
const API = 'http://localhost:4410/api/repo/sitzung-1'
const URL_SEITE = 'http://localhost:4410/repo/sitzung-1'
const SKRIPT = '/opt/lp/live-plan'
const MIT_SKRIPT = { options: { skript: SKRIPT } }

type PlanFrage = { id: string; frage: string; optionen: { label: string }[]; entscheidung: string; zurueckgezogen?: string }

const FRAGE = {
  question: 'Welche Datenbank?',
  header: 'DB',
  multiSelect: false,
  options: [
    { label: 'Postgres', description: 'Server' },
    { label: 'SQLite', description: 'Datei' },
  ],
}

type ChatEnde = { deny: string } | { isError: true; result: unknown } | { answers: Record<string, unknown>; response?: string }

const ok = (stdout = '') => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})
const antwort = (status: number, text: string) => ({ value: { status, ok: status < 300, headers: {}, text } })

// The world beneath the plugin: the live-plan script and server in memory, a mocked clock.
// `live-plan frage` appends F<n>; `/warte` answers once a decision lands or after 20 s.
// `/zurueckziehen` and `live-plan frage-zurueck` withdraw an undecided question; a decided one they
// name in the field `entschieden` (409) and with exit 3, their prose differs from the server's on
// purpose: the mod reads only field and exit code (K2). `postFehler` POSTs to `/entscheidung` answer
// `postStatus` (500) first; `unaenderbar`: the file cannot be changed line by line (409);
// `entschiedenUnterwegs`: the browser decides a question just before its withdrawal arrives;
// `zurueckOhneServer`: `/zurueckziehen` is not reachable, the script withdraws;
// `live-plan frage-zurueck --alle GRUND` withdraws every open question at once; `yamlDa` false:
// the session has no YAML.
function welt(
  on: On,
  opts: {
    fragen?: PlanFrage[]
    server?: boolean
    startHilft?: boolean
    skriptDa?: boolean
    store?: Record<string, unknown>
    postFehler?: number
    postStatus?: number
    unaenderbar?: boolean
    entschiedenUnterwegs?: string
    zurueckOhneServer?: boolean
    yamlDa?: boolean
  } = {},
) {
  const clock = mock.clock(on, { now: 10_000 })
  mock.env(on, { HOME: '/home/t' })
  mock.store(on, opts.store)
  const plan = { fragen: [...(opts.fragen ?? [])], verlauf: 0, server: opts.server ?? true }
  const prozesse: { argv: string[]; stdin?: string }[] = []
  const posts: { frage: string; wahl: string; eigen?: boolean }[] = []
  const zurueck: { frage: string; grund: string; weg: 'server' | 'skript' }[] = []
  const logs: string[] = []
  const notizen: string[] = []
  let postFehler = opts.postFehler ?? 0
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
  // Withdraws `id` unless it is decided: 'ok', else 'entschieden' or 'unbekannt'.
  const zurueckziehen = (id: string, grund: string, weg: 'server' | 'skript') => {
    const f = plan.fragen.find(x => x.id === id)
    if (f && !f.entscheidung && opts.entschiedenUnterwegs) f.entscheidung = opts.entschiedenUnterwegs
    if (!f) return 'unbekannt' as const
    if (f.entscheidung) return 'entschieden' as const
    zurueck.push({ frage: id, grund, weg })
    f.zurueckgezogen ??= grund
    plan.verlauf += 1
    return 'ok' as const
  }
  const lauf = (exitCode: number, stderr = '') => ({
    value: { exitCode, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false },
  })

  on('fs.stat', ($, e) =>
    (e.path.endsWith('.yaml') ? opts.yamlDa === false : opts.skriptDa === false)
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
    if (e.argv[2] === 'frage-zurueck' && opts.unaenderbar) return lauf(1, 'live-plan: eine Frage steht in Flow-Form\n')
    if (e.argv[2] === 'frage-zurueck' && e.argv[3] === '--alle') {
      for (const f of plan.fragen.filter(x => !x.entscheidung && !x.zurueckgezogen)) zurueckziehen(f.id, e.argv[4]!, 'skript')
      return lauf(0)
    }
    if (e.argv[2] === 'frage-zurueck') {
      const r = zurueckziehen(e.argv[3]!, e.argv[4]!, 'skript')
      return r === 'ok' ? lauf(0) : r === 'entschieden' ? lauf(3, `live-plan: ${e.argv[3]} steht\n`) : lauf(1, `live-plan: ${e.argv[3]} fehlt\n`)
    }
    if (e.argv[2] === 'start' && opts.startHilft !== false) plan.server = true
    return ok()
  })
  on('http.fetch', async ($, e) => {
    if (!plan.server) return { deny: 'ECONNREFUSED' }
    if (e.init?.method === 'POST' && e.url === `${API}/entscheidung`) {
      const b = JSON.parse(e.init.body ?? '{}') as { frage: string; wahl: string; eigen?: boolean }
      posts.push(b)
      if (postFehler > 0) {
        postFehler -= 1
        return antwort(opts.postStatus ?? 500, '{"fehler":"kaputt"}')
      }
      entscheiden(b.frage, b.wahl)
      return antwort(200, '{"ok":true}')
    }
    if (e.init?.method === 'POST' && e.url === `${API}/zurueckziehen` && opts.unaenderbar) {
      return antwort(409, '{"fehler":"eine Frage steht in Flow-Form"}')
    }
    if (e.init?.method === 'POST' && e.url === `${API}/zurueckziehen` && opts.zurueckOhneServer) return { deny: 'ECONNREFUSED' }
    if (e.init?.method === 'POST' && e.url === `${API}/zurueckziehen`) {
      const b = JSON.parse(e.init.body ?? '{}') as { frage: string; grund: string }
      const r = zurueckziehen(b.frage, b.grund, 'server')
      if (r === 'ok') return antwort(200, '{"ok":true}')
      const f = plan.fragen.find(x => x.id === b.frage)
      return r === 'entschieden' ? antwort(409, JSON.stringify({ fehler: 'steht', entschieden: f?.entscheidung })) : antwort(404, '{"fehler":"fehlt"}')
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
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
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

  // The chat dialog ending after `nachMs` with a refusal, an error, or answers of any shape.
  const chatEnde = (ende: ChatEnde, nachMs = 5_000) =>
    on('tool.call', { tool: 'AskUserQuestion' }, async ($, e) => {
      dialog.geoeffnet += 1
      await clock.sleep(nachMs)
      if (!('answers' in ende)) return ende
      return { result: { questions: e.questions, answers: ende.answers, ...(ende.response ? { response: ende.response } : {}) } }
    })

  return { clock, plan, prozesse, posts, zurueck, logs, notizen, prompts, status, dialog, entscheiden, chat, chatEnde }
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

test('Rueckfall, wenn der Server auch nach start nicht antwortet: die angelegte Frage bleibt nicht offen', MIT_SKRIPT, async ($, on) => {
  const w = welt(on, { server: false, startHilft: false })
  w.chat('SQLite', 1_000)
  const lauf = $.tool.call({ tool: 'AskUserQuestion', questions: [FRAGE] })
  await w.clock.settle()
  await w.clock.advance(1_000)
  expect(await lauf).toMatchObject({ result: { answers: { 'Welche Datenbank?': 'SQLite' } } })
  // The chat's answer cannot reach the server: the script closes the question in the YAML itself,
  // and its reason says the answer is lost (S2: accepted, not stored elsewhere).
  expect(w.prozesse.map(p => p.argv.slice(2))).toEqual([
    ['frage', ID],
    ['start'],
    ['frage-zurueck', 'F1', 'im Chat beantwortet, live-plan nicht erreichbar – Antwort nicht gespeichert', '--sitzung', ID],
  ])
  expect(w.plan.fragen[0]!.zurueckgezogen).toBe('im Chat beantwortet, live-plan nicht erreichbar – Antwort nicht gespeichert')
  expect(w.status).toEqual([])
  expect(w.logs).toEqual([])
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

// ---------------------------------------------------------------------------
// #27: a question the session closes is closed in the live-plan too.

test('Esc im Chat (deny) zieht die Frage im live-plan zurueck', MIT_SKRIPT, async ($, on) => {
  const w = welt(on)
  w.chatEnde({ deny: 'Der Nutzer hat abgelehnt' })
  const lauf = $.tool.call({ tool: 'AskUserQuestion', questions: [FRAGE] })
  await w.clock.settle()
  await w.clock.advance(5_000)
  expect(await lauf).toEqual({ deny: 'Der Nutzer hat abgelehnt' })
  expect(w.zurueck).toEqual([{ frage: 'F1', grund: 'in der Sitzung abgebrochen', weg: 'server' }])
  expect(w.plan.fragen[0]).toMatchObject({ entscheidung: '', zurueckgezogen: 'in der Sitzung abgebrochen' })
  expect(w.posts).toEqual([])
})

test('ein unterbrochener Dialog (isError) zieht alle Fragen des Aufrufs zurueck', MIT_SKRIPT, async ($, on) => {
  const w = welt(on)
  const ZWEITE = { ...FRAGE, question: 'Welcher Port?', options: [{ label: '4410' }, { label: '8080' }] }
  w.chatEnde({ isError: true, result: 'Interrupted by user' })
  const lauf = $.tool.call({ tool: 'AskUserQuestion', questions: [FRAGE, ZWEITE] })
  await w.clock.settle()
  await w.clock.advance(5_000)
  expect(await lauf).toMatchObject({ isError: true })
  expect(w.zurueck.map(z => [z.frage, z.grund])).toEqual([
    ['F1', 'in der Sitzung abgebrochen'],
    ['F2', 'in der Sitzung abgebrochen'],
  ])
})

test('eine unbeantwortete Frage (keine oder leere Antwort) wird zurueckgezogen, die beantwortete entschieden', MIT_SKRIPT, async ($, on) => {
  const w = welt(on)
  const ZWEITE = { ...FRAGE, question: 'Welcher Port?', options: [{ label: '4410' }, { label: '8080' }] }
  const DRITTE = { ...FRAGE, question: 'Welche Farbe?', options: [{ label: 'Rot' }, { label: 'Blau' }] }
  w.chatEnde({ answers: { 'Welche Datenbank?': 'SQLite', 'Welche Farbe?': '  \n ' } })
  const lauf = $.tool.call({ tool: 'AskUserQuestion', questions: [FRAGE, ZWEITE, DRITTE] })
  await w.clock.settle()
  await w.clock.advance(5_000)
  await lauf
  expect(w.posts).toEqual([{ frage: 'F1', wahl: 'SQLite' }])
  expect(w.zurueck.map(z => [z.frage, z.grund])).toEqual([
    ['F2', 'in der Sitzung nicht beantwortet'],
    ['F3', 'in der Sitzung nicht beantwortet'],
  ])
})

test('Mehrfachauswahl als Liste wird mit Komma verbunden gespiegelt statt verworfen', MIT_SKRIPT, async ($, on) => {
  const w = welt(on)
  w.chatEnde({ answers: { 'Welche Datenbank?': ['Postgres', 'SQLite'] } })
  const lauf = $.tool.call({ tool: 'AskUserQuestion', questions: [{ ...FRAGE, multiSelect: true }] })
  await w.clock.settle()
  await w.clock.advance(5_000)
  await lauf
  expect(w.posts).toEqual([{ frage: 'F1', wahl: 'Postgres, SQLite', eigen: true }])
  expect(w.zurueck).toEqual([])
})

test('eine freie Antwort (response) ohne Wahl schliesst die einzige Frage als eigene Antwort', MIT_SKRIPT, async ($, on) => {
  const w = welt(on)
  w.chatEnde({ answers: {}, response: 'erst morgen entscheiden' })
  const lauf = $.tool.call({ tool: 'AskUserQuestion', questions: [FRAGE] })
  await w.clock.settle()
  await w.clock.advance(5_000)
  await lauf
  expect(w.posts).toEqual([{ frage: 'F1', wahl: 'erst morgen entscheiden', eigen: true }])
})

test('eine abgelehnte Spiegelung (HTTP 500) wird wiederholt', MIT_SKRIPT, async ($, on) => {
  const w = welt(on, { postFehler: 1 })
  w.chat('Postgres')
  const lauf = $.tool.call({ tool: 'AskUserQuestion', questions: [FRAGE] })
  await w.clock.settle()
  await w.clock.advance(5_000)
  await lauf
  expect(w.posts).toEqual([
    { frage: 'F1', wahl: 'Postgres' },
    { frage: 'F1', wahl: 'Postgres' },
  ])
  expect(w.plan.fragen[0]!.entscheidung).toBe('Postgres')
  expect(w.zurueck).toEqual([])
})

test('scheitert die Spiegelung zweimal (HTTP 500), wird die Frage mit Fehler-Grund zurueckgezogen statt offen gelassen', MIT_SKRIPT, async ($, on) => {
  const w = welt(on, { postFehler: 2 })
  w.chat('Postgres')
  const lauf = $.tool.call({ tool: 'AskUserQuestion', questions: [FRAGE] })
  await w.clock.settle()
  await w.clock.advance(5_000)
  await lauf
  expect(w.posts).toHaveLength(2)
  expect(w.zurueck).toEqual([{ frage: 'F1', grund: 'im Chat beantwortet, Fehler im live-plan (HTTP 500) – Antwort nicht gespeichert', weg: 'server' }])
})

test('lehnt der live-plan die Antwort ab (422), wird nicht wiederholt, sondern zurueckgezogen', MIT_SKRIPT, async ($, on) => {
  const w = welt(on, { postFehler: 2, postStatus: 422 })
  w.chat('Postgres')
  const lauf = $.tool.call({ tool: 'AskUserQuestion', questions: [FRAGE] })
  await w.clock.settle()
  await w.clock.advance(5_000)
  await lauf
  expect(w.posts).toEqual([{ frage: 'F1', wahl: 'Postgres' }])
  expect(w.zurueck).toEqual([{ frage: 'F1', grund: 'im Chat beantwortet, vom live-plan abgelehnt (HTTP 422) – Antwort nicht gespeichert', weg: 'server' }])
  expect(w.plan.fragen[0]).toMatchObject({ entscheidung: '' })
})

test('eine Antwort, die kein Text ist (Zahl, Objekt), zaehlt als unbeantwortet', MIT_SKRIPT, async ($, on) => {
  const w = welt(on)
  const ZWEITE = { ...FRAGE, question: 'Welcher Port?', options: [{ label: '4410' }, { label: '8080' }] }
  w.chatEnde({ answers: { 'Welche Datenbank?': 42, 'Welcher Port?': { label: '4410' } } })
  const lauf = $.tool.call({ tool: 'AskUserQuestion', questions: [FRAGE, ZWEITE] })
  await w.clock.settle()
  await w.clock.advance(5_000)
  await lauf
  expect(w.posts).toEqual([])
  expect(w.zurueck.map(z => [z.frage, z.grund])).toEqual([
    ['F1', 'in der Sitzung nicht beantwortet'],
    ['F2', 'in der Sitzung nicht beantwortet'],
  ])
})

test('eine freie Antwort (response) bei zwei Fragen: die ohne eigene Wahl wird mit passendem Grund zurueckgezogen', MIT_SKRIPT, async ($, on) => {
  const w = welt(on)
  const ZWEITE = { ...FRAGE, question: 'Welcher Port?', options: [{ label: '4410' }, { label: '8080' }] }
  w.chatEnde({ answers: { 'Welche Datenbank?': 'SQLite' }, response: 'den Port spaeter' })
  const lauf = $.tool.call({ tool: 'AskUserQuestion', questions: [FRAGE, ZWEITE] })
  await w.clock.settle()
  await w.clock.advance(5_000)
  await lauf
  expect(w.posts).toEqual([{ frage: 'F1', wahl: 'SQLite' }])
  expect(w.zurueck.map(z => [z.frage, z.grund])).toEqual([['F2', 'im Chat frei beantwortet, keiner Frage zuzuordnen']])
})

test('ein Lesefehler laesst die Browser-Antwort nicht fallen: sie erreicht den Dialog trotzdem', MIT_SKRIPT, async ($, on) => {
  const w = welt(on)
  w.chat('Postgres', 120_000)
  const lauf = $.tool.call({ tool: 'AskUserQuestion', questions: [FRAGE] })
  await w.clock.settle()
  // The server goes away while the hook long-polls: the next read fails.
  w.plan.server = false
  await w.clock.advance(20_000)
  await w.clock.advance(3_000)
  w.plan.server = true
  w.entscheiden('F1', 'SQLite')
  await w.clock.advance(3_000)
  expect(await lauf).toMatchObject({ result: { answers: { 'Welche Datenbank?': 'SQLite' } } })
  expect(w.dialog.abgebrochen).toBe(1)
})

test('auch ein langer Ausfall ueber viele Takte beendet die Browser-Antwort nicht: nur Chat oder Abbruch tun es', MIT_SKRIPT, async ($, on) => {
  const w = welt(on)
  w.chat('Postgres', 600_000)
  const lauf = $.tool.call({ tool: 'AskUserQuestion', questions: [FRAGE] })
  await w.clock.settle()
  w.plan.server = false
  await w.clock.advance(20_000)
  for (let i = 0; i < 20; i++) await w.clock.advance(3_000)
  w.plan.server = true
  w.entscheiden('F1', 'SQLite')
  await w.clock.advance(3_000)
  expect(await lauf).toMatchObject({ result: { answers: { 'Welche Datenbank?': 'SQLite' } } })
  expect(w.dialog.abgebrochen).toBe(1)
})

test('unterwegs im Browser entschieden: der Server sagt es im Feld entschieden, kein Skript, kein Hinweis', MIT_SKRIPT, async ($, on) => {
  const w = welt(on, { entschiedenUnterwegs: 'Postgres' })
  w.chatEnde({ deny: 'Der Nutzer hat abgelehnt' })
  const lauf = $.tool.call({ tool: 'AskUserQuestion', questions: [FRAGE] })
  await w.clock.settle()
  await w.clock.advance(5_000)
  await lauf
  expect(w.prozesse.filter(p => p.argv[2] === 'frage-zurueck')).toEqual([])
  expect(w.zurueck).toEqual([])
  expect(w.logs).toEqual([])
  expect(w.plan.fragen[0]).toMatchObject({ entscheidung: 'Postgres' })
})

test('unterwegs entschieden, ohne Server: das Skript sagt es mit Exit 3, kein Hinweis', MIT_SKRIPT, async ($, on) => {
  const w = welt(on, { entschiedenUnterwegs: 'Postgres', zurueckOhneServer: true })
  w.chatEnde({ deny: 'Der Nutzer hat abgelehnt' })
  const lauf = $.tool.call({ tool: 'AskUserQuestion', questions: [FRAGE] })
  await w.clock.settle()
  await w.clock.advance(5_000)
  await lauf
  expect(w.prozesse.filter(p => p.argv[2] === 'frage-zurueck').map(p => p.argv.slice(3))).toEqual([['F1', 'in der Sitzung abgebrochen', '--sitzung', ID]])
  expect(w.zurueck).toEqual([])
  expect(w.logs).toEqual([])
})

test('laesst sich die Datei nicht aendern (409, nicht entschieden), versucht es das Skript und sagt es im Verlauf', MIT_SKRIPT, async ($, on) => {
  const w = welt(on, { unaenderbar: true })
  w.chatEnde({ deny: 'Der Nutzer hat abgelehnt' })
  const lauf = $.tool.call({ tool: 'AskUserQuestion', questions: [FRAGE] })
  await w.clock.settle()
  await w.clock.advance(5_000)
  await lauf
  expect(w.prozesse.filter(p => p.argv[2] === 'frage-zurueck').map(p => p.argv.slice(3))).toEqual([['F1', 'in der Sitzung abgebrochen', '--sitzung', ID]])
  expect(w.logs).toEqual(['live-plan: F1 nicht zurueckgezogen (in der Sitzung abgebrochen)'])
})

test('Sitzungsende zieht alle offenen Fragen der Sitzung zurueck, auch die des Agenten; entschiedene und zurueckgezogene bleiben', async ($, on) => {
  const w = welt(on, {
    fragen: [
      { ...OFFEN, id: 'F1' },
      { ...OFFEN },
      { ...OFFEN, id: 'F3', entscheidung: '8080' },
      { ...OFFEN, id: 'F4', zurueckgezogen: 'in der Sitzung abgebrochen' },
    ],
    // F2 never went through the mod (the agent wrote it): it is closed all the same (B1).
    store: { [`fragen:${ID}`]: { offen: [], gemeldet: ['F1', 'F3'] } },
  })
  await $.session.end({ reason: 'prompt_input_exit', sessionId: ID, resume: { id: ID } })
  expect(w.zurueck).toEqual([
    { frage: 'F1', grund: 'Sitzung beendet', weg: 'server' },
    { frage: 'F2', grund: 'Sitzung beendet', weg: 'server' },
  ])
  expect(w.plan.fragen.map(f => f.zurueckgezogen)).toEqual(['Sitzung beendet', 'Sitzung beendet', undefined, 'in der Sitzung abgebrochen'])
})

test('Sitzungsende ohne Server: das Skript zieht alle offenen Fragen in der YAML zurueck, in einem Aufruf', async ($, on) => {
  const w = welt(on, {
    server: false,
    fragen: [{ ...OFFEN, id: 'F1' }, { ...OFFEN }, { ...OFFEN, id: 'F3', entscheidung: '8080' }],
  })
  await $.session.end({ reason: 'prompt_input_exit', sessionId: ID, resume: { id: ID } })
  expect(w.prozesse.filter(p => p.argv[2] === 'frage-zurueck').map(p => p.argv.slice(2))).toEqual([
    ['frage-zurueck', '--alle', 'Sitzung beendet', '--sitzung', ID],
  ])
  expect(w.plan.fragen.map(f => f.zurueckgezogen)).toEqual(['Sitzung beendet', 'Sitzung beendet', undefined])
  expect(w.logs).toEqual([])
})

test('Sitzungsende ohne Server, das Skript scheitert: ein Hinweis im Verlauf', async ($, on) => {
  const w = welt(on, { server: false, unaenderbar: true, fragen: [{ ...OFFEN }] })
  await $.session.end({ reason: 'prompt_input_exit', sessionId: ID, resume: { id: ID } })
  expect(w.plan.fragen[0]!.zurueckgezogen).toBeUndefined()
  expect(w.logs).toEqual(['live-plan: offene Fragen nicht zurueckgezogen (Sitzung beendet)'])
})

test('Sitzungsende ohne Server und ohne YAML: nichts zu schliessen, kein Aufruf, kein Hinweis', async ($, on) => {
  const w = welt(on, { server: false, yamlDa: false })
  await $.session.end({ reason: 'prompt_input_exit', sessionId: ID, resume: { id: ID } })
  // register.tsx runs `neu --auto` on its own; this hook calls nothing.
  expect(w.prozesse.filter(p => p.argv[2] === 'frage-zurueck')).toEqual([])
  expect(w.logs).toEqual([])
})

test('eine zurueckgezogene Frage meldet sich nicht als offen und wird nicht wieder aufgenommen', MIT_SKRIPT, async ($, on) => {
  const w = welt(on, { fragen: [{ ...OFFEN, id: 'F1', frage: FRAGE.question, zurueckgezogen: 'Sitzung beendet' }] })
  w.chat()
  const ende = await zug($, 't-8')
  await ende()
  await w.clock.advance(3_000)
  expect(w.notizen).toEqual([])
  const lauf = $.tool.call({ tool: 'AskUserQuestion', questions: [FRAGE] })
  await w.clock.settle()
  // Asked again, it is a new question: one `frage` call, F2 appended, F1 stays withdrawn.
  expect(w.prozesse.filter(p => p.argv[2] === 'frage')).toHaveLength(1)
  expect(w.plan.fragen.map(f => [f.id, f.zurueckgezogen])).toEqual([
    ['F1', 'Sitzung beendet'],
    ['F2', undefined],
  ])
  w.entscheiden('F2', 'SQLite')
  expect(await lauf).toMatchObject({ result: { answers: { 'Welche Datenbank?': 'SQLite' } } })
})

test('teilweise schon gestellt: nur die neue Frage wird angehaengt, keine Dublette', MIT_SKRIPT, async ($, on) => {
  const w = welt(on, { fragen: [{ ...OFFEN, id: 'F1', frage: FRAGE.question }] })
  const ZWEITE = { ...FRAGE, question: 'Welcher Port?', options: [{ label: '4410' }, { label: '8080' }] }
  w.chat()
  const lauf = $.tool.call({ tool: 'AskUserQuestion', questions: [FRAGE, ZWEITE] })
  await w.clock.settle()
  const ein = JSON.parse(w.prozesse[0]!.stdin!) as { fragen: { frage: string }[] }
  expect(ein.fragen.map(f => f.frage)).toEqual(['Welcher Port?'])
  expect(w.plan.fragen.map(f => f.id)).toEqual(['F1', 'F2'])
  w.entscheiden('F1', 'SQLite')
  w.entscheiden('F2', '8080')
  expect(await lauf).toMatchObject({ result: { answers: { 'Welche Datenbank?': 'SQLite', 'Welcher Port?': '8080' } } })
})
