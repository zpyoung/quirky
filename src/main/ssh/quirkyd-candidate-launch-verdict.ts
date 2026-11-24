import {
  evaluateQuirkydActivation,
  type QuirkydActivationVerdict
} from '../managed-server/activation/quirkyd-activation-gate'
import { quirkydActivationTransactionRoot } from '../managed-server/activation/quirkyd-activation-transaction'
import type { QuirkydReadinessParse } from '../managed-server/install/quirkyd-remote-launch'
import {
  launchQuirkydAndAwaitReadiness,
  type QuirkydRemoteExecTarget
} from '../managed-server/install/quirkyd-remote-runtime-control'
import { isUnconfirmedSshCommandTermination } from './remote-exec/remote-exec-command'

type CandidateLaunchTarget = Parameters<typeof launchQuirkydAndAwaitReadiness>[0] &
  QuirkydRemoteExecTarget & {
    remoteHome: string
    nodePath: string
    userDataDir: string
    bindHost: string
    port: number
  }

/**
 * Starts one slot and judges its readiness. An unconfirmed SSH termination rethrows: it says
 * nothing about the candidate, so it must never read as a rejected one.
 */
export async function launchAndJudgeQuirkydSlot(
  options: CandidateLaunchTarget,
  slot: { remoteInstallDir: string; fullVersion: string; buildHash: string }
): Promise<{ verdict: QuirkydActivationVerdict; launchError: unknown }> {
  let parsed: QuirkydReadinessParse | null = null
  let launchError: unknown
  try {
    parsed = await launchQuirkydAndAwaitReadiness(options, {
      remoteInstallDir: slot.remoteInstallDir,
      nodePath: options.nodePath,
      fullVersion: slot.fullVersion,
      userDataDir: options.userDataDir,
      bindHost: options.bindHost,
      port: options.port,
      activationRoot: quirkydActivationTransactionRoot(options.host, options.remoteHome)
    })
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    launchError = error
  }
  const verdict = evaluateQuirkydActivation(parsed?.state === 'ready' ? parsed.readiness : null, {
    buildHash: slot.buildHash,
    fullVersion: slot.fullVersion
  })
  return { verdict, launchError }
}
