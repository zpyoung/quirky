import { beforeAll, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import { discoverCandidates, discoverUiFiles } from '../../../scripts/ui-scoreboard/audit-discovery'
import { parseCoverage, resolveRef, selectCandidate } from '../../../scripts/ui-scoreboard/audit-evidence'
import { auditPlugin } from '../../../scripts/ui-scoreboard/audit'
import { checkPlugin } from '../../../scripts/ui-scoreboard/tokens'
import type { Candidate, CoverageFile, Inventory, PluginInventory, Ref, StateKind } from '../../../scripts/ui-scoreboard/contracts'

const FRAGMENT = 'plugins/quirky.reviews/ui-scoreboard/checks-shell.json'
const UI = 'plugins/quirky.reviews/src/ui.tsx'
const STATUS_BAR = 'plugins/quirky.reviews/src/StatusBarItem.tsx'
const PANEL = 'plugins/quirky.reviews/src/checks/ChecksPanel.tsx'
const DATA = 'plugins/quirky.reviews/src/checks/data.ts'
const OWNED = [UI, STATUS_BAR, PANEL, DATA]
const PANEL_SURFACE = 'panel:quirky.reviews/checks'
const STATUS_BAR_SURFACE = 'status-bar:quirky.reviews/checks'
const CHILD_VIEW_SURFACES = [
  'view:quirky.reviews/create',
  'view:quirky.reviews/review',
  'view:quirky.reviews/settings',
]
const SURFACES = [PANEL_SURFACE, STATUS_BAR_SURFACE, ...CHILD_VIEW_SURFACES]
const UI_CONTROL = 'command:quirky.reviews/ui-control'
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
  return {
    ...plugin,
    coverageFragments: plugin.coverageFragments!.map((fragment) => fragment.file === FRAGMENT
      ? { ...fragment, content: JSON.stringify(value) }
      : fragment),
  }
}

function candidateAt(ref: Ref, category: Candidate['category'], anchor?: string): Candidate {
  const graph = discoverUiFiles(plugin)
  const resolved = resolveRef(plugin, graph.files, ref)
  if ('code' in resolved) throw new Error(resolved.message)
  const candidate = selectCandidate(resolved, discoverCandidates(plugin, graph.files), category, anchor)
  if ('code' in candidate) throw new Error(candidate.message)
  return candidate
}

function withoutPassEvidence(subject: PluginInventory) {
  const graph = discoverUiFiles(subject)
  return auditPlugin(inventory, subject).flatMap((check) => check.evidence
    .filter((entry) => !PASS[entry.code])
    .filter((entry) => {
      if (entry.code === 'coverage-missing' && entry.source && graph.files.includes(entry.source.file) && !OWNED.includes(entry.source.file)) return false
      if (entry.code === 'state-missing' && check.id === 'empty' && CHILD_VIEW_SURFACES.includes(entry.targetId ?? '')) return false
      return true
    }))
}

function expectRemovedStateToExposeCandidate(entry: CoverageFile['states'][number]) {
  const candidate = candidateAt(entry.site, 'state', entry.anchor)
  const changed = withCoverage({ ...coverage, states: coverage.states.filter((state) => state !== entry) })
  const failures = auditPlugin(inventory, changed).find((check) => check.id === entry.state)!.evidence
  const line = candidate.anchorStart
  const source = plugin.sources.find((item) => item.file === candidate.file)!
  const candidateLine = source.content.slice(0, line).split('\n').length
  expect(failures.some((failure) => failure.code === 'coverage-missing' && failure.source?.file === candidate.file && failure.source.line === candidateLine)).toBe(true)
}

