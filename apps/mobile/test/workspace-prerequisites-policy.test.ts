import { expect, test } from 'bun:test'
import { matchesWorkspaceFilters } from '../src/pages/workspace-filters'
import { DEFAULT_WORKSPACE_PREFERENCES } from '../src/pages/storage'
import { validatePageRpc } from '../src/shell/bridge-policy'
import { assertMobileCallAllowed } from '../../../plugins/quirky.mobile/src/daemon/authorization'

const workspace = { id: 'wt_fixture', isMain: false, createdBy: 'api' as const, branch: 'feature' }
const filters = { ...DEFAULT_WORKSPACE_PREFERENCES.filters, hideAutomationCreated: true, hideOtherClient: true, hideSleeping: true }

test('Hide sleeping filters only parked Worktree records, not stopped-session recovery', () => {
  expect(matchesWorkspaceFilters(workspace, filters, { worktreeId: workspace.id, automation: null, otherClient: null })).toBe(true)
  expect(matchesWorkspaceFilters({ ...workspace, sleeping: false }, filters, undefined)).toBe(true)
  expect(matchesWorkspaceFilters({ ...workspace, sleeping: true }, filters, undefined)).toBe(false)
  expect(matchesWorkspaceFilters(workspace, filters, { worktreeId: workspace.id, automation: true, otherClient: null })).toBe(false)
  expect(matchesWorkspaceFilters(workspace, filters, { worktreeId: workspace.id, automation: false, otherClient: true })).toBe(false)
  expect(matchesWorkspaceFilters(workspace, filters, { worktreeId: workspace.id, automation: false, otherClient: false })).toBe(true)
})

test('default-branch exception overrides parked visibility but not explicit hide-default', () => {
  const main = { ...workspace, isMain: true, sleeping: true }
  expect(matchesWorkspaceFilters(main, { ...filters, exceptDefaultBranch: true }, undefined)).toBe(true)
  expect(matchesWorkspaceFilters(main, { ...filters, exceptDefaultBranch: true, hideDefaultBranch: true }, undefined)).toBe(false)
})

test('canonical worktree parking is a base-route mutation with an exact selector only', () => {
  const grants = ['rpc', 'terminal'] as const
  const workspaceRoute = { kind: 'workspaces' } as const
  const panelRoute = { kind: 'files', worktreeId: workspace.id } as const
  for (const method of ['quirky.worktree/sleep', 'quirky.worktree/wake']) {
    expect(() => validatePageRpc(method, { worktree: '' }, grants, workspaceRoute)).toThrow()
    expect(() => validatePageRpc(method, { worktree: workspace.id, withDescendants: true }, grants, workspaceRoute)).toThrow()
    expect(() => assertMobileCallAllowed(method, { worktree: workspace.id, withDescendants: true })).toThrow()
  }
  expect(() => validatePageRpc('quirky.worktree/sleep', { worktree: workspace.id }, grants, panelRoute)).toThrow()
})

test('both phone policy layers reject identity spoofing and oversized UTF8 Markdown mutations', () => {
  const grants = ['rpc', 'terminal'] as const
  const route = { kind: 'session', worktreeId: workspace.id } as const
  const call = { worktree: 'wt_fixture', tabId: 'tab_fixture', text: 'é'.repeat(32769), expectedRevision: 1 }
  expect(() => validatePageRpc('quirky.mobile/markdownWrite', call, grants, route)).toThrow()
  expect(() => assertMobileCallAllowed('quirky.mobile/markdownWrite', call)).toThrow()
  for (const identity of ['deviceId', 'caller', 'clientId', 'role']) {
    expect(() => validatePageRpc('quirky.worktree/origins', { [identity]: 'forged' }, grants, route)).toThrow()
    expect(() => assertMobileCallAllowed('quirky.worktree/origins', { [identity]: 'forged' })).toThrow()
  }
  expect(() => validatePageRpc('quirky.mobile/markdownWrite', { ...call, text: 'safe', expectedRevision: -1 }, grants, route)).toThrow()
  expect(() => assertMobileCallAllowed('quirky.mobile/sessionTabAction', { worktree: 'wt', tabId: 'tab', action: 'eval', name: 'evil' })).toThrow()
})

test('non-session pages cannot start a Browser lease or mutate a Markdown tab', () => {
  const grants = ['rpc', 'terminal'] as const
  const route = { kind: 'workspaces' } as const
  expect(() => validatePageRpc('quirky.mobile/browserWatchStart', { worktree: workspace.id, tabId: 'tab_fixture' }, grants, route)).toThrow()
  expect(() => validatePageRpc('quirky.mobile/markdownWrite', { worktree: workspace.id, tabId: 'tab_fixture', text: 'safe', expectedRevision: 0 }, grants, route)).toThrow()
})
