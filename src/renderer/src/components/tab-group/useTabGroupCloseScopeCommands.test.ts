// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab, TabContentType, TabGroup } from '../../../../shared/tab-types'
import { useTabGroupCloseScopeCommands } from './useTabGroupCloseScopeCommands'

const mocks = vi.hoisted(() => {
  const state: {
    groupsByWorktree: Record<string, TabGroup[]>
    unifiedTabsByWorktree: Record<string, Tab[]>
  } = { groupsByWorktree: {}, unifiedTabsByWorktree: {} }
  return { closeEmptyGroup: vi.fn(), state }
})

vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    (selector: (state: { closeEmptyGroup: () => void }) => unknown) => selector(mocks),
    { getState: () => mocks.state }
  )
}))
vi.mock('../confirmation-dialog-context', () => ({
  useConfirmationDialog: () => async () => true
}))
vi.mock('./workspace-emptied-reaction', () => ({
  captureWorkspaceEmptiedReaction: vi.fn(() => vi.fn())
}))

function tab(id: string, contentType: TabContentType = 'terminal', isPinned = false): Tab {
  return {
    id,
    entityId: id,
    contentType,
    groupId: 'group-1',
    worktreeId: 'worktree-1',
    label: 'private tab title',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    isPinned
  }
}

function commands({
  worktreeId = 'worktree-1',
  contentType = 'terminal',
  closeMany = vi.fn()
}: {
  worktreeId?: string
  contentType?: TabContentType
  closeMany?: (ids: string[]) => void
} = {}) {
  const group: TabGroup = {
    id: 'group-1',
    worktreeId,
    activeTabId: 'selected',
    tabOrder: ['left', 'pinned-left', 'selected', 'right', 'pinned-right', 'missing', 'last']
  }
  // Storage order differs from the visible order; pinned and missing tabs must not count.
  const groupTabs = [
    tab('last'),
    tab('selected', contentType),
    tab('pinned-left', 'terminal', true),
    tab('pinned-right', 'terminal', true),
    tab('right'),
    tab('left')
  ]
  mocks.state = {
    groupsByWorktree: { [worktreeId]: [group] },
    unifiedTabsByWorktree: { [worktreeId]: groupTabs }
  }
  const hook = renderHook(() =>
    useTabGroupCloseScopeCommands({
      groupId: group.id,
      worktreeId,
      closeItem: vi.fn(),
      closeMany
    })
  )
  return { ...hook.result.current, closeMany }
}

beforeEach(() => vi.clearAllMocks())

describe('directional tab close', () => {
  it.each(['left', 'right'] as const)(
    'closes the tabs on the %s side of the selected tab',
    async (direction) => {
      const expectedIds = direction === 'left' ? ['left'] : ['right', 'last']
      const closeMany = vi.fn((ids: string[]) => {
        expect(ids).toEqual(expectedIds)
        // The close flow can leave these tabs open after a cancelled save prompt.
      })
      const scope = commands({ closeMany })

      await act(async () => {
        if (direction === 'left') {
          scope.closeToLeft('selected')
        } else {
          scope.closeToRight('selected')
        }
      })

      expect(closeMany).toHaveBeenCalledExactlyOnceWith(expectedIds)
    }
  )

  it('does not close anything when no tabs are eligible', () => {
    const scope = commands()
    scope.closeToLeft('left')

    expect(scope.closeMany).not.toHaveBeenCalled()
  })

  it('ignores stale tab ids', () => {
    const scope = commands()
    scope.closeToLeft('stale')
    scope.closeToRight('stale')

    expect(scope.closeMany).not.toHaveBeenCalled()
  })
})