test('the fragment declares all five surfaces once and covers the owned production graph', () => {
  const graph = discoverUiFiles(plugin)
  expect(graph.failures).toEqual([])
  expect(graph.files.length).toBeGreaterThanOrEqual(18)

  const candidates = discoverCandidates(plugin, graph.files)
  const ownedCandidates = candidates.filter((candidate) => OWNED.includes(candidate.file))
  expect(ownedCandidates.length).toBeGreaterThan(0)
  expect(candidates.some((candidate) => !OWNED.includes(candidate.file))).toBe(true)
  for (const entry of [...coverage.states, ...coverage.notState, ...coverage.actions]) expect(OWNED).toContain(entry.site.file)
  for (const entry of coverage.states) {
    const references = entry.render.component === 'toast'
      ? [entry.render.call, ...(entry.render.via ?? [])]
      : [entry.render.element, entry.render.import, ...(entry.render.via ?? [])]
    for (const reference of references) expect(OWNED).toContain(reference.file)
  }
  for (const entry of coverage.actions) {
    if ('route' in entry) {
      for (const reference of [entry.route.invoke, ...(entry.route.via ?? [])]) expect(OWNED).toContain(reference.file)
    }
  }

  expect(Object.keys(coverage.surfaces).sort()).toEqual([...SURFACES].sort())
  const declarations = [
    ...(plugin.coverage ? [parseCoverage(plugin.coverage.content)] : []),
    ...(plugin.coverageFragments ?? []).map((fragment) => parseCoverage(fragment.content)),
  ]
  for (const surface of SURFACES) {
    expect(declarations.filter((entry) => Object.hasOwn(entry.surfaces, surface))).toHaveLength(1)
  }
  for (const surface of [PANEL_SURFACE, ...CHILD_VIEW_SURFACES]) {
    expect(coverage.surfaces[surface]).toEqual({
      loading: { applicable: true },
      empty: { applicable: true },
      error: { applicable: true },
    })
  }
  for (const surface of [PANEL_SURFACE, ...CHILD_VIEW_SURFACES]) {
    for (const state of ['loading', 'error'] as const) {
      const entry = coverage.states.find((candidate) => candidate.surface === surface && candidate.state === state && candidate.site.file === UI)
      expect(entry).toBeDefined()
      if (!entry || entry.render.component === 'toast') throw new Error(`Expected shell ${state} shared evidence for ${surface}`)
      expect(entry.render.component).toBe(state === 'loading' ? 'NoticeLine' : 'InlineError')
      expect(entry.render.element.file).toBe(UI)
    }
  }
  for (const state of ['loading', 'empty', 'error'] as const) {
    const entry = coverage.states.find((candidate) => candidate.surface === PANEL_SURFACE && candidate.state === state && candidate.site.file === PANEL)
    expect(entry).toBeDefined()
    if (!entry || entry.render.component === 'toast') throw new Error(`Expected Checks panel ${state} shared evidence`)
    expect(entry.render.component).toBe(state === 'loading' ? 'NoticeLine' : state === 'empty' ? 'EmptyState' : 'InlineError')
  }
  for (const decision of Object.values(coverage.surfaces[STATUS_BAR_SURFACE]!)) {
    expect(decision.applicable).toBe(false)
    if (!decision.applicable) {
      expect(decision.reason).toMatch(/hide|no check data|optional/i)
      expect(decision.evidence.length).toBeGreaterThan(0)
      for (const reference of decision.evidence) {
        expect(reference.file).toBe(STATUS_BAR)
        expect('code' in resolveRef(plugin, graph.files, reference)).toBe(false)
      }
    }
  }

  const uiControlActions = coverage.actions.filter((entry) => 'route' in entry && entry.route.target === UI_CONTROL)
  expect(uiControlActions.length).toBeGreaterThan(0)
  for (const entry of uiControlActions) {
    if (!('route' in entry)) throw new Error('Expected a routed UI control action')
    expect(entry.route.invoke.file).toBe(DATA)
    expect(entry.route.invoke.quote).toMatch(/command\s*:\s*REVIEWS_UI_CONTROL/)
    expect(entry.route.via?.length).toBeGreaterThan(0)
    expect(entry.route.via?.at(-1)?.file).toBe(DATA)
    expect(entry.route.via?.at(-1)?.quote).toMatch(/reviewsUiControlDescriptor/)
  }

  const issues = withoutPassEvidence(plugin)
  expect(issues).toEqual([])
  expect(checkPlugin(inventory, plugin.id).find((check) => check.id === 'compatibility-tokens')?.status).toBe('pass')
})

test('state, notState and action entries stay one physical line each', () => {
  const fragment = plugin.coverageFragments!.find((entry) => entry.file === FRAGMENT)!
  const lines = fragment.content.split('\n')
  for (const section of ['states', 'notState', 'actions'] as const) {
    const start = lines.findIndex((line) => line.trim() === `"${section}": [`)
    expect(start).toBeGreaterThanOrEqual(0)
    const end = lines.findIndex((line, index) => index > start && (line.trim() === '],' || line.trim() === ']'))
    expect(end).toBeGreaterThan(start)
    const entries = lines.slice(start + 1, end).filter((line) => line.trim().startsWith('{'))
    expect(entries).toHaveLength(coverage[section].length)
    for (const line of entries) expect(line.trim()).toMatch(/^\{.*\},?$/)
  }
})

