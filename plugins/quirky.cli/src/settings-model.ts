import type { FolderPickerResult, UiPluginContext } from '@quirky/protocol'
import type {
  CliLaunchTarget,
  InstalledCommandStatus,
  PairedRuntimeSummary,
  ProfileLauncherStatus
} from '@quirky/protocol/node'

export type CliTarget = {
  available: boolean
  executablePath: CliLaunchTarget['executablePath'] | null
  entrypointPath: CliLaunchTarget['entrypointPath'] | null
}

export type CliSettingsSnapshot = {
  phase: 'loading' | 'ready' | 'failed'
  refreshing: boolean
  busy: boolean
  loadError: string | null
  actionError: string | null
  status: InstalledCommandStatus | null
  target: CliTarget | null
  launchers: ProfileLauncherStatus[] | null
  runtimes: PairedRuntimeSummary[] | null
}

export type ProfileLauncherDraft = { name: string; profileHome: string; path: string }
export type RuntimeDraft = { name: string; pairingOffer: string }

type ActionOutcome<Value> = { ok: true; value: Value } | { ok: false }

/** Owns one mounted settings view's daemon state, reads, action lock, and teardown. */
export class CliSettingsModel {
  private readonly listeners = new Set<() => void>()
  private currentSnapshot: CliSettingsSnapshot = {
    phase: 'loading',
    refreshing: false,
    busy: false,
    loadError: null,
    actionError: null,
    status: null,
    target: null,
    launchers: null,
    runtimes: null
  }
  private disposed = false
  private refreshSequence = 0

