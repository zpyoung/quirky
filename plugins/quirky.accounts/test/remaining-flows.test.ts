import { afterEach, describe, expect, jest, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RpcErrorCode,
  type ProcessRunner,
  type ProcessSpawner,
  type RunResult,
  type Session,
  type SpawnExit,
  type SpawnOptions,
  type SpawnedProcess,
  type StopOptions
} from '@quirky/protocol'
import { AccountLoginManager, type LoginCompletion, type LoginRequest } from '../src/login'
import { AccountProfiles } from '../src/profiles'
import type { AccountState, ManagedProvider, PendingLogin } from '../src/types'
import type { UsageState } from '../src/usage/types'
import type { AccountsHarness } from './support/index'
import { cleanupAll, startAccounts, waitForAsync } from './support/index'
import { interceptProviderFetch, restoreProviderFetchFixtures } from './acceptance-fixtures'
import { addManagedAccount, call, createClaudeSession, restartAndExit, sessionPlugins } from './remaining-support'

const originalProviderPath = process.env.PATH
let isolatedProviderPath: string | null = null
const timerControls = jest as unknown as {
  useFakeTimers(): void
  advanceTimersByTime(milliseconds: number): void
  useRealTimers(): void
}

afterEach(async () => {
  if (isolatedProviderPath !== null) {
    if (originalProviderPath === undefined) delete process.env.PATH
    else process.env.PATH = originalProviderPath
    isolatedProviderPath = null
  }
  await cleanupAll()
  await restoreProviderFetchFixtures()
})

type ConfirmationError = { code?: number; data?: { askId?: string } }

async function requireConfirmation(
  h: AccountsHarness,
  provider: ManagedProvider,
  accountId: string
): Promise<string> {
  const error = await h.client.callAny('quirky.accounts/remove', { provider, accountId }).then(
    () => null,
    (reason: unknown) => reason as ConfirmationError
  )
  expect(error?.code).toBe(RpcErrorCode.ConfirmationRequired)
  const askId = error?.data?.askId
  if (!askId) throw new Error('Account removal did not include a confirmation ask ID')
  return askId
}

function usageFor(state: UsageState, provider: string) {
  const snapshot = state.providers.find((item) => item.provider === provider)
  if (!snapshot) throw new Error(`Missing ${provider} usage snapshot`)
  return snapshot
}

