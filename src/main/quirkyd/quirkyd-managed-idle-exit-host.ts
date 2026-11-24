/** Binds managed idle exit to this quirkyd's RPC server, PTY provider and terminal daemon. */
import { getAppEnvironment } from '../../shared/app-environment'
import type { RuntimeRpcClientActivity } from '../runtime/runtime-rpc/runtime-rpc-shutdown'
import type { QuirkydIdleExitEvidence } from './quirkyd-idle-exit-monitor'
import {
  activationFenceExists,
  createQuirkydIdleProbes,
  installQuirkydManagedIdleExit,
  resolveQuirkydManagedIdleExit,
  type QuirkydManagedIdleExitConfig,
  type QuirkydManagedIdleExitPorts
} from './quirkyd-managed-idle-exit'
import type { QuirkydDaemonRetirement } from './quirkyd-daemon-retirement'
import { recoverDaemonAfterCancelledIdleStop } from './quirkyd-idle-stop-daemon-recovery'
import {
  consumeQuirkydIdleStopRecord,
  discardQuirkydIdleStopRecord,
  writeQuirkydIdleStopRecord
} from './quirkyd-idle-stop-record'
import type { QuirkydShutdownTrigger } from './quirkyd-lifecycle'
import type { QuirkydIdleStopRecord } from '../../shared/quirkyd-idle-exit'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'

let requestIdleShutdown: QuirkydShutdownTrigger | null = null

/** main binds its shutdown once signal handling exists; the quiet period outlasts that gap. */
export function bindQuirkydIdleShutdown(request: QuirkydShutdownTrigger): void {
  requestIdleShutdown = request
}

type QuirkydIdleExitRuntimePorts = {
  rpc: { readClientActivity(): RuntimeRpcClientActivity }
  agentStates: () => readonly { state: string }[]
  hasStagedMigration: () => boolean
  automationsBusy: () => boolean
  /** Shutdown stops the monitor first, so a signal stop is never recorded as an idle one. */
  registerCleanup: (cleanup: () => void) => void
}

/**
 * Runs under the instance lock at startup: reads the previous run's idle-stop record before
 * anything this run does could be mistaken for it. Inert for an quirkyd no client launched.
 */
export function beginQuirkydIdleExit(userDataPath: string): {
  previousIdleStop: QuirkydIdleStopRecord | null | undefined
  start: (ports: QuirkydIdleExitRuntimePorts) => Promise<void>
} {
  const config = resolveQuirkydManagedIdleExit(process.env)
  if (!config) {
    return { previousIdleStop: undefined, start: async () => {} }
  }
  const previousIdleStop = consumeQuirkydIdleStopRecord(userDataPath)
  if (previousIdleStop) {
    console.error(`[quirkyd] the previous run stopped idle at ${previousIdleStop.stoppedAt}`)
  }
  const version = getAppEnvironment().getVersion()
  return {
    previousIdleStop,
    start: (ports) => startQuirkydManagedIdleExit({ ...ports, config, userDataPath, version })
  }
}

