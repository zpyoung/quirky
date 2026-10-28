import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import type { QuirkyClient } from '@quirky/protocol'
import { bootWorkspace, bootWorkspaceWithAgent, workspaceItemUrl, type WorkspaceAgentFixture, type WorkspaceFixture } from './fixtures/workspace'

type RecordValue = Record<string, unknown>
const hosts: (WorkspaceFixture | WorkspaceAgentFixture)[] = []
afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.cleanup()
})

function record(value: unknown): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected an object')
  return value as RecordValue
}

function stringField(value: RecordValue, key: string): string {
  const field = value[key]
  if (typeof field !== 'string') throw new Error(`expected ${key} to be a string`)
  return field
}

function recordIfObject(value: unknown): RecordValue | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : null
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args], { env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

async function openComposer(host: WorkspaceFixture, kind: 'issue' | 'pullRequest', number: number, fields: RecordValue = {}): Promise<RecordValue> {
  const target = { worktree: host.worktree, kind, number, url: workspaceItemUrl(kind, number) }
  return record(await host.call('workspace', { target, action: 'start', newWorkspace: true, ...fields }))
}

async function submitComposer(host: WorkspaceFixture, request: RecordValue, kind: 'issue' | 'pullRequest', number: number, fields: RecordValue = {}): Promise<RecordValue> {
  const target = { worktree: host.worktree, kind, number, url: workspaceItemUrl(kind, number) }
  return record(await host.call('workspace', {
    target,
    action: 'start',
    newWorkspace: true,
    composerRequestId: stringField(request, 'requestId'),
    name: `workspace-${kind}-${number}`,
    prompt: `Work on ${kind} #${number}\n${target.url}`,
    setup: 'skip',
    issueCommand: 'skip',
    agent: '',
    ...fields
  }))
}

async function cliWorkspace(host: WorkspaceFixture, params: RecordValue): Promise<RecordValue> {
  const flags = ['--target', JSON.stringify(params.target), '--action', stringField(params, 'action')]
  if (params.newWorkspace === true) flags.push('--new-workspace')
  for (const key of ['setup', 'issueCommand', 'agent', 'name', 'prompt', 'composerRequestId']) {
    if (params[key] === undefined) continue
    flags.push(`--${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, stringField(params, key))
  }
  const result = await host.cli(['--json', 'tasks', 'workspace', ...flags])
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' })
  return record(JSON.parse(result.stdout))
}

async function listWorktrees(host: WorkspaceFixture): Promise<RecordValue[]> {
  const values = await host.client.callAny('quirky.worktree/list', { repo: host.repoId })
  if (!Array.isArray(values)) throw new Error('worktree list was not an array')
  return values.map(record)
}

async function sessionAfterReady(client: QuirkyClient, sessionId: string): Promise<RecordValue> {
  const { promise, resolve, reject } = Promise.withResolvers<RecordValue>()
  let settled = false
  let unsubscribe = () => {}
  const finish = (value: RecordValue | Error) => {
    if (settled) return
    settled = true
    unsubscribe()
    if (value instanceof Error) reject(value)
    else resolve(value)
  }
  const read = async () => {
    try {
      const session = record(await client.callAny('quirky.session/get', { session: sessionId }))
      if (session.promptDelivery === 'pasted') finish(session)
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  }
  unsubscribe = client.onEvent((event) => {
    const raw = recordIfObject(event)
    const data = recordIfObject(raw?.data)
    const session = recordIfObject(data?.session)
    if (raw?.type === 'quirky.session/changed' && session?.id === sessionId) void read()
  })
  void read()
  return await promise
}
test('generated CLI and API create canonical issue and fork-PR workspaces without losing exact source links or checkout', async () => {
  const host = await bootWorkspace()
  hosts.push(host)
  const issueTarget = { worktree: host.worktree, kind: 'issue', number: 4, url: workspaceItemUrl('issue', 4) }
  const opened = await cliWorkspace(host, { target: issueTarget, action: 'start', newWorkspace: true, setup: 'skip' })
  expect(opened).toMatchObject({ kind: 'composer', target: issueTarget })
  const issue = await cliWorkspace(host, {
    target: issueTarget,
    action: 'start',
    newWorkspace: true,
    composerRequestId: opened.requestId,
    setup: 'skip',
    issueCommand: 'skip',
    agent: '',
    name: 'issue-from-cli',
    prompt: 'Issue context from CLI'
  })
  expect(issue).toMatchObject({ kind: 'created', target: issueTarget, worktree: { linkedIssue: { kind: 'issue', number: 4, url: issueTarget.url } }, issueCommand: { ran: 'none' } })
  const issueWorktree = record(issue.worktree)
  const issuePath = stringField(issueWorktree, 'path')
  expect(existsSync(`${issuePath}/README.md`)).toBe(true)
  const state = record(await host.call('state'))
  const links = record(state.links)
  expect(Object.values(links)).toContainEqual(expect.objectContaining({ url: issueTarget.url, worktree: issueWorktree.id }))

  const pullTarget = { worktree: host.worktree, kind: 'pullRequest', number: 3, url: workspaceItemUrl('pullRequest', 3) }
  const pullRequest = await openComposer(host, 'pullRequest', 3)
  expect(pullRequest.kind).toBe('composer')
  const pull = await submitComposer(host, pullRequest, 'pullRequest', 3)
  expect(pull).toMatchObject({ kind: 'created', target: pullTarget, worktree: { branch: 'fixture/pr-head', linkedPR: { kind: 'pullRequest', number: 3, url: pullTarget.url }, pushTarget: { remoteName: 'pr-fork-owner-fork-repo', branchName: 'fixture/pr-head' } } })
  const pullWorktree = record(pull.worktree)
  const pullPath = stringField(pullWorktree, 'path')
  const expectedHead = git(host.baseBare, 'rev-parse', 'refs/pull/3/head')
  expect(git(pullPath, 'rev-parse', 'HEAD')).toBe(expectedHead)
  expect(readFileSync(`${pullPath}/PR_HEAD.md`, 'utf8')).toBe('fork pull-request head\n')
  expect(Object.values(record(record(await host.call('state')).links))).toContainEqual(expect.objectContaining({ url: pullTarget.url, worktree: pullWorktree.id }))
  expect(await listWorktrees(host)).toHaveLength(3)
}, 60_000)

test('a missing canonical item fails without falling back to an unrelated plain workspace', async () => {
  const host = await bootWorkspace()
  hosts.push(host)
  const target = { worktree: host.worktree, kind: 'issue', number: 99, url: workspaceItemUrl('issue', 99) }
  await expect(host.call('workspace', { target, action: 'start', newWorkspace: true, setup: 'skip' })).rejects.toThrow()
  expect(await listWorktrees(host)).toHaveLength(1)
})

test('a cancelled composer cannot submit its old request or create a workspace', async () => {
  const host = await bootWorkspace()
  hosts.push(host)
  const request = await openComposer(host, 'issue', 4)
  expect(request.kind).toBe('composer')
  const cancelled = await host.call('workspaceComposerCancel', { requestId: request.requestId })
  expect(cancelled).toBeNull()
  await expect(submitComposer(host, request, 'issue', 4)).rejects.toThrow(/no longer active/)
  expect(await host.call('workspaceComposerState')).toBeNull()
  expect(await listWorktrees(host)).toHaveLength(1)
})

test('setup and issue-command skip decisions are independent across each other’s trust retry', async () => {
  const host = await bootWorkspace()
  hosts.push(host)
  host.setHooks({ setup: "printf 'setup-ran' > setup-marker.txt", issueCommand: "printf 'issue-ran' > issue-marker.txt" })
  const initial = await openComposer(host, 'issue', 4, { setup: 'run', issueCommand: 'run' })
  const setupPrompt = await submitComposer(host, initial, 'issue', 4, { setup: 'run', issueCommand: 'run' })
  expect(setupPrompt).toMatchObject({ kind: 'composer', trustKind: 'setup', trustScript: "printf 'setup-ran' > setup-marker.txt", trustHash: expect.stringMatching(/^[a-f0-9]{64}$/) })

  const issuePrompt = await submitComposer(host, setupPrompt, 'issue', 4, { setup: 'skip', issueCommand: 'run' })
  expect(issuePrompt).toMatchObject({ kind: 'composer', setup: 'skip', trustKind: 'issue', trustScript: "printf 'issue-ran' > issue-marker.txt", trustHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
  const created = await submitComposer(host, issuePrompt, 'issue', 4, { setup: 'skip', issueCommand: 'skip' })
  expect(created).toMatchObject({ kind: 'created', setup: { ran: 'skipped' }, issueCommand: { ran: 'skipped' } })
  const worktree = record(created.worktree)
  const path = stringField(worktree, 'path')
  expect(existsSync(`${path}/setup-marker.txt`)).toBe(false)
  expect(existsSync(`${path}/issue-marker.txt`)).toBe(false)
})

test('run-once approvals retain independent pins and changed scripts refuse before workspace or hook execution', async () => {
  const host = await bootWorkspace()
  hosts.push(host)
  const setupA = "printf 'setup-A' > setup-marker.txt"
  const setupB = "printf 'setup-B' > setup-marker.txt"
  const issueA = "printf 'issue-A' > issue-marker.txt"
  const issueB = "printf 'issue-B' > issue-marker.txt"
  host.setHooks({ setup: setupA, issueCommand: issueA })
  const initial = await openComposer(host, 'issue', 4, { setup: 'run', issueCommand: 'run' })
  const first = await submitComposer(host, initial, 'issue', 4, { setup: 'run', issueCommand: 'run' })
  expect(first).toMatchObject({ kind: 'composer', trustKind: 'setup', trustScript: setupA })
  const shownSetupA = stringField(first, 'trustHash')

  host.setHooks({ setup: setupB, issueCommand: issueA })
  const changedSetup = await submitComposer(host, first, 'issue', 4, { setup: 'run', issueCommand: 'run', trustSetup: true, trustSetupHash: shownSetupA })
  expect(changedSetup).toMatchObject({ kind: 'composer', trustKind: 'setup', trustScript: setupB, trustChanged: true })
  const shownSetupB = stringField(changedSetup, 'trustHash')
  expect(shownSetupB).not.toBe(shownSetupA)
  expect(await listWorktrees(host)).toHaveLength(1)
  expect(existsSync(`${host.repoPath}/setup-marker.txt`)).toBe(false)
  expect(existsSync(`${host.repoPath}/issue-marker.txt`)).toBe(false)

  const issuePrompt = await submitComposer(host, changedSetup, 'issue', 4, { setup: 'run', issueCommand: 'run', trustSetup: true, trustSetupHash: shownSetupB })
  expect(issuePrompt).toMatchObject({ kind: 'composer', setup: 'run', trustKind: 'issue', trustScript: issueA, trustSetupHash: shownSetupB })
  const shownIssueA = stringField(issuePrompt, 'trustHash')

  host.setHooks({ setup: setupB, issueCommand: issueB })
  const changedIssue = await submitComposer(host, issuePrompt, 'issue', 4, {
    setup: 'run', issueCommand: 'run',
    trustSetup: true, trustSetupHash: shownSetupB,
    trustIssueCommand: true, trustIssueCommandHash: shownIssueA
  })
  expect(changedIssue).toMatchObject({ kind: 'composer', setup: 'run', trustKind: 'issue', trustScript: issueB, trustSetupHash: shownSetupB, trustChanged: true })
  const shownIssueB = stringField(changedIssue, 'trustHash')
  expect(shownIssueB).not.toBe(shownIssueA)
  expect(await listWorktrees(host)).toHaveLength(1)
  expect(existsSync(`${host.repoPath}/setup-marker.txt`)).toBe(false)
  expect(existsSync(`${host.repoPath}/issue-marker.txt`)).toBe(false)

  const created = await submitComposer(host, changedIssue, 'issue', 4, {
    setup: 'run', issueCommand: 'run',
    trustSetup: true, trustSetupHash: shownSetupB,
    trustIssueCommand: true, trustIssueCommandHash: shownIssueB
  })
  expect(created).toMatchObject({
    kind: 'created',
    setup: { ran: 'daemon', exitCode: 0 },
    issueCommand: { ran: 'daemon', exitCode: 0 },
    warnings: expect.any(Array)
  })
  const worktree = record(created.worktree)
  const path = stringField(worktree, 'path')
  expect(readFileSync(`${path}/setup-marker.txt`, 'utf8')).toBe('setup-B')
  expect(readFileSync(`${path}/issue-marker.txt`, 'utf8')).toBe('issue-B')
  expect(worktree.linkedIssue).toMatchObject({ number: 4, url: workspaceItemUrl('issue', 4) })
}, 60_000)

test('issue-command run-once approval survives a changed setup script and remains hash-pinned across retries', async () => {
  const host = await bootWorkspace()
  hosts.push(host)
  const setupA = "printf 'setup-A' > setup-marker.txt"
  const setupB = "printf 'setup-B' > setup-marker.txt"
  const issueScript = "printf 'issue-approved' > issue-marker.txt"
  const initialRef = host.setHooks({ setup: setupA, issueCommand: issueScript })
  await host.client.callAny('quirky.repo/trustHooks', { repo: host.repoId, kind: 'setup', ref: initialRef })

  const initial = await openComposer(host, 'issue', 4, { setup: 'run', issueCommand: 'run' })
  const issuePrompt = await submitComposer(host, initial, 'issue', 4, { setup: 'run', issueCommand: 'run' })
  expect(issuePrompt).toMatchObject({ kind: 'composer', trustKind: 'issue', trustScript: issueScript })
  const shownIssueHash = stringField(issuePrompt, 'trustHash')

  host.setHooks({ setup: setupB, issueCommand: issueScript })
  const setupPrompt = await submitComposer(host, issuePrompt, 'issue', 4, {
    setup: 'run',
    issueCommand: 'run',
    trustIssueCommand: true,
    trustIssueCommandHash: shownIssueHash
  })
  expect(setupPrompt).toMatchObject({
    kind: 'composer',
    trustKind: 'setup',
    trustScript: setupB,
    trustIssueCommandHash: shownIssueHash
  })
  const shownSetupHash = stringField(setupPrompt, 'trustHash')

  const created = await submitComposer(host, setupPrompt, 'issue', 4, {
    setup: 'run',
    issueCommand: 'run',
    trustSetup: true,
    trustSetupHash: shownSetupHash,
    trustIssueCommand: true,
    trustIssueCommandHash: shownIssueHash
  })
  expect(created).toMatchObject({
    kind: 'created',
    setup: { ran: 'daemon', exitCode: 0 },
    issueCommand: { ran: 'daemon', exitCode: 0 }
  })
  const worktree = record(created.worktree)
  const path = stringField(worktree, 'path')
  expect(readFileSync(`${path}/setup-marker.txt`, 'utf8')).toBe('setup-B')
  expect(readFileSync(`${path}/issue-marker.txt`, 'utf8')).toBe('issue-approved')
}, 60_000)

test('rapid concurrent submission of one composer request creates only one linked workspace', async () => {
  const host = await bootWorkspace()
  hosts.push(host)
  const request = await openComposer(host, 'issue', 4)
  const submissions = await Promise.allSettled([
    submitComposer(host, request, 'issue', 4),
    submitComposer(host, request, 'issue', 4)
  ])
  const created = submissions.flatMap((submission) => {
    if (submission.status !== 'fulfilled' || submission.value.kind !== 'created') return []
    return [submission.value]
  })
  expect(created).toHaveLength(1)
  expect(await listWorktrees(host)).toHaveLength(2)
  const taskState = record(await host.call('state'))
  const links = Object.values(record(taskState.links)).filter((value) => record(value).url === workspaceItemUrl('issue', 4))
  expect(links).toHaveLength(1)
}, 60_000)

test('Project-style direct Start picks the default agent and reports the readiness-gated one-time prompt delivery', async () => {
  const host = await bootWorkspaceWithAgent()
  hosts.push(host)
  const chosen = record(await host.call('quirky.agents/pick', { forAgentTab: true }))
  expect(chosen.agent).toBe('goose')
  await host.call('quirky.agents/setDefault', { agent: 'auto' })
  await host.client.callAny('events.subscribe', {})
  const target = { worktree: host.worktree, kind: 'issue', number: 4, url: workspaceItemUrl('issue', 4) }
  const prompt = `Work on this GitHub issue: Fixture agent issue\n\n${target.url}\n\nKeep this project context.`
  const created = record(await host.call('quirky.tasks/workspace', {
    target,
    action: 'start',
    newWorkspace: true,
    name: 'fixture-agent-issue',
    prompt,
    setup: 'inherit'
  }))
  expect(created).toMatchObject({ kind: 'created', target, worktree: { linkedIssue: { number: 4, url: target.url } }, agent: 'goose' })
  expect(typeof created.agentSessionId).toBe('string')
  const sessionId = stringField(created, 'agentSessionId')
  const finalSession = await sessionAfterReady(host.client, sessionId)
  expect(finalSession.promptDelivery).toBe('pasted')
  const input = host.fakeLog('goose').flatMap((event) => {
    if (event.type !== 'input' || typeof event.b64 !== 'string') return []
    return [Buffer.from(event.b64, 'base64').toString('utf8')]
  }).join('')
  const expectedPrompt = prompt.replaceAll('\n', '\r')
  expect(input).toContain(expectedPrompt)
  expect(input.indexOf(expectedPrompt)).toBe(input.lastIndexOf(expectedPrompt))
}, 60_000)

test('submitting a retained composer without replacing its prompt delivers the prefilled item context', async () => {
  const host = await bootWorkspaceWithAgent()
  hosts.push(host)
  await host.client.callAny('events.subscribe', {})
  const target = { worktree: host.worktree, kind: 'issue', number: 4, url: workspaceItemUrl('issue', 4) }
  const opened = record(await host.call('quirky.tasks/workspace', { target, action: 'start', agent: 'goose' }))
  const created = record(await host.call('quirky.tasks/workspace', {
    target, action: 'start', newWorkspace: true, composerRequestId: opened.requestId, setup: 'skip', name: 'retained-item-context'
  }))
  const session = await sessionAfterReady(host.client, stringField(created, 'agentSessionId'))
  expect(session.promptDelivery).toBe('pasted')
  const input = host.fakeLog('goose').flatMap(event => event.type === 'input' ? [Buffer.from(event.b64, 'base64').toString('utf8')] : []).join('')
  expect(input).toContain(`Work on GitHub issue #4: Issue 4\r${target.url}`)
}, 60_000)
