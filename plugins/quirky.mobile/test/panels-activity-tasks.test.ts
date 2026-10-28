import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MobileTestClient } from './support/client'
import { waitForAsync } from '../../../packages/daemon/test/helpers'
import { bootTasks, type TasksTest } from '../../quirky.tasks/test/helpers'
import { fixtureIssue, listFixtureSource, seedListFixture } from '../../quirky.tasks/test/fixtures/list'
import { issueFixtureRecord, issueFixtureSource, seedIssueFixture } from '../../quirky.tasks/test/fixtures/issue'
import { startAccounts, cleanupAll, type AccountsHarness } from '../../quirky.accounts/test/support/index'
import { bootHosting, type HostingTest } from '../../quirky.hosting/test/helpers'
import { writeClaudeFixture, writeJsonlFixture } from '../../quirky.vault/test/fixtures/scanner-fixtures'

type MobileHost = { client: { callAny(method: string, params?: Record<string, unknown>): Promise<unknown> } }
type RecordValue = Record<string, unknown>

const ISOLATED_ENV_KEYS = ['QUIRKY_MOBILE_PORT', 'QUIRKY_MOBILE_HOST', 'QUIRKY_VAULT_SOURCE_HOME', 'QUIRKY_AGENT_SEARCH_DIRS', 'BROWSER'] as const
let priorEnvironment: Map<typeof ISOLATED_ENV_KEYS[number], string | undefined> | undefined
let phone: MobileTestClient | undefined
let tasksHost: TasksTest | undefined
let accountsHost: AccountsHarness | undefined
let vaultHost: HostingTest | undefined
let vaultSourceHome: string | undefined
let agentSearchDirectory: string | undefined

beforeEach(() => {
  priorEnvironment = new Map(ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]] as const))
  process.env.QUIRKY_MOBILE_PORT = '0'
  delete process.env.QUIRKY_MOBILE_HOST
  delete process.env.QUIRKY_VAULT_SOURCE_HOME
  delete process.env.BROWSER
  agentSearchDirectory = mkdtempSync(join(tmpdir(), 'quirky-mobile-empty-agent-search-'))
  process.env.QUIRKY_AGENT_SEARCH_DIRS = agentSearchDirectory
})

afterEach(async () => {
  try {
    if (phone) await phone.close()
    phone = undefined
    if (accountsHost) {
      await cleanupAll()
      accountsHost = undefined
    }
    if (tasksHost) {
      await tasksHost.cleanup()
      tasksHost = undefined
    }
    if (vaultHost) {
      await vaultHost.cleanup()
      vaultHost = undefined
    }
  } finally {
    if (vaultSourceHome) rmSync(vaultSourceHome, { recursive: true, force: true })
    vaultSourceHome = undefined
    if (agentSearchDirectory) rmSync(agentSearchDirectory, { recursive: true, force: true })
    agentSearchDirectory = undefined
    for (const key of ISOLATED_ENV_KEYS) {
      const value = priorEnvironment?.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    priorEnvironment = undefined
  }
})

function record(value: unknown): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected an object result')
  return value as RecordValue
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('expected an array result')
  return value
}

function stringField(value: RecordValue, name: string): string {
  if (typeof value[name] !== 'string') throw new Error(`expected ${name} to be a string`)
  return value[name] as string
}

async function pairPhone(host: MobileHost): Promise<MobileTestClient> {
  const pairing = record(await host.client.callAny('quirky.mobile/pair', { address: '127.0.0.1' }))
  if (pairing.available !== true || typeof pairing.endpoint !== 'string' || typeof pairing.pairingUrl !== 'string') {
    throw new Error('the isolated daemon did not create a mobile pairing offer')
  }
  const code = new URL(pairing.pairingUrl).searchParams.get('code')
  if (!code) throw new Error('the mobile pairing offer did not include its one-time code')
  const offer = record(JSON.parse(Buffer.from(code, 'base64url').toString('utf8')) as unknown)
  const client = MobileTestClient.connect(
    pairing.endpoint,
    stringField(offer, 'publicKeyB64'),
    stringField(offer, 'deviceToken')
  )
  phone = client
  await client.authenticated
  return client
}

