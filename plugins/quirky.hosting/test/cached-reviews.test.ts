import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { watch } from 'node:fs/promises'
import { join } from 'node:path'
import { RpcErrorCode, type PluginContext, type Worktree } from '@quirky/protocol'
import { isRecord } from '../src/pr-data'
import { createEnv, type HostingEnv } from '../src/env'
import { createPRLookup, type PRLookup } from '../src/pr-review'
import { bootHosting, type HostingTest } from './helpers'

const hosts: HostingTest[] = []
const cachedReviewEnvironments: HostingEnv[] = []
afterEach(async () => {
  for (const environment of cachedReviewEnvironments.splice(0).reverse()) await environment.dispose()
  for (const host of hosts.splice(0).reverse()) await host.cleanup()
})

const ghFixture = String.raw`
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { watch } from 'node:fs/promises'
import { dirname, join } from 'node:path'
const statePath = join(process.env.QUIRKY_TEST_FIXTURE_DIR ?? '', 'state.json')
const readState = () => JSON.parse(readFileSync(statePath, 'utf8'))
const saveState = (state) => {
  const temporary = statePath + '.' + process.pid + '.tmp'
  writeFileSync(temporary, JSON.stringify(state))
  renameSync(temporary, statePath)
}
const args = process.argv.slice(2)
const input = process.env.QUIRKY_TEST_GH_INPUT ?? ''
const fields = input.length === 0 ? {} : JSON.parse(input)
const output = (value) => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value))
const fail = (message) => { process.stderr.write(message); process.exit(1) }
const option = (name, fallback = undefined) => {
  const index = args.indexOf(name)
  return index < 0 ? fallback : args[index + 1]
}
const state = readState()
const prs = Array.isArray(state.prs) ? state.prs : []
const byNumber = (value) => prs.find((item) => item.number === Number(value))
const ownerRepo = (value) => {
  const parts = String(value ?? 'test-owner/test-repo').split('/')
  return { owner: parts.at(-2) ?? 'test-owner', repo: parts.at(-1) ?? 'test-repo' }
}
const selectedRepo = ownerRepo(option('--repo', option('-R', 'test-owner/test-repo')))
const asRestPull = (item) => {
  const merged = item.state === 'MERGED'
  const closed = item.state === 'CLOSED' || merged
  const owner = item.headRepositoryOwner?.login ?? item.headRepository?.owner?.login ?? selectedRepo.owner
  const repo = item.headRepository?.name ?? selectedRepo.repo
  return {
    number: item.number,
    id: item.number,
    url: item.url,
    html_url: item.url,
    title: item.title,
    body: item.body,
    state: closed ? 'closed' : 'open',
    draft: item.isDraft === true,
    merged_at: merged ? new Date(0).toISOString() : null,
    mergeable: item.mergeable === 'MERGEABLE' ? true : item.mergeable === 'CONFLICTING' ? false : null,
    mergeable_state: typeof item.mergeStateStatus === 'string' ? item.mergeStateStatus.toLowerCase() : null,
    base: { ref: item.baseRefName, sha: item.baseRefOid, repo: { name: selectedRepo.repo, owner: { login: selectedRepo.owner } } },
    head: { ref: item.headRefName, sha: item.headRefOid, repo: { name: repo, owner: { login: owner } }, user: { login: owner } }
  }
}
const command = args[0]
if (command === 'auth' && args[1] === 'status') {
  if (state.authenticated === false) fail('You are not logged into any GitHub hosts. Run gh auth login.')
  output('Logged in to github.com account test-user (keyring)\n')
} else if (command === 'auth' && args[1] === 'token') {
  output('isolated-test-token\n')
} else if (command === 'api') {
  const endpoint = args.find((value) => value.startsWith('repos/')) ?? ''
  if (args.includes('rate_limit')) {
    output({ resources: { core: { limit: 5000, remaining: 4000, reset: 1999999999 }, graphql: { limit: 5000, remaining: 4000, reset: 1999999999 }, search: { limit: 30, remaining: 30, reset: 1999999999 } } })
  } else if (args.includes('user')) {
    output({ login: 'test-user' })
  } else if (args.includes('graphql')) {
    output({ data: { repository: {
      id: 'REPO_test', viewerDefaultMergeMethod: 'SQUASH', mergeCommitAllowed: true,
      rebaseMergeAllowed: true, squashMergeAllowed: true, autoMergeAllowed: true,
      defaultBranchRef: { name: state.defaultBranch ?? 'main' }, mergeQueue: null,
      ref: { rules: { nodes: [] } }
    } } })
  } else if (endpoint.includes('/pulls?')) {
    if (state.listFailure) fail('HTTP 503: temporarily unavailable')
    const query = new URLSearchParams(endpoint.split('?')[1] ?? '')
    const head = query.get('head') ?? ''
    const colon = head.indexOf(':')
    const owner = colon < 0 ? '' : head.slice(0, colon)
    const branch = colon < 0 ? head : head.slice(colon + 1)
    output(prs.filter((item) => item.headRefName === branch &&
      (!owner || (item.headRepositoryOwner?.login ?? item.headRepository?.owner?.login) === owner) &&
      (query.get('state') === 'all' || item.state === 'OPEN' || item.state === 'DRAFT')).map(asRestPull))
  } else if (/\/pulls\/\d+$/.test(endpoint)) {
    const number = Number(endpoint.match(/\/pulls\/(\d+)$/)?.[1])
    const item = byNumber(number)
    if (!item) fail('HTTP 404: Not Found')
    const method = option('--method', option('-X', 'GET')).toUpperCase()
    if (method === 'PATCH') {
      const request = fields && typeof fields === 'object' ? fields : {}
      Object.assign(item, request)
      saveState(state)
    }
    output(asRestPull(item))
  } else {
    output({})
  }
} else if (command === 'pr' && args[1] === 'view') {
  const number = args.find((value, index) => index > 1 && /^\d+$/.test(value))
  const item = number ? byNumber(number) : undefined
  if (!item) fail('HTTP 404: Not Found')
  if (state.pauseNextView === true && state.lookupStarted !== true) {
    state.lookupStarted = true
    saveState(state)
    const watcher = watch(dirname(statePath), { persistent: false })
    try {
      while (readState().releaseLookup !== true) await watcher.next()
    } finally {
      await watcher.return?.()
    }
  }
  output(item)
} else {
  output({})
}
`

