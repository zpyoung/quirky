/** Recovering an interrupted decommission from its journal entry; see quirkyd-decommission-transaction. */
import { writeQuirkydActivationRecord } from '../activation/quirkyd-activation-record-store'
import type { QuirkydActivationRecoveryResult } from '../activation/quirkyd-activation-recovery'
import type { QuirkydDecommissionRecoveryPlan } from './quirkyd-decommission-transaction'
import { settleQuirkydDecommissionStop } from './quirkyd-decommission-stop'
import {
  quirkydLivenessProbeCommand,
  quirkydLivenessProvenExited,
  parseQuirkydLiveness
} from '../install/quirkyd-remote-launch'
import { execQuirkydRemote } from '../install/quirkyd-remote-runtime-control'
import {
  ensureQuirkydSlotServing,
  quirkydSlotDir,
  resolveQuirkydSlotIdentity,
  type QuirkydSlotOptions
} from '../../ssh/quirkyd-recovery-slot'

/** Finishes an interrupted decommission; the record is only cleared on proven exit. */
export async function reconcileQuirkydDecommission(
  options: QuirkydSlotOptions,
  plan: QuirkydDecommissionRecoveryPlan
): Promise<QuirkydActivationRecoveryResult> {
  if (plan.action === 'keep-serving') {
    // Nothing was sent, so the recorded version must still be the one serving.
    const identity = await resolveQuirkydSlotIdentity(options, plan.version)
    return {
      outcome: 'recovered',
      resolution: 'restored-incumbent',
      activeVersion: plan.version,
      readiness: await ensureQuirkydSlotServing(options, identity)
    }
  }
  if (plan.action === 'resume-stop') {
    const settlement = await settleQuirkydDecommissionStop(options, plan.request)
    if (settlement.state === 'unsettled') {
      return {
        outcome: 'refused',
        verdict: settlement.verdict,
        code: 'quirkyd_recovery_decommission_unsettled',
        reason: settlement.reason
      }
    }
    if (settlement.state === 'withdrawn') {
      return reconcileQuirkydDecommission(options, {
        action: 'keep-serving',
        version: plan.request.version
      })
    }
    return reconcileQuirkydDecommission(options, {
      action: 'confirm-decommissioned',
      version: plan.request.version,
      record: plan.record
    })
  }
  // Only proven exit commits; a slot that is live or unanswering keeps the fence.
  const liveness = parseQuirkydLiveness(
    await execQuirkydRemote(
      options,
      quirkydLivenessProbeCommand(options.host, quirkydSlotDir(options, plan.version))
    )
  )
  if (!quirkydLivenessProvenExited(liveness)) {
    return {
      outcome: 'refused',
      verdict: liveness === 'LIVE' ? 'live' : 'unverifiable',
      code: 'quirkyd_recovery_decommissioned_slot_not_exited',
      reason: `quirkyd ${plan.version} is recorded as stopped but is ${liveness.toLowerCase()}.`
    }
  }
  if (plan.record) {
    await writeQuirkydActivationRecord(options, plan.record)
  }
  return { outcome: 'recovered', resolution: 'committed', activeVersion: null, readiness: null }
}
