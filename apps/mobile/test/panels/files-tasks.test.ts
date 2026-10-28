import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import {
  classifyWorkspaceResult,
  MOBILE_EDITOR_DRAFT_LIMIT,
  MOBILE_EDITOR_INLINE_DRAFT_LIMIT,
  MOBILE_EDITOR_TRANSFER_CHUNK_LIMIT,
  draftChunkLength,
  draftWriteMode,
  replaceTaskFilter,
  safeExplorerPath,
  sortExplorerEntries
} from '../../src/panels/files-tasks/model'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PanelBridge } from '../../src/panels/contracts'
import { FilesTasksPanel } from '../../src/panels/files-tasks'

type BridgeCall = { method: string; params: Record<string, unknown> }
let root: Root | null = null
let container: HTMLDivElement | null = null
const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = reactGlobal.IS_REACT_ACT_ENVIRONMENT
beforeAll(() => {
  GlobalRegistrator.register()
  reactGlobal.IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  container?.remove()
  container = null
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
  if (previousActEnvironment === undefined) delete reactGlobal.IS_REACT_ACT_ENVIRONMENT
  else reactGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

function mobileTasksBridge(workspaceReplies: unknown[]) {
  const calls: BridgeCall[] = []
  const navigations: unknown[] = []
  const waiters = new Map<string, (() => void)[]>()
  const repo = { id: 'repo-mobile', name: 'mobile-app', path: '/repos/mobile-app', worktree: 'wt-mobile' }
  const issue = {
    kind: 'issue', number: 22, title: 'Mobile trust fixture', body: 'Fixture body', state: 'open',
    url: 'https://github.com/mobile-owner/mobile-app/issues/22', worktree: 'wt-mobile',
    repoId: repo.id, repoName: repo.name, labels: [], assignees: [], author: 'mobile-fixture'
  }
  const bridge = {
    init: { host: { name: 'Consent fixture desktop' } },
    state: { phase: 'connected', attempts: 0 },
    onState: () => () => {},
    onEvent: () => () => {},
    onStream: () => () => {},
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      let response: unknown = {}
      if (method === 'quirky.tasks/state') response = { navigation: { mode: 'issues', repoIds: null, query: 'is:open', page: 1 }, preferences: { defaultTaskSource: 'github', visibleTaskProviders: ['github'] } }
      else if (method === 'quirky.tasks/repositories') response = [repo]
      else if (method === 'quirky.tasks/list') response = { items: [issue], repositories: [repo], failures: [], page: 1, totalPages: 1 }
      else if (method === 'quirky.tasks/issue') response = { item: issue, comments: [], partialFailures: [], viewerCanUpdate: true, truncated: false }
      else if (method === 'quirky.tasks/workspace') {
        const next = workspaceReplies.shift()
        if (next === undefined) throw new Error('unexpected mobile workspace submission')
        response = next
      } else if (method === 'quirky.mobile/agentCatalog') response = { defaultAgent: 'codex', agents: [{ id: 'codex', label: 'Codex', installed: true, enabled: true, isDefault: true }] }
      const queued = waiters.get(method)
      queued?.shift()?.()
      return response
    },
    storage: { get: async () => null, set: async () => {}, remove: async () => {} },
    native: { clipboardRead: async () => '', clipboardWrite: async () => {}, openExternal: async () => {}, haptic: async () => {} },
    navigate: async (route: unknown) => { navigations.push(route) },
    report: () => {},
    close: () => {}
  } as unknown as PanelBridge
  return {
    bridge,
    calls,
    navigations,
    waitFor(method: string): Promise<void> {
      const deferred = Promise.withResolvers<void>()
      const queued = waiters.get(method) ?? []
      queued.push(deferred.resolve)
      waiters.set(method, queued)
      return deferred.promise
    }
  }
}

async function mountTasksPanel(bridge: PanelBridge): Promise<void> {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => { root!.render(createElement(FilesTasksPanel, { bridge, route: { kind: 'tasks' } })) })
}