  constructor(private readonly context: UiPluginContext) {}

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): CliSettingsSnapshot => this.currentSnapshot

  /** Invalidates pending reads and prevents later daemon calls, state changes, or notifications. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.refreshSequence++
    this.listeners.clear()
  }

  /** Reads the four settings sources together and ignores results superseded by a newer read. */
  async refresh(): Promise<void> {
    if (this.disposed) return
    const sequence = ++this.refreshSequence
    this.updateSnapshot({
      phase: this.currentSnapshot.status === null ? 'loading' : 'ready',
      refreshing: true,
      loadError: null
    })

    try {
      const [rawStatus, rawTarget, rawLaunchers, rawRuntimes] = await Promise.all([
        this.context.call('quirky.cli/commandStatus', {}),
        this.context.call('quirky.cli/commandTarget', {}),
        this.context.call('quirky.cli/profileLauncherList', {}),
        this.context.call('quirky.cli/runtimeList', {})
      ])
      if (!this.isCurrentRefresh(sequence)) return

      const launcherResult = rawLaunchers as { launchers: ProfileLauncherStatus[] }
      const runtimeResult = rawRuntimes as { runtimes: PairedRuntimeSummary[] }
      this.updateSnapshot({
        phase: 'ready',
        refreshing: false,
        loadError: null,
        status: rawStatus as InstalledCommandStatus,
        target: rawTarget as CliTarget,
        launchers: launcherResult.launchers,
        runtimes: runtimeResult.runtimes
      })
    } catch (error) {
      if (!this.isCurrentRefresh(sequence)) return
      this.updateSnapshot({
        phase: this.currentSnapshot.status === null ? 'failed' : 'ready',
        refreshing: false,
        loadError: this.errorMessage(error)
      })
    }
  }

  async installCommand(): Promise<boolean> {
    const outcome = await this.runAction(async () => {
      const { status, target } = this.currentSnapshot
      if (!status || !target?.available || !target.executablePath || !target.entrypointPath) {
        throw new Error('no verified CLI executable and entrypoint are available')
      }
      let replaceForeign = false
      if (status.state === 'foreign') {
        replaceForeign = await this.context.confirm({
          title: 'Replace foreign command?',
          body: `Replace the foreign launcher at ${status.path}?`
        })
        if (!replaceForeign || this.disposed) return
      }
      await this.context.call('quirky.cli/commandInstall', {
        path: status.path,
        profileHome: status.profileHome,
        executablePath: target.executablePath,
        entrypointPath: target.entrypointPath,
        replaceForeign
      })
    })
    return outcome.ok
  }

  async revealCommand(): Promise<boolean> {
    const outcome = await this.runAction(async () => {
      await this.context.call('quirky.cli/commandReveal', {})
    })
    return outcome.ok
  }

  async uninstallCommand(): Promise<boolean> {
    const status = this.currentSnapshot.status
    if (status === null) return false
    const outcome = await this.runAction(async () => {
      await this.context.call('quirky.cli/commandUninstall', { path: status.path })
    })
    return outcome.ok
  }

  /** Returns the sole selected path without reloading settings; cancellation and failure return null. */
  async pickProfileHome(startingFolder: string): Promise<string | null> {
    const outcome = await this.runAction(async () => {
      const result = await this.context.call('desktop.folder.pick', {
        title: 'Choose profile QUIRKY_HOME',
        ...(startingFolder ? { startingFolder } : {}),
        multiple: false
      }) as FolderPickerResult
      return !result.cancelled && result.paths.length === 1 ? result.paths[0]! : null
    }, false)
    return outcome.ok ? outcome.value : null
  }

  async createProfileLauncher(draft: ProfileLauncherDraft): Promise<boolean> {
    const outcome = await this.runAction(async () => {
      const target = this.currentSnapshot.target
      if (!target?.available || !target.executablePath || !target.entrypointPath) {
        throw new Error('no verified CLI executable and entrypoint are available')
      }
      if (!draft.name.trim() || !draft.profileHome.trim()) throw new Error('profile name and QUIRKY_HOME are required')
      await this.context.call('quirky.cli/profileLauncherInstall', {
        name: draft.name,
        profileHome: draft.profileHome,
        ...(draft.path ? { path: draft.path } : {}),
        executablePath: target.executablePath,
        entrypointPath: target.entrypointPath
      })
    })
    return outcome.ok
  }

  async removeProfileLauncher(path: string): Promise<boolean> {
    const outcome = await this.runAction(async () => {
      await this.context.call('quirky.cli/profileLauncherRemove', { path })
    })
    return outcome.ok
  }

  async saveRuntime(draft: RuntimeDraft): Promise<boolean> {
    const outcome = await this.runAction(async () => {
      if (!draft.name.trim() || !draft.pairingOffer.trim()) throw new Error('runtime name and pairing offer are required')
      await this.context.call('quirky.cli/runtimeAdd', { name: draft.name, pairingCode: draft.pairingOffer })
    })
    return outcome.ok
  }

  async removeRuntime(id: string): Promise<boolean> {
    const outcome = await this.runAction(async () => {
      await this.context.call('quirky.cli/runtimeRemove', { selector: id })
    })
    return outcome.ok
  }

  /** Holds the action lock through its optional refresh and records action failures for the view. */
  private async runAction<Value>(action: () => Promise<Value>, refreshAfter = true): Promise<ActionOutcome<Value>> {
    if (this.disposed || this.currentSnapshot.busy) return { ok: false }
    this.updateSnapshot({ busy: true, actionError: null })
    try {
      const value = await action()
      if (this.disposed) return { ok: false }
      if (refreshAfter) await this.refresh()
      if (this.disposed) return { ok: false }
      return { ok: true, value }
    } catch (error) {
      if (!this.disposed) this.updateSnapshot({ actionError: this.errorMessage(error) })
      return { ok: false }
    } finally {
      if (!this.disposed) this.updateSnapshot({ busy: false })
    }
  }

  /** Publishes one immutable snapshot to subscribers unless teardown has begun. */
  private updateSnapshot(update: Partial<CliSettingsSnapshot>): void {
    if (this.disposed) return
    this.currentSnapshot = { ...this.currentSnapshot, ...update }
    this.listeners.forEach((listener) => listener())
  }

  /** Accepts only the newest read while this mount remains active. */
  private isCurrentRefresh(sequence: number): boolean {
    return !this.disposed && sequence === this.refreshSequence
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}
