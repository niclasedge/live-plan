// The question channel of live-plan, contract v3 section B (/tmp/live-plan-vertrag-v3.md):
//
// 1. AskUserQuestion is also asked in the live-plan browser view. The hook appends the
//    questions to the session's YAML (`live-plan frage`), then lets the chat dialog and the
//    browser race: `next(e)` runs the dialog, a long poll on the server waits for the browser.
//    The browser winning returns the answer while `next` is still pending, which aborts the
//    dialog beneath (the `tool.call` contract: "returning with `next` pending aborts what runs
//    beneath"). The chat winning stops the poll and mirrors its choice into the YAML; an answer
//    that is no option's label (Claude Code's "Other") goes there as an own answer (`eigen`).
// 2. Decisions on questions the hook did not ask (written by the agent into the YAML) wake the
//    session: `$.prompt.submit` when idle, else collected until the running turn completes.
// 3. A native notification once per open question.

import type { EngineInterface, Register, Timer } from 'claude-code'
import { AUSFUEHREN, ablehnung, anfrage, einordnen, frageVon, messung, unbekannt } from './sprengradius'
import type { Bericht, Risiko } from './sprengradius'

type Option = { label: string; description?: string }
export type Frage = { question: string; header?: string; multiSelect?: boolean; options: readonly Option[] }
type PlanFrage = { id?: unknown; frage?: unknown; entscheidung?: unknown; optionen?: unknown }
type Daten = { verlauf?: unknown; plan?: { fragen?: unknown } }

// Questions seen open (notified), decisions reported or answered through hook 1, and
// Sprengradius decisions already acted on.
type Merker = { offen: string[]; gemeldet: string[]; verbraucht: string[] }

type Ort = { id: string; wurzel: string; api: string }

const ID = /^[A-Za-z0-9._-]+$/
const TAKT_MS = 3000
const WARTE_MS = 20_000
const LAUF_MS = 15_000
const MAX_MERKER = 500

const entscheidung = (f: PlanFrage): string | null =>
  typeof f.entscheidung === 'string' && f.entscheidung.trim() ? f.entscheidung : null

const fragenAus = (d: Daten): PlanFrage[] =>
  Array.isArray(d.plan?.fragen) ? d.plan.fragen.filter((f): f is PlanFrage => !!f && typeof f === 'object') : []

// An own answer is a decision that is no option's label; the server keeps it to these limits.
const EIGEN_HOECHSTENS = 500
const istLabel = (f: PlanFrage, wahl: string): boolean =>
  Array.isArray(f.optionen) && f.optionen.some(o => !!o && typeof o === 'object' && (o as { label?: unknown }).label === wahl)

// One line of at most `max` code points, without control, line-break or bidi characters.
function einzeilig(text: string, max = EIGEN_HOECHSTENS): string {
  const zeile = text
    .replace(/[\p{Cc}\u2028\u2029]+/gu, ' ')
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\p{Cs}/gu, '')
    .trim()
  return [...zeile].slice(0, max).join('').trim()
}

// How a decision reads in the chat: a label as is, an own answer marked and quoted.
const meldetext = (f: PlanFrage, wahl: string): string =>
  istLabel(f, wahl) ? wahl : `(eigene Antwort) ${JSON.stringify(einzeilig(wahl))}`

// Resolves `p`, or null as soon as `signal` aborts or `p` rejects.
function bis<T>(p: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return Promise.resolve(null)
  return new Promise(resolve => {
    const ab = () => resolve(null)
    signal.addEventListener('abort', ab, { once: true })
    p.then(
      v => {
        signal.removeEventListener('abort', ab)
        resolve(v)
      },
      () => {
        signal.removeEventListener('abort', ab)
        resolve(null)
      },
    )
  })
}

// ---------------------------------------------------------------------------
// Where the session's plan is served, and reading it. gitWurzel and skriptPfad are
// register.tsx's: the validator follows `$` only into functions of the same file.

let ortCache: Ort | null = null
let skriptOption = ''

