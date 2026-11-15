import { beforeAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import { discoverCandidates, discoverUiFiles } from '../../../scripts/ui-scoreboard/audit-discovery'
import { parseCoverage } from '../../../scripts/ui-scoreboard/audit-evidence'
import { auditPlugin } from '../../../scripts/ui-scoreboard/audit'
import { checkRatchet, parseRatchetConfig } from '../../../scripts/ui-scoreboard/ratchet'
import { checkPlugin } from '../../../scripts/ui-scoreboard/tokens'
import type { CoverageFile, Evidence, Inventory, PluginInventory, StaticCheckId } from '../../../scripts/ui-scoreboard/contracts'

const ROOT = 'plugins/quirky.tasks/'
const SURFACE = `${ROOT}src/projects/ProjectsSurface.tsx`
const CONTROL = `${ROOT}src/projects/control.ts`
const FRAGMENT = `${ROOT}ui-scoreboard/projects.json`
const VIEWS_FRAGMENT = `${ROOT}ui-scoreboard/projects-views.json`
const TASKS_VIEW = 'view:quirky.tasks/tasks'
const STATIC_CHECKS: StaticCheckId[] = ['commands', 'compatibility-tokens', 'empty', 'error', 'loading']
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

function viewsFragment(): CoverageFile {
  const source = plugin.coverageFragments?.find((entry) => entry.file === VIEWS_FRAGMENT)
  expect(source).toBeDefined()
  return parseCoverage(source!.content)
}

function withCoverage(subject: PluginInventory, file: string, coverage: CoverageFile): PluginInventory {
  return {
    ...subject,
    coverageFragments: subject.coverageFragments!.map((source) => source.file === file ? { ...source, content: JSON.stringify(coverage) } : source),
  }
}

function withPlugin(subject: PluginInventory): Inventory {
  return { ...inventory, plugins: inventory.plugins.map((entry) => entry.id === subject.id ? subject : entry) }
}

function withTableAlert(subject: PluginInventory): PluginInventory {
  const source = subject.sources.find((entry) => entry.file === SURFACE)
  expect(source).toBeDefined()
  const opening = source!.content.indexOf('<div className="quirky-tasks-projects__table-scroll">')
  const insertion = source!.content.indexOf('>', opening) + 1
  expect(opening).toBeGreaterThan(0)
  expect(viewRegion(source!.content)(insertion)).toBe(true)
  const content = `${source!.content.slice(0, insertion)}<p role="alert">uncovered</p>${source!.content.slice(insertion)}`
  return { ...subject, sources: subject.sources.map((entry) => entry.file === SURFACE ? { ...entry, content } : entry) }
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

test('Projects has complete audit coverage across its production graph', () => {
  const coverage = fragment()
  const views = viewsFragment()
  expect(coverage.surfaces).toEqual({})
  expect(views.surfaces).toEqual({})
  for (const state of ['loading', 'empty', 'error']) {
    expect(coverage.states.some((entry) => entry.surface === TASKS_VIEW && entry.state === state)).toBe(true)
  }
  expect(views.states.length).toBeGreaterThan(0)
  for (const state of views.states) expect(state.surface).toBe(TASKS_VIEW)

  const graph = discoverUiFiles(plugin)
  expect(graph.failures).toEqual([])
  expect(graph.files).toContain(CONTROL)
  const candidates = discoverCandidates(plugin, graph.files)
  expect(candidates.filter((entry) => entry.file === CONTROL)).toEqual([])
  expect(candidates.filter((entry) => entry.file === SURFACE && entry.kind.startsWith('unresolved-'))).toEqual([])

  const audits = auditPlugin(inventory, plugin)
  expect(audits.map((check) => check.id)).toEqual(['loading', 'empty', 'error', 'commands'])
  expect(audits.every((check) => check.status === 'pass')).toBe(true)
  expect(failures()).toEqual([])

  const checks = checkPlugin(inventory, plugin.id)
  expect(checks.map((check) => check.id)).toEqual(['compatibility-tokens', 'loading', 'empty', 'error', 'commands'])
  expect(checks.every((check) => check.status === 'pass')).toBe(true)
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

test('changing the first Projects view error witness reports missing fragment evidence', () => {
  const coverage = viewsFragment()
  const state = coverage.states.find((entry) => entry.state === 'error')
  expect(state).toBeDefined()
  if (!state) throw new Error('Expected a Projects view error state')
  const quote = state.site.quote
  state.site.quote = `${quote[0] === 'x' ? 'y' : 'x'}${quote.slice(1)}`
  const changed = withCoverage(plugin, VIEWS_FRAGMENT, coverage)
  expect(failures(changed).some((entry) =>
    entry.code === 'evidence-missing' && entry.coverageFile === VIEWS_FRAGMENT)).toBe(true)
})

test('removing a routed Projects parent callback exposes that callback', () => {
  const coverage = viewsFragment()
  const callback = coverage.actions.find((entry) =>
    'route' in entry && entry.site.file === SURFACE && entry.route.target === 'quirky.tasks/projectEdit')
  expect(callback).toBeDefined()
  if (!callback || !('route' in callback)) throw new Error('Expected a routed Projects parent callback')

  const source = plugin.sources.find((entry) => entry.file === SURFACE)!
  const quoteOffset = source.content.indexOf(callback.site.quote)
  expect(quoteOffset).toBeGreaterThanOrEqual(0)
  const anchorOffset = callback.anchor === undefined ? 0 : callback.site.quote.indexOf(callback.anchor)
  expect(anchorOffset).toBeGreaterThanOrEqual(0)
  const callbackLine = source.content.slice(0, quoteOffset + anchorOffset).split('\n').length
  const changed = withCoverage(plugin, VIEWS_FRAGMENT, {
    ...coverage,
    actions: coverage.actions.filter((entry) => entry !== callback),
  })
  const commandEvidence = auditPlugin(inventory, changed).find((check) => check.id === 'commands')!.evidence
  expect(commandEvidence.some((entry) =>
    entry.code === 'coverage-missing' && entry.source?.file === SURFACE && entry.source.line === callbackLine)).toBe(true)
})

test('an alert in the table region is uncovered and fails the Tasks ratchet', () => {
  viewsFragment()
  const changed = withTableAlert(plugin)
  expect(failures(changed).some((entry) =>
    entry.code === 'coverage-missing' && entry.source?.file === SURFACE)).toBe(true)

  const enrollment = parseRatchetConfig(readFileSync(resolve(import.meta.dir, '../../../scripts/ui-scoreboard-ratchet.json'), 'utf8'))
  const ratchet = checkRatchet(withPlugin(changed), { 'quirky.tasks': enrollment['quirky.tasks']! })
  expect(ratchet.exitCode).toBe(1)
  expect(ratchet.failures.some((entry) =>
    entry.code === 'coverage-missing' && entry.source?.file === SURFACE)).toBe(true)
})

test('the Tasks ratchet enrolls all five static checks', () => {
  const enrollment = parseRatchetConfig(readFileSync(resolve(import.meta.dir, '../../../scripts/ui-scoreboard-ratchet.json'), 'utf8'))
  expect(enrollment['quirky.tasks']).toEqual(STATIC_CHECKS)
  expect(checkRatchet(inventory, { 'quirky.tasks': enrollment['quirky.tasks']! })).toEqual({ exitCode: 0, failures: [] })
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
