import { beforeAll, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { collectInventory } from '../../../../scripts/ui-scoreboard/inventory'
import { auditPlugin } from '../../../../scripts/ui-scoreboard/audit'
import { parseCoverage } from '../../../../scripts/ui-scoreboard/audit-evidence'
import type { CheckResult, CoverageFile, Evidence, Inventory, PluginInventory } from '../../../../scripts/ui-scoreboard/contracts'

const ROOT = 'plugins/quirky.terminal/'
const FRAGMENT = `${ROOT}ui-scoreboard/pane.json`
const FLOATING = 'overlay:quirky.terminal/floating'
const TERMINAL = `${ROOT}src/window/pane/TerminalPaneView.tsx`
const MOBILE = `${ROOT}src/window/pane/MobileDriverOverlay.tsx`
const DOCK = `${ROOT}src/window/dock/DockHost.tsx`
const OWNED = [
  'src/window/pane/TerminalPaneView.tsx',
  'src/window/pane/MobileDriverOverlay.tsx',
  'src/window/pane/SearchBox.tsx',
  'src/window/pane/LinkPopover.tsx',
  'src/window/pane/kittyGraphics.ts',
  'src/window/pane/kittyGraphicsDecoder.ts',
  'src/window/pane/task-links.ts',
  'src/window/pane/appearance.ts',
  'src/window/pane/kitty.ts',
  'src/window/pane/regexSafety.ts',
  'src/window/pane/settings.ts',
  'src/window/pane/commands.ts',
  'src/window/dock/DockHost.tsx'
].map((path) => ROOT + path)
const PASS: Record<string, true> = { 'state-covered': true, 'state-not-applicable': true, 'not-state': true, 'action-routed': true, 'action-transient': true, 'action-not-user': true }
let inventory: Inventory
let plugin: PluginInventory
let coverage: CoverageFile
let checks: CheckResult[]

beforeAll(() => {
  inventory = collectInventory(resolve(import.meta.dir, '../../../..'))
  expect(inventory.failures).toEqual([])
  plugin = inventory.plugins.find((entry) => entry.id === 'quirky.terminal')!
  const fragment = plugin.coverageFragments?.find((entry) => entry.file === FRAGMENT)
  expect(fragment).toBeDefined()
  coverage = parseCoverage(fragment!.content)
  checks = auditPlugin(inventory, plugin)
})

function withCoverage(value: CoverageFile): PluginInventory {
  return {
    ...plugin,
    coverageFragments: plugin.coverageFragments!.map((entry) => entry.file === FRAGMENT ? { ...entry, content: JSON.stringify(value) } : entry)
  }
}

function withSource(sourcePlugin: PluginInventory, file: string, update: (content: string) => string): PluginInventory {
  return {
    ...sourcePlugin,
    sources: sourcePlugin.sources.map((entry) => entry.file === file ? { ...entry, content: update(entry.content) } : entry)
  }
}

function withPlugin(value: PluginInventory): Inventory {
  return { ...inventory, plugins: inventory.plugins.map((entry) => entry.id === value.id ? value : entry) }
}

function failures(evidence: Evidence[]): Evidence[] {
  return evidence.filter((entry) => !PASS[entry.code])
}

function hasState(state: 'loading' | 'error', file: string, component: 'NoticeLine' | 'InlineError', siteText: string, elementText: string): boolean {
  const entry = coverage.states.find((candidate) => candidate.state === state && candidate.site.file === file && candidate.site.quote.includes(siteText) && candidate.render.component === component)
  if (!entry || entry.render.component === 'toast') return false
  if (!entry.render.element.quote.includes(elementText)) return false
  return checks.find((check) => check.id === state)!.evidence.some((evidence) => evidence.code === 'state-covered' && evidence.targetId === FLOATING && evidence.component === component && evidence.source?.file === file)
}

test('pane fragment declares no surfaces and attributes its states to the floating overlay', () => {
  expect(coverage.schemaVersion).toBe(1)
  expect(Object.keys(coverage.surfaces)).toEqual([])
  for (const entry of coverage.states) expect(entry.surface).toBe(FLOATING)
})

test('pane fragment entries and all thirteen owned sources have no audit failures', () => {
  const issues = failures(checks.flatMap((check) => check.evidence))
  expect(issues.filter((entry) => entry.coverageFile === FRAGMENT)).toEqual([])
  expect(issues.filter((entry) => OWNED.includes(entry.source?.file ?? ''))).toEqual([])
})

test('shared state witnesses cover pane, mobile and dock loading and errors', () => {
  expect(hasState('loading', TERMINAL, 'NoticeLine', 'connection.status', 'Connecting terminal…')).toBe(true)
  expect(hasState('error', TERMINAL, 'InlineError', 'connection.status', 'connection.message!')).toBe(true)
  expect(hasState('error', MOBILE, 'InlineError', 'readError', 'message={readError}')).toBe(true)
  expect(hasState('loading', DOCK, 'NoticeLine', 'viewMounted', 'Opening agent composer…')).toBe(true)
  expect(hasState('error', DOCK, 'InlineError', 'hostError', 'Agent composer unavailable:')).toBe(true)
  expect(hasState('error', DOCK, 'InlineError', 'mountError', 'Agent composer unavailable:')).toBe(true)
})

test('replacing a dock InlineError with raw markup invalidates its error witness', () => {
  const state = coverage.states.find((entry) => entry.state === 'error' && entry.site.file === DOCK && entry.site.quote.includes('hostError'))
  expect(state).toBeDefined()
  if (!state || state.render.component !== 'InlineError') throw new Error('dock host error must use InlineError')
  const quote = state.render.element.quote
  expect(quote).toContain('<InlineError')
  const rawMarkup = quote.replace('<InlineError', '<div')
  expect(rawMarkup).not.toBe(quote)
  const mutated = withSource(plugin, DOCK, (content) => content.replace(quote, rawMarkup))
  expect(mutated.sources.find((entry) => entry.file === DOCK)!.content).not.toContain(quote)
  const error = auditPlugin(withPlugin(mutated), mutated).find((check) => check.id === 'error')!
  expect(failures(error.evidence).some((entry) => entry.coverageFile === FRAGMENT)).toBe(true)
})

test('removing mobile Retry coverage exposes the mobile-state route', () => {
  const retry = coverage.actions.find((entry) => 'route' in entry && entry.site.file === MOBILE && entry.route.target === 'quirky.terminal/mobileState')
  expect(retry).toBeDefined()
  const mutated = withCoverage({ ...coverage, actions: coverage.actions.filter((entry) => entry !== retry) })
  const commands = auditPlugin(inventory, mutated).find((check) => check.id === 'commands')!
  expect(commands.evidence.some((entry) => entry.code === 'coverage-missing' && entry.source?.file === MOBILE)).toBe(true)
})

test('undeclaring a pane command descriptor invalidates its routed action', () => {
  const descriptor = coverage.actions.find((entry) => 'route' in entry && entry.site.file === `${ROOT}src/window/pane/commands.ts` && entry.route.target === 'command:quirky.terminal/search')
  expect(descriptor).toBeDefined()
  const target = 'route' in descriptor! ? descriptor.route.target : ''
  const mutated: PluginInventory = {
    ...plugin,
    contributions: {
      ...plugin.contributions!,
      commands: plugin.contributions!.commands.filter((command) => command !== target)
    }
  }
  const commands = auditPlugin(withPlugin(mutated), mutated).find((check) => check.id === 'commands')!
  expect(commands.evidence.some((entry) => entry.code === 'route-undeclared' && entry.coverageFile === FRAGMENT)).toBe(true)
})

