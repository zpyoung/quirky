import { afterEach, expect, test } from 'bun:test'
import { bootGitLab, type GitLabWorld } from './world'
import { mergeRequest } from './stand-in'

const worlds: GitLabWorld[] = []
afterEach(async () => { for (const world of worlds.splice(0).reverse()) await world.cleanup() })

const head = 'a'.repeat(40)
const base = 'b'.repeat(40)
const start = 'c'.repeat(40)
const discussionPath = '/api/v4/projects/group%2Fsub%2Fproj/merge_requests/5/discussions'
const mrPath = '/api/v4/projects/group%2Fsub%2Fproj/merge_requests/5'
const createdAt = '2024-01-01T00:00:00.000Z'

async function boot(discussions: Record<string, any>[] = []): Promise<GitLabWorld> {
  const world = await bootGitLab()
  worlds.push(world)
  world.server.mergeRequests = [mergeRequest({
    sha: head,
    diff_refs: { base_sha: base, start_sha: start, head_sha: head }
  })]
  world.server.discussions = discussions
  return world
}

function note(id: number, body: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    body,
    author: { username: 'fixture-user' },
    created_at: createdAt,
    system: false,
    ...overrides
  }
}

function discussion(id: string, notes: unknown[], overrides: Record<string, unknown> = {}) {
  return { id, individual_note: false, notes, ...overrides }
}

function reason(reason: string) { return { data: { reason } } }
function requests(world: GitLabWorld, method: string, path: string) {
  return world.server.requests.filter((request) => request.method === method && request.path === path)
}

async function observeEvents(world: GitLabWorld): Promise<unknown[]> {
  const events: unknown[] = []
  world.client.onEvent((event) => events.push(event))
  await world.client.callAny('events.subscribe', {})
  return events
}

function changedEventCount(events: unknown[]): number {
  return events.filter((event) => event && typeof event === 'object' && 'type' in event && event.type === 'quirky.hosting/changed').length
}

const initialDiscussions = () => [
  discussion('d1', [note(101, 'hello')], { individual_note: true }),
  discussion('a'.repeat(40), [
    note(201, 'please fix', { position: { new_path: 'src/a.ts', new_line: 10 }, resolvable: true, resolved: false }),
    note(202, 'on it')
  ]),
  discussion('system-301', [note(301, 'system event', { system: true })], { individual_note: true }),
  discussion('b'.repeat(40), [note(401, 'resolved', { resolvable: true, resolved: true })])
]

test('comments map individual and review notes, omit system notes, and cache for sixty seconds', async () => {
  const world = await boot(initialDiscussions())
  const first = await world.call('comments', { number: 5 }) as Record<string, any>
  expect(first).toMatchObject({ number: 5, partial: false, partialFailures: [], comments: [
    { kind: 'issue_comment', id: 101, author: 'fixture-user', url: `${world.server.url}/group/sub/proj/-/merge_requests/5#note_101`, isBot: null, body: 'hello', createdAt, state: null, path: null, line: null, startLine: null, threadId: null, isResolved: null, isOutdated: null, reactionSubjectId: null, reactions: [] },
    { kind: 'review_comment', id: 201, author: 'fixture-user', body: 'please fix', path: 'src/a.ts', line: 10, threadId: 'a'.repeat(40), isResolved: false, isOutdated: false },
    { kind: 'review_comment', id: 202, author: 'fixture-user', body: 'on it', path: 'src/a.ts', line: 10, threadId: 'a'.repeat(40), isResolved: false, isOutdated: false },
    { kind: 'review_comment', id: 401, body: 'resolved', path: null, line: null, threadId: 'b'.repeat(40), isResolved: true }
  ] })
  expect(first.comments.map((comment: Record<string, unknown>) => comment.id)).toEqual([101, 201, 202, 401])
  const discussionGets = requests(world, 'GET', discussionPath)
  expect(discussionGets).toHaveLength(1)

  world.server.discussions = []
  expect(await world.call('comments', { number: 5 })).toEqual(first)
  expect(requests(world, 'GET', discussionPath)).toHaveLength(1)
  const uncached = await world.call('comments', { number: 5, noCache: true }) as Record<string, any>
  expect(uncached.comments).toEqual([])
  expect(requests(world, 'GET', discussionPath)).toHaveLength(2)
})