describe('quirky.accounts remaining flow acceptance', () => {
  test('declining account removal preserves the selected profile and its auth bytes', async () => {
    const h = await startAccounts()
    const added = await addManagedAccount(h, 'claude', 'decline-remove@fixture.test')
    const accountId = added.id
    await call(h, 'quirky.accounts/select', { provider: 'claude', accountId })
    const accountHome = h.managedHome('claude', accountId)
    const authPath = join(accountHome, '.credentials.json')
    const authBefore = readFileSync(authPath)
    const askId = await requireConfirmation(h, 'claude', accountId)

    await call(h, 'quirky.ask/answer', {
      askId,
      answers: { confirm: { value: false, source: 'input' } }
    })
    const after = await call<AccountState>(h, 'quirky.accounts/list')
    expect(after.accounts).toContainEqual(expect.objectContaining({ id: accountId, provider: 'claude' }))
    expect(after.active.claude).toBe(accountId)
    expect(existsSync(accountHome)).toBe(true)
    expect(readFileSync(authPath)).toEqual(authBefore)
  })

  test('declining reset-credit confirmation leaves the offer available without provider redemption', async () => {
    const h = await startAccounts()
    const added = await addManagedAccount(h, 'codex', 'decline-reset@fixture.test')
    const accountId = added.id
    const resetAt = Math.floor((Date.now() + 60 * 60_000) / 1000)
    let redemptionCount = 0
    const fixture = interceptProviderFetch((url, init) => {
      if (url.hostname !== 'chatgpt.com') return null
      if (url.pathname === '/backend-api/wham/usage') {
        return Response.json({
          plan_type: 'plus',
          rate_limit: {
            primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_at: resetAt },
            secondary_window: { used_percent: 15, limit_window_seconds: 604_800, reset_at: resetAt }
          }
        })
      }
      if (url.pathname === '/backend-api/wham/rate-limit-reset-credits') {
        return Response.json({ available_count: 1, total_earned_count: 2, credits: [{ status: 'available', expires_at: resetAt, granted_at: resetAt - 100 }] })
      }
      if (url.pathname === '/backend-api/wham/rate-limit-reset-credits/consume' && init?.method === 'POST') {
        redemptionCount += 1
        return Response.json({ code: 'reset' })
      }
      return null
    })

    try {
      const before = await call<UsageState>(h, 'quirky.accounts/refresh', { provider: 'codex', force: true })
      const expectedScope = usageFor(before, 'codex').rateLimitResetCredits?.expectedScope
      expect(expectedScope).toEqual({ accountId, accountRevision: expect.any(Number), offerRevision: expect.any(String) })
      if (!expectedScope) throw new Error('Codex usage did not include a scoped reset offer')

      const refused = await h.client.callAny('quirky.accounts/consumeResetCredit', {
        idempotencyKey: 'accounts-remaining-declined-reset',
        expectedScope
      }).then(
        () => null,
        (error: unknown) => error as ConfirmationError
      )
      expect(refused?.code).toBe(RpcErrorCode.ConfirmationRequired)
      const askId = refused?.data?.askId
      if (!askId) throw new Error('Reset confirmation did not include its ask ID')
      await call(h, 'quirky.ask/answer', {
        askId,
        answers: { confirm: { value: false, source: 'input' } }
      })

      const after = await call<UsageState>(h, 'quirky.accounts/usage')
      expect(usageFor(after, 'codex').rateLimitResetCredits).toMatchObject({
        availableCount: 1,
        expectedScope
      })
      expect(redemptionCount).toBe(0)
    } finally {
      await fixture.restore()
    }
  })

  test('Ask keeps or explicitly restarts each stale Claude process without relabeling the kept process', async () => {
    const h = await startAccounts({ plugins: sessionPlugins })
    const accountA = await addManagedAccount(h, 'claude', 'ask-a@fixture.test')
    const accountB = await addManagedAccount(h, 'claude', 'ask-b@fixture.test')
    const idA = accountA.id
    const idB = accountB.id
    await call(h, 'quirky.accounts/select', { provider: 'claude', accountId: idA })
    const kept = await createClaudeSession(h)
    const restarted = await createClaudeSession(h)
    await call(h, 'quirky.session/setStatus', { session: kept.id, status: 'working' })
    await call(h, 'quirky.session/setStatus', { session: restarted.id, status: 'waiting' })

    const selected = await call<AccountState>(h, 'quirky.accounts/select', { provider: 'claude', accountId: idB })
    expect(selected.staleSessions.map((item) => item.sessionId)).toEqual(expect.arrayContaining([kept.id, restarted.id]))
    expect(h.harness.pty.requests.some((request) => request.type === 'kill' && [kept.id, restarted.id].includes(request.sessionId))).toBe(false)

    const keptState = await call<AccountState>(h, 'quirky.accounts/keep', { sessions: [kept.id], selectionRevision: selected.revision })
    expect(keptState.staleSessions).toContainEqual(expect.objectContaining({ sessionId: kept.id, accountId: idA, selectedId: idB, kept: true }))
    const restartedState = await restartAndExit(h, restarted.id, selected.revision)
    const sessions = await call<Session[]>(h, 'quirky.session/list')
    const resumed = sessions.find((session) => session.resumedFrom === restarted.id)
    expect(resumed).toMatchObject({
      agent: 'claude',
      cwd: restarted.cwd,
      providerSession: { id: restarted.providerSession?.id }
    })
    expect(h.harness.pty.sessions.get(kept.id)?.env.CLAUDE_CONFIG_DIR).toBe(h.managedHome('claude', idA))
    expect(resumed ? h.harness.pty.sessions.get(resumed.id)?.env.CLAUDE_CONFIG_DIR : undefined).toBe(h.managedHome('claude', idB))
    expect(restartedState.staleSessions.some((item) => item.sessionId === restarted.id)).toBe(false)
    expect(h.harness.pty.requests.some((request) => request.type === 'kill' && request.sessionId === kept.id)).toBe(false)
  })

  test('Always restarts an idle Claude session on selection while Never leaves running state to future launches', async () => {
    const h = await startAccounts({ plugins: sessionPlugins })
    const accountA = await addManagedAccount(h, 'claude', 'policy-a@fixture.test')
    const accountB = await addManagedAccount(h, 'claude', 'policy-b@fixture.test')
    const accountC = await addManagedAccount(h, 'claude', 'policy-c@fixture.test')
    const idA = accountA.id
    const idB = accountB.id
    const idC = accountC.id
    await call(h, 'quirky.accounts/select', { provider: 'claude', accountId: idA })
    const automatic = await createClaudeSession(h)
    await call(h, 'quirky.session/setStatus', { session: automatic.id, status: 'waiting' })
    await call(h, 'quirky.accounts/setPreferences', { claudeSwitchPolicy: 'always' })

    const selectingB = call<AccountState>(h, 'quirky.accounts/select', { provider: 'claude', accountId: idB })
    await waitForAsync(async () => h.harness.pty.requests.some(
      (request) => request.type === 'kill' && request.sessionId === automatic.id
    ) || undefined)
    h.harness.pty.exit(automatic.id, 137, { exitSignal: 'SIGKILL', exitCause: 'killed' })
    const selectedB = await selectingB
    const sessionsAfterAlways = await call<Session[]>(h, 'quirky.session/list')
    const resumedB = sessionsAfterAlways.find((session) => session.resumedFrom === automatic.id)
    expect(resumedB).toBeTruthy()
    expect(resumedB?.providerSession?.id).toBe(automatic.providerSession?.id)
    expect(resumedB ? h.harness.pty.sessions.get(resumedB.id)?.env.CLAUDE_CONFIG_DIR : undefined).toBe(h.managedHome('claude', idB))

    const retained = await createClaudeSession(h)
    await call(h, 'quirky.session/setStatus', { session: retained.id, status: 'waiting' })
    await call(h, 'quirky.accounts/setPreferences', { claudeSwitchPolicy: 'never' })
    const killsBeforeNever = h.harness.pty.requests.filter((request) => request.type === 'kill').length
    const selectedC = await call<AccountState>(h, 'quirky.accounts/select', { provider: 'claude', accountId: idC })

    expect(selectedC.staleSessions).toContainEqual(expect.objectContaining({
      sessionId: retained.id,
      accountId: idB,
      selectedId: idC,
      queued: false,
      kept: false
    }))
    expect(h.harness.pty.requests.filter((request) => request.type === 'kill')).toHaveLength(killsBeforeNever)
    expect(h.harness.pty.sessions.get(retained.id)?.env.CLAUDE_CONFIG_DIR).toBe(h.managedHome('claude', idB))
    const future = await createClaudeSession(h)
    expect(h.harness.pty.sessions.get(future.id)?.env.CLAUDE_CONFIG_DIR).toBe(h.managedHome('claude', idC))
  })
})
describe('AccountLoginManager process spawning', () => {
  test('spawns each provider with its isolated environment and bounded process options', async () => {
    for (const provider of ['claude', 'codex'] as const) {
      const fixture = createLoginFixture(provider)
      const processes = createLoginSpawner()
      const login = createLoginManager(fixture, processes.spawner)
      try {
        const pending = login.manager.begin(fixture.request)
        const process = processes.calls[0]!
        expect(process.argv).toEqual(provider === 'claude'
          ? ['claude', 'auth', 'login', '--claudeai']
          : ['codex', 'login'])
        expect(process.options).toMatchObject({
          cwd: fixture.home,
          env: {
            ...(provider === 'claude' ? { CLAUDE_CONFIG_DIR: fixture.home } : { CODEX_HOME: fixture.home })
          },
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'ignore',
          timeoutMs: provider === 'claude' ? 600_000 : 180_000,
          killGraceMs: 2_000
        })
        expect(process.options.env).not.toBe(globalThis.process.env)
        process.exit(1)
        expect(await login.completion).toMatchObject({ status: 'error', request: fixture.request })
        await login.waitForChange((state) => state.id === pending.id && state.status === 'error')
        expect(login.manager.status(pending.id)?.status).toBe('error')
      } finally {
        fixture.cleanup()
      }
    }
  })

  test('extracts only trusted OAuth URLs from streamed provider output across chunks', async () => {
    const claude = createLoginFixture('claude')
    const claudeProcesses = createLoginSpawner()
    const claudeLogin = createLoginManager(claude, claudeProcesses.spawner)
    const codex = createLoginFixture('codex')
    const codexProcesses = createLoginSpawner()
    const codexLogin = createLoginManager(codex, codexProcesses.spawner)
    try {
      const claudeTask = claudeLogin.manager.begin(claude.request)
      const claudeProcess = claudeProcesses.calls[0]!
      const claudeUrl = 'https://platform.claude.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback&state=fixture'
      const expectedClaudeUrl = new URL(claudeUrl).toString()
      const claudeUrlChange = claudeLogin.waitForChange((value) => value.id === claudeTask.id && value.url === expectedClaudeUrl)
      claudeProcess.push('https://evil.example/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%2Fcallback ')
      claudeProcess.push('Please open https://platform.claude.com/oauth/')
      claudeProcess.push('authorize?redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback&state=fixture\n')
      await claudeUrlChange
      expect(claudeLogin.manager.status(claudeTask.id)?.url).toBe(expectedClaudeUrl)
      expect(claudeLogin.changes.some((value) => value.url?.includes('evil.example'))).toBe(false)
      claudeProcess.exit(1)
      await claudeLogin.completion

      const codexTask = codexLogin.manager.begin(codex.request)
      const codexProcess = codexProcesses.calls[0]!
      const codexUrl = 'https://auth.openai.com/oauth/authorize?state=fixture'
      const expectedCodexUrl = new URL(codexUrl).toString()
      const codexUrlChange = codexLogin.waitForChange((value) => value.id === codexTask.id && value.url === expectedCodexUrl)
      codexProcess.push('Navigate to this URL to authenticate: https://evil.example/oauth/authorize?state=bad\n')
      const prefix = new TextEncoder().encode('🔐 Navigate to this URL to authenticate: https://auth.openai.com/oauth/')
      const suffix = new TextEncoder().encode('authorize?state=fixture\n')
      const emojiStart = prefix.indexOf(0xf0)
      codexProcess.push(prefix.subarray(0, emojiStart + 2))
      codexProcess.push(prefix.subarray(emojiStart + 2))
      codexProcess.push(suffix)
      await codexUrlChange
      expect(codexLogin.manager.status(codexTask.id)?.url).toBe(expectedCodexUrl)
      expect(codexLogin.changes.some((value) => value.url?.includes('evil.example'))).toBe(false)
      codexProcess.exit(1)
      await codexLogin.completion
    } finally {
      claude.cleanup()
      codex.cleanup()
    }
  })

  test('creates a private Claude browser helper and captures its trusted URL inside the copy-link window', async () => {
    timerControls.useFakeTimers()
    const fixture = createLoginFixture('claude', { copyLink: true })
    const processes = createLoginSpawner()
    const login = createLoginManager(fixture, processes.spawner)
    try {
      const pending = login.manager.begin(fixture.request)
      const process = processes.calls[0]!
      const script = process.options.env?.BROWSER
      expect(script).toBeTruthy()
      expect(existsSync(script!)).toBe(true)
      expect(statSync(script!).mode & 0o777).toBe(0o700)
      const scriptText = readFileSync(script!, 'utf8')
      expect(scriptText).toContain('chmod 600 "$tmp"')
      expect(scriptText).toContain('mv "$tmp" "$file"')
      const browserFile = browserCaptureFile(scriptText)
      const url = 'https://claude.ai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback&state=fixture'
      writeFileSync(browserFile, url, { mode: 0o600 })
      timerControls.advanceTimersByTime(200)
      expect(login.manager.status(pending.id)?.url).toBe(new URL(url).toString())
      process.exit(1)
      await login.completion
    } finally {
      timerControls.useRealTimers()
      fixture.cleanup()
    }
  })

  test('stops watching for a Claude browser URL after the 60-second copy-link window', async () => {
    timerControls.useFakeTimers()
    const fixture = createLoginFixture('claude', { copyLink: true })
    const processes = createLoginSpawner()
    const login = createLoginManager(fixture, processes.spawner)
    try {
      const pending = login.manager.begin(fixture.request)
      const script = processes.calls[0]!.options.env?.BROWSER
      if (!script) throw new Error('Claude browser helper was not configured')
      const browserFile = browserCaptureFile(readFileSync(script, 'utf8'))
      timerControls.advanceTimersByTime(60_000)
      writeFileSync(browserFile, 'https://claude.ai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%2Fcallback')
      timerControls.advanceTimersByTime(200)
      expect(login.manager.status(pending.id)?.url).toBeNull()
      processes.calls[0]!.exit(1)
      await login.completion
    } finally {
      timerControls.useRealTimers()
      fixture.cleanup()
    }
  })

  test('cancellation, supersession, and shutdown do not wait for a blocked stdin close', async () => {
    for (const action of ['cancel', 'supersede', 'shutdown'] as const) {
      const fixture = createLoginFixture('claude')
      const processes = createLoginSpawner()
      const login = createLoginManager(fixture, processes.spawner)
      try {
        const pending = login.manager.begin(fixture.request)
        const process = processes.calls[0]!
        const operation = action === 'cancel'
          ? login.manager.cancel(pending.id)
          : action === 'supersede'
            ? login.manager.supersedePending()
            : login.manager.shutdown()
        expect(process.closeInputCalls).toBe(1)
        expect(process.stopCalls).toEqual([{ graceMs: 2_000 }])
        process.exit(null, { signal: 'SIGTERM', stopped: 'stop' })
        await operation
        expect(await login.completion).toMatchObject({
          status: 'cancelled',
          superseded: action === 'supersede'
        })
      } finally {
        fixture.cleanup()
      }
    }
  })

  test('fails closed when stdout errors before a Codex auth change is latched', async () => {
    const fixture = createLoginFixture('codex')
    const processes = createLoginSpawner()
    const login = createLoginManager(fixture, processes.spawner)
    try {
      login.manager.begin(fixture.request)
      writeFileSync(join(fixture.home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'fixture-token' } }))
      processes.calls[0]!.failStdout(new Error('private stream failure'))
      processes.calls[0]!.exit(0)
      const completion = await login.completion
      expect(completion).toMatchObject({ status: 'error', identity: null })
      expect(processes.calls[0]!.stopCalls).toEqual([{ graceMs: 2_000 }])
    } finally {
      fixture.cleanup()
    }
  })

  test('keeps a Codex auth change already latched before stdout fails', async () => {
    const fixture = createLoginFixture('codex')
    const processes = createLoginSpawner()
    const login = createLoginManager(fixture, processes.spawner)
    try {
      const pending = login.manager.begin(fixture.request)
      writeFileSync(join(fixture.home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'fixture-token' } }))
      const cancelling = login.manager.cancel(pending.id)
      expect(processes.calls[0]!.closeInputCalls).toBe(1)
      processes.calls[0]!.failStdout(new Error('private stream failure'))
      processes.calls[0]!.exit(0)
      await cancelling
      expect(await login.completion).toMatchObject({ status: 'complete', identity: { hasAuth: true } })
    } finally {
      fixture.cleanup()
    }
  })

  test('awaits asynchronous profile identity lookup before notifying the service', async () => {
    const runStarted = Promise.withResolvers<void>()
    const keychainResult = Promise.withResolvers<RunResult>()
    const fixture = createLoginFixture('claude', {
      run: () => {
        runStarted.resolve()
        return keychainResult.promise
      }
    })
    const processes = createLoginSpawner()
    const login = createLoginManager(fixture, processes.spawner)
    try {
      login.manager.begin(fixture.request)
      processes.calls[0]!.exit(0)
      await runStarted.promise
      expect(login.finishedCount()).toBe(0)
      keychainResult.resolve({
        stdout: new Uint8Array(),
        stdoutText: '',
        stderr: '',
        exitCode: 44,
        signal: null,
        durationMs: 0
      })
      expect(await login.completion).toMatchObject({ status: 'error', identity: null })
      expect(login.finishedCount()).toBe(1)
    } finally {
      fixture.cleanup()
    }
  })
})

