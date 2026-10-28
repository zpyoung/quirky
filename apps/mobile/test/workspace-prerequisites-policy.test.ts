import { expect, test } from 'bun:test'
import { matchesWorkspaceFilters } from '../src/pages/workspace-filters'
import { DEFAULT_WORKSPACE_PREFERENCES } from '../src/pages/storage'
import { validatePageRpc } from '../src/shell/bridge-policy'
import { assertMobileCallAllowed } from '../../../plugins/quirky.mobile/src/daemon/authorization'

const workspace = { id: 'wt_fixture', isMain: false, createdBy: 'api' as const, branch: 'feature' }
const filters = { ...DEFAULT_WORKSPACE_PREFERENCES.filters, hideAutomationCreated: true, hideOtherClient: true, hideSleeping: true }

test('unknown API origins and partial sleep are visible; only proven predicates hide rows', () => {
  expect(matchesWorkspaceFilters(workspace, filters, { worktreeId: workspace.id, automation: null, otherClient: null }, 'partial')).toBe(true)
  expect(matchesWorkspaceFilters(workspace, filters, { worktreeId: workspace.id, automation: false, otherClient: false }, 'awake')).toBe(true)
  expect(matchesWorkspaceFilters(workspace, filters, { worktreeId: workspace.id, automation: true, otherClient: null }, 'awake')).toBe(false)
  expect(matchesWorkspaceFilters(workspace, filters, { worktreeId: workspace.id, automation: false, otherClient: true }, 'awake')).toBe(false)
  expect(matchesWorkspaceFilters(workspace, filters, undefined, 'asleep')).toBe(false)
})

test('default-branch exception overrides provenance and sleeping but not explicit hide-default', () => {
  const main = { ...workspace, isMain: true }
  expect(matchesWorkspaceFilters(main, { ...filters, exceptDefaultBranch: true }, undefined, 'asleep')).toBe(true)
  expect(matchesWorkspaceFilters(main, { ...filters, exceptDefaultBranch: true, hideDefaultBranch: true }, undefined, 'asleep')).toBe(false)
})

test('both phone policy layers reject identity spoofing and oversized UTF8 Markdown mutations', () => {
  const grants = ['rpc', 'terminal'] as const
  const call = { worktree: 'wt_fixture', tabId: 'tab_fixture', text: 'é'.repeat(32769), expectedRevision: 1 }
  expect(() => validatePageRpc('quirky.mobile/markdownWrite', call, grants)).toThrow()
  expect(() => assertMobileCallAllowed('quirky.mobile/markdownWrite', call)).toThrow()
  for (const identity of ['deviceId', 'caller', 'clientId', 'role']) {
    expect(() => validatePageRpc('quirky.worktree/origins', { [identity]: 'forged' }, grants)).toThrow()
    expect(() => assertMobileCallAllowed('quirky.worktree/origins', { [identity]: 'forged' })).toThrow()
  }
  expect(() => validatePageRpc('quirky.mobile/markdownWrite', { ...call, text: 'safe', expectedRevision: -1 }, grants)).toThrow()
  expect(() => assertMobileCallAllowed('quirky.mobile/sessionTabAction', { worktree: 'wt', tabId: 'tab', action: 'eval', name: 'evil' })).toThrow()
})
