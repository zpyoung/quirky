import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { auditPlugin } from '../../../scripts/ui-scoreboard/audit'
import { discoverCandidates, discoverUiFiles } from '../../../scripts/ui-scoreboard/audit-discovery'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import { checkPlugin } from '../../../scripts/ui-scoreboard/tokens'

const root = resolve(import.meta.dir, '../../..')
const history = 'plugins/quirky.vault/src/window/HistoryPanel.tsx'
const evidence = 'plugins/quirky.vault/src/window/evidence.tsx'
const surface = 'panel:quirky.vault/history'
const passing: Record<string, true> = { 'state-covered': true, 'state-not-applicable': true, 'not-state': true, 'action-routed': true, 'action-transient': true, 'action-not-user': true }

test('History coverage resolves every candidate without claiming Search Settings or enrolling the plugin', () => {
  const inventory = collectInventory(root)
  const plugin = inventory.plugins.find((entry) => entry.id === 'quirky.vault')!
  const graph = discoverUiFiles(plugin)
  expect(graph.failures).toEqual([])
  const candidates = discoverCandidates(plugin, graph.files)
  expect(candidates.some((candidate) => candidate.file === history && candidate.category === 'action')).toBe(true)
  expect(candidates.some((candidate) => candidate.file === evidence && candidate.category === 'state')).toBe(true)
  expect(checkPlugin(inventory, plugin.id).find((check) => check.id === 'compatibility-tokens')?.status).toBe('pass')

  const checks = auditPlugin(inventory, plugin)
  const issues = checks.flatMap((check) => check.evidence).filter((item) => !passing[item.code])
  expect(issues.filter((item) => item.source?.file === history || item.source?.file === evidence || item.targetId === surface || item.message.includes(surface) || item.coverageFile === 'plugins/quirky.vault/ui-scoreboard/history.json')).toEqual([])
  expect(issues.some((item) => item.source?.file.endsWith('/SearchSettings.tsx'))).toBe(true)
  expect(plugin.coverageFragments?.map((fragment) => fragment.file)).toContain('plugins/quirky.vault/ui-scoreboard/history.json')
  expect(JSON.parse(readFileSync(resolve(root, 'scripts/ui-scoreboard-ratchet.json'), 'utf8'))).not.toHaveProperty('quirky.vault')
})
