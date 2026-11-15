import { beforeAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { UI_CONTROL_COMMAND } from '../src/ui-control'
import { auditPlugin } from '../../../scripts/ui-scoreboard/audit'
import { parseCoverage } from '../../../scripts/ui-scoreboard/audit-evidence'
import { discoverCandidates, discoverUiFiles } from '../../../scripts/ui-scoreboard/audit-discovery'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import { checkPlugin } from '../../../scripts/ui-scoreboard/tokens'
import { checkRatchet, parseRatchetConfig } from '../../../scripts/ui-scoreboard/ratchet'
import type { CoverageFile, Inventory, PluginInventory, StaticCheckId } from '../../../scripts/ui-scoreboard/contracts'

const ROOT = resolve(import.meta.dir, '../../..')
const FRAGMENT = 'plugins/quirky.worktree/ui-scoreboard/group-and-settings-dialogs.json'
const FILES = ['actions.ts', 'GroupDialogs.tsx', 'StatusSettingsDialog.tsx', 'TagsPopover.tsx'].map((name) => `plugins/quirky.worktree/src/${name}`)
const CHECKS: StaticCheckId[] = ['commands', 'compatibility-tokens', 'empty', 'error', 'loading']
let inventory: Inventory
let plugin: PluginInventory
let coverage: CoverageFile

beforeAll(() => {
  inventory = collectInventory(ROOT)
  expect(inventory.failures).toEqual([])
  plugin = inventory.plugins.find(({ id }) => id === 'quirky.worktree')!
  expect(plugin).toBeDefined()
  const graph = discoverUiFiles(plugin)
  expect(graph.failures).toEqual([])
  expect(graph.files.length).toBeGreaterThanOrEqual(56)
  expect(graph.files).toEqual(expect.arrayContaining(FILES))
  const fragment = plugin.coverageFragments?.find(({ file }) => file === FRAGMENT)
  expect(fragment).toBeDefined()
  coverage = parseCoverage(fragment!.content)
})

function subject(value: CoverageFile): PluginInventory {
  return { ...plugin, coverageFragments: plugin.coverageFragments!.map((entry) => entry.file === FRAGMENT ? { ...entry, content: JSON.stringify(value) } : entry) }
}
function withPlugin(value: PluginInventory): Inventory {
  return { ...inventory, plugins: inventory.plugins.map((entry) => entry.id === plugin.id ? value : entry) }
}
function audit(value = coverage) { return auditPlugin(inventory, subject(value)).flatMap(({ evidence }) => evidence) }
function missing(value: CoverageFile, file: string): boolean {
  return audit(value).some(({ code, source }) => code === 'coverage-missing' && source?.file === file)
}
function enrollment() {
  const actual = parseRatchetConfig(readFileSync(resolve(ROOT, 'scripts/ui-scoreboard-ratchet.json'), 'utf8'))
  expect(actual['quirky.worktree']).toEqual(CHECKS)
  return { 'quirky.worktree': actual['quirky.worktree']! }
}

test('the unfiltered Worktree graph passes exactly all five static checks', () => {
  expect(coverage.schemaVersion).toBe(1)
  expect(coverage.surfaces).toEqual({})
  expect(coverage.states.every(({ surface }) => surface === 'sidebar-section:quirky.worktree/worktrees')).toBe(true)
  for (const entry of [...coverage.states, ...coverage.notState, ...coverage.actions]) expect(FILES).toContain(entry.site.file)
  const candidates = discoverCandidates(plugin, discoverUiFiles(plugin).files)
  for (const file of FILES) expect(candidates.some((candidate) => candidate.file === file)).toBe(true)
  expect(candidates.filter(({ file, kind }) => file === FILES[0] && kind.startsWith('unresolved'))).toEqual([])
  const checks = checkPlugin(inventory, plugin.id)
  expect(checks.map(({ id }) => id).sort()).toEqual([...CHECKS].sort())
  expect(checks.filter(({ status }) => status !== 'pass')).toEqual([])
})

test('the actual Worktree enrollment passes against the complete inventory', () => {
  expect(checkRatchet(inventory, enrollment())).toEqual({ exitCode: 0, failures: [] })
}, 30_000)

test('every owned route resolves the actual public API and generated CLI', () => {
  const routes = audit().filter(({ code, coverageFile }) => code === 'action-routed' && coverageFile === FRAGMENT)
  for (const [api, cli] of [
    ['ui.command.run', `quirky ui run ${UI_CONTROL_COMMAND}`],
    ['quirky.repo/groupCreate', 'quirky repo group create'],
    ['quirky.repo/groupRename', 'quirky repo group rename'],
    ['quirky.repo/groupDelete', 'quirky repo group delete'],
    ['quirky.worktree/createGroup', 'quirky worktree create-group'],
    ['quirky.worktree/setStatusDefinitions', 'quirky worktree status-set'],
    ['quirky.worktree/tagCreate', 'quirky worktree tagCreate'],
    ['quirky.worktree/tagUpdate', 'quirky worktree tagUpdate'],
    ['quirky.worktree/tagAssign', 'quirky worktree tagAssign']
  ]) expect(routes).toEqual(expect.arrayContaining([expect.objectContaining({ api: expect.stringContaining(api!), cli })]))
  const repo = inventory.plugins.find(({ id }) => id === 'quirky.repo')!
  expect(repo.contributions?.cliCommands).toEqual(expect.arrayContaining([expect.objectContaining({ methods: expect.arrayContaining(['quirky.repo/groupAdd']) })]))
  for (const file of FILES.slice(1)) expect(coverage.actions.some((entry) => entry.site.file === file && 'route' in entry && entry.route.target === UI_CONTROL_COMMAND)).toBe(true)
})

test.each(['loading', 'empty', 'error', 'helper'] as const)('removing owned %s evidence exposes its candidate and fails the ratchet', (kind) => {
  const value = structuredClone(coverage)
  const index = value.states.findIndex((entry) => kind === 'helper' ? entry.site.file === FILES[0] && entry.render.component === 'toast' : entry.state === kind && entry.render.component !== 'toast')
  expect(index).toBeGreaterThanOrEqual(0)
  const [removed] = value.states.splice(index, 1)
  expect(missing(value, removed!.site.file)).toBe(true)
  expect(checkRatchet(withPlugin(subject(value)), enrollment()).exitCode).toBe(1)
}, 30_000)

test('helper success notices remain advisory and partial import and trust failures remain errors', () => {
  const source = plugin.sources.find(({ file }) => file === FILES[0])!.content
  const advisories = coverage.notState.filter(({ site }) => site.file === FILES[0]).map(({ site, anchor }) => {
    const offset = source.indexOf(site.quote) + site.quote.indexOf(anchor!)
    return source.slice(offset, offset + 180)
  })
  for (const beginning of [
    'context.toast(`Created ${result.worktree.name}`, result.worktree.path)',
    "context.toast('Guest workspace base fallback'",
    'context.toast(`Created ${result.worktree.name}`, receiptLines',
    "context.toast(\"We'll skip this confirmation next time."
  ]) expect(advisories.some((text) => text.startsWith(beginning))).toBe(true)
  const helperErrors = coverage.states.filter(({ site, render }) => site.file === FILES[0] && render.component === 'toast')
  for (const text of ['Some repositories could not be added', 'Could not trust ${kindLabel}', 'context.toast(failure, messageOf(error))']) {
    expect(helperErrors.some(({ render }) => render.component === 'toast' && render.call.quote.includes(text))).toBe(true)
  }
})

test('advisory and routed control classifications are required, not decorative coverage', () => {
  const value = structuredClone(coverage)
  const index = value.notState.findIndex(({ site }) => /retention|Ledger records retained/.test(site.quote))
  expect(index).toBeGreaterThanOrEqual(0)
  const [removed] = value.notState.splice(index, 1)
  expect(missing(value, removed!.site.file)).toBe(true)
  for (const file of FILES.slice(1)) {
    const changed = structuredClone(coverage)
    const action = changed.actions.findIndex((entry) => entry.site.file === file && 'route' in entry && entry.route.target === UI_CONTROL_COMMAND)
    expect(action).toBeGreaterThanOrEqual(0)
    changed.actions.splice(action, 1)
    expect(missing(changed, file)).toBe(true)
  }
})

test('wrong shared render kinds, undeclared targets and stale complete witnesses fail closed', () => {
  for (const [kind, component] of [['loading', 'InlineError'], ['error', 'NoticeLine']] as const) {
    const value = structuredClone(coverage)
    const entry = value.states.find((entry) => entry.state === kind && entry.render.component !== 'toast')!
    entry.render = { ...entry.render, component } as typeof entry.render
    expect(audit(value).some(({ code }) => code === 'render-not-accepted')).toBe(true)
  }
  const value = structuredClone(coverage)
  const action = value.actions.find((entry) => 'route' in entry && entry.route.target === UI_CONTROL_COMMAND)!
  if (!('route' in action)) throw new Error('Missing control route')
  action.route.target = 'command:quirky.worktree/undeclared'
  expect(audit(value).some(({ code }) => code === 'route-target-changed')).toBe(true)
  const stale = structuredClone(coverage)
  const routed = stale.actions.find((entry) => 'route' in entry && entry.route.via?.length)!
  if (!('route' in routed)) throw new Error('Missing complete route witness')
  routed.route.via![0]!.quote += '\n// stale witness'
  expect(audit(stale).some(({ code }) => code === 'evidence-missing' || code === 'via-invalid')).toBe(true)
})

test('the enrolled ratchet detects an owned compatibility token in its full source snapshot', () => {
  const changed = { ...plugin, sources: plugin.sources.map((source) => source.file === FILES[1] ? { ...source, content: source.content + '\nconst style = "var(--compat-g3-regression)"\n' } : source) }
  expect(checkRatchet(withPlugin(changed), enrollment()).exitCode).toBe(1)
}, 30_000)