test('removing an owned public route exposes its exact missing candidate', () => {
  const action = coverage.actions.find((entry) => 'route' in entry && entry.route.target === UI_CONTROL)
  expect(action).toBeDefined()
  if (!action || !('route' in action)) throw new Error('Expected a routed UI control action')
  const candidate = candidateAt(action.site, 'action', action.anchor)
  const changed = withCoverage({ ...coverage, actions: coverage.actions.filter((entry) => entry !== action) })
  const failures = auditPlugin(inventory, changed).find((check) => check.id === 'commands')!.evidence
  const source = plugin.sources.find((item) => item.file === candidate.file)!
  const candidateLine = source.content.slice(0, candidate.anchorStart).split('\n').length
  expect(failures.some((entry) => entry.code === 'coverage-missing' && entry.source?.file === candidate.file && entry.source.line === candidateLine)).toBe(true)
})

for (const state of ['loading', 'error', 'empty'] as const satisfies readonly StateKind[]) {
  test(`removing owned ${state} evidence exposes its exact missing candidate`, () => {
    const entry = coverage.states.find((candidate) => candidate.state === state)
    expect(entry).toBeDefined()
    if (!entry) throw new Error(`Expected an owned ${state} state entry`)
    expectRemovedStateToExposeCandidate(entry)
  })
}

test('replacing a witnessed shared loading render with raw markup invalidates its evidence', () => {
  const state = coverage.states.find((entry) => entry.state === 'loading' && entry.render.component === 'NoticeLine')
  expect(state).toBeDefined()
  if (!state || state.render.component !== 'NoticeLine') throw new Error('Expected a shared loading component')
  const element = state.render.element
  const quote = element.quote
  const raw = quote
    .replace(/<NoticeLine\b[^>]*>([\s\S]*?)<\/NoticeLine>/, '<p>$1</p>')
    .replace(/<NoticeLine\b[^>]*\/>/, '<p>Loading review…</p>')
  expect(raw).not.toBe(quote)
  const edited: PluginInventory = {
    ...plugin,
    sources: plugin.sources.map((source) => source.file === element.file
      ? { ...source, content: source.content.replace(quote, raw) }
      : source),
  }
  const check = auditPlugin(inventory, edited).find((entry) => entry.id === state.state)!
  expect(check.status).toBe('fail')
  expect(check.evidence.some((entry) => entry.code === 'evidence-missing' && entry.coverageFile === FRAGMENT)).toBe(true)
})

test('authentication failure is covered as a shared Checks error', () => {
  const entry = coverage.states.find((candidate) => candidate.surface === PANEL_SURFACE
    && candidate.state === 'error'
    && candidate.site.file === PANEL
    && candidate.site.quote.includes('authenticationFailure'))
  expect(entry).toBeDefined()
  if (!entry || entry.render.component === 'toast') throw new Error('Expected a shared authentication error')
  expect(entry.render.component).toBe('InlineError')
  expect(withoutPassEvidence(plugin)).toEqual([])
  expectRemovedStateToExposeCandidate(entry)
})

for (const anchor of [
  "diagnosticProvider === 'GitHub' && diagnosticData.ghAvailable === false &&",
  "active.conflicts?.status === 'unavailable' &&",
]) {
  test(`unavailable diagnostic has shared error evidence: ${anchor}`, () => {
    const entry = coverage.states.find((state) => state.surface === PANEL_SURFACE
      && state.site.file === PANEL && state.anchor === anchor)
    expect(entry).toBeDefined()
    if (!entry || entry.render.component !== 'InlineError') throw new Error('Expected a shared diagnostic error')
    expect(entry.state).toBe('error')
    expect(entry.render.import.file).toBe(PANEL)
    expect(entry.render.import.quote).toContain('@quirky/ui')
    expectRemovedStateToExposeCandidate(entry)
    const element = entry.render.element
    const raw = element.quote.replace(/<InlineError\b[\s\S]*\/>/, '<p>Diagnostic unavailable</p>')
    expect(raw).not.toBe(element.quote)
    const edited: PluginInventory = {
      ...plugin,
      sources: plugin.sources.map((source) => source.file === element.file
        ? { ...source, content: source.content.replace(element.quote, raw) }
        : source),
    }
    const check = auditPlugin(inventory, edited).find((result) => result.id === 'error')!
    expect(check.status).toBe('fail')
    expect(check.evidence.some((failure) => failure.code === 'evidence-missing' && failure.coverageFile === FRAGMENT)).toBe(true)
  })
}