async function gitWurzel($: EngineInterface, cwd: string): Promise<string | null> {
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

async function skriptPfad($: EngineInterface): Promise<string | null> {
  if (skriptOption) return skriptOption
  const env = (await $.env.get('LIVE_PLAN_SKRIPT'))?.trim()
  if (env) return env
  const config = (await $.env.get('CLAUDE_CONFIG_DIR'))?.trim()
  const home = (await $.env.get('HOME'))?.trim()
  const dir = config || (home ? `${home}/.claude` : '')
  return dir ? `${dir.replace(/\/+$/, '')}/skills/live-plan/live-plan` : null
}

async function ortVon($: EngineInterface): Promise<Ort | null> {
  const id = await $.session.id()
  if (!ID.test(id)) return null
  if (ortCache?.id === id) return ortCache
  const wurzel = await gitWurzel($, await $.session.cwd())
  const repo = wurzel?.split('/').filter(Boolean).pop()
  if (!wurzel || !repo) return null
  const port = (await $.env.get('LIVE_PLAN_PORT'))?.trim() || '4410'
  ortCache = { id, wurzel, api: `http://localhost:${port}/api/${encodeURIComponent(repo)}/${encodeURIComponent(id)}` }
  return ortCache
}

async function planHolen($: EngineInterface, api: string): Promise<Daten | null> {
  try {
    const r = await $.http.fetch(api)
    if (!r.ok) return null
    const d = JSON.parse(r.text) as Daten
    return d && typeof d === 'object' ? d : null
  } catch {
    return null
  }
}

async function entscheiden($: EngineInterface, api: string, frage: string, wahl: string, eigen = false): Promise<void> {
  await $.http
    .fetch(`${api}/entscheidung`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frage, wahl, ...(eigen ? { eigen: true } : {}) }),
    })
    .catch(() => undefined)
}

// ---------------------------------------------------------------------------
// What was notified and reported, per session: in memory, and in $.store across reloads.

let merker: { id: string; m: Merker } | null = null

const texte = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

async function merkerVon($: EngineInterface, id: string): Promise<Merker> {
  if (merker?.id === id) return merker.m
  const roh = (await $.store.get(`fragen:${id}`).catch(() => undefined)) as Partial<Merker> | undefined
  if (merker?.id === id) return merker.m
  merker = { id, m: { offen: texte(roh?.offen), gemeldet: texte(roh?.gemeldet), verbraucht: texte(roh?.verbraucht) } }
  return merker.m
}

async function sichern($: EngineInterface, id: string, m: Merker): Promise<void> {
  m.offen = m.offen.slice(-MAX_MERKER)
  m.gemeldet = m.gemeldet.slice(-MAX_MERKER)
  m.verbraucht = m.verbraucht.slice(-MAX_MERKER)
  await $.store.set(`fragen:${id}`, m).catch(() => undefined)
}

// ---------------------------------------------------------------------------
// 1. AskUserQuestion in the browser.

// Appends the questions to the YAML and makes sure the server serves them; null to pass on.
async function vorbereiten($: EngineInterface, fragen: readonly Frage[]): Promise<{ ort: Ort; ids: string[]; url: string } | null> {
  if (!fragen.length || fragen.some(f => !f.options?.length)) return null
  const ort = await ortVon($)
  const skript = await skriptPfad($)
  if (!ort || !skript) return null
  // Asked already (Sprengradius puts its question there before the chat dialog): take it up.
  const offen = fragenAus((await planHolen($, ort.api)) ?? {}).filter(f => !entscheidung(f))
  const schon = fragen.map(f => offen.findLast(o => o.frage === f.question)?.id)
  if (schon.every((id): id is string => typeof id === 'string')) return { ort, ids: schon, url: ort.api.replace('/api/', '/') }
  const da = await $.fs.stat(skript).catch(() => undefined)
  if (!da || da.kind === 'dir') return null
  const eingabe = {
    quelle: 'AskUserQuestion',
    fragen: fragen.map(f => ({
      frage: f.question,
      ...(f.header ? { kopf: f.header } : {}),
      multi: f.multiSelect === true,
      optionen: f.options.map(o => ({ label: o.label, ...(o.description ? { beschreibung: o.description } : {}) })),
    })),
  }
  const r = await $.process.run(['bun', skript, 'frage', ort.id], {
    cwd: ort.wurzel,
    stdin: JSON.stringify(eingabe),
    timeoutMs: LAUF_MS,
  })
  if (r.exitCode !== 0) return null
  const zeile = r.stdout.trim().split('\n').pop() ?? ''
  const j = JSON.parse(zeile) as { ids?: unknown; url?: unknown }
  const ids = texte(j.ids)
  if (ids.length !== fragen.length) return null
  // Hook 1 answers these itself: hook 2 never reports them.
  const m = await merkerVon($, ort.id)
  m.gemeldet.push(...ids)
  await sichern($, ort.id, m)
  if (!(await planHolen($, ort.api))) {
    await $.process.run(['bun', skript, 'start'], { cwd: ort.wurzel, timeoutMs: LAUF_MS }).catch(() => undefined)
    if (!(await planHolen($, ort.api))) return null
  }
  return { ort, ids, url: typeof j.url === 'string' ? j.url : ort.api }
}

