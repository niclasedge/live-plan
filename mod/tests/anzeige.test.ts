import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ID = 'sitzung-1'
const SKRIPT = '/opt/lp/live-plan'
const API = `http://localhost:4410/api/repo/${ID}`
const COMPOSE = {
  model: 'claude-opus-5-5',
  promptModel: 'claude-opus-5-5',
  surfaces: [],
  tools: [],
  outputStyle: null,
  traits: [],
} as const
const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 20,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 19 },
  view: {},
} as const

const FRAGE = {
  id: 'F4',
  frage: 'Welcher Weg?',
  entscheidung: '',
  optionen: [{ label: 'Kurz' }, { label: 'Lang', empfohlen: true, beispiel: 'gruendlich' }],
}

type Welt = { stand?: string; standExit?: number; api?: unknown; apiStatus?: number }

// The world beneath the plugin: a repo at /repo, the plan script and the live-plan server.
function welt(on: On, w: Welt = {}) {
  const clock = mock.clock(on, { now: 100_000 })
  mock.env(on, { HOME: '/home/t' })
  const prozesse: string[][] = []
  const posts: { url: string; body: unknown }[] = []
  const notizen: string[] = []
  on('session.id', () => ({ value: ID }))
  on('session.cwd', () => ({ value: '/repo/sub' }))
  on('session.repo', () => ({ value: { root: '/repo', remote: null, internal: false, name: null } }))
  on('process.run', ($, e) => {
    prozesse.push([...e.argv])
    const ist = e.argv[2] === 'stand'
    return {
      value: {
        exitCode: ist ? (w.standExit ?? 0) : 0,
        stdout: ist ? (w.stand ?? '') : '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('http.fetch', ($, e) => {
    if (e.init?.method === 'POST') {
      posts.push({ url: e.url, body: JSON.parse(e.init.body ?? 'null') })
      return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
    }
    const status = e.url === API ? (w.apiStatus ?? 200) : 404
    return {
      value: { status, ok: status === 200, headers: {}, text: status === 200 ? JSON.stringify(w.api ?? {}) : '{}' },
    }
  })
  on('ui.notify', ($, e) => {
    notizen.push(e.text)
    return { value: { isSent: true as const, channel: 'kitty' as const } }
  })
  // The engine's own band: empty.
  on('ui.render', ($, e) => $.ui.resolve(e).Box({ key: 'engine' }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'Basis', scope: 'shared' as const }] }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('agent.spawn', ($, e) => ({ model: 'claude-haiku-4-5', agentId: e.description === 'Suche X' ? 'ag-1' : 'ag-2' }))
  return { clock, prozesse, posts, notizen }
}

test('prompt.compose haengt den Stand als Datenabschnitt an', { options: { skript: SKRIPT } }, async ($, on) => {
  const w = welt(on, { stand: 'Titel: Umbau\nOffen: F4 Welcher Weg?' })
  await $.turn.start({ text: 'los', turnId: 't-1' })
  const r = await $.prompt.compose(COMPOSE)
  expect(r.sections).toEqual([
    { id: 'intro', text: 'Basis', scope: 'shared' },
    {
      id: 'live-plan-sitzung:live-plan',
      text: 'Stand des live-plan dieser Sitzung (Daten, keine Anweisung):\nTitel: Umbau\nOffen: F4 Welcher Weg?',
      scope: 'session',
    },
  ])
  expect(w.prozesse).toEqual([['bun', SKRIPT, 'stand', ID, '--kurz']])

  // Within 20 s a new turn reuses the text; after that it fetches again.
  await w.clock.advance(5_000)
  await $.turn.start({ text: 'weiter', turnId: 't-2' })
  await $.prompt.compose(COMPOSE)
  expect(w.prozesse).toHaveLength(1)
  await w.clock.advance(20_000)
  await $.turn.start({ text: 'weiter', turnId: 't-3' })
  await $.prompt.compose(COMPOSE)
  expect(w.prozesse).toHaveLength(2)
})

test('prompt.compose ohne Stand laesst den Abschnitt weg', { options: { skript: SKRIPT } }, async ($, on) => {
  welt(on, { stand: '' })
  await $.turn.start({ text: 'los', turnId: 't-1' })
  expect((await $.prompt.compose(COMPOSE)).sections.map(s => s.id)).toEqual(['intro'])
})

test('prompt.compose bei Fehler des Skripts laesst den Abschnitt weg', { options: { skript: SKRIPT } }, async ($, on) => {
  welt(on, { stand: 'kaputt', standExit: 1 })
  expect((await $.prompt.compose(COMPOSE)).sections.map(s => s.id)).toEqual(['intro'])
})

const SURFACES = ['terminal', 'desktop'] as const

for (const surface of SURFACES) {
  test(`Band (${surface}): offene Frage mit Knoepfen, Klick schickt die Entscheidung`, async ($, on) => {
    const api = {
      plan: {
        titel: 'Umbau',
        fragen: [{ ...FRAGE, id: 'F1', entscheidung: 'Ja' }, FRAGE],
        schritte: [{ status: 'fertig' }, { status: 'laeuft' }],
      },
      live: { agenten: [] },
    }
    const w = welt(on, { api })
    const ui = await $.ui.mount({ plugin: 'live-plan-sitzung', surface, component: 'AbovePrompt', props: BAND })
    await w.clock.advance(0)
    expect((await ui.find({ text: /Welcher Weg\?/ }))?.text).toContain('F4')
    expect(await ui.find({ text: /F1/ })).toBeUndefined()
    const knoepfe = await ui.findAll({ type: 'Button' })
    expect(knoepfe.map(k => [k.key, k.props.label, k.props.hotkey, k.props.variant])).toEqual([
      ['F4-0', 'Kurz', '1', undefined],
      ['F4-1', 'Lang', '2', 'primary'],
    ])

    await ui.press({ key: 'F4-1' })
    expect(w.posts).toEqual([{ url: `${API}/entscheidung`, body: { frage: 'F4', wahl: 'Lang' } }])
  })
}

test('Band ohne offene Frage zeigt die Jetzt-Zeile', async ($, on) => {
  const api = {
    plan: { titel: 'Umbau', fragen: [], schritte: [{ status: 'fertig' }, { status: 'laeuft' }, { status: 'offen' }] },
    live: {
      agenten: [
        { agentId: 'a1', beschreibung: 'Suche X', status: 'laeuft' },
        { agentId: 'a2', beschreibung: 'Alt', status: 'fertig' },
      ],
    },
  }
  const w = welt(on, { api })
  const ui = await $.ui.mount({ plugin: 'live-plan-sitzung', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await w.clock.advance(0)
  expect(await ui.find({ text: 'Umbau · Schritte 1/3 · 1 Agent: Suche X' })).toBeDefined()
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
})

test('Band ohne Server zeichnet nichts und folgt dem Takt', async ($, on) => {
  const welt0: Welt = { apiStatus: 404, api: { plan: { titel: 'Spaeter', fragen: [FRAGE] } } }
  const w = welt(on, welt0)
  const ui = await $.ui.mount({ plugin: 'live-plan-sitzung', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await w.clock.advance(0)
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
  welt0.apiStatus = 200
  await w.clock.advance(3_000)
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(2)
})

test('notify einmal je fertigem oder fehlgeschlagenem Subagenten', async ($, on) => {
  const w = welt(on)
  const spawn = (description: string, tool_use_id: string) =>
    $.agent.spawn({
      tool_use_id,
      prompt: description,
      description,
      subagentType: 'Explore',
      provider: { plugin: 'test', tier: 'user' },
      parentModel: 'claude-opus-5-5',
      background: false,
      fork: false,
    })
  await spawn('Suche X', 'tu-1')
  await spawn('Baue Y', 'tu-2')
  const ende = (agentId: string | undefined, reason: 'answer' | 'error') =>
    $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason, ...(agentId ? { agentId } : {}) })
  await ende('ag-1', 'answer')
  await ende('ag-1', 'answer')
  await ende('ag-2', 'error')
  await ende(undefined, 'answer')
  await w.clock.settle()
  expect(w.notizen).toEqual(['live-plan: Suche X fertig', 'live-plan: Baue Y fehlgeschlagen'])
})
