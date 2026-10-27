import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import type { PluginContext } from '@quirky/protocol'
import { UsageService, type UsageTarget } from '../src/usage'
import './usage/providers.test'
import './usage/credentials.test'

const providers = ['claude', 'codex', 'gemini', 'antigravity', 'opencode-go', 'kimi', 'minimax', 'grok', 'cursor', 'zcode']
const roots: string[] = []
const services: UsageService[] = []
const envBefore = new Map<string, string | undefined>()
const nativeFetch = globalThis.fetch
const nativeDateNow = Date.now
type FetchMockImplementation = (...args: Parameters<typeof fetch>) => Promise<Response>

function fetchMock(implementation: FetchMockImplementation): typeof fetch {
  return Object.assign(implementation, { preconnect: nativeFetch.preconnect })
}

function setEnv(name: string, value: string): void {
  if (!envBefore.has(name)) envBefore.set(name, process.env[name])
  process.env[name] = value
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'quirky-usage-test-'))
  roots.push(root)
  const home = join(root, 'home')
  const quirkyHome = join(root, 'quirky-home')
  const dataDir = join(quirkyHome, 'plugin-data', 'quirky.accounts')
  const bin = join(root, 'bin')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  mkdirSync(bin, { recursive: true, mode: 0o700 })
  setEnv('HOME', home)
  setEnv('QUIRKY_HOME', quirkyHome)
  setEnv('PATH', `${bin}:${process.env.PATH ?? ''}`)
  for (const name of [
    'APPDATA',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'GROK_HOME',
    'GROK_CLI_CHAT_PROXY_BASE_URL',
    'KIMI_CODE_HOME',
    'KIMI_CODE_BASE_URL',
    'OPENCODE_API_KEY',
    'OPENCODE_DB',
    'OPENCODE_AUTH_CONTENT',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME'
  ]) setEnv(name, '')
  const security = join(bin, 'security')
  writeFileSync(security, '#!/bin/sh\nexit 44\n', { mode: 0o700 })
  chmodSync(security, 0o700)
  return root
}

function createService(root: string, targets: () => Promise<UsageTarget[]>, settings: Record<string, unknown> = {}): UsageService {
  const context = {
    dataDir: join(root, 'quirky-home', 'plugin-data', 'quirky.accounts'),
    home: join(root, 'quirky-home'),
    emit: () => true,
    log: () => undefined,
    getSetting: (name: string) => settings[name]
  } as unknown as PluginContext
  const service = new UsageService(context, targets)
  services.push(service)
  return service
}

function accountTargets(root: string, accountId = 'claude-a', revision = 1): UsageTarget[] {
  return providers.map((provider) => ({
    provider,
    accountId: provider === 'claude' || provider === 'codex' ? accountId : null,
    home:
      provider === 'claude'
        ? join(root, 'profiles', accountId, 'claude')
        : provider === 'codex'
          ? join(root, 'profiles', accountId, 'codex')
          : null,
    active: true,
    label: provider,
    ...(provider === 'claude' || provider === 'codex' ? { revision } : {})
  }))
}

function putClaudeCredential(home: string, token: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  writeFileSync(
    join(home, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: `refresh-${token}` } }),
    { mode: 0o600 }
  )
}

function claudeResponse(usedPercent: number): Response {
  return Response.json({
    five_hour: { utilization: usedPercent, resets_at: '2026-10-27T13:00:00.000Z' },
    seven_day: { utilization: 25, resets_at: '2026-11-03T12:00:00.000Z' }
  })
}

function putGeminiCredentialFixture(root: string, expiry: number): { path: string; bytes: string } {
  const home = join(root, 'home')
  const credentialDir = join(home, '.gemini')
  const binary = join(root, 'bin', 'gemini')
  const source = join(root, 'node_modules', '@google', 'gemini-cli-core', 'dist', 'src', 'code_assist', 'oauth2.js')
  mkdirSync(credentialDir, { recursive: true, mode: 0o700 })
  mkdirSync(dirname(source), { recursive: true, mode: 0o700 })
  const bytes = JSON.stringify({ access_token: 'expired-access-token', refresh_token: 'fixture-refresh-token', expiry_date: expiry })
  const path = join(credentialDir, 'oauth_creds.json')
  writeFileSync(path, bytes, { mode: 0o600 })
  writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  chmodSync(binary, 0o700)
  writeFileSync(source, `export const OAUTH_CLIENT_ID = 'fixture-client';\nexport const OAUTH_CLIENT_SECRET = 'fixture-secret';\n`, { mode: 0o600 })
  return { path, bytes }
}

