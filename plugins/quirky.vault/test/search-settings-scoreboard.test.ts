import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { auditPlugin } from '../../../scripts/ui-scoreboard/audit'
import { discoverCandidates, discoverUiFiles } from '../../../scripts/ui-scoreboard/audit-discovery'
import { parseCoverage } from '../../../scripts/ui-scoreboard/audit-evidence'
import type { CheckResult, Inventory, PluginInventory, StaticCheckId } from '../../../scripts/ui-scoreboard/contracts'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import { checkRatchet, parseRatchetConfig } from '../../../scripts/ui-scoreboard/ratchet'
import { checkPlugin } from '../../../scripts/ui-scoreboard/tokens'

const root = resolve(import.meta.dir, '../../..')
const pluginId = 'quirky.vault'
const searchSettingsFile = 'plugins/quirky.vault/src/window/SearchSettings.tsx'
const fragmentFile = 'plugins/quirky.vault/ui-scoreboard/search-settings.json'
const viewSurface = 'view:quirky.vault/search-settings'
const settingsSurface = 'settings-section:quirky.vault/search'
const emptyReason = 'Search settings are a fixed form: the local host row always renders, and remote hosts only add rows.'
const embeddedReason = 'The embedded Settings section mounts the same SearchSettings component as view:quirky.vault/search-settings, which owns each state site once.'
const localRowEvidence = { file: searchSettingsFile, quote: 'data-vault-host-id="local"' }
const embeddedMountEvidence = [
  { file: searchSettingsFile, quote: 'root.render(<SearchSettings context={context} report={props.report} embedded />)' },
  { file: searchSettingsFile, quote: 'root.render(<SearchSettings context={context} report={props.report} />)' },
]
const inventory = collectInventory(root)
const vault = inventory.plugins.find((plugin) => plugin.id === pluginId)!

type CoverageFileEntry = NonNullable<PluginInventory['coverageFragments']>[number]

function searchSettingsFragment(plugin: PluginInventory = vault): CoverageFileEntry {
  const fragment = plugin.coverageFragments?.find((entry) => entry.file === fragmentFile)
  expect(fragment).toBeDefined()
  return fragment!
}

function withVault(plugin: PluginInventory): Inventory {
  return {
    ...inventory,
    plugins: inventory.plugins.map((entry) => entry.id === pluginId ? plugin : entry),
  }
}

function cloneVault(): PluginInventory {
  return JSON.parse(JSON.stringify(vault)) as PluginInventory
}

function resultFor(results: CheckResult[], id: CheckResult['id']): CheckResult {
  const result = results.find((entry) => entry.id === id)
  expect(result).toBeDefined()
  return result!
}

function replaceOnce(content: string, before: string, after: string): string {
  const index = content.indexOf(before)
  expect(index).toBeGreaterThanOrEqual(0)
  return `${content.slice(0, index)}${after}${content.slice(index + before.length)}`
}

function pluginWithSourceReplacement(before: string, after: string): PluginInventory {
  const copy = cloneVault()
  const source = copy.sources.find((entry) => entry.file === searchSettingsFile)
  expect(source).toBeDefined()
  source!.content = replaceOnce(source!.content, before, after)
  return copy
}

test('Search Settings candidates and static checks pass in the collected inventory', () => {
  const graph = discoverUiFiles(vault)
  expect(graph.failures).toEqual([])

  const candidates = discoverCandidates(vault, graph.files).filter((candidate) => candidate.file === searchSettingsFile)
  expect(candidates).toHaveLength(37)
  expect(candidates.filter((candidate) => candidate.category === 'state')).toHaveLength(31)
  expect(candidates.filter((candidate) => candidate.category === 'action')).toHaveLength(6)
  expect(candidates.filter(({ anchorText }) => anchorText === 'status && (status.filesFailed > 0 || status.degradedRoots.length > 0) ?')
    .map(({ category, kind }) => ({ category, kind }))).toEqual([{ category: 'state', kind: 'conditional-render' }])
  expect(candidates.filter((candidate) => candidate.kind === 'unresolved-assignment')).toEqual([])

  const auditChecks = auditPlugin(inventory, vault)
  expect(Object.fromEntries(auditChecks.map(({ id, status }) => [id, status]))).toEqual({
    loading: 'pass', empty: 'pass', error: 'pass', commands: 'pass',
  })

  const pluginChecks = checkPlugin(inventory, pluginId)
  expect(pluginChecks.map(({ id }) => id).sort()).toEqual([
    'commands', 'compatibility-tokens', 'empty', 'error', 'loading',
  ])
  expect(pluginChecks.every(({ status }) => status === 'pass')).toBe(true)
})

