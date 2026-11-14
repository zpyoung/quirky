import { beforeAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import { discoverCandidates, discoverUiFiles } from '../../../scripts/ui-scoreboard/audit-discovery'
import { parseCoverage, resolveRef, selectCandidate } from '../../../scripts/ui-scoreboard/audit-evidence'
import { auditPlugin } from '../../../scripts/ui-scoreboard/audit'
import type { Candidate, CoverageFile, Inventory, PluginInventory, Ref } from '../../../scripts/ui-scoreboard/contracts'

const FRAGMENT = 'plugins/quirky.reviews/ui-scoreboard/review-and-comments.json'
const OWNED = ['plugins/quirky.reviews/src/detail/ReviewPage.tsx', 'plugins/quirky.reviews/src/detail/Comments.tsx']
const SURFACE = 'view:quirky.reviews/review'
const CONTROL = 'command:quirky.reviews/ui-control'
const PASS: Record<string, true> = { 'state-covered': true, 'state-not-applicable': true, 'not-state': true, 'action-routed': true, 'action-transient': true, 'action-not-user': true }
let inventory: Inventory
let plugin: PluginInventory
const coverageSource = readFileSync(resolve(import.meta.dir, '../../..', FRAGMENT), 'utf8')
const coverage = parseCoverage(coverageSource)
let uiFiles: string[]
let candidates: Candidate[]

beforeAll(() => {
  inventory = collectInventory(resolve(import.meta.dir, '../../..'))
  expect(inventory.failures).toEqual([])
  plugin = inventory.plugins.find((entry) => entry.id === 'quirky.reviews')!
  expect(plugin).toBeDefined()
  const fragment = plugin.coverageFragments?.find((entry) => entry.file === FRAGMENT)
  expect(fragment).toBeDefined()
  expect(fragment!.content).toBe(coverageSource)
  const graph = discoverUiFiles(plugin)
  expect(graph.failures).toEqual([])
  uiFiles = graph.files
  candidates = discoverCandidates(plugin, uiFiles)
})

function withCoverage(value: CoverageFile): PluginInventory {
  return { ...plugin, coverageFragments: plugin.coverageFragments!.map((entry) => entry.file === FRAGMENT ? { ...entry, content: JSON.stringify(value) } : entry) }
}

function candidateAt(ref: Ref, category: Candidate['category'], anchor?: string): Candidate {
  const resolved = resolveRef(plugin, uiFiles, ref)
  if ('code' in resolved) throw new Error(resolved.message)
  const candidate = selectCandidate(resolved, candidates, category, anchor)
  if ('code' in candidate) throw new Error(candidate.message)
  return candidate
}

function missingCandidate(subject: PluginInventory, candidate: Candidate): boolean {
  const source = plugin.sources.find((entry) => entry.file === candidate.file)!
  const line = source.content.slice(0, candidate.anchorStart).split('\n').length
  return auditPlugin(inventory, subject).some((check) => check.evidence.some((entry) => entry.code === 'coverage-missing' && entry.source?.file === candidate.file && entry.source.line === line))
}

function failures(subject: PluginInventory) {
  const graph = discoverUiFiles(subject)
  return auditPlugin(inventory, subject).flatMap((check) => check.evidence.filter((entry) => {
    if (PASS[entry.code]) return false
    if (entry.code === 'coverage-missing' && entry.source && graph.files.includes(entry.source.file) && !OWNED.includes(entry.source.file)) return false
    if (entry.code === 'state-missing' && ['view:quirky.reviews/create', 'view:quirky.reviews/settings'].includes(entry.targetId ?? '')) return false
    return true
  }))
}

test('the complete production graph has one classification per owned candidate and no duplicated surfaces', () => {
  const graph = discoverUiFiles(plugin)
  expect(graph.failures).toEqual([])
  expect(graph.files.length).toBeGreaterThanOrEqual(18)
  expect(coverage.schemaVersion).toBe(1)
  expect(coverage.surfaces).toEqual({})
  const declarations = [...(plugin.coverage ? [plugin.coverage] : []), ...(plugin.coverageFragments ?? [])].map((entry) => parseCoverage(entry.content))
  for (const surface of plugin.targets) expect(declarations.filter((entry) => Object.hasOwn(entry.surfaces, surface))).toHaveLength(1)
  for (const entry of [...coverage.states, ...coverage.notState, ...coverage.actions]) expect(OWNED).toContain(entry.site.file)
  for (const file of OWNED) {
    expect(graph.files).toContain(file)
    for (const kind of ['loading', 'empty', 'error'] as const) expect(coverage.states.some((entry) => entry.site.file === file && entry.state === kind && entry.surface === SURFACE)).toBe(true)
  }
  const routes = coverage.actions.filter((entry) => 'route' in entry && entry.route.target === CONTROL)
  expect(routes.length).toBeGreaterThan(0)
  for (const entry of routes) {
    if (!('route' in entry)) throw new Error('Expected a command route')
    expect(entry.route.invoke.quote).toMatch(/command\s*:\s*REVIEWS_UI_CONTROL/)
    expect(entry.route.via?.at(-1)?.quote).toMatch(/reviewsUiControlDescriptor/)
  }
  expect(failures(plugin)).toEqual([])
})

test('each fragment entry occupies one physical line', () => {
  const lines = plugin.coverageFragments!.find((entry) => entry.file === FRAGMENT)!.content.split('\n')
  for (const section of ['states', 'notState', 'actions'] as const) {
    const start = lines.findIndex((line) => line.trim() === `"${section}": [`)
    const end = lines.findIndex((line, index) => index > start && ['],', ']'].includes(line.trim()))
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const entries = lines.slice(start + 1, end).filter((line) => line.trim().startsWith('{'))
    expect(entries).toHaveLength(coverage[section].length)
    for (const line of entries) expect(line.trim()).toMatch(/^\{.*\},?$/)
  }
})

for (const [index, entry] of coverage.actions.entries()) {
  if (!('route' in entry)) continue
  test(`deleting public route ${index + 1} in ${entry.site.file} exposes its exact candidate`, () => {
    const candidate = candidateAt(entry.site, 'action', entry.anchor)
    expect(missingCandidate(withCoverage({ ...coverage, actions: coverage.actions.filter((item) => item !== entry) }), candidate)).toBe(true)
  })
}

for (const [index, entry] of coverage.states.entries()) {
  test(`deleting ${entry.state} witness ${index + 1} in ${entry.site.file} exposes its exact candidate`, () => {
    const candidate = candidateAt(entry.site, 'state', entry.anchor)
    expect(missingCandidate(withCoverage({ ...coverage, states: coverage.states.filter((item) => item !== entry) }), candidate)).toBe(true)
  })
}

test('raw replacements invalidate shared renders in both source files', () => {
  for (const file of OWNED) {
    const entry = coverage.states.find((item) => item.site.file === file && item.render.component === 'NoticeLine')!
    expect(entry).toBeDefined()
    if (entry.render.component !== 'NoticeLine') throw new Error('Expected a loading line')
    const quote = entry.render.element.quote
    const raw = quote.replace(/<NoticeLine\b[^>]*>([\s\S]*?)<\/NoticeLine>/, '<p>$1</p>')
    expect(raw).not.toBe(quote)
    const subject = { ...plugin, sources: plugin.sources.map((source) => source.file === file ? { ...source, content: source.content.replace(quote, raw) } : source) }
    expect(failures(subject).some((failure) => failure.code === 'evidence-missing' && failure.coverageFile === FRAGMENT)).toBe(true)
  }
})

test('an unclassified raw alert in either source fails owned coverage', () => {
  for (const file of OWNED) {
    const subject = { ...plugin, sources: plugin.sources.map((source) => source.file === file ? { ...source, content: `${source.content}\nconst unexpectedAlert = <p role="alert">Fixture failed.</p>\n` } : source) }
    expect(failures(subject).some((failure) => failure.code === 'coverage-missing' && failure.source?.file === file)).toBe(true)
  }
})
