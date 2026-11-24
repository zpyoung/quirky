import type { z } from 'zod'
import { defineMethod } from '../core'
import type { QuirkyRuntimeService } from '../../quirky-runtime'
import {
  QUIRKYD_TERMINAL_CENSUS_METHOD,
  QuirkydTerminalCensusParamsSchema,
  type QuirkydTerminalCensus
} from '../../../../shared/quirkyd-terminal-census'

const SPAWN_SETTLE_MS = 10_000
const UNVERIFIABLE: QuirkydTerminalCensus = {
  liveSessions: null,
  startedSinceActivation: null,
  daemonProtocolVersion: null
}

export const QUIRKYD_TERMINAL_CENSUS_METHODS = [
  defineMethod({
    name: QUIRKYD_TERMINAL_CENSUS_METHOD,
    permission: 'host-admin',
    params: QuirkydTerminalCensusParamsSchema,
    handler: async (params, { runtime }) => {
      if (params.closeAdmissionForMs === undefined) {
        return countTerminals(params, runtime)
      }
      // Before counting: a terminal admitted after the count would die with the stop, uncounted.
      const admission = runtime.terminalUpdateAdmission
      const admissionClosedUntil = admission.close(params.closeAdmissionForMs)
      // A spawn admitted before the close may still be starting; count only once it has.
      if (admissionClosedUntil > 0 && !(await admission.waitForSpawnsToSettle(SPAWN_SETTLE_MS))) {
        return { ...UNVERIFIABLE, admissionClosedUntil }
      }
      return { ...(await countTerminals(params, runtime)), admissionClosedUntil }
    }
  })
]

async function countTerminals(
  params: z.infer<typeof QuirkydTerminalCensusParamsSchema>,
  runtime: Pick<QuirkyRuntimeService, 'releaseFinishedAutomationRunTerminals'>
): Promise<QuirkydTerminalCensus> {
  // Why lazy: the census reaches the daemon modules, whose xterm polyfill defines a global
  // `window`; importing them statically would load it into every process with the dispatcher.
  const { collectQuirkydTerminalCensus } = await import('../../../quirkyd/quirkyd-terminal-census')
  if (!params.releaseFinishedAutomationTerminals) {
    return collectQuirkydTerminalCensus(params.activatedAt)
  }
  const before = await collectQuirkydTerminalCensus(params.activatedAt)
  const released = await runtime.releaseFinishedAutomationRunTerminals()
  return settledCensus(
    () => collectQuirkydTerminalCensus(params.activatedAt),
    before.liveSessions === null ? null : before.liveSessions - released
  )
}

/** Closed sessions leave the daemon a moment after the close; wait briefly for the count to drop. */
async function settledCensus(
  collect: () => Promise<QuirkydTerminalCensus>,
  expectedAtMost: number | null
): Promise<QuirkydTerminalCensus> {
  let census = await collect()
  for (let attempt = 0; attempt < 15 && expectedAtMost !== null; attempt += 1) {
    if (census.liveSessions === null || census.liveSessions <= expectedAtMost) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
    census = await collect()
  }
  return census
}
