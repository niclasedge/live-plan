// live-plan-sitzung: keeps one register file per Claude session for the live-plan web server,
// `<LIVE_PLAN_CACHE or ~/.cache/live-plan>/sitzungen/<id>.json`, per the contract
// "Sitzungs-Register des live-plan (v 1)". No UI: the live-plan web server draws.
//
// Taken from savvy-progress (johnnyvizz/claude-kit, plugins/savvy-progress/hooks/register.tsx,
// MIT): the `progress` and `step` tools and their schemas, the flow merge, the subagent
// bookkeeping on agent.spawn / turn.step / turn.complete, PRICES, costOf and windowOf.
// Deviations: `tier` is a free string (not savvy's enum) and not required; a new flow title
// does not drop finished agents (the register keeps the session's history, 200 at most);
// `laufend` is the number of running subagents.
//
// Contract v1.1 (optional fields, `v` stays 1): `haupt.limits`/`haupt.limitsZeit` from
// session.measure and session.usage(), and `dateien`, the files Claude read and wrote,
// from tool.call on Read/Edit/Write/NotebookEdit/Grep/Glob.
//
// Ansagen: at the end of each answered turn of the main session the final answer goes to
// `live-plan sage --auto` on stdin; the script cleans and shortens it, skips a trivial one and one
// the session already announced itself this turn, and appends it to LIVE_PLAN_CACHE/ansagen.jsonl.

import type { EngineInterface, PluginOptions, Register, SessionRateLimit, SessionUsage } from 'claude-code'
import { fragenRegistrieren, sprengradiusRegistrieren } from './fragen'
import { anzeigeRegistrieren } from './anzeige'

type Phase = 'plan' | 'design' | 'delegate' | 'review' | 'close'

type Aufgabe = { titel: string; stufe?: string; nach: number[] }

type Fortschritt = {
  titel: string
  phase: Phase
  gesamt: number
  erledigt: number
  laufend: number
  fertig: boolean
  aufgaben: Aufgabe[]
}

type Agent = {
  id: string
  agentId?: string
  typ: string
  beschreibung: string
  modell: string
  effort?: string
  status: 'laeuft' | 'fertig' | 'fehler'
  gestartet: number
  beendet?: number
  kontext: number
  kontextMax: number
  tokens: number
  kostenUsd: number
  schritte: number
  runde: number
  stepErledigt?: number
  stepGesamt?: number
  stepNotiz?: string
}

type Limit = { art: string; prozent: number; reset?: number }

type Art = 'gelesen' | 'geschrieben'

type Datei = { pfad: string; gelesen?: number; geschrieben?: number; agent?: string; n: number }

export type Sitzung = {
  v: 1
  id: string
  cwd: string
  wurzel: string | null
  repo: string | null
  modell: string
  gestartet: number
  aktualisiert: number
  beendet?: number
  haupt: {
    kontext: { benutzt: number | null; max: number | null; prozent: number | null }
    kostenUsd: number | null
    zuege: number
    limits?: Limit[]
    limitsZeit?: number
  }
  fortschritt: Fortschritt | null
  agenten: Agent[]
  dateien?: Datei[]
}

type ProgressInput = {
  title?: string
  total?: number
  done?: number
  phase?: Phase
  finished?: boolean
  tasks?: { title?: string; tier?: string; after?: number[] }[]
}

type StepInput = { done?: number; total?: number; note?: string }

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const TOOL = 'mcp__live-plan-sitzung__progress'
const STEP_TOOL = 'mcp__live-plan-sitzung__step'
const PHASES: readonly Phase[] = ['plan', 'design', 'delegate', 'review', 'close']
const ID = /^[A-Za-z0-9._-]+$/
const MAX_AGENTEN = 200
const MAX_DATEIEN = 400
// The file tools whose calls `dateien` records; Grep and Glob only with a `path`.
const DATEI_WERKZEUGE = new Map<string, Art>([
  ['Read', 'gelesen'],
  ['Grep', 'gelesen'],
  ['Glob', 'gelesen'],
  ['Edit', 'geschrieben'],
  ['Write', 'geschrieben'],
  ['NotebookEdit', 'geschrieben'],
])
const TAKT_MS = 1000
// What of a turn's answer goes to `sage --auto`; the script keeps the first sentences only.
const ANTWORT_HOECHSTENS = 20_000

// ---------------------------------------------------------------------------
// Cost and context window, from savvy-progress.