test('comments follow discussion pages and cap at five hundred with a partial marker', async () => {
  const world = await boot()
  world.server.discussions = Array.from({ length: 150 }, (_, index) => discussion(`page-${index}`, [note(index + 1, `note-${index}`)], { individual_note: true, resolvable: false }))
  const all = await world.call('comments', { number: 5, noCache: true }) as Record<string, any>
  expect(all).toMatchObject({ partial: false, partialFailures: [] })
  expect(all.comments).toHaveLength(150)
  expect(requests(world, 'GET', discussionPath)).toHaveLength(2)

  world.server.requests.length = 0
  world.server.discussions = Array.from({ length: 600 }, (_, index) => discussion(`cap-${index}`, [note(index + 1, `note-${index}`)], { individual_note: true, resolvable: false }))
  const capped = await world.call('comments', { number: 5, noCache: true }) as Record<string, any>
  expect(capped).toMatchObject({ partial: true, partialFailures: ['discussions_truncated'] })
  expect(capped.comments).toHaveLength(500)
  expect(requests(world, 'GET', discussionPath)).toHaveLength(5)
})

test('inline comments use fresh diff refs, accept one line, and publish changed', async () => {
  const world = await boot()
  const events = await observeEvents(world)
  const result = await world.call('reviewComment', { number: 5, action: 'inline', headSha: head, path: 'src/a.ts', line: 12, body: 'nit' })
  expect(result).toMatchObject({ number: 5, action: 'inline', comment: { path: 'src/a.ts', line: 12, startLine: null, body: 'nit' } })
  const post = requests(world, 'POST', discussionPath)
  expect(post).toHaveLength(1)
  expect(post[0].body).toEqual({ body: 'nit', position: { position_type: 'text', base_sha: base, start_sha: start, head_sha: head, old_path: 'src/a.ts', new_path: 'src/a.ts', new_line: 12 } })
  expect(requests(world, 'GET', mrPath)).toHaveLength(1)

  const sameLine = await world.call('reviewComment', { number: 5, action: 'inline', headSha: head, path: 'src/a.ts', startLine: 12, line: 12, body: 'same line' })
  expect(sameLine).toMatchObject({ action: 'inline', comment: { path: 'src/a.ts', line: 12, startLine: null, body: 'same line' } })
  expect(requests(world, 'POST', discussionPath)).toHaveLength(2)
  expect(changedEventCount(events)).toBe(2)
})

