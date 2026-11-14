import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, readlinkSync, rmSync, symlinkSync, writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import type { UiModel } from '@quirky/protocol'

import {
  prepareRuntimeAssets, runtimeAssetEnvironment, snapshotRuntimeAssets, verifyRuntimeAssets,
  type AssetSnapshot, type RuntimeAssets
} from './runtime-assets'

const SHELL_ASSETS = [
  'index.html', 'main.js', 'main.css', 'xterm.css', 'vendor/react.js',
  'vendor/react-dom.js', 'vendor/react-dom-client.js', 'vendor/jsx-runtime.js'
]
const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'runtime-assets-test-'))
  homes.push(root)
  return root
}

function put(path: string, contents: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function treeState(root: string): string[] {
  const state: string[] = []
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      const rel = relative(root, path)
      const info = lstatSync(path)
      if (info.isSymbolicLink()) state.push(`${rel}:link:${readlinkSync(path)}`)
      else if (info.isDirectory()) {
        state.push(`${rel}:dir:${info.ino}:${info.mtimeMs}`)
        visit(path)
      } else {
        const bytes = readFileSync(path)
        state.push(`${rel}:file:${info.ino}:${info.size}:${info.mtimeMs}:${digest(bytes)}`)
      }
    }
  }
  visit(root)
  return state
}


type FixtureOptions = { pluginId?: string }
function makeRepo(parent: string, options: FixtureOptions = {}) {
  const repoRoot = join(parent, 'checkout')
  const pluginId = options.pluginId ?? 'acme.fixture'
  const pluginRoot = join(repoRoot, 'plugins', pluginId)
  put(join(pluginRoot, 'quirky-plugin.json'), JSON.stringify({ id: pluginId, name: 'Fixture', version: '1.0.0', apiVersion: '1.0.0', main: 'main.ts', cli: 'cli.ts', ui: 'dist/ui.js' }))
  put(join(pluginRoot, 'main.ts'), 'export const main = true\n')
  put(join(pluginRoot, 'cli.ts'), 'export const cli = true\n')
  put(join(pluginRoot, 'src', 'entry.tsx'), 'export const entry = true\n')
  put(join(pluginRoot, 'src', 'helper.ts'), 'export const helper = true\n')
  put(join(pluginRoot, 'assets', 'icon.svg'), '<svg/>')
  put(join(pluginRoot, '.git', 'config'), 'must not be staged')
  put(join(pluginRoot, 'node_modules', 'plugin-dep', 'package.json'), JSON.stringify({ name: 'plugin-dep', main: 'index.js' }))
  put(join(pluginRoot, 'node_modules', 'plugin-dep', 'index.js'), 'module.exports = 1')
  put(join(repoRoot, 'node_modules', 'root-dep', 'package.json'), JSON.stringify({ name: 'root-dep', main: 'index.js' }))
  put(join(repoRoot, 'node_modules', 'root-dep', 'index.js'), 'module.exports = 2')
  put(join(pluginRoot, 'dist', 'ui.js'), 'checkout-ui-entry')
  put(join(pluginRoot, 'dist', 'chunks', 'split.js'), 'checkout-split')
  put(join(pluginRoot, 'dist', 'assets', 'font.woff2'), Buffer.from([1, 2, 3, 4]))
  put(join(pluginRoot, 'dist', 'pdf.worker.min.mjs'), 'checkout-worker')
  put(join(pluginRoot, 'dist', 'unreferenced.txt'), 'all built output is immutable')

  const headlessId = 'quirky.headless'
  const headlessRoot = join(repoRoot, 'plugins', headlessId)
  put(join(headlessRoot, 'quirky-plugin.json'), JSON.stringify({ id: headlessId, name: 'Headless', version: '1.0.0', apiVersion: '1.0.0', main: 'main.ts', cli: 'cli.ts' }))
  put(join(headlessRoot, 'main.ts'), 'export const headless = true\n')
  put(join(headlessRoot, 'cli.ts'), 'export const cli = true\n')

  const uiDir = join(repoRoot, 'packages', 'ui', 'dist')
  for (const asset of SHELL_ASSETS) put(join(uiDir, asset), asset === 'index.html'
    ? '<!doctype html><script type="importmap">{}</script><main>fixture</main></body>'
    : `checkout-${asset}`)
  return { repoRoot, uiDir, pluginRoot, pluginId, headlessRoot }
}


function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith('/'))
}


