import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runUiScoreboard, type SignalSource } from '../ui-scoreboard'
import { SCORE_DIMENSIONS, type CaptureManifest, type ModelFamily, type ReviewReport } from '../ui-review/contracts'
import { collectInventory } from './inventory'
import type { Inventory, ScoreboardReport } from './contracts'

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'scoreboard-cli-')); roots.push(root)
  const inventory: Inventory = {
    repoRoot: root, commit: 'fixture', sourceDigest: 'digest', dirty: false,
    plugins: [{ id: 'acme.ui', directory: 'plugins/acme.ui', hasUi: true, targets: ['view'], sources: [{ file: 'plugins/acme.ui/src/ui.tsx', content: '"--compat-px-40"' }] }],
    targets: [{ id: 'view', plugin: 'acme.ui', title: 'View', kind: 'view' }], sharedSources: [], failures: [],
    exclusions: [{ plugin: 'quirky.avatar', reason: 'paused-unmerged', branch: 'zpyoung/avatar-plugin', pr: 305, steerDate: '2026-11-13' }],
  }
  return { root, inventory, output: join(root, 'output') }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const quiet = { stdout: (_: string) => {}, stderr: (_: string) => {} }
function report(output: string): ScoreboardReport { return JSON.parse(readFileSync(join(output, 'scoreboard.json'), 'utf8')) }

function fixtureFile(root: string, path: string, content: string): void {
  const fullPath = join(root, path)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, content)
}

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: root,
      QUIRKY_HOME: root,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Scoreboard CLI fixture',
      GIT_AUTHOR_EMAIL: 'scoreboard@example.invalid',
      GIT_COMMITTER_NAME: 'Scoreboard CLI fixture',
      GIT_COMMITTER_EMAIL: 'scoreboard@example.invalid',
    },
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}
function manyActionInventory(inventory: Inventory): Inventory {
  const file = 'plugins/acme.ui/src/ui.tsx'
  const invoke = "context.call('acme.ui/save', {})"
  const extraActions = Array.from({ length: 26 }, (_, index) =>
    `  <button onClick={() => doAction(${index})}>Action ${index}</button>`,
  ).join('\n')
  const content = `export function Main() {
  return <>
    <button onClick={() => ${invoke}}>Save</button>
${extraActions}
  </>
}`
  const noState = {
    applicable: false,
    reason: 'This view has no state branches.',
    evidence: [{ file, quote: 'export function Main' }],
  }
  const coverage = {
    schemaVersion: 1,
    surfaces: {
      'view:acme.ui/main': { loading: noState, empty: noState, error: noState },
    },
    states: [],
    notState: [],
    actions: [{
      site: { file, quote: `onClick={() => ${invoke}}` },
      route: { invoke: { file, quote: invoke }, target: 'acme.ui/save' },
    }],
  }
  const plugin = inventory.plugins[0]!
  plugin.targets = ['view:acme.ui/main']
  plugin.sources = [{ file, content }]
  plugin.contributions = {
    methods: ['acme.ui/save'], commands: [],
    cliCommands: [{ id: 'save', words: 'save', methods: ['acme.ui/save'] }],
  }
  plugin.coverage = { file: 'plugins/acme.ui/ui-scoreboard.json', content: JSON.stringify(coverage) }
  return inventory
}

