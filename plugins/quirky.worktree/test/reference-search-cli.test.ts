import { afterEach, describe, expect, test } from 'bun:test'
import { realpathSync } from 'node:fs'
import type { QuirkyClient, Repo, Worktree } from '@quirky/protocol'
import { spawnCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import { makeTempDir } from '../../../packages/daemon/test/plugins/fixtures'
import { isolateGitConfig } from '../../quirky.repo/test/git-fixtures'
import { startPluginHarness, testCliContext, type PluginHarness } from '../../quirky.repo/test/harness'
import type { ReferenceSearchResult } from '../src/parity-types'
import { commands } from '../cli'
import { addFakeRepo, fakeRegistrations } from './fixtures/fake-git'

isolateGitConfig()
let harness: PluginHarness | undefined
afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
})

const url = 'https://github.com/acme/api/pull/5123'
const item = { id: 'github.com/acme/api#5123', host: 'github.com', project: 'acme/api', sigil: '#', number: 5123 } as const

const sampleResult: ReferenceSearchResult = {
  query: { kind: 'url', url, item: item.id },
  items: [item],
  ambiguous: false,
  matches: [{
    worktree: {
      id: 'wt-a', repoId: 'repo-alpha', name: 'wt-a', path: '/fixture/alpha/wt-a', kind: 'git',
      archivedAt: null, lastActivityAt: 300, state: 'present', staleReason: null
    },
    links: [{ source: 'reference', referenceId: 'ref-pr', url, label: 'PR 5123', item: item.id }],
    linkTotal: 1,
    sessions: [
      { id: 's1', name: null, title: 'first', agent: 'claude', kind: 'terminal', status: 'working', liveness: 'live', linked: false, lastActivityAt: 30 },
      { id: 's2', name: null, title: 'second', agent: 'shell', kind: 'terminal', status: 'running', liveness: 'unverifiable', linked: false, lastActivityAt: 20 },
      { id: 's3', name: null, title: 'third', agent: 'codex', kind: 'terminal', status: 'exited', liveness: 'exited', linked: false, lastActivityAt: 10 }
    ],
    sessionTotal: 3
  }],
  total: 1,
  truncated: false,
  archivedOmitted: 1,
  stale: 0,
  evidence: { sessions: 'listed', sessionsReason: null, processes: 'listed', processesReason: null, skippedSessions: 0 }
}

function recordingClient(result: unknown) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const client = {
    callAny: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      return result
    }
  } as unknown as QuirkyClient
  return { client, calls }
}

async function runFind(result: ReferenceSearchResult, flags: Record<string, unknown> = {}, query = url, json = false) {
  const { client, calls } = recordingClient(result)
  const output = testCliContext(client, { json })
  await commands['find-reference']!({ positionals: [query], flags }, output.ctx)
  return { calls, lines: output.lines }
}

const call = (client: QuirkyClient, method: string, params: Record<string, unknown> = {}) => client.callAny(method, params)

