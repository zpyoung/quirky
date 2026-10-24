import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { RpcErrorCode, RpcError, type QuirkyClient, type QuirkyEvent } from '@quirky/protocol'
import { startHarness, waitFor, type Harness } from './helpers'

let h: Harness
let client: QuirkyClient
let events: QuirkyEvent[]

beforeEach(async () => {
  h = await startHarness()
  h.git.addRepo('/fake/alpha')
  ;({ client, events } = await h.connectWithEvents('cli'))
})
afterEach(() => h.cleanup())

async function errorCode(promise: Promise<unknown>): Promise<number | null> {
  try {
    await promise
    return null
  } catch (error) {
    return (error as RpcError).code
  }
}

describe('settings', () => {
  test('has defaults and validates updates', async () => {
    const settings = await client.call('settings.get', {})
    expect(settings).toEqual({
      worktreesRoot: join(homedir(), 'quirky', 'workspaces'),
      terminalScrollback: 2000,
      notifications: true
    })
    const next = await client.call('settings.set', { worktreesRoot: '~/wt', notifications: false })
    expect(next.worktreesRoot).toBe(join(homedir(), 'wt'))
    expect(next.notifications).toBe(false)
    expect((await client.call('settings.get', {})).notifications).toBe(false)
    expect(await errorCode((client as any).call('settings.set', { terminalScrollback: -1 }))).toBe(
      RpcErrorCode.InvalidParams
    )
  })
})

describe('repos', () => {
  test('add resolves the toplevel, dedupes and emits repo.changed', async () => {
    const repo = await client.call('repo.add', { path: '/fake/alpha/src/deep' })
    expect(repo).toMatchObject({ name: 'alpha', path: '/fake/alpha' })
    expect(repo.id).toMatch(/^repo_[0-9a-f]+$/)
    const again = await client.call('repo.add', { path: '/fake/alpha' })
    expect(again.id).toBe(repo.id)
    expect(await client.call('repo.list', {})).toHaveLength(1)
    await waitFor(() => events.find((e) => e.type === 'repo.changed'))
  })

  test('add rejects a path outside any repo', async () => {
    expect(await errorCode(client.call('repo.add', { path: '/nowhere' }))).toBe(RpcErrorCode.InvalidParams)
  })

  test('remove deletes the repo', async () => {
    const repo = await client.call('repo.add', { path: '/fake/alpha' })
    await client.call('repo.remove', { repoId: repo.id })
    expect(await client.call('repo.list', {})).toEqual([])
    expect(await errorCode(client.call('repo.remove', { repoId: repo.id }))).toBe(RpcErrorCode.NotFound)
  })
})

describe('worktrees', () => {
  test('list gives stable ids and marks the main worktree', async () => {
    const repo = await client.call('repo.add', { path: '/fake/alpha' })
    const [main] = await client.call('worktree.list', { repoId: repo.id })
    const expectedId = `wt_${createHash('sha1').update('/fake/alpha').digest('hex').slice(0, 12)}`
    expect(main).toMatchObject({ id: expectedId, repoId: repo.id, isMain: true, name: 'main', branch: 'main' })
    expect(await client.call('worktree.list', {})).toHaveLength(1)
  })

  test('create validates the name and builds the path under worktreesRoot', async () => {
    await client.call('settings.set', { worktreesRoot: '/tmp/wtroot' })
    const repo = await client.call('repo.add', { path: '/fake/alpha' })
    for (const name of ['-bad', 'a..b', 'has space', '', 'semi;colon']) {
      expect(await errorCode(client.call('worktree.create', { repoId: repo.id, name }))).toBe(
        RpcErrorCode.InvalidParams
      )
    }
    const worktree = await client.call('worktree.create', {
      repoId: repo.id,
      name: 'feat/login',
      baseRef: 'develop'
    })
    expect(worktree).toMatchObject({
      path: '/tmp/wtroot/alpha/feat-login',
      branch: 'feat/login',
      isMain: false,
      repoId: repo.id
    })
    expect(h.git.calls.find((c) => c.fn === 'addWorktree')?.args).toEqual([
      '/fake/alpha',
      '/tmp/wtroot/alpha/feat-login',
      'feat/login',
      'develop'
    ])
    await waitFor(() => events.find((e) => e.type === 'worktree.changed'))
    expect(await client.call('worktree.list', { repoId: repo.id })).toHaveLength(2)
  })

  test('remove refuses the main worktree and closes sessions first', async () => {
    const repo = await client.call('repo.add', { path: '/fake/alpha' })
    const [main] = await client.call('worktree.list', { repoId: repo.id })
    expect(await errorCode(client.call('worktree.remove', { worktreeId: main.id }))).toBe(RpcErrorCode.Conflict)

    const worktree = await client.call('worktree.create', { repoId: repo.id, name: 'tmp' })
    const session = await client.call('session.create', { worktreeId: worktree.id, agent: 'shell' })
    await client.call('worktree.remove', { worktreeId: worktree.id, force: true })
    expect(await client.call('session.list', {})).toEqual([])
    expect(h.pty.requests.some((r) => r.type === 'forget' && r.sessionId === session.id)).toBe(true)
    expect(h.git.calls.find((c) => c.fn === 'removeWorktree')?.args).toEqual([
      '/fake/alpha',
      worktree.path,
      true
    ])
    expect(await client.call('worktree.list', { repoId: repo.id })).toHaveLength(1)
  })

  test('git methods run in the worktree path and report changes', async () => {
    const repo = await client.call('repo.add', { path: '/fake/alpha' })
    const [main] = await client.call('worktree.list', { repoId: repo.id })
    expect((await client.call('git.status', { worktreeId: main.id })).files).toHaveLength(1)
    expect(await client.call('git.diff', { worktreeId: main.id, path: 'a.txt', staged: true })).toMatchObject({
      staged: true,
      modified: 'new'
    })
    await client.call('git.stage', { worktreeId: main.id, paths: ['a.txt'] })
    await client.call('git.unstage', { worktreeId: main.id, paths: ['a.txt'] })
    expect(await client.call('git.commit', { worktreeId: main.id, message: 'msg' })).toEqual({
      sha: 'c'.repeat(40)
    })
    await waitFor(() => events.filter((e) => e.type === 'git.changed').length >= 3)
    expect(await errorCode((client as any).call('git.stage', { worktreeId: main.id, paths: 'a.txt' }))).toBe(
      RpcErrorCode.InvalidParams
    )
  })
})
