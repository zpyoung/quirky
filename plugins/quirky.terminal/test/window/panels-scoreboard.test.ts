import { beforeAll, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { collectInventory } from '../../../../scripts/ui-scoreboard/inventory'
import { auditPlugin } from '../../../../scripts/ui-scoreboard/audit'
import { parseCoverage } from '../../../../scripts/ui-scoreboard/audit-evidence'
import type { CheckResult, CoverageFile, Evidence, Inventory, PluginInventory } from '../../../../scripts/ui-scoreboard/contracts'

const ROOT = 'plugins/quirky.terminal/'
const FRAGMENT = `${ROOT}ui-scoreboard/panels.json`
const OWNED = ['src/ui.tsx', 'src/window/EmulatorView.tsx', 'src/window/SessionsPanel.tsx', 'src/window/ShortcutSettings.tsx', 'src/window/quick-commands/QuickCommandDialog.tsx', 'src/window/quick-commands/QuickCommandsPanel.tsx', 'src/window/quick-commands/QuickCommandsStripButton.tsx', 'src/window/quick-commands/shared.tsx', 'src/window/floating/FloatingOverlay.tsx'].map((path) => ROOT + path)
const SURFACES = ['overlay:quirky.terminal/floating', 'panel:quirky.terminal/quick-commands', 'panel:quirky.terminal/sessions', 'settings-section:quirky.terminal/shortcuts', 'view:quirky.terminal/emulator']
const PASS: Record<string, true> = { 'state-covered': true, 'state-not-applicable': true, 'not-state': true, 'action-routed': true, 'action-transient': true, 'action-not-user': true }
let inventory: Inventory
let plugin: PluginInventory
let coverage: CoverageFile
let checks: CheckResult[]

beforeAll(() => {
  inventory = collectInventory(resolve(import.meta.dir, '../../../..'))
  expect(inventory.failures).toEqual([])
  plugin = inventory.plugins.find((entry) => entry.id === 'quirky.terminal')!
  const fragment = plugin.coverageFragments?.find((entry) => entry.file === FRAGMENT)
  expect(fragment).toBeDefined()
  coverage = parseCoverage(fragment!.content)
  checks = auditPlugin(inventory, plugin)
})

function withCoverage(value: CoverageFile): PluginInventory {
  return { ...plugin, coverageFragments: plugin.coverageFragments!.map((entry) => entry.file === FRAGMENT ? { ...entry, content: JSON.stringify(value) } : entry) }
}

function failures(evidence: Evidence[]): Evidence[] {
  return evidence.filter((entry) => !PASS[entry.code])
}

test('all five surfaces declare loading, empty and error applicable', () => {
  expect(Object.keys(coverage.surfaces).sort()).toEqual([...SURFACES].sort())
  for (const surface of SURFACES) expect(coverage.surfaces[surface]).toEqual({ loading: { applicable: true }, empty: { applicable: true }, error: { applicable: true } })
})

test('all fragment entries pass and all nine owned source files are covered', () => {
  const issues = failures(checks.flatMap((check) => check.evidence))
  expect(issues.filter((entry) => entry.coverageFile === FRAGMENT && entry.code !== 'state-missing')).toEqual([])
  expect(issues.filter((entry) => OWNED.includes(entry.source?.file ?? ''))).toEqual([])
})

test('only floating overlay loading and empty may remain missing', () => {
  for (const check of checks) {
    for (const entry of check.evidence.filter((entry) => entry.code === 'state-missing')) {
      expect(entry.targetId).toBe('overlay:quirky.terminal/floating')
      expect(['loading', 'empty']).toContain(check.id)
    }
  }
})

test('shared state evidence covers the four panels and floating errors', () => {
  for (const surface of SURFACES) {
    for (const state of surface.startsWith('overlay:') ? ['error'] : ['loading', 'empty', 'error']) {
      expect(checks.find((check) => check.id === state)!.evidence.some((entry) => entry.code === 'state-covered' && entry.targetId === surface)).toBe(true)
    }
  }
})

test('replacing emulator shared loading with raw markup invalidates its witness', () => {
  const quote = '<NoticeLine>Loading simulators…</NoticeLine>'
  const source = plugin.sources.find((entry) => entry.file === `${ROOT}src/window/EmulatorView.tsx`)!
  expect(source.content).toContain(quote)
  const mutated = { ...plugin, sources: plugin.sources.map((entry) => entry === source ? { ...entry, content: entry.content.replace(quote, '<p>Loading simulators…</p>') } : entry) }
  expect(failures(auditPlugin(inventory, mutated).find((check) => check.id === 'loading')!.evidence).some((entry) => entry.coverageFile === FRAGMENT)).toBe(true)
})

test('removing restart-host coverage exposes the Sessions action', () => {
  const action = coverage.actions.find((entry) => 'route' in entry && entry.route.target === 'quirky.terminal/restartHost')!
  expect(action).toBeDefined()
  const mutated = withCoverage({ ...coverage, actions: coverage.actions.filter((entry) => entry !== action) })
  expect(auditPlugin(inventory, mutated).find((check) => check.id === 'commands')!.evidence.some((entry) => entry.code === 'coverage-missing' && entry.source?.file.endsWith('/SessionsPanel.tsx'))).toBe(true)
})

test('undeclaring the dialog command invalidates the routed actions', () => {
  const mutated = { ...plugin, contributions: { ...plugin.contributions!, commands: plugin.contributions!.commands.filter((id) => id !== 'command:quirky.terminal/quick-command-dialog') } }
  const changedInventory = { ...inventory, plugins: inventory.plugins.map((entry) => entry.id === plugin.id ? mutated : entry) }
  expect(auditPlugin(changedInventory, mutated).find((check) => check.id === 'commands')!.evidence.some((entry) => entry.code === 'route-undeclared' && entry.coverageFile === FRAGMENT)).toBe(true)
})

test('hidden commands have strict public argument schemas', async () => {
  const manifest = await Bun.file(resolve(import.meta.dir, '../../quirky-plugin.json')).json()
  const commands = manifest.contributes.command
  const dialog = commands.find((entry: { id: string }) => entry.id === 'quick-command-dialog')
  const copy = commands.find((entry: { id: string }) => entry.id === 'copy-quick-command')
  expect(dialog.palette).toBe(false)
  expect(dialog.args.required).toEqual(['action'])
  expect(dialog.args.additionalProperties).toBe(false)
  expect(dialog.args.properties.action.enum).toEqual(['open', 'toggle-advanced', 'toggle-append-enter'])
  expect(copy.palette).toBe(false)
  expect(copy.args.required).toEqual(['command'])
  expect(copy.args.additionalProperties).toBe(false)
  for (const command of [dialog, copy]) {
    for (const property of Object.values(command.args.properties) as { type: unknown }[]) expect(typeof property.type).toBe('string')
  }
})
