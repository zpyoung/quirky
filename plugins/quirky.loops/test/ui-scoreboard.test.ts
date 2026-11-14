import { beforeAll, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import { checkPlugin } from '../../../scripts/ui-scoreboard/tokens'
import { parseCoverage } from '../../../scripts/ui-scoreboard/audit-evidence'
import { parseRatchetConfig } from '../../../scripts/ui-scoreboard/ratchet'
import type { Inventory, PluginInventory, StaticCheckId } from '../../../scripts/ui-scoreboard/contracts'

const root = resolve(import.meta.dir, '../../..')
const checks: StaticCheckId[] = ['commands', 'compatibility-tokens', 'empty', 'error', 'loading']
let inventory: Inventory
let plugin: PluginInventory

beforeAll(async () => {
  inventory = await collectInventory(root)
  const found = inventory.plugins.find((entry) => entry.id === 'quirky.loops')
  if (!found) throw new Error('Background Loops is missing from the repository inventory')
  plugin = found
})

function withPlugin(replacement: PluginInventory): Inventory {
  return { ...inventory, plugins: inventory.plugins.map((entry) => entry.id === plugin.id ? replacement : entry) }
}

test('Background Loops passes all five source-bound static checks on its real surfaces', () => {
  expect(inventory.failures).toEqual([])
  const results = checkPlugin(inventory, plugin.id)
  expect(results.map((entry) => entry.id).sort()).toEqual(checks)
  expect(results.filter((entry) => entry.status !== 'pass').map((entry) => ({ id: entry.id, reason: entry.reason }))).toEqual([])
  if (!plugin.coverage) throw new Error('Background Loops needs source-bound coverage')
  const coverage = parseCoverage(plugin.coverage.content)
  expect(Object.keys(coverage.surfaces).sort()).toEqual(['overlay:quirky.loops/dialogs', 'view:quirky.loops/loop'])
  for (const surface of Object.values(coverage.surfaces)) {
    expect(surface).toEqual({ loading: { applicable: true }, empty: { applicable: true }, error: { applicable: true } })
  }
})

test('Background Loops enrolls exactly its five static checks in the ratchet', async () => {
  const ratchet = parseRatchetConfig(await Bun.file(resolve(root, 'scripts/ui-scoreboard-ratchet.json')).text())
  expect(ratchet['quirky.loops']).toEqual(checks)
})

test('missing coverage fails the shared-state and command checks', () => {
  const results = checkPlugin(withPlugin({ ...plugin, coverage: undefined }), plugin.id)
  expect(results.filter((entry) => entry.status === 'fail').map((entry) => entry.id).sort()).toEqual(['commands', 'empty', 'error', 'loading'])
  expect(results.flatMap((entry) => entry.evidence).some((entry) => entry.code === 'coverage-file-missing')).toBe(true)
})

test('a stale shared-render quote fails instead of accepting detached evidence', () => {
  if (!plugin.coverage) throw new Error('Background Loops needs source-bound coverage')
  const coverage = parseCoverage(plugin.coverage.content)
  const state = coverage.states.find((entry) => entry.render.component !== 'toast')
  if (!state || state.render.component === 'toast') throw new Error('Background Loops needs shared rendering evidence')
  state.render.element.quote = '<InlineError message="detached stale quote" />'
  const results = checkPlugin(withPlugin({ ...plugin, coverage: { ...plugin.coverage, content: JSON.stringify(coverage) } }), plugin.id)
  expect(results.some((entry) => entry.status === 'fail')).toBe(true)
  expect(results.flatMap((entry) => entry.evidence).some((entry) => entry.code === 'evidence-missing')).toBe(true)
})
