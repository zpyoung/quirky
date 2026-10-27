import { existsSync } from 'node:fs'
import { RpcErrorCode } from '@quirky/protocol'
import { afterEach, describe, expect, test } from 'bun:test'
import type { HostOutcome, PublicListResult, SearchResponse, SearchStatus, ViewState } from '../src/types'
import { VaultRig } from './support/harness'

type PublicSearchStatus = { status: SearchStatus; hosts: HostOutcome[] }

let rig: VaultRig | undefined

afterEach(async () => {
  await rig?.cleanup()
  rig = undefined
})

const start = async () => (rig = await VaultRig.start())

describe('vault public API', () => {
  test('lists the real fixture inventory as host-qualified public sessions', async () => {
    const vault = await start()
    const result = await vault.call<PublicListResult>('list', { host: 'local', unlimited: true })

    expect(result.sessions).toHaveLength(25)
    expect(result.total).toBe(25)
    expect(result.hosts).toEqual([
      expect.objectContaining({ hostId: 'local', kind: 'ok', scannedAt: expect.any(Number) })
    ])
    for (const [agent, expected] of Object.entries(vault.expected)) {
      const session = result.sessions.find((row) => row.agent === agent)
      expect(session).toMatchObject({
        id: expect.any(String),
        sourceId: expect.any(String),
        hostId: 'local',
        agent,
        sessionId: expected.sessionId,
        title: expected.title,
        cwd: expected.cwd,
        source: { presence: 'present', filePath: expect.any(String) }
      })
      if (!session) throw new Error(`missing ${agent} source record`)
      expect(session.id).not.toBe(session.sourceId)
    }
    expect(result.issues).toEqual([])
  })

  test('off-state title browsing and status never create or open the full-text index', async () => {
    const vault = await start()
    await vault.call('list', { unlimited: true })

    const status = await vault.call<PublicSearchStatus>('searchStatus', {})
    expect(status.status.enabled).toBe(false)
    expect(status.hosts).toEqual([expect.objectContaining({ hostId: 'local', kind: 'ok' })])
    expect(vault.searchDatabaseExists()).toBe(false)

    const denied = await vault.call<SearchResponse>('search', { query: 'vault-fixture-claude-marker' })
    expect(denied).toMatchObject({ kind: 'unavailable', reason: 'disabled' })
    expect(vault.searchDatabaseExists()).toBe(false)
  })

  test('empty agent selection stays empty and all-without-hosts remains local only', async () => {
    const vault = await start()
    const empty = await vault.call<PublicListResult>('list', { agents: [], unlimited: true })
    expect(empty.sessions).toEqual([])
    expect(empty.total).toBe(0)

    const all = await vault.call<PublicListResult>('list', { host: 'all', unlimited: true })
    expect(all.sessions).toHaveLength(25)
    expect(all.hosts.map((host) => host.hostId)).toEqual(['local'])
    expect(all.sessions.every((session) => session.hostId === 'local')).toBe(true)
  })

  test('stable view settings survive daemon restart while query and scope are transient', async () => {
    const vault = await start()
    const changed = await vault.call<ViewState>('setView', {
      group: 'agent',
      hideEmptySessions: true,
      sessionLimit: null,
      browseSort: 'created',
      query: 'temporary-query',
      scope: 'project',
      selectedId: 'local:test'
    })
    expect(changed).toMatchObject({
      group: 'agent',
      hideEmptySessions: true,
      sessionLimit: null,
      browseSort: 'created',
      query: 'temporary-query',
      scope: 'project',
      selectedId: 'local:test'
    })

    await vault.restart()
    const restored = await vault.call<ViewState>('getView', {})
    expect(restored).toMatchObject({ group: 'agent', hideEmptySessions: true, sessionLimit: null, browseSort: 'created' })
    expect(restored).toMatchObject({ query: '', scope: expect.any(String), selectedId: null, expandedIds: [], focusedSearch: false })

    const reset = await vault.call<ViewState>('resetView', {})
    expect(reset).toMatchObject({ group: 'project', hideEmptySessions: false, sessionLimit: 250, browseSort: 'updated', searchSort: 'relevance' })
  })

  test('unknown workspace scope returns a bounded scope error instead of global results', async () => {
    const vault = await start()
    const response = await vault.call<SearchResponse>('search', {
      query: 'vault-fixture-claude-marker',
      within: { worktree: 'missing-workspace' }
    })
    expect(response).toMatchObject({ kind: 'unavailable', reason: 'scope-unknown' })
    expect(vault.searchDatabaseExists()).toBe(false)
  })
  test('consented search is real, clear requires confirmation, and clearing leaves source transcripts intact', async () => {
    const vault = await start()
    const sourcePath = vault.fixturePaths.claude
    if (!sourcePath) throw new Error('Claude source fixture path was not generated')
    expect(existsSync(sourcePath)).toBe(true)

    const enabled = await vault.call<PublicSearchStatus>('setSearchEnabled', { enabled: true })
    expect(enabled.status.enabled).toBe(true)
    expect(vault.searchDatabaseExists()).toBe(true)
    const searched = await vault.call<SearchResponse>('search', {
      query: 'vault-fixture-claude-marker',
      freshness: 'wait-until-current',
      filters: { agents: ['claude'] }
    })
    if (searched.kind !== 'results') throw new Error(`search did not return results: ${searched.kind}`)
    expect(searched.hits.some((hit) => hit.agent === 'claude')).toBe(true)

    const confirmation = await vault.client.callAny('quirky.vault/clearSearchIndex', {}).then(
      () => null,
      (error: unknown) => error as { code?: number }
    )
    expect(confirmation).toMatchObject({ code: RpcErrorCode.ConfirmationRequired })
    expect(vault.searchDatabaseExists()).toBe(true)
    expect((await vault.call<PublicSearchStatus>('searchStatus', {})).status.enabled).toBe(true)

    const cleared = await vault.call<{ cleared: boolean; status: SearchStatus }>('clearSearchIndex', { yes: true })
    expect(cleared).toMatchObject({ cleared: true, status: { enabled: false } })
    expect(vault.searchDatabaseExists()).toBe(false)
    expect(existsSync(sourcePath)).toBe(true)
  })
})
