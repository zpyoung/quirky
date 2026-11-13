import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode, type PluginStore, type QuirkyClient, type Repo, type RpcError, type Worktree } from '@quirky/protocol'
import { makeTempDir } from '../../../packages/daemon/test/plugins/fixtures'
import { waitFor } from '../../../packages/daemon/test/helpers'
import { PtyClient } from '../../../packages/daemon/src/pty-client'
import type { CallerIdentity } from '../selector'
import { startPluginHarness, type PluginHarness } from '../../quirky.repo/test/harness'
import { addFakeRepo, fakeRegistrations } from './fixtures/fake-git'
import { listReferences, unlinkReference, type RecordEnv } from '../src/daemon/records'
import type { WorktreeControl } from '../src/control-types'
import { filesystemIdentitySource } from '../src/daemon/identity'
import type { WorktreeRow } from '../src/daemon/store'
import type { GitHubWorktreeLink, PtySessionInfo } from '@quirky/protocol'
import type { ReferenceSearchResult, WorktreeReference } from '../src/parity-types'
import {
  findReferences,
  parseReferenceQuery,
  readStoredWorktrees,
  referenceItemOf,
  searchReferences,
  sessionLiveness,
  type ReferenceSearchEnv,
  type StoredWorktree
} from '../src/daemon/reference-search'

const ref = (id: string, url: string, label = id, createdAt = 1): WorktreeReference => ({ id, url, label, createdAt })

function storedWorktree(
  id: string,
  options: Partial<StoredWorktree> & Pick<StoredWorktree, 'references'>
): StoredWorktree {
  return {
    id,
    repoId: 'alpha',
    name: id,
    path: `/workspaces/${id}`,
    kind: 'git',
    archivedAt: null,
    lastActivityAt: 0,
    state: 'present',
    staleReason: null,
    linkedPR: null,
    linkedIssue: null,
    ...options
  }
}

const githubIssue: GitHubWorktreeLink = {
  provider: 'github',
  kind: 'issue',
  number: 7,
  title: 'Seven',
  url: 'https://github.com/acme/api/issues/7',
  repository: { host: 'github.com', owner: 'acme', repo: 'api' }
}

const world = [
  storedWorktree('wt-a', {
    lastActivityAt: 300,
    references: [
      ref('ref-pr', 'https://github.com/acme/api/pull/5123', 'PR 5123'),
      ref('ref-app', 'https://tracker.example/issues/42', 'APP-42')
    ]
  }),
  storedWorktree('wt-b', {
    lastActivityAt: 200,
    references: [ref('ref-gitlab', 'https://gitlab.com/acme/api/-/issues/5123')],
    linkedIssue: githubIssue
  }),
  storedWorktree('wt-c', {
    lastActivityAt: 100,
    archivedAt: 123,
    references: [ref('ref-comment', 'https://github.com/acme/api/issues/5123#issuecomment-9')]
  })
]

function session(
  id: string,
  worktreeId: string,
  status: string,
  options: { kind?: string; lastActivityAt?: number; name?: string | null; title?: string; agent?: string } = {}
) {
  return {
    id,
    worktreeId,
    kind: options.kind ?? 'terminal',
    agent: options.agent ?? 'claude',
    name: options.name ?? null,
    title: options.title ?? id,
    status,
    lastActivityAt: options.lastActivityAt ?? 1
  }
}

function pty(sessionId: string, overrides: Partial<PtySessionInfo> = {}): PtySessionInfo {
  return {
    sessionId,
    state: 'running',
    pid: 1,
    alive: true,
    exitCode: null,
    exitSignal: null,
    exitCause: null,
    cols: 80,
    rows: 24,
    argv: [],
    cwd: '/',
    title: null,
    shellState: {} as PtySessionInfo['shellState'],
    createdAt: 0,
    offset: 0,
    ...overrides
  }
}

function search(
  query: string,
  worktrees: StoredWorktree[] = world,
  options: {
    includeArchived?: boolean
    limit?: number
    sessions?: { rows: unknown[] } | { error: string }
    processes?: { rows: PtySessionInfo[] } | { error: string }
  } = {}
) {
  return searchReferences({
    query: parseReferenceQuery(query),
    worktrees,
    includeArchived: options.includeArchived ?? false,
    limit: options.limit ?? 50,
    sessions: options.sessions ?? { rows: [] },
    processes: options.processes ?? { rows: [] }
  })
}

