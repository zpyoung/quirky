import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode, type OwnerSessionHostRef } from '@quirky/protocol'
import { isolateGitConfig, makeRepo } from '../../quirky.repo/test/git-fixtures'
import { runCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import { cleanupAll, startAccounts, waitForAsync, type AccountsHarness } from './support/index'
isolateGitConfig()

type HostRegistration = {
  id: string
  runtime: { id: string; name: string; endpoint: string; grantId: string }
  identity: { hostId: string; generation: string }
  connected: boolean
  error: string | null
}
type RemoteMirror = {
  id: string
  hostId: string
  identity: { hostId: string; generation: string }
  worktree: { id: string; instanceId: string; path: string; name: string; kind: string }
  connected: boolean
  fingerprint: string
}
type AccountSummary = { id: string; provider: string; label: string; email: string | null; needsSignIn: boolean }
type AccountState = {
  accounts: AccountSummary[]
  active: { claude: string | null; codex: string | null }
  preferences: { claudeSwitchPolicy: string }
  pendingLogin: unknown
}
type UsageState = { providers: { provider: string; accountId: string | null; weekly?: { usedPercent: number } | null }[] }
type OwnerWorld = { local: AccountsHarness; remote: AccountsHarness; runtime: { id: string; name: string; endpoint: string; grantId: string }; host: HostRegistration }

const worktreePlugins = ['quirky.cli', 'quirky.mobile', 'quirky.repo', 'quirky.worktree', 'quirky.agents', 'quirky.session', 'quirky.terminal', 'quirky.git', 'quirky.editor', 'quirky.sidebar-extras']
const call = <T,>(client: AccountsHarness['client'], method: string, params: Record<string, unknown> = {}) =>
  client.callAny(method, params) as Promise<T>

let previousMobilePort: string | undefined
let previousMobileHost: string | undefined
let previousBrowser: string | undefined

beforeEach(() => {
  previousMobilePort = process.env.QUIRKY_MOBILE_PORT
  previousMobileHost = process.env.QUIRKY_MOBILE_HOST
  previousBrowser = process.env.BROWSER
  delete process.env.BROWSER
  process.env.QUIRKY_MOBILE_PORT = '0'
  process.env.QUIRKY_MOBILE_HOST = '127.0.0.1'
})

afterEach(async () => {
  try {
    await cleanupAll()
  } finally {
    if (previousMobilePort === undefined) delete process.env.QUIRKY_MOBILE_PORT
    else process.env.QUIRKY_MOBILE_PORT = previousMobilePort
    if (previousMobileHost === undefined) delete process.env.QUIRKY_MOBILE_HOST
    else process.env.QUIRKY_MOBILE_HOST = previousMobileHost
    previousMobilePort = undefined
    previousMobileHost = undefined
    if (previousBrowser === undefined) delete process.env.BROWSER
    else process.env.BROWSER = previousBrowser
    previousBrowser = undefined
  }
})

async function startOwnerWorld(prefix: string): Promise<OwnerWorld> {
  const local = await startAccounts({ plugins: worktreePlugins })
  const remote = await startAccounts({ plugins: worktreePlugins })
  for (const h of [local, remote]) {
    await call(h.client, 'setting.set', {
      id: 'setting:quirky.worktree/worktreesRoot',
      value: join(h.home, 'worktrees')
    })
  }

  const offer = await call<{ offer: string }>(remote.client, 'quirky.mobile/ownerPair', {
    name: `${prefix} owner`,
    address: '127.0.0.1',
    confirm: true
  })
  const runtime = await call<{ id: string; name: string; endpoint: string; grantId: string }>(local.client, 'quirky.cli/runtimeAdd', {
    name: `${prefix} saved owner`,
    pairingCode: offer.offer
  })
  const host = await call<HostRegistration>(local.client, 'quirky.worktree/remoteHostRegister', {
    runtime: `runtime:${runtime.id}`
  })
  expect(host.connected).toBe(true)
  expect(host.runtime.id).toBe(runtime.id)
  return { local, remote, runtime, host }
}

async function createRemoteMirror(world: OwnerWorld, name: string): Promise<RemoteMirror> {
  const repoPath = join(world.remote.home, 'shared-repository')
  makeRepo(repoPath)
  const repo = await call<{ id: string }>(world.remote.client, 'quirky.repo/add', { path: repoPath })
  const created = await call<{ worktree: { id: string; instanceId: string; path: string; name: string; kind: string } }>(
    world.remote.client,
    'quirky.worktree/create',
    { repo: repo.id, name }
  )
  const mirror = await call<RemoteMirror>(world.local.client, 'quirky.worktree/remoteAttach', {
    host: world.host.id,
    worktree: created.worktree.id
  })
  const listed = await call<{ workspaces: RemoteMirror[] }>(world.local.client, 'quirky.worktree/remoteList', { host: world.host.id })
  expect(listed.workspaces).toContainEqual(expect.objectContaining({
    id: mirror.id,
    hostId: world.host.id,
    identity: world.host.identity,
    worktree: expect.objectContaining({ id: created.worktree.id, instanceId: created.worktree.instanceId }),
    connected: true,
    fingerprint: mirror.fingerprint
  }))
  return mirror
}

function hostRef(host: HostRegistration): OwnerSessionHostRef {
  return {
    hostId: host.identity.hostId,
    identity: { ...host.identity },
    runtime: {
      id: host.runtime.id,
      endpoint: host.runtime.endpoint,
      grantId: host.runtime.grantId
    }
  }
}

async function addCodexAccount(h: AccountsHarness, email: string): Promise<AccountSummary> {
  h.setLoginMode('complete', email)
  const pending = await call<{ id: string }>(h.client, 'quirky.accounts/beginLogin', { provider: 'codex' })
  const completed = await waitForAsync(async () => {
    const status = await call<{ status: string; result: AccountSummary | null }>(h.client, 'quirky.accounts/loginStatus', { id: pending.id })
    return status.status === 'pending' ? undefined : status
  })
  if (completed.status !== 'complete' || !completed.result) throw new Error(`Codex fixture login for ${email} did not complete`)
  return completed.result
}

function codexUsage(value: UsageState): UsageState['providers'][number] | undefined {
  return value.providers.find((snapshot) => snapshot.provider === 'codex')
}

function profileIds(h: AccountsHarness, provider: 'claude' | 'codex'): string[] {
  const directory = join(h.home, 'plugin-data', 'quirky.accounts', 'profiles', provider)
  return existsSync(directory) ? readdirSync(directory).sort() : []
}

async function expectPolicyRejection(promise: Promise<unknown>, message: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => {
      if (typeof caught === 'object' && caught !== null && 'code' in caught && typeof caught.code === 'number') {
        return { code: caught.code }
      }
      return null
    }
  )
  if (error === null) throw new Error(message)
  expect(error.code === RpcErrorCode.Conflict || error.code === RpcErrorCode.InvalidParams, message).toBe(true)
}