type ReviewState = 'OPEN' | 'DRAFT' | 'CLOSED' | 'MERGED'
type CheckConclusion = 'SUCCESS' | 'FAILURE' | 'PENDING' | 'NEUTRAL'

function review(number: number, headOid: string, state: ReviewState = 'OPEN', conclusion: CheckConclusion = 'SUCCESS'): Record<string, unknown> {
  return {
    number,
    id: `PR_fixture_${number}`,
    title: `Review ${number}`,
    body: 'fixture review',
    state,
    url: `https://github.com/test-owner/test-repo/pull/${number}`,
    isDraft: state === 'DRAFT',
    baseRefName: 'main',
    baseRefOid: 'b'.repeat(40),
    headRefName: 'feature',
    headRefOid: headOid,
    headRepositoryOwner: { login: 'test-owner' },
    headRepository: { name: 'test-repo', owner: { login: 'test-owner' } },
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    statusCheckRollup: [{ state: conclusion === 'PENDING' ? 'IN_PROGRESS' : 'SUCCESS', status: conclusion === 'PENDING' ? 'IN_PROGRESS' : 'COMPLETED', conclusion }]
  }
}

async function host(prs: Record<string, unknown>[] = [], extra: Record<string, unknown> = {}): Promise<HostingTest> {
  const result = await bootHosting(ghFixture)
  hosts.push(result)
  result.writeState({ authenticated: true, defaultBranch: 'main', prs, ...extra })
  return result
}

