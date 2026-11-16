import { beforeAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import { discoverCandidates, discoverUiFiles } from '../../../scripts/ui-scoreboard/audit-discovery'
import { parseCoverage, resolveRef, selectCandidate } from '../../../scripts/ui-scoreboard/audit-evidence'
import { auditPlugin } from '../../../scripts/ui-scoreboard/audit'
import { checkPlugin } from '../../../scripts/ui-scoreboard/tokens'
import { checkRatchet, parseRatchetConfig } from '../../../scripts/ui-scoreboard/ratchet'
import type { CoverageFile, Inventory, PluginInventory, StaticCheckId } from '../../../scripts/ui-scoreboard/contracts'

const ROOT = resolve(import.meta.dir, '../../..')
const FILE = 'plugins/quirky.editor/src/markdown/MarkdownSurface.tsx'
const FRAGMENT = 'plugins/quirky.editor/ui-scoreboard/markdown-surface.json'
const SURFACE = 'view:quirky.editor/document'
const STATIC: StaticCheckId[] = ['commands', 'compatibility-tokens', 'empty', 'error', 'loading']
let inventory: Inventory
let plugin: PluginInventory

beforeAll(() => {
  inventory = collectInventory(ROOT)
  expect(inventory.failures).toEqual([])
  plugin = inventory.plugins.find(({ id }) => id === 'quirky.editor')!
  expect(plugin).toBeDefined()
})

function coverage(): CoverageFile {
  const fragment = plugin.coverageFragments?.find(({ file }) => file === FRAGMENT)
  expect(fragment).toBeDefined()
  return parseCoverage(fragment!.content)
}

function changedCoverage(value: CoverageFile): PluginInventory {
  return { ...plugin, coverageFragments: plugin.coverageFragments!.map((fragment) => fragment.file === FRAGMENT
    ? { ...fragment, content: JSON.stringify(value) } : fragment) }
}

function candidateFor(entry: CoverageFile['actions'][number]) {
  const files = discoverUiFiles(plugin).files
  const ref = resolveRef(plugin, files, entry.site)
  if ('code' in ref) throw new Error(ref.message)
  const candidate = selectCandidate(ref, discoverCandidates(plugin, files), 'action', entry.anchor)
  if ('code' in candidate) throw new Error(candidate.message)
  return candidate
}

function snapshot(value: PluginInventory): Inventory {
  return { ...inventory, plugins: inventory.plugins.map((entry) => entry.id === plugin.id ? value : entry) }
}

function enrollment() {
  const real = parseRatchetConfig(readFileSync(resolve(ROOT, 'scripts/ui-scoreboard-ratchet.json'), 'utf8'))
  expect(real[plugin.id]?.slice().sort()).toEqual(STATIC)
  return { [plugin.id]: real[plugin.id]! }
}

test('Markdown completes every Editor static check across the full production graph', () => {
  const graph = discoverUiFiles(plugin)
  expect(graph.failures).toEqual([])
  expect(graph.files).toContain(FILE)
  const candidates = discoverCandidates(plugin, graph.files)
  const owned = candidates.filter(({ file }) => file === FILE)
  expect(owned.length).toBeGreaterThan(0)
  expect(candidates.length).toBeGreaterThan(owned.length)
  const fragment = coverage()
  expect(fragment.surfaces).toEqual({})
  for (const entry of [...fragment.states, ...fragment.notState, ...fragment.actions]) expect(entry.site.file).toBe(FILE)
  for (const state of fragment.states) expect(state.surface).toBe(SURFACE)
  const declarations = (plugin.coverageFragments ?? []).flatMap((source) => Object.keys(parseCoverage(source.content).surfaces).map((surface) => ({ surface, file: source.file })))
  expect(declarations.length).toBeGreaterThan(0)
  expect(new Set(declarations.map(({ surface }) => surface)).size).toBe(declarations.length)
  for (const declaration of declarations) expect(declaration.file).toBe('plugins/quirky.editor/ui-scoreboard/explorer-and-overlays.json')
  expect(checkPlugin(inventory, plugin.id).map(({ id, status }) => ({ id, status }))).toEqual(expect.arrayContaining(STATIC.map((id) => ({ id, status: 'pass' }))))
  expect(auditPlugin(inventory, plugin).every(({ status }) => status === 'pass')).toBe(true)
  expect(checkRatchet(inventory, enrollment())).toEqual({ exitCode: 0, failures: [] })
}, 30_000)

for (const mode of ['SourceSurface', 'PreviewSurface', 'RichSurface']) {
  test(`${mode} mounted actions resolve through the descriptor to the public CLI`, () => {
    const value = coverage()
    const source = plugin.sources.find(({ file }) => file === FILE)!.content
    const from = source.indexOf(`function ${mode}(`)
    const next = source.indexOf('\nfunction ', from + 1)
    const end = next < 0 ? source.length : next
    const action = value.actions.find((entry) => {
      if (!('route' in entry)) return false
      const selected = candidateFor(entry)
      return selected.anchorStart > from && selected.anchorStart < end
    })
    expect(action).toBeDefined()
    if (!action || !('route' in action)) throw new Error(`Missing ${mode} command witness.`)
    expect(action.route.target).toBe('command:quirky.editor/ui-control')
    const invocation = resolveRef(plugin, discoverUiFiles(plugin).files, action.route.invoke)
    if ('code' in invocation) throw new Error(invocation.message)
    const line = invocation.source.getLineAndCharacterOfPosition(invocation.start).line + 1
    const check = auditPlugin(inventory, plugin).find(({ id }) => id === 'commands')!
    expect(check.evidence).toContainEqual(expect.objectContaining({
      code: 'action-routed', source: expect.objectContaining({ file: invocation.file, line }),
      coverageFile: FRAGMENT, api: 'ui.command.run', cli: 'quirky ui run command:quirky.editor/ui-control'
    }))
  }, 30_000)
}

test('removing a real Markdown action fails both command coverage and enrollment', () => {
  const value = coverage()
  const index = value.actions.findIndex((entry) => 'route' in entry)
  expect(index).toBeGreaterThanOrEqual(0)
  const [action] = value.actions.splice(index, 1)
  const candidate = candidateFor(action!)
  const source = plugin.sources.find(({ file }) => file === FILE)!.content
  const line = source.slice(0, candidate.anchorStart).split('\n').length
  const edited = changedCoverage(value)
  const check = auditPlugin(inventory, edited).find(({ id }) => id === 'commands')!
  expect(check.status).toBe('fail')
  expect(check.evidence).toContainEqual(expect.objectContaining({ code: 'coverage-missing', source: expect.objectContaining({ file: FILE, line }) }))
  expect(checkRatchet(snapshot(edited), enrollment()).exitCode).toBe(1)
}, 30_000)

test('raw markup cannot replace a witnessed shared Markdown failure render', () => {
  const state = coverage().states.find((entry) => entry.render.component === 'InlineError')!
  expect(state).toBeDefined()
  if (state.render.component === 'toast') throw new Error('Expected shared component evidence.')
  const render = state.render
  const edited = { ...plugin, sources: plugin.sources.map((source) => source.file === render.element.file
    ? { ...source, content: source.content.replace(render.element.quote, '<div role="alert">Raw failure</div>') } : source) }
  expect(auditPlugin(inventory, edited).find(({ id }) => id === state.state)?.status).toBe('fail')
  expect(checkRatchet(snapshot(edited), enrollment()).exitCode).toBe(1)
}, 30_000)

for (const sibling of ['document-and-source.json', 'explorer-and-overlays.json', 'notebook-and-mermaid.json', 'viewers-and-changes.json']) {
  test(`enrollment fails without prerequisite ${sibling}`, () => {
    const original = plugin.coverageFragments!
    expect(original.some(({ file }) => file.endsWith(`/${sibling}`))).toBe(true)
    const edited = { ...plugin, coverageFragments: original.filter(({ file }) => !file.endsWith(`/${sibling}`)) }
    expect(checkRatchet(snapshot(edited), enrollment()).exitCode).toBe(1)
  }, 30_000)
}
