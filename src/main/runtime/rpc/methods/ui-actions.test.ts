import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTION_CATALOG } from '../../../../shared/keybindings/action-catalog'
import type { UiStateSnapshot } from '../../../../shared/public-rpc/ui-state'
import type { RpcContext } from '../core'
import { getDestructivePreviewer } from '../destructive-previewers'

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { sender: unknown }, reply: unknown) => void>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, listener: (event: { sender: unknown }, reply: unknown) => void) => {
      mocks.listeners.set(channel, listener)
    },
    removeListener: (channel: string, listener: unknown) => {
      if (mocks.listeners.get(channel) === listener) {
        mocks.listeners.delete(channel)
      }
    }
  }
}))

import { UI_ACTION_METHODS, previewUiRunAction } from './ui-actions'

const SNAPSHOT: UiStateSnapshot = {
  worktreeId: 'repo::/a',
  view: 'terminal',
  tab: { id: 'tab-1', type: 'terminal', title: 'zsh' },
  paneId: 'pane-1',
  panels: {
    leftSidebar: true,
    rightSidebar: { open: false, tab: null },
    floatingTerminal: false
  },
  editorFile: null
}

type SentRequest = {
  requestId: string
  actionId?: string
  worktreeId?: string
  probeOnly?: boolean
}

function replyChannelFor(channel: string): string {
  return channel === 'ui:requestAction' ? 'ui:actionReply' : 'ui:stateReply'
}

/** A window whose renderer answers each request through `answer`, or never when it is null. */
function makeWindow(answer: ((request: SentRequest) => Record<string, unknown>) | null) {
  const webContents = {
    send: vi.fn((channel: string, request: SentRequest) => {
      if (!answer) {
        return
      }
      mocks.listeners.get(replyChannelFor(channel))?.(
        { sender: webContents },
        { requestId: request.requestId, ...answer(request) }
      )
    })
  }
  return { webContents }
}

function makeRuntime(win: ReturnType<typeof makeWindow> | null) {
  return {
    getAuthoritativeWindow: vi.fn(() => {
      if (!win) {
        throw new Error('No renderer window available')
      }
      return win
    }),
    showTerminalWorkspaceLaunchScope: vi.fn(async (selector: string) => ({
      id: `resolved:${selector}`,
      path: `/work/${selector}`,
      folderWorkspace: null
    })),
    getRuntimeGitStatus: vi.fn(async () => ({ entries: [{}, {}, {}] }))
  }
}

function methodNamed(name: string) {
  const method = UI_ACTION_METHODS.find((candidate) => candidate.name === name)
  if (!method) {
    throw new Error(`missing method ${name}`)
  }
  return method
}

async function call(name: string, params: unknown, runtime: ReturnType<typeof makeRuntime>) {
  const method = methodNamed(name)
  const parsed = method.params === null ? undefined : method.params.parse(params)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers read only the runtime fields the stub above provides.
  const context = { runtime } as unknown as RpcContext
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the parsed value is the method's own params type, narrowed by name above.
  return (method.handler as (params: unknown, context: RpcContext) => unknown)(parsed, context)
}

beforeEach(() => mocks.listeners.clear())
afterEach(() => vi.useRealTimers())

describe('ui.* methods without a window', () => {
  it.each([
    ['ui.state', null],
    ['ui.listActions', {}],
    ['ui.runAction', { actionId: 'view.tasks' }]
  ])('%s fails with no_ui when the app is headless', async (name, params) => {
    const runtime = makeRuntime(null)

    await expect(call(name, params, runtime)).rejects.toMatchObject({
      message: 'no_ui',
      code: 'no_ui'
    })
  })
})

