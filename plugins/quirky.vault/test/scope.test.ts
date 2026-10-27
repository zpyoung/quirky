import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { QuirkyClient } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { afterEach, expect, test } from 'bun:test'
import type { PublicListResult, SearchResponse, ViewState } from '../src/types'
import { writeJsonlFixture } from './fixtures/scanner-fixtures'
import { VaultRig } from './support/harness'

let rig: VaultRig | undefined

afterEach(async () => {
  await rig?.cleanup()
  rig = undefined
})

const start = async () => (rig = await VaultRig.start())

async function connect(
  vault: VaultRig,
  role: 'cli' | 'ui',
  identity: { cwd?: string; worktreeId?: string } = {}
): Promise<QuirkyClient> {
  const client = await QuirkyClient.connect(rpcUrl(vault.h.runtime), { role, ...identity })
  vault.h.clients.push(client)
  return client
}

async function api<T>(client: QuirkyClient, method: string, params: Record<string, unknown> = {}): Promise<T> {
  return (await client.callAny(`quirky.vault/${method}`, params)) as T
}

test('unregistered CLI cwd defaults to All and lists fixture records', async () => {
  const vault = await start()
  const client = await connect(vault, 'cli', { cwd: join(vault.home, 'unregistered-cwd') })

  expect((await api<ViewState>(client, 'getView')).scope).toBe('all')
  const result = await api<PublicListResult>(client, 'list', { unlimited: true })
  expect(result.sessions).toHaveLength(25)
  expect(result.total).toBe(25)
})

test('active UI worktree selects Workspace and keeps an old in-scope session inside the default depth', async () => {
  const vault = await start()
  const workspacePath = join(vault.home, 'active-worktree')
  mkdirSync(workspacePath)
  const repo = await vault.client.callAny('quirky.repo/add', { path: workspacePath, folder: true }) as { id: string }
  const worktrees = await vault.client.callAny('quirky.worktree/list', { repo: repo.id }) as { id: string; path: string }[]
  const worktree = worktrees.find((item) => item.path === workspacePath)
  if (!worktree) throw new Error('folder project did not expose its primary worktree')

  const oldTime = Date.UTC(2020, 0, 1)
  await writeJsonlFixture(vault.sourceHome, 'claude', 'old-workspace-session', [
    {
      type: 'user',
      sessionId: 'old-workspace-session',
      timestamp: new Date(oldTime).toISOString(),
      cwd: workspacePath,
      message: { role: 'user', content: 'old session inside the active workspace' }
    },
    {
      type: 'assistant',
      sessionId: 'old-workspace-session',
      timestamp: new Date(oldTime + 1_000).toISOString(),
      message: { role: 'assistant', content: 'workspace response' }
    }
  ])
  const recentBase = Date.UTC(2026, 9, 26)
  for (let index = 0; index < 250; index++) {
    const sessionId = `outside-session-${index}`
    const timestamp = new Date(recentBase + index * 1_000).toISOString()
    await writeJsonlFixture(vault.sourceHome, 'claude', sessionId, [
      {
        type: 'user',
        sessionId,
        timestamp,
        cwd: join(vault.home, `outside-${index}`),
        message: { role: 'user', content: `newer out-of-scope session ${index}` }
      },
      {
        type: 'assistant',
        sessionId,
        timestamp: new Date(recentBase + index * 1_000 + 500).toISOString(),
        message: { role: 'assistant', content: 'outside response' }
      }
    ])
  }

  const window = await connect(vault, 'ui')
  await window.callAny('ui.view.open', {
    id: 'view:quirky.session/worktree',
    input: { worktree: worktree.id }
  })
  const state = await window.callAny('ui.state', {}) as { layout: { view: { input: { worktree: string } } } }
  expect(state.layout.view.input.worktree).toBe(worktree.id)
  expect((await api<ViewState>(window, 'getView')).scope).toBe('workspace')

  const result = await api<PublicListResult>(window, 'list', { force: true })
  expect(result.sessions.map((session) => session.sessionId)).toEqual(['old-workspace-session'])
  expect(result.total).toBe(1)
})

test('an unavailable claimed worktree identity stays a bounded Workspace scope', async () => {
  const vault = await start()
  const client = await connect(vault, 'cli', {
    cwd: join(vault.home, 'unregistered-cwd'),
    worktreeId: 'missing-worktree'
  })

  expect((await api<ViewState>(client, 'getView')).scope).toBe('workspace')
  const result = await api<PublicListResult>(client, 'list', { unlimited: true })
  expect(result.sessions).toEqual([])
  expect(result.total).toBe(0)
})

test('unknown explicit within returns no list rows and an unavailable search result', async () => {
  const vault = await start()
  const within = { worktree: 'missing-worktree' }

  const list = await api<PublicListResult>(vault.client, 'list', { within, unlimited: true })
  expect(list.sessions).toEqual([])
  expect(list.total).toBe(0)

  const search = await api<SearchResponse>(vault.client, 'search', {
    query: 'vault-fixture-claude-marker',
    within
  })
  expect(search).toMatchObject({ kind: 'unavailable', reason: 'scope-unknown' })
})

test('an explicitly selected unavailable scope does not widen to All', async () => {
  const vault = await start()
  const client = await connect(vault, 'cli', { cwd: join(vault.home, 'unregistered-cwd') })

  expect((await api<ViewState>(client, 'setView', { scope: 'workspace' })).scope).toBe('workspace')
  const result = await api<PublicListResult>(client, 'list', { unlimited: true })
  expect(result.sessions).toEqual([])
  expect(result.total).toBe(0)
})
