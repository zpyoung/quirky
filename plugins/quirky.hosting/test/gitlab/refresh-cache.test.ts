import { afterEach, expect, test } from 'bun:test'
import type { PluginCaller, PluginContext, Worktree } from '@quirky/protocol'
import { createEnv, type HostingConfiguration, type HostingEnv, type Scope } from '../../src/env'
import { prMethods } from '../../src/pr'
import { bootGitLab, type GitLabWorld } from './world'
import { mergeRequest, startGitLab, type GitLabStandIn } from './stand-in'

const worlds: GitLabWorld[] = []
const harnesses: CacheHarness[] = []

async function boot(options: Parameters<typeof bootGitLab>[0] = {}): Promise<GitLabWorld> {
  const world = await bootGitLab(options)
  worlds.push(world)
  return world
}

afterEach(async () => {
  for (const world of worlds.splice(0).reverse()) await world.cleanup()
  for (const harness of harnesses.splice(0).reverse()) await harness.cleanup()
})

const projectPath = (world: GitLabWorld) => `/api/v4/projects/${encodeURIComponent(`${world.identity.owner}/${world.identity.repo}`)}`
const listPath = (world: GitLabWorld) => `${projectPath(world)}/merge_requests`
const reviewPath = (world: GitLabWorld, number: number) => `${listPath(world)}/${number}`
const reviewUrl = (world: GitLabWorld, number: number) => `${world.server.url}/${world.identity.owner}/${world.identity.repo}/-/merge_requests/${number}`

function git(world: GitLabWorld, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: world.repoPath, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git fixture setup failed: ${new TextDecoder().decode(result.stderr)}`)
  return new TextDecoder().decode(result.stdout).trim()
}

async function cachedReviews(world: GitLabWorld, worktrees = [world.worktree]): Promise<Record<string, any>[]> {
  const result = await world.client.callAny('quirky.hosting/cachedReviews', { worktrees }) as { workspaces?: unknown }
  if (!Array.isArray(result.workspaces)) throw new Error('cachedReviews returned an invalid workspace result')
  return result.workspaces as Record<string, any>[]
}

async function listenForEvents(world: GitLabWorld): Promise<unknown[]> {
  const events: unknown[] = []
  world.client.onEvent((event) => events.push(event))
  await world.client.callAny('events.subscribe', {})
  return events
}

function mrAtHead(head: string, overrides: Record<string, unknown> = {}): Record<string, any> {
  return mergeRequest({
    sha: head,
    diff_refs: { base_sha: 'b'.repeat(40), start_sha: 'c'.repeat(40), head_sha: head },
    ...overrides
  })
}

type RemoteUrls = { origin: string | null; upstream: string | null }
type CacheHarness = {
  env: HostingEnv
  server: GitLabStandIn
  projectPath: string
  events: { type: string; data: unknown }[]
  worktrees: Worktree[]
  caller: PluginCaller
  call(method: string, params?: Record<string, unknown>): Promise<unknown>
  cached(selectors?: string[]): Promise<{ workspaces: Record<string, any>[] }>
  replaceWorktree(id: string, worktree: Worktree): void
  setRemotes(id: string, remotes: RemoteUrls): void
  setConfiguration(worktree: Worktree, configuration: HostingConfiguration): void
  setGitLabHosts(value: string): void
  cleanup(): Promise<void>
}

function fixtureWorktree(index: number, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: `wt_${String(index).padStart(12, '0')}`,
    repoId: 'repo_abcdef',
    path: `/fixture/gitlab-worktree-${index}`,
    kind: 'git',
    instanceId: `gitlab-instance-${index}`,
    branch: 'feature',
    head: 'a'.repeat(40),
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

async function cacheHarness(count = 1): Promise<CacheHarness> {
  const originalToken = process.env.GITLAB_TOKEN
  process.env.GITLAB_TOKEN = 'dummy-gitlab-token'
  const server = startGitLab()
  const projectPath = `/api/v4/projects/${encodeURIComponent('group/sub/proj')}`
  const events: { type: string; data: unknown }[] = []
  const worktrees = Array.from({ length: count }, (_, index) => fixtureWorktree(index + 1))
  const configurations = new Map<string, HostingConfiguration>()
  const remotes = new Map<string, RemoteUrls>()
  for (const worktree of worktrees) {
    remotes.set(worktree.id, { origin: `http://${server.host}/group/sub/proj.git`, upstream: null })
  }
  let gitLabHosts = `gitlab.com ${server.host}`
  const store = {
    get: (_query: string, repoId: string) => {
      const configuration = configurations.get(repoId)
      return configuration === undefined ? undefined : {
        issue_source_preference: configuration.issueSourcePreference,
        account_host: configuration.account?.host ?? null,
        account_user: configuration.account?.user ?? null
      }
    },
    run: (_query: string, repoId: string, preference: HostingConfiguration['issueSourcePreference'], host: string | null, user: string | null) => {
      configurations.set(repoId, { issueSourcePreference: preference, account: host && user ? { host, user } : null })
    },
    all: () => []
  }
  const context = {
    pluginId: 'quirky.hosting',
    process: {
      run: async (argv: string[], options?: { cwd?: string }) => {
        if (argv[0] !== 'git') throw new Error(`Unexpected fixture process: ${argv.join(' ')}`)
        const worktree = worktrees.find((item) => item.path === options?.cwd)
        if (!worktree) throw new Error(`Unexpected fixture Git worktree: ${options?.cwd ?? ''}`)
        const args = argv.slice(1)
        let stdout: string
        if (args[0] === 'symbolic-ref') stdout = worktree.branch === null ? '' : `${worktree.branch}\n`
        else if (args[0] === 'rev-parse') stdout = `${worktree.head}\n`
        else throw new Error(`Unexpected fixture Git query: ${args.join(' ')}`)
        return {
          stdout: new TextEncoder().encode(stdout),
          stdoutText: stdout,
          stderr: '',
          exitCode: 0,
          signal: null,
          durationMs: 0
        }
      }
    },
    openStore: () => store,
    error: (_kind: string, message: string) => new Error(message),
    emit: (type: string, data: unknown) => events.push({ type, data }),
    getSetting: (id: string) => id === 'gitlabHosts' ? gitLabHosts : undefined,
    call: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'quirky.worktree/list') return [...worktrees]
      if (method === 'quirky.worktree/resolve') {
        const selector = typeof params.selector === 'string' ? params.selector : ''
        const id = selector.startsWith('id:') ? selector.slice(3) : selector
        const resolved = worktrees.find((worktree) => worktree.id === id)
          ?? (selector === 'current' ? worktrees[0] : undefined)
        if (resolved) return resolved
      }
      throw new Error(`Unexpected fixture context call: ${method}`)
    }
  } as unknown as PluginContext
  const env = createEnv(context)
  env.remoteUrls = async (worktree) => ({ ...(remotes.get(worktree.id) ?? { origin: null, upstream: null }) })
  const methods = prMethods(env)
  const caller = { role: 'plugin', pluginId: 'quirky.hosting' } as PluginCaller
  let cleaned = false
  const harness: CacheHarness = {
    env,
    server,
    projectPath,
    events,
    worktrees,
    caller,
    async call(method, params = {}) {
      const handler = methods[method]
      if (!handler) throw new Error(`Missing fixture handler: ${method}`)
      return await handler(params, caller)
    },
    async cached(selectors = worktrees.map((worktree) => worktree.id)) {
      return await methods.cachedReviews!({ worktrees: selectors }, caller) as { workspaces: Record<string, any>[] }
    },
    replaceWorktree(id, worktree) {
      const index = worktrees.findIndex((current) => current.id === id)
      if (index < 0) throw new Error(`Unknown fixture worktree: ${id}`)
      worktrees[index] = worktree
    },
    setRemotes(id, value) {
      remotes.set(id, { ...value })
    },
    setConfiguration(worktree, configuration) {
      configurations.set(worktree.repoId, configuration)
    },
    setGitLabHosts(value) {
      gitLabHosts = value
    },
    async cleanup() {
      if (cleaned) return
      cleaned = true
      try {
        server.close()
        await env.dispose()
      } finally {
        if (originalToken === undefined) delete process.env.GITLAB_TOKEN
        else process.env.GITLAB_TOKEN = originalToken
      }
    }
  }
  harnesses.push(harness)
  return harness
}

