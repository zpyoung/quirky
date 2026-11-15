import { beforeAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import { discoverCandidates, discoverUiFiles } from '../../../scripts/ui-scoreboard/audit-discovery'
import { parseCoverage, resolveRef, selectCandidate } from '../../../scripts/ui-scoreboard/audit-evidence'
import { auditPlugin } from '../../../scripts/ui-scoreboard/audit'
import { checkPlugin } from '../../../scripts/ui-scoreboard/tokens'
import type { Candidate, CoverageFile, Evidence, Inventory, PluginInventory } from '../../../scripts/ui-scoreboard/contracts'

const EDITOR = 'plugins/quirky.editor'
const FRAGMENT = `${EDITOR}/ui-scoreboard/explorer-and-overlays.json`
const UI_CONTROL_FILE = `${EDITOR}/src/window/uiControl.tsx`
const UI_CONTROL_COMMAND = 'command:quirky.editor/ui-control'
const DOCUMENT_SURFACE = 'view:quirky.editor/document'
const SURFACES = [
  'overlay:quirky.editor/close',
  'overlay:quirky.editor/quick-open',
  'panel:quirky.editor/explorer',
  'sidebar-section:quirky.editor/explorer',
  DOCUMENT_SURFACE,
]
const OWNED_FILES = [
  `${EDITOR}/src/ui.tsx`,
  `${EDITOR}/src/window/ExplorerPanel.tsx`,
  `${EDITOR}/src/window/QuickOpenOverlay.tsx`,
  `${EDITOR}/src/window/CloseOverlay.tsx`,
  `${EDITOR}/src/window/overlayState.ts`,
  `${EDITOR}/src/window/editorFocus.ts`,
  UI_CONTROL_FILE,
]
const OWNED = new Set(OWNED_FILES)
const ROUTE_HELPERS = new Set([`${EDITOR}/src/window/settings.ts`])
const ROUTE_EVIDENCE_FILES = new Set([...OWNED_FILES, ...ROUTE_HELPERS])
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
let coverage: CoverageFile

beforeAll(() => {
  inventory = collectInventory(resolve(import.meta.dir, '../../..'))
  expect(inventory.failures).toEqual([])
  plugin = inventory.plugins.find((entry) => entry.id === 'quirky.editor')!
  expect(plugin).toBeDefined()

  graph = discoverUiFiles(plugin)
  expect(graph.failures).toEqual([])
  expect(graph.files.length).toBeGreaterThanOrEqual(31)

  const fragment = plugin.coverageFragments?.find((entry) => entry.file === FRAGMENT)
  expect(fragment).toBeDefined()
  coverage = parseCoverage(fragment!.content)
  candidates = discoverCandidates(plugin, graph.files)
})

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

function controlRoute() {
  const action = coverage.actions.find((entry) => 'route' in entry
    && entry.route.target === UI_CONTROL_COMMAND
    && entry.route.invoke.file === UI_CONTROL_FILE
    && OWNED.has(entry.site.file))
  expect(action).toBeDefined()
  if (!action || !('route' in action)) throw new Error('Expected a routed ui-control descriptor action')
  return action
}

function isAllowedSiblingGap(checkId: string, entry: Evidence): boolean {
  // The document surface is declared here, but its state witnesses belong to the sibling document-source slice.
  if (entry.code === 'state-missing') {
    return ['loading', 'empty', 'error'].includes(checkId) && entry.targetId === DOCUMENT_SURFACE
  }
  if (entry.code !== 'coverage-missing' || !entry.source || OWNED.has(entry.source.file) || !graph.files.includes(entry.source.file)) return false
  const source = plugin.sources.find((item) => item.file === entry.source!.file)
  return !!source && candidates.some((candidate) => candidate.file === entry.source!.file
    && source.content.slice(0, candidate.anchorStart).split('\n').length === entry.source!.line)
}

test('the full graph fragment owns exactly five surfaces and covers only this source slice', () => {
  expect(plugin.targets.toSorted()).toEqual(SURFACES.toSorted())
  expect(OWNED_FILES.every((file) => graph.files.includes(file))).toBe(true)

  const ownedCandidates = candidates.filter((candidate) => OWNED.has(candidate.file))
  expect(ownedCandidates.length).toBeGreaterThan(0)
  expect(candidates.length).toBeGreaterThan(ownedCandidates.length)

  expect(Object.keys(coverage.surfaces).sort()).toEqual([...SURFACES].sort())
  for (const sibling of plugin.coverageFragments ?? []) {
    if (sibling.file === FRAGMENT) continue
    const other = parseCoverage(sibling.content)
    expect(Object.keys(other.surfaces).filter((surface) => SURFACES.includes(surface))).toEqual([])
  }
  for (const decision of Object.values(coverage.surfaces).flatMap((surface) => [surface.loading, surface.empty, surface.error])) {
    if (!decision.applicable) for (const reference of decision.evidence) expect(OWNED).toContain(reference.file)
  }
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
      expect(ROUTE_EVIDENCE_FILES).toContain(entry.route.invoke.file)
      for (const via of entry.route.via ?? []) expect(ROUTE_EVIDENCE_FILES).toContain(via.file)
    }
  }

  const checks = auditPlugin(inventory, plugin)
  const allIssues = checks.flatMap((check) => check.evidence.filter((entry) => PASS_CODES[entry.code] !== true))
  const ownedIssues = allIssues.filter((entry) => OWNED.has(entry.source?.file ?? '')
    || (entry.coverageFile === FRAGMENT && !(entry.code === 'state-missing' && entry.targetId === DOCUMENT_SURFACE))
    || (SURFACES.includes(entry.targetId ?? '') && !(entry.code === 'state-missing' && entry.targetId === DOCUMENT_SURFACE)))
  expect(ownedIssues).toEqual([])

  for (const check of checks) {
    for (const entry of check.evidence.filter((item) => PASS_CODES[item.code] !== true && !ownedIssues.includes(item))) {
      expect(isAllowedSiblingGap(check.id, entry)).toBe(true)
    }
  }

  expect(checkPlugin(inventory, plugin.id).find((check) => check.id === 'compatibility-tokens')?.status).toBe('pass')
  const ratchet = JSON.parse(readFileSync(resolve(import.meta.dir, '../../../scripts/ui-scoreboard-ratchet.json'), 'utf8')) as Record<string, unknown>
  expect(Object.hasOwn(ratchet, plugin.id)).toBe(false)
})

