import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { QuirkyClient, Session, Worktree } from '@quirky/protocol'
import { createFakeGit, useTestGit } from '../../../packages/git/src/testing'
import { builtinsDir, makeHomeWithoutAutoHooks, startHarness, waitForAsync, type Harness } from '../../../packages/daemon/test/helpers'
import { groupsInOrder } from '../src/layout/tree'
import { isTerminalTab } from '../src/layout/types'
import type { Tab, TerminalTab, ViewTab, Workspace } from '../src/layout/types'
import { call, restartDaemon } from './support'

const EDITOR_VIEW = 'view:quirky.editor/document'
const EDITOR_CLOSE_COMMAND = 'command:quirky.editor/close'
const EDITOR_CAN_CLOSE = 'quirky.editor/canClose'

type EditorBuffer = {
  id: string
  name: string
  contentRevision: number
  tabId: string | null
  preview: boolean
  dirty: boolean
  draft: string | null
}

type EditorState = { buffers: EditorBuffer[]; tabs: { tabId: string; bufferId: string; mode: 'edit' | 'preview'; group?: string }[] }
type ViewOpenResult = { workspace: Workspace; tab: string }
type OpenViewParams = {
  key: string
  title: string
  input?: Record<string, unknown>
  group?: string
  replace?: string
  reuse?: boolean
  activate?: boolean
  preview?: boolean
}

const tabsOf = (workspace: Workspace): Tab[] => groupsInOrder(workspace.root).flatMap((group) => group.tabs)
const isView = (tab: Tab): tab is ViewTab => 'kind' in tab && tab.kind === 'view'
const viewOf = (workspace: Workspace, tabId: string): ViewTab => {
  const tab = tabsOf(workspace).find((candidate) => candidate.id === tabId)
  if (!tab || !isView(tab)) throw new Error(`expected view tab ${tabId}`)
  return tab
}
const findView = (workspace: Workspace, bufferId: string, mode?: 'edit' | 'preview'): ViewTab => {
  const tab = tabsOf(workspace).find((candidate) => isView(candidate) && candidate.input?.bufferId === bufferId && (mode === undefined || (candidate.input?.mode ?? 'edit') === mode))
  if (!tab || !isView(tab)) throw new Error(`expected view tab for buffer ${bufferId}`)
  return tab
}
const terminalTabs = (workspace: Workspace): TerminalTab[] => tabsOf(workspace).filter(isTerminalTab)
const groupsOf = (workspace: Workspace) => groupsInOrder(workspace.root)

let harness: Harness
let client: QuirkyClient
let scratch: string
let repo: string
let worktree: Worktree
let worktreeSelector: string

beforeEach(async () => {
  scratch = mkdtempSync('/tmp/qt-view-tabs-')
  repo = join(scratch, 'repo')
  mkdirSync(repo, { recursive: true })
  for (const name of ['a.md', 'b.md', 'c.md']) writeFileSync(join(repo, name), `# ${name}\n`)
  const git = createFakeGit()
  git.addRepo(repo)
  useTestGit(git)
  harness = await startHarness({ home: makeHomeWithoutAutoHooks('qt-view-tabs-'), builtinPluginsDir: builtinsDir() })
  client = await harness.connect('cli')
  await call(client, 'quirky.repo/add', { path: repo })
  const worktrees = await call<Worktree[]>(client, 'quirky.worktree/list', {})
  worktree = worktrees.find((entry) => entry.isMain)!
  worktreeSelector = `id:${worktree.id}`
})

afterEach(async () => {
  useTestGit(null)
  await harness?.cleanup()
  rmSync(scratch, { recursive: true, force: true })
})