test('inline comments reject stale heads, ranges, malformed inputs, and provider-invalid coordinates safely', async () => {
  const world = await boot()
  await expect(world.call('reviewComment', { number: 5, action: 'inline', headSha: 'd'.repeat(40), path: 'src/a.ts', line: 12, body: 'stale' })).rejects.toMatchObject(reason('stale_head'))
  expect(requests(world, 'POST', discussionPath)).toHaveLength(0)
  await expect(world.call('reviewComment', { number: 5, action: 'inline', headSha: head, path: 'src/a.ts', startLine: 10, line: 12, body: 'range' })).rejects.toMatchObject({ message: 'GitLab range comments are not supported yet; comment on one line.', data: { reason: 'unsupported_range' } })
  await expect(world.call('reviewComment', { number: 5, action: 'inline', headSha: head, path: 'src/a.ts', line: 12, body: '' })).rejects.toMatchObject(reason('invalid_input'))
  await expect(world.call('reviewComment', { number: 5, action: 'inline', headSha: head, path: '../secret', line: 12, body: 'bad path' })).rejects.toMatchObject(reason('invalid_input'))
  await expect(world.call('reviewComment', { number: 5, action: 'inline', headSha: head, path: '/absolute', line: 12, body: 'bad path' })).rejects.toMatchObject(reason('invalid_input'))
  await expect(world.call('reviewComment', { number: 5, action: 'inline', headSha: head, path: 'src/\0a.ts', line: 12, body: 'bad path' })).rejects.toMatchObject(reason('invalid_input'))
  await expect(world.call('reviewComment', { number: 5, action: 'inline', headSha: head, path: 'src/a.ts', line: 12, body: 'x'.repeat(65_537) })).rejects.toMatchObject(reason('invalid_input'))
  expect(requests(world, 'POST', discussionPath)).toHaveLength(0)

  world.server.failures.set(`POST ${discussionPath}`, { status: 400, body: { message: 'line outside diff' } })
  await expect(world.call('reviewComment', { number: 5, action: 'inline', headSha: head, path: 'src/a.ts', line: 999, body: 'outside' })).rejects.toMatchObject(reason('invalid_coordinates'))
  expect(requests(world, 'POST', discussionPath)).toHaveLength(1)
})

test('inline comment requires a well-formed fresh merge request diff_refs response', async () => {
  const world = await boot()
  world.server.mergeRequests = [mergeRequest({ sha: head, diff_refs: { base_sha: base, start_sha: start, head_sha: null } })]
  const error = await world.call('reviewComment', { number: 5, action: 'inline', headSha: head, path: 'src/a.ts', line: 12, body: 'nit' }).then(() => null, (caught: unknown) => caught)
  expect(error).toMatchObject(reason('schema_drift'))
  expect(requests(world, 'POST', discussionPath)).toHaveLength(0)
})

test('malformed discussion response rows fail with schema_drift instead of raw shape errors', async () => {
  const world = await boot()
  world.server.discussions = [{ id: 'broken', individual_note: false, notes: 'not-an-array' }]
  await expect(world.call('comments', { number: 5, noCache: true })).rejects.toMatchObject(reason('schema_drift'))
})