function pluginModeInventory(baseInventory: Inventory): Inventory {
  const repoRoot = join(baseInventory.repoRoot, 'repo')
  const file = 'plugins/acme.ui/src/ui.tsx'
  const importLine = "import { EmptyState, InlineError } from '@quirky/ui'"
  const source = `${importLine}
export function Main({ status }: { status: string }) {
  if (status === 'busy') return <EmptyState message="Loading items" />
  if (status === 'none') return <EmptyState message="No items yet" />
  if (status === 'bad') return <InlineError message="Could not load" />
  return <button onClick={() => context.call('acme.ui/save', {})}>Save</button>
}`
  const quote = (value: string) => ({ file, quote: value })
  const coverage = {
    schemaVersion: 1,
    surfaces: {
      'view:acme.ui/main': {
        loading: { applicable: true },
        empty: { applicable: true },
        error: { applicable: true },
      },
    },
    states: [
      {
        surface: 'view:acme.ui/main', state: 'loading',
        site: quote("if (status === 'busy')"),
        render: { component: 'EmptyState', element: quote('<EmptyState message="Loading items" />'), import: quote(importLine) },
      },
      {
        surface: 'view:acme.ui/main', state: 'empty',
        site: quote("if (status === 'none')"),
        render: { component: 'EmptyState', element: quote('<EmptyState message="No items yet" />'), import: quote(importLine) },
      },
      {
        surface: 'view:acme.ui/main', state: 'error',
        site: quote("if (status === 'bad')"),
        render: { component: 'InlineError', element: quote('<InlineError message="Could not load" />'), import: quote(importLine) },
      },
    ],
    notState: [],
    actions: [{
      site: quote('onClick'),
      route: { invoke: quote("context.call('acme.ui/save', {})"), target: 'acme.ui/save' },
    }],
  }
  fixtureFile(repoRoot, 'plugins/acme.ui/quirky-plugin.json', JSON.stringify({
    id: 'acme.ui',
    name: 'Acme UI',
    ui: 'src/ui.tsx',
    contributes: { view: [{ id: 'view', title: 'View' }] },
  }))
  fixtureFile(repoRoot, file, source)
  fixtureFile(repoRoot, 'plugins/acme.ui/ui-scoreboard.json', JSON.stringify(coverage))
  fixtureFile(repoRoot, 'packages/ui/src/styles.css', ':root { color: var(--ui-text-primary); }\n')
  fixtureFile(repoRoot, 'packages/ui/src/design-system/compatibility-tokens.css', ':root { --compat-px-40: 40px; }\n')
  fixtureFile(repoRoot, 'packages/daemon/src/runtime.ts', 'export const runtime = true\n')
  fixtureFile(repoRoot, 'apps/desktop/src/main.ts', 'export const desktop = true\n')
  git(repoRoot, 'init', '--quiet')
  git(repoRoot, 'add', '--all')
  git(repoRoot, 'commit', '--quiet', '-m', 'CLI plugin fixture')
  const inventory = collectInventory(repoRoot)
  const selected = inventory.plugins[0]!
  selected.targets = ['view:acme.ui/main']
  selected.sources = [{ file, content: source }]
  selected.coverage = { file: 'plugins/acme.ui/ui-scoreboard.json', content: JSON.stringify(coverage) }
  selected.contributions = {
    methods: ['acme.ui/save', 'acme.ui/load'],
    commands: ['command:acme.ui/refresh'],
    cliCommands: [{ id: 'save', words: 'save', methods: ['acme.ui/save'] }],
  }
  inventory.plugins.push(
    { id: 'acme.other', directory: 'plugins/acme.other', hasUi: false, targets: ['view:acme.other/main'], sources: [] },
    { id: 'acme.palette', directory: 'plugins/acme.palette', hasUi: true, targets: [], sources: [] },
  )
  inventory.targets = [
    { id: 'view:acme.ui/main', plugin: 'acme.ui', title: 'Main', kind: 'view' },
    { id: 'view:acme.other/main', plugin: 'acme.other', title: 'Other', kind: 'view' },
    { id: 'host:shell', plugin: null, title: 'Shell', kind: 'host' },
  ]
  return inventory
}

function pluginManifest(inventory: Inventory, pluginId: string): CaptureManifest {
  const targets = inventory.targets.filter((target) => target.plugin === pluginId)
  const captures = targets.flatMap((target) => (['dark', 'light'] as const).map((theme) => ({
    targetId: target.id,
    theme,
    image: { path: `/captures/${target.id}-${theme}.png`, sha256: (theme === 'dark' ? 'a' : 'b').repeat(64) },
    reference: { path: `/goldens/${theme}.png`, sha256: (theme === 'dark' ? 'c' : 'd').repeat(64) },
    status: 'captured' as const,
  })))
  return {
    schemaVersion: 1, createdAt: '2026-11-13T00:00:00.000Z', commit: inventory.commit,
    surface: 'desktop-renderer', viewport: { width: 1280, height: 800 },
    scope: 'filtered', selectors: [pluginId], targets, captures, failures: [],
  }
}

function passingPluginReview(manifest: CaptureManifest, reviewerAlias: string, authorFamily: ModelFamily): ReviewReport {
  return {
    schemaVersion: 1, createdAt: '2026-11-13T00:00:00.000Z', status: 'passed',
    scope: manifest.scope, threshold: 85, authorFamily, reviewerAlias,
    captures: manifest.captures.map((capture) => ({
      targetId: capture.targetId, theme: capture.theme, image: capture.image!, reference: capture.reference,
      reviewer: { alias: reviewerAlias, provider: 'fixture', model: 'fixture-reviewer', family: authorFamily },
      assessment: {
        targetVisible: true, imagesRead: true, reasons: [],
        scores: Object.fromEntries(SCORE_DIMENSIONS.map((dimension) => [dimension, 85])) as Record<typeof SCORE_DIMENSIONS[number], number>,
      },
      score: 85, passed: true,
    })),
    failures: [],
  }
}

