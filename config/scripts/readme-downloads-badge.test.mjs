import { describe, expect, it } from 'vitest'
import { countReleaseDownloads } from '../../.github/scripts/render-readme-downloads-badge.mjs'

const asset = (downloads) => ({ download_count: downloads })

describe('README downloads badge', () => {
  it('counts published app releases and skips drafts', () => {
    expect(
      countReleaseDownloads([
        { tag_name: 'v1.4.1', draft: false, assets: [asset(10), asset(5)] },
        { tag_name: 'v1.4.2-rc.0', draft: false, assets: [asset(3)] },
        { tag_name: 'mobile-v0.0.1', draft: false, assets: [asset(2)] },
        { tag_name: 'v1.4.3', draft: true, assets: [asset(100)] }
      ])
    ).toBe(20)
  })
})
