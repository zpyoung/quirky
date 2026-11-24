import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { ReleaseBuild, ReleaseChannel } from '../../shared/release-channel'
import { compareVersions } from '../updater-fallback'
import { profileStateBuildCompatibilityError } from '../../shared/profile-state-build-compatibility'
import { listReleaseBuilds, resolveTargetBuild } from '../updater-release-builds'
import { ReleaseBuildListCache, type ReleaseBuildListOptions } from '../updater-release-build-cache'
import { UpdaterMenuChecks } from './updater-menu-checks'

/** Handles local-build selection and exact release-channel/tag jumps. */
export abstract class UpdaterBuildSelection extends UpdaterMenuChecks {
  private readonly releaseBuildCache = new ReleaseBuildListCache((channel) =>
    listReleaseBuilds(channel)
  )

  protected async checkForLocalBuildFromMenu(): Promise<void> {
    if (process.platform !== 'darwin') {
      this.sendLocalBuildErrorAndRestore(
        'Local build switching is currently available only on macOS.',
        true
      )
      return
    }
    if (this.currentStatus.state === 'checking' || this.currentStatus.state === 'downloading') {
      return
    }
    if (this.localBuildSelectionInProgress) {
      return
    }
    this.localBuildSelectionInProgress = true
    try {
      const [{ chooseLocalBuild }, { startLocalBuildFeed }] = await Promise.all([
        import('../local-builds/local-build-switch'),
        import('../local-builds/local-build-feed-server')
      ])
      const candidate = await chooseLocalBuild(this.mainWindowRef)
      if (!candidate) {
        return
      }
      const compatibilityError = profileStateBuildCompatibilityError(
        app.getVersion(),
        candidate.version
      )
      if (compatibilityError) {
        await candidate.close()
        throw new Error(compatibilityError)
      }
      this.closeLocalBuildFeed()
      const feed = await startLocalBuildFeed(candidate)
      this.activeLocalBuildFeed = feed
      this.activeUpdateSource = 'local'
      this.clearPrereleaseFallbackContext()
      this.clearPublishingWindowLastGoodCheck()
      this.clearAvailableUpdateContext()
      this.userInitiatedCheck = true
      this.sendStatus({ state: 'checking', userInitiated: true })

      const updater = this.getAutoUpdater()
      updater.allowDowngrade = true
      updater.disableDifferentialDownload = true
      updater.setFeedURL({ provider: 'generic', url: feed.url })
      const attemptId = this.beginUpdateCheckAttempt()
      this.markUpdateCheckLaunched(attemptId)
      await updater.checkForUpdates()
      this.handleSettledUpdateCheckPromise(attemptId)
    } catch (error) {
      this.userInitiatedCheck = false
      this.sendLocalBuildErrorAndRestore(String((error as Error)?.message ?? error), true)
    } finally {
      this.localBuildSelectionInProgress = false
    }
  }

  protected async listAvailableReleaseBuilds(
    channel: ReleaseChannel,
    options?: ReleaseBuildListOptions
  ): Promise<ReleaseBuild[]> {
    return this.releaseBuildCache.list(channel, options)
  }

  /** Pins the updater at one exact release tag and checks it, so any published build on a channel — including an older one — can be installed. */
  protected async checkForPinnedBuild(channel: ReleaseChannel, tag: string): Promise<void> {
    if (!app.isPackaged || is.dev) {
      this.sendStatus({ state: 'not-available', userInitiated: true })
      return
    }
    if (this.currentStatus.state === 'checking' || this.currentStatus.state === 'downloading') {
      return
    }
    if (this.localBuildSelectionInProgress || this.pinnedBuildSelectionInProgress) {
      return
    }
    this.pinnedBuildSelectionInProgress = true
    try {
      const target = resolveTargetBuild(tag)
      const compatibilityError = profileStateBuildCompatibilityError(
        app.getVersion(),
        target.version
      )
      if (compatibilityError) {
        throw new Error(compatibilityError)
      }
      if (compareVersions(target.version, app.getVersion()) === 0) {
        this.sendSettledCheckStatus({ state: 'not-available', userInitiated: true })
        return
      }
      this.closeLocalBuildFeed()
      this.activeUpdateSource = 'release'
      this.isPinnedBuildActive = true
      this.clearPrereleaseFallbackContext()
      this.clearPublishingWindowLastGoodCheck()
      this.clearAvailableUpdateContext()
      this.userInitiatedCheck = true
      this.sendStatus({ state: 'checking', userInitiated: true })

      const updater = this.getAutoUpdater()
      // Why: an intentional jump to an older tag must not be filtered out as "not newer".
      updater.allowDowngrade = true
      updater.disableDifferentialDownload = true
      updater.allowPrerelease = true
      console.info(`[updater] pinned to ${channel} build ${target.tag} → ${target.feedUrl}`)
      updater.setFeedURL({ provider: 'generic', url: target.feedUrl })
      this.availableReleaseUrl = target.feedUrl
      const attemptId = this.beginUpdateCheckAttempt()
      this.markUpdateCheckLaunched(attemptId)
      await updater.checkForUpdates()
      this.handleSettledUpdateCheckPromise(attemptId)
    } catch (error) {
      this.userInitiatedCheck = false
      this.clearAvailableUpdateContext()
      this.restoreReleaseUpdateSource()
      this.sendSettledCheckStatus({
        state: 'error',
        message: String((error as Error)?.message ?? error),
        userInitiated: true
      })
    } finally {
      this.pinnedBuildSelectionInProgress = false
    }
  }
}
