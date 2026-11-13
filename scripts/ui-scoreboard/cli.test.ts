import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runUiScoreboard, type SignalSource } from '../ui-scoreboard'
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

test('help and malformed arguments perform no filesystem or runtime work', async () => {
  const forbidden = () => { throw new Error('side effect') }
  const help: string[] = []
  expect(await runUiScoreboard(['--help'], { ...quiet, stdout: (text) => help.push(text), collectInventory: forbidden, mkdir: forbidden })).toBe(0)
  expect(help.join('\n')).toContain("source audit read from each plugin's ui-scoreboard.json")
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

test('daemon-only plugins keep screenshot checks non-applicable', async () => {
  const { inventory, output } = fixture()
  inventory.plugins[0]!.hasUi = false
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
