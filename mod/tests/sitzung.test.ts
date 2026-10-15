import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ID = 'sitzung-1'
const PFAD = '/home/t/.cache/live-plan/sitzungen/sitzung-1.json'
const START = { cwd: '/repo/sub', surface: null, isInteractive: false } as const

// The world beneath the plugin: files in memory, a repo at /repo, a mocked clock.
function welt(
  on: On,
  opts: { skriptDa?: boolean; sageEnde?: { exitCode: number; stderr: string }; env?: Record<string, string> } = {},
) {
  const clock = mock.clock(on, { now: 10_000 })
  mock.env(on, { HOME: '/home/t', ...opts.env })
  const dateien = new Map<string, string>()
  const prozesse: string[][] = []
  const laeufe: { argv: string[]; cwd?: string; stdin?: string }[] = []
  const toasts: string[] = []
  on('fs.write', ($, e) => {
    dateien.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.stat', ($, e) =>
    opts.skriptDa
      ? { value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false } }
      : { deny: `ENOENT ${e.path}` },
  )
  on('process.run', ($, e) => {
    prozesse.push([...e.argv])
    laeufe.push({ argv: [...e.argv], cwd: e.init?.cwd, stdin: e.init?.stdin })
    const ende = e.argv[2] === 'sage' && opts.sageEnde ? opts.sageEnde : { exitCode: 0, stderr: '' }
    return { value: { ...ende, stdout: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.id', () => ({ value: ID }))
  on('session.cwd', () => ({ value: '/repo/sub' }))
  on('session.repo', () => ({ value: { root: '/repo', remote: null, internal: false, name: null } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: {
      startedAt: 5_000,
      context: { tokens: 1_000, window: 200_000, percent: 0.5 },
      rateLimits: [],
      cost: { usd: 0.12 },
    },
  }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__live-plan-sitzung__${e.name}` } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  const lesen = () => JSON.parse(dateien.get(PFAD) ?? 'null')
  return { clock, prozesse, laeufe, lesen, toasts }
}

test('session.start schreibt das Register mit id und cwd', async ($, on) => {
  const w = welt(on)
  await $.session.start(START)
  const s = w.lesen()
  expect(s).toMatchObject({
    v: 1,
    id: ID,
    cwd: '/repo/sub',
    wurzel: '/repo',
    repo: 'repo',
    modell: 'claude-opus-5-5',
    gestartet: 5_000,
    aktualisiert: 10_000,
    fortschritt: null,
    agenten: [],
  })
  expect(s.haupt).toEqual({ kontext: { benutzt: 1_000, max: 200_000, prozent: 0.5 }, kostenUsd: 0.12, zuege: 0 })
  expect(w.prozesse).toEqual([])
})

test('session.start ruft neu --auto, wenn das Skript da ist', { options: { skript: '/opt/lp/live-plan' } }, async ($, on) => {
  const w = welt(on, { skriptDa: true })
  await $.session.start(START)
  await w.clock.settle()
  expect(w.prozesse).toEqual([['bun', '/opt/lp/live-plan', 'neu', '--auto', ID]])
})

test('agent.spawn, turn.step und turn.complete ergeben einen fertigen Agenten', async ($, on) => {
  const w = welt(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: 'ag-1' }))
  on('turn.step', async function* ($, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: {
        model: 'claude-haiku-4-5',
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }
  })
  await $.session.start(START)
  await $.agent.spawn({
    tool_use_id: 'tu-1',
    prompt: 'Suche X',
    description: 'Suche X',
    subagentType: 'Explore',
    provider: { plugin: 'test', tier: 'user' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })
  const schritt = $.turn.step({ turnId: 't-1', index: 0, model: 'claude-haiku-4-5', messageCount: 1, agentId: 'ag-1', effort: 'low' })
  for await (const _ of schritt) {
    // drain the stream
  }
  await $.turn.complete({ answer: 'fertig', durationMs: 10, isAborted: false, turnId: 't-1', agentId: 'ag-1', reason: 'answer' })
  await w.clock.advance(1_000)

  const [a] = w.lesen().agenten
  expect(a).toMatchObject({
    id: 'ag-1',
    agentId: 'ag-1',
    typ: 'Explore',
    beschreibung: 'Suche X',
    modell: 'claude-haiku-4-5',
    effort: 'low',
    status: 'fertig',
    kontext: 150,
    kontextMax: 200_000,
    tokens: 150,
    schritte: 1,
    runde: 1,
  })
  expect(a.tokens).toBeGreaterThan(0)
  expect(a.kostenUsd).toBeGreaterThan(0)
})

test('progress setzt fortschritt', async ($, on) => {
  const w = welt(on)
  await $.session.start(START)
  const r = await $.tool.call({
    tool: 'mcp__live-plan-sitzung__progress',
    title: 'Umbau',
    phase: 'delegate',
    done: 1,
    tasks: [
      { title: 'Erst', tier: 'savvy-heavy' },
      { title: 'Dann', after: [1] },
    ],
  })
  expect(r).toMatchObject({ result: 'ok: delegate 1/2' })
  await w.clock.advance(1_000)
  expect(w.lesen().fortschritt).toEqual({
    titel: 'Umbau',
    phase: 'delegate',
    gesamt: 2,
    erledigt: 1,
    laufend: 0,
    fertig: false,
    aufgaben: [
      { titel: 'Erst', stufe: 'heavy', nach: [] },
      { titel: 'Dann', nach: [1] },
    ],
  })
})

test('Hauptzug zaehlt zuege, session.end setzt beendet sofort', async ($, on) => {
  const w = welt(on)
  await $.session.start(START)
  await $.turn.complete({ answer: 'ok', durationMs: 10, isAborted: false, turnId: 't-1', reason: 'answer' })
  await w.clock.advance(500)
  await $.session.end({ reason: 'other', sessionId: ID, resume: { id: ID } })
  const s = w.lesen()
  expect(s.haupt.zuege).toBe(1)
  expect(s.beendet).toBe(10_500)
  expect(s.aktualisiert).toBe(10_500)
})

const RESET = '2026-10-10T12:00:00.000Z'

test('session.measure setzt limits und limitsZeit, leere Messung behaelt sie', async ($, on) => {
  const w = welt(on)
  await $.session.start(START)
  await w.clock.advance(1_000)
  await $.session.measure({
    context: { tokens: 2_000, window: 200_000, percent: 1 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 34.5, resetsAt: RESET },
      { kind: 'seven_day', percentUsed: 12 },
    ],
    cost: { usd: 0.5 },
    changed: ['context', 'rateLimits', 'cost'],
  })
  await w.clock.advance(1_000)
  const s = w.lesen()
  expect(s.haupt.limits).toEqual([
    { art: 'five_hour', prozent: 34.5, reset: Date.parse(RESET) },
    { art: 'seven_day', prozent: 12 },
  ])
  expect(s.haupt.limitsZeit).toBe(11_000)
  expect(s.haupt.kontext).toEqual({ benutzt: 2_000, max: 200_000, prozent: 1 })
  expect(s.haupt.kostenUsd).toBe(0.5)

  // No reading in the next measurement and none in session.usage(): the last limits stay.
  await $.session.measure({ context: { tokens: 3_000, window: 200_000, percent: 1.5 }, rateLimits: [], changed: ['context'] })
  await $.turn.complete({ answer: 'ok', durationMs: 10, isAborted: false, turnId: 't-1', reason: 'answer' })
  await w.clock.advance(1_000)
  const t = w.lesen()
  expect(t.haupt.limits).toEqual(s.haupt.limits)
  expect(t.haupt.limitsZeit).toBe(11_000)
  expect(t.haupt.zuege).toBe(1)
})

// The engine beneath the file tools: answers, errs or denies as `ausgang` says.
function werkzeuge(on: On, ausgang: () => 'ok' | 'fehler' | 'nein' = () => 'ok') {
  on('tool.call', ($, e) => {
    const a = ausgang()
    if (a === 'nein') return { deny: 'nein' }
    return (a === 'fehler' ? { result: 'kaputt', isError: true, text: 'kaputt' } : { result: 'ok', text: 'ok' }) as never
  })
}

test('dateien: Read, Edit, Grep relativ zur Wurzel, ausserhalb absolut', async ($, on) => {
  const w = welt(on)
  werkzeuge(on)
  await $.session.start(START)
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts' })
  await w.clock.advance(100)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'x', new_string: 'y' })
  await $.tool.call({ tool: 'Write', file_path: '/etc/hosts', content: '' })
  // Grep and Glob are not built-in tools in every engine version, hence the casts.
  await $.tool.call({ tool: 'Grep', pattern: 'x', path: '/repo/sub/../docs' } as never)
  await $.tool.call({ tool: 'Glob', pattern: '*.ts' } as never)
  await w.clock.advance(1_000)
  expect(w.lesen().dateien).toEqual([
    { pfad: 'src/a.ts', gelesen: 10_000, geschrieben: 10_100, n: 2 },
    { pfad: '/etc/hosts', geschrieben: 10_100, n: 1 },
    { pfad: 'docs', gelesen: 10_100, n: 1 },
  ])
})

test('dateien: kein Eintrag bei deny oder isError, andere Werkzeuge laufen durch', async ($, on) => {
  const w = welt(on)
  let ausgang: 'ok' | 'fehler' | 'nein' = 'nein'
  werkzeuge(on, () => ausgang)
  await $.session.start(START)
  expect(await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' })).toMatchObject({ deny: 'nein' })
  expect(await $.tool.call({ tool: 'Edit', file_path: '/repo/b.ts', old_string: 'x', new_string: 'y' })).toMatchObject({
    deny: 'nein',
  })
  ausgang = 'fehler'
  expect(await $.tool.call({ tool: 'Read', file_path: '/repo/c.ts' })).toMatchObject({ isError: true })
  expect(await $.tool.call({ tool: 'Write', file_path: '/repo/d.ts', content: '' })).toMatchObject({ isError: true })
  ausgang = 'ok'
  expect(await $.tool.call({ tool: 'Bash', command: 'true' })).toMatchObject({ result: 'ok' })
  await w.clock.advance(1_000)
  expect(w.lesen().dateien).toBeUndefined()
})

test('dateien: hoechstens 400, aelteste fallen weg, erneute Beruehrung rueckt ans Ende', async ($, on) => {
  const w = welt(on)
  werkzeuge(on)
  await $.session.start(START)
  for (let i = 0; i < 405; i++) await $.tool.call({ tool: 'Read', file_path: `/repo/f${i}.ts` })
  await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/repo/f10.ts', new_source: '' })
  await w.clock.advance(1_000)
  const d = w.lesen().dateien
  expect(d).toHaveLength(400)
  expect(d[0].pfad).toBe('f5.ts')
  expect(d.at(-1)).toMatchObject({ pfad: 'f10.ts', n: 2, geschrieben: 10_000 })
  expect(d.some((x: { pfad: string }) => x.pfad === 'f4.ts')).toBe(false)
})

const SKRIPT = { options: { skript: '/opt/lp/live-plan' } }
const sage = (w: ReturnType<typeof welt>) => w.laeufe.filter(l => l.argv[2] === 'sage')

test('Ansage: ein beantworteter Hauptzug geht mit seiner Antwort an sage --auto', SKRIPT, async ($, on) => {
  const w = welt(on, { skriptDa: true })
  await $.session.start(START)
  await $.turn.complete({ answer: 'Der Build ist **gruen**.', durationMs: 4_000, isAborted: false, turnId: 't-1', reason: 'answer' })
  await w.clock.settle()
  // seit = now (10_000) - durationMs - 1 s slack
  expect(sage(w)).toEqual([
    {
      argv: ['bun', '/opt/lp/live-plan', 'sage', '--auto', '--id', ID, '--seit', '5000', '--repo', 'repo'],
      cwd: '/repo',
      stdin: 'Der Build ist **gruen**.',
    },
  ])
})

test('Ansage: scheitert sage --auto, zeigt ein Toast die Meldung von live-plan', SKRIPT, async ($, on) => {
  const meldung = 'live-plan: Ansage nicht gespeichert: die Sperre /c/ansagen.jsonl.sperre ist seit 12000 ms besetzt'
  const w = welt(on, { skriptDa: true, sageEnde: { exitCode: 1, stderr: `${meldung}\n` } })
  await $.session.start(START)
  await $.turn.complete({ answer: 'Der Build ist gruen, der PR ist offen.', durationMs: 4_000, isAborted: false, turnId: 't-1', reason: 'answer' })
  await w.clock.settle()
  expect(sage(w)).toHaveLength(1)
  expect(w.toasts).toEqual([meldung])
})

test('Ansage: ohne Meldung von live-plan auf stderr nennt das Toast den Exit-Code', SKRIPT, async ($, on) => {
  const w = welt(on, { skriptDa: true, sageEnde: { exitCode: 2, stderr: 'irgendwas\n' } })
  await $.session.start(START)
  await $.turn.complete({ answer: 'Der Build ist gruen, der PR ist offen.', durationMs: 4_000, isAborted: false, turnId: 't-1', reason: 'answer' })
  await w.clock.settle()
  expect(w.toasts).toEqual(['live-plan: sage --auto endete mit Exit 2, die Ansage fehlt'])
})

test('Ansage: ein erfolgreiches sage --auto zeigt kein Toast', SKRIPT, async ($, on) => {
  const w = welt(on, { skriptDa: true })
  await $.session.start(START)
  await $.turn.complete({ answer: 'Der Build ist gruen, der PR ist offen.', durationMs: 4_000, isAborted: false, turnId: 't-1', reason: 'answer' })
  await w.clock.settle()
  expect(sage(w)).toHaveLength(1)
  expect(w.toasts).toEqual([])
})

test('Ansage: kein sage fuer Subagenten, Abbrueche, leere Antworten oder ohne Skript', SKRIPT, async ($, on) => {
  const w = welt(on, { skriptDa: true })
  await $.session.start(START)
  await $.turn.complete({ answer: 'Bericht des Agenten.', durationMs: 10, isAborted: false, turnId: 't-1', agentId: 'ag-1', reason: 'answer' })
  await $.turn.complete({ answer: 'Halb fertig', durationMs: 10, isAborted: true, turnId: 't-2', reason: 'aborted' })
  await $.turn.complete({ answer: '  ', durationMs: 10, isAborted: false, turnId: 't-3', reason: 'answer' })
  await w.clock.settle()
  expect(sage(w)).toEqual([])
})

test('Ansage: ohne Skript laeuft nichts und der Zug zaehlt trotzdem', async ($, on) => {
  const w = welt(on)
  await $.session.start(START)
  await $.turn.complete({ answer: 'Alles erledigt, der PR ist offen.', durationMs: 10, isAborted: false, turnId: 't-1', reason: 'answer' })
  await w.clock.advance(1_000)
  expect(w.prozesse).toEqual([])
  expect(w.lesen().haupt.zuege).toBe(1)
})

test('Ansage: ein firstmate-Worker (FM_TASK_INBOX gesetzt) geht ohne sage aus, das Register zaehlt den Zug trotzdem', SKRIPT, async ($, on) => {
  const w = welt(on, { skriptDa: true, env: { FM_TASK_INBOX: '/tmp/fm-inbox-test' } })
  await $.session.start(START)
  await $.turn.complete({ answer: 'Der Worker ist fertig, der PR ist offen.', durationMs: 4_000, isAborted: false, turnId: 't-1', reason: 'answer' })
  await w.clock.settle()
  expect(sage(w)).toEqual([])
  // The register is written on the takt: advance the clock before reading it.
  await w.clock.advance(1_000)
  expect(w.lesen().haupt.zuege).toBe(1)
})

test('Ansage: ein leerer FM_TASK_INBOX zaehlt als nicht gesetzt, sage laeuft wie bisher', SKRIPT, async ($, on) => {
  const w = welt(on, { skriptDa: true, env: { FM_TASK_INBOX: '' } })
  await $.session.start(START)
  await $.turn.complete({ answer: 'Der Build ist gruen, der PR ist offen.', durationMs: 4_000, isAborted: false, turnId: 't-1', reason: 'answer' })
  await w.clock.settle()
  expect(sage(w)).toHaveLength(1)
})
