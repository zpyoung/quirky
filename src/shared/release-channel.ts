import { compareAppVersions, isValidAppVersion } from './app-version'

export type ReleaseChannel = 'stable' | 'rc'

export const RELEASE_CHANNELS: readonly ReleaseChannel[] = ['stable', 'rc']

export const RELEASE_CHANNEL_LABELS: Readonly<Record<ReleaseChannel, string>> = {
  stable: 'Stable',
  rc: 'RC'
}

export const MAIN_RELEASE_REPO = 'zpyoung/quirky'

export function isReleaseChannel(value: unknown): value is ReleaseChannel {
  return typeof value === 'string' && RELEASE_CHANNELS.includes(value as ReleaseChannel)
}

export function normalizeTagToVersion(tag: string): string {
  return tag.replace(/^v/i, '')
}

export function getVersionChannel(version: string): ReleaseChannel | null {
  const normalized = normalizeTagToVersion(version)
  if (!isValidAppVersion(normalized)) {
    return null
  }
  return normalized.includes('-') ? 'rc' : 'stable'
}

/**
 * Release-notes page for a version. A null version falls back to the plain
 * releases listing (not /releases/latest — /latest also breaks when GitHub's
 * API is degraded).
 */
export function getReleaseNotesUrlForVersion(version: string | null): string {
  return version
    ? `https://github.com/${MAIN_RELEASE_REPO}/releases/tag/v${normalizeTagToVersion(version)}`
    : `https://github.com/${MAIN_RELEASE_REPO}/releases`
}

/**
 * The electron-updater manifest each platform's updater fetches before it can
 * install anything. A release without one has nothing that platform can use,
 * which is how a build whose Windows leg failed — or one whose Windows leg is
 * still running — stays out of that platform's picker instead of becoming a row
 * that 404s on download.
 */
const PLATFORM_UPDATE_MANIFESTS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  darwin: ['latest-mac.yml'],
  win32: ['latest.yml'],
  // Both, because one release carries x64 and arm64 and either makes it installable.
  linux: ['latest-linux.yml', 'latest-linux-arm64.yml']
}

export function getUpdateManifestNamesForPlatform(platform: NodeJS.Platform): readonly string[] {
  return PLATFORM_UPDATE_MANIFESTS[platform] ?? []
}

/** True when the release carries an artifact this platform's updater can install. */
export function hasInstallableArtifactForPlatform(
  platform: NodeJS.Platform,
  assetNames: readonly string[]
): boolean {
  const manifests = getUpdateManifestNamesForPlatform(platform)
  // Why permissive on an unknown platform: a filter that hides every build is a
  // worse failure than one that offers a build the download step will report on.
  if (manifests.length === 0) {
    return true
  }
  return manifests.some((manifest) => assetNames.includes(manifest))
}

export type ReleaseBuild = {
  tag: string
  version: string
  channel: ReleaseChannel
  /** The release's GitHub title. Null when it is absent or just repeats the tag. */
  name: string | null
  publishedAt: string | null
  releaseUrl: string
}

/** Newest first, so the picker's first row is always the channel's current tip. */
export function sortReleaseBuildsNewestFirst(builds: ReleaseBuild[]): ReleaseBuild[] {
  return [...builds].sort((left, right) => compareAppVersions(right.version, left.version))
}
