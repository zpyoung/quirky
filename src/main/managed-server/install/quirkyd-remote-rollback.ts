/**
 * Going back to the previously active quirkyd.
 *
 * Rollback is a state operation, not a binary swap. The version dirs are immutable and both
 * are still on disk, so pointing at the old one is trivial; what is not trivial is that both
 * versions share ONE data root, outside either dir. A newer quirkyd migrates that root on load
 * — and Quirky's persisted state carries no schema version to migrate against, so the older
 * build cannot be shown to read the result. Rollback therefore restores the pre-activation
 * snapshot, and refuses when restoring it would orphan work (`assessQuirkydRollback`).
 *
 * The order is the whole safety argument: stop, rescue, restore, then start. Restoring under
 * a running quirkyd would replace the store beneath a process holding it open, and starting
 * before restoring would let the old build migrate the new build's state. The rescue copy of
 * the newer state, and the journal under the activation fence, make each step undoable.
 */
import { logQuirkydActivationOutcome } from '../activation/quirkyd-activation-outcome-log'
import type { QuirkydHostTransport } from '../../ssh/quirkyd-host-transport'
import type { QuirkydActivationRecord } from '../activation/quirkyd-activation-record'
import type { QuirkydTerminalCensus } from '../../../shared/quirkyd-terminal-census'
import type { QuirkydActivationVerdict } from '../activation/quirkyd-activation-gate'
import type { QuirkydDaemonProtocolFacts } from '../../ssh/quirkyd-daemon-protocol-crossing'
import { readQuirkydActivationRecord } from '../activation/quirkyd-activation-record-store'
import { sameQuirkydActivationRecord } from '../activation/quirkyd-activation-transaction'
import type { RemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import {
  resolveQuirkydActivationReadinessTimeout,
  withQuirkydActivationLock
} from '../activation/quirkyd-activation-lock'
import { quirkydActivationFenceRefusal } from '../activation/quirkyd-activation-fence-hold'
import { QUIRKYD_STARTUP_READINESS_TIMEOUT_MS } from '../../../shared/quirkyd-profile-preflight'
import { rollbackQuirkydLocked } from '../lifecycle/quirkyd-rollback-transition'

export type QuirkydRollbackOptions = {
  conn: QuirkydHostTransport
  host: RemoteHostPlatform
  remoteHome: string
  record: QuirkydActivationRecord
  nodePath: string
  userDataDir: string
  bindHost: string
  port: number
  census: QuirkydTerminalCensus
  /** Expected build hash of the rollback target, from the client's copy of those bytes. */
  targetBuildHash: string
  /** The rollback target's daemon protocol facts, from the same copy. */
  targetDaemonProtocol: QuirkydDaemonProtocolFacts
  readinessTimeoutMs?: number
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  signal?: AbortSignal
}

export type QuirkydRollbackResult =
  | {
      outcome: 'rolled-back'
      target: string
      discarded: string[]
      verdict: QuirkydActivationVerdict
    }
  | { outcome: 'refused'; code: string; reason: string }
  | { outcome: 'failed'; code: string; reason: string }

export async function rollbackQuirkyd(
  input: QuirkydRollbackOptions
): Promise<QuirkydRollbackResult> {
  const options = {
    ...input,
    readinessTimeoutMs: resolveQuirkydActivationReadinessTimeout(
      input.readinessTimeoutMs,
      QUIRKYD_STARTUP_READINESS_TIMEOUT_MS
    )
  }
  return logQuirkydActivationOutcome(
    `rollback to ${options.record.previous ?? 'none'}`,
    () =>
      withQuirkydActivationLock(
        options,
        async (lock) => {
          if (
            !sameQuirkydActivationRecord(await readQuirkydActivationRecord(options), options.record)
          ) {
            return {
              outcome: 'refused',
              code: 'quirkyd_rollback_record_changed',
              reason:
                'The host activation record changed while this rollback was waiting. Refresh the ' +
                'host state and review the new rollback target before trying again.'
            }
          }
          return rollbackQuirkydLocked(options, lock)
        },
        async () => {
          const { code, reason } = await quirkydActivationFenceRefusal(options, 'rollback')
          return { outcome: 'refused', code, reason }
        }
      ),
    ['rolled-back']
  )
}