function cursorDirectories(home: string): { cli: string; ide: string } {
  if (process.platform === 'darwin') {
    return { cli: join(home, '.cursor'), ide: join(home, 'Library', 'Application Support', 'Cursor') }
  }
  if (process.platform === 'win32') {
    const root = process.env.APPDATA?.trim() || join(home, 'AppData', 'Roaming')
    return { cli: join(root, 'Cursor'), ide: join(root, 'Cursor') }
  }
  const root = process.env.XDG_CONFIG_HOME?.trim() || join(home, '.config')
  return { cli: join(root, 'cursor'), ide: join(root, 'Cursor') }
}

function cursorJwt(expirySeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ sub: 'auth0|cursor-fixture', exp: expirySeconds })).toString('base64url')
  return `header.${payload}.signature`
}

function readProvider(service: UsageService, provider: string) {
  return service.state().providers.find((snapshot) => snapshot.provider === provider)
}

afterEach(() => {
  for (const service of services.splice(0)) service.shutdown()
  globalThis.fetch = nativeFetch
  Date.now = nativeDateNow
  for (const [name, value] of envBefore) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  envBefore.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('UsageService', () => {
  test('coalesces refreshes for the same provider and account', async () => {
    const root = fixtureRoot()
    const target = accountTargets(root)
    const home = target.find((item) => item.provider === 'claude')?.home
    if (!home) throw new Error('Claude fixture home is missing')
    putClaudeCredential(home, 'test-token-a')
    const response = Promise.withResolvers<Response>()
    const started = Promise.withResolvers<void>()
    let calls = 0
    globalThis.fetch = fetchMock(async () => {
      calls += 1
      started.resolve()
      return response.promise
    })
    const service = createService(root, async () => target)
    const first = service.refresh({ provider: 'claude', force: true })
    const second = service.refresh({ provider: 'claude', force: true })
    await started.promise
    response.resolve(claudeResponse(43))
    const [firstState, secondState] = await Promise.all([first, second])
    expect(calls).toBe(1)
    expect(firstState).toEqual(secondState)
    expect(readProvider(service, 'claude')?.session?.usedPercent).toBe(43)
  })

  test('does not publish a late Claude result after the active account changes', async () => {
    const root = fixtureRoot()
    const accountA = accountTargets(root, 'claude-a', 11)
    const homeA = accountA.find((item) => item.provider === 'claude')?.home
    if (!homeA) throw new Error('Claude fixture home is missing')
    putClaudeCredential(homeA, 'token-a')
    let current = accountA
    const response = Promise.withResolvers<Response>()
    const started = Promise.withResolvers<void>()
    globalThis.fetch = fetchMock(async () => {
      started.resolve()
      return response.promise
    })
    const service = createService(root, async () => current)
    const pending = service.refresh({ provider: 'claude', force: true })
    await started.promise
    current = accountTargets(root, 'claude-b', 12)
    response.resolve(claudeResponse(91))
    const state = await pending
    expect(state.providers.find((snapshot) => snapshot.provider === 'claude')).toMatchObject({
      accountId: 'claude-b',
      status: 'idle',
      session: null
    })
    expect(JSON.stringify(state)).not.toContain('token-a')
  })

  test('keeps last-good values stale through network errors for 30 minutes only', async () => {
    const root = fixtureRoot()
    const target = accountTargets(root)
    const home = target.find((item) => item.provider === 'claude')?.home
    if (!home) throw new Error('Claude fixture home is missing')
    putClaudeCredential(home, 'test-token-stale')
    let now = Date.parse('2026-10-27T12:00:00.000Z')
    Date.now = () => now
    const results = [claudeResponse(75), new Response('', { status: 500 }), new Response('', { status: 500 })]
    globalThis.fetch = fetchMock(async () => results.shift() ?? new Response('', { status: 500 }))
    const service = createService(root, async () => target)
    await service.refresh({ provider: 'claude', force: true })
    now += 1_000
    const stale = await service.refresh({ provider: 'claude', force: true })
    expect(stale.providers.find((snapshot) => snapshot.provider === 'claude')).toMatchObject({
      status: 'error',
      error: expect.any(String),
      session: { usedPercent: 75 }
    })
    now += 30 * 60_000
    const expired = await service.refresh({ provider: 'claude', force: true })
    expect(expired.providers.find((snapshot) => snapshot.provider === 'claude')).toMatchObject({
      status: 'error',
      session: null,
      weekly: null
    })
  })

  test('persists secret-free last-good snapshots across service instances', async () => {
    const root = fixtureRoot()
    const target = accountTargets(root)
    const home = target.find((item) => item.provider === 'claude')?.home
    if (!home) throw new Error('Claude fixture home is missing')
    putClaudeCredential(home, 'test-token-persisted')
    globalThis.fetch = fetchMock(async () => claudeResponse(43))
    const first = createService(root, async () => target)
    await first.refresh({ provider: 'claude', force: true })
    first.shutdown()
    globalThis.fetch = fetchMock(async () => new Response('', { status: 500 }))
    const second = createService(root, async () => target)
    const state = await second.refresh({ provider: 'claude', force: true })
    const snapshot = state.providers.find((item) => item.provider === 'claude')
    expect(snapshot).toMatchObject({ status: 'error', session: { usedPercent: 43 } })
    const snapshotPath = join(root, 'quirky-home', 'plugin-data', 'quirky.accounts', 'usage-snapshots.json')
    expect(statSync(snapshotPath).mode & 0o777).toBe(0o600)
    expect(readFileSync(snapshotPath, 'utf8')).not.toContain('test-token-persisted')
  })

  test('disables Gemini CLI OAuth polling unless explicitly enabled', async () => {
    const root = fixtureRoot()
    const credential = putGeminiCredentialFixture(root, Date.now() - 1_000)
    let calls = 0
    globalThis.fetch = fetchMock(async () => {
      calls += 1
      return Response.json({ access_token: 'unexpected-token', expires_in: 3600 })
    })
    const service = createService(root, async () => accountTargets(root))
    const state = await service.refresh({ provider: 'gemini', force: true })
    expect(state.providers.find((snapshot) => snapshot.provider === 'gemini')).toMatchObject({
      status: 'unavailable',
      error: 'Gemini CLI OAuth polling is disabled; enable it to read Gemini usage.'
    })
    expect(calls).toBe(0)
    expect(readFileSync(credential.path, 'utf8')).toBe(credential.bytes)
  })

  test('refreshes expired Gemini CLI OAuth only after explicit opt-in', async () => {
    const root = fixtureRoot()
    const credential = putGeminiCredentialFixture(root, Date.now() - 1_000)
    const urls: string[] = []
    globalThis.fetch = fetchMock(async (input) => {
      const url = String(input)
      urls.push(url)
      if (url === 'https://oauth2.googleapis.com/token') {
        return Response.json({ access_token: 'fresh-access-token', refresh_token: 'rotated-refresh-token', expires_in: 3600 })
      }
      if (url === 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist') {
        return Response.json({ cloudaicompanionProject: 'fixture-project' })
      }
      return Response.json({ buckets: [{ modelId: 'gemini-2.5-pro', remainingFraction: 0.4, resetTime: '2026-10-27T13:00:00.000Z' }] })
    })
    const service = createService(root, async () => accountTargets(root), { 'gemini-cli-oauth-enabled': true })
    const state = await service.refresh({ provider: 'gemini', force: true })
    expect(urls).toEqual([
      'https://oauth2.googleapis.com/token',
      'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
      'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota'
    ])
    expect(state.providers.find((snapshot) => snapshot.provider === 'gemini')).toMatchObject({
      status: 'ok',
      session: { usedPercent: 60 }
    })
    expect(readFileSync(credential.path, 'utf8')).toContain('rotated-refresh-token')
    expect(statSync(credential.path).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(state)).not.toContain('fresh-access-token')
    expect(JSON.stringify(state)).not.toContain('rotated-refresh-token')
  })

  test('parses Retry-After and retains quota for 24 hours after rate limiting', async () => {
    const root = fixtureRoot()
    const target = accountTargets(root)
    const home = target.find((item) => item.provider === 'claude')?.home
    if (!home) throw new Error('Claude fixture home is missing')
    putClaudeCredential(home, 'test-token-rate-limited')
    let now = Date.parse('2026-10-27T12:00:00.000Z')
    Date.now = () => now
    const results = [
      claudeResponse(66),
      new Response('', { status: 429, headers: { 'Retry-After': '120' } }),
      new Response('', { status: 429, headers: { 'Retry-After': new Date(now + 60_000).toUTCString() } }),
      new Response('', { status: 429, headers: { 'Retry-After': '1' } })
    ]
    globalThis.fetch = fetchMock(async () => results.shift() ?? new Response('', { status: 429 }))
    const service = createService(root, async () => target)
    await service.refresh({ provider: 'claude', force: true })
    now += 5_000
    const stale = await service.refresh({ provider: 'claude', force: true })
    const snapshot = stale.providers.find((item) => item.provider === 'claude')
    expect(snapshot?.status).toBe('error')
    expect(snapshot?.session?.usedPercent).toBe(66)
    expect(snapshot?.usageMetadata?.retryAtMs).toBe(now + 120_000)
    now += 23 * 60 * 60_000
    const stillStale = await service.refresh({ provider: 'claude', force: true })
    expect(stillStale.providers.find((item) => item.provider === 'claude')?.session?.usedPercent).toBe(66)
    now += 60 * 60_000
    const expired = await service.refresh({ provider: 'claude', force: true })
    expect(expired.providers.find((item) => item.provider === 'claude')?.session).toBeNull()
  })

  test('stores configurable credentials with private permissions and never returns values', async () => {
    const root = fixtureRoot()
    const service = createService(root, async () => accountTargets(root))
    const credentials = [
      ['minimax', 'api-key', 'mm-secret'],
      ['minimax', 'cookie', 'mm-cookie=_token=secret'],
      ['minimax', 'group-id', 'mm-group'],
      ['minimax', 'model', 'general'],
      ['minimax', 'base-url', 'https://platform.minimax.io'],
      ['opencode-go', 'api-key', 'opencode-secret'],
      ['opencode-go', 'cookie', 'auth=opencode-cookie'],
      ['zcode', 'api-key', 'zcode-secret'],
      ['zcode', 'base-url', 'https://api.z.ai']
    ] as const
    for (const [provider, kind, value] of credentials) {
      expect(service.setCredential({ provider, kind, value })).toEqual({
        provider,
        kind,
        configured: true,
        readable: true
      })
    }
    expect(service.credentialStatus()).toHaveLength(credentials.length)
    expect(JSON.stringify(service.state())).not.toContain('secret')
    const files = readdirSync(join(root, 'quirky-home', 'plugin-data', 'quirky.accounts'))
    const credentialFile = files.map((name) => join(root, 'quirky-home', 'plugin-data', 'quirky.accounts', name)).find((path) => readFileSync(path, 'utf8').includes('mm-secret'))
    if (!credentialFile) throw new Error('Credential file was not persisted')
    expect(statSync(credentialFile).mode & 0o777).toBe(0o600)
    expect(() => service.setCredential({ provider: 'minimax', kind: 'base-url', value: 'https://example.invalid' })).toThrow()
    expect(() => service.setCredential({ provider: 'claude', kind: 'api-key', value: 'not-supported' })).toThrow()
    expect(service.clearCredential({ provider: 'opencode-go', kind: 'api-key' })).toEqual({
      provider: 'opencode-go',
      kind: 'api-key',
      configured: false,
      readable: true
    })
    expect(JSON.stringify(service.credentialStatus())).not.toContain('opencode-secret')
  })

  test('configures, refreshes, and clears MiniMax, OpenCode Go, and ZCode credentials', async () => {
    const root = fixtureRoot()
    const service = createService(root, async () => accountTargets(root))
    service.setCredential({ provider: 'minimax', kind: 'api-key', value: 'minimax-key' })
    service.setCredential({ provider: 'opencode-go', kind: 'api-key', value: 'opencode-key' })
    service.setCredential({ provider: 'zcode', kind: 'api-key', value: 'zcode-key' })
    service.setCredential({ provider: 'zcode', kind: 'base-url', value: 'https://api.z.ai' })
    const urls: string[] = []
    globalThis.fetch = fetchMock(async (input) => {
      const url = String(input)
      urls.push(url)
      if (url.includes('minimax.io')) {
        return Response.json({ base_resp: { status_code: 0 }, model_remains: [{ model_name: 'general', current_interval_remaining_percent: 60, start_time: 0, end_time: Date.now() + 60_000 }] })
      }
      if (url.includes('opencode.ai/zen/go/v1/usage')) {
        return Response.json({ usage: { rolling: { percent: 20 }, weekly: { percent: 30 } } })
      }
      if (url.includes('api.z.ai')) {
        return Response.json({ success: true, code: 200, data: { limits: [{ type: 'TOKENS_LIMIT', unit: 6, number: 1, usage: 100, currentValue: 40 }] } })
      }
      throw new Error('Unexpected provider URL')
    })
    for (const provider of ['minimax', 'opencode-go', 'zcode']) {
      const state = await service.refresh({ provider, force: true })
      expect(state.providers.find((snapshot) => snapshot.provider === provider)?.status).toBe('ok')
    }
    expect(urls).toHaveLength(3)
    expect(JSON.stringify(service.state())).not.toContain('minimax-key')
    expect(JSON.stringify(service.state())).not.toContain('opencode-key')
    expect(JSON.stringify(service.state())).not.toContain('zcode-key')
    service.clearCredential({ provider: 'minimax', kind: 'api-key' })
    service.clearCredential({ provider: 'opencode-go', kind: 'api-key' })
    service.clearCredential({ provider: 'zcode', kind: 'api-key' })
    service.clearCredential({ provider: 'zcode', kind: 'base-url' })
    globalThis.fetch = fetchMock(async () => { throw new Error('No credential should make a network request') })
    for (const provider of ['minimax', 'opencode-go', 'zcode']) {
      const state = await service.refresh({ provider, force: true })
      expect(state.providers.find((snapshot) => snapshot.provider === provider)?.status).toBe('unavailable')
    }
  })

  test('reads the active OpenCode Go API key from its read-only credential database', async () => {
    const root = fixtureRoot()
    const home = join(root, 'home')
    const dataDirectory = join(home, '.local', 'share', 'opencode')
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 })
    const databasePath = join(dataDirectory, 'opencode.db')
    const database = new Database(databasePath)
    database.exec('CREATE TABLE credential (integration_id TEXT, active INTEGER, time_created INTEGER, value TEXT)')
    database.prepare('INSERT INTO credential (integration_id, active, time_created, value) VALUES (?, ?, ?, ?)').run(
      'opencode-go',
      1,
      Date.now(),
      JSON.stringify({ type: 'api', key: 'native-opencode-key' })
    )
    database.close()
    chmodSync(databasePath, 0o600)
    const opencode = join(root, 'bin', 'opencode')
    writeFileSync(opencode, '#!/bin/sh\nprintf \'opencode v2.0.0\\n\'\n', { mode: 0o700 })
    chmodSync(opencode, 0o700)
    let authorization = ''
    globalThis.fetch = fetchMock(async (input, init) => {
      expect(String(input)).toContain('opencode.ai/zen/go/v1/usage')
      authorization = new Headers(init?.headers).get('Authorization') ?? ''
      return Response.json({ usage: { rolling: { percent: 15 }, weekly: { percent: 27 } } })
    })
    const service = createService(root, async () => accountTargets(root))
    const state = await service.refresh({ provider: 'opencode-go', force: true })
    expect(authorization).toBe('Bearer native-opencode-key')
    expect(state.providers.find((snapshot) => snapshot.provider === 'opencode-go')).toMatchObject({
      status: 'ok',
      usageMetadata: { credentialSource: 'opencode-credential-database' }
    })
    expect(JSON.stringify(state)).not.toContain('native-opencode-key')
  })

  test('falls through a denied Cursor Keychain read to the working CLI credential', async () => {
    const root = fixtureRoot()
    const cursorDir = cursorDirectories(join(root, 'home')).cli
    mkdirSync(cursorDir, { recursive: true, mode: 0o700 })
    const token = cursorJwt(Math.floor((Date.now() + 60 * 60_000) / 1000))
    writeFileSync(join(cursorDir, 'auth.json'), JSON.stringify({ accessToken: token }), { mode: 0o600 })
    const security = join(root, 'bin', 'security')
    writeFileSync(security, '#!/bin/sh\necho keychain locked >&2\nexit 1\n', { mode: 0o700 })
    chmodSync(security, 0o700)
    globalThis.fetch = fetchMock(async () => Response.json({ isUnlimited: true, membershipType: 'pro' }))
    const service = createService(root, async () => accountTargets(root))
    const state = await service.refresh({ provider: 'cursor', force: true })
    expect(state.providers.find((snapshot) => snapshot.provider === 'cursor')).toMatchObject({
      status: 'ok',
      planType: 'pro',
      usageMetadata: { credentialSource: 'cli' }
    })
    expect(JSON.stringify(state)).not.toContain(token)
  })

  test('falls through an expired Cursor CLI token to the read-only IDE SQLite credential', async () => {
    const root = fixtureRoot()
    const home = join(root, 'home')
    const { cli, ide } = cursorDirectories(home)
    const cursorDir = cli
    const databasePath = join(ide, 'User', 'globalStorage', 'state.vscdb')
    mkdirSync(cursorDir, { recursive: true, mode: 0o700 })
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
    writeFileSync(join(cursorDir, 'auth.json'), JSON.stringify({ accessToken: cursorJwt(Math.floor((Date.now() - 60_000) / 1000)) }), { mode: 0o600 })
    const database = new Database(databasePath)
    database.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)')
    database.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('cursorAuth/accessToken', cursorJwt(Math.floor((Date.now() + 60 * 60_000) / 1000)))
    database.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('cursorAuth/cachedEmail', 'fixture@example.invalid')
    database.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('cursorAuth/stripeMembershipType', 'pro')
    database.close()
    globalThis.fetch = fetchMock(async () => Response.json({ isUnlimited: true, membershipType: 'pro' }))
    const service = createService(root, async () => accountTargets(root))
    const state = await service.refresh({ provider: 'cursor', force: true })
    expect(state.providers.find((snapshot) => snapshot.provider === 'cursor')).toMatchObject({
      status: 'ok',
      usageMetadata: { credentialSource: 'desktop' }
    })
    expect(JSON.stringify(state)).not.toContain('fixture@example.invalid')
  })

  test('rejects a stale reset confirmation and binds a request ID permanently to its first account scope', async () => {
    const root = fixtureRoot()
    const profileA = join(root, 'profiles', 'codex-a')
    const profileB = join(root, 'profiles', 'codex-b')
    mkdirSync(profileA, { recursive: true, mode: 0o700 })
    mkdirSync(profileB, { recursive: true, mode: 0o700 })
    writeFileSync(join(profileA, 'auth.json'), JSON.stringify({ tokens: { access_token: 'codex-token-a', account_id: 'openai-a' } }), { mode: 0o600 })
    writeFileSync(join(profileB, 'auth.json'), JSON.stringify({ tokens: { access_token: 'codex-token-b', account_id: 'openai-b' } }), { mode: 0o600 })
    const bin = join(root, 'bin')
    const codex = join(bin, 'codex')
    writeFileSync(
      codex,
      `#!/bin/sh\nwhile IFS= read -r line; do\n  case "$line" in\n    *'"method":"initialize"'*) printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{}}' ;;\n    *'"method":"account/rateLimits/read"'*) printf '%s\\n' '{"jsonrpc":"2.0","id":2,"result":{"rateLimits":{"primary":{"usedPercent":25,"windowDurationMins":300,"resetsAt":1793120400},"secondary":{"usedPercent":40,"windowDurationMins":10080,"resetsAt":1793725200}},"planType":"plus","rateLimitResetCredits":{"availableCount":1,"totalEarnedCount":1,"credits":[{"status":"available","expiresAt":1793120400,"grantedAt":1793000000}]}}}' ;;\n  esac\ndone\n`,
      { mode: 0o700 }
    )
    chmodSync(codex, 0o700)
    let current = accountTargets(root, 'codex-a', 31)
    current = current.map((target) => target.provider === 'codex' ? { ...target, home: profileA } : target)
    const service = createService(root, async () => current)
    let requests = 0
    let authUsed = ''
    globalThis.fetch = fetchMock(async (_input, init) => {
      requests += 1
      authUsed = new Headers(init?.headers).get('Authorization') ?? ''
      return Response.json({ code: 'reset' })
    })
    const firstState = await service.refresh({ provider: 'codex', force: true })
    const firstOffer = firstState.providers.find((snapshot) => snapshot.provider === 'codex')
    const firstScope = firstOffer?.rateLimitResetCredits?.expectedScope
    expect(firstScope).toEqual({
      accountId: 'codex-a',
      accountRevision: 31,
      offerRevision: expect.any(String)
    })
    expect(await service.consumeResetCredit({ idempotencyKey: 'request-1', expectedScope: firstScope!, yes: true })).toBe('reset')
    expect(authUsed).toBe('Bearer codex-token-a')

    current = accountTargets(root, 'codex-b', 32).map((target) => target.provider === 'codex' ? { ...target, home: profileB } : target)
    const secondState = await service.refresh({ provider: 'codex', force: true })
    const secondScope = secondState.providers.find((snapshot) => snapshot.provider === 'codex')?.rateLimitResetCredits?.expectedScope
    expect(secondScope?.accountId).toBe('codex-b')
    await expect(service.consumeResetCredit({ idempotencyKey: 'request-1', expectedScope: secondScope!, yes: true })).rejects.toThrow()
    await expect(service.consumeResetCredit({ idempotencyKey: 'request-2', expectedScope: firstScope!, yes: true })).rejects.toThrow()
    expect(requests).toBe(1)
  })
})