test('reply targets must be on the selected merge request and use the discussion endpoint', async () => {
  const world = await boot(initialDiscussions())
  const events = await observeEvents(world)
  const threaded = await world.call('reviewComment', { number: 5, action: 'reply', replyToId: 201, body: 'done' })
  expect(threaded).toMatchObject({ action: 'reply', comment: { path: 'src/a.ts', line: 10, startLine: null, body: 'done' } })
  const threadPost = world.server.requests.find((request) => request.method === 'POST' && request.path === `${discussionPath}/${'a'.repeat(40)}/notes`)
  expect(threadPost?.body).toEqual({ body: 'done' })

  const individual = await world.call('reviewComment', { number: 5, action: 'reply', replyToId: 101, body: 'individual reply' })
  expect(individual).toMatchObject({ action: 'reply', comment: { path: null, line: null, startLine: null, body: 'individual reply' } })
  expect(world.server.requests.some((request) => request.method === 'POST' && request.path === `${discussionPath}/d1/notes`)).toBe(true)
  expect(changedEventCount(events)).toBe(2)

  const postsBeforeForeign = world.server.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/notes')).length
  await expect(world.call('reviewComment', { number: 5, action: 'reply', replyToId: 999, body: 'foreign' })).rejects.toMatchObject(reason('foreign_target'))
  expect(requests(world, 'POST', `${discussionPath}/999/notes`)).toHaveLength(0)
  expect(world.server.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/notes'))).toHaveLength(postsBeforeForeign)
  expect(changedEventCount(events)).toBe(2)
})

test('resolve and unresolve accept only GitLab discussion IDs and confirm the requested state', async () => {
  const world = await boot(initialDiscussions())
  const events = await observeEvents(world)
  const id = 'a'.repeat(40)
  expect(await world.call('resolveThread', { number: 5, threadId: id, action: 'resolve' })).toEqual({ threadId: id, action: 'resolve', resolved: true })
  const resolved = requests(world, 'PUT', `${discussionPath}/${id}`)[0]
  expect(resolved.query).toEqual({ resolved: 'true' })
  expect(await world.call('resolveThread', { number: 5, threadId: id, action: 'unresolve' })).toEqual({ threadId: id, action: 'unresolve', resolved: false })
  expect(requests(world, 'PUT', `${discussionPath}/${id}`)[1].query).toEqual({ resolved: 'false' })
  expect(changedEventCount(events)).toBe(2)
  await expect(world.call('resolveThread', { number: 5, threadId: 'THREAD', action: 'resolve' })).rejects.toMatchObject(reason('invalid_input'))
  expect(requests(world, 'PUT', `${discussionPath}/THREAD`)).toHaveLength(0)

  world.server.failures.set(`PUT ${discussionPath}/${id}`, { status: 404, body: { message: 'missing' } })
  await expect(world.call('resolveThread', { number: 5, threadId: id, action: 'resolve' })).rejects.toMatchObject(reason('not_found'))
  expect(changedEventCount(events)).toBe(2)
})

test('top-level conversation adds and edits notes, while delete and confirmation are refused', async () => {
  const world = await boot(initialDiscussions())
  const events = await observeEvents(world)
  const added = await world.call('reviewConversation', { number: 5, action: 'add', body: 'lgtm' })
  const addedId = (added as { comment: { id: number } }).comment.id
  expect(added).toMatchObject({ number: 5, action: 'add', comment: { id: expect.any(Number), kind: 'issue_comment', body: 'lgtm', author: 'fixture-user', createdAt: expect.any(String), url: expect.stringContaining('#note_') } })
  expect(requests(world, 'POST', `${mrPath}/notes`).at(-1)?.body).toEqual({ body: 'lgtm' })
  const edited = await world.call('reviewConversation', { number: 5, action: 'edit', commentId: addedId, body: 'updated' })
  expect(edited).toMatchObject({ number: 5, action: 'edit', comment: { id: addedId, body: 'updated', kind: 'issue_comment' } })
  expect(world.server.requests.find((request) => request.method === 'PUT' && request.path === `${mrPath}/notes/${addedId}`)?.body).toEqual({ body: 'updated' })
  expect(changedEventCount(events)).toBe(2)

  const writesBeforeDelete = world.server.requests.filter((request) => request.method !== 'GET').length
  await expect(world.call('reviewConversation', { number: 5, action: 'delete', commentId: addedId })).rejects.toMatchObject(reason('unsupported_action'))
  await expect(world.call('reviewConversationConfirmation', { number: 5, action: 'delete', commentId: addedId })).rejects.toMatchObject(reason('unsupported_action'))
  expect(await world.call('reviewConversationConfirmation', { number: 5, action: 'add', body: 'x' })).toBeNull()
  expect(await world.call('reviewConversationConfirmation', { number: 5, action: 'edit', commentId: addedId, body: 'x' })).toBeNull()
  expect(world.server.requests.filter((request) => request.method !== 'GET')).toHaveLength(writesBeforeDelete)
  expect(changedEventCount(events)).toBe(2)
})

test('discussion result, errors, and changed events never include the GitLab token', async () => {
  const world = await boot()
  const events: unknown[] = []
  world.client.onEvent((event) => events.push(event))
  await world.client.callAny('events.subscribe', {})
  const result = await world.call('reviewConversation', { number: 5, action: 'add', body: 'safe' })
  const failure = await world.call('resolveThread', { number: 5, threadId: 'not-a-discussion-id', action: 'resolve' }).then(() => null, (caught: unknown) => caught)
  const output = JSON.stringify({ result, failure, events })
  expect(output).not.toContain('dummy-gitlab-token')
  expect(events.some((event) => event && typeof event === 'object' && 'type' in event && event.type === 'quirky.hosting/changed')).toBe(true)
})
