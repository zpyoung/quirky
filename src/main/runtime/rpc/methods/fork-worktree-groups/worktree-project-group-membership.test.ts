import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../../dispatcher'
import type { RpcRequest } from '../../core'
import type { QuirkyRuntimeService } from '../../../quirky-runtime'
import { WORKTREE_METHODS } from '../worktree'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

const passthroughDedupe = <T>(_repo: string, _id: string | undefined, run: () => Promise<T>) =>
  run()

describe('worktree.set project group membership', () => {
  it('forwards projectGroupId through worktree.set', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: passthroughDedupe,
      updateManagedWorktreeMeta: vi.fn().mockResolvedValue({ id: 'wt-1' })
    } as unknown as QuirkyRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.set', {
        worktree: 'id:wt-1',
        projectGroupId: 'group-1'
      })
    )

    expect(response).toMatchObject({ ok: true })
    expect(runtime.updateManagedWorktreeMeta).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({
        projectGroupId: 'group-1'
      })
    )
  })

  it('forwards a projectGroupId clear through worktree.set', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: passthroughDedupe,
      updateManagedWorktreeMeta: vi.fn().mockResolvedValue({ id: 'wt-1' })
    } as unknown as QuirkyRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.set', {
        worktree: 'id:wt-1',
        projectGroupId: null
      })
    )

    expect(response).toMatchObject({ ok: true })
    expect(runtime.updateManagedWorktreeMeta).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({
        projectGroupId: null
      })
    )
  })

  it('drops projectGroupId from a mobile-scoped worktree.set', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: passthroughDedupe,
      updateManagedWorktreeMeta: vi.fn().mockResolvedValue({ id: 'wt-1' })
    } as unknown as QuirkyRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const replies: string[] = []
    await dispatcher.dispatchStreaming(
      makeRequest('worktree.set', {
        worktree: 'id:wt-1',
        displayName: 'from phone',
        projectGroupId: 'group-1'
      }),
      (response) => replies.push(response),
      { clientKind: 'mobile' }
    )
    const [, meta] = vi.mocked(runtime.updateManagedWorktreeMeta).mock.calls[0]!
    expect('projectGroupId' in meta).toBe(false)
    expect(meta).toMatchObject({ displayName: 'from phone' })
  })

  it('still forwards projectGroupId for a runtime-scoped worktree.set', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: passthroughDedupe,
      updateManagedWorktreeMeta: vi.fn().mockResolvedValue({ id: 'wt-1' })
    } as unknown as QuirkyRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const replies: string[] = []
    await dispatcher.dispatchStreaming(
      makeRequest('worktree.set', { worktree: 'id:wt-1', projectGroupId: 'group-1' }),
      (response) => replies.push(response),
      { clientKind: 'runtime' }
    )

    expect(runtime.updateManagedWorktreeMeta).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({ projectGroupId: 'group-1' })
    )
  })
})
