import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { validateValue, type CallerConnection, type PluginCaller, type PluginContext, type Schema, type Worktree } from '@quirky/protocol'
import { createEnv, type HostingConfiguration, type HostingEnv, type Scope } from '../../src/env'
import { prMethods } from '../../src/pr'
import { refreshMethods } from '../../src/refresh'
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
const hostingManifest = JSON.parse(readFileSync(resolve(import.meta.dir, '../../quirky-plugin.json'), 'utf8')) as {
  contributes: {
    method: { id: string; result: Schema }[]
    event: { id: string; data: Schema }[]
  }
}

function methodResultSchema(id: string): Schema {
  const schema = hostingManifest.contributes.method.find((method) => method.id === id)?.result
  if (!schema) throw new Error(`missing ${id} result schema`)
  return schema
}

function eventDataSchema(id: string): Schema {
  const schema = hostingManifest.contributes.event.find((event) => event.id === id)?.data
  if (!schema) throw new Error(`missing ${id} event schema`)
  return schema
}

function propertySchema(schema: Schema, name: string): Schema {
  const property = schema.properties?.[name]
  if (!property) throw new Error(`missing ${name} schema property`)
  return property
}

function reviewForSchema(review: Record<string, unknown>, schema: Schema): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(schema.properties ?? {})
      .filter((name) => Object.hasOwn(review, name))
      .map((name) => [name, review[name]])
  )
}

function eventRecord(value: unknown): Record<string, any> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected event object')
  return value as Record<string, any>
}

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
async function listenForRefreshEvents(world: GitLabWorld): Promise<{ events: unknown[]; firstRefresh: Promise<void> }> {
  const events: unknown[] = []
  const firstRefresh = Promise.withResolvers<void>()
  world.client.onEvent((event) => {
    events.push(event)
    const record = eventRecord(event)
    if (record.type === 'quirky.hosting/refresh' && typeof record.data === 'object' &&
        record.data !== null && 'outcome' in record.data) firstRefresh.resolve()
  })
  await world.client.callAny('events.subscribe', {})
  return { events, firstRefresh: firstRefresh.promise }
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
  call(method: string, params?: Record<string, unknown>, caller?: PluginCaller): Promise<unknown>
  cached(selectors?: string[]): Promise<{ workspaces: Record<string, any>[] }>
  replaceWorktree(id: string, worktree: Worktree): void
  removeWorktree(id: string): void
  setRemotes(id: string, remotes: RemoteUrls): void
  setConfiguration(worktree: Worktree, configuration: HostingConfiguration): void
  setGitLabHosts(value: string): void
  cleanup(): Promise<void>
}
type RefreshTestConnection = { caller: PluginCaller; close(): void }
let nextRefreshConnectionId = 0

function refreshTestConnection(name: string): RefreshTestConnection {
  const callbacks = new Set<() => void>()
  let closed = false
  const connection: CallerConnection = {
    id: ++nextRefreshConnectionId,
    transport: 'socket',
    onClose(callback: () => void) {
      if (closed) callback()
      else callbacks.add(callback)
      return () => { callbacks.delete(callback) }
    },
    openStream() {
      throw new Error('Socket fixture connections do not support streams')
    }
  }
  return {
    caller: { role: 'ui', name, connection },
    close() {
      if (closed) return
      closed = true
      for (const callback of [...callbacks]) callback()
      callbacks.clear()
    }
  }
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
  const refresh = refreshMethods(env, methods)
  const handlers = { ...methods, ...refresh }
  const caller = { role: 'plugin', pluginId: 'quirky.hosting' } as PluginCaller
  let cleaned = false
  const harness: CacheHarness = {
    env,
    server,
    projectPath,
    events,
    worktrees,
    caller,
    async call(method, params = {}, requestCaller = caller) {
      const handler = handlers[method]
      if (!handler) throw new Error(`Missing fixture handler: ${method}`)
      return await handler(params, requestCaller)
    },
    async cached(selectors = worktrees.map((worktree) => worktree.id)) {
      return await handlers.cachedReviews!({ worktrees: selectors }, caller) as { workspaces: Record<string, any>[] }
    },
    replaceWorktree(id, worktree) {
      const index = worktrees.findIndex((current) => current.id === id)
      if (index < 0) throw new Error(`Unknown fixture worktree: ${id}`)
      worktrees[index] = worktree
    },
    removeWorktree(id) {
      const index = worktrees.findIndex((current) => current.id === id)
      if (index >= 0) worktrees.splice(index, 1)
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
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await originalFetch(input, init)
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input))
    if (!paused && predicate(url.pathname)) {
      paused = true
      entered.resolve()
      await released.promise
    }
    return response
  }, { preconnect: originalFetch.preconnect })
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
  waitRealTurn(): Promise<void>
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
  const fakeTimerIds = new WeakMap<object, number>()
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
      fakeTimerIds.set(timer, timer.id)
      return timer
    }) as unknown as typeof setTimeout
    globalThis.clearTimeout = ((handle: unknown) => {
      const id = typeof handle === 'object' && handle !== null ? fakeTimerIds.get(handle) : undefined
      if (id !== undefined) {
        timers.delete(id)
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
    waitRealTurn() {
      const turn = Promise.withResolvers<void>()
      originalSetTimeout(turn.resolve, 0)
      return turn.promise
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
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await originalFetch(input, init)
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input))
    if (predicate(url.pathname)) clock.installTimers()
    return response
  }, { preconnect: originalFetch.preconnect })
  return () => { globalThis.fetch = originalFetch }
}

