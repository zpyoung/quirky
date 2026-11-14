import { beforeAll, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import * as ts from 'typescript'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import { discoverCandidates, discoverUiFiles } from '../../../scripts/ui-scoreboard/audit-discovery'
import { parseCoverage } from '../../../scripts/ui-scoreboard/audit-evidence'
import { auditPlugin } from '../../../scripts/ui-scoreboard/audit'
import type { CoverageFile, Evidence, Inventory, PluginInventory } from '../../../scripts/ui-scoreboard/contracts'

const ROOT = 'plugins/quirky.tasks/'
const LIST = `${ROOT}src/list/TasksList.tsx`
const CONTROL = `${ROOT}src/list/list-control.ts`
const FRAGMENT = `${ROOT}ui-scoreboard/list.json`
const PASS: Record<string, true> = { 'state-covered': true, 'state-not-applicable': true, 'not-state': true, 'action-routed': true, 'action-transient': true, 'action-not-user': true }
let inventory: Inventory
let plugin: PluginInventory

beforeAll(() => {
  inventory = collectInventory(resolve(import.meta.dir, '../../..'))
  expect(inventory.failures).toEqual([])
  plugin = inventory.plugins.find((entry) => entry.id === 'quirky.tasks')!
  expect(plugin).toBeDefined()
})

function fragment(): CoverageFile {
  const source = plugin.coverageFragments?.find((entry) => entry.file === FRAGMENT)
  expect(source).toBeDefined()
  return parseCoverage(source!.content)
}

function evidence(subject = plugin): Evidence[] {
  return auditPlugin(inventory, subject).flatMap((check) => check.evidence)
}

test('list fragment covers its reachable states and commands without redeclaring shell surfaces', () => {
  const coverage = fragment()
  expect(coverage.surfaces).toEqual({})
  const graph = discoverUiFiles(plugin)
  expect(graph.failures).toEqual([])
  expect(graph.files).toContain(CONTROL)
  expect(discoverCandidates(plugin, graph.files).filter((entry) => entry.file === CONTROL)).toEqual([])
  const audit = evidence()
  expect(audit.filter((entry) => !PASS[entry.code] && ([LIST, CONTROL].includes(entry.source?.file ?? '') || entry.coverageFile === FRAGMENT))).toEqual([])
  for (const entry of coverage.states) expect(entry.surface).toBe('view:quirky.tasks/tasks')
  expect([...new Set(coverage.states.map((entry) => entry.state))].sort()).toEqual(['empty', 'error', 'loading'])
  const filters = coverage.actions.find((entry) => entry.site.quote.includes("requestControl('filters', !filtersOpen)"))
  expect(filters && 'route' in filters && filters.route.target).toBe('command:quirky.tasks/list-control')
  expect(audit.some((entry) => entry.code === 'action-routed' && entry.source?.file === CONTROL && entry.api === 'ui.command.run' && entry.cli === 'quirky ui run command:quirky.tasks/list-control')).toBe(true)
})

test('a stale list state witness reports missing evidence in its own fragment', () => {
  const coverage = fragment()
  coverage.states[0]!.site.quote = `x${coverage.states[0]!.site.quote.slice(1)}`
  const changed = {
    ...plugin,
    coverageFragments: plugin.coverageFragments!.map((source) => source.file === FRAGMENT ? { ...source, content: JSON.stringify(coverage) } : source),
  }
  expect(evidence(changed).some((entry) => entry.code === 'evidence-missing' && entry.coverageFile === FRAGMENT)).toBe(true)
})

test('a new raw alert in the list section fails coverage', () => {
  fragment()
  const source = plugin.sources.find((entry) => entry.file === LIST)!
  const parsed = ts.createSourceFile(LIST, source.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let insertion = -1
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(parsed) === 'section' && node.attributes.properties.some((property) => ts.isJsxAttribute(property) && property.name.getText(parsed) === 'className' && property.initializer && ts.isStringLiteral(property.initializer) && property.initializer.text === 'tasks-list')) {
      insertion = node.end
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  expect(insertion).toBeGreaterThanOrEqual(0)
  const content = `${source.content.slice(0, insertion)}<p role="alert">x</p>${source.content.slice(insertion)}`
  const changed = { ...plugin, sources: plugin.sources.map((entry) => entry.file === LIST ? { ...entry, content } : entry) }
  expect(evidence(changed).some((entry) => entry.code === 'coverage-missing' && entry.source?.file === LIST)).toBe(true)
})
