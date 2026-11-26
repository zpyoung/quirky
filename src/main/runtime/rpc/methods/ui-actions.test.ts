import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTION_CATALOG } from '../../../../shared/keybindings/action-catalog'
import type { UiStateSnapshot } from '../../../../shared/public-rpc/ui-state'
import type { RpcContext } from '../core'
import { getDestructivePreviewer } from '../destructive-previewers'
import { PublicRpcError } from '../public-rpc-error'
import { setRuntimeDesktopSurface } from '../../runtime-desktop-surface'

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { sender: unknown }, reply: unknown) => void>()
}))

import { UI_ACTION_METHODS, previewUiRunAction } from './ui-actions'

const NO_UI_NEXT = [
  { command: 'quirky status', why: 'this host has no window; UI commands need the desktop app' }
]
const NOT_APPLICABLE_NEXT = [
  { command: 'quirky action list --available', why: 'shows which actions apply right now' }
]
const TIMEOUT_NEXT = [{ command: 'quirky ui state', why: 'check the window is responsive' }]
const INVALID_ARGUMENT_NEXT = [{ command: 'quirky action list', why: 'lists valid action ids' }]

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
  hostId?: string
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
    resolveRuntimeFileTarget: vi.fn(async () => ({ executionHostId: 'local' as const })),
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

beforeEach(() => {
  mocks.listeners.clear()
  setRuntimeDesktopSurface({
    showNotification: () => false,
    findWindowById: () => null,
    onIpc: (channel, listener) => {
      mocks.listeners.set(channel, listener as (event: { sender: unknown }, reply: unknown) => void)
    },
    removeIpcListener: (channel, listener) => {
      if (mocks.listeners.get(channel) === listener) {
        mocks.listeners.delete(channel)
      }
    }
  })
})
afterEach(() => {
  vi.useRealTimers()
  setRuntimeDesktopSurface(null)
})

describe('ui.* methods without a window', () => {
  it.each([
    ['ui.state', null],
    ['ui.listActions', {}],
    ['ui.runAction', { actionId: 'view.tasks' }]
  ])('%s fails with unavailable/no_ui when the app is headless', async (name, params) => {
    const runtime = makeRuntime(null)

    const error = await call(name, params, runtime).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(PublicRpcError)
    expect(error).toMatchObject({ code: 'unavailable', reason: 'no_ui', next: NO_UI_NEXT })
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

  it('sends the host that owns the workspace so the renderer picks the same checkout', async () => {
    const win = makeWindow(() => ({ claimed: true }))
    const runtime = makeRuntime(win)
    runtime.resolveRuntimeFileTarget.mockResolvedValue({
      executionHostId: 'ssh:other-host' as never
    })

    await call('ui.runAction', { actionId: 'workspace.delete', workspace: 'feature' }, runtime)

    expect(runtime.resolveRuntimeFileTarget).toHaveBeenCalledWith('feature')
    expect(win.webContents.send).toHaveBeenCalledWith(
      'ui:requestAction',
      expect.objectContaining({ worktreeId: 'resolved:feature', hostId: 'ssh:other-host' })
    )
  })

  it('omits the host when main cannot settle one, leaving the renderer to decline an ambiguous id', async () => {
    const win = makeWindow(() => ({ claimed: true }))
    const runtime = makeRuntime(win)
    runtime.resolveRuntimeFileTarget.mockRejectedValue(
      new Error('worktree_execution_host_unresolved')
    )

    await call('ui.runAction', { actionId: 'workspace.delete', workspace: 'feature' }, runtime)

    const sent = win.webContents.send.mock.calls[0]?.[1] as SentRequest
    expect(sent.worktreeId).toBe('resolved:feature')
    expect('hostId' in sent).toBe(false)
  })

  it('surfaces the renderer reason as the message of unavailable/not_applicable', async () => {
    const win = makeWindow(() => ({
      claimed: false,
      reason: 'no focused tab in workspace resolved:feature'
    }))
    const runtime = makeRuntime(win)

    const error = await call(
      'ui.runAction',
      { actionId: 'tab.close', workspace: 'feature' },
      runtime
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(PublicRpcError)
    expect(error).toMatchObject({
      code: 'unavailable',
      reason: 'not_applicable',
      message: 'no focused tab in workspace resolved:feature',
      next: NOT_APPLICABLE_NEXT
    })
  })

  it('refuses a ui-only action without asking the renderer, naming the typed command', async () => {
    const win = makeWindow(() => ({ claimed: true }))
    const runtime = makeRuntime(win)

    await expect(call('ui.runAction', { actionId: 'editor.find' }, runtime)).rejects.toMatchObject({
      code: 'unavailable',
      reason: 'not_applicable',
      message: ACTION_CATALOG['editor.find'].uiOnlyReason,
      next: NOT_APPLICABLE_NEXT
    })
    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('rejects an unknown action id', async () => {
    const runtime = makeRuntime(makeWindow(() => ({ claimed: true })))

    const error = await call('ui.runAction', { actionId: 'nope.nothing' }, runtime).catch(
      (caught: unknown) => caught
    )

    expect(error).toBeInstanceOf(PublicRpcError)
    expect(error).toMatchObject({
      code: 'invalid_argument',
      reason: 'invalid_argument',
      next: INVALID_ARGUMENT_NEXT
    })
  })

  it('requires an explicit workspace for workspace.delete', async () => {
    const win = makeWindow(() => ({ claimed: true }))

    await expect(
      call('ui.runAction', { actionId: 'workspace.delete' }, makeRuntime(win))
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      reason: 'invalid_argument',
      next: INVALID_ARGUMENT_NEXT
    })
    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('fails with timeout/renderer_timeout after 10 seconds without a reply and stops listening', async () => {
    vi.useFakeTimers()
    const runtime = makeRuntime(makeWindow(null))

    const outcome = expect(
      call('ui.runAction', { actionId: 'view.tasks' }, runtime)
    ).rejects.toMatchObject({
      code: 'timeout',
      reason: 'renderer_timeout',
      next: TIMEOUT_NEXT
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
      code: 'timeout',
      reason: 'renderer_timeout'
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