type FakeLoginProcess = {
  argv: string[]
  options: SpawnOptions
  handle: SpawnedProcess
  closeInputCalls: number
  stopCalls: StopOptions[]
  push(chunk: string | Uint8Array): void
  failStdout(error: unknown): void
  exit(code: number | null, extra?: Partial<SpawnExit>): void
}

function createLoginSpawner(): {
  spawner: ProcessSpawner
  calls: FakeLoginProcess[]
} {
  const calls: FakeLoginProcess[] = []
  const spawner: ProcessSpawner = {
    spawn(argv, options) {
      const exited = Promise.withResolvers<SpawnExit>()
      const blockedInputClose = Promise.withResolvers<void>().promise
      let stdoutController!: ReadableStreamDefaultController<Uint8Array>
      let stdoutEnded = false
      let settled = false
      let process!: FakeLoginProcess
      const settle = (result: SpawnExit): void => {
        if (settled) return
        settled = true
        if (!stdoutEnded) {
          stdoutEnded = true
          stdoutController.close()
        }
        exited.resolve(result)
      }
      const handle: SpawnedProcess = {
        pid: null,
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            stdoutController = controller
          }
        }),
        stderr: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close()
          }
        }),
        stderrTail: () => '',
        write: async () => true,
        closeInput: () => {
          process.closeInputCalls += 1
          return blockedInputClose
        },
        exited: exited.promise,
        stop: async (stopOptions) => {
          process.stopCalls.push(stopOptions ?? {})
          return exited.promise
        }
      }
      process = {
        argv: [...argv],
        options,
        handle,
        closeInputCalls: 0,
        stopCalls: [],
        push(chunk) {
          if (stdoutEnded) throw new Error('stdout is already closed')
          stdoutController.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk)
        },
        failStdout(error) {
          if (stdoutEnded) return
          stdoutEnded = true
          stdoutController.error(error)
        },
        exit(code, extra = {}) {
          settle({ exitCode: code, signal: null, durationMs: 0, ...extra })
        }
      }
      calls.push(process)
      return handle
    }
  }
  return { spawner, calls }
}

