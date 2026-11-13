import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginContext, PluginStore, ProcessRunner, RunOptions, RunResult } from '@quirky/protocol'
import { AccountProfiles } from '../src/profiles'
import type { LoginCompletion } from '../src/login'
import type { AccountPrepareResult, ManagedProvider, PendingLogin } from '../src/types'
import { AccountService } from '../src/service'
import { migrations } from '../src/store'
import type { AccountsHarness } from './support/index'
import { spawnNativePty } from './support/native-pty'
import { cleanupAll, defaultHome, startAccounts, waitForAsync } from './support/index'

type RunnerCall = { argv: readonly string[]; options?: RunOptions }

function runResult(overrides: Partial<RunResult> = {}): RunResult {
  const stdoutText = overrides.stdoutText ?? ''
  return {
    stdout: new TextEncoder().encode(stdoutText),
    stdoutText,
    stderr: '',
    exitCode: 0,
    signal: null,
    durationMs: 0,
    ...overrides
  }
}

function recordingRunner(
  respond: (argv: readonly string[], options?: RunOptions) => Promise<RunResult> = async () => runResult()
): { runner: ProcessRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = []
  const runner: ProcessRunner = {
    run: async (argv, options) => {
      calls.push({ argv: [...argv], options })
      return respond(argv, options)
    }
  }
  return { runner, calls }
}

function directFixture(runner: ProcessRunner) {
  const root = mkdtempSync(join(tmpdir(), 'quirky-accounts-profiles-'))
  const previousHome = process.env.HOME
  process.env.HOME = root
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  return {
    root,
    dataDir,
    profiles: new AccountProfiles(dataDir, runner),
    dispose() {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      rmSync(root, { recursive: true, force: true })
    }
  }
}

function sqliteStore(): { database: Database; store: PluginStore } {
  const database = new Database(':memory:')
  const store: PluginStore = {
    version: migrations.length,
    run(sql, ...params) {
      const result = database.query(sql).run(...params as never[])
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
    },
    get: <T>(sql: string, ...params: unknown[]) => (database.query(sql).get(...params as never[]) ?? null) as T | null,
    all: <T>(sql: string, ...params: unknown[]) => database.query(sql).all(...params as never[]) as T[],
    exec: (sql) => database.exec(sql),
    transaction: (work) => database.transaction(work)()
  }
  for (const migration of migrations) {
    if (typeof migration === 'string') database.exec(migration)
    else migration(store)
  }
  return { database, store }
}

function insertManagedAccount(
  store: PluginStore,
  provider: ManagedProvider,
  id: string,
  home: string,
  label: string,
  identityKey: string
): void {
  const now = Date.now()
  store.run(
    `INSERT INTO accounts (id, provider, label, email, organization, created_at, updated_at, last_authenticated_at, needs_sign_in, home, identity_key, auth_kind)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 0, ?, ?, 'oauth')`,
    id,
    provider,
    label,
    label,
    now,
    now,
    now,
    home,
    identityKey
  )
}

function prepareIdentityHome(path: string): void {
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, '.claude.json'), '{}')
}