test('Search Settings coverage declares its shared loading and failure branches and actions', () => {
  const fragment = searchSettingsFragment()
  const coverage = parseCoverage(fragment.content)

  expect(Object.keys(coverage.surfaces).sort()).toEqual([settingsSurface, viewSurface].sort())
  expect(coverage.surfaces[viewSurface]).toEqual({
    loading: { applicable: true },
    empty: { applicable: false, reason: emptyReason, evidence: [localRowEvidence] },
    error: { applicable: true },
  })
  expect(coverage.surfaces[settingsSurface]).toEqual({
    loading: { applicable: false, reason: embeddedReason, evidence: embeddedMountEvidence },
    empty: { applicable: false, reason: emptyReason, evidence: [localRowEvidence] },
    error: { applicable: false, reason: embeddedReason, evidence: embeddedMountEvidence },
  })

  expect(coverage.states.map(({ state, surface, anchor, render }) => [surface, state, anchor, render.component]).sort()).toEqual([
    [viewSurface, 'error', 'hostError !== null ?', 'InlineError'],
    [viewSurface, 'error', 'state.error ?', 'InlineError'],
    [viewSurface, 'error', 'state.scopeStatusError ?', 'NoticeLine'],
    [viewSurface, 'error', 'status && (status.filesFailed > 0 || status.degradedRoots.length > 0) ?', 'NoticeLine'],
    [viewSurface, 'loading', 'hostError === null && !remoteStatus ?', 'NoticeLine'],
    [viewSurface, 'loading', 'state.loading ?', 'NoticeLine'],
  ].sort())
  expect(coverage.states.every(({ site }) => site.file === searchSettingsFile)).toBe(true)
  expect(coverage.states.every(({ render }) => 'import' in render && render.import.file === searchSettingsFile && render.import.quote.includes("from '@quirky/ui'"))).toBe(true)

  expect(coverage.notState.filter(({ anchor }) => anchor === 'state.scopeStatusError ?'
    || anchor === 'status && (status.filesFailed > 0 || status.degradedRoots.length > 0) ?')).toEqual([])
  expect(coverage.notState).toHaveLength(19)
  expect(coverage.notState.every(({ site, reason }) => site.file === searchSettingsFile && reason.length > 0)).toBe(true)
  expect(coverage.actions).toHaveLength(6)
  expect(coverage.actions.every((action) => 'route' in action && action.site.file === searchSettingsFile && (action.route.via?.length ?? 0) > 0)).toBe(true)
})

test('Search Settings action evidence resolves all six public API and CLI routes', () => {
  const commands = resultFor(auditPlugin(inventory, vault), 'commands')
  const routes = commands.evidence
    .filter((item) => item.code === 'action-routed' && item.source?.file === searchSettingsFile)
    .map((item) => `${item.api} → ${item.cli}`)
    .sort()

  expect(routes).toEqual([
    'quirky.vault/clearSearchIndex → quirky vault clearSearchIndex',
    'quirky.vault/searchStatus → quirky vault searchStatus',
    'quirky.vault/setSearchEnabled → quirky vault setSearchEnabled',
    'quirky.vault/setSearchEnabled → quirky vault setSearchEnabled',
    'quirky.vault/setSearchEnabled → quirky vault setSearchEnabled',
    'ui.panel.open → quirky ui open-panel panel:quirky.vault/history',
  ])
})

test('removing the Clear action from an in-memory fragment is caught by the commands audit', () => {
  const copy = cloneVault()
  const fragment = searchSettingsFragment(copy)
  const coverage = parseCoverage(fragment.content)
  const clearIndex = coverage.actions.findIndex((action) => 'route' in action && action.route.target === 'quirky.vault/clearSearchIndex')
  expect(clearIndex).toBeGreaterThanOrEqual(0)
  coverage.actions.splice(clearIndex, 1)
  fragment.content = JSON.stringify(coverage)

  const commands = resultFor(auditPlugin(withVault(copy), copy), 'commands')
  expect(commands.status).toBe('fail')
  expect(commands.evidence).toEqual(expect.arrayContaining([
    expect.objectContaining({
      code: 'coverage-missing',
      message: 'Unmapped action candidate jsx-handler: onClick',
      source: expect.objectContaining({ file: searchSettingsFile }),
    }),
  ]))
})

test('replacing the local loading NoticeLine in an in-memory source copy is caught by the loading audit', () => {
  const copy = pluginWithSourceReplacement(
    'data-vault-search-loading><NoticeLine>Checking search status…</NoticeLine>',
    'data-vault-search-loading><p>Checking search status…</p>',
  )
  const loading = resultFor(auditPlugin(withVault(copy), copy), 'loading')

  expect(loading.status).toBe('fail')
  expect(loading.evidence.some((item) => item.code === 'evidence-missing' && item.message.includes('data-vault-search-loading><NoticeLine>Checking search status…</NoticeLine>'))).toBe(true)
})

test('replacing the host InlineError in an in-memory source copy is caught by the error audit', () => {
  const copy = pluginWithSourceReplacement('<InlineError message={hostError} />', '<span>{hostError}</span>')
  const error = resultFor(auditPlugin(withVault(copy), copy), 'error')

  expect(error.status).toBe('fail')
  expect(error.evidence.some((item) => item.code === 'evidence-missing' && item.message.includes('<InlineError message={hostError} />'))).toBe(true)
})

test('replacing the remote entries push with an assignment in an in-memory source copy is caught by commands', () => {
  const copy = pluginWithSourceReplacement(
    'remoteEntries.push([host.hostId, { status: remote, error: null }])',
    'remoteStatuses[host.hostId] = { status: remote, error: null }',
  )
  const commands = resultFor(auditPlugin(withVault(copy), copy), 'commands')

  expect(commands.status).toBe('fail')
  expect(commands.evidence).toEqual(expect.arrayContaining([
    expect.objectContaining({
      code: 'coverage-missing',
      message: expect.stringContaining('Unmapped action candidate unresolved-assignment: remoteStatuses[host.hostId]'),
      source: expect.objectContaining({ file: searchSettingsFile }),
    }),
  ]))
})

test('the ratchet enrolls all five Vault static checks and accepts the collected inventory', () => {
  const ratchet = parseRatchetConfig(readFileSync(resolve(root, 'scripts/ui-scoreboard-ratchet.json'), 'utf8'))
  const enrolledChecks: StaticCheckId[] = ['commands', 'compatibility-tokens', 'empty', 'error', 'loading']
  expect(ratchet[pluginId]).toEqual(enrolledChecks)

  const result = checkRatchet(inventory, { [pluginId]: enrolledChecks })
  expect(result.exitCode).toBe(0)
  expect(result.failures).toEqual([])
}, 30_000)
