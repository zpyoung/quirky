import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { UpdateCheckOptions, UpdateStatus } from '../../shared/update-status-types'
import type {
  RemoteServerUpdateInstallResult,
  RemoteServerUpdaterSnapshot,
  RemoteServerUpdateSupport
} from '../../shared/remote-server-update'
import { hasServeUpdateSupervisor } from '../serve-update-handoff'
import { getLinuxPackageType } from '../linux-update-package-type'
import { UpdaterBuildSelection } from './updater-build-selection'
import type { UpdateInstallMode } from './updater-state'

/** Exposes updater state to runtime RPC callers without leaking internal mutators. */
export abstract class UpdaterRemoteStatus extends UpdaterBuildSelection {
  /** Abandons an un-acted local or pinned update and restores the release feed. */
  protected dismissAvailableUpdate(): void {
    if (this.activeUpdateSource === 'release' && !this.isPinnedBuildActive) {
      return
    }
    if (this.localBuildSelectionInProgress || this.pinnedBuildSelectionInProgress) {
      return
    }
    // Why: only an un-acted 'available' card is abandoned — 'downloading'/'downloaded' still need the pinned feed and allowDowngrade.
    if (this.currentStatus.state !== 'available') {
      return
    }
    this.clearAvailableUpdateContext()
    this.restoreReleaseUpdateSource()
    // Why: leaving the card's 'available' status behind would let a retry download the local version off the restored release feed.
    this.sendStatus({ state: 'idle' })
  }

  protected getUpdateStatus(): UpdateStatus {
    return this.currentStatus
  }

  protected getRemoteServerUpdateSupport(): RemoteServerUpdateSupport {
    if (!app.isPackaged || is.dev) {
      return {
        installMode: this.updateInstallMode,
        automatic: false,
        reason: 'unpackaged-build'
      }
    }
    if (!this.autoUpdaterInitialized) {
      return {
        installMode: this.updateInstallMode,
        automatic: false,
        reason: 'updater-unavailable'
      }
    }
    const linuxPackageType = getLinuxPackageType()
    if (
      this.updateInstallMode === 'unsupported-headless-serve' ||
      linuxPackageType === 'deb' ||
      linuxPackageType === 'rpm' ||
      linuxPackageType === 'unusable'
    ) {
      return {
        installMode: this.updateInstallMode,
        automatic: false,
        reason: 'manual-service-update-required'
      }
    }
    return { installMode: this.updateInstallMode, automatic: true, reason: 'available' }
  }

  protected getRemoteServerUpdaterSnapshot(runtimeId: string): RemoteServerUpdaterSnapshot {
    return {
      appVersion: app.getVersion(),
      runtimeId,
      support: this.getRemoteServerUpdateSupport(),
      status: this.getUpdateStatus()
    }
  }

  protected assertRemoteServerUpdateAvailable(): void {
    if (!this.getRemoteServerUpdateSupport().automatic) {
      throw new Error('remote_update_manual_required')
    }
  }

  protected checkForRemoteServerUpdate(
    runtimeId: string,
    options?: UpdateCheckOptions
  ): RemoteServerUpdaterSnapshot {
    this.assertRemoteServerUpdateAvailable()
    this.checkForUpdatesFromMenu(options)
    return this.getRemoteServerUpdaterSnapshot(runtimeId)
  }

  protected downloadRemoteServerUpdate(runtimeId: string): RemoteServerUpdaterSnapshot {
    this.assertRemoteServerUpdateAvailable()
    if (this.currentStatus.state !== 'available') {
      throw new Error('remote_update_not_available')
    }
    this.downloadUpdate()
    return this.getRemoteServerUpdaterSnapshot(runtimeId)
  }

  protected installRemoteServerUpdate(runtimeId: string): RemoteServerUpdateInstallResult {
    this.assertRemoteServerUpdateAvailable()
    if (this.currentStatus.state !== 'downloaded') {
      throw new Error('remote_update_not_downloaded')
    }
    const targetVersion = this.currentStatus.version
    const result: RemoteServerUpdateInstallResult = {
      accepted: true,
      fromVersion: app.getVersion(),
      targetVersion,
      runtimeId
    }
    this.quitAndInstall()
    return result
  }

  protected resolveUpdateInstallMode(isServeMode: boolean): UpdateInstallMode {
    if (!isServeMode) {
      return 'interactive'
    }
    return hasServeUpdateSupervisor() ? 'supervised-headless-serve' : 'unsupported-headless-serve'
  }

  protected abstract downloadUpdate(): void
  protected abstract quitAndInstall(): void
}
