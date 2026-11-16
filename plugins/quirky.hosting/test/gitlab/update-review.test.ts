import { afterEach, expect, test } from 'bun:test'
import type { HostingTest } from '../helpers'
import { bootGitLab, type GitLabWorld } from './world'
import { mergeRequest } from './stand-in'

let active: HostingTest | undefined

async function boot(overrides: Record<string, unknown> = {}, drop: string[] = []): Promise<GitLabWorld> {
  const world = await bootGitLab()
  active = world
  world.server.mergeRequests = [mr(overrides, drop)]
  return world
}

afterEach(async () => {
  await active?.cleanup()
  active = undefined
})

const projectPath = (world: GitLabWorld) => `/api/v4/projects/${encodeURIComponent(`${world.identity.owner}/${world.identity.repo}`)}`
const reviewPath = (world: GitLabWorld) => `${projectPath(world)}/merge_requests/5`
const reason = (value: string) => ({ data: { reason: value } })
const unknownMessage = 'GitLab did not confirm the merge request update. Refresh before retrying.'
const schemaDriftMessage = 'GitLab returned an unexpected response.'

type Action = 'edit' | 'close' | 'reopen' | 'ready' | 'draft'

function mr(overrides: Record<string, unknown> = {}, drop: string[] = []): Record<string, any> {
  const value = mergeRequest(overrides)
  for (const key of drop) delete value[key]
  return value
}

async function update(world: GitLabWorld, action: Action, params: Record<string, unknown> = {}): Promise<unknown> {
  return world.call('updateReview', { number: 5, action, ...params })
}

async function expectUnknownCompletion(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({ message: unknownMessage, ...reason('unknown_completion') })
}

async function expectSchemaDrift(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({ message: schemaDriftMessage, ...reason('schema_drift') })
}

function expectPutCount(world: GitLabWorld, count: number): void {
  expect(world.server.requests.filter((request) => request.method === 'PUT')).toHaveLength(count)
}

