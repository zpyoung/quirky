import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { bootTasks, type TasksTest as HostingTest } from './helpers'
import { issueFixtureRecord, issueFixtureSource, seedIssueFixture } from './fixtures/issue'
import { Markdown, safeHttpUrl } from '../src/issue/Markdown'

type RecordValue = Record<string, unknown>
const hosts: HostingTest[] = []
afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.cleanup()
})

function object(value: unknown): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected an object result')
  return value as RecordValue
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
function seedIssue(host: HostingTest, number = 22): void {
  host.writeState(seedIssueFixture(host.readState(), { number }))
}
async function openIssue(host: HostingTest, number = 22): Promise<void> {
  await host.call('navigate', {
    mode: 'issues',
    repoIds: [host.repoId],
    detail: {
      worktree: host.worktree,
      kind: 'issue',
      number,
      url: `https://github.com/test-owner/test-repo/issues/${number}`,
      host: 'github.com',
      owner: 'test-owner',
      repo: 'test-repo'
    },
    newIssue: false,
    project: null
  })
}
async function secondRepo(host: HostingTest): Promise<string> {
  const path = join(host.root, 'second-repo')
  mkdirSync(path, { recursive: true })
  execFileSync('git', ['-C', path, 'init', '--initial-branch=main'], { stdio: 'ignore' })
  execFileSync('git', ['-C', path, 'config', 'user.name', 'Issue Fixture'], { stdio: 'ignore' })
  execFileSync('git', ['-C', path, 'config', 'user.email', 'issue-fixture@example.test'], { stdio: 'ignore' })
  execFileSync('git', ['-C', path, 'commit', '--allow-empty', '-m', 'initial'], { stdio: 'ignore' })
  execFileSync('git', ['-C', path, 'remote', 'add', 'origin', 'https://github.com/second-owner/second-repo.git'], { stdio: 'ignore' })
  const repository = object(await host.client.callAny('quirky.repo/add', { path }))
  if (typeof repository.id !== 'string') throw new Error('second repository registration returned no ID')
  return repository.id
}

test('issue detail reads bounded activity and issue edits reconcile provider field, body, and status state', async () => {
  const host = await bootTasks(issueFixtureSource)
  hosts.push(host)
  seedIssue(host)
  await openIssue(host)

  const detail = object(await host.call('issue'))
  expect(object(detail.item)).toMatchObject({ kind: 'issue', number: 22, title: 'reported', body: 'original body', labels: ['bug'], assignees: ['alice'] })
  expect(detail.viewerCanUpdate).toBe(true)
  expect(array(detail.timeline)).toHaveLength(1)
  expect(array(detail.partialFailures)).toEqual([])

  const edited = object(await host.call('issueEdit', {
    title: 'triaged',
    body: 'confirmed body',
    state: 'closed',
    stateReason: 'not_planned',
    labels: ['bug', 'triage'],
    assignees: ['maintainer']
  }))
  expect(object(edited.item)).toMatchObject({ title: 'triaged', body: 'confirmed body', state: 'closed', labels: ['bug', 'triage'], assignees: ['maintainer'] })
  expect(issueFixtureRecord(host.readState(), 'test-owner', 'test-repo', 22)).toMatchObject({ title: 'triaged', body: 'confirmed body', state: 'closed', state_reason: 'not planned' })
}, 30_000)

test('issue edit exposes partial completion without claiming later body writes succeeded', async () => {
  const host = await bootTasks(issueFixtureSource)
  hosts.push(host)
  seedIssue(host)
  await openIssue(host)
  const state = object(host.readState())
  host.writeState({ ...state, responses: [{ when: 'PATCH repos/test-owner/test-repo/issues/22', method: 'PATCH', error: 'HTTP 500: body update failed' }] })

  let failure: unknown
  try {
    await host.call('issueEdit', { state: 'closed', title: 'must not persist' })
  } catch (error: unknown) {
    failure = error
  }
  expect(failure).toBeDefined()
  expect(object(object(failure).data)).toMatchObject({ partial: true, completedSteps: ['state'] })
  expect(issueFixtureRecord(host.readState(), 'test-owner', 'test-repo', 22)).toMatchObject({ title: 'reported', body: 'original body', state: 'closed' })
}, 30_000)

