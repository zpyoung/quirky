import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AccountPrepareResult, ManagedProvider, PendingLogin } from '../src/types'
import type { AccountsHarness } from './support/index'
import { spawnNativePty } from './support/native-pty'
import { cleanupAll, defaultHome, startAccounts, waitForAsync } from './support/index'

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