function listItemState(host: TasksTest): RecordValue[] {
  const state = record(host.readState())
  const items = record(state.items)
  return list(items['test-owner/test-repo']).map(record)
}

test('encrypted task consumers list, detail, edit, and create a workspace attached to the selected repository', async () => {
  const host = await bootTasks(listFixtureSource, { extraBuiltins: ['quirky.mobile', 'quirky.agents', 'quirky.session', 'quirky.terminal', 'quirky.ask'] })
  tasksHost = host
  const issue = fixtureIssue('test-owner', 'test-repo', 22, '2026-10-02T00:00:00Z')
  issue.title = 'Mobile task fixture'
  issue.body = 'Original provider description'
  host.writeState(seedListFixture({ 'test-owner/test-repo': [issue] }))
  const mobile = await pairPhone(host)

  const result = record(await mobile.call('quirky.tasks/list', {
    mode: 'issues', repoIds: null, query: 'is:open', page: 1
  }))
  const rows = list(result.items).map(record)
  const selected = rows.find((row) => row.kind === 'issue' && row.number === 22)
  if (!selected) throw new Error('the mobile task list omitted the fixture issue')
  const repositories = list(await mobile.call('quirky.tasks/repositories', {})).map(record)
  const repository = repositories.find((entry) => entry.id === selected.repoId)
  if (!repository) throw new Error('the listed issue had no selected-repository association')
  expect(list(result.repositories).map(record)).toContainEqual(expect.objectContaining({ id: repository.id, worktree: repository.worktree }))
  const target = {
    worktree: stringField(repository, 'worktree'),
    kind: 'issue',
    number: 22,
    url: stringField(selected, 'url')
  }
  expect(target.worktree).toBe(host.worktree)

  const issueParams = { worktree: target.worktree, number: target.number, url: target.url }
  const detail = record(await mobile.call('quirky.tasks/issue', issueParams))
  expect(record(detail.item)).toMatchObject({ kind: 'issue', number: 22, title: 'Mobile task fixture', body: 'Original provider description' })
  const edited = record(await mobile.call('quirky.tasks/issueEdit', {
    ...issueParams,
    body: 'Updated provider description',
    labels: ['mobile-triage'],
    assignees: ['mobile-reviewer']
  }))
  expect(record(edited.item)).toMatchObject({
    kind: 'issue', number: 22, title: 'Mobile task fixture', body: 'Updated provider description',
    labels: ['mobile-triage'], assignees: ['mobile-reviewer']
  })
  expect(listItemState(host)).toContainEqual(expect.objectContaining({
    number: 22, title: 'Mobile task fixture', body: 'Updated provider description',
    labels: ['mobile-triage'], assignees: ['mobile-reviewer']
  }))


  const composer = record(await mobile.call('quirky.tasks/workspace', { target, action: 'start', newWorkspace: true }))
  expect(composer).toMatchObject({ kind: 'composer', target, repoId: repository.id })
  const agentCatalog = record(await mobile.call('quirky.mobile/agentCatalog', {}))
  expect(Object.keys(agentCatalog).sort()).toEqual(['agents', 'defaultAgent'].sort())
  const agents = list(agentCatalog.agents).map(record)
  for (const agent of agents) {
    expect(Object.keys(agent).sort()).toEqual(['enabled', 'id', 'installed', 'isDefault', 'label', 'resumable'].sort())
  }
  const created = record(await mobile.call('quirky.tasks/workspace', {
    target,
    action: 'start',
    newWorkspace: true,
    composerRequestId: stringField(composer, 'requestId'),
    name: 'mobile-task-22',
    prompt: stringField(composer, 'prompt'),
    setup: 'skip'
  }))
  expect(created).toMatchObject({ kind: 'created', target, worktree: { repoId: repository.id } })
  const createdWorktree = record(created.worktree)
  const resolved = record(await host.client.callAny('quirky.worktree/resolve', { selector: stringField(createdWorktree, 'id') }))
  expect(resolved).toMatchObject({
    repoId: repository.id,
    linkedIssue: { kind: 'issue', number: 22, url: target.url }
  })
  expect(await host.call('workspaceComposerState')).toBeNull()

  const existing = record(await mobile.call('quirky.tasks/workspace', { target, action: 'start' }))
  expect(existing).toMatchObject({ kind: 'resumed', target, worktree: { id: createdWorktree.id, repoId: repository.id } })
  expect(Object.keys(existing).sort()).toEqual(['kind', 'target', 'worktree'].sort())

  const responses = JSON.stringify({ result, detail, edited, agentCatalog, composer, created, existing })
  expect(responses).not.toContain('fixture-ambient-token')
  expect(responses).not.toContain('fixture-github-token')
}, 60_000)

