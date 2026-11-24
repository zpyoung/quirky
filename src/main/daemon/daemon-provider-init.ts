import { getLocalPtyProvider } from '../ipc/pty/provider/registry'
import { rebindLocalProviderListeners } from '../ipc/pty/provider/listener-lifecycle'
import { isStartupDiagnosticsEnabled, logStartupDiagnostic } from '../startup/startup-diagnostics'
import { checkDaemonHealth } from './daemon-health'
import { collectPinnedDaemonVersions, pruneOldDaemonHosts } from './daemon-host-relocation'
import {
  cleanupFailedDaemonAdoption,
  releaseDaemonAdoptionLease,
  takeDaemonAdoptionLeaseRelease
} from './daemon-endpoint-adoption'
import { createLegacyDaemonAdapters } from './daemon-legacy-adapters'
import {
  discoverNewerProtocolHolds,
  isHoldingForNewerProtocolDaemon
} from './daemon-newer-protocol-hold'
import {
  getDaemonHistoryDir as getHistoryDir,
  getDaemonRuntimeDir as getRuntimeDir,
  resolveStaleDaemonRecycleVersion
} from './daemon-launch-paths'
import {
  createOutOfProcessLauncher,
  type DaemonLaunchPolicy
} from './daemon-out-of-process-launcher'
import type { DaemonProvider } from './daemon-provider-routing'
import { installDaemonProvider } from './daemon-provider-state'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonRespawnReason } from './daemon-pty-runtime-state'
import { DaemonPtyRouter } from './daemon-pty-router'
import { DaemonSpawner, getDaemonPidPath } from './daemon-spawner'
import { clearSeveredDaemon, installSeveredDaemonController } from './daemon-host-image-state'
import {
  createSeveredDaemonController,
  hasSeveredDaemonBeenReplaced
} from './daemon-severed-restart'

// Why: daemon init runs concurrent with window load, so an in-process t timestamp (not harness stderr timing) measures cold-start.
function logDaemonMilestone(event: string, details: Record<string, unknown> = {}): void {
  if (isStartupDiagnosticsEnabled()) {
    logStartupDiagnostic(event, {
      t: Math.round(performance.now()),
      ...details
    })
  }
}

