import { beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import { discoverCandidates, discoverUiFiles } from '../../../scripts/ui-scoreboard/audit-discovery'
import { parseCoverage } from '../../../scripts/ui-scoreboard/audit-evidence'
import { auditPlugin } from '../../../scripts/ui-scoreboard/audit'
import { checkPlugin } from '../../../scripts/ui-scoreboard/tokens'
import { checkRatchet, parseRatchetConfig } from '../../../scripts/ui-scoreboard/ratchet'
import type { CoverageFile, Inventory, PluginInventory, StateKind, StaticCheckId, SourceFile } from '../../../scripts/ui-scoreboard/contracts'

const PLUGIN_ID = 'quirky.orchestration'
const PLUGIN_DIR = `plugins/${PLUGIN_ID}`
const COVERAGE_FILE = `${PLUGIN_DIR}/ui-scoreboard.json`
const UI_SOURCE = `${PLUGIN_DIR}/src/ui.tsx`
const SETTINGS_SOURCE = `${PLUGIN_DIR}/src/window/OrchestrationSettings.tsx`
const REMOTE_SOURCE = `${PLUGIN_DIR}/src/window/RemoteWorkerOutputView.tsx`
const OVERLAY = 'overlay:quirky.orchestration/floating-setup'
const SETTINGS = 'view:quirky.orchestration/settings'
const REMOTE = 'view:quirky.orchestration/remote-worker-output'
const SURFACES = [OVERLAY, REMOTE, SETTINGS]
const ENROLLED_CHECKS: StaticCheckId[] = ['commands', 'compatibility-tokens', 'empty', 'error', 'loading']

const repoRoot = resolve(import.meta.dir, '../../..')
let inventory: Inventory
let plugin: PluginInventory
let coverage: CoverageFile

function pluginIn(snapshot: Inventory): PluginInventory {
  const found = snapshot.plugins.find((entry) => entry.id === PLUGIN_ID)
  if (!found) throw new Error(`Inventory did not contain ${PLUGIN_ID}`)
  return found
}

function clonedFixture(): { inventory: Inventory; plugin: PluginInventory } {
  const copy = structuredClone(inventory)
  return { inventory: copy, plugin: pluginIn(copy) }
}

function sourceIn(subject: PluginInventory, file: string): SourceFile {
  const source = subject.sources.find((entry) => entry.file === file)
  if (!source) throw new Error(`Inventory did not contain source ${file}`)
  return source
}

function replaceOnce(source: SourceFile, before: string, after: string): void {
  expect(source.content.split(before)).toHaveLength(2)
  const changed = source.content.replace(before, after)
  expect(changed).not.toBe(source.content)
  expect(changed).toContain(after)
  expect(changed).not.toContain(before)
  source.content = changed
}

function checkIn(snapshot: Inventory, subject: PluginInventory, id: 'loading' | 'empty' | 'error' | 'commands') {
  const check = auditPlugin(snapshot, subject).find((entry) => entry.id === id)
  if (!check) throw new Error(`Audit did not return ${id}`)
  return check
}

beforeAll(() => {
  inventory = collectInventory(repoRoot)
  expect(inventory.failures).toEqual([])
  plugin = pluginIn(inventory)
  expect(plugin.coverage?.file).toBe(COVERAGE_FILE)
  coverage = parseCoverage(plugin.coverage!.content)
}, 30_000)

test('discovers the full 68-candidate orchestration UI graph', () => {
  const graph = discoverUiFiles(plugin)
  expect(graph.failures).toEqual([])
  expect(graph.files).toHaveLength(13)

  const candidates = discoverCandidates(plugin, graph.files)
  expect(candidates).toHaveLength(68)
  expect(candidates.filter((candidate) => candidate.kind.startsWith('unresolved-'))).toEqual([])

  const observedCounts = Object.fromEntries(
    [...new Set(candidates.map((candidate) => candidate.file))].sort().map((file) => {
      const inFile = candidates.filter((candidate) => candidate.file === file)
      return [file, {
        state: inFile.filter((candidate) => candidate.category === 'state').length,
        action: inFile.filter((candidate) => candidate.category === 'action').length,
      }]
    }),
  )
  expect(observedCounts).toEqual({
    [UI_SOURCE]: { state: 3, action: 3 },
    [SETTINGS_SOURCE]: { state: 30, action: 12 },
    [REMOTE_SOURCE]: { state: 18, action: 2 },
  })
}, 30_000)

test('passes all four source audits and all five static plugin checks', () => {
  const audit = auditPlugin(inventory, plugin)
  expect(audit.map(({ id, status }) => [id, status])).toEqual([
    ['loading', 'pass'],
    ['empty', 'pass'],
    ['error', 'pass'],
    ['commands', 'pass'],
  ])

  const checks = checkPlugin(inventory, PLUGIN_ID)
  expect(checks).toHaveLength(5)
  expect(checks.map(({ id, status }) => [id, status])).toEqual([
    ['compatibility-tokens', 'pass'],
    ['loading', 'pass'],
    ['empty', 'pass'],
    ['error', 'pass'],
    ['commands', 'pass'],
  ])
}, 30_000)

test('coverage has the reviewed three-surface state and action shape', () => {
  expect(parseCoverage(plugin.coverage!.content)).toEqual(coverage)
  expect(Object.keys(coverage.surfaces).sort()).toEqual([...SURFACES].sort())
  expect(coverage.states).toHaveLength(15)
  expect(coverage.notState).toHaveLength(22)
  expect(coverage.actions).toHaveLength(17)

  expect(coverage.surfaces[OVERLAY]).toMatchObject({
    loading: { applicable: false },
    empty: { applicable: false },
    error: { applicable: true },
  })
  for (const surface of [SETTINGS, REMOTE]) {
    expect(coverage.surfaces[surface]).toMatchObject({
      loading: { applicable: true },
      empty: { applicable: true },
      error: { applicable: true },
    })
  }

  const stateCounts: Record<string, Partial<Record<StateKind, number>>> = {}
  for (const entry of coverage.states) {
    const counts = stateCounts[entry.surface] ??= {}
    counts[entry.state] = (counts[entry.state] ?? 0) + 1
  }
  expect(stateCounts).toEqual({
    [OVERLAY]: { error: 1 },
    [SETTINGS]: { loading: 3, empty: 1, error: 5 },
    [REMOTE]: { loading: 2, empty: 1, error: 2 },
  })
}, 30_000)

test('every routed action has its expected public CLI pair', () => {
  const commands = checkIn(inventory, plugin, 'commands')
  const routed = commands.evidence.filter((entry) => entry.code === 'action-routed')
  expect(routed).toHaveLength(9)

  const pairKeys = routed.map(({ api, cli }) => `${api}\0${cli}`).sort()
  const expected = [
    ['ui.command.run', 'quirky ui run command:quirky.orchestration/dismiss-setup'],
    ['ui.command.run', 'quirky ui run command:quirky.orchestration/open-settings'],
    ['ui.command.run', 'quirky ui run command:quirky.orchestration/copy-install-command'],
    ['ui.command.run', 'quirky ui run command:quirky.orchestration/copy-prompt'],
    ['quirky.orchestration/skillInstall', 'quirky orchestration skill-install'],
    ['quirky.orchestration/skillStatus', 'quirky orchestration skill-status'],
    ['quirky.orchestration/policySet', 'quirky orchestration policy-set'],
    ['quirky.orchestration/workerRead', 'quirky orchestration worker-read'],
    ['quirky.orchestration/workerRead', 'quirky orchestration worker-read'],
  ].map(([api, cli]) => `${api}\0${cli}`).sort()
  expect(pairKeys).toEqual(expected)
}, 30_000)

test('reports an unmapped copy-prompt action when its coverage entry is removed', () => {
  const { inventory: changedInventory, plugin: changedPlugin } = clonedFixture()
  const coverageSource = changedPlugin.coverage
  if (!coverageSource) throw new Error('Orchestration coverage was missing')
  const changedCoverage = parseCoverage(coverageSource.content)
  const removed = changedCoverage.actions.filter((entry) => 'route' in entry && entry.route.target === 'command:quirky.orchestration/copy-prompt')
  expect(removed).toHaveLength(1)
  changedCoverage.actions = changedCoverage.actions.filter((entry) => !('route' in entry && entry.route.target === 'command:quirky.orchestration/copy-prompt'))
  expect(changedCoverage.actions).toHaveLength(16)
  coverageSource.content = JSON.stringify(changedCoverage)

  const commands = checkIn(changedInventory, changedPlugin, 'commands')
  expect(commands.status).toBe('fail')
  expect(commands.evidence).toContainEqual(expect.objectContaining({
    code: 'coverage-missing',
    message: 'Unmapped action candidate jsx-handler: onClick',
  }))
}, 30_000)

test('rejects a raw error render after the remote InlineError witness is replaced', () => {
  const { inventory: changedInventory, plugin: changedPlugin } = clonedFixture()
  replaceOnce(
    sourceIn(changedPlugin, REMOTE_SOURCE),
    '{error ? <InlineError message={error} /> : null}',
    '{error ? <div role="alert" className="ui-error-text">{error}</div> : null}',
  )

  const error = checkIn(changedInventory, changedPlugin, 'error')
  expect(error.status).toBe('fail')
  expect(error.evidence).toContainEqual(expect.objectContaining({
    code: 'evidence-missing',
    message: expect.stringContaining('<InlineError message={error} />'),
  }))
}, 30_000)

test('finds an unresolved window listener when the dismissal signal is replaced', () => {
  const { inventory: changedInventory, plugin: changedPlugin } = clonedFixture()
  replaceOnce(
    sourceIn(changedPlugin, UI_SOURCE),
    'const stopDismissed = signals.dismissed.subscribe(() => { setDismissed(true) })',
    'const stopDismissed = () => {}\n    window.addEventListener(DISMISSED_EVENT, () => { setDismissed(true) })',
  )

  const commands = checkIn(changedInventory, changedPlugin, 'commands')
  expect(commands.status).toBe('fail')
  expect(commands.evidence).toContainEqual(expect.objectContaining({
    code: 'coverage-missing',
    message: 'Unmapped action candidate unresolved-listener: window.addEventListener(DISMISSED_EVENT',
  }))
}, 30_000)

test('rejects a copy-prompt route after its command declaration is removed', () => {
  const { inventory: changedInventory, plugin: changedPlugin } = clonedFixture()
  const commands = changedPlugin.contributions?.commands
  if (!commands) throw new Error('Orchestration command contributions were missing')
  const target = 'command:quirky.orchestration/copy-prompt'
  expect(commands.filter((command) => command === target)).toHaveLength(1)
  changedPlugin.contributions!.commands = commands.filter((command) => command !== target)
  expect(changedPlugin.contributions!.commands).not.toContain(target)

  const commandCheck = checkIn(changedInventory, changedPlugin, 'commands')
  expect(commandCheck.status).toBe('fail')
  expect(commandCheck.evidence).toContainEqual(expect.objectContaining({
    code: 'route-undeclared',
    message: expect.stringContaining(`Undeclared command ${target}`),
  }))
}, 30_000)

test('rejects raw depth-loading markup after its NoticeLine witness is replaced', () => {
  const { inventory: changedInventory, plugin: changedPlugin } = clonedFixture()
  replaceOnce(
    sourceIn(changedPlugin, SETTINGS_SOURCE),
    '<NoticeLine>Checking nested worker depth…</NoticeLine>',
    '<p className="ui-text-muted">Checking nested worker depth…</p>',
  )

  const loading = checkIn(changedInventory, changedPlugin, 'loading')
  expect(loading.status).toBe('fail')
  expect(loading.evidence).toContainEqual(expect.objectContaining({
    code: 'evidence-missing',
    message: expect.stringContaining('<NoticeLine>Checking nested worker depth…</NoticeLine>'),
  }))
}, 30_000)

test('enrolls all orchestration static checks and passes the ratchet CLI', () => {
  const ratchet = parseRatchetConfig(readFileSync(resolve(repoRoot, 'scripts/ui-scoreboard-ratchet.json'), 'utf8'))
  expect(ratchet[PLUGIN_ID]).toEqual(ENROLLED_CHECKS)

  const result = checkRatchet(inventory, { [PLUGIN_ID]: [...ENROLLED_CHECKS] })
  expect(result).toEqual({ exitCode: 0, failures: [] })

  const home = mkdtempSync(join(tmpdir(), 'quirky-orchestration-scoreboard-'))
  try {
    const cli = Bun.spawnSync(['bun', 'run', 'ui:scoreboard:check'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home, QUIRKY_HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(cli.exitCode).toBe(0)
    expect(cli.stdout.toString()).toContain('Static ratchet: passed')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}, 30_000)
