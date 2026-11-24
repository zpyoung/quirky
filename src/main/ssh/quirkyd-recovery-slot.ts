/**
 * Slot-level verdicts shared by activation, rollback and their crash recovery.
 *
 * Every verdict here is the execution host's: `exited` only on positive proof, and a probe
 * that could not answer is `unverifiable` — never a reason to start a second slot.
 */
import type { ServeReadiness } from '../server/serve-readiness'
import type { QuirkydActivationExpectation } from '../managed-server/activation/quirkyd-activation-gate'
import { QUIRKYD_INSTALL_MODEL } from '../managed-server/install/remote-install-model'
import { computeRemoteInstallDir } from '../managed-server/install/remote-versioned-install'
import { readRemoteQuirkydBuildHash } from '../managed-server/install/quirkyd-remote-build-hash'
import {
  launchQuirkydSlotAndAwaitReadiness,
  QuirkydActiveReadinessError,
  probeActiveQuirkydReadiness
} from './quirkyd-active-readiness'
import {
  quirkydLivenessProbeCommand,
  quirkydLivenessProvenExited,
  parseQuirkydLiveness,
  type QuirkydLiveness
} from '../managed-server/install/quirkyd-remote-launch'
import {
  parseQuirkydStopOutcome,
  stopQuirkydCommand,
  type QuirkydStopOutcome
} from '../managed-server/install/quirkyd-remote-process-control'
import {
  execQuirkydRemote,
  type QuirkydRemoteExecTarget
} from '../managed-server/install/quirkyd-remote-runtime-control'
import { quirkydActivationTransactionRoot } from '../managed-server/activation/quirkyd-activation-transaction'
import {
  initialQuirkydActivationAdmissionCommand,
  parseInitialQuirkydActivationAdmission
} from './quirkyd-initial-activation-admission'

export const QUIRKYD_SLOT_STOP_WAIT_SECONDS = 20

