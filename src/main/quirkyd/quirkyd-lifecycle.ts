import { setRuntimeBrowserCommandsFactory } from '../runtime/runtime-browser-commands-factory'
import { setDesktopBrowserBridgeHostEnabled } from '../runtime/desktop-browser-bridge/desktop-browser-bridge-registry'
import { QUIRKYD_MANAGED_ACTIVATION_ROOT_ENV } from '../../shared/quirkyd-managed-launch-env'
import { startQuirkydBrowserProvider } from './quirkyd-browser-startup'
import { QuirkydRuntimeLifetime, type QuirkydRuntimeCleanup } from './quirkyd-runtime-lifetime'
import type { QuirkydManagedStopInstance } from '../../shared/quirkyd-stop-request'
import { acquireQuirkydInstanceLock } from './quirkyd-instance-lock'
import { QUIRKYD_BUNDLED_LAUNCHER_ENV } from './quirkyd-bundled-runtime'
import { resolveQuirkydExitCode } from './quirkyd-exit-code'
import { recordAgentSessionRuntimeEnd } from '../runtime/agent-session-runtime-end-record'
import { QUIRKYD_SHUTDOWN_DEADLINE_MS } from './quirkyd-stop-deadlines'
import {
  acquireProfileStateRuntimeAdmission,
  type ProfileStateRuntimeAdmission
} from '../persistence/profile-state/profile-state-access'

const bundledLauncherChannel = process.env[QUIRKYD_BUNDLED_LAUNCHER_ENV] === '1'
delete process.env[QUIRKYD_BUNDLED_LAUNCHER_ENV]

function createIdempotentQuirkydCleanup(cleanup: () => Promise<void>): () => Promise<void> {
  let completion: Promise<void> | null = null
  return () => {
    completion ??= Promise.resolve().then(cleanup)
    return completion
  }
}

export { QUIRKYD_SHUTDOWN_DEADLINE_MS }

/**
 * True when this call began the stop; false when another source already owns it.
 * `stoppedExitCode` is the code a completed stop exits with; a fatal fault passes non-zero.
 */
export type QuirkydShutdownTrigger = (
  reason: string,
  onFailed?: () => void,
  stoppedExitCode?: number
) => boolean

/**
 * A launcher and its child can both receive the same process-group or service stop signal.
 * Returns the trigger stop-request listeners share, so every source runs one bounded stop.
 * `onFailed` runs before a failed or overdue stop exits, so a caller can retract a clean record.
 */
