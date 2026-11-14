import { beforeAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { auditPlugin } from '../../../scripts/ui-scoreboard/audit'
import { discoverCandidates, discoverUiFiles } from '../../../scripts/ui-scoreboard/audit-discovery'
import { parseCoverage } from '../../../scripts/ui-scoreboard/audit-evidence'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import { checkPlugin } from '../../../scripts/ui-scoreboard/tokens'
import { checkRatchet, parseRatchetConfig } from '../../../scripts/ui-scoreboard/ratchet'
import type { CoverageFile, Inventory, PluginInventory, StateKind } from '../../../scripts/ui-scoreboard/contracts'

const root = resolve(import.meta.dir, '../../..')
const pluginId = 'quirky.accounts'
const directory = `plugins/${pluginId}`
const usagePath = `${directory}/src/window/Usage.tsx`
const fragmentPath = `${directory}/ui-scoreboard/usage.json`
const settingsSurface = 'view:quirky.accounts/settings'
const usageSurface = 'status-bar:quirky.accounts/usage'
const accessorySurface = 'view:quirky.accounts/session-accessory'
const dialogSurface = 'overlay:quirky.accounts/switch-dialog'
const passCodes: Record<string, true> = { 'state-covered': true, 'state-not-applicable': true, 'not-state': true, 'action-routed': true, 'action-transient': true, 'action-not-user': true }
let inventory: Inventory
let plugin: PluginInventory
const enrollment = parseRatchetConfig(readFileSync(resolve(root, 'scripts/ui-scoreboard-ratchet.json'), 'utf8'))

beforeAll(() => {
  inventory = collectInventory(root)
  plugin = inventory.plugins.find(({ id }) => id === pluginId)!
  expect(plugin).toBeDefined()
})

function fragment(target: PluginInventory = plugin): CoverageFile {
  const source = target.coverageFragments?.find(({ file }) => file === fragmentPath)
  expect(source).toBeDefined()
  return parseCoverage(source!.content)
}

function mutatedCoverage(change: (coverage: CoverageFile) => void) {
  const copy = structuredClone(inventory)
  const target = copy.plugins.find(({ id }) => id === pluginId)!
  const coverage = fragment(target)
  change(coverage)
  target.coverageFragments!.find(({ file }) => file === fragmentPath)!.content = JSON.stringify(coverage)
  return { inventory: copy, plugin: target }
}

function expectRegression(copy: Inventory, ids: readonly (StateKind | 'commands')[], code: string, evidenceFile: string) {
  const checks = checkPlugin(copy, pluginId)
  const ratchet = checkRatchet(copy, { [pluginId]: enrollment[pluginId]! })
  expect(ratchet.exitCode).toBe(1)
  for (const check of ids) {
    const result = checks.find(({ id }) => id === check)!
    expect(result.status).toBe('fail')
    expect(result.evidence.some((entry) => entry.code === code && (
      entry.source?.file === evidenceFile || entry.coverageFile === evidenceFile
    ))).toBe(true)
    expect(ratchet.failures.some((entry) => entry.code === code && entry.message.startsWith(`${pluginId} / ${check}:`))).toBe(true)
  }
}

test('the complete Accounts plugin passes all five static checks', () => {
  const checks = checkPlugin(inventory, 'quirky.accounts')
  expect(checks.map(({ id, status, applicable }) => ({ id, status, applicable }))).toEqual([
    { id: 'compatibility-tokens', status: 'pass', applicable: true },
    { id: 'loading', status: 'pass', applicable: true },
    { id: 'empty', status: 'pass', applicable: true },
    { id: 'error', status: 'pass', applicable: true },
    { id: 'commands', status: 'pass', applicable: true },
  ])
})

test('Usage owns three surfaces and scopes every candidate to Usage.tsx', () => {
  const coverage = fragment()
  expect(coverage.schemaVersion).toBe(1)
  expect(Object.keys(coverage).sort()).toEqual(['actions', 'notState', 'schemaVersion', 'states', 'surfaces'])
  expect(Object.keys(coverage.surfaces).sort()).toEqual([dialogSurface, usageSurface, accessorySurface].sort())
  expect(coverage.surfaces[settingsSurface]).toBeUndefined()
  expect(coverage.surfaces[usageSurface]).toEqual({
    loading: { applicable: true }, empty: { applicable: true }, error: { applicable: true },
  })
  for (const surface of [accessorySurface, dialogSurface]) {
    const decisions = coverage.surfaces[surface]!
    expect(decisions.loading).toEqual({ applicable: true })
    expect(decisions.error).toEqual({ applicable: true })
    expect(decisions.empty.applicable).toBe(false)
    if (decisions.empty.applicable) throw new Error('Expected an unmounted empty surface')
    expect(decisions.empty.reason.trim()).not.toBe('')
    expect(decisions.empty.evidence.length).toBeGreaterThan(0)
    for (const reference of decisions.empty.evidence) {
      expect(reference.file).toBe(usagePath)
      expect(plugin.sources.find(({ file }) => file === reference.file)!.content).toContain(reference.quote)
    }
    expect(decisions.empty.evidence.some(({ quote }) => quote.includes('return null'))).toBe(true)
  }
  for (const entry of [...coverage.states, ...coverage.notState, ...coverage.actions]) {
    expect(entry.site.file).toBe(usagePath)
  }
  for (const entry of coverage.states) {
    expect([usageSurface, accessorySurface, dialogSurface, settingsSurface]).toContain(entry.surface)
  }
  const candidates = discoverCandidates(plugin, discoverUiFiles(plugin).files)
  expect(candidates.some(({ file, category }) => file === usagePath && category === 'state')).toBe(true)
  expect(candidates.some(({ file, category }) => file === usagePath && category === 'action')).toBe(true)
})

test('combined fragments retain bounded UI discovery and state and route witnesses', () => {
  expect(inventory.failures.filter((entry) =>
    entry.message.includes(pluginId) || entry.source?.file.startsWith(`${directory}/`),
  )).toEqual([])
  const graph = discoverUiFiles(plugin)
  expect(graph.failures).toEqual([])
  expect(graph.files.filter((file) => file.startsWith(`${directory}/src/usage/`))).toEqual([
    `${directory}/src/usage/types.ts`,
  ])
  expect(plugin.coverageFragments!.map(({ file }) => file)).toContain(`${directory}/ui-scoreboard/accounts-settings.json`)
  expect(plugin.coverageFragments!.map(({ file }) => file)).toContain(fragmentPath)
  const checks = auditPlugin(inventory, plugin)
  expect(checks.flatMap(({ evidence }) => evidence).filter(({ code }) => !passCodes[code])).toEqual([])
  for (const surface of [usageSurface, accessorySurface, dialogSurface]) {
    for (const state of ['loading', 'empty', 'error'] as const) {
      const code = state === 'empty' && surface !== usageSurface ? 'state-not-applicable' : 'state-covered'
      expect(checks.find(({ id }) => id === state)!.evidence.some((entry) =>
        entry.code === code && entry.targetId === surface && entry.coverageFile === fragmentPath,
      )).toBe(true)
    }
  }
  const routes = [
    'command:quirky.accounts/select-account', 'command:quirky.accounts/refresh',
    'quirky.accounts/setUiState', 'quirky.accounts/setPreferences',
    'quirky.accounts/keep', 'quirky.accounts/restart', 'quirky.accounts/consumeResetCredit',
    settingsSurface,
  ]
  const commands = checks.find(({ id }) => id === 'commands')!
  const coverage = fragment()
  for (const route of routes) {
    expect(coverage.actions.some((entry) => 'route' in entry && entry.route.target === route)).toBe(true)
    expect(commands.evidence.some((entry) => entry.code === 'action-routed' &&
      entry.message === `Action routes through ${route}` && entry.coverageFile === fragmentPath,
    )).toBe(true)
  }
})

test('Accounts is enrolled in all five checks', () => {
  expect(enrollment[pluginId]).toEqual(['commands', 'compatibility-tokens', 'empty', 'error', 'loading'])
})

test.each(Object.entries(enrollment).flatMap(([id, checks]) => checks.map((check) => [id, check] as const)))(
  'the static ratchet passes for %s / %s',
  (id, check) => {
    expect(checkRatchet(inventory, { [id]: [check] })).toEqual({ exitCode: 0, failures: [] })
  },
  60_000,
)

test('a removed Usage state fails its state check and the ratchet', () => {
  const coverage = fragment()
  const removed = coverage.states[0]!
  const copy = mutatedCoverage((value) => { value.states.shift() })
  expectRegression(copy.inventory, [removed.state], 'coverage-missing', usagePath)
}, 60_000)

test('a removed decisive Usage action fails commands and the ratchet', () => {
  const copy = mutatedCoverage((coverage) => {
    const index = coverage.actions.findIndex((entry) => 'route' in entry)
    expect(index).toBeGreaterThanOrEqual(0)
    coverage.actions.splice(index, 1)
  })
  expectRegression(copy.inventory, ['commands'], 'coverage-missing', usagePath)
}, 60_000)

test('replacing a witnessed shared render with raw markup fails the ratchet', () => {
  const copy = structuredClone(inventory)
  const target = copy.plugins.find(({ id }) => id === pluginId)!
  const entry = fragment(target).states.find(({ render }) => render.component !== 'toast')!
  if (entry.render.component === 'toast') throw new Error('Expected a shared component')
  const source = target.sources.find(({ file }) => file === usagePath)!
  expect(source.content).toContain(entry.render.element.quote)
  source.content = source.content.replace(entry.render.element.quote, '<p>Usage unavailable</p>')
  expectRegression(copy, [entry.state], 'evidence-missing', fragmentPath)
}, 60_000)

test('a broken public route witness fails commands and the ratchet', () => {
  const copy = mutatedCoverage((coverage) => {
    const entry = coverage.actions.find((entry) => 'route' in entry)!
    if (!('route' in entry)) throw new Error('Expected a routed action')
    entry.route.invoke.quote += ' missing route witness'
  })
  expectRegression(copy.inventory, ['commands'], 'evidence-missing', fragmentPath)
}, 60_000)

test('redeclaring Settings in the Usage fragment fails every state ratchet', () => {
  const copy = mutatedCoverage((coverage) => {
    coverage.surfaces[settingsSurface] = {
      loading: { applicable: true }, empty: { applicable: true }, error: { applicable: true },
    }
  })
  expectRegression(copy.inventory, ['loading', 'empty', 'error'], 'coverage-surface-duplicate', fragmentPath)
}, 60_000)
