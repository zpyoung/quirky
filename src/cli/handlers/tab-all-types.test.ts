import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandHandler, HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime/client'
import { BROWSER_TAB_HANDLERS } from './browser-tab'
import { TAB_ALL_TYPES_HANDLERS, withNonBrowserTabTypes } from './tab-all-types'

const PUBLIC_OPTIONS = { publicContract: true, confirm: false, caller: undefined }

const WORKTREE_FLAG = 'id:repo::/work'

const TERMINAL_TAB = { type: 'terminal', id: 't1', title: 'zsh', isActive: true, isPinned: true }
const MARKDOWN_TAB = { type: 'markdown', id: 'm1', title: 'README', isActive: false }
const FILE_TAB = { type: 'file', id: 'f1', title: 'index.ts', isActive: true }
const BROWSER_TAB = { type: 'browser', id: 'b1', title: 'docs', isActive: false }
const CHAT_TAB = { type: 'agent-session', id: 'c1', title: 'chat', isActive: false }

const SNAPSHOT_A = {
  worktree: 'wt-a',
  activeTabId: 't1',
  tabGroups: [{ id: 'g1', activeTabId: 't1', tabOrder: ['t1', 'm1'] }],
  tabs: [TERMINAL_TAB, MARKDOWN_TAB]
}

const SNAPSHOT_B = {
  worktree: 'wt-b',
  activeTabId: 'f1',
  tabGroups: [{ id: 'g2', activeTabId: 'f1', tabOrder: ['f1', 'b1', 'c1'] }],
  tabs: [FILE_TAB, BROWSER_TAB, CHAT_TAB]
}

