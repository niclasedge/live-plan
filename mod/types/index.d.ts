// The state contract of live-plan-sitzung: what the band above the prompt draws from.

export type LivePlanSitzungOption = { label: string; empfohlen: boolean }

export type LivePlanSitzungFrage = { id: string; frage: string; optionen: LivePlanSitzungOption[] }

export type LivePlanSitzungBand = {
  repo: string
  slug: string
  titel: string
  // Open questions of the plan (no `entscheidung` yet), in plan order.
  fragen: LivePlanSitzungFrage[]
  // Steps of the plan, or the flow reported through `progress` when the plan has none.
  schritte: { fertig: number; gesamt: number }
  // Descriptions of the subagents the register lists as running.
  laufend: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'live-plan-sitzung': { band: LivePlanSitzungBand | null }
  }
}