describe('reference query parsing', () => {
  test('normalizes URL host and identifies a review item without changing the path case', () => {
    expect(parseReferenceQuery('https://GitHub.com/Acme/API/pull/5123/files#diff-1')).toEqual({
      kind: 'url',
      url: 'https://github.com/Acme/API/pull/5123/files#diff-1',
      item: 'github.com/acme/api#5123'
    })
    expect(referenceItemOf('https://GitHub.com/Acme/API/pull/5123/files#diff-1')).toEqual({
      id: 'github.com/acme/api#5123',
      host: 'github.com',
      project: 'acme/api',
      sigil: '#',
      number: 5123
    })
  })

  test('canonicalizes keys and supports GitLab subgroup merge request keys', () => {
    expect(parseReferenceQuery('Acme/API#5123')).toEqual({ kind: 'key', key: 'acme/api#5123' })
    expect(parseReferenceQuery('group/sub/project!45')).toEqual({ kind: 'key', key: 'group/sub/project!45' })
  })

  test('recognizes issue and merge request URL variants on arbitrary hosts', () => {
    expect(referenceItemOf('https://github.example/acme/api/issues/7')).toMatchObject({
      id: 'github.example/acme/api#7', sigil: '#', project: 'acme/api', number: 7
    })
    expect(referenceItemOf('https://gitlab.example.com/group/sub/project/-/merge_requests/45/diffs')).toMatchObject({
      id: 'gitlab.example.com/group/sub/project!45', sigil: '!', project: 'group/sub/project', number: 45
    })
    expect(referenceItemOf('https://gitlab.example.com/group/sub/project/merge_requests/45')).toMatchObject({
      id: 'gitlab.example.com/group/sub/project!45', sigil: '!', project: 'group/sub/project', number: 45
    })
  })

  test('rejects malformed keys and overlong or non-string queries with an owner/repo example', () => {
    for (const value of [
      '', '   ', '5', '#5', 'acme#5', 'acme/api#0', 'acme/api#05', 'acme/api#5#6',
      'a/../b#5', 'a/-/b#5', 'acme/api #5', 'STA-1234', 'acme/api#9007199254740993',
      'x'.repeat(2_049), 17
    ]) {
      expect(() => parseReferenceQuery(value)).toThrow(/owner\/repo#123/)
    }
  })

  test('rejects non-HTTP URL schemes with an HTTP or HTTPS example', () => {
    for (const value of ['ftp://x/y', 'javascript:alert(1)', 'http://']) {
      expect(() => parseReferenceQuery(value)).toThrow(/HTTP or HTTPS/)
    }
  })

  test('leaves shapes that are not review or issue items as plain URLs', () => {
    for (const url of [
      'https://github.com/acme/api/pull/07',
      'https://github.com//acme/api/pull/7',
      'https://github.com/acme/api/pulls/7',
      'https://github.com/acme/pull/7',
      'https://github.com/acme/api/pull/9007199254740993'
    ]) {
      expect(parseReferenceQuery(url)).toMatchObject({ kind: 'url', item: null })
      expect(referenceItemOf(url)).toBeNull()
    }
  })
})

describe('pure reference matching', () => {
  test('URL item query matches the same host/project/number and reports the stored manual link', () => {
    const result = search('https://GitHub.com/Acme/API/pull/5123/files#diff-1')
    expect(result).toMatchObject({
      query: { kind: 'url', url: 'https://github.com/Acme/API/pull/5123/files#diff-1', item: 'github.com/acme/api#5123' },
      items: [{ id: 'github.com/acme/api#5123', host: 'github.com', project: 'acme/api', sigil: '#', number: 5123 }],
      ambiguous: false,
      total: 1,
      archivedOmitted: 1,
      truncated: false,
      matches: [{
        worktree: { id: 'wt-a', state: 'present', staleReason: null },
        links: [{ source: 'reference', referenceId: 'ref-pr', url: 'https://github.com/acme/api/pull/5123', label: 'PR 5123', item: 'github.com/acme/api#5123' }]
      }]
    })
    expect(result.matches[0]?.worktree).not.toHaveProperty('branch')
  })

  test('issue URL matches a pull request and an archived issue with the shared number space', () => {
    const result = search('https://github.com/acme/api/issues/5123', world, { includeArchived: true })
    expect(result.matches.map(({ worktree }) => worktree.id)).toEqual(['wt-a', 'wt-c'])
    expect(result.total).toBe(2)
    expect(result.archivedOmitted).toBe(0)
    expect(result.matches[1]?.links[0]?.url).toBe('https://github.com/acme/api/issues/5123#issuecomment-9')
  })

  test('key query returns same-number items from different hosts and marks ambiguity', () => {
    const result = search('acme/api#5123')
    expect(result).toMatchObject({
      query: { kind: 'key', key: 'acme/api#5123' },
      items: [
        { id: 'github.com/acme/api#5123', host: 'github.com', project: 'acme/api', sigil: '#', number: 5123 },
        { id: 'gitlab.com/acme/api#5123', host: 'gitlab.com', project: 'acme/api', sigil: '#', number: 5123 }
      ],
      ambiguous: true,
      total: 2,
      archivedOmitted: 1
    })
    expect(result.matches.map(({ worktree }) => worktree.id)).toEqual(['wt-a', 'wt-b'])
    expect(result.matches.flatMap(({ links }) => links.map(({ item }) => item))).toEqual([
      'github.com/acme/api#5123', 'gitlab.com/acme/api#5123'
    ])
  })
  test('returns items in canonical order when GitLab is encountered first', () => {
    const result = search('acme/api#5123', [world[1]!, world[0]!])
    expect(result.items.map(({ id }) => id)).toEqual([
      'github.com/acme/api#5123',
      'gitlab.com/acme/api#5123'
    ])
  })


  test('case-insensitive project keys return the same canonical query and matches', () => {
    const result = search('Acme/API#5123')
    expect(result.query).toEqual({ kind: 'key', key: 'acme/api#5123' })
    expect(result.matches.map(({ worktree }) => worktree.id)).toEqual(['wt-a', 'wt-b'])
  })

  test('merge request keys match both GitLab URL forms but issue keys do not', () => {
    const matches = [
      storedWorktree('mr-diffs', { references: [ref('diff', 'https://gitlab.example.com/group/sub/project/-/merge_requests/45/diffs')] }),
      storedWorktree('mr-short', { references: [ref('short', 'https://gitlab.example.com/group/sub/project/merge_requests/45')] })
    ]
    const merge = search('group/sub/project!45', matches)
    expect(merge.matches.map(({ worktree }) => worktree.id)).toEqual(['mr-diffs', 'mr-short'])
    expect(merge.matches.flatMap(({ links }) => links.map(({ item }) => item))).toEqual([
      'gitlab.example.com/group/sub/project!45', 'gitlab.example.com/group/sub/project!45'
    ])
    expect(merge.ambiguous).toBe(false)
    expect(search('group/sub/project#45', matches).matches).toEqual([])
  })

  test('structured linked issues and pull requests count as stored links', () => {
    const issue = search('acme/api#7')
    expect(issue.matches).toMatchObject([{
      worktree: { id: 'wt-b' },
      links: [{ source: 'linkedIssue', referenceId: null, url: 'https://github.com/acme/api/issues/7', label: 'Seven', item: 'github.com/acme/api#7' }]
    }])
    const pull = { ...githubIssue, kind: 'pullRequest' as const, number: 45, title: 'Review', url: 'https://github.com/acme/api/pull/45' }
    const pullResult = search('acme/api#45', [storedWorktree('linked-pr', { references: [], linkedPR: pull })])
    expect(pullResult.matches[0]?.links[0]).toMatchObject({ source: 'linkedPR', referenceId: null, label: 'Review' })
  })

  test('plain URL comparison ignores scheme, credentials, fragment and trailing slashes only', () => {
    const references = [ref('tracker', 'https://tracker.example/issues/42', 'APP-42')]
    const matching = search('http://person:secret@tracker.example/issues/42/#note', [storedWorktree('tracked', { references })])
    expect(matching.query).toMatchObject({ kind: 'url', item: null })
    expect(matching.matches[0]?.links[0]?.url).toBe('https://tracker.example/issues/42')
    expect(search('https://tracker.example/issues/42?x=1', [storedWorktree('tracked', { references })]).matches).toEqual([])
    expect(search('https://tracker.example/Issues/42', [storedWorktree('tracked', { references })]).matches).toEqual([])
  })

  test('a key with no matching stored link returns an empty non-truncated result', () => {
    expect(search('nobody/nothing#1')).toMatchObject({
      matches: [], items: [], total: 0, truncated: false, ambiguous: false
    })
  })

  test('archive omission is counted, and an explicit archived-only search remains empty by default', () => {
    const archivedOnly = world.filter(({ id }) => id === 'wt-c')
    expect(search('acme/api#5123', archivedOnly)).toMatchObject({ matches: [], total: 0, archivedOmitted: 1 })
    expect(search('acme/api#5123', archivedOnly, { includeArchived: true }).matches.map(({ worktree }) => worktree.id)).toEqual(['wt-c'])
  })

  test('orders shuffled worktree candidates by activity then ID before capping, including stale rows', () => {
    const worktrees = [
      storedWorktree('wt-z', {
        lastActivityAt: 100,
        references: [ref('z', 'https://github.com/acme/api/issues/5123')]
      }),
      storedWorktree('wt-c', {
        lastActivityAt: 200,
        state: 'stale',
        staleReason: 'folder-missing',
        references: [ref('c', 'https://github.com/acme/api/issues/5123')]
      }),
      storedWorktree('wt-a', {
        lastActivityAt: 100,
        references: [ref('a', 'https://github.com/acme/api/issues/5123')]
      }),
      storedWorktree('wt-b', {
        lastActivityAt: 200,
        references: [ref('b', 'https://github.com/acme/api/issues/5123')]
      })
    ]
    const result = search('acme/api#5123', worktrees, { limit: 3 })
    expect(result.matches.map(({ worktree }) => worktree.id)).toEqual(['wt-b', 'wt-c', 'wt-a'])
    expect(result).toMatchObject({ total: 4, truncated: true, stale: 1 })
  })

  test('caps links and returns the top twenty of scrambled sessions by liveness, activity, then ID', () => {
    const manyLinks = Array.from({ length: 25 }, (_, index) => ref(`ref-${index}`, `https://github.com/acme/api/issues/5#${index}`))
    const rankedSession = (id: string, status: string, lastActivityAt: number, kind = 'terminal') =>
      session(id, 'many', status, { kind, lastActivityAt })
    const manySessions = [
      rankedSession('exit-oldest', 'exited', 10),
      rankedSession('unknown-tie-z', 'running', 500),
      rankedSession('live-oldest', 'working', 100, 'structured'),
      rankedSession('exit-tie-z', 'exited', 900),
      rankedSession('unknown-oldest', 'running', 100),
      rankedSession('live-tie-z', 'working', 400, 'structured'),
      rankedSession('exit-500', 'exited', 500),
      rankedSession('unknown-tie-a', 'running', 500),
      rankedSession('live-newest', 'working', 800, 'structured'),
      rankedSession('exit-newest', 'exited', 1_000),
      rankedSession('unknown-700', 'running', 700),
      rankedSession('live-tie-a', 'working', 400, 'structured'),
      rankedSession('exit-tie-a', 'exited', 900),
      rankedSession('unknown-200', 'running', 200),
      rankedSession('exit-800', 'exited', 800),
      rankedSession('unknown-300', 'running', 300),
      rankedSession('exit-400', 'exited', 400),
      rankedSession('unknown-400', 'running', 400),
      rankedSession('exit-600', 'exited', 600),
      rankedSession('exit-300', 'exited', 300),
      rankedSession('exit-200', 'exited', 200),
      rankedSession('exit-100', 'exited', 100),
      rankedSession('unknown-lower', 'running', 50)
    ]
    const result = search('acme/api#5', [storedWorktree('many', { references: manyLinks })], {
      sessions: { rows: manySessions },
      processes: { rows: [] }
    })
    expect(result.matches[0]?.links.map(({ referenceId }) => referenceId)).toEqual(manyLinks.slice(0, 20).map(({ id }) => id))
    expect(result.matches[0]).toMatchObject({ linkTotal: 25, sessionTotal: 23 })
    expect(result.matches[0]?.sessions?.map(({ id }) => id)).toEqual([
      'live-newest', 'live-tie-a', 'live-tie-z', 'live-oldest',
      'unknown-700', 'unknown-tie-a', 'unknown-tie-z', 'unknown-400',
      'unknown-300', 'unknown-200', 'unknown-oldest', 'unknown-lower',
      'exit-newest', 'exit-tie-a', 'exit-tie-z', 'exit-800',
      'exit-600', 'exit-500', 'exit-400', 'exit-300'
    ])
  })


  test('returns sessions sorted by liveness, with listed evidence and no inferred reference ownership', () => {
    const result = search('https://github.com/acme/api/pull/5123', world, {
      sessions: { rows: [
        session('s1', 'wt-a', 'working', { lastActivityAt: 3, agent: 'claude' }),
        session('s2', 'wt-a', 'running', { lastActivityAt: 2, agent: 'shell' }),
        session('s3', 'wt-a', 'exited', { lastActivityAt: 1, agent: 'codex' })
      ] },
      processes: { rows: [pty('s1')] }
    })
    expect(result.matches[0]?.sessions).toMatchObject([
      { id: 's1', liveness: 'live', linked: false, status: 'working', agent: 'claude' },
      { id: 's2', liveness: 'unverifiable', linked: false, status: 'running', agent: 'shell' },
      { id: 's3', liveness: 'exited', linked: false, status: 'exited', agent: 'codex' }
    ])
    expect(result.matches[0]?.sessions?.map(({ id }) => id)).toEqual(['s1', 's2', 's3'])
    expect(result.evidence).toEqual({ sessions: 'listed', sessionsReason: null, processes: 'listed', processesReason: null, skippedSessions: 0 })
  })

  test('marks terminal sessions unverifiable when the PTY host is unavailable', () => {
    const result = search('https://github.com/acme/api/pull/5123', world, {
      sessions: { rows: [session('s1', 'wt-a', 'working'), session('s2', 'wt-a', 'running'), session('s3', 'wt-a', 'exited')] },
      processes: { error: 'host down' }
    })
    expect(result.matches[0]?.sessions?.map(({ id, liveness }) => [id, liveness])).toEqual([
      ['s1', 'unverifiable'], ['s2', 'unverifiable'], ['s3', 'exited']
    ])
    expect(result.evidence.processes).toBe('unavailable')
    expect(result.evidence.processesReason).toContain('host down')
  })

  test('keeps matches when session listing is unavailable and marks each session list unknown', () => {
    const result = search('https://github.com/acme/api/pull/5123', world, {
      sessions: { error: 'method not found' },
      processes: { rows: [] }
    })
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]).toMatchObject({ sessions: null, sessionTotal: null })
    expect(result.evidence).toMatchObject({ sessions: 'unavailable', sessionsReason: 'method not found' })
  })

  test('counts malformed session entries in evidence without returning them', () => {
    const result = search('https://github.com/acme/api/pull/5123', world, {
      sessions: { rows: [session('valid', 'wt-a', 'working'), { worktreeId: 'wt-a' }, { id: 'no-worktree' }] },
      processes: { rows: [pty('valid')] }
    })
    expect(result.matches[0]?.sessions?.map(({ id }) => id)).toEqual(['valid'])
    expect(result.evidence.skippedSessions).toBe(2)
  })

  test('stale matches remain in activity order and stale counts only returned rows', () => {
    const worktrees = [
      storedWorktree('stale-newest', { references: [ref('a', 'https://github.com/acme/api/issues/5')], lastActivityAt: 3, state: 'stale', staleReason: 'folder-missing' }),
      storedWorktree('stale-middle', { references: [ref('b', 'https://github.com/acme/api/issues/5')], lastActivityAt: 2, state: 'stale', staleReason: 'project-unregistered' }),
      storedWorktree('present-oldest', { references: [ref('c', 'https://github.com/acme/api/issues/5')], lastActivityAt: 1 })
    ]
    expect(search('acme/api#5', worktrees, { limit: 1 })).toMatchObject({
      matches: [{ worktree: { id: 'stale-newest', state: 'stale' } }],
      total: 3,
      truncated: true,
      stale: 1
    })
  })
})

