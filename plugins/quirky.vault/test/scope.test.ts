import { join } from 'node:path'
import { QuirkyClient } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { afterEach, expect, test } from 'bun:test'
import type { PublicListResult, SearchResponse, ViewState } from '../src/types'
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
