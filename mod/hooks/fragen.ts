// The question channel of live-plan, contract v3 section B (/tmp/live-plan-vertrag-v3.md):
//
// 1. AskUserQuestion is also asked in the live-plan browser view. The hook appends the
//    questions to the session's YAML (`live-plan frage`), then lets the chat dialog and the
//    browser race: `next(e)` runs the dialog, a long poll on the server waits for the browser.
//    The browser winning returns the answer while `next` is still pending, which aborts the
//    dialog beneath (the `tool.call` contract: "returning with `next` pending aborts what runs
//    beneath"). The chat winning stops the poll and mirrors its choice into the YAML; an answer
//    that is no option's label (Claude Code's "Other") goes there as an own answer (`eigen`).
//    A question the chat closes without an answer (Esc, an interrupt, none given) is withdrawn
//    (`zurueckgezogen`, #27). When the session ends, every open question of its plan is withdrawn,
//    the agent's own too; without the server the script does it in the YAML.
// 2. Decisions on questions the hook did not ask (written by the agent into the YAML) wake the
//    session: `$.prompt.submit` when idle, else collected until the running turn completes.
// 3. A native notification once per open question.

import type { EngineInterface, Register, Timer } from 'claude-code'
import { AUSFUEHREN, ablehnung, anfrage, einordnen, frageVon, messung, unbekannt } from './sprengradius'
import type { Bericht, Risiko } from './sprengradius'

type Option = { label: string; description?: string }
export type Frage = { question: string; header?: string; multiSelect?: boolean; options: readonly Option[] }
type PlanFrage = { id?: unknown; frage?: unknown; entscheidung?: unknown; optionen?: unknown; zurueckgezogen?: unknown }
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

// Withdrawn (#27): closed without a decision, no one waits on it.
const zurueckgezogen = (f: PlanFrage): boolean => typeof f.zurueckgezogen === 'string' && f.zurueckgezogen.trim() !== ''
// Open as logik.ts's frageOffen reads it: neither decided nor withdrawn.
const offen = (f: PlanFrage): boolean => !entscheidung(f) && !zurueckgezogen(f)

// Why a question is withdrawn: the reason the live-plan shows next to it.
const ABGEBROCHEN = 'in der Sitzung abgebrochen'
const UNBEANTWORTET = 'in der Sitzung nicht beantwortet'
// A free `response` next to several questions belongs to none of them.
const FREI = 'im Chat frei beantwortet, keiner Frage zuzuordnen'
const NICHT_ERREICHBAR = 'live-plan nicht erreichbar'
const BEENDET = 'Sitzung beendet'
// The chat's answer that the YAML did not take is lost (accepted): the reason says so.
// No connection, a refusal (4xx), or the server failing (5xx).
const NICHT_GESPEICHERT = (status: number | null): string =>
  `im Chat beantwortet, ${
    status === null ? 'live-plan nicht erreichbar' : status >= 500 ? `Fehler im live-plan (HTTP ${status})` : `vom live-plan abgelehnt (HTTP ${status})`
  } – Antwort nicht gespeichert`

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

// A POST to the server, sent once more after a 5xx or no connection; the outcome, never swallowed.
async function posten($: EngineInterface, url: string, koerper: object): Promise<{ ok: boolean; status: number | null; text: string }> {
  let status: number | null = null
  let text = ''
  for (let anlauf = 0; anlauf < 2; anlauf++) {
    try {
      const r = await $.http.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(koerper) })
      if (r.ok) return { ok: true, status: r.status, text: r.text }
      status = r.status
      text = r.text
      if (r.status < 500) break
    } catch {
      status = null
      text = ''
    }
  }
  return { ok: false, status, text }
}

function entscheiden($: EngineInterface, api: string, frage: string, wahl: string, eigen = false): Promise<{ ok: boolean; status: number | null }> {
  return posten($, `${api}/entscheidung`, { frage, wahl, ...(eigen ? { eigen: true } : {}) })
}

// A decided question is not withdrawn. The server says so in the field `entschieden` of its 409,
// the script with exit code ENTSCHIEDEN_EXIT; their prose is for people (zurueckziehen.test.ts
// couples both to the real server and script).
export const ENTSCHIEDEN_EXIT = 3
export function schonEntschieden(r: { status: number | null; text: string }): boolean {
  if (r.status !== 409) return false
  try {
    const j = JSON.parse(r.text) as { entschieden?: unknown } | null
    return typeof j?.entschieden === 'string'
  } catch {
    return false
  }
}