test('the ui-control descriptor command resolves to its declared public CLI route', () => {
  const action = controlRoute()
  expect(action.route.invoke.quote).toMatch(/\bcommand\s*:\s*EDITOR_UI_CONTROL_COMMAND\b/)

  const invocation = resolveRef(plugin, graph.files, action.route.invoke)
  if ('code' in invocation) throw new Error(invocation.message)
  const expectedLine = invocation.source.getLineAndCharacterOfPosition(invocation.start).line + 1
  const commandCheck = auditPlugin(inventory, plugin).find((check) => check.id === 'commands')!
  expect(commandCheck.evidence).toContainEqual(expect.objectContaining({
    code: 'action-routed',
    source: { file: UI_CONTROL_FILE, line: expectedLine, column: expect.any(Number) },
    api: 'ui.command.run',
    cli: `quirky ui run ${UI_CONTROL_COMMAND}`,
  }))
})

test('removing the routed ui-control action exposes its actual owned candidate', () => {
  const action = controlRoute()
  const site = resolveRef(plugin, graph.files, action.site)
  if ('code' in site) throw new Error(site.message)
  const candidate = selectCandidate(site, candidates, 'action', action.anchor)
  if ('code' in candidate) throw new Error(candidate.message)
  const line = site.source.getLineAndCharacterOfPosition(candidate.anchorStart).line + 1
  const edited = withCoverage({ ...coverage, actions: coverage.actions.filter((entry) => entry !== action) })
  const commandCheck = auditPlugin(inventory, edited).find((check) => check.id === 'commands')!

  expect(commandCheck.evidence).toContainEqual(expect.objectContaining({
    code: 'coverage-missing',
    source: expect.objectContaining({ file: candidate.file, line }),
  }))
})

test('replacing a witnessed NoticeLine with raw markup invalidates its render evidence', () => {
  const state = coverage.states.find((entry) => entry.state === 'loading'
    && entry.render.component === 'NoticeLine'
    && OWNED.has(entry.site.file))
  expect(state).toBeDefined()
  if (!state || state.render.component !== 'NoticeLine') throw new Error('Expected an owned NoticeLine render')
  const element = state.render.element

  const quote = element.quote
  const raw = quote
    .replace(/<NoticeLine\b([^>]*)>([\s\S]*?)<\/NoticeLine>/, '<p$1>$2</p>')
    .replace(/<NoticeLine\b([^>]*)\s*\/>/, '<p$1 />')
  expect(raw).not.toBe(quote)
  const source = plugin.sources.find((entry) => entry.file === element.file)!
  const edited = withSource(source.file, source.content.replace(quote, raw))
  const check = auditPlugin(inventory, edited).find((entry) => entry.id === state.state)!

  expect(check.status).toBe('fail')
  expect(check.evidence).toContainEqual(expect.objectContaining({ code: 'evidence-missing', coverageFile: FRAGMENT }))
})
