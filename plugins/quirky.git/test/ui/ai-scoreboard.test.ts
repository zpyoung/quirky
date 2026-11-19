import { beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { resolve } from 'node:path'
import { collectInventory } from '../../../../scripts/ui-scoreboard/inventory'
import { discoverCandidates, discoverUiFiles } from '../../../../scripts/ui-scoreboard/audit-discovery'
import { auditPlugin } from '../../../../scripts/ui-scoreboard/audit'
import { parseCoverage } from '../../../../scripts/ui-scoreboard/audit-evidence'
import { checkPlugin } from '../../../../scripts/ui-scoreboard/tokens'
import type { CoverageFile, Inventory, PluginInventory } from '../../../../scripts/ui-scoreboard/contracts'

setDefaultTimeout(30_000)
const ROOT = resolve(import.meta.dir, '../../../..')
const PREFIX = 'plugins/quirky.git/'
const FRAGMENT = `${PREFIX}ui-scoreboard/ai.json`
const SETTINGS = 'view:quirky.git/ai-settings'
const OWNED = ['ai/AiSettingsView.tsx', 'ai/CommitSparkle.tsx', 'ai/FixSplitButton.tsx', 'ai/GenerateDialog.tsx', 'ai/LaunchDialog.tsx', 'ai/LaunchOptionsEditor.tsx', 'ai/useAiFix.ts', 'ai/agents.ts', 'ai/useDraft.ts', 'ai/ai-control.ts', 'daemon/ai-recipes.ts'].map((file) => `${PREFIX}src/${file}`)
const PASS: Record<string, true> = { 'state-covered': true, 'state-not-applicable': true, 'not-state': true, 'action-routed': true, 'action-transient': true, 'action-not-user': true }
let inventory: Inventory
let plugin: PluginInventory
beforeAll(() => {
  inventory = collectInventory(ROOT)
  plugin = inventory.plugins.find((entry) => entry.id === 'quirky.git')!
  expect(plugin).toBeDefined()
})
function fragment(): CoverageFile {
  const source = plugin.coverageFragments?.find((entry) => entry.file === FRAGMENT)
  expect(source).toBeDefined()
  return parseCoverage(source!.content)
}
function withFragment(coverage: CoverageFile): PluginInventory {
  return { ...plugin, coverageFragments: plugin.coverageFragments!.map((source) => source.file === FRAGMENT ? { ...source, content: JSON.stringify(coverage) } : source) }
}

test('the full AI graph has owned coverage, settings witnesses and valid command routes', () => {
  const coverage = fragment()
  expect(coverage.surfaces).toEqual({})
  expect(inventory.failures.filter((entry) => entry.source?.file.startsWith(PREFIX) || entry.message.includes('quirky.git'))).toEqual([])
  const graph = discoverUiFiles(plugin)
  expect(graph.failures).toEqual([])
  const candidates = discoverCandidates(plugin, graph.files)
  expect(candidates.filter((entry) => OWNED.includes(entry.file)).length).toBeGreaterThan(0)
  expect(candidates.filter((entry) => entry.file === `${PREFIX}src/daemon/ai-recipes.ts`)).toEqual([])
  const checks = auditPlugin(inventory, plugin)
  const failures = checks.flatMap((check) => check.evidence).filter((entry) => !PASS[entry.code])
  expect(failures.filter((entry) => !(entry.code === 'coverage-missing' && graph.files.includes(entry.source?.file ?? '') && !OWNED.includes(entry.source?.file ?? '') || entry.code === 'state-missing' && entry.targetId !== SETTINGS))).toEqual([])
  for (const state of ['loading', 'empty', 'error'] as const) {
    expect(coverage.states.some((entry) => entry.surface === SETTINGS && entry.state === state)).toBe(true)
    expect(failures.filter((entry) => entry.code === 'state-missing' && entry.targetId === SETTINGS)).toEqual([])
  }
  expect(coverage.actions.some((entry) => 'route' in entry && entry.route.target === 'command:quirky.git/ui-control')).toBe(true)
  expect(checks.find((check) => check.id === 'commands')!.evidence.some((entry) => entry.code === 'action-routed' && entry.api === 'ui.command.run' && entry.cli === 'quirky ui run command:quirky.git/ui-control' && entry.coverageFile === FRAGMENT)).toBe(true)
  expect(checkPlugin(inventory, plugin.id).find((check) => check.id === 'compatibility-tokens')?.status).toBe('pass')
})

test('deleting an AI mounted route exposes its exact source candidate', () => {
  const coverage = fragment()
  const index = coverage.actions.findIndex((entry) => 'route' in entry && entry.route.target === 'command:quirky.git/ui-control')
  expect(index).toBeGreaterThanOrEqual(0)
  const [removed] = coverage.actions.splice(index, 1)
  const before = auditPlugin(inventory, plugin).find((check) => check.id === 'commands')!.evidence
  const after = auditPlugin(inventory, withFragment(coverage)).find((check) => check.id === 'commands')!.evidence
  expect(after.filter((entry) => entry.code === 'coverage-missing' && entry.source?.file === removed!.site.file).length).toBeGreaterThan(before.filter((entry) => entry.code === 'coverage-missing' && entry.source?.file === removed!.site.file).length)
})

test('raw markup cannot replace the settings shared InlineError witness', () => {
  const coverage = fragment()
  const witness = coverage.states.find((entry) => entry.surface === SETTINGS && entry.state === 'error' && entry.render.component === 'InlineError')!
  expect(witness).toBeDefined()
  if (witness.render.component === 'toast') throw new Error('Expected a shared element witness')
  const render = witness.render.element
  const source = plugin.sources.find((entry) => entry.file === render.file)!
  expect(source.content.includes(render.quote)).toBe(true)
  const changed = { ...plugin, sources: plugin.sources.map((entry) => entry === source ? { ...entry, content: entry.content.replace(render.quote, '<p role="alert">Read failed</p>') } : entry) }
  const evidence = auditPlugin(inventory, changed).flatMap((check) => check.evidence)
  expect(evidence.some((entry) => entry.code === 'evidence-missing' && entry.coverageFile === FRAGMENT)).toBe(true)
})
