import { beforeAll, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import { discoverCandidates, discoverUiFiles } from '../../../scripts/ui-scoreboard/audit-discovery'
import { parseCoverage, resolveRef, selectCandidate } from '../../../scripts/ui-scoreboard/audit-evidence'
import { auditPlugin } from '../../../scripts/ui-scoreboard/audit'
import { checkPlugin } from '../../../scripts/ui-scoreboard/tokens'
import type { Candidate, CheckResult, CoverageFile, Evidence, Inventory, PluginInventory } from '../../../scripts/ui-scoreboard/contracts'

const EDITOR = 'plugins/quirky.editor'
const FRAGMENT = `${EDITOR}/ui-scoreboard/document-and-source.json`
const PARENT = `${EDITOR}/ui-scoreboard/explorer-and-overlays.json`
const OWNED = [`${EDITOR}/src/window/DocumentSurface.tsx`, `${EDITOR}/src/window/SourceEditor.tsx`]
const COMMAND = 'command:quirky.editor/ui-control'
const SURFACE = 'view:quirky.editor/document'
const PASS: Record<string, true> = { 'state-covered': true, 'state-not-applicable': true, 'not-state': true, 'action-routed': true, 'action-transient': true, 'action-not-user': true }
let inventory: Inventory
let plugin: PluginInventory
let graph: { files: string[]; failures: Evidence[] }
let candidates: Candidate[]
let coverage: CoverageFile
let baselineChecks: CheckResult[]

beforeAll(() => {
  inventory = collectInventory(resolve(import.meta.dir, '../../..'))
  expect(inventory.failures).toEqual([])
  plugin = inventory.plugins.find((entry) => entry.id === 'quirky.editor')!
  graph = discoverUiFiles(plugin)
  expect(graph.failures).toEqual([])
  candidates = discoverCandidates(plugin, graph.files)
  const fragment = plugin.coverageFragments?.find((entry) => entry.file === FRAGMENT)
  expect(fragment).toBeDefined()
  coverage = parseCoverage(fragment!.content)
  baselineChecks = checkPlugin(inventory, plugin.id)
})

function withCoverage(value: CoverageFile): PluginInventory {
  return { ...plugin, coverageFragments: plugin.coverageFragments!.map((fragment) => fragment.file === FRAGMENT
    ? { ...fragment, content: JSON.stringify(value) } : fragment) }
}
function issues(value = plugin): Evidence[] {
  const checks = value === plugin ? baselineChecks.filter((check) => check.id !== 'compatibility-tokens') : auditPlugin(inventory, value)
  return checks.flatMap((check) => check.evidence.filter((entry) => !PASS[entry.code]))
}
function routeFor(file: string) {
  const entry = coverage.actions.find((action) => action.site.file === file && 'route' in action && action.route.target === COMMAND)
  if (!entry || !('route' in entry)) throw new Error(`No addressed control route in ${file}`)
  return entry
}

test('document/source owns the complete two-file slice without declaring sibling surfaces', () => {
  expect(coverage.surfaces).toEqual({})
  for (const file of OWNED) {
    expect(graph.files).toContain(file)
    expect(candidates.filter((candidate) => candidate.file === file).length).toBeGreaterThan(0)
  }
  const declarations = (plugin.coverageFragments ?? []).filter((fragment) => Object.hasOwn(parseCoverage(fragment.content).surfaces, SURFACE))
  expect(declarations.map((entry) => entry.file)).toEqual([PARENT])
  for (const kind of ['loading', 'empty', 'error']) {
    expect(coverage.states.some((entry) => entry.surface === SURFACE && entry.state === kind)).toBe(true)
  }
  for (const entry of [...coverage.states, ...coverage.notState, ...coverage.actions]) expect(OWNED).toContain(entry.site.file)
  const failures = issues()
  expect(failures.filter((entry) => OWNED.includes(entry.source?.file ?? '') || entry.coverageFile === FRAGMENT)).toEqual([])
  for (const entry of failures) {
    expect(entry.code).toBe('coverage-missing')
    expect(entry.source).toBeDefined()
    expect(graph.files).toContain(entry.source!.file)
    expect(OWNED).not.toContain(entry.source!.file)
    const source = plugin.sources.find((source) => source.file === entry.source!.file)!
    expect(candidates.some((candidate) => candidate.file === source.file
      && source.content.slice(0, candidate.anchorStart).split('\n').length === entry.source!.line)).toBe(true)
  }
  expect(baselineChecks.find((entry) => entry.id === 'compatibility-tokens')?.status).toBe('pass')
})

test.each(OWNED)('the descriptor in %s resolves to the public ui run route', (file) => {
  const action = routeFor(file)
  expect(action.route.invoke.quote).toMatch(/command\s*:\s*EDITOR_UI_CONTROL_COMMAND/)
  const invoke = resolveRef(plugin, graph.files, action.route.invoke)
  if ('code' in invoke) throw new Error(invoke.message)
  const line = invoke.source.getLineAndCharacterOfPosition(invoke.start).line + 1
  expect(baselineChecks.find((check) => check.id === 'commands')!.evidence).toContainEqual(expect.objectContaining({
    code: 'action-routed', source: expect.objectContaining({ file: invoke.file, line }),
    api: 'ui.command.run', cli: `quirky ui run ${COMMAND}`,
  }))
})

test('removing a real document action exposes that candidate', () => {
  const action = routeFor(OWNED[0]!)
  const site = resolveRef(plugin, graph.files, action.site)
  if ('code' in site) throw new Error(site.message)
  const candidate = selectCandidate(site, candidates, 'action', action.anchor)
  if ('code' in candidate) throw new Error(candidate.message)
  const line = site.source.getLineAndCharacterOfPosition(candidate.anchorStart).line + 1
  expect(issues(withCoverage({ ...coverage, actions: coverage.actions.filter((entry) => entry !== action) }))).toContainEqual(expect.objectContaining({
    code: 'coverage-missing', source: expect.objectContaining({ file: candidate.file, line }),
  }))
})

test('replacing a witnessed shared error with raw markup invalidates error evidence', () => {
  const state = coverage.states.find((entry) => entry.state === 'error' && entry.render.component === 'InlineError')!
  expect(state).toBeDefined()
  if (state.render.component !== 'InlineError') throw new Error('Expected shared error evidence')
  const { file, quote } = state.render.element
  const raw = quote.replace(/<InlineError\b/, '<div')
  expect(raw).not.toBe(quote)
  const edited = { ...plugin, sources: plugin.sources.map((source) => source.file === file
    ? { ...source, content: source.content.replace(quote, raw) } : source) }
  expect(auditPlugin(inventory, edited).find((check) => check.id === 'error')!.evidence).toContainEqual(expect.objectContaining({
    code: 'evidence-missing', coverageFile: FRAGMENT,
  }))
})
