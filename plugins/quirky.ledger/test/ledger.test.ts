import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode, type QuirkyClient, type Repo, type Worktree } from '@quirky/protocol'
import { git } from '../../quirky.repo/test/git-fixtures'
import { startLedgerHarness, workspaceTarget, projectTarget, type LedgerHarness } from './harness'

const CONTENT = {
  bug: (title: string) => ({ title, file: 'src/main.ts:7', description: 'A reproducible failure.', severity: 'high' }),
  deferred: (title: string) => ({ title, why_deferred: 'Blocked on a dependency.', priority: 'medium' }),
  'test-gap': (title: string) => ({ title, file_under_test: 'src/main.ts:11', reason_skipped: 'No stable fixture exists.' }),
  proposal: (title: string) => ({ title, context: 'The current flow is slow.', recommendation: 'Cache the lookup.' }),
  decision: (title: string) => ({ title, context: 'Two designs were considered.', decision: 'Use the simple design.', consequences: 'Less configuration.', status: 'proposed' })
} as const

type EntryType = keyof typeof CONTENT
type RpcFailure = Error & { code?: number; data?: Record<string, unknown> }
type LedgerLocation = { path: string; line?: number; base: { kind: 'project' | 'workspace'; id: string; host?: string }; external?: boolean; host?: string }
type LedgerActor = { kind: string; model?: string | null; providerSessionId?: string | null; tool?: string | null }
type LedgerChange = {
  revision: number
  actor: LedgerActor
  before: { content?: Record<string, unknown>; state?: string; reviewed?: boolean }
  after: { content?: Record<string, unknown>; state?: string; reviewed?: boolean }
  changedFields: string[]
}
type LedgerEntry = {
  id: string
  type: EntryType
  sequence: number
  revision: number
  content: Record<string, unknown>
  state: 'open' | 'resolved' | 'archived'
  reviewed: boolean
  origin: Record<string, unknown>
  createdAt: string
  updatedAt: string
  history: LedgerChange[]
  latestContentActor: LedgerActor
}
type LedgerOwner = { tier: 'project' | 'group'; id: string }
type LedgerSummary = {
  ledgerId: string
  tier: 'project' | 'group'
  owner: LedgerOwner | null
  formerOwner?: LedgerOwner | null
  revision: number
  entryCount: number
  nextSequence: number
  staleAfterDays: number
  sourceEquivalences?: string[][]
  metadataHistory?: Record<string, unknown>[]
}
type LedgerCandidate = {
  entry: LedgerEntry
  stale: boolean
  reason: 'reviewed' | 'unreviewed'
  evidence: { available: boolean; fileExists?: boolean; note?: string; baselineRevision?: string | null; [key: string]: unknown }
}
type LedgerResponse = {
  schemaVersion: number
  runtime: { runtimeId: string; profileId: string }
  ledger: LedgerSummary | null
  entry: LedgerEntry
  entries: LedgerEntry[]
  matches: LedgerEntry[]
  ledgers: LedgerSummary[]
  candidates: LedgerCandidate[]
  importResult: { created: string[]; updated: string[]; alreadyPresent: string[]; skipped: { reason: string; sourcePath?: string; anchor?: string }[] }
  removalPreview: { ledgerId: string; revision: number; entryCount: number }[]
  sourceEquivalences?: string[][]
  metadataHistory?: Record<string, unknown>[]
  message?: string
  explanation?: string
}
type FiledResponse = LedgerResponse & { entry: LedgerEntry; ledger: LedgerSummary; matches: LedgerEntry[] }

function locationOf(entry: LedgerEntry, field = 'file'): LedgerLocation {
  const value = entry.content[field]
  if (typeof value !== 'object' || value === null || !('path' in value) || typeof value.path !== 'string' || !('base' in value)) {
    throw new Error(`expected ${field} to be a normalized ledger location`)
  }
  return value as LedgerLocation
}


let h: LedgerHarness | undefined

afterEach(async () => {
  await h?.cleanup()
  h = undefined
})

async function start(): Promise<LedgerHarness> {
  h = await startLedgerHarness()
  return h
}

function content(type: EntryType, title = `${type} observation`) {
  return CONTENT[type](title)
}

async function fileEntry(
  harness: LedgerHarness,
  type: EntryType,
  options: { title?: string; target?: Record<string, unknown>; client?: QuirkyClient; content?: Record<string, unknown> } = {}
): Promise<FiledResponse> {
  return await harness.request({
    operation: 'file',
    target: options.target ?? workspaceTarget(harness.project),
    type,
    content: options.content ?? content(type, options.title)
  }, options.client) as FiledResponse
}

async function failure(promise: Promise<unknown>): Promise<RpcFailure> {
  try {
    await promise
  } catch (error) {
    return error as RpcFailure
  }
  throw new Error('expected the daemon call to fail')
}

async function domainFailure(promise: Promise<unknown>, kind: string): Promise<RpcFailure> {
  const error = await failure(promise)
  expect(error.data).toMatchObject({ kind })
  return error
}

async function uiClient(harness: LedgerHarness) {
  return harness.connectAs('ui')
}

async function confirmedOperation(
  harness: LedgerHarness,
  operation: string,
  params: Record<string, unknown>,
  client?: QuirkyClient
) {
  return harness.operation(operation, { ...params, confirmed: true, yes: true }, client ?? await uiClient(harness))
}

const entryIds = (response: LedgerResponse) => (response.entries ?? []).map((entry) => entry.id)