test('issue comments are confirmed once, visible after detail refresh, and failed comments do not enter the timeline', async () => {
  const host = await bootTasks(issueFixtureSource)
  hosts.push(host)
  seedIssue(host)
  await openIssue(host)

  const posted = await host.cli(['--json', 'tasks', 'issue-comment', '--worktree', host.worktree, '--number', '22', '--body', 'hello **team**'])
  expect(posted).toMatchObject({ code: 0, stderr: '' })
  expect(object(JSON.parse(posted.stdout))).toMatchObject({ comment: { issueNumber: 22, body: 'hello **team**', author: 'issue-fixture' } })
  const refreshed = object(await host.call('issue'))
  expect(array(refreshed.comments).map((value) => object(value).body)).toEqual(['hello **team**'])

  const state = object(host.readState())
  host.writeState({ ...state, responses: [{ when: 'POST repos/test-owner/test-repo/issues/22/comments', method: 'POST', error: 'HTTP 500: comment unavailable' }] })
  await expect(host.call('issueComment', { body: 'must remain in composer' })).rejects.toThrow()
  const afterFailure = object(await host.call('issue', { refresh: true }))
  expect(array(afterFailure.comments).map((value) => object(value).body)).toEqual(['hello **team**'])
  const timeline = array(afterFailure.timeline).map(object)
  expect(timeline).toHaveLength(1)
  expect(timeline.map((value) => value.body)).not.toContain('must remain in composer')
  const commentStore = object(object(host.readState()).resources)
  expect(array(object(commentStore.comments)['test-owner/test-repo/22'])).toHaveLength(1)
}, 30_000)

test('repo-scoped issue draft resets labels and assignees when changed, then CLI creation opens one real issue', async () => {
  const host = await bootTasks(issueFixtureSource)
  hosts.push(host)
  const otherRepoId = await secondRepo(host)
  await host.call('navigate', { mode: 'issues', repoIds: [host.repoId, otherRepoId] })
  const choices = object(await host.call('issueChoices', { kind: 'repositories' }))
  expect(array(choices.repositories).map((value) => object(value).id)).toEqual([host.repoId, otherRepoId])

  await host.call('draft', { title: 'Repair parser', body: 'details', repoId: host.repoId, labels: ['bug'], assignees: ['alice'] })
  const switched = object(await host.call('draft', { repoId: otherRepoId }))
  expect(object(switched.draft)).toMatchObject({ title: 'Repair parser', body: 'details', repoId: otherRepoId, labels: [], assignees: [] })
  await host.call('draft', { title: 'Fix parser', body: 'reproduced', labels: ['triage'], assignees: ['bob'] })

  const created = await host.cli(['--json', 'tasks', 'create-issue'])
  expect(created).toMatchObject({ code: 0, stderr: '' })
  expect(object(JSON.parse(created.stdout))).toMatchObject({ item: { kind: 'issue', number: 101, title: 'Fix parser', body: 'reproduced', url: 'https://github.com/second-owner/second-repo/issues/101' } })
  const current = object(await host.call('state'))
  const readback = object(await host.call('issue', { target: object(object(current.navigation).detail) }))
  expect(object(readback.item)).toMatchObject({ kind: 'issue', number: 101, title: 'Fix parser', body: 'reproduced', url: 'https://github.com/second-owner/second-repo/issues/101', labels: ['triage'], assignees: ['bob'] })
  expect(object(current.issueDraft)).toMatchObject({ title: '', body: '', labels: [], assignees: [], repoId: null })
  expect(object(current.navigation).detail).toMatchObject({ kind: 'issue', number: 101, url: 'https://github.com/second-owner/second-repo/issues/101' })
  const calls = array(object(host.readState()).calls).map(object)
  expect(calls.filter((call) => call.method === 'POST' && call.endpoint === 'repos/second-owner/second-repo/issues')).toHaveLength(1)
}, 30_000)

test('body-save warning clears the title but keeps the session body and opens the created issue', async () => {
  const host = await bootTasks(issueFixtureSource)
  hosts.push(host)
  await host.call('draft', { title: 'Large issue', body: 'retain this description', repoId: host.repoId })
  const fixture = object(host.readState())
  host.writeState({ ...fixture, responses: [
    { when: 'POST repos/test-owner/test-repo/issues', method: 'POST', nth: 1, error: 'HTTP 422: body is too long' },
    { when: 'PATCH repos/test-owner/test-repo/issues/101', method: 'PATCH', error: 'HTTP 500: body save failed' }
  ] })

  const result = object(await host.call('createIssue'))
  expect(result).toMatchObject({ partial: true, bodySaveWarning: expect.any(String), item: { kind: 'issue', number: 101, title: 'Large issue' } })
  const current = object(await host.call('state'))
  expect(object(current.issueDraft)).toMatchObject({ title: '', body: 'retain this description', labels: [], assignees: [], repoId: host.repoId })
  expect(object(current.navigation).detail).toMatchObject({ kind: 'issue', number: 101 })
  expect(issueFixtureRecord(host.readState(), 'test-owner', 'test-repo', 101)).toMatchObject({ title: 'Large issue', body: '' })
}, 30_000)

