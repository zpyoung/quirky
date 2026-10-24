import { afterEach, expect, test } from 'bun:test'
import { RpcError, RpcErrorCode, type Worktree } from '@quirky/protocol'
import { removeWorktree } from '../src/actions'
import type { Connection } from '../src/connection'

const worktree: Worktree = {
  id: 'w2',
  repoId: 'r1',
  path: '/wt/feature',
  branch: 'feature',
  head: 'abc',
  isMain: false,
  name: 'feature'
}

const g = globalThis as { window?: unknown }
afterEach(() => {
  delete g.window
})

function fakeConnection(failWith: Error | null) {
  const calls: { method: string; params: unknown }[] = []
  const toasts: string[] = []
  const connection = {
    async call(method: string, params: unknown) {
      calls.push({ method, params })
      const forced = (params as { force?: boolean }).force === true
      if (failWith && !forced) throw failWith
      return { ok: true }
    },
    async attempt(method: string, params: unknown) {
      return connection.call(method, params)
    },
    toastError: (title: string) => void toasts.push(title),
    async refreshWorktrees() {}
  }
  return { connection: connection as unknown as Connection, calls, toasts }
}

test('a Conflict from worktree.remove opens the force prompt with the daemon message', async () => {
  const prompts: string[] = []
  g.window = {
    confirm: (message: string) => {
      prompts.push(message)
      return true
    }
  }
  const { connection, calls, toasts } = fakeConnection(
    new RpcError(RpcErrorCode.Conflict, 'worktree has uncommitted changes')
  )
  await removeWorktree(connection, worktree)
  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain('worktree has uncommitted changes')
  expect(calls.map((c) => c.params)).toEqual([
    { worktreeId: 'w2' },
    { worktreeId: 'w2', force: true }
  ])
  expect(toasts).toEqual([])
})

test('declining the force prompt leaves the worktree alone', async () => {
  let asked = 0
  g.window = { confirm: () => ++asked === 1 }
  const { connection, calls } = fakeConnection(new RpcError(RpcErrorCode.Conflict, 'dirty'))
  await removeWorktree(connection, worktree)
  expect(calls).toHaveLength(1)
})

test('other errors show a toast and skip the force prompt', async () => {
  let asked = 0
  g.window = { confirm: () => ++asked > 0 }
  const { connection, calls, toasts } = fakeConnection(new RpcError(RpcErrorCode.Internal, 'boom'))
  await removeWorktree(connection, worktree)
  expect(asked).toBe(1)
  expect(calls).toHaveLength(1)
  expect(toasts).toEqual(['Could not remove worktree'])
})
