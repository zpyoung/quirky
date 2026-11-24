/**
 * Decommissioning a managed quirkyd: stop its active instance and record that nothing serves.
 *
 * Runs under the activation fence and journal, so an interrupted decommission recovers like an
 * activation does. It refuses while the terminal census says terminals are live or cannot be
 * counted, and it never signals: the instance-bound request reaches only the quirkyd it names.
 * Only proven exit deactivates the record; anything less withdraws the request or keeps the
 * fence. Windows runs the same steps: the request is a staged file and exit proof is quirkyd's own.
 */
import { randomUUID } from 'node:crypto'
import type { QuirkydActivationRecord } from '../activation/quirkyd-activation-record'
import {
  readQuirkydActivationRecord,
  writeQuirkydActivationRecord
} from '../activation/quirkyd-activation-record-store'
import { sameQuirkydActivationRecord } from '../activation/quirkyd-activation-transaction'
import { writeQuirkydActivationTransaction } from '../activation/quirkyd-activation-transaction-store'
import { withQuirkydActivationLock } from '../activation/quirkyd-activation-lock'
import { quirkydActivationFenceRefusal } from '../activation/quirkyd-activation-fence-hold'
import {
  committedQuirkydDecommissionRecord,
  createQuirkydDecommissionTransaction,
  withQuirkydDecommissionProcessExited,
  withQuirkydDecommissionStopDispatched
} from '../lifecycle/quirkyd-decommission-transaction'
import { readRemoteQuirkydManagedStopTarget } from '../lifecycle/quirkyd-managed-remote-stop'
import { settleQuirkydDecommissionStop } from '../lifecycle/quirkyd-decommission-stop'
import type { QuirkydSlotOptions } from '../../ssh/quirkyd-recovery-slot'
import type { QuirkydDecommissionResult } from '../../../shared/quirkyd-decommission'
import type { QuirkydTerminalCensus } from '../../../shared/quirkyd-terminal-census'

export type QuirkydDecommissionOptions = QuirkydSlotOptions & {
  /** The record the caller reviewed; a changed host record refuses rather than guessing. */
  record: QuirkydActivationRecord
  /** Taken by the caller just before; any live or uncounted terminal refuses. */
  census: QuirkydTerminalCensus
  now?: () => Date
}

type Refusal = Extract<QuirkydDecommissionResult, { outcome: 'refused' }>

function refuse(verdict: Refusal['verdict'], code: string, reason: string): Refusal {
  return { outcome: 'refused', verdict, code, reason }
}

function censusRefusal(census: QuirkydTerminalCensus): Refusal | null {
  if (census.liveSessions === null) {
    return refuse(
      'unverifiable',
      'quirkyd_decommission_census_unavailable',
      'The terminal daemon did not answer a session count, so decommissioning could end ' +
        'running work. Retry when the host answers.'
    )
  }
  if (census.liveSessions > 0) {
    return refuse(
      'live',
      'quirkyd_decommission_terminals_running',
      `${census.liveSessions} terminal${census.liveSessions === 1 ? ' is' : 's are'} still ` +
        'running on this host. Close them before decommissioning the server.'
    )
  }
  return null
}

export async function decommissionRemoteQuirkyd(
  options: QuirkydDecommissionOptions
): Promise<QuirkydDecommissionResult> {
  const now = options.now ?? ((): Date => new Date())
  return withQuirkydActivationLock(
    options,
    async (lock) => {
      const record = await readQuirkydActivationRecord(options)
      if (!sameQuirkydActivationRecord(record, options.record)) {
        return refuse(
          'unverifiable',
          'quirkyd_decommission_record_changed',
          'The host activation record changed since it was reviewed. Refresh and try again.'
        )
      }
      const activeVersion = record.active
      if (!activeVersion) {
        return refuse(
          'unverifiable',
          'quirkyd_decommission_nothing_active',
          'No quirkyd version is active on this host, so there is nothing to decommission.'
        )
      }
      const census = censusRefusal(options.census)
      if (census) {
        return census
      }
      const target = await readRemoteQuirkydManagedStopTarget(options, activeVersion)
      if (target.state === 'refused') {
        return refuse(target.verdict, target.code, target.reason)
      }

      let transaction = createQuirkydDecommissionTransaction({
        transactionId: randomUUID(),
        recordBefore: { ...record, active: activeVersion },
        now: now()
      })
      await writeQuirkydActivationTransaction(options, transaction)
      lock.retainOnError()
      const request = {
        schemaVersion: 1 as const,
        transactionId: transaction.transactionId,
        ...target.context,
        // Best effort: an idle daemon goes with quirkyd, a busy one keeps its terminals.
        retireIdleDaemon: true as const
      }
      // Durable before it can reach the host, so recovery can settle exactly this request.
      transaction = withQuirkydDecommissionStopDispatched(transaction, request, now())
      await writeQuirkydActivationTransaction(options, transaction)

      const settlement = await settleQuirkydDecommissionStop(options, request)
      if (settlement.state === 'withdrawn') {
        // quirkyd never acted on it and keeps serving; the record never changed.
        return refuse(settlement.verdict, 'quirkyd_decommission_stop_withdrawn', settlement.reason)
      }
      if (settlement.state === 'unsettled') {
        lock.retain()
        return refuse(settlement.verdict, 'quirkyd_decommission_stop_unsettled', settlement.reason)
      }
      transaction = withQuirkydDecommissionProcessExited(transaction, now())
      await writeQuirkydActivationTransaction(options, transaction)
      await writeQuirkydActivationRecord(options, committedQuirkydDecommissionRecord(transaction))
      return {
        outcome: 'decommissioned',
        version: activeVersion,
        retirement: settlement.retirement
      }
    },
    async () => {
      const refusal = await quirkydActivationFenceRefusal(options, 'stop')
      return refuse('unverifiable', refusal.code, refusal.reason)
    }
  )
}
