import { describe, expect, it } from 'vitest'
import {
  getReleaseNotesUrlForVersion,
  getUpdateManifestNamesForPlatform,
  getVersionChannel,
  hasInstallableArtifactForPlatform,
  isReleaseChannel,
  sortReleaseBuildsNewestFirst,
  type ReleaseBuild
} from './release-channel'
import { compareAppVersions } from './app-version'

describe('release channel', () => {
  it('classifies versions by channel', () => {
    expect(getVersionChannel('1.4.160')).toBe('stable')
    expect(getVersionChannel('v1.4.160')).toBe('stable')
    expect(getVersionChannel('1.4.160-rc.3')).toBe('rc')
    expect(getVersionChannel('not-a-version')).toBeNull()
  })

  it('builds release-notes links against the main release repo', () => {
    expect(getReleaseNotesUrlForVersion('1.4.160')).toBe(
      'https://github.com/zpyoung/quirky/releases/tag/v1.4.160'
    )
    expect(getReleaseNotesUrlForVersion('v1.4.160-rc.3')).toBe(
      'https://github.com/zpyoung/quirky/releases/tag/v1.4.160-rc.3'
    )
    expect(getReleaseNotesUrlForVersion(null)).toBe('https://github.com/zpyoung/quirky/releases')
  })

  it('detects an installable artifact from the platform update manifest', () => {
    expect(hasInstallableArtifactForPlatform('win32', ['latest.yml'])).toBe(true)
    expect(hasInstallableArtifactForPlatform('win32', ['latest-mac.yml'])).toBe(false)
    expect(hasInstallableArtifactForPlatform('darwin', ['latest-mac.yml'])).toBe(true)
    expect(hasInstallableArtifactForPlatform('darwin', ['latest.yml'])).toBe(false)
    expect(hasInstallableArtifactForPlatform('linux', ['latest-linux-arm64.yml'])).toBe(true)
    expect(hasInstallableArtifactForPlatform('linux', [])).toBe(false)
    // An unknown platform must not hide every build; a download-time error is a
    // better failure than an empty picker with no explanation.
    expect(hasInstallableArtifactForPlatform('freebsd', [])).toBe(true)
  })

  it('lists the update manifests each platform can install from', () => {
    expect(getUpdateManifestNamesForPlatform('darwin')).toEqual(['latest-mac.yml'])
    expect(getUpdateManifestNamesForPlatform('win32')).toEqual(['latest.yml'])
    expect(getUpdateManifestNamesForPlatform('linux')).toEqual([
      'latest-linux.yml',
      'latest-linux-arm64.yml'
    ])
    expect(getUpdateManifestNamesForPlatform('freebsd')).toEqual([])
  })

  it('accepts only known channels', () => {
    expect(isReleaseChannel('stable')).toBe(true)
    expect(isReleaseChannel('rc')).toBe(true)
    expect(isReleaseChannel('hourly')).toBe(false)
    expect(isReleaseChannel('nightly')).toBe(false)
    expect(isReleaseChannel(null)).toBe(false)
    expect(isReleaseChannel(undefined)).toBe(false)
  })

  it('sorts builds newest first by semver', () => {
    const build = (version: string): ReleaseBuild => ({
      tag: `v${version}`,
      version,
      channel: getVersionChannel(version) ?? 'stable',
      name: null,
      publishedAt: null,
      releaseUrl: `https://github.com/zpyoung/quirky/releases/tag/v${version}`
    })
    const sorted = sortReleaseBuildsNewestFirst([
      build('1.4.160-rc.1'),
      build('1.4.160'),
      build('1.4.161-rc.1'),
      build('1.4.160-rc.2')
    ])
    expect(sorted.map((entry) => entry.version)).toEqual([
      '1.4.161-rc.1',
      '1.4.160',
      '1.4.160-rc.2',
      '1.4.160-rc.1'
    ])
  })

  it('orders an rc below its own stable release', () => {
    expect(compareAppVersions('1.4.160-rc.3', '1.4.160')).toBeLessThan(0)
  })
})