function pauseResponse(predicate: (path: string) => boolean): {
  entered: Promise<void>
  release(): void
  restore(): void
} {
  const originalFetch = globalThis.fetch
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  let paused = false
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init)
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input))
    if (!paused && predicate(url.pathname)) {
      paused = true
      entered.resolve()
      await released.promise
    }
    return response
  }
  return {
    entered: entered.promise,
    release: () => released.resolve(),
    restore: () => {
      released.resolve()
      globalThis.fetch = originalFetch
    }
  }
}

async function withFrozenNow<T>(now: number, callback: () => Promise<T>): Promise<T> {
  const originalNow = Date.now
  Date.now = () => now
  try {
    return await callback()
  } finally {
    Date.now = originalNow
  }
}

type ClockTimer = { id: number; dueAt: number; callback: () => void; unref(): ClockTimer }
type ControlledClock = {
  readonly now: number
  readonly timersInstalled: boolean
  setNow(value: number): void
  nextDueAt(): number | undefined
  installTimers(): void
  disableTimers(): void
  advanceTo(target: number): Promise<void>
  restore(): void
}

function controlledClock(startAt: number): ControlledClock {
  const originalNow = Date.now
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  let now = startAt
  let nextId = 0
  let timersInstalled = false
  const timers = new Map<number, ClockTimer>()
  Date.now = () => now

  const installTimers = () => {
    if (timersInstalled) return
    timersInstalled = true
    globalThis.setTimeout = ((handler: unknown, delay = 0, ...args: unknown[]) => {
      const timer: ClockTimer = {
        id: ++nextId,
        dueAt: now + Math.max(0, Number(delay) || 0),
        callback: () => invokeTimerHandler(handler, args),
        unref() { return timer }
      }
      timers.set(timer.id, timer)
      return timer
    }) as unknown as typeof setTimeout
    globalThis.clearTimeout = ((handle: unknown) => {
      if (typeof handle === 'object' && handle !== null && 'id' in handle && typeof handle.id === 'number') {
        timers.delete(handle.id)
        return
      }
      originalClearTimeout(handle as Parameters<typeof originalClearTimeout>[0])
    }) as typeof clearTimeout
  }
  const disableTimers = () => {
    if (!timersInstalled) return
    timersInstalled = false
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  }
  return {
    get now() { return now },
    get timersInstalled() { return timersInstalled },
    setNow(value) { now = value },
    nextDueAt() {
      return [...timers.values()].reduce<number | undefined>((min, timer) =>
        min === undefined || timer.dueAt < min ? timer.dueAt : min, undefined)
    },
    installTimers,
    disableTimers,
    async advanceTo(target) {
      while (true) {
        const next = [...timers.values()]
          .filter((timer) => timer.dueAt <= target)
          .sort((left, right) => left.dueAt - right.dueAt)[0]
        if (!next) break
        timers.delete(next.id)
        now = next.dueAt
        next.callback()
        await Promise.resolve()
      }
      now = target
    },
    restore() {
      disableTimers()
      Date.now = originalNow
    }
  }
}

