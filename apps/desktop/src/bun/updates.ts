import type { TrayMenuItem } from './events'

export const UPDATE_CHECK_ACTION = 'check-update'
export const UPDATE_APPLY_ACTION = 'apply-update'

const FIRST_CHECK_DELAY_MS = 30_000
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

/** The slice of Electrobun's `UpdateInfo` the controller reads. */
export type UpdateInfoLike = {
  version: string
  updateAvailable: boolean
  updateReady: boolean
  error: string
}

/** The slice of Electrobun's `Updater` the controller drives; tests pass a fake. */
export type UpdaterLike = {
  getLocalInfo(): Promise<{ channel: string; version: string; baseUrl: string }>
  checkForUpdate(): Promise<UpdateInfoLike>
  downloadUpdate(): Promise<void>
  applyUpdate(): Promise<void>
  updateInfo(): UpdateInfoLike
}

export type UpdateNotice = { title: string; body: string }

export type UpdateCheckResult = 'disabled' | 'current' | 'ready' | 'failed' | 'busy'

export type UpdateControllerOptions = {
  updater: UpdaterLike
  notify: (notice: UpdateNotice) => void
  /** Called with the downloaded version when an update becomes ready to apply, so menus can show the restart item. */
  onReady: (version: string) => void
  /** Runs `fn` once after `ms` and returns a cancel function. */
  schedule: (fn: () => void, ms: number) => () => void
  warn?: (message: string, error?: unknown) => void
  firstCheckDelayMs?: number
  intervalMs?: number
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Keeps the installed app current from its release feed. After a short delay and then every few
 * hours it checks for a newer build, downloads it in the background and announces it once it is
 * staged; `restart()` swaps it in. Nothing here throws: failures are logged and, for a manual
 * check, shown to the user. The dev channel never checks.
 */
export function createUpdateController(options: UpdateControllerOptions) {
  const { updater, notify, onReady, schedule } = options
  const warn = options.warn ?? ((message, error) => console.warn(message, error))
  const firstDelay = options.firstCheckDelayMs ?? FIRST_CHECK_DELAY_MS
  const interval = options.intervalMs ?? CHECK_INTERVAL_MS

  let running: { manual: boolean; result: Promise<UpdateCheckResult> } | null = null
  let readyVersion: string | null = null
  let cancelTimer: (() => void) | null = null
  let stopped = false

  async function isDevChannel(): Promise<boolean> {
    try {
      const info = await updater.getLocalInfo()
      return info.channel === 'dev' || info.channel === '' || info.baseUrl === ''
    } catch (error) {
      warn('reading local update info failed:', error)
      return true
    }
  }

  function fail(manual: boolean, error: unknown): UpdateCheckResult {
    warn('update check failed:', error)
    if (manual) notify({ title: 'Update check failed', body: describe(error) })
    return 'failed'
  }

  async function run(manual: boolean): Promise<UpdateCheckResult> {
    if (await isDevChannel()) {
      if (manual) notify({ title: 'Updates are off', body: 'This is a development build, so it does not update itself.' })
      return 'disabled'
    }
    try {
      const checked = await updater.checkForUpdate()
      if (checked.error) return fail(manual, checked.error)
      if (!checked.updateAvailable) {
        if (manual) notify({ title: "You're up to date", body: 'Quirky is on the latest version.' })
        return 'current'
      }
      await updater.downloadUpdate()
      const downloaded = updater.updateInfo()
      if (downloaded.error) return fail(manual, downloaded.error)
      if (!downloaded.updateReady) return fail(manual, 'the update did not finish downloading')

      const announce = manual || readyVersion !== downloaded.version
      readyVersion = downloaded.version
      onReady(downloaded.version)
      if (announce) {
        notify({ title: 'Update ready', body: `Quirky ${downloaded.version} is downloaded. Choose Restart to Update from the Quirky menu.` })
      }
      return 'ready'
    } catch (error) {
      return fail(manual, error)
    }
  }

  function check(manual: boolean): Promise<UpdateCheckResult> {
    if (running) {
      if (!manual) return Promise.resolve('busy')
      // a silent scheduled run would swallow the outcome a manual check owes the user
      return running.manual ? running.result : running.result.then(() => check(true))
    }
    const result = run(manual).finally(() => {
      running = null
    })
    running = { manual, result }
    return result
  }

  function arm(ms: number): void {
    if (stopped) return
    cancelTimer = schedule(() => {
      void check(false).finally(() => arm(interval))
    }, ms)
  }

  return {
    /** Begins the periodic checks; a no-op on the dev channel. */
    async start(): Promise<void> {
      if (await isDevChannel()) return
      arm(firstDelay)
    },
    /** A user-requested check that always reports its outcome. */
    checkNow(): Promise<UpdateCheckResult> {
      return check(true)
    },
    /** Quits and relaunches into the staged update; reports a failure to start the swap. */
    async restart(): Promise<void> {
      try {
        await updater.applyUpdate()
        const { error } = updater.updateInfo()
        if (error) throw new Error(error)
      } catch (error) {
        warn('applying update failed:', error)
        notify({ title: 'Could not restart to update', body: describe(error) })
      }
    },
    /** Version staged for restart, or null. */
    readyVersion: (): string | null => readyVersion,
    stop(): void {
      stopped = true
      cancelTimer?.()
      cancelTimer = null
    }
  }
}

export type UpdateController = ReturnType<typeof createUpdateController>

/** Tray menu with the update items in their own group above the trailing divider and Quit entry. */
export function trayMenuWithUpdates(base: TrayMenuItem[], readyVersion: string | null): TrayMenuItem[] {
  const items: TrayMenuItem[] = [{ type: 'normal', label: 'Check for Updates…', action: UPDATE_CHECK_ACTION }]
  if (readyVersion) items.unshift({ type: 'normal', label: 'Restart to Update', action: UPDATE_APPLY_ACTION })
  const quitAt = base.length - 2
  return [...base.slice(0, quitAt), { type: 'divider' }, ...items, ...base.slice(quitAt)]
}

/** The update menu action carried by a native menu or tray click, or null for any other click. */
export function updateActionFromEvent(event: unknown): typeof UPDATE_CHECK_ACTION | typeof UPDATE_APPLY_ACTION | null {
  const action = (event as { data?: { action?: unknown } } | null)?.data?.action
  return action === UPDATE_CHECK_ACTION || action === UPDATE_APPLY_ACTION ? action : null
}
