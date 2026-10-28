import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { MobileBundleAsset, MobileBundleManifest, MobilePageInit, MobileRoute } from '../src/contracts'
import { buildMobilePages } from '../scripts/build-pages'
import { PAGE_BUNDLE_ROUTES, validateBundleManifest } from '../src/shell/generation'
import { resolveBundleRoute, resolvePageRequestPath } from '../src/shell/shell-security'
import { validatePageInit, validatePageReport, validatePageRpc, validateRoute } from '../src/shell/bridge-policy'
import { validatePanelRoute } from '../src/panels/routes'

const assetBytes = new TextEncoder().encode('<!doctype html><main>verified page</main>')
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function buildIdFor(assets: readonly MobileBundleAsset[]): string {
  const canonical = `v=1\nshellVersion=1\n${[...assets]
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .map((asset) => `${asset.path}\0${asset.bytes}\0${asset.sha256}\0${asset.contentType}\n`)
    .join('')}`
  return sha256(new TextEncoder().encode(canonical))
}

function bundleManifest(): MobileBundleManifest {
  const assets: MobileBundleAsset[] = [{ path: 'index.html', bytes: assetBytes.byteLength, sha256: sha256(assetBytes), contentType: 'text/html; charset=utf-8' }]
  return {
    v: 1,
    shellVersion: 1,
    buildId: buildIdFor(assets),
    assets,
    totalBytes: assetBytes.byteLength,
    routes: PAGE_BUNDLE_ROUTES.map((route) => ({ ...route, grants: [...route.grants] }))
  }
}

function pageInit(route: MobileRoute): MobilePageInit {
  const routeDefinition = PAGE_BUNDLE_ROUTES.find((candidate) => candidate.kind === route.kind)
  if (!routeDefinition) throw new Error(`Missing test route ${route.kind}`)
  return {
    v: 1,
    sessionId: 'mount-panel',
    host: {
      id: 'host-1',
      name: 'Desktop',
      endpoint: 'wss://desktop.example/rpc',
      publicKeyB64: 'public-key',
      lastConnected: null,
      lastWorktree: 'worktree-1'
    },
    route,
    grants: [...routeDefinition.grants],
    preferences: {
      sessionView: 'terminal',
      onboardingCompleted: true,
      notificationChoice: 'disabled',
      terminalTextScale: 1,
      autocomplete: false,
      terminalLinkMode: 'phone',
      shortcuts: []
    },
    connectionState: { phase: 'connected', attempts: 0 },
    safeArea: { top: 0, right: 0, bottom: 0, left: 0 }
  }
}