test('encrypted task comments and edits mutate the stateful GitHub issue fixture', async () => {
  const host = await bootTasks(issueFixtureSource, { extraBuiltins: ['quirky.mobile'] })
  tasksHost = host
  host.writeState(seedIssueFixture(host.readState(), {
    number: 22,
    title: 'Mobile comment fixture',
    body: 'Original issue body',
    comments: []
  }))
  const mobile = await pairPhone(host)
  const target = {
    worktree: host.worktree,
    kind: 'issue',
    number: 22,
    url: 'https://github.com/test-owner/test-repo/issues/22'
  }

  await mobile.call('quirky.tasks/navigate', {
    worktree: target.worktree,
    source: 'github',
    mode: 'issues',
    detail: target
  })
  const issueParams = { worktree: target.worktree, number: target.number, url: target.url }
  const detail = record(await mobile.call('quirky.tasks/issue', issueParams))
  expect(record(detail.item)).toMatchObject({ kind: 'issue', number: 22, title: 'Mobile comment fixture' })

  const comment = record(await mobile.call('quirky.tasks/issueComment', { ...issueParams, body: 'Comment written from the paired client' }))
  expect(record(comment.comment)).toMatchObject({ body: 'Comment written from the paired client', author: 'issue-fixture' })
  const edited = record(await mobile.call('quirky.tasks/issueEdit', {
    ...issueParams,
    title: 'Mobile comment fixture edited',
    body: 'Issue edited from the paired client',
    labels: ['mobile'],
    assignees: ['reviewer']
  }))
  expect(record(edited.item)).toMatchObject({
    title: 'Mobile comment fixture edited', body: 'Issue edited from the paired client',
    labels: ['mobile'], assignees: ['reviewer']
  })
  expect(issueFixtureRecord(host.readState(), 'test-owner', 'test-repo', 22)).toMatchObject({
    title: 'Mobile comment fixture edited', body: 'Issue edited from the paired client',
    labels: [{ name: 'mobile' }], assignees: [{ login: 'reviewer' }]
  })
  const storedComments = record(record(host.readState()).resources)
  expect(list(record(storedComments.comments)['test-owner/test-repo/22']).map(record).map((entry) => entry.body))
    .toContain('Comment written from the paired client')
  expect(JSON.stringify({ detail, comment, edited })).not.toContain('fixture-ambient-token')
  expect(JSON.stringify({ detail, comment, edited })).not.toContain('fixture-github-token')
}, 60_000)

