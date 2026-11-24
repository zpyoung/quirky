import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'

/**
 * Which orchestration runs must receive their workers' questions even when a UI could render them.
 *
 * The ask code stays generic: a supervisor (Heimdall, for owned watchers) installs the predicate,
 * and nothing is forced while none is installed — including every suite that never boots one.
 */
export type ForcedHandoffPolicy = {
  runtime: QuirkyRuntimeService
  isForcedRun: (runId: string) => boolean
}

let installedPolicy: ForcedHandoffPolicy | null = null

export function installForcedHandoffPolicy(policy: ForcedHandoffPolicy): void {
  installedPolicy = policy
}

export function clearForcedHandoffPolicy(): void {
  installedPolicy = null
}

export function getForcedHandoffPolicy(): ForcedHandoffPolicy | null {
  return installedPolicy
}
