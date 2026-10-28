import { join } from 'node:path'
import { QuirkyClient } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { afterEach, expect, test } from 'bun:test'
import type { PublicListResult, SearchResponse, ViewState } from '../src/types'
import { VaultRig } from './support/harness'
import { mkdirSync } from 'node:fs'
import { isolateGitConfig, makeRepo } from '../../quirky.repo/test/git-fixtures'
import { writeJsonlFixture } from './fixtures/scanner-fixtures'

const { scratch } = isolateGitConfig()
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



test('an unavailable claimed worktree identity stays a bounded Workspace scope', async () => {
  const vault = await start()
  const cwd = join(vault.home, 'registered-folder-workspace')
  mkdirSync(cwd, { recursive: true })
  const repo = await vault.client.callAny('quirky.repo/add', { path: cwd, folder: true }) as { id: string }
  const worktrees = await vault.client.callAny('quirky.worktree/list', { repo: repo.id }) as {
    id: string
    path: string
    isMain: boolean
  }[]
  const primary = worktrees.find((worktree) => worktree.isMain)
  if (!primary) throw new Error('registered folder project has no primary workspace')
  const client = await connect(vault, 'cli', { cwd: primary.path, worktreeId: 'missing-worktree' })

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
  const client = await connect(vault, 'cli')

  expect((await api<ViewState>(client, 'setView', { scope: 'workspace' })).scope).toBe('workspace')
  const result = await api<PublicListResult>(client, 'list', { unlimited: true })
  expect(result.sessions).toEqual([])
  expect(result.total).toBe(0)
})
test('without a worktree or project context the default scope is All', async () => {
  const vault = await start()
  expect((await api<ViewState>(vault.client, 'getView')).scope).toBe('all')
})



test('real Workspace and Project scopes apply depth after selecting registered worktrees', async () => {
  const vault = await start()
  const projectPath = makeRepo(scratch())
  const repo = await vault.client.callAny('quirky.repo/add', { path: projectPath }) as { id: string }
  const worktrees = await vault.client.callAny('quirky.worktree/list', { repo: repo.id }) as {
    id: string
    path: string
    isMain: boolean
  }[]
  const primary = worktrees.find((worktree) => worktree.isMain)
  if (!primary) throw new Error('registered Git project has no primary worktree')
  await vault.client.callAny('setting.set', {
    id: 'setting:quirky.worktree/worktreesRoot',
    value: join(vault.home, 'worktrees')
  })
  const created = await vault.client.callAny('quirky.worktree/create', { repo: repo.id, name: 'secondary' }) as {
    worktree: { id: string; path: string }
  }
  const secondary = created.worktree
  const base = Date.UTC(2020, 0, 1)
  const writeSession = (sessionId: string, cwd: string, timestamp: number) =>
    writeJsonlFixture(vault.sourceHome, 'claude', sessionId, [
      {
        type: 'user',
        sessionId,
        timestamp: new Date(timestamp).toISOString(),
        cwd,
        message: { role: 'user', content: `Scoped history ${sessionId}` }
      },
      {
        type: 'assistant',
        sessionId,
        timestamp: new Date(timestamp + 1_000).toISOString(),
        cwd,
        message: { role: 'assistant', content: `Answer ${sessionId}` }
      }
    ])

  await writeSession('scope-old-primary', primary.path, base)
  await writeSession('scope-old-secondary', secondary.path, base + 2_000)
  const unrelatedRoot = join(vault.home, 'newer-unrelated-projects')
  for (let index = 0; index < 251; index++) {
    const cwd = join(unrelatedRoot, `project-${index}`)
    mkdirSync(cwd, { recursive: true })
    await writeSession(`scope-unrelated-${index}`, cwd, Date.UTC(2026, 9, 20) + index * 2_000)
  }

  const projectClient = await connect(vault, 'ui')
  await projectClient.callAny('ui.view.open', {
    id: 'view:quirky.vault/search-settings',
    input: { repo: repo.id }
  })
  const uiState = await projectClient.callAny('ui.state', {}) as {
    layout: { view: { id: string; input?: unknown } | null }
  }
  expect(uiState.layout.view).toEqual({
    id: 'view:quirky.vault/search-settings',
    input: { repo: repo.id }
  })
  expect((await api<ViewState>(projectClient, 'getView')).scope).toBe('project')
  const project = await api<PublicListResult>(projectClient, 'list', { agents: ['claude'] })
  expect(project.sessions.map((session) => session.sessionId).sort()).toEqual([
    'scope-old-primary',
    'scope-old-secondary'
  ])
  expect(project.sessions.every((session) => session.cwd === primary.path || session.cwd === secondary.path)).toBe(true)
  await projectClient.callAny('ui.view.open', {
    id: 'view:quirky.vault/search-settings',
    input: { repo: 'repo-not-registered' }
  })
  expect((await api<ViewState>(projectClient, 'getView')).scope).toBe('project')
  const unavailableProject = await api<PublicListResult>(projectClient, 'list', { agents: ['claude'] })
  expect(unavailableProject.sessions).toEqual([])
  expect(unavailableProject.total).toBe(0)
  expect(unavailableProject.hosts).toEqual([
    expect.objectContaining({ hostId: 'local', kind: 'unavailable' })
  ])

  const active = await connect(vault, 'cli', { cwd: primary.path, worktreeId: primary.id })
  expect((await api<ViewState>(active, 'getView')).scope).toBe('workspace')
  const workspace = await api<PublicListResult>(active, 'list', { agents: ['claude'] })
  expect(workspace.sessions.map((session) => session.sessionId)).toEqual(['scope-old-primary'])
  expect(workspace.hasMore).toBe(false)

  await api<ViewState>(active, 'setView', { scope: 'all' })
  const all = await api<PublicListResult>(active, 'list', { agents: ['claude'] })
  expect(all.sessions).toHaveLength(250)
  expect(all.hasMore).toBe(true)
  expect(all.sessions.some((session) => session.sessionId.startsWith('scope-old-'))).toBe(false)
})