function refreshPayloads(harness: CacheHarness): Record<string, any>[] {
  return harness.events.filter((event) => event.type === 'refresh').map((event) => eventRecord(event.data))
}

function refreshOutcomeCount(harness: CacheHarness): number {
  return refreshPayloads(harness).filter((event) => Object.hasOwn(event, 'outcome')).length
}

function refreshCandidate(worktree: Worktree, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    worktree: worktree.id,
    branch: worktree.branch ?? 'feature',
    headOid: worktree.head,
    ...overrides
  }
}

async function waitForCondition(clock: ControlledClock, predicate: () => boolean, description: string): Promise<void> {
  for (let turn = 0; turn < 1_000; turn += 1) {
    if (predicate()) return
    await clock.waitRealTurn()
  }
  throw new Error(`Timed out waiting for ${description}`)
}

function holdStandInResponse(
  harness: CacheHarness,
  method: string,
  path: string
): { entered: Promise<void>; release(): void; clear(): void } {
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const key = `${method} ${path}`
  harness.server.responseBarriers.set(key, async () => {
    entered.resolve()
    await gate.promise
  })
  return {
    entered: entered.promise,
    release: () => gate.resolve(),
    clear: () => harness.server.responseBarriers.delete(key)
  }
}

async function withControlledHarness<T>(
  count: number,
  run: (harness: CacheHarness, clock: ControlledClock) => Promise<T>
): Promise<T> {
  const clock = controlledClock(Date.now())
  clock.installTimers()
  let harness: CacheHarness | undefined
  try {
    harness = await cacheHarness(count)
    return await run(harness, clock)
  } finally {
    try {
      await harness?.cleanup()
    } finally {
      clock.restore()
    }
  }
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

function withoutFetchedAt(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutFetchedAt)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'fetchedAt')
      .map(([key, entry]) => [key, withoutFetchedAt(entry)])
  )
}

test('manual GitLab refresh publishes a schema-valid result and lifecycle, and CLI uses candidate JSON', async () => {
  const world = await boot()
  const head = git(world, ['rev-parse', 'HEAD'])
  world.server.mergeRequests = [mrAtHead(head, { detailed_merge_status: 'mergeable' })]
  const events = await listenForEvents(world)
  const candidate = { worktree: world.worktree, branch: 'feature', headOid: head }
  const cliCandidate = { worktree: world.worktree, branch: 'feature' }

  const result = await world.call('refresh', { candidate, reason: 'manual' }) as Record<string, any>
  expect(result).toMatchObject({
    kind: 'found',
    review: {
      provider: 'gitlab',
      repository: world.identity,
      detailedMergeStatus: 'mergeable',
      number: 5,
      headRefOid: head
    }
  })
  expect(typeof result.fetchedAt).toBe('number')
  expect(world.glabInvocations()).toEqual([])
  expect(world.invocations()).toEqual([])

  const refreshEvents = events.filter((event) => {
    if (typeof event !== 'object' || event === null || !('type' in event)) return false
    return event.type === 'quirky.hosting/refresh'
  }).map((event) => eventRecord(event).data as Record<string, any>)
  expect(refreshEvents.map((event) => event.status)).toContain('in-flight')
  const completed = refreshEvents.find((event) => event.outcome?.kind === 'found')
  if (!completed) throw new Error('expected a completed GitLab refresh event')
  expect(completed).toMatchObject({
    reason: 'manual',
    worktreeId: world.worktree,
    outcome: { review: { provider: 'gitlab', repository: world.identity, detailedMergeStatus: 'mergeable' } }
  })
  expect(typeof completed.sequence).toBe('number')
  const sequences = refreshEvents.map((event) => event.sequence as number)
  expect(sequences).toEqual([...sequences].sort((left, right) => left - right))

  const resultSchema = methodResultSchema('refresh')
  const resultReviewSchema = propertySchema(resultSchema, 'review')
  expect(validateValue(resultSchema, {
    ...result,
    review: reviewForSchema(eventRecord(result.review), resultReviewSchema)
  }, 'refresh result')).toBeNull()

  const refreshEventSchema = eventDataSchema('refresh')
  const eventOutcomeSchema = propertySchema(refreshEventSchema, 'outcome')
  const eventReviewSchema = propertySchema(eventOutcomeSchema, 'review')
  expect(validateValue(refreshEventSchema, {
    ...completed,
    outcome: {
      ...completed.outcome,
      review: reviewForSchema(eventRecord(completed.outcome.review), eventReviewSchema)
    }
  }, 'refresh event')).toBeNull()

  const cli = await world.cli([
    '--json', 'hosting', 'refresh',
    '--candidate', JSON.stringify(cliCandidate),
    '--reason', 'manual'
  ])
  expect(cli.code).toBe(0)
  expect(withoutFetchedAt(JSON.parse(cli.stdout))).toEqual(withoutFetchedAt(result))

  const requestsBeforeQueue = world.server.requests.length
  const before = Date.now()
  const queued = await world.call('refresh', { candidate, reason: 'post-push' }) as Record<string, any>
  const after = Date.now()
  expect(queued).toMatchObject({ kind: 'queued' })
  expect(typeof queued.sequence).toBe('number')
  expect(typeof queued.dueAt).toBe('number')
  expect(Number(queued.dueAt)).toBeGreaterThanOrEqual(before + 2_500)
  expect(Number(queued.dueAt)).toBeLessThanOrEqual(after + 2_500)
  expect(world.server.requests).toHaveLength(requestsBeforeQueue)
  expect(validateValue(resultSchema, queued, 'post-push result')).toBeNull()
  expect(world.glabInvocations()).toEqual([])
  expect(world.invocations()).toEqual([])
}, 20_000)