function invokeTimerHandler(handler: unknown, args: unknown[]): void {
  if (typeof handler === 'function') Reflect.apply(handler, undefined, args)
}

function installClockAfterResponse(clock: ControlledClock, predicate: (path: string) => boolean): () => void {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init)
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input))
    if (predicate(url.pathname)) clock.installTimers()
    return response
  }
  return () => { globalThis.fetch = originalFetch }
}

test('routed branch and exact review lookups publish the same current-head cache snapshot', async () => {
  const world = await boot()
  const head = git(world, ['rev-parse', 'HEAD'])
  world.server.mergeRequests = [mrAtHead(head, { head_pipeline: { status: 'failed' } })]
  const events = await listenForEvents(world)

  // The saved preference defaults to auto. GitLab's resolved scope uses origin, but that must not
  // make a snapshot captured under the saved default look stale on its next cache-only read.
  const branchResult = await world.call('forBranch') as Record<string, any>
  expect(branchResult).toMatchObject({
    kind: 'found',
    review: {
      provider: 'gitlab', number: 5, state: 'open', headRefName: 'feature', headRefOid: head,
      checksStatus: 'failure', url: reviewUrl(world, 5)
    }
  })
  const firstSnapshot = await cachedReviews(world)
  expect(firstSnapshot).toMatchObject([{
    worktreeId: world.worktree,
    branch: 'feature',
    headOid: head,
    review: { state: 'open', checksStatus: 'failure', headRefOid: head, number: 5, url: reviewUrl(world, 5) },
    stale: false
  }])

  const afterBranch = world.server.requests.length
  const warmBranch = await world.call('forBranch') as Record<string, any>
  expect(warmBranch.fetchedAt).toBe(branchResult.fetchedAt)
  expect(world.server.requests).toHaveLength(afterBranch)

  const exactResult = await world.call('review', { number: 5 }) as Record<string, any>
  expect(exactResult).toMatchObject({ kind: 'found', review: { provider: 'gitlab', number: 5, checksStatus: 'failure' } })
  expect((await cachedReviews(world))[0]).toMatchObject({
    worktreeId: world.worktree,
    branch: 'feature',
    headOid: head,
    review: { state: 'open', checksStatus: 'failure', headRefOid: head, number: 5, url: reviewUrl(world, 5) },
    stale: false
  })
  const afterExact = world.server.requests.length
  const warmExact = await world.call('review', { number: 5 }) as Record<string, any>
  expect(warmExact.fetchedAt).toBe(exactResult.fetchedAt)
  expect(world.server.requests).toHaveLength(afterExact)
  expect(world.server.requests.some((request) => /\/(?:pipelines|jobs)(?:\/|$)/u.test(request.path))).toBe(false)
  expect(world.glabInvocations()).toEqual([])
  expect(world.invocations()).toEqual([])

  const cacheEvents = events.filter((event) => typeof event === 'object' && event !== null
    && 'type' in event && event.type === 'quirky.hosting/reviewCacheChanged')
  expect(cacheEvents).toContainEqual(expect.objectContaining({
    type: 'quirky.hosting/reviewCacheChanged',
    data: expect.objectContaining({ worktreeId: world.worktree })
  }))
})

test('cachedReviews is cache-only with no GitLab credentials, including CLI and bounded selectors', async () => {
  const world = await boot({ token: null })
  const first = await cachedReviews(world)
  const repeated = await cachedReviews(world)
  expect(first).toMatchObject([{ worktreeId: world.worktree, review: null, stale: false }])
  expect(repeated).toEqual(first)

  const maximumBatch = await cachedReviews(world, Array.from({ length: 1_000 }, () => world.worktree))
  expect(maximumBatch).toHaveLength(1)
  await expect(world.client.callAny('quirky.hosting/cachedReviews', {
    worktrees: Array.from({ length: 1_001 }, () => world.worktree)
  })).rejects.toMatchObject({ data: { reason: 'validation_error' } })

  const cli = await world.cli(['--json', 'hosting', 'cached-reviews', '--worktrees', world.worktree])
  expect(cli.code).toBe(0)
  expect(JSON.parse(cli.stdout)).toEqual({ workspaces: first })
  expect(world.server.requests).toEqual([])
  expect(world.glabInvocations()).toEqual([])
  expect(world.invocations()).toEqual([])
})

