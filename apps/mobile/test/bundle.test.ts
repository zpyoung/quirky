import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MobileBundleAsset, MobileBundleManifest, MobileBundleManifestResult, MobileBundleReadResult } from '../src/contracts'
import { buildMobilePages } from '../scripts/build-pages'
import { downloadBundle, evictLeastRecentlyUsedHosts, validateBundleManifest } from '../src/shell/generation'
import type { GenerationStore, StoredGeneration } from '../src/shell/generation'
import { bundleRoutesFixture } from './bundle-fixture'

const bytes = new TextEncoder().encode('<html>phone</html>')
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
function buildIdFor(assets: readonly MobileBundleAsset[]): string {
  const newline = String.fromCharCode(10)
  const separator = String.fromCharCode(0)
  const canonical = `v=1${newline}shellVersion=1${newline}${[...assets]
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .map((asset) => `${asset.path}${separator}${asset.bytes}${separator}${asset.sha256}${separator}${asset.contentType}${newline}`)
    .join('')}`
  return digest(new TextEncoder().encode(canonical))
}

const manifest = (assetBytes: Uint8Array = bytes, assetHash = digest(assetBytes)): MobileBundleManifest => {
  const assets: MobileBundleAsset[] = [{ path: 'index.html', bytes: assetBytes.byteLength, sha256: assetHash, contentType: 'text/html; charset=utf-8' }]
  return {
    v: 1,
    shellVersion: 1,
    buildId: buildIdFor(assets),
    assets,
    totalBytes: assetBytes.byteLength,
    routes: bundleRoutesFixture()
  }
}
const manifestResult = (value = manifest()): MobileBundleManifestResult => ({ manifest: value, chunkBytes: 8, rangeBytes: 4 })

function memoryStore(active: StoredGeneration | null = null): GenerationStore & { activeValue: StoredGeneration | null; stages: Uint8Array[][]; discarded: number; activated: number } {
  const store = {
    activeValue: active,
    stages: [] as Uint8Array[][],
    discarded: 0,
    activated: 0,
    async getActive() { return this.activeValue },
    async begin() {
      const written: Uint8Array[] = []
      this.stages.push(written)
      let finished = false
      return {
        directory: 'memory-generation',
        async writeAsset(_path: string, value: Uint8Array) { written.push(value) },
        async activate(value: MobileBundleManifest) {
          store.activated++
          finished = true
          const installed = { manifest: value, directory: 'memory-generation', activatedAt: 10 }
          store.activeValue = installed
          return installed
        },
        async discard() { if (!finished) store.discarded++ }
      }
    },
    async touch() {},
    async pruneHosts() {}
  }
  return store
}

function chunkFetcher(assetBytes: Uint8Array, assetHash = digest(assetBytes)) {
  return async (buildId: string, path: string, offset: number): Promise<MobileBundleReadResult> => {
    const data = assetBytes.slice(offset, Math.min(offset + 8, assetBytes.byteLength))
    return {
      buildId,
      path,
      offset,
      data: Buffer.from(data).toString('base64'),
      encoding: 'identity',
      eof: offset + data.byteLength === assetBytes.byteLength,
      sha256: assetHash
    }
  }
}

const sha256 = async (value: Uint8Array) => new Uint8Array(createHash('sha256').update(value).digest())

