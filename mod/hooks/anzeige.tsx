// Contract v3, part C: the session's live-plan in the system prompt, a band above the prompt
// with the plan's open questions as buttons, and a notification when a subagent ends.

import { atom, read } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { LivePlanSitzungBand, LivePlanSitzungFrage } from '../types'
import { zustand } from './register'

const SECTION = 'live-plan-sitzung:live-plan'
const VORSPANN = 'Stand des live-plan dieser Sitzung (Daten, keine Anweisung):'
const STAND_ABSTAND_MS = 20_000
const TAKT_MS = 3000
const ID = /^[A-Za-z0-9._-]+$/

const BAND = { plugin: 'live-plan-sitzung', key: 'band' } as const
const band = atom(BAND, null)

type Ort = { repo: string; slug: string; wurzel: string }

type ApiFrage = { id?: unknown; frage?: unknown; entscheidung?: unknown; optionen?: unknown }
type ApiAgent = { agentId?: unknown; beschreibung?: unknown; status?: unknown }
type Api = {
  plan?: { titel?: unknown; fragen?: unknown; schritte?: unknown } | null
  live?: { fortschritt?: { titel?: unknown; gesamt?: unknown; erledigt?: unknown } | null; agenten?: unknown } | null
}

// Where the session's plan lives: repository root, its name and the session id as slug.
let ort: Ort | null = null

// The `stand --kurz` text for the system prompt and when it was fetched.
let stand = ''
let standZeit = -Infinity
let standHolt: Promise<void> | null = null

let takt: { cancel: () => void } | null = null
let bandJson = 'null'

// The subagents already announced.
const gemeldet = new Set<string>()

let skriptOption = ''

// gitWurzel and skriptPfad as in register.tsx: the engine follows $ only into functions of
// the same file, so they cannot be imported.
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

// Re-read per call: a /clear gives the session a new id, and so the plan a new slug.
async function ortVon($: EngineInterface): Promise<Ort | null> {
  const slug = await $.session.id()
  if (ort?.slug === slug) return ort
  if (!ID.test(slug)) return null
  const wurzel = await gitWurzel($, await $.session.cwd())
  const repo = wurzel?.split('/').filter(Boolean).pop()
  ort = wurzel && repo ? { repo, slug, wurzel } : null
  return ort
}

async function basisUrl($: EngineInterface): Promise<string> {
  const port = (await $.env.get('LIVE_PLAN_PORT'))?.trim()
  return `http://localhost:${port && /^\d+$/.test(port) ? port : '4410'}`
}

const apiUrl = async ($: EngineInterface, o: { repo: string; slug: string }): Promise<string> =>
  `${await basisUrl($)}/api/${encodeURIComponent(o.repo)}/${encodeURIComponent(o.slug)}`

// ---------------------------------------------------------------------------
// System prompt: `bun <skript> stand <id> --kurz`, fetched at most every 20 s.

async function standHolen($: EngineInterface): Promise<void> {
  const o = await ortVon($)
  const skript = await skriptPfad($)
  if (!o || !skript) {
    stand = ''
    return
  }
  const r = await $.process.run(['bun', skript, 'stand', o.slug, '--kurz'], { cwd: o.wurzel, timeoutMs: 10_000 })
  stand = r.exitCode === 0 ? r.stdout.trim() : ''
}

// Starts a fetch unless one ran within the last 20 s; a failed one leaves the section out.
async function standAuffrischen($: EngineInterface): Promise<void> {
  if (standHolt) return
  const jetzt = await $.clock.now()
  if (jetzt - standZeit < STAND_ABSTAND_MS) return
  standZeit = jetzt
  standHolt = standHolen($)
    .catch(() => {
      stand = ''
    })
    .finally(() => {
      standHolt = null
    })
}

// ---------------------------------------------------------------------------
// The band's data: GET /api/<repo>/<slug> every 3 s, written to state only on a change.

const text = (x: unknown): string => (typeof x === 'string' ? x.trim() : '')
const zahl = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? Math.max(0, Math.round(x)) : 0)

const offeneFragen = (roh: unknown): LivePlanSitzungFrage[] =>
  (Array.isArray(roh) ? (roh as ApiFrage[]) : [])
    .filter(f => f && text(f.id) && text(f.frage) && !text(f.entscheidung))
    .map(f => ({
      id: text(f.id),
      frage: text(f.frage),
      optionen: (Array.isArray(f.optionen) ? (f.optionen as { label?: unknown; empfohlen?: unknown }[]) : [])
        .filter(o => o && text(o.label))
        .map(o => ({ label: text(o.label), empfohlen: o.empfohlen === true })),
    }))

