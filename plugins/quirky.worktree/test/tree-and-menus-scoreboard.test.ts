import { beforeAll, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { auditPlugin } from '../../../scripts/ui-scoreboard/audit'
import { parseCoverage } from '../../../scripts/ui-scoreboard/audit-evidence'
import { discoverUiFiles } from '../../../scripts/ui-scoreboard/audit-discovery'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import type { CoverageFile, Evidence, Inventory, PluginInventory } from '../../../scripts/ui-scoreboard/contracts'

const FRAGMENT = 'plugins/quirky.worktree/ui-scoreboard/tree-and-menus.json'
const WORKTREE_SURFACE = 'sidebar-section:quirky.worktree/worktrees'
const UI_CONTROL = 'command:quirky.worktree/uiControl'
const TREE = 'plugins/quirky.worktree/src/Tree.tsx'
const MENU = 'plugins/quirky.worktree/src/Menu.tsx'
const BOARD = 'plugins/quirky.worktree/src/WorktreeBoard.tsx'
const OWNED_FILES: Record<string, true> = {
  'plugins/quirky.worktree/src/Tree.tsx': true,
  'plugins/quirky.worktree/src/Menu.tsx': true,
  'plugins/quirky.worktree/src/WorktreeBoard.tsx': true,
  'plugins/quirky.worktree/src/ExternalInbox.tsx': true,
  'plugins/quirky.worktree/src/Notices.tsx': true,
  'plugins/quirky.worktree/src/OrchestrationRows.tsx': true,
  'plugins/quirky.worktree/src/useSidebarActivity.ts': true,
  'plugins/quirky.worktree/src/useTree.ts': true,
  'plugins/quirky.worktree/src/ui-control.ts': true,
  [FRAGMENT]: true,
}
const LATER_FILES: Record<string, true> = {
  'plugins/quirky.worktree/src/WorktreesSection.tsx': true,
  'plugins/quirky.worktree/src/FilterMenu.tsx': true,
  'plugins/quirky.worktree/src/ViewTabs.tsx': true,
  'plugins/quirky.worktree/src/DisplayMenu.tsx': true,
  'plugins/quirky.worktree/src/SaveViewDialog.tsx': true,
  'plugins/quirky.worktree/src/actions.ts': true,
  'plugins/quirky.worktree/src/GroupDialogs.tsx': true,
  'plugins/quirky.worktree/src/StatusSettingsDialog.tsx': true,
  'plugins/quirky.worktree/src/TagsPopover.tsx': true,
}
const PASS_CODES: Record<string, true> = {
  'state-covered': true,
  'state-not-applicable': true,
  'not-state': true,
  'action-routed': true,
  'action-transient': true,
  'action-not-user': true,
}
const EXPECTED_CLI_ROUTES = [
  'quirky ui run command:quirky.worktree/uiControl',
  'quirky worktree navigate',
  'quirky automations navigate',
  'quirky worktree set',
  'quirky repo group collapse',
  'quirky worktree project-set',
  'quirky worktree delete-branch',
  'quirky orchestration task-terminal',
  'quirky ui open-view view:quirky.session/worktree',
]
let inventory: Inventory
let plugin: PluginInventory
let coverage: CoverageFile

beforeAll(() => {
  inventory = collectInventory(resolve(import.meta.dir, '../../..'))
  expect(inventory.failures).toEqual([])
  plugin = inventory.plugins.find((entry) => entry.id === 'quirky.worktree')!
  expect(plugin).toBeDefined()
  const fragment = plugin.coverageFragments?.find((entry) => entry.file === FRAGMENT)
  expect(fragment).toBeDefined()
  coverage = parseCoverage(fragment!.content)
})

function withCoverage(value: CoverageFile): PluginInventory {
  return {
    ...plugin,
    coverageFragments: plugin.coverageFragments!.map((fragment) => fragment.file === FRAGMENT
      ? { ...fragment, content: JSON.stringify(value) }
      : fragment),
  }
}

function withSource(subject: PluginInventory, file: string, replace: (content: string) => string): PluginInventory {
  return {
    ...subject,
    sources: subject.sources.map((source) => source.file === file
      ? { ...source, content: replace(source.content) }
      : source),
  }
}

function evidence(subject = plugin, sourceInventory = inventory): Evidence[] {
  return auditPlugin(sourceInventory, subject).flatMap(({ evidence: entries }) => entries)
}

function failures(subject = plugin, sourceInventory = inventory): Evidence[] {
  return evidence(subject, sourceInventory).filter(({ code }) => PASS_CODES[code] !== true)
}

function firstReplace(source: string, before: string, after: string): string {
  const at = source.indexOf(before)
  if (at < 0 || source.indexOf(before, at + before.length) >= 0) throw new Error(`Expected one source occurrence: ${before}`)
  return `${source.slice(0, at)}${after}${source.slice(at + before.length)}`
}

test('the fragment covers only the already-declared worktree surface and owned candidates', () => {
  expect(coverage.schemaVersion).toBe(1)
  expect(coverage.surfaces).toEqual({})
  for (const entry of [...coverage.states, ...coverage.notState, ...coverage.actions]) {
    expect(OWNED_FILES[entry.site.file]).toBe(true)
  }
})

test('Menu and WorktreeBoard callback producers are explicitly forwarded', () => {
  const menuActions = coverage.actions.filter((entry) => entry.site.file === MENU)
  expect(menuActions).toHaveLength(32)
  expect(menuActions.every((entry) => 'notAction' in entry && entry.notAction === 'forwarded')).toBe(true)

  const boardActions = coverage.actions.filter((entry) => entry.site.file === BOARD)
  expect(boardActions.map((entry) => entry.anchor).sort()).toEqual(['onChange', 'onClick'])
  expect(boardActions.every((entry) => 'notAction' in entry && entry.notAction === 'forwarded')).toBe(true)
  expect(coverage.notState.some((entry) => entry.site.file === BOARD && entry.anchor === 'candidate.icon ?')).toBe(true)
})

test('Tree automation availability distinguishes positive metadata from missing sources', () => {
  const treeForwards = coverage.actions.filter((entry) =>
    entry.site.file === TREE && 'notAction' in entry && entry.notAction === 'forwarded')
  expect(treeForwards.some((entry) => entry.anchor === 'onToggleAutomationDetails')).toBe(true)
  expect(coverage.actions.some((entry) =>
    entry.site.file === TREE && entry.anchor === 'onToggleFold' && 'route' in entry && entry.route.target === UI_CONTROL)).toBe(true)

  for (const anchor of [
    "definitionStatus === 'available' &&",
    "runHistoryStatus === 'available' &&",
  ]) {
    expect(coverage.notState.some((entry) => entry.site.file === TREE && entry.anchor === anchor)).toBe(true)
  }
  for (const anchor of [
    "definitionStatus === 'missing' &&",
    "runHistoryStatus === 'missing' &&",
    "(definitionStatus === 'unavailable' || runHistoryStatus === 'unavailable') &&",
  ]) {
    expect(coverage.states.some((entry) =>
      entry.site.file === TREE && entry.state === 'error' && entry.anchor === anchor && entry.render.component === 'NoticeLine')).toBe(true)
    expect(coverage.notState.some((entry) => entry.site.file === TREE && entry.anchor === anchor)).toBe(false)
  }
  expect(coverage.notState.some((entry) => entry.site.file === TREE && entry.anchor === 'role=\"status\"')).toBe(true)
  expect(coverage.notState.some((entry) =>
    entry.site.file === 'plugins/quirky.worktree/src/Notices.tsx' && entry.anchor === 'role=\"status\"')).toBe(true)

  for (const [file, anchor] of [
    ['plugins/quirky.worktree/src/ExternalInbox.tsx', 'if (projects.length === 0)'],
    ['plugins/quirky.worktree/src/Notices.tsx', 'if (kept.length === 0)'],
    ['plugins/quirky.worktree/src/OrchestrationRows.tsx', 'if (groups.length === 0)'],
  ] as const) {
    expect(coverage.notState.some((entry) => entry.site.file === file && entry.anchor === anchor)).toBe(true)
  }
})

test('auxiliary actions retain parent forwarding and their real public routes', () => {
  const noticeActions = coverage.actions.filter((entry) => entry.site.file === 'plugins/quirky.worktree/src/Notices.tsx')
  expect(noticeActions.filter((entry) => 'notAction' in entry && entry.notAction === 'forwarded')).toHaveLength(2)
  expect(noticeActions.filter((entry) => 'route' in entry).map((entry) => 'route' in entry ? entry.route.target : ''))
    .toEqual(['quirky.worktree/deleteBranch'])

  const inboxTargets = coverage.actions
    .filter((entry) => entry.site.file === 'plugins/quirky.worktree/src/ExternalInbox.tsx' && 'route' in entry)
    .map((entry) => 'route' in entry ? entry.route.target : '')
    .sort()
  expect(inboxTargets).toEqual([
    'quirky.worktree/setProjectMetadata',
    'quirky.worktree/setProjectMetadata',
    'quirky.worktree/suppressExternalInbox',
  ])

  const orchestrationTargets = coverage.actions
    .filter((entry) => entry.site.file === 'plugins/quirky.worktree/src/OrchestrationRows.tsx' && 'route' in entry)
    .map((entry) => 'route' in entry ? entry.route.target : '')
  expect(orchestrationTargets).toEqual(expect.arrayContaining([
    'quirky.orchestration/taskTerminal',
    'view:quirky.session/worktree',
  ]))
})

test('all owned toast errors remain visible error-state evidence on the worktree surface', () => {
  const toastErrors = coverage.states.filter((entry) => entry.state === 'error' && entry.render.component === 'toast')
  expect(toastErrors).toHaveLength(13)
  expect(toastErrors.every((entry) => entry.surface === WORKTREE_SURFACE)).toBe(true)
  for (const [file, count] of [
    ['plugins/quirky.worktree/src/Tree.tsx', 7],
    ['plugins/quirky.worktree/src/ExternalInbox.tsx', 2],
    ['plugins/quirky.worktree/src/OrchestrationRows.tsx', 3],
    ['plugins/quirky.worktree/src/useSidebarActivity.ts', 1],
  ] as const) {
    expect(toastErrors.filter((entry) => entry.site.file === file)).toHaveLength(count)
  }
})


test('the full plugin graph passes every structural, state and route witness check', () => {
  const files = discoverUiFiles(plugin).files
  expect(files.length).toBeGreaterThanOrEqual(55)
  const fullEvidence = evidence()
  const issues = fullEvidence
    .filter(({ code }) => PASS_CODES[code] !== true)
    .filter(({ code, source }) => !(code === 'coverage-missing' && source !== undefined && LATER_FILES[source.file] === true))
  expect(issues.filter(({ source, coverageFile, targetId }) =>
    OWNED_FILES[source?.file ?? ''] === true || coverageFile === FRAGMENT || targetId !== undefined)).toEqual([])
  expect(issues).toEqual([])

  const routedCli = fullEvidence.filter(({ code }) => code === 'action-routed').map(({ cli }) => cli)
  expect(routedCli).toEqual(expect.arrayContaining(EXPECTED_CLI_ROUTES))
})

test('removing the automation InlineError evidence exposes its Tree candidate', () => {
  const index = coverage.states.findIndex((entry) =>
    entry.site.file === TREE && entry.state === 'error' && entry.render.component === 'InlineError')
  expect(index).toBeGreaterThanOrEqual(0)
  const mutant = withCoverage({ ...coverage, states: coverage.states.filter((_, at) => at !== index) })
  expect(failures(mutant).some(({ code, source }) => code === 'coverage-missing' && source?.file === TREE)).toBe(true)
})

test('replacing automation checking NoticeLine with a raw paragraph is rejected', () => {
  const entry = coverage.states.find((candidate) =>
    candidate.site.file === TREE && candidate.state === 'loading' && candidate.render.component === 'NoticeLine' &&
    candidate.render.element.quote.includes('Checking automation availability'))
  if (!entry || entry.render.component === 'toast') throw new Error('Missing automation checking render evidence')
  const original = entry.render.element.quote
  const rawElement = original.replace('<NoticeLine>', '<p className="ui-text-muted">').replace('</NoticeLine>', '</p>')
  expect(rawElement).not.toBe(original)
  const rawCoverage = {
    ...coverage,
    states: coverage.states.map((candidate) => {
      if (candidate !== entry || candidate.render.component === 'toast') return candidate
      const siteQuote = candidate.site.quote.includes(original)
        ? candidate.site.quote.replace(original, rawElement)
        : candidate.site.quote
      return {
        ...candidate,
        site: { ...candidate.site, quote: siteQuote },
        render: { ...candidate.render, element: { ...candidate.render.element, quote: rawElement } },
      }
    }),
  }
  const mutated = withSource(withCoverage(rawCoverage), TREE, (content) => firstReplace(content, original, rawElement))
  expect(failures(mutated).some(({ code, source: at }) => code === 'render-element-invalid' && at?.file === TREE)).toBe(true)
})

test('undeclaring the UI control command invalidates its real route witness', () => {
  const subject = plugin
  const commandInventory: Inventory = {
    ...inventory,
    plugins: inventory.plugins.map((candidate) => candidate.id === 'quirky.worktree'
      ? {
          ...candidate,
          contributions: {
            ...candidate.contributions!,
            commands: candidate.contributions!.commands.filter((command) => command !== UI_CONTROL),
          },
        }
      : candidate),
  }
  expect(subject.sources.some(({ file, content }) => file.endsWith('/ui-control.ts') && content.includes(`'${UI_CONTROL}'`))).toBe(true)
  expect(failures(subject, commandInventory).some(({ code, source }) =>
    code === 'route-undeclared' && source?.file.endsWith('/ui-control.ts'))).toBe(true)
})

test('renaming a scoped route target disagrees with its command witness', () => {
  const index = coverage.actions.findIndex((entry) => 'route' in entry && entry.route.target === UI_CONTROL)
  expect(index).toBeGreaterThanOrEqual(0)
  const entry = coverage.actions[index]!
  if (!('route' in entry)) throw new Error('Missing scoped command route')
  const actions = [...coverage.actions]
  actions[index] = { ...entry, route: { ...entry.route, target: `${UI_CONTROL}-wrong` } }
  expect(failures(withCoverage({ ...coverage, actions })).some(({ code, source }) =>
    code === 'route-target-changed' && source?.file.endsWith('/ui-control.ts'))).toBe(true)
})

test('removing the WorktreeBoard status-change forwarding entry exposes its candidate', () => {
  const mutant = withCoverage({
    ...coverage,
    actions: coverage.actions.filter((entry) => !(entry.site.file === BOARD && entry.anchor === 'onChange')),
  })
  expect(failures(mutant).some(({ code, source }) => code === 'coverage-missing' && source?.file === BOARD)).toBe(true)
})