// Waits until every question `ids` names is decided in the browser: answers by question
// text, or null once `stop` aborts or the server fails.
async function browserAntwort(
  $: EngineInterface,
  api: string,
  ids: string[],
  fragen: readonly Frage[],
  stop: AbortSignal,
): Promise<Record<string, string> | null> {
  while (!stop.aborted) {
    const d = await bis(planHolen($, api), stop)
    if (!d) return null
    const liste = fragenAus(d)
    const antworten: Record<string, string> = {}
    for (const [i, id] of ids.entries()) {
      const f = liste.find(x => x.id === id)
      if (!f) return null
      const wahl = entscheidung(f)
      if (wahl) antworten[fragen[i]!.question] = wahl
    }
    if (Object.keys(antworten).length === ids.length) return antworten
    const seit = typeof d.verlauf === 'number' ? d.verlauf : 0
    const w = await bis($.http.fetch(`${api}/warte?seit=${seit}&hoechstens_ms=${WARTE_MS}`), stop)
    if (!w?.ok) return null
  }
  return null
}

// The chat's choice into the YAML: an option's label as is, any other answer ("Other") as an own
// answer, shortened to what the server takes (one line, 500 characters) instead of dropped.
async function spiegeln($: EngineInterface, api: string, fragen: readonly Frage[], ids: string[], ergebnis: unknown): Promise<void> {
  const r = ergebnis as { deny?: unknown; isError?: unknown; result?: { answers?: Record<string, unknown> } }
  if (r?.deny !== undefined || r?.isError) return
  const antworten = r?.result?.answers ?? {}
  for (const [i, f] of fragen.entries()) {
    const wahl = antworten[f.question]
    if (typeof wahl !== 'string') continue
    if (f.options.some(o => o.label === wahl)) {
      await entscheiden($, api, ids[i]!, wahl)
      continue
    }
    const eigen = einzeilig(wahl)
    if (eigen) await entscheiden($, api, ids[i]!, eigen, true)
  }
}

// ---------------------------------------------------------------------------
// 2. and 3. The timer: notify open questions, report decisions.

let takt: Timer | null = null
let tickLaeuft = false
// The main loop's running turn; null while the session is idle.
let hauptZug: string | null = null
let wartend: { id: string; zeilen: Map<string, string> } | null = null

async function melden($: EngineInterface): Promise<void> {
  if (!wartend?.zeilen.size || hauptZug) return
  const { id, zeilen } = wartend
  wartend = null
  const m = await merkerVon($, id)
  m.gemeldet.push(...zeilen.keys())
  await sichern($, id, m)
  // Not awaited: it resolves once the new turn starts, after this dispatch.
  void $.prompt.submit({ text: [...zeilen].map(([f, w]) => `live-plan: ${f} = ${w}`).join('\n') }).catch(() => undefined)
}

async function tick($: EngineInterface): Promise<void> {
  if (tickLaeuft) return
  tickLaeuft = true
  try {
    const ort = await ortVon($)
    if (!ort) return
    const d = await planHolen($, ort.api)
    if (!d) return
    const m = await merkerVon($, ort.id)
    if (wartend && wartend.id !== ort.id) wartend = null
    let neu = false
    for (const f of fragenAus(d)) {
      if (typeof f.id !== 'string') continue
      const wahl = entscheidung(f)
      if (!wahl) {
        if (m.offen.includes(f.id)) continue
        m.offen.push(f.id)
        neu = true
        void $.ui.notify(`live-plan: ${f.id} offen — ${String(f.frage ?? '')}`).catch(() => undefined)
      } else if (m.offen.includes(f.id) && !m.gemeldet.includes(f.id)) {
        wartend ??= { id: ort.id, zeilen: new Map() }
        wartend.zeilen.set(f.id, meldetext(f, wahl))
      }
    }
    if (neu) await sichern($, ort.id, m)
    await melden($)
  } catch {
    // Never disturb the session.
  } finally {
    tickLaeuft = false
  }
}

function starteTakt($: EngineInterface): void {
  if (takt) return
  try {
    takt = $.clock.every(TAKT_MS, () => {
      void tick($)
    })
  } catch {
    takt = null
  }
}

// A plugin may hook an event only once without a matcher (register.tsx holds turn.complete):
// these matchers select every turn.
const JEDER_ZUG = /(?:)/
const JEDES_ENDE = ['answer', 'aborted', 'refusal', 'error'] as const

