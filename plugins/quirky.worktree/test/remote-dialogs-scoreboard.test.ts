import { beforeAll, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { auditPlugin } from '../../../scripts/ui-scoreboard/audit'
import { parseCoverage } from '../../../scripts/ui-scoreboard/audit-evidence'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import type { CoverageFile, Evidence, Inventory, PluginInventory } from '../../../scripts/ui-scoreboard/contracts'

const FRAGMENT = 'plugins/quirky.worktree/ui-scoreboard/remote-and-dialogs.json'
const SURFACES = [
  'sidebar-section:quirky.worktree/remote-workspaces',
  'sidebar-section:quirky.worktree/worktrees',
  'view:quirky.worktree/environments',
  'view:quirky.worktree/remote',
]
const OWNED_FILES: Record<string, true> = {
  'plugins/quirky.worktree/src/ui.tsx': true,
  'plugins/quirky.worktree/src/ui-control.ts': true,
  'plugins/quirky.worktree/src/RemoteWorkspace.tsx': true,
  'plugins/quirky.worktree/src/RemoteWorkspacesSection.tsx': true,
  'plugins/quirky.worktree/src/VmEnvironments.tsx': true,
  'plugins/quirky.worktree/src/VmRecipeSelector.tsx': true,
  'plugins/quirky.worktree/src/CleanupDialog.tsx': true,
  'plugins/quirky.worktree/src/DeleteDialog.tsx': true,
  'plugins/quirky.worktree/src/RemoveProjectDialog.tsx': true,
  'plugins/quirky.worktree/src/TrustDialog.tsx': true,
  'plugins/quirky.worktree/src/UpdateDialog.tsx': true,
  'plugins/quirky.worktree/src/BaseFallbackDialog.tsx': true,
  'plugins/quirky.worktree/src/ParentDialog.tsx': true,
}
const LATER_FILES: Record<string, true> = {
  'plugins/quirky.worktree/src/CreateDialog.tsx': true,
  'plugins/quirky.worktree/src/AddProjectDialog.tsx': true,
  'plugins/quirky.worktree/src/ProjectSettingsDialog.tsx': true,
  'plugins/quirky.worktree/src/Tree.tsx': true,
  'plugins/quirky.worktree/src/Menu.tsx': true,
  'plugins/quirky.worktree/src/OrchestrationRows.tsx': true,
  'plugins/quirky.worktree/src/ExternalInbox.tsx': true,
  'plugins/quirky.worktree/src/Notices.tsx': true,
  'plugins/quirky.worktree/src/WorktreeBoard.tsx': true,
  'plugins/quirky.worktree/src/useSidebarActivity.ts': true,
  'plugins/quirky.worktree/src/useTree.ts': true,
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
const EXPECTED_STATE_COMPONENTS = [
  ['view:quirky.worktree/remote', 'loading', 'NoticeLine'],
  ['view:quirky.worktree/remote', 'empty', 'EmptyState'],
  ['view:quirky.worktree/remote', 'error', 'InlineError'],
  ['view:quirky.worktree/environments', 'loading', 'NoticeLine'],
  ['view:quirky.worktree/environments', 'empty', 'EmptyState'],
  ['view:quirky.worktree/environments', 'error', 'InlineError'],
  ['sidebar-section:quirky.worktree/remote-workspaces', 'loading', 'NoticeLine'],
  ['sidebar-section:quirky.worktree/remote-workspaces', 'empty', 'EmptyState'],
  ['sidebar-section:quirky.worktree/remote-workspaces', 'error', 'InlineError'],
  ['sidebar-section:quirky.worktree/worktrees', 'loading', 'NoticeLine'],
  ['sidebar-section:quirky.worktree/worktrees', 'empty', 'EmptyState'],
  ['sidebar-section:quirky.worktree/worktrees', 'error', 'InlineError'],
  ['sidebar-section:quirky.worktree/worktrees', 'error', 'toast'],
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

function evidence(subject = plugin): Evidence[] {
  return auditPlugin(inventory, subject).flatMap(({ evidence: entries }) => entries)
}

function failures(subject = plugin): Evidence[] {
  return evidence(subject).filter(({ code }) => PASS_CODES[code] !== true)
}

test('the fragment declares exactly the four owned surfaces with all states applicable', () => {
  expect(coverage.schemaVersion).toBe(1)
  expect(Object.keys(coverage.surfaces).sort()).toEqual([...SURFACES].sort())
  for (const surface of SURFACES) {
    expect(coverage.surfaces[surface]).toEqual({
      loading: { applicable: true },
      empty: { applicable: true },
      error: { applicable: true },
    })
  }
  for (const entry of [...coverage.states, ...coverage.notState, ...coverage.actions]) {
    expect(OWNED_FILES[entry.site.file]).toBe(true)
  }
})

test('each applicable state is backed by its required shared component evidence', () => {
  const covered = evidence().filter(({ code }) => code === 'state-covered')
  const actual = covered.map(({ targetId, component }) => `${targetId}\0${component}`)
  for (const [target, , component] of EXPECTED_STATE_COMPONENTS) {
    expect(actual).toContain(`${target}\0${component}`)
  }
  for (const [target, state, component] of EXPECTED_STATE_COMPONENTS) {
    expect(coverage.states.some((entry) => entry.surface === target && entry.state === state && entry.render.component === component)).toBe(true)
  }
})

test('the owned slice is covered and all remaining failures belong to later-slice files', () => {
  const issues = failures()
  expect(issues.filter(({ source, coverageFile, targetId }) =>
    OWNED_FILES[source?.file ?? ''] === true || coverageFile === FRAGMENT || targetId !== undefined)).toEqual([])
  expect(issues.every(({ source }) => source !== undefined && LATER_FILES[source.file] === true)).toBe(true)

  const routedCli = evidence()
    .filter(({ code }) => code === 'action-routed')
    .map(({ cli }) => cli)
  expect(routedCli).toEqual(expect.arrayContaining([
    'quirky ui run command:quirky.worktree/uiControl',
    'quirky worktree vm-suspend',
    'quirky worktree vm-resume',
    'quirky worktree vm-destroy',
    'quirky worktree vm-list',
    'quirky worktree cleanup-preview',
    'quirky ledger request',
    'quirky worktree set',
    'quirky repo rm',
    'quirky ui open-view view:quirky.worktree/environments',
  ]))
})

test('removing the first state or action entry exposes its owned candidate', () => {
  const firstState = coverage.states[0]!
  expect(firstState).toBeDefined()
  const withoutFirstState = withCoverage({ ...coverage, states: coverage.states.slice(1) })
  expect(failures(withoutFirstState).some(({ source }) => source?.file === firstState.site.file)).toBe(true)

  const firstAction = coverage.actions[0]!
  expect(firstAction).toBeDefined()
  const withoutFirstAction = withCoverage({ ...coverage, actions: coverage.actions.slice(1) })
  expect(failures(withoutFirstAction).some(({ source }) => source?.file === firstAction.site.file)).toBe(true)
})
