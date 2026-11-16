import { beforeAll, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import { discoverCandidates, discoverUiFiles } from '../../../scripts/ui-scoreboard/audit-discovery'
import { parseCoverage, resolveRef, resolveVia, selectCandidate } from '../../../scripts/ui-scoreboard/audit-evidence'
import { auditPlugin } from '../../../scripts/ui-scoreboard/audit'
import { checkPlugin } from '../../../scripts/ui-scoreboard/tokens'
import type { Candidate, CoverageFile, Evidence, Inventory, PluginInventory } from '../../../scripts/ui-scoreboard/contracts'

const EDITOR = 'plugins/quirky.editor'
const FRAGMENT = `${EDITOR}/ui-scoreboard/viewers-and-changes.json`
const PARENT_FRAGMENT = `${EDITOR}/ui-scoreboard/explorer-and-overlays.json`
const VIEWER = `${EDITOR}/src/viewers/ViewerSurface.tsx`
const CHANGES = `${EDITOR}/src/window/ChangesSurface.tsx`
const CONTROL = `${EDITOR}/src/window/uiControl.tsx`
const OWNED = new Set([VIEWER, CHANGES])
const SURFACE = 'view:quirky.editor/document'
const COMMAND = 'command:quirky.editor/ui-control'
const PASS: Record<string, true> = { 'state-covered': true, 'state-not-applicable': true, 'not-state': true, 'action-routed': true, 'action-transient': true, 'action-not-user': true }
let inventory: Inventory
let plugin: PluginInventory
let graph: { files: string[]; failures: Evidence[] }
let candidates: Candidate[]
let coverage: CoverageFile

beforeAll(() => {
  inventory = collectInventory(resolve(import.meta.dir, '../../..'))
  expect(inventory.failures).toEqual([])
  plugin = inventory.plugins.find(({ id }) => id === 'quirky.editor')!
  expect(plugin).toBeDefined()
  graph = discoverUiFiles(plugin)
  expect(graph.failures).toEqual([])
  candidates = discoverCandidates(plugin, graph.files)
  const fragment = plugin.coverageFragments?.find(({ file }) => file === FRAGMENT)
  expect(fragment).toBeDefined()
  coverage = parseCoverage(fragment!.content)
})

function withCoverage(next: CoverageFile): PluginInventory {
  return { ...plugin, coverageFragments: plugin.coverageFragments!.map((fragment) => fragment.file === FRAGMENT
    ? { ...fragment, content: JSON.stringify(next) } : fragment) }
}

function routeFor(file: string) {
  const action = coverage.actions.find((entry) => entry.site.file === file && 'route' in entry && entry.route.target === COMMAND)
  if (!action || !('route' in action)) throw new Error(`No public control route for ${file}`)
  return action
}

test('viewer and Changes evidence covers the full production slice without declaring parent surfaces', () => {
  expect(coverage.surfaces).toEqual({})
  for (const file of OWNED) {
    expect(graph.files).toContain(file)
    expect(candidates.filter((candidate) => candidate.file === file).length).toBeGreaterThan(0)
  }
  const declarations = (plugin.coverageFragments ?? []).flatMap((fragment) =>
    Object.keys(parseCoverage(fragment.content).surfaces).map((surface) => ({ surface, file: fragment.file })))
  for (const target of plugin.targets) expect(declarations.filter(({ surface }) => surface === target)).toEqual([
    { surface: target, file: PARENT_FRAGMENT },
  ])
  for (const entry of coverage.states) {
    expect(entry.surface).toBe(SURFACE)
    expect(OWNED.has(entry.site.file)).toBe(true)
    expect(entry.render.component).not.toBe('toast')
    if (entry.render.component !== 'toast') {
      expect(OWNED.has(entry.render.element.file)).toBe(true)
      expect(OWNED.has(entry.render.import.file)).toBe(true)
    }
  }
  for (const entry of [...coverage.notState, ...coverage.actions]) expect(OWNED.has(entry.site.file)).toBe(true)
  for (const entry of coverage.actions) if ('route' in entry) {
    expect(new Set([...OWNED, CONTROL]).has(entry.route.invoke.file)).toBe(true)
    for (const via of entry.route.via ?? []) expect(new Set([...OWNED, CONTROL]).has(via.file)).toBe(true)
  }
  const checks = auditPlugin(inventory, plugin)
  const failures = checks.flatMap((check) => check.evidence.filter(({ code }) => !PASS[code]))
  expect(failures.filter((entry) => OWNED.has(entry.source?.file ?? '') || entry.coverageFile === FRAGMENT)).toEqual([])
  for (const entry of failures) {
    // The parent owns the document declaration; other document renderers may still contribute state evidence.
    if (entry.code === 'state-missing') {
      expect(entry.targetId).toBe(SURFACE)
      continue
    }
    expect(entry.code).toBe('coverage-missing')
    expect(OWNED.has(entry.source?.file ?? '')).toBe(false)
    expect(graph.files).toContain(entry.source!.file)
    const source = plugin.sources.find(({ file }) => file === entry.source!.file)!
    expect(candidates.some((candidate) => candidate.file === source.file
      && source.content.slice(0, candidate.anchorStart).split('\n').length === entry.source!.line)).toBe(true)
  }
  expect(checkPlugin(inventory, plugin.id).find(({ id }) => id === 'compatibility-tokens')?.status).toBe('pass')
})

test.each([VIEWER, CHANGES])('%s exposes a descriptor-backed public CLI action', (file) => {
  const action = routeFor(file)
  expect(action.route.invoke.file).toBe(CONTROL)
  expect(action.route.invoke.quote).toMatch(/\bcommand\s*:\s*EDITOR_UI_CONTROL_COMMAND\b/)
  const helpers = (action.route.via ?? []).map((reference) => {
    const helperRef = resolveRef(plugin, graph.files, reference)
    if ('code' in helperRef) throw new Error(helperRef.message)
    const helper = resolveVia(helperRef)
    if ('code' in helper) throw new Error(helper.message)
    return { file: reference.file, name: helper.name }
  })
  expect(helpers).toContainEqual({ file: CONTROL, name: 'run' })
  expect(helpers.slice(-2)).toEqual([
    { file: CONTROL, name: 'requestEditorUiControl' },
    { file: CONTROL, name: 'editorUiControlDescriptor' },
  ])
  const resolved = resolveRef(plugin, graph.files, action.route.invoke)
  if ('code' in resolved) throw new Error(resolved.message)
  const line = resolved.source.getLineAndCharacterOfPosition(resolved.start).line + 1
  expect(auditPlugin(inventory, plugin).find(({ id }) => id === 'commands')!.evidence).toContainEqual(expect.objectContaining({
    code: 'action-routed', source: { file: CONTROL, line, column: expect.any(Number) },
    api: 'ui.command.run', cli: `quirky ui run ${COMMAND}`,
  }))
})

test('removing an actual action entry reveals its uncovered source candidate', () => {
  const action = routeFor(VIEWER)
  const site = resolveRef(plugin, graph.files, action.site)
  if ('code' in site) throw new Error(site.message)
  const candidate = selectCandidate(site, candidates, 'action', action.anchor)
  if ('code' in candidate) throw new Error(candidate.message)
  const line = site.source.getLineAndCharacterOfPosition(candidate.anchorStart).line + 1
  const changed = withCoverage({ ...coverage, actions: coverage.actions.filter((entry) => entry !== action) })
  expect(auditPlugin(inventory, changed).find(({ id }) => id === 'commands')!.evidence).toContainEqual(expect.objectContaining({
    code: 'coverage-missing', source: expect.objectContaining({ file: candidate.file, line }),
  }))
})

test('raw markup cannot stand in for a witnessed shared loading state', () => {
  const state = coverage.states.find((entry) => entry.state === 'loading' && entry.render.component === 'NoticeLine')!
  expect(state).toBeDefined()
  if (state.render.component !== 'NoticeLine') throw new Error('Expected a NoticeLine witness')
  const element = state.render.element
  const raw = element.quote
    .replace(/<NoticeLine\b([^>]*)>([\s\S]*?)<\/NoticeLine>/, '<p$1>$2</p>')
    .replace(/<NoticeLine\b([^>]*)\s*\/>/, '<p$1 />')
  expect(raw).not.toBe(element.quote)
  const edited = { ...plugin, sources: plugin.sources.map((source) => source.file === element.file
    ? { ...source, content: source.content.replace(element.quote, raw) } : source) }
  expect(auditPlugin(inventory, edited).find(({ id }) => id === state.state)!.evidence).toContainEqual(expect.objectContaining({
    code: 'evidence-missing', coverageFile: FRAGMENT,
  }))
})
