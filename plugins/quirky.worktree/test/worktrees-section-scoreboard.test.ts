import { beforeAll, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { UI_CONTROL_COMMAND } from '../src/ui-control'
import { auditPlugin } from '../../../scripts/ui-scoreboard/audit'
import { parseCoverage } from '../../../scripts/ui-scoreboard/audit-evidence'
import { discoverCandidates, discoverUiFiles } from '../../../scripts/ui-scoreboard/audit-discovery'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import type { CoverageFile, Evidence, Inventory, PluginInventory } from '../../../scripts/ui-scoreboard/contracts'

const FRAGMENT = 'plugins/quirky.worktree/ui-scoreboard/worktrees-section.json'
const FILES = ['WorktreesSection', 'FilterMenu', 'ViewTabs', 'DisplayMenu', 'SaveViewDialog'].map((name) => `plugins/quirky.worktree/src/${name}.tsx`)
const owned: Record<string, true> = Object.fromEntries(FILES.map((file) => [file, true]))
const PASS: Record<string, true> = { 'state-covered': true, 'state-not-applicable': true, 'not-state': true, 'action-routed': true, 'action-transient': true, 'action-not-user': true }
let inventory: Inventory
let plugin: PluginInventory
let coverage: CoverageFile

beforeAll(() => {
  inventory = collectInventory(resolve(import.meta.dir, '../../..'))
  plugin = inventory.plugins.find((entry) => entry.id === 'quirky.worktree')!
  expect(plugin).toBeDefined()
  expect(inventory.failures).toEqual([])
  const graph = discoverUiFiles(plugin)
  expect(graph.failures).toEqual([])
  expect(graph.files.length).toBeGreaterThanOrEqual(55)
  expect(graph.files).toEqual(expect.arrayContaining(FILES))
  const fragment = plugin.coverageFragments?.find(({ file }) => file === FRAGMENT)
  expect(fragment).toBeDefined()
  coverage = parseCoverage(fragment!.content)
})

function subject(value: CoverageFile): PluginInventory {
  return { ...plugin, coverageFragments: plugin.coverageFragments!.map((entry) => entry.file === FRAGMENT ? { ...entry, content: JSON.stringify(value) } : entry) }
}
function evidence(value = coverage): Evidence[] {
  return auditPlugin(inventory, subject(value)).flatMap((check) => check.evidence)
}
function failures(value = coverage): Evidence[] {
  return evidence(value).filter(({ code }) => PASS[code] !== true)
}
function clone(): CoverageFile { return structuredClone(coverage) }
function missingAfter(value: CoverageFile, file: string): boolean {
  return failures(value).some(({ code, source }) => code === 'coverage-missing' && source?.file === file)
}

test('the complete plugin graph has no owned, structural, global or witness failures', () => {
  expect(coverage.schemaVersion).toBe(1)
  expect(coverage.surfaces).toEqual({})
  expect(coverage.states.every(({ surface }) => surface === 'sidebar-section:quirky.worktree/worktrees')).toBe(true)
  for (const entry of [...coverage.states, ...coverage.notState, ...coverage.actions]) expect(owned[entry.site.file]).toBe(true)
  const candidates = discoverCandidates(plugin, discoverUiFiles(plugin).files)
  for (const file of FILES) expect(candidates.some((entry) => entry.file === file)).toBe(true)
  expect(failures().filter(({ code, source, coverageFile }) => code !== 'coverage-missing' || !source || owned[source.file] === true || coverageFile === FRAGMENT)).toEqual([])
})

test('section and tab requests and retained parent methods expose actual public API and CLI routes', () => {
  const routes = evidence().filter(({ code, coverageFile }) => code === 'action-routed' && coverageFile === FRAGMENT)
  expect(routes).toEqual(expect.arrayContaining([expect.objectContaining({ api: 'ui.command.run', cli: `quirky ui run ${UI_CONTROL_COMMAND}` })]))
  for (const file of [FILES[0]!, FILES[2]!]) {
    expect(coverage.actions.some((entry) => entry.site.file === file && 'route' in entry && entry.route.target === UI_CONTROL_COMMAND)).toBe(true)
  }
  const control = coverage.actions.find((entry) => 'route' in entry && entry.route.target === UI_CONTROL_COMMAND)!
  if (!('route' in control)) throw new Error('Missing scoped command route')
  expect(control.route.invoke).toEqual({ file: 'plugins/quirky.worktree/src/ui-control.ts', quote: 'command: UI_CONTROL_COMMAND' })
  for (const target of ['quirky.worktree/set', 'quirky.repo/groupCreate', 'quirky.worktree/remove', 'quirky.worktree/reorder', 'quirky.worktree/reorderProjects']) {
    expect(coverage.actions.some((entry) => 'route' in entry && entry.route.target === target)).toBe(true)
    expect(routes.some(({ api, cli }) => api?.includes(target) && typeof cli === 'string' && cli.startsWith('quirky '))).toBe(true)
  }
  expect(plugin.contributions?.methods).toEqual(expect.arrayContaining(['quirky.worktree/setViews', 'quirky.worktree/setActiveView']))
})

test('removing each shared state family exposes a real candidate', () => {
  for (const state of ['loading', 'empty', 'error'] as const) {
    const index = coverage.states.findIndex((entry) => entry.state === state && entry.render.component !== 'toast')
    expect(index).toBeGreaterThanOrEqual(0)
    const value = clone()
    const [removed] = value.states.splice(index, 1)
    expect(missingAfter(value, removed!.site.file)).toBe(true)
  }
})

test('removing advisory, decisive parent and tab-menu coverage exposes their candidates', () => {
  const advisory = coverage.notState.findIndex((entry) => /Changed|Filtered|cleanupCount|hidden/.test(entry.site.quote))
  expect(advisory).toBeGreaterThanOrEqual(0)
  const value = clone()
  const [removed] = value.notState.splice(advisory, 1)
  expect(missingAfter(value, removed!.site.file)).toBe(true)
  for (const file of [FILES[0]!, FILES[2]!]) {
    const index = coverage.actions.findIndex((entry) => entry.site.file === file && 'route' in entry && entry.route.target === UI_CONTROL_COMMAND && /onClick|onClose|onAction|onOpen/.test(entry.site.quote))
    expect(index).toBeGreaterThanOrEqual(0)
    const changed = clone()
    changed.actions.splice(index, 1)
    expect(missingAfter(changed, file)).toBe(true)
  }
})

test('wrong render families and undeclared commands cannot serve as witnesses', () => {
  for (const [state, replacement] of [['loading', 'InlineError'], ['error', 'EmptyState']] as const) {
    const value = clone()
    const entry = value.states.find((entry) => entry.state === state && entry.render.component !== 'toast')!
    expect(entry).toBeDefined()
    entry.render = { ...entry.render, component: replacement } as typeof entry.render
    expect(failures(value).some(({ code }) => code === 'render-not-accepted')).toBe(true)
  }
  const value = clone()
  const entry = value.actions.find((entry) => 'route' in entry && entry.route.target === UI_CONTROL_COMMAND)!
  if (!('route' in entry)) throw new Error('Missing scoped command route')
  entry.route.target = 'command:quirky.worktree/not-declared'
  expect(failures(value).some(({ code }) => code === 'route-target-changed')).toBe(true)
})
