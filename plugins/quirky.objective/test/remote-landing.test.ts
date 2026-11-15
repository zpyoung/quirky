import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { authorize, execute, preflight } from '../../quirky.sitter/src/github'
import { decide, stop, worldFromHosting } from '../../quirky.sitter/src/policy'

const H1 = '1'.repeat(40)
const H2 = '2'.repeat(40)
const B1 = 'b'.repeat(40)
const REVIEW_URL = 'https://github.com/test-owner/test-repo/pull/7'
const REPOSITORY = { host: 'github.com', owner: 'test-owner', repo: 'test-repo' }
const HEAD_REPOSITORY = { host: 'github.com', owner: 'test-owner', repo: 'test-repo' }

type Identity = { host: string; owner: string; repo: string }
type ExpectedReview = {
  number: number
  url: string
  repository: Identity
  headRepository: Identity
  headRefName: string
  baseRefName: string
  headSha: string
}

function expectedReview(overrides: Partial<ExpectedReview> = {}): ExpectedReview {
  return {
    number: 7,
    url: REVIEW_URL,
    repository: { ...REPOSITORY },
    headRepository: { ...HEAD_REPOSITORY },
    headRefName: 'feature',
    baseRefName: 'main',
    headSha: H1,
    ...overrides
  }
}

function payload(pin: ExpectedReview | undefined = expectedReview()) {
  return {
    worktreeId: 'w1',
    branch: 'feature',
    headRefName: 'feature',
    provider: 'github',
    reviewNumber: 7,
    reviewUrl: REVIEW_URL,
    repository: { ...REPOSITORY },
    branchUpdateMode: 'merge-base-update',
    mergeMethod: null,
    mergeCheckScope: 'all',
    ...(pin === undefined ? {} : { expectedReview: pin })
  }
}

function enrollment(pin: ExpectedReview | undefined = expectedReview()) {
  return {
    capabilities: { updateBranch: 'off', resolveConflicts: 'off', fixChecks: 'off', merge: 'gated' },
    kindPayload: payload(pin)
  }
}

function hostingReview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    url: REVIEW_URL,
    state: 'open',
    headRefName: 'feature',
    baseRefName: 'main',
    headRefOid: H1,
    baseRefOid: B1,
    repository: { ...REPOSITORY },
    headRepository: { name: 'test-repo', owner: { login: 'test-owner' } },
    headRepositoryOwner: { login: 'test-owner' },
    draft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    mergeQueueRequired: false,
    mergeMetadataKnown: true,
    mergeQueueKnown: true,
    mergeMethods: { default: 'squash', allowed: ['squash', 'merge', 'rebase'] },
    ...overrides
  }
}

function pinnedSnapshot(
  overrides: Record<string, unknown> = {},
  freshness: string = 'live'
) {
  const canonicalPayload = payload() as never
  const world = worldFromHosting(hostingReview(overrides), null, canonicalPayload)
  return {
    freshness,
    contentIdentity: JSON.stringify([world.headSha, world.baseSha]),
    observedAtMs: 1,
    world
  } as never
}

