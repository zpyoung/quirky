import type { QuirkydManagedStopRequest } from '../../shared/quirkyd-stop-request'
import { persistQuirkydDaemonRetirementRecord } from './quirkyd-completed-stop-receipt'
import type { QuirkydDaemonRetirement } from './quirkyd-daemon-retirement'
import { stopQuirkydAutomationScheduler } from './quirkyd-automations'

// Lazy like the rest of quirkyd's daemon graph: the entry module must not load it at import time.
async function retireLazily(): Promise<QuirkydDaemonRetirement> {
  const { retireQuirkydDaemonIfIdle } = await import('./quirkyd-daemon-retirement')
  return retireQuirkydDaemonIfIdle()
}

/** Runs before quirkyd stops for a managed request; it can record an outcome but never veto. */
export async function prepareQuirkydManagedStop(
  request: QuirkydManagedStopRequest,
  retire: () => Promise<QuirkydDaemonRetirement> = retireLazily,
  stopAutomations: () => void = stopQuirkydAutomationScheduler
): Promise<void> {
  // First, so no dispatch races the census below or writes a run the stop then discards.
  stopAutomations()
  if (!request.retireIdleDaemon) {
    return
  }
  const outcome = await retire().catch((error: unknown): QuirkydDaemonRetirement => ({
    retirement: 'unverifiable',
    liveSessions: null,
    reason: `Retirement failed: ${error instanceof Error ? error.message : String(error)}`
  }))
  try {
    persistQuirkydDaemonRetirementRecord(request, outcome)
  } catch (error) {
    // The completion command reads a missing record as `unverifiable`.
    console.error('[quirkyd] could not record daemon retirement:', error)
  }
}
