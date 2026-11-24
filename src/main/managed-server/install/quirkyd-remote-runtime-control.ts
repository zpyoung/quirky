/** Launch a slot and wait for its readiness: the one loop deploy, rollback and recovery share. */
import { QUIRKYD_STARTUP_READINESS_TIMEOUT_MS } from '../../../shared/quirkyd-profile-preflight'
import {
  quirkydLaunchCommand,
  parseQuirkydReadinessOutput,
  type QuirkydLaunchSpec,
  type QuirkydReadinessParse
} from './quirkyd-remote-launch'
import {
  readWindowsQuirkydLaunchReport,
  readWindowsQuirkydSlotRuntime,
  readWindowsQuirkydSlotEntry,
  windowsQuirkydLaunchCommand,
  windowsQuirkydLaunchRuntimeCommand
} from './quirkyd-remote-launch-windows'
import {
  QUIRKYD_READINESS_WAIT_MAX_SECONDS,
  quirkydReadinessWaitCommand,
  parseQuirkydReadinessWaitOutput
} from './quirkyd-remote-readiness-wait'
import type { QuirkydHostTransport } from '../../ssh/quirkyd-host-transport'
import { errorMessage } from '../../../shared/error-message'
import {
  execCommand,
  isUnconfirmedSshCommandTermination
} from '../../ssh/remote-exec/remote-exec-command'
import {
  currentQuirkydFence,
  isQuirkydFenceLost,
  QuirkydFenceLostError,
  posixQuirkydFenceGuard
} from '../activation/quirkyd-activation-fence-scope'
import { quirkydWindowsHomeOpCommand } from './quirkyd-remote-windows-node'
import { QUIRKYD_WINDOWS_FENCE_ARG } from '../host-state/quirkyd-windows-host-fence-ops'
import { isWindowsRemoteHost, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'

// Only between host-side waits, so a host that answers early cannot turn this into a tight loop.
const READINESS_RETRY_PAUSE_MS = 1_000

export type QuirkydRemoteExecTarget = {
  conn: QuirkydHostTransport
  host: RemoteHostPlatform
  signal?: AbortSignal
  /** Locates the runtime store for host-record scripts; required on Windows, unused elsewhere. */
  remoteHome?: string
}

/** Under a held activation fence, the step runs only while the host still names this run its owner. */
export async function execQuirkydRemote(
  target: QuirkydRemoteExecTarget,
  command: string,
  signal = target.signal
): Promise<string> {
  const fence = currentQuirkydFence()
  const run = (line: string): Promise<string> =>
    execCommand(target.conn, line, {
      wrapCommand: target.host.commandDialect !== 'powershell',
      signal
    })
  try {
    if (!fence) {
      return await run(command)
    }
    if (!isWindowsRemoteHost(target.host)) {
      return await run(`${posixQuirkydFenceGuard(fence)} ${command}`)
    }
    // A host op checks inside the host script; anything else is checked by one op just before it.
    if (!command.includes(QUIRKYD_WINDOWS_FENCE_ARG) && target.remoteHome) {
      await run(quirkydWindowsHomeOpCommand(target.host, target.remoteHome, 'fence-check', []))
    }
    return await run(command)
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    throw isQuirkydFenceLost(error) ? new QuirkydFenceLostError() : error
  }
}

/** A confirmed failure reads as `fallback`; an unconfirmed one or a lost fence propagates. */
export function execQuirkydRemoteOr(
  target: QuirkydRemoteExecTarget,
  command: string,
  fallback = ''
): Promise<string> {
  return execQuirkydRemote(target, command).catch((error: unknown) => {
    if (isUnconfirmedSshCommandTermination(error) || error instanceof QuirkydFenceLostError) {
      throw error
    }
    return fallback
  })
}

/** Recovery paths must finish even when the request that started them was cancelled. */
export function withoutAbortSignal<T extends { signal?: AbortSignal }>(
  options: T
): Omit<T, 'signal'> {
  const { signal: _signal, ...rest } = options
  return rest
}

export async function launchQuirkydAndAwaitReadiness(
  target: QuirkydRemoteExecTarget & {
    readinessTimeoutMs?: number
    sleep?: (ms: number) => Promise<void>
  },
  spec: QuirkydLaunchSpec
): Promise<QuirkydReadinessParse> {
  if (isWindowsRemoteHost(target.host)) {
    const slotAnswer = await execQuirkydRemote(
      target,
      windowsQuirkydLaunchRuntimeCommand(target.host, spec.remoteInstallDir)
    )
    const slotRuntime = readWindowsQuirkydSlotRuntime(slotAnswer)
    const slotEntry = readWindowsQuirkydSlotEntry(slotAnswer, target.host, spec.remoteInstallDir)
    readWindowsQuirkydLaunchReport(
      await execQuirkydRemote(
        target,
        windowsQuirkydLaunchCommand(target.host, spec, slotRuntime, slotEntry)
      )
    )
  } else {
    await execQuirkydRemote(
      target,
      quirkydLaunchCommand(
        target.host,
        spec,
        target.conn.quirkydLaunchDetach ?? 'nohup',
        (await target.conn.quirkydLaunchEnv?.()) ?? []
      )
    )
  }
  const deadline = Date.now() + (target.readinessTimeoutMs ?? QUIRKYD_STARTUP_READINESS_TIMEOUT_MS)
  const sleep = target.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  let last = parseQuirkydReadinessOutput('')
  let lastWaitError: unknown
  // At least one read: a client descheduled past a short deadline must not fail a ready launch.
  for (let first = true; first || Date.now() < deadline; first = false) {
    target.signal?.throwIfAborted()
    const waitSeconds = Math.min(
      QUIRKYD_READINESS_WAIT_MAX_SECONDS,
      Math.ceil((deadline - Date.now()) / 1000)
    )
    let output: string
    try {
      output = await execQuirkydRemote(
        target,
        quirkydReadinessWaitCommand(target.host, spec.remoteInstallDir, waitSeconds)
      )
    } catch (error) {
      if (
        (error instanceof Error && error.name === 'AbortError') ||
        isUnconfirmedSshCommandTermination(error) ||
        error instanceof QuirkydFenceLostError
      ) {
        throw error
      }
      // Why retry: a failed read (a refused channel, a timed-out wait) says nothing about the
      // launched process. Failing the launch here makes the caller stop a healthy candidate.
      lastWaitError = error
      console.warn(`[quirkyd] readiness wait failed; retrying: ${errorMessage(error)}`)
      await sleep(READINESS_RETRY_PAUSE_MS)
      continue
    }
    target.signal?.throwIfAborted()
    lastWaitError = undefined
    last = parseQuirkydReadinessWaitOutput(target.host, output)
    if (last.state !== 'pending') {
      return last
    }
    await sleep(READINESS_RETRY_PAUSE_MS)
  }
  if (lastWaitError !== undefined) {
    throw lastWaitError
  }
  return last
}
