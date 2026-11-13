import { describe, expect, test } from 'bun:test'
import type { GitHubWorktreeLink, PtySessionInfo } from '@quirky/protocol'
import type { WorktreeReference } from '../src/parity-types'
import {
  parseReferenceQuery,
  referenceItemOf,
  searchReferences,
  sessionLiveness,
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

  test('truncates worktrees after activity ordering while computing items over every match', () => {
    const result = search('acme/api#5123', world, { includeArchived: true, limit: 2 })
    expect(result.matches.map(({ worktree }) => worktree.id)).toEqual(['wt-a', 'wt-b'])
    expect(result).toMatchObject({
      total: 3,
      truncated: true,
      items: [
        { id: 'github.com/acme/api#5123' },
        { id: 'gitlab.com/acme/api#5123' }
      ],
      ambiguous: true
    })
  })

  test('caps links and sessions at twenty while preserving their stored and sorted order', () => {
    const manyLinks = Array.from({ length: 25 }, (_, index) => ref(`ref-${index}`, `https://github.com/acme/api/issues/5#${index}`))
    const manySessions = Array.from({ length: 23 }, (_, index) => session(`s${index}`, 'many', 'running', {
      kind: 'structured', lastActivityAt: 100 - index
    }))
    const result = search('acme/api#5', [storedWorktree('many', { references: manyLinks })], {
      sessions: { rows: manySessions },
      processes: { rows: [] }
    })
    expect(result.matches[0]?.links.map(({ referenceId }) => referenceId)).toEqual(manyLinks.slice(0, 20).map(({ id }) => id))
    expect(result.matches[0]).toMatchObject({ linkTotal: 25, sessionTotal: 23 })
    expect(result.matches[0]?.sessions?.map(({ id }) => id)).toEqual(Array.from({ length: 20 }, (_, index) => `s${index}`))
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
