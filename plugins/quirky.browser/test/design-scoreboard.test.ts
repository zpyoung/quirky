import { beforeAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { auditPlugin } from '../../../scripts/ui-scoreboard/audit'
import { discoverCandidates, discoverUiFiles } from '../../../scripts/ui-scoreboard/audit-discovery'
import { parseCoverage } from '../../../scripts/ui-scoreboard/audit-evidence'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import type { CheckResult, CoverageFile, Inventory, PluginInventory } from '../../../scripts/ui-scoreboard/contracts'
import { clampPayload } from '../src/design/payload'

const repoRoot = resolve(import.meta.dir, '../../..')
const fragmentPath = 'plugins/quirky.browser/ui-scoreboard/design.json'
const windowFile = 'plugins/quirky.browser/src/design-window/DesignWindow.tsx'
const overlayFile = 'plugins/quirky.browser/src/markup/MarkupOverlay.tsx'
const passCodes: Record<string, true> = { 'state-covered': true, 'state-not-applicable': true, 'not-state': true, 'action-routed': true, 'action-transient': true, 'action-not-user': true }
let inventory: Inventory
let browser: PluginInventory
let coverage: CoverageFile
let results: CheckResult[]
beforeAll(() => {
  inventory = collectInventory(repoRoot)
  browser = inventory.plugins.find(({ id }) => id === 'quirky.browser')!
  results = auditPlugin(inventory, browser)
})

function fragment(): CoverageFile {
  return coverage ??= parseCoverage(readFileSync(join(repoRoot, fragmentPath), 'utf8'))
}

test('design coverage extends the page surface without declaring it twice', () => {
  expect(fragment().schemaVersion).toBe(1)
  expect(fragment().surfaces).toEqual({})
})

test('the entire Browser plugin passes every source audit', () => {
  for (const id of ['loading', 'empty', 'error', 'commands']) {
    const result = results.find((entry) => entry.id === id)!
    expect(result.status).toBe('pass')
    expect(result.evidence.filter(({ code }) => !passCodes[code])).toEqual([])
  }
})

test('design loading, empty and error states use shared components', () => {
  const states = (id: string, file: string) => results.find((entry) => entry.id === id)!.evidence
    .filter((entry) => entry.code === 'state-covered' && entry.targetId === 'view:quirky.browser/page' && entry.source?.file === file)
    .map(({ component }) => component)
  expect(states('loading', windowFile)).toEqual(['NoticeLine'])
  expect(states('empty', windowFile)).toEqual(['EmptyState', 'EmptyState'])
  expect(states('error', windowFile)).toEqual(['InlineError'])
  expect(states('error', overlayFile)).toEqual(['InlineError'])
})

test('all 24 overlay event barriers are verified at their exact sites', () => {
  const barriers = fragment().actions.filter((entry) => 'notAction' in entry && entry.notAction === 'barrier')
  expect(barriers).toHaveLength(24)
  const source = browser.sources.find(({ file }) => file === overlayFile)!.content
  const evidence = results.find(({ id }) => id === 'commands')!.evidence
  for (const entry of barriers) {
    const start = source.indexOf(entry.site.quote)
    expect(start).toBeGreaterThanOrEqual(0)
    const line = source.slice(0, start + entry.site.quote.indexOf(entry.anchor ?? '')).split('\n').length
    expect(evidence.some((item) => item.code === 'action-not-user' && item.coverageFile === fragmentPath && item.source?.file === overlayFile && item.source.line === line)).toBe(true)
  }
})

test('adding a side effect to the shared barrier invalidates all 23 uses', () => {
  const source = browser.sources.find(({ file }) => file === overlayFile)!
  const content = source.content.replace(/(function stopOverlayPropagation[^]*?event\.stopPropagation\(\))/, "$1; window.dispatchEvent(new Event('x'))")
  expect(content).not.toBe(source.content)
  const tampered = { ...browser, sources: browser.sources.map((entry) => entry === source ? { ...entry, content } : entry) }
  const commands = auditPlugin(inventory, tampered).find(({ id }) => id === 'commands')!
  expect(commands.status).toBe('fail')
  expect(commands.evidence.filter(({ code }) => code === 'barrier-invalid')).toHaveLength(23)
})

test.each(['barrier', 'route'] as const)('missing %s coverage exposes the uncovered action', (kind) => {
  const original = fragment()
  const index = original.actions.findIndex((entry) => kind === 'barrier' ? 'notAction' in entry && entry.notAction === 'barrier' : 'route' in entry)
  const removed = original.actions[index]!
  const source = browser.sources.find(({ file }) => file === removed.site.file)!.content
  const start = source.indexOf(removed.site.quote)
  const line = source.slice(0, start + removed.site.quote.indexOf(removed.anchor ?? '')).split('\n').length
  const value = { ...original, actions: original.actions.filter((_, i) => i !== index) }
  const changed = { ...browser, coverageFragments: browser.coverageFragments?.map((entry) => entry.file === fragmentPath ? { ...entry, content: JSON.stringify(value) } : entry) }
  const commands = auditPlugin(inventory, changed).find(({ id }) => id === 'commands')!
  expect(commands.status).toBe('fail')
  expect(commands.evidence.some((entry) => entry.code === 'coverage-missing' && entry.source?.file === removed.site.file && entry.source.line === line)).toBe(true)
})

test('payload records do not produce UI action candidates', () => {
  expect(discoverCandidates(browser, discoverUiFiles(browser).files).filter(({ file }) => file.endsWith('/design/payload.ts'))).toEqual([])
})

test('payload record normalization preserves key order, last value and null prototypes', () => {
  const payload = clampPayload({ page: { sanitizedUrl: 'https://example.test/' }, target: {
    tagName: 'a', selector: '#link',
    attributes: { ID: 'first', id: 'second', Class: 'c', HREF: 'https://u:p@example.test/b?q=1', onclick: 'x()' },
    computedStyles: { display: 'block', position: 'static', bogus: 'x' },
  } })
  expect(payload.target.attributes).toEqual({ id: 'second', class: 'c', href: 'https://example.test/b' })
  expect(Object.keys(payload.target.attributes)).toEqual(['id', 'class', 'href'])
  expect(payload.target.computedStyles).toEqual({ display: 'block', position: 'static' })
  expect(Object.getPrototypeOf(payload.target.attributes)).toBeNull()
  expect(Object.getPrototypeOf(payload.target.computedStyles)).toBeNull()
})

test('Browser is enrolled in every static ratchet check', () => {
  const ratchet = JSON.parse(readFileSync(join(repoRoot, 'scripts/ui-scoreboard-ratchet.json'), 'utf8'))
  expect(ratchet['quirky.browser']).toEqual(['commands', 'compatibility-tokens', 'empty', 'error', 'loading'])
})