// USD per million tokens: input, output, cache read, cache write (5-minute TTL).
// The engine reports tokens, not money, so a subagent's cost is an estimate.
const PRICES: [RegExp, [number, number, number, number]][] = [
  [/fable|mythos/, [10, 50, 0.25, 12.5]],
  [/opus-5-5/, [4, 20, 0.2, 5]],
  [/opus/, [5, 25, 0.5, 6.25]],
  [/sonnet/, [2, 10, 0.2, 2.5]],
  [/haiku/, [1, 5, 0.1, 1.25]],
]

const priceOf = (model: string): [number, number, number, number] =>
  PRICES.find(([re]) => re.test(model.toLowerCase()))?.[1] ?? [4, 20, 0.2, 5]

const costOf = (model: string, u: Usage): number => {
  const [i, o, r, w] = priceOf(model)
  return (
    ((u.input_tokens || 0) * i +
      (u.output_tokens || 0) * o +
      (u.cache_read_input_tokens || 0) * r +
      (u.cache_creation_input_tokens || 0) * w) /
    1e6
  )
}

const tokensOf = (u: Usage): number =>
  (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)

const windowOf = (model: string): number => (/haiku/i.test(model) ? 200_000 : 1_000_000)

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

// ---------------------------------------------------------------------------
// The flow reported through `progress`, merged as savvy-progress merges it.

const leer = (): Fortschritt => ({
  titel: 'live-plan',
  phase: 'plan',
  gesamt: 0,
  erledigt: 0,
  laufend: 0,
  fertig: false,
  aufgaben: [],
})

const istNeu = (prev: Fortschritt | null, input: ProgressInput): boolean =>
  !prev || prev.fertig || (input.title !== undefined && input.title.trim() !== prev.titel)

const aufgabenAus = (tasks: ProgressInput['tasks']): Aufgabe[] | undefined =>
  tasks
    ?.filter(t => t.title?.trim())
    .map(t => {
      const stufe = (t.tier ?? '').replace(/^savvy-/, '').trim().toLowerCase()
      return {
        titel: (t.title ?? '').trim(),
        ...(stufe ? { stufe } : {}),
        nach: (t.after ?? []).filter(n => Number.isInteger(n) && n > 0),
      }
    })

const mischen = (prev: Fortschritt | null, input: ProgressInput): Fortschritt => {
  // A new title means a new flow: never carry counters over from an earlier one.
  const base = istNeu(prev, input) || !prev ? leer() : { ...leer(), ...prev }
  const aufgaben = aufgabenAus(input.tasks) ?? base.aufgaben
  const gesamt = Math.max(0, Math.round(input.total ?? (input.tasks ? aufgaben.length : base.gesamt)))
  const erledigt = Math.min(gesamt || Infinity, Math.max(0, Math.round(input.done ?? base.erledigt)))
  const phase = input.phase && PHASES.includes(input.phase) ? input.phase : base.phase
  return {
    ...base,
    titel: input.title?.trim() || base.titel,
    gesamt,
    erledigt,
    phase: input.finished ? 'close' : phase,
    fertig: input.finished === true,
    aufgaben,
  }
}

// Keeps the fields of `alt` it does not set (limits, limitsZeit).
const hauptAus = (n: SessionUsage, zuege: number, alt?: Sitzung['haupt']): Sitzung['haupt'] => ({
  ...alt,
  kontext: { benutzt: n.context.tokens ?? null, max: n.context.window ?? null, prozent: n.context.percent ?? null },
  kostenUsd: n.cost?.usd ?? null,
  zuege,
})

const limitsAus = (raten: readonly SessionRateLimit[] | undefined): Limit[] =>
  (raten ?? [])
    .filter(r => typeof r?.kind === 'string' && typeof r.percentUsed === 'number' && Number.isFinite(r.percentUsed))
    .map(r => {
      const reset = typeof r.resetsAt === 'string' ? Date.parse(r.resetsAt) : NaN
      return { art: r.kind, prozent: Math.round(r.percentUsed * 10) / 10, ...(Number.isFinite(reset) ? { reset } : {}) }
    })

// An empty reading keeps the last limits: a response without them reports none.
const limitsSetzen = (h: Sitzung['haupt'], raten: readonly SessionRateLimit[] | undefined, jetzt: number): void => {
  const limits = limitsAus(raten)
  if (!limits.length) return
  h.limits = limits
  h.limitsZeit = jetzt
}

