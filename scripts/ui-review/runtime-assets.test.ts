import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, readlinkSync, rmSync, symlinkSync, watch, writeFileSync,
  type FSWatcher
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import {
  prepareRuntimeAssets, runtimeAssetEnvironment, snapshotRuntimeAssets,
  type RuntimeAssets
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
function waitForPath(path: string, watchers: FSWatcher[]): Promise<void> {
  if (existsSync(path)) return Promise.resolve()
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const watcher = watch(dirname(path), { persistent: false }, () => {
    if (!existsSync(path)) return
    watcher.close()
    resolve()
  })
  watchers.push(watcher)
  watcher.on('error', (error) => {
    watcher.close()
    reject(error)
  })
  if (existsSync(path)) {
    watcher.close()
    resolve()
  }
  return promise
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

  test('settles aborted staging without deleting another capture home', async () => {
    const root = freshRoot()
    const fixture = makeRepo(root)
    for (let index = 0; index < 600; index++) put(join(fixture.pluginRoot, 'src', `entry-${String(index).padStart(4, '0')}.ts`), `export const n = ${index}\n`)
    const homeA = join(root, 'home-a')
    const homeB = join(root, 'home-b')
    mkdirSync(homeA)
    mkdirSync(homeB)
    const stageA = join(homeA, 'capture-assets')
    const controller = new AbortController()
    const pendingA = prepareRuntimeAssets({ repoRoot: fixture.repoRoot, home: homeA, skipBuild: false, signal: controller.signal })
    let pendingB: Promise<RuntimeAssets> | undefined
    const watchers: FSWatcher[] = []
    try {
      const stagedPlugin = join(stageA, 'plugins', fixture.pluginId)
      await waitForPath(stageA, watchers)
      await waitForPath(join(stageA, 'plugins'), watchers)
      await waitForPath(stagedPlugin, watchers)
      await waitForPath(join(stagedPlugin, 'quirky-plugin.json'), watchers)
      expect(existsSync(join(stagedPlugin, 'src', 'entry-0599.ts'))).toBe(false)
      pendingB = prepareRuntimeAssets({ repoRoot: fixture.repoRoot, home: homeB, skipBuild: false })
      controller.abort(new Error('staging cancelled'))
      await expect(pendingA).rejects.toThrow(/abort|cancel/i)
      expect(existsSync(stageA)).toBe(false)
      const b = await pendingB
      expect(existsSync(join(b.pluginsDir, fixture.pluginId, 'src', 'entry-0599.ts'))).toBe(true)
      expect(existsSync(stageA)).toBe(false)
    } finally {
      controller.abort(new Error('test cleanup'))
      for (const watcher of watchers) watcher.close()
      await pendingA.catch(() => undefined)
      if (pendingB) await pendingB.catch(() => undefined)
    }
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


