import { beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { collectInventory } from '../../../../scripts/ui-scoreboard/inventory'
import { discoverCandidates, discoverUiFiles } from '../../../../scripts/ui-scoreboard/audit-discovery'
import { auditPlugin } from '../../../../scripts/ui-scoreboard/audit'
import { parseCoverage } from '../../../../scripts/ui-scoreboard/audit-evidence'
import { checkPlugin } from '../../../../scripts/ui-scoreboard/tokens'
import type { CoverageFile, Inventory, PluginInventory } from '../../../../scripts/ui-scoreboard/contracts'

// full-graph AST audits need a watchdog independent of product performance budgets.
setDefaultTimeout(30_000)

const ROOT = resolve(import.meta.dir, '../../../..')
const PREFIX = 'plugins/quirky.git/'
const FRAGMENT = `${PREFIX}ui-scoreboard/panel-shell.json`
const OWNED = ['SourceControl.tsx', 'StatusBarItem.tsx', 'panel/WorktreePanel.tsx', 'panel/Header.tsx', 'panel/Notices.tsx', 'panel/Dialog.tsx', 'panel/data.ts', 'ui-control.ts', 'ui.tsx', 'scm.ts'].map((file) => `${PREFIX}src/${file}`)
const PANEL = 'panel:quirky.git/source-control'
const STATUS = 'status-bar:quirky.git/ahead-behind'
const VIEWS = ['view:quirky.git/ai-settings', 'view:quirky.git/diff']
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

test('the full production graph has complete owned classifications, honest sibling gaps and valid routes', () => {
  const coverage = fragment()
  expect(inventory.failures.filter((entry) => entry.source?.file.startsWith(PREFIX) || entry.message.includes('quirky.git'))).toEqual([])
  const graph = discoverUiFiles(plugin)
  expect(graph.failures).toEqual([])
  const candidates = discoverCandidates(plugin, graph.files)
  expect(candidates.filter((entry) => OWNED.includes(entry.file)).length).toBeGreaterThan(0)
  const checks = auditPlugin(inventory, plugin)
  const failures = checks.flatMap((check) => check.evidence).filter((entry) => !PASS[entry.code])
  expect(failures.filter((entry) => !(entry.code === 'coverage-missing' && graph.files.includes(entry.source?.file ?? '') && !OWNED.includes(entry.source?.file ?? '') || entry.code === 'state-missing' && VIEWS.includes(entry.targetId ?? '')))).toEqual([])
  expect(Object.keys(coverage.surfaces).sort()).toEqual([PANEL, STATUS, ...VIEWS].sort())
  const all = [plugin.coverage, ...(plugin.coverageFragments ?? [])].filter((source) => source !== undefined).map((source) => parseCoverage(source.content))
  for (const surface of [PANEL, STATUS, ...VIEWS]) expect(all.filter((entry) => Object.hasOwn(entry.surfaces, surface))).toHaveLength(1)
  for (const surface of [PANEL, ...VIEWS]) expect(coverage.surfaces[surface]).toEqual({ loading: { applicable: true }, empty: { applicable: true }, error: { applicable: true } })
  for (const state of ['loading', 'empty', 'error'] as const) expect(coverage.surfaces[STATUS]![state].applicable).toBe(false)
  const routed = checks.find((check) => check.id === 'commands')!.evidence
  expect(routed.some((entry) => entry.code === 'action-routed' && entry.cli === 'quirky ui run command:quirky.git/ui-control')).toBe(true)
  expect(checkPlugin(inventory, plugin.id).find((check) => check.id === 'compatibility-tokens')?.status).toBe('pass')
  expect(JSON.parse(readFileSync(resolve(ROOT, 'scripts/ui-scoreboard-ratchet.json'), 'utf8'))['quirky.git']).toBeUndefined()
})

test('removing a real routed action restores missing coverage at its source candidate', () => {
  const coverage = fragment()
  const index = coverage.actions.findIndex((entry) => 'route' in entry && entry.route.target === 'command:quirky.git/ui-control')
  expect(index).toBeGreaterThanOrEqual(0)
  const [removed] = coverage.actions.splice(index, 1)
  const before = auditPlugin(inventory, plugin).find((check) => check.id === 'commands')!.evidence
  const after = auditPlugin(inventory, withFragment(coverage)).find((check) => check.id === 'commands')!.evidence
  expect(after.filter((entry) => entry.code === 'coverage-missing' && entry.source?.file === removed!.site.file).length).toBeGreaterThan(before.filter((entry) => entry.code === 'coverage-missing' && entry.source?.file === removed!.site.file).length)
})

test('raw markup cannot replace a witnessed shared loading render', () => {
  const coverage = fragment()
  const witness = coverage.states.find((entry) => entry.surface === PANEL && entry.state === 'loading' && entry.render.component === 'NoticeLine')!
  expect(witness).toBeDefined()
  if (witness.render.component === 'toast') throw new Error('Expected shared render witness')
  const render = witness.render.element
  const source = plugin.sources.find((entry) => entry.file === render.file)!
  expect(source.content.includes(render.quote)).toBe(true)
  const changed = { ...plugin, sources: plugin.sources.map((entry) => entry === source ? { ...entry, content: entry.content.replace(render.quote, '<p role="status">Loading…</p>') } : entry) }
  const evidence = auditPlugin(inventory, changed).flatMap((check) => check.evidence)
  expect(evidence.some((entry) => entry.code === 'evidence-missing' && entry.coverageFile === FRAGMENT)).toBe(true)
})