test('authorization validates and preserves the expected review pin', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quirky-sitter-pin-'))
  try {
    let review = hostingReview()
    const calls: string[] = []
    const call = async (method: string) => {
      calls.push(method)
      if (method === 'quirky.worktree/resolve') {
        return { id: 'w1', repoId: 'r1', path: directory, branch: 'feature', kind: 'git' }
      }
      if (method === 'quirky.hosting/forBranch') return { kind: 'found', review }
      throw new Error(`unexpected call: ${method}`)
    }
    const input = (pin: unknown) => ({
      kind: 'hosted-review',
      kindPayload: {
        worktree: 'id:w1',
        branchUpdateMode: 'merge-base-update',
        mergeMethod: null,
        mergeCheckScope: 'all',
        expectedReview: pin
      },
      capabilities: { updateBranch: 'off', resolveConflicts: 'off', fixChecks: 'off', merge: 'gated' }
    })

    const pin = expectedReview()
    const authorized = await authorize(call as never, input(pin) as never)
    expect(authorized.kindPayload.expectedReview).toEqual(pin)

    const mismatches: Array<Record<string, unknown>> = [
      { headRefOid: H2 },
      { headRepository: { name: 'fork', owner: { login: 'contributor' } }, headRepositoryOwner: { login: 'contributor' } },
      { baseRefName: 'develop' },
      { number: 8 },
      { url: 'https://github.com/test-owner/test-repo/pull/8' }
    ]
    for (const mismatch of mismatches) {
      review = hostingReview(mismatch)
      await expect(authorize(call as never, input(pin) as never)).rejects.toThrow()
    }

    calls.length = 0
    const malformed = { ...pin, headSha: 'not-a-commit' }
    await expect(authorize(call as never, input(malformed) as never)).rejects.toThrow()
    expect(calls).toEqual([])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('hosting observations include the fork head repository identity', () => {
  const observed = worldFromHosting(hostingReview({
    headRepository: { name: 'contribution', owner: { login: 'contributor' } },
    headRepositoryOwner: { login: 'contributor' }
  }), null, payload() as never) as unknown as Record<string, unknown>
  expect(observed.headRepository).toEqual({ host: 'github.com', owner: 'contributor', repo: 'contribution' })
})

test('pinned policy parks moved heads and review mismatches before merged lifecycle completion', () => {
  const cases: Array<{ name: string; overrides: Record<string, unknown>; reason: string }> = [
    { name: 'moved head', overrides: { headRefOid: H2 }, reason: 'objective-head-moved' },
    {
      name: 'fork head repository',
      overrides: { headRepository: { name: 'fork', owner: { login: 'contributor' } }, headRepositoryOwner: { login: 'contributor' } },
      reason: 'objective-review-mismatch'
    },
    { name: 'base ref', overrides: { baseRefName: 'develop' }, reason: 'objective-review-mismatch' },
    { name: 'review number', overrides: { number: 8 }, reason: 'objective-review-mismatch' },
    { name: 'review URL', overrides: { url: 'https://github.com/test-owner/test-repo/pull/8' }, reason: 'objective-review-mismatch' },
    {
      name: 'missing head repository metadata',
      overrides: { headRepository: undefined, headRepositoryOwner: undefined },
      reason: 'objective-review-mismatch'
    },
    { name: 'missing head SHA', overrides: { headRefOid: undefined }, reason: 'objective-head-moved' }
  ]

  for (const item of cases) {
    const merged = pinnedSnapshot({ state: 'merged', ...item.overrides })
    const stopped = stop(merged, [], enrollment() as never)
    expect(stopped?.kind, item.name).toBe('park')
    expect((stopped as { detail?: string } | null)?.detail, item.name).toContain(`${item.reason}:`)

    const open = pinnedSnapshot(item.overrides)
    expect(decide(open, [], enrollment() as never), item.name).toMatchObject({
      action: null,
      reason: item.reason
    })
  }
})

test('cached or incomplete observations cannot complete a pinned merged review', () => {
  const cached = pinnedSnapshot({ state: 'merged' }, 'cached')
  expect(stop(cached, [], enrollment() as never)).toMatchObject({
    kind: 'park',
    reason: 'stop-predicate',
    detail: expect.stringContaining('objective-review-mismatch:')
  })
  expect(decide(cached, [], enrollment() as never)).toMatchObject({
    action: null,
    reason: 'objective-review-mismatch'
  })

  for (const missing of [
    { headRefName: undefined },
    { baseRefName: undefined },
    { repository: undefined },
    { headRepository: undefined, headRepositoryOwner: undefined },
    { number: undefined },
    { url: undefined }
  ]) {
    expect(stop(pinnedSnapshot({ state: 'merged', ...missing }), [], enrollment() as never)).toMatchObject({
      kind: 'park',
      reason: 'stop-predicate'
    })
  }
})

test('only the exact live pinned review is accepted as merged', () => {
  expect(stop(pinnedSnapshot({ state: 'merged' }), [], enrollment() as never)).toEqual({
    kind: 'terminal',
    state: 'merged',
    reason: 'review merged'
  })
})

test('preflight and execution reject stale or forged pinned actions before mutation', async () => {
  const calls: string[] = []
  const call = async (method: string) => {
    calls.push(method)
    return undefined
  }
  let processCalls = 0
  const processRun = async () => {
    processCalls++
    return { stdout: new Uint8Array(), stdoutText: '', stderr: '', exitCode: 0, signal: null, durationMs: 0 }
  }
  const pinned = enrollment()
  const staleSnapshot = pinnedSnapshot({ headRefOid: H2 })
  const preparation = {
    kind: 'prepare-fix',
    capability: 'fixChecks',
    visibility: 'local',
    contentIdentity: JSON.stringify([H1, B1]),
    evidenceKey: 'prepare',
    expectedHeadSha: H1,
    failedChecks: []
  }
  const verdict = await preflight(call as never, {
    action: preparation as never,
    snapshot: staleSnapshot,
    journal: [],
    enrollment: pinned as never
  }, processRun as never)
  expect(verdict).toMatchObject({ verdict: 'hold', reason: 'objective-head-moved' })
  expect(calls).toEqual([])
  expect(processCalls).toBe(0)
  const forgedPreflight = await preflight(call as never, {
    action: { ...preparation, expectedHeadSha: H2 } as never,
    snapshot: pinnedSnapshot(),
    journal: [],
    enrollment: pinned as never
  }, processRun as never)
  expect(forgedPreflight).toMatchObject({ verdict: 'hold', reason: 'objective-head-moved' })
  expect(calls).toEqual([])
  expect(processCalls).toBe(0)


  const forgedMerge = { kind: 'merge', head: H2, method: 'squash', ordinal: 1 }
  const result = await execute(call as never, forgedMerge as never, pinned as never)
  expect(result).toMatchObject({
    effect: 'not-landed',
    reason: expect.stringContaining('objective-head-moved')
  })
  expect(calls).toEqual([])
})
test('pinned execute revalidates the complete live review identity before merge', async () => {
  const staleReviews: Array<[string, unknown]> = [
    ['changed base ref', { kind: 'found', review: hostingReview({ baseRefName: 'release' }) }],
    ['changed head repository', {
      kind: 'found',
      review: hostingReview({
        headRepository: { name: 'forked-repo', owner: { login: 'test-owner' } }
      })
    }],
    ['changed review URL', { kind: 'found', review: hostingReview({ url: 'https://github.com/test-owner/test-repo/pull/8' }) }],
    ['changed review number', { kind: 'found', review: hostingReview({ number: 8 }) }],
    ['unavailable lookup', { kind: 'unavailable', message: 'lookup unavailable' }],
    ['unknown lookup', { kind: 'unknown' }]
  ]

  for (const [description, liveLookup] of staleReviews) {
    const calls: string[] = []
    const call = async (method: string) => {
      calls.push(method)
      if (method === 'quirky.hosting/review') return liveLookup
      if (method === 'quirky.hosting/merge') return { state: 'merged' }
      throw new Error(`unexpected call: ${method}`)
    }
    const result = await execute(
      call as never,
      { kind: 'merge', head: H1, method: 'squash', ordinal: 1 } as never,
      enrollment() as never
    )

    expect(result, description).toMatchObject({ effect: 'not-landed' })
    expect(calls, description).toEqual(['quirky.hosting/review'])
  }
})

test('pinned execute allows merge when the complete live review identity matches', async () => {
  const calls: string[] = []
  const call = async (method: string) => {
    calls.push(method)
    if (method === 'quirky.hosting/review') return { kind: 'found', review: hostingReview() }
    if (method === 'quirky.hosting/merge') return { state: 'merged' }
    throw new Error(`unexpected call: ${method}`)
  }

  const result = await execute(
    call as never,
    { kind: 'merge', head: H1, method: 'squash', ordinal: 1 } as never,
    enrollment() as never
  )

  expect(result).toEqual({ effect: 'landed' })
  expect(calls).toEqual(['quirky.hosting/review', 'quirky.hosting/merge'])
})