// SC-01 / SC-02: each public request is run by the real daemon and backed by the plugin store.
describe('Project ledger API: filing, targets and locations', () => {
  test('reads do not allocate a ledger; all five types share a project sequence across worktrees', async () => {
    const harness = await start()
    const sibling = (await harness.client.callAny('quirky.worktree/create', {
      repo: harness.project.repo.id,
      name: 'sibling-ledger'
    }) as { worktree: Worktree }).worktree

    const empty = await harness.operation('list', { target: projectTarget(harness.project) }) as LedgerResponse
    expect(empty).toMatchObject({ schemaVersion: 1, ledger: null, entries: [] })
    expect((await harness.operation('catalog', {} ) as LedgerResponse).ledgers).toEqual([])

    const filed = [
      await fileEntry(harness, 'bug', { title: 'Crash when saving' }),
      await fileEntry(harness, 'deferred', { title: 'Move cache invalidation' , target: { workspaceId: sibling.id } }),
      await fileEntry(harness, 'test-gap', { title: 'Cover unicode parser' }),
      await fileEntry(harness, 'proposal', { title: 'Cache repository lookups' }),
      await fileEntry(harness, 'decision', { title: 'Keep transaction synchronous' })
    ]
    expect(filed.map((response) => response.entry.id)).toEqual(['bug-1', 'deferred-2', 'test-gap-3', 'proposal-4', 'decision-5'])
    expect(filed.map((response) => response.entry.revision)).toEqual([1, 1, 1, 1, 1])
    expect(filed.every((response) => response.entry.state === 'open' && response.entry.reviewed === false)).toBe(true)
    expect(filed[0]!.entry.origin).toMatchObject({ workspaceId: harness.project.workspace.id, owner: { tier: 'project', id: harness.project.repo.id } })
    expect(filed[1]!.entry.origin.workspaceId).toBe(sibling.id)

    const shared = await harness.operation('list', { target: projectTarget(harness.project), filters: { sort: 'sequence' } }) as LedgerResponse
    expect(entryIds(shared)).toEqual(['bug-1', 'deferred-2', 'test-gap-3', 'proposal-4', 'decision-5'])
    expect(shared.ledger).toMatchObject({ tier: 'project', owner: { id: harness.project.repo.id }, entryCount: 5, nextSequence: 6 })

    const duplicate = await fileEntry(harness, 'bug', { title: 'Crash while saving again' })
    expect(duplicate.entry.id).toBe('bug-6')
    expect(duplicate.matches.map((entry: LedgerEntry) => entry.id)).toContain('bug-1')
    expect((await harness.operation('list', { target: { workspaceId: sibling.id } }) as LedgerResponse).entries).toHaveLength(6)
    await harness.client.callAny('quirky.worktree/remove', { worktree: sibling.id, yes: true })
    const retained = await harness.operation('show', { target: projectTarget(harness.project), id: 'deferred-2' }) as LedgerResponse
    expect(retained.entry.origin.workspaceId).toBe(sibling.id)
    expect(entryIds(await harness.operation('list', { target: projectTarget(harness.project), filters: { sort: 'sequence' } }))).toHaveLength(6)
  })

  test('rejects every missing or blank required field and invalid enum without allocating a ledger', async () => {
    const harness = await start()
    const required: Record<EntryType, string[]> = {
      bug: ['title', 'file', 'description', 'severity'],
      deferred: ['title', 'why_deferred', 'priority'],
      'test-gap': ['title', 'file_under_test', 'reason_skipped'],
      proposal: ['title', 'context', 'recommendation'],
      decision: ['title', 'context', 'decision', 'consequences', 'status']
    }

    for (const type of Object.keys(required) as EntryType[]) {
      const valid: Record<string, unknown> = { ...content(type, `valid ${type}`) }
      for (const field of required[type]) {
        const without = { ...valid }
        delete without[field]
        await domainFailure(harness.request({ operation: 'file', target: workspaceTarget(harness.project), type, content: without }), 'invalid-request')
        const blank = { ...valid, [field]: '  \n  ' }
        await domainFailure(harness.request({ operation: 'file', target: workspaceTarget(harness.project), type, content: blank }), 'invalid-request')
      }
    }

    for (const [type, field, bad] of [
      ['bug', 'severity', 'urgent'],
      ['deferred', 'priority', 'normal'],
      ['decision', 'status', 'declined']
    ] as const) {
      await domainFailure(harness.request({
        operation: 'file', target: workspaceTarget(harness.project), type,
        content: { ...content(type), [field]: bad }
      }), 'invalid-enum')
    }
    expect((await harness.operation('list', { target: projectTarget(harness.project) }) as LedgerResponse).ledger).toBeNull()
  })

  test('resolves workspace, project and group selectors and reports missing or ambiguous targets', async () => {
    const harness = await start()
    const first = await harness.client.callAny('quirky.repo/groupCreate', { name: 'Tools' }) as { id: string }
    const second = await harness.client.callAny('quirky.repo/groupCreate', { name: 'Tools' }) as { id: string }
    await harness.client.callAny('quirky.repo/groupAdd', { group: first.id, repo: harness.project.repo.id })

    const byMembership = await harness.request({ operation: 'file', target: { workspaceId: harness.project.workspace.id, group: true }, type: 'proposal', content: content('proposal', 'Group member filing') }) as LedgerResponse
    expect(byMembership.ledger).toMatchObject({ tier: 'group', owner: { id: first.id } })
    const byId = await harness.request({ operation: 'file', target: { workspaceId: harness.project.workspace.id, groupSelector: first.id }, type: 'decision', content: content('decision', 'Group selector by id') }) as LedgerResponse
    expect(byId.ledger!.owner).toMatchObject({ id: first.id })
    const explicitlyTargeted = await harness.operation('list', { target: { owner: { tier: 'group', id: first.id } }, filters: { sort: 'sequence' } }) as LedgerResponse
    expect(entryIds(explicitlyTargeted)).toEqual([byMembership.entry.id, byId.entry.id])

    const byName = await harness.request({ operation: 'list', target: { workspaceId: harness.project.workspace.id, groupSelector: 'Tools' } }) as LedgerResponse
    expect(byName.ledger!.owner).toMatchObject({ id: first.id })
    expect((await harness.client.callAny('quirky.repo/groupList') as { id: string }[]).map((group) => group.id)).toEqual(expect.arrayContaining([first.id, second.id]))
    const ineligible = await domainFailure(harness.request({ operation: 'list', target: { workspaceId: harness.project.workspace.id, groupSelector: 'no-such-group' } }), 'group-ambiguous')
    expect(ineligible.data?.eligible).toEqual([expect.objectContaining({ id: first.id })])
    await domainFailure(harness.request({ operation: 'list', target: { workspaceId: 'workspace_missing' } }), 'workspace-missing')
    await domainFailure(harness.request({ operation: 'list', target: { workspaceId: harness.project.workspace.id, group: true, owner: { tier: 'project', id: harness.project.repo.id } } }), 'invalid-target')
    await domainFailure(harness.request({ operation: 'list', target: { owner: { tier: 'project', id: 'repo_missing' } } }), 'owner-missing')
    await domainFailure(harness.request({ operation: 'list', target: { ledgerId: 'ledger_missing' } }), 'not-found')
  })

  test('folder workspaces require a group, and a folder in a group targets that group ledger', async () => {
    const harness = await start()
    const notesPath = join(harness.home, 'notes')
    mkdirSync(notesPath, { recursive: true })
    writeFileSync(join(notesPath, 'notes.txt'), 'notes\n')
    const folderRepo = await harness.client.callAny('quirky.repo/add', { path: notesPath, folder: true }) as { id: string }
    const folderWorkspace = ((await harness.client.callAny('quirky.worktree/list', { repo: folderRepo.id })) as Worktree[])[0]!
    await domainFailure(harness.request({ operation: 'file', target: { workspaceId: folderWorkspace.id }, type: 'proposal', content: content('proposal') }), 'group-missing')

    const group = await harness.client.callAny('quirky.repo/groupCreate', { name: 'Notes' }) as { id: string }
    await harness.client.callAny('quirky.repo/groupAdd', { group: group.id, repo: folderRepo.id })
    const response = await harness.request({ operation: 'file', target: { workspaceId: folderWorkspace.id, group: true }, type: 'proposal', content: content('proposal', 'Folder notes') }) as LedgerResponse
    expect(response.ledger).toMatchObject({ tier: 'group', owner: { id: group.id } })
  })

  test('normalizes scoped paths, parses safe line numbers, and rejects external paths without a host', async () => {
    const harness = await start()
    const normalized = await fileEntry(harness, 'bug', { content: { ...content('bug'), file: 'src/../src/main.ts:42' } })
    expect(normalized.entry.content.file).toMatchObject({ path: 'src/main.ts', line: 42, base: { kind: 'project', id: harness.project.repo.id } })
    const absolute = await fileEntry(harness, 'bug', {
      content: { ...content('bug'), file: `${join(harness.project.path, 'src/main.ts')}:43` }
    })
    expect(locationOf(absolute.entry)).toMatchObject({ path: 'src/main.ts', line: 43, base: { kind: 'project', id: harness.project.repo.id } })

    for (const badLocation of ['src/main.ts:0', 'src/main.ts:9007199254740992']) {
      await domainFailure(harness.request({ operation: 'file', target: workspaceTarget(harness.project), type: 'bug', content: { ...content('bug'), file: badLocation } }), 'invalid-request')
    }
    await domainFailure(harness.request({
      operation: 'file',
      target: workspaceTarget(harness.project),
      type: 'bug',
      content: {
        ...content('bug'),
        file: { path: '../private.txt', base: { kind: 'workspace', id: harness.project.workspace.id }, external: true }
      }
    }), 'invalid-request')

    const external = await fileEntry(harness, 'bug', {
      content: { ...content('bug'), file: { path: '../private.txt', base: { kind: 'workspace', id: harness.project.workspace.id }, external: true, host: 'local-test' } }
    })
    expect(locationOf(external.entry)).toMatchObject({ external: true, host: 'local-test' })
    expect(locationOf(external.entry).path).toMatch(/private\.txt$/)
  })
})

