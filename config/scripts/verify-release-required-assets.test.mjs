import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  extractManifestAssetNames,
  getRequiredReleaseAssetNames,
  verifyRequiredReleaseAssets
} from './verify-release-required-assets.mjs'

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn(async () => body),
    text: vi.fn(async () => (typeof body === 'string' ? body : JSON.stringify(body)))
  }
}

function releaseWithAssets(tag, assetNames) {
  return {
    tag_name: tag,
    draft: true,
    prerelease: false,
    assets: assetNames.map((name, index) => ({
      id: index + 1,
      name,
      state: 'uploaded',
      size: 123
    }))
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getRequiredReleaseAssetNames', () => {
  it('requires the mac manifest and the arm64 dmg installer', () => {
    expect(getRequiredReleaseAssetNames('v1.4.27')).toEqual(
      expect.arrayContaining([
        'latest-mac.yml',
        'orca-macos-arm64.dmg',
        'orca-macos-arm64.dmg.blockmap'
      ])
    )
  })

  // Fork: arm64-only, so an x64 asset must not be required — each arch costs a
  // separate ~40min notarization and no fork machine runs Intel.
  it('does not require x64 assets', () => {
    expect(getRequiredReleaseAssetNames('v1.4.27').filter((name) => name.includes('x64'))).toEqual(
      []
    )
  })

  // Fork: mac-only. The .zip assets are validated dynamically from latest-mac.yml,
  // and no Windows/Linux assets are required.
  it('does not hardcode Windows or Linux assets', () => {
    const nonMac = getRequiredReleaseAssetNames('v1.4.27').filter(
      (name) =>
        name.includes('linux') ||
        name.endsWith('.exe') ||
        name.endsWith('.AppImage') ||
        name.endsWith('.deb') ||
        name.endsWith('.rpm')
    )
    expect(nonMac).toEqual([])
  })
})

describe('extractManifestAssetNames', () => {
  it('extracts relative and absolute manifest asset names', () => {
    const manifest = `files:
  - url: Orca-1.4.27-arm64-mac.zip
  - url: https://example.com/downloads/orca-windows-setup.exe
path: orca-linux.AppImage`
    expect(extractManifestAssetNames(manifest)).toEqual([
      'Orca-1.4.27-arm64-mac.zip',
      'orca-windows-setup.exe',
      'orca-linux.AppImage'
    ])
  })
})

describe('verifyRequiredReleaseAssets', () => {
  it('fails when a manifest-referenced asset has not been uploaded', async () => {
    const tag = 'v1.4.27'
    // The mac .zip is referenced by latest-mac.yml but never uploaded, so
    // verification must add it from the manifest and then report it missing.
    const release = releaseWithAssets(tag, getRequiredReleaseAssetNames(tag))
    const latestMacAsset = release.assets.find((asset) => asset.name === 'latest-mac.yml')
    const macManifest = `version: 1.4.27
files:
  - url: Orca-1.4.27-arm64-mac.zip
    sha512: test
path: Orca-1.4.27-arm64-mac.zip`
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([release]))
      .mockResolvedValueOnce(jsonResponse(macManifest))
      .mockResolvedValue(jsonResponse('version: 1.4.27'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      verifyRequiredReleaseAssets({ repo: 'zpyoung/quirky', tag, token: 'token' })
    ).rejects.toThrow('Missing: Orca-1.4.27-arm64-mac.zip')
    expect(latestMacAsset).toBeTruthy()
  })
})