test('GitLab keeps the default GitHub-only methods refused before provider requests', async () => {
  const world = await boot()
  const requests: Record<string, Record<string, unknown>> = {
    merge: { number: 5, expectedHead: 'a'.repeat(40), method: 'squash', action: 'direct', yes: true },
    autoMerge: { number: 5, action: 'enable', method: 'squash' },
    createStacked: { title: 'x', parentNumber: 5 },
    reviewers: { number: 5, action: 'add', logins: ['x'] },
    reviewAssignees: { number: 5, action: 'add', logins: ['x'] },
    reviewStack: { number: 5 },
    pushRepository: { remote: 'origin' },
    reaction: { number: 5, action: 'add', subjectId: 'x', content: '+1' },
    fileViewed: { number: 5, path: 'x', viewed: true },
    files: { number: 5 },
    fileContents: { number: 5, path: 'x', side: 'head' },
    rateLimit: {},
    accounts: {},
    configure: {},
    configuration: {}
  }
  for (const [method, params] of Object.entries(requests)) {
    await expect(world.call(method, params)).rejects.toMatchObject({
      message: `GitLab hosting does not answer quirky.hosting/${method} yet.`,
      data: { reason: 'unsupported_provider' }
    })
  }
  expect(world.server.requests).toEqual([])
  expect(world.glabInvocations()).toEqual([])
  expect(world.invocations()).toEqual([])
})

test('refresh refuses plugin-role callers and malformed or foreign-provider outcomes', async () => {
  const harness = await cacheHarness()
  const worktree = harness.worktrees[0]!
  const candidate = refreshCandidate(worktree)
  const requestsBefore = harness.server.requests.length
  await expect(harness.call('refresh', { candidate, reason: 'manual' }, harness.caller))
    .rejects.toMatchObject({ data: { reason: 'validation_error' } })
  expect(harness.server.requests).toHaveLength(requestsBefore)

  const invalidOutcomes: unknown[] = [
    { kind: 'found', fetchedAt: Date.now(), review: { provider: 'github' } },
    { kind: 'found', fetchedAt: Date.now(), review: { provider: 'gitlab', repository: harness.server.project, number: 5 } }
  ]
  for (const lookup of invalidOutcomes) {
    const methods = refreshMethods(harness.env, {
      forBranch: async () => lookup
    })
    const connection = refreshTestConnection(`malformed-${String(invalidOutcomes.indexOf(lookup))}`)
    const result = await methods.refresh!({ candidate, reason: 'manual' }, connection.caller) as Record<string, any>
    expect(result.kind).toBe('unavailable')
    expect(result.kind).not.toBe('found')
    connection.close()
  }
  expect(harness.server.requests).toHaveLength(requestsBefore)
})
test('visible refresh ownership unions worktrees, ignores stale generations, and cleans every owner', async () => {
  await withControlledHarness(3, async (harness) => {
    const [shared, firstOnly, secondOnly] = harness.worktrees
    if (!shared || !firstOnly || !secondOnly) throw new Error('expected three registered worktrees')
    const first = refreshTestConnection('visible-first')
    const second = refreshTestConnection('visible-second')
    const observer = refreshTestConnection('visible-observer')
    try {
      expect(await harness.call('visibleRefreshCandidates', {
        generation: 4,
        candidates: [refreshCandidate(shared), refreshCandidate(firstOnly)]
      }, first.caller)).toMatchObject({ accepted: true, generation: 4, candidates: 2 })
      expect(await harness.call('visibleRefreshCandidates', {
        generation: 2,
        candidates: [refreshCandidate(shared), refreshCandidate(secondOnly)]
      }, second.caller)).toMatchObject({ accepted: true, generation: 2, candidates: 2 })
      expect(await harness.call('refreshState', {}, first.caller)).toMatchObject({
        owners: 2, visibleCandidates: 3, queued: 3
      })

      expect(await harness.call('visibleRefreshCandidates', {
        generation: 4,
        candidates: []
      }, first.caller)).toMatchObject({ accepted: false, generation: 4, candidates: 2 })
      first.close()
      expect(await harness.call('refreshState', {}, second.caller)).toMatchObject({
        owners: 1, visibleCandidates: 2, queued: 2
      })

      expect(await harness.call('visibleRefreshCandidates', {
        generation: 3,
        candidates: [refreshCandidate(secondOnly)]
      }, second.caller)).toMatchObject({ accepted: true, generation: 3, candidates: 1 })
      second.close()
      expect(await harness.call('refreshState', {}, observer.caller)).toMatchObject({
        owners: 1, visibleCandidates: 0, queued: 0, inFlight: 0
      })
      expect(refreshPayloads(harness).some((event) => event.skippedReason === 'disconnected')).toBe(true)
      await expect(harness.call('refresh', {
        candidate: refreshCandidate(shared), reason: 'manual'
      }, harness.caller)).rejects.toMatchObject({ data: { reason: 'validation_error' } })
      expect(harness.server.requests).toEqual([])
    } finally {
      first.close()
      second.close()
      observer.close()
    }
  })
})