async function startWorld() {
  harness = await startPluginHarness()
  fakeRegistrations(harness.git!)
  const alpha = addFakeRepo(harness.git!, 'alpha')
  const root = realpathSync(makeTempDir('qw-reference-cli-'))
  await call(harness.client, 'setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: root })
  const repo = await call(harness.client, 'quirky.repo/add', { path: alpha }) as Repo
  const created = await call(harness.client, 'quirky.worktree/create', { repo: repo.id, name: 'linked-review' }) as { worktree: Worktree }
  return { harness, repo, worktree: created.worktree }
}

describe('worktree find-reference CLI', () => {
  test('prints one worktree block with links, sessions, and the archived note', async () => {
    const { lines } = await runFind(sampleResult)
    expect(lines).toEqual([[
      '1 worktree linked to github.com/acme/api#5123',
      '1 archived worktree not shown; pass --include-archived',
      '',
      'wt-a  wt-a  present  /fixture/alpha/wt-a',
      '  link     PR 5123  https://github.com/acme/api/pull/5123',
      '  session  s1  claude  live  linked: no',
      '  session  s2  shell  unverifiable  linked: no',
      '  session  s3  codex  exited  linked: no'
    ].join('\n')])
  })

  test('prints each structured link with its kind and labels URL queries without a recognized item', async () => {
    const structured: ReferenceSearchResult = {
      ...sampleResult,
      query: { kind: 'url', url: 'https://tracker.example/issues/42', item: null },
      items: [],
      matches: [{
        ...sampleResult.matches[0]!,
        links: [
          { source: 'linkedPR', referenceId: null, url, label: 'Review', item: item.id },
          { source: 'linkedIssue', referenceId: null, url: 'https://github.com/acme/api/issues/7', label: 'Seven', item: 'github.com/acme/api#7' }
        ],
        linkTotal: 2
      }],
      archivedOmitted: 0
    }
    const { lines } = await runFind(structured, {}, 'https://tracker.example/issues/42')
    expect(lines[0]).toContain('1 worktree linked to https://tracker.example/issues/42')
    expect(lines[0]).toContain('  link     (pull request) Review  https://github.com/acme/api/pull/5123')
    expect(lines[0]).toContain('  link     (issue) Seven  https://github.com/acme/api/issues/7')
  })

  test('reports stale, ambiguous, truncated, and unavailable evidence notes', async () => {
    const staleMatch = {
      ...sampleResult.matches[0]!,
      worktree: { ...sampleResult.matches[0]!.worktree, state: 'stale' as const, staleReason: 'folder-missing' as const, archivedAt: 42 },
      sessions: null,
      sessionTotal: null
    }
    const result: ReferenceSearchResult = {
      ...sampleResult,
      query: { kind: 'key', key: 'acme/api#5123' },
      items: [item, { ...item, id: 'gitlab.com/acme/api#5123', host: 'gitlab.com' }],
      ambiguous: true,
      matches: [
        staleMatch,
        {
          ...staleMatch,
          worktree: { ...staleMatch.worktree, id: 'wt-b', name: 'wt-b', path: '/fixture/alpha/wt-b', archivedAt: null },
          links: [{
            source: 'reference', referenceId: 'ref-gl',
            url: 'https://gitlab.com/acme/api/-/issues/5123',
            label: 'Issue 5123', item: 'gitlab.com/acme/api#5123'
          }]
        }
      ],
      total: 3,
      truncated: true,
      archivedOmitted: 0,
      stale: 2,
      evidence: { sessions: 'unavailable', sessionsReason: 'session list down', processes: 'unavailable', processesReason: 'PTY host down', skippedSessions: 0 }
    }
    const { lines } = await runFind(result)
    const output = lines[0]!
    expect(output).toContain('ambiguous: acme/api#5123 matches 2 items: github.com/acme/api#5123, gitlab.com/acme/api#5123')
    expect(output).toContain('showing 2 of 3 worktrees; raise --limit (max 200)')
    expect(output).toContain('2 matches are stale;')
    expect(output).toContain('sessions unavailable: session list down')
    expect(output).toContain('process liveness unverifiable: PTY host down')
    expect(output).toContain('wt-a  wt-a  stale: folder-missing  /fixture/alpha/wt-a  archived')
    expect(output).toContain('  sessions unknown')
  })

  test('prints no-match output and any archived omission without blocks', async () => {
    const result: ReferenceSearchResult = {
      ...sampleResult,
      query: { kind: 'key', key: 'nobody/nothing#1' },
      items: [], ambiguous: false, matches: [], total: 0, truncated: false, archivedOmitted: 1, stale: 0
    }
    const { lines } = await runFind(result, {}, 'nobody/nothing#1')
    expect(lines).toEqual(['no worktree is linked to nobody/nothing#1\n1 archived worktree not shown; pass --include-archived'])
  })

  test('says when link and session caps cut results, including singular counts', async () => {
    const links = Array.from({ length: 25 }, (_, index) => ({
      source: 'reference' as const, referenceId: `ref-${index}`, url: `${url}#${index}`, label: `Link ${index}`, item: item.id
    }))
    const sessions = Array.from({ length: 23 }, (_, index) => ({
      id: `s${index + 1}`, name: null, title: `session ${index + 1}`, agent: 'claude', kind: 'terminal', status: 'running',
      liveness: 'live' as const, linked: false, lastActivityAt: 100 - index
    }))
    const capped: ReferenceSearchResult = {
      ...sampleResult,
      matches: [{ ...sampleResult.matches[0]!, links: links.slice(0, 20), linkTotal: 25, sessions: sessions.slice(0, 20), sessionTotal: 23 }]
    }
    const { lines } = await runFind(capped)
    const output = lines[0]!
    expect(output.match(/  link     Link /g)).toHaveLength(20)
    expect(output).toContain('  5 more links not shown (25 total)')
    expect(output.match(/  session  s\d+  claude  live  linked: no/g)).toHaveLength(20)
    expect(output).toContain('  3 more sessions not shown (23 total)')

    const singular: ReferenceSearchResult = {
      ...sampleResult,
      archivedOmitted: 0,
      matches: [{ ...sampleResult.matches[0]!, links: links.slice(0, 20), linkTotal: 21, sessions: sessions.slice(0, 20), sessionTotal: 21 }]
    }
    const singularOutput = (await runFind(singular)).lines[0]!
    expect(singularOutput).toContain('  1 more link not shown (21 total)')
    expect(singularOutput).toContain('  1 more session not shown (21 total)')
  })

  test('prints no sessions when the list is available but empty', async () => {
    const result: ReferenceSearchResult = {
      ...sampleResult, archivedOmitted: 0,
      matches: [{ ...sampleResult.matches[0]!, sessions: [], sessionTotal: 0 }]
    }
    const { lines } = await runFind(result)
    expect(lines[0]).toContain('  no sessions')
  })

  test('maps each supported option and emits the method JSON result unchanged', async () => {
    const { calls, lines } = await runFind(sampleResult, { worktree: 'id:wt-a', 'include-archived': true, limit: 7 }, url, true)
    expect(calls).toEqual([{
      method: 'quirky.worktree/findReferences',
      params: { query: url, worktree: 'id:wt-a', includeArchived: true, limit: 7 }
    }])
    expect(lines).toEqual([JSON.stringify(sampleResult)])

    const repoCall = await runFind(sampleResult, { repo: 'id:repo-alpha' })
    expect(repoCall.calls).toEqual([{
      method: 'quirky.worktree/findReferences', params: { query: url, repo: 'id:repo-alpha' }
    }])
  })

  test('requires a query', async () => {
    const { client, calls } = recordingClient(sampleResult)
    const output = testCliContext(client)
    await expect(commands['find-reference']!({ positionals: [], flags: {} }, output.ctx)).rejects.toThrow(/usage/i)
    expect(calls).toEqual([])
  })

  test('real CLI parses flags and returns an archived fixture unchanged as JSON', async () => {
    const { harness, repo, worktree } = await startWorld()
    const reference = await call(harness.client, 'quirky.worktree/linkReference', { worktree: worktree.id, url, label: 'PR 5123' }) as { id: string }
    await call(harness.client, 'quirky.worktree/archive', { worktree: worktree.id })

    const proc = spawnCli([
      'worktree', 'find-reference', url,
      '--worktree', `id:${worktree.id}`, '--include-archived', '--limit', '1', '--json'
    ], { home: harness.h.home })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited
    ])
    expect(code).toBe(0)
    expect(stderr).toBe('')
    const result = JSON.parse(stdout) as ReferenceSearchResult
    expect(result.matches.map((match) => match.worktree.id)).toEqual([worktree.id])
    expect(result.matches[0]!.worktree.archivedAt).not.toBeNull()
    expect(result.matches[0]!.links.map((link) => link.referenceId)).toEqual([reference.id])
    expect(result.archivedOmitted).toBe(0)

    const text = spawnCli([
      'worktree', 'find-reference', url, '--repo', `id:${repo.id}`, '--include-archived', '--limit', '1'
    ], { home: harness.h.home })
    const [textOut, textErr, textCode] = await Promise.all([
      new Response(text.stdout).text(), new Response(text.stderr).text(), text.exited
    ])
    expect(textCode).toBe(0)
    expect(textErr).toBe('')
    expect(textOut).toBe([
      '1 worktree linked to github.com/acme/api#5123',
      '',
      `${worktree.name}  ${worktree.id}  present  ${worktree.path}  archived`,
      '  link     PR 5123  https://github.com/acme/api/pull/5123',
      '  no sessions',
      ''
    ].join('\n'))

    const invalid = spawnCli([
      'worktree', 'find-reference', url, '--worktree', worktree.id, '--repo', repo.id
    ], { home: harness.h.home })
    const [invalidErr, invalidCode] = await Promise.all([
      new Response(invalid.stderr).text(), invalid.exited
    ])
    expect(invalidCode).toBe(1)
    expect(invalidErr).toContain('worktree')
    expect(invalidErr).toContain('repo')
  })
})

