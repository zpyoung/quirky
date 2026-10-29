import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { QuirkyClient, type CliContext, type QuirkyEvent } from '@quirky/protocol'
import { startHarness, type Harness } from '../../../../packages/daemon/test/helpers'

export const PLUGIN_DIR = resolve(import.meta.dir, '../..')

const harnesses = new Set<Harness>()
const tempDirs: string[] = []
const originalEnv = new Map<string, string | undefined>()
const PROVIDER_ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'GROK_HOME', 'GROK_CLI_CHAT_PROXY_BASE_URL', 'KIMI_CODE_HOME', 'KIMI_CODE_BASE_URL', 'OPENCODE_API_KEY', 'OPENCODE_AUTH_CONTENT', 'OPENCODE_DB', 'OPENCODE_CONFIG_DIR']
const ENV_KEYS = ['HOME', 'QUIRKY_HOME', 'PATH', 'QUIRKY_AGENT_SEARCH_DIRS', 'ZDOTDIR', 'ENV', 'BASH_ENV', ...PROVIDER_ENV_KEYS, 'ACCOUNTS_FAKE_LOGIN_MODE', 'ACCOUNTS_FAKE_EMAIL', 'ACCOUNTS_SECURITY_LOG']

let savedFetch: typeof fetch | null = null
const activeFetches = new Set<Promise<Response>>()

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

function providerFixture(url: URL): Response | null {
  const now = Date.now()
  const resetAt = new Date(now + 60 * 60_000).toISOString()
  const resetAtSeconds = Math.floor(Date.parse(resetAt) / 1000)
  if (url.hostname === 'api.anthropic.com' && url.pathname === '/api/oauth/usage') {
    return jsonResponse({
      five_hour: { utilization: 25, resets_at: resetAt },
      seven_day: { utilization: 10, resets_at: resetAt },
      spend: { enabled: false }
    })
  }
  if (url.hostname === 'chatgpt.com' && url.pathname === '/backend-api/wham/usage') {
    return jsonResponse({
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_at: resetAtSeconds },
        secondary_window: { used_percent: 15, limit_window_seconds: 604_800, reset_at: resetAtSeconds },
        rate_limit_reset_credits: { available_count: 1, total_earned_count: 1 }
      }
    })
  }
  if (url.hostname === 'chatgpt.com' && url.pathname === '/backend-api/wham/rate-limit-reset-credits') {
    return jsonResponse({ available_count: 1, total_earned_count: 1, credits: [{ status: 'available', expires_at: resetAtSeconds }] })
  }
  if (url.hostname === 'chatgpt.com' && url.pathname === '/backend-api/wham/rate-limit-reset-credits/consume') {
    return jsonResponse({ code: 'reset' })
  }
  if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') {
    return jsonResponse({ access_token: 'fixture-gemini-access-token', expires_in: 3600 })
  }
  if (url.hostname === 'cloudcode-pa.googleapis.com' && url.pathname === '/v1internal:loadCodeAssist') {
    return jsonResponse({ cloudaicompanionProject: 'fixture-project' })
  }
  if (url.hostname === 'cloudcode-pa.googleapis.com' && url.pathname === '/v1internal:retrieveUserQuota') {
    return jsonResponse({ buckets: [{ modelId: 'gemini-2.5-pro', remainingFraction: 0.75, resetTime: resetAt }] })
  }
  if (url.hostname === 'api.kimi.com' && url.pathname === '/coding/v1/usages') {
    return jsonResponse({ usage: { limit: 100, used: 25, resetTime: resetAt }, limits: [] })
  }
  if (['platform.minimax.io', 'www.minimaxi.com'].includes(url.hostname) && url.pathname === '/v1/api/openplatform/coding_plan/remains') {
    return jsonResponse({
      base_resp: { status_code: 0 },
      model_remains: [{
        model_name: 'general',
        current_interval_remaining_percent: 75,
        start_time: resetAtSeconds - 18_000,
        end_time: resetAtSeconds,
        current_weekly_remaining_percent: 60,
        weekly_remains_time: 60 * 60_000
      }]
    })
  }
  if (url.hostname === 'opencode.ai' && url.pathname === '/zen/go/v1/usage') {
    return jsonResponse({ usage: { rolling: { percent: 20, resetsAt: resetAt }, weekly: { percent: 10, resetsAt: resetAt } } })
  }
  if (url.hostname === 'opencode.ai' && url.pathname === '/_server') {
    return new Response('const workspaces = [{ id: \"org_fixture\" }];', { status: 200, headers: { 'content-type': 'text/javascript' } })
  }
  if (url.hostname === 'opencode.ai' && url.pathname === '/console/api/go/status') {
    return jsonResponse({ usage: { rolling: { percent: 20, resetsAt: resetAt }, weekly: { percent: 10, resetsAt: resetAt } } })
  }
  if (url.hostname === 'opencode.ai' && url.pathname === '/console/api/billing/status') {
    return jsonResponse({ billingMode: 'prepaid', mode: 'pay-as-you-go', balanceMicroCents: '100000000' })
  }
  if (url.hostname === 'cursor.com' && url.pathname === '/api/usage-summary') {
    return jsonResponse({ isUnlimited: true, membershipType: 'fixture' })
  }
  if (url.hostname === 'cursor.com' && url.pathname === '/api/usage') {
    return jsonResponse({ 'gpt-4': { numRequests: 25, maxRequestUsage: 100 } })
  }
  if (url.hostname === 'cli-chat-proxy.grok.com' && url.pathname.endsWith('/billing')) {
    return jsonResponse({ config: { creditUsagePercent: 25, currentPeriod: { end: resetAt } } })
  }
  if (['api.z.ai', 'open.bigmodel.cn', 'dev.bigmodel.cn'].includes(url.hostname) && url.pathname === '/api/monitor/usage/quota/limit') {
    return jsonResponse({ success: true, code: 0, data: { limits: [{ type: 'TOKENS_LIMIT', usage: 25, total: 100, unit: 6, number: 1, nextResetTime: resetAt }], level: 'fixture' } })
  }
  return null
}

