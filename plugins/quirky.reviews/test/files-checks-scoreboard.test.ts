import { beforeAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import { discoverCandidates, discoverUiFiles } from '../../../scripts/ui-scoreboard/audit-discovery'
import { parseCoverage, resolveRef, selectCandidate } from '../../../scripts/ui-scoreboard/audit-evidence'
import { auditPlugin } from '../../../scripts/ui-scoreboard/audit'
import { checkPlugin } from '../../../scripts/ui-scoreboard/tokens'
import { checkRatchet, parseRatchetConfig } from '../../../scripts/ui-scoreboard/ratchet'
import type { CoverageFile, Inventory, PluginInventory, Ref, StaticCheckId, StaticRatchet } from '../../../scripts/ui-scoreboard/contracts'
import { registerReviewsUiControl, requestReviewsUiControl, reviewsUiControlDescriptor } from '../src/checks/data'

const ROOT = resolve(import.meta.dir, '../../..')
const FRAGMENT = 'plugins/quirky.reviews/ui-scoreboard/files-and-checks.json'
const OWNED = ['plugins/quirky.reviews/src/detail/FilesChanged.tsx', 'plugins/quirky.reviews/src/detail/ChecksList.tsx']
const CHECKS: StaticCheckId[] = ['commands', 'compatibility-tokens', 'empty', 'error', 'loading']
let inventory: Inventory
let plugin: PluginInventory
let coverage: CoverageFile
let enrollment: StaticRatchet

beforeAll(() => {
  inventory = collectInventory(ROOT)
  expect(inventory.failures).toEqual([])
  plugin = inventory.plugins.find((entry) => entry.id === 'quirky.reviews')!
  expect(plugin).toBeDefined()
  const fragment = plugin.coverageFragments?.find((entry) => entry.file === FRAGMENT)
  expect(fragment).toBeDefined()
  coverage = parseCoverage(fragment!.content)
  enrollment = parseRatchetConfig(readFileSync(resolve(ROOT, 'scripts/ui-scoreboard-ratchet.json'), 'utf8'))
})

function withCoverage(value: CoverageFile): PluginInventory {
  return { ...plugin, coverageFragments: plugin.coverageFragments!.map((entry) => entry.file === FRAGMENT ? { ...entry, content: JSON.stringify(value) } : entry) }
}

function replaceSource(file: string, before: string, after: string): PluginInventory {
  expect(after).not.toBe(before)
  const source = plugin.sources.find((entry) => entry.file === file)!
  expect(source.content).toContain(before)
  return { ...plugin, sources: plugin.sources.map((entry) => entry.file === file ? { ...entry, content: entry.content.replace(before, after) } : entry) }
}

function expectMissing(subject: PluginInventory, ref: Ref, category: 'state' | 'action', check: string, anchor?: string) {
  const graph = discoverUiFiles(plugin)
  const resolved = resolveRef(plugin, graph.files, ref)
  if ('code' in resolved) throw new Error(resolved.message)
  const candidate = selectCandidate(resolved, discoverCandidates(plugin, graph.files), category, anchor)
  if ('code' in candidate) throw new Error(candidate.message)
  const source = plugin.sources.find((entry) => entry.file === candidate.file)!
  const line = source.content.slice(0, candidate.anchorStart).split('\n').length
  expect(auditPlugin(inventory, subject).find((entry) => entry.id === check)!.evidence.some((entry) => entry.code === 'coverage-missing' && entry.source?.file === candidate.file && entry.source.line === line)).toBe(true)
}

test('every discovered Reviews file passes all five static checks without sibling exclusions', () => {
  const graph = discoverUiFiles(plugin)
  expect(graph.failures).toEqual([])
  for (const file of OWNED) expect(graph.files).toContain(file)
  const candidates = discoverCandidates(plugin, graph.files)
  expect(candidates.some((entry) => !OWNED.includes(entry.file))).toBe(true)
  expect(coverage.surfaces).toEqual({})
  for (const entry of [...coverage.states, ...coverage.notState, ...coverage.actions]) expect(OWNED).toContain(entry.site.file)
  const audit = auditPlugin(inventory, plugin)
  expect(audit.map((entry) => entry.id).sort()).toEqual(['commands', 'empty', 'error', 'loading'])
  expect(audit.filter((entry) => entry.status !== 'pass')).toEqual([])
  const results = checkPlugin(inventory, plugin.id)
  expect(results.map((entry) => entry.id).sort()).toEqual(CHECKS)
  expect(results.filter((entry) => entry.status !== 'pass')).toEqual([])
  expect([...enrollment['quirky.reviews']!].sort()).toEqual(CHECKS)
  expect(checkRatchet(inventory, enrollment)).toEqual({ exitCode: 0, failures: [] })
}, 60_000)

test('prerequisite fragments and public dispatcher exports remain mandatory', () => {
  for (const fragment of ['checks-shell.json', 'review-and-comments.json', 'create-and-settings.json', 'sitter-and-actions.json']) {
    const file = `plugins/quirky.reviews/ui-scoreboard/${fragment}`
    expect(plugin.coverageFragments?.some((entry) => entry.file === file)).toBe(true)
    const changed = { ...plugin, coverageFragments: plugin.coverageFragments!.filter((entry) => entry.file !== file) }
    expect(auditPlugin(inventory, changed).some((entry) => entry.status === 'fail')).toBe(true)
  }
  for (const dispatcher of [registerReviewsUiControl, reviewsUiControlDescriptor, requestReviewsUiControl]) expect(typeof dispatcher).toBe('function')
})

test('every classification occupies one physical line', () => {
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

for (const state of ['loading', 'empty', 'error'] as const) {
  test(`removing ${state} evidence exposes its exact uncovered candidate`, () => {
    const entry = coverage.states.find((item) => item.state === state)!
    expect(entry).toBeDefined()
    expectMissing(withCoverage({ ...coverage, states: coverage.states.filter((item) => item !== entry) }), entry.site, 'state', state, entry.anchor)
  })
}

test('removing a command route exposes its exact uncovered action', () => {
  const entry = coverage.actions.find((item) => 'route' in item)!
  expect(entry).toBeDefined()
  expectMissing(withCoverage({ ...coverage, actions: coverage.actions.filter((item) => item !== entry) }), entry.site, 'action', 'commands', entry.anchor)
})

test('breaking a public dispatcher route fails the commands audit', () => {
  const entry = coverage.actions.find((item) => 'route' in item)!
  if (!('route' in entry)) throw new Error('Expected a command route')
  const witness = [entry.route.invoke, ...(entry.route.via ?? [])].find((ref) => /requestReviewsUiControl|reviewsUiControlDescriptor/.test(ref.quote))
  expect(witness).toBeDefined()
  const { file, quote } = witness!
  const changed = replaceSource(file, quote, quote.replace(/requestReviewsUiControl|reviewsUiControlDescriptor/, 'unroutedReviewControl'))
  expect(auditPlugin(inventory, changed).find((item) => item.id === 'commands')!.status).toBe('fail')
})

for (const [state, component, role] of [['loading', 'EmptyState', 'status'], ['error', 'InlineError', 'alert']] as const) {
  test(`raw role=${role} cannot replace a shared ${state} render`, () => {
    const entry = coverage.states.find((item) => item.state === state && item.render.component === component)!
    expect(entry).toBeDefined()
    if (entry.render.component === 'toast') throw new Error('Expected shared rendered state')
    const { file, quote } = entry.render.element
    const changed = replaceSource(file, quote, `<p role="${role}">Unshared state</p>`)
    expect(auditPlugin(inventory, changed).find((item) => item.id === state)!.status).toBe('fail')
  })
}