// Absolute posix path with `.` and `..` resolved; a relative one counts from `cwd`.
const normPfad = (p: string, cwd: string): string => {
  const teile: string[] = []
  for (const t of (p.startsWith('/') ? p : `${cwd}/${p}`).split('/')) {
    if (!t || t === '.') continue
    if (t === '..') teile.pop()
    else teile.push(t)
  }
  return `/${teile.join('/')}`
}

// Relative to the repository root when inside it, else absolute.
const relativ = (p: string, s: Sitzung): string => {
  const abs = normPfad(p, s.cwd)
  const w = s.wurzel ? normPfad(s.wurzel, '/') : null
  if (!w || w === '/') return abs
  if (abs === w) return '.'
  return abs.startsWith(`${w}/`) ? abs.slice(w.length + 1) : abs
}

// One entry per path, newest last, MAX_DATEIEN at most (oldest dropped).
const beruehren = (s: Sitzung, pfad: string, art: Art, jetzt: number, agent?: string): void => {
  const liste = s.dateien ?? []
  const alt = liste.find(d => d.pfad === pfad)
  const neu: Datei = { ...alt, pfad, n: (alt?.n ?? 0) + 1 }
  if (art === 'gelesen') neu.gelesen = jetzt
  else neu.geschrieben = jetzt
  if (agent) neu.agent = agent
  else delete neu.agent
  s.dateien = [...liste.filter(d => d !== alt), neu].slice(-MAX_DATEIEN)
}

const nachfuehren = (s: Sitzung): void => {
  if (s.fortschritt && !s.fortschritt.fertig) {
    s.fortschritt.laufend = s.agenten.filter(a => a.status === 'laeuft').length
  }
}

// ---------------------------------------------------------------------------
// The session's register: held in module variables, re-read from its file after a hot
// reload (module variables start afresh then), written at most once per TAKT_MS.

export let zustand: Sitzung | null = null
let pfad: string | null = null
let ladend: Promise<Sitzung | null> | null = null
let schmutzig = false
let zuletzt = -Infinity
let kette: Promise<void> = Promise.resolve()
let takt: { cancel: () => void } | null = null
let skriptOption = ''

async function basis($: EngineInterface): Promise<string | null> {
  const eigen = (await $.env.get('LIVE_PLAN_CACHE'))?.trim()
  if (eigen) return eigen.replace(/\/+$/, '')
  const home = (await $.env.get('HOME'))?.trim()
  return home ? `${home.replace(/\/+$/, '')}/.cache/live-plan` : null
}

export async function gitWurzel($: EngineInterface, cwd: string): Promise<string | null> {
  try {
    return (await $.session.repo())?.root ?? null
  } catch {
    // No repo noun: ask git itself.
  }
  try {
    const r = await $.process.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 })
    const root = r.stdout.trim()
    return r.exitCode === 0 && root ? root : null
  } catch {
    return null
  }
}

async function lesen($: EngineInterface, p: string, id: string): Promise<Sitzung | null> {
  try {
    const text = await $.fs.read(p)
    const j = JSON.parse(typeof text === 'string' ? text : '') as Sitzung
    return j && j.v === 1 && j.id === id && Array.isArray(j.agenten) ? j : null
  } catch {
    return null
  }
}

// Fields that describe where the session runs; refreshed on session.start.
async function ort($: EngineInterface, cwd: string) {
  const wurzel = await gitWurzel($, cwd)
  const modell = await $.session.model().catch(() => '')
  return { cwd, wurzel, repo: wurzel ? (wurzel.split('/').filter(Boolean).pop() ?? null) : null, modell }
}

async function anlegen($: EngineInterface, id: string, cwd: string): Promise<Sitzung> {
  const jetzt = await $.clock.now()
  const nutzung = await $.session.usage().catch(() => undefined)
  const s: Sitzung = {
    v: 1,
    id,
    ...(await ort($, cwd)),
    gestartet: nutzung?.startedAt ?? jetzt,
    aktualisiert: jetzt,
    haupt: nutzung
      ? hauptAus(nutzung, 0)
      : { kontext: { benutzt: null, max: null, prozent: null }, kostenUsd: null, zuege: 0 },
    fortschritt: null,
    agenten: [],
  }
  if (nutzung) limitsSetzen(s.haupt, nutzung.rateLimits, jetzt)
  return s
}

function starteTakt($: EngineInterface): void {
  if (takt) return
  try {
    takt = $.clock.every(TAKT_MS, () => {
      void leeren($)
    })
  } catch {
    takt = null
  }
}