function memoryStore(rows: Record<string, unknown>[] = []): PluginStore {
  return {
    version: 1,
    run: () => ({ changes: 0, lastInsertRowid: 0 }),
    get: <T>(_sql: string, ...params: unknown[]) => {
      const row = rows.find((candidate) => candidate.id === params[0])
      return row === undefined ? null : row as unknown as T
    },
    all: <T>() => rows as unknown as T[],
    exec: () => {},
    transaction: (work) => work()
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  const { promise, resolve } = Promise.withResolvers<T>()
  return { promise, resolve }
}

function installSecurityScript(h: AccountsHarness, script: string): void {
  const path = join(h.fakeBin, 'security')
  writeFileSync(path, script, { mode: 0o700 })
  chmodSync(path, 0o700)
}

async function securityLogCount(h: AccountsHarness, count: number): Promise<void> {
  await waitForAsync(async () => {
    try {
      const lines = readFileSync(join(h.home, 'security.log'), 'utf8').trim().split('\n').filter(Boolean)
      return lines.length >= count ? lines.length : undefined
    } catch {
      return undefined
    }
  })
}


afterEach(cleanupAll)

const call = <T>(h: AccountsHarness, method: string, params: Record<string, unknown> = {}) => h.client.callAny(method, params) as Promise<T>

async function add(h: AccountsHarness, provider: ManagedProvider, email: string): Promise<PendingLogin> {
  h.setLoginMode('complete', email)
  const started = await call<PendingLogin>(h, 'quirky.accounts/beginLogin', { provider })
  return waitForAsync(async () => {
    const current = await call<PendingLogin>(h, 'quirky.accounts/loginStatus', { id: started.id })
    return current.status === 'pending' ? undefined : current
  })
}

function mode(path: string): number {
  return lstatSync(path).mode & 0o777
}

function prepareArgs(h: AccountsHarness, agent: string, sessionId: string, claudeSource: 'inherited' | 'explicit' = 'inherited', claudeValue: string | null = null) {
  return {
    agent,
    sessionId,
    worktreeId: 'worktree_fixture',
    cwd: h.userHome,
    homeOverrides: {
      claude: { value: claudeValue, source: claudeSource },
      codex: { value: null, source: 'inherited' }
    }
  }
}

describe('async profile Keychain access', () => {
  test('maps credential read outcomes without exposing process output', async () => {
    const scenarios: {
      name: string
      result?: Partial<RunResult>
      reject?: boolean
      authKind: 'oauth' | 'none' | 'unknown'
    }[] = [
      { name: 'credential output', result: { stdoutText: ' credential ' }, authKind: 'oauth' },
      { name: 'empty output', result: { stdoutText: ' \n ' }, authKind: 'none' },
      { name: 'missing exit code', result: { exitCode: 44 }, authKind: 'none' },
      { name: 'missing message', result: { exitCode: 7, stderr: 'The item could not be found.' }, authKind: 'none' },
      { name: 'other failure', result: { exitCode: 7 }, authKind: 'unknown' },
      { name: 'spawn error', result: { exitCode: null, spawnError: { code: 'ENOENT', message: 'secret spawn output' } }, authKind: 'unknown' },
      { name: 'signal', result: { exitCode: null, signal: 'SIGTERM' }, authKind: 'unknown' },
      { name: 'signal with exit 44', result: { exitCode: 44, signal: 'SIGTERM' }, authKind: 'unknown' },
      { name: 'signal with not-found output', result: { exitCode: 7, signal: 'SIGTERM', stderr: 'The item could not be found.' }, authKind: 'unknown' },
      { name: 'spawn error with exit 44', result: { exitCode: 44, spawnError: { code: 'ENOENT', message: 'secret spawn output' } }, authKind: 'unknown' },
      { name: 'spawn error with not-found output', result: { exitCode: 7, spawnError: { code: 'ENOENT', message: 'secret spawn output' }, stderr: 'The item could not be found.' }, authKind: 'unknown' },
      { name: 'timeout despite missing message', result: { stopped: 'timeout', stderr: 'could not be found' }, authKind: 'unknown' },
      { name: 'abort', result: { stopped: 'aborted' }, authKind: 'unknown' },
      { name: 'overflow', result: { stopped: 'overflow', stderr: 'could not be found' }, authKind: 'unknown' },
      { name: 'runner rejection', reject: true, authKind: 'unknown' }
    ]

    for (const scenario of scenarios) {
      const { runner, calls } = recordingRunner(async () => {
        if (scenario.reject) throw new Error('secret runner output')
        return runResult(scenario.result)
      })
      const fixture = directFixture(runner)
      const home = join(fixture.root, 'custom-home')
      prepareIdentityHome(home)
      try {
        const identity = await fixture.profiles.readIdentity('claude', home)
        expect(identity.authKind).toBe(scenario.authKind)
        expect(identity.hasAuth).toBe(scenario.authKind === 'oauth')
        expect(calls).toHaveLength(1)
        expect(calls[0]?.argv[0]).toBe('security')
        expect(calls[0]?.argv[1]).toBe('find-generic-password')
        expect(calls[0]?.options).toMatchObject({ timeoutMs: 3_000, maxOutputBytes: 4_096, killGraceMs: 0, env: process.env })
        expect(calls[0]?.options?.signal).toBeInstanceOf(AbortSignal)
      } finally {
        fixture.dispose()
      }
    }
  })

  test('skips Keychain for file tokens and selects scoped or legacy service names', async () => {
    const { runner, calls } = recordingRunner()
    const fixture = directFixture(runner)
    try {
      const legacyHome = join(fixture.root, '.claude')
      prepareIdentityHome(legacyHome)
      await fixture.profiles.readIdentity('claude', legacyHome)
      expect(calls[0]?.argv).toContain('Claude Code-credentials')

      const scopedHome = join(fixture.root, 'custom-home')
      prepareIdentityHome(scopedHome)
      await fixture.profiles.readIdentity('claude', scopedHome)
      const suffix = createHash('sha256').update(scopedHome.normalize('NFC')).digest('hex').slice(0, 8)
      expect(calls[1]?.argv).toContain(`Claude Code-credentials-${suffix}`)

      const tokenHome = join(fixture.root, 'file-token-home')
      prepareIdentityHome(tokenHome)
      writeFileSync(join(tokenHome, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"file-token"}}')
      const identity = await fixture.profiles.readIdentity('claude', tokenHome)
      expect(identity.authKind).toBe('oauth')
      expect(calls).toHaveLength(2)
    } finally {
      fixture.dispose()
    }
  })

  test('deletes the Keychain item before removing a managed profile on accepted outcomes', async () => {
    const accepted: Partial<RunResult>[] = [
      { exitCode: 0 },
      { exitCode: 44 },
      { exitCode: 2, stderr: 'The item could not be found.' }
    ]

    for (const [index, outcome] of accepted.entries()) {
      const { runner, calls } = recordingRunner(async () => runResult(outcome))
      const fixture = directFixture(runner)
      const id = randomUUID()
      try {
        const home = await fixture.profiles.create('claude', id)
        await fixture.profiles.remove('claude', id)
        expect(calls).toHaveLength(1)
        expect(calls[0]?.argv).toEqual([
          'security',
          'delete-generic-password',
          '-s',
          `Claude Code-credentials-${createHash('sha256').update(home.normalize('NFC')).digest('hex').slice(0, 8)}`,
          '-a',
          expect.any(String)
        ])
        expect(calls[0]?.options).toMatchObject({ timeoutMs: 3_000, maxOutputBytes: 4_096, killGraceMs: 0, env: process.env })
        expect(calls[0]?.options?.signal).toBeInstanceOf(AbortSignal)
        expect(existsSync(home)).toBe(false)
      } finally {
        fixture.dispose()
      }
    }
  })

  test('preserves managed files and sanitizes every Keychain deletion failure', async () => {
    const failures: {
      result?: Partial<RunResult>
      reject?: boolean
    }[] = [
      { result: { exitCode: 5, stdoutText: 'secret stdout', stderr: 'secret stderr' } },
      { result: { exitCode: null, spawnError: { code: 'EACCES', message: 'secret spawn message' } } },
      { result: { exitCode: null, signal: 'SIGKILL' } },
      { result: { exitCode: 44, signal: 'SIGTERM' } },
      { result: { exitCode: 7, signal: 'SIGTERM', stderr: 'The item could not be found.' } },
      { result: { exitCode: 44, spawnError: { code: 'EACCES', message: 'secret spawn message' } } },
      { result: { exitCode: 7, spawnError: { code: 'EACCES', message: 'secret spawn message' }, stderr: 'The item could not be found.' } },
      { result: { stopped: 'timeout', stderr: 'could not be found' } },
      { result: { stopped: 'aborted' } },
      { result: { stopped: 'overflow' } },
      { reject: true }
    ]

    for (const [index, failure] of failures.entries()) {
      const { runner } = recordingRunner(async () => {
        if (failure.reject) throw new Error('secret rejected message')
        return runResult({ stdoutText: 'secret stdout', stderr: 'secret stderr', ...failure.result })
      })
      const fixture = directFixture(runner)
      const id = randomUUID()
      try {
        const home = await fixture.profiles.create('claude', id)
        const error = await fixture.profiles.remove('claude', id).then(() => null, (value: unknown) => value)
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toBe('The managed Claude credential could not be removed from Keychain.')
        expect((error as Error).message).not.toContain('secret')
        expect(existsSync(home)).toBe(true)
        expect(existsSync(join(home, '..', 'owner.json'))).toBe(true)
      } finally {
        fixture.dispose()
      }
    }
  })

  test('validates canonical ownership before running a Keychain delete', async () => {
    const { runner, calls } = recordingRunner()
    const fixture = directFixture(runner)
    const id = randomUUID()
    const outside = join(fixture.root, 'outside')
    try {
      const home = await fixture.profiles.create('claude', id)
      mkdirSync(outside)
      rmSync(home, { recursive: true, force: true })
      symlinkSync(outside, home)
      const error = await fixture.profiles.remove('claude', id).then(() => null, (value: unknown) => value)
      expect(error).toBeInstanceOf(Error)
      expect(calls).toHaveLength(0)
      expect(existsSync(outside)).toBe(true)
      expect(lstatSync(home).isSymbolicLink()).toBe(true)
    } finally {
      fixture.dispose()
    }
  })

  test('does not let rejected failed-profile cleanup replace the primary login error', async () => {
    const { runner } = recordingRunner()
    const fixture = directFixture(runner)
    const duplicateId = randomUUID()
    const service = new AccountService({
      dataDir: fixture.dataDir,
      process: runner,
      call: async () => [],
      emit: () => {},
      log: () => {}
    } as unknown as PluginContext, memoryStore([{
      id: duplicateId,
      provider: 'claude',
      label: 'Existing',
      email: 'duplicate@example.test',
      organization: null,
      created_at: 1,
      updated_at: 1,
      last_authenticated_at: 1,
      needs_sign_in: 0,
      active: 0,
      home: join(fixture.root, 'existing-home'),
      identity_key: 'claude:duplicate@example.test:',
      auth_kind: 'oauth'
    }]))
    service.profiles.remove = async () => {
      throw new Error('cleanup secret')
    }
    const completion: LoginCompletion = {
      request: {
        provider: 'claude',
        accountId: randomUUID(),
        home: join(fixture.root, 'failed-home'),
        label: null,
        copyLink: false,
        reauthenticating: false,
        mutationGeneration: 0
      },
      status: 'complete',
      identity: {
        email: 'duplicate@example.test',
        organization: null,
        authKind: 'oauth',
        hasAuth: true,
        identityKey: 'claude:duplicate@example.test:'
      },
      error: null,
      superseded: false
    }
    const finish = (service as unknown as { finishLoginMutation(value: LoginCompletion): Promise<unknown> })
      .finishLoginMutation.bind(service)
    try {
      const error = await finish(completion).then(() => null, (value: unknown) => value)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe('This Claude account is already added.')
      expect((error as Error).message).not.toContain('cleanup secret')
    } finally {
      await service.shutdown()
      fixture.dispose()
    }
  })
})

describe('async AccountService callers', () => {
  test('awaits rejected identity reads in service defaults and preparation fallbacks', async () => {
    const { runner } = recordingRunner()
    const fixture = directFixture(runner)
    const context = {
      dataDir: fixture.dataDir,
      process: runner,
      call: async () => [],
      emit: () => {},
      log: () => {}
    } as unknown as PluginContext
    const service = new AccountService(context, memoryStore())
    service.start()
    service.profiles.readIdentity = async () => {
      throw new Error('private identity read detail')
    }
    const customHome = join(fixture.root, 'custom-prepare-home')
    prepareIdentityHome(customHome)
    const providerParams = {
      agent: 'claude',
      cwd: fixture.root,
      homeOverrides: {
        claude: { value: customHome, source: 'explicit' },
        codex: { value: null, source: 'inherited' }
      }
    }
    try {
      const state = await service.list()
      expect(state.systemDefault.claude).toEqual({ label: 'System default', email: null, hasAuth: false, authKind: 'unknown' })
      expect(state.systemDefault.codex).toEqual({ label: 'System default', email: null, hasAuth: false, authKind: 'unknown' })
      const providerEnv = await service.prepareProviderEnv(providerParams)
      expect(providerEnv.account?.label).toBe('Custom Claude home')
      expect(providerEnv.account?.authKind).toBe('unknown')
      const prepared = await service.prepare({
        ...providerParams,
        sessionId: 'prepare-identity-rejection',
        worktreeId: 'test-worktree'
      })
      expect(prepared.account?.label).toBe('Custom Claude home')
      expect(prepared.account?.authKind).toBe('unknown')
    } finally {
      await service.shutdown()
      fixture.dispose()
    }
  })

  test('awaits rejected identity reads during Codex restart preflight', async () => {
    const { runner } = recordingRunner()
    const fixture = directFixture(runner)
    const id = randomUUID()
    const home = await fixture.profiles.create('codex', id)
    const service = new AccountService({
      dataDir: fixture.dataDir,
      process: runner,
      call: async () => [],
      emit: () => {},
      log: () => {}
    } as unknown as PluginContext, memoryStore([{
      id,
      provider: 'codex',
      label: 'Codex',
      email: 'codex@example.test',
      organization: null,
      created_at: 1,
      updated_at: 1,
      last_authenticated_at: 1,
      needs_sign_in: 0,
      active: 0,
      home,
      identity_key: 'codex:account',
      auth_kind: 'oauth'
    }]))
    service.profiles.readIdentity = async () => {
      throw new Error('private identity read detail')
    }
    const internal = service as unknown as {
      preflightCodexRestart(old: unknown, targetId: string | null): Promise<void>
    }
    try {
      const error = await internal.preflightCodexRestart({
        providerSession: { id: 'conversation', transcriptPath: null }
      }, id).then(() => null, (value: unknown) => value)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe('The selected Codex account home is unavailable or untrusted; the previous session was not stopped.')
    } finally {
      await service.shutdown()
      fixture.dispose()
    }
  })
  test('holds preparation and list until asynchronous Keychain reads settle', async () => {
    const h = await startAccounts()
    const home = join(h.userHome, 'held-custom-home')
    prepareIdentityHome(home)
    installSecurityScript(h, `#!/bin/sh
printf '%s\\n' "$*" >> "$ACCOUNTS_SECURITY_LOG"
if [ "$1" = "find-generic-password" ]; then
  while [ ! -e "$ACCOUNTS_SECURITY_LOG.release" ]; do sleep 0.01; done
  printf 'fixture-keychain-token'
  exit 0
fi
exit 44
`)
    const params = {
      agent: 'claude',
      cwd: h.userHome,
      homeOverrides: {
        claude: { value: home, source: 'explicit' },
        codex: { value: null, source: 'inherited' }
      }
    }
    const prepared = call<AccountPrepareResult>(h, 'quirky.accounts/prepareProviderEnv', params)
    await securityLogCount(h, 1)
    writeFileSync(`${join(h.home, 'security.log')}.release`, 'released')
    expect((await prepared).account?.authKind).toBe('oauth')

    rmSync(`${join(h.home, 'security.log')}.release`, { force: true })
    const listed = call<{ systemDefault: { claude: { authKind: string } } }>(h, 'quirky.accounts/list')
    await securityLogCount(h, 2)
    writeFileSync(`${join(h.home, 'security.log')}.release`, 'released')
    expect((await listed).systemDefault.claude.authKind).toBe('oauth')
  })

  test('serializes select and remove while prepare awaits an independent identity read', async () => {
    const h = await startAccounts()
    const first = await add(h, 'claude', 'first-async@example.test')
    const second = await add(h, 'claude', 'second-async@example.test')
    const firstId = first.result?.id
    const secondId = second.result?.id
    if (!firstId || !secondId) throw new Error('Completed Claude logins did not return account IDs')
    const firstHome = h.managedHome('claude', firstId)
    writeFileSync(join(firstHome, '.credentials.json'), '{"claudeAiOauth":{}}')
    const customHome = join(h.userHome, 'concurrent-custom-home')
    prepareIdentityHome(customHome)

    const confirmation = await h.client.callAny('quirky.accounts/remove', { provider: 'claude', accountId: secondId })
      .then(() => null, (error: unknown) => error as { data?: { askId?: string } })
    const askId = confirmation?.data?.askId
    if (!askId) throw new Error('Claude account removal did not request confirmation')
    await call(h, 'quirky.ask/answer', { askId, answers: { confirm: { value: true, source: 'input' } } })

    installSecurityScript(h, `#!/bin/sh
printf '%s\\n' "$*" >> "$ACCOUNTS_SECURITY_LOG"
case "$1" in
  find-generic-password)
    while [ ! -e "$ACCOUNTS_SECURITY_LOG.release" ]; do sleep 0.01; done
    printf 'fixture-keychain-token'
    exit 0
    ;;
  delete-generic-password) exit 44 ;;
esac
exit 2
`)
    const selecting = call(h, 'quirky.accounts/select', { provider: 'claude', accountId: firstId })
    await securityLogCount(h, 1)
    const removing = call(h, 'quirky.accounts/remove', { provider: 'claude', accountId: secondId, confirmation: askId })
    const preparing = call<AccountPrepareResult>(h, 'quirky.accounts/prepare', prepareArgs(
      h,
      'claude',
      'concurrent-prepare',
      'explicit',
      customHome
    ))
    await securityLogCount(h, 2)
    expect(readFileSync(join(h.home, 'security.log'), 'utf8')).not.toContain('delete-generic-password')
    writeFileSync(`${join(h.home, 'security.log')}.release`, 'released')
    const [, , prepared] = await Promise.all([selecting, removing, preparing])
    expect(prepared.account?.authKind).toBe('oauth')
    expect(existsSync(h.managedHome('claude', secondId))).toBe(false)
    expect((await call<{ accounts: { id: string }[] }>(h, 'quirky.accounts/list')).accounts.map((account) => account.id)).not.toContain(secondId)
  })
  test('rejects managed preparation after the selected account is removed during identity read', async () => {
    const h = await startAccounts()
    const login = await add(h, 'claude', 'removed-during-prepare@example.test')
    const id = login.result?.id
    if (!id) throw new Error('Completed Claude login did not return an account ID')
    await call(h, 'quirky.accounts/select', { provider: 'claude', accountId: id })
    const home = h.managedHome('claude', id)
    rmSync(join(home, '.credentials.json'), { force: true })

    const confirmation = await h.client.callAny('quirky.accounts/remove', { provider: 'claude', accountId: id })
      .then(() => null, (error: unknown) => error as { data?: { askId?: string } })
    const askId = confirmation?.data?.askId
    if (!askId) throw new Error('Claude account removal did not request confirmation')
    await call(h, 'quirky.ask/answer', { askId, answers: { confirm: { value: true, source: 'input' } } })

    const securityLog = join(h.home, 'security.log')
    const release = `${securityLog}.release`
    const managedService = `Claude Code-credentials-${createHash('sha256').update(home.normalize('NFC')).digest('hex').slice(0, 8)}`
    rmSync(securityLog, { force: true })
    installSecurityScript(h, `#!/bin/sh
printf '%s\\n' "$*" >> "$ACCOUNTS_SECURITY_LOG"
case "$1" in
  find-generic-password)
    if [ "$3" = "${managedService}" ]; then
      while [ ! -e "$ACCOUNTS_SECURITY_LOG.release" ]; do sleep 0.01; done
      printf 'fixture-keychain-token'
      exit 0
    fi
    exit 44
    ;;
  delete-generic-password) exit 44 ;;
esac
exit 2
`)


    const sessionId = 'removed-managed-prepare'
    const params = prepareArgs(h, 'claude', sessionId)
    const preparing = call<AccountPrepareResult>(h, 'quirky.accounts/prepare', params).then(
      (result) => ({ result }),
      (error: unknown) => ({ error })
    )
    const providerPreparing = call<AccountPrepareResult>(h, 'quirky.accounts/prepareProviderEnv', {
      agent: 'claude',
      cwd: h.userHome,
      homeOverrides: params.homeOverrides
    }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error })
    )
    let removing: Promise<{ succeeded: true } | { succeeded: false; error: unknown }> | null = null
    try {
      await securityLogCount(h, 2)
      removing = call(h, 'quirky.accounts/remove', { provider: 'claude', accountId: id, confirmation: askId }).then(
        () => ({ succeeded: true as const }),
        (error: unknown) => ({ succeeded: false as const, error })
      )
      await securityLogCount(h, 3)
      const removed = await removing
      expect(removed.succeeded).toBe(true)
      expect(existsSync(home)).toBe(false)
      expect((await call<{ accounts: { id: string }[] }>(h, 'quirky.accounts/list')).accounts.map((account) => account.id)).not.toContain(id)
    } finally {
      writeFileSync(release, 'released')
      if (removing) await removing
    }

    const [prepared, providerPrepared] = await Promise.all([preparing, providerPreparing])
    expect('error' in prepared ? prepared.error : undefined).toBeInstanceOf(Error)
    expect('error' in providerPrepared ? providerPrepared.error : undefined).toBeInstanceOf(Error)
    expect(await call<{ provider: ManagedProvider | null; home: string | null }>(h, 'quirky.accounts/sessionHome', { session: sessionId })).toEqual({ provider: null, home: null })
  })


  test('rechecks the selected managed Codex account after resume preparation before saving a session', async () => {
    const { runner } = recordingRunner()
    const fixture = directFixture(runner)
    const { database, store } = sqliteStore()
    const historyStarted = deferred<void>()
    const historyGate = deferred<string>()
    const id = randomUUID()
    let service: AccountService | null = null
    let preparing: Promise<{ result: AccountPrepareResult } | { error: unknown }> | null = null
    try {
      const home = await fixture.profiles.create('codex', id)
      writeFileSync(join(home, 'auth.json'), '{"tokens":{"access_token":"fixture-codex-token","account_id":"resume-account"}}')
      insertManagedAccount(store, 'codex', id, home, 'resume@example.test', 'codex:resume-account')
      store.run('INSERT INTO active_accounts (provider, account_id) VALUES (?, ?)', 'codex', id)
      service = new AccountService({
        dataDir: fixture.dataDir,
        process: runner,
        call: async () => [],
        emit: () => {},
        log: () => {},
        error: (kind: string, message: string) => Object.assign(new Error(message), { kind })
      } as unknown as PluginContext, store)
      service.start()
      const historyBoundary = service as unknown as {
        bridgeCodexResume(...args: unknown[]): Promise<string>
      }
      historyBoundary.bridgeCodexResume = async () => {
        historyStarted.resolve(undefined)
        return historyGate.promise
      }

      const sessionId = 'resume-after-managed-removal'
      preparing = service.prepare({
        agent: 'codex',
        sessionId,
        worktreeId: 'test-worktree',
        cwd: fixture.root,
        homeOverrides: {
          claude: { value: null, source: 'inherited' },
          codex: { value: null, source: 'inherited' }
        },
        resume: {
          sourceSessionId: 'missing-source-session',
          providerSession: { id: 'codex-conversation', transcriptPath: null }
        }
      }).then(
        (result) => ({ result }),
        (error: unknown) => ({ error })
      )

      await historyStarted.promise
      await service.remove({ provider: 'codex', accountId: id })
      expect(existsSync(home)).toBe(false)
      expect(store.get<{ id: string }>('SELECT id FROM accounts WHERE id = ?', id)).toBeNull()

      historyGate.resolve(join(fixture.root, 'prepared-rollout.jsonl'))
      const prepared = await preparing
      expect('error' in prepared).toBe(true)
      if ('error' in prepared) {
        expect(prepared.error).toBeInstanceOf(Error)
        expect(prepared.error).toMatchObject({ kind: 'conflict' })
        expect((prepared.error as Error).message).toContain('The selected codex account changed')
      }
      expect(store.get('SELECT session_id FROM account_sessions WHERE session_id = ?', sessionId)).toBeNull()
      expect(existsSync(home)).toBe(false)
    } finally {
      historyGate.resolve(join(fixture.root, 'released-rollout.jsonl'))
      if (preparing) await preparing
      if (service) await service.shutdown()
      database.close()
      fixture.dispose()
    }
  })

  test('select waits for managed identity and refuses a no-auth account without changing the prior selection', async () => {
    const identityReadStarted = deferred<void>()
    const identityReadGate = deferred<RunResult>()
    const previousId = randomUUID()
    const targetId = randomUUID()
    let targetHomeService = ''
    const { runner } = recordingRunner(async (argv) => {
      if (argv[1] === 'find-generic-password' && targetHomeService !== '' && argv.includes(targetHomeService)) {
        identityReadStarted.resolve(undefined)
        return identityReadGate.promise
      }
      return runResult({ exitCode: 44 })
    })
    const fixture = directFixture(runner)
    const { database, store } = sqliteStore()
    const previousEmail = 'previous-selection@example.test'
    const targetEmail = 'no-auth-target@example.test'
    let service: AccountService | null = null
    let selecting: Promise<{ selected: true } | { selected: false; error: unknown }> | null = null
    try {
      const previousHome = await fixture.profiles.create('claude', previousId)
      const targetHome = await fixture.profiles.create('claude', targetId)
      writeFileSync(join(previousHome, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: previousEmail } }))
      targetHomeService = `Claude Code-credentials-${createHash('sha256').update(targetHome.normalize('NFC')).digest('hex').slice(0, 8)}`
      writeFileSync(join(previousHome, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"previous-token"}}')
      writeFileSync(join(targetHome, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: targetEmail } }))
      insertManagedAccount(store, 'claude', previousId, previousHome, previousEmail, `claude:${previousEmail}:`)
      insertManagedAccount(store, 'claude', targetId, targetHome, targetEmail, `claude:${targetEmail}:`)
      store.run('INSERT INTO active_accounts (provider, account_id) VALUES (?, ?)', 'claude', previousId)
      service = new AccountService({
        dataDir: fixture.dataDir,
        process: runner,
        call: async () => [],
        emit: () => {},
        log: () => {},
        error: (kind: string, message: string) => Object.assign(new Error(message), { kind })
      } as unknown as PluginContext, store)
      service.start()

      selecting = service.select({ provider: 'claude', accountId: targetId }).then(
        () => ({ selected: true as const }),
        (error: unknown) => ({ selected: false as const, error })
      )
      await identityReadStarted.promise
      expect(store.get<{ account_id: string }>('SELECT account_id FROM active_accounts WHERE provider = ?', 'claude')?.account_id).toBe(previousId)

      identityReadGate.resolve(runResult({ exitCode: 44 }))
      const outcome = await selecting
      expect(outcome.selected).toBe(false)
      if (!outcome.selected) {
        expect(outcome.error).toBeInstanceOf(Error)
        expect(outcome.error).toMatchObject({ kind: 'conflict' })
        expect((outcome.error as Error).message).toContain('Sign in to this claude account again before selecting it.')
      }
      expect(store.get<{ account_id: string }>('SELECT account_id FROM active_accounts WHERE provider = ?', 'claude')?.account_id).toBe(previousId)
      expect(store.get<{ needs_sign_in: number }>('SELECT needs_sign_in FROM accounts WHERE id = ?', targetId)?.needs_sign_in).toBe(1)
    } finally {
      identityReadGate.resolve(runResult({ exitCode: 44 }))
      if (selecting) await selecting
      if (service) await service.shutdown()
      database.close()
      fixture.dispose()
    }
  })

  test('keeps account and profile intact on Keychain deletion failure without leaking output', async () => {
    const h = await startAccounts()
    const login = await add(h, 'claude', 'delete-failure@example.test')
    const id = login.result?.id
    if (!id) throw new Error('Completed Claude login did not return an account ID')
    const home = h.managedHome('claude', id)
    const secret = 'keychain-output-secret'
    installSecurityScript(h, `#!/bin/sh
printf '%s\\n' "$*" >> "$ACCOUNTS_SECURITY_LOG"
printf '%s' '${secret}'
printf '%s' '${secret}' >&2
exit 7
`)
    const confirmation = await h.client.callAny('quirky.accounts/remove', { provider: 'claude', accountId: id })
      .then(() => null, (error: unknown) => error as { data?: { askId?: string } })
    const askId = confirmation?.data?.askId
    if (!askId) throw new Error('Claude account removal did not request confirmation')
    await call(h, 'quirky.ask/answer', { askId, answers: { confirm: { value: true, source: 'input' } } })
    const failure = await h.client.callAny('quirky.accounts/remove', { provider: 'claude', accountId: id, confirmation: askId })
      .then(() => null, (error: unknown) => error as Error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure?.message).toContain('The managed account could not be removed; it is still available for retry.')
    expect(failure?.message).not.toContain(secret)
    expect(existsSync(home)).toBe(true)
    expect((await call<{ accounts: { id: string }[] }>(h, 'quirky.accounts/list')).accounts.map((account) => account.id)).toContain(id)
  })
})

