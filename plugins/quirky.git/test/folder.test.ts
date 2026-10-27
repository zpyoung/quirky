import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { RpcError, RpcErrorCode } from '@quirky/protocol'
import { startGitHarness, type GitHarness } from './support'

const SENTENCE = 'Opened as folder. Git features are unavailable for this workspace.'

let g: GitHarness
beforeEach(async () => {
  g = await startGitHarness()
})
afterEach(() => g.cleanup())

async function errorOf(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise
  } catch (error) {
    return error as RpcError
  }
  throw new Error('expected the call to fail')
}

describe('SC-13: quirky.git on a folder workspace', () => {
  const methods: Array<[string, Record<string, unknown>]> = [
    ['status', {}],
    ['diff', { path: 'a.txt' }],
    ['stage', { paths: ['a.txt'] }],
    ['unstage', { paths: ['a.txt'] }],
    ['commit', { message: 'msg' }]
  ]

  for (const [method, params] of methods) {
    test(`${method} is InvalidParams with the folder reason and runs no git`, async () => {
      const error = await errorOf(g.call(`quirky.git/${method}`, { worktree: g.notes.id, ...params }))
      expect(error.code).toBe(RpcErrorCode.InvalidParams)
      expect(error.message).toBe(SENTENCE)
      expect(error.data).toEqual({ reason: 'folder-workspace' })
      expect(g.git.calls).toEqual([])
      expect(g.events.filter((e) => e.type === 'quirky.git/changed')).toEqual([])
    })
  }

  test('a folder is refused when selected by name too', async () => {
    const error = await errorOf(g.call('quirky.git/status', { worktree: 'notes' }))
    expect(error.data).toEqual({ reason: 'folder-workspace' })
  })

  test('git workspaces still run git', async () => {
    await g.call('quirky.git/status', { worktree: g.main.id })
    expect(g.git.calls.map((c) => c.fn)).toEqual(['status'])
  })
})