test('ownerCall reads and selects the pinned mirrored owner, keeping local accounts and usage independent, including its generated CLI route', async () => {
  const world = await startOwnerWorld('accounts-owner-routing')
  const mirror = await createRemoteMirror(world, 'accounts-owner-mirror')
  const localAccount = await addCodexAccount(world.local, 'local-owner@example.test')
  const remoteFirst = await addCodexAccount(world.remote, 'remote-first@example.test')
  const remoteSecond = await addCodexAccount(world.remote, 'remote-second@example.test')
  const owner = hostRef(world.host)

  const localBefore = await call<AccountState>(world.local.client, 'quirky.accounts/list')
  const remoteBefore = await call<AccountState>(world.remote.client, 'quirky.accounts/list')
  expect(localBefore.accounts.map((account) => account.email)).toContain('local-owner@example.test')
  expect(remoteBefore.accounts.map((account) => account.email)).toEqual(expect.arrayContaining([
    'remote-first@example.test', 'remote-second@example.test'
  ]))
  expect(remoteBefore.accounts.map((account) => account.id)).not.toContain(localAccount.id)
  expect(remoteBefore.active.codex).toBe(remoteSecond.id)

  const scopedBefore = await call<AccountState>(world.local.client, 'quirky.accounts/ownerCall', {
    owner,
    operation: 'list',
    params: {}
  })
  expect(scopedBefore.accounts.map((account) => account.id)).toContain(remoteFirst.id)
  expect(scopedBefore.accounts.map((account) => account.id)).not.toContain(localAccount.id)

  const selected = await call<AccountState>(world.local.client, 'quirky.accounts/ownerCall', {
    owner,
    operation: 'select',
    params: { provider: 'codex', accountId: remoteFirst.id }
  })
  expect(selected.active.codex).toBe(remoteFirst.id)
  const remoteAfter = await call<AccountState>(world.local.client, 'quirky.accounts/ownerCall', {
    owner,
    operation: 'list',
    params: {}
  })
  const localAfter = await call<AccountState>(world.local.client, 'quirky.accounts/list')
  expect(remoteAfter.active.codex).toBe(remoteFirst.id)
  expect(localAfter.active.codex).toBe(localAccount.id)
  expect(localAfter.accounts.map((account) => account.id)).not.toContain(remoteFirst.id)

  const remoteUsageState = await call<UsageState>(world.local.client, 'quirky.accounts/ownerCall', {
    owner,
    operation: 'refresh',
    params: { provider: 'codex', force: true }
  })
  const localUsageState = await call<UsageState>(world.local.client, 'quirky.accounts/refresh', {
    provider: 'codex',
    force: true
  })
  expect(codexUsage(remoteUsageState)?.accountId).toBe(remoteFirst.id)
  expect(codexUsage(localUsageState)?.accountId).toBe(localAccount.id)
  expect(codexUsage(remoteUsageState)).not.toEqual(codexUsage(localUsageState))

  const cli = await runCli([
    'accounts',
    'owner-call',
    '--owner',
    JSON.stringify(owner),
    '--operation',
    'list',
    '--operation-params',
    '{}',
    '--json'
  ], { home: world.local.home })
  expect(cli.code).toBe(0)
  expect(cli.stderr).toBe('')
  const cliState = JSON.parse(cli.stdout) as AccountState
  expect(cliState.active.codex).toBe(remoteFirst.id)
  expect(cliState.accounts.map((account) => account.id)).not.toContain(localAccount.id)
})

