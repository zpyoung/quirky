import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode, type QuirkyClient, type QuirkyEvent } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { afterEach, describe, expect, test } from 'bun:test'
import type { HostedSession, HostOutcome, PublicListResult, SearchResponse, SearchResults, SearchStatus } from '../src/types'
import { writeJsonlFixture, writeScopeFixture } from './fixtures/scanner-fixtures'
import { createVaultHostForwarder, removeVaultHostForwarder } from './support/host-forwarder'
import { VaultRig } from './support/harness'

type PublicStatus = { status: SearchStatus; hosts: HostOutcome[] }
type JsonRecord = Record<string, unknown>

const rigs: VaultRig[] = []
const pluginRoots: string[] = []

afterEach(async () => {
  for (const root of pluginRoots.splice(0).reverse()) removeVaultHostForwarder(root)
  for (const rig of rigs.splice(0).reverse()) await rig.cleanup()
})

async function start(options: { isolateVaultPlugin?: boolean; includeEveryAgentFixture?: boolean } = {}): Promise<VaultRig> {
  const rig = await VaultRig.start(options)
  rigs.push(rig)
  return rig
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function waitForEvent(client: QuirkyClient, predicate: (event: QuirkyEvent) => boolean): Promise<QuirkyEvent> {
  const { promise, resolve } = Promise.withResolvers<QuirkyEvent>()
  let unsubscribe = () => {}
  unsubscribe = client.onEvent((event) => {
    if (!predicate(event)) return
    unsubscribe()
    resolve(event)
  })
  return promise
}

function scanProgress(event: QuirkyEvent, filePath: string): boolean {
  if (event.type !== 'quirky.vault/scanProgress') return false
  const data = recordOf(event.data)
  return data?.phase === 'reading' && data.current === filePath
}

function results(response: SearchResponse): SearchResults {
  if (response.kind !== 'results') throw new Error(`expected search results, got ${response.kind}`)
  return response
}

function userRecord(sessionId: string, cwd: string, content: unknown, at: number): JsonRecord {
  return {
    type: 'user',
    sessionId,
    timestamp: new Date(at).toISOString(),
    cwd,
    message: { role: 'user', content }
  }
}

function assistantRecord(sessionId: string, cwd: string, content: unknown, at: number): JsonRecord {
  return {
    type: 'assistant',
    sessionId,
    timestamp: new Date(at).toISOString(),
    cwd,
    message: { role: 'assistant', content }
  }
}

function largeTranscript(sessionId: string, finalMarker: string): JsonRecord[] {
  const base = Date.UTC(2026, 9, 1, 10, 0, 0)
  const count = 16_000
  return Array.from({ length: count }, (_, index) => {
    const assistant = index % 2 === 1
    const type = assistant ? 'assistant' : 'user'
    const content = index === count - 1 ? finalMarker : `${'valid owned transcript context '.repeat(12)} ${index}`
    return {
      type,
      sessionId,
      timestamp: new Date(base + index * 1_000).toISOString(),
      cwd: '/tmp/vault-cancellation-worktree',
      message: { role: type, content }
    }
  })
}

describe('vault public acceptance flows', () => {
  test('coalesced list callers cancel independently and a new scan generation wins after all consumers cancel', async () => {
    const vault = await start()
    const sessionId = 'flow-large-cancel-session'
    const sourcePath = await writeJsonlFixture(vault.sourceHome, 'claude', sessionId, largeTranscript(sessionId, 'initialscanfinalmarker'))
    const secondClient = await vault.h.connect('cli')
    const targetProgressEvents: QuirkyEvent[] = []
    const unlisten = vault.client.onEvent((event) => {
      if (scanProgress(event, sourcePath)) targetProgressEvents.push(event)
    })

    const firstProgress = waitForEvent(vault.client, (event) => scanProgress(event, sourcePath))
    const firstOutcome = vault.client.callAny('quirky.vault/list', {
      host: 'local', agents: ['claude'], unlimited: true, requestToken: 'shared-caller-one'
    }).then(
      (value) => ({ kind: 'fulfilled' as const, value: value as PublicListResult }),
      (error: unknown) => ({ kind: 'rejected' as const, error })
    )
    const secondOutcome = secondClient.callAny('quirky.vault/list', {
      host: 'local', agents: ['claude'], unlimited: true, requestToken: 'shared-caller-two'
    }) as Promise<PublicListResult>
    await firstProgress
    const cancelledOne = await vault.call<{ cancelled: boolean }>('cancelList', { requestToken: 'shared-caller-one' })
    expect(cancelledOne.cancelled).toBe(true)
    const firstSettled = await firstOutcome
    expect(firstSettled.kind).toBe('rejected')

    const secondResult = await secondOutcome
    const secondSession = secondResult.sessions.find((session) => session.sessionId === sessionId)
    if (!secondSession) throw new Error(`shared scan did not include ${sessionId}`)
    expect(secondSession.previewMessages.some((message) => message.text.includes('initialscanfinalmarker'))).toBe(true)
    expect(targetProgressEvents.length).toBe(1)

    const supersededMarker = 'supersededscanmarker'
    await writeJsonlFixture(vault.sourceHome, 'claude', sessionId, largeTranscript(sessionId, supersededMarker))
    const allCancelledProgress = waitForEvent(vault.client, (event) => scanProgress(event, sourcePath))
    const allCancelledOutcome = vault.client.callAny('quirky.vault/list', {
      host: 'local', agents: ['claude'], unlimited: true, force: true, requestToken: 'all-consumers-cancelled'
    }).then(
      (value) => ({ kind: 'fulfilled' as const, value }),
      (error: unknown) => ({ kind: 'rejected' as const, error })
    )
    await allCancelledProgress
    const cancelledAll = await vault.call<{ cancelled: boolean }>('cancelList', { requestToken: 'all-consumers-cancelled' })
    expect(cancelledAll.cancelled).toBe(true)

    const finalMarker = 'newgenerationfinalmarker'
    await writeJsonlFixture(vault.sourceHome, 'claude', sessionId, [
      userRecord(sessionId, '/tmp/vault-cancellation-worktree', 'replacement transcript user turn', Date.UTC(2026, 9, 2, 10, 0, 0)),
      assistantRecord(sessionId, '/tmp/vault-cancellation-worktree', finalMarker, Date.UTC(2026, 9, 2, 10, 0, 1))
    ])
    const currentPromise = vault.call<PublicListResult>('list', {
      host: 'local', agents: ['claude'], unlimited: true, force: true, requestToken: 'new-generation'
    })
    expect((await allCancelledOutcome).kind).toBe('rejected')
    const current = await currentPromise
    const currentSession = current.sessions.find((session) => session.sessionId === sessionId)
    if (!currentSession) throw new Error(`new scan generation lost ${sessionId}`)
    expect(currentSession.previewMessages.some((message) => message.text.includes(finalMarker))).toBe(true)
    expect(currentSession.previewMessages.some((message) => message.text.includes(supersededMarker))).toBe(false)
    unlisten()
    secondClient.close()
  })
  test('unlimited view depth exceeds the scanner default while an explicit limit still wins', async () => {
    const vault = await start()
    const existing = await vault.call<PublicListResult>('list', {
      host: 'local', agents: ['claude'], unlimited: true
    })
    const projectRoot = join(vault.sourceHome, '.claude', 'projects', 'project')
    mkdirSync(projectRoot, { recursive: true })
    const addedSessions = 1_001
    const base = Date.UTC(2026, 9, 1, 16, 0, 0)
    for (let index = 0; index < addedSessions; index++) {
      const sessionId = `flow-unbounded-${String(index).padStart(4, '0')}`
      const at = base + index * 1_000
      const transcript = [
        userRecord(sessionId, '/tmp/vault-unbounded', `owned limit fixture ${sessionId}`, at),
        assistantRecord(sessionId, '/tmp/vault-unbounded', `completed ${sessionId}`, at + 500)
      ].map((record) => JSON.stringify(record)).join('\n')
      writeFileSync(join(projectRoot, `${sessionId}.jsonl`), `${transcript}\n`)
    }

    const expectedTotal = existing.total + addedSessions
    const view = await vault.call<{ sessionLimit: number | null }>('setView', { sessionLimit: null })
    expect(view.sessionLimit).toBe(null)
    const unlimited = await vault.call<PublicListResult>('list', {
      host: 'local', agents: ['claude'], force: true
    })
    const allIds = unlimited.sessions.map((session) => session.sessionId)
    expect(unlimited.total).toBe(expectedTotal)
    expect(unlimited.sessions.length).toBe(expectedTotal)
    expect(unlimited.hasMore).toBe(false)
    expect(new Set(allIds).size).toBe(expectedTotal)
    expect(allIds.includes('flow-unbounded-1000')).toBe(true)

    const capped = await vault.call<PublicListResult>('list', {
      host: 'local', agents: ['claude'], limit: 23, force: true
    })
    const cappedIds = capped.sessions.map((session) => session.sessionId)
    expect(capped.total).toBe(expectedTotal)
    expect(capped.sessions.length).toBe(23)
    expect(capped.hasMore).toBe(true)
    expect(new Set(cappedIds).size).toBe(23)
  }, 30_000)


  test('kernel consent starts indexing, publishes status without a status read, and clear follows the retained disabled index', async () => {
    const vault = await start()
    const inventory = await vault.call<PublicListResult>('list', { host: 'local', unlimited: true })
    const sourcePaths = inventory.sessions.map((session) => session.source.filePath)
    expect(sourcePaths.every((path) => typeof path === 'string')).toBe(true)
    expect(new Set(sourcePaths).size).toBe(sourcePaths.length)

    const indexedEvent = waitForEvent(vault.client, (event) => {
      if (event.type !== 'quirky.vault/searchStatus') return false
      const status = recordOf(event.data)
      return status?.enabled === true && typeof status.filesIndexed === 'number' && status.filesIndexed === sourcePaths.length
    })
    await vault.client.callAny('setting.set', { id: 'setting:quirky.vault/search-enabled', value: true })
    const event = await indexedEvent
    const status = event.type === 'quirky.vault/searchStatus' ? recordOf(event.data) : null
    if (!status) throw new Error('search status event did not carry a status object')
    expect(status.enabled).toBe(true)
    expect(status.filesIndexed).toBe(sourcePaths.length)
    expect(typeof status.messagesIndexed).toBe('number')
    expect((status.messagesIndexed as number) > 0).toBe(true)
    expect(vault.searchDatabaseExists()).toBe(true)

    const searchable = results(await vault.call<SearchResponse>('search', {
      query: 'vault-fixture-claude-marker',
      freshness: 'wait-until-current',
      filters: { agents: ['claude'] }
    }))
    expect(searchable.hits.length).toBe(1)
    expect(searchable.hits[0]?.agent).toBe('claude')

    const disabledEvent = waitForEvent(vault.client, (candidate) => {
      if (candidate.type !== 'quirky.vault/searchStatus') return false
      const value = recordOf(candidate.data)
      return value?.enabled === false && value.phase === 'closed'
    })
    await vault.client.callAny('setting.set', { id: 'setting:quirky.vault/search-enabled', value: false })
    const disabledEventValue = await disabledEvent
    const disabled = disabledEventValue.type === 'quirky.vault/searchStatus' ? recordOf(disabledEventValue.data) : null
    expect(disabled?.enabled).toBe(false)
    expect(vault.searchDatabaseExists()).toBe(true)

    const confirmation = await vault.client.callAny('quirky.vault/clearSearchIndex', {}).then(
      () => null,
      (error: unknown) => error as { code?: number }
    )
    expect(confirmation?.code).toBe(RpcErrorCode.ConfirmationRequired)
    expect(vault.searchDatabaseExists()).toBe(true)

    const clear = await vault.call<{ cleared: boolean; status: SearchStatus }>('clearSearchIndex', { yes: true })
    expect(clear.cleared).toBe(true)
    expect(clear.status.enabled).toBe(false)
    expect(vault.searchDatabaseExists()).toBe(false)
    expect(vault.fixturePaths.claude !== undefined && existsSync(vault.fixturePaths.claude)).toBe(true)
  })

  test('real Claude records preserve role scope, bounded tool text, long conversation chunks, safe evidence, and query filters', async () => {
    const vault = await start()
    const base = Date.UTC(2026, 9, 1, 12, 0, 0)
    const roleSession = 'flow-claude-role-cap'
    const longUserText = `${'ordinarycontext '.repeat(1_000)} longconversationmarker userrolemarker evidenceword [[spoofed]] \uE0020 \uE0021 \uE0022`
    await writeJsonlFixture(vault.sourceHome, 'claude', roleSession, [
      userRecord(roleSession, '/tmp/vault-flow-alpha', longUserText, base),
      assistantRecord(roleSession, '/tmp/vault-flow-alpha', [
        { type: 'text', text: 'assistantrolemarker' },
        { type: 'tool_use', id: 'terminal-tool', name: 'resolveTerminalPath', input: { path: '/tmp/terminal path vaulttoolonlyquasar' } }
      ], base + 1_000),
      userRecord(roleSession, '/tmp/vault-flow-alpha', [
        { type: 'text', text: 'tool result was returned to the user' },
        { type: 'tool_result', tool_use_id: 'terminal-tool', content: `${'x'.repeat(3_072)} toolcaponlymarker` }
      ], base + 2_000)
    ])

    await writeJsonlFixture(vault.sourceHome, 'claude', 'flow-phrase-alpha', [
      userRecord('flow-phrase-alpha', '/tmp/vault-flow-alpha', 'terminal fix phrase marker', base + 3_000),
      assistantRecord('flow-phrase-alpha', '/tmp/vault-flow-alpha', 'alpha response', base + 4_000)
    ])
    await writeJsonlFixture(vault.sourceHome, 'claude', 'flow-phrase-beta', [
      userRecord('flow-phrase-beta', '/tmp/vault-flow-beta', 'beta investigation', base + 5_000),
      assistantRecord('flow-phrase-beta', '/tmp/vault-flow-beta', 'terminal tool path', base + 6_000)
    ])
    await writeJsonlFixture(vault.sourceHome, 'claude', 'flow-phrase-alpha-two', [
      userRecord('flow-phrase-alpha-two', '/tmp/vault-flow-alpha', 'terminal rebuild route', base + 7_000),
      assistantRecord('flow-phrase-alpha-two', '/tmp/vault-flow-alpha', 'retry response', base + 8_000)
    ])
    await vault.call('setSearchEnabled', { enabled: true })

    const fresh = (query: string, extra: Record<string, unknown> = {}) => vault.call<SearchResponse>('search', {
      query,
      freshness: 'wait-until-current',
      ...extra
    })
    const userHit = results(await fresh('userrolemarker')).hits[0]
    expect(userHit?.evidence?.role).toBe('user')
    const assistantHit = results(await fresh('assistantrolemarker', { scope: 'conversation' })).hits[0]
    expect(assistantHit?.evidence?.role).toBe('assistant')

    const longHit = results(await fresh('longconversationmarker')).hits[0]
    expect(longHit?.sessionId).toBe(roleSession)
    expect(longHit?.evidence?.role).toBe('user')

    const toolHit = results(await fresh('resolveTerminalPath', { scope: 'all' })).hits[0]
    expect(toolHit?.sessionId).toBe(roleSession)
    expect(toolHit?.evidence?.role).toBe('tool')
    const uniqueToolHit = results(await fresh('vaulttoolonlyquasar', { scope: 'all' })).hits[0]
    expect(uniqueToolHit?.sessionId).toBe(roleSession)
    expect(uniqueToolHit?.evidence?.role).toBe('tool')
    expect(results(await fresh('vaulttoolonlyquasar', { scope: 'conversation' })).hits.length).toBe(0)
    expect(results(await fresh('toolcaponlymarker', { scope: 'all' })).hits.length).toBe(0)

    const safeEvidence = results(await fresh('evidenceword')).hits[0]?.evidence?.snippet ?? ''
    expect(safeEvidence.includes('[[evidenceword]]')).toBe(true)
    expect(safeEvidence.includes('[[spoofed]]')).toBe(false)
    expect(safeEvidence.includes('\uE0020spoofed\uE0021')).toBe(true)
    expect(safeEvidence.includes('\uE00220 \uE00221 \uE00222')).toBe(true)

    const phrase = results(await fresh('"terminal fix"'))
    expect(phrase.hits.map((hit) => hit.sessionId)).toEqual(['flow-phrase-alpha'])
    const repaired = results(await fresh('terminl'))
    expect(repaired.repairedTerms?.terminl).toBe('terminal')
    expect(repaired.hits.some((hit) => hit.sessionId === 'flow-phrase-alpha')).toBe(true)
    expect(repaired.hits.some((hit) => hit.sessionId === 'flow-phrase-beta')).toBe(true)

    const alpha = results(await fresh('repo:alpha', { filters: { agents: ['claude'] } }))
    expect(alpha.hits.some((hit) => hit.sessionId === 'flow-phrase-alpha')).toBe(true)
    expect(alpha.hits.every((hit) => hit.cwd === '/tmp/vault-flow-alpha')).toBe(true)
    const beta = results(await fresh('path:beta', { filters: { agents: ['claude'] } }))
    expect(beta.hits.map((hit) => hit.sessionId)).toEqual(['flow-phrase-beta'])

    const filtered = results(await fresh('terminal', {
      filters: {
        agents: ['claude'],
        scopePaths: ['/tmp/vault-flow-beta'],
        since: '2026-10-01T00:00:00Z',
        sort: 'newest'
      }
    }))
    expect(filtered.hits.map((hit) => hit.sessionId)).toEqual(['flow-phrase-beta'])

    const unknown = await fresh('terminal', { within: { worktree: 'not-a-vault-worktree' } })
    expect(unknown.kind).toBe('unavailable')
    if (unknown.kind === 'unavailable') expect(unknown.reason).toBe('scope-unknown')
  })

  test('public cursor pages are deterministic and distinguish malformed query/filter cursors from stale source generations', async () => {
    const vault = await start()
    const base = Date.UTC(2026, 9, 1, 14, 0, 0)
    const paths = new Map<string, string>()
    for (let index = 1; index <= 4; index++) {
      const sessionId = `flow-page-${index}`
      paths.set(sessionId, await writeJsonlFixture(vault.sourceHome, 'claude', sessionId, [
        userRecord(sessionId, '/tmp/vault-pages', `pagequeryneedle independent ${index}`, base + index * 60_000),
        assistantRecord(sessionId, '/tmp/vault-pages', `page answer ${index}`, base + index * 60_000 + 1_000)
      ]))
    }
    await vault.call('setSearchEnabled', { enabled: true })

    const query = 'pagequeryneedle'
    const filters = { agents: ['claude'], sort: 'newest' as const }
    const first = results(await vault.call<SearchResponse>('search', {
      query, freshness: 'wait-until-current', limit: 2, filters
    }))
    const firstCursor = first.page.cursor
    if (!firstCursor) throw new Error('four matching transcripts did not produce a second page')
    const second = results(await vault.call<SearchResponse>('search', {
      query, limit: 2, cursor: firstCursor, filters
    }))
    expect(first.page.hasMore).toBe(true)
    expect(second.page.hasMore).toBe(false)
    const pageIds = [...first.hits, ...second.hits].map((hit) => hit.sessionId)
    expect(pageIds).toEqual(['flow-page-4', 'flow-page-3', 'flow-page-2', 'flow-page-1'])
    expect(new Set(pageIds).size).toBe(pageIds.length)

    const wrongQuery = await vault.call<SearchResponse>('search', {
      query: 'differentpagequery', limit: 2, cursor: firstCursor, filters
    })
    expect(wrongQuery.kind).toBe('malformed-cursor')
    const wrongFilters = await vault.call<SearchResponse>('search', {
      query, limit: 2, cursor: firstCursor,
      filters: { agents: ['claude'], scopePaths: ['/tmp/vault-pages'], sort: 'newest' }
    })
    expect(wrongFilters.kind).toBe('malformed-cursor')

    const changedId = 'flow-page-4'
    const changedPath = paths.get(changedId)
    if (!changedPath) throw new Error(`missing fixture path for ${changedId}`)
    await writeJsonlFixture(vault.sourceHome, 'claude', changedId, [
      userRecord(changedId, '/tmp/vault-pages', 'replacementnewterm', base + 10 * 60_000),
      assistantRecord(changedId, '/tmp/vault-pages', 'updated response', base + 10 * 60_000 + 1_000)
    ])
    const staleAfterWrite = await vault.call<SearchResponse>('search', {
      query, freshness: 'wait-until-current', limit: 2, cursor: firstCursor, filters
    })
    expect(staleAfterWrite.kind).toBe('stale-cursor')
    const oldTerm = results(await vault.call<SearchResponse>('search', {
      query, freshness: 'wait-until-current', filters
    }))
    expect(oldTerm.hits.some((hit) => hit.sessionId === changedId)).toBe(false)
    const newTerm = results(await vault.call<SearchResponse>('search', {
      query: 'replacementnewterm', freshness: 'wait-until-current', filters
    }))
    expect(newTerm.hits.map((hit) => hit.sessionId)).toEqual([changedId])

    const missingId = 'flow-proven-missing-source'
    const missingPath = await writeJsonlFixture(vault.sourceHome, 'claude', missingId, [
      userRecord(missingId, '/tmp/vault-pages', 'missingfilemarker', base + 20 * 60_000)
    ])
    const indexedMissing = results(await vault.call<SearchResponse>('search', {
      query: 'missingfilemarker', freshness: 'wait-until-current', filters
    })).hits[0]
    if (!indexedMissing) throw new Error('missing-source fixture was not indexed before deletion')
    rmSync(missingPath)
    const missingHit = results(await vault.call<SearchResponse>('search', {
      query: 'missingfilemarker', freshness: 'indexed', filters
    })).hits[0]
    expect(missingHit?.source.presence).toBe('missing')
    const resumeFailure = await vault.client.callAny('quirky.vault/prepareResume', { id: indexedMissing.id }).then(
      () => null,
      (error: unknown) => error as { code?: number }
    )
    expect(resumeFailure?.code).toBe(RpcErrorCode.Conflict)
    expect(existsSync(missingPath)).toBe(false)
    const swept = results(await vault.call<SearchResponse>('search', {
      query: 'missingfilemarker', freshness: 'wait-until-current', filters
    }))
    expect(swept.hits.length).toBe(0)
  }, 30_000)

  test('API retention removes old derived content only and an unavailable source root retains recent indexed data', async () => {
    const vault = await start({ includeEveryAgentFixture: false })
    const oldId = 'flow-retained-expired-source'
    const oldTime = new Date('2000-01-01T00:00:00.000Z')
    const oldPath = await writeJsonlFixture(vault.sourceHome, 'claude', oldId, [
      userRecord(oldId, '/tmp/vault-retention', 'retentionoldmarker', oldTime.getTime())
    ])
    utimesSync(oldPath, oldTime, oldTime)
    const recentId = 'flow-retained-root-source'
    await writeJsonlFixture(vault.sourceHome, 'claude', recentId, [
      userRecord(recentId, '/tmp/vault-retention', 'rootavailabilitymarker', Date.UTC(2026, 9, 1, 12, 0, 0))
    ])
    await vault.call('setSearchEnabled', { enabled: true })

    const initiallyIndexed = results(await vault.call<SearchResponse>('search', {
      query: 'retentionoldmarker', freshness: 'wait-until-current', filters: { agents: ['claude'] }
    }))
    expect(initiallyIndexed.hits.map((hit) => hit.sessionId)).toEqual([oldId])

    await vault.call('setSearchEnabled', { enabled: true, historyDays: 1 })
    const expired = results(await vault.call<SearchResponse>('search', {
      query: 'retentionoldmarker', freshness: 'wait-until-current', filters: { agents: ['claude'] }
    }))
    expect(expired.hits.length).toBe(0)
    expect(existsSync(oldPath)).toBe(true)

    const rootPath = join(vault.sourceHome, '.claude', 'projects')
    const movedPath = `${rootPath}.temporarily-unavailable`
    renameSync(rootPath, movedPath)
    try {
      const retained = results(await vault.call<SearchResponse>('search', {
        query: 'rootavailabilitymarker', freshness: 'wait-until-current', filters: { agents: ['claude'] }
      }))
      expect(retained.hits.map((hit) => hit.sessionId)).toEqual([recentId])
      expect(retained.hits[0]?.source.presence).toBe('unverifiable')
      const status = await vault.call<PublicStatus>('searchStatus', {})
      expect(status.status.phase).toBe('degraded')
      expect(status.status.filesIndexed > 0).toBe(true)
      expect(status.status.degradedRoots.some((root) => root.root === rootPath)).toBe(true)
    } finally {
      renameSync(movedPath, rootPath)
    }
  })

  test('first prompt and supported Claude child actions resolve the selected transcript', async () => {
    const vault = await start()
    const { worktreeSessionId } = await writeScopeFixture(vault.sourceHome, 0)
    const firstPrompt = `${'Please inspect this supported session carefully. '.repeat(280)} unique-full-prompt-ending`
    const parentPath = await writeJsonlFixture(vault.sourceHome, 'claude', worktreeSessionId, [
      userRecord(worktreeSessionId, '/tmp/vault-worktree', firstPrompt, Date.UTC(2026, 9, 1, 10, 0, 0)),
      assistantRecord(worktreeSessionId, '/tmp/vault-worktree', 'Parent response turn', Date.UTC(2026, 9, 1, 10, 0, 1))
    ])
    const childPath = join(vault.sourceHome, '.claude', 'projects', 'project', worktreeSessionId, 'subagents', 'agent-scope.jsonl')
    writeFileSync(childPath, [
      JSON.stringify(userRecord('agent-child-session-identity', '/tmp/vault-worktree', 'Child task marker', Date.UTC(2026, 9, 1, 10, 0, 2))),
      JSON.stringify(assistantRecord('agent-child-session-identity', '/tmp/vault-worktree', 'Child response marker', Date.UTC(2026, 9, 1, 10, 0, 3)))
    ].join('\n') + '\n')

    const listed = await vault.call<PublicListResult>('list', { host: 'local', agents: ['claude'], unlimited: true })
    const parent = listed.sessions.find((session) => session.sessionId === worktreeSessionId)
    if (!parent) throw new Error('supported Claude parent transcript was not listed')
    expect(parent.source.filePath).toBe(parentPath)
    expect(parent.subagentTranscriptCount).toBe(1)
    const prompt = await vault.call<{ prompt: string | null }>('firstPrompt', { id: parent.id })
    expect(prompt.prompt).toBe(firstPrompt)

    const children = await vault.call<HostedSession[]>('subagents', { id: parent.id })
    expect(children.length).toBe(1)
    const child = children[0]
    if (!child) throw new Error('supported child transcript was not discovered')
    expect(child.agent).toBe('claude')
    expect(child.sessionId).toBe('agent-child-session-identity')
    expect(child.subagent).toBe(true)
    expect(child.previewMessages.some((message) => message.text === 'Child response marker')).toBe(true)
    expect(child.id === parent.id).toBe(false)
    expect(child.source.filePath).toBe(childPath)

    const previousOpenLog = process.env.QUIRKY_TEST_OPEN_LOG
    const openLog = join(vault.home, 'selected-source-open.jsonl')
    process.env.QUIRKY_TEST_OPEN_LOG = openLog
    try {
      const childMetadata = await vault.call<HostedSession | null>('get', { id: child.id })
      expect(childMetadata?.sessionId).toBe('agent-child-session-identity')
      expect(childMetadata?.source.filePath).toBe(childPath)
      const opening = await vault.client.callAny('quirky.vault/openSource', { id: child.id, mode: 'open' }).then(
        (value: unknown) => ({ value: value as { ok?: boolean } }),
        (error: unknown) => ({ error })
      )
      expect('error' in opening).toBe(false)
      if ('value' in opening) expect(opening.value.ok).toBe(true)
      const opened = existsSync(openLog) ? readFileSync(openLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { target: string; reveal: boolean }) : []
      expect(opened).toEqual([{ target: childPath, reveal: false }])
    } finally {
      if (previousOpenLog === undefined) delete process.env.QUIRKY_TEST_OPEN_LOG
      else process.env.QUIRKY_TEST_OPEN_LOG = previousOpenLog
    }
  })

  test('real host contributions preserve identity, expose partial availability, redact remote paths, and fail honestly', async () => {
    const remote = await start({ isolateVaultPlugin: true })
    await remote.call('setSearchEnabled', { enabled: true })
    const remoteSearch = results(await remote.call<SearchResponse>('search', {
      query: 'vault-fixture-claude-marker', freshness: 'wait-until-current', filters: { agents: ['claude'] }
    }))
    expect(remoteSearch.hits.some((hit) => hit.sessionId === 'claude-fixture-session')).toBe(true)

    const local = await start({ isolateVaultPlugin: true })
    const forwarder = createVaultHostForwarder(rpcUrl(remote.h.runtime))
    pluginRoots.push(forwarder.root)
    await local.client.callAny('plugin.install', { path: forwarder.directory, yes: true })
    const contributions = await local.client.callAny('plugin.contributions', { kind: 'vault-host' }) as { id: string; plugin: string; data: Record<string, unknown> }[]
    const contribution = contributions.find((item) => item.plugin === 'test.vault-forwarder')
    if (!contribution) throw new Error('installed public host contribution was not effective')
    const remoteHostId = contribution.id
    expect(contribution.data.methodPrefix).toBe('test.vault-forwarder')

    const allSessions = await local.call<PublicListResult>('list', {
      host: 'all', agents: ['claude'], unlimited: true
    })
    const matchingProviderIds = allSessions.sessions.filter((session) => session.agent === 'claude' && session.sessionId === 'claude-fixture-session')
    const localOnly = await local.call<PublicListResult>('list', {
      host: 'local', agents: ['claude'], unlimited: true
    })
    expect(localOnly.sessions.filter((session) => session.sessionId === 'claude-fixture-session').map((session) => session.hostId)).toEqual(['local'])
    expect(localOnly.hosts.map((host) => host.hostId)).toEqual(['local'])

    expect(matchingProviderIds.length).toBe(2)
    const localSession = matchingProviderIds.find((session) => session.hostId === 'local')
    const remoteSession = matchingProviderIds.find((session) => session.hostId === remoteHostId)
    if (!localSession || !remoteSession) throw new Error('host-qualified list omitted one copy of the shared provider identity')
    expect(localSession.id === remoteSession.id).toBe(false)
    expect(remoteSession.source.presence).toBe('present')
    expect(Object.keys(remoteSession.source).sort()).toEqual(['presence'])
    expect(Object.hasOwn(remoteSession, 'filePath')).toBe(false)
    expect(Object.hasOwn(remoteSession, 'codexHome')).toBe(false)
    expect(allSessions.hosts.some((host) => host.hostId === remoteHostId && host.kind === 'ok')).toBe(true)

    const partial = results(await local.call<SearchResponse>('search', {
      host: 'all', query: 'vault-fixture-claude-marker', freshness: 'wait-until-current', filters: { agents: ['claude'] }
    }))
    const remoteHit = partial.hits.find((hit) => hit.hostId === remoteHostId && hit.sessionId === 'claude-fixture-session')
    if (!remoteHit) throw new Error('all-host search did not preserve the remote match identity')
    expect(remoteHit.source.presence).toBe('present')
    expect(Object.keys(remoteHit.source).sort()).toEqual(['presence'])
    expect(Object.hasOwn(remoteHit, 'resumeCommand')).toBe(false)
    expect(partial.hosts?.some((host) => host.hostId === 'local' && host.kind === 'unavailable' && host.reason === 'disabled')).toBe(true)
    expect(partial.hosts?.some((host) => host.hostId === remoteHostId && host.kind === 'ok')).toBe(true)

    const unknown = await local.call<SearchResponse>('search', {
      host: 'all', query: 'vault-fixture-claude-marker', within: { worktree: 'host-forwarder-missing-worktree' }
    })
    expect(unknown.kind).toBe('unavailable')
    if (unknown.kind === 'unavailable') expect(unknown.reason).toBe('scope-unknown')

    const remoteProjects = join(remote.sourceHome, '.claude', 'projects')
    const movedProjects = `${remoteProjects}.temporarily-unavailable`
    renameSync(remoteProjects, movedProjects)
    try {
      const availableDespiteRootMove = results(await local.call<SearchResponse>('search', {
        host: remoteHostId,
        query: 'vault-fixture-claude-marker',
        freshness: 'wait-until-current',
        filters: { agents: ['claude'] }
      }))
      expect(availableDespiteRootMove.hits.some((hit) => hit.sessionId === 'claude-fixture-session')).toBe(true)
      const remoteStatus = await local.call<PublicStatus>('searchStatus', { host: remoteHostId })
      expect(remoteStatus.status.enabled).toBe(true)
      expect(remoteStatus.status.phase).toBe('degraded')
      expect(remoteStatus.status.degradedRoots.length > 0).toBe(true)
      expect(remoteStatus.status.degradedRoots.some((root) => root.root?.startsWith(remote.sourceHome))).toBe(false)
    } finally {
      renameSync(movedProjects, remoteProjects)
    }
    await remote.call('setSearchEnabled', { enabled: false })
    const enabledAll = await local.call<PublicStatus>('setSearchEnabled', { enabled: true, host: 'all' })
    expect(enabledAll.hosts.map((host) => host.hostId)).toEqual(['local', remoteHostId])
    expect(enabledAll.hosts.every((host) => host.kind === 'ok')).toBe(true)
    expect((await local.call<PublicStatus>('searchStatus', { host: 'local' })).status.enabled).toBe(true)
    expect((await local.call<PublicStatus>('searchStatus', { host: remoteHostId })).status.enabled).toBe(true)
    const webClient = await local.h.connect('ui')
    const webDisabled = await webClient.callAny('quirky.vault/setSearchEnabled', { enabled: false, host: 'local' }) as PublicStatus
    expect(webDisabled.status.enabled).toBe(false)
    const webEnabled = await webClient.callAny('quirky.vault/setSearchEnabled', { enabled: true, host: 'local' }) as PublicStatus
    expect(webEnabled.status.enabled).toBe(true)
    const disabledAgain = await webClient.callAny('quirky.vault/setSearchEnabled', { enabled: false, host: 'local' }) as PublicStatus
    expect(disabledAgain.status.enabled).toBe(false)



    await remote.client.callAny('plugin.disable', { id: 'quirky.vault' })
    await local.call('setSearchEnabled', { enabled: true, host: 'local' })

    const survivingLocalSearch = results(await local.call<SearchResponse>('search', {
      host: 'local',
      query: 'vault-fixture-claude-marker',
      freshness: 'wait-until-current',
      filters: { agents: ['claude'] }
    }))
    const survivingLocalHit = survivingLocalSearch.hits.find((hit) => hit.sessionId === 'claude-fixture-session')
    if (!survivingLocalHit) throw new Error('local vault stopped serving its source after the remote vault was disabled')
    expect(survivingLocalHit.source.filePath).toBe(local.fixturePaths.claude)
    const partialAll = await local.call<PublicListResult>('list', {
      host: 'all', agents: ['claude'], unlimited: true
    })
    expect(partialAll.sessions.some((session) => session.hostId === 'local')).toBe(true)
    const failedRemote = partialAll.hosts.find((host) => host.hostId === remoteHostId)
    expect(failedRemote?.kind).toBe('error')
    expect(failedRemote?.reason?.includes(remote.sourceHome)).toBe(false)
    const unavailableList = await local.call<PublicListResult>('list', {
      host: remoteHostId, agents: ['claude'], unlimited: true
    })
    expect(unavailableList.sessions.length).toBe(0)
    const unavailableListHost = unavailableList.hosts.find((host) => host.hostId === remoteHostId)
    expect(unavailableListHost?.kind).toBe('error')
    expect(typeof unavailableListHost?.reason).toBe('string')
    expect((unavailableListHost?.reason?.length ?? 0) > 0).toBe(true)

    const unavailableSearch = await local.call<SearchResponse>('search', {
      host: remoteHostId, query: 'vault-fixture-claude-marker', filters: { agents: ['claude'] }
    })
    expect(unavailableSearch.kind).toBe('unavailable')
    if (unavailableSearch.kind === 'unavailable') expect(unavailableSearch.reason).toBe('no-service')
    expect(unavailableSearch.hosts?.some((host) => host.hostId === remoteHostId && host.kind === 'error')).toBe(true)
  })
})
