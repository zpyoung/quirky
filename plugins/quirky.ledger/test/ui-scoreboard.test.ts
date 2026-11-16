import { beforeAll, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import { discoverCandidates, discoverUiFiles } from '../../../scripts/ui-scoreboard/audit-discovery'
import { parseCoverage, resolveRef, selectCandidate } from '../../../scripts/ui-scoreboard/audit-evidence'
import { auditPlugin } from '../../../scripts/ui-scoreboard/audit'
import { checkPlugin } from '../../../scripts/ui-scoreboard/tokens'
import type { CoverageFile, Evidence, Inventory, PluginInventory } from '../../../scripts/ui-scoreboard/contracts'

const APP = 'plugins/quirky.ledger/src/ui/LedgerApp.tsx'
const FRAGMENT = 'plugins/quirky.ledger/ui-scoreboard/ledger-app.json'
const SURFACES = ['view:quirky.ledger/ledger', 'panel:quirky.ledger/ledger', 'sidebar-section:quirky.ledger/ledger']
const PASS: Record<string, true> = { 'state-covered': true, 'state-not-applicable': true, 'not-state': true, 'action-routed': true, 'action-transient': true, 'action-not-user': true }
let inventory: Inventory
let plugin: PluginInventory
let coverage: CoverageFile

beforeAll(() => {
  inventory = collectInventory(resolve(import.meta.dir, '../../..'))
  expect(inventory.failures).toEqual([])
  plugin = inventory.plugins.find((entry) => entry.id === 'quirky.ledger')!
  expect(plugin).toBeDefined()
  const fragment = plugin.coverageFragments?.find((entry) => entry.file === FRAGMENT)
  expect(fragment).toBeDefined()
  coverage = parseCoverage(fragment!.content)
})

function withCoverage(value: CoverageFile): PluginInventory {
  return { ...plugin, coverageFragments: plugin.coverageFragments!.map((fragment) => fragment.file === FRAGMENT ? { ...fragment, content: JSON.stringify(value) } : fragment) }
}

function failures(subject: PluginInventory): Evidence[] {
  return auditPlugin(inventory, subject).flatMap((check) => check.evidence).filter((entry) => !PASS[entry.code])
}

test('the fragment covers the entire owned source through the full production graph, not the remaining components', () => {
  const graph = discoverUiFiles(plugin)
  expect(graph.failures).toEqual([])
  const candidates = discoverCandidates(plugin, graph.files)
  const owned = candidates.filter((candidate) => candidate.file === APP)
  expect(owned.length).toBeGreaterThan(0)
  expect(candidates.some((candidate) => candidate.file !== APP)).toBe(true)
  expect(Object.keys(coverage.surfaces).sort()).toEqual([...SURFACES].sort())
  for (const entry of [...coverage.states, ...coverage.notState, ...coverage.actions]) expect(entry.site.file).toBe(APP)
  for (const surface of SURFACES.slice(0, 2)) {
    expect(coverage.surfaces[surface]).toEqual({ loading: { applicable: true }, empty: { applicable: true }, error: { applicable: true } })
  }
  for (const decision of Object.values(coverage.surfaces[SURFACES[2]]!)) {
    expect(decision.applicable).toBe(false)
    if (!decision.applicable) {
      expect(decision.evidence.length).toBeGreaterThan(0)
      for (const reference of decision.evidence) {
        expect(reference.file).toBe(APP)
        expect('code' in resolveRef(plugin, graph.files, reference)).toBe(false)
      }
    }
  }
  for (const state of coverage.states) {
    expect(state.render.component).not.toBe('toast')
    if (state.render.component !== 'toast') {
      expect(state.render.import.file).toBe(APP)
      expect(state.render.element.file).toBe(APP)
    }
  }
  const issues = failures(plugin)
  expect(issues.filter((entry) => entry.source?.file === APP || entry.coverageFile === FRAGMENT || SURFACES.includes(entry.targetId ?? ''))).toEqual([])
  expect(issues.filter((entry) => !(entry.code === 'coverage-missing' && entry.source?.file !== APP && graph.files.includes(entry.source?.file ?? '')) && !(entry.code === 'surface-decision-missing' && entry.targetId === 'view:quirky.ledger/settings'))).toEqual([])
  const checks = checkPlugin(inventory, plugin.id)
  expect(checks.find((check) => check.id === 'compatibility-tokens')?.status).toBe('pass')
  const ratchet = require('../../../scripts/ui-scoreboard-ratchet.json')
  expect(ratchet[plugin.id]).toEqual(['commands', 'compatibility-tokens', 'empty', 'error', 'loading'])
})

test('removing an owned public action exposes its actual missing candidate', () => {
  const action = coverage.actions.find((entry) => 'route' in entry)!
  expect(action).toBeDefined()
  const graph = discoverUiFiles(plugin)
  const reference = resolveRef(plugin, graph.files, action.site)
  if ('code' in reference) throw new Error(reference.message)
  const candidate = selectCandidate(reference, discoverCandidates(plugin, graph.files), 'action', action.anchor)
  if ('code' in candidate) throw new Error(candidate.message)
  const line = reference.source.getLineAndCharacterOfPosition(candidate.anchorStart).line + 1
  const edited = withCoverage({ ...coverage, actions: coverage.actions.filter((entry) => entry !== action) })
  const commandFailures = auditPlugin(inventory, edited).find((check) => check.id === 'commands')!.evidence
  expect(commandFailures.some((entry) => entry.code === 'coverage-missing' && entry.source?.file === APP && entry.source.line === line)).toBe(true)
})

test('replacing a witnessed shared loading render with raw markup invalidates its evidence', () => {
  const state = coverage.states.find((entry) => entry.state === 'loading' && entry.render.component === 'NoticeLine')!
  expect(state).toBeDefined()
  if (state.render.component === 'toast') throw new Error('Expected a shared component')
  const quote = state.render.element.quote
  const raw = quote.replace(/<NoticeLine\b[^>]*>[\s\S]*?<\/NoticeLine>/, '<p>Loading ledger…</p>')
  expect(raw).not.toBe(quote)
  const edited = { ...plugin, sources: plugin.sources.map((source) => source.file === APP ? { ...source, content: source.content.replace(quote, raw) } : source) }
  const check = auditPlugin(inventory, edited).find((entry) => entry.id === state.state)!
  expect(check.status).toBe('fail')
  expect(check.evidence.some((entry) => entry.code === 'evidence-missing' && entry.coverageFile === FRAGMENT)).toBe(true)
})