test('plugin mode captures and reports only the selected plugin without certifying the full goal', async () => {
  const { inventory: base, output } = fixture()
  const inventory = pluginModeInventory(base)
  let captureOnly: string[] | undefined
  const exit = await runUiScoreboard(['--plugin', 'acme.ui', '--author-family', 'openai', '--output', output], {
    ...quiet,
    collectInventory: () => inventory,
    captureApplication: async (options) => {
      captureOnly = options.only
      return pluginManifest(inventory, 'acme.ui')
    },
    reviewManifest: async (manifest, options) => passingPluginReview(manifest, options.reviewerAlias, options.authorFamily),
  })

  expect(exit).toBe(0)
  expect(captureOnly).toEqual(['acme.ui'])
  const value = report(output)
  expect(value).toMatchObject({ mode: 'plugin', plugin: 'acme.ui', status: 'passed', goalPassed: false })
  expect(value.plugins.map((plugin) => plugin.id)).toEqual(['acme.ui'])
  expect(value.host).toEqual({ checks: [], targets: [] })
  expect(value.cells.map((cell) => [cell.plugin, cell.targetId, cell.theme])).toEqual([
    ['acme.ui', 'view:acme.ui/main', 'dark'],
    ['acme.ui', 'view:acme.ui/main', 'light'],
  ])
  const markdown = readFileSync(join(output, 'scoreboard.md'), 'utf8')
  expect(markdown).toContain('Mode: plugin (acme.ui).')
  expect(markdown).not.toContain('| host |')
  expect(markdown).not.toContain('acme.other')
})

test('plugin arguments reject duplicates, missing values, incompatible modes, and missing requirements', async () => {
  const forbidden = () => { throw new Error('side effect') }
  for (const args of [
    ['--plugin'],
    ['--plugin', 'acme.ui', '--plugin', 'acme.ui', '--author-family', 'openai', '--output', '/tmp/no'],
    ['--plugin', 'acme.ui', '--help'],
    ['--plugin', 'acme.ui', '--check-ratchet'],
    ['--plugin', 'acme.ui', '--static-only', '--output', '/tmp/no'],
    ['--plugin', 'acme.ui', '--output', '/tmp/no'],
    ['--plugin', 'acme.ui', '--author-family', 'openai'],
  ]) {
    expect(await runUiScoreboard(args, { ...quiet, collectInventory: forbidden, mkdir: forbidden })).toBe(2)
  }
})

test('plugin mode rejects unknown and zero-target plugins before capture', async () => {
  const { inventory: base, root } = fixture()
  const inventory = pluginModeInventory(base)
  let captureStarted = false
  for (const [pluginId, output, expected] of [
    ['acme.missing', join(root, 'unknown-output'), 'Unknown plugin: acme.missing'],
    ['acme.palette', join(root, 'zero-output'), 'Plugin acme.palette has no declared capture targets'],
  ]) {
    const errors: string[] = []
    expect(await runUiScoreboard(['--plugin', pluginId, '--author-family', 'openai', '--output', output], {
      ...quiet,
      collectInventory: () => inventory,
      captureApplication: async () => { captureStarted = true; throw new Error('capture should not start') },
      stderr: (text) => errors.push(text),
    })).toBe(2)
    expect(errors.join('\\n')).toContain(expected)
  }
  expect(captureStarted).toBe(false)
})

