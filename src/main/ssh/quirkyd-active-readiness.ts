/** Proving that the quirkyd an activation record names is the one actually serving. */
import {
  evaluateQuirkydActivation,
  type QuirkydActivationExpectation
} from '../managed-server/activation/quirkyd-activation-gate'
import {
  quirkydLivenessProbeCommand,
  parseQuirkydLiveness,
  type QuirkydLaunchSpec,
  type QuirkydReadinessParse
} from '../managed-server/install/quirkyd-remote-launch'
import {
  execQuirkydRemote,
  launchQuirkydAndAwaitReadiness,
  type QuirkydRemoteExecTarget
} from '../managed-server/install/quirkyd-remote-runtime-control'
import {
  parseQuirkydReadinessWaitOutput,
  readQuirkydReadinessNowCommand
} from '../managed-server/install/quirkyd-remote-readiness-wait'
import type { ServeReadiness } from '../server/serve-readiness'
import { withQuirkydLogTail } from '../managed-server/install/quirkyd-remote-log-tail'

/** `exited` is proven absence; `unverifiable` means the host could not say, which is not death. */
export type QuirkydReadinessFailureVerdict = 'exited' | 'unverifiable' | 'rejected'

export class QuirkydActiveReadinessError extends Error {
  constructor(
    readonly verdict: QuirkydReadinessFailureVerdict,
    message: string
  ) {
    super(message)
    this.name = 'QuirkydActiveReadinessError'
  }
}

function gatedReadiness(
  parsed: QuirkydReadinessParse,
  expectation: QuirkydActivationExpectation,
  label: string
): ServeReadiness {
  const readiness = parsed.state === 'ready' ? parsed.readiness : null
  const verdict = evaluateQuirkydActivation(readiness, expectation)
  if (verdict.decision === 'reject') {
    throw new QuirkydActiveReadinessError(
      'rejected',
      `${label} failed its readiness check: ${verdict.reason}`
    )
  }
  if (!readiness) {
    throw new QuirkydActiveReadinessError(
      'rejected',
      `${label} passed activation without a readiness payload.`
    )
  }
  const coverage = quirkydDaemonCoverageRefusal(readiness)
  if (coverage) {
    throw new QuirkydActiveReadinessError('rejected', `${label} ${coverage}`)
  }
  return readiness
}

/**
 * A slot proves terminals only when its daemon's self-test spawned a PTY, or completed the
 * handshake on a platform whose daemon never spawn-probes. A build that predates the coverage
 * field keeps the identity gate alone, so an older slot is not stranded.
 */
export function quirkydDaemonCoverageRefusal(readiness: ServeReadiness): string | null {
  const health = readiness.health
  const coverage = health?.terminalDaemon?.selfTest?.coverage
  if (!health || coverage === undefined || coverage === 'pty-spawn') {
    return null
  }
  if (coverage === 'handshake' && health.platform === 'win32') {
    return null
  }
  return (
    `reported terminal-daemon coverage '${String(coverage)}', which does not prove a PTY can ` +
    `be created on ${health.platform}.`
  )
}

/** Checks a recorded-active slot without starting anything. */
export async function probeActiveQuirkydReadiness(
  target: QuirkydRemoteExecTarget & { remoteInstallDir: string },
  expectation: QuirkydActivationExpectation
): Promise<ServeReadiness> {
  const liveness = parseQuirkydLiveness(
    await execQuirkydRemote(
      target,
      quirkydLivenessProbeCommand(target.host, target.remoteInstallDir)
    )
  )
  if (liveness === 'DEAD') {
    throw new QuirkydActiveReadinessError(
      'exited',
      `quirkyd ${expectation.fullVersion} is recorded active but its process has exited.`
    )
  }
  if (liveness === 'NEVER_LAUNCHED') {
    throw new QuirkydActiveReadinessError(
      'exited',
      `quirkyd ${expectation.fullVersion} is recorded active but was never started from its install directory.`
    )
  }
  if (liveness !== 'LIVE') {
    throw new QuirkydActiveReadinessError(
      'unverifiable',
      `quirkyd ${expectation.fullVersion} process state is unverifiable.`
    )
  }
  const parsed = parseQuirkydReadinessWaitOutput(
    target.host,
    await execQuirkydRemote(
      target,
      readQuirkydReadinessNowCommand(target.host, target.remoteInstallDir)
    )
  )
  return gatedReadiness(parsed, expectation, 'The active quirkyd')
}

/** Starts a slot (recovery or rollback) and accepts it only if it proves the expected build. */
export async function launchQuirkydSlotAndAwaitReadiness(
  target: QuirkydRemoteExecTarget & {
    readinessTimeoutMs?: number
    sleep?: (ms: number) => Promise<void>
  },
  spec: QuirkydLaunchSpec,
  expectation: QuirkydActivationExpectation
): Promise<ServeReadiness> {
  const parsed = await launchQuirkydAndAwaitReadiness(target, spec)
  try {
    return gatedReadiness(parsed, expectation, `quirkyd ${spec.fullVersion}`)
  } catch (error) {
    if (!(error instanceof QuirkydActiveReadinessError)) {
      throw error
    }
    const message = await withQuirkydLogTail(target, spec.remoteInstallDir, error.message)
    throw new QuirkydActiveReadinessError(error.verdict, message)
  }
}