test('ownerCall rejects stale host or saved-grant pins, phone grants, remote sign-in and local-only policy writes before side effects', async () => {
  const world = await startOwnerWorld('accounts-owner-fences')
  await createRemoteMirror(world, 'accounts-owner-fence-mirror')
  const localAccount = await addCodexAccount(world.local, 'fence-local@example.test')
  const remoteAccount = await addCodexAccount(world.remote, 'fence-remote@example.test')
  const owner = hostRef(world.host)
  const initialRemote = await call<AccountState>(world.remote.client, 'quirky.accounts/list')
  const initialLocal = await call<AccountState>(world.local.client, 'quirky.accounts/list')
  const remoteClaudeProfiles = profileIds(world.remote, 'claude')
  const localClaudeProfiles = profileIds(world.local, 'claude')
  const remoteAuthPath = join(world.remote.managedHome('codex', remoteAccount.id), 'auth.json')
  const remoteAuthBefore = readFileSync(remoteAuthPath)

  await expectPolicyRejection(call(world.local.client, 'quirky.accounts/ownerCall', {
    owner: { ...owner, identity: { ...owner.identity, generation: 'stale-generation' } },
    operation: 'select',
    params: { provider: 'codex', accountId: remoteAccount.id }
  }), 'A replaced owner generation must be refused before remote account selection.')
  await expectPolicyRejection(call(world.local.client, 'quirky.accounts/ownerCall', {
    owner: { ...owner, runtime: { ...owner.runtime, grantId: `${owner.runtime.grantId}-stale` } },
    operation: 'select',
    params: { provider: 'codex', accountId: remoteAccount.id }
  }), 'A replaced saved grant must be refused before remote account selection.')
  await expectPolicyRejection(call(world.local.client, 'quirky.accounts/ownerCall', {
    owner: { ...owner, hostId: 'unregistered-owner-host' },
    operation: 'select',
    params: { provider: 'codex', accountId: remoteAccount.id }
  }), 'An unregistered owner identity must be refused before remote account selection.')

  const phoneOffer = await call<{ pairingUrl: string }>(world.remote.client, 'quirky.mobile/pair', { address: '127.0.0.1' })
  const phoneTarget = await call<{ id: string; endpoint: string; grantId: string }>(world.local.client, 'quirky.cli/runtimeAdd', {
    name: 'Phone-scoped runtime',
    pairingCode: phoneOffer.pairingUrl
  })
  await expectPolicyRejection(call(world.local.client, 'quirky.accounts/ownerCall', {
    owner: {
      hostId: 'unregistered-phone-host',
      identity: { hostId: 'unregistered-phone-host', generation: 'phone-generation' },
      runtime: { id: phoneTarget.id, endpoint: phoneTarget.endpoint, grantId: phoneTarget.grantId }
    },
    operation: 'select',
    params: { provider: 'codex', accountId: remoteAccount.id }
  }), 'Phone-scoped saved runtimes cannot be promoted to full-owner Accounts authority.')

  world.remote.setLoginMode('pending')
  await expectPolicyRejection(call(world.local.client, 'quirky.accounts/ownerCall', {
    owner,
    operation: 'beginLogin',
    params: { provider: 'claude' }
  }), 'Remote browser sign-in must be rejected before creating a login profile.')
  await expectPolicyRejection(call(world.local.client, 'quirky.accounts/ownerCall', {
    owner,
    operation: 'beginLogin',
    params: { provider: 'codex', accountId: remoteAccount.id }
  }), 'Remote reauthentication must be rejected before changing saved credentials.')
  await expectPolicyRejection(call(world.local.client, 'quirky.accounts/ownerCall', {
    owner,
    operation: 'openExternal',
    params: { target: 'https://auth.openai.com/oauth/authorize?client_id=fixture' }
  }), 'A remote pending sign-in URL must not be opened on the local machine.')
  await expectPolicyRejection(call(world.local.client, 'quirky.accounts/ownerCall', {
    owner,
    operation: 'setPreferences',
    params: { claudeSwitchPolicy: 'never' }
  }), 'Remote owner routing must not mutate the local Claude restart policy.')
  await expectPolicyRejection(call(world.local.client, 'quirky.accounts/ownerCall', {
    owner,
    operation: 'quirky.cli/runtimeCall',
    params: { method: 'quirky.accounts/select', params: { provider: 'codex', accountId: remoteAccount.id } }
  }), 'ownerCall is a fixed Accounts operation set, not a generic runtime RPC proxy.')

  expect(profileIds(world.remote, 'claude')).toEqual(remoteClaudeProfiles)
  expect(profileIds(world.local, 'claude')).toEqual(localClaudeProfiles)
  expect(readFileSync(remoteAuthPath)).toEqual(remoteAuthBefore)
  expect((await call<AccountState>(world.remote.client, 'quirky.accounts/list')).pendingLogin).toEqual(initialRemote.pendingLogin)
  expect((await call<AccountState>(world.remote.client, 'quirky.accounts/list')).active.codex).toBe(initialRemote.active.codex)
  expect((await call<AccountState>(world.local.client, 'quirky.accounts/list')).active.codex).toBe(localAccount.id)
  expect(initialLocal.active.codex).toBe(localAccount.id)
  expect((await call<AccountState>(world.remote.client, 'quirky.accounts/list')).preferences.claudeSwitchPolicy)
    .toBe(initialRemote.preferences.claudeSwitchPolicy)

  await world.remote.harness.daemon.stop()
  await expect(call(world.local.client, 'quirky.accounts/ownerCall', { owner, operation: 'list', params: {} }))
    .rejects.toMatchObject({ code: expect.any(Number) })
  const stillLocal = await call<AccountState>(world.local.client, 'quirky.accounts/list')
  expect(stillLocal.accounts.map((account) => account.id)).toContain(localAccount.id)
  expect(stillLocal.accounts.map((account) => account.id)).not.toContain(remoteAccount.id)
})
