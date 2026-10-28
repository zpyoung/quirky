import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { MobileTestClient } from './support/client'
import { waitForAsync } from '../../../packages/daemon/test/helpers'
import { bootTasks, type TasksTest } from '../../quirky.tasks/test/helpers'
import { fixtureIssue, listFixtureSource, seedListFixture } from '../../quirky.tasks/test/fixtures/list'
import { issueFixtureRecord, issueFixtureSource, seedIssueFixture } from '../../quirky.tasks/test/fixtures/issue'
import { startAccounts, cleanupAll, type AccountsHarness } from '../../quirky.accounts/test/support/index'
import { bootHosting, type HostingTest } from '../../quirky.hosting/test/helpers'
import { writeClaudeFixture, writeJsonlFixture } from '../../quirky.vault/test/fixtures/scanner-fixtures'
import { bootWorkspaceWithAgent, workspaceFixtureFiles, type WorkspaceAgentFixture } from '../../quirky.tasks/test/fixtures/workspace'

type MobileHost = { client: { callAny(method: string, params?: Record<string, unknown>): Promise<unknown> } }
type RecordValue = Record<string, unknown>

const ISOLATED_ENV_KEYS = ['QUIRKY_MOBILE_PORT', 'QUIRKY_MOBILE_HOST', 'QUIRKY_VAULT_SOURCE_HOME', 'QUIRKY_AGENT_SEARCH_DIRS', 'BROWSER'] as const
let priorEnvironment: Map<typeof ISOLATED_ENV_KEYS[number], string | undefined> | undefined
let phone: MobileTestClient | undefined
let tasksHost: TasksTest | undefined
let accountsHost: AccountsHarness | undefined
let workspaceAgentHost: WorkspaceAgentFixture | undefined
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
    try {
      if (workspaceAgentHost) await workspaceAgentHost.cleanup()
    } finally {
      workspaceAgentHost = undefined
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

function runFixtureGit(git: string, cwd: string, home: string, args: string[]): string {
  const result = Bun.spawnSync([git, '-C', cwd, ...args], {
    env: { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe'
  })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

function installWorkspaceHooks(host: WorkspaceAgentFixture, setup: string, issueCommand: string): void {
  const git = Bun.which('git')
  if (!git) throw new Error('Git is required to install workspace hook fixtures.')
  const filename = workspaceFixtureFiles.hookFile
  const path = join(host.repo, filename)
  const body = [
    `scripts:\n  setup: ${JSON.stringify(setup)}`,
    `issueCommand: ${JSON.stringify(issueCommand)}`
  ].join('\n') + '\n'
  const run = (args: string[]) => runFixtureGit(git, host.repo, host.userHome, args)
  run(['checkout', '--quiet', 'main'])
  writeFileSync(path, body)
  run(['add', filename])
  run(['-c', 'user.name=Workspace Fixture', '-c', 'user.email=workspace@example.test', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', `set ${filename}`])
  const revision = run(['rev-parse', 'HEAD'])
  run(['update-ref', 'refs/remotes/origin/main', revision])
  run(['push', '--quiet', host.baseBare, 'refs/heads/main:refs/heads/main'])
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
test('paired mobile workspace consent carries content pins through both hooks and executes each approved script', async () => {
  const host = await bootWorkspaceWithAgent({ extraEnv: { QUIRKY_MOBILE_PORT: '0' } })
  workspaceAgentHost = host
  let installedPlugins = list(await host.call('plugin.list')).map(record)
  if (!installedPlugins.some((plugin) => plugin.id === 'quirky.mobile')) {
    await host.call('plugin.install', { path: resolve(import.meta.dir, '..'), yes: true })
    installedPlugins = list(await host.call('plugin.list')).map(record)
  }
  if (!installedPlugins.some((plugin) => plugin.id === 'quirky.mobile')) {
    throw new Error('the real Mobile plugin was not installed in the isolated daemon')
  }
  const setupScript = "printf 'setup-ran' > setup-marker.txt"
  const issueCommand = "printf 'issue-ran' > issue-marker.txt"
  installWorkspaceHooks(host, setupScript, issueCommand)
  const repository = record(await host.call('quirky.worktree/resolve', { selector: host.worktree }))
  const repoId = stringField(repository, 'repoId')
  const issue = fixtureIssue('test-owner', 'test-repo', 22, '2026-10-02T00:00:00Z')
  host.writeState(seedListFixture({ 'test-owner/test-repo': [issue] }))
  const mobile = await pairPhone(host)
  const target = {
    worktree: host.worktree,
    kind: 'issue',
    number: 22,
    url: issue.url
  }

  const initial = record(await mobile.call('quirky.tasks/workspace', {
    target,
    action: 'start',
    newWorkspace: true,
    setup: 'run',
    issueCommand: 'run',
    agent: ''
  }))
  expect(initial.kind).toBe('composer')
  expect(initial.target).toEqual(target)
  expect(initial.setup).toBe('run')
  expect(initial.issueCommand).toBe('run')
  const composer = {
    target,
    action: 'start',
    newWorkspace: true,
    composerRequestId: stringField(initial, 'requestId'),
    name: 'mobile-consent-22',
    prompt: stringField(initial, 'prompt'),
    setup: 'run',
    issueCommand: 'run',
    agent: ''
  }

  const setupPrompt = record(await mobile.call('quirky.tasks/workspace', composer))
  expect(setupPrompt.kind).toBe('composer')
  expect(setupPrompt.trustKind).toBe('setup')
  expect(setupPrompt.trustScript).toBe(setupScript)
  const setupHash = stringField(setupPrompt, 'trustHash')
  expect(setupHash).toMatch(/^[a-f0-9]{64}$/)
  expect(await host.client.callAny('quirky.worktree/list', { repo: repoId }) as unknown[]).toHaveLength(1)

  const issuePrompt = record(await mobile.call('quirky.tasks/workspace', {
    ...composer,
    trustSetup: true,
    trustSetupHash: setupHash
  }))
  expect(issuePrompt.kind).toBe('composer')
  expect(issuePrompt.setup).toBe('run')
  expect(issuePrompt.trustKind).toBe('issue')
  expect(issuePrompt.trustScript).toBe(issueCommand)
  expect(issuePrompt.trustSetupHash).toBe(setupHash)
  const issueHash = stringField(issuePrompt, 'trustHash')
  expect(issueHash).toMatch(/^[a-f0-9]{64}$/)
  expect(await host.client.callAny('quirky.worktree/list', { repo: repoId }) as unknown[]).toHaveLength(1)

  const created = record(await mobile.call('quirky.tasks/workspace', {
    ...composer,
    trustSetup: true,
    trustSetupHash: setupHash,
    trustIssueCommand: true,
    trustIssueCommandHash: issueHash
  }))
  expect(created.kind).toBe('created')
  expect(created.target).toEqual(target)
  expect(created.agent).toBeNull()
  expect(record(created.setup).ran).not.toBe('skipped')
  const worktree = record(created.worktree)
  const path = stringField(worktree, 'path')
  const setupMarker = join(path, 'setup-marker.txt')
  const issueMarker = join(path, 'issue-marker.txt')
  await waitForAsync(() => existsSync(setupMarker) && existsSync(issueMarker) ? true : false, 15_000)
  expect(readFileSync(setupMarker, 'utf8')).toBe('setup-ran')
  expect(readFileSync(issueMarker, 'utf8')).toBe('issue-ran')
}, 60_000)