describe('session liveness', () => {
  test('uses the record status, kind and PTY evidence conservatively', () => {
    expect(sessionLiveness({ id: 's', kind: 'terminal', status: 'exited' }, [pty('s')])).toBe('exited')
    for (const status of ['starting', 'running', 'working', 'waiting', 'done']) {
      expect(sessionLiveness({ id: 's', kind: 'terminal', status }, [pty('s')])).toBe('live')
      expect(sessionLiveness({ id: 's', kind: 'structured', status }, [])).toBe('live')
    }
    expect(sessionLiveness({ id: 's', kind: 'terminal', status: 'running' }, null)).toBe('unverifiable')
    expect(sessionLiveness({ id: 's', kind: 'terminal', status: 'running' }, [pty('s', { state: 'restorable' })])).toBe('unverifiable')
    expect(sessionLiveness({ id: 's', kind: 'terminal', status: 'running' }, [pty('s', { state: 'exited' })])).toBe('unverifiable')
    expect(sessionLiveness({ id: 's', kind: 'terminal', status: 'running' }, [pty('s', { alive: false })])).toBe('unverifiable')
    expect(sessionLiveness({ id: 's', kind: 'terminal', status: 'unknown' }, [pty('s')])).toBe('unverifiable')
    expect(sessionLiveness({ id: 's', kind: 'unknown', status: 'working' }, [pty('s')])).toBe('unverifiable')
    expect(sessionLiveness({ id: 's', kind: 'structured', status: 'exited' }, [])).toBe('exited')
  })
})
let unlinkHarness: PluginHarness | undefined
afterEach(async () => {
  await unlinkHarness?.cleanup()
  unlinkHarness = undefined
})