test('refresh candidate and tracked-work queues both enforce the 1000-entry bound', async () => {
  await withControlledHarness(1_001, async (harness) => {
    const first = refreshTestConnection('capacity-first')
    const second = refreshTestConnection('capacity-second')
    try {
      const candidates = harness.worktrees.slice(0, 1_000).map((worktree) => refreshCandidate(worktree))
      expect(await harness.call('visibleRefreshCandidates', { generation: 1, candidates }, first.caller))
        .toMatchObject({ accepted: true, candidates: 1_000 })
      await expect(harness.call('visibleRefreshCandidates', {
        generation: 2,
        candidates: Array.from({ length: 1_001 }, () => refreshCandidate(harness.worktrees[1_000]!))
      }, second.caller)).rejects.toMatchObject({ data: { reason: 'validation_error' } })
      expect(await harness.call('refreshState', {}, first.caller)).toMatchObject({
        visibleCandidates: 1_000, queued: 1_000
      })

      await expect(harness.call('visibleRefreshCandidates', {
        generation: 1,
        candidates: [refreshCandidate(harness.worktrees[1_000]!)]
      }, second.caller)).rejects.toMatchObject({ data: { reason: 'validation_error' } })
      await expect(harness.call('enqueueRefresh', {
        candidate: refreshCandidate(harness.worktrees[1_000]!),
        reason: 'visible'
      }, second.caller)).resolves.toMatchObject({ kind: 'skipped', skippedReason: 'capacity' })
      expect(await harness.call('refreshState', {}, first.caller)).toMatchObject({
        visibleCandidates: 1_000, queued: 1_000
      })
      expect(harness.server.requests).toEqual([])
    } finally {
      first.close()
      second.close()
    }
  })
}, 60_000)
test('GitLab background refresh starts are spaced by 10 seconds and capped at 20 per five minutes', async () => {
  await withControlledHarness(21, async (harness, clock) => {
    const connection = refreshTestConnection('background-budget')
    const candidates = harness.worktrees.map((worktree) => refreshCandidate(worktree))
    try {
      expect(await harness.call('visibleRefreshCandidates', { generation: 1, candidates }, connection.caller))
        .toMatchObject({ accepted: true, candidates: 21 })
      const startedAt = clock.now

      await clock.advanceTo(startedAt)
      await waitForCondition(clock, () => refreshOutcomeCount(harness) >= 1, 'the first background refresh')
      for (let count = 2; count <= 20; count += 1) {
        await clock.advanceTo(startedAt + (count - 1) * 10_000)
        await waitForCondition(clock, () => refreshOutcomeCount(harness) >= count, `background refresh ${count}`)
      }

      const starts = refreshPayloads(harness)
        .filter((event) => event.reason === 'visible' && event.status === 'in-flight')
        .map((event) => event.requestStartedAt as number)
      expect(starts).toHaveLength(20)
      expect(starts[0]).toBe(startedAt)
      for (let index = 1; index < starts.length; index += 1) {
        expect(starts[index]! - starts[index - 1]!).toBeGreaterThanOrEqual(10_000)
      }

      await clock.advanceTo(startedAt + 299_999)
      expect(refreshOutcomeCount(harness)).toBe(20)
      expect(await harness.call('refreshState', {}, connection.caller)).toMatchObject({
        budgets: { backgroundStarts: 20 }
      })
      await clock.advanceTo(startedAt + 300_000)
      await waitForCondition(clock, () => refreshOutcomeCount(harness) >= 21, 'the first background refresh after the five-minute cap')
      const allStarts = refreshPayloads(harness)
        .filter((event) => event.reason === 'visible' && event.status === 'in-flight')
        .map((event) => event.requestStartedAt as number)
      expect(allStarts).toHaveLength(21)
      expect(allStarts[20]).toBe(startedAt + 300_000)
      expect(harness.server.requests.length).toBeGreaterThan(0)
    } finally {
      connection.close()
    }
  })
}, 120_000)

