import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  deleteConfirmedWorkspace,
  deleteHoveredWorkspaceImmediately
} from './hovered-workspace-delete'

vi.mock('@/store', () => ({ useAppStore: Object.assign(vi.fn(), { getState: vi.fn() }) }))

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo::/feature',
    repoId: 'repo',
    path: '/feature',
    branch: 'feature',
    isMainWorktree: false,
    ...overrides
  } as Worktree
}

const target = worktree({ hostId: 'ssh:build', instanceId: 'instance-2' })

function dependencies() {
  return { deleteWorktree: vi.fn(), getCurrentState: vi.fn() }
}

describe('confirmed workspace delete', () => {
  it('tells the delete flow the caller already confirmed', () => {
    const deps = dependencies()

    expect(
      deleteConfirmedWorkspace({} as AppState, { kind: 'worktree', worktree: target }, deps)
    ).toBe(true)
    expect(deps.deleteWorktree).toHaveBeenCalledWith(target.id, {
      confirmed: true,
      expectedHostId: 'ssh:build',
      expectedInstanceId: 'instance-2'
    })
  })

  it('leaves the hover path on the confirmation preference', () => {
    const deps = dependencies()

    deleteHoveredWorkspaceImmediately({} as AppState, { kind: 'worktree', worktree: target }, deps)

    expect(deps.deleteWorktree).toHaveBeenCalledWith(target.id, {
      expectedHostId: 'ssh:build',
      expectedInstanceId: 'instance-2'
    })
  })
})