export type QuirkydSlotOptions = QuirkydRemoteExecTarget & {
  remoteHome: string
  /** Host Node for legacy slots only; a slot's own runtime marker wins. */
  nodePath: string
  userDataDir: string
  bindHost: string
  port: number
  readinessTimeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

export type QuirkydSlotIdentity = { version: string; remoteDir: string; buildHash: string }

function expectation(identity: QuirkydSlotIdentity): QuirkydActivationExpectation {
  return { buildHash: identity.buildHash, fullVersion: identity.version }
}

export function quirkydSlotDir(options: QuirkydSlotOptions, version: string): string {
  return computeRemoteInstallDir(QUIRKYD_INSTALL_MODEL, options.remoteHome, version)
}

/** Reads the installed bytes' hash, so a later readiness payload can be matched to them. */
export async function resolveQuirkydSlotIdentity(
  options: QuirkydSlotOptions,
  version: string
): Promise<QuirkydSlotIdentity> {
  const remoteDir = quirkydSlotDir(options, version)
  return { version, remoteDir, buildHash: await readRemoteQuirkydBuildHash(options, remoteDir) }
}

export function launchQuirkydSlot(
  options: QuirkydSlotOptions,
  identity: QuirkydSlotIdentity
): Promise<ServeReadiness> {
  return launchQuirkydSlotAndAwaitReadiness(
    options,
    {
      remoteInstallDir: identity.remoteDir,
      nodePath: options.nodePath,
      fullVersion: identity.version,
      userDataDir: options.userDataDir,
      bindHost: options.bindHost,
      port: options.port,
      // Every SSH launch is client-managed, so every one may idle out and be woken on connect.
      activationRoot: quirkydActivationTransactionRoot(options.host, options.remoteHome)
    },
    expectation(identity)
  )
}

/** Proves the slot serves, starting it only on proven exit. */
export async function ensureQuirkydSlotServing(
  options: QuirkydSlotOptions,
  identity: QuirkydSlotIdentity
): Promise<ServeReadiness> {
  const liveness = parseQuirkydLiveness(
    await execQuirkydRemote(options, quirkydLivenessProbeCommand(options.host, identity.remoteDir))
  )
  if (liveness === 'LIVE') {
    return probeActiveQuirkydReadiness(
      { ...options, remoteInstallDir: identity.remoteDir },
      expectation(identity)
    )
  }
  if (!quirkydLivenessProvenExited(liveness)) {
    throw new QuirkydActiveReadinessError(
      'unverifiable',
      `quirkyd ${identity.version} process state is unverifiable.`
    )
  }
  return launchQuirkydSlot(options, identity)
}

/** `justLaunched` only for a slot this run started; otherwise the readiness PID must agree. */
export async function stopQuirkydSlot(
  options: QuirkydSlotOptions,
  remoteDir: string,
  justLaunched: boolean
): Promise<QuirkydStopOutcome> {
  return parseQuirkydStopOutcome(
    await execQuirkydRemote(
      options,
      stopQuirkydCommand(
        options.host,
        remoteDir,
        justLaunched
          ? { waitSeconds: QUIRKYD_SLOT_STOP_WAIT_SECONDS, justLaunched: true }
          : { waitSeconds: QUIRKYD_SLOT_STOP_WAIT_SECONDS, nodePath: options.nodePath }
      )
    )
  )
}

export type QuirkydSlotQuiescence = 'exited' | 'other-slot-serving'

/**
 * Before an interrupted run's state is replaced: the slot it started must be proven exited and
 * the slot being restored must not be running, or must already be serving (nothing to undo).
 *
 * A missing PID file is not proof of exit: an SSH drop can kill the launcher after `nohup`
 * but before it records `$!`, so the data root's owner records decide.
 */
export async function quiesceInterruptedQuirkydSlot(
  options: QuirkydSlotOptions,
  /** `null` when nothing was launched, so only `otherSlot` needs ruling out. */
  version: string | null,
  otherSlot: QuirkydSlotIdentity | null
): Promise<QuirkydSlotQuiescence> {
  const remoteDir = version === null ? null : quirkydSlotDir(options, version)
  const stopped =
    remoteDir === null ? 'already-exited' : await stopQuirkydSlot(options, remoteDir, false)
  let exited = stopped === 'stopped' || stopped === 'already-exited'
  if ((stopped === 'unknown' || stopped === 'unconfirmed') && remoteDir !== null) {
    // No verified answer, e.g. the slot died before readiness; liveness decides.
    exited = quirkydLivenessProvenExited(await slotLiveness(options, remoteDir))
  }
  if (otherSlot) {
    const other = await slotLiveness(options, otherSlot.remoteDir)
    if (other === 'LIVE' && (exited || stopped === 'no-pid')) {
      // The serving slot holds the instance lock, so a PID-less launch cannot own the state.
      await probeActiveQuirkydReadiness(
        { ...options, remoteInstallDir: otherSlot.remoteDir },
        expectation(otherSlot)
      )
      return 'other-slot-serving'
    }
    if (!quirkydLivenessProvenExited(other)) {
      throw new QuirkydActiveReadinessError(
        'unverifiable',
        `quirkyd ${version ?? 'candidate'} (${stopped}) and ${otherSlot.version} (${other}) cannot both be ` +
          'ruled out as owners of the shared state; it was not replaced.'
      )
    }
  }
  if (!exited && stopped === 'no-pid' && remoteDir !== null) {
    const admission = parseInitialQuirkydActivationAdmission(
      await execQuirkydRemote(
        options,
        initialQuirkydActivationAdmissionCommand(
          options.host,
          options.userDataDir,
          remoteDir,
          options.nodePath
        )
      )
    )
    exited = admission.decision === 'proceed'
  }
  if (!exited) {
    throw new QuirkydActiveReadinessError(
      'unverifiable',
      `quirkyd ${version ?? 'candidate'} could not be confirmed stopped (${stopped}); replacing its state would be unsafe.`
    )
  }
  return 'exited'
}

/** Asks the host whether anything runs from this slot directory. */
export async function slotLiveness(
  options: QuirkydSlotOptions,
  remoteDir: string
): Promise<QuirkydLiveness> {
  return parseQuirkydLiveness(
    await execQuirkydRemote(options, quirkydLivenessProbeCommand(options.host, remoteDir))
  )
}