test('GitLab active refreshes queue the fourth start per connection and budget until 30 seconds', async () => {
  await withControlledHarness(8, async (harness, clock) => {
    harness.server.mergeRequests = []
    const first = refreshTestConnection('active-budget-first')
    const second = refreshTestConnection('active-budget-second')
    const candidates = harness.worktrees.map((worktree) => refreshCandidate(worktree))
    try {
      const startedAt = clock.now
      for (let index = 0; index < 3; index += 1) {
        expect(await harness.call('refresh', {
          candidate: candidates[index], reason: 'active'
        }, first.caller)).toMatchObject({ kind: 'no-review' })
      }
      for (let index = 4; index < 7; index += 1) {
        expect(await harness.call('refresh', {
          candidate: candidates[index], reason: 'active'
        }, second.caller)).toMatchObject({ kind: 'no-review' })
      }
      const requestsAfterSix = harness.server.requests.length
      expect(await harness.call('refresh', {
        candidate: candidates[3], reason: 'active'
      }, first.caller)).toMatchObject({ kind: 'queued', dueAt: startedAt + 30_000 })
      expect(await harness.call('refresh', {
        candidate: candidates[7], reason: 'active'
      }, second.caller)).toMatchObject({ kind: 'queued', dueAt: startedAt + 30_000 })
      expect(harness.server.requests).toHaveLength(requestsAfterSix)
      expect(await harness.call('refreshState', {}, first.caller)).toMatchObject({
        queued: 2, budgets: { activeStarts: 3 }
      })
      expect(await harness.call('refreshState', {}, second.caller)).toMatchObject({
        queued: 2, budgets: { activeStarts: 3 }
      })

      await clock.advanceTo(startedAt + 29_999)
      expect(harness.server.requests).toHaveLength(requestsAfterSix)
      await clock.advanceTo(startedAt + 30_000)
      await waitForCondition(clock, () => refreshOutcomeCount(harness) >= 8, 'both queued active refreshes')
      const activeStarts = refreshPayloads(harness)
        .filter((event) => event.reason === 'active' && event.status === 'in-flight')
        .map((event) => event.requestStartedAt as number)
      expect(activeStarts.slice(-2)).toEqual([startedAt + 30_000, startedAt + 30_000])
      expect(harness.server.requests.length).toBeGreaterThan(requestsAfterSix)
    } finally {
      first.close()
      second.close()
    }
  })
}, 60_000)
test('GitLab Retry-After pauses manual refreshes on the shared host budget until its deadline', async () => {
  await withControlledHarness(2, async (harness, clock) => {
    const [firstWorktree, secondWorktree] = harness.worktrees
    if (!firstWorktree || !secondWorktree) throw new Error('expected two worktrees')
    const connection = refreshTestConnection('retry-after-budget')
    harness.server.failures.set(`GET ${harness.projectPath}/merge_requests`, {
      status: 429,
      headers: { 'Retry-After': '30' }
    })
    try {
      const startedAt = clock.now
      const failed = await harness.call('refresh', {
        candidate: refreshCandidate(firstWorktree), reason: 'manual'
      }, connection.caller) as Record<string, any>
      expect(failed).toMatchObject({
        kind: 'unavailable',
        reason: 'rate_limited',
        retryDisabledUntil: startedAt + 30_000
      })
      const deadline = failed.retryDisabledUntil as number
      const requestsAtDeadline = harness.server.requests.length

      const paused = await harness.call('refresh', {
        candidate: refreshCandidate(secondWorktree), reason: 'manual'
      }, connection.caller) as Record<string, any>
      expect(paused).toEqual({ kind: 'paused', skippedReason: 'rate-limit', pausedUntil: deadline })
      expect(harness.server.requests).toHaveLength(requestsAtDeadline)

      harness.server.failures.clear()
      await clock.advanceTo(deadline)
      const resumed = await harness.call('refresh', {
        candidate: refreshCandidate(secondWorktree), reason: 'manual'
      }, connection.caller)
      expect(resumed).toMatchObject({ kind: 'no-review' })
      expect(harness.server.requests.length).toBeGreaterThan(requestsAtDeadline)
      const afterSuccess = harness.server.requests.length
      expect(await harness.call('refresh', {
        candidate: refreshCandidate(secondWorktree), reason: 'manual'
      }, connection.caller)).toMatchObject({ kind: 'no-review' })
      expect(harness.server.requests.length).toBeGreaterThan(afterSuccess)

      harness.server.failures.set(`GET ${harness.projectPath}/merge_requests`, { status: 500 })
      expect(await harness.call('refresh', {
        candidate: refreshCandidate(secondWorktree), reason: 'manual'
      }, connection.caller)).toMatchObject({ kind: 'unavailable', reason: 'server_error' })
      const afterFailure = harness.server.requests.length
      harness.server.failures.clear()
      expect(await harness.call('refresh', {
        candidate: refreshCandidate(secondWorktree), reason: 'manual'
      }, connection.caller)).toMatchObject({ kind: 'no-review' })
      expect(harness.server.requests.length).toBeGreaterThan(afterFailure)
    } finally {
      connection.close()
    }
  })
})

test('GitLab background failures double from 60 seconds and stop at the 15-minute cap', async () => {
  await withControlledHarness(1, async (harness, clock) => {
    const worktree = harness.worktrees[0]!
    const connection = refreshTestConnection('failure-backoff')
    harness.server.failures.set(`GET ${harness.projectPath}/merge_requests`, { status: 500 })
    try {
      const startedAt = clock.now
      expect(await harness.call('visibleRefreshCandidates', {
        generation: 1,
        candidates: [refreshCandidate(worktree)]
      }, connection.caller)).toMatchObject({ accepted: true, candidates: 1 })
      await clock.advanceTo(startedAt)
      await waitForCondition(clock, () => refreshOutcomeCount(harness) >= 1, 'the first failed refresh')

      const starts = [startedAt]
      let outcomes = 1
      for (const delay of [60_000, 120_000, 240_000, 480_000, 900_000, 900_000]) {
        const nextStart = starts.at(-1)! + delay
        await clock.advanceTo(nextStart - 1)
        expect(refreshOutcomeCount(harness)).toBe(outcomes)
        await clock.advanceTo(nextStart)
        outcomes += 1
        await waitForCondition(clock, () => refreshOutcomeCount(harness) >= outcomes, `failed refresh ${outcomes}`)
        starts.push(nextStart)
        expect(refreshPayloads(harness).filter((event) => event.status === 'in-flight')
          .map((event) => event.requestStartedAt)).toEqual(starts)
      }
    } finally {
      connection.close()
    }
  })
}, 60_000)
test('queued GitLab refreshes revalidate the host identity before any provider request', async () => {
  await withControlledHarness(1, async (harness, clock) => {
    const worktree = harness.worktrees[0]!
    const connection = refreshTestConnection('queued-host-change')
    try {
      expect(await harness.call('enqueueRefresh', {
        candidate: refreshCandidate(worktree),
        reason: 'visible'
      }, connection.caller)).toMatchObject({ kind: 'queued' })
      harness.setGitLabHosts('gitlab.com')
      await clock.advanceTo(clock.now)
      await waitForCondition(clock, () =>
        refreshPayloads(harness).some((event) => event.skippedReason === 'superseded'),
      'the stale queued refresh to be discarded')
      expect(harness.server.requests).toEqual([])
      expect(await harness.call('refreshState', {}, connection.caller)).toMatchObject({
        queued: 0, inFlight: 0, visibleCandidates: 0
      })
    } finally {
      connection.close()
    }
  })
})