export function installQuirkydShutdownSignals(
  stop: () => Promise<void>,
  deadlineMs = QUIRKYD_SHUTDOWN_DEADLINE_MS
): QuirkydShutdownTrigger {
  let stopping = false
  let exitCode = 0
  let failed = false
  let retractClean: (() => void) | undefined
  const markFailed = (): void => {
    if (!failed) {
      failed = true
      retractClean?.()
    }
  }
  const shutdown: QuirkydShutdownTrigger = (signal, onFailed, stoppedExitCode = 0) => {
    if (stopping) {
      // A fatal fault during a clean stop must still exit as a failure, not as that clean stop.
      if (stoppedExitCode !== 0 && exitCode === 0) {
        exitCode = stoppedExitCode
        onFailed?.()
        markFailed()
      }
      return false
    }
    stopping = true
    exitCode = stoppedExitCode
    retractClean = onFailed
    setTimeout(() => {
      console.error(`quirkyd: shutdown after ${signal} exceeded ${deadlineMs}ms — exiting`)
      markFailed()
      process.exit(1)
    }, deadlineMs)
    stop()
      .then(() => process.exit(exitCode))
      .catch((error) => {
        console.error(`quirkyd: shutdown after ${signal} failed:`, error)
        markFailed()
        process.exit(resolveQuirkydExitCode(error))
      })
    return true
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  // Headless runtimes survive terminal hangups; INT/TERM are the graceful stop contract.
  if (process.platform !== 'win32') {
    process.on('SIGHUP', () => {})
  }
  if (bundledLauncherChannel && typeof process.send === 'function') {
    process.once('disconnect', () => shutdown('launcher disconnect'))
    if (!process.connected) {
      shutdown('launcher disconnect')
    }
  }
  return shutdown
}

export async function startQuirkydWithLifecycle<T extends object>(
  start: (registerRuntimeCleanup: (cleanup: QuirkydRuntimeCleanup) => void) => Promise<T>,
  cleanupHost: (runtimeCleanupSucceeded: boolean) => Promise<void>
): Promise<T & { stop(): Promise<void> }> {
  // Runtime resources stop in reverse registration order before any host resource.
  const runtime = new QuirkydRuntimeLifetime()
  const cleanup = createIdempotentQuirkydCleanup(async () => {
    // First, before any wait: chats whose agent dies with this stop read as a restart, not a crash.
    recordAgentSessionRuntimeEnd('quit')
    let runtimeCleanupSucceeded = false
    try {
      await runtime.stop()
      runtimeCleanupSucceeded = true
    } finally {
      await cleanupHost(runtimeCleanupSucceeded)
    }
  })
  try {
    const handle = await start((nextCleanup) => runtime.add(nextCleanup))
    return { ...handle, stop: cleanup }
  } catch (error) {
    try {
      await cleanup()
    } catch (cleanupError) {
      // Keep the launch failure as the supervisor-facing verdict; cleanup still needs a breadcrumb.
      console.error('[quirkyd] startup cleanup failed:', cleanupError)
    }
    throw error
  }
}

/** Keep profile admission and the instance lock until every runtime writer has stopped. */
export async function startQuirkydWithHost<T extends object>(
  userDataPath: string,
  start: (registerCleanup: (cleanup: QuirkydRuntimeCleanup) => void) => Promise<T>,
  runQuitHandlers: () => void
): Promise<T & { stop(): Promise<void>; instance: QuirkydManagedStopInstance }> {
  const instanceLock = acquireQuirkydInstanceLock(userDataPath)
  const { pid, startedAtMs, nonce } = instanceLock.record
  const instance = { pid, startedAtMs, nonce, lockPath: instanceLock.path }
  let admission: ProfileStateRuntimeAdmission | undefined
  let browserProvider: ReturnType<typeof startQuirkydBrowserProvider> | undefined
  return startQuirkydWithLifecycle(
    async (registerCleanup) => {
      admission = acquireProfileStateRuntimeAdmission(userDataPath)
      // Why not awaited: a desktop sidecar's authorization UI must not hold RPC readiness hostage.
      browserProvider = startQuirkydBrowserProvider({ userDataPath })
      // Why managed only: a desktop opts in per SSH host, so a server the user started has no
      // bridge to wait for; its CLI's browser commands go to the paired desktop hosting its pages.
      setDesktopBrowserBridgeHostEnabled(Boolean(process.env[QUIRKYD_MANAGED_ACTIVATION_ROOT_ENV]))
      return { ...(await start(registerCleanup)), instance }
    },
    async (runtimeCleanupSucceeded) => {
      // Failed teardown keeps both fences until the process actually exits.
      const host = new QuirkydRuntimeLifetime(() => {
        if (runtimeCleanupSucceeded) {
          instanceLock.release()
        }
      })
      host.add(({ failed }) => {
        if (runtimeCleanupSucceeded && !failed) {
          admission?.release()
        }
      })
      host.add(() => runQuitHandlers())
      host.add(() => setRuntimeBrowserCommandsFactory(null))
      host.add(() => setDesktopBrowserBridgeHostEnabled(false))
      host.add(() => browserProvider?.stop())
      await host.stop()
    }
  )
}

export async function flushQuirkydProfileStoreForShutdown(store: {
  flushFinalOrThrowAsync(): Promise<void>
  freezeWritesAsync(): Promise<void>
}): Promise<void> {
  try {
    await store.flushFinalOrThrowAsync()
  } finally {
    await store.freezeWritesAsync()
  }
}