describe('runtime asset staging and snapshots', () => {
  test('stages independent copies under each home without inheriting output or changing checkout sources', async () => {
    const root = freshRoot()
    const fixture = makeRepo(root)
    const sourceBefore = treeState(fixture.repoRoot)
    const homeA = join(root, 'home-a')
    const homeB = join(root, 'home-b')
    mkdirSync(homeA)
    mkdirSync(homeB)

    const [a, b] = await Promise.all([
      prepareRuntimeAssets({ repoRoot: fixture.repoRoot, home: homeA, skipBuild: false }),
      prepareRuntimeAssets({ repoRoot: fixture.repoRoot, home: homeB, skipBuild: false })
    ])
    expect(a.ownedRoot).not.toBeNull()
    expect(b.ownedRoot).not.toBeNull()
    expect(isInside(realpathSync(homeA), realpathSync(a.ownedRoot!))).toBe(true)
    expect(isInside(realpathSync(homeB), realpathSync(b.ownedRoot!))).toBe(true)
    expect(a.uiDir).not.toBe(b.uiDir)
    expect(a.pluginsDir).not.toBe(b.pluginsDir)
    expect(realpathSync(a.uiDir)).not.toBe(realpathSync(fixture.uiDir))
    expect(realpathSync(a.pluginsDir)).not.toBe(realpathSync(join(fixture.repoRoot, 'plugins')))

    for (const assets of [a, b]) {
      const staged = join(assets.pluginsDir, fixture.pluginId)
      expect(readFileSync(join(staged, 'quirky-plugin.json'), 'utf8')).toContain('dist/ui.js')
      expect(readFileSync(join(staged, 'main.ts'), 'utf8')).toContain('main')
      expect(readFileSync(join(staged, 'cli.ts'), 'utf8')).toContain('cli')
      expect(readFileSync(join(staged, 'src', 'helper.ts'), 'utf8')).toContain('helper')
      expect(readFileSync(join(staged, 'assets', 'icon.svg'), 'utf8')).toBe('<svg/>')
      expect(existsSync(join(staged, '.git'))).toBe(false)
      expect(existsSync(join(staged, 'dist'))).toBe(false)
      expect(realpathSync(join(staged, 'node_modules'))).toBe(realpathSync(join(fixture.pluginRoot, 'node_modules')))
      expect(realpathSync(join(assets.ownedRoot!, 'node_modules'))).toBe(realpathSync(join(fixture.repoRoot, 'node_modules')))
      expect(existsSync(join(assets.pluginsDir, 'quirky.headless', 'main.ts'))).toBe(true)
      expect(existsSync(join(assets.pluginsDir, 'quirky.headless', 'dist'))).toBe(false)
      expect(existsSync(join(assets.uiDir, 'main.js'))).toBe(false)

      const require = createRequire(join(staged, 'quirky-plugin.json'))
      expect(realpathSync(require.resolve('plugin-dep'))).toBe(realpathSync(join(fixture.pluginRoot, 'node_modules', 'plugin-dep', 'index.js')))
      expect(realpathSync(require.resolve('root-dep'))).toBe(realpathSync(join(fixture.repoRoot, 'node_modules', 'root-dep', 'index.js')))
    }

    const base = { KEEP: 'unchanged', QUIRKY_UI_OUT: 'old-ui', QUIRKY_UI_DIR: 'old-ui-dir', QUIRKY_PLUGINS_DIR: 'old-plugins', QUIRKY_BUILTIN_PLUGINS_DIR: 'old-builtin' }
    const envA = runtimeAssetEnvironment(base, a)
    const envB = runtimeAssetEnvironment(base, b)
    expect(base.QUIRKY_UI_OUT).toBe('old-ui')
    expect(envA).toMatchObject({ KEEP: 'unchanged', QUIRKY_UI_OUT: a.uiDir, QUIRKY_UI_DIR: a.uiDir, QUIRKY_PLUGINS_DIR: a.pluginsDir, QUIRKY_BUILTIN_PLUGINS_DIR: a.pluginsDir })
    expect(envB).toMatchObject({ QUIRKY_UI_OUT: b.uiDir, QUIRKY_UI_DIR: b.uiDir, QUIRKY_PLUGINS_DIR: b.pluginsDir, QUIRKY_BUILTIN_PLUGINS_DIR: b.pluginsDir })
    expect(envA.QUIRKY_UI_OUT).not.toBe(envB.QUIRKY_UI_OUT)
    expect(treeState(fixture.repoRoot)).toEqual(sourceBefore)
  })


  test('skip-build uses checkout roots read-only and overlays only a copied environment', async () => {
    const root = freshRoot()
    const fixture = makeRepo(root)
    const before = treeState(fixture.repoRoot)
    const home = join(root, 'home')
    mkdirSync(home)
    const assets = await prepareRuntimeAssets({ repoRoot: fixture.repoRoot, home, skipBuild: true })
    const snapshot = snapshotRuntimeAssets(assets)
    const base = { QUIRKY_UI_OUT: 'prior', QUIRKY_PLUGINS_DIR: 'prior', OTHER: 'same' }
    const env = runtimeAssetEnvironment(base, assets)

    expect(assets.ownedRoot).toBeNull()
    expect(assets.uiDir).toBe(join(fixture.repoRoot, 'packages', 'ui', 'dist'))
    expect(assets.pluginsDir).toBe(join(fixture.repoRoot, 'plugins'))
    expect(env).toMatchObject({ QUIRKY_UI_OUT: assets.uiDir, QUIRKY_UI_DIR: assets.uiDir, QUIRKY_PLUGINS_DIR: assets.pluginsDir, QUIRKY_BUILTIN_PLUGINS_DIR: assets.pluginsDir, OTHER: 'same' })
    expect(base).toEqual({ QUIRKY_UI_OUT: 'prior', QUIRKY_PLUGINS_DIR: 'prior', OTHER: 'same' })
    expect(existsSync(join(home, 'capture-assets'))).toBe(false)
    expect(snapshot.size).toBeGreaterThan(SHELL_ASSETS.length)
    expect(treeState(fixture.repoRoot)).toEqual(before)
  })

  test('refuses every pre-existing staging entry without replacing it', async () => {
    for (const kind of ['file', 'directory', 'symlink'] as const) {
      const root = freshRoot()
      const fixture = makeRepo(root)
      const home = join(root, 'home')
      const outside = join(root, 'outside')
      mkdirSync(home)
      mkdirSync(outside)
      put(join(outside, 'sentinel'), 'must survive')
      const stage = join(home, 'capture-assets')
      if (kind === 'file') put(stage, 'existing file')
      else if (kind === 'directory') put(join(stage, 'sentinel'), 'existing directory')
      else symlinkSync(outside, stage, 'dir')
      const before = treeState(home)

      await expect(prepareRuntimeAssets({ repoRoot: fixture.repoRoot, home, skipBuild: false })).rejects.toThrow()
      expect(treeState(home)).toEqual(before)
      expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('must survive')
    }
  })

  test('rejects canonically overlapping source and destination trees', async () => {
    const root = freshRoot()
    const fixture = makeRepo(root)
    const home = join(fixture.repoRoot, 'nested-home')
    mkdirSync(home)
    await expect(prepareRuntimeAssets({ repoRoot: fixture.repoRoot, home, skipBuild: false })).rejects.toThrow(/overlap|inside|contain/i)
    expect(existsSync(join(home, 'capture-assets'))).toBe(false)
  })

  test('settles aborted staging without deleting another capture home', () => {
    const root = freshRoot()
    const fixture = makeRepo(root)
    const sourceBefore = treeState(fixture.repoRoot)
    const script = `
      import { mock } from 'bun:test'
      import { strict as assert } from 'node:assert'
      import { existsSync, readFileSync } from 'node:fs'
      import * as filesystem from 'node:fs/promises'
      import { join } from 'node:path'
      const fs = { ...filesystem }
      let entered, release, gatePath
      mock.module('node:fs/promises', () => ({
        ...fs,
        async copyFile(...args) {
          await fs.copyFile(...args)
          if (args[1] === gatePath) {
            entered.resolve()
            await release.promise
          }
        }
      }))
      // the staging module must load after the isolated filesystem barrier is installed
      const { prepareRuntimeAssets } = await import(${JSON.stringify(join(import.meta.dir, 'runtime-assets.ts'))})
      for (const order of ['before', 'after']) {
        const homeA = join(${JSON.stringify(root)}, 'home-a-' + order)
        const homeB = join(${JSON.stringify(root)}, 'home-b-' + order)
        await fs.mkdir(homeA)
        await fs.mkdir(homeB)
        const stageA = join(homeA, 'capture-assets')
        gatePath = join(await fs.realpath(homeA), 'capture-assets/plugins/acme.fixture/src/entry.tsx')
        entered = Promise.withResolvers()
        release = Promise.withResolvers()
        const controller = new AbortController()
        const pendingA = prepareRuntimeAssets({ repoRoot: ${JSON.stringify(fixture.repoRoot)}, home: homeA, skipBuild: false, signal: controller.signal })
        const rejectedA = assert.rejects(pendingA, /abort|cancel/i)
        await entered.promise
        assert.equal(existsSync(gatePath), true)
        const pendingB = prepareRuntimeAssets({ repoRoot: ${JSON.stringify(fixture.repoRoot)}, home: homeB, skipBuild: false })
        if (order === 'before') await pendingB
        controller.abort(new Error('staging cancelled'))
        release.resolve()
        await rejectedA
        const b = await pendingB
        assert.equal(existsSync(stageA), false)
        assert.equal(readFileSync(join(b.pluginsDir, 'acme.fixture/src/helper.ts'), 'utf8'), 'export const helper = true\\n')
      }
    `
    const child = Bun.spawnSync([process.execPath, '-e', script], {
      env: { QUIRKY_HOME: root, HOME: root, PATH: process.env.PATH ?? '/usr/bin:/bin' },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 20_000
    })
    expect(child.exitCode, child.stderr.toString()).toBe(0)
    expect(treeState(fixture.repoRoot)).toEqual(sourceBefore)
  }, 30_000)

  test('rejects source symlinks but excludes a symlinked generated dist before traversal', async () => {
    const root = freshRoot()
    const fixture = makeRepo(root)
    const outside = join(root, 'outside')
    mkdirSync(outside)
    put(join(outside, 'sentinel'), 'read only')
    rmSync(join(fixture.pluginRoot, 'dist'), { recursive: true, force: true })
    symlinkSync(outside, join(fixture.pluginRoot, 'dist'), 'dir')
    const home = join(root, 'home')
    mkdirSync(home)
    const assets = await prepareRuntimeAssets({ repoRoot: fixture.repoRoot, home, skipBuild: false })
    expect(existsSync(join(assets.pluginsDir, fixture.pluginId, 'dist'))).toBe(false)
    expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('read only')

    const symlinkFixture = makeRepo(root, { pluginId: 'acme.linked' })
    symlinkSync(outside, join(symlinkFixture.pluginRoot, 'src', 'outside'), 'dir')
    const secondHome = join(root, 'second-home')
    mkdirSync(secondHome)
    await expect(prepareRuntimeAssets({ repoRoot: symlinkFixture.repoRoot, home: secondHome, skipBuild: false })).rejects.toThrow(/symlink|symbolic|runtime assets/i)
    rmSync(join(symlinkFixture.pluginRoot, 'src', 'outside'))
    symlinkSync(symlinkFixture.pluginRoot, join(symlinkFixture.repoRoot, 'plugins', 'acme.linked-alias'), 'dir')
    const thirdHome = join(root, 'third-home')
    mkdirSync(thirdHome)
    await expect(prepareRuntimeAssets({ repoRoot: symlinkFixture.repoRoot, home: thirdHome, skipBuild: false })).rejects.toThrow(/symlink|symbolic|runtime assets/i)
    expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('read only')
  })

  test('accepts real roots reached through filesystem aliases', async () => {
    const root = freshRoot()
    const fixture = makeRepo(root)
    const home = join(root, 'home')
    mkdirSync(home)
    const assets = await prepareRuntimeAssets({ repoRoot: fixture.repoRoot, home, skipBuild: true })
    expect(realpathSync(assets.uiDir)).toBe(realpathSync(fixture.uiDir))
    expect(realpathSync(assets.pluginsDir)).toBe(realpathSync(join(fixture.repoRoot, 'plugins')))
    expect(snapshotRuntimeAssets(assets).size).toBeGreaterThan(SHELL_ASSETS.length)
  })

  test('snapshots all required shell, manifest UI, and plugin output files by public URL', () => {
    const root = freshRoot()
    const fixture = makeRepo(root)
    const assets = { repoRoot: fixture.repoRoot, uiDir: fixture.uiDir, pluginsDir: join(fixture.repoRoot, 'plugins'), ownedRoot: null }
    const snapshot = snapshotRuntimeAssets(assets)
    const keys = new Set(snapshot.keys())
    for (const asset of SHELL_ASSETS) expect(keys.has(`/${asset}`)).toBe(true)
    for (const asset of ['dist/ui.js', 'dist/chunks/split.js', 'dist/assets/font.woff2', 'dist/pdf.worker.min.mjs', 'dist/unreferenced.txt']) {
      expect(keys.has(`/plugins/${fixture.pluginId}/${asset}`)).toBe(true)
      const fingerprint = snapshot.get(`/plugins/${fixture.pluginId}/${asset}`)!
      expect(fingerprint.path).toBe(realpathSync(join(fixture.pluginRoot, asset)))
      expect(fingerprint.size).toBe(readFileSync(fingerprint.path).byteLength)
      expect(fingerprint.sha256).toBe(digest(readFileSync(fingerprint.path)))
    }
    expect([...keys].some((key) => key.startsWith('/plugins/quirky.headless/'))).toBe(false)
    expect(snapshot.get('/index.html')?.sha256).toBe(digest(readFileSync(join(fixture.uiDir, 'index.html'))))
  })

  test('requires every shell asset and each manifest-declared UI entrypoint', () => {
    for (const missing of ['vendor/react.js', 'plugin-ui']) {
      const root = freshRoot()
      const fixture = makeRepo(root)
      if (missing === 'vendor/react.js') rmSync(join(fixture.uiDir, missing))
      else {
        const manifest = JSON.parse(readFileSync(join(fixture.pluginRoot, 'quirky-plugin.json'), 'utf8'))
        manifest.ui = 'dist/not-the-entry.js'
        put(join(fixture.pluginRoot, 'quirky-plugin.json'), JSON.stringify(manifest))
      }
      const assets = { repoRoot: fixture.repoRoot, uiDir: fixture.uiDir, pluginsDir: join(fixture.repoRoot, 'plugins'), ownedRoot: null }
      expect(() => snapshotRuntimeAssets(assets)).toThrow(/runtime assets: missing/)
    }
  })


  test('rejects malformed or escaping manifest UI paths without touching outside files', () => {
    const invalidPaths = [
      '/tmp/outside.js', '/plugins/acme.fixture/dist/ui.js', 'https://outside.test/ui.js',
      '../outside.js', 'dist/../../outside.js', 'dist\\ui.js', 'dist/%2e%2e%2foutside.js',
      'dist/%2Foutside.js', 'dist/%5coutside.js', 'dist/%00outside.js', 'dist/%', 'dist/ui.js?x', 'dist/ui.js#x'
    ]
    for (const ui of invalidPaths) {
      const root = freshRoot()
      const fixture = makeRepo(root)
      const outside = join(root, 'outside')
      put(join(outside, 'sentinel'), 'do not touch')
      const manifest = JSON.parse(readFileSync(join(fixture.pluginRoot, 'quirky-plugin.json'), 'utf8'))
      manifest.ui = ui
      put(join(fixture.pluginRoot, 'quirky-plugin.json'), JSON.stringify(manifest))
      const assets = { repoRoot: fixture.repoRoot, uiDir: fixture.uiDir, pluginsDir: join(fixture.repoRoot, 'plugins'), ownedRoot: null }
      expect(() => snapshotRuntimeAssets(assets)).toThrow(/runtime assets: invalid URL/)
      expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('do not touch')
    }
  })
})

