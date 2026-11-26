import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import { createTestStore } from '../../store/slices/store-test-helpers'
import { buildUiTabsSnapshot } from './ui-action-ipc-bridge'

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
