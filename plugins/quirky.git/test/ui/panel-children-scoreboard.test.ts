import { beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { resolve } from 'node:path'
import { collectInventory } from '../../../../scripts/ui-scoreboard/inventory'
import { discoverCandidates, discoverUiFiles } from '../../../../scripts/ui-scoreboard/audit-discovery'
import { auditPlugin } from '../../../../scripts/ui-scoreboard/audit'
import { parseCoverage } from '../../../../scripts/ui-scoreboard/audit-evidence'
import type { CoverageFile, Inventory, PluginInventory } from '../../../../scripts/ui-scoreboard/contracts'

setDefaultTimeout(30_000)

const ROOT = resolve(import.meta.dir, '../../../..')
const PREFIX = 'plugins/quirky.git/'
const FRAGMENT = `${PREFIX}ui-scoreboard/panel-children-and-notes.json`
const OWNED = [
  'panel/Cards.tsx', 'panel/ChangeBaseDialog.tsx', 'panel/HistoryDock.tsx',
  'panel/Rows.tsx', 'panel/ShipBar.tsx', 'panel/list.tsx',
  'notes/NoteCards.tsx', 'notes/SendMenu.tsx', 'notes/binding.tsx',
  'notes/extension.ts', 'notes/useNotes.ts',
].map((file) => `${PREFIX}src/${file}`)
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

test('every owned candidate in the production graph is classified once with valid evidence', () => {
  const coverage = fragment()
  const graph = discoverUiFiles(plugin)
  expect(graph.failures.filter((entry) => OWNED.includes(entry.source?.file ?? '')).map((entry) => entry.source?.file)).toEqual([])
  const candidates = discoverCandidates(plugin, graph.files).filter((candidate) => OWNED.includes(candidate.file))
  expect(candidates.length).toBeGreaterThan(0)
  const failures = auditPlugin(inventory, plugin).flatMap((check) => check.evidence).filter((entry) => !PASS[entry.code])
  expect(failures.filter((entry) => OWNED.includes(entry.source?.file ?? '') || entry.source?.file === FRAGMENT || entry.coverageFile === FRAGMENT)).toEqual([])
  expect(coverage.surfaces).toEqual({})
})

test('owned public and mounted routes resolve their API and CLI commands', () => {
  const evidence = auditPlugin(inventory, plugin).find((check) => check.id === 'commands')!.evidence
    .filter((entry) => entry.code === 'action-routed' && (OWNED.includes(entry.source?.file ?? '') || entry.coverageFile === FRAGMENT))
  const pairs = new Set(evidence.map((entry) => `${entry.api} → ${entry.cli}`))
  for (const method of ['addNote', 'editNote', 'deleteNote', 'noteTargets', 'sendNotes', 'setBase', 'branches', 'history', 'commitFiles']) {
    expect(pairs.has(`quirky.git/${method} → quirky git ${method}`), method).toBe(true)
  }
  expect(pairs.has('ui.command.run → quirky ui run command:quirky.git/ui-control')).toBe(true)
})

test('removing the toggle-commit route exposes a missing action', () => {
  const coverage = fragment()
  const index = coverage.actions.findIndex((entry) => 'route' in entry && entry.site.file.endsWith('/HistoryDock.tsx') && JSON.stringify(entry).includes('toggle-commit'))
  expect(index).toBeGreaterThanOrEqual(0)
  const [removed] = coverage.actions.splice(index, 1)
  const evidence = auditPlugin(inventory, withFragment(coverage)).find((check) => check.id === 'commands')!.evidence
  expect(evidence.some((entry) => entry.code === 'coverage-missing' && entry.source?.file === removed!.site.file)).toBe(true)
})

test('raw loading markup cannot replace the shared commits NoticeLine', () => {
  fragment()
  const file = `${PREFIX}src/panel/HistoryDock.tsx`
  const before = '<NoticeLine>Loading commits…</NoticeLine>'
  const source = plugin.sources.find((entry) => entry.file === file)!
  expect(source.content.includes(before)).toBe(true)
  const changed = { ...plugin, sources: plugin.sources.map((entry) => entry === source ? { ...entry, content: entry.content.replace(before, '<p>Loading commits…</p>') } : entry) }
  const evidence = auditPlugin(inventory, changed).find((check) => check.id === 'loading')!.evidence
  expect(evidence.some((entry) => entry.code === 'evidence-missing' && entry.coverageFile === FRAGMENT)).toBe(true)
})