test('help and malformed arguments perform no filesystem or runtime work', async () => {
  const forbidden = () => { throw new Error('side effect') }
  const help: string[] = []
  expect(await runUiScoreboard(['--help'], { ...quiet, stdout: (text) => help.push(text), collectInventory: forbidden, mkdir: forbidden })).toBe(0)
  expect(help.join('\\n')).toContain("source audit read from each plugin's ui-scoreboard.json")
  expect(help.join('\\n')).toContain('[--plugin <id>]')
  expect(help.join('\\n')).toContain('never sets goalPassed: true')
  for (const args of [[], ['--wat'], ['--help', '--help'], ['--static-only', '--output', 'relative'], ['--check-ratchet', '--output', '/tmp/no'], ['--static-only', '--author-family', 'openai', '--output', '/tmp/no'], ['--author-family', 'no', '--output', '/tmp/no'], ['--static-only', '--output', '/tmp/no', '--output', '/tmp/no']]) {
    expect(await runUiScoreboard(args, { ...quiet, collectInventory: forbidden, mkdir: forbidden })).toBe(2)
  }
})
test('static-only writes complete honest reports and never starts runtime', async () => {
  const { inventory, output } = fixture(); const messages: string[] = []
  const forbidden = async () => { throw new Error('runtime called') }
  expect(await runUiScoreboard(['--', '--static-only', '--output', output], {
    ...quiet, collectInventory: () => inventory, captureApplication: forbidden, reviewManifest: forbidden, stdout: (text) => messages.push(text),
  })).toBe(1)
  const value = report(output)
  expect(value).toMatchObject({ mode: 'static-only', goalPassed: false, status: 'failed', sourceDigest: 'digest', threshold: 85 })
  expect(value.plugins[0]!.checks).toHaveLength(6)
  expect(value.plugins[0]!.checks.find((check) => check.id === 'commands')).toMatchObject({ status: 'fail', reason: 'coverage-file-missing' })
  expect(value.cells.map((cell) => [cell.theme, cell.code, cell.score])).toEqual([['dark', 'not-run', null], ['light', 'not-run', null]])
  expect(readFileSync(join(output, 'scoreboard.md'), 'utf8')).toContain('--compat-px-40')
  expect(messages.join('\n')).toContain(join(output, 'scoreboard.json'))
  expect(messages.join('\n')).toContain(join(output, 'scoreboard.md'))
})
test('Markdown caps failed source-audit evidence and JSON retains all evidence', async () => {
  const { output, inventory } = fixture()
  expect(await runUiScoreboard(['--static-only', '--output', output], {
    ...quiet, collectInventory: () => manyActionInventory(inventory),
  })).toBe(1)

  const value = report(output)
  const commands = value.plugins[0]!.checks.find((check) => check.id === 'commands')!
  expect(commands.evidence).toHaveLength(27)
  expect(commands.evidence.some((item) => item.code === 'action-routed')).toBe(true)

  const markdown = readFileSync(join(output, 'scoreboard.md'), 'utf8')
  const section = markdown.split('### acme.ui: commands\n')[1]!.split('\n\n### ')[0]!
  expect(section.split('\n').filter((line) => line.startsWith('- coverage-missing:'))).toHaveLength(25)
  expect(section).toContain('… and 1 more in scoreboard.json')
  expect(section).not.toContain('action-routed')
  const json = JSON.parse(readFileSync(join(output, 'scoreboard.json'), 'utf8')) as ScoreboardReport
  const storedCommands = json.plugins[0]!.checks.find((check) => check.id === 'commands')!
  expect(storedCommands.evidence).toHaveLength(27)
  expect(storedCommands.evidence.some((item) => item.code === 'action-routed')).toBe(true)
})

test('render contributions keep screenshots applicable in static-only mode without a UI module', async () => {
  const { inventory, output } = fixture()
  inventory.plugins[0]!.hasUi = false

  expect(await runUiScoreboard(['--static-only', '--output', output], { ...quiet, collectInventory: () => inventory })).toBe(1)
  expect(report(output).plugins[0]!.checks.find((check) => check.id === 'screenshots'))
    .toMatchObject({ applicable: true, status: 'fail', reason: 'image-checks-failed' })
})

test('render contributions keep failed full screenshot measurement applicable without a UI module', async () => {
  const { inventory, output } = fixture()
  inventory.plugins[0]!.hasUi = false
  let captureStarted = false

  expect(await runUiScoreboard(['--author-family', 'openai', '--output', output], {
    ...quiet,
    collectInventory: () => inventory,
    captureApplication: async () => {
      captureStarted = true
      throw new Error('Chromium missing')
    },
  })).toBe(2)
  expect(captureStarted).toBe(true)
  expect(report(output).plugins[0]!.checks.find((check) => check.id === 'screenshots'))
    .toMatchObject({ applicable: true, status: 'fail', reason: 'image-checks-failed' })
})

test('UI plugins with no declared capture targets rate screenshots as not applicable', async () => {
  const { inventory, output } = fixture()
  inventory.plugins[0]!.hasUi = true
  inventory.plugins[0]!.targets = []
  inventory.targets = []

  expect(await runUiScoreboard(['--static-only', '--output', output], { ...quiet, collectInventory: () => inventory })).toBe(1)
  expect(report(output).plugins[0]!.checks.find((check) => check.id === 'screenshots'))
    .toMatchObject({ applicable: false, status: 'pass', reason: 'no-ui-surface' })
})