function outputOf(testHost: HostingTest, args: string[]): string {
  const result = Bun.spawnSync({ cmd: ['git', ...args], cwd: testHost.repoPath, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}

function git(testHost: HostingTest, args: string[]): void {
  const result = Bun.spawnSync({ cmd: ['git', ...args], cwd: testHost.repoPath, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
}

async function cached(testHost: HostingTest): Promise<Record<string, unknown>> {
  const result = await testHost.client.callAny('quirky.hosting/cachedReviews', { worktrees: [testHost.worktree] })
  if (!isRecord(result) || !Array.isArray(result.workspaces) || !isRecord(result.workspaces[0])) {
    throw new Error('cachedReviews returned an invalid workspace result')
  }
  return result.workspaces[0]
}

type FixtureCall = { method: string; params?: Record<string, unknown> }
type CachedReviewsCaller = Parameters<PRLookup['cachedReviews']>[1]

function cachedWorktree(index: number, repoIndex: number, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: `wt_${String(index).padStart(12, '0')}`,
    repoId: `repo_${repoIndex}`,
    path: `/unavailable/repo-${repoIndex}/worktree-${index}`,
    kind: 'git',
    instanceId: `instance-${index}`,
    branch: `feature-${index}`,
    head: index.toString(16).repeat(40),
    isMain: false,
    name: `worktree-${index}`,
    displayName: null,
    comment: '',
    status: 'in-progress',
    pinned: false,
    unread: false,
    parentId: null,
    createdAt: 0,
    createdBy: 'window',
    baseRef: null,
    keepBranch: false,
    removing: false,
    groupId: null,
    ...overrides
  } as unknown as Worktree
}

function cachedReviewFixture(worktrees: Worktree[], failGit = false) {
  const calls: FixtureCall[] = []
  const execCalls: Array<{ file: 'git'; args: string[] }> = []
  const store = { get: () => undefined, run: () => undefined, all: () => [] }
  const context = {
    pluginId: 'quirky.hosting',
    openStore: () => store,
    error: (_kind: string, message: string) => new Error(message),
    emit: () => undefined,
    call: async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      calls.push({ method, ...(params === undefined ? {} : { params }) })
      if (method === 'quirky.worktree/list') return worktrees
      if (method === 'quirky.worktree/resolve') {
        const selector = params?.selector
        const id = typeof selector === 'string' ? selector.replace(/^id:/u, '') : ''
        const resolved = worktrees.find((worktree) => worktree.id === id)
        if (resolved) return resolved
      }
      throw new Error(`Unexpected context call: ${method}`)
    }
  } as unknown as PluginContext
  const env = createEnv(context, {
    exec: async (file, args) => {
      execCalls.push({ file, args: [...args] })
      if (failGit) throw new Error('Git identity unavailable')
      return { stdout: '' }
    }
  })
  cachedReviewEnvironments.push(env)
  return { env, lookup: createPRLookup(env), calls, execCalls }
}

function cachedReviewRaceFixture(worktree: Worktree) {
  const fixture = cachedReviewFixture([worktree])
  const identity = { host: 'github.com', owner: 'test-owner', repo: 'test-repo' }
  const originalOrigin = 'https://github.com/test-owner/test-repo.git'
  let currentOrigin = originalOrigin
  let remoteReadCount = 0
  const remoteReadStarted = Promise.withResolvers<void>()
  const pendingRemoteRead = Promise.withResolvers<{ origin: string | null; upstream: string | null }>()

  fixture.env.resolve = async () => {
    const configuration = fixture.env.configuration(worktree)
    return {
      worktree,
      origin: identity,
      repository: identity,
      candidates: [identity],
      issueRepository: identity,
      issueSourcePreference: configuration.issueSourcePreference,
      issueSourceFellBack: false,
      remotes: { origin: currentOrigin, upstream: null },
      ...(configuration.account ? { binding: configuration.account } : {})
    }
  }
  fixture.env.gitWorktree = async (_worktree, args) => {
    if (args[0] === 'symbolic-ref') return `${worktree.branch}\n`
    if (args[0] === 'rev-parse') return `${worktree.head}\n`
    throw new Error(`Unexpected Git query: ${args.join(' ')}`)
  }
  fixture.env.remoteUrls = async () => {
    remoteReadCount += 1
    if (remoteReadCount === 2) {
      remoteReadStarted.resolve()
      return pendingRemoteRead.promise
    }
    return { origin: currentOrigin, upstream: null }
  }

  return {
    ...fixture,
    originalOrigin,
    remoteReadStarted: remoteReadStarted.promise,
    releaseRemoteRead: (origin: string) => pendingRemoteRead.resolve({ origin, upstream: null }),
    setOrigin: (origin: string) => { currentOrigin = origin }
  }
}

test('cachedReviews marks an invalidated snapshot stale after remote verification', async () => {
  const worktree = cachedWorktree(1, 0)
  const fixture = cachedReviewRaceFixture(worktree)
  await fixture.lookup.forBranch({}, cachedReviewsCaller)

  const pending = fixture.lookup.cachedReviews({ worktrees: [worktree.id] }, cachedReviewsCaller)
  await fixture.remoteReadStarted
  fixture.env.invalidate(await fixture.env.resolve({}, cachedReviewsCaller))
  fixture.releaseRemoteRead(fixture.originalOrigin)

  const result = await pending
  expect(result.workspaces).toMatchObject([{ worktreeId: worktree.id, stale: true }])
})

test('cachedReviews preserves a replacement snapshot after older remote verification', async () => {
  const worktree = cachedWorktree(1, 0)
  const fixture = cachedReviewRaceFixture(worktree)
  await fixture.lookup.forBranch({}, cachedReviewsCaller)

  const pending = fixture.lookup.cachedReviews({ worktrees: [worktree.id] }, cachedReviewsCaller)
  await fixture.remoteReadStarted
  fixture.env.invalidate(await fixture.env.resolve({}, cachedReviewsCaller))
  const replacementOrigin = 'git@github.com:test-owner/test-repo.git'
  fixture.setOrigin(replacementOrigin)
  await fixture.lookup.forBranch({}, cachedReviewsCaller)
  fixture.releaseRemoteRead(replacementOrigin)

  const staleResult = await pending
  expect(staleResult.workspaces).toMatchObject([{ worktreeId: worktree.id, stale: true }])
  const currentResult = await fixture.lookup.cachedReviews({ worktrees: [worktree.id] }, cachedReviewsCaller)
  expect(currentResult.workspaces).toMatchObject([{
    worktreeId: worktree.id,
    branch: worktree.branch,
    headOid: worktree.head,
    review: null,
    stale: false
  }])
})


const cachedReviewsCaller = { role: 'plugin' } as CachedReviewsCaller

function errorReason(error: unknown): unknown {
  return isRecord(error) && isRecord(error.data) ? error.data.reason : undefined
}


test('cachedReviews resolves cold batches from one worktree list without Git spawns', async () => {
  const worktrees = Array.from({ length: 7 }, (_, index) => cachedWorktree(index + 1, Math.floor(index / 3)))
  const ordered = [worktrees[4]!, worktrees[1]!, worktrees[6]!, worktrees[0]!, worktrees[4]!, worktrees[2]!, worktrees[5]!, worktrees[3]!, worktrees[1]!]

  for (const prefix of ['', 'id:']) {
    const fixture = cachedReviewFixture(worktrees)
    const result = await fixture.lookup.cachedReviews({
      worktrees: ordered.map((worktree) => `${prefix}${worktree.id}`)
    }, cachedReviewsCaller)

    expect(result.workspaces).toEqual([worktrees[4]!, worktrees[1]!, worktrees[6]!, worktrees[0]!, worktrees[2]!, worktrees[5]!, worktrees[3]!].map((worktree) => ({
      worktreeId: worktree.id,
      instanceId: worktree.instanceId,
      branch: worktree.branch,
      headOid: worktree.head,
      review: null,
      stale: false
    })))
    expect(fixture.calls.map(({ method }) => method)).toEqual(['quirky.worktree/list'])
    expect(fixture.execCalls).toEqual([])
  }
})

test('cachedReviews preserves canonical ambiguity for duplicate worktree IDs', async () => {
  const testHost = await host()
  const linkedCheckout = join(testHost.root, 'linked-checkout')
  git(testHost, ['worktree', 'add', '--detach', linkedCheckout])
  await testHost.client.callAny('quirky.repo/add', { path: linkedCheckout })

  const worktrees = await testHost.client.callAny('quirky.worktree/list', {})
  if (!Array.isArray(worktrees)) throw new Error('worktree listing returned an invalid result')
  expect(worktrees.filter((worktree) => isRecord(worktree) && worktree.id === testHost.worktree)).toHaveLength(2)

  const selector = `id:${testHost.worktree}`
  const expectedError = {
    code: RpcErrorCode.Conflict,
    message: `${selector} matches 2 worktrees: ${selector}, ${selector}`,
    data: { matches: [selector, selector] }
  }
  const canonicalError = await testHost.client.callAny('quirky.worktree/resolve', { selector }).then(
    () => undefined,
    (error: unknown) => error
  )
  expect(canonicalError).toMatchObject(expectedError)

  const singleCachedError = await testHost.client.callAny('quirky.hosting/cachedReviews', {
    worktrees: [testHost.worktree]
  }).then(
    () => undefined,
    (error: unknown) => error
  )
  const expectedCachedError = {
    code: RpcErrorCode.NotFound,
    data: { reason: 'worktree_unavailable' }
  }
  expect(singleCachedError).toMatchObject(expectedCachedError)

  const batchCachedError = await testHost.client.callAny('quirky.hosting/cachedReviews', {
    worktrees: [testHost.worktree, testHost.worktree]
  }).then(
    () => undefined,
    (error: unknown) => error
  )
  expect(batchCachedError).toMatchObject(expectedCachedError)
})

test('cachedReviews reports unverified HEAD fallback failures with the stable identity error', async () => {
  const worktrees = ['', 'malformed', '0'.repeat(40), '0'.repeat(64)].map((head, index) =>
    cachedWorktree(index + 1, 0, { head })
  )
  const fixture = cachedReviewFixture(worktrees, true)
  const result = await fixture.lookup.cachedReviews({ worktrees: worktrees.map(({ id }) => id) }, cachedReviewsCaller)

  expect(result.workspaces).toEqual(worktrees.map((worktree) => ({
    worktreeId: worktree.id,
    instanceId: worktree.instanceId,
    branch: null,
    headOid: null,
    review: null,
    stale: true,
    error: 'The current local worktree identity could not be verified.'
  })))
  expect(fixture.calls.map(({ method }) => method)).toEqual(['quirky.worktree/list'])
  expect(fixture.execCalls.map(({ args }) => args.join(' ')).sort()).toEqual([
    ...Array.from({ length: worktrees.length }, () => 'rev-parse --verify HEAD'),
    ...Array.from({ length: worktrees.length }, () => 'symbolic-ref --quiet --short HEAD')
  ].sort())
})

test('cachedReviews returns folder workspaces without probing Git', async () => {
  const folder = cachedWorktree(1, 0, { kind: 'folder', branch: null, head: '' })
  const fixture = cachedReviewFixture([folder])

  const result = await fixture.lookup.cachedReviews({ worktrees: [folder.id] }, cachedReviewsCaller)

  expect(result.workspaces).toEqual([{
    worktreeId: folder.id,
    instanceId: folder.instanceId,
    branch: null,
    headOid: null,
    review: null,
    stale: true
  }])
  expect(fixture.execCalls).toEqual([])
})

test('cachedReviews validates selector batches before lookup and rejects inactive environments', async () => {
  const worktree = cachedWorktree(1, 0)
  const fixture = cachedReviewFixture([worktree])
  const invalidParams: Array<Record<string, unknown>> = [
    {},
    { worktrees: null },
    { worktrees: [''] },
    { worktrees: ['x'.repeat(4097)] }
  ]

  for (const params of invalidParams) {
    const error = await fixture.lookup.cachedReviews(params, cachedReviewsCaller).then(
      () => undefined,
      (reason: unknown) => reason
    )
    expect(error).toBeDefined()
  }
  expect(await fixture.lookup.cachedReviews({ worktrees: [] }, cachedReviewsCaller)).toEqual({ workspaces: [] })
  expect(fixture.calls).toEqual([])
  expect(fixture.execCalls).toEqual([])

  const unavailable = await fixture.lookup.cachedReviews({ worktrees: ['wt_missing'] }, cachedReviewsCaller).then(
    () => undefined,
    (reason: unknown) => reason
  )
  expect(errorReason(unavailable)).toBe('worktree_unavailable')
  expect(fixture.calls.map(({ method }) => method)).toEqual(['quirky.worktree/resolve'])

  await fixture.env.dispose()
  const inactive = await fixture.lookup.cachedReviews({ worktrees: [worktree.id] }, cachedReviewsCaller).then(
    () => undefined,
    (reason: unknown) => reason
  )
  expect(errorReason(inactive)).toBe('plugin_inactive')
  expect(fixture.calls.map(({ method }) => method)).toEqual(['quirky.worktree/resolve'])
})


async function waitForLookup(testHost: HostingTest): Promise<void> {
  const ready = (): boolean => {
    const value: unknown = testHost.readState()
    return isRecord(value) && value.lookupStarted === true
  }
  if (ready()) return
  const watcher = watch(testHost.root, { persistent: false })
  try {
    if (ready()) return
    for await (const _ of watcher) {
      if (ready()) return
    }
  } finally {
    await watcher.return?.()
  }
}

async function resolvePausedLookup(testHost: HostingTest, pending: Promise<unknown>): Promise<void> {
  try {
    await testHost.call('configure', { issueSourcePreference: 'origin' })
  } finally {
    const state: unknown = testHost.readState()
    if (isRecord(state)) testHost.writeState({ ...state, releaseLookup: true })
    await pending
  }
}

test('cachedReviews cold miss stays cache-only and validates bounded selectors', async () => {
  const testHost = await host()
  const before = testHost.invocations().length
  expect(await cached(testHost)).toMatchObject({
    worktreeId: testHost.worktree,
    branch: 'feature',
    review: null,
    stale: false
  })
  expect(testHost.invocations()).toHaveLength(before)

  const invalid = await testHost.client.callAny('quirky.hosting/cachedReviews', { worktrees: Array.from({ length: 1001 }, () => testHost.worktree) }).then(
    () => undefined,
    (error: unknown) => error
  )
  expect(invalid).toBeDefined()
  expect(testHost.invocations()).toHaveLength(before)
})

test('normal inferred and explicit branch lookups populate the current workspace snapshot', async () => {
  const testHost = await host()
  const headOid = outputOf(testHost, ['rev-parse', 'HEAD'])
  testHost.writeState({ authenticated: true, prs: [review(7, headOid), review(8, headOid)] })

  const events: unknown[] = []
  const { promise: twoCacheChanges, resolve: resolveTwoCacheChanges } = Promise.withResolvers<void>()
  let cacheChangeCount = 0
  testHost.client.onEvent((event) => {
    events.push(event)
    if (isRecord(event) && event.type === 'quirky.hosting/reviewCacheChanged') {
      cacheChangeCount += 1
      if (cacheChangeCount === 2) resolveTwoCacheChanges()
    }
  })
  await testHost.client.callAny('events.subscribe', {})

  expect(await testHost.call('forBranch', { branch: 'feature' })).toMatchObject({ kind: 'found', review: { number: 7 } })
  const callsBeforeRead = testHost.invocations().length
  expect(await cached(testHost)).toMatchObject({
    branch: 'feature',
    headOid,
    review: { number: 7, state: 'open', checksStatus: 'success', headRefOid: headOid },
    stale: false
  })
  expect(testHost.invocations()).toHaveLength(callsBeforeRead)

  expect(await testHost.call('forBranch', { branch: 'feature', number: 8 })).toMatchObject({ kind: 'found', review: { number: 8 } })
  expect(await cached(testHost)).toMatchObject({ review: { number: 8, state: 'open' }, stale: false })
  await twoCacheChanges
  expect(cacheChangeCount).toBe(2)
  const eventCount = events.length
  await cached(testHost)
  expect(events).toHaveLength(eventCount)
}, 20_000)

test('normal exact review lookups populate only matching current-head facts', async () => {
  const testHost = await host()
  const headOid = outputOf(testHost, ['rev-parse', 'HEAD'])
  testHost.writeState({ authenticated: true, prs: [review(11, headOid)] })

  expect(await testHost.call('review', { number: 11 })).toMatchObject({ kind: 'found', review: { number: 11 } })
  expect(await cached(testHost)).toMatchObject({
    branch: 'feature', headOid,
    review: { number: 11, headRefOid: headOid, checksStatus: 'success' }, stale: false
  })
})

test('explicit merged links with an old head stay unknown while inferred merged relations use the captured head', async () => {
  const testHost = await host()
  const oldHead = outputOf(testHost, ['rev-parse', 'HEAD'])
  const unrelatedHead = 'c'.repeat(40)
  testHost.writeState({ authenticated: true, prs: [review(7, unrelatedHead, 'MERGED')] })
  await testHost.call('forBranch', { branch: 'feature', number: 7 })
  expect(await cached(testHost)).toMatchObject({ review: null, stale: true })
  expect(await testHost.call('forBranch', { branch: 'feature', number: 7, headOid: unrelatedHead })).toMatchObject({
    kind: 'found',
    review: { number: 7 }
  })
  expect(await cached(testHost)).toMatchObject({ headOid: oldHead, review: null, stale: true })

  writeFileSync(join(testHost.repoPath, 'advance.txt'), 'new local work\n')
  git(testHost, ['add', 'advance.txt'])
  git(testHost, ['-c', 'user.name=Hosting Test', '-c', 'user.email=hosting@example.test', 'commit', '-m', 'advance local head'])
  const newHead = outputOf(testHost, ['rev-parse', 'HEAD'])
  testHost.writeState({ authenticated: true, prs: [review(7, oldHead, 'MERGED')] })
  expect(await testHost.call('forBranch', { branch: 'feature', headOid: newHead })).toMatchObject({ kind: 'found', review: { state: 'merged' } })
  expect(await cached(testHost)).toMatchObject({
    headOid: newHead,
    review: { state: 'merged', headRefOid: oldHead },
    stale: false
  })
}, 20_000)

test('tracked-branch lookup preserves the hosting-established workspace relationship', async () => {
  const testHost = await host()
  const headOid = outputOf(testHost, ['rev-parse', 'HEAD'])
  git(testHost, ['update-ref', 'refs/remotes/origin/release', headOid])
  git(testHost, ['branch', '--set-upstream-to=origin/release', 'feature'])
  testHost.writeState({ authenticated: true, prs: [{ ...review(12, headOid), headRefName: 'release' }] })

  expect(await testHost.call('forBranch', { branch: 'feature', headOid })).toMatchObject({
    kind: 'found',
    review: { number: 12, headRefName: 'release' }
  })
  expect(await cached(testHost)).toMatchObject({
    branch: 'feature',
    headOid,
    review: { number: 12, headRefOid: headOid },
    stale: false
  })
})

test('normal refreshes populate merged, closed, open, and checks status fields', async () => {
  const cases = [
    ['MERGED', 'SUCCESS', { state: 'merged', checksStatus: 'success' }],
    ['CLOSED', 'FAILURE', { state: 'closed', checksStatus: 'failure' }],
    ['OPEN', 'PENDING', { state: 'open', checksStatus: 'pending' }]
  ] as const
  for (const [state, conclusion, expected] of cases) {
    const testHost = await host()
    const headOid = outputOf(testHost, ['rev-parse', 'HEAD'])
    testHost.writeState({ authenticated: true, prs: [review(7, headOid, state, conclusion)] })
    await testHost.call('refresh', {
      candidate: { worktree: testHost.worktree, branch: 'feature', number: 7, headOid },
      reason: 'manual'
    })
    expect(await cached(testHost)).toMatchObject({ review: { ...expected, headRefOid: headOid }, stale: false })
  }
}, 20_000)

test('normal misses and unavailable lookups remain explicit non-hiding outcomes', async () => {
  const missingHost = await host()
  expect(await missingHost.call('forBranch', { branch: 'feature' })).toMatchObject({ kind: 'no-review' })
  expect(await cached(missingHost)).toMatchObject({ review: null, stale: false })

  await missingHost.cleanup()
  hosts.splice(hosts.indexOf(missingHost), 1)
  const unavailableHost = await host([], { listFailure: true })
  expect(await unavailableHost.call('forBranch', { branch: 'feature' })).toMatchObject({ kind: 'unavailable' })
  expect(await cached(unavailableHost)).toMatchObject({ review: null, stale: false, error: 'GitHub is temporarily unavailable.' })
}, 20_000)

test('head changes and hosting mutations invalidate cached workspace review facts', async () => {
  const testHost = await host()
  const headOid = outputOf(testHost, ['rev-parse', 'HEAD'])
  testHost.writeState({ authenticated: true, prs: [review(7, headOid)] })
  await testHost.call('forBranch', { branch: 'feature' })
  expect((await cached(testHost)).review).not.toBeNull()
  git(testHost, ['config', 'remote.origin.url', 'https://github.com/another-owner/another-repo.git'])
  expect(await cached(testHost)).toMatchObject({ review: null, stale: true })
  git(testHost, ['config', 'remote.origin.url', 'https://github.com/test-owner/test-repo.git'])
  await testHost.call('forBranch', { branch: 'feature' })

  writeFileSync(join(testHost.repoPath, 'advance.txt'), 'new local work\n')
  git(testHost, ['add', 'advance.txt'])
  git(testHost, ['-c', 'user.name=Hosting Test', '-c', 'user.email=hosting@example.test', 'commit', '-m', 'advance local head'])
  expect(await cached(testHost)).toMatchObject({ review: null, stale: true })

  const newHead = outputOf(testHost, ['rev-parse', 'HEAD'])
  testHost.writeState({ authenticated: true, prs: [review(7, newHead)] })
  await testHost.call('refresh', {
    candidate: { worktree: testHost.worktree, branch: 'feature', number: 7, headOid: newHead },
    reason: 'manual'
  })
  expect((await cached(testHost)).review).not.toBeNull()
  await testHost.call('updateReview', { number: 7, action: 'edit', title: 'Edited review' })
  expect(await cached(testHost)).toMatchObject({ review: null, stale: true })
})

test('filesystem instance replacement invalidates a cached review snapshot', async () => {
  const testHost = await host()
  const headOid = outputOf(testHost, ['rev-parse', 'HEAD'])
  testHost.writeState({ authenticated: true, prs: [review(7, headOid)] })
  await testHost.call('forBranch', { branch: 'feature' })
  const before = await cached(testHost)
  const oldInstanceId = before.instanceId
  expect(before.review).not.toBeNull()

  const movedRepo = join(testHost.root, 'old-repo-instance')
  renameSync(testHost.repoPath, movedRepo)
  mkdirSync(testHost.repoPath)
  git(testHost, ['init', '--quiet', '--initial-branch', 'feature'])
  git(testHost, ['config', 'user.name', 'Hosting Fixture'])
  git(testHost, ['config', 'user.email', 'hosting-fixture@example.test'])
  writeFileSync(join(testHost.repoPath, 'README.md'), 'replacement repository\n')
  git(testHost, ['add', 'README.md'])
  git(testHost, ['commit', '--quiet', '-m', 'replacement'])
  git(testHost, ['remote', 'add', 'origin', 'https://github.com/test-owner/test-repo.git'])

  const after = await cached(testHost)
  expect(after.instanceId).not.toBe(oldInstanceId)
  expect(after).toMatchObject({ review: null, stale: true })
})

test('configuration invalidation and stale in-flight lookup cannot repopulate snapshots', async () => {
  const testHost = await host([], { pauseNextView: true })
  const headOid = outputOf(testHost, ['rev-parse', 'HEAD'])
  testHost.writeState({ authenticated: true, prs: [review(7, headOid)], pauseNextView: true })

  const pending = testHost.call('forBranch', { branch: 'feature' })
  await waitForLookup(testHost)
  await resolvePausedLookup(testHost, pending)
  expect(await cached(testHost)).toMatchObject({ review: null, stale: false })

  testHost.writeState({ authenticated: true, prs: [review(7, headOid)] })
  await testHost.call('forBranch', { branch: 'feature' })
  expect((await cached(testHost)).review).not.toBeNull()
  await testHost.call('configure', { issueSourcePreference: 'origin' })
  expect(await cached(testHost)).toMatchObject({ review: null, stale: true })
})

test('expired unavailable snapshots emit cache changes without a cached read', async () => {
  const testHost = await host([], { listFailure: true })
  const initialChange = Promise.withResolvers<void>()
  const expiryChange = Promise.withResolvers<void>()
  let cacheChangeCount = 0
  testHost.client.onEvent((event) => {
    if (!isRecord(event) || event.type !== 'quirky.hosting/reviewCacheChanged') return
    cacheChangeCount += 1
    if (cacheChangeCount === 1) initialChange.resolve()
    if (cacheChangeCount === 2) expiryChange.resolve()
  })
  await testHost.client.callAny('events.subscribe', {})
  await testHost.call('forBranch', { branch: 'feature' })
  await initialChange.promise
  expect(cacheChangeCount).toBe(1)
  const invocationCount = testHost.invocations().length

  await expiryChange.promise
  expect(cacheChangeCount).toBe(2)
  expect(testHost.invocations()).toHaveLength(invocationCount)
  expect(await cached(testHost)).toMatchObject({ review: null, stale: false })
  expect(Object.hasOwn(await cached(testHost), 'error')).toBe(false)
  expect(cacheChangeCount).toBe(2)
}, 20_000)

test('snapshot replacement moves expiry past the previous timer', async () => {
  const testHost = await host([], { listFailure: true })
  const secondChange = Promise.withResolvers<void>()
  let cacheChangeCount = 0
  testHost.client.onEvent((event) => {
    if (!isRecord(event) || event.type !== 'quirky.hosting/reviewCacheChanged') return
    cacheChangeCount += 1
    if (cacheChangeCount === 2) secondChange.resolve()
  })
  await testHost.client.callAny('events.subscribe', {})
  await testHost.call('forBranch', { branch: 'feature' })

  const headOid = outputOf(testHost, ['rev-parse', 'HEAD'])
  testHost.writeState({ authenticated: true, defaultBranch: 'main', prs: [review(7, headOid)] })
  expect(await testHost.call('review', { number: 7 })).toMatchObject({ kind: 'found', review: { number: 7 } })
  await secondChange.promise
  expect(cacheChangeCount).toBe(2)
  const invocationCount = testHost.invocations().length

  // The daemon owns the snapshot clock; test-process fake timers cannot cross its expiry.
  await Bun.sleep(5_100)
  expect(await cached(testHost)).toMatchObject({ review: { number: 7 }, stale: false })
  expect(testHost.invocations()).toHaveLength(invocationCount)
  expect(cacheChangeCount).toBe(2)
}, 20_000)

