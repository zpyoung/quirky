import { beforeAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { auditPlugin } from '../../../scripts/ui-scoreboard/audit'
import { parseCoverage } from '../../../scripts/ui-scoreboard/audit-evidence'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import type { CheckResult, Evidence, Inventory, PluginInventory } from '../../../scripts/ui-scoreboard/contracts'
import { checkPlugin } from '../../../scripts/ui-scoreboard/tokens'

const repoRoot = resolve(import.meta.dir, '../../..')
const fragmentPath = 'plugins/quirky.browser/ui-scoreboard/preferences.json'
const ownedSurfaces = [
  'settings-section:quirky.browser/browser-preferences',
  'view:quirky.browser/browser-settings',
] as const
const ownedNames = [
  'plugins/quirky.browser/src/preferences-ui.tsx',
  'plugins/quirky.browser/src/preferences-window/BrowserSettings.tsx',
  'plugins/quirky.browser/src/preferences-window/CookieImportPanel.tsx',
  'plugins/quirky.browser/src/preferences-window/shared.tsx',
  fragmentPath,
  ...ownedSurfaces,
]
const followUpFiles: Record<string, true> = {
  'plugins/quirky.browser/src/preferences-window/BrowserProfileMenu.tsx': true,
  'plugins/quirky.browser/src/ui.tsx': true,
  'plugins/quirky.browser/src/window/BrowserPaneWindow.tsx': true,
  'plugins/quirky.browser/src/window/useDisclosureMenu.ts': true,
  'plugins/quirky.browser/src/design-window/DesignWindow.tsx': true,
  'plugins/quirky.browser/src/design/payload.ts': true,
  'plugins/quirky.browser/src/markup/MarkupOverlay.tsx': true,
}
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

function auditFailures(plugin: PluginInventory = snapshot().plugin): Evidence[] {
  const { inventory, plugin: original } = snapshot()
  const results = plugin === original ? (cachedAudit ??= auditPlugin(inventory, plugin)) : auditPlugin(inventory, plugin)
  return failures(results.flatMap(({ evidence }) => evidence))
}

function withFragmentContent(plugin: PluginInventory, file: string, content: string): PluginInventory {
  const fragments = plugin.coverageFragments
  if (!fragments) throw new Error('Browser scoreboard fragment was not collected')
  return {
    ...plugin,
    coverageFragments: fragments.map((fragment) => fragment.file === file ? { ...fragment, content } : fragment),
  }
}

test('the preferences scoreboard fragment parses and declares both owned surfaces', () => {
  const text = readFileSync(join(repoRoot, fragmentPath), 'utf8')
  const coverage = parseCoverage(text)

  expect(coverage.schemaVersion).toBe(1)
  expect(Object.keys(coverage.surfaces).sort()).toEqual([...ownedSurfaces].sort())
  for (const surface of ownedSurfaces) {
    expect(coverage.surfaces[surface]).toEqual({
      loading: { applicable: true },
      empty: { applicable: true },
      error: { applicable: true },
    })
  }
})

test('the scoreboard has no failure evidence naming owned files, surfaces, or the fragment', () => {
  const evidence = auditFailures()
  const ownedFailures = evidence.filter((item) => ownedNames.some((name) => JSON.stringify(item).includes(name)))

  expect(ownedFailures).toEqual([])
})

test('remaining scoreboard failures are confined to the documented follow-up', () => {
  const evidence = auditFailures()

  expect(evidence.length).toBeGreaterThan(0)
  expect(evidence.every(({ source, targetId }) =>
    (source !== undefined && followUpFiles[source.file] === true) || targetId === 'view:quirky.browser/page'
  )).toBe(true)
})

test('Browser compatibility tokens pass and the plugin is not enrolled in the ratchet', () => {
  const { inventory } = snapshot()
  const tokenCheck = checkPlugin(inventory, 'quirky.browser').find(({ id }) => id === 'compatibility-tokens')

  expect(tokenCheck).toMatchObject({ status: 'pass' })
  const ratchet = JSON.parse(readFileSync(join(repoRoot, 'scripts/ui-scoreboard-ratchet.json'), 'utf8')) as Record<string, unknown>
  expect(Object.hasOwn(ratchet, 'quirky.browser')).toBe(false)
})

test.each(['states', 'actions'] as const)('removing the first %s entry exposes its source file', (kind) => {
  const { plugin } = snapshot()
  const fragment = plugin.coverageFragments?.find(({ file }) => file === fragmentPath)
  if (!fragment) throw new Error('Browser preferences scoreboard fragment was not collected')
  const coverage = parseCoverage(fragment.content)
  const first = coverage[kind][0]
  if (!first) throw new Error(`Browser preferences fragment needs ${kind} entries`)
  const withoutFirst = withFragmentContent(plugin, fragment.file, JSON.stringify({
    ...coverage,
    [kind]: coverage[kind].slice(1),
  }))
  expect(auditFailures(withoutFirst).some(({ source }) => source?.file === first.site.file)).toBe(true)
})