function mobileButton(label: string): HTMLButtonElement {
  const found = [...(container?.querySelectorAll('button') ?? [])].find((button) => button.textContent?.trim() === label)
  if (!(found instanceof HTMLButtonElement)) throw new Error(`No mobile Tasks button named ${label}`)
  return found
}
function mobileButtonContaining(text: string): HTMLButtonElement {
  const found = [...(container?.querySelectorAll('button') ?? [])].find((button) => button.textContent?.includes(text))
  if (!(found instanceof HTMLButtonElement)) throw new Error(`No mobile Tasks button contains ${text}`)
  return found
}

async function clickMobileButton(label: string): Promise<void> {
  const button = mobileButton(label)
  await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve() })
}

async function selectMobileLabel(labelText: string, value: string): Promise<void> {
  const label = [...(container?.querySelectorAll('label') ?? [])].find((candidate) => candidate.textContent?.includes(labelText))
  const select = label?.querySelector('select')
  if (!(select instanceof HTMLSelectElement)) throw new Error(`No mobile select named ${labelText}`)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

test('explorer accepts only entries contained by the returned worktree root and sorts folders first', () => {
  const root = '/work/repo'
  expect(safeExplorerPath({ path: '/work/repo/src/index.ts', name: 'index.ts', isDirectory: false }, root)).toBe('src/index.ts')
  expect(safeExplorerPath({ path: '/work/repo-link/secret', name: 'secret', isDirectory: false }, root)).toBeNull()
  expect(safeExplorerPath({ path: '/work/repo/leak', name: 'leak', isDirectory: false, isSymlink: true, error: 'This link points outside the worktree.' }, root)).toBeNull()
  expect(safeExplorerPath({ path: '../secret', name: 'secret', isDirectory: false }, root)).toBeNull()

  expect(sortExplorerEntries([
    { path: 'z.ts', name: 'z.ts', isDirectory: false },
    { path: 'docs', name: 'docs', isDirectory: true },
    { path: 'a', name: 'a', isDirectory: true }
  ]).map(({ name }) => name)).toEqual(['a', 'docs', 'z.ts'])
})

test('task filter updates replace only their own qualifiers and retain search/repository context', () => {
  const query = 'is:issue is:open assignee:old repo:acme/app "bad parser"'
  const closed = replaceTaskFilter(query, 'status', 'closed')
  expect(closed).toBe('is:issue assignee:old repo:acme/app "bad parser" is:closed')
  expect(replaceTaskFilter(closed, 'assignee', '@me')).toBe('is:issue repo:acme/app "bad parser" is:closed assignee:@me')
  expect(replaceTaskFilter('is:pr review-requested:alice review:approved repo:acme/app', 'review', 'needs-review'))
    .toBe('is:pr repo:acme/app review-requested:@me')
})


test('workspace composer is not success until the plugin confirms a created worktree', () => {
  expect(classifyWorkspaceResult({ kind: 'composer', requestId: 'req-1', name: 'fix-parser' }))
    .toMatchObject({ kind: 'composer', requestId: 'req-1' })
  expect(classifyWorkspaceResult({ kind: 'created', worktree: { id: 'wt-1', name: 'fix-parser' } }))
    .toMatchObject({ kind: 'created', worktreeId: 'wt-1', name: 'fix-parser' })
  expect(classifyWorkspaceResult({ kind: 'resumed', worktree: { id: 'existing-wt', name: 'linked-task' } }))
    .toMatchObject({ kind: 'resumed', worktreeId: 'existing-wt', name: 'linked-task' })
  expect(classifyWorkspaceResult({ kind: 'created', worktree: {} }).kind).toBe('invalid')
})
test('file drafts switch to bounded transfers beyond the safe direct-write size', () => {
  const inlineLimit = MOBILE_EDITOR_INLINE_DRAFT_LIMIT
  const totalBytes = MOBILE_EDITOR_DRAFT_LIMIT
  expect(draftWriteMode(inlineLimit)).toBe('inline')
  expect(draftWriteMode(inlineLimit + 1)).toBe('transfer')
  expect(draftWriteMode(totalBytes)).toBe('transfer')
  expect(() => draftWriteMode(totalBytes + 1)).toThrow('1 MiB')

  let offset = 0
  while (offset < totalBytes) {
    const length = draftChunkLength(totalBytes, offset, MOBILE_EDITOR_TRANSFER_CHUNK_LIMIT)
    expect(length).toBeGreaterThan(0)
    expect(length).toBeLessThanOrEqual(MOBILE_EDITOR_TRANSFER_CHUNK_LIMIT)
    offset += length
  }
  expect(offset).toBe(totalBytes)
  expect(draftChunkLength(totalBytes, totalBytes, MOBILE_EDITOR_TRANSFER_CHUNK_LIMIT)).toBe(0)
})
test('mobile composer keeps setup and issue-command consent independent and forwards both displayed pins', async () => {
  const target = { worktree: 'wt-mobile', kind: 'issue', number: 22, url: 'https://github.com/mobile-owner/mobile-app/issues/22' }
  const baseRequest = {
    kind: 'composer',
    requestId: 'mobile-composer-1',
    target,
    repoId: 'repo-mobile',
    repoName: 'mobile-app',
    name: 'mobile-issue-22',
    title: 'Mobile trust fixture',
    prompt: 'Fix the mobile fixture.',
    setup: 'run',
    issueCommand: 'run',
    agent: 'codex'
  }
  const setupHash = 'a'.repeat(64)
  const issueHash = 'b'.repeat(64)
  const setupChallenge = {
    ...baseRequest,
    trustKind: 'setup',
    trustScript: 'printf setup-ran > setup-marker.txt',
    trustHash: setupHash,
    error: 'Setup approval required.'
  }
  const issueChallenge = {
    ...baseRequest,
    agent: '',
    trustKind: 'issue',
    trustScript: 'printf issue-ran > issue-marker.txt',
    trustHash: issueHash,
    trustSetupHash: setupHash,
    error: 'Issue command approval required.'
  }
  const created = { kind: 'created', target, worktree: { id: 'wt-mobile-created', name: 'mobile-issue-22' } }
  const fixture = mobileTasksBridge([baseRequest, setupChallenge, issueChallenge, created])
  const listLoaded = fixture.waitFor('quirky.tasks/list')
  await mountTasksPanel(fixture.bridge)
  await act(async () => { await listLoaded })

  const issueDetails = fixture.waitFor('quirky.tasks/issue')
  await clickMobileButtonContaining('Mobile trust fixture')
  await act(async () => { await issueDetails })
  const initialWorkspace = fixture.waitFor('quirky.tasks/workspace')
  const agentCatalog = fixture.waitFor('quirky.mobile/agentCatalog')
  await clickMobileButton('Create Workspace In')
  await act(async () => { await initialWorkspace; await agentCatalog })
  await selectMobileLabel('Agent (optional)', '')

  const firstSubmit = fixture.waitFor('quirky.tasks/workspace')
  await clickMobileButton('Create workspace')
  await act(async () => { await firstSubmit })
  expect(container?.textContent).toContain('Setup script needs approval')
  expect(container?.textContent).toContain(setupHash)
  expect(container?.textContent).toContain('Run setup once')

  const setupApproval = fixture.waitFor('quirky.tasks/workspace')
  await clickMobileButton('Run setup once')
  await act(async () => { await setupApproval })
  expect(container?.textContent).toContain('Issue command needs approval')
  expect(container?.textContent).toContain(issueHash)
  expect(container?.textContent).toContain('Skip issue command')
  expect(container?.textContent).not.toContain('Run setup once')

  const issueSkip = fixture.waitFor('quirky.tasks/workspace')
  await clickMobileButton('Skip issue command')
  await act(async () => { await issueSkip })

  const workspaceCalls = fixture.calls.filter((call) => call.method === 'quirky.tasks/workspace')
  expect(workspaceCalls).toHaveLength(4)
  expect(workspaceCalls[1]?.params).toMatchObject({ setup: 'run', issueCommand: 'run', agent: '' })
  expect(workspaceCalls[2]?.params).toMatchObject({ setup: 'run', issueCommand: 'run', trustSetup: true, trustSetupHash: setupHash, agent: '' })
  expect(workspaceCalls[3]?.params).toMatchObject({ setup: 'run', issueCommand: 'skip', trustSetup: true, trustSetupHash: setupHash, agent: '' })
  expect(workspaceCalls[3]?.params).not.toHaveProperty('trustIssueCommand')
  expect(workspaceCalls[3]?.params).not.toHaveProperty('trustIssueCommandHash')
  expect(fixture.navigations).toContainEqual({ kind: 'session', worktreeId: 'wt-mobile-created' })
})
