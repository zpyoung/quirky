import type { ReleaseBuild, ReleaseChannel } from './release-channel'

// ─── Updater ─────────────────────────────────────────────────────────

// Why: the release object sent to the renderer omits `version` (redundant
// with the top-level UpdateStatus.version) to keep one source of truth.
export type ChangelogRelease = {
  title: string
  description: string
  mediaUrl?: string
  releaseNotesUrl: string
}

export type ChangelogData = {
  release: ChangelogRelease
  releasesBehind: number | null
}

export type UpdateCheckOptions = {
  includePrerelease?: boolean
  includePerfPrerelease?: boolean
  localBuild?: boolean
  /** Channel switching; `targetTag` pins an exact build, including older ones. */
  channel?: ReleaseChannel
  targetTag?: string
}

/** Non-release origins for an update. */
export type UpdateSource = 'local'

export type UpdateInstallBlocker = {
  pid: number
  kind: 'window' | 'server' | 'browser' | 'unknown'
}

export type UpdateInstallBlock = {
  reason: 'running-instances' | 'busy' | 'unresponsive'
  instances: UpdateInstallBlocker[]
}

export type UpdateStatus = (
  | { state: 'idle' }
  | { state: 'checking'; userInitiated?: boolean }
  | {
      state: 'available'
      version: string
      // Why: releaseUrl is not currently populated by the update-available handler
      // (it always sends undefined). Kept on the type for the Settings page's
      // release-notes link fallback and for potential future use if the main
      // process starts extracting release URLs from electron-updater metadata.
      releaseUrl?: string
      // Why: changelog is always explicitly set by the main process — null means
      // the fetch failed or the version wasn't in the JSON (simple mode), and a
      // populated object means rich mode. Using `| null` (not `?`) avoids a
      // three-state ambiguity (undefined vs null vs present) and makes exhaustive
      // checks straightforward.
      changelog: ChangelogData | null
      /** Linux only: a package manager owns this install, so Quirky cannot apply the update itself.
       *  Additive and optional — older clients simply keep offering their own download. */
      externallyManaged?: boolean
    }
  | { state: 'not-available'; userInitiated?: boolean }
  | { state: 'downloading'; percent: number; version: string }
  | {
      state: 'downloaded'
      version: string
      releaseUrl?: string
      /** Install preparation is in progress; older clients can still render downloaded. */
      installing?: boolean
    }
  | {
      state: 'error'
      message: string
      /** Known download/install target; absent for check-time failures and older hosts. */
      version?: string
      /** Omitted by older hosts and for failures whose retryability is unknown. */
      retryable?: boolean
      /** A staged update can retry installation without downloading again; older hosts omit this. */
      retryAction?: 'install'
      userInitiated?: boolean
      /** Optional so older paired clients retain the diagnostic and install retry. */
      installBlock?: UpdateInstallBlock
    }
) & { source?: UpdateSource }

export type ReleaseBuildListResult =
  | { ok: true; channel: ReleaseChannel; builds: ReleaseBuild[] }
  | { ok: false; channel: ReleaseChannel; message: string }