const daemonCall = (client: QuirkyClient, method: string, params: Record<string, unknown> = {}) =>
  client.callAny(method, params)

async function unlinkWorld() {
  unlinkHarness = await startPluginHarness()
  fakeRegistrations(unlinkHarness.git!)
  const repo = await daemonCall(
    unlinkHarness.client,
    'quirky.repo/add',
    { path: addFakeRepo(unlinkHarness.git!, 'api') }
  ) as Repo
  const worktrees = await daemonCall(unlinkHarness.client, 'quirky.worktree/list', { repo: repo.id }) as Worktree[]
  const worktree = worktrees[0]!
  const pull = await daemonCall(unlinkHarness.client, 'quirky.worktree/linkReference', {
    worktree: worktree.id,
    url: 'https://github.com/acme/api/pull/5123',
    label: 'PR 5123'
  }) as WorktreeReference
  const tracker = await daemonCall(unlinkHarness.client, 'quirky.worktree/linkReference', {
    worktree: worktree.id,
    url: 'https://tracker.example/issues/42',
    label: 'APP-42'
  }) as WorktreeReference
  return { t: unlinkHarness, worktree, pull, tracker }
}

async function rpcFailure(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise
  } catch (error) {
    return error as RpcError
  }
  throw new Error('expected the call to fail')
}

describe('reference unlinking', () => {
  test('an absent ID succeeds without writing or emitting and preserves stored reference metadata', async () => {
    const references = [
      ref('ref-one', 'https://tracker.example/issues/1', 'One', 11),
      ref('ref-two', 'https://tracker.example/issues/2', 'Two', 22)
    ]
    const writes: { sql: string; params: unknown[] }[] = []
    const events: unknown[] = []
    const store = {
      get<T>(sql: string): T | null {
        expect(sql).toBe('SELECT references_json FROM worktrees WHERE id = ?')
        return { references_json: JSON.stringify(references) } as T
      },
      run(sql: string, ...params: unknown[]) {
        writes.push({ sql, params })
        return { changes: 1, lastInsertRowid: 0 }
      }
    } as unknown as PluginStore
    const worktree = { id: 'wt-a', repoId: 'alpha' } as WorktreeControl
    const env: RecordEnv = {
      store,
      fail: (_kind, message) => new Error(message),
      find: async (_selector: string, _identity: CallerIdentity) => ({ worktree, all: [worktree] }),
      changed: (data) => events.push(data)
    }

    const before = await listReferences(env, 'id:wt-a', {})
    const result = await unlinkReference(env, { worktree: 'id:wt-a', reference: 'ref_missing' }, {})
    const after = await listReferences(env, 'id:wt-a', {})

    expect(result).toEqual({ ok: true, removed: false })
    expect(after).toEqual(before)
    expect(after).toEqual(references)
    expect(writes).toEqual([])
    expect(events).toEqual([])
  })

  test('removes one present ID, emits one change, and succeeds idempotently on the second call', async () => {
    const { t, worktree, pull, tracker } = await unlinkWorld()
    const eventsClient = await t.h.connectWithEvents('ui')
    const changedCount = () => eventsClient.events.filter((event) => event.type === 'quirky.worktree/changed').length
    const before = changedCount()

    expect(await daemonCall(eventsClient.client, 'quirky.worktree/unlinkReference', {
      worktree: worktree.id,
      reference: pull.id
    })).toEqual({ ok: true, removed: true })
    await waitFor(() => changedCount() > before)
    expect(changedCount() - before).toBe(1)
    expect(await daemonCall(t.client, 'quirky.worktree/references', { worktree: worktree.id })).toEqual([tracker])
    expect(await daemonCall(eventsClient.client, 'quirky.worktree/unlinkReference', {
      worktree: worktree.id,
      reference: pull.id
    })).toEqual({ ok: true, removed: false })
  })

  test('removes by exact URL only', async () => {
    const { t, worktree, pull, tracker } = await unlinkWorld()
    expect(await daemonCall(t.client, 'quirky.worktree/unlinkReference', {
      worktree: worktree.id,
      url: tracker.url
    })).toEqual({ ok: true, removed: true })
    expect(await daemonCall(t.client, 'quirky.worktree/references', { worktree: worktree.id })).toEqual([pull])

    expect(await daemonCall(t.client, 'quirky.worktree/unlinkReference', {
      worktree: worktree.id,
      url: `${tracker.url}/`
    })).toEqual({ ok: true, removed: false })
    expect(await daemonCall(t.client, 'quirky.worktree/references', { worktree: worktree.id })).toEqual([pull])
  })

  test('rejects invalid removal arguments while a missing worktree remains not-found', async () => {
    const { t, worktree, pull, tracker } = await unlinkWorld()
    const invalid = [
      { worktree: worktree.id },
      { worktree: worktree.id, reference: pull.id, url: tracker.url },
      { worktree: worktree.id, reference: '' },
      { worktree: worktree.id, reference: 5 },
      { worktree: worktree.id, url: 5 },
      { worktree: worktree.id, url: 'javascript:alert(1)' },
      { worktree: worktree.id, url: 'https://tracker.example/' + 'x'.repeat(2_049) }
    ]
    for (const params of invalid) {
      expect((await rpcFailure(daemonCall(t.client, 'quirky.worktree/unlinkReference', params))).code).toBe(RpcErrorCode.InvalidParams)
    }
    expect((await rpcFailure(daemonCall(t.client, 'quirky.worktree/unlinkReference', {
      worktree: 'id:missing',
      reference: 'ref_missing'
    }))).code).toBe(RpcErrorCode.NotFound)
  })
})