test('direct GitLab refreshes return superseded after every awaited target-identity change', async () => {
  const mutations: [string, (harness: CacheHarness, worktree: Worktree) => void | Promise<void>][] = [
    ['instance replacement', (harness, worktree) => harness.replaceWorktree(worktree.id, {
      ...worktree, instanceId: 'replacement-instance'
    })],
    ['path replacement', (harness, worktree) => harness.replaceWorktree(worktree.id, {
      ...worktree, path: `${worktree.path}-replacement`
    })],
    ['branch change', (harness, worktree) => harness.replaceWorktree(worktree.id, {
      ...worktree, branch: 'release'
    })],
    ['HEAD change', (harness, worktree) => harness.replaceWorktree(worktree.id, {
      ...worktree, head: 'f'.repeat(40)
    })],
    ['detachment', (harness, worktree) => harness.replaceWorktree(worktree.id, {
      ...worktree, branch: null
    })],
    ['repository replacement', (harness, worktree) => harness.replaceWorktree(worktree.id, {
      ...worktree, repoId: 'repo_deadbeef'
    })],
    ['remote change', (harness, worktree) => harness.setRemotes(worktree.id, {
      origin: `http://${harness.server.host}/group/sub/replaced.git`, upstream: null
    })],
    ['saved configuration change', (harness, worktree) => harness.setConfiguration(worktree, {
      issueSourcePreference: 'origin', account: null
    })],
    ['host removal', (harness) => harness.setGitLabHosts('gitlab.com')],
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
    ['worktree removal', (harness, worktree) => harness.removeWorktree(worktree.id)]
  ]

  for (const [change, mutate] of mutations) {
    await withControlledHarness(1, async (harness) => {
      const worktree = harness.worktrees[0]!
      const connection = refreshTestConnection(`direct-stale-${change}`)
      const barrier = holdStandInResponse(harness, 'GET', `${harness.projectPath}/merge_requests`)
      try {
        const pending = harness.call('refresh', {
          candidate: refreshCandidate(worktree),
          reason: 'manual'
        }, connection.caller)
        await barrier.entered
        const requestsAtBarrier = harness.server.requests.length
        await mutate(harness, worktree)
        barrier.release()
        const result = await pending as Record<string, any>
        expect(result, change).toMatchObject({ kind: 'unavailable', reason: 'superseded' })
        expect(harness.server.requests, change).toHaveLength(requestsAtBarrier)
        expect(refreshPayloads(harness).filter((event) => event.outcome?.kind === 'found'), change).toHaveLength(0)
        expect(refreshPayloads(harness).some((event) => event.skippedReason === 'superseded'), change).toBe(true)
      } finally {
        barrier.release()
        barrier.clear()
        connection.close()
      }
    })
  }

  await withControlledHarness(1, async (harness) => {
    const worktree = harness.worktrees[0]!
    const connection = refreshTestConnection('direct-stale-disposal')
    const barrier = holdStandInResponse(harness, 'GET', `${harness.projectPath}/merge_requests`)
    try {
      const pending = harness.call('refresh', {
        candidate: refreshCandidate(worktree), reason: 'manual'
      }, connection.caller)
      await barrier.entered
      await harness.env.dispose()
      barrier.release()
      expect(await pending).toMatchObject({ kind: 'unavailable' })
      expect(refreshPayloads(harness).filter((event) => event.outcome?.kind === 'found')).toHaveLength(0)
    } finally {
      barrier.release()
      barrier.clear()
      connection.close()
    }
  })
}, 60_000)