// SC-03–05: read shapes, history, optimistic concurrency, state and provenance.
describe('Project ledger API: revisions, filters and provenance', () => {
  test('show includes full history and content actor; list filters by all documented dimensions', async () => {
    const harness = await start()
    const created = await fileEntry(harness, 'bug', { title: 'Intermittent cache crash' })
    const id = created.entry.id
    const shown = await harness.operation('show', { target: projectTarget(harness.project), id }) as LedgerResponse
    expect(shown.entry.history).toHaveLength(1)
    expect(shown.entry.history[0]!).toMatchObject({ revision: 1, after: { state: 'open', reviewed: false } })
    expect(shown.entry.latestContentActor).toEqual(shown.entry.history[0]!.actor)

    const deferred = await fileEntry(harness, 'deferred', { title: 'Delay cache optimization' })
    const ui = await uiClient(harness)
    const reviewed = await harness.operation('edit', {
      target: projectTarget(harness.project), id: deferred.entry.id, ifRevision: 1,
      content: { title: 'Delay cache optimization after review' }
    }, ui) as LedgerResponse
    expect(reviewed.entry.reviewed).toBe(true)

    expect(entryIds(await harness.operation('list', { target: projectTarget(harness.project), filters: { type: 'bug', state: 'open', reviewed: false } }))).toEqual([id])
    expect(entryIds(await harness.operation('list', { target: projectTarget(harness.project), filters: { reviewed: true } }))).toEqual([deferred.entry.id])
    expect(entryIds(await harness.operation('list', { target: projectTarget(harness.project), filters: { search: 'cache optimization' } }))).toEqual([deferred.entry.id])
    expect(entryIds(await harness.operation('list', { target: projectTarget(harness.project), filters: { search: id } }))).toEqual([id])
    expect(entryIds(await harness.operation('list', { target: projectTarget(harness.project), filters: { workspaceId: harness.project.workspace.id, branch: 'refs/heads/main', sort: 'sequence' } }))).toEqual([id, deferred.entry.id])
    expect(entryIds(await harness.operation('list', { target: projectTarget(harness.project), filters: { sort: 'sequence' } }))).toEqual([id, deferred.entry.id])
    expect(entryIds(await harness.operation('list', { target: projectTarget(harness.project), filters: { sort: 'title' } }))).toEqual([deferred.entry.id, id])
    const activity = await harness.operation('list', { target: projectTarget(harness.project), filters: { sort: 'activity' } }) as LedgerResponse
    expect(Date.parse(activity.entries[0]!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(activity.entries[1]!.updatedAt))
    expect(entryIds(await harness.operation('list', { target: projectTarget(harness.project), filters: { stale: false, sort: 'sequence' } }))).toEqual([id, deferred.entry.id])
    await domainFailure(harness.operation('show', { target: projectTarget(harness.project), id: 'bug-404' }), 'not-found')
    expect((await harness.operation('show', { target: projectTarget(harness.project), id }) as LedgerResponse).entry.revision).toBe(1)
  })

  test('edits merge content, all states transition, effective changes append history, and revert restores an old snapshot', async () => {
    const harness = await start()
    const created = await fileEntry(harness, 'bug', { title: 'Recover cache' })
    const id = created.entry.id

    const originalLocation = created.entry.content.file
    const historicalLocation = await harness.operation('edit', {
      target: projectTarget(harness.project), id, ifRevision: 1, content: { file: originalLocation }
    }) as LedgerResponse
    expect(historicalLocation.entry.revision).toBe(1)
    expect(historicalLocation.entry.content.file).toEqual(originalLocation)
    await domainFailure(harness.operation('edit', { target: projectTarget(harness.project), id, ifRevision: 1, content: { severity: 'urgent' } }), 'invalid-enum')
    await domainFailure(harness.operation('state', { target: projectTarget(harness.project), id, state: 'complete', ifRevision: 1 }), 'invalid-enum')
    const edited = await harness.operation('edit', { target: projectTarget(harness.project), id, ifRevision: 1, content: { severity: 'critical' } }) as LedgerResponse
    expect(edited.entry).toMatchObject({ revision: 2, content: { title: 'Recover cache', severity: 'critical' }, reviewed: false })
    const noop = await harness.operation('edit', { target: projectTarget(harness.project), id, ifRevision: 2, content: { severity: 'critical' } }) as LedgerResponse
    expect(noop.entry.revision).toBe(2)
    const noStateChange = await harness.operation('state', { target: projectTarget(harness.project), id, state: 'open', ifRevision: 2 }) as LedgerResponse
    expect(noStateChange.entry.revision).toBe(2)
    expect(noStateChange.entry.reviewed).toBe(false)

    const transitionStates: LedgerEntry['state'][] = ['resolved', 'archived', 'open', 'archived', 'resolved', 'open', 'archived']
    let revision = 2
    const reached: string[] = []
    for (const state of transitionStates) {
      const changed = await harness.operation('state', { target: projectTarget(harness.project), id, state, ifRevision: revision }) as LedgerResponse
      revision++
      reached.push(changed.entry.state)
    }
    expect(reached).toEqual(transitionStates)

    const reverted = await harness.operation('revert', { target: projectTarget(harness.project), id, toRevision: 1, ifRevision: 9 }) as LedgerResponse
    expect(reverted.entry).toMatchObject({ revision: 10, state: 'open', content: { severity: 'high' } })
    expect(reverted.entry.history.map((change: LedgerChange) => change.revision)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(reverted.entry.history[9]!.changedFields).toEqual(expect.arrayContaining(['state', 'severity']))
    const stale = await domainFailure(harness.operation('edit', { target: projectTarget(harness.project), id, ifRevision: 1, content: { title: 'stale write' } }), 'conflict')
    expect(stale.data).toMatchObject({ currentRevision: 10 })
    expect((await harness.operation('show', { target: projectTarget(harness.project), id }) as LedgerResponse).entry.content.title).toBe('Recover cache')
    await domainFailure(harness.operation('edit', { target: projectTarget(harness.project), id, ifRevision: 10, content: {} }), 'invalid-request')
    await domainFailure(harness.operation('edit', { target: projectTarget(harness.project), id, ifRevision: 10, type: 'decision', content: { title: 'Type must stay fixed' } }), 'invalid-request')
  })

  test('two writers with the same revision produce one winner and one conflict with no partial history', async () => {
    const harness = await start()
    const created = await fileEntry(harness, 'proposal')
    const one = await harness.connectAs('cli')
    const two = await harness.connectAs('cli')
    const attempts = await Promise.allSettled([
      harness.operation('edit', { target: projectTarget(harness.project), id: created.entry.id, ifRevision: 1, content: { recommendation: 'First writer' } }, one),
      harness.operation('edit', { target: projectTarget(harness.project), id: created.entry.id, ifRevision: 1, content: { recommendation: 'Second writer' } }, two)
    ])
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1)
    const final = await harness.operation('show', { target: projectTarget(harness.project), id: created.entry.id }) as LedgerResponse
    expect(final.entry.revision).toBe(2)
    expect(final.entry.history).toHaveLength(2)
    const rejected = attempts.find((attempt) => attempt.status === 'rejected') as PromiseRejectedResult
    expect((rejected.reason as RpcFailure).data).toMatchObject({ kind: 'conflict', currentRevision: 2 })
    one.close()
    two.close()
  })

  test('UI edits mark content reviewed, agent edits reset it, and caller-supplied actor claims are not trusted', async () => {
    const harness = await start()
    const ui = await uiClient(harness)
    const first = await fileEntry(harness, 'decision', { title: 'UI provenance', client: ui })
    expect(first.entry.reviewed).toBe(false)
    const editedByUi = await harness.operation('edit', {
      target: projectTarget(harness.project), id: first.entry.id, ifRevision: 1,
      content: { consequences: 'Reviewed by a person.' }
    }, ui) as LedgerResponse
    expect(editedByUi.entry.reviewed).toBe(true)
    expect(editedByUi.entry.latestContentActor).toEqual(editedByUi.entry.history[1]!.actor)

    const agent = await harness.connectAs('cli')
    const forgedAttempt = await harness.operation('edit', {
      target: projectTarget(harness.project), id: first.entry.id, ifRevision: 2,
      content: { consequences: 'Claimed from an untrusted request.' },
      actor: { kind: 'human', providerSessionId: 'spoofed' }
    }, agent).then(
      (response) => ({ response: response as LedgerResponse }),
      (error) => ({ error: error as RpcFailure })
    )
    if ('response' in forgedAttempt) {
      expect(forgedAttempt.response.entry.latestContentActor).not.toMatchObject({ kind: 'human', providerSessionId: 'spoofed' })
    } else {
      expect(forgedAttempt.error.code).toBe(RpcErrorCode.InvalidParams)
    }
    const current = await harness.operation('show', { target: projectTarget(harness.project), id: first.entry.id }) as LedgerResponse
    const editedByAgent = await harness.operation('edit', {
      target: projectTarget(harness.project), id: first.entry.id, ifRevision: current.entry.revision,
      content: { consequences: 'Updated by the agent.' }
    }, agent) as LedgerResponse
    expect(editedByAgent.entry.reviewed).toBe(false)
    expect(editedByAgent.entry.latestContentActor).not.toMatchObject({ kind: 'human', providerSessionId: 'spoofed' })
    expect(editedByAgent.entry.history.at(-1)!.actor).toEqual(editedByAgent.entry.latestContentActor)
    agent.close()
  })

  test('approval changes review revision without replacing the latest content actor; no-op approval does not revise', async () => {
    const harness = await start()
    const first = await fileEntry(harness, 'bug', { title: 'Approve me' })
    const ui = await uiClient(harness)
    const second = await fileEntry(harness, 'deferred', { title: 'Atomic approve second' })
    await domainFailure(harness.operation('approve', {
      target: projectTarget(harness.project), selections: [{ id: first.entry.id, revision: 1 }, { id: second.entry.id, revision: 2 }]
    }, ui), 'conflict')
    await domainFailure(harness.operation('approve', {
      target: projectTarget(harness.project), selections: [{ id: first.entry.id, revision: 1 }, { id: first.entry.id, revision: 1 }]
    }, ui), 'invalid-request')
    expect((await harness.operation('show', { target: projectTarget(harness.project), id: first.entry.id }) as LedgerResponse).entry).toMatchObject({ revision: 1, reviewed: false })
    const actor = first.entry.latestContentActor
    const approved = await harness.operation('approve', {
      target: projectTarget(harness.project), selections: [{ id: first.entry.id, revision: 1 }]
    }, ui) as LedgerResponse
    expect(approved.entries[0]!).toMatchObject({ id: first.entry.id, revision: 2, reviewed: true, latestContentActor: actor })
    expect(approved.entries[0]!.history[1]!).toMatchObject({ revision: 2, before: { reviewed: false }, after: { reviewed: true } })
    const noOp = await harness.operation('approve', {
      target: projectTarget(harness.project), selections: [{ id: first.entry.id, revision: 2 }]
    }, ui) as LedgerResponse
    expect(noOp.entries[0]!.revision).toBe(2)
    await domainFailure(harness.operation('approve', { target: projectTarget(harness.project), selections: [{ id: first.entry.id, revision: 1 }] }, ui), 'conflict')
    expect((await harness.operation('show', { target: projectTarget(harness.project), id: first.entry.id }) as LedgerResponse).entry.revision).toBe(2)
  })
})

// SC-06/07: destructive confirmations, all-or-nothing selection validation, and advisory evidence.
describe('Project ledger API: review, bulk operations and confirmation', () => {
  test('review is advisory, safely reports evidence, sorts by review band and never mutates entries', async () => {
    const harness = await start()
    const ui = await uiClient(harness)
    const present = await fileEntry(harness, 'bug', { title: 'Existing local evidence' })
    const externalDir = join(harness.home, 'outside')
    mkdirSync(externalDir, { recursive: true })
    writeFileSync(join(externalDir, 'secret.ts'), 'private evidence\n')
    const external = await fileEntry(harness, 'bug', {
      title: 'External evidence is unavailable',
      content: {
        ...content('bug', 'External evidence is unavailable'),
        file: { path: join(externalDir, 'secret.ts'), base: { kind: 'workspace', id: harness.project.workspace.id }, external: true, host: 'untrusted-host' }
      }
    })
    const reviewed = await fileEntry(harness, 'proposal', { title: 'Reviewed band' })
    await harness.operation('edit', { target: projectTarget(harness.project), id: reviewed.entry.id, ifRevision: 1, content: { recommendation: 'Human checked it.' } }, ui)

    const before = await harness.operation('list', { target: projectTarget(harness.project) }) as LedgerResponse
    rmSync(join(harness.project.path, 'src/main.ts'))
    const response = await harness.operation('review', { target: projectTarget(harness.project) }) as LedgerResponse
    expect(response.candidates.map((candidate: LedgerCandidate) => candidate.entry.id)).toEqual([present.entry.id, external.entry.id, reviewed.entry.id])
    const localEvidence = response.candidates.find((candidate: LedgerCandidate) => candidate.entry.id === present.entry.id)!.evidence
    expect(localEvidence).toMatchObject({ available: true, fileExists: false, baselineRevision: expect.any(String) })
    const externalEvidence = response.candidates.find((candidate: LedgerCandidate) => candidate.entry.id === external.entry.id)!.evidence
    expect(externalEvidence).toMatchObject({ available: true, note: expect.stringContaining('External locations are not dereferenced') })
    expect(externalEvidence.fileExists).toBeUndefined()
    expect(response.candidates[0]!.entry.state).toBe('open')
    const after = await harness.operation('list', { target: projectTarget(harness.project) }) as LedgerResponse
    expect(after.entries.map((entry: LedgerEntry) => [entry.id, entry.revision, entry.state])).toEqual(before.entries.map((entry: LedgerEntry) => [entry.id, entry.revision, entry.state]))

    const staleSetting = await harness.operation('settings', {
      target: projectTarget(harness.project), ifLedgerRevision: after.ledger!.revision, staleAfterDays: 0
    }, ui) as LedgerResponse
    expect(staleSetting.ledger!.staleAfterDays).toBe(0)
    // Staleness is defined against persisted wall-clock activity timestamps; wait for a clock tick.
    await Bun.sleep(5)
    const stale = await harness.operation('review', { target: projectTarget(harness.project) }) as LedgerResponse
    expect(stale.candidates.every((candidate: LedgerCandidate) => candidate.stale === true)).toBe(true)
    expect(entryIds(await harness.operation('list', { target: projectTarget(harness.project), filters: { stale: true } }))).toEqual([present.entry.id, external.entry.id, reviewed.entry.id])
    expect(stale.candidates.filter((candidate: LedgerCandidate) => candidate.reason === 'unreviewed').map((candidate: LedgerCandidate) => candidate.entry.id)).toEqual([present.entry.id, external.entry.id])
    expect(stale.candidates.at(-1)!.entry.id).toBe(reviewed.entry.id)
  })

  test('review refuses to follow a symlink outside the originating workspace', async () => {
    const harness = await start()
    const outside = join(harness.home, 'outside-secret.ts')
    writeFileSync(outside, 'must not be read\n')
    symlinkSync(outside, join(harness.project.path, 'src', 'linked.ts'))
    const created = await fileEntry(harness, 'bug', { title: 'Symlinked location', content: { ...content('bug'), file: 'src/linked.ts' } })
    const response = await harness.operation('review', { target: projectTarget(harness.project) }) as LedgerResponse
    const evidence = response.candidates.find((candidate: LedgerCandidate) => candidate.entry.id === created.entry.id)!.evidence
    expect(evidence.note).toMatch(/outside|scope/i)
    expect(evidence.fileExists).toBeUndefined()
  })

  test('bulk-state validates duplicate and stale immutable selections before changing any record', async () => {
    const harness = await start()
    const one = await fileEntry(harness, 'bug', { title: 'Bulk one' })
    const two = await fileEntry(harness, 'deferred', { title: 'Bulk two' })
    const ui = await uiClient(harness)
    const before = await harness.operation('list', { target: projectTarget(harness.project) }) as LedgerResponse

    const duplicate = await domainFailure(confirmedOperation(harness, 'bulk-state', {
      target: projectTarget(harness.project), state: 'resolved',
      selections: [{ id: one.entry.id, revision: 1 }, { id: one.entry.id, revision: 1 }]
    }, ui), 'invalid-request')
    expect(duplicate.code).toBe(RpcErrorCode.InvalidParams)
    const stale = await domainFailure(confirmedOperation(harness, 'bulk-state', {
      target: projectTarget(harness.project), state: 'resolved',
      selections: [{ id: one.entry.id, revision: 1 }, { id: two.entry.id, revision: 2 }]
    }, ui), 'conflict')
    expect(stale.data?.currentRevision).toBe(1)

    const unchanged = await harness.operation('list', { target: projectTarget(harness.project) }) as LedgerResponse
    expect(unchanged.entries.map((entry: LedgerEntry) => [entry.id, entry.revision, entry.state])).toEqual(before.entries.map((entry: LedgerEntry) => [entry.id, entry.revision, entry.state]))

    const changed = await confirmedOperation(harness, 'bulk-state', {
      target: projectTarget(harness.project), state: 'resolved',
      selections: [{ id: one.entry.id, revision: 1 }, { id: two.entry.id, revision: 1 }]
    }, ui) as LedgerResponse
    expect(changed.entries.map((entry: LedgerEntry) => entry.state)).toEqual(['resolved', 'resolved'])
    const sameState = await confirmedOperation(harness, 'bulk-state', {
      target: projectTarget(harness.project), state: 'resolved',
      selections: [{ id: one.entry.id, revision: 2 }, { id: two.entry.id, revision: 2 }]
    }, ui) as LedgerResponse
    expect(sameState.entries.every((entry: LedgerEntry) => entry.revision === 2)).toBe(true)
  })

  test('a destructive API call requires the standard confirmation and consumes the answer once', async () => {
    const harness = await start()
    const created = await fileEntry(harness, 'bug', { title: 'Needs confirmation' })
    const ui = await uiClient(harness)
    const params = {
      target: projectTarget(harness.project),
      state: 'archived',
      selections: [{ id: created.entry.id, revision: 1 }],
      confirmed: true
    }
    const pending = await failure(harness.operation('bulk-state', params, ui))
    expect(pending.code).toBe(RpcErrorCode.ConfirmationRequired)
    expect(pending.data).toMatchObject({ askId: expect.any(String), action: expect.stringContaining(created.entry.id) })
    const askId = String(pending.data!.askId)
    expect((await harness.operation('show', { target: projectTarget(harness.project), id: created.entry.id }) as LedgerResponse).entry.state).toBe('open')

    await ui.callAny('quirky.ask/answer', { askId, answers: { confirm: { value: true, source: 'input' } } })
    const accepted = await harness.operation('bulk-state', { ...params, confirmation: askId }, ui) as LedgerResponse
    expect(accepted.entries[0]!).toMatchObject({ id: created.entry.id, state: 'archived', revision: 2 })
    const reused = await failure(harness.operation('bulk-state', { ...params, confirmation: askId }, ui))
    expect(reused.code).toBe(RpcErrorCode.Conflict)
  })

  test('delete-entries preserves sequence tombstones and rejects stale selections atomically', async () => {
    const harness = await start()
    const one = await fileEntry(harness, 'bug', { title: 'Delete one' })
    const two = await fileEntry(harness, 'proposal', { title: 'Keep two' })
    const ui = await uiClient(harness)
    await harness.operation('edit', { target: projectTarget(harness.project), id: one.entry.id, ifRevision: 1, content: { title: 'Revision two' } })
    await domainFailure(confirmedOperation(harness, 'delete-entries', {
      target: projectTarget(harness.project), selections: [{ id: one.entry.id, revision: 2 }, { id: one.entry.id, revision: 2 }]
    }, ui), 'invalid-request')
    await domainFailure(confirmedOperation(harness, 'delete-entries', {
      target: projectTarget(harness.project), selections: [{ id: one.entry.id, revision: 1 }, { id: two.entry.id, revision: 1 }]
    }, ui), 'conflict')
    expect(entryIds(await harness.operation('list', { target: projectTarget(harness.project) }))).toEqual([one.entry.id, two.entry.id])

    await confirmedOperation(harness, 'delete-entries', {
      target: projectTarget(harness.project), selections: [{ id: one.entry.id, revision: 2 }]
    }, ui)
    await domainFailure(harness.operation('show', { target: projectTarget(harness.project), id: one.entry.id }), 'not-found')
    const next = await fileEntry(harness, 'deferred', { title: 'Sequence survives deletion' })
    expect(next.entry.id).toBe('deferred-3')
  })
})

// SC-10: owner-scoped settings and durability; invalid persisted payload must stop, not reset, the store.
describe('Project ledger API: settings, restart and persisted corruption', () => {
  test('staleness settings are per-ledger, range checked, revision guarded and durable across restart', async () => {
    const harness = await start()
    const noLedger = await harness.operation('settings', { target: projectTarget(harness.project), staleAfterDays: 0 }) as LedgerResponse
    expect(noLedger.ledger).toBeNull()

    await fileEntry(harness, 'bug', { title: 'Persistent staleness' })
    const otherProject = await harness.addProject('staleness-isolation')
    await fileEntry(harness, 'proposal', { title: 'Independent staleness setting', target: workspaceTarget(otherProject) })
    const otherUi = await harness.connectAs('ui', otherProject)
    const otherSettings = await harness.operation('settings', { target: projectTarget(otherProject) }, otherUi) as LedgerResponse
    expect(otherSettings.ledger!.staleAfterDays).toBe(90)
    const maximum = await harness.operation('settings', {
      target: projectTarget(otherProject), ifLedgerRevision: otherSettings.ledger!.revision, staleAfterDays: 3650
    }, otherUi) as LedgerResponse
    expect(maximum.ledger!.staleAfterDays).toBe(3650)
    otherUi.close()
    const ui = await uiClient(harness)
    const initial = await harness.operation('settings', { target: projectTarget(harness.project) }, ui) as LedgerResponse
    expect(initial.ledger!.staleAfterDays).toBe(90)
    const saved = await harness.operation('settings', {
      target: projectTarget(harness.project), ifLedgerRevision: initial.ledger!.revision, staleAfterDays: 0
    }, ui) as LedgerResponse
    expect(saved.ledger).toMatchObject({ staleAfterDays: 0, revision: initial.ledger!.revision + 1 })
    const detail = await harness.operation('show', { target: projectTarget(harness.project), id: 'bug-1' }, ui) as LedgerResponse
    const metadataHistory = detail.metadataHistory ?? detail.ledger!.metadataHistory
    expect(metadataHistory?.length).toBeGreaterThan(0)
    expect(JSON.stringify(metadataHistory)).toContain('"staleAfterDays":0')
    const staleSettings = await failure(harness.operation('settings', {
      target: projectTarget(harness.project), ifLedgerRevision: initial.ledger!.revision, staleAfterDays: 15
    }, ui))
    expect(staleSettings.data).toMatchObject({ kind: 'conflict', currentRevision: saved.ledger!.revision })

    for (const invalid of [-1, 3651, 1.5]) {
      const error = await failure(harness.operation('settings', { target: projectTarget(harness.project), ifLedgerRevision: saved.ledger!.revision, staleAfterDays: invalid }, ui))
      expect(error.code).toBe(RpcErrorCode.InvalidParams)
    }
    const beforeRestart = await harness.operation('show', { target: projectTarget(harness.project), id: 'bug-1' }) as LedgerResponse
    const oldRuntime = beforeRestart.runtime.runtimeId
    const oldProfile = beforeRestart.runtime.profileId
    await harness.restart()
    const afterRestart = await harness.operation('show', { target: projectTarget(harness.project), id: 'bug-1' }) as LedgerResponse
    expect(afterRestart.runtime).toMatchObject({ profileId: oldProfile })
    expect(afterRestart.runtime.runtimeId).not.toBe(oldRuntime)
    expect(afterRestart.entry.history).toHaveLength(1)
    expect(afterRestart.ledger!.staleAfterDays).toBe(0)
    const otherUiAfterRestart = await harness.connectAs('ui', otherProject)
    const persistedOther = await harness.operation('settings', { target: projectTarget(otherProject) }, otherUiAfterRestart) as LedgerResponse
    expect(persistedOther.ledger!.staleAfterDays).toBe(3650)
    otherUiAfterRestart.close()
    expect(afterRestart.ledger!.nextSequence).toBe(2)
  })

  test('malformed persisted JSON makes the ledger service unavailable and leaves the corrupted bytes untouched', async () => {
    const harness = await start()
    const created = await fileEntry(harness, 'proposal', { title: 'Persisted corruption marker' })
    const databasePath = join(harness.home, 'plugin-data', 'quirky.ledger', 'store.db')
    const database = new Database(databasePath)
    let corrupted = false
    try {
      const tables = database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]
      for (const { name: table } of tables) {
        const columns = database.query(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all() as { name: string; type: string }[]
        for (const { name: column } of columns) {
          let rows: { rowid: number; value: string }[]
          try {
            rows = database.query(`SELECT rowid, "${column.replaceAll('"', '""')}" AS value FROM "${table.replaceAll('"', '""')}" WHERE typeof("${column.replaceAll('"', '""')}") = 'text'`).all() as { rowid: number; value: string }[]
          } catch {
            continue
          }
          const row = rows.find((candidate) => candidate.value.includes('Persisted corruption marker') && isJsonObject(candidate.value))
          if (!row) continue
          database.query(`UPDATE "${table.replaceAll('"', '""')}" SET "${column.replaceAll('"', '""')}" = '{malformed-json' WHERE rowid = ?`).run(row.rowid)
          corrupted = true
          break
        }
        if (corrupted) break
      }
    } finally {
      database.close()
    }
    expect(corrupted).toBe(true)
    const corruptBytes = await Bun.file(databasePath).arrayBuffer()
    await harness.restart()
    const error = await domainFailure(harness.operation('list', { target: projectTarget(harness.project) }), 'incompatible-store')
    expect(error.data?.kind).toBe('incompatible-store')
    expect(new Uint8Array(await corruptBytes)).toEqual(new Uint8Array(await Bun.file(databasePath).arrayBuffer()))
    expect(created.entry.id).toBe('proposal-1')
  })
})

function isJsonObject(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null
  } catch {
    return false
  }
}

