import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const worktree = {
    id: 'repo::/feature',
    instanceId: 'feature-instance',
    repoId: 'repo',
    path: '/workspaces/feature',
    displayName: 'feature',
    isMainWorktree: false
  }
  const state = {
    settings: { skipDeleteWorktreeConfirm: false },
    repos: [],
    worktreeLineageById: {},
    clearWorktreeDeleteState: vi.fn(),
    openModal: vi.fn(),
    removeWorktree: vi.fn().mockResolvedValue({ ok: true })
  }
  return { state, worktree }
})

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/store/selectors', () => ({
  getAllWorktreesFromState: () => [mocks.worktree],
  getWorktreeMapFromState: () => new Map([[mocks.worktree.id, mocks.worktree]]),
  getWorktreeOnHostFromState: () => mocks.worktree
}))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }))
vi.mock('./delete-worktree-failure-toast', () => ({ showDeleteWorktreeFailureToast: vi.fn() }))

import { runWorktreeDelete } from './delete-worktree-flow'

describe('confirmed worktree delete', () => {
  beforeEach(() => {
    mocks.state.settings = { skipDeleteWorktreeConfirm: false }
    mocks.state.openModal.mockClear()
    mocks.state.removeWorktree.mockClear()
  })

  it('opens the confirmation modal for an unconfirmed delete by default', () => {
    runWorktreeDelete(mocks.worktree.id)

    expect(mocks.state.openModal).toHaveBeenCalledWith('delete-worktree', expect.anything())
    expect(mocks.state.removeWorktree).not.toHaveBeenCalled()
  })

  it('deletes without the modal when the caller already confirmed, whatever the preference says', () => {
    runWorktreeDelete(mocks.worktree.id, { confirmed: true })

    expect(mocks.state.openModal).not.toHaveBeenCalled()
    expect(mocks.state.removeWorktree).toHaveBeenCalledTimes(1)
  })
})