test('cached-reviews CLI returns the routed snapshot without touching a provider', async () => {
  const world = await boot()
  const head = git(world, ['rev-parse', 'HEAD'])
  world.server.mergeRequests = [mrAtHead(head, { head_pipeline: { status: 'failed' } })]
  await world.call('forBranch')
  const expected = await world.client.callAny('quirky.hosting/cachedReviews', { worktrees: [world.worktree] })
  const requestCount = world.server.requests.length

  const cli = await world.cli(['--json', 'hosting', 'cached-reviews', '--worktrees', world.worktree])
  expect(cli.code).toBe(0)
  expect(JSON.parse(cli.stdout)).toEqual(expected)
  expect(world.server.requests).toHaveLength(requestCount)
  expect(world.glabInvocations()).toEqual([])
  expect(world.invocations()).toEqual([])
})
test('GitLab lookup outcomes and an explicit old-head relation stay honest in cached workspace views', async () => {
  const world = await boot()
  const head = git(world, ['rev-parse', 'HEAD'])
  const oldHead = 'd'.repeat(40)

  const cases = [
    {
      request: mrAtHead(head, { head_pipeline: { status: 'failed' } }),
      expected: { state: 'open', checksStatus: 'failure', headRefOid: head }
    },
    {
      request: mrAtHead(head, { draft: true, title: 'Draft: Add x', head_pipeline: { status: 'running' } }),
      expected: { state: 'draft', checksStatus: 'pending', headRefOid: head }
    },
    {
      request: mrAtHead(head, { state: 'closed', head_pipeline: { status: 'success' } }),
      expected: { state: 'closed', checksStatus: 'success', headRefOid: head }
    },
    {
      request: mrAtHead(head, { state: 'merged', head_pipeline: { status: 'success' } }),
      expected: { state: 'merged', checksStatus: 'success', headRefOid: head }
    }
  ] as const

  for (const { request, expected } of cases) {
    world.server.mergeRequests = [request]
    const result = await world.call('forBranch', { fresh: true }) as Record<string, any>
    expect(result).toMatchObject({ kind: 'found' })
    expect((await cachedReviews(world))[0]).toMatchObject({
      branch: 'feature',
      headOid: head,
      review: { ...expected, number: 5, url: reviewUrl(world, 5) },
      stale: false
    })
  }

  world.server.mergeRequests = []
  expect(await world.call('forBranch', { fresh: true })).toMatchObject({ kind: 'no-review' })
  expect((await cachedReviews(world))[0]).toMatchObject({ review: null, stale: false })

  world.server.failures.set(`GET ${listPath(world)}`, {
    status: 500,
    body: { message: 'private-provider-response-body' }
  })
  expect(await world.call('forBranch', { fresh: true })).toMatchObject({ kind: 'unavailable', reason: 'server_error' })
  const unavailable = (await cachedReviews(world))[0]
  expect(unavailable).toMatchObject({ review: null, stale: false, error: 'GitLab is temporarily unavailable.' })
  expect(JSON.stringify(unavailable)).not.toContain('private-provider-response-body')

  world.server.failures.clear()
  world.server.mergeRequests = [mrAtHead(oldHead, { state: 'merged' })]
  const explicitOldHead = await world.call('forBranch', { number: 5, fresh: true }) as Record<string, any>
  expect(explicitOldHead).toMatchObject({ kind: 'found', review: { state: 'merged', headRefOid: oldHead } })
  expect((await cachedReviews(world))[0]).toMatchObject({
    branch: 'feature',
    headOid: head,
    review: null,
    stale: true
  })
})

test('two same-branch worktrees publish only their own instance and head facts', async () => {
  const harness = await cacheHarness(2)
  const [first, originalSecond] = harness.worktrees
  if (!first || !originalSecond) throw new Error('expected two registered worktrees')
  const second = { ...originalSecond, head: 'e'.repeat(40) } as Worktree
  harness.replaceWorktree(second.id, second)
  harness.server.mergeRequests = [mrAtHead(first.head, { head_pipeline: { status: 'failed' } })]

  const firstResult = await harness.call('forBranch', { worktree: first.id }) as Record<string, any>
  const secondResult = await harness.call('forBranch', { worktree: second.id }) as Record<string, any>
  expect(firstResult).toMatchObject({ kind: 'found', review: { checksStatus: 'failure', headRefOid: first.head } })
  expect(secondResult).toMatchObject({ kind: 'found', review: { checksStatus: 'failure', headRefOid: first.head } })

  const snapshots = await harness.cached([first.id, second.id])
  expect(snapshots.workspaces).toHaveLength(2)
  expect(snapshots.workspaces[0]).toMatchObject({
    worktreeId: first.id,
    instanceId: first.instanceId,
    branch: 'feature',
    headOid: first.head,
    review: { state: 'open', checksStatus: 'failure', headRefOid: first.head },
    stale: false
  })
  expect(snapshots.workspaces[1]).toMatchObject({
    worktreeId: second.id,
    instanceId: second.instanceId,
    branch: 'feature',
    headOid: second.head,
    review: null,
    stale: true
  })
  expect(harness.events.filter((event) => event.type === 'reviewCacheChanged').map((event) => event.data))
    .toEqual(expect.arrayContaining([
      expect.objectContaining({ worktreeId: first.id }),
      expect.objectContaining({ worktreeId: second.id })
    ]))
})

