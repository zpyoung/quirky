import { beforeAll, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { auditPlugin } from '../../../scripts/ui-scoreboard/audit'
import { discoverCandidates, discoverUiFiles } from '../../../scripts/ui-scoreboard/audit-discovery'
import { parseCoverage } from '../../../scripts/ui-scoreboard/audit-evidence'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import type { CoverageFile, Evidence, Inventory, PluginInventory, StateEntry } from '../../../scripts/ui-scoreboard/contracts'
import { checkPlugin } from '../../../scripts/ui-scoreboard/tokens'

const FRAGMENT = 'plugins/quirky.ledger/ui-scoreboard/ledger-dialogs.json'
const SURFACE = 'view:quirky.ledger/ledger'
const TARGET_FILES = [
  'plugins/quirky.ledger/src/ui/LedgerDetail.tsx',
  'plugins/quirky.ledger/src/ui/LedgerForm.tsx',
  'plugins/quirky.ledger/src/ui/LedgerTriage.tsx'
]
const STATIC_CHECKS = ['commands', 'compatibility-tokens', 'empty', 'error', 'loading'] as const
const PASS_CODES: Record<string, true> = {
  'state-covered': true,
  'state-not-applicable': true,
  'not-state': true,
  'action-routed': true,
  'action-transient': true,
  'action-not-user': true
}
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



test('ledger dialog fragment accounts for every owned candidate with shared states and forwarded actions', () => {
  const graph = discoverUiFiles(plugin)
  expect(graph.failures).toEqual([])
  const candidates = discoverCandidates(plugin, graph.files)
  const ownedCandidates = candidates.filter((candidate) => TARGET_FILES.includes(candidate.file))
  expect(ownedCandidates.length).toBeGreaterThan(0)

  expect(coverage.surfaces).toEqual({})
  expect(coverage.states.length).toBeGreaterThan(0)
  expect(coverage.states.every((state) => state.surface === SURFACE)).toBe(true)
  const entries = [...coverage.states, ...coverage.notState, ...coverage.actions]
  expect([...new Set(entries.map((entry) => entry.site.file))].toSorted()).toEqual([...TARGET_FILES].toSorted())
  expect([...coverage.notState, ...coverage.actions].every((entry) =>
    'reason' in entry && entry.reason.trim().length >= 20 && !/unsupported|not handled|generic skip/i.test(entry.reason)
  )).toBe(true)
  expect(coverage.actions.some((action) => action.site.file.endsWith('/LedgerForm.tsx') && action.anchor === 'onSubmit' && 'notAction' in action && action.notAction === 'forwarded')).toBe(true)
  expect(coverage.actions.some((action) => action.site.file.endsWith('/LedgerForm.tsx') && 'transient' in action && action.transient === 'draft')).toBe(true)

  const checks = checkPlugin(inventory, plugin.id)
  expect(checks.map((check) => check.id).toSorted()).toEqual([...STATIC_CHECKS].toSorted())
  expect(checks.filter((check) => check.status === 'fail')).toEqual([])

  const audit = auditPlugin(inventory, plugin)
  expect(audit.flatMap((check) => check.evidence).filter((item) => !PASS_CODES[item.code])).toEqual([])
  expect(audit.flatMap((check) => check.evidence).filter((item) => item.code === 'coverage-surface-duplicate')).toEqual([])
})

test('removing one dialog state witness exposes its actual missing candidate', () => {
  const graph = discoverUiFiles(plugin)
  const state = coverage.states.find((entry) => TARGET_FILES.includes(entry.site.file))!
  expect(state).toBeDefined()
  const edited: PluginInventory = {
    ...plugin,
    coverageFragments: plugin.coverageFragments!.map((fragment) => fragment.file === FRAGMENT
      ? { ...fragment, content: JSON.stringify({ ...coverage, states: coverage.states.filter((entry) => entry !== state) }) }
      : fragment)
  }
  const failures = auditPlugin(inventory, edited).flatMap((check) => check.evidence).filter((item) => !PASS_CODES[item.code])
  expect(failures.some((item) => item.code === 'coverage-missing' && item.source?.file === state.site.file)).toBe(true)
  expect(graph.failures).toEqual([])
})

test('replacing a witnessed dialog shared render with raw markup fails the shared-component audit', () => {
  const state = coverage.states.find((entry) => entry.render.component === 'NoticeLine') as StateEntry | undefined
  expect(state).toBeDefined()
  if (!state) throw new Error('Expected a NoticeLine witness')
  const render = state.render
  if (render.component === 'toast') throw new Error('Expected a shared element witness')
  const quote = render.element.quote
  const raw = quote.replace(/<NoticeLine\b[^>]*>([\s\S]*?)<\/NoticeLine>/, '<p>$1</p>')
  expect(raw).not.toBe(quote)
  const source = plugin.sources.find((item) => item.file === state.site.file)
  expect(source?.content).toContain(quote)
  const changedCoverage: CoverageFile = {
    ...coverage,
    states: coverage.states.map((entry) => entry === state
      ? { ...state, render: { ...render, element: { ...render.element, quote: raw } } }
      : entry)
  }
  const edited: PluginInventory = {
    ...plugin,
    sources: plugin.sources.map((item) => item.file === state.site.file
      ? { ...item, content: item.content.replace(quote, raw) }
      : item),
    coverageFragments: plugin.coverageFragments!.map((fragment) => fragment.file === FRAGMENT
      ? { ...fragment, content: JSON.stringify(changedCoverage) }
      : fragment)
  }
  const check = auditPlugin(inventory, edited).find((item) => item.id === state.state)!
  expect(check.status).toBe('fail')
  expect(check.evidence.some((item) => item.code === 'render-element-invalid' && item.coverageFile === FRAGMENT)).toBe(true)
})
