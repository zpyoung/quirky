/**
 * What a managed quirkyd counts as "in use" before an idle stop, and the stop itself.
 *
 * The stop is the ordinary graceful shutdown, which disconnects from the terminal daemon and
 * never shuts it down, so no terminal can be killed by it. Terminals are still a blocker: a
 * host with live terminals keeps its server so a returning client finds it serving.
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { RELAY_INSTALL_LOCK_NAME } from '../../shared/relay-install-lock-name'
import { hasErrorCode } from '../daemon/daemon-process-inspection'
import type { RuntimeRpcClientActivity } from '../runtime/runtime-rpc/runtime-rpc-shutdown'
import { QUIRKYD_MANAGED_ACTIVATION_ROOT_ENV } from '../../shared/quirkyd-managed-launch-env'
import {
  QUIRKYD_IDLE_EXIT_TIMEOUT_MS,
  readQuirkydE2EIdleTimeoutMs
} from '../../shared/quirkyd-idle-exit'
import {
  QuirkydIdleExitMonitor,
  type QuirkydIdleExitEvidence,
  type QuirkydIdleProbe,
  type QuirkydIdleVerdict
} from './quirkyd-idle-exit-monitor'

export type QuirkydManagedIdleExitConfig = { timeoutMs: number; activationRoot: string }

/** Null for any quirkyd a client did not launch: a user-started or paired server never idles out. */
export function resolveQuirkydManagedIdleExit(
  env: NodeJS.ProcessEnv
): QuirkydManagedIdleExitConfig | null {
  const activationRoot = env[QUIRKYD_MANAGED_ACTIVATION_ROOT_ENV]
  if (!activationRoot) {
    return null
  }
  return {
    timeoutMs: readQuirkydE2EIdleTimeoutMs(env) ?? QUIRKYD_IDLE_EXIT_TIMEOUT_MS,
    activationRoot
  }
}

export type QuirkydManagedIdleExitPorts = {
  readClientActivity: () => RuntimeRpcClientActivity
  /** Every terminal the PTY provider knows, daemon-owned or in-process. */
  listTerminals: () => Promise<readonly unknown[]>
  /** Live daemon sessions across generations; null when a daemon did not answer. */
  countDaemonSessions: () => Promise<number | null>
  hasDaemon: () => boolean
  agentStates: () => readonly { state: string }[]
  hasChatProviders: () => boolean
  hasStagedMigration: () => boolean
  /** An enabled schedule or an unsettled run; nothing would fire either once the host exits. */
  automationsBusy: () => boolean
  /** Exists while a client holds the host's activation fence (update, rollback, decommission). */
  activationFenceExists: (root: string) => Promise<boolean>
}

export function createQuirkydIdleProbes(
  config: QuirkydManagedIdleExitConfig,
  ports: QuirkydManagedIdleExitPorts
): QuirkydIdleProbe[] {
  const verdict = (busy: boolean): QuirkydIdleVerdict => (busy ? 'busy' : 'idle')
  return [
    {
      name: 'clients',
      read: () => {
        const activity = ports.readClientActivity()
        return verdict(activity.openConnections > 0 || activity.requestsInFlight > 0)
      }
    },
    {
      name: 'terminals',
      read: async () => {
        if ((await ports.listTerminals()).length > 0) {
          return 'busy'
        }
        // Why read the daemon too: it outlives this process and may hold sessions no provider lists.
        if (!ports.hasDaemon()) {
          return 'idle'
        }
        const live = await ports.countDaemonSessions()
        return live === null ? 'unverifiable' : verdict(live > 0)
      }
    },
    {
      name: 'agents',
      read: () => verdict(ports.agentStates().some((entry) => entry.state === 'working'))
    },
    { name: 'chat-providers', read: () => verdict(ports.hasChatProviders()) },
    { name: 'migration', read: () => verdict(ports.hasStagedMigration()) },
    { name: 'automations', read: () => verdict(ports.automationsBusy()) },
    {
      name: 'activation',
      read: async () => verdict(await ports.activationFenceExists(config.activationRoot))
    }
  ]
}

/** The client holds the fence only while the lock exists; a bare root is an interrupted acquire. */
export async function activationFenceExists(root: string): Promise<boolean> {
  try {
    await stat(join(root, RELAY_INSTALL_LOCK_NAME))
    return true
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return false
    }
    throw error
  }
}

export function installQuirkydManagedIdleExit(input: {
  config: QuirkydManagedIdleExitConfig
  ports: QuirkydManagedIdleExitPorts
  /** Records the clean stop, then runs the same graceful shutdown as SIGTERM. */
  stop: (evidence: QuirkydIdleExitEvidence) => void | boolean | Promise<void | boolean>
}): () => void {
  const monitor = new QuirkydIdleExitMonitor({
    timeoutMs: input.config.timeoutMs,
    probes: createQuirkydIdleProbes(input.config, input.ports),
    lastClientActivityAt: () => input.ports.readClientActivity().lastRequestAt,
    onIdle: input.stop
  })
  monitor.start()
  return () => monitor.stop()
}