const terminal = <T = any>(method: string, params: Record<string, unknown> = {}, c = client) => call<T>(c, `quirky.terminal/${method}`, params)
const editor = <T = any>(method: string, params: Record<string, unknown> = {}, c = client) => call<T>(c, `quirky.editor/${method}`, params)
const layoutOf = (c = client) => terminal<{ workspace: Workspace }>('workspace', { workspace: worktreeSelector }, c).then((result) => result.workspace)
const errorOf = async (promise: Promise<unknown>) => (await promise.then(() => null, (error: unknown) => error)) as (Error & { code?: number }) | null
const openBuffer = (path: string, options: { preview?: boolean; mode?: 'source' | 'rich' | 'preview' } = {}) =>
  editor<EditorBuffer>('open', { worktree: worktreeSelector, path, focus: false, ...options })
const draftBuffer = (buffer: EditorBuffer, content = '# dirty\n') =>
  editor<EditorBuffer>('draft', { bufferId: buffer.id, content, expectedRevision: buffer.contentRevision })
const sessionList = (c = client) => call<Session[]>(c, 'quirky.session/list', {})

async function openView(params: OpenViewParams): Promise<ViewOpenResult> {
  return terminal<ViewOpenResult>('openViewTab', {
    workspace: worktreeSelector,
    viewId: EDITOR_VIEW,
    input: { bufferId: params.key },
    reuse: true,
    ...params
  })
}

async function workspaceTabForBuffer(buffer: EditorBuffer): Promise<ViewTab> {
  return findView(await layoutOf(), buffer.id)
}