function installProviderFetch(): void {
  if (savedFetch !== null) return
  const original = globalThis.fetch
  savedFetch = original
  const isolated: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = (async () => {
        const text = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        const url = new URL(text)
        if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)) {
          return original(input, init)
        }
        const response = providerFixture(url)
        if (response === null) throw new Error('Unexpected external provider request blocked by isolated account fixtures.')
        return response
      })()
      activeFetches.add(request)
      try {
        return await request
      } finally {
        activeFetches.delete(request)
      }
    },
    { preconnect: original.preconnect }
  )
  globalThis.fetch = isolated
}

async function restoreProviderFetch(): Promise<void> {
  if (savedFetch === null) return
  while (activeFetches.size > 0) await Promise.allSettled([...activeFetches])
  globalThis.fetch = savedFetch
  savedFetch = null
}

const fakeProvider = String.raw`#!${process.execPath}
const { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')
const provider = process.argv[1].split('/').pop()
const mode = process.env.ACCOUNTS_FAKE_LOGIN_MODE || 'complete'
const email = process.env.ACCOUNTS_FAKE_EMAIL || (provider === 'claude' ? 'claude@example.test' : 'codex@example.test')
const url = provider === 'claude'
  ? 'https://claude.ai/oauth/authorize?client_id=fixture&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback&state=fixture'
  : 'https://auth.openai.com/oauth/authorize?client_id=fixture&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fcallback&state=fixture'
const home = provider === 'claude' ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME
const waitForRelease = async () => {
  while (!existsSync(join(home, '.fixture-release-login'))) await new Promise((resolve) => setTimeout(resolve, 20))
}
const writeClaudeAuth = () => {
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email, organizationUuid: 'fixture-org', organizationName: 'Fixture Org' } }))
  writeFileSync(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-claude-token', refreshToken: 'fixture-claude-refresh' } }), { mode: 0o600 })
  chmodSync(join(home, '.credentials.json'), 0o600)
}
const writeCodexAuth = () => {
  mkdirSync(home, { recursive: true })
  const claims = { email, 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-workspace' }, 'https://api.openai.com/profile': { email } }
  const token = 'header.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.signature'
  const authPath = join(home, 'auth.json')
  writeFileSync(authPath, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'fixture-codex-token-' + Date.now(), id_token: token, account_id: 'fixture-workspace' } }), { mode: 0o600 })
  chmodSync(authPath, 0o600)
}
const writeAuth = provider === 'claude' ? writeClaudeAuth : writeCodexAuth
const run = async () => {
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    process.stdout.write(provider === 'claude' ? 'Claude Code 2.1.80\\n' : 'codex 1.0.0\\n')
    return
  }
  if (process.argv.includes('__route')) {
    process.stdout.write('ROUTE:' + provider + ':' + (process.env.CLAUDE_CONFIG_DIR || process.env.CODEX_HOME || '') + '\\n')
    return
  }
  if (!process.argv.includes('login')) return
  if (provider === 'codex') {
    let config
    try {
      config = readFileSync(join(home, 'config.toml'), 'utf8')
    } catch {
      process.stderr.write('managed CODEX_HOME is missing its private file credential-store setting\\n')
      process.exitCode = 8
      return
    }
    if (!/^\s*cli_auth_credentials_store\s*=\s*"file"\s*$/m.test(config)) {
      process.stderr.write('managed CODEX_HOME is not configured for file credential storage\\n')
      process.exitCode = 8
      return
    }
  }
  if (provider === 'codex') process.stdout.write('Navigate to this URL to authenticate: ' + url + '\\n')
  if (provider === 'claude' && process.env.BROWSER) spawnSync(process.env.BROWSER, [url], { stdio: 'ignore' })
  if (mode === 'failure') {
    process.stderr.write('fixture login failed\n')
    process.exitCode = 7
    return
  }
  if (mode === 'auth-written-await') writeAuth()
  if (mode === 'pending' || mode === 'auth-written-await') await waitForRelease()
  if (mode !== 'pending' && mode !== 'auth-written-await') writeAuth()
}
void run()
`

