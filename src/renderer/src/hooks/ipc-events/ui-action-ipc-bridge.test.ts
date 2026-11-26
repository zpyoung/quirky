import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerAppCommandDispatcher } from '@/lib/app-command-dispatch'
import type { Tab } from '../../../../shared/tab-types'
import { createTestStore } from '../../store/slices/store-test-helpers'
import { buildUiTabsSnapshot, registerUiActionIpcBridge } from './ui-action-ipc-bridge'

function tab(id: string, worktreeId: string, contentType: Tab['contentType']): Tab {
  return {
    id,
    entityId: id,
    groupId: 'group-1',
    worktreeId,
    contentType,
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

describe('buildUiTabsSnapshot', () => {
  it('lists every workspace tabs with their public type, including workspaces with none', () => {
    const store = createTestStore()
    store.setState({
      unifiedTabsByWorktree: {
        'wt-1': [tab('t1', 'wt-1', 'terminal'), tab('b1', 'wt-1', 'browser')],
        'wt-2': [tab('c1', 'wt-2', 'agent-session')],
        'wt-3': []
      }
    })

    expect(buildUiTabsSnapshot(store.getState())).toEqual({
      'wt-1': [
        { id: 't1', type: 'terminal' },
        { id: 'b1', type: 'browser' }
      ],
      'wt-2': [{ id: 'c1', type: 'chat' }],
      'wt-3': []
    })
  })
})

describe('registerUiActionIpcBridge', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('hands the requested host to the command dispatcher with the workspace', () => {
    let deliver: ((request: Record<string, unknown>) => void) | undefined
    const replyUiAction = vi.fn()
    vi.stubGlobal('window', {
      api: {
        ui: {
          onRequestUiAction: (callback: (request: Record<string, unknown>) => void) => {
            deliver = callback
            return () => {}
          },
          replyUiAction
        }
      }
    })
    const dispatcher = vi.fn(() => ({ claimed: true }))
    const unregister = registerAppCommandDispatcher(dispatcher)
    const unsubs: (() => void)[] = []

    registerUiActionIpcBridge(unsubs)
    deliver?.({
      requestId: 'r1',
      actionId: 'workspace.delete',
      worktreeId: 'repo::/feature',
      hostId: 'ssh:other-host'
    })
    deliver?.({ requestId: 'r2', actionId: 'workspace.delete', worktreeId: 'repo::/feature' })
    unregister()
    unsubs.forEach((unsub) => unsub())

    expect(dispatcher).toHaveBeenNthCalledWith(1, 'workspace.delete', 'rpc', {
      worktreeId: 'repo::/feature',
      hostId: 'ssh:other-host'
    })
    expect(dispatcher).toHaveBeenNthCalledWith(2, 'workspace.delete', 'rpc', {
      worktreeId: 'repo::/feature'
    })
    expect(replyUiAction).toHaveBeenCalledWith({ requestId: 'r1', claimed: true })
  })
})