// Loads the register once per module instance: the file of this session id if it holds
// one, else a new register.
function laden($: EngineInterface, start?: { cwd: string }): Promise<Sitzung | null> {
  if (zustand) return Promise.resolve(zustand)
  ladend ??= (async () => {
    try {
      const id = await $.session.id()
      const b = await basis($)
      if (!ID.test(id) || !b) return null
      const p = `${b}/sitzungen/${id}.json`
      const alt = await lesen($, p, id)
      const cwd = start?.cwd ?? (await $.session.cwd())
      let s: Sitzung
      if (alt) {
        s = alt
        if (start) {
          Object.assign(s, await ort($, cwd))
          delete s.beendet
        }
      } else {
        s = await anlegen($, id, cwd)
      }
      pfad = p
      zustand = s
      schmutzig = true
      starteTakt($)
      // A new register outside session.start (a /clear with a new id): set up its plan too.
      if (!alt && !start) void neuAuto($, s).catch(() => undefined)
      return s
    } finally {
      ladend = null
    }
  })()
  return ladend
}

// Writes the register now when something changed; writes are chained so an older
// snapshot never lands after a newer one.
function leeren($: EngineInterface): Promise<void> {
  kette = kette
    .then(async () => {
      if (!schmutzig || !zustand || !pfad) return
      schmutzig = false
      const jetzt = await $.clock.now()
      zuletzt = jetzt
      zustand.aktualisiert = jetzt
      try {
        await $.fs.write(pfad, JSON.stringify(zustand, null, 1))
      } catch {
        schmutzig = true
      }
    })
    .catch(() => undefined)
  return kette
}

// Marks a change; writes at once when the last write is a TAKT_MS old (or `sofort`),
// otherwise the timer writes it on its next tick.
async function merken($: EngineInterface, sofort = false): Promise<void> {
  schmutzig = true
  const jetzt = await $.clock.now()
  if (sofort || jetzt - zuletzt >= TAKT_MS) await leeren($)
}

export async function skriptPfad($: EngineInterface): Promise<string | null> {
  if (skriptOption) return skriptOption
  const env = (await $.env.get('LIVE_PLAN_SKRIPT'))?.trim()
  if (env) return env
  const config = (await $.env.get('CLAUDE_CONFIG_DIR'))?.trim()
  const home = (await $.env.get('HOME'))?.trim()
  const dir = config || (home ? `${home}/.claude` : '')
  return dir ? `${dir.replace(/\/+$/, '')}/skills/live-plan/live-plan` : null
}

// The script's path when it is there as a file, else null.
async function skriptDa($: EngineInterface): Promise<string | null> {
  const skript = await skriptPfad($)
  if (!skript) return null
  const da = await $.fs.stat(skript).catch(() => undefined)
  return da && da.kind !== 'dir' ? skript : null
}

// `bun <skript> neu --auto <id>` in the repository root; skipped silently when the
// session is outside a repository or the script is missing.
async function neuAuto($: EngineInterface, s: Sitzung): Promise<void> {
  if (!s.wurzel) return
  const skript = await skriptDa($)
  if (!skript) return
  await $.process.run(['bun', skript, 'neu', '--auto', s.id], { cwd: s.wurzel, timeoutMs: 30_000 })
}

// `bun <skript> sage --auto` with the turn's answer on stdin; `--seit` is the turn's start, so an
// announcement the session made itself during the turn (`live-plan sage`) replaces this one.
async function ansageAuto($: EngineInterface, s: Sitzung, antwort: string, dauerMs: number): Promise<void> {
  const skript = await skriptDa($)
  if (!skript) return
  const seit = (await $.clock.now()) - Math.max(0, dauerMs) - 1000
  await $.process.run(
    ['bun', skript, 'sage', '--auto', '--id', s.id, '--seit', String(Math.round(seit)), ...(s.repo ? ['--repo', s.repo] : [])],
    { cwd: s.wurzel ?? s.cwd, stdin: antwort.slice(0, ANTWORT_HOECHSTENS), timeoutMs: 30_000 },
  )
}