async function startQuirkydManagedIdleExit(
  input: QuirkydIdleExitRuntimePorts & {
    config: QuirkydManagedIdleExitConfig
    userDataPath: string
    version: string
  }
): Promise<void> {
  const { getLocalPtyProvider } = await import('../ipc/pty/provider/registry')
  const { getCurrentDaemonPid, getDaemonEndpointFacts, isDaemonTerminalAdmissionClosed } =
    await import('../daemon/daemon-provider-state')
  const { countLiveQuirkydDaemonSessions, retireQuirkydDaemonIfIdle } =
    await import('./quirkyd-daemon-retirement')
  const idleRecord = createIdleStopRecordOwnership(input.userDataPath)
  const hasChatProviders = (): boolean =>
    getStructuredAgentSessionHost()?.hasLoadedProviders() ?? false
  const ports: QuirkydManagedIdleExitPorts = {
    readClientActivity: () => input.rpc.readClientActivity(),
    listTerminals: () => getLocalPtyProvider().listProcesses(),
    countDaemonSessions: countLiveQuirkydDaemonSessions,
    hasDaemon: () => getDaemonEndpointFacts() !== null,
    agentStates: input.agentStates,
    hasChatProviders,
    hasStagedMigration: input.hasStagedMigration,
    automationsBusy: input.automationsBusy,
    activationFenceExists
  }
  // Work that an exit would end; clients and terminals are excluded, as the stop already weighed them.
  const nonTerminalWorkProbes = createQuirkydIdleProbes(input.config, ports).filter(
    (probe) => probe.name !== 'clients' && probe.name !== 'terminals'
  )
  const hasNonTerminalWork = async (): Promise<boolean> => {
    for (const probe of nonTerminalWorkProbes) {
      if (
        (await Promise.resolve()
          .then(probe.read)
          .catch(() => 'unverifiable')) !== 'idle'
      ) {
        return true
      }
    }
    return false
  }
  const dispose = installQuirkydManagedIdleExit({
    config: input.config,
    ports,
    stop: async (evidence) => {
      // Read first: a replacement may stop only the incarnation that agreed to retire.
      const retiringPid = getCurrentDaemonPid()
      const outcome = await stopForIdle(input, evidence, retireQuirkydDaemonIfIdle)
      // Clients or providers may return while daemon retirement awaits its reply.
      const activity = input.rpc.readClientActivity()
      if (
        hasChatProviders() ||
        activity.openConnections > 0 ||
        activity.requestsInFlight > 0 ||
        activity.lastRequestAt > evidence.quietSince
      ) {
        discardQuirkydIdleStopRecord(input.userDataPath)
        const daemon = await recoverDaemonAfterCancelledIdleStop(outcome, {
          admissionClosed: isDaemonTerminalAdmissionClosed,
          retireAgain: () => retireQuirkydDaemonIfIdle(),
          replaceDaemon: async () => {
            if (retiringPid === null) {
              throw new Error('the retiring daemon never identified itself')
            }
            const { restartDaemon } = await import('../daemon/daemon-provider-restart')
            await restartDaemon({ expectedDaemonPid: retiringPid, endpointMayBeGone: true })
          }
        })
        if (daemon === 'serving' || (await hasNonTerminalWork())) {
          return false
        }
        // The returning client's reconnect relaunches a server that can run terminals.
        idleRecord.requestShutdown(requestIdleShutdown)
        return true
      }
      idleRecord.requestShutdown(requestIdleShutdown)
      return true
    }
  })
  input.registerCleanup(() => {
    dispose()
    idleRecord.onShutdown()
  })
}

/**
 * A stop that fails or overruns is not clean, and one another source (a signal, a stop request)
 * took over is not idle; the next start must report neither as an idle stop. `onShutdown` runs
 * in every stop's cleanup, so a takeover that finishes before the idle request is handled too.
 */
export function createIdleStopRecordOwnership(userDataPath: string): {
  requestShutdown(request: QuirkydShutdownTrigger | null): void
  onShutdown(): void
} {
  let idleOwnsStop = false
  const discard = (): void => discardQuirkydIdleStopRecord(userDataPath)
  return {
    requestShutdown: (request) => {
      // Set first: the stop this starts may run its cleanup before the trigger returns.
      idleOwnsStop = true
      if (request?.('idle', discard) !== true) {
        idleOwnsStop = false
        discard()
      }
    },
    onShutdown: () => {
      if (!idleOwnsStop) {
        discard()
      }
    }
  }
}

async function stopForIdle(
  input: { userDataPath: string; version: string },
  evidence: QuirkydIdleExitEvidence,
  retireDaemon: () => Promise<QuirkydDaemonRetirement>
): Promise<QuirkydDaemonRetirement> {
  console.error(`[quirkyd] stopping: no client, terminal or job for ${evidence.timeoutMs}ms`)
  try {
    writeQuirkydIdleStopRecord(input.userDataPath, evidence, input.version)
  } catch (error) {
    console.error('[quirkyd] could not record the idle stop:', error)
  }
  // The daemon leaves only if it proves itself empty; a busy one stays up with its terminals.
  const outcome = await retireDaemon().catch((error: unknown): QuirkydDaemonRetirement => ({
    retirement: 'unverifiable',
    liveSessions: null,
    reason: String(error)
  }))
  console.error(
    `[quirkyd] terminal daemon on idle stop: ${outcome.retirement}${outcome.reason ? ` (${outcome.reason})` : ''}`
  )
  return outcome
}