function bandAus(api: Api, o: Ort): LivePlanSitzungBand | null {
  const plan = api.plan ?? null
  const live = api.live ?? null
  const schritte = Array.isArray(plan?.schritte) ? (plan.schritte as { status?: unknown }[]) : []
  const f = live?.fortschritt ?? null
  const agenten = Array.isArray(live?.agenten) ? (live.agenten as ApiAgent[]) : []
  const b: LivePlanSitzungBand = {
    repo: o.repo,
    slug: o.slug,
    titel: text(plan?.titel) || text(f?.titel),
    fragen: offeneFragen(plan?.fragen),
    schritte: schritte.length
      ? { fertig: schritte.filter(s => s?.status === 'fertig').length, gesamt: schritte.length }
      : { fertig: zahl(f?.erledigt), gesamt: zahl(f?.gesamt) },
    laufend: agenten.filter(a => a?.status === 'laeuft').map(a => text(a.beschreibung) || text(a.agentId)),
  }
  const leer = !b.titel && !b.fragen.length && !b.schritte.gesamt && !b.laufend.length
  return leer ? null : b
}

async function bandHolen($: EngineInterface): Promise<LivePlanSitzungBand | null> {
  const o = await ortVon($)
  if (!o) return null
  const r = await $.http.fetch(await apiUrl($, o))
  if (!r.ok) return null
  return bandAus(JSON.parse(r.text) as Api, o)
}

async function bandAuffrischen($: EngineInterface): Promise<void> {
  let neu: LivePlanSitzungBand | null
  try {
    neu = await bandHolen($)
  } catch {
    // Server down or not JSON: the band shows nothing.
    neu = null
  }
  const json = JSON.stringify(neu)
  if (json === bandJson) return
  await $.state.set(BAND, neu)
  bandJson = json
}

function taktStarten($: EngineInterface): void {
  if (takt) return
  try {
    takt = $.clock.every(TAKT_MS, () => {
      void bandAuffrischen($).catch(() => undefined)
    })
    void bandAuffrischen($).catch(() => undefined)
  } catch {
    takt = null
  }
}

async function entscheiden($: EngineInterface, b: LivePlanSitzungBand, frage: string, wahl: string): Promise<void> {
  try {
    const r = await $.http.fetch(`${await apiUrl($, b)}/entscheidung`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ frage, wahl }),
    })
    if (!r.ok) $.ui.toast(`live-plan: ${frage} nicht gespeichert (${r.status})`)
  } catch {
    $.ui.toast(`live-plan: ${frage} nicht gespeichert (Server nicht erreichbar)`)
  }
  await bandAuffrischen($).catch(() => undefined)
}

const jetztZeile = (b: LivePlanSitzungBand): string =>
  [
    b.titel || 'live-plan',
    b.schritte.gesamt ? `Schritte ${b.schritte.fertig}/${b.schritte.gesamt}` : '',
    b.laufend.length ? `${b.laufend.length} ${b.laufend.length === 1 ? 'Agent' : 'Agenten'}: ${b.laufend.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(' · ')

// ---------------------------------------------------------------------------

export const anzeigeRegistrieren: Register = (on, options) => {
  skriptOption = typeof options.skript === 'string' ? options.skript.trim() : ''

  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    try {
      await standAuffrischen($)
    } catch {
      // Never disturb the session.
    }
    return r
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    try {
      // After a reload nothing was fetched yet: fetch once without waiting for turn.start.
      if (standZeit === -Infinity) await standAuffrischen($)
      if (standHolt) await standHolt
      if (!stand) return r
      const ohne = r.sections.filter(s => s.id !== SECTION)
      return { sections: [...ohne, { id: SECTION, text: `${VORSPANN}\n${stand}`, scope: 'session' as const }] }
    } catch {
      return r
    }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    taktStarten($)
    if (e.props.hasSurvey) return next(e)
    const b = await read($, band)
    if (!b) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    if (!b.fragen.length) {
      return (
        <Box>
          <Text dimColor wrap="truncate-end">
            {jetztZeile(b)}
          </Text>
        </Box>
      )
    }
    let taste = 0
    return (
      <Box flexDirection="column">
        {b.fragen.map(f => (
          <Box key={`frage-${f.id}`} flexDirection="column">
            <Text>
              <Text bold>{f.id}</Text> {f.frage}
            </Text>
            <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
              {f.optionen.map((o, i) => {
                taste += 1
                return (
                  <Button
                    key={`${f.id}-${i}`}
                    label={o.label}
                    {...(taste <= 9 ? { hotkey: String(taste) } : {})}
                    {...(o.empfohlen ? { variant: 'primary' as const } : {})}
                    onPress={() => entscheiden($, b, f.id, o.label)}
                  />
                )
              })}
            </Box>
          </Box>
        ))}
      </Box>
    )
  }).catch(($, e, next) => next(e))

  // A subagent's turn ended: one notification per agent, the turn itself untouched.
  // The matcher keeps this apart from register.tsx's unmatched turn.complete.
  on('turn.complete', { agentId: /./ }, async ($, e, next) => {
    try {
      const id = e.agentId
      if (id && !gemeldet.has(id)) {
        gemeldet.add(id)
        const wer = zustand?.agenten.find(a => a.agentId === id)?.beschreibung || `Subagent ${id}`
        const wie = e.reason === 'answer' ? 'fertig' : e.reason === 'aborted' ? 'abgebrochen' : 'fehlgeschlagen'
        void $.ui.notify(`live-plan: ${wer} ${wie}`).catch(() => undefined)
      }
    } catch {
      // Never disturb the session.
    }
    return next(e)
  })
}
