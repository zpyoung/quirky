import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MobileBundleManifest } from '../src/contracts'
import { createGenerationStore, type BundleFileSystem } from '../src/shell/generation'
import { resolveBundleRoute, resolvePageRequestPath } from '../src/shell/shell-security'
import { bundleRoutesFixture } from './bundle-fixture'

const html = new TextEncoder().encode('<!doctype html><main>ready</main>')
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const manifestAsset = { path: 'index.html', bytes: html.byteLength, sha256: hash(html), contentType: 'text/html; charset=utf-8' }
function buildIdFor(assets: readonly { path: string; bytes: number; sha256: string; contentType: string }[]): string {
  const newline = String.fromCharCode(10)
  const separator = String.fromCharCode(0)
  const canonical = `v=1${newline}shellVersion=1${newline}${[...assets]
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .map((asset) => `${asset.path}${separator}${asset.bytes}${separator}${asset.sha256}${separator}${asset.contentType}${newline}`)
    .join('')}`
  return hash(new TextEncoder().encode(canonical))
}
const manifest: MobileBundleManifest = {
  v: 1,
  shellVersion: 1,
  buildId: buildIdFor([manifestAsset]),
  assets: [manifestAsset],
  totalBytes: html.byteLength,
  routes: bundleRoutesFixture()
}
let root: string | undefined

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function localFileSystem(): Promise<BundleFileSystem> {
  root = await mkdtemp(join(tmpdir(), 'quirky-generation-cache-'))
  return {
    async exists(path) { try { await stat(path); return true } catch { return false } },
    async createDirectory(path) { await mkdir(path, { recursive: true }) },
    async listDirectory(path) {
      try {
        const entries = await readdir(path, { withFileTypes: true })
        return await Promise.all(entries.map(async (entry) => ({ name: entry.name, isDirectory: entry.isDirectory(), modifiedAt: (await stat(join(path, entry.name))).mtimeMs })))
      } catch { return [] }
    },
    async readFile(path) { return new Uint8Array(await readFile(path)) },
    async writeFile(path, bytes) { await writeFile(path, bytes) },
    async movePath(from, to) { await rename(from, to) },
    async removePath(path) { await rm(path, { recursive: true, force: true }) }
  }
}

const sha256 = async (bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest())

describe('isolated page shell and generation storage', () => {
  test('route lookup rejects unsupported routes and bounds every identifier before mount', () => {
    expect(resolveBundleRoute(manifest, { kind: 'workspaces' }).path).toBe('/')
    expect(resolveBundleRoute(manifest, { kind: 'session', worktreeId: 'wt-1', sessionId: 's-1' }).path).toBe('/session')
    expect(() => resolveBundleRoute(manifest, { kind: 'session', worktreeId: 'x'.repeat(1025) })).toThrow(/route|length/i)
    expect(() => resolveBundleRoute(manifest, { kind: 'home' } as never)).toThrow(/route|available/i)
  })

  test('origin resolver serves only exact GET asset paths and refuses traversal, encoded URLs, and network requests', () => {
    const origin = 'quirky-mobile-web://mount_1'
    const allowed = new Set(['index.html', 'page.js', 'page.css'])
    expect(resolvePageRequestPath(`${origin}/`, origin, 'GET', allowed)).toBe('index.html')
    expect(resolvePageRequestPath(`${origin}/page.js`, origin, 'GET', allowed)).toBe('page.js')
    for (const url of [
      `${origin}/%2e%2e/secret`, `${origin}/../secret`, `${origin}/page.js?token=secret`,
      'https://example.com/page.js', `${origin}/page.js#fragment`
    ]) expect(resolvePageRequestPath(url, origin, 'GET', allowed)).toBeNull()
    expect(resolvePageRequestPath(`${origin}/page.js`, origin, 'POST', allowed)).toBeNull()
    expect(resolvePageRequestPath(`${origin}/page.js`, origin, 'GET', allowed, 'bytes=0-4')).toBeNull()
    expect(resolvePageRequestPath(`${origin}/unknown.js`, origin, 'GET', allowed)).toBeNull()
  })

  test('atomic generation activation exposes no partial files and keeps the prior verified generation on failure', async () => {
    const fs = await localFileSystem()
    const store = await createGenerationStore(fs, root!, sha256, () => 100)
    const first = await store.begin('host-1', manifest)
    await first.writeAsset('index.html', html)
    const active = await first.activate(manifest)
    expect(active.manifest.buildId).toBe(manifest.buildId)
    expect(await store.getActive('host-1')).toMatchObject({ manifest: { buildId: manifest.buildId }, directory: active.directory })

    const mismatchedManifest = { ...manifest, buildId: 'f'.repeat(64) }
    const mismatched = await store.begin('host-1', mismatchedManifest)
    await mismatched.writeAsset('index.html', html)
    await expect(mismatched.activate(mismatchedManifest)).rejects.toThrow(/build ID/i)
    await mismatched.discard()

    const wrongHashAsset = { ...manifest.assets[0]!, sha256: '0'.repeat(64) }
    const updateManifest = { ...manifest, buildId: buildIdFor([wrongHashAsset]), assets: [wrongHashAsset] }
    const update = await store.begin('host-1', updateManifest)
    await update.writeAsset('index.html', html)
    await expect(update.activate(updateManifest)).rejects.toThrow(/hash/i)
    await update.discard()
    expect(await store.getActive('host-1')).toMatchObject({ manifest: { buildId: manifest.buildId }, directory: active.directory })
  })

  test('reuses an unchanged verified generation and prunes stale cache records after activation', async () => {
    const fs = await localFileSystem()
    const store = await createGenerationStore(fs, root!, sha256, () => 200)
    const first = await store.begin('host-1', manifest)
    await first.writeAsset('index.html', html)
    await first.activate(manifest)
    const reused = await store.getActive('host-1')
    expect(reused?.manifest.buildId).toBe(manifest.buildId)

    const secondHtml = new TextEncoder().encode('<!doctype html><main>version two</main>')
    const secondAsset = { ...manifest.assets[0]!, bytes: secondHtml.byteLength, sha256: hash(secondHtml) }
    const second = { ...manifest, buildId: buildIdFor([secondAsset]), assets: [secondAsset], totalBytes: secondHtml.byteLength }
    const stage = await store.begin('host-2', second)
    await stage.writeAsset('index.html', secondHtml)
    await stage.activate(second)
    await store.touch('host-1', 1)
    await store.touch('host-2', 2)
    await store.pruneHosts('host-2', 1)
    expect(await store.getActive('host-1')).toBeNull()
    expect((await store.getActive('host-2'))?.manifest.buildId).toBe(second.buildId)
  })
})