test('GitLab mutations invalidate the shared snapshot and publish the existing cache event', async () => {
  const world = await boot()
  const head = git(world, ['rev-parse', 'HEAD'])
  world.server.mergeRequests = [mrAtHead(head)]
  const events = await listenForEvents(world)
  await world.call('forBranch')
  expect((await cachedReviews(world))[0]).toMatchObject({ review: { number: 5 }, stale: false })

  await world.call('updateReview', { number: 5, action: 'close' })
  const afterMutation = world.server.requests.length
  expect((await cachedReviews(world))[0]).toMatchObject({ review: null, stale: true })
  expect(world.server.requests).toHaveLength(afterMutation)
  expect(events).toContainEqual(expect.objectContaining({
    type: 'quirky.hosting/reviewCacheChanged',
    data: expect.objectContaining({ worktreeId: world.worktree })
  }))
})

test('failed-only retry invalidates cached reviews before a refreshed head pipeline is published', async () => {
  const world = await boot()
  const head = git(world, ['rev-parse', 'HEAD'])
  const pipeline = {
    id: 90,
    project_id: 42,
    sha: head,
    ref: 'feature',
    status: 'failed',
    source: 'push',
    web_url: `${world.server.url}/group/sub/proj/-/pipelines/90`,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:01:00.000Z'
  }
  world.server.mergeRequests = [mrAtHead(head, { head_pipeline: { ...pipeline } })]
  world.server.mergeRequestPipelines.set('5', [pipeline])
  world.server.pipelines = [pipeline]
  world.server.jobs = [{
    id: 201,
    name: 'build',
    stage: 'test',
    status: 'failed',
    allow_failure: false,
    created_at: '2026-01-01T00:00:00.000Z',
    started_at: '2026-01-01T00:00:01.000Z',
    finished_at: '2026-01-01T00:00:02.000Z',
    web_url: `${world.server.url}/group/sub/proj/-/jobs/201`,
    pipeline: { id: 90, project_id: 42, ref: 'feature', sha: head, status: 'failed' },
    commit: {
      id: head,
      short_id: head.slice(0, 8),
      title: 'fixture',
      message: 'fixture',
      author_name: 'Fixture',
      author_email: 'fixture@example.test',
      committed_date: '2026-01-01T00:00:00.000Z'
    }
  }]
  const events = await listenForEvents(world)

  expect(await world.call('forBranch')).toMatchObject({
    kind: 'found',
    review: { checksStatus: 'failure', headRefOid: head }
  })
  expect((await cachedReviews(world))[0]).toMatchObject({ review: { checksStatus: 'failure' }, stale: false })

  await world.call('rerunChecks', { number: 5, failedOnly: true })
  const afterRetry = world.server.requests.length
  expect((await cachedReviews(world))[0]).toMatchObject({ review: null, stale: true })
  expect(world.server.requests).toHaveLength(afterRetry)
  expect(events).toContainEqual(expect.objectContaining({
    type: 'quirky.hosting/reviewCacheChanged',
    data: expect.objectContaining({ worktreeId: world.worktree })
  }))

  world.server.mergeRequests = [mrAtHead(head, { head_pipeline: { ...pipeline, status: 'success' } })]
  expect(await world.call('forBranch')).toMatchObject({
    kind: 'found',
    review: { checksStatus: 'success', headRefOid: head }
  })
  expect((await cachedReviews(world))[0]).toMatchObject({ review: { checksStatus: 'success' }, stale: false })
})
test('cache snapshots reject every changed local, remote, saved-config, credential, and host identity', async () => {
  const mutations: [string, (harness: CacheHarness, worktree: Worktree) => void][] = [
    ['branch', (harness, worktree) => harness.replaceWorktree(worktree.id, { ...worktree, branch: 'release' })],
    ['head', (harness, worktree) => harness.replaceWorktree(worktree.id, { ...worktree, head: 'f'.repeat(40) })],
    ['instance', (harness, worktree) => harness.replaceWorktree(worktree.id, { ...worktree, instanceId: 'recreated-instance' })],
    ['path', (harness, worktree) => harness.replaceWorktree(worktree.id, { ...worktree, path: `${worktree.path}-replacement` })],
    ['repository', (harness, worktree) => harness.replaceWorktree(worktree.id, { ...worktree, repoId: 'repo_deadbeef' })],
    ['origin', (harness, worktree) => harness.setRemotes(worktree.id, {
      origin: `http://${harness.server.host}/group/sub/replaced.git`, upstream: null
    })],
    ['upstream', (harness, worktree) => harness.setRemotes(worktree.id, {
      origin: `http://${harness.server.host}/group/sub/proj.git`,
      upstream: `http://${harness.server.host}/group/sub/upstream.git`
    })],
    ['saved configuration', (harness, worktree) => harness.setConfiguration(worktree, {
      issueSourcePreference: 'origin', account: null
    })],
    ['GitLab host allowlist', (harness) => harness.setGitLabHosts('gitlab.com')]
  ]

  for (const [identity, mutate] of mutations) {
    const harness = await cacheHarness()
    try {
      const worktree = harness.worktrees[0]!
      harness.setConfiguration(worktree, { issueSourcePreference: 'auto', account: null })
      harness.server.mergeRequests = [mrAtHead(worktree.head)]
      expect(harness.env.configuration(worktree)).toEqual({ issueSourcePreference: 'auto', account: null })
      await harness.call('forBranch', { worktree: worktree.id })
      expect((await harness.cached([worktree.id])).workspaces[0]).toMatchObject({ review: { number: 5 }, stale: false })
      const requestsBeforeCacheRead = harness.server.requests.length
      mutate(harness, worktree)

      const result = await harness.cached([worktree.id])
      expect(result.workspaces[0], identity).toMatchObject({ review: null, stale: true })
      expect(harness.server.requests, identity).toHaveLength(requestsBeforeCacheRead)
    } finally {
      await harness.cleanup()
    }
  }

  const harness = await cacheHarness()
  const originalToken = process.env.GITLAB_TOKEN
  try {
    const worktree = harness.worktrees[0]!
    harness.setConfiguration(worktree, { issueSourcePreference: 'auto', account: null })
    harness.server.mergeRequests = [mrAtHead(worktree.head)]
    expect(harness.env.configuration(worktree)).toEqual({ issueSourcePreference: 'auto', account: null })
    await harness.call('forBranch', { worktree: worktree.id })
    expect((await harness.cached([worktree.id])).workspaces[0]).toMatchObject({ review: { number: 5 }, stale: false })
    const requestsBeforeCacheRead = harness.server.requests.length
    process.env.GITLAB_TOKEN = 'rotated-test-token'
    expect((await harness.cached([worktree.id])).workspaces[0]).toMatchObject({ review: null, stale: true })
    expect(harness.server.requests).toHaveLength(requestsBeforeCacheRead)
  } finally {
    if (originalToken === undefined) delete process.env.GITLAB_TOKEN
    else process.env.GITLAB_TOKEN = originalToken
    await harness.cleanup()
  }
})

