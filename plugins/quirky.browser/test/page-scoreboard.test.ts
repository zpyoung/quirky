import { beforeAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { auditPlugin } from '../../../scripts/ui-scoreboard/audit'
import { parseCoverage } from '../../../scripts/ui-scoreboard/audit-evidence'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import type { CheckResult, Evidence, Inventory, PluginInventory } from '../../../scripts/ui-scoreboard/contracts'

const repoRoot = resolve(import.meta.dir, '../../..')
const fragmentPath = 'plugins/quirky.browser/ui-scoreboard/page.json'
const ownedSurface = 'view:quirky.browser/page'
const ownedFiles: readonly string[] = [
  'plugins/quirky.browser/src/ui.tsx',
  'plugins/quirky.browser/src/ui-control.ts',
  'plugins/quirky.browser/src/window/BrowserPaneWindow.tsx',
  'plugins/quirky.browser/src/window/useDisclosureMenu.ts',
  'plugins/quirky.browser/src/preferences-window/BrowserProfileMenu.tsx',
  'plugins/quirky.browser/src/preferences-ui.tsx',
  'plugins/quirky.browser/src/preferences-window/BrowserSettings.tsx',
  'plugins/quirky.browser/src/preferences-window/CookieImportPanel.tsx',
  'plugins/quirky.browser/src/preferences-window/shared.tsx',
]
const passingAuditCodes: Record<string, true> = {
  'state-covered': true,
  'state-not-applicable': true,
  'not-state': true,
  'action-routed': true,
  'action-transient': true,
  'action-not-user': true,
}

let cachedSnapshot: { inventory: Inventory; plugin: PluginInventory } | undefined
let cachedAudit: CheckResult[] | undefined
function snapshot() {
  if (cachedSnapshot) return cachedSnapshot
  const inventory = collectInventory(repoRoot)
  const plugin = inventory.plugins.find(({ id }) => id === 'quirky.browser')
  if (!plugin) throw new Error('quirky.browser was not discovered')
  cachedSnapshot = { inventory, plugin }
  return cachedSnapshot
}

beforeAll(() => { snapshot() })

function failures(evidence: Evidence[]): Evidence[] {
  return evidence.filter(({ code }) => passingAuditCodes[code] === undefined)
}

function auditResults(plugin: PluginInventory = snapshot().plugin) {
  const { inventory, plugin: original } = snapshot()
  return plugin === original ? (cachedAudit ??= auditPlugin(inventory, plugin)) : auditPlugin(inventory, plugin)
}

function auditFailures(plugin: PluginInventory = snapshot().plugin): Evidence[] {
  return failures(auditResults(plugin).flatMap(({ evidence }) => evidence))
}

function withFragmentContent(plugin: PluginInventory, file: string, content: string): PluginInventory {
  const fragments = plugin.coverageFragments
  if (!fragments) throw new Error('Browser scoreboard fragment was not collected')
  return {
    ...plugin,
    coverageFragments: fragments.map((fragment) => fragment.file === file ? { ...fragment, content } : fragment),
  }
}

test('the page scoreboard fragment parses and declares its surface', () => {
  const text = readFileSync(join(repoRoot, fragmentPath), 'utf8')
  const coverage = parseCoverage(text)

  expect(coverage.schemaVersion).toBe(1)
  expect(Object.keys(coverage.surfaces)).toEqual([ownedSurface])
  expect(coverage.surfaces[ownedSurface]).toEqual({
    loading: { applicable: true },
    empty: { applicable: true },
    error: { applicable: true },
  })
})

test('all owned files and the page surface have no failure evidence', () => {
  const evidence = auditFailures()
  const ownedFailures = evidence.filter(({ source, coverageFile, targetId }) =>
    (source !== undefined && ownedFiles.includes(source.file)) ||
    coverageFile === fragmentPath || targetId === ownedSurface
  )

  expect(ownedFailures).toEqual([])
})

test('no Browser scoreboard failures remain after design coverage', () => {
  expect(auditFailures()).toEqual([])
})

test('the page states are witnessed by the required components', () => {
  const results = auditResults()
  const componentsFor = (id: 'loading' | 'empty' | 'error') => {
    const check = results.find((result) => result.id === id)
    return new Set(check?.evidence
      .filter(({ code, targetId }) => code === 'state-covered' && targetId === ownedSurface)
      .map(({ component }) => component)
      .filter((component): component is string => component !== undefined))
  }

  expect([...componentsFor('loading')].sort()).toEqual(['EmptyState', 'NoticeLine'])
  expect([...componentsFor('empty')].sort()).toEqual(['EmptyState'])
  expect([...componentsFor('error')].sort()).toEqual(['InlineError', 'toast'])
})

test.each(['states', 'actions'] as const)('removing the first %s entry exposes its source file', (kind) => {
  const { plugin } = snapshot()
  const fragment = plugin.coverageFragments?.find(({ file }) => file === fragmentPath)
  if (!fragment) throw new Error('Browser page scoreboard fragment was not collected')
  const coverage = parseCoverage(fragment.content)
  const first = coverage[kind][0]
  if (!first) throw new Error(`Browser page fragment needs ${kind} entries`)
  const withoutFirst = withFragmentContent(plugin, fragment.file, JSON.stringify({
    ...coverage,
    [kind]: coverage[kind].slice(1),
  }))
  expect(auditFailures(withoutFirst).some(({ source }) => source?.file === first.site.file)).toBe(true)
})