describe('runtime asset confinement', () => {
  test('rejects symlinked output roots and entries that escape their asset roots', () => {
    for (const kind of ['file', 'directory', 'ui-root', 'plugin-dist-root', 'sibling-prefix'] as const) {
      const root = freshRoot()
      const fixture = makeRepo(root)
      const outside = join(root, 'outside')
      mkdirSync(outside)
      put(join(outside, 'sentinel'), 'do not touch')
      const dist = join(fixture.pluginRoot, 'dist')
      let sentinel = join(outside, 'sentinel')
      if (kind === 'file') {
        rmSync(join(dist, 'chunks', 'split.js'))
        symlinkSync(sentinel, join(dist, 'chunks', 'split.js'))
      } else if (kind === 'directory') {
        rmSync(join(dist, 'assets'), { recursive: true })
        symlinkSync(outside, join(dist, 'assets'), 'dir')
      } else if (kind === 'ui-root') {
        rmSync(fixture.uiDir, { recursive: true })
        symlinkSync(outside, fixture.uiDir, 'dir')
      } else if (kind === 'plugin-dist-root') {
        rmSync(dist, { recursive: true })
        symlinkSync(outside, dist, 'dir')
      } else {
        const sibling = join(fixture.repoRoot, 'plugins', `${fixture.pluginId}-extra`, 'dist', 'assets')
        put(join(sibling, 'sentinel'), 'do not touch')
        sentinel = join(sibling, 'sentinel')
        rmSync(join(dist, 'assets'), { recursive: true })
        symlinkSync(sibling, join(dist, 'assets'), 'dir')
      }
      const assets = { repoRoot: fixture.repoRoot, uiDir: fixture.uiDir, pluginsDir: join(fixture.repoRoot, 'plugins'), ownedRoot: null }
      expect(() => snapshotRuntimeAssets(assets)).toThrow(/runtime assets: escapes root/)
      expect(readFileSync(sentinel, 'utf8')).toBe('do not touch')
    }
  })
})
function addUiPlugin(repoRoot: string, pluginId: string): string {
  const pluginRoot = join(repoRoot, 'plugins', pluginId)
  put(join(pluginRoot, 'quirky-plugin.json'), JSON.stringify({ id: pluginId, name: pluginId, version: '1.0.0', apiVersion: '1.0.0', ui: 'dist/ui.js' }))
  put(join(pluginRoot, 'dist', 'ui.js'), `${pluginId}-entry`)
  put(join(pluginRoot, 'dist', 'chunks', 'unselected.js'), `${pluginId}-chunk`)
  return pluginRoot
}