test('existing output is never overwritten, including files', async () => {
  const { output, inventory } = fixture(); mkdirSync(output); writeFileSync(join(output, 'keep'), 'owner')
  expect(await runUiScoreboard(['--static-only', '--output', output], { ...quiet, collectInventory: () => inventory })).toBe(2)
  expect(readFileSync(join(output, 'keep'), 'utf8')).toBe('owner')
  expect(existsSync(join(output, 'scoreboard.json'))).toBe(false)
})
test('full mode attempts capture despite static debt and preserves operational failures', async () => {
  const { inventory, output } = fixture(); let called = false
  const exit = await runUiScoreboard(['--author-family', 'openai', '--output', output], {
    ...quiet, collectInventory: () => inventory,
    captureApplication: async () => { called = true; throw new Error('Chromium missing') },
  })
  expect(called).toBe(true); expect(exit).toBe(2)
  expect(report(output)).toMatchObject({ status: 'error', goalPassed: false })
  expect(report(output).plugins[0]!.checks[0]!.status).toBe('fail')
})
test('inventory failures block capture but preserve every plugin and failure', async () => {
  const { inventory, output } = fixture(); inventory.failures.push({ code: 'paused-plugin-present', message: 'avatar present' })
  let called = false
  expect(await runUiScoreboard(['--author-family', 'openai', '--output', output], { ...quiet, collectInventory: () => inventory, captureApplication: async () => { called = true; throw new Error('unexpected') } })).toBe(2)
  expect(called).toBe(false); expect(report(output).failures[0]!.code).toBe('paused-plugin-present')
  expect(report(output).plugins.map((plugin) => plugin.id)).toEqual(['acme.ui'])
})
test('signals abort owned work, await cleanup, preserve report and remove listeners', async () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const { inventory, output } = fixture(); const listeners = new Map<string, () => void>(); let cleaned = false
    const signals: SignalSource = { on: (name, fn) => { listeners.set(name, fn) }, off: (name) => { listeners.delete(name) } }
    const exit = await runUiScoreboard(['--author-family', 'openai', '--output', output], {
      ...quiet, collectInventory: () => inventory, signals,
      captureApplication: async (options) => {
        const { promise: aborted, resolve: done } = Promise.withResolvers<void>()
        options.signal!.addEventListener('abort', () => { cleaned = true; done() }, { once: true })
        listeners.get(signal)!(); await aborted; throw new Error('cancelled')
      },
    })
    expect(exit).toBe(signal === 'SIGINT' ? 130 : 143); expect(cleaned).toBe(true); expect(listeners.size).toBe(0)
    expect(report(output).goalPassed).toBe(false)
  }
})
test('real checkout inventory count is discovered rather than pinned', async () => {
  const { output } = fixture()
  expect(await runUiScoreboard(['--static-only', '--output', output], { ...quiet, repoRoot: resolve(import.meta.dir, '../..') })).toBe(1)
  const value = report(output); console.log(`Discovered ${value.plugins.length} immediate plugins`)
  expect(value.plugins.some((plugin) => plugin.id === 'quirky.session')).toBe(true)
  expect(value.host.targets).toEqual(['host:palette', 'host:popups', 'host:scoped', 'host:settings', 'host:shell'])
}, 30_000)

test('ratchet CLI starts no runtime and creates no reports', async () => {
  const { root, inventory } = fixture(); const messages: string[] = []
  const forbidden = async () => { throw new Error('unexpected runtime or output') }
  const exit = await runUiScoreboard(['--check-ratchet'], {
    ...quiet, repoRoot: root, collectInventory: () => inventory, readFile: async () => '{}',
    mkdir: forbidden, writeFile: forbidden, captureApplication: forbidden, reviewManifest: forbidden,
    stdout: (text) => messages.push(text),
  })
  expect(exit).toBe(0)
  expect(messages).toEqual(['Static ratchet: passed'])
  expect(existsSync(join(root, 'scoreboard.json'))).toBe(false)
})

test('report rows use canonical lexical order rather than locale collation', async () => {
  const { inventory, output } = fixture()
  inventory.plugins = ['acme.a', 'acme.Z'].map((id) => ({ id, directory: `plugins/${id}`, hasUi: false, targets: [], sources: [] }))
  inventory.targets = []
  expect(await runUiScoreboard(['--static-only', '--output', output], { ...quiet, collectInventory: () => inventory })).toBe(1)
  expect(report(output).plugins.map((plugin) => plugin.id)).toEqual(['acme.Z', 'acme.a'])
})