test('pre-request capture leases reject late lookups after target changes and disposal', async () => {
  const mutations: [string, (harness: CacheHarness, worktree: Worktree) => void | Promise<void>][] = [
    ['worktree recreation', (harness, worktree) => harness.replaceWorktree(worktree.id, { ...worktree, instanceId: 'new-instance' })],
    ['remote change', (harness, worktree) => harness.setRemotes(worktree.id, {
      origin: `http://${harness.server.host}/group/sub/replaced.git`, upstream: null
    })],
    ['saved configuration change', (harness, worktree) => harness.setConfiguration(worktree, {
      issueSourcePreference: 'origin', account: null
    })],
    ['host allowlist change', (harness) => harness.setGitLabHosts('gitlab.com')],
    ['local HEAD change', (harness, worktree) => harness.replaceWorktree(worktree.id, { ...worktree, head: 'f'.repeat(40) })],
    ['repository invalidation', (harness, worktree) => {
      const identity = { host: harness.server.host, owner: 'group/sub', repo: 'proj' }
      harness.env.changed({
        worktree,
        origin: identity,
        repository: identity,
        candidates: [identity],
        issueRepository: identity,
        issueSourcePreference: 'auto',
        issueSourceFellBack: false,
        remotes: { origin: `http://${harness.server.host}/group/sub/proj.git`, upstream: null }
      } satisfies Scope)
    }],
    ['plugin disposal', async (harness) => await harness.env.dispose()]
  ]

  for (const [change, mutate] of mutations) {
    const barrier = pauseResponse((path) => path.endsWith('/approvals'))
    let harness: CacheHarness | undefined
    try {
      const activeHarness = await cacheHarness()
      harness = activeHarness
      const worktree = activeHarness.worktrees[0]!
      activeHarness.server.mergeRequests = [mrAtHead(worktree.head)]
      const pending = activeHarness.call('forBranch', { worktree: worktree.id, fresh: true })
      await barrier.entered
      await mutate(activeHarness, worktree)
      barrier.release()
      expect(await pending, change).toMatchObject({ kind: 'found' })
      expect(activeHarness.events.filter((event) => event.type === 'reviewCacheChanged'), change).toHaveLength(0)
      if (change !== 'plugin disposal') {
        expect((await activeHarness.cached([worktree.id])).workspaces[0], change).toMatchObject({ review: null, stale: false })
      }
    } finally {
      barrier.restore()
      await harness?.cleanup()
    }
  }
})