describe('reference search boundary regressions', () => {
  test('explicit GitLab routes outrank route-like subgroup names', () => {
    for (const route of ['merge_requests', 'issues']) {
      const sigil = route === 'merge_requests' ? '!' : '#'
      const url = `https://gitlab.example/group/sub/pull/7/-/${route}/45`
      const key = `group/sub/pull/7${sigil}45`
      expect(referenceItemOf(url)?.id).toBe(`gitlab.example/${key}`)
      const rows = [storedWorktree('nested', { references: [ref('nested-ref', url)] })]
      expect(search(key, rows).matches.map((match) => match.worktree.id)).toEqual(['nested'])
      expect(search('group/sub#7', rows).matches).toEqual([])
    }
  })

  test('non-string statuses cannot establish session liveness', () => {
    const malformed = { ...session('malformed', 'wt-a', 'working', { kind: 'structured' }), status: ['working'] }
    expect(sessionLiveness(malformed, null)).toBe('unverifiable')
    const result = search('acme/api#5123', world, { sessions: { rows: [malformed] } })
    expect(result.matches[0]!.sessions).toMatchObject([{ id: 'malformed', status: '', liveness: 'unverifiable', linked: false }])
  })
})
let searchHarness: PluginHarness | undefined
afterEach(async () => {
  await searchHarness?.cleanup()
  searchHarness = undefined
})