const fakeSecurity = String.raw`#!/bin/sh
printf '%s\n' "$*" >> "$ACCOUNTS_SECURITY_LOG"
case "$1" in
  find-generic-password) exit 44 ;;
  delete-generic-password) exit 44 ;;
  *) exit 2 ;;
esac
`

function rememberEnvironment(): void {
  if (originalEnv.size !== 0) return
  for (const key of ENV_KEYS) originalEnv.set(key, process.env[key])
}

function executable(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: 0o700 })
  chmodSync(path, 0o700)
}

export type AccountsHarness = {
  home: string
  userHome: string
  fakeBin: string
  harness: Harness
  client: QuirkyClient
  events: QuirkyEvent[]
  setLoginMode(mode: 'complete' | 'pending' | 'auth-written-await' | 'failure', email?: string): void
  managedHome(provider: 'claude' | 'codex', accountId: string): string
  releaseLogin(provider: 'claude' | 'codex', accountId: string): void
}

export type AccountsOptions = { plugins?: string[]; uiDir?: string }

export async function startAccounts(options: AccountsOptions = {}): Promise<AccountsHarness> {
  rememberEnvironment()
  const home = mkdtempSync(join(tmpdir(), 'quirky-accounts-'))
  const userHome = join(home, 'user-home')
  const fakeBin = join(home, 'fake-bin')
  const builtinPluginsDir = mkdtempSync(join(tmpdir(), 'quirky-accounts-builtins-'))
  tempDirs.push(home, builtinPluginsDir)
  mkdirSync(userHome, { recursive: true, mode: 0o700 })
  mkdirSync(fakeBin, { recursive: true, mode: 0o700 })
  const securityLog = join(home, 'security.log')
  executable(join(fakeBin, 'claude'), fakeProvider)
  executable(join(fakeBin, 'codex'), fakeProvider)
  executable(join(fakeBin, 'security'), fakeSecurity)
  symlinkSync(PLUGIN_DIR, join(builtinPluginsDir, 'quirky.accounts'))
  symlinkSync(resolve(PLUGIN_DIR, '../quirky.ask'), join(builtinPluginsDir, 'quirky.ask'))
  const requestedPlugins = new Set(options.plugins ?? [])
  if (requestedPlugins.has('quirky.worktree')) requestedPlugins.add('quirky.cli')
  for (const plugin of requestedPlugins) {
    symlinkSync(resolve(PLUGIN_DIR, `../${plugin}`), join(builtinPluginsDir, plugin))
  }
  process.env.HOME = userHome
  process.env.QUIRKY_HOME = home
  process.env.PATH = `${fakeBin}:${originalEnv.get('PATH') ?? ''}`
  process.env.QUIRKY_AGENT_SEARCH_DIRS = fakeBin
  for (const key of PROVIDER_ENV_KEYS) delete process.env[key]
  delete process.env.ZDOTDIR
  delete process.env.ENV
  delete process.env.BASH_ENV
  process.env.ACCOUNTS_FAKE_LOGIN_MODE = 'complete'
  process.env.ACCOUNTS_FAKE_EMAIL = ''
  process.env.ACCOUNTS_SECURITY_LOG = securityLog
  installProviderFetch()
  const harness = await startHarness({
    home,
    builtinPluginsDir,
    ...(options.uiDir === undefined ? {} : { uiDir: options.uiDir })
  })
  harnesses.add(harness)
  const client = await harness.connect('cli', 'accounts-test')
  const events: QuirkyEvent[] = []
  client.onEvent((event) => events.push(event))
  await client.call('events.subscribe', {})
  return {
    home,
    userHome,
    fakeBin,
    harness,
    client,
    events,
    setLoginMode(mode, email = '') {
      process.env.ACCOUNTS_FAKE_LOGIN_MODE = mode
      process.env.ACCOUNTS_FAKE_EMAIL = email
    },
    managedHome(provider, accountId) {
      const path = join(home, 'plugin-data', 'quirky.accounts', 'profiles', provider, accountId, 'home')
      try {
        return realpathSync.native(path)
      } catch {
        return path
      }
    },
    releaseLogin(provider, accountId) {
      writeFileSync(join(home, 'plugin-data', 'quirky.accounts', 'profiles', provider, accountId, 'home', '.fixture-release-login'), 'ok')
    }
  }
}