test('the production page builder emits every approved route with verified assets', async () => {
  const repositoryRoot = join(import.meta.dir, '..', '..', '..')
  const temporaryRoot = await mkdtemp(join(repositoryRoot, 'apps', 'mobile', '.panel-shell-test-'))
  const outputDirectory = join(temporaryRoot, 'assets', 'mobile')
  try {
    const built = await buildMobilePages(repositoryRoot, outputDirectory)
    expect(validateBundleManifest(built)).toEqual(built)
    for (const expected of PAGE_BUNDLE_ROUTES) {
      expect(built.routes.find((route) => route.kind === expected.kind)).toEqual(expected)
    }
    for (const asset of built.assets) {
      const bytes = new Uint8Array(await readFile(join(outputDirectory, asset.path)))
      expect(bytes.byteLength).toBe(asset.bytes)
      expect(sha256(bytes)).toBe(asset.sha256)
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('bundle and route gates reject undeclared routes and extra route fields', () => {
  const manifest = bundleManifest()
  expect(validateBundleManifest(manifest)).toEqual(manifest)
  expect(resolveBundleRoute(manifest, { kind: 'source-control', worktreeId: 'worktree-1', tab: 'changes' }).kind).toBe('source-control')
  expect(() => resolveBundleRoute(manifest, { kind: 'source-control', worktreeId: 'worktree-1', tab: 'admin' } as never)).toThrow()
  expect(() => resolveBundleRoute(manifest, { kind: 'files', worktreeId: 'worktree-1', path: 'src/main.ts', caller: 'phone' } as never)).toThrow()
  expect(() => resolveBundleRoute(manifest, { kind: 'unlisted-panel' } as never)).toThrow()
  expect(() => validateRoute({ kind: 'accounts', worktreeId: 'worktree-1' } as never)).toThrow()
  expect(() => validatePanelRoute({ kind: 'file-preview', worktreeId: 'worktree-1', path: '../outside.txt' })).toThrow()

  const omittedRoute = { ...manifest, routes: manifest.routes.slice(1) }
  expect(() => validateBundleManifest(omittedRoute)).toThrow(/route/i)
  const undeclaredRoute = { ...manifest, routes: manifest.routes.map((route, index) => index === 2 ? { ...route, kind: 'admin' } : route) }
  expect(() => validateBundleManifest(undeclaredRoute)).toThrow(/route/i)
})

test('page init requires the exact route grants and panel reports contain only fresh route metadata', () => {
  const init = pageInit({ kind: 'files', worktreeId: 'worktree-1', path: 'src/main.ts' })
  expect(() => validatePageInit(init)).not.toThrow()
  expect(() => validatePageInit({ ...init, grants: [] })).toThrow(/grant/i)
  expect(() => validatePageInit({ ...init, grants: [...init.grants, 'haptics'] })).toThrow(/grant/i)

  const report = {
    route: 'files',
    worktreeId: 'worktree-1',
    path: 'src/main.ts',
    connectionPhase: 'connected',
    stale: false
  }
  expect(() => validatePageReport(report)).not.toThrow()
  expect(() => validatePageReport({ ...report, terminalVisible: true, notesBody: 'not layout metadata' })).toThrow(/report/i)
  expect(() => validatePageReport({ ...report, path: '../outside.txt' })).toThrow(/report|path/i)
  expect(() => validatePageReport({ route: 'source-control', worktreeId: 'worktree-1', tab: 'admin', connectionPhase: 'connected', stale: false })).toThrow(/report|tab/i)
})

test('page RPCs use the public method parameter ceiling without granting unknown methods or identity fields', () => {
  const panelRoute = { kind: 'source-control', worktreeId: 'worktree-1' } as const
  const panelGrants = pageInit(panelRoute).grants
  expect(() => validatePageRpc('quirky.git/stage', { worktree: 'worktree-1', paths: ['src/main.ts'], scope: 'staged' }, panelGrants, panelRoute)).not.toThrow()
  expect(() => validatePageRpc('quirky.git/stage', { worktree: 'worktree-1', paths: ['src/main.ts'], scope: 'staged', unexpected: true }, panelGrants, panelRoute)).toThrow(/parameter/i)
  expect(() => validatePageRpc('quirky.git/stage', { worktree: 'worktree-1', paths: ['src/main.ts'], scope: 'staged', caller: 'phone' }, panelGrants, panelRoute)).toThrow(/parameter/i)
  expect(() => validatePageRpc('quirky.git/stage', { worktree: 'worktree-1', paths: ['src/main.ts'], scope: 'staged' }, pageInit({ kind: 'workspaces' }).grants, { kind: 'workspaces' })).toThrow(/base/i)
  expect(() => validatePageRpc('quirky.agents/list', {}, panelGrants, panelRoute)).toThrow(/unavailable/i)
  expect(() => validatePageRpc('quirky.vault/prepareResume', { id: 'entry-1' }, panelGrants, panelRoute)).toThrow(/unavailable/i)
  expect(() => validatePageRpc('quirky.editor/read', { bufferId: 'buffer-1', action: 'bytes', offset: 0, length: 384 * 1024 }, panelGrants, panelRoute)).not.toThrow()
  expect(() => validatePageRpc('quirky.editor/read', { bufferId: 'buffer-1', action: 'bytes', offset: 0, length: 384 * 1024 + 1 }, panelGrants, panelRoute)).toThrow(/parameter/i)
  expect(() => validatePageRpc('quirky.editor/transfer', { action: 'chunk', transferId: 'transfer-1', offset: 0, data: 'AAAA'.repeat(16_384) }, panelGrants, panelRoute)).not.toThrow()
  expect(() => validatePageRpc('quirky.mobile/notificationPoll', { subscriptionId: 'poll-1', waitMs: 20_000, after: 1, epoch: 'epoch-1', onlyWhenDesktopAway: false }, panelGrants, panelRoute)).not.toThrow()
})

test('manifest and isolated-origin gates reject unsafe asset paths', () => {
  const manifest = bundleManifest()
  const unsafeAsset = { ...manifest.assets[0]!, path: '../index.html' }
  expect(() => validateBundleManifest({ ...manifest, assets: [unsafeAsset] })).toThrow(/path/i)

  const origin = 'quirky-mobile-web://mount-panel'
  const allowedPaths = new Set(['index.html', 'page.js'])
  expect(resolvePageRequestPath(`${origin}/page.js`, origin, 'GET', allowedPaths)).toBe('page.js')
  for (const path of ['/../outside.js', '/%2e%2e/outside.js', '/page.js?token=secret', '/page.js#fragment']) {
    expect(resolvePageRequestPath(`${origin}${path}`, origin, 'GET', allowedPaths)).toBeNull()
  }
})
