import { beforeAll, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { discoverCandidates, discoverUiFiles } from '../../../scripts/ui-scoreboard/audit-discovery'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import type { Inventory, PluginInventory } from '../../../scripts/ui-scoreboard/contracts'
import { auditPlugin } from '../../../scripts/ui-scoreboard/audit'
import { parseCoverage } from '../../../scripts/ui-scoreboard/audit-evidence'
import { checkPlugin } from '../../../scripts/ui-scoreboard/tokens'
import type { CoverageFile } from '../../../scripts/ui-scoreboard/contracts'

const root = resolve(import.meta.dir, '../../..')
const directory = 'plugins/quirky.accounts'
const owned: Record<string, true> = {
  [`${directory}/src/window/AccountsSettings.tsx`]: true,
  [`${directory}/src/window/model.ts`]: true,
  [`${directory}/src/ui.tsx`]: true,
}
let inventory: Inventory
let plugin: PluginInventory

beforeAll(() => {
  inventory = collectInventory(root)
  plugin = inventory.plugins.find(({ id }) => id === 'quirky.accounts')!
  expect(plugin).toBeDefined()
})

test('Accounts UI discovery never reaches daemon usage implementations', () => {
  expect(inventory.failures.filter((failure) =>
    failure.message.includes('quirky.accounts') || failure.source?.file.startsWith(`${directory}/`),
  )).toEqual([])
  const graph = discoverUiFiles(plugin)
  expect(graph.failures).toEqual([])
  expect(graph.files.filter((file) => file.startsWith(`${directory}/src/usage/`))).toEqual([
    `${directory}/src/usage/types.ts`,
  ])
  expect(discoverCandidates(plugin, graph.files).filter((candidate) =>
    owned[candidate.file] && candidate.kind === 'unresolved-assignment',
  )).toEqual([])
})

const fragmentPath = `${directory}/ui-scoreboard/accounts-settings.json`
const settingsSurface = 'view:quirky.accounts/settings'
const usageSurfaces = ['status-bar:quirky.accounts/usage', 'view:quirky.accounts/session-accessory', 'overlay:quirky.accounts/switch-dialog']
const passCodes: Record<string, true> = { 'state-covered': true, 'state-not-applicable': true, 'not-state': true, 'action-routed': true, 'action-transient': true, 'action-not-user': true }

function fragment(target: PluginInventory = plugin): CoverageFile {
  const source = target.coverageFragments?.find(({ file }) => file === fragmentPath)
  expect(source).toBeDefined()
  return parseCoverage(source!.content)
}

function withFragment(coverage: CoverageFile): { inventory: Inventory; plugin: PluginInventory } {
  const copy = structuredClone(inventory)
  const target = copy.plugins.find(({ id }) => id === plugin.id)!
  target.coverageFragments!.find(({ file }) => file === fragmentPath)!.content = JSON.stringify(coverage)
  return { inventory: copy, plugin: target }
}

test('the settings fragment classifies its entire owned graph without concealing Usage debt', () => {
  const coverage = fragment()
  expect(Object.keys(coverage.surfaces)).toEqual([settingsSurface])
  expect(coverage.surfaces[settingsSurface]).toEqual({ loading: { applicable: true }, empty: { applicable: true }, error: { applicable: true } })
  const results = auditPlugin(inventory, plugin)
  const failures = results.flatMap(({ evidence }) => evidence).filter(({ code }) => !passCodes[code])
  expect(failures.filter((failure) => !(
    failure.code === 'coverage-missing' && failure.source?.file === `${directory}/src/window/Usage.tsx`
    || failure.code === 'surface-decision-missing' && usageSurfaces.includes(failure.targetId ?? '')
  ))).toEqual([])
  for (const state of ['loading', 'empty', 'error']) {
    expect(results.find(({ id }) => id === state)!.evidence.some((entry) =>
      entry.code === 'state-covered' && entry.targetId === settingsSurface,
    )).toBe(true)
  }
  for (const action of coverage.actions) {
    if ('route' in action) continue
    expect(action).toMatchObject({ transient: 'draft' })
    expect(action.site.file).toBe(`${directory}/src/window/AccountsSettings.tsx`)
  }
  expect(results.find(({ id }) => id === 'commands')!.evidence.some(({ code, api }) => code === 'action-routed' && api === 'ui.command.run')).toBe(true)
  const candidates = discoverCandidates(plugin, discoverUiFiles(plugin).files).filter(({ file }) => owned[file])
  const missing = new Set(failures.filter(({ code, source }) => code === 'coverage-missing' && source && owned[source.file]).map(({ source }) => `${source!.file}:${source!.line}:${source!.column}`))
  console.info(`Accounts settings owned candidates: discovered=${candidates.length}, claimed=${candidates.length - missing.size}`)
  expect(checkPlugin(inventory, plugin.id).find(({ id }) => id === 'compatibility-tokens')?.status).toBe('pass')
})

test('removing a routed settings action exposes the owned missing coverage', () => {
  const coverage = fragment()
  const index = coverage.actions.findIndex((action) => 'route' in action && action.route.target === 'command:quirky.accounts/select-account')
  expect(index).toBeGreaterThanOrEqual(0)
  const [removed] = coverage.actions.splice(index, 1)
  const mutated = withFragment(coverage)
  expect(auditPlugin(mutated.inventory, mutated.plugin).find(({ id }) => id === 'commands')!.evidence.some((entry) =>
    entry.code === 'coverage-missing' && entry.source?.file === removed!.site.file,
  )).toBe(true)
})

test('a stale shared-render witness cannot certify settings state coverage', () => {
  const coverage = fragment()
  const entry = coverage.states.find((entry) => entry.surface === settingsSurface && entry.render.component === 'NoticeLine')!
  expect(entry).toBeDefined()
  if (entry.render.component === 'toast') throw new Error('Expected shared render evidence')
  entry.render.element.quote += ' stale fixture witness'
  const mutated = withFragment(coverage)
  expect(auditPlugin(mutated.inventory, mutated.plugin).flatMap(({ evidence }) => evidence).some((entry) =>
    entry.code === 'evidence-missing' && entry.coverageFile === fragmentPath,
  )).toBe(true)
})