test('encrypted account consumers expose safe state, usage windows, and active account selection from fixture-owned credentials', async () => {
  const host = await startAccounts({ plugins: ['quirky.mobile'] })
  accountsHost = host
  host.setLoginMode('complete', 'mobile-claude@example.test')
  const pending = record(await host.client.callAny('quirky.accounts/beginLogin', { provider: 'claude', label: 'Mobile Claude' }))
  const loginId = stringField(pending, 'id')
  const completed = await waitForAsync(async () => {
    const current = record(await host.client.callAny('quirky.accounts/loginStatus', { id: loginId }))
    return current.status === 'pending' ? undefined : current
  }, 10_000)
  expect(completed).toMatchObject({ status: 'complete', provider: 'claude' })
  const account = record(completed.result)
  const accountId = stringField(account, 'id')
  const managedHome = host.managedHome('claude', accountId)
  expect(realpathSync(managedHome).startsWith(`${realpathSync(host.home)}${process.platform === 'win32' ? '\\' : '/'}`)).toBe(true)
  const credentialsPath = join(managedHome, '.credentials.json')
  expect(existsSync(credentialsPath)).toBe(true)
  expect(readFileSync(credentialsPath, 'utf8')).toContain('fixture-claude-token')

  const mobile = await pairPhone(host)
  const accounts = record(await mobile.call('quirky.accounts/list', {}))
  expect(accounts).toMatchObject({ active: { claude: null } })
  expect(list(accounts.accounts).map(record)).toContainEqual(expect.objectContaining({
    id: accountId, provider: 'claude', label: 'Mobile Claude', email: 'mobile-claude@example.test'
  }))
  const initialUsage = record(await mobile.call('quirky.accounts/usage', {}))
  expect(Array.isArray(initialUsage.providers)).toBe(true)

  const selected = record(await mobile.call('quirky.accounts/select', { provider: 'claude', accountId }))
  expect(record(selected.active).claude).toBe(accountId)
  expect(record(await mobile.call('quirky.accounts/list', {})).active).toMatchObject({ claude: accountId })

  const refreshed = await mobile.call('quirky.accounts/refresh', { provider: 'claude', force: true })
  const inactiveUsage = await mobile.call('quirky.accounts/inactiveUsage', { provider: 'claude' })
  const usage = record(await mobile.call('quirky.accounts/usage', {}))
  const activeUsage = list(usage.providers).map(record).find((entry) => entry.provider === 'claude' && entry.accountId === accountId)
  expect(activeUsage).toMatchObject({
    status: 'ok', session: { usedPercent: 25 }, weekly: { usedPercent: 10 }
  })

  const publicResponses = JSON.stringify({ accounts, initialUsage, selected, refreshed, inactiveUsage, usage })
  expect(publicResponses).not.toContain('fixture-claude-token')
  expect(publicResponses).not.toContain('fixture-claude-refresh')
  expect(publicResponses).not.toContain(managedHome)
}, 60_000)

