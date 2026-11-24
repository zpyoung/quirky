import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getReleaseNotesUrlForVersion } from '../../shared/release-channel'

const fetchMock = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ net: { fetch: fetchMock } }))

import { listReleaseBuilds, resolveTargetBuild } from '../updater-release-builds'

const version = '1.4.201-rc.0.zy03'
const tag = `v${version}`
const releaseUrl = `https://github.com/zpyoung/quirky/releases/tag/${tag}`
const feedUrl = `https://github.com/zpyoung/quirky/releases/download/${tag}`

describe('fork release routing', () => {
  beforeEach(() => {
    fetchMock.mockReset()
  })

  it('opens fork release notes for fork-suffixed versions', () => {
    expect(getReleaseNotesUrlForVersion(version)).toBe(releaseUrl)
    expect(getReleaseNotesUrlForVersion(tag)).toBe(releaseUrl)
  })

  it('lists fork RC builds and pins their downloads to the fork', async () => {
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () =>
        url === 'https://api.github.com/repos/zpyoung/quirky/releases?per_page=100'
          ? [{ tag_name: tag, assets: [{ name: 'latest-mac.yml' }, { name: 'quirky.dmg' }] }]
          : []
    }))

    const builds = await listReleaseBuilds('rc', 'darwin')
    expect(
      builds.map((build) => ({ version: build.version, releaseUrl: build.releaseUrl }))
    ).toEqual([{ version, releaseUrl }])
    expect(resolveTargetBuild(tag)).toEqual({ tag, version, feedUrl })
  })
})
