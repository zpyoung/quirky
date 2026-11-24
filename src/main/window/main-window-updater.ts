import { app, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type { ReleaseBuildListResult, UpdateCheckOptions } from '../../shared/update-status-types'
import { RELEASE_CHANNELS, type ReleaseChannel } from '../../shared/release-channel'
import type { Store } from '../persistence'
import { logStartupMilestone } from '../startup/startup-diagnostics'
import {
  checkForUpdatesFromMenu,
  dismissAvailableUpdate,
  downloadUpdate,
  getUpdateStatus,
  listAvailableReleaseBuilds,
  quitAndInstall,
  setupAutoUpdater,
  type PreQuitCleanupFailureMode,
  type UpdateInstallMode,
  type UpdaterSetupOptions
} from '../updater'

const UPDATER_SETUP_FALLBACK_MS = 15_000

// Why: a manual check can arrive before deferred setup runs, so entry points force this pending setup to configure the updater first.
let pendingAutoUpdaterSetup: (() => void) | null = null

export function ensureAutoUpdaterConfigured(): void {
  pendingAutoUpdaterSetup?.()
}

type UpdaterSetupHooks = {
  onBeforeUpdateQuit?: () => void | Promise<void>
  onBeforeUpdateQuitFailure?: PreQuitCleanupFailureMode
  updateInstallMode?: UpdateInstallMode
}

function buildUpdaterSetupOptions(store: Store, options?: UpdaterSetupHooks): UpdaterSetupOptions {
  return {
    getLastUpdateCheckAt: () => store.getUI().lastUpdateCheckAt,
    onBeforeQuit: async () => {
      try {
        await options?.onBeforeUpdateQuit?.()
      } finally {
        await store.flushPendingAsync()
      }
    },
    setLastUpdateCheckAt: (timestamp) => {
      store.updateUI({ lastUpdateCheckAt: timestamp })
    },
    getReleaseChannelOverride: () => store.getUI().releaseChannelOverride ?? null,
    onBeforeQuitFailure: options?.onBeforeUpdateQuitFailure,
    installMode: options?.updateInstallMode
  }
}

/**
 * Headless serve has no window, so the window-driven setup above never runs and remote clients see
 * the updater as unavailable forever (#22261). Deferred past readiness: the require is slow.
 */
export function setupHeadlessServeAutoUpdater(store: Store, options: UpdaterSetupHooks): void {
  setImmediate(() => {
    try {
      setupAutoUpdater(null, buildUpdaterSetupOptions(store, options))
      logStartupMilestone('updater-setup-done')
    } catch (error) {
      console.warn(
        '[serve] updater setup failed:',
        error instanceof Error ? error.message : String(error)
      )
    }
  })
}

export function scheduleMainWindowAutoUpdaterSetup(
  mainWindow: BrowserWindow,
  store: Store,
  options?: UpdaterSetupHooks
): void {
  // Why: setupAutoUpdater sync-require()s electron-updater (slow on cold Windows w/ Defender, #7225), so defer past first paint; timer fallback covers crash-looping renderers.
  let updaterSetupDone = false
  let updaterSetupFallback: ReturnType<typeof setTimeout> | null = null
  const clearDeferredSetup = (): void => {
    if (updaterSetupFallback) {
      clearTimeout(updaterSetupFallback)
      updaterSetupFallback = null
    }
    if (pendingAutoUpdaterSetup === setupAutoUpdaterDeferred) {
      pendingAutoUpdaterSetup = null
    }
  }
  const setupAutoUpdaterDeferred = (): void => {
    if (updaterSetupDone || mainWindow.isDestroyed()) {
      return
    }
    updaterSetupDone = true
    try {
      setupAutoUpdater(mainWindow, buildUpdaterSetupOptions(store, options))
      logStartupMilestone('updater-setup-done')
    } finally {
      clearDeferredSetup()
    }
  }
  pendingAutoUpdaterSetup = setupAutoUpdaterDeferred
  mainWindow.once('ready-to-show', () => setImmediate(setupAutoUpdaterDeferred))
  updaterSetupFallback = setTimeout(() => {
    updaterSetupFallback = null
    setupAutoUpdaterDeferred()
  }, UPDATER_SETUP_FALLBACK_MS)
  updaterSetupFallback.unref?.()
  if (updaterSetupDone) {
    clearDeferredSetup()
  }
}

export function registerUpdaterHandlers(_store: Store): void {
  ipcMain.removeHandler('updater:getStatus')
  ipcMain.removeHandler('updater:getVersion')
  ipcMain.removeHandler('updater:check')
  ipcMain.removeHandler('updater:download')
  ipcMain.removeHandler('updater:quitAndInstall')
  ipcMain.removeHandler('updater:dismissAvailableUpdate')
  ipcMain.removeHandler('updater:listBuilds')

  ipcMain.handle('updater:getStatus', () => getUpdateStatus())
  ipcMain.handle('updater:getVersion', () => app.getVersion())
  ipcMain.handle('updater:check', (_event, options?: UpdateCheckOptions) => {
    ensureAutoUpdaterConfigured()
    return checkForUpdatesFromMenu(options)
  })
  ipcMain.handle('updater:download', () => downloadUpdate())
  ipcMain.handle('updater:quitAndInstall', () => quitAndInstall())
  ipcMain.handle('updater:dismissAvailableUpdate', () => dismissAvailableUpdate())
  ipcMain.handle(
    'updater:listBuilds',
    async (
      _event,
      channel: ReleaseChannel,
      options?: { force?: boolean }
    ): Promise<ReleaseBuildListResult> => {
      if (!RELEASE_CHANNELS.includes(channel)) {
        return { ok: false, channel, message: `Unknown release channel "${channel}".` }
      }
      try {
        return {
          ok: true,
          channel,
          builds: await listAvailableReleaseBuilds(channel, { force: options?.force === true })
        }
      } catch (error) {
        // Why: a network/rate-limit failure is expected here; return it as data so
        // the picker can render the reason instead of rejecting the invoke.
        return { ok: false, channel, message: String((error as Error)?.message ?? error) }
      }
    }
  )
}
