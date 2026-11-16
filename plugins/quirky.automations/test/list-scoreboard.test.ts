import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import { discoverCandidates, discoverUiFiles } from '../../../scripts/ui-scoreboard/audit-discovery'
import { parseCoverage } from '../../../scripts/ui-scoreboard/audit-evidence'
import { parseRatchetConfig } from '../../../scripts/ui-scoreboard/ratchet'
import { checkPlugin } from '../../../scripts/ui-scoreboard/tokens'

const root = resolve(import.meta.dir, '../../..')
const inventory = collectInventory(root)
const plugin = inventory.plugins.find(({ id }) => id === 'quirky.automations')!
const page = `${plugin.directory}/src/list/AutomationsPage.tsx`

test('automations passes all static state and command checks', () => {
  const checks = checkPlugin(inventory, plugin.id)
  for (const id of ['compatibility-tokens', 'loading', 'empty', 'error', 'commands']) {
    const check = checks.find((entry) => entry.id === id)!
    expect({ id, status: check.status, failures: [...new Set(check.evidence.filter(({ code }) => !['state-covered', 'state-not-applicable', 'not-state', 'action-routed', 'action-transient', 'action-not-user'].includes(code) && id !== 'compatibility-tokens').map(({ code }) => code))] }).toEqual({ id, status: 'pass', failures: [] })
  }
})

test('list routes contain no unresolved action candidates', () => {
  const candidates = discoverCandidates(plugin, discoverUiFiles(plugin).files)
  expect(candidates.filter(({ file, kind }) => file === page && kind.startsWith('unresolved-'))).toEqual([])
})

test('the list fragment reuses the surface declared by the editor', () => {
  const fragment = plugin.coverageFragments?.find(({ file }) => file.endsWith('/ui-scoreboard/list.json'))
  expect(fragment).toBeDefined()
  expect(parseCoverage(fragment!.content).surfaces).toEqual({})
})

test('automations is enrolled in every static ratchet check', () => {
  const ratchet = parseRatchetConfig(readFileSync(resolve(root, 'scripts/ui-scoreboard-ratchet.json'), 'utf8'))
  expect(ratchet['quirky.automations']).toEqual(['commands', 'compatibility-tokens', 'empty', 'error', 'loading'])
})

test('list states do not use raw compatibility state classes', () => {
  expect(plugin.sources.find(({ file }) => file === page)!.content.match(/className="auto-(error|warning|info|muted)"/g) ?? []).toEqual([])
})
