import { beforeAll, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { discoverCandidates, discoverUiFiles } from '../../../scripts/ui-scoreboard/audit-discovery'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import type { Inventory, PluginInventory } from '../../../scripts/ui-scoreboard/contracts'

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
  expect(inventory.failures.filter((failure) => failure.message.includes(directory))).toEqual([])
  const graph = discoverUiFiles(plugin)
  expect(graph.failures).toEqual([])
  expect(graph.files.filter((file) => file.startsWith(`${directory}/src/usage/`))).toEqual([
    `${directory}/src/usage/types.ts`,
  ])
  expect(discoverCandidates(plugin, graph.files).filter((candidate) =>
    owned[candidate.file] && candidate.kind === 'unresolved-assignment',
  )).toEqual([])
})
