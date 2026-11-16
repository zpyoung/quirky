import { beforeAll, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import { discoverCandidates, discoverUiFiles } from '../../../scripts/ui-scoreboard/audit-discovery'
import { parseCoverage, resolveRef, selectCandidate } from '../../../scripts/ui-scoreboard/audit-evidence'
import { auditPlugin } from '../../../scripts/ui-scoreboard/audit'
import { checkPlugin } from '../../../scripts/ui-scoreboard/tokens'
import type { Candidate, CoverageFile, Evidence, Inventory, PluginInventory } from '../../../scripts/ui-scoreboard/contracts'

const EDITOR = 'plugins/quirky.editor'
const FRAGMENT = `${EDITOR}/ui-scoreboard/notebook-and-mermaid.json`
const UI_CONTROL_FILE = `${EDITOR}/src/window/uiControl.tsx`
const UI_CONTROL_COMMAND = 'command:quirky.editor/ui-control'
const DOCUMENT_SURFACE = 'view:quirky.editor/document'
const NOTEBOOK_FILE = `${EDITOR}/src/notebook/NotebookSurface.tsx`
const MERMAID_FILE = `${EDITOR}/src/markdown/MermaidDiagram.tsx`
const OPERATIONS_FILE = `${EDITOR}/src/markdown/operations.ts`
const PIPELINE_FILE = `${EDITOR}/src/markdown/previewPipeline.ts`
const SOURCE_FILE = `${EDITOR}/src/markdown/source.ts`
const OWNED_FILES = [NOTEBOOK_FILE, MERMAID_FILE, OPERATIONS_FILE, PIPELINE_FILE, SOURCE_FILE]
const OWNED = new Set(OWNED_FILES)
const HELPER_FILES = new Set([OPERATIONS_FILE, PIPELINE_FILE, SOURCE_FILE])
const UI_FILES = new Set([NOTEBOOK_FILE, MERMAID_FILE])
const PASS_CODES: Record<string, true> = {
  'state-covered': true,
  'state-not-applicable': true,
  'not-state': true,
  'action-routed': true,
  'action-transient': true,
  'action-not-user': true,
}

let inventory: Inventory
let plugin: PluginInventory
let graph: { files: string[]; failures: Evidence[] }
let candidates: Candidate[]
let candidateLocations: Set<string>

beforeAll(() => {
  inventory = collectInventory(resolve(import.meta.dir, '../../..'))
  expect(inventory.failures).toEqual([])
  plugin = inventory.plugins.find((entry) => entry.id === 'quirky.editor')!
  expect(plugin).toBeDefined()
  graph = discoverUiFiles(plugin)
  expect(graph.failures).toEqual([])
  candidates = discoverCandidates(plugin, graph.files)
  candidateLocations = new Set(candidates.map((candidate) => `${candidate.file}:${lineOf(candidate)}`))
})

function fragmentCoverage(): CoverageFile {
  const fragment = plugin.coverageFragments?.find((entry) => entry.file === FRAGMENT)
  expect(fragment).toBeDefined()
  if (!fragment) throw new Error(`Missing ${FRAGMENT}`)
  return parseCoverage(fragment.content)
}

function withCoverage(value: CoverageFile): PluginInventory {
  return {
    ...plugin,
    coverageFragments: plugin.coverageFragments!.map((fragment) => fragment.file === FRAGMENT
      ? { ...fragment, content: JSON.stringify(value) }
      : fragment),
  }
}

function withSource(file: string, content: string): PluginInventory {
  return { ...plugin, sources: plugin.sources.map((source) => source.file === file ? { ...source, content } : source) }
}

function lineOf(candidate: Candidate, value: PluginInventory = plugin): number {
  const source = value.sources.find((entry) => entry.file === candidate.file)!
  return source.content.slice(0, candidate.anchorStart).split('\n').length
}

function isAllowedSiblingGap(checkId: string, entry: Evidence): boolean {
  if (entry.code === 'state-missing') return ['loading', 'empty', 'error'].includes(checkId) && entry.targetId === DOCUMENT_SURFACE
  if (entry.code !== 'coverage-missing' || !entry.source || OWNED.has(entry.source.file) || !graph.files.includes(entry.source.file)) return false
  return candidateLocations.has(`${entry.source.file}:${entry.source.line}`)
}

function routeAction(value: CoverageFile, file: string): Extract<CoverageFile['actions'][number], { route: unknown }> | undefined {
  return value.actions.find((entry): entry is Extract<CoverageFile['actions'][number], { route: unknown }> =>
    'route' in entry && entry.site.file === file && entry.route.target === UI_CONTROL_COMMAND)
}

function expectMissingAction(action: CoverageFile['actions'][number], value: CoverageFile): Candidate {
  const site = resolveRef(plugin, graph.files, action.site)
  if ('code' in site) throw new Error(site.message)
  const candidate = selectCandidate(site, candidates, 'action', action.anchor)
  if ('code' in candidate) throw new Error(candidate.message)
  const edited = withCoverage({ ...value, actions: value.actions.filter((entry) => entry !== action) })
  const commandCheck = auditPlugin(inventory, edited).find((check) => check.id === 'commands')!
  expect(commandCheck.evidence).toContainEqual(expect.objectContaining({
    code: 'coverage-missing',
    source: expect.objectContaining({ file: candidate.file, line: lineOf(candidate) }),
  }))
  return candidate
}

test('the helper files contain no misleading assignment candidates', () => {
  expect(OWNED_FILES.every((file) => graph.files.includes(file))).toBe(true)
  expect(candidates.filter((candidate) => HELPER_FILES.has(candidate.file))).toEqual([])
})

test('the full graph fragment covers its owned candidates without declaring surfaces', () => {
  const coverage = fragmentCoverage()
  expect(plugin.targets).toContain(DOCUMENT_SURFACE)
  expect(OWNED_FILES.every((file) => graph.files.includes(file))).toBe(true)
  const ownedCandidates = candidates.filter((candidate) => OWNED.has(candidate.file))
  expect(ownedCandidates.length).toBeGreaterThan(0)
  expect(candidates.length).toBeGreaterThan(ownedCandidates.length)
  expect(coverage.surfaces).toEqual({})

  for (const state of coverage.states) {
    expect(OWNED).toContain(state.site.file)
    if (state.render.component === 'toast') {
      expect(OWNED).toContain(state.render.call.file)
      for (const via of state.render.via ?? []) expect(OWNED).toContain(via.file)
    } else {
      expect(OWNED).toContain(state.render.element.file)
      expect(OWNED).toContain(state.render.import.file)
      for (const via of state.render.via ?? []) expect(OWNED).toContain(via.file)
    }
  }
  for (const entry of coverage.notState) expect(OWNED).toContain(entry.site.file)
  for (const entry of coverage.actions) {
    expect(OWNED).toContain(entry.site.file)
    if ('route' in entry) {
      expect(UI_CONTROL_FILE).toBe(entry.route.invoke.file)
      expect(entry.route.via?.length ?? 0).toBeGreaterThan(0)
    }
  }

  const checks = auditPlugin(inventory, plugin)
  const issues = checks.flatMap((check) => check.evidence.filter((entry) => PASS_CODES[entry.code] !== true))
  const ownedIssues = issues.filter((entry) => OWNED.has(entry.source?.file ?? '') || entry.coverageFile === FRAGMENT)
  expect(ownedIssues).toEqual([])
  for (const check of checks) {
    for (const issue of check.evidence.filter((entry) => PASS_CODES[entry.code] !== true && !ownedIssues.includes(entry))) {
      expect(isAllowedSiblingGap(check.id, issue)).toBe(true)
    }
  }
  expect(checkPlugin(inventory, plugin.id).find((check) => check.id === 'compatibility-tokens')?.status).toBe('pass')
}, 30_000)

test('the descriptor command remains linked to its public CLI route', () => {
  const coverage = fragmentCoverage()
  const action = coverage.actions.find((entry) => 'route' in entry && UI_FILES.has(entry.site.file)
    && entry.route.target === UI_CONTROL_COMMAND && entry.route.invoke.file === UI_CONTROL_FILE)
  expect(action).toBeDefined()
  if (!action || !('route' in action)) throw new Error('Expected an owned route through the ui-control descriptor')
  expect(action.route.invoke.quote).toMatch(/\bcommand\s*:\s*EDITOR_UI_CONTROL_COMMAND\b/)
  expect(action.route.via?.length ?? 0).toBeGreaterThan(0)

  const invocation = resolveRef(plugin, graph.files, action.route.invoke)
  if ('code' in invocation) throw new Error(invocation.message)
  const commandCheck = auditPlugin(inventory, plugin).find((check) => check.id === 'commands')!
  expect(commandCheck.evidence).toContainEqual(expect.objectContaining({
    code: 'action-routed',
    source: { file: UI_CONTROL_FILE, line: invocation.source.getLineAndCharacterOfPosition(invocation.start).line + 1, column: expect.any(Number) },
    api: 'ui.command.run',
    cli: `quirky ui run ${UI_CONTROL_COMMAND}`,
  }))
})

test('removing the Notebook control entry exposes its actual action candidate', () => {
  const coverage = fragmentCoverage()
  const action = routeAction(coverage, NOTEBOOK_FILE)
  expect(action).toBeDefined()
  if (!action) throw new Error('Expected a Notebook ui-control route')
  expectMissingAction(action, coverage)
})

test('removing the Mermaid Retry entry exposes its actual action candidate', () => {
  const coverage = fragmentCoverage()
  const action = routeAction(coverage, MERMAID_FILE)
  expect(action).toBeDefined()
  if (!action) throw new Error('Expected a Mermaid ui-control Retry route')
  expectMissingAction(action, coverage)
})

test('replacing a witnessed Mermaid InlineError invalidates its render evidence', () => {
  const coverage = fragmentCoverage()
  const state = coverage.states.find((entry) => entry.site.file === MERMAID_FILE
    && entry.state === 'error' && entry.render.component === 'InlineError')
  expect(state).toBeDefined()
  if (!state || state.render.component !== 'InlineError') throw new Error('Expected a Mermaid InlineError state')
  const render = state.render
  if (!('element' in render)) throw new Error('Expected an element-based Mermaid error render')
  const quote = render.element.quote
  const raw = quote.replace(/<InlineError\b/, '<div').replace(/<\/InlineError>/, '</div>')
  expect(raw).not.toBe(quote)
  const source = plugin.sources.find((entry) => entry.file === render.element.file)!
  const edited = withSource(source.file, source.content.replace(quote, raw))
  const check = auditPlugin(inventory, edited).find((entry) => entry.id === state.state)!
  expect(check.status).toBe('fail')
  expect(check.evidence).toContainEqual(expect.objectContaining({ code: 'evidence-missing', coverageFile: FRAGMENT }))
})

for (const replacement of [
  {
    file: OPERATIONS_FILE,
    transformed: 'lines.splice(openLine, 1, `${indentation}${marker}${language}`)',
    original: 'lines[openLine] = `${indentation}${marker}${language}`',
  },
  {
    file: PIPELINE_FILE,
    transformed: 'Reflect.set(data, MARKDOWN_CLASS_MARKER, true)',
    original: 'data[MARKDOWN_CLASS_MARKER] = true',
  },
  {
    file: PIPELINE_FILE,
    transformed: 'Reflect.set(data, MARKDOWN_HEADING_MARKER, true)',
    original: 'data[MARKDOWN_HEADING_MARKER] = true',
  },
  {
    file: SOURCE_FILE,
    transformed: 'details.splice(details.length - 1, 1, true)',
    original: 'details[details.length - 1] = true',
  },
]) {
  test(`restoring ${replacement.transformed} exposes a missing helper candidate`, () => {
    const source = plugin.sources.find((entry) => entry.file === replacement.file)!
    const restoredContent = source.content.replace(replacement.transformed, replacement.original)
    expect(restoredContent).not.toBe(source.content)
    const restored = withSource(source.file, restoredContent)
    const restoredCandidates = discoverCandidates(restored, graph.files)
    const candidate = restoredCandidates.find((entry) => entry.file === replacement.file)
    expect(candidate).toBeDefined()
    if (!candidate) throw new Error(`Restored write did not expose a candidate in ${replacement.file}`)
    expect(candidate.kind).toBe('unresolved-assignment')
    const missing = auditPlugin(inventory, restored).flatMap((check) => check.evidence)
      .find((entry) => entry.code === 'coverage-missing' && entry.source?.file === candidate.file && entry.source.line === lineOf(candidate, restored))
    expect(missing).toBeDefined()
  })
}

