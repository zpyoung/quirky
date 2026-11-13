import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Inventory } from './contracts'
import { collectInventory } from './inventory'

type PluginOptions = {
  ui?: string
  contributes?: Record<string, Array<Record<string, unknown>>>
  sources?: Record<string, string>
  coverage?: string
}

const roots: string[] = []
const slotKinds = ['view', 'panel', 'sidebar-section', 'activity-item', 'status-bar', 'overlay', 'settings-section'] as const
const hostTargetIds = ['host:shell', 'host:scoped', 'host:popups', 'host:settings', 'host:palette']
const sourceExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.html', '.htm', '.svg', '.css', '.scss', '.sass', '.less']

function isolatedEnv(root: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: root,
    QUIRKY_HOME: root,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Inventory fixture',
    GIT_AUTHOR_EMAIL: 'inventory@example.invalid',
    GIT_COMMITTER_NAME: 'Inventory fixture',
    GIT_COMMITTER_EMAIL: 'inventory@example.invalid'
  }
}

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: root, env: isolatedEnv(root) })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

function putFile(root: string, file: string, content: string): void {
  const path = join(root, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function addPlugin(root: string, directory: string, id = directory, options: PluginOptions = {}): void {
  const manifest = { id, name: id, ...(options.ui ? { ui: options.ui } : {}), ...(options.contributes ? { contributes: options.contributes } : {}) }
  putFile(root, `plugins/${directory}/quirky-plugin.json`, `${JSON.stringify(manifest, null, 2)}\n`)
  for (const [path, content] of Object.entries(options.sources ?? {})) putFile(root, `plugins/${directory}/${path}`, content)
  if (options.coverage !== undefined) putFile(root, `plugins/${directory}/ui-scoreboard.json`, options.coverage)
}

function createRepository(options: { plugins?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'g3-1-inventory-'))
  roots.push(root)
  mkdirSync(join(root, 'plugins'), { recursive: true })
  putFile(root, 'packages/ui/src/styles.css', ':root { color: var(--ui-text-primary); }\n')
  putFile(root, 'packages/ui/src/design-system/compatibility-tokens.css', ':root { --compat-px-40: 40px; }\n')
  putFile(root, 'packages/ui/src/test/ignored.ts', 'export const ignored = true\n')
  putFile(root, 'packages/daemon/src/runtime.ts', 'export const runtime = true\n')
  putFile(root, 'apps/desktop/src/main.ts', 'export const desktop = true\n')

  if (options.plugins !== false) {
    const visibleContributions = Object.fromEntries(slotKinds.map((kind) => [kind, [{ id: `${kind}-entry`, title: kind }]]))
    addPlugin(root, 'acme.visible', 'acme.visible', {
      ui: 'src/ui.tsx',
      contributes: visibleContributions,
      sources: { 'src/ui.tsx': 'export const Visible = () => null\n', 'main.ts': 'export const start = () => undefined\n' }
    })
    addPlugin(root, 'acme.service', 'acme.service', { sources: { 'src/service.ts': 'export const service = true\n' } })
    addPlugin(root, 'acme.new', 'acme.new', {
      ui: 'src/panel.tsx',
      contributes: { panel: [{ id: 'new-panel', title: 'New panel' }] },
      sources: { 'src/panel.tsx': 'export const Panel = () => null\n' }
    })
    addPlugin(root, 'acme.orphan', 'acme.orphan', {
      ui: 'src/ui.ts',
      sources: { 'src/ui.ts': 'export const Orphan = () => null\n' }
    })
    putFile(root, 'plugins/acme.visible/nested/fake/quirky-plugin.json', JSON.stringify({ id: 'acme.fake', ui: 'src/fake.ts' }))
  }

  git(root, 'init', '--quiet')
  git(root, 'config', 'user.name', 'Inventory fixture')
  git(root, 'config', 'user.email', 'inventory@example.invalid')
  git(root, 'add', '--all')
  git(root, 'commit', '--quiet', '-m', 'fixture')
  return root
}

function collect(root: string): Inventory {
  const settings = isolatedEnv(root)
  const keys = Object.keys(settings)
  const previous = new Map(keys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, settings)
  try {
    return collectInventory(root)
  } finally {
    for (const key of keys) {
      const value = previous.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('collectInventory', () => {
  test('discovers immediate plugins and every declared slot plus the five host targets', () => {
    const root = createRepository()
    const inventory = collect(root)

    expect(inventory.failures).toEqual([])
    expect(inventory.plugins.map(({ id }) => id)).toEqual(['acme.new', 'acme.orphan', 'acme.service', 'acme.visible'])
    expect(inventory.plugins.find(({ id }) => id === 'acme.service')).toMatchObject({ hasUi: false, targets: [] })
    expect(inventory.plugins.find(({ id }) => id === 'acme.orphan')).toMatchObject({ hasUi: true, targets: [] })
    expect(inventory.plugins.find(({ id }) => id === 'acme.new')?.targets).toEqual(['panel:acme.new/new-panel'])
    expect(inventory.plugins.find(({ id }) => id === 'acme.visible')?.targets.slice().sort()).toEqual(
      slotKinds.map((kind) => `${kind}:acme.visible/${kind}-entry`).sort()
    )
    expect(inventory.plugins.map(({ id }) => id)).not.toContain('acme.fake')
    expect(inventory.targets.filter(({ kind }) => kind === 'host').map(({ id }) => id).sort()).toEqual(hostTargetIds.slice().sort())
    expect(new Set(inventory.targets.map(({ kind }) => kind))).toEqual(new Set(['host', ...slotKinds]))
  })

  test('records full contribution IDs and CLI command methods', () => {
    const root = createRepository({ plugins: false })
    addPlugin(root, 'acme.app', 'acme.app', {
      contributes: {
        method: [{ id: 'save' }, { id: 'load' }],
        command: [{ id: 'refresh' }],
        'cli-command': [
          { id: 'save', words: 'save', method: 'save' },
          { id: 'combined', methods: ['acme.app/load', 'other.plugin/refresh'] }
        ]
      }
    })
    git(root, 'add', '--all')
    git(root, 'commit', '--quiet', '-m', 'contribution fixture')
    const plugin = collect(root).plugins.find(({ id }) => id === 'acme.app')

    expect(plugin?.contributions).toEqual({
      methods: ['acme.app/save', 'acme.app/load'],
      commands: ['command:acme.app/refresh'],
      cliCommands: [
        { id: 'save', words: 'save', methods: ['acme.app/save'] },
        { id: 'combined', methods: ['acme.app/load', 'other.plugin/refresh'] }
      ]
    })
  })

  test('loads an optional coverage file separately from production sources', () => {
    const root = createRepository({ plugins: false })
    const content = '{"schemaVersion":1}\n'
    addPlugin(root, 'acme.app', 'acme.app', {
      ui: 'src/ui.tsx',
      sources: { 'src/ui.tsx': 'export const App = () => null\n' },
      coverage: content
    })
    git(root, 'add', '--all')
    git(root, 'commit', '--quiet', '-m', 'coverage fixture')
    const plugin = collect(root).plugins.find(({ id }) => id === 'acme.app')

    expect(plugin?.coverage).toEqual({ file: 'plugins/acme.app/ui-scoreboard.json', content })
    expect(plugin?.sources.map(({ file }) => file)).not.toContain('plugins/acme.app/ui-scoreboard.json')
  })

  test('leaves coverage undefined when the optional file is absent', () => {
    const plugin = collect(createRepository()).plugins.find(({ id }) => id === 'acme.service')

    expect(plugin?.coverage).toBeUndefined()
  })

  test('rejects a symlinked coverage file without reading its target', () => {
    const root = createRepository()
    const target = join(root, 'outside/ui-scoreboard.json')
    putFile(root, 'outside/ui-scoreboard.json', '{"schemaVersion":1}\n')
    symlinkSync(target, join(root, 'plugins/acme.visible/ui-scoreboard.json'))
    const inventory = collect(root)
    const plugin = inventory.plugins.find(({ id }) => id === 'acme.visible')

    expect(plugin?.coverage).toBeUndefined()
    expect(inventory.failures).toContainEqual(expect.objectContaining({
      code: 'source-symlink',
      message: expect.stringContaining('plugins/acme.visible/ui-scoreboard.json')
    }))
  })

  test('reports a coverage file on a plugin without a UI or targets', () => {
    const root = createRepository({ plugins: false })
    addPlugin(root, 'acme.daemon', 'acme.daemon', { coverage: '{"schemaVersion":1}\n' })
    git(root, 'add', '--all')
    git(root, 'commit', '--quiet', '-m', 'unexpected coverage fixture')
    const inventory = collect(root)

    expect(inventory.failures).toContainEqual(expect.objectContaining({
      code: 'unexpected-coverage-file',
      message: expect.stringContaining('plugins/acme.daemon/ui-scoreboard.json')
    }))
  })

  test('digests and marks the inventory dirty when only coverage changes', () => {
    const root = createRepository({ plugins: false })
    addPlugin(root, 'acme.app', 'acme.app', {
      ui: 'src/ui.tsx',
      sources: { 'src/ui.tsx': 'export const App = () => null\n' },
      coverage: '{"schemaVersion":1}\n'
    })
    git(root, 'add', '--all')
    git(root, 'commit', '--quiet', '-m', 'coverage digest fixture')
    const before = collect(root)
    putFile(root, 'plugins/acme.app/ui-scoreboard.json', '{"schemaVersion":1,"changed":true}\n')
    const after = collect(root)

    expect(after.sourceDigest).not.toBe(before.sourceDigest)
    expect(after.dirty).toBe(true)
  })

  test('records the exact avatar exclusion only when its manifest is absent', () => {
    const inventory = collect(createRepository())

    expect(inventory.exclusions).toEqual([{
      plugin: 'quirky.avatar', reason: 'paused-unmerged', branch: 'zpyoung/avatar-plugin', pr: 305, steerDate: '2026-11-13'
    }])
    expect(inventory.plugins.some(({ id }) => id === 'quirky.avatar')).toBe(false)
    expect(inventory.failures).toEqual([])
  })

  test('fails inventory rather than excluding an avatar manifest present in the scanned tree', () => {
    const root = createRepository({ plugins: false })
    addPlugin(root, 'quirky.avatar', 'quirky.avatar', { ui: 'src/ui.ts', sources: { 'src/ui.ts': 'export const Avatar = () => null\n' } })
    git(root, 'add', '--all')
    git(root, 'commit', '--quiet', '-m', 'avatar fixture')
    const inventory = collect(root)

    expect(inventory.plugins.some(({ id }) => id === 'quirky.avatar')).toBe(true)
    expect(inventory.failures).toContainEqual(expect.objectContaining({ code: 'paused-plugin-present' }))
  })

  test('reports malformed manifests and retains their immediate plugin rows', () => {
    const root = createRepository({ plugins: false })
    putFile(root, 'plugins/acme.invalid/quirky-plugin.json', '{"id":')
    git(root, 'add', '--all')
    git(root, 'commit', '--quiet', '-m', 'invalid manifest fixture')
    const inventory = collect(root)

    expect(inventory.plugins.some(({ id }) => id === 'acme.invalid')).toBe(true)
    expect(inventory.failures.some(({ message }) => message.includes('acme.invalid'))).toBe(true)
  })

  test('fails on duplicate manifest IDs and directory/manifest ID mismatches', () => {
    const duplicateRoot = createRepository({ plugins: false })
    addPlugin(duplicateRoot, 'acme.first', 'acme.shared')
    addPlugin(duplicateRoot, 'acme.second', 'acme.shared')
    git(duplicateRoot, 'add', '--all')
    git(duplicateRoot, 'commit', '--quiet', '-m', 'duplicate ID fixture')
    const duplicate = collect(duplicateRoot)

    expect(duplicate.failures.some(({ code, message }) => /duplicate/i.test(`${code} ${message}`))).toBe(true)

    const mismatchRoot = createRepository({ plugins: false })
    addPlugin(mismatchRoot, 'acme.expected', 'acme.actual')
    git(mismatchRoot, 'add', '--all')
    git(mismatchRoot, 'commit', '--quiet', '-m', 'mismatched ID fixture')
    const mismatch = collect(mismatchRoot)

    expect(mismatch.failures.some(({ code, message }) => /mismatch|does not match/i.test(`${code} ${message}`))).toBe(true)
  })

  test('fails on unreadable or symlinked production sources', () => {
    const root = createRepository()
    putFile(root, 'outside/source.ts', 'export const outside = true\n')
    symlinkSync(join(root, 'outside/source.ts'), join(root, 'plugins/acme.visible/src/linked.ts'))
    const linked = collect(root)
    expect(linked.failures.some(({ message }) => message.includes('linked.ts'))).toBe(true)

    const unreadableRoot = createRepository()
    symlinkSync(join(unreadableRoot, 'missing.ts'), join(unreadableRoot, 'plugins/acme.visible/src/unreadable.ts'))
    const unreadable = collect(unreadableRoot)
    expect(unreadable.failures.some(({ message }) => message.includes('unreadable.ts'))).toBe(true)
  })

  test('scans lint-supported source extensions without truncation and excludes tests and build trees', () => {
    const root = createRepository()
    const longSource = 'x'.repeat(1_048_601)
    for (const [index, extension] of sourceExtensions.entries()) {
      putFile(root, `plugins/acme.visible/src/formats/source-${index}${extension}`, `source-${extension}`)
    }
    putFile(root, 'plugins/acme.visible/src/formats/large.ts', longSource)
    for (const directory of ['node_modules', 'vendor', 'dist', 'build', 'coverage', 'test', 'tests', '__tests__', '__test__', '_test', '_tests', 'fixture', 'fixtures', '__fixtures__', '_fixtures']) {
      putFile(root, `plugins/acme.visible/src/${directory}/ignored.ts`, 'ignored')
    }
    for (const file of ['Widget.test.tsx', 'Widget.spec.ts', 'Widget.fixture.ts', 'Widget.fixtures.css']) {
      putFile(root, `plugins/acme.visible/src/components/${file}`, 'ignored')
    }
    git(root, 'add', '--all')
    git(root, 'commit', '--quiet', '-m', 'source traversal fixture')
    const inventory = collect(root)
    const pluginSources = inventory.plugins.find(({ id }) => id === 'acme.visible')!.sources
    const paths = pluginSources.map(({ file }) => file)

    for (const extension of sourceExtensions) expect(paths.some((file) => file.endsWith(extension))).toBe(true)
    expect(pluginSources.find(({ file }) => file.endsWith('/large.ts'))?.content).toBe(longSource)
    expect(paths.some((file) => /(?:^|\/)(?:node_modules|vendor|dist|build|coverage|test|tests|__tests__|__test__|_test|_tests|fixture|fixtures|__fixtures__|_fixtures)\//.test(file))).toBe(false)
    expect(paths.some((file) => /\.(?:test|spec|fixture|fixtures)\.[^.]+$/i.test(file))).toBe(false)
    expect(inventory.sharedSources.map(({ file }) => file)).toContain('packages/ui/src/styles.css')
    expect(inventory.sharedSources.map(({ file }) => file)).not.toContain('packages/ui/src/design-system/compatibility-tokens.css')
    expect(inventory.sharedSources.map(({ file }) => file)).not.toContain('packages/ui/src/test/ignored.ts')
  })

  test('digests manifest and production source contents deterministically and reports the fixture commit', () => {
    const root = createRepository()
    const first = collect(root)
    const second = collect(root)

    expect(first.commit).toBe(git(root, 'rev-parse', 'HEAD'))
    expect(first.sourceDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(second.sourceDigest).toBe(first.sourceDigest)
    expect(first.dirty).toBe(false)
    const pluginSourcePaths = first.plugins.flatMap(({ sources }) => sources.map(({ file }) => file))
    expect(pluginSourcePaths).toEqual(pluginSourcePaths.slice().sort())

    const daemonPath = join(root, 'packages/daemon/src/runtime.ts')
    writeFileSync(daemonPath, 'export const runtime = false\n')
    const afterDaemonChange = collect(root)
    expect(afterDaemonChange.sourceDigest).not.toBe(first.sourceDigest)
    expect(afterDaemonChange.dirty).toBe(true)

    const desktopPath = join(root, 'apps/desktop/src/main.ts')
    writeFileSync(desktopPath, 'export const desktop = false\n')
    const afterDesktopChange = collect(root)
    expect(afterDesktopChange.sourceDigest).not.toBe(afterDaemonChange.sourceDigest)
    expect(afterDesktopChange.dirty).toBe(true)

    const sourcePath = join(root, 'plugins/acme.visible/src/ui.tsx')
    writeFileSync(sourcePath, 'export const Visible = () => <main />\n')
    const afterSourceChange = collect(root)
    expect(afterSourceChange.sourceDigest).not.toBe(afterDesktopChange.sourceDigest)
    expect(afterSourceChange.dirty).toBe(true)

    const manifestPath = join(root, 'plugins/acme.visible/quirky-plugin.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.name = 'Changed manifest contents'
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    expect(collect(root).sourceDigest).not.toBe(afterSourceChange.sourceDigest)
  })

  test('ignores unrelated dirty docs, tests, and build artifacts but includes untracked production source', () => {
    const root = createRepository()
    const baseline = collect(root)
    putFile(root, 'README.md', 'fixture documentation\n')
    putFile(root, 'plugins/acme.visible/build/generated.js', 'generated')
    putFile(root, 'plugins/acme.visible/src/sample.test.tsx', 'test source')
    putFile(root, 'packages/ui/src/tests/helper.ts', 'test helper')
    putFile(root, 'packages/daemon/src/runtime.test.ts', 'test daemon source')
    putFile(root, 'packages/daemon/build/generated.js', 'daemon build output')
    git(root, 'add', '--all')
    git(root, 'commit', '--quiet', '-m', 'unrelated paths fixture')

    putFile(root, 'README.md', 'changed documentation\n')
    putFile(root, 'plugins/acme.visible/build/generated.js', 'changed generated output')
    putFile(root, 'plugins/acme.visible/src/sample.test.tsx', 'changed test source')
    putFile(root, 'packages/ui/src/tests/helper.ts', 'changed test helper')
    putFile(root, 'packages/daemon/src/runtime.test.ts', 'changed test daemon source')
    putFile(root, 'packages/daemon/build/generated.js', 'changed daemon build output')
    const cleanSnapshot = collect(root)
    expect(cleanSnapshot.dirty).toBe(false)
    expect(cleanSnapshot.sourceDigest).toBe(baseline.sourceDigest)

    putFile(root, 'packages/daemon/src/runtime.ts', 'export const runtime = false\n')
    const daemonChange = collect(root)
    expect(daemonChange.dirty).toBe(true)
    expect(daemonChange.sourceDigest).not.toBe(cleanSnapshot.sourceDigest)

    putFile(root, 'plugins/acme.visible/src/untracked.mjs', 'export const production = true\n')
    const inventory = collect(root)
    expect(inventory.dirty).toBe(true)
    expect(inventory.plugins.find(({ id }) => id === 'acme.visible')?.sources.map(({ file }) => file)).toContain(
      'plugins/acme.visible/src/untracked.mjs'
    )
  })

  test('fails when the immediate plugin inventory is empty', () => {
    const inventory = collect(createRepository({ plugins: false }))

    expect(inventory.plugins).toEqual([])
    expect(inventory.failures.length).toBeGreaterThan(0)
  })
})

