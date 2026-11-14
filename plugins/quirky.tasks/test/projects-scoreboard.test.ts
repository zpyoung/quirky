import { beforeAll, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import { discoverCandidates, discoverUiFiles } from '../../../scripts/ui-scoreboard/audit-discovery'
import { parseCoverage } from '../../../scripts/ui-scoreboard/audit-evidence'
import { auditPlugin } from '../../../scripts/ui-scoreboard/audit'
import type { CoverageFile, Evidence, Inventory, PluginInventory } from '../../../scripts/ui-scoreboard/contracts'

const ROOT = 'plugins/quirky.tasks/'
const SURFACE = `${ROOT}src/projects/ProjectsSurface.tsx`
const CONTROL = `${ROOT}src/projects/control.ts`
const FRAGMENT = `${ROOT}ui-scoreboard/projects.json`
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

function failures(subject = plugin): Evidence[] {
  return auditPlugin(inventory, subject).flatMap((check) => check.evidence).filter((entry) => !PASS[entry.code])
}

function viewRegion(content: string): (offset: number) => boolean {
  const layout = content.indexOf('<div className="quirky-tasks-projects__table-scroll">')
  const layoutEnd = content.indexOf('</div>', layout) + '</div>'.length
  const children = content.indexOf('function ProjectTable(')
  const childrenEnd = content.indexOf('function scrollToToday(')
  expect(layout).toBeGreaterThan(0)
  expect(layoutEnd).toBeGreaterThan(layout)
  expect(children).toBeGreaterThan(layoutEnd)
  expect(childrenEnd).toBeGreaterThan(children)
  return (offset) => (offset >= layout && offset < layoutEnd) || (offset >= children && offset < childrenEnd)
}

test('Projects shell evidence covers all shell candidates and leaves only the view region', () => {
  const coverage = fragment()
  expect(coverage.surfaces).toEqual({})
  for (const state of ['loading', 'empty', 'error']) {
    expect(coverage.states.some((entry) => entry.surface === 'view:quirky.tasks/tasks' && entry.state === state)).toBe(true)
  }
  const graph = discoverUiFiles(plugin)
  expect(graph.failures).toEqual([])
  expect(graph.files).toContain(CONTROL)
  const candidates = discoverCandidates(plugin, graph.files)
  expect(candidates.filter((entry) => entry.file === CONTROL)).toEqual([])
  const content = plugin.sources.find((entry) => entry.file === SURFACE)!.content
  const insideView = viewRegion(content)
  expect(candidates.filter((entry) => entry.file === SURFACE && !insideView(entry.anchorStart) && entry.kind.startsWith('unresolved-'))).toEqual([])
  const issues = failures()
  expect(issues.filter((entry) => entry.coverageFile === FRAGMENT || entry.source?.file === CONTROL)).toEqual([])
  const projectsIssues = issues.filter((entry) => entry.source?.file === SURFACE)
  expect(projectsIssues.length).toBeGreaterThan(0)
  for (const issue of projectsIssues) {
    expect(issue.code).toBe('coverage-missing')
    const source = issue.source!
    const lines = content.split('\n')
    const offset = lines.slice(0, source.line - 1).reduce((sum, line) => sum + line.length + 1, 0) + source.column - 1
    expect(insideView(offset)).toBe(true)
  }
})

test('changing a Projects state witness reports missing evidence in its fragment', () => {
  const coverage = fragment()
  const quote = coverage.states[0]!.site.quote
  coverage.states[0]!.site.quote = `${quote[0] === 'x' ? 'y' : 'x'}${quote.slice(1)}`
  const changed = {
    ...plugin,
    coverageFragments: plugin.coverageFragments!.map((source) => source.file === FRAGMENT ? { ...source, content: JSON.stringify(coverage) } : source),
  }
  expect(failures(changed).some((entry) => entry.code === 'evidence-missing' && entry.coverageFile === FRAGMENT)).toBe(true)
})

test('a new raw alert after the no-project state is uncovered', () => {
  fragment()
  const source = plugin.sources.find((entry) => entry.file === SURFACE)!
  const empty = source.content.indexOf('<EmptyState message="Choose a project to get started."')
  expect(empty).toBeGreaterThan(0)
  const insertion = source.content.indexOf('/>', empty) + 2
  const content = `${source.content.slice(0, insertion)}<p role="alert">x</p>${source.content.slice(insertion)}`
  const changed = { ...plugin, sources: plugin.sources.map((entry) => entry.file === SURFACE ? { ...entry, content } : entry) }
  expect(failures(changed).some((entry) => entry.code === 'coverage-missing' && entry.source?.file === SURFACE)).toBe(true)
})
