import { beforeAll, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { UI_CONTROL_COMMAND } from '../src/ui-control'
import { auditPlugin } from '../../../scripts/ui-scoreboard/audit'
import { parseCoverage } from '../../../scripts/ui-scoreboard/audit-evidence'
import { discoverCandidates, discoverUiFiles } from '../../../scripts/ui-scoreboard/audit-discovery'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import type { Candidate, CoverageFile, Evidence, Inventory, PluginInventory } from '../../../scripts/ui-scoreboard/contracts'

const FRAGMENT = 'plugins/quirky.worktree/ui-scoreboard/project-dialogs.json'
const WORKTREES = 'sidebar-section:quirky.worktree/worktrees'
const CREATE_FILE = 'plugins/quirky.worktree/src/CreateDialog.tsx'
const ADD_FILE = 'plugins/quirky.worktree/src/AddProjectDialog.tsx'
const SETTINGS_FILE = 'plugins/quirky.worktree/src/ProjectSettingsDialog.tsx'
const CONTROL_FILE = 'plugins/quirky.worktree/src/ui-control.ts'
const OWNED_FILES: Record<string, true> = {
  [CREATE_FILE]: true,
  [ADD_FILE]: true,
  [SETTINGS_FILE]: true,
  [CONTROL_FILE]: true,
}
const PASS_CODES: Record<string, true> = {
  'state-covered': true,
  'state-not-applicable': true,
  'not-state': true,
  'action-routed': true,
  'action-transient': true,
  'action-not-user': true,
}
const REQUIRED_CLI = [
  'quirky worktree create',
  'quirky repo add',
  'quirky repo import',
  'quirky repo set',
  'quirky desktop pick-folder',
  'quirky ui open-view view:quirky.worktree/environments',
]

let inventory: Inventory
let plugin: PluginInventory
let coverage: CoverageFile
let fragmentText: string
let uiFiles: string[]
let candidates: Candidate[]

beforeAll(() => {
  inventory = collectInventory(resolve(import.meta.dir, '../../..'))
  plugin = inventory.plugins.find((entry) => entry.id === 'quirky.worktree')!
  expect(plugin).toBeDefined()
  const graph = discoverUiFiles(plugin)
  uiFiles = graph.files
  expect(uiFiles.length).toBeGreaterThanOrEqual(55)
  candidates = discoverCandidates(plugin, uiFiles)
  const fragment = plugin.coverageFragments?.find((entry) => entry.file === FRAGMENT)
  expect(fragment).toBeDefined()
  fragmentText = fragment!.content
  coverage = parseCoverage(fragmentText)
})

function withCoverage(value: CoverageFile): PluginInventory {
  return {
    ...plugin,
    coverageFragments: plugin.coverageFragments!.map((fragment) => fragment.file === FRAGMENT
      ? { ...fragment, content: JSON.stringify(value) }
      : fragment),
  }
}

function evidence(subject = plugin, sourceInventory = inventory): Evidence[] {
  return auditPlugin(sourceInventory, subject).flatMap(({ evidence: entries }) => entries)
}

function failures(subject = plugin, sourceInventory = inventory): Evidence[] {
  return evidence(subject, sourceInventory).filter(({ code }) => PASS_CODES[code] !== true)
}

function ownedFailures(subject = plugin, sourceInventory = inventory): Evidence[] {
  return failures(subject, sourceInventory).filter(({ source, coverageFile }) =>
    OWNED_FILES[source?.file ?? ''] === true || coverageFile === FRAGMENT)
}

function cloneCoverage(): CoverageFile {
  return JSON.parse(JSON.stringify(coverage)) as CoverageFile
}

function controlRoute() {
  const entry = coverage.actions.find((action) => 'route' in action && action.route.target === UI_CONTROL_COMMAND)
  expect(entry).toBeDefined()
  if (!entry || !('route' in entry)) throw new Error(`Missing routed action for ${UI_CONTROL_COMMAND}`)
  return entry
}

test('the fragment adds only worktrees dialog evidence without redeclaring inherited surfaces', () => {
  expect(coverage.schemaVersion).toBe(1)
  expect(coverage.surfaces).toEqual({})
  expect(coverage.states.length).toBeGreaterThan(0)
  expect(coverage.states.every((entry) => entry.surface === WORKTREES)).toBe(true)
  expect(coverage.states.filter((entry) => entry.state === 'loading').length).toBeGreaterThan(0)
  expect(coverage.states.filter((entry) => entry.state === 'loading')
    .every((entry) => entry.render.component === 'NoticeLine')).toBe(true)
  expect(coverage.states.filter((entry) => entry.state === 'empty').length).toBeGreaterThan(0)
  expect(coverage.states.filter((entry) => entry.state === 'empty')
    .every((entry) => entry.render.component === 'EmptyState')).toBe(true)
  expect(coverage.states.filter((entry) => entry.state === 'error').length).toBeGreaterThan(0)
  expect(coverage.states.filter((entry) => entry.state === 'error')
    .every((entry) => ['InlineError', 'FormRow', 'toast', 'NoticeLine'].includes(entry.render.component))).toBe(true)
  expect(coverage.notState.length).toBeGreaterThan(0)
  expect(coverage.actions.length).toBeGreaterThan(0)
  for (const entry of [...coverage.states, ...coverage.notState, ...coverage.actions]) {
    expect(OWNED_FILES[entry.site.file]).toBe(true)
  }

  for (const file of Object.keys(OWNED_FILES)) {
    expect(plugin.sources.some((source) => source.file === file)).toBe(true)
  }

  const entryLines = fragmentText.split('\n').filter((line) => /^\s{4}\{.*\},?$/.test(line))
  expect(entryLines.length).toBe(coverage.states.length + coverage.notState.length + coverage.actions.length)
  expect(fragmentText.split('\n').length).toBeLessThanOrEqual(220)
})

test('the real inventory audit covers only this fragment’s four dialog sources', () => {
  expect(uiFiles.length).toBeGreaterThanOrEqual(55)
  expect(ownedFailures()).toEqual([])
  expect(candidates.filter(({ file }) => OWNED_FILES[file] === true).length).toBeGreaterThan(0)

  const computedWrites = candidates.filter(({ file, kind }) =>
    (file === CREATE_FILE || file === SETTINGS_FILE) && kind === 'unresolved-assignment')
  expect(computedWrites).toEqual([])
})

test('routed dialog actions resolve to their public CLI commands', () => {
  const routedCli = evidence()
    .filter(({ code, source, coverageFile }) => code === 'action-routed' &&
      (OWNED_FILES[source?.file ?? ''] === true || coverageFile === FRAGMENT))
    .map(({ cli }) => cli)
  expect(routedCli).toEqual(expect.arrayContaining([
    ...REQUIRED_CLI,
    `quirky ui run ${UI_CONTROL_COMMAND}`,
  ]))

  const control = controlRoute()
  expect(control.site.file).toBe(CREATE_FILE)
  expect(control.route.invoke.file).toBe(CONTROL_FILE)
  expect(control.route.invoke.quote).toBe('command: UI_CONTROL_COMMAND')
  expect(control.route.invoke.quote).not.toContain('ui.window.command.run')
  expect(control.route.invoke.quote).not.toContain('executeCommand')

  const metadataCli = plugin.contributions?.cliCommands.find((command) =>
    command.id === 'project-set' && command.methods.includes('quirky.worktree/setProjectMetadata'))
  expect(metadataCli).toBeDefined()
  expect(`quirky worktree ${metadataCli?.words ?? metadataCli?.id}`).toBe('quirky worktree project-set')
})

test('removing the first state, advisory, or decisive control action exposes its candidate', () => {
  const firstState = coverage.states[0]!
  expect(ownedFailures(withCoverage({ ...coverage, states: coverage.states.slice(1) }))
    .some(({ code, source }) => code === 'coverage-missing' && source?.file === firstState.site.file)).toBe(true)

  const firstAdvisory = coverage.notState[0]!
  expect(ownedFailures(withCoverage({ ...coverage, notState: coverage.notState.slice(1) }))
    .some(({ code, source }) => code === 'coverage-missing' && source?.file === firstAdvisory.site.file)).toBe(true)

  const decisive = controlRoute()
  expect(ownedFailures(withCoverage({
    ...coverage,
    actions: coverage.actions.filter((entry) => entry !== decisive),
  })).some(({ code, source }) => code === 'coverage-missing' && source?.file === decisive.site.file)).toBe(true)
})

test('wrong shared-state components and an unknown command route fail audit', () => {
  const wrongLoading = cloneCoverage()
  const loadingIndex = wrongLoading.states.findIndex((entry) => entry.state === 'loading')
  expect(loadingIndex).toBeGreaterThanOrEqual(0)
  const loading = wrongLoading.states[loadingIndex]!
  loading.render = { ...loading.render, component: 'InlineError' } as CoverageFile['states'][number]['render']
  expect(ownedFailures(withCoverage(wrongLoading)).some(({ code }) => code === 'render-not-accepted')).toBe(true)

  const wrongError = cloneCoverage()
  const errorIndex = wrongError.states.findIndex((entry) => entry.state === 'error' && entry.render.component === 'InlineError')
  expect(errorIndex).toBeGreaterThanOrEqual(0)
  const error = wrongError.states[errorIndex]!
  error.render = { ...error.render, component: 'EmptyState' } as CoverageFile['states'][number]['render']
  expect(ownedFailures(withCoverage(wrongError)).some(({ code }) => code === 'render-not-accepted')).toBe(true)

  const unknownCommand = cloneCoverage()
  const controlIndex = unknownCommand.actions.findIndex((entry) =>
    'route' in entry && entry.route.target === UI_CONTROL_COMMAND)
  expect(controlIndex).toBeGreaterThanOrEqual(0)
  const action = unknownCommand.actions[controlIndex]!
  if (!('route' in action)) throw new Error('Control action must have a public route')
  action.route = { ...action.route, target: 'command:quirky.worktree/not-declared' }
  expect(ownedFailures(withCoverage(unknownCommand)).some(({ code }) => code === 'route-target-changed')).toBe(true)
})