describe('hosted editor view tabs', () => {
  test('keeps view tabs session-free beside legacy terminal rows through restart and session reconciliation', async () => {
    const initial = (await terminal<{ workspace: Workspace }>('workspace', { workspace: worktreeSelector, ensure: true })).workspace
    const legacyTerminal = terminalTabs(initial)[0]!
    const terminalSession = 'root' in legacyTerminal ? legacyTerminal.root.kind === 'pane' ? legacyTerminal.root.session : '' : ''
    expect(terminalSession).not.toBe('')
    expect('kind' in legacyTerminal).toBe(false)

    const buffer = await openBuffer('a.md', { preview: true })
    const before = await layoutOf()
    const view = findView(before, buffer.id)
    expect(view).toMatchObject({
      kind: 'view',
      viewId: EDITOR_VIEW,
      key: buffer.id,
      input: { bufferId: buffer.id },
      closeCommand: EDITOR_CLOSE_COMMAND,
      closeMethod: EDITOR_CAN_CLOSE,
      closeParams: { bufferId: buffer.id },
      preview: true
    })
    expect('root' in view).toBe(false)
    expect('activePane' in view).toBe(false)
    expect((await sessionList()).map((session) => session.id)).toEqual([terminalSession])

    const reopened = await restartDaemon(harness, { builtinPluginsDir: builtinsDir() })
    try {
      const persisted = await layoutOf(reopened.client)
      expect(tabsOf(persisted).find((tab) => tab.id === legacyTerminal.id)).toEqual(legacyTerminal)
      expect(viewOf(persisted, view.id)).toEqual(view)
      expect((await sessionList(reopened.client)).map((session) => session.id)).toEqual([terminalSession])

      await call(reopened.client, 'quirky.session/close', { session: terminalSession })
      const reconciled = await waitForAsync(async () => {
        const current = await layoutOf(reopened.client)
        return tabsOf(current).some((tab) => tab.id === view.id) ? current : null
      })
      expect(terminalTabs(reconciled)).toEqual([])
      expect(viewOf(reconciled, view.id)).toEqual(view)
      expect(await sessionList(reopened.client)).toEqual([])
    } finally {
      await reopened.stop()
    }
  })

  test('reuses identity, replaces only an explicit preview, rekeys, moves, pins, colours and activates views', async () => {
    const terminalWorkspace = (await terminal<{ workspace: Workspace }>('newTab', { workspace: worktreeSelector })).workspace
    const group = groupsOf(terminalWorkspace)[0]!
    const firstBuffer = await openBuffer('a.md', { preview: true })
    let workspace = await layoutOf()
    const first = findView(workspace, firstBuffer.id)

    const reused = await openView({ key: firstBuffer.id, title: firstBuffer.name, input: { bufferId: firstBuffer.id }, group: group.id, preview: true })
    expect(reused.tab).toBe(first.id)
    expect(tabsOf(reused.workspace).filter((tab) => isView(tab) && tab.viewId === EDITOR_VIEW && tab.key === firstBuffer.id)).toHaveLength(1)

    const replacement = await openView({
      key: 'browse-b',
      title: 'b.md',
      input: { bufferId: 'b-buffer' },
      group: group.id,
      replace: first.id,
      preview: true
    })
    expect(replacement.tab).toBe(first.id)
    expect(viewOf(replacement.workspace, replacement.tab)).toMatchObject({ key: 'browse-b', title: 'b.md', input: { bufferId: 'b-buffer' }, preview: true })

    const second = await openView({ key: 'edit-c', title: 'c.md', input: { bufferId: 'c-buffer' }, group: group.id })
    workspace = (await terminal<{ workspace: Workspace }>('rekeyViewTabs', {
      workspace: worktreeSelector,
      viewId: EDITOR_VIEW,
      revision: second.workspace.revision,
      changes: [{ tab: second.tab, key: 'renamed-c', input: { bufferId: 'c-buffer', mode: 'source' }, title: 'c-renamed.md', preview: false }]
    })).workspace
    expect(viewOf(workspace, second.tab)).toMatchObject({ key: 'renamed-c', title: 'c-renamed.md', input: { bufferId: 'c-buffer', mode: 'source' }, preview: false })

    workspace = (await terminal<{ workspace: Workspace }>('moveTab', { tab: first.id, split: 'right', of: group.id })).workspace
    expect(groupsOf(workspace)).toHaveLength(2)
    workspace = (await terminal<{ workspace: Workspace }>('pinTab', { tab: first.id, pinned: true })).workspace
    workspace = (await terminal<{ workspace: Workspace }>('setTabColor', { tab: first.id, color: 'teal' })).workspace
    workspace = (await terminal<{ workspace: Workspace }>('activateTab', { tab: first.id })).workspace
    expect(viewOf(workspace, first.id)).toMatchObject({ pinned: true, color: 'teal' })
    expect(workspace.activeGroup).toBe(groupsOf(workspace).find((entry) => entry.tabs.some((tab) => tab.id === first.id))!.id)

    const invalidPaneOperation = await errorOf(terminal('equalize', { tab: first.id }))
    expect(invalidPaneOperation).not.toBeNull()
    expect(await layoutOf()).toEqual(workspace)

    const closed = (await terminal<{ workspace: Workspace }>('closeTab', { tab: first.id, yes: true })).workspace
    expect(tabsOf(closed).some((tab) => tab.id === first.id)).toBe(false)
    expect(closed.closed).toEqual(workspace.closed)
    expect(await editor<EditorState>('state', { worktree: worktreeSelector })).toMatchObject({ buffers: [expect.objectContaining({ id: firstBuffer.id })] })
  })

  test('validates effective view and close contributions through public declarations', async () => {
    const contributions = await call<{ id: string; kind: string }[]>(client, 'plugin.contributions', {})
    expect(contributions.some((entry) => entry.kind === 'view' && entry.id === EDITOR_VIEW)).toBe(true)
    expect(contributions.some((entry) => entry.kind === 'command' && entry.id === EDITOR_CLOSE_COMMAND)).toBe(true)
    expect(contributions.some((entry) => entry.kind === 'method' && entry.id === `method:${EDITOR_CAN_CLOSE}`)).toBe(true)

    const unknownView = await errorOf(terminal('openViewTab', { workspace: worktreeSelector, viewId: 'view:quirky.editor/missing', key: 'x', title: 'x' }))
    expect(unknownView).not.toBeNull()
    const unknownMethod = await errorOf(terminal('openViewTab', { workspace: worktreeSelector, viewId: EDITOR_VIEW, key: 'x', title: 'x', closeMethod: 'quirky.editor/missing' }))
    expect(unknownMethod).not.toBeNull()
    const unknownCommand = await errorOf(terminal('openViewTab', { workspace: worktreeSelector, viewId: EDITOR_VIEW, key: 'x', title: 'x', closeCommand: 'command:quirky.editor/missing' }))
    expect(unknownCommand).not.toBeNull()
    expect(tabsOf(await layoutOf())).toEqual([])
  })

  test('dirty editor views refuse close, bulk close, preview replacement and group removal atomically', async () => {
    const terminalWorkspace = (await terminal<{ workspace: Workspace }>('newTab', { workspace: worktreeSelector })).workspace
    const anchor = terminalTabs(terminalWorkspace)[0]!
    const anchorGroup = groupsOf(terminalWorkspace)[0]!

    const first = await openBuffer('a.md')
    await draftBuffer(first)
    const firstView = await workspaceTabForBuffer(first)
    const beforeSingleClose = await layoutOf()
    expect(await errorOf(terminal('closeTab', { tab: firstView.id, yes: true }))).not.toBeNull()
    expect(await layoutOf()).toEqual(beforeSingleClose)
    expect((await editor<EditorState>('state', { bufferId: first.id, worktree: worktreeSelector })).buffers[0]?.dirty).toBe(true)

    const second = await openBuffer('b.md')
    await draftBuffer(second)
    const secondView = await workspaceTabForBuffer(second)
    const beforeBulkClose = await layoutOf()
    expect(await errorOf(terminal('closeTabs', { tab: anchor.id, which: 'right', yes: true }))).not.toBeNull()
    expect(await layoutOf()).toEqual(beforeBulkClose)
    expect(tabsOf(await layoutOf()).some((tab) => tab.id === secondView.id)).toBe(true)

    const third = await openBuffer('c.md')
    await draftBuffer(third)
    const thirdView = await workspaceTabForBuffer(third)
    let workspace = await layoutOf()
    await terminal('moveTab', { tab: thirdView.id, split: 'right', of: anchorGroup.id })
    workspace = await layoutOf()
    const dirtyGroup = groupsOf(workspace).find((group) => group.tabs.some((tab) => tab.id === thirdView.id))!
    const beforeGroupClose = workspace
    expect(await errorOf(terminal('closeGroup', { group: dirtyGroup.id }))).not.toBeNull()
    expect(await layoutOf()).toEqual(beforeGroupClose)

    await terminal('rekeyViewTabs', {
      workspace: worktreeSelector,
      viewId: EDITOR_VIEW,
      changes: [{ tab: firstView.id, key: firstView.key, input: firstView.input as Record<string, unknown>, preview: true }]
    })
    workspace = await layoutOf()
    const beforeReplacement = workspace
    expect(await errorOf(openView({ key: 'replacement', title: 'replacement.md', input: { bufferId: 'replacement-buffer' }, replace: firstView.id, preview: true }))).not.toBeNull()
    expect(await layoutOf()).toEqual(beforeReplacement)
    expect(viewOf(await layoutOf(), firstView.id)).toMatchObject({ key: firstView.key, preview: true })
  })

  test('closing a shared Markdown preview does not close its edit tab or discard its dirty buffer', async () => {
    const edit = await openBuffer('a.md')
    await draftBuffer(edit)
    const preview = await openBuffer('a.md', { mode: 'preview' })
    expect(preview.id).toBe(edit.id)
    const workspace = await layoutOf()
    const previewTab = findView(workspace, edit.id, 'preview')
    const editTab = findView(workspace, edit.id, 'edit')
    expect(previewTab.key).toBe(`preview:${edit.id}`)

    const closed = (await terminal<{ workspace: Workspace }>('closeTab', { tab: previewTab.id, yes: true })).workspace
    expect(tabsOf(closed).some((tab) => tab.id === previewTab.id)).toBe(false)
    expect(tabsOf(closed).some((tab) => tab.id === editTab.id)).toBe(true)
    const state = await editor<EditorState>('state', { bufferId: edit.id, worktree: worktreeSelector })
    expect(state.buffers).toMatchObject([expect.objectContaining({ id: edit.id, dirty: true, draft: '# dirty\n' })])
  })
})