test('same-timestamp older lookup cannot replace a newer leased snapshot', async () => {
  const sameTimestamp = 1_800_000_000_000
  const barrier = pauseResponse((path) => path.endsWith('/approvals'))
  let harness: CacheHarness | undefined
  try {
    const activeHarness = await cacheHarness()
    harness = activeHarness
    const worktree = activeHarness.worktrees[0]!
    activeHarness.server.mergeRequests = [mrAtHead(worktree.head, { head_pipeline: { status: 'failed' } })]
    await withFrozenNow(sameTimestamp, async () => {
      const olderRequest = activeHarness.call('forBranch', { worktree: worktree.id, fresh: true })
      await barrier.entered

      activeHarness.server.mergeRequests = [mrAtHead(worktree.head, { head_pipeline: { status: 'success' } })]
      const newerResult = await activeHarness.call('forBranch', { worktree: worktree.id, fresh: true }) as Record<string, any>
      expect(newerResult).toMatchObject({ kind: 'found', review: { checksStatus: 'success' }, fetchedAt: sameTimestamp })

      barrier.release()
      const olderResult = await olderRequest as Record<string, any>
      expect(olderResult).toMatchObject({ kind: 'found', review: { checksStatus: 'failure' }, fetchedAt: sameTimestamp })
      expect((await activeHarness.cached([worktree.id])).workspaces[0]).toMatchObject({
        review: { checksStatus: 'success', headRefOid: worktree.head },
        stale: false
      })
      expect(activeHarness.events.filter((event) => event.type === 'reviewCacheChanged')).toHaveLength(1)
    })
  } finally {
    barrier.restore()
    await harness?.cleanup()
  }
})

test('fresh routed lookups from both methods publish cache snapshots', async () => {
  const harness = await cacheHarness()
  const worktree = harness.worktrees[0]!
  harness.server.mergeRequests = [mrAtHead(worktree.head, { head_pipeline: { status: 'failed' } })]
  try {
    expect(await harness.call('forBranch', { worktree: worktree.id, fresh: true })).toMatchObject({
      kind: 'found', review: { provider: 'gitlab', checksStatus: 'failure' }
    })
    expect((await harness.cached([worktree.id])).workspaces[0]).toMatchObject({
      review: { state: 'open', checksStatus: 'failure', headRefOid: worktree.head },
      stale: false
    })

    expect(await harness.call('review', { worktree: worktree.id, number: 5, fresh: true })).toMatchObject({
      kind: 'found', review: { provider: 'gitlab', checksStatus: 'failure' }
    })
    expect((await harness.cached([worktree.id])).workspaces[0]).toMatchObject({
      review: { state: 'open', checksStatus: 'failure', headRefOid: worktree.head },
      stale: false
    })
  } finally {
    await harness.cleanup()
  }
})

test('the shared snapshot capacity retains 500 of 501 entries and selector batches cap at 1000', async () => {
  const harness = await cacheHarness(501)
  harness.server.mergeRequests = [mrAtHead('a'.repeat(40))]
  try {
    await withFrozenNow(1_700_000_000_000, async () => {
      for (const worktree of harness.worktrees) {
        const result = await harness.call('review', { worktree: worktree.id, number: 5 })
        expect(result).toMatchObject({ kind: 'found', review: { number: 5 } })
      }

      const requestsBeforeCacheRead = harness.server.requests.length
      const snapshots = await harness.cached(harness.worktrees.map((worktree) => worktree.id))
      expect(snapshots.workspaces).toHaveLength(501)
      expect(snapshots.workspaces.filter((workspace) => workspace.review !== null)).toHaveLength(500)
      expect(snapshots.workspaces[0]).toMatchObject({ worktreeId: harness.worktrees[0]?.id, review: null, stale: false })
      expect(snapshots.workspaces[500]).toMatchObject({
        worktreeId: harness.worktrees[500]?.id,
        review: { state: 'open', number: 5 },
        stale: false
      })

      const repeatedSelectorBatch = await harness.cached(Array.from({ length: 1_000 }, () => harness.worktrees[500]!.id))
      expect(repeatedSelectorBatch.workspaces).toHaveLength(1)
      expect(repeatedSelectorBatch.workspaces[0]).toMatchObject({ review: { state: 'open', number: 5 }, stale: false })
      expect(harness.server.requests).toHaveLength(requestsBeforeCacheRead)
    })
  } finally {
    await harness.cleanup()
  }
}, 120_000)

test('folder workspace cache rows remain local and never probe GitLab', async () => {
  const harness = await cacheHarness()
  const worktree = harness.worktrees[0]!
  harness.replaceWorktree(worktree.id, { ...worktree, kind: 'folder' })
  try {
    const result = await harness.cached([worktree.id])
    expect(result.workspaces).toMatchObject([{
      worktreeId: worktree.id,
      branch: null,
      headOid: null,
      review: null,
      stale: true
    }])
    expect(harness.server.requests).toEqual([])
  } finally {
    await harness.cleanup()
  }
})