export async function initDaemonPtyProvider(
  signal?: AbortSignal,
  options: DaemonLaunchPolicy = {}
): Promise<void> {
  logDaemonMilestone('daemon-init-start')
  // Why: e2e coverage for the startup PTY gate (#5232) needs a daemon init that deterministically outlasts the first-window timeout.
  const e2eInitDelayMs = Number(process.env.QUIRKY_E2E_DAEMON_INIT_DELAY_MS)
  if (Number.isFinite(e2eInitDelayMs) && e2eInitDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, e2eInitDelayMs))
  }
  const runtimeDir = getRuntimeDir()

  const newSpawner = new DaemonSpawner({
    runtimeDir,
    launcher: createOutOfProcessLauncher(runtimeDir, options),
    staleDaemonRecycleVersion: resolveStaleDaemonRecycleVersion(
      options.recycleStaleDaemonOnEveryPlatform === true
    )
  })

  // Why: assign the module-level spawner/adapter only after both succeed, so a failed ensureRunning() leaves no stale spawner.
  const info = await newSpawner.ensureRunning()
  // Why: reclaim superseded daemon-host copies on EVERY launch (spawns are rare), keeping current + live-daemon-pinned versions.
  pruneOldDaemonHosts(collectPinnedDaemonVersions(runtimeDir))
  const launchMode = newSpawner.getHandle()?.mode
  const quarantine = newSpawner.getHandle()?.quarantine
  logDaemonMilestone('daemon-current-ready')
  if (signal?.aborted) {
    // Why: fail-open may already have spawned fallback PTYs; don't install late, but retire an empty daemon (live sessions reject it and survive).
    const abortedStartupAdapter = new DaemonPtyAdapter({
      socketPath: info.socketPath,
      tokenPath: info.tokenPath,
      pidPath: getDaemonPidPath(runtimeDir),
      profileScope: runtimeDir,
      runtimeDir
    })
    releaseDaemonAdoptionLease(newSpawner.getHandle())
    await abortedStartupAdapter.disconnectOnly()
    return
  }

  const newAdapter = new DaemonPtyAdapter({
    socketPath: info.socketPath,
    tokenPath: info.tokenPath,
    pidPath: getDaemonPidPath(runtimeDir),
    profileScope: runtimeDir,
    runtimeDir,
    packagedAppVersion: newSpawner.staleDaemonRecycleVersion,
    historyPath: getHistoryDir(),
    // Why: on daemon death, ensureConnected() detects the dead socket and calls this to fork a replacement before retrying.
    respawn: async (reason: DaemonRespawnReason) => {
      if (reason === 'daemon_died') {
        console.warn('[daemon] Daemon process died — respawning')
      }
      newSpawner.resetHandle()
      await newSpawner.ensureRunning()
      return takeDaemonAdoptionLeaseRelease(newSpawner.getHandle())
    }
  })
  let legacyAdapters: DaemonPtyAdapter[] = []
  let routedAdapter: DaemonProvider = newAdapter
  try {
    // Why: the launcher's temporary pair closes only after this permanent pair is established, leaving no adoption gap.
    await newAdapter.establishLifecycleLease()
    releaseDaemonAdoptionLease(newSpawner.getHandle())

    // Why beside legacy discovery: older daemons are adopted, newer ones only hold their tabs.
    const [discoveredLegacyAdapters] = await Promise.all([
      createLegacyDaemonAdapters(runtimeDir),
      discoverNewerProtocolHolds(runtimeDir)
    ])
    legacyAdapters = discoveredLegacyAdapters
    routedAdapter =
      launchMode === 'degraded-new-pty-fallback'
        ? new DegradedDaemonPtyProvider({
            current: newAdapter,
            legacy: legacyAdapters,
            fallback: getLocalPtyProvider(),
            // Why the incarnation gate: a severed daemon passes health checks for hours, so only a
            // new daemon at the endpoint (after a crash respawn or restart) may take fresh terminals.
            probeCurrentDaemonSpawn: async () =>
              (quarantine !== 'host-image-severed' ||
                hasSeveredDaemonBeenReplaced(getDaemonPidPath(runtimeDir))) &&
              (await checkDaemonHealth(info.socketPath, info.tokenPath)) === 'healthy'
          })
        : legacyAdapters.length > 0 || isHoldingForNewerProtocolDaemon()
          ? new DaemonPtyRouter({
              current: newAdapter,
              legacy: legacyAdapters
            })
          : newAdapter
    if (routedAdapter instanceof DegradedDaemonPtyProvider) {
      // Why: preserved daemon can't create fresh terminals; discover its live session ids so only they route to it (fresh panes fall back locally).
      await routedAdapter.discoverDaemonSessions()
    } else if (routedAdapter instanceof DaemonPtyRouter) {
      await routedAdapter.discoverLegacySessions()
    }
    if (signal?.aborted) {
      // Why: same late-swap guard after legacy discovery; release uninstalled adapter leases without killing live sessions.
      await routedAdapter.disconnectOnly()
      return
    }
  } catch (error) {
    try {
      await cleanupFailedDaemonAdoption(newSpawner, newAdapter, legacyAdapters)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Daemon adoption and cleanup both failed')
    }
    throw error
  }
  installDaemonProvider(newSpawner, routedAdapter)
  installSeveredDaemonController(createSeveredDaemonController())
  if (quarantine !== 'host-image-severed') {
    clearSeveredDaemon()
  }
  // Why: the first window may register PTY listeners before daemon init finishes; rebind so daemon PTYs still fan out events.
  rebindLocalProviderListeners()
  logDaemonMilestone('daemon-init-done', {
    legacyAdapters: legacyAdapters.length
  })
}