async function werkzeugeAnmelden($: EngineInterface): Promise<void> {
  await $.tool.register({
    name: 'progress',
    description:
      'Report the progress of a multi-step plan to the live-plan view. ' +
      'Call it after presenting the plan (title, total, tasks, phase "delegate"), each time a task is accepted (done), ' +
      'when switching phase or re-planning (tasks), and once at the end with finished: true. Fields left out keep their previous value.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short name of the overall task, a few words.' },
        total: { type: 'integer', minimum: 0, description: 'Number of planned worker tasks.' },
        done: { type: 'integer', minimum: 0, description: 'Number of tasks accepted after review.' },
        phase: { type: 'string', enum: [...PHASES] },
        finished: { type: 'boolean', description: 'True once the flow is closed.' },
        tasks: {
          type: 'array',
          description:
            'The planned worker tasks in order, numbered from 1. Each title must equal the Agent tool `description` the task will be delegated with, so the view can match runs to tasks.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'A few words; reused verbatim as the Agent description.' },
              tier: { type: 'string', description: 'Optional tier or model class of the worker (e.g. heavy, careful, medium, light).' },
              after: { type: 'array', items: { type: 'integer' }, description: 'Numbers of the tasks this one waits for.' },
            },
            required: ['title'],
          },
        },
      },
    },
  })
  await $.tool.register({
    name: 'step',
    description:
      'For subagents: report progress on your own task to the live-plan view. ' +
      'Right after reading the brief, call it with `total` (your plan in 3-8 steps) and `done: 0`; ' +
      'call it again as each step finishes. Cheap and silent.',
    inputSchema: {
      type: 'object',
      properties: {
        done: { type: 'integer', minimum: 0, description: 'Steps finished so far.' },
        total: { type: 'integer', minimum: 1, description: 'Steps planned; may change if the plan changes.' },
        note: { type: 'string', description: 'The step in progress, a few words.' },
      },
      required: ['done'],
    },
  })
}

// Records a file tool's path in `dateien`; `roh` is the call's raw path argument.
async function eintragen($: EngineInterface, roh: unknown, art: Art, agent?: string): Promise<void> {
  if (typeof roh !== 'string' || !roh.trim()) return
  const s = await laden($)
  if (!s) return
  beruehren(s, relativ(roh.trim(), s), art, await $.clock.now(), agent)
  await merken($)
}

const etikett = (f: Fortschritt): string =>
  f.fertig ? 'fertig' : `${f.phase}${f.gesamt ? ` ${f.erledigt}/${f.gesamt}` : ''}`