function createLoginFixture(
  provider: ManagedProvider,
  options: { copyLink?: boolean; run?: ProcessRunner['run'] } = {}
): {
  home: string
  profiles: AccountProfiles
  request: LoginRequest
  cleanup(): void
} {
  const root = mkdtempSync(join(tmpdir(), 'quirky-login-flow-'))
  const home = join(root, 'home')
  const bin = join(root, 'empty-bin')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(bin, { mode: 0o700 })
  isolatedProviderPath = bin
  process.env.PATH = bin
  const runner: ProcessRunner = {
    run: (argv, runOptions) => options.run
      ? options.run(argv, runOptions)
      : Promise.resolve({
        stdout: new Uint8Array(),
        stdoutText: '',
        stderr: '',
        exitCode: 44,
        signal: null,
        durationMs: 0
      })
  }
  const profiles = new AccountProfiles(root, runner)
  const request: LoginRequest = {
    provider,
    accountId: 'fixture-account',
    home,
    label: null,
    copyLink: options.copyLink ?? false,
    reauthenticating: false,
    mutationGeneration: 0
  }
  return {
    home,
    profiles,
    request,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  }
}

function createLoginManager(
  fixture: { profiles: AccountProfiles; request: LoginRequest },
  spawner: ProcessSpawner
): {
  manager: AccountLoginManager
  completion: Promise<LoginCompletion>
  finishedCount(): number
  changes: PendingLogin[]
  waitForChange(predicate: (pending: PendingLogin) => boolean): Promise<PendingLogin>
} {
  const completion = Promise.withResolvers<LoginCompletion>()
  let count = 0
  const changes: PendingLogin[] = []
  const waiters: { predicate: (pending: PendingLogin) => boolean; resolve: (pending: PendingLogin) => void }[] = []
  const manager = new AccountLoginManager(
    fixture.profiles,
    spawner,
    async (value) => {
      count += 1
      completion.resolve(value)
      return null
    },
    (pending) => {
      changes.push(pending)
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        const waiter = waiters[index]!
        if (waiter.predicate(pending)) {
          waiters.splice(index, 1)
          waiter.resolve(pending)
        }
      }
    }
  )
  const waitForChange = (predicate: (pending: PendingLogin) => boolean): Promise<PendingLogin> => {
    const existing = changes.find(predicate)
    if (existing) return Promise.resolve(existing)
    const deferred = Promise.withResolvers<PendingLogin>()
    waiters.push({ predicate, resolve: deferred.resolve })
    return deferred.promise
  }
  return { manager, completion: completion.promise, finishedCount: () => count, changes, waitForChange }
}


function browserCaptureFile(script: string): string {
  const match = /^file='([^']+)'$/m.exec(script)
  if (!match?.[1]) throw new Error('Claude browser helper did not expose its capture file')
  return match[1]
}
