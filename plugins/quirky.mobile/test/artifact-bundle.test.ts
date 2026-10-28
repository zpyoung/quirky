import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getMobileBundleChunk, getMobileBundleManifest } from '../src/daemon/bundle'

test('artifact pages load exact packaged bytes without acquiring terminal driving or arbitrary route grants', () => {
  const root = mkdtempSync(join(tmpdir(), 'quirky-artifact-bundle-'))
  const directory = join(root, 'assets', 'mobile')
  mkdirSync(directory, { recursive: true })
  const html = Buffer.from('<!doctype html><title>Terminal artifact</title>')
  const routes = [
    { kind: 'workspaces', path: '/', grants: ['rpc', 'storage', 'navigate', 'terminal', 'externalLink'] },
    { kind: 'session', path: '/session', grants: ['rpc', 'storage', 'navigate', 'terminal', 'clipboard.read', 'clipboard.write', 'externalLink'] },
    { kind: 'terminal-artifacts', path: '/terminal-artifacts', grants: ['rpc', 'storage', 'navigate'] },
    { kind: 'terminal-artifact', path: '/terminal-artifact', grants: ['rpc', 'storage', 'navigate'] },
  ]
  const manifest = {
    v: 1, shellVersion: 1, buildId: 'a'.repeat(64),
    assets: [{ path: 'index.html', bytes: html.length, sha256: createHash('sha256').update(html).digest('hex'), contentType: 'text/html' }],
    totalBytes: html.length, routes,
  }
  const manifestPath = join(directory, 'manifest.json')
  try {
    writeFileSync(join(directory, 'index.html'), html)
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const published = getMobileBundleManifest(root)
    const chunk = getMobileBundleChunk(root, { buildId: published.manifest.buildId, path: 'index.html', offset: 0 })
    expect(Buffer.from(chunk.data, 'base64')).toEqual(html)
    expect(chunk.eof).toBe(true)
    expect(chunk.sha256).toBe(createHash('sha256').update(html).digest('hex'))

    const preview = routes.find(route => route.kind === 'terminal-artifact')!
    preview.grants.push('terminal')
    writeFileSync(manifestPath, JSON.stringify(manifest))
    expect(() => getMobileBundleManifest(root)).toThrow('grants are unsupported')
    preview.grants.pop()
    preview.path = '/files/preview'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    expect(() => getMobileBundleManifest(root)).toThrow('path is invalid')
    preview.path = '/terminal-artifact'
    preview.kind = 'arbitrary-file-access'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    expect(() => getMobileBundleManifest(root)).toThrow('route is invalid')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