// Withdraws questions the session closed without a decision (#27): through the server, else the
// script, which writes the YAML itself; a decided one stays. What neither reaches is said in the
// transcript, so the live-plan's open question is no silent lie.
async function zurueckziehen($: EngineInterface, ort: Ort, ids: readonly string[], grund: string): Promise<void> {
  for (const id of ids) {
    const r = await posten($, `${ort.api}/zurueckziehen`, { frage: id, grund })
    if (r.ok || schonEntschieden(r)) continue
    const skript = await skriptPfad($)
    const lauf = skript
      ? await $.process.run(['bun', skript, 'frage-zurueck', id, grund, '--sitzung', ort.id], { cwd: ort.wurzel, timeoutMs: LAUF_MS }).catch(() => null)
      : null
    if (lauf && (lauf.exitCode === 0 || lauf.exitCode === ENTSCHIEDEN_EXIT)) continue
    $.ui.log(`live-plan: ${id} nicht zurueckgezogen (${grund})`)
  }
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
// `erreichbar` false: the questions are in the YAML, but the server serves them not even after
// `start`; their ids stay, so the chat's outcome still closes them there.
async function vorbereiten(
  $: EngineInterface,
  fragen: readonly Frage[],
): Promise<{ ort: Ort; ids: string[]; url: string; erreichbar: boolean } | null> {
  if (!fragen.length || fragen.some(f => !f.options?.length)) return null
  const ort = await ortVon($)
  const skript = await skriptPfad($)
  if (!ort || !skript) return null
  // Asked already (Sprengradius puts its question there before the chat dialog): take it up. A
  // withdrawn one is closed; asked again, it is a new question.
  const vorhanden = fragenAus((await planHolen($, ort.api)) ?? {}).filter(offen)
  const schon = fragen.map(f => vorhanden.findLast(o => o.frage === f.question)?.id)
  if (schon.every((id): id is string => typeof id === 'string')) return { ort, ids: schon, url: ort.api.replace('/api/', '/'), erreichbar: true }
  const da = await $.fs.stat(skript).catch(() => undefined)
  if (!da || da.kind === 'dir') return null
  // Only the ones not asked yet are appended: no second open copy of a question (H4).
  const neue = fragen.filter((f, i) => typeof schon[i] !== 'string')
  const eingabe = {
    quelle: 'AskUserQuestion',
    fragen: neue.map(f => ({
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
  const angelegt = texte(j.ids)
  if (angelegt.length !== neue.length) return null
  const ids = schon.map(id => (typeof id === 'string' ? id : angelegt.shift()!))
  // Hook 1 answers these itself: hook 2 never reports them.
  const m = await merkerVon($, ort.id)
  m.gemeldet.push(...ids)
  await sichern($, ort.id, m)
  const url = typeof j.url === 'string' ? j.url : ort.api
  if (!(await planHolen($, ort.api))) {
    await $.process.run(['bun', skript, 'start'], { cwd: ort.wurzel, timeoutMs: LAUF_MS }).catch(() => undefined)
    if (!(await planHolen($, ort.api))) return { ort, ids, url, erreichbar: false }
  }
  return { ort, ids, url, erreichbar: true }
}

// Waits until every question `ids` names is decided in the browser: answers by question
// text, or null once `stop` aborts (the chat answered, the call ended) or a question is gone or
// withdrawn. A failed read is no answer (H2): it reads again a beat later, as long as it takes;
// the hook's budget pauses while the chat dialog (`next`) runs.
async function browserAntwort(
  $: EngineInterface,
  api: string,
  ids: string[],
  fragen: readonly Frage[],
  stop: AbortSignal,
): Promise<Record<string, string> | null> {
  while (!stop.aborted) {
    const d = await bis(planHolen($, api), stop)
    if (d) {
      const liste = fragenAus(d)
      const antworten: Record<string, string> = {}
      for (const [i, id] of ids.entries()) {
        const f = liste.find(x => x.id === id)
        if (!f || zurueckgezogen(f)) return null
        const wahl = entscheidung(f)
        if (wahl) antworten[fragen[i]!.question] = wahl
      }
      if (Object.keys(antworten).length === ids.length) return antworten
      const seit = typeof d.verlauf === 'number' ? d.verlauf : 0
      const w = await bis($.http.fetch(`${api}/warte?seit=${seit}&hoechstens_ms=${WARTE_MS}`), stop)
      if (w?.ok) continue
    }
    if (stop.aborted) return null
    await $.clock.sleep(TAKT_MS, { signal: stop }).catch(() => undefined)
  }
  return null
}

// What the chat dialog ended with: its answers by question text and a free `response`; null when
// it was refused or failed (deny, isError: Esc, an interrupt, an error).
function chatAntworten(ergebnis: unknown): { antworten: Map<string, unknown>; frei: string } | null {
  if (typeof ergebnis !== 'object' || ergebnis === null) return { antworten: new Map(), frei: '' }
  if (('deny' in ergebnis && ergebnis.deny !== undefined) || ('isError' in ergebnis && ergebnis.isError)) return null
  const result = 'result' in ergebnis && typeof ergebnis.result === 'object' && ergebnis.result !== null ? ergebnis.result : {}
  const answers = 'answers' in result && typeof result.answers === 'object' && result.answers !== null ? result.answers : {}
  const frei = 'response' in result && typeof result.response === 'string' ? result.response : ''
  return { antworten: new Map(Object.entries(answers)), frei }
}

// An answer as text: a multiple choice as a list is joined with commas, as the dialog joins it.
const antwortText = (roh: unknown): string =>
  typeof roh === 'string' ? roh : Array.isArray(roh) ? roh.filter((x): x is string => typeof x === 'string').join(', ') : ''

// The chat's outcome into the YAML: an option's label as is, any other answer ("Other", a multiple
// choice) as an own answer, shortened to what the server takes (one line, 500 characters) instead
// of dropped. A question left without an answer is withdrawn, as is one whose answer the server
// would not take: either way the live-plan must not show it waiting.
async function spiegeln($: EngineInterface, ort: Ort, fragen: readonly Frage[], ids: string[], ergebnis: unknown): Promise<void> {
  const chat = chatAntworten(ergebnis)
  if (!chat) return zurueckziehen($, ort, ids, ABGEBROCHEN)
  const zurueck: { id: string; grund: string }[] = []
  for (const [i, f] of fragen.entries()) {
    const id = ids[i]!
    let wahl = antwortText(chat.antworten.get(f.question))
    // A free answer in place of a choice belongs to the question only if it is the only one.
    if (!wahl.trim() && fragen.length === 1) wahl = chat.frei
    const label = f.options.some(o => o.label === wahl)
    const text = label ? wahl : einzeilig(wahl)
    if (!text) {
      zurueck.push({ id, grund: chat.frei.trim() ? FREI : UNBEANTWORTET })
      continue
    }
    const r = await entscheiden($, ort.api, id, text, !label)
    if (!r.ok) zurueck.push({ id, grund: NICHT_GESPEICHERT(r.status) })
  }
  for (const { id, grund } of zurueck) await zurueckziehen($, ort, [id], grund)
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
        if (zurueckgezogen(f) || m.offen.includes(f.id)) continue
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
// register.tsx holds session.end without a matcher: this one selects every session.
const JEDE_SITZUNG = /(?:)/

// At the session's end no one waits on its open questions: every open one is withdrawn, the
// agent's own too, so list and page agree (B1). A decided or withdrawn one stays. Without the
// server (off, crashed) the script withdraws them in the YAML, all in one call within
// session.end's short bound; a session without a YAML has nothing to close.
async function sitzungsende($: EngineInterface, sitzung: string): Promise<void> {
  const ort = await ortVon($)
  if (!ort || ort.id !== sitzung) return
  const d = await planHolen($, ort.api)
  if (d) {
    const ids = fragenAus(d).flatMap(f => (typeof f.id === 'string' && offen(f) ? [f.id] : []))
    return zurueckziehen($, ort, ids, BEENDET)
  }
  const yaml = await $.fs.stat(`${ort.wurzel}/.live-plan/${ort.id}.yaml`).catch(() => undefined)
  if (!yaml || yaml.kind !== 'file') return
  const skript = await skriptPfad($)
  const lauf = skript
    ? await $.process.run(['bun', skript, 'frage-zurueck', '--alle', BEENDET, '--sitzung', ort.id], { cwd: ort.wurzel, timeoutMs: LAUF_MS }).catch(() => null)
    : null
  if (lauf?.exitCode !== 0) $.ui.log(`live-plan: offene Fragen nicht zurueckgezogen (${BEENDET})`)
}

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
    // The chat dialog failing outright leaves no question of this call open in the YAML.
    const gescheitert = async (fehler: unknown): Promise<never> => {
      await zurueckziehen($, ort, ids, ABGEBROCHEN).catch(() => undefined)
      throw fehler
    }

    // The questions are in the YAML, the server does not serve them: the chat alone (H3), its
    // outcome still closes them there.
    if (!bereit.erreichbar) {
      const ergebnis = await next(e).catch(gescheitert)
      await spiegeln($, ort, fragen, ids, ergebnis).catch(() => undefined)
      return ergebnis
    }

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
      const sieg = await Promise.race([chatSieg, browserSieg]).catch(gescheitert)
      stop.abort()
      if ('browser' in sieg) {
        // Returning with `next` pending aborts the dialog beneath.
        return { result: { questions: e.questions, answers: sieg.browser } }
      }
      await spiegeln($, ort, fragen, ids, sieg.chat).catch(() => undefined)
      return sieg.chat
    } finally {
      stop.abort()
      next.signal.removeEventListener('abort', abbrechen)
      $.ui.status(undefined)
    }
  }).catch(($, e, next) => next(e))

  on('session.end', { sessionId: JEDE_SITZUNG }, async ($, e, next) => {
    // The whole chain shares one short bound: what does not finish within it is left.
    await bis(sitzungsende($, e.sessionId), next.signal)
    return next(e)
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
    // No live-plan to ask: never block, say so. A question it got but cannot show is withdrawn.
    if (!bereit?.erreichbar) {
      if (bereit) await zurueckziehen($, bereit.ort, bereit.ids, NICHT_ERREICHBAR).catch(() => undefined)
      await $.ui.notify(`Sprengradius: ${bericht.zusammenfassung} — ohne live-plan nicht gehalten`).catch(() => undefined)
      return next(e)
    }
    return { deny: anfrage(frage, bereit.ids[0]!, bereit.url, bericht) }
  }).catch(($, e, next) => next(e))
}