function envelope(result: unknown) {
  return { id: 'req-1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

type FakeClient = { call: ReturnType<typeof vi.fn>; isRemote: boolean }

function fakeClient(snapshots: unknown[] = [SNAPSHOT_A, SNAPSHOT_B]): FakeClient {
  const call = vi.fn(async (method: string) => {
    switch (method) {
      case 'session.tabs.listAll':
        return envelope({ snapshots })
      case 'session.tabs.list':
        return envelope(SNAPSHOT_A)
      case 'browser.tabList':
        return envelope({ tabs: [] })
      default:
        return envelope({})
    }
  })
  return { call, isRemote: false }
}

function contextFor(
  client: FakeClient,
  flags: Record<string, string | boolean>,
  json = true
): HandlerContext {
  // SAFETY: the handlers under test touch only call and isRemote on the client
  const asClient = client as unknown as RuntimeClient
  return { flags: new Map(Object.entries(flags)), cwd: '/', json, client: asClient }
}

function handler(table: Record<string, CommandHandler>, key: string): CommandHandler {
  const found = table[key]
  if (!found) {
    throw new Error(`no handler for ${key}`)
  }
  return found
}

describe('tab commands across tab types', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    for (const key of [
      'QUIRKY_CALLER_ROLE',
      'QUIRKY_AGENT_SESSION_ID',
      'QUIRKY_WORKTREE_ID',
      'QUIRKY_TERMINAL_HANDLE'
    ]) {
      vi.stubEnv(key, '')
    }
  })

  afterEach(() => {
    logSpy.mockRestore()
    vi.unstubAllEnvs()
  })

  function printedTabIds(): string[] {
    const tabs: { id: string }[] = JSON.parse(String(logSpy.mock.calls[0][0])).result.tabs
    return tabs.map((tab) => tab.id)
  }

  describe('without a non-browser --type', () => {
    it('runs the browser path unchanged when --type is absent', async () => {
      const client = fakeClient()
      await handler(BROWSER_TAB_HANDLERS, 'tab list')(contextFor(client, { worktree: 'all' }))
      expect(client.call.mock.calls).toEqual([['browser.tabList', { worktree: undefined }]])
    })

    it('runs the browser path unchanged for --type browser', async () => {
      const client = fakeClient()
      await handler(
        BROWSER_TAB_HANDLERS,
        'tab list'
      )(contextFor(client, { type: 'browser', worktree: 'all' }))
      expect(client.call.mock.calls).toEqual([['browser.tabList', { worktree: undefined }]])
    })

    it('leaves handlers it does not route untouched', () => {
      const exec: CommandHandler = async () => {}
      const wrapped = withNonBrowserTabTypes({ exec })
      expect(wrapped.exec).toBe(exec)
    })
  })

  describe('with --type', () => {
    it('--type all lists every tab through session.tabs.listAll', async () => {
      const client = fakeClient()
      await handler(BROWSER_TAB_HANDLERS, 'tab list')(contextFor(client, { type: 'all' }))
      expect(client.call.mock.calls).toEqual([['session.tabs.listAll', undefined, PUBLIC_OPTIONS]])
      expect(printedTabIds()).toEqual(['t1', 'm1', 'f1', 'b1', 'c1'])
    })

    it.each([
      ['terminal', ['t1']],
      ['markdown', ['m1']],
      ['editor', ['f1']],
      ['chat', ['c1']]
    ])('--type %s keeps only that type', async (type, ids) => {
      const client = fakeClient()
      await handler(BROWSER_TAB_HANDLERS, 'tab list')(contextFor(client, { type }))
      expect(printedTabIds()).toEqual(ids)
    })

    it('reports each tab with its group, pin state and workspace', async () => {
      const client = fakeClient()
      await handler(BROWSER_TAB_HANDLERS, 'tab list')(contextFor(client, { type: 'terminal' }))
      const [row] = JSON.parse(String(logSpy.mock.calls[0][0])).result.tabs
      expect(row).toEqual({
        id: 't1',
        type: 'terminal',
        title: 'zsh',
        active: true,
        pinned: true,
        worktree: 'wt-a',
        groupId: 'g1'
      })
    })

    it('lists one workspace through session.tabs.list when --worktree names it', async () => {
      const client = fakeClient()
      await handler(
        BROWSER_TAB_HANDLERS,
        'tab list'
      )(contextFor(client, { type: 'all', worktree: WORKTREE_FLAG }))
      expect(client.call.mock.calls).toEqual([['session.tabs.list', { worktree: WORKTREE_FLAG }]])
      expect(printedTabIds()).toEqual(['t1', 'm1'])
    })

    it('rejects an unknown --type before calling the runtime', async () => {
      const client = fakeClient()
      await expect(
        handler(BROWSER_TAB_HANDLERS, 'tab list')(contextFor(client, { type: 'window' }))
      ).rejects.toMatchObject({ code: 'invalid_argument' })
      expect(client.call).not.toHaveBeenCalled()
    })

    it('tab show finds a tab of the requested type', async () => {
      const client = fakeClient()
      await handler(
        BROWSER_TAB_HANDLERS,
        'tab show'
      )(contextFor(client, { type: 'terminal', page: 't1' }))
      expect(JSON.parse(String(logSpy.mock.calls[0][0])).result.tab).toMatchObject({
        id: 't1',
        type: 'terminal'
      })
    })

    it('tab show does not match a tab of another type', async () => {
      const client = fakeClient()
      await expect(
        handler(
          BROWSER_TAB_HANDLERS,
          'tab show'
        )(contextFor(client, { type: 'markdown', page: 't1' }))
      ).rejects.toMatchObject({ code: 'not_found' })
    })

    it('tab current prints the active tab of the named workspace', async () => {
      const client = fakeClient()
      await handler(
        BROWSER_TAB_HANDLERS,
        'tab current'
      )(contextFor(client, { type: 'all', worktree: WORKTREE_FLAG }))
      expect(JSON.parse(String(logSpy.mock.calls[0][0])).result.tab).toMatchObject({ id: 't1' })
    })

    it('tab switch activates the tab in the workspace that holds it', async () => {
      const client = fakeClient()
      await handler(
        BROWSER_TAB_HANDLERS,
        'tab switch'
      )(contextFor(client, { type: 'editor', page: 'f1' }))
      expect(client.call).toHaveBeenLastCalledWith(
        'session.tabs.activate',
        { worktree: 'wt-b', tabId: 'f1' },
        PUBLIC_OPTIONS
      )
    })

    it('tab switch --index counts tabs of that type in one workspace', async () => {
      const client = fakeClient()
      await handler(
        BROWSER_TAB_HANDLERS,
        'tab switch'
      )(contextFor(client, { type: 'markdown', index: '0', worktree: WORKTREE_FLAG }))
      expect(client.call).toHaveBeenLastCalledWith(
        'session.tabs.activate',
        { worktree: WORKTREE_FLAG, tabId: 'm1' },
        PUBLIC_OPTIONS
      )
    })

    it('tab switch needs --index or --page', async () => {
      const client = fakeClient()
      await expect(
        handler(BROWSER_TAB_HANDLERS, 'tab switch')(contextFor(client, { type: 'terminal' }))
      ).rejects.toMatchObject({ code: 'invalid_argument' })
    })

    it('tab close closes with user intent so the runtime does not refuse it', async () => {
      const client = fakeClient()
      await handler(
        BROWSER_TAB_HANDLERS,
        'tab close'
      )(contextFor(client, { type: 'terminal', page: 't1' }))
      expect(client.call).toHaveBeenLastCalledWith(
        'session.tabs.close',
        { worktree: 'wt-a', tabId: 't1', reason: 'user' },
        PUBLIC_OPTIONS
      )
    })

    it('tab create explains that only browser tabs are created', async () => {
      const client = fakeClient()
      await expect(
        handler(BROWSER_TAB_HANDLERS, 'tab create')(contextFor(client, { type: 'terminal' }))
      ).rejects.toMatchObject({ code: 'invalid_argument' })
      expect(client.call).not.toHaveBeenCalled()
    })

    it('refuses an id that is open in more than one workspace without --worktree', async () => {
      const twin = { ...SNAPSHOT_B, tabs: [{ ...TERMINAL_TAB }] }
      const client = fakeClient([SNAPSHOT_A, twin])
      await expect(
        handler(BROWSER_TAB_HANDLERS, 'tab switch')(contextFor(client, { type: 'all', page: 't1' }))
      ).rejects.toMatchObject({ code: 'conflict' })
    })
  })

  describe('new verbs', () => {
    it('tab focus activates by id, searching every type', async () => {
      const client = fakeClient()
      await handler(TAB_ALL_TYPES_HANDLERS, 'tab focus')(contextFor(client, { id: 'c1' }))
      expect(client.call.mock.calls).toEqual([
        ['session.tabs.listAll', undefined, PUBLIC_OPTIONS],
        ['session.tabs.activate', { worktree: 'wt-b', tabId: 'c1' }, PUBLIC_OPTIONS]
      ])
    })

    it('tab focus skips the lookup when --worktree is given', async () => {
      const client = fakeClient()
      await handler(
        TAB_ALL_TYPES_HANDLERS,
        'tab focus'
      )(contextFor(client, { id: 'c1', worktree: WORKTREE_FLAG }))
      expect(client.call.mock.calls).toEqual([
        ['session.tabs.activate', { worktree: WORKTREE_FLAG, tabId: 'c1' }, PUBLIC_OPTIONS]
      ])
    })

    it('tab focus fails with not_found for an unknown id', async () => {
      const client = fakeClient()
      await expect(
        handler(TAB_ALL_TYPES_HANDLERS, 'tab focus')(contextFor(client, { id: 'nope' }))
      ).rejects.toMatchObject({ code: 'not_found' })
    })

    it('tab move sends a move-to-group request with the optional index', async () => {
      const client = fakeClient()
      await handler(
        TAB_ALL_TYPES_HANDLERS,
        'tab move'
      )(contextFor(client, { id: 't1', 'to-group': 'g2', index: '1' }))
      expect(client.call).toHaveBeenLastCalledWith(
        'session.tabs.move',
        { worktree: 'wt-a', tabId: 't1', targetGroupId: 'g2', kind: 'move-to-group', index: 1 },
        PUBLIC_OPTIONS
      )
    })

    it('tab move leaves the index out when --index is absent', async () => {
      const client = fakeClient()
      await handler(
        TAB_ALL_TYPES_HANDLERS,
        'tab move'
      )(contextFor(client, { id: 't1', 'to-group': 'g2' }))
      expect(client.call).toHaveBeenLastCalledWith(
        'session.tabs.move',
        { worktree: 'wt-a', tabId: 't1', targetGroupId: 'g2', kind: 'move-to-group' },
        PUBLIC_OPTIONS
      )
    })

    it('tab move needs --to-group', async () => {
      const client = fakeClient()
      await expect(
        handler(TAB_ALL_TYPES_HANDLERS, 'tab move')(contextFor(client, { id: 't1' }))
      ).rejects.toMatchObject({ code: 'invalid_argument' })
    })

    it.each([
      ['tab pin', true],
      ['tab unpin', false]
    ])('%s sets isPinned=%s through session.tabs.setTabProps', async (command, isPinned) => {
      const client = fakeClient()
      await handler(TAB_ALL_TYPES_HANDLERS, command)(contextFor(client, { id: 'm1' }))
      expect(client.call).toHaveBeenLastCalledWith(
        'session.tabs.setTabProps',
        { worktree: 'wt-a', tabId: 'm1', isPinned },
        PUBLIC_OPTIONS
      )
    })

    it('tab pin --type checks the tab is of that type', async () => {
      const client = fakeClient()
      await expect(
        handler(
          TAB_ALL_TYPES_HANDLERS,
          'tab pin'
        )(contextFor(client, { id: 'm1', type: 'terminal' }))
      ).rejects.toMatchObject({ code: 'not_found' })
      expect(client.call).not.toHaveBeenCalledWith(
        'session.tabs.setTabProps',
        expect.anything(),
        expect.anything()
      )
    })
  })
})