export const register: Register = (on, options: PluginOptions) => {
  fragenRegistrieren(on, options)
  anzeigeRegistrieren(on, options)
  sprengradiusRegistrieren(on, options)
  skriptOption = typeof options.skript === 'string' ? options.skript.trim() : ''

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      zustand = null
      ladend = null
      const s = await laden($, { cwd: started.cwd || e.cwd })
      if (s) await merken($, true)
    } catch {
      // Never disturb the session.
    }
    try {
      await werkzeugeAnmelden($)
    } catch {
      // The tools are optional.
    }
    // Not awaited: the first prompt never waits for the plan script.
    if (zustand) void neuAuto($, zustand).catch(() => undefined)
    return started
  })

  on('session.end', async ($, e, next) => {
    try {
      const s = await laden($)
      if (s) {
        s.beendet = await $.clock.now()
        await merken($, true)
      }
      if (e.reason === 'clear') {
        // /clear raises no session.start: the next event loads the register of the id then.
        zustand = null
        pfad = null
      }
    } catch {
      // Never disturb the session.
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    try {
      if (started.deny !== undefined) return started
      const s = await laden($)
      if (!s) return started
      const at = await $.clock.now()
      const runde = 1 + s.agenten.filter(a => e.description && norm(a.beschreibung) === norm(e.description)).length
      const run: Agent = {
        id: started.agentId ?? e.tool_use_id,
        ...(started.agentId ? { agentId: started.agentId } : {}),
        typ: e.subagentType,
        beschreibung: e.description,
        modell: started.model,
        status: 'laeuft',
        gestartet: at,
        kontext: 0,
        kontextMax: windowOf(started.model),
        tokens: 0,
        kostenUsd: 0,
        schritte: 0,
        runde,
      }
      s.agenten = [...s.agenten.filter(a => a.id !== run.id), run].slice(-MAX_AGENTEN)
      nachfuehren(s)
      await merken($)
    } catch {
      // Never disturb the session.
    }
    return started
  }).catch(($, e, next) => next(e))

  // Each model request of a subagent: live context, tokens and cost.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    try {
      const agentId = e.agentId
      const usage = result.usage
      if (!agentId || !usage) return result
      const s = await laden($)
      const a = s?.agenten.find(x => x.agentId === agentId)
      if (!s || !a) return result
      const model = usage.model || e.model
      a.modell = model
      if (typeof e.effort === 'string') a.effort = e.effort
      a.status = 'laeuft'
      delete a.beendet
      a.kontext = tokensOf(usage)
      a.kontextMax = windowOf(model)
      a.tokens += tokensOf(usage)
      a.kostenUsd += costOf(model, usage)
      a.schritte += 1
      nachfuehren(s)
      await merken($)
    } catch {
      // Never disturb the session.
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    try {
      const s = await laden($)
      if (s && e.agentId) {
        const a = s.agenten.find(x => x.agentId === e.agentId)
        if (a) {
          a.status = e.reason === 'answer' ? 'fertig' : 'fehler'
          a.beendet = await $.clock.now()
          // A run whose steps went unseen still gets the turn's own sum.
          if (a.schritte === 0 && e.usage) {
            a.modell = e.usage.model || a.modell
            a.tokens = tokensOf(e.usage)
            a.kostenUsd = costOf(a.modell, e.usage)
          }
          nachfuehren(s)
          await merken($)
        }
      } else if (s) {
        const nutzung = await $.session.usage().catch(() => undefined)
        s.haupt = nutzung ? hauptAus(nutzung, s.haupt.zuege + 1, s.haupt) : { ...s.haupt, zuege: s.haupt.zuege + 1 }
        if (nutzung) limitsSetzen(s.haupt, nutzung.rateLimits, await $.clock.now())
        if (e.usage?.model) s.modell = e.usage.model
        await merken($)
        // Not awaited: the end of the turn never waits for the script.
        if (e.reason === 'answer' && e.answer.trim()) void ansageAuto($, s, e.answer, e.durationMs).catch(() => undefined)
      }
    } catch {
      // Never disturb the session.
    }
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    try {
      const s = await laden($)
      if (!s) return { result: 'ok' }
      const f = mischen(s.fortschritt, e as unknown as ProgressInput)
      s.fortschritt = f
      nachfuehren(s)
      await merken($)
      return { result: `ok: ${etikett(f)}` }
    } catch {
      return { result: 'ok' }
    }
  }).catch(() => ({ result: 'ok' }))

  // A worker's own progress: the call runs in the worker's loop, so agentId names it.
  on('tool.call', { tool: STEP_TOOL }, async ($, e) => {
    const agentId = e.agentId
    if (!agentId) return { result: 'ignored: only subagents report steps' }
    try {
      const input = e as unknown as StepInput
      const s = await laden($)
      const a = s?.agenten.find(x => x.agentId === agentId)
      if (s && a) {
        const gesamt = Math.max(0, Math.round(input.total ?? a.stepGesamt ?? 0))
        const erledigt = Math.max(0, Math.round(input.done ?? a.stepErledigt ?? 0))
        a.stepGesamt = gesamt
        a.stepErledigt = gesamt ? Math.min(gesamt, erledigt) : erledigt
        const notiz = input.note?.trim()
        if (notiz) a.stepNotiz = notiz
        else delete a.stepNotiz
        await merken($)
      }
    } catch {
      // Never disturb the session.
    }
    return { result: 'ok' }
  }).catch(() => ({ result: 'ok' }))

  // Usage as the status line has it: context, cost and the rate-limit windows.
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    try {
      const s = await laden($)
      if (s) {
        const k = e.context
        s.haupt.kontext = { benutzt: k.tokens ?? null, max: k.window ?? null, prozent: k.percent ?? null }
        if (e.cost) s.haupt.kostenUsd = e.cost.usd ?? null
        limitsSetzen(s.haupt, e.rateLimits, await $.clock.now())
        await merken($)
      }
    } catch {
      // Never disturb the session.
    }
    return result
  })

  // Files read: recorded only once the tool answered without error.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const result = await next(e)
    try {
      if (!result.deny && !result.isError) await eintragen($, e.file_path, 'gelesen', e.agentId)
    } catch {
      // Never disturb the session.
    }
    return result
  }).catch(($, e, next) => next(e))

  // The other file tools; every other call passes straight on.
  on('tool.call', async ($, e, next) => {
    const art = e.tool === 'Read' ? undefined : DATEI_WERKZEUGE.get(e.tool)
    if (!art) return next(e)
    const result = await next(e)
    try {
      if (!result.deny && !result.isError) {
        const a = e as unknown as { file_path?: unknown; notebook_path?: unknown; path?: unknown }
        await eintragen($, a.file_path ?? a.notebook_path ?? a.path, art, e.agentId)
      }
    } catch {
      // Never disturb the session.
    }
    return result
  }).catch(($, e, next) => next(e))
}