describe('ui.runAction', () => {
  it('returns claimed when the renderer runs the action, passing the resolved workspace', async () => {
    const win = makeWindow(() => ({ claimed: true }))
    const runtime = makeRuntime(win)

    await expect(
      call('ui.runAction', { actionId: 'tab.close', workspace: 'feature' }, runtime)
    ).resolves.toEqual({ claimed: true })

    expect(win.webContents.send).toHaveBeenCalledWith(
      'ui:requestAction',
      expect.objectContaining({ actionId: 'tab.close', worktreeId: 'resolved:feature' })
    )
  })

  it('passes the renderer reason through as not_applicable', async () => {
    const win = makeWindow(() => ({
      claimed: false,
      reason: 'no focused tab in workspace resolved:feature'
    }))
    const runtime = makeRuntime(win)

    await expect(
      call('ui.runAction', { actionId: 'tab.close', workspace: 'feature' }, runtime)
    ).rejects.toMatchObject({
      message: 'not_applicable',
      code: 'not_applicable',
      data: { reason: 'no focused tab in workspace resolved:feature' }
    })
  })

  it('refuses a ui-only action without asking the renderer, naming the typed command', async () => {
    const win = makeWindow(() => ({ claimed: true }))
    const runtime = makeRuntime(win)

    await expect(call('ui.runAction', { actionId: 'editor.find' }, runtime)).rejects.toMatchObject({
      message: 'not_applicable',
      data: { reason: ACTION_CATALOG['editor.find'].uiOnlyReason }
    })
    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('rejects an unknown action id', async () => {
    const runtime = makeRuntime(makeWindow(() => ({ claimed: true })))

    await expect(call('ui.runAction', { actionId: 'nope.nothing' }, runtime)).rejects.toMatchObject(
      {
        message: 'invalid_argument',
        code: 'invalid_argument'
      }
    )
  })

  it('requires an explicit workspace for workspace.delete', async () => {
    const win = makeWindow(() => ({ claimed: true }))

    await expect(
      call('ui.runAction', { actionId: 'workspace.delete' }, makeRuntime(win))
    ).rejects.toMatchObject({ message: 'invalid_argument' })
    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('fails with renderer_timeout after 10 seconds without a reply and stops listening', async () => {
    vi.useFakeTimers()
    const runtime = makeRuntime(makeWindow(null))

    const outcome = expect(
      call('ui.runAction', { actionId: 'view.tasks' }, runtime)
    ).rejects.toMatchObject({
      message: 'renderer_timeout',
      code: 'renderer_timeout'
    })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(mocks.listeners.has('ui:actionReply')).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    await outcome
    expect(mocks.listeners.has('ui:actionReply')).toBe(false)
  })

  it('ignores a reply from a different window or request id', async () => {
    vi.useFakeTimers()
    const win = makeWindow(null)
    const runtime = makeRuntime(win)

    const outcome = expect(
      call('ui.runAction', { actionId: 'view.tasks' }, runtime)
    ).rejects.toMatchObject({
      message: 'renderer_timeout'
    })
    const sent = win.webContents.send.mock.calls[0]?.[1] as SentRequest
    mocks.listeners.get('ui:actionReply')?.(
      { sender: {} },
      { requestId: sent.requestId, claimed: true }
    )
    mocks.listeners.get('ui:actionReply')?.(
      { sender: win.webContents },
      { requestId: 'other', claimed: true }
    )
    await vi.advanceTimersByTimeAsync(10_000)
    await outcome
  })
})

describe('ui.listActions', () => {
  it('probes rpc actions without running them and marks ui-only ones unavailable', async () => {
    const win = makeWindow((request) =>
      request.actionId === 'view.tasks'
        ? { claimed: true }
        : { claimed: false, reason: 'not in this view' }
    )

    const result = (await call('ui.listActions', {}, makeRuntime(win))) as {
      actions: { id: string; available: boolean; reason?: string; destructive: boolean }[]
    }

    const byId = new Map(result.actions.map((action) => [action.id, action]))
    expect(byId.get('view.tasks')).toMatchObject({ available: true, destructive: false })
    expect(byId.get('tab.close')).toMatchObject({ available: false, reason: 'not in this view' })
    expect(byId.get('editor.find')).toMatchObject({
      available: false,
      reason: ACTION_CATALOG['editor.find'].uiOnlyReason
    })
    expect(byId.get('workspace.delete')?.destructive).toBe(true)
    expect(result.actions).toHaveLength(Object.keys(ACTION_CATALOG).length)
    const probes = win.webContents.send.mock.calls.map(([, request]) => request as SentRequest)
    expect(probes.every((request) => request.probeOnly === true)).toBe(true)
  })

  it('keeps only available actions when asked', async () => {
    const win = makeWindow((request) => ({ claimed: request.actionId === 'view.ledger' }))

    const result = (await call('ui.listActions', { available: true }, makeRuntime(win))) as {
      actions: { id: string }[]
    }

    expect(result.actions.map((action) => action.id)).toEqual(['view.ledger'])
  })
})

describe('ui.state', () => {
  it('returns the renderer snapshot', async () => {
    const win = makeWindow(() => ({ state: SNAPSHOT }))

    await expect(call('ui.state', null, makeRuntime(win))).resolves.toEqual(SNAPSHOT)
    expect(win.webContents.send).toHaveBeenCalledWith(
      'ui:requestState',
      expect.objectContaining({ requestId: expect.any(String) })
    )
  })

  it('rejects a reply that is not a snapshot', async () => {
    const win = makeWindow(() => ({ state: { view: 3 } }))

    await expect(call('ui.state', null, makeRuntime(win))).rejects.toThrow()
  })
})

describe('workspace.delete preview', () => {
  it('is registered for ui.runAction', () => {
    expect(getDestructivePreviewer('ui.runAction')).toBeDefined()
  })

  it('counts uncommitted files for a git worktree', async () => {
    const runtime = makeRuntime(makeWindow(null))

    const lines = await previewUiRunAction(
      { actionId: 'workspace.delete', workspace: 'feature' },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the previewer reads only the runtime fields the stub provides.
      { runtime } as unknown as RpcContext
    )

    expect(lines).toEqual([
      'deletes the worktree at /work/feature',
      '3 uncommitted files would be lost'
    ])
    expect(runtime.getRuntimeGitStatus).toHaveBeenCalledWith('feature', { admissionTier: 'status' })
  })

  it('says a folder workspace is only removed from Quirky', async () => {
    const runtime = makeRuntime(makeWindow(null))
    runtime.showTerminalWorkspaceLaunchScope.mockResolvedValue({
      id: 'folder:docs',
      path: '/work/docs',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the previewer only checks that a folder workspace record exists.
      folderWorkspace: {} as never
    })

    const lines = await previewUiRunAction(
      { actionId: 'workspace.delete', workspace: 'docs' },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the previewer reads only the runtime fields the stub provides.
      { runtime } as unknown as RpcContext
    )

    expect(lines).toEqual(['removes folder workspace from Quirky; files stay on disk'])
    expect(runtime.getRuntimeGitStatus).not.toHaveBeenCalled()
  })

  it('has nothing to preview for a non-destructive action', async () => {
    const runtime = makeRuntime(makeWindow(null))

    await expect(
      previewUiRunAction(
        { actionId: 'view.tasks' },
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the previewer reads only the runtime fields the stub provides.
        { runtime } as unknown as RpcContext
      )
    ).resolves.toEqual([])
  })
})