test('disconnecting the last visible owner during a read cannot create a repeating refresh', async () => {
  await withControlledHarness(1, async (harness, clock) => {
    const worktree = harness.worktrees[0]!
    const connection = refreshTestConnection('visible-in-flight-disconnect')
    const barrier = holdStandInResponse(harness, 'GET', `${harness.projectPath}/merge_requests`)
    try {
      expect(await harness.call('visibleRefreshCandidates', {
        generation: 1,
        candidates: [refreshCandidate(worktree)]
      }, connection.caller)).toMatchObject({ accepted: true, candidates: 1 })
      await clock.advanceTo(clock.now)
      await barrier.entered
      const requestsAfterStart = harness.server.requests.length
      connection.close()
      barrier.release()
      await waitForCondition(clock, () =>
        refreshPayloads(harness).some((event) => event.skippedReason === 'disconnected'),
      'the disconnected in-flight refresh to finish')
      expect(harness.server.requests).toHaveLength(requestsAfterStart)

      await clock.advanceTo(clock.now + 16 * 60_000)
      const observer = refreshTestConnection('visible-disconnect-observer')
      try {
        expect(await harness.call('refreshState', {}, observer.caller)).toMatchObject({
          queued: 0, visibleCandidates: 0, inFlight: 0
        })
        expect(harness.server.requests).toHaveLength(requestsAfterStart)
      } finally {
        observer.close()
      }
    } finally {
      barrier.release()
      barrier.clear()
      connection.close()
    }
  })
}, 60_000)
test('a slower older visible generation cannot replace a newer concurrent report', async () => {
  await withControlledHarness(1, async (harness) => {
    const worktree = harness.worktrees[0]!
    const connection = refreshTestConnection('visible-generation-race')
    const resolverEntered = Promise.withResolvers<void>()
    const releaseResolver = Promise.withResolvers<void>()
    const originalGitWorktree = harness.env.gitWorktree
    let firstBranchRead = true
    harness.env.gitWorktree = async (target, args) => {
      if (target.id === worktree.id && args[0] === 'symbolic-ref' && firstBranchRead) {
        firstBranchRead = false
        resolverEntered.resolve()
        await releaseResolver.promise
      }
      return originalGitWorktree(target, args)
    }
    try {
      const older = harness.call('visibleRefreshCandidates', {
        generation: 5,
        candidates: [refreshCandidate(worktree)]
      }, connection.caller)
      await resolverEntered.promise

      expect(await harness.call('visibleRefreshCandidates', {
        generation: 6,
        candidates: []
      }, connection.caller)).toMatchObject({ accepted: true, generation: 6, candidates: 0 })
      releaseResolver.resolve()
      expect(await older).toMatchObject({ accepted: false, generation: 6, candidates: 0 })
      expect(await harness.call('refreshState', {}, connection.caller)).toMatchObject({
        queued: 0, visibleCandidates: 0
      })
      expect(harness.server.requests).toEqual([])
    } finally {
      releaseResolver.resolve()
      harness.env.gitWorktree = originalGitWorktree
      connection.close()
    }
  })
})

test('GitHub and GitLab background budgets do not collide on a shared host string', async () => {
  await withControlledHarness(2, async (harness, clock) => {
    const [gitlabWorktree, githubWorktree] = harness.worktrees
    if (!gitlabWorktree || !githubWorktree) throw new Error('expected two worktrees')
    const githubRemote = `https://${harness.server.host}/owner/repo.git?source=github`
    harness.setRemotes(githubWorktree.id, { origin: githubRemote, upstream: null })
    const githubIdentity = { host: harness.server.host, owner: 'owner', repo: 'repo' }
    const originalResolve = harness.env.resolve
    harness.env.resolve = async (params, caller) => {
      if (params.worktree === githubWorktree.id) {
        return {
          worktree: githubWorktree,
          origin: githubIdentity,
          repository: githubIdentity,
          candidates: [githubIdentity],
          issueRepository: githubIdentity,
          issueSourcePreference: 'origin',
          issueSourceFellBack: false,
          remotes: { origin: githubRemote, upstream: null }
        }
      }
      return originalResolve(params, caller)
    }
    const connection = refreshTestConnection('provider-budget-separation')
    try {
      const startedAt = clock.now
      expect(await harness.call('enqueueRefresh', {
        candidate: refreshCandidate(gitlabWorktree),
        reason: 'visible'
      }, connection.caller)).toMatchObject({ kind: 'queued' })
      expect(await harness.call('enqueueRefresh', {
        candidate: refreshCandidate(githubWorktree),
        reason: 'visible'
      }, connection.caller)).toMatchObject({ kind: 'queued' })

      await clock.advanceTo(startedAt)
      await waitForCondition(clock, () => refreshOutcomeCount(harness) >= 2, 'both provider budgets to start')
      const starts = refreshPayloads(harness)
        .filter((event) => event.status === 'in-flight')
        .map((event) => event.requestStartedAt as number)
      expect(starts).toEqual([startedAt, startedAt])
      expect(await harness.call('refreshState', {}, connection.caller)).toMatchObject({
        budgets: { backgroundStarts: 2 }
      })
      expect(harness.server.requests.length).toBeGreaterThan(0)
    } finally {
      connection.close()
    }
  })
}, 20_000)
test('queued refreshes reject replaced, removed, detached, changed, and host-removed targets before start', async () => {
  const mutations: [string, (harness: CacheHarness, worktree: Worktree) => void][] = [
    ['instance replacement', (harness, worktree) => harness.replaceWorktree(worktree.id, { ...worktree, instanceId: 'new-instance' })],
    ['path replacement', (harness, worktree) => harness.replaceWorktree(worktree.id, { ...worktree, path: `${worktree.path}-new` })],
    ['branch change', (harness, worktree) => harness.replaceWorktree(worktree.id, { ...worktree, branch: 'release' })],
    ['HEAD change', (harness, worktree) => harness.replaceWorktree(worktree.id, { ...worktree, head: 'f'.repeat(40) })],
    ['detachment', (harness, worktree) => harness.replaceWorktree(worktree.id, { ...worktree, branch: null })],
    ['repository change', (harness, worktree) => harness.replaceWorktree(worktree.id, { ...worktree, repoId: 'repo_deadbeef' })],
    ['remote change', (harness, worktree) => harness.setRemotes(worktree.id, {
      origin: `http://${harness.server.host}/group/sub/other.git`, upstream: null
    })],
    ['saved configuration change', (harness, worktree) => harness.setConfiguration(worktree, {
      issueSourcePreference: 'origin', account: null
    })],
    ['host removal', (harness) => harness.setGitLabHosts('gitlab.com')],
    ['worktree removal', (harness, worktree) => harness.removeWorktree(worktree.id)]
  ]
  for (const [change, mutate] of mutations) {
    await withControlledHarness(1, async (harness, clock) => {
      const worktree = harness.worktrees[0]!
      const connection = refreshTestConnection(`queued-stale-${change}`)
      try {
        expect(await harness.call('enqueueRefresh', {
          candidate: refreshCandidate(worktree), reason: 'visible'
        }, connection.caller)).toMatchObject({ kind: 'queued' })
        mutate(harness, worktree)
        await clock.advanceTo(clock.now)
        await waitForCondition(clock, () =>
          refreshPayloads(harness).some((event) => event.skippedReason === 'superseded'),
        `${change} queue entry to be skipped`)
        expect(harness.server.requests, change).toEqual([])
        expect(await harness.call('refreshState', {}, connection.caller), change).toMatchObject({
          queued: 0, inFlight: 0
        })
      } finally {
        connection.close()
      }
    })
  }
}, 60_000)