export async function cleanupAll(): Promise<void> {
  for (const harness of [...harnesses]) {
    await harness.cleanup()
    harnesses.delete(harness)
  }
  await restoreProviderFetch()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  originalEnv.clear()
}

export async function waitForAsync<T>(check: () => Promise<T | undefined | null | false>, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await Bun.sleep(20)
  }
  throw new Error('Timed out waiting for account state')
}

export function testCli(client: QuirkyClient): { ctx: CliContext; lines: unknown[] } {
  const lines: unknown[] = []
  return {
    lines,
    ctx: {
      requestBase: crypto.randomUUID(),
      call: (method, params = {}) => client.callAny(method, params),
      out: {
        json: true,
        result: (value) => void lines.push(value),
        line: (text) => void lines.push(text),
        jsonLine: (value) => void lines.push(value)
      },
      format: { table: () => '', record: () => '' },
      env: {},
      cwd: process.cwd(),
      readFile: async (path) => await Bun.file(path).text(),
      sleep: (ms) => Bun.sleep(ms),
      now: Date.now,
      usage: (message) => Object.assign(new Error(message), { exit: 2 }),
      fail: (message) => Object.assign(new Error(message), { exit: 1 }),
      reconnect: async () => undefined
    }
  }
}

export function defaultHome(home: string, provider: 'claude' | 'codex'): string {
  return provider === 'claude' ? join(home, 'user-home', '.claude') : join(home, 'user-home', '.codex')
}