describe('verified mobile page generations', () => {
  test('downloads contiguous bounded chunks, verifies hashes, then activates the complete generation', async () => {
    const store = memoryStore()
    const offsets: number[] = []
    const installed = await downloadBundle('host-1', manifestResult(), async (buildId, path, offset) => {
      offsets.push(offset)
      return chunkFetcher(bytes)(buildId, path, offset)
    }, store, sha256)

    expect(offsets).toEqual([0, 8, 16])
    expect(store.stages[0]?.[0]).toEqual(bytes)
    expect(installed.manifest.buildId).toBe(manifest().buildId)
    expect(store.activeValue).toBe(installed)
  })
  test('rejects a build ID that does not match the canonical manifest before staging', async () => {
    const store = memoryStore()
    const mismatched = { ...manifest(), buildId: 'f'.repeat(64) }
    await expect(downloadBundle('host-1', manifestResult(mismatched), chunkFetcher(bytes), store, sha256)).rejects.toThrow(/build ID/i)
    expect(store.stages).toHaveLength(0)
  })

  test('a failed update never activates partial or hash-mismatched bytes and leaves the previous generation usable', async () => {
    const prior = {
      manifest: manifest(new TextEncoder().encode('<html>previous generation</html>')),
      directory: 'old-good-generation',
      activatedAt: 1
    }
    const store = memoryStore(prior)
    const changed = Uint8Array.from(bytes)
    changed[0] = changed[0]! ^ 1
    await expect(downloadBundle('host-1', manifestResult(), chunkFetcher(changed, digest(bytes)), store, sha256)).rejects.toThrow()
    expect(store.activeValue).toBe(prior)
    expect(store.activated).toBe(0)
    expect(store.discarded).toBe(1)
  })

  test('rejects unsupported shell versions, unsafe asset paths, duplicate paths and oversized manifests', () => {
    const safe = manifest()
    expect(validateBundleManifest(safe)).toEqual(safe)
    expect(() => validateBundleManifest({ ...safe, shellVersion: 2 })).toThrow(/shell/i)
    expect(() => validateBundleManifest({ ...safe, assets: [{ ...safe.assets[0]!, path: '../secret' }] })).toThrow(/path/i)
    expect(() => validateBundleManifest({ ...safe, assets: [{ ...safe.assets[0]!, path: `index.html${String.fromCharCode(10)}` }] })).toThrow(/path/i)
    expect(() => validateBundleManifest({ ...safe, assets: [safe.assets[0], safe.assets[0]] })).toThrow(/duplicate/i)
    expect(() => validateBundleManifest({ ...safe, totalBytes: 33 * 1024 * 1024 })).toThrow(/limit|size/i)
  })

  test('manifest pins artifact route paths and capabilities to their exact metadata', () => {
    const safe = manifest()
    expect(validateBundleManifest(safe)).toEqual(safe)

    for (const kind of ['terminal-artifacts', 'terminal-artifact'] as const) {
      const underGranted = {
        ...safe,
        routes: safe.routes.map((route) => route.kind === kind ? { ...route, grants: route.grants.slice(1) } : route)
      }
      const overGranted = {
        ...safe,
        routes: safe.routes.map((route) => route.kind === kind ? { ...route, grants: [...route.grants, 'terminal'] } : route)
      }
      const wrongPath = {
        ...safe,
        routes: safe.routes.map((route) => route.kind === kind ? { ...route, path: `${route.path}/unexpected` } : route)
      }

      expect(() => validateBundleManifest(underGranted)).toThrow(/grants/i)
      expect(() => validateBundleManifest(overGranted)).toThrow(/grants/i)
      expect(() => validateBundleManifest(wrongPath)).toThrow(/path/i)
    }
  })

  test('evicts only least-recently-used hosts beyond the six-host bound', () => {
    const hosts = Array.from({ length: 7 }, (_, index) => ({ hostId: `host-${index}`, lastUsedAt: index + 1 }))
    expect(evictLeastRecentlyUsedHosts(hosts, 6, 'host-6')).toEqual(['host-0'])
    expect(evictLeastRecentlyUsedHosts(hosts, 6, 'host-0')).toEqual(['host-1'])
  })
})

test('the production page builder emits a manifest matching every packaged web asset', async () => {
  const repositoryRoot = join(import.meta.dir, '..', '..', '..')
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'quirky-mobile-pages-'))
  const outputDirectory = join(temporaryRoot, 'assets', 'mobile')
  try {
    const built = await buildMobilePages(repositoryRoot, outputDirectory)
    expect(validateBundleManifest(built)).toEqual(built)
    expect(built.buildId).toBe(buildIdFor(built.assets))
    for (const asset of built.assets) {
      const content = new Uint8Array(await readFile(join(outputDirectory, asset.path)))
      expect(content.byteLength).toBe(asset.bytes)
      expect(digest(content)).toBe(asset.sha256)
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})
