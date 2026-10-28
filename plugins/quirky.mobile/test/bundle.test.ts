import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginContext, PluginCaller } from '@quirky/protocol'
import { MobileService, registerMobileMethods } from '../src/daemon/service'

let work: string | undefined

afterEach(async () => {
  if (work) rmSync(work, { recursive: true, force: true })
  work = undefined
})

function makePlugin(): { dir: string; html: Buffer } {
  work = mkdtempSync(join(tmpdir(), 'quirky-mobile-bundle-'))
  const dir = join(work, 'plugin')
  const bundleDir = join(dir, 'assets', 'mobile')
  mkdirSync(bundleDir, { recursive: true })
  const html = Buffer.from('<!doctype html><title>Quirky phone bundle</title>')
  const asset = { path: 'index.html', bytes: html.byteLength, sha256: createHash('sha256').update(html).digest('hex'), contentType: 'text/html; charset=utf-8' }
  const manifest = {
    v: 1,
    shellVersion: 1,
    buildId: 'a'.repeat(64),
    assets: [asset],
    totalBytes: html.byteLength,
    routes: [
      { kind: 'workspaces', path: '/', grants: ['rpc', 'storage', 'navigate', 'terminal', 'externalLink'] },
      { kind: 'session', path: '/session', grants: ['rpc', 'storage', 'navigate', 'terminal', 'clipboard.read', 'clipboard.write', 'externalLink'] }
    ]
  }
  writeFileSync(join(bundleDir, 'index.html'), html)
  writeFileSync(join(bundleDir, 'manifest.json'), JSON.stringify(manifest))
  return { dir, html }
}

function serviceHarness(pluginDir: string) {
  const handlers = new Map<string, (params: Record<string, unknown>, caller: PluginCaller) => unknown>()
  const context = {
    pluginId: 'quirky.mobile',
    dir: pluginDir,
    dataDir: join(work!, 'fresh-home', 'plugin-data', 'quirky.mobile'),
    home: join(work!, 'fresh-home'),
    workerEntrypoint: () => { throw new Error('unused') },
    log: () => {},
    provide: (id: string, implementation: unknown) => handlers.set(id, implementation as (params: Record<string, unknown>, caller: PluginCaller) => unknown),
    emit: () => true,
    subscribe: () => () => {},
    call: async () => undefined,
    createFileResource: async () => { throw new Error('unused') },
    openStore: () => { throw new Error('unused') },
    getSetting: () => undefined,
    storedSettingValue: () => undefined,
    error: (kind: string, message: string) => Object.assign(new Error(message), { kind }),
    pty: {},
    notify: () => {},
    launch: {},
    clients: { accept: () => { throw new Error('unused') } }
  } as unknown as PluginContext
  const service = new MobileService(context, { hostValue: '127.0.0.1', portValue: '0' })
  registerMobileMethods(context, service)
  const call = async (method: string, params: Record<string, unknown> = {}, caller: PluginCaller = { role: 'mobile', deviceId: 'device-1', name: 'Phone' }) => {
    const handler = handlers.get(`method:quirky.mobile/${method}`)
    if (!handler) throw new Error(`missing mobile API method ${method}`)
    return await handler(params, caller)
  }
  return { call, service }
}

describe('authenticated mobile page bundle API', () => {
  test('serves the packaged manifest and bounded chunks through registered plugin methods', async () => {
    const { dir, html } = makePlugin()
    const harness = serviceHarness(dir)
    try {
      const result = await harness.call('bundleManifest') as { manifest: { buildId: string }; chunkBytes: number; rangeBytes: number }
      expect(result.manifest.buildId).toBe('a'.repeat(64))
      expect(result.chunkBytes).toBeGreaterThan(0)
      expect(result.rangeBytes).toBeGreaterThan(0)

      const chunk = await harness.call('bundleChunk', { buildId: result.manifest.buildId, path: 'index.html', offset: 0 }) as { data: string; eof: boolean; sha256: string }
      expect(Buffer.compare(Buffer.from(chunk.data, 'base64'), html)).toBe(0)
      expect(chunk.eof).toBe(true)
      expect(chunk.sha256).toBe(createHash('sha256').update(html).digest('hex'))
    } finally {
      await harness.service.stop()
    }
  })

  test('rejects traversal, changed builds, invalid offsets, and bytes that no longer match the manifest', async () => {
    const { dir } = makePlugin()
    const harness = serviceHarness(dir)
    try {
      await expect(harness.call('bundleChunk', { buildId: 'b'.repeat(64), path: 'index.html', offset: 0 })).rejects.toMatchObject({ kind: 'conflict' })
      await expect(harness.call('bundleChunk', { buildId: 'a'.repeat(64), path: '../index.html', offset: 0 })).rejects.toMatchObject({ kind: 'invalid-params' })
      await expect(harness.call('bundleChunk', { buildId: 'a'.repeat(64), path: 'safe-but-unlisted.html', offset: 0 })).rejects.toMatchObject({ kind: 'not-found' })
      await expect(harness.call('bundleChunk', { buildId: 'a'.repeat(64), path: `index.html${String.fromCharCode(10)}`, offset: 0 })).rejects.toMatchObject({ kind: 'invalid-params' })
      await expect(harness.call('bundleChunk', { buildId: 'a'.repeat(64), path: 'index.html', offset: -1 })).rejects.toMatchObject({ kind: 'invalid-params' })
      await expect(harness.call('bundleRange', { buildId: 'a'.repeat(64), path: 'index.html', offset: 1.5 })).rejects.toMatchObject({ kind: 'invalid-params' })
      writeFileSync(join(dir, 'assets', 'mobile', 'index.html'), 'changed after manifest')
      await expect(harness.call('bundleChunk', { buildId: 'a'.repeat(64), path: 'index.html', offset: 0 })).rejects.toMatchObject({ kind: 'conflict' })
    } finally {
      await harness.service.stop()
    }
  })

  test('range requests optionally gzip the returned bytes without changing the full asset hash', async () => {
    const { dir, html } = makePlugin()
    const harness = serviceHarness(dir)
    try {
      const result = await harness.call('bundleRange', { buildId: 'a'.repeat(64), path: 'index.html', offset: 0, gzip: true }) as { data: string; encoding: string; sha256: string; eof: boolean }
      expect(result.encoding).toBe('gzip')
      expect(Buffer.compare(gunzipSync(Buffer.from(result.data, 'base64')), html)).toBe(0)
      expect(result.sha256).toBe(createHash('sha256').update(html).digest('hex'))
      expect(result.eof).toBe(true)
    } finally {
      await harness.service.stop()
    }
  })

  test('the phone preferences API exposes only auto-restore and keeps configure local-only', async () => {
    const { dir } = makePlugin()
    const harness = serviceHarness(dir)
    try {
      expect(await harness.call('preferences')).toEqual({ autoRestoreFitMs: null })
      expect(await harness.call('updatePreferences', { autoRestoreFitMs: 300_000 })).toEqual({ autoRestoreFitMs: 300_000 })
      expect(await harness.call('preferences')).toEqual({ autoRestoreFitMs: 300_000 })
      await expect(harness.call('updatePreferences', { autoRestoreFitMs: 300_000, machineName: 'not-phone-owned' })).rejects.toThrow()
      await expect(harness.call('configure', { machineName: 'phone-admin' })).rejects.toThrow()
    } finally {
      await harness.service.stop()
    }
  })

})
