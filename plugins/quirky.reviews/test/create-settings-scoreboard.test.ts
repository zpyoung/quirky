import { beforeAll, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import { discoverCandidates, discoverUiFiles } from '../../../scripts/ui-scoreboard/audit-discovery'
import { parseCoverage, resolveRef, selectCandidate } from '../../../scripts/ui-scoreboard/audit-evidence'
import { auditPlugin } from '../../../scripts/ui-scoreboard/audit'
import { checkPlugin } from '../../../scripts/ui-scoreboard/tokens'
import type { Candidate, CoverageFile, Inventory, PluginInventory, Ref } from '../../../scripts/ui-scoreboard/contracts'

const FRAGMENT = 'plugins/quirky.reviews/ui-scoreboard/create-and-settings.json'
const OWNED = ['plugins/quirky.reviews/src/create/CreateReview.tsx', 'plugins/quirky.reviews/src/create/HostingSettings.tsx']
const SURFACES = ['view:quirky.reviews/create', 'view:quirky.reviews/settings']
const PASS: Record<string, true> = {
  'state-covered': true,
  'state-not-applicable': true,
  'not-state': true,
  'action-routed': true,
  'action-transient': true,
  'action-not-user': true,
}
let inventory: Inventory
let plugin: PluginInventory
let coverage: CoverageFile

beforeAll(() => {
  inventory = collectInventory(resolve(import.meta.dir, '../../..'))
  expect(inventory.failures).toEqual([])
  plugin = inventory.plugins.find((entry) => entry.id === 'quirky.reviews')!
  expect(plugin).toBeDefined()
  const fragment = plugin.coverageFragments?.find((entry) => entry.file === FRAGMENT)
  expect(fragment).toBeDefined()
  coverage = parseCoverage(fragment!.content)
})

function withCoverage(value: CoverageFile): PluginInventory {
  return { ...plugin, coverageFragments: plugin.coverageFragments!.map((entry) => entry.file === FRAGMENT ? { ...entry, content: JSON.stringify(value) } : entry) }
}

function candidateAt(ref: Ref, category: Candidate['category'], anchor?: string): Candidate {
  const graph = discoverUiFiles(plugin)
  const resolved = resolveRef(plugin, graph.files, ref)
  if ('code' in resolved) throw new Error(resolved.message)
  const candidate = selectCandidate(resolved, discoverCandidates(plugin, graph.files), category, anchor)
  if ('code' in candidate) throw new Error(candidate.message)
  return candidate
}

function missingCandidate(subject: PluginInventory, candidate: Candidate, check: string): boolean {
  const source = plugin.sources.find((entry) => entry.file === candidate.file)!
  const line = source.content.slice(0, candidate.anchorStart).split('\n').length
  return auditPlugin(inventory, subject).find((entry) => entry.id === check)!.evidence.some((entry) => entry.code === 'coverage-missing' && entry.source?.file === candidate.file && entry.source.line === line)
}

test('the compact slice covers every owned candidate without masking structural or global failures', () => {
  const graph = discoverUiFiles(plugin)
  expect(graph.failures).toEqual([])
  expect(graph.files.length).toBeGreaterThanOrEqual(18)
  const candidates = discoverCandidates(plugin, graph.files)
  expect(candidates.some((entry) => OWNED.includes(entry.file))).toBe(true)
  expect(coverage.surfaces).toEqual({})
  for (const entry of [...coverage.states, ...coverage.notState, ...coverage.actions]) expect(OWNED).toContain(entry.site.file)
  const declarations = [
    ...(plugin.coverage ? [parseCoverage(plugin.coverage.content)] : []),
    ...(plugin.coverageFragments ?? []).map((entry) => parseCoverage(entry.content)),
  ]
  for (const surface of SURFACES) {
    expect(declarations.filter((entry) => Object.hasOwn(entry.surfaces, surface))).toHaveLength(1)
    for (const state of ['loading', 'empty', 'error'] as const) {
      const witnesses = coverage.states.filter((entry) => entry.surface === surface && entry.state === state)
      expect(witnesses.length).toBeGreaterThan(0)
      for (const entry of witnesses) {
        expect(state === 'loading' ? ['NoticeLine'] : state === 'empty' ? ['EmptyState'] : ['InlineError', 'FormRow']).toContain(entry.render.component)
        if (entry.render.component === 'toast') throw new Error('Expected a shared rendered state')
        expect(OWNED).toContain(entry.render.element.file)
      }
    }
  }
  const failures = auditPlugin(inventory, plugin).flatMap((check) => check.evidence.filter((entry) => {
    if (PASS[entry.code]) return false
    if (entry.code === 'coverage-missing' && entry.source && graph.files.includes(entry.source.file) && !OWNED.includes(entry.source.file)) return false
    if (entry.code === 'state-missing' && check.id === 'empty' && entry.targetId === 'view:quirky.reviews/review') return false
    return true
  }))
  expect(failures).toEqual([])
  expect(checkPlugin(inventory, plugin.id).find((entry) => entry.id === 'compatibility-tokens')?.status).toBe('pass')
})

test('each classification occupies one physical line', () => {
  const lines = plugin.coverageFragments!.find((entry) => entry.file === FRAGMENT)!.content.split('\n')
  for (const section of ['states', 'notState', 'actions'] as const) {
    const start = lines.findIndex((line) => line.trim() === `"${section}": [`)
    const end = lines.findIndex((line, index) => index > start && (line.trim() === '],' || line.trim() === ']'))
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const entries = lines.slice(start + 1, end).filter((line) => line.trim().startsWith('{'))
    expect(entries).toHaveLength(coverage[section].length)
    for (const line of entries) expect(line.trim()).toMatch(/^\{.*\},?$/)
  }
})

test('deleting a routed local action exposes that exact missing candidate', () => {
  const action = coverage.actions.find((entry) => 'route' in entry && entry.route.target === 'command:quirky.reviews/ui-control')
  expect(action).toBeDefined()
  if (!action) throw new Error('Expected a mounted action route')
  const candidate = candidateAt(action.site, 'action', action.anchor)
  expect(missingCandidate(withCoverage({ ...coverage, actions: coverage.actions.filter((entry) => entry !== action) }), candidate, 'commands')).toBe(true)
})

for (const surface of SURFACES) {
  for (const state of ['loading', 'empty', 'error'] as const) {
    test(`deleting ${surface} ${state} evidence exposes its exact candidate`, () => {
      const witness = coverage.states.find((entry) => entry.surface === surface && entry.state === state)!
      expect(witness).toBeDefined()
      const candidate = candidateAt(witness.site, 'state', witness.anchor)
      expect(missingCandidate(withCoverage({ ...coverage, states: coverage.states.filter((entry) => entry !== witness) }), candidate, state)).toBe(true)
    })
  }
}

test('raw markup cannot stand in for a witnessed shared render', () => {
  const state = coverage.states.find((entry) => entry.render.component === 'NoticeLine')!
  expect(state).toBeDefined()
  if (state.render.component !== 'NoticeLine') throw new Error('Expected NoticeLine')
  const { file, quote } = state.render.element
  const raw = quote.replace(/<NoticeLine\b[^>]*>([\s\S]*?)<\/NoticeLine>/, '<p>$1</p>').replace(/<NoticeLine\b[^>]*\/>/, '<p>Loading…</p>')
  expect(raw).not.toBe(quote)
  const changed = { ...plugin, sources: plugin.sources.map((entry) => entry.file === file ? { ...entry, content: entry.content.replace(quote, raw) } : entry) }
  const failures = auditPlugin(inventory, changed).find((entry) => entry.id === state.state)!.evidence
  expect(failures.some((entry) => entry.code === 'evidence-missing' && entry.coverageFile === FRAGMENT)).toBe(true)
})