function expectReadbackCount(world: GitLabWorld, count: number): void {
  const putIndex = world.server.requests.findIndex((request) => request.method === 'PUT')
  expect(putIndex).toBeGreaterThanOrEqual(0)
  expect(world.server.requests.slice(putIndex + 1).filter((request) =>
    request.method === 'GET' && request.path === reviewPath(world)
  )).toHaveLength(count)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function listenForEvents(world: GitLabWorld): Promise<unknown[]> {
  const events: unknown[] = []
  world.client.onEvent((event) => events.push(event))
  await world.client.callAny('events.subscribe', {})
  return events
}

function changedEvents(events: unknown[]): unknown[] {
  return events.filter((event) => isRecord(event) && event.type === 'quirky.hosting/changed')
}

function runGit(world: GitLabWorld, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: world.repoPath, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git fixture setup failed: ${new TextDecoder().decode(result.stderr)}`)
  return new TextDecoder().decode(result.stdout).trim()
}

async function cachedReviews(world: GitLabWorld): Promise<Record<string, any>[]> {
  const result = await world.client.callAny('quirky.hosting/cachedReviews', { worktrees: [world.worktree] }) as { workspaces?: unknown }
  if (!Array.isArray(result.workspaces)) throw new Error('cachedReviews returned an invalid workspace result')
  return result.workspaces as Record<string, any>[]
}

function mrAtHead(head: string, overrides: Record<string, unknown> = {}): Record<string, any> {
  return mergeRequest({
    sha: head,
    diff_refs: { base_sha: 'b'.repeat(40), start_sha: 'c'.repeat(40), head_sha: head },
    ...overrides
  })
}

test.failing('ready with an unchanged reply is unknown completion', async () => {
  const world = await boot({ title: 'Draft: unchanged', draft: true })
  world.server.failures.set(`PUT ${reviewPath(world)}`, { status: 200, body: mr({ title: 'Draft: unchanged', draft: true }) })

  await expectUnknownCompletion(update(world, 'ready'))
  expect(world.server.mergeRequests[0]).toMatchObject({ title: 'Draft: unchanged', draft: true })
  expectPutCount(world, 1)
  expectReadbackCount(world, 1)
})

test.failing('close with an unchanged reply is unknown completion', async () => {
  const world = await boot({ title: 'Open work', draft: false })
  world.server.failures.set(`PUT ${reviewPath(world)}`, { status: 200, body: mr({ title: 'Open work', draft: false }) })

  await expectUnknownCompletion(update(world, 'close'))
  expect(world.server.mergeRequests[0]?.state).toBe('opened')
  expectPutCount(world, 1)
  expectReadbackCount(world, 1)
})

test.failing('reopen with an unchanged reply is unknown completion', async () => {
  const world = await boot({ state: 'closed', title: 'Closed work', draft: false })
  world.server.failures.set(`PUT ${reviewPath(world)}`, { status: 200, body: mr({ state: 'closed', title: 'Closed work', draft: false }) })

  await expectUnknownCompletion(update(world, 'reopen'))
  expect(world.server.mergeRequests[0]?.state).toBe('closed')
  expectPutCount(world, 1)
  expectReadbackCount(world, 1)
})

test.failing('draft with an unchanged reply is unknown completion', async () => {
  const world = await boot({ title: 'Unchanged', draft: false })
  world.server.failures.set(`PUT ${reviewPath(world)}`, { status: 200, body: mr({ title: 'Unchanged', draft: false }) })

  await expectUnknownCompletion(update(world, 'draft'))
  expect(world.server.mergeRequests[0]?.draft).toBe(false)
  expectPutCount(world, 1)
  expectReadbackCount(world, 1)
})

test.failing('ready on a closed draft returns the closed state after clearing draft', async () => {
  const world = await boot({ state: 'closed', title: 'Draft: closed work', draft: true })

  expect(await update(world, 'ready')).toEqual({ number: 5, updated: true, state: 'closed' })
  expect(world.server.mergeRequests[0]).toMatchObject({ state: 'closed', draft: false, title: 'closed work' })
  expect(world.server.requests.find((request) => request.method === 'PUT')?.body).toEqual({ title: 'closed work' })
  expectPutCount(world, 1)
})

test.failing('ready with an incomplete object reply is unknown completion', async () => {
  const world = await boot({ title: 'Draft: x', draft: true })
  world.server.failures.set(`PUT ${reviewPath(world)}`, {
    status: 200,
    body: { iid: 5, id: 5, project_id: 42 }
  })

  await expectUnknownCompletion(update(world, 'ready'))
  expectPutCount(world, 1)
  expectReadbackCount(world, 1)
})

const invalidReplyCases: Array<{ name: string; body: Record<string, any> }> = [
  { name: 'missing state', body: mr({}, ['state']) },
  { name: 'unsupported state', body: mr({ state: 'locked' }) },
  { name: 'numeric title', body: mr({ title: 7 }) },
  { name: 'empty title', body: mr({ title: '' }) },
  { name: 'string draft flag', body: mr({ draft: 'no' }) },
  { name: 'string legacy draft flag', body: mr({ work_in_progress: 'no' }) },
  { name: 'null draft flag', body: mr({ draft: null }) }
]
for (const { name, body } of invalidReplyCases) {
  test.failing(`ready with a reply containing ${name} is unknown completion`, async () => {
    const world = await boot({ title: 'Draft: x', draft: true })
    world.server.failures.set(`PUT ${reviewPath(world)}`, { status: 200, body })

    await expectUnknownCompletion(update(world, 'ready'))
    expectPutCount(world, 1)
    expectReadbackCount(world, 1)
  })
}

const wrongIdentityReplyCases: Array<{ name: string; body: Record<string, any> }> = [
  { name: 'a different iid', body: mr({ iid: 6 }) },
  { name: 'a missing iid', body: mr({}, ['iid']) },
  { name: 'a different project', body: mr({ project_id: 43 }) },
  { name: 'a missing project id', body: mr({}, ['project_id']) }
]
for (const { name, body } of wrongIdentityReplyCases) {
  test.failing(`ready with ${name} in the reply is unknown completion`, async () => {
    const world = await boot({ title: 'Draft: x', draft: true })
    world.server.failures.set(`PUT ${reviewPath(world)}`, { status: 200, body })

    await expectUnknownCompletion(update(world, 'ready'))
    expectPutCount(world, 1)
    expectReadbackCount(world, 1)
  })
}

const nonObjectReplies: Array<{ name: string; body: unknown }> = [
  { name: 'a string', body: 'ok' },
  { name: 'an array', body: [] },
  { name: 'null', body: null }
]
for (const { name, body } of nonObjectReplies) {
  test.failing(`close with ${name} reply is unknown completion`, async () => {
    const world = await boot({ title: 'Open work', draft: false })
    world.server.failures.set(`PUT ${reviewPath(world)}`, { status: 200, body })

    await expectUnknownCompletion(update(world, 'close'))
    expectPutCount(world, 1)
    expectReadbackCount(world, 1)
  })
}

for (const [name, raw] of [['unparseable', 'not json'], ['empty', '']] as const) {
  test.failing(`close with an ${name} raw reply is unknown completion`, async () => {
    const world = await boot({ title: 'Open work', draft: false })
    world.server.failures.set(`PUT ${reviewPath(world)}`, { status: 200, raw })

    await expectUnknownCompletion(update(world, 'close'))
    expectPutCount(world, 1)
    expectReadbackCount(world, 1)
  })
}

test.failing('close with a reply over the output limit is unknown completion', async () => {
  const world = await boot({ title: 'Open work', draft: false })
  world.server.failures.set(`PUT ${reviewPath(world)}`, { status: 200, body: 'x'.repeat(4 * 1024 * 1024 + 16) })

  await expectUnknownCompletion(update(world, 'close'))
  expectPutCount(world, 1)
  expectReadbackCount(world, 1)
})

test.failing('ready with a malformed reply succeeds when readback sees the landed update', async () => {
  const world = await boot({ title: 'Draft: x', draft: true })
  world.server.responseBarriers.set(`PUT ${reviewPath(world)}`, async () => {
    Object.assign(world.server.mergeRequests[0]!, { title: 'Add x', draft: false })
  })
  world.server.failures.set(`PUT ${reviewPath(world)}`, { status: 200, raw: 'not json' })

  expect(await update(world, 'ready')).toEqual({ number: 5, updated: true, state: 'open' })
  expect(world.server.mergeRequests[0]).toMatchObject({ title: 'Add x', draft: false })
  expectPutCount(world, 1)
  expectReadbackCount(world, 1)
})

test.failing('close with failed readback is unknown completion', async () => {
  const world = await boot({ title: 'Open work', draft: false })
  world.server.failures.set(`PUT ${reviewPath(world)}`, { status: 200, body: mr({ title: 'Open work', draft: false }) })
  world.server.responseBarriers.set(`PUT ${reviewPath(world)}`, async () => {
    world.server.failures.set(`GET ${reviewPath(world)}`, { status: 500 })
  })

  await expectUnknownCompletion(update(world, 'close'))
  expectPutCount(world, 1)
  expectReadbackCount(world, 1)
})

test.failing('close with invalid readback is unknown completion', async () => {
  const world = await boot({ title: 'Open work', draft: false })
  world.server.failures.set(`PUT ${reviewPath(world)}`, { status: 200, body: mr({ title: 'Open work', draft: false }) })
  world.server.responseBarriers.set(`PUT ${reviewPath(world)}`, async () => {
    world.server.failures.set(`GET ${reviewPath(world)}`, { status: 200, body: mr({ iid: 6 }) })
  })

  await expectUnknownCompletion(update(world, 'close'))
  expectPutCount(world, 1)
  expectReadbackCount(world, 1)
})

const invalidPrewriteCases: Array<{ name: string; body: Record<string, any>; action: Action }> = [
  { name: 'a different iid', body: mr({ iid: 6 }), action: 'close' },
  { name: 'a missing iid', body: mr({}, ['iid']), action: 'close' },
  { name: 'a different project', body: mr({ project_id: 43 }), action: 'close' },
  { name: 'a missing project id', body: mr({}, ['project_id']), action: 'close' },
  { name: 'a missing state', body: mr({}, ['state']), action: 'ready' },
  { name: 'an unsupported state', body: mr({ state: 'locked' }), action: 'close' },
  { name: 'a missing title', body: mr({ draft: true }, ['title']), action: 'draft' },
  { name: 'an empty title', body: mr({ title: '' }), action: 'close' },
  { name: 'a string draft flag', body: mr({ draft: 'yes' }), action: 'ready' },
  { name: 'a null draft flag', body: mr({ draft: null }), action: 'draft' },
  { name: 'a string legacy draft flag', body: mr({ work_in_progress: 'no' }), action: 'draft' }
]
for (const { name, body, action } of invalidPrewriteCases) {
  test.failing(`updateReview rejects a pre-write MR with ${name}`, async () => {
    const world = await boot()
    world.server.failures.set(`GET ${reviewPath(world)}`, { status: 200, body })

    await expectSchemaDrift(update(world, action))
    expectPutCount(world, 0)
  })
}

test('a missing pre-write merge request remains not found', async () => {
  const world = await boot()
  world.server.failures.set(`GET ${reviewPath(world)}`, { status: 404 })

  await expect(update(world, 'close')).rejects.toMatchObject(reason('not_found'))
  expectPutCount(world, 0)
})

for (const [name, params, unchanged] of [
  ['title', { title: 'New title' }, mr({ title: 'Open work', draft: false })],
  ['body', { body: 'new body' }, mr({ title: 'Open work', draft: false })]
] as const) {
  test.failing(`edit ${name} with an unchanged reply is unknown completion`, async () => {
    const world = await boot({ title: 'Open work', draft: false })
    world.server.failures.set(`PUT ${reviewPath(world)}`, { status: 200, body: unchanged })

    await expectUnknownCompletion(update(world, 'edit', params))
    expectPutCount(world, 1)
    expectReadbackCount(world, 1)
  })
}

test('edit confirms a body after CRLF normalization', async () => {
  const world = await boot({ title: 'Open work', draft: false })
  world.server.failures.set(`PUT ${reviewPath(world)}`, { status: 200, body: mr({ title: 'Open work', draft: false, description: 'a\nb' }) })

  expect(await update(world, 'edit', { body: 'a\r\nb' })).toEqual({ number: 5, updated: true, state: 'open' })
  expectPutCount(world, 1)
})

test.failing('close on a closed MR is a no-op with its validated state', async () => {
  const world = await boot({ state: 'closed', title: 'Closed work', draft: false })

  expect(await update(world, 'close')).toEqual({ number: 5, updated: false, state: 'closed' })
  expectPutCount(world, 0)
})

test.failing('reopen on an open draft is a no-op with draft state', async () => {
  const world = await boot({ state: 'opened', title: 'Draft: open work', draft: true })

  expect(await update(world, 'reopen')).toEqual({ number: 5, updated: false, state: 'draft' })
  expectPutCount(world, 0)
})

test.failing('reopen on an open non-draft is a no-op with open state', async () => {
  const world = await boot({ state: 'opened', title: 'Open work', draft: false })

  expect(await update(world, 'reopen')).toEqual({ number: 5, updated: false, state: 'open' })
  expectPutCount(world, 0)
})

test.failing('draft on a closed draft is a no-op with closed state', async () => {
  const world = await boot({ state: 'closed', title: 'Draft: closed work', draft: true })

  expect(await update(world, 'draft')).toEqual({ number: 5, updated: false, state: 'closed' })
  expectPutCount(world, 0)
})

test.failing('draft on a merged draft is a no-op with merged state', async () => {
  const world = await boot({ state: 'merged', title: 'Draft: merged work', draft: true })

  expect(await update(world, 'draft')).toEqual({ number: 5, updated: false, state: 'merged' })
  expectPutCount(world, 0)
})

test('ready on a closed non-draft is a no-op with closed state', async () => {
  const world = await boot({ state: 'closed', title: 'Closed work', draft: false })

  expect(await update(world, 'ready')).toEqual({ number: 5, updated: false, state: 'closed' })
  expectPutCount(world, 0)
})

test('ready on a merged non-draft is a no-op with merged state', async () => {
  const world = await boot({ state: 'merged', title: 'Merged work', draft: false })

  expect(await update(world, 'ready')).toEqual({ number: 5, updated: false, state: 'merged' })
  expectPutCount(world, 0)
})

for (const [action, message] of [
  ['reopen', 'GitLab cannot reopen a merged merge request.'],
  ['close', 'GitLab cannot close a merged merge request.']
] as const) {
  test.failing(`${action} on a merged MR is refused`, async () => {
    const world = await boot({ state: 'merged', title: 'Merged work', draft: false })

    await expect(update(world, action)).rejects.toMatchObject({ message, ...reason('invalid_state') })
    expectPutCount(world, 0)
  })
}

test.failing('reopen of a closed draft returns draft state', async () => {
  const world = await boot({ state: 'closed', title: 'Draft: x', draft: true })

  expect(await update(world, 'reopen')).toEqual({ number: 5, updated: true, state: 'draft' })
  expect(world.server.mergeRequests[0]).toMatchObject({ state: 'opened', title: 'Draft: x', draft: true })
  expectPutCount(world, 1)
})

test('ready clears a draft indicated only by the current flag', async () => {
  const world = await boot({ title: 'x', draft: true })

  expect(await update(world, 'ready')).toEqual({ number: 5, updated: true, state: 'open' })
  expect(world.server.requests.find((request) => request.method === 'PUT')?.body).toEqual({ title: 'x' })
  expect(world.server.mergeRequests[0]?.draft).toBe(false)
  expectPutCount(world, 1)
})

test('draft on a draft indicated only by the current flag is a no-op', async () => {
  const world = await boot({ title: 'x', draft: true })

  expect(await update(world, 'draft')).toEqual({ number: 5, updated: false, state: 'draft' })
  expectPutCount(world, 0)
})

test('draft on an MR indicated only by work_in_progress is a no-op', async () => {
  const world = await boot({ title: 'x', work_in_progress: true }, ['draft'])

  expect(await update(world, 'draft')).toEqual({ number: 5, updated: false, state: 'draft' })
  expectPutCount(world, 0)
})

test('ready is confirmed by clearing work_in_progress without a draft key', async () => {
  const world = await boot({ title: 'x', work_in_progress: true }, ['draft'])
  world.server.failures.set(`PUT ${reviewPath(world)}`, {
    status: 200,
    body: mr({ title: 'x', work_in_progress: false }, ['draft'])
  })

  expect(await update(world, 'ready')).toEqual({ number: 5, updated: true, state: 'open' })
  expectPutCount(world, 1)
})

test.failing('ready stays unknown when work_in_progress remains true', async () => {
  const world = await boot({ title: 'x', work_in_progress: true }, ['draft'])

  await expectUnknownCompletion(update(world, 'ready'))
  expect(world.server.mergeRequests[0]).toMatchObject({ title: 'x', draft: false, work_in_progress: true })
  expectPutCount(world, 1)
  expectReadbackCount(world, 1)
})

test('draft on a prefix-only draft is a no-op', async () => {
  const world = await boot({ title: 'Draft: x' }, ['draft'])

  expect(await update(world, 'draft')).toEqual({ number: 5, updated: false, state: 'draft' })
  expectPutCount(world, 0)
})

test('ready clears a prefix-only draft', async () => {
  const world = await boot({ title: 'Draft: x' }, ['draft'])

  expect(await update(world, 'ready')).toEqual({ number: 5, updated: true, state: 'open' })
  expect(world.server.requests.find((request) => request.method === 'PUT')?.body).toEqual({ title: 'x' })
  expectPutCount(world, 1)
})

test('ready on an unprefixed MR with no draft flag is a no-op', async () => {
  const world = await boot({ title: 'x' }, ['draft'])

  expect(await update(world, 'ready')).toEqual({ number: 5, updated: false, state: 'open' })
  expectPutCount(world, 0)
})

test.failing('ready with a conflicting legacy draft signal stays unknown', async () => {
  const world = await boot({ title: 'x', draft: false, work_in_progress: true })

  await expectUnknownCompletion(update(world, 'ready'))
  expect(world.server.requests.find((request) => request.method === 'PUT')?.body).toEqual({ title: 'x' })
  expect(world.server.mergeRequests[0]).toMatchObject({ draft: false, work_in_progress: true })
  expectPutCount(world, 1)
  expectReadbackCount(world, 1)
})

test('draft on a prefix-conflicting MR is a no-op with draft state', async () => {
  const world = await boot({ title: 'Draft: x', draft: false })

  expect(await update(world, 'draft')).toEqual({ number: 5, updated: false, state: 'draft' })
  expectPutCount(world, 0)
})

test.failing('ready rejects a reply with a true legacy draft signal', async () => {
  const world = await boot({ title: 'Draft: x', draft: true })
  world.server.failures.set(`PUT ${reviewPath(world)}`, {
    status: 200,
    body: mr({ title: 'x', draft: false, work_in_progress: true })
  })

  await expectUnknownCompletion(update(world, 'ready'))
  expectPutCount(world, 1)
  expectReadbackCount(world, 1)
})

test.failing('ready rejects a reply whose title still has a draft prefix', async () => {
  const world = await boot({ title: 'Draft: x', draft: true })
  world.server.failures.set(`PUT ${reviewPath(world)}`, {
    status: 200,
    body: mr({ title: 'Draft: x', draft: false })
  })

  await expectUnknownCompletion(update(world, 'ready'))
  expectPutCount(world, 1)
  expectReadbackCount(world, 1)
})

async function expectUnconfirmedWriteInvalidatesCache(
  action: Action,
  failure: { status: number; body?: unknown },
  overrides: Record<string, unknown>
): Promise<void> {
  const world = await boot()
  const head = runGit(world, ['rev-parse', 'HEAD'])
  world.server.mergeRequests = [mrAtHead(head, overrides)]
  const events = await listenForEvents(world)
  await world.call('forBranch')
  expect((await cachedReviews(world))[0]).toMatchObject({ review: { number: 5 }, stale: false })
  const changedBefore = changedEvents(events).length

  world.server.failures.set(`PUT ${reviewPath(world)}`, failure)
  await expectUnknownCompletion(update(world, action))
  expectPutCount(world, 1)
  expectReadbackCount(world, 1)
  expect(changedEvents(events).length - changedBefore).toBe(1)

  const requestCount = world.server.requests.length
  expect((await cachedReviews(world))[0]).toMatchObject({ review: null, stale: true })
  expect(world.server.requests).toHaveLength(requestCount)
}

test.failing('unchanged ready reply emits changed and invalidates a fresh cache', async () => {
  await expectUnconfirmedWriteInvalidatesCache('ready', { status: 200, body: mr({ title: 'Draft: x', draft: true }) }, { title: 'Draft: x', draft: true })
})

test.failing('invalid ready reply emits changed and invalidates a fresh cache', async () => {
  await expectUnconfirmedWriteInvalidatesCache('ready', { status: 200, body: { iid: 5, id: 5, project_id: 42 } }, { title: 'Draft: x', draft: true })
})

test.failing('non-object close reply emits changed and invalidates a fresh cache', async () => {
  await expectUnconfirmedWriteInvalidatesCache('close', { status: 200, body: 'ok' }, { title: 'Open work', draft: false })
})

test('ordinary ready on an open draft confirms an open result', async () => {
  const world = await boot({ title: 'Draft: x', draft: true })

  expect(await update(world, 'ready')).toEqual({ number: 5, updated: true, state: 'open' })
  expectPutCount(world, 1)
})

test('GitLab direct and queued merge remain refused before any stand-in request', async () => {
  const world = await boot()
  for (const action of ['direct', 'queue'] as const) {
    await expect(world.call('merge', {
      number: 5,
      expectedHead: 'a'.repeat(40),
      method: 'squash',
      action,
      yes: true
    })).rejects.toMatchObject(reason('unsupported_provider'))
  }

  expectPutCount(world, 0)
  expect(world.server.requests).toEqual([])
})

test('a non-2xx PUT keeps its server error and does not read back', async () => {
  const world = await boot({ title: 'Open work', draft: false })
  world.server.failures.set(`PUT ${reviewPath(world)}`, { status: 500 })

  await expect(update(world, 'close')).rejects.toMatchObject(reason('server_error'))
  expectPutCount(world, 1)
  expectReadbackCount(world, 0)
})