async function searchWorld(options: { realSession?: boolean } = {}) {
  const t = await startPluginHarness(options.realSession
    ? { plugins: ['quirky.repo', 'quirky.worktree', 'quirky.agents', 'quirky.session'], fakeSession: false }
    : {})
  searchHarness = t
  const root = realpathSync(makeTempDir('qrs-root-'))
  await daemonCall(t.client, 'setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: root })
  fakeRegistrations(t.git!)

  const alphaPath = addFakeRepo(t.git!, 'alpha')
  const alphaRepo = await daemonCall(t.client, 'quirky.repo/add', { path: alphaPath }) as Repo
  const alphaWorktrees = await daemonCall(t.client, 'quirky.worktree/list', { repo: alphaRepo.id }) as Worktree[]
  const worktreeA = alphaWorktrees.find((worktree) => worktree.isMain)!
  const createdB = await daemonCall(t.client, 'quirky.worktree/create', { repo: alphaRepo.id, name: 'fix-login' }) as { worktree: Worktree }
  const worktreeB = createdB.worktree

  const betaPath = addFakeRepo(t.git!, 'beta')
  const betaRepo = await daemonCall(t.client, 'quirky.repo/add', { path: betaPath }) as Repo
  const betaWorktrees = await daemonCall(t.client, 'quirky.worktree/list', { repo: betaRepo.id }) as Worktree[]
  const betaWorktree = betaWorktrees.find((worktree) => worktree.isMain)!

  await daemonCall(t.client, 'quirky.worktree/linkReference', {
    worktree: worktreeA.id,
    url: 'https://github.com/acme/api/pull/5123',
    label: 'PR 5123'
  })
  await daemonCall(t.client, 'quirky.worktree/linkReference', {
    worktree: worktreeA.id,
    url: 'https://tracker.example/issues/42',
    label: 'APP-42'
  })
  await daemonCall(t.client, 'quirky.worktree/linkReference', {
    worktree: worktreeB.id,
    url: 'https://gitlab.com/acme/api/-/issues/5123',
    label: 'GitLab 5123'
  })
  await daemonCall(t.client, 'quirky.worktree/linkReference', {
    worktree: betaWorktree.id,
    url: 'https://github.com/acme/api/pull/5123',
    label: 'Beta PR 5123'
  })
  return { t, root, alphaRepo, betaRepo, worktreeA, worktreeB, betaWorktree }
}

function worktreeStoreFile(home: string): string {
  return join(home, 'plugin-data', 'quirky.worktree', 'store.db')
}

function rawStoreSnapshot(home: string): { worktrees: unknown[]; origins: unknown[] } {
  const db = new Database(worktreeStoreFile(home), { readonly: true })
  try {
    return {
      worktrees: db.query('SELECT * FROM worktrees ORDER BY id').all(),
      origins: db.query('SELECT * FROM worktree_origins ORDER BY worktree_id').all()
    }
  } finally {
    db.close()
  }
}

function worktreeRows(home: string): WorktreeRow[] {
  const db = new Database(worktreeStoreFile(home), { readonly: true })
  try {
    return db.query('SELECT * FROM worktrees ORDER BY id').all() as WorktreeRow[]
  } finally {
    db.close()
  }
}

function runPluginSql(home: string, plugin: string, sql: string, ...params: (string | number | null)[]): void {
  const db = new Database(join(home, 'plugin-data', plugin, 'store.db'))
  try {
    db.query(sql).run(...params)
  } finally {
    db.close()
  }
}

function addPathlessMatchingRows(home: string, sourceId: string, count: number): void {
  const db = new Database(worktreeStoreFile(home))
  try {
    const columns = (db.query('PRAGMA table_info(worktrees)').all() as { name: string }[]).map(({ name }) => name)
    const quotedColumns = columns.map((name) => `"${name}"`).join(', ')
    const selectedColumns = columns.map((name) =>
      name === 'id' ? '?' : name === 'path' ? 'NULL' : `"${name}"`
    ).join(', ')
    const insert = db.query(`INSERT INTO worktrees (${quotedColumns}) SELECT ${selectedColumns} FROM worktrees WHERE id = ?`)
    db.exec('BEGIN')
    try {
      for (let index = 0; index < count; index++) {
        insert.run(`limit-row-${String(index).padStart(3, '0')}`, sourceId)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } finally {
    db.close()
  }
}

function storeForRows(rows: WorktreeRow[]): Pick<PluginStore, 'all' | 'get'> {
  return {
    all<T>(sql: string): T[] {
      expect(sql).toContain('worktrees')
      return rows as T[]
    },
    get<T>(): T | null {
      return null
    }
  }
}

function searchEnv(rows: WorktreeRow[], overrides: Partial<ReferenceSearchEnv> = {}): ReferenceSearchEnv {
  return {
    store: storeForRows(rows),
    identitySource: filesystemIdentitySource,
    repoIds: async () => [...new Set(rows.map((row) => row.repo_id))],
    resolveRepo: async () => { throw new Error('unexpected repo resolution') },
    sessions: async () => [],
    processes: async () => [],
    fail: (kind, message, data) => Object.assign(new Error(message), { kind, data }),
    ...overrides
  }
}

describe('stored reference search', () => {
  test('validates method options and preserves selector error classes and data', async () => {
    const { t, alphaRepo, worktreeA, betaWorktree } = await searchWorld()
    const invalidQueries = ['', ' '.repeat(2), 'x'.repeat(2_049), '5', 'ftp://x/y']
    for (const query of invalidQueries) {
      expect((await rpcFailure(daemonCall(t.client, 'quirky.worktree/findReferences', { query }))).code).toBe(RpcErrorCode.InvalidParams)
    }
    const invalidOptions = [
      { limit: 0 },
      { limit: 201 },
      { limit: 1.5 },
      { limit: '5' },
      { includeArchived: 'yes' },
      { worktree: worktreeA.id, repo: alphaRepo.id }
    ]
    for (const options of invalidOptions) {
      expect((await rpcFailure(daemonCall(t.client, 'quirky.worktree/findReferences', {
        query: 'acme/api#5123',
        ...options
      }))).code).toBe(RpcErrorCode.InvalidParams)
    }
    expect((await rpcFailure(daemonCall(t.client, 'quirky.worktree/findReferences', {
      query: 'acme/api#5123',
      unexpected: true
    }))).code).toBe(RpcErrorCode.InvalidParams)

    const missing = await rpcFailure(daemonCall(t.client, 'quirky.worktree/findReferences', {
      query: 'acme/api#5123', worktree: 'name:missing'
    }))
    expect(missing.code).toBe(RpcErrorCode.NotFound)
    expect(missing.message).toBe('no worktree matches name:missing; use id:, name:, path: or current')

    const branch = await rpcFailure(daemonCall(t.client, 'quirky.worktree/findReferences', {
      query: 'acme/api#5123', worktree: 'branch:main'
    }))
    expect(branch.code).toBe(RpcErrorCode.InvalidParams)
    expect(branch.message).toContain('id:, name:, path: or current')

    runPluginSql(t.h.home, 'quirky.worktree',
      'UPDATE worktrees SET display_name = ? WHERE id IN (?, ?)',
      'shared', worktreeA.id, betaWorktree.id)
    const conflict = await rpcFailure(daemonCall(t.client, 'quirky.worktree/findReferences', {
      query: 'acme/api#5123', worktree: 'name:shared'
    }))
    expect(conflict.code).toBe(RpcErrorCode.Conflict)
    expect(conflict.message).toContain('matches 2 worktrees')
    expect(conflict.data).toEqual(expect.objectContaining({
      matches: expect.arrayContaining([`id:${worktreeA.id}`, `id:${betaWorktree.id}`])
    }))

    const resolveFailure = await rpcFailure(daemonCall(t.client, 'quirky.repo/resolve', { selector: 'name:absent' }))
    const searchFailure = await rpcFailure(daemonCall(t.client, 'quirky.worktree/findReferences', {
      query: 'acme/api#5123', repo: 'name:absent'
    }))
    expect(searchFailure.code).toBe(resolveFailure.code)
    expect(searchFailure.message).toBe(resolveFailure.message)
  })

  test('enforces daemon and module limits over more than fifty matches', async () => {
    const { t, alphaRepo, worktreeA } = await searchWorld()
    addPathlessMatchingRows(t.h.home, worktreeA.id, 201)
    const query = 'https://github.com/acme/api/pull/5123'
    const defaultDaemon = await daemonCall(t.client, 'quirky.worktree/findReferences', {
      query, repo: alphaRepo.id
    }) as ReferenceSearchResult
    expect(defaultDaemon).toMatchObject({ total: 202, truncated: true })
    expect(defaultDaemon.matches).toHaveLength(50)

    const maximumDaemon = await daemonCall(t.client, 'quirky.worktree/findReferences', {
      query, repo: alphaRepo.id, limit: 200
    }) as ReferenceSearchResult
    expect(maximumDaemon).toMatchObject({ total: 202, truncated: true })
    expect(maximumDaemon.matches).toHaveLength(200)

    const rejectedDaemon = await rpcFailure(daemonCall(t.client, 'quirky.worktree/findReferences', {
      query, repo: alphaRepo.id, limit: 201
    }))
    expect(rejectedDaemon.code).toBe(RpcErrorCode.InvalidParams)

    const env = searchEnv(worktreeRows(t.h.home), { resolveRepo: async () => alphaRepo })
    const directDefault = await findReferences(env, { query, repo: alphaRepo.id }, {})
    expect(directDefault).toMatchObject({ total: 202, truncated: true })
    expect(directDefault.matches).toHaveLength(50)

    const directMaximum = await findReferences(env, { query, repo: alphaRepo.id, limit: 200 }, {})
    expect(directMaximum).toMatchObject({ total: 202, truncated: true })
    expect(directMaximum.matches).toHaveLength(200)

    await expect(findReferences(env, { query, repo: alphaRepo.id, limit: 201 }, {})).rejects.toMatchObject({
      kind: 'invalid-params',
      message: 'limit must be an integer from 1 to 200'
    })
  })

  test('narrows by worktree or resolved repository', async () => {
    const { t, alphaRepo, betaRepo, worktreeA, worktreeB, betaWorktree } = await searchWorld()
    runPluginSql(t.h.home, 'quirky.worktree', 'UPDATE worktrees SET last_activity_at = ? WHERE id = ?', 100, worktreeA.id)
    runPluginSql(t.h.home, 'quirky.worktree', 'UPDATE worktrees SET last_activity_at = ? WHERE id = ?', 200, worktreeB.id)
    const worktreeResult = await daemonCall(t.client, 'quirky.worktree/findReferences', {
      query: 'acme/api#5123', worktree: `id:${worktreeB.id}`
    }) as ReferenceSearchResult
    expect(worktreeResult.matches.map(({ worktree }) => worktree.id)).toEqual([worktreeB.id])
    expect(worktreeResult.ambiguous).toBe(false)

    const alphaResult = await daemonCall(t.client, 'quirky.worktree/findReferences', {
      query: 'acme/api#5123', repo: alphaRepo.id
    }) as ReferenceSearchResult
    const betaResult = await daemonCall(t.client, 'quirky.worktree/findReferences', {
      query: 'acme/api#5123', repo: betaRepo.id
    }) as ReferenceSearchResult
    expect(alphaResult.matches.map(({ worktree }) => worktree.id)).toEqual([worktreeB.id, worktreeA.id])
    expect(betaResult.matches.map(({ worktree }) => worktree.id)).toEqual([betaWorktree.id])
  })

  test('supports identity selectors for a pathless row and skips it for path-based selection', async () => {
    const { t, root, worktreeA, worktreeB } = await searchWorld()
    runPluginSql(t.h.home, 'quirky.worktree',
      'UPDATE worktrees SET path = NULL, name = ?, display_name = NULL WHERE id = ?',
      'legacy', worktreeA.id)
    const query = 'https://github.com/acme/api/pull/5123'
    for (const selector of [`id:${worktreeA.id}`, worktreeA.id, 'name:legacy', 'legacy']) {
      const result = await daemonCall(t.client, 'quirky.worktree/findReferences', {
        query, worktree: selector
      }) as ReferenceSearchResult
      expect(result.matches).toMatchObject([{
        worktree: { id: worktreeA.id, name: 'legacy', path: null, state: 'stale', staleReason: 'folder-missing' }
      }])
    }

    const currentById = await t.connectAs({ worktreeId: worktreeA.id })
    const currentResult = await daemonCall(currentById, 'quirky.worktree/findReferences', { query, worktree: 'current' }) as ReferenceSearchResult
    expect(currentResult.matches.map(({ worktree }) => worktree.id)).toEqual([worktreeA.id])

    const currentByCwd = await t.connectAs({ cwd: worktreeB.path })
    const cwdResult = await daemonCall(currentByCwd, 'quirky.worktree/findReferences', {
      query: 'acme/api#5123', worktree: 'current'
    }) as ReferenceSearchResult
    expect(cwdResult.matches.map(({ worktree }) => worktree.id)).toEqual([worktreeB.id])

    const noPath = join(root, 'not-a-worktree')
    for (const selector of [`path:${noPath}`, 'current']) {
      const client = selector === 'current' ? await t.connectAs({ cwd: noPath }) : t.client
      expect((await rpcFailure(daemonCall(client, 'quirky.worktree/findReferences', {
        query, worktree: selector
      }))).code).toBe(RpcErrorCode.NotFound)
    }
    for (const selector of ['name:nothing', 'nothing', 'name:api']) {
      expect((await rpcFailure(daemonCall(t.client, 'quirky.worktree/findReferences', {
        query, worktree: selector
      }))).code).toBe(RpcErrorCode.NotFound)
    }
  })

  test('keeps stored rows unchanged and performs no git or event work while searching', async () => {
    const { t, alphaRepo } = await searchWorld()
    const watcher = await t.h.connectWithEvents('ui')
    const before = rawStoreSnapshot(t.h.home)
    const gitCallCount = t.git!.calls.length
    const result = await daemonCall(watcher.client, 'quirky.worktree/findReferences', {
      query: 'https://github.com/acme/api/pull/5123'
    }) as ReferenceSearchResult

    expect(result.matches).toHaveLength(2)
    expect(result.matches.some(({ worktree }) => worktree.repoId === alphaRepo.id)).toBe(true)
    expect(rawStoreSnapshot(t.h.home)).toEqual(before)
    expect(t.git!.calls.slice(gitCallCount)).toEqual([])
    expect(watcher.events.filter((event) => event.type.startsWith('quirky.worktree/'))).toEqual([])

    const rows = worktreeRows(t.h.home)
    let allCalls = 0
    let getCalls = 0
    const store = new Proxy<Pick<PluginStore, 'all' | 'get'>>({
      all<T>(sql: string): T[] {
        allCalls++
        expect(sql).toContain('worktrees')
        return rows as T[]
      },
      get<T>(): T | null {
        getCalls++
        return null
      }
    }, {
      get(target, property, receiver) {
        if (property !== 'all' && property !== 'get') throw new Error(`store.${String(property)} is unavailable`)
        return Reflect.get(target, property, receiver)
      }
    })
    const env = searchEnv(rows, { store, repoIds: async () => [alphaRepo.id] })
    const readOnlyResult = await findReferences(env, { query: 'https://github.com/acme/api/pull/5123' }, {})
    const stored = readStoredWorktrees({ store })
    expect(readOnlyResult.matches.length).toBeGreaterThan(0)
    expect(stored.length).toBe(rows.length)
    expect(allCalls).toBe(2)
    expect(getCalls).toBe(0)
  })

  test('reports missing and replaced folders as stale without deleting their rows', async () => {
    const { t, alphaRepo, worktreeB } = await searchWorld()
    const registrations = t.git!.worktreesByRepo.get(alphaRepo.path)!
    t.git!.worktreesByRepo.set(alphaRepo.path, registrations.filter(({ path }) => path !== worktreeB.path))
    rmSync(worktreeB.path, { recursive: true, force: true })
    const before = rawStoreSnapshot(t.h.home)
    const found = await daemonCall(t.client, 'quirky.worktree/findReferences', {
      query: 'acme/api#5123', worktree: `id:${worktreeB.id}`
    }) as ReferenceSearchResult
    expect(found.matches[0]?.worktree).toMatchObject({ id: worktreeB.id, state: 'stale', staleReason: 'folder-missing' })
    expect(rawStoreSnapshot(t.h.home)).toEqual(before)

    const other = await daemonCall(t.client, 'quirky.worktree/create', { repo: alphaRepo.id, name: 'replacement-check' }) as { worktree: Worktree }
    await daemonCall(t.client, 'quirky.worktree/linkReference', {
      worktree: other.worktree.id, url: 'https://github.com/acme/api/issues/5123', label: 'replacement'
    })
    const row = worktreeRows(t.h.home).find(({ id }) => id === other.worktree.id)!
    runPluginSql(t.h.home, 'quirky.worktree', 'UPDATE worktrees SET birthtime = ? WHERE id = ?', (row.birthtime ?? 0) + 1_000_000, row.id)
    const replacedBefore = rawStoreSnapshot(t.h.home)
    const replaced = await daemonCall(t.client, 'quirky.worktree/findReferences', {
      query: 'acme/api#5123', worktree: `id:${other.worktree.id}`
    }) as ReferenceSearchResult
    expect(replaced.matches[0]?.worktree).toMatchObject({ id: other.worktree.id, state: 'stale', staleReason: 'folder-replaced' })
    expect(rawStoreSnapshot(t.h.home)).toEqual(replacedBefore)
  })

  test('marks unregistered projects stale and propagates project-list failures', async () => {
    const { t } = await searchWorld()
    const rows = worktreeRows(t.h.home)
    const unregistered = await findReferences(searchEnv(rows, { repoIds: async () => [] }), {
      query: 'https://github.com/acme/api/pull/5123'
    }, {})
    expect(unregistered.matches.every(({ worktree }) =>
      worktree.state === 'stale' && worktree.staleReason === 'project-unregistered'
    )).toBe(true)

    const failure = new Error('project list failed')
    await expect(findReferences(searchEnv(rows, { repoIds: async () => { throw failure } }), {
      query: 'https://github.com/acme/api/pull/5123'
    }, {})).rejects.toBe(failure)
  })

  test('classifies filesystem identity only for returned narrowed matches', async () => {
    const { t, alphaRepo, betaRepo } = await searchWorld()
    const sourceRows = worktreeRows(t.h.home)
    const alphaSource = sourceRows.find(({ repo_id }) => repo_id === alphaRepo.id)!
    const betaSource = sourceRows.find(({ repo_id }) => repo_id === betaRepo.id)!
    const virtualRow = (source: WorktreeRow, id: string, lastActivityAt: number, archivedAt: number | null = null): WorktreeRow & { path: string } => ({
      ...source,
      id,
      name: id,
      display_name: id,
      path: `/virtual/${id}`,
      last_activity_at: lastActivityAt,
      archived_at: archivedAt,
      birthtime: 100,
      instance_id: `fs:expected:${id}:100`,
      references_json: JSON.stringify([ref(`match-${id}`, 'https://github.com/acme/api/pull/5123', 'match')])
    })
    const winner = virtualRow(alphaSource, 'winner', 300)
    const archived = virtualRow(alphaSource, 'archived', 1_000, 123)
    const capped = virtualRow(alphaSource, 'capped', 200)
    const outsideRepo = virtualRow(betaSource, 'outside-repo', 900)
    const nonmatching = {
      ...virtualRow(alphaSource, 'nonmatching', 2_000),
      references_json: JSON.stringify([ref('other', 'https://elsewhere.example/issues/9')])
    }
    const rows = [nonmatching, outsideRepo, archived, capped, winner]
    const statted: string[] = []
    const identitySource = {
      open() {
        throw new Error('search should not open filesystem identities')
      },
      stat(path: string) {
        statted.push(path)
        return { device: 'actual', inode: 'changed', birthtimeMs: 100 }
      }
    }
    const env = searchEnv(rows, {
      identitySource,
      repoIds: async () => [alphaRepo.id, betaRepo.id],
      resolveRepo: async () => alphaRepo
    })
    const query = 'https://github.com/acme/api/pull/5123'
    const narrowed = await findReferences(env, { query, repo: alphaRepo.id, limit: 1 }, {})
    expect(narrowed).toMatchObject({ total: 2, archivedOmitted: 1, truncated: true, stale: 1 })
    expect(narrowed.matches.map(({ worktree }) => worktree.id)).toEqual(['winner'])
    expect(statted).toEqual([winner.path])

    statted.length = 0
    const selected = await findReferences(env, { query, worktree: 'id:winner' }, {})
    expect(selected.matches.map(({ worktree }) => worktree.id)).toEqual(['winner'])
    expect(selected.stale).toBe(1)
    expect(statted).toEqual([winner.path])
  })

  test('does not depend on git listings and leaves deleted-group membership untouched', async () => {
    const { t, alphaRepo, worktreeA, worktreeB } = await searchWorld()
    let listCalled = false
    t.git!.listRegistrations = async () => {
      listCalled = true
      throw new Error('git unavailable')
    }
    const beforeGit = t.git!.calls.length
    runPluginSql(t.h.home, 'quirky.worktree', 'UPDATE worktrees SET last_activity_at = ? WHERE id = ?', 100, worktreeA.id)
    runPluginSql(t.h.home, 'quirky.worktree', 'UPDATE worktrees SET last_activity_at = ? WHERE id = ?', 200, worktreeB.id)
    const result = await daemonCall(t.client, 'quirky.worktree/findReferences', {
      query: 'acme/api#5123', repo: alphaRepo.id
    }) as ReferenceSearchResult
    expect(result.matches.map(({ worktree }) => worktree.id)).toEqual([worktreeB.id, worktreeA.id])
    expect(result.items.map(({ id }) => id)).toEqual([
      'github.com/acme/api#5123', 'gitlab.com/acme/api#5123'
    ])
    expect(result.matches.some(({ worktree }) => worktree.state === 'present')).toBe(true)
    expect(listCalled).toBe(false)
    expect(t.git!.calls.length).toBe(beforeGit)

    const deletedGroupId = 'group-deleted-search-test'
    runPluginSql(t.h.home, 'quirky.repo',
      'INSERT OR REPLACE INTO deleted_groups (id, deleted_at) VALUES (?, ?)', deletedGroupId, Date.now())
    runPluginSql(t.h.home, 'quirky.worktree',
      'UPDATE worktrees SET project_group_id = ? WHERE id = ?', deletedGroupId, worktreeA.id)
    expect(await daemonCall(t.client, 'quirky.repo/groupDeletedIds')).toContain(deletedGroupId)
    const watcher = await t.h.connectWithEvents('ui')
    const before = rawStoreSnapshot(t.h.home)
    const found = await daemonCall(watcher.client, 'quirky.worktree/findReferences', {
      query: 'https://github.com/acme/api/pull/5123'
    }) as ReferenceSearchResult
    expect(found.matches.some(({ worktree }) => worktree.id === worktreeA.id)).toBe(true)
    expect(rawStoreSnapshot(t.h.home)).toEqual(before)
    expect(watcher.events.filter((event) => event.type.startsWith('quirky.worktree/'))).toEqual([])
  })

  test('returns matches when the session list is unavailable or not an array', async () => {
    const { t } = await searchWorld()
    const rows = worktreeRows(t.h.home)
    for (const sessions of [
      async () => { throw new Error('unknown method: quirky.session/list') },
      async () => ({ sessions: [] })
    ]) {
      const result = await findReferences(searchEnv(rows, { sessions }), {
        query: 'https://github.com/acme/api/pull/5123'
      }, {})
      expect(result.matches.length).toBeGreaterThan(0)
      expect(result.matches.every((match) => match.sessions === null && match.sessionTotal === null)).toBe(true)
      expect(result.evidence.sessions).toBe('unavailable')
      expect(result.evidence.sessionsReason).toBeTruthy()
    }
  })

  test('does not reconnect or list a disconnected PTY host during a stored search', async () => {
    const { t, worktreeA } = await searchWorld()
    t.sessions.sessions = [session('running', worktreeA.id, 'running'), session('exited', worktreeA.id, 'exited')]
    const watcher = await t.h.connectWithEvents('ui')
    const before = rawStoreSnapshot(t.h.home)
    const requestsBefore = t.h.pty.requests.length
    const descriptor = Object.getOwnPropertyDescriptor(PtyClient.prototype, 'connected')!
    const request = spyOn(PtyClient.prototype, 'request')
    const connect = spyOn(PtyClient.prototype, 'connect')
    Object.defineProperty(PtyClient.prototype, 'connected', { ...descriptor, get: () => false })
    try {
      const result = await daemonCall(watcher.client, 'quirky.worktree/findReferences', {
        query: 'https://github.com/acme/api/pull/5123', worktree: worktreeA.id
      }) as ReferenceSearchResult
      expect(request.mock.calls.filter(([type]) => type === 'list')).toEqual([])
      expect(connect).not.toHaveBeenCalled()
      expect(t.h.pty.requests.slice(requestsBefore)).toEqual([])
      expect(result.evidence.processes).toBe('unavailable')
      expect(result.evidence.processesReason).toContain('not connected')
      expect(result.matches[0]?.sessions?.map(({ id, liveness }) => [id, liveness])).toEqual([
        ['running', 'unverifiable'], ['exited', 'exited']
      ])
      expect(rawStoreSnapshot(t.h.home)).toEqual(before)
      expect(watcher.events.filter((event) => event.type.startsWith('quirky.worktree/'))).toEqual([])
    } finally {
      request.mockRestore()
      connect.mockRestore()
      Object.defineProperty(PtyClient.prototype, 'connected', descriptor)
    }
  })

  test('uses the real session and PTY listing for terminal liveness', async () => {
    const { t, worktreeA } = await searchWorld({ realSession: true })
    const session = await daemonCall(t.client, 'quirky.session/create', {
      worktree: worktreeA.id,
      agent: 'shell'
    }) as { id: string }
    const result = await daemonCall(t.client, 'quirky.worktree/findReferences', {
      query: 'https://github.com/acme/api/pull/5123'
    }) as ReferenceSearchResult
    expect(result.matches[0]?.sessions).toMatchObject([{ id: session.id, kind: 'terminal', liveness: 'live', linked: false }])
    expect(result.evidence).toMatchObject({ sessions: 'listed', processes: 'listed' })
    await daemonCall(t.client, 'quirky.session/close', { session: session.id })
    const closed = await daemonCall(t.client, 'quirky.worktree/findReferences', {
      query: 'https://github.com/acme/api/pull/5123'
    }) as ReferenceSearchResult
    const closedSession = closed.matches[0]?.sessions?.find(({ id }) => id === session.id)
    expect(closed.evidence.sessions).toBe('listed')
    expect(closedSession === undefined || closedSession.liveness === 'exited').toBe(true)
  })
})