test('shared cache TTLs expire from the observation time, including warm branch and exact hits', async () => {
  const outcomes: {
    name: string
    method?: 'forBranch' | 'review'
    active?: boolean
    ttl: number
    request?: Record<string, unknown>
    failure?: boolean
  }[] = [
    { name: 'open', ttl: 120_000, request: mrAtHead('a'.repeat(40)) },
    { name: 'active open', ttl: 60_000, active: true, request: mrAtHead('a'.repeat(40)) },
    { name: 'draft', ttl: 120_000, request: mrAtHead('a'.repeat(40), { draft: true }) },
    { name: 'closed', ttl: 15 * 60_000, request: mrAtHead('a'.repeat(40), { state: 'closed' }) },
    { name: 'merged', ttl: 6 * 60 * 60_000, request: mrAtHead('a'.repeat(40), { state: 'merged' }) },
    { name: 'pending merged', ttl: 60_000, request: mrAtHead('a'.repeat(40), { state: 'merged', head_pipeline: { status: 'running' } }) },
    { name: 'no review', ttl: 15 * 60_000 },
    { name: 'active no review', ttl: 60_000, active: true },
    { name: 'unavailable', ttl: 5_000, failure: true },
    { name: 'exact review', method: 'review', ttl: 120_000, request: mrAtHead('a'.repeat(40)) }
  ]

  for (const outcome of outcomes) {
    const startedAt = 1_700_000_000_000
    const clock = controlledClock(startedAt)
    const finalPath = outcome.request ? '/approvals' : '/merge_requests'
    const restoreFetch = installClockAfterResponse(clock, (path) => path.endsWith(finalPath))
    let harness: CacheHarness | undefined
    try {
      harness = await cacheHarness()
      const worktree = harness.worktrees[0]!
      if (outcome.request) harness.server.mergeRequests = [outcome.request]
      if (outcome.failure) {
        harness.server.failures.set(`GET ${harness.projectPath}/merge_requests`, {
          status: 500,
          body: { message: 'private-error-body' }
        })
      }
      const method = outcome.method ?? 'forBranch'
      const params = {
        worktree: worktree.id,
        ...(method === 'review' ? { number: 5 } : {}),
        ...(outcome.active ? { active: true } : {})
      }
      const first = await harness.call(method, params) as Record<string, any>
      expect(first.kind, outcome.name).toBe(outcome.failure ? 'unavailable' : outcome.request ? 'found' : 'no-review')
      const initialSnapshot = (await harness.cached([worktree.id])).workspaces[0]
      expect(initialSnapshot, outcome.name).toMatchObject({ stale: false })
      if (first.kind === 'found') expect(initialSnapshot?.review).toMatchObject({
        state: first.review.state,
        checksStatus: first.review.checksStatus,
        headRefOid: worktree.head
      })
      else expect(initialSnapshot).toMatchObject({ review: null })
      if (outcome.failure) expect(initialSnapshot?.error).toBe('GitLab is temporarily unavailable.')
      expect(clock.nextDueAt(), outcome.name).toBe(startedAt + outcome.ttl)
      const requestCount = harness.server.requests.length
      clock.setNow(startedAt + 1_000)
      const warm = await harness.call(method, params) as Record<string, any>
      expect(warm.fetchedAt, outcome.name).toBe(first.fetchedAt)
      expect((await harness.cached([worktree.id])).workspaces[0]?.stale, outcome.name).toBe(false)
      expect(clock.nextDueAt(), outcome.name).toBe(startedAt + outcome.ttl)
      expect(harness.server.requests, outcome.name).toHaveLength(requestCount)

      const beforeExpiryEvents = harness.events.filter((event) => event.type === 'reviewCacheChanged').length
      await clock.advanceTo(startedAt + outcome.ttl)
      expect(harness.events.filter((event) => event.type === 'reviewCacheChanged'), outcome.name)
        .toHaveLength(beforeExpiryEvents + 1)
      expect((await harness.cached([worktree.id])).workspaces[0], outcome.name).toMatchObject({ review: null, stale: false })
    } finally {
      restoreFetch()
      await harness?.cleanup()
      clock.restore()
    }
  }
}, 60_000)
test('stale cache-only reads remain credential-free after the environment token disappears', async () => {
  const harness = await cacheHarness()
  const worktree = harness.worktrees[0]!
  const originalToken = process.env.GITLAB_TOKEN
  try {
    harness.setConfiguration(worktree, { issueSourcePreference: 'auto', account: null })
    harness.server.mergeRequests = [mrAtHead(worktree.head)]
    await harness.call('forBranch', { worktree: worktree.id })
    delete process.env.GITLAB_TOKEN
    const requestsBeforeRead = harness.server.requests.length
    expect((await harness.cached([worktree.id])).workspaces[0]).toMatchObject({ review: null, stale: true })
    expect(harness.server.requests).toHaveLength(requestsBeforeRead)
  } finally {
    if (originalToken === undefined) delete process.env.GITLAB_TOKEN
    else process.env.GITLAB_TOKEN = originalToken
    await harness.cleanup()
  }
})