describe('quirky.accounts profile ownership and routing', () => {
  test('managed Claude setup is private, shares only managed history, and never changes default config or auth', async () => {
    const h = await startAccounts()
    const source = defaultHome(h.home, 'claude')
    const userHistory = join(source, 'projects', 'user-project')
    mkdirSync(userHistory, { recursive: true })
    writeFileSync(join(source, 'settings.json'), '{"model":"fixture"}\n')
    writeFileSync(join(source, '.claude.json'), '{"oauthAccount":{"emailAddress":"system@example.test"}}\n')
    writeFileSync(join(source, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"fixture-default-secret"}}\n')
    writeFileSync(join(userHistory, 'existing.jsonl'), '{"type":"user","message":"existing default history"}\n')
    const before = ['settings.json', '.claude.json', '.credentials.json', 'projects/user-project/existing.jsonl']
      .map((name) => readFileSync(join(source, name)))

    const login = await add(h, 'claude', 'private@example.test')
    expect(login.status).toBe('complete')
    const id = login.result?.id
    expect(id).toBeTruthy()
    const home = h.managedHome('claude', id ?? '')
    expect(mode(home)).toBe(0o700)
    expect(mode(join(home, '..'))).toBe(0o700)
    expect(readFileSync(join(home, 'settings.json'), 'utf8')).toContain('fixture')
    expect(readFileSync(join(home, '.credentials.json'), 'utf8')).toContain('fixture-claude-token')
    expect(readFileSync(join(home, '.credentials.json'), 'utf8')).not.toContain('fixture-default-secret')
    expect(readFileSync(join(home, 'projects', 'user-project', 'existing.jsonl'), 'utf8')).toContain('existing default history')
    expect(lstatSync(join(home, 'projects')).isSymbolicLink()).toBe(true)
    expect(mode(join(home, '..', 'owner.json'))).toBe(0o600)
    expect(readFileSync(join(home, '..', 'owner.json'), 'utf8')).toContain('claude')
    expect(['settings.json', '.claude.json', '.credentials.json', 'projects/user-project/existing.jsonl']
      .map((name) => readFileSync(join(source, name)))).toEqual(before)
  })

  test('Claude history remains shared when the first account predates default history and survives its removal', async () => {
    const h = await startAccounts()
    const source = defaultHome(h.home, 'claude')
    expect(existsSync(source)).toBe(false)

    const first = await add(h, 'claude', 'first-history@example.test')
    const firstId = first.result?.id
    if (!firstId) throw new Error('First Claude login did not return an account ID')
    const firstHome = h.managedHome('claude', firstId)

    const defaultConversation = join(source, 'projects', 'late-default-project', 'conversation.jsonl')
    mkdirSync(join(source, 'projects', 'late-default-project'), { recursive: true })
    const conversation = '{"type":"user","message":"conversation created after account A"}\n'
    writeFileSync(defaultConversation, conversation)
    expect(readFileSync(join(firstHome, 'projects', 'late-default-project', 'conversation.jsonl'), 'utf8')).toBe(conversation)
    const systemHistory = join(source, 'history.jsonl')
    const firstHistory = join(firstHome, 'history.jsonl')
    const historyContent = '{"display":"shared Claude history"}\n'
    writeFileSync(systemHistory, historyContent)
    expect(readFileSync(firstHistory, 'utf8')).toBe(historyContent)

    const second = await add(h, 'claude', 'second-history@example.test')
    const secondId = second.result?.id
    if (!secondId) throw new Error('Second Claude login did not return an account ID')
    const secondConversation = join(h.managedHome('claude', secondId), 'projects', 'late-default-project', 'conversation.jsonl')
    expect(readFileSync(secondConversation, 'utf8')).toBe(conversation)
    expect(readFileSync(join(h.managedHome('claude', secondId), 'history.jsonl'), 'utf8')).toBe(historyContent)

    const refused = await h.client.callAny('quirky.accounts/remove', { provider: 'claude', accountId: firstId })
      .then(() => null, (error: unknown) => error as { data?: { askId?: string } })
    const askId = refused?.data?.askId
    if (!askId) throw new Error('Claude account removal did not request confirmation')
    await h.client.callAny('quirky.ask/answer', { askId, answers: { confirm: { value: true, source: 'input' } } })
    await h.client.callAny('quirky.accounts/remove', { provider: 'claude', accountId: firstId, confirmation: askId })

    expect(existsSync(firstHome)).toBe(false)
    expect(readFileSync(defaultConversation, 'utf8')).toBe(conversation)
    expect(readFileSync(secondConversation, 'utf8')).toBe(conversation)
    expect(readFileSync(systemHistory, 'utf8')).toBe(historyContent)
    expect(readFileSync(join(h.managedHome('claude', secondId), 'history.jsonl'), 'utf8')).toBe(historyContent)
  })

  test('preparation records actual custom identity and explicit user homes outrank selection', async () => {
    const h = await startAccounts()
    const added = await add(h, 'claude', 'managed@example.test')
    const id = added.result?.id
    if (!id) throw new Error('Completed Claude login did not return an account ID')
    await call(h, 'quirky.accounts/select', { provider: 'claude', accountId: id })

    const inherited = await call<AccountPrepareResult>(h, 'quirky.accounts/prepare', prepareArgs(h, 'claude', 'session-managed'))
    expect(inherited.account).toEqual({ provider: 'claude', id, label: 'managed@example.test', source: 'managed', authKind: 'oauth' })
    expect(inherited.env.CLAUDE_CONFIG_DIR).toBe(h.managedHome('claude', id))
    expect(inherited.account?.id).toBe(id)

    const custom = join(h.userHome, 'explicit-claude-home')
    mkdirSync(custom, { recursive: true })
    writeFileSync(join(custom, '.claude.json'), '{"oauthAccount":{"emailAddress":"custom@example.test"}}')
    writeFileSync(join(custom, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"fixture-custom-token"}}')
    const explicit = await call<AccountPrepareResult>(h, 'quirky.accounts/prepare', prepareArgs(h, 'claude', 'session-custom', 'explicit', custom))
    expect(explicit.account).toEqual({ provider: 'claude', id: null, label: 'custom@example.test', source: 'custom', authKind: 'oauth' })
    expect(explicit.env.CLAUDE_CONFIG_DIR).not.toBe(h.managedHome('claude', id))
  })

  test('an existing bash PTY re-reads the pointer after a later selection', async () => {
    const h = await startAccounts()
    const first = await add(h, 'claude', 'first@example.test')
    h.setLoginMode('complete', 'second@example.test')
    const secondStarted = await call<PendingLogin>(h, 'quirky.accounts/beginLogin', { provider: 'claude', label: 'Second' })
    const second = await waitForAsync(async () => {
      const state = await call<PendingLogin>(h, 'quirky.accounts/loginStatus', { id: secondStarted.id })
      return state.status === 'pending' ? undefined : state
    })
    const firstId = first.result?.id
    const secondId = second.result?.id
    if (!firstId || !secondId) throw new Error('Completed Claude logins did not return account IDs')
    await call(h, 'quirky.accounts/select', { provider: 'claude', accountId: firstId })
    const prepared = await call<AccountPrepareResult>(h, 'quirky.accounts/prepare', prepareArgs(h, 'shell', 'shell-session'))
    expect(prepared.shellInit).toBeTruthy()

    let output = ''
    let hasExited = false
    const routeWaiters: { from: number; expected: string; resolve: () => void; reject: (error: Error) => void }[] = []
    const onOutput = (data: Uint8Array | string): void => {
      output += typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
      for (let index = routeWaiters.length - 1; index >= 0; index--) {
        const waiter = routeWaiters[index]
        if (waiter && output.slice(waiter.from).includes(waiter.expected)) {
          routeWaiters.splice(index, 1)
          waiter.resolve()
        }
      }
    }
    const env: Record<string, string | undefined> = { ...process.env }
    for (const [name, value] of Object.entries(prepared.env)) {
      if (value === null) delete env[name]
      else env[name] = value
    }
    env.QUIRKY_SHELL_INIT = prepared.shellInit ?? ''
    const pty = spawnNativePty(['/bin/bash', '--noprofile', '--norc', '-i'], {
      env,
      terminal: { cols: 80, rows: 24, data: (_terminal, data) => onOutput(data) }
    })
    void pty.exited.then(() => {
      hasExited = true
      for (const waiter of routeWaiters.splice(0)) waiter.reject(new Error('PTY shell exited before reporting its route'))
    })
    const waitForRoute = (from: number, expected: string): Promise<void> => {
      if (output.slice(from).includes(expected)) return Promise.resolve()
      if (hasExited) return Promise.reject(new Error('PTY shell exited before reporting its route'))
      const { promise, resolve, reject } = Promise.withResolvers<void>()
      routeWaiters.push({ from, expected, resolve, reject })
      return promise
    }
    try {
      pty.terminal.write(`source "$QUIRKY_SHELL_INIT"\nclaude __route\n`)
      await waitForRoute(0, h.managedHome('claude', firstId))
      const oldLength = output.length
      await call(h, 'quirky.accounts/select', { provider: 'claude', accountId: secondId })
      pty.terminal.write('claude __route\n')
      await waitForRoute(oldLength, h.managedHome('claude', secondId))
    } finally {
      try {
        pty.kill('SIGKILL')
      } catch {
        // The PTY may have exited after reporting the second route.
      }
      await pty.exited
      pty.terminal.close()
    }
  })

  test('Codex profile forces file credential storage when System default has no config', async () => {
    const h = await startAccounts()
    const systemConfig = join(defaultHome(h.home, 'codex'), 'config.toml')
    expect(existsSync(systemConfig)).toBe(false)

    const login = await add(h, 'codex', 'isolated@example.test')
    expect(login.status).toBe('complete')
    const home = h.managedHome('codex', login.result?.id ?? '')
    const config = readFileSync(join(home, 'config.toml'), 'utf8')
    expect(config).toMatch(/^cli_auth_credentials_store = \"file\"$/m)
    expect(existsSync(systemConfig)).toBe(false)
  })

  test('Codex prepare retains last-synced settings and reports safe empty and missing source warnings', async () => {
    const h = await startAccounts()
    const systemConfig = join(defaultHome(h.home, 'codex'), 'config.toml')
    mkdirSync(join(defaultHome(h.home, 'codex')), { recursive: true })
    writeFileSync(systemConfig, 'model = "gpt-5"\nmodel_provider = "openai"\n')

    const login = await add(h, 'codex', 'sync@example.test')
    const id = login.result?.id ?? ''
    const managedConfig = join(h.managedHome('codex', id), 'config.toml')
    const initiallySynced = readFileSync(managedConfig, 'utf8')
    expect(initiallySynced).toContain('model = "gpt-5"')
    expect(initiallySynced).toMatch(/^cli_auth_credentials_store = "file"$/m)

    writeFileSync(systemConfig, 'model = "gpt-5.1"\nmodel_provider = "openai"\n')
    await call<AccountPrepareResult>(h, 'quirky.accounts/prepare', prepareArgs(h, 'codex', 'session-valid-config'))
    const synced = readFileSync(managedConfig, 'utf8')
    expect(synced).toContain('model = "gpt-5.1"')
    expect(synced).toMatch(/^cli_auth_credentials_store = "file"$/m)

    writeFileSync(systemConfig, '')
    await call<AccountPrepareResult>(h, 'quirky.accounts/prepare', prepareArgs(h, 'codex', 'session-empty-config'))
    expect(readFileSync(managedConfig, 'utf8')).toBe(synced)
    let state = await call<{ configWarnings: { accountId: string | null; kind: string; message: string }[] }>(h, 'quirky.accounts/list')
    let warning = state.configWarnings.find((item) => item.accountId === id)
    expect(warning?.kind).toBe('source-empty')
    expect(warning?.message).not.toContain(systemConfig)

    rmSync(systemConfig, { force: true })
    await call<AccountPrepareResult>(h, 'quirky.accounts/prepare', prepareArgs(h, 'codex', 'session-missing-config'))
    expect(readFileSync(managedConfig, 'utf8')).toBe(synced)
    state = await call<{ configWarnings: { accountId: string | null; kind: string; message: string }[] }>(h, 'quirky.accounts/list')
    warning = state.configWarnings.find((item) => item.accountId === id)
    expect(warning?.kind).toBe('source-missing')
    expect(warning?.message).not.toContain(systemConfig)
    writeFileSync(systemConfig, 'model_provider = "custom"\nmodel = "custom-model"\n')
    await call<AccountPrepareResult>(h, 'quirky.accounts/prepare', prepareArgs(h, 'codex', 'session-custom-config'))
    expect(readFileSync(managedConfig, 'utf8')).toBe(synced)
    state = await call<{ configWarnings: { accountId: string | null; kind: string; message: string }[] }>(h, 'quirky.accounts/list')
    warning = state.configWarnings.find((item) => item.accountId === id)
    expect(warning?.kind).toBe('sync-failed')
    expect(warning?.message).not.toContain(systemConfig)
  })

  test('symlink replacement is neither followed for preparation nor deleted by removal', async () => {
    const h = await startAccounts()
    const added = await add(h, 'codex', 'unsafe@example.test')
    const id = added.result?.id ?? ''
    await call(h, 'quirky.accounts/select', { provider: 'codex', accountId: id })
    const managedParent = join(h.home, 'plugin-data', 'quirky.accounts', 'profiles', 'codex', id)
    const home = join(managedParent, 'home')
    rmSync(home, { recursive: true, force: true })
    symlinkSync(h.userHome, home)

    const prepared = await h.client.callAny('quirky.accounts/prepare', prepareArgs(h, 'codex', 'unsafe-session'))
      .then(() => null, (error: unknown) => error)
    expect(prepared).not.toBeNull()
    const removal = await h.client.callAny('quirky.accounts/remove', { provider: 'codex', accountId: id, yes: true })
      .then(() => null, (error: unknown) => error)
    expect(removal).not.toBeNull()
    expect(existsSync(h.userHome)).toBe(true)
    expect((await call<{ accounts: { id: string }[] }>(h, 'quirky.accounts/list')).accounts.map((account) => account.id)).toContain(id)
    expect(lstatSync(home).isSymbolicLink()).toBe(true)
  })
})
