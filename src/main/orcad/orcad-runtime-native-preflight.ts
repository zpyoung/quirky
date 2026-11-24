import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PtySpawnHealthTimeoutError,
  PTY_SPAWN_HEALTH_TIMEOUT_MS,
  runPtySpawnHealthProbe
} from '../daemon/pty-subprocess/spawn-preflight'
import { WatcherProcessSupervisor } from '../ipc/parcel-watcher-process-supervisor'
import { resolveWatcherProcessEntryPath } from '../ipc/parcel-watcher-entry-path'
import { resolveOrcadInstallRoot } from './orcad-app-paths'

/** The candidate process owns disposable PTY and watcher probes before it touches user state. */
export async function preflightOrcadNativeRuntime(
  options: { nativeFeatures?: boolean } = {}
): Promise<void> {
  // Runtime health checks can degrade independently; artifact qualification remains strict.
  if (options.nativeFeatures === false) {
    return
  }
  await probePtySpawn()
  const directory = await mkdtemp(join(tmpdir(), 'orca-native-ready-'))
  const supervisor = new WatcherProcessSupervisor({
    entryPath: resolveWatcherProcessEntryPath(resolveOrcadInstallRoot(), false),
    useInProcessVitestFallback: false
  })
  const cancellation = new AbortController()
  let subscription: { unsubscribe(): Promise<void> } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    let resolveDelivery: () => void = () => {}
    let rejectDelivery: (error: unknown) => void = () => {}
    const delivered = new Promise<void>((resolve, reject) => {
      resolveDelivery = resolve
      rejectDelivery = reject
    })
    // A native callback can fail while subscribe is pending.
    void delivered.catch(() => {})
    timer = setTimeout(() => {
      const error = new Error('Bundled file watcher readiness timed out')
      cancellation.abort(error)
      rejectDelivery(error)
    }, 5_000)
    subscription = await supervisor.subscribe(
      directory,
      (error, events) => {
        if (error) {
          rejectDelivery(error)
        } else if (events.some((event) => event.path === join(directory, 'ready'))) {
          resolveDelivery()
        }
      },
      {},
      { signal: cancellation.signal, subscribeTimeoutMs: 5_000, onTerminalError: rejectDelivery }
    )
    await writeFile(join(directory, 'ready'), '')
    await delivered
  } finally {
    clearTimeout(timer)
    try {
      await subscription?.unsubscribe()
    } finally {
      supervisor.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  }
}

/** Retries once only after a timeout; a spawn error or non-zero exit fails immediately. */
async function probePtySpawn(): Promise<void> {
  try {
    await runPtySpawnHealthProbe(PTY_SPAWN_HEALTH_TIMEOUT_MS)
  } catch (error) {
    if (!(error instanceof PtySpawnHealthTimeoutError)) {
      throw error
    }
    await runPtySpawnHealthProbe(PTY_SPAWN_HEALTH_TIMEOUT_MS)
  }
}
