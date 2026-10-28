import { afterEach, expect, test } from 'bun:test'
import { bootHosting, type HostingTest } from './helpers'
import { conversationFixture } from './review-conversation-fixture'

const hosts: HostingTest[] = []
afterEach(async () => { for (const host of hosts.splice(0).reverse()) await host.cleanup() })

async function boot(): Promise<HostingTest> {
  const host = await bootHosting(conversationFixture)
  hosts.push(host)
  host.writeState({ comments: [], assignees: ['alex'] })
  return host
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected object')
  return value as Record<string, unknown>
}

test('PR conversation adds and edits the selected PR, preserves text, and confirms delete', async () => {
  const h = await boot()
  const added = object(await h.call('reviewConversation', { number: 7, action: 'add', body: 'hello **team** — 你好' }))
  expect(added).toMatchObject({ number: 7, action: 'add', comment: { id: 101, body: 'hello **team** — 你好' } })
  await h.call('reviewConversation', { number: 7, action: 'edit', commentId: 101, body: 'changed' })
  expect(object(h.readState()).comments).toMatchObject([{ id: 101, body: 'changed' }])
  await expect(h.call('reviewConversation', { number: 7, action: 'delete', commentId: 101 })).rejects.toMatchObject({ code: -32009 })
  expect(object(h.readState()).comments).toMatchObject([{ id: 101 }])
  await h.call('reviewConversation', { number: 7, action: 'delete', commentId: 101, yes: true })
  expect(object(h.readState()).comments).toEqual([])
}, 20_000)

test('PR conversation rejects comment IDs belonging to another PR before any write', async () => {
  const h = await boot()
  h.writeState({ comments: [{ id: 91, body: 'foreign', issue_url: 'https://api.github.com/repos/test-owner/test-repo/issues/8' }], assignees: [] })
  await expect(h.call('reviewConversation', { number: 7, action: 'edit', commentId: 91, body: 'wrong target' })).rejects.toMatchObject({ data: { reason: 'comment_mismatch' } })
  await expect(h.call('reviewConversation', { number: 7, action: 'delete', commentId: 91, yes: true })).rejects.toMatchObject({ data: { reason: 'comment_mismatch' } })
  expect(object(h.readState()).comments).toMatchObject([{ id: 91, body: 'foreign' }])
}, 20_000)

test('PR assignees replace, add, remove and clear without confirmation', async () => {
  const h = await boot()
  await h.call('reviewAssignees', { number: 7, action: 'set', logins: ['jo', 'pat'] })
  expect(object(h.readState()).assignees).toEqual(['jo', 'pat'])
  await h.call('reviewAssignees', { number: 7, action: 'add', logins: ['sam'] })
  expect(object(h.readState()).assignees).toEqual(['jo', 'pat', 'sam'])
  await h.call('reviewAssignees', { number: 7, action: 'remove', logins: ['jo'] })
  expect(object(h.readState()).assignees).toEqual(['pat', 'sam'])
  await h.call('reviewAssignees', { number: 7, action: 'set', logins: [] })
  expect(object(h.readState()).assignees).toEqual([])
}, 20_000)

test('invalid conversation and assignee inputs never reach provider writes', async () => {
  const h = await boot()
  await expect(h.call('reviewConversation', { number: 7, action: 'add', body: ' ' })).rejects.toMatchObject({ data: { reason: 'invalid_body' } })
  await expect(h.call('reviewConversation', { number: 7, action: 'add', body: '好'.repeat(22_000) })).rejects.toMatchObject({ data: { reason: 'invalid_body' } })
  await expect(h.call('reviewAssignees', { number: 7, action: 'add', logins: ['--help'] })).rejects.toMatchObject({ data: { reason: 'invalid_logins' } })
  expect(object(h.readState())).toEqual({ comments: [], assignees: ['alex'] })
}, 20_000)

test('provider refusal preserves prior conversation and assignees without fabricated success', async () => {
  const h = await boot()
  h.writeState({ comments: [], assignees: ['alex'], failWrite: true })
  await expect(h.call('reviewConversation', { number: 7, action: 'add', body: 'hello' })).rejects.toMatchObject({ data: { reason: 'permission_denied' } })
  await expect(h.call('reviewAssignees', { number: 7, action: 'set', logins: ['jo'] })).rejects.toMatchObject({ data: { reason: 'permission_denied' } })
  expect(object(h.readState())).toEqual({ comments: [], assignees: ['alex'], failWrite: true })
}, 20_000)

test('PR mutation preserves explicit origin selection with an upstream and rejects unconfigured sources', async () => {
  const h = await bootHosting(conversationFixture, { upstream: 'https://github.com/base-owner/base-repo.git' })
  hosts.push(h)
  h.writeState({ comments: [], assignees: [] })
  const prRepo = { host: 'github.com', owner: 'test-owner', repo: 'test-repo' }
  const added = await h.call('reviewConversation', { number: 7, prRepo, action: 'add', body: 'origin only' })
  expect(added).toMatchObject({ number: 7, comment: { body: 'origin only', url: 'https://github.com/test-owner/test-repo/pull/7#issuecomment-101' } })
  await h.call('reviewAssignees', { number: 7, prRepo, action: 'set', logins: ['jo'] })
  const wrong = { host: 'github.com', owner: 'unconfigured', repo: 'wrong' }
  await expect(h.call('reviewConversation', { number: 7, prRepo: wrong, action: 'add', body: 'must not send' })).rejects.toMatchObject({ data: { reason: 'repository_mismatch' } })
  await expect(h.call('reviewAssignees', { number: 7, prRepo: wrong, action: 'set', logins: ['sam'] })).rejects.toMatchObject({ data: { reason: 'repository_mismatch' } })
  expect(object(h.readState())).toMatchObject({ comments: [{ body: 'origin only' }], assignees: ['jo'] })
}, 20_000)