test('GitHub and GitLab host pacing keys stay distinct when their host strings match', async () => {
  await withControlledHarness(2, async (harness, clock) => {
    const [gitlabWorktree, githubWorktree] = harness.worktrees
    if (!gitlabWorktree || !githubWorktree) throw new Error('expected two worktrees')
    const githubRemote = `https://${harness.server.host}/owner/repo.git?source=github`
    harness.setRemotes(githubWorktree.id, { origin: githubRemote, upstream: null })
    const githubIdentity = { host: harness.server.host, owner: 'owner', repo: 'repo' }
    const originalResolve = harness.env.resolve
    harness.env.resolve = async (params, caller) => {
      if (params.worktree === githubWorktree.id) {
        return {
          worktree: githubWorktree,
          origin: githubIdentity,
          repository: githubIdentity,
          candidates: [githubIdentity],
          issueRepository: githubIdentity,
          issueSourcePreference: 'origin',
          issueSourceFellBack: false,
          remotes: { origin: githubRemote, upstream: null }
        }
      }
      return originalResolve(params, caller)
    }
    const connection = refreshTestConnection('provider-budget-separation')
    try {
      const startedAt = clock.now
      expect(await harness.call('enqueueRefresh', {
        candidate: refreshCandidate(gitlabWorktree), reason: 'visible'
      }, connection.caller)).toMatchObject({ kind: 'queued' })
      expect(await harness.call('enqueueRefresh', {
        candidate: refreshCandidate(githubWorktree), reason: 'visible'
      }, connection.caller)).toMatchObject({ kind: 'queued' })

      await clock.advanceTo(startedAt)
      await waitForCondition(clock, () => refreshOutcomeCount(harness) >= 2, 'both provider budgets')
      const starts = refreshPayloads(harness)
        .filter((event) => event.status === 'in-flight')
        .map((event) => event.requestStartedAt as number)
      expect(starts).toEqual([startedAt, startedAt])
      expect(await harness.call('refreshState', {}, connection.caller)).toMatchObject({
        budgets: { backgroundStarts: 2 }
      })
      expect(harness.server.requests.length).toBeGreaterThan(0)
    } finally {
      connection.close()
    }
  })
}, 20_000)
test('real daemon GitLab visibility refresh shares connection owners and validates its event schema', async () => {
  const world = await boot()
  const head = git(world, ['rev-parse', 'HEAD'])
  world.server.mergeRequests = []
  const { events, firstRefresh } = await listenForRefreshEvents(world)
  const candidate = { worktree: world.worktree, branch: 'feature', headOid: head }
  const first = await world.call('visibleRefreshCandidates', { generation: 1, candidates: [candidate] })
  expect(first).toMatchObject({ accepted: true, generation: 1, candidates: 1 })
  expect(validateValue(methodResultSchema('visibleRefreshCandidates'), first, 'visibility result')).toBeNull()

  const second = await world.connect('ui')
  let secondClosed = false
  const closeSecond = () => {
    if (secondClosed) return
    secondClosed = true
    second.close()
  }
  try {
    const overlap = await second.callAny('quirky.hosting/visibleRefreshCandidates', {
      generation: 0,
      candidates: [candidate]
    })
    expect(overlap).toMatchObject({ accepted: true, generation: 0, candidates: 1 })
    expect(await world.call('refreshState')).toMatchObject({ owners: 2, visibleCandidates: 1 })
    closeSecond()
    expect(await world.call('refreshState')).toMatchObject({ owners: 1, visibleCandidates: 1 })

    await firstRefresh
    const event = events.map(eventRecord).find((value) => value.type === 'quirky.hosting/refresh')
    if (!event) throw new Error('expected a GitLab visibility refresh lifecycle event')
    expect(validateValue(eventDataSchema('refresh'), eventRecord(event.data), 'visibility refresh event')).toBeNull()
    expect(world.glabInvocations()).toEqual([])
    expect(world.invocations()).toEqual([])
  } finally {
    closeSecond()
    await world.call('visibleRefreshCandidates', { generation: 2, candidates: [] })
  }
}, 20_000)