test('Markdown rendering leaves raw HTML inert and rejects javascript and data links and images', () => {
  const markup = renderToStaticMarkup(createElement(Markdown, {
    source: '<script>alert(1)</script> [unsafe](javascript:alert(1)) [pixel](data:image/png;base64,AA) ![bad](javascript:alert(1)) [safe](https://github.com/example/repo/issues/1)'
  }))
  expect(markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  expect(markup).not.toContain('href="javascript:')
  expect(markup).not.toContain('href="data:')
  expect(markup).not.toContain('src="javascript:')
  expect(markup).toContain('href="https://github.com/example/repo/issues/1"')
})

test('issue source choices preserve upstream as the default and update through the public hosting configuration', async () => {
  const host = await bootTasks(issueFixtureSource)
  hosts.push(host)
  execFileSync('git', ['-C', join(host.root, 'repo'), 'remote', 'add', 'upstream', 'https://github.com/up-owner/up-repo.git'], { stdio: 'ignore' })

  const initial = object(await host.call('issueChoices', { kind: 'source' }))
  expect(initial).toMatchObject({ available: true, repoId: host.repoId, source: 'upstream' })
  expect(array(initial.sources)).toHaveLength(2)
  await host.call('issueSource', { repoId: host.repoId, source: 'origin' })
  expect(object(await host.call('issueChoices', { kind: 'source' })).source).toBe('origin')
}, 30_000)

test('image URL insertion permits HTTP(S) URLs only and enforces the 8 KiB byte limit', () => {
  expect(safeHttpUrl('https://example.com/image.png', 8192)).toBe('https://example.com/image.png')
  expect(safeHttpUrl('javascript:alert(1)', 8192)).toBeNull()
  expect(safeHttpUrl('data:image/png;base64,AA', 8192)).toBeNull()
  expect(safeHttpUrl(`https://example.com/${'a'.repeat(8192)}`, 8192)).toBeNull()
})

test('concurrent label replacements serialize through confirmed issue state', async () => {
  const host = await bootTasks(issueFixtureSource)
  hosts.push(host)
  seedIssue(host)
  await openIssue(host)

  const results = await Promise.all([
    host.call('issueEdit', { labels: ['first'] }),
    host.call('issueEdit', { labels: ['second'] })
  ])
  expect(object(object(results[0]).item).labels).toEqual(['first'])
  expect(object(object(results[1]).item).labels).toEqual(['second'])
  expect(issueFixtureRecord(host.readState(), 'test-owner', 'test-repo', 22).labels).toEqual([{ name: 'second' }])
}, 30_000)

test('explicit issue refresh bypasses cached public detail while normal reads retain it', async () => {
  const host = await bootTasks(issueFixtureSource)
  hosts.push(host)
  seedIssue(host)
  await openIssue(host)
  const initial = object(await host.call('issue'))
  expect(object(initial.item).title).toBe('reported')

  host.writeState(seedIssueFixture(host.readState(), { title: 'refreshed title', body: 'refreshed body' }))
  expect(object(object(await host.call('issue')).item)).toMatchObject({ title: 'reported', body: 'original body' })
  const refreshed = object(await host.call('issue', { refresh: true }))
  expect(object(refreshed.item)).toMatchObject({ title: 'refreshed title', body: 'refreshed body' })
}, 30_000)

test('explicit worktree and issue number override an active Project item with the same issue number', async () => {
  const host = await bootTasks(issueFixtureSource)
  hosts.push(host)
  seedIssue(host, 22)
  const otherRepoId = await secondRepo(host)
  host.writeState(seedIssueFixture(host.readState(), {
    owner: 'second-owner',
    repo: 'second-repo',
    number: 22,
    title: 'second repository issue',
    body: 'different source'
  }))
  const worktrees = array(await host.client.callAny('quirky.worktree/list', { repo: otherRepoId })).map(object)
  const otherWorktree = worktrees.find((worktree) => worktree.path === join(host.root, 'second-repo'))
  if (typeof otherWorktree?.id !== 'string') throw new Error('second worktree registration returned no ID')

  await host.call('navigate', {
    mode: 'projects',
    repoIds: [host.repoId],
    project: { id: 'PROJECT_1', owner: 'test-owner', ownerType: 'organization', number: 1, url: 'https://github.com/orgs/test-owner/projects/1', host: 'github.com' },
    detail: {
      worktree: host.worktree,
      kind: 'issue',
      number: 22,
      url: 'https://github.com/test-owner/test-repo/issues/22',
      projectId: 'PROJECT_1',
      itemId: 'PROJECT_ITEM_22',
      host: 'github.com',
      owner: 'test-owner',
      repo: 'test-repo'
    }
  })

  await expect(host.call('issue', { worktree: otherWorktree.id })).rejects.toThrow('positive issue number')
  const detail = object(await host.call('issue', { worktree: otherWorktree.id, number: 22 }))
  expect(detail.source).toBe('repository')
  expect(object(detail.item)).toMatchObject({ number: 22, title: 'second repository issue', body: 'different source' })
}, 30_000)