export const fragenRegistrieren: Register = (on, options) => {
  skriptOption = typeof options.skript === 'string' ? options.skript.trim() : ''

  // Only the main loop raises turn.start; the timer starts with the first prompt.
  on('turn.start', { turnId: JEDER_ZUG }, async ($, e, next) => {
    const r = await next(e)
    hauptZug = e.turnId
    starteTakt($)
    return r
  }).catch(($, e, next) => next(e))

  on('turn.complete', { reason: JEDES_ENDE }, async ($, e, next) => {
    const r = await next(e)
    try {
      if (!e.agentId) {
        hauptZug = null
        starteTakt($)
        await melden($)
      }
    } catch {
      // Never disturb the session.
    }
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const fragen = e.questions as readonly Frage[]
    starteTakt($)
    let bereit: Awaited<ReturnType<typeof vorbereiten>> = null
    try {
      bereit = await vorbereiten($, fragen)
    } catch {
      bereit = null
    }
    if (!bereit) return next(e)
    const { ort, ids, url } = bereit

    const stop = new AbortController()
    const abbrechen = () => stop.abort()
    next.signal.addEventListener('abort', abbrechen, { once: true })
    $.ui.status(`Frage offen im live-plan: ${url}`)
    try {
      const chat = next(e)
      type Sieg = { chat: Awaited<typeof chat> } | { browser: Record<string, string> }
      const chatSieg: Promise<Sieg> = chat.then(r => ({ chat: r }))
      chatSieg.catch(() => undefined)
      // A browser that gives up leaves the race to the chat.
      const browserSieg: Promise<Sieg> = browserAntwort($, ort.api, ids, fragen, stop.signal).then(a =>
        a ? { browser: a } : chatSieg,
      )
      const sieg = await Promise.race([chatSieg, browserSieg])
      stop.abort()
      if ('browser' in sieg) {
        // Returning with `next` pending aborts the dialog beneath.
        return { result: { questions: e.questions, answers: sieg.browser } }
      }
      await spiegeln($, ort.api, fragen, ids, sieg.chat).catch(() => undefined)
      return sieg.chat
    } finally {
      next.signal.removeEventListener('abort', abbrechen)
      $.ui.status(undefined)
    }
  }).catch(($, e, next) => next(e))
}

// ---------------------------------------------------------------------------
// 4. Sprengradius (sprengradius.ts): a risky Bash command is refused at once, its question put
//    into the live-plan (with the measured paths), and Claude told to ask it through
//    AskUserQuestion, which hook 1 takes up and races against the browser. Run again after
//    "Ausführen", the same question decided so lets the command through, once. A hook's own
//    dialog ($.ui.ask) is not used: a host like T3 Code never draws it.
//    Its hook sits here because $ is followed only into functions of this file.

// Runs sprengradius.ts's measuring steps; a call that rejects reaches it as null.
async function sprengradiusMessen($: EngineInterface, r: Risiko): Promise<Bericht> {
  const schritte = messung(r, await $.session.cwd())
  let s = schritte.next()
  while (!s.done) {
    const { argv, cwd, timeoutMs, env } = s.value
    s = schritte.next(await $.process.run(argv, { cwd, timeoutMs, ...(env ? { env } : {}) }).catch(() => null))
  }
  return s.value
}

// The latest decision on this very question not acted on yet; marked as acted on.
async function freigabeNehmen($: EngineInterface, frage: string): Promise<string | null> {
  const ort = await ortVon($)
  if (!ort) return null
  const m = await merkerVon($, ort.id)
  const f = fragenAus((await planHolen($, ort.api)) ?? {}).findLast(
    x => x.frage === frage && entscheidung(x) && typeof x.id === 'string' && !m.verbraucht.includes(x.id),
  )
  if (!f) return null
  m.verbraucht.push(f.id as string)
  await sichern($, ort.id, m)
  return entscheidung(f)
}

export const sprengradiusRegistrieren: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const befehl = String(e.command ?? '')
    let risiko: Risiko | null = null
    try {
      risiko = einordnen(befehl)
    } catch {
      risiko = null
    }
    if (!risiko) return next(e)
    const r = risiko
    const bericht = await sprengradiusMessen($, r).catch(() => unbekannt(r))
    const frage = frageVon(befehl, bericht)
    const wahl = await freigabeNehmen($, frage.question).catch(() => null)
    if (wahl === AUSFUEHREN) return next(e)
    if (wahl !== null) return { deny: ablehnung(wahl, bericht) }
    let bereit: Awaited<ReturnType<typeof vorbereiten>> = null
    try {
      bereit = await vorbereiten($, [frage])
    } catch {
      bereit = null
    }
    // No live-plan to ask: never block, say so.
    if (!bereit) {
      await $.ui.notify(`Sprengradius: ${bericht.zusammenfassung} — ohne live-plan nicht gehalten`).catch(() => undefined)
      return next(e)
    }
    return { deny: anfrage(frage, bereit.ids[0]!, bereit.url, bericht) }
  }).catch(($, e, next) => next(e))
}