function moduleUrl(pluginId = 'acme.fixture', path = 'dist/ui.js'): string {
  return `/plugins/${encodeURIComponent(pluginId)}/${path.split('/').map(encodeURIComponent).join('/')}`
}

function modelWithModules(urls: Record<string, string>): UiModel {
  return {
    sidebarSections: [],
    statusBars: [],
    activityItems: [],
    panels: [],
    views: [],
    overlays: [],
    commands: [],
    keybindings: [],
    settings: [],
    settingsSections: [],
    menuItems: [],
    themes: [],
    theme: { chosen: 'default', active: 'default' },
    modules: Object.fromEntries(Object.entries(urls).map(([pluginId, url]) => [
      pluginId, { url, provides: [], apiVersion: '1.0.0' }
    ]))
  }
}

function expectedIndex(html: string, urls: string[]): string {
  const importMap = /<script\b(?=[^>]*\s+type\s*=\s*(["'])importmap\1)[^>]*>/i.test(html)
  const bodyEnd = /<\/body\s*>/i.exec(html)
  if (!importMap || bodyEnd === null || urls.length === 0) return html
  const links = urls.map((url) => `<link rel="modulepreload" href="${url.replace(/[&"'<>]/g, (character) => ({
    '&': '&amp;', '"': '&quot;', "'": '&#39;', '<': '&lt;', '>': '&gt;'
  })[character]!)}">`).join('\n')
  return `${html.slice(0, bodyEnd.index)}${links}${html.slice(bodyEnd.index)}`
}

function serveSnapshot(snapshot: AssetSnapshot, urls: string[]) {
  const seen: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      seen.push(path)
      const publicPath = path === '/' ? '/index.html' : path
      const asset = snapshot.get(publicPath)
      if (!asset) return new Response('not found', { status: 404 })
      const bytes = readFileSync(asset.path)
      return publicPath === '/index.html'
        ? new Response(expectedIndex(bytes.toString('utf8'), urls))
        : new Response(bytes)
    }
  })
  return { server, seen }
}