describe('worktree unlink-reference CLI', () => {
  test('reports absent IDs as successful no-ops and distinguishes removal by URL from ID', async () => {
    const missing = recordingClient({ ok: true, removed: false })
    const missingOutput = testCliContext(missing.client)
    await commands['unlink-reference']!({ positionals: ['id:wt-a', 'ref_missing'], flags: {} }, missingOutput.ctx)
    expect(missing.calls).toEqual([{
      method: 'quirky.worktree/unlinkReference', params: { worktree: 'id:wt-a', reference: 'ref_missing' }
    }])
    expect(missingOutput.lines).toEqual(['ref_missing was not linked'])

    const byUrl = recordingClient({ ok: true, removed: true })
    const urlOutput = testCliContext(byUrl.client)
    await commands['unlink-reference']!({ positionals: ['id:wt-a', 'https://tracker.example/issues/42'], flags: {} }, urlOutput.ctx)
    expect(byUrl.calls).toEqual([{
      method: 'quirky.worktree/unlinkReference', params: { worktree: 'id:wt-a', url: 'https://tracker.example/issues/42' }
    }])
    expect(urlOutput.lines).toEqual(['unlinked https://tracker.example/issues/42'])
  })

  test('emits the complete removal result unchanged as JSON', async () => {
    const result = { ok: true, removed: false }
    const { client } = recordingClient(result)
    const output = testCliContext(client, { json: true })
    await commands['unlink-reference']!({ positionals: ['wt-a', 'ref_missing'], flags: {} }, output.ctx)
    expect(output.lines).toEqual([JSON.stringify(result)])
  })
})
