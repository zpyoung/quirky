import {
  QUIRKYD_UPDATE_ADMISSION_FENCE_MS,
  type QuirkydTerminalCensus
} from '../../shared/quirkyd-terminal-census'
import type { QuirkydTerminalCensusRequestOptions } from './quirkyd-terminal-census-client'

/**
 * The counts an update makes against one incumbent. Only the last, just before the stop, closes
 * its terminal admission: the first precedes an upload that may take minutes.
 */
export function updateTerminalCounts(
  count: (options: QuirkydTerminalCensusRequestOptions) => Promise<QuirkydTerminalCensus>
): {
  countFirst: () => Promise<QuirkydTerminalCensus>
  recountCensus: () => Promise<QuirkydTerminalCensus>
  releaseIncumbentAdmission: () => Promise<void>
} {
  // Why release: finished automation shells would otherwise defer every update on a host with
  // schedules; the update restarts the server anyway.
  const release = { releaseFinishedAutomationTerminals: true }
  return {
    countFirst: () => count(release),
    recountCensus: () =>
      count({ ...release, closeAdmissionForMs: QUIRKYD_UPDATE_ADMISSION_FENCE_MS }),
    releaseIncumbentAdmission: async () => {
      await count({ closeAdmissionForMs: 0 })
    }
  }
}