test('encrypted vault consumers list and search owned Claude sessions by workspace and project, then resume without launch data', async () => {
  vaultSourceHome = mkdtempSync(join(tmpdir(), 'quirky-mobile-vault-source-'))
  process.env.QUIRKY_VAULT_SOURCE_HOME = vaultSourceHome
  const host = await bootHosting(listFixtureSource, {
    extraBuiltins: ['quirky.mobile', 'quirky.vault', 'quirky.agents', 'quirky.session', 'quirky.terminal', 'quirky.ask']
  })
  vaultHost = host
  await writeClaudeFixture(vaultSourceHome, { cwd: host.repoPath })
  await writeJsonlFixture(vaultSourceHome, 'claude', 'outside-scope-session', [
    {
      type: 'user',
      sessionId: 'outside-scope-session',
      timestamp: '2026-10-01T10:00:00.000Z',
      cwd: join(vaultSourceHome, 'outside-worktree'),
      message: { role: 'user', content: 'outsideonlyvaultmarker vault-fixture-claude-marker' }
    },
    {
      type: 'assistant',
      sessionId: 'outside-scope-session',
      timestamp: '2026-10-01T10:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'outside response' }] }
    }
  ])
  await host.client.callAny('quirky.agents/configure', { agent: 'claude', command: process.execPath, args: '', env: {} })
  await host.client.callAny('quirky.vault/setSearchEnabled', { enabled: true, historyDays: null, host: 'local' })
  let lastSearchStatus: RecordValue = {}
  try {
    await waitForAsync(async () => {
      const state = record(await host.client.callAny('quirky.vault/searchStatus', { host: 'local' }))
      const status = record(state.status)
      lastSearchStatus = status
      return status.enabled === true && (status.phase === 'current' || status.phase === 'degraded') &&
        Number(status.filesIndexed) >= 2 && status.filesDue === 0 && status.filesFailed === 0 &&
        record(status.sessionsByAgent).claude === 2 ? status : undefined
    }, 20_000)
  } catch (error) {
    throw new Error(`owned vault search did not become ready: ${JSON.stringify(lastSearchStatus)}`, { cause: error })
  }

  const mobile = await pairPhone(host)
  const workspaceWithin = { worktree: host.worktree }
  const selectedWorkspace = record(await mobile.call('quirky.worktree/resolve', { selector: host.worktree }))
  const projectWithin = { repo: stringField(selectedWorkspace, 'repoId') }
  const workspaceList = record(await mobile.call('quirky.vault/list', {
    host: 'local', limit: 100, sort: 'updated', force: false, within: workspaceWithin
  }))
  const projectList = record(await mobile.call('quirky.vault/list', {
    host: 'local', limit: 100, sort: 'updated', force: false, within: projectWithin
  }))
  const workspaceSessions = list(workspaceList.sessions).map(record)
  const projectSessions = list(projectList.sessions).map(record)
  expect(workspaceSessions.map((session) => session.sessionId)).toContain('claude-fixture-session')
  expect(projectSessions.map((session) => session.sessionId)).toContain('claude-fixture-session')
  expect(workspaceSessions.map((session) => session.sessionId)).not.toContain('outside-scope-session')
  expect(projectSessions.map((session) => session.sessionId)).not.toContain('outside-scope-session')
  const sourceSession = workspaceSessions.find((session) => session.sessionId === 'claude-fixture-session')!
  expect(sourceSession).toMatchObject({ agent: 'claude', presence: 'present' })
  expect(sourceSession).not.toHaveProperty('launch')

  const searchRequest = {
    host: 'local',
    query: 'vault-fixture-claude-marker',
    scope: 'all',
    freshness: 'indexed',
    limit: 50,
    filters: { sort: 'newest' }
  }
  const workspaceSearch = record(await mobile.call('quirky.vault/search', { ...searchRequest, within: workspaceWithin }))
  const projectSearch = record(await mobile.call('quirky.vault/search', { ...searchRequest, within: projectWithin }))
  expect(workspaceSearch.kind).toBe('results')
  expect(projectSearch.kind).toBe('results')
  expect(list(workspaceSearch.hits).map(record).map((hit) => hit.sessionId)).toContain('claude-fixture-session')
  expect(list(projectSearch.hits).map(record).map((hit) => hit.sessionId)).toContain('claude-fixture-session')
  expect(list(workspaceSearch.hits).map(record).map((hit) => hit.sessionId)).not.toContain('outside-scope-session')
  expect(list(projectSearch.hits).map(record).map((hit) => hit.sessionId)).not.toContain('outside-scope-session')
  expect(JSON.stringify({ workspaceList, projectList, workspaceSearch, projectSearch })).not.toContain('resumeCommand')

  await expect(mobile.call('quirky.vault/prepareResume', { id: stringField(sourceSession, 'id') }))
    .rejects.toMatchObject({ code: -32001 })
  await expect(mobile.call('quirky.agents/list', {})).rejects.toMatchObject({ code: -32001 })
  const resumed = record(await mobile.call('quirky.vault/resume', { id: stringField(sourceSession, 'id') }))
  expect(resumed).toMatchObject({ worktreeId: host.worktree })
  expect(typeof resumed.id).toBe('string')
  expect(resumed.id).not.toBe(sourceSession.id)
  expect(resumed).not.toHaveProperty('launch')
}, 60_000)