async function prebuilt(repoRoot: string) {
  const home = join(dirname(repoRoot), 'prebuilt-home')
  mkdirSync(home)
  const assets = await prepareRuntimeAssets({ repoRoot, home, skipBuild: true })
  return { assets, snapshot: snapshotRuntimeAssets(assets) }
}

function verifyOptions(port: number) {
  return { port, timeoutMs: 2_000 }
}

async function rejectionMessage(operation: Promise<unknown>): Promise<string> {
  try {
    await operation
  } catch (error) {
    return String(error)
  }
  throw new Error('expected runtime asset verification to reject')
}

describe('runtime asset HTTP verification', () => {
  test('verifies advertised module, script, stylesheet and import-map aliases against their recorded bytes', async () => {
    const cases = [
      ['/plugins/acme.fixture/dist/%75i.js', '/plugins/acme.fixture/dist/ui.js', ''],
      ['/%6dain.js', '/main.js', '<script type="module" src="./%6dain.js"></script>'],
      ['/%6dain.css', '/main.css', '<link rel="stylesheet" href="./%6dain.css">'],
      ['/vendor/%72eact.js', '/vendor/react.js', '<script type="importmap">{"imports":{"react":"./vendor/%72eact.js"}}</script>']
    ] as const
    for (const [advertised, canonical, declaration] of cases) {
      const fixture = makeRepo(freshRoot())
      if (declaration) put(join(fixture.uiDir, 'index.html'), `<html><head><script type="importmap">{}</script>${declaration}</head><body></body></html>`)
      const { assets, snapshot } = await prebuilt(fixture.repoRoot)
      const module = declaration ? moduleUrl() : advertised
      let corruptAlias = true
      const seen: string[] = []
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
        const path = new URL(request.url).pathname
        seen.push(path)
        const key = path === '/' ? '/index.html' : path === advertised ? canonical : path
        const asset = snapshot.get(key)
        if (!asset) return new Response('missing', { status: 404 })
        const bytes = readFileSync(asset.path)
        if (path === advertised && corruptAlias) bytes[0] = bytes[0]! ^ 1
        return key === '/index.html'
          ? new Response(expectedIndex(bytes.toString('utf8'), [module]))
          : new Response(bytes)
      } })
      try {
        await expect(verifyRuntimeAssets(assets, snapshot, modelWithModules({ 'acme.fixture': module }), verifyOptions(server.port!)))
          .rejects.toThrow(`runtime assets: served bytes differ ${advertised}`)
        expect(seen).toContain(advertised)
        corruptAlias = false
        await verifyRuntimeAssets(assets, snapshot, modelWithModules({ 'acme.fixture': module }), verifyOptions(server.port!))
      } finally {
        await server.stop(true)
      }
    }
  })

  test('rejects document bases that send executable or style references outside verified root output', async () => {
    const trap = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { throw new Error('foreign base was contacted') } })
    try {
      for (const base of [`http://127.0.0.1:${trap.port!}/`, `//127.0.0.1:${trap.port!}/`, '/unverified/', '&sol;&sol;foreign.invalid/', '&#x2f;&#x2f;foreign.invalid/', `http://127.0.0.1:${trap.port!}/" href="/`, '/', '&#47;']) {
        const fixture = makeRepo(freshRoot())
        put(join(fixture.uiDir, 'index.html'), `<html><head><base href="${base}"><script type="importmap">{}</script><link rel="stylesheet" href="./main.css"></head><body><script type="module" src="./main.js"></script></body></html>`)
        const { assets, snapshot } = await prebuilt(fixture.repoRoot)
        const url = moduleUrl()
        const server = serveSnapshot(snapshot, [url])
        try {
          const verifying = verifyRuntimeAssets(assets, snapshot, modelWithModules({ 'acme.fixture': url }), verifyOptions(server.server.port!))
          if (base === '/' || base === '&#47;') await verifying
          else await expect(verifying).rejects.toThrow('runtime assets: invalid URL')
        } finally {
          await server.server.stop(true)
        }
      }
    } finally {
      await trap.stop(true)
    }
  })

  test('rejects hostile module URLs before contacting either loopback server', async () => {
    const root = freshRoot()
    const fixture = makeRepo(root)
    addUiPlugin(fixture.repoRoot, 'acme.unselected')
    const { assets, snapshot } = await prebuilt(fixture.repoRoot)
    const daemon = serveSnapshot(snapshot, [])
    const trapRequests: string[] = []
    const trap = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        trapRequests.push(request.url)
        return new Response('unexpected request')
      }
    })
    const outside = join(root, 'outside')
    put(join(outside, 'sentinel'), 'must survive')
    const id65 = 'a'.repeat(65)
    const attacks = [
      `http://127.0.0.1:${trap.port!}/plugins/acme.fixture/dist/ui.js`,
      `//127.0.0.1:${trap.port!}/plugins/acme.fixture/dist/ui.js`,
      '/plugins/acme.fixture/dist/ui.js?mode=1',
      '/plugins/acme.fixture/dist/ui.js#fragment',
      '/plugins/acme.fixture/dist\\\\ui.js',
      '/plugins/acme.fixture/dist%5cui.js',
      '/plugins/acme.fixture/dist%2Fui.js',
      '/plugins/acme.fixture/./dist/ui.js',
      '/plugins/acme.fixture/../acme.fixture/dist/ui.js',
      '/plugins/acme.fixture/%2e%2e%2fui.js',
      '/plugins/acme.fixture/dist/%00ui.js',
      '/plugins/acme.fixture/dist/%01ui.js',
      '/plugins/acme.fixture/dist/%',
      `/plugins/${id65}/dist/ui.js`,
      '/plugins/acme.fixture-extra/dist/ui.js'
    ]
    try {
      for (const url of attacks) {
        const error = await rejectionMessage(verifyRuntimeAssets(
          assets, snapshot, modelWithModules({ 'acme.fixture': url }), verifyOptions(daemon.server.port!)
        ))
        expect(error).toContain('runtime assets: invalid URL')
      }
      const longUrl = `/plugins/acme.fixture/dist/${'x'.repeat(4_096)}`
      await expect(verifyRuntimeAssets(
        assets, snapshot, modelWithModules({ 'acme.fixture': longUrl }), verifyOptions(daemon.server.port!)
      )).rejects.toThrow()
      await expect(verifyRuntimeAssets(
        assets, snapshot, modelWithModules({ [id65]: moduleUrl(id65) }), verifyOptions(daemon.server.port!)
      )).rejects.toThrow(/runtime assets: invalid URL/)
      expect(daemon.seen).toHaveLength(0)
      expect(trapRequests).toHaveLength(0)
      expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('must survive')
    } finally {
      daemon.server.stop(true)
      trap.stop(true)
    }
  })

  test('accepts a double-encoded filename once and binds every module, including unselected plugins', async () => {
    const root = freshRoot()
    const fixture = makeRepo(root)
    const unselectedRoot = addUiPlugin(fixture.repoRoot, 'acme.unselected')
    const id64 = 'a'.repeat(64)
    addUiPlugin(fixture.repoRoot, id64)
    const encodedName = '%2e%2e%2foutside.txt'
    put(join(fixture.pluginRoot, 'dist', encodedName), 'literal segment')
    const { assets, snapshot } = await prebuilt(fixture.repoRoot)
    const selectedUrl = moduleUrl(fixture.pluginId, `dist/${encodedName}`)
    const unselectedUrl = moduleUrl('acme.unselected', 'dist/chunks/unselected.js')
    const url64 = moduleUrl(id64)
    expect(snapshot.has(selectedUrl)).toBe(true)
    const urls = { 'acme.fixture': selectedUrl, 'acme.unselected': unselectedUrl, [id64]: url64 }
    const server = serveSnapshot(snapshot, Object.values(urls))
    try {
      const wrongBinding = modelWithModules({ 'acme.fixture': selectedUrl, 'acme.unselected': selectedUrl })
      await expect(verifyRuntimeAssets(assets, snapshot, wrongBinding, verifyOptions(server.server.port!)))
        .rejects.toThrow(/runtime assets: invalid URL/)
      expect(server.seen).toHaveLength(0)
      await verifyRuntimeAssets(assets, snapshot, modelWithModules(urls), verifyOptions(server.server.port!))
      expect(server.seen).toContain(selectedUrl)
      expect(server.seen).toContain(unselectedUrl)
      expect(server.seen).toContain(url64)
      expect(readFileSync(join(unselectedRoot, 'dist', 'chunks', 'unselected.js'), 'utf8')).toBe('acme.unselected-chunk')
    } finally {
      server.server.stop(true)
    }
  })

  test('matches daemon index transformation, UTF-8 byte bounds, and missing-transform prerequisites', async () => {
    const cases = [
      { name: 'transformed', html: '<!doctype html><script type="importmap">{\"imports\":{\"react\":\"./vendor/react.js\"}}</script><link rel=\"stylesheet\" href=\"./main.css\"><script type=\"module\" src=\"./main.js\"></script><p>café</p></body >', urls: true },
      { name: 'empty modules', html: '<script type=\"importmap\">{}</script><p>café</p></body>', urls: false },
      { name: 'missing import map', html: '<p>café</p></body>', urls: true },
      { name: 'missing body', html: '<script type=\"importmap\">{}</script><p>café</p>', urls: true }
    ]
    for (const scenario of cases) {
      const root = freshRoot()
      const fixture = makeRepo(root)
      put(join(fixture.uiDir, 'index.html'), scenario.html)
      const { assets, snapshot } = await prebuilt(fixture.repoRoot)
      const url = moduleUrl()
      const modules: Record<string, string> = scenario.urls ? { 'acme.fixture': url } : {}
      const urls = Object.values(modules)
      const expected = expectedIndex(scenario.html, urls)
      if (scenario.name === 'transformed') {
        expect(expected).not.toBe(scenario.html)
        expect(Buffer.byteLength(expected, 'utf8')).toBeGreaterThan(Buffer.byteLength(scenario.html, 'utf8'))
        expect(expected.length).toBeLessThan(Buffer.byteLength(expected, 'utf8'))
      } else expect(expected).toBe(scenario.html)
      const server = serveSnapshot(snapshot, urls)
      try {
        await verifyRuntimeAssets(assets, snapshot, modelWithModules(modules), verifyOptions(server.server.port!))
        expect(server.seen).toContain('/')
        expect(server.seen).toContain('/index.html')
      } finally {
        server.server.stop(true)
      }
    }
  })

  test('rejects missing executable, stylesheet, and import-map outputs referenced by index HTML', async () => {
    const documents = [
      '<!doctype html><script type="importmap">{}</script><script type="module" src="./missing.js"></script><body></body>',
      '<!doctype html><script type="importmap">{}</script><link rel="stylesheet" href="./missing.css"><body></body>',
      '<!doctype html><script type="importmap">{"imports":{"missing":"./vendor/missing.js"}}</script><body></body>'
    ]
    for (const indexHtml of documents) {
      const root = freshRoot()
      const fixture = makeRepo(root)
      put(join(fixture.uiDir, 'index.html'), indexHtml)
      const { assets, snapshot } = await prebuilt(fixture.repoRoot)
      const url = moduleUrl()
      const server = serveSnapshot(snapshot, [url])
      try {
        await expect(verifyRuntimeAssets(assets, snapshot, modelWithModules({ 'acme.fixture': url }), verifyOptions(server.server.port!)))
          .rejects.toThrow(/runtime assets: missing/)
      } finally {
        server.server.stop(true)
      }
    }
  })

  test('skip-build verifies unchanged output and rejects changed, missing, added, and symlinked output without repair', async () => {
    for (const change of ['unchanged', 'changed', 'missing', 'added', 'symlink'] as const) {
      const root = freshRoot()
      const fixture = makeRepo(root)
      const { assets, snapshot } = await prebuilt(fixture.repoRoot)
      const url = moduleUrl()
      const publicPath = `/plugins/${fixture.pluginId}/dist/ui.js`
      const file = join(fixture.pluginRoot, 'dist', 'ui.js')
      const outside = join(root, 'outside')
      put(join(outside, 'sentinel'), 'must survive')
      if (change === 'changed') {
        const bytes = Buffer.from(readFileSync(file))
        bytes[0] ^= 1
        put(file, bytes)
      } else if (change === 'missing') rmSync(file)
      else if (change === 'added') put(join(fixture.pluginRoot, 'dist', 'added-after-snapshot.js'), 'new output')
      else if (change === 'symlink') {
        rmSync(file)
        symlinkSync(join(outside, 'sentinel'), file)
      }
      const server = serveSnapshot(snapshot, [url])
      try {
        if (change === 'unchanged') {
          await verifyRuntimeAssets(assets, snapshot, modelWithModules({ 'acme.fixture': url }), verifyOptions(server.server.port!))
          expect(server.seen.length).toBeGreaterThan(0)
        } else {
          const error = await rejectionMessage(verifyRuntimeAssets(
            assets, snapshot, modelWithModules({ 'acme.fixture': url }), verifyOptions(server.server.port!)
          ))
          expect(server.seen).toHaveLength(0)
          if (change === 'symlink') expect(error).toContain('runtime assets: escapes root')
          else {
            const diagnostic = change === 'added' ? 'changed' : change
            expect(error).toContain(`runtime assets: ${diagnostic} ${change === 'added' ? `${publicPath.slice(0, publicPath.lastIndexOf('/'))}/added-after-snapshot.js` : publicPath}`)
            if (change === 'added') expect(error).toContain('(added)')
          }
        }
        expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('must survive')
        if (change === 'missing') expect(existsSync(file)).toBe(false)
        if (change === 'added') expect(existsSync(join(fixture.pluginRoot, 'dist', 'added-after-snapshot.js'))).toBe(true)
        if (change === 'symlink') expect(lstatSync(file).isSymbolicLink()).toBe(true)
        if (change === 'changed') expect(readFileSync(file)).toHaveLength(snapshot.get(publicPath)!.size)
      } finally {
        server.server.stop(true)
      }
    }
  })
})