// SC-11/12: retention, stable project identity, explicit attachment and owner deletion guards.
describe('Project ledger API: owner lifecycle and attachment', () => {
  test('removal preview snapshots guard repo removal; retained entries detach and reattach eagerly on re-add', async () => {
    const harness = await start()
    const created = await fileEntry(harness, 'bug', { title: 'Retain across project removal' })
    await harness.operation('edit', {
      target: projectTarget(harness.project), id: created.entry.id, ifRevision: 1,
      content: { title: 'Revision before removal preview' }
    })
    const preview = await harness.operation('removal-preview', { removal: { repoIds: [harness.project.repo.id] } }) as LedgerResponse
    expect(preview.removalPreview).toEqual([expect.objectContaining({ ledgerId: created.ledger!.ledgerId, revision: created.ledger!.revision + 1, entryCount: 1 })])
    const stalePreview = await failure(harness.operation('removal-preview', {
      removal: {
        repoIds: [harness.project.repo.id],
        expectedLedgers: [{ ledgerId: created.ledger!.ledgerId, revision: created.ledger!.revision }]
      }
    }))
    expect(stalePreview.code).toBe(RpcErrorCode.Conflict)

    const stale = await failure(harness.client.callAny('quirky.repo/remove', {
      repo: harness.project.repo.id,
      expectedLedgers: [{ ledgerId: created.ledger!.ledgerId, revision: created.ledger!.revision }]
    }))
    expect(stale.code).toBe(RpcErrorCode.Conflict)
    expect((await harness.client.callAny('quirky.repo/list') as Repo[]).some((repo) => repo.id === harness.project.repo.id)).toBe(true)

    git(harness.project.path, 'remote', 'set-url', 'origin', 'https://github.com/acme/renamed.git')
    const sticky = await harness.operation('list', { target: projectTarget(harness.project) }) as LedgerResponse
    expect(sticky.ledger!.ledgerId).toBe(created.ledger!.ledgerId)
    const current = await harness.operation('removal-preview', { removal: { repoIds: [harness.project.repo.id] } }) as LedgerResponse
    await harness.client.callAny('quirky.repo/remove', {
      repo: harness.project.repo.id,
      expectedLedgers: current.removalPreview.map((ledger: LedgerSummary) => ({ ledgerId: ledger.ledgerId, revision: ledger.revision }))
    })
    await harness.restart()
    const detached = await harness.operation('list', { target: { ledgerId: created.ledger!.ledgerId } }) as LedgerResponse
    expect(detached.ledger).toMatchObject({ owner: null, formerOwner: { tier: 'project', id: harness.project.repo.id }, entryCount: 1 })
    expect(detached.entries[0]!.id).toBe(created.entry.id)

    const readded = await harness.addProject('alpha-readded', { origin: 'https://test-user:test-secret@GITHUB.COM:443/ACME/ALPHA.git' })
    const recovered = await harness.operation('list', { target: projectTarget(readded) }) as LedgerResponse
    expect(recovered.ledger!.ledgerId).toBe(created.ledger!.ledgerId)
    expect(recovered.entries[0]!.id).toBe(created.entry.id)
    const next = await fileEntry(harness, 'deferred', { title: 'Sequence continued', target: workspaceTarget(readded) })
    expect(next.entry.id).toBe('deferred-2')
  })

  test('recovers a project ledger from its canonical repository root when no origin remote exists', async () => {
    const harness = await start()
    const original = await harness.addProject('path-identity')
    const created = await fileEntry(harness, 'proposal', { title: 'Stable local-root identity', target: workspaceTarget(original) })
    await harness.client.callAny('quirky.repo/remove', { repo: original.repo.id })
    const repo = await harness.client.callAny('quirky.repo/add', { path: original.path }) as Repo
    const worktrees = await harness.client.callAny('quirky.worktree/list', { repo: repo.id }) as Worktree[]
    const workspace = worktrees.find((worktree) => worktree.path === original.path)!
    const readded = { repo, workspace, path: original.path }
    const recovered = await harness.operation('list', { target: projectTarget(readded) }) as LedgerResponse
    expect(recovered.ledger!.ledgerId).toBe(created.ledger!.ledgerId)
    expect(recovered.entries[0]!.id).toBe(created.entry.id)
  })

  test('canonical project identity preserves non-GitHub path case and nondefault ports', async () => {
    const harness = await start()
    const original = await harness.addProject('nondefault-port', { origin: 'https://gitlab.example:8443/Acme/App.git' })
    const created = await fileEntry(harness, 'bug', { title: 'Non-GitHub case-sensitive identity', target: workspaceTarget(original) })
    await harness.client.callAny('quirky.repo/remove', { repo: original.repo.id })

    const differentCase = await harness.addProject('different-case', { origin: 'ssh://git@gitlab.example:8443/acme/app.git' })
    expect((await harness.operation('list', { target: projectTarget(differentCase) }) as LedgerResponse).ledger).toBeNull()
    await harness.client.callAny('quirky.repo/remove', { repo: differentCase.repo.id })

    const defaultPort = await harness.addProject('default-port', { origin: 'https://gitlab.example/Acme/App.git' })
    expect((await harness.operation('list', { target: projectTarget(defaultPort) }) as LedgerResponse).ledger).toBeNull()
    await harness.client.callAny('quirky.repo/remove', { repo: defaultPort.repo.id })

    const equivalent = await harness.addProject('transport-equivalent', { origin: 'ssh://git@gitlab.example:8443/Acme/App.git' })
    const recovered = await harness.operation('list', { target: projectTarget(equivalent) }) as LedgerResponse
    expect(recovered.ledger!.ledgerId).toBe(created.ledger!.ledgerId)
    expect(recovered.entries[0]!.id).toBe(created.entry.id)
  })

  test('ambiguous live codebase matches remain detached until a unique project is available', async () => {
    const harness = await start()
    const origin = 'https://github.com/acme/ambiguous.git'
    const original = await harness.addProject('ambiguous-original', { origin })
    const created = await fileEntry(harness, 'bug', { title: 'Do not choose between live clones', target: workspaceTarget(original) })
    const firstClone = await harness.addProject('ambiguous-first', { origin })
    const secondClone = await harness.addProject('ambiguous-second', { origin })
    await harness.client.callAny('quirky.repo/remove', { repo: original.repo.id })

    const detached = await harness.operation('catalog', {}) as LedgerResponse
    expect(detached.ledgers.find((ledger: LedgerSummary) => ledger.ledgerId === created.ledger!.ledgerId)!.owner).toBeNull()
    expect((await harness.operation('list', { target: projectTarget(firstClone) }) as LedgerResponse).ledger).toBeNull()
    expect((await harness.operation('list', { target: projectTarget(secondClone) }) as LedgerResponse).ledger).toBeNull()

    await harness.client.callAny('quirky.repo/remove', { repo: secondClone.repo.id })
    const recovered = await harness.operation('list', { target: projectTarget(firstClone) }) as LedgerResponse
    expect(recovered.ledger!.ledgerId).toBe(created.ledger!.ledgerId)
    expect(recovered.entries[0]!.id).toBe(created.entry.id)
  })

  test('same-name groups never auto-reattach a detached group ledger', async () => {
    const harness = await start()
    const group = await harness.client.callAny('quirky.repo/groupCreate', { name: 'Retained Group' }) as { id: string }
    await harness.client.callAny('quirky.repo/groupAdd', { group: group.id, repo: harness.project.repo.id })
    const created = await harness.request({ operation: 'file', target: { workspaceId: harness.project.workspace.id, group: true }, type: 'proposal', content: content('proposal', 'Group retention') }) as LedgerResponse
    const stalePreview = await harness.operation('removal-preview', { removal: { groupIds: [group.id] } }) as LedgerResponse
    expect(stalePreview.removalPreview).toEqual([expect.objectContaining({ ledgerId: created.ledger!.ledgerId, entryCount: 1 })])
    await harness.request({ operation: 'file', target: { workspaceId: harness.project.workspace.id, group: true }, type: 'decision', content: content('decision', 'Second group record') })
    const staleRemoval = await failure(harness.client.callAny('quirky.repo/groupDelete', {
      group: group.id,
      expectedLedgers: stalePreview.removalPreview.map((ledger: LedgerSummary) => ({ ledgerId: ledger.ledgerId, revision: ledger.revision }))
    }))
    expect(staleRemoval.code).toBe(RpcErrorCode.Conflict)
    expect((await harness.client.callAny('quirky.repo/groupList') as { id: string }[]).some((item) => item.id === group.id)).toBe(true)
    const preview = await harness.operation('removal-preview', { removal: { groupIds: [group.id] } }) as LedgerResponse
    expect(preview.removalPreview[0]!.entryCount).toBe(2)
    await harness.client.callAny('quirky.repo/groupDelete', {
      group: group.id,
      expectedLedgers: preview.removalPreview.map((ledger: LedgerSummary) => ({ ledgerId: ledger.ledgerId, revision: ledger.revision }))
    })
    const sameName = await harness.client.callAny('quirky.repo/groupCreate', { name: 'Retained Group' }) as { id: string }
    const catalog = await harness.operation('catalog', {}) as LedgerResponse
    const detachedSummary = catalog.ledgers.find((ledger: LedgerSummary) => ledger.ledgerId === created.ledger!.ledgerId)!
    expect(detachedSummary.owner).toBeNull()
    expect(detachedSummary.formerOwner!.id).toBe(group.id)
    expect(sameName.id).not.toBe(group.id)
  })

  test('detached ledgers can be explicitly attached to an empty same-tier owner with equivalence history', async () => {
    const harness = await start()
    const created = await fileEntry(harness, 'bug', { title: 'Move only by explicit attach', content: { ...content('bug'), file: 'src/main.ts:7' } })
    await harness.client.callAny('quirky.repo/remove', { repo: harness.project.repo.id })
    const target = await harness.addProject('new-owner')
    const ui = await uiClient(harness)
    const detached = await harness.operation('list', { target: { ledgerId: created.ledger!.ledgerId } }) as LedgerResponse
    expect(detached.ledger).toMatchObject({ owner: null, revision: 2 })
    const detachedEdit = await harness.operation('edit', {
      target: { ledgerId: created.ledger!.ledgerId }, id: created.entry.id, ifRevision: 1,
      content: { title: 'Edited while detached' }
    }, ui) as LedgerResponse
    expect(detachedEdit.entry).toMatchObject({ revision: 2, reviewed: true })
    const detachedAfterEdit = await harness.operation('list', { target: { ledgerId: created.ledger!.ledgerId } }) as LedgerResponse
    const otherTier = await harness.client.callAny('quirky.repo/groupCreate', { name: 'Wrong attachment tier' }) as { id: string }
    await domainFailure(confirmedOperation(harness, 'attach', {
      target: { ledgerId: created.ledger!.ledgerId }, ifLedgerRevision: detachedAfterEdit.ledger!.revision,
      attachTo: { tier: 'group', id: otherTier.id }
    }, ui), 'attachment-refused')
    await domainFailure(confirmedOperation(harness, 'attach', {
      target: { ledgerId: created.ledger!.ledgerId }, ifLedgerRevision: detachedAfterEdit.ledger!.revision - 1,
      attachTo: { tier: 'project', id: target.repo.id }
    }, ui), 'conflict')

    const attached = await confirmedOperation(harness, 'attach', {
      target: { ledgerId: created.ledger!.ledgerId },
      ifLedgerRevision: detachedAfterEdit.ledger!.revision,
      attachTo: { tier: 'project', id: target.repo.id }
    }, ui) as LedgerResponse
    expect(attached.ledger).toMatchObject({ owner: { tier: 'project', id: target.repo.id }, formerOwner: { tier: 'project', id: harness.project.repo.id } })
    const detail = await harness.operation('show', { target: projectTarget(target), id: created.entry.id }) as LedgerResponse
    expect(detail.entry.id).toBe(created.entry.id)
    expect(detail.ledger!.sourceEquivalences ?? detail.sourceEquivalences).toEqual(expect.arrayContaining([expect.arrayContaining([harness.project.repo.id, target.repo.id])]))

    const occupied = await harness.addProject('occupied-owner')
    await fileEntry(harness, 'proposal', { title: 'Occupy destination', target: workspaceTarget(occupied) })
    await domainFailure(confirmedOperation(harness, 'attach', {
      target: { ledgerId: created.ledger!.ledgerId },
      ifLedgerRevision: attached.ledger!.revision,
      attachTo: { tier: 'project', id: occupied.repo.id }
    }, ui), 'attachment-refused')
    await domainFailure(confirmedOperation(harness, 'attach', {
      target: { ledgerId: created.ledger!.ledgerId },
      ifLedgerRevision: attached.ledger!.revision,
      attachTo: { tier: 'group', id: 'group_missing' }
    }, ui), 'attachment-refused')
  })

  test('delete-ledger requires the current ledger snapshot, confirmation and removes every entry', async () => {
    const harness = await start()
    await fileEntry(harness, 'bug', { title: 'Delete ledger contents' })
    await fileEntry(harness, 'proposal', { title: 'Second entry before ledger deletion' })
    const ui = await uiClient(harness)
    const current = await harness.operation('catalog', {}) as LedgerResponse
    const ledger = current.ledgers[0]!
    await domainFailure(confirmedOperation(harness, 'delete-ledger', {
      target: { ledgerId: ledger.ledgerId }, ifLedgerRevision: ledger.revision - 1
    }, ui), 'conflict')
    const removed = await confirmedOperation(harness, 'delete-ledger', {
      target: { ledgerId: ledger.ledgerId }, ifLedgerRevision: ledger.revision
    }, ui) as LedgerResponse
    expect(removed.ledger).toBeNull()
    expect((await harness.operation('catalog', {}) as LedgerResponse).ledgers).toEqual([])
  })

  test('public operation wrappers delegate to the shared request engine, including import and catalog', async () => {
    const harness = await start()
    const viaWrapper = await harness.operation('file', {
      target: workspaceTarget(harness.project), type: 'proposal', content: content('proposal', 'Wrapper route')
    }) as LedgerResponse
    const viaRequest = await harness.request({ operation: 'show', target: projectTarget(harness.project), id: viaWrapper.entry.id }) as LedgerResponse
    expect(viaRequest.entry).toMatchObject({ id: viaWrapper.entry.id, type: 'proposal' })
    expect((await harness.operation('catalog', {}) as LedgerResponse).ledgers).toHaveLength(1)
    const noSource = await harness.operation('import', { target: workspaceTarget(harness.project) }) as LedgerResponse
    expect(noSource.importResult).toMatchObject({ created: [], updated: [], alreadyPresent: [] })
    expect((await harness.operation('removal-preview', { removal: { repoIds: [harness.project.repo.id] } }) as LedgerResponse).removalPreview).toHaveLength(1)
  })
})
