import { beforeAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import { checkPlugin } from '../../../scripts/ui-scoreboard/tokens'
import { parseCoverage } from '../../../scripts/ui-scoreboard/audit-evidence'
import { parseRatchetConfig } from '../../../scripts/ui-scoreboard/ratchet'
import type { CoverageFile, Inventory, PluginInventory, StaticCheckId } from '../../../scripts/ui-scoreboard/contracts'

const root = resolve(import.meta.dir, '../../..')
const id = 'quirky.heimdall'
const checks: StaticCheckId[] = ['commands', 'compatibility-tokens', 'empty', 'error', 'loading']
let inventory: Inventory
let plugin: PluginInventory

beforeAll(() => {
  inventory = collectInventory(root)
  const found = inventory.plugins.find((entry) => entry.id === id)
  if (!found) throw new Error('Heimdall is missing from the repository inventory')
  plugin = found
})

function coverage(): CoverageFile {
  if (!plugin.coverage) throw new Error('Heimdall needs source-bound coverage')
  return parseCoverage(plugin.coverage.content)
}

function withCoverage(content: CoverageFile | undefined): Inventory {
  const replacement = { ...plugin, coverage: content && { file: plugin.coverage!.file, content: JSON.stringify(content) } }
  return { ...inventory, plugins: inventory.plugins.map((entry) => entry.id === id ? replacement : entry) }
}

test('both Heimdall surfaces pass all five source-bound checks', () => {
  expect(inventory.failures).toEqual([])
  const results = checkPlugin(inventory, id)
  expect(results.map((entry) => entry.id).sort()).toEqual(checks)
  expect(results.filter((entry) => entry.status !== 'pass').map((entry) => ({ id: entry.id, reason: entry.reason, evidence: entry.evidence.filter((item) => !['not-state', 'state-covered', 'action-routed', 'action-transient', 'action-not-user'].includes(item.code)) }))).toEqual([])
  const surfaces = coverage().surfaces
  expect(Object.keys(surfaces).sort()).toEqual(['sidebar-section:quirky.heimdall/navigation', 'view:quirky.heimdall/fleet'])
  for (const surface of Object.values(surfaces)) {
    expect(surface).toEqual({ loading: { applicable: true }, empty: { applicable: true }, error: { applicable: true } })
  }
})

test('Heimdall enrolls all five static checks', () => {
  const ratchet = parseRatchetConfig(readFileSync(resolve(root, 'scripts/ui-scoreboard-ratchet.json'), 'utf8'))
  expect(ratchet[id]).toEqual(checks)
})

test('missing coverage fails each state and command check', () => {
  const results = checkPlugin(withCoverage(undefined), id)
  expect(results.filter((entry) => entry.status === 'fail').map((entry) => entry.id).sort()).toEqual(['commands', 'empty', 'error', 'loading'])
  for (const result of results.filter((entry) => entry.status === 'fail')) {
    expect(result.evidence.some((entry) => entry.code === 'coverage-file-missing')).toBe(true)
  }
})

test('every action classification is necessary for command coverage', () => {
  const original = coverage()
  for (let index = 0; index < original.actions.length; index++) {
    const changed = structuredClone(original)
    changed.actions.splice(index, 1)
    const result = checkPlugin(withCoverage(changed), id).find((entry) => entry.id === 'commands')!
    expect(result.status).toBe('fail')
    expect(result.evidence.some((entry) => entry.code === 'coverage-missing')).toBe(true)
  }
}, 30_000)

test('every shared state classification is necessary for its state check', () => {
  const original = coverage()
  for (let index = 0; index < original.states.length; index++) {
    const changed = structuredClone(original)
    const [removed] = changed.states.splice(index, 1)
    const result = checkPlugin(withCoverage(changed), id).find((entry) => entry.id === removed!.state)!
    expect(result.status).toBe('fail')
    expect(result.evidence.some((entry) => entry.code === 'coverage-missing')).toBe(true)
  }
}, 30_000)

test('detached shared-render evidence is rejected', () => {
  const changed = coverage()
  const state = changed.states.find((entry) => entry.render.component !== 'toast')!
  if (state.render.component === 'toast') throw new Error('Heimdall needs shared component evidence')
  state.render.element.quote = '<InlineError message="detached stale quote" />'
  const result = checkPlugin(withCoverage(changed), id).find((entry) => entry.id === state.state)!
  expect(result.status).toBe('fail')
  expect(result.evidence.some((entry) => entry.code === 'evidence-missing')).toBe(true)
})
