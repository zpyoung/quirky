import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import { isAbsolute, join, resolve } from 'node:path'
import { mapCursorUsage, mapGrokUsage, mapMiniMaxUsage, mapOpenCodeGoUsage, mapZcodeUsage } from './mappers'
import { readStoredCredential, type CredentialRead } from './credentials'
import { errorSnapshot, finiteNumber, parseRetryAfterMs, readJsonFile, record, responseFailure, responseJson } from './provider-utils'
import type { ProviderRuntime } from './process'
import type { ProviderSnapshot, UsageFailureKind } from './types'
import { homeDirectory } from './credentials'

const MINIMAX_USAGE_PATH = '/v1/api/openplatform/coding_plan/remains'
const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'
const OPENCODE_SERVER_URL = 'https://opencode.ai/_server'
const OPENCODE_WORKSPACES_SERVER_ID = 'def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f'
const CURSOR_ORIGIN = 'https://cursor.com'
const ZCODE_HOSTS = ['api.z.ai', 'open.bigmodel.cn', 'dev.bigmodel.cn']
const MINIMAX_HOSTS = ['platform.minimax.io', 'www.minimaxi.com']

type KeychainPassword = (service: string, account: string) => Promise<CredentialRead>

function safeProviderError(provider: 'opencode-go' | 'minimax' | 'grok' | 'cursor' | 'zcode', runtime: ProviderRuntime, message: string, kind: UsageFailureKind, status: 'error' | 'unavailable' = 'error'): ProviderSnapshot {
  return errorSnapshot(provider, runtime.now(), message, kind, status)
}

function allowedOrigin(value: string | null, provider: 'zcode' | 'minimax', fallback: string): string | null {
  if (!value) return fallback
  try {
    const parsed = new URL(value)
    const allowed = provider === 'zcode' ? ZCODE_HOSTS : MINIMAX_HOSTS
    if (parsed.protocol !== 'https:' || !allowed.includes(parsed.hostname.toLowerCase()) || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '' && parsed.pathname !== '/') || (parsed.port !== '' && parsed.port !== '443')) return null
    return parsed.origin
  } catch {
    return null
  }
}

function minimaxCredential(dataDir: string, kind: 'api-key' | 'cookie' | 'group-id' | 'model' | 'base-url'): string | null {
  return readStoredCredential(dataDir, 'minimax', kind)
}

function cleanCookie(raw: string): string {
  const normalized = raw.trim()
  if (!normalized) return ''
  if (normalized.includes(';') || /^(?:_token|Authorization|authorization)=/i.test(normalized)) return normalized
  if (/^[A-Za-z0-9._-]+$/.test(normalized)) return `_token=${normalized}`
  return normalized
}

function cookieValue(cookie: string, name: string): string | null {
  for (const part of cookie.split(';')) {
    const equal = part.indexOf('=')
    if (equal < 0 || part.slice(0, equal).trim() !== name) continue
    const value = part.slice(equal + 1).trim()
    if (value) return value
  }
  return null
}

export async function fetchMiniMaxUsage(runtime: ProviderRuntime, dataDir: string): Promise<ProviderSnapshot> {
  const apiKey = minimaxCredential(dataDir, 'api-key')
  const rawCookie = minimaxCredential(dataDir, 'cookie')
  const groupId = minimaxCredential(dataDir, 'group-id')
  const models = minimaxCredential(dataDir, 'model') ?? 'general'
  const origin = allowedOrigin(minimaxCredential(dataDir, 'base-url'), 'minimax', 'https://platform.minimax.io')
  if (!origin) return safeProviderError('minimax', runtime, 'MiniMax base URL is not allowlisted', 'usage-unavailable')
  if (!apiKey && !rawCookie) return safeProviderError('minimax', runtime, 'MiniMax credentials are not configured', 'missing-credentials', 'unavailable')
  const cookie = rawCookie ? cleanCookie(rawCookie) : ''
  if (!apiKey && !cookieValue(cookie, '_token')) return safeProviderError('minimax', runtime, 'MiniMax auth cookie is invalid', 'missing-credentials')
  const endpoint = `${origin}${MINIMAX_USAGE_PATH}`
  const apiResult = async (): Promise<ProviderSnapshot> => {
    const response = await runtime.fetch(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      redirect: 'error',
      credentials: 'omit'
    })
    if (!response.ok) {
      const result = responseFailure('minimax', response, runtime.now(), {
        rateLimited: 'MiniMax usage is rate limited',
        unauthorized: 'MiniMax API key expired. Replace it in Settings.',
        generic: `MiniMax usage fetch failed (HTTP ${response.status})`
      }, { source: 'web', credentialSource: 'api-key' })
      return result
    }
    const mapped = mapMiniMaxUsage(await responseJson(response), models.split(',').map((item) => item.trim()).filter(Boolean), runtime.now())
    return {
      ...mapped,
      usageMetadata: { source: 'web', attemptedSources: ['web'], ...(mapped.status === 'ok' ? { lastSuccessfulSource: 'web' as const } : {}), credentialSource: 'api-key' }
    }
  }
  const cookieResult = async (): Promise<ProviderSnapshot> => {
    const mode = origin === 'https://www.minimaxi.com' ? 'cn' : 'overseas'
    const referer = mode === 'cn' ? 'https://platform.minimaxi.com/console/usage' : 'https://platform.minimax.io/console/usage'
    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: referer,
      'User-Agent': process.platform === 'win32'
        ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0'
        : process.platform === 'darwin'
          ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0'
          : 'Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0',
      Cookie: cookie
    }
    const resolvedGroup = groupId ?? cookieValue(cookie, 'minimax_group_id_v2')
    if (resolvedGroup) headers['X-Group-Id'] = resolvedGroup
    const response = await runtime.fetch(endpoint, { method: 'GET', headers, redirect: 'error', credentials: 'omit' })
    if (!response.ok) {
      return responseFailure('minimax', response, runtime.now(), {
        rateLimited: 'MiniMax usage is rate limited',
        unauthorized: 'MiniMax session cookie expired. Replace it in Settings.',
        generic: `MiniMax usage fetch failed (HTTP ${response.status})`
      }, { source: 'web', credentialSource: 'session-cookie' })
    }
    const mapped = mapMiniMaxUsage(await responseJson(response), models.split(',').map((item) => item.trim()).filter(Boolean), runtime.now())
    return { ...mapped, usageMetadata: { source: 'web', attemptedSources: ['web'], ...(mapped.status === 'ok' ? { lastSuccessfulSource: 'web' as const } : {}), credentialSource: 'session-cookie' } }
  }
  try {
    if (apiKey) {
      const result = await apiResult()
      if (result.status === 'ok' || !rawCookie || result.usageMetadata?.failureKind !== 'stale-token') return result
    }
    return await cookieResult()
  } catch {
    return safeProviderError('minimax', runtime, 'MiniMax usage request failed', runtime.signal.aborted ? 'usage-unavailable' : 'network')
  }
}

function openCodeAuthFilePath(): string {
  const environment = process.env
  if (environment.APPDATA?.trim()) return join(environment.APPDATA.trim(), 'opencode', 'auth.json')
  const dataHome = environment.XDG_DATA_HOME?.trim() || join(homeDirectory(), '.local', 'share')
  return join(dataHome, 'opencode', 'auth.json')
}

function openCodeDatabasePaths(): { paths: string[]; unreadable: boolean } {
  const environment = process.env
  const dataHome = environment.XDG_DATA_HOME?.trim() || join(homeDirectory(), '.local', 'share')
  const dataDirectory = join(dataHome, 'opencode')
  const selected = environment.OPENCODE_DB?.trim()
  if (selected === ':memory:') return { paths: [], unreadable: false }
  if (selected) {
    const path = isAbsolute(selected) ? resolve(selected) : resolve(dataDirectory, selected)
    return { paths: existsSync(path) ? [path] : [], unreadable: false }
  }
  try {
    const paths = readdirSync(dataDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^opencode(?:-[A-Za-z0-9_.-]+)?\.db$/.test(entry.name))
      .map((entry) => join(dataDirectory, entry.name))
      .sort((left, right) => {
        const leftRank = left.endsWith('/opencode.db') ? 0 : 1
        const rightRank = right.endsWith('/opencode.db') ? 0 : 1
        return leftRank - rightRank || (left < right ? -1 : left > right ? 1 : 0)
      })
    return { paths, unreadable: false }
  } catch {
    return { paths: [], unreadable: false }
  }
}

function readOpenCodeCredentialDatabaseKey(): { key: string | null; unreadable: boolean } {
  const discovered = openCodeDatabasePaths()
  let unreadable = discovered.unreadable
  for (const path of discovered.paths) {
    let database: Database | null = null
    try {
      database = new Database(path, { readonly: true, create: false })
      database.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 250')
      const table = database.query<{ name: unknown }, []>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'credential'`).get()
      if (!table) continue
      const rows = database.query<{ value: unknown }, [string]>(
        'SELECT value FROM credential WHERE integration_id = ? ORDER BY active DESC, time_created DESC LIMIT 8'
      ).all('opencode-go')
      for (const row of rows) {
        if (typeof row.value !== 'string') continue
        try {
          const credential = record(JSON.parse(row.value) as unknown)
          if (credential?.type === 'api' && typeof credential.key === 'string' && credential.key.trim()) {
            return { key: credential.key.trim(), unreadable }
          }
        } catch {
          continue
        }
      }
    } catch {
      unreadable = true
    } finally {
      database?.close()
    }
  }
  return { key: null, unreadable }
}

async function detectOpenCodeBackend(runtime: ProviderRuntime): Promise<'v1' | 'v2' | null> {
  for (const command of ['opencode', 'opencode2']) {
    const result = await runtime.run(command, ['--version'], { timeoutMs: 5_000, maxOutputBytes: 1_024 })
    if (result.code !== 0 || result.timedOut || result.outputLimitExceeded) continue
    const version = /^(?:opencode\s+)?v?([12])\.\d+\.\d+(?:[-+][\w.-]+)?$/i.exec(result.stdout.trim())
    if (version?.[1] === '1') return 'v1'
    if (version?.[1] === '2') return 'v2'
  }
  return null
}

async function readOpenCodeApiKey(runtime: ProviderRuntime): Promise<{ key: string | null; source: string; unreadable: boolean } | null> {
  const environmentKey = process.env.OPENCODE_API_KEY?.trim()
  const inline = process.env.OPENCODE_AUTH_CONTENT
  const authPath = openCodeAuthFilePath()
  const databasePaths = openCodeDatabasePaths()
  const hasAuthFile = existsSync(authPath)
  const backend = databasePaths.paths.length || inline || hasAuthFile
    ? await detectOpenCodeBackend(runtime)
    : null
  let unreadable = false
  if (backend === 'v2' && databasePaths.paths.length > 0) {
    const database = readOpenCodeCredentialDatabaseKey()
    if (database.key) return { key: database.key, source: 'opencode-credential-database', unreadable: false }
    unreadable = database.unreadable
  }
  let inlineConfigured = false
  if (backend === 'v1' && inline) {
    try {
      const parsed: unknown = JSON.parse(inline)
      inlineConfigured = true
      const content = record(parsed)
      const credential = record(content?.['opencode-go'])
      if (credential?.type === 'api' && typeof credential.key === 'string' && credential.key.trim()) {
        return { key: credential.key.trim(), source: 'opencode-auth-content', unreadable }
      }
      if (environmentKey && unreadable) return { key: null, source: 'credential-database-unreadable', unreadable: true }
      if (environmentKey) return { key: environmentKey, source: 'environment', unreadable: false }
      return null
    } catch {
      inlineConfigured = false
    }
  }
  if (backend && !inlineConfigured) {
    const parsed = record(await readJsonFile(authPath, 1_000_000))
    const credential = record(parsed?.['opencode-go'])
    if (credential?.type === 'api' && typeof credential.key === 'string' && credential.key.trim()) {
      return { key: credential.key.trim(), source: 'opencode-auth-file', unreadable }
    }
  }
  if (environmentKey && unreadable) return { key: null, source: 'credential-database-unreadable', unreadable: true }
  if (environmentKey) return { key: environmentKey, source: 'environment', unreadable: false }
  return unreadable ? { key: null, source: 'credential-database-unreadable', unreadable: true } : null
}


function normalizeOpenCodeCookie(raw: string): string {
  const value = raw.trim()
  if (!value) return ''
  if (value.includes(';') || /^(?:auth|__Host-auth|__Host-console_session)=/i.test(value)) return value
  return value.startsWith('Fe26.2**') || /^[A-Za-z0-9.\-_]+$/.test(value) ? `auth=${value}` : value
}

function allowedOpenCodeCookies(raw: string): string {
  return raw.split(';').map((pair) => pair.trim()).filter((pair) => {
    const name = pair.slice(0, pair.indexOf('=')).trim()
    return ['auth', '__Host-auth', '__Host-console_session'].includes(name) && pair.includes('=')
  }).join('; ')
}

function openCodeBillingBalance(value: unknown): ProviderSnapshot['extraUsage'] | undefined {
  const data = record(value)
  if (data?.billingMode !== 'prepaid' || data.mode !== 'pay-as-you-go' || typeof data.balanceMicroCents !== 'string' || !/^-?\d+$/.test(data.balanceMicroCents)) return undefined
  const cents = Number(data.balanceMicroCents)
  if (!Number.isSafeInteger(cents)) return undefined
  return {
    unit: 'currency',
    balance: cents / 100_000_000,
    currencyCode: 'USD',
    enabled: true,
    disabledReason: null,
    spent: null,
    spendLimit: null,
    spentPercent: null,
    resetsAt: null
  }
}

async function fetchOpenCodeCookieUsage(runtime: ProviderRuntime, cookie: string): Promise<ProviderSnapshot> {
  const workspacesResponse = await runtime.fetch(`${OPENCODE_SERVER_URL}?id=${OPENCODE_WORKSPACES_SERVER_ID}`, {
    method: 'GET',
    headers: {
      'X-Server-Id': OPENCODE_WORKSPACES_SERVER_ID,
      'X-Server-Instance': `server-fn:${randomUUID()}`,
      Accept: 'text/javascript, application/json;q=0.9, */*;q=0.8',
      Origin: 'https://opencode.ai',
      Referer: 'https://opencode.ai',
      Cookie: cookie
    },
    redirect: 'error',
    credentials: 'omit'
  })
  if (!workspacesResponse.ok) return responseFailure('opencode-go', workspacesResponse, runtime.now(), { rateLimited: 'OpenCode Go usage is rate limited', unauthorized: 'OpenCode Go sign-in expired', generic: `OpenCode workspace lookup failed (HTTP ${workspacesResponse.status})` }, { source: 'web', credentialSource: 'session-cookie' })
  const text = await workspacesResponse.text()
  const ids = [...text.matchAll(/\bid\s*:\s*["']((?:org|wrk|wk)_[A-Za-z0-9]+)["']/g)].map((match) => match[1]).filter((id, index, list) => typeof id === 'string' && list.indexOf(id) === index)
  if (ids.length === 0) return safeProviderError('opencode-go', runtime, 'No OpenCode workspace was found for this session', 'usage-unavailable')
  let lastFailure: ProviderSnapshot | null = null
  for (const workspaceId of ids) {
    const response = await runtime.fetch('https://opencode.ai/console/api/go/status', {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Origin: 'https://opencode.ai',
        Referer: `https://opencode.ai/console/${workspaceId}/go`,
        'x-org-id': workspaceId,
        Cookie: cookie
      },
      redirect: 'error',
      credentials: 'omit'
    })
    if (!response.ok) {
      lastFailure = responseFailure('opencode-go', response, runtime.now(), { rateLimited: 'OpenCode Go usage is rate limited', unauthorized: 'OpenCode Go session expired', generic: `OpenCode Go usage request failed (HTTP ${response.status})` }, { source: 'web', credentialSource: 'session-cookie' })
      continue
    }
    const mapped = mapOpenCodeGoUsage(await responseJson(response), runtime.now())
    let extraUsage: ProviderSnapshot['extraUsage']
    try {
      const billing = await runtime.fetch('https://opencode.ai/console/api/billing/status', {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Origin: 'https://opencode.ai',
          Referer: `https://opencode.ai/console/${workspaceId}/billing`,
          'x-org-id': workspaceId,
          Cookie: cookie
        },
        redirect: 'error',
        credentials: 'omit'
      })
      if (billing.ok) extraUsage = openCodeBillingBalance(await responseJson(billing))
    } catch {
      // The optional balance request must not discard a usable quota reading.
    }
    if (mapped.status === 'ok') {
      return { ...mapped, ...(extraUsage ? { extraUsage } : {}), usageMetadata: { source: 'web', credentialSource: 'session-cookie', lastSuccessfulSource: 'web' } }
    }
    if (extraUsage) {
      return {
        provider: 'opencode-go',
        accountId: null,
        status: 'ok',
        error: null,
        updatedAt: runtime.now(),
        session: null,
        weekly: null,
        extraUsage,
        usageMetadata: { source: 'web', credentialSource: 'session-cookie', lastSuccessfulSource: 'web' }
      }
    }
    lastFailure = mapped
  }
  return lastFailure ?? safeProviderError('opencode-go', runtime, 'OpenCode Go usage was unavailable', 'usage-unavailable')
}

export async function fetchOpenCodeGoUsage(runtime: ProviderRuntime, dataDir: string): Promise<ProviderSnapshot> {
  const configuredKey = readStoredCredential(dataDir, 'opencode-go', 'api-key')
  const rawCookie = readStoredCredential(dataDir, 'opencode-go', 'cookie')
  const cookie = rawCookie ? allowedOpenCodeCookies(normalizeOpenCodeCookie(rawCookie)) : ''
  let key = configuredKey
  let source = configuredKey ? 'settings' : ''
  if (!key) {
    const native = await readOpenCodeApiKey(runtime)
    if (!cookie && native?.unreadable && !native.key) return safeProviderError('opencode-go', runtime, 'OpenCode credential database could not be read', 'usage-unavailable')
    key = native?.key ?? null
    source = native?.source ?? ''
  }
  if (key) {
    try {
      const response = await runtime.fetch(OPENCODE_GO_USAGE_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        redirect: 'error',
        credentials: 'omit'
      })
      if (response.ok) {
        const mapped = mapOpenCodeGoUsage(await responseJson(response), runtime.now())
        if (mapped.status === 'ok') return { ...mapped, usageMetadata: { source: 'web', attemptedSources: ['web'], lastSuccessfulSource: 'web', credentialSource: source } }
        if (!cookie) return mapped
      } else if (!cookie) {
        return responseFailure('opencode-go', response, runtime.now(), { rateLimited: 'OpenCode Go usage is rate limited', unauthorized: 'OpenCode Go API key is not authorized', generic: `OpenCode Go usage request failed (HTTP ${response.status})` }, { source: 'web', credentialSource: source })
      }
    } catch {
      if (!cookie) return safeProviderError('opencode-go', runtime, 'OpenCode Go usage request failed', runtime.signal.aborted ? 'usage-unavailable' : 'network')
    }
  }
  if (cookie) {
    try {
      return await fetchOpenCodeCookieUsage(runtime, cookie)
    } catch {
      return safeProviderError('opencode-go', runtime, 'OpenCode Go session request failed', runtime.signal.aborted ? 'usage-unavailable' : 'network')
    }
  }
  return safeProviderError('opencode-go', runtime, 'No OpenCode Go API key or session cookie is configured', 'missing-credentials', 'unavailable')
}

function cursorRoots(): { cli: string; ide: string } {
  if (process.platform === 'darwin') {
    return { cli: join(homeDirectory(), '.cursor'), ide: join(homeDirectory(), 'Library', 'Application Support', 'Cursor') }
  }
  if (process.platform === 'win32') {
    const root = process.env.APPDATA?.trim() || join(homeDirectory(), 'AppData', 'Roaming')
    return { cli: join(root, 'Cursor'), ide: join(root, 'Cursor') }
  }
  const root = process.env.XDG_CONFIG_HOME?.trim() || join(homeDirectory(), '.config')
  return { cli: join(root, 'cursor'), ide: join(root, 'Cursor') }
}

function cursorToken(raw: string): { raw: string; subject: string; expiresAt: number | null } | null {
  const parts = raw.trim().split('.')
  if (parts.length < 2 || !parts[1]) return null
  try {
    const payload = record(JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')))
    if (typeof payload?.sub !== 'string' || !payload.sub.trim()) return null
    const exp = finiteNumber(payload.exp)
    return { raw: raw.trim(), subject: payload.sub.trim(), expiresAt: exp === null ? null : exp * 1000 }
  } catch {
    return null
  }
}

function cursorIsFresh(token: { expiresAt: number | null }, now: number): boolean {
  return token.expiresAt === null || token.expiresAt > now
}

function cursorCliIdentity(config: unknown): { email: string | null; displayName: string | null } {
  const auth = record(record(config)?.authInfo)
  return {
    email: typeof auth?.email === 'string' ? auth.email : null,
    displayName: typeof auth?.displayName === 'string' ? auth.displayName : null
  }
}

async function cursorKeychain(run: KeychainPassword): Promise<CredentialRead> {
  if (process.platform !== 'darwin') return { status: 'missing' }
  return run('cursor-access-token', 'cursor-user')
}

function cursorDesktopToken(path: string): { token: string | null; email: string | null; membership: string | null } | null {
  if (!existsSync(path)) return null
  let database: Database | null = null
  try {
    database = new Database(path, { readonly: true, create: false })
    database.exec('PRAGMA busy_timeout = 250')
    const rows = database.query<{ key: unknown; value: unknown }, [string, string, string]>('SELECT key, value FROM ItemTable WHERE key IN (?, ?, ?)').all(
      'cursorAuth/accessToken',
      'cursorAuth/cachedEmail',
      'cursorAuth/stripeMembershipType'
    )
    const values = new Map<string, string>()
    for (const row of rows) {
      const value = typeof row.value === 'string' ? row.value : row.value instanceof Uint8Array ? Buffer.from(row.value).toString('utf8').trim() : ''
      if (typeof row.key === 'string' && value) values.set(row.key, value)
    }
    return {
      token: values.get('cursorAuth/accessToken') ?? null,
      email: values.get('cursorAuth/cachedEmail') ?? null,
      membership: values.get('cursorAuth/stripeMembershipType') ?? null
    }
  } catch {
    return null
  } finally {
    database?.close()
  }
}

async function readCursorToken(runtime: ProviderRuntime): Promise<{ token: ReturnType<typeof cursorToken>; source: string; email: string | null; displayName: string | null; membership: string | null; keychainError: boolean }> {
  const roots = cursorRoots()
  const keychain = await cursorKeychain(async (service, account) => {
    const result = await runtime.run('security', ['find-generic-password', '-s', service, '-a', account, '-w'], { timeoutMs: 3_000, maxOutputBytes: 16 * 1024 })
    if (result.code === 0 && result.stdout.trim()) return { status: 'found', value: result.stdout.trim() }
    if (result.code === 44 || /could not be found|not found/i.test(result.stderr)) return { status: 'missing' }
    return result.code === 0 ? { status: 'missing' } : { status: 'error' }
  })
  let expired: { token: ReturnType<typeof cursorToken>; source: string; email: string | null; displayName: string | null; membership: string | null } | null = null
  let keychainError = keychain.status === 'error'
  const identity = cursorCliIdentity(await readJsonFile(join(roots.cli, 'cli-config.json')))
  const candidates: { raw: string; source: string; email: string | null; displayName: string | null; membership: string | null }[] = []
  if (keychain.status === 'found') candidates.push({ raw: keychain.value, source: 'keychain', ...identity, membership: null })
  const cliAuth = record(await readJsonFile(join(roots.cli, 'auth.json')))
  if (typeof cliAuth?.accessToken === 'string') candidates.push({ raw: cliAuth.accessToken, source: 'cli', ...identity, membership: null })
  for (const candidate of candidates) {
    const token = cursorToken(candidate.raw)
    if (!token) continue
    if (cursorIsFresh(token, runtime.now())) return { token, source: candidate.source, email: candidate.email, displayName: candidate.displayName, membership: candidate.membership, keychainError }
    expired ??= { token, source: candidate.source, email: candidate.email, displayName: candidate.displayName, membership: candidate.membership }
  }
  const desktopPath = join(roots.ide, 'User', 'globalStorage', 'state.vscdb')
  const desktop = cursorDesktopToken(desktopPath)
  if (desktop?.token) {
    const token = cursorToken(desktop.token)
    if (token) {
      if (cursorIsFresh(token, runtime.now())) return { token, source: 'desktop', email: desktop.email, displayName: null, membership: desktop.membership, keychainError }
      expired ??= { token, source: 'desktop', email: desktop.email, displayName: null, membership: desktop.membership }
    }
  }
  if (expired) return { ...expired, keychainError }
  return { token: null, source: '', email: null, displayName: null, membership: null, keychainError }
}

function cursorCookie(session: { raw: string; subject: string }): string {
  return `WorkosCursorSessionToken=${encodeURIComponent(session.subject)}%3A%3A${session.raw}`
}

function mapLegacyCursorQuota(payload: unknown, now: number): ProviderSnapshot | null {
  const data = record(payload)
  if (!data) return null
  const quotas: { name: string; used: number; limit: number }[] = []
  for (const [name, value] of Object.entries(data)) {
    const entry = record(value)
    const limit = finiteNumber(entry?.maxRequestUsage)
    const used = finiteNumber(entry?.numRequests)
    if (limit !== null && limit > 0 && used !== null) quotas.push({ name, used, limit })
  }
  if (quotas.length === 0) return null
  const selected = quotas.find((item) => item.name === 'gpt-4') ?? quotas.sort((left, right) => right.limit - left.limit)[0]
  if (!selected) return null
  return {
    provider: 'cursor', accountId: null, status: 'ok', error: null, updatedAt: now, session: null, weekly: null,
    monthly: { usedPercent: Math.min(100, Math.max(0, (selected.used / selected.limit) * 100)), windowMinutes: 43_200, resetsAt: null, resetDescription: null },
    planType: null
  }
}

export async function fetchCursorUsage(runtime: ProviderRuntime): Promise<ProviderSnapshot> {
  const session = await readCursorToken(runtime)
  if (!session.token) {
    return safeProviderError('cursor', runtime, session.keychainError ? 'Unable to read the Cursor login from macOS Keychain' : 'No Cursor sign-in found on this computer', session.keychainError ? 'keychain-unavailable' : 'missing-credentials', 'unavailable')
  }
  if (!cursorIsFresh(session.token, runtime.now())) return safeProviderError('cursor', runtime, 'Cursor sign-in expired — run cursor-agent login again', 'stale-token')
  const source = session.source === 'desktop' ? 'web' : 'cli'
  const provenance = createHash('sha256').update(session.token.subject).digest('hex').slice(0, 12)
  const headers = {
    Cookie: cursorCookie(session.token),
    Origin: CURSOR_ORIGIN,
    Referer: `${CURSOR_ORIGIN}/dashboard`,
    Accept: 'application/json'
  }
  const metadata = { source, credentialSource: session.source, authProvenance: provenance } as const
  try {
    const response = await runtime.fetch(`${CURSOR_ORIGIN}/api/usage-summary`, { headers, redirect: 'manual', credentials: 'omit' })
    if (response.status === 429) {
      const now = runtime.now()
      const delay = parseRetryAfterMs(response.headers.get('retry-after'), now)
      return errorSnapshot('cursor', now, 'Cursor usage is rate limited right now', 'rate-limited', 'error', { ...metadata, ...(delay !== null ? { retryAtMs: now + delay } : {}) })
    }
    if (response.status === 401) return errorSnapshot('cursor', runtime.now(), 'Cursor sign-in expired — run cursor-agent login again', 'stale-token', 'error', metadata)
    if (!response.ok) return errorSnapshot('cursor', runtime.now(), `Cursor usage request failed (HTTP ${response.status})`, 'server', 'error', metadata)
    const summary = mapCursorUsage(await responseJson(response), runtime.now())
    if (summary.status === 'ok') return { ...summary, usageMetadata: { ...metadata, lastSuccessfulSource: source } }
    const legacy = await runtime.fetch(`${CURSOR_ORIGIN}/api/usage?user=${encodeURIComponent(session.token.subject)}`, { headers, redirect: 'manual', credentials: 'omit' })
    if (!legacy.ok) return responseFailure('cursor', legacy, runtime.now(), { rateLimited: 'Cursor usage is rate limited right now', unauthorized: 'Cursor sign-in expired — run cursor-agent login again', generic: `Cursor usage request failed (HTTP ${legacy.status})` }, metadata)
    const mapped = mapLegacyCursorQuota(await responseJson(legacy), runtime.now())
    return mapped ? { ...mapped, planType: summary.planType, usageMetadata: { ...metadata, lastSuccessfulSource: source } } : errorSnapshot('cursor', runtime.now(), 'Cursor reported no usage allowance for this account', 'usage-unavailable', 'unavailable', metadata)
  } catch {
    return errorSnapshot('cursor', runtime.now(), runtime.signal.aborted ? 'Cursor usage refresh was cancelled' : 'Cursor usage request failed', runtime.signal.aborted ? 'usage-unavailable' : 'network', 'error', metadata)
  }
}

function grokAuthPath(): string {
  const configured = process.env.GROK_HOME?.trim()
  const grokHome = configured && isAbsolute(configured) ? configured : join(homeDirectory(), '.grok')
  return join(grokHome, 'auth.json')
}

function grokEntry(value: unknown): Record<string, unknown> | null {
  const entry = record(value)
  return typeof entry?.key === 'string' && entry.key.length > 0 ? entry : null
}

async function readGrokCredential(now: number): Promise<{ token: string; userId: string | null; expiresAt: number | null } | null> {
  const auth = record(await readJsonFile(grokAuthPath()))
  if (!auth) return null
  let preferredFound = false
  let expiredPreferred: { token: string; userId: string | null; expiresAt: number | null } | null = null
  let fallback: { token: string; userId: string | null; expiresAt: number | null } | null = null
  for (const [issuer, raw] of Object.entries(auth)) {
    const preferred = issuer === 'https://auth.x.ai' || issuer.startsWith('https://auth.x.ai::')
    preferredFound ||= preferred
    const entry = grokEntry(raw)
    if (!entry) continue
    const token = entry.key
    if (typeof token !== 'string') continue
    const expiresAt = typeof entry.expires_at === 'string' ? Date.parse(entry.expires_at) : Number.NaN
    const candidate = {
      token,
      userId: typeof entry.user_id === 'string' ? entry.user_id : null,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : null
    }
    if (preferred) {
      if (candidate.expiresAt === null || candidate.expiresAt - now > 5 * 60_000) return candidate
      expiredPreferred ??= candidate
    } else {
      fallback ??= candidate
    }
  }
  return expiredPreferred ?? (preferredFound ? null : fallback)
}

export async function fetchGrokUsage(runtime: ProviderRuntime): Promise<ProviderSnapshot> {
  const session = await readGrokCredential(runtime.now())
  if (!session) return safeProviderError('grok', runtime, 'Not signed in to Grok CLI', 'missing-credentials', 'unavailable')
  if (session.expiresAt !== null && session.expiresAt - runtime.now() <= 5 * 60_000) return safeProviderError('grok', runtime, 'Grok sign-in expired — run grok on this computer and sign in if prompted', 'delegated-refresh-required')
  const configuredBase = process.env.GROK_CLI_CHAT_PROXY_BASE_URL?.trim()
  let base = 'https://cli-chat-proxy.grok.com/v1'
  if (configuredBase) {
    try {
      const parsed = new URL(configuredBase)
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'cli-chat-proxy.grok.com' || parsed.username || parsed.password || parsed.search || parsed.hash) return safeProviderError('grok', runtime, 'Grok usage base URL is not allowlisted', 'usage-unavailable')
      base = parsed.toString().replace(/\/$/, '')
    } catch {
      return safeProviderError('grok', runtime, 'Grok usage base URL is invalid', 'usage-unavailable')
    }
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.token}`,
    'X-XAI-Token-Auth': 'xai-grok-cli',
    Accept: 'application/json'
  }
  if (session.userId) headers['x-userid'] = session.userId
  try {
    const creditsResponse = await runtime.fetch(`${base}/billing?format=credits`, { headers, redirect: 'error', credentials: 'omit' })
    if (!creditsResponse.ok) return responseFailure('grok', creditsResponse, runtime.now(), { rateLimited: 'Grok usage is rate limited', unauthorized: `Grok usage request unauthorized (HTTP ${creditsResponse.status})`, generic: `Grok usage request failed (HTTP ${creditsResponse.status})` }, { source: 'web', credentialSource: 'grok-cli' })
    const creditsData = await responseJson(creditsResponse)
    const mapped = mapGrokUsage(creditsData, runtime.now())
    if (mapped.status === 'ok') return { ...mapped, usageMetadata: { source: 'web', credentialSource: 'grok-cli', lastSuccessfulSource: 'web' } }
    const monthlyResponse = await runtime.fetch(`${base}/billing`, { headers, redirect: 'error', credentials: 'omit' })
    if (!monthlyResponse.ok) return responseFailure('grok', monthlyResponse, runtime.now(), { rateLimited: 'Grok usage is rate limited', unauthorized: `Grok usage request unauthorized (HTTP ${monthlyResponse.status})`, generic: `Grok usage request failed (HTTP ${monthlyResponse.status})` }, { source: 'web', credentialSource: 'grok-cli' })
    const monthly = mapGrokUsage(await responseJson(monthlyResponse), runtime.now())
    return monthly.status === 'ok' ? { ...monthly, usageMetadata: { source: 'web', credentialSource: 'grok-cli', lastSuccessfulSource: 'web' } } : monthly
  } catch {
    return safeProviderError('grok', runtime, 'Grok usage request failed', runtime.signal.aborted ? 'usage-unavailable' : 'network')
  }
}

function zcodeNativeCredentials(): { apiKey: string; baseUrl: string; source: string } | null {
  const configPath = join(homeDirectory(), '.zcode', 'cli', 'config.json')
  let config: Record<string, unknown> | null
  try {
    config = record(JSON.parse(readFileSync(configPath, 'utf8')))
  } catch {
    return null
  }
  const model = config?.model
  const modelName = typeof model === 'string' ? model : record(model)?.main
  if (typeof modelName !== 'string') return null
  const divider = modelName.indexOf('/')
  if (divider < 1 || divider === modelName.length - 1) return null
  const providerName = modelName.slice(0, divider)
  const provider = record(record(config?.provider)?.[providerName])
  const options = record(provider?.options)
  const apiKey = typeof options?.apiKey === 'string' ? options.apiKey.trim() : ''
  const baseUrl = typeof options?.baseURL === 'string' ? options.baseURL.trim() : ''
  return apiKey && baseUrl ? { apiKey, baseUrl, source: 'zcode-cli-config' } : null
}
export async function fetchZcodeUsage(runtime: ProviderRuntime, dataDir: string): Promise<ProviderSnapshot> {
  const savedKey = readStoredCredential(dataDir, 'zcode', 'api-key')
  const native = savedKey ? null : zcodeNativeCredentials()
  const apiKey = savedKey ?? native?.apiKey ?? ''
  const source = savedKey ? 'settings' : native?.source ?? ''
  if (!apiKey) return safeProviderError('zcode', runtime, 'ZCode Coding Plan credentials are not configured', 'missing-credentials', 'unavailable')
  const configuredUrl = readStoredCredential(dataDir, 'zcode', 'base-url') ?? native?.baseUrl ?? null
  const base = allowedOrigin(configuredUrl, 'zcode', '')
  if (!base) return safeProviderError('zcode', runtime, 'ZCode Coding Plan base URL is not allowlisted', 'usage-unavailable')
  const url = `${base}/api/monitor/usage/quota/limit`
  try {
    const response = await runtime.fetch(url, {
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      headers: { Authorization: apiKey, 'Accept-Language': 'en-US,en', 'Content-Type': 'application/json' }
    })
    if (!response.ok) return responseFailure('zcode', response, runtime.now(), { rateLimited: 'ZCode usage is rate limited', unauthorized: 'ZCode API key is not authorized', generic: `ZCode quota request failed (HTTP ${response.status})` }, { source: 'web', credentialSource: source })
    const payload = await responseJson(response)
    const mapped = mapZcodeUsage(payload, runtime.now())
    return mapped.status === 'ok'
      ? { ...mapped, usageMetadata: { source: 'web', credentialSource: source, lastSuccessfulSource: 'web' } }
      : { ...mapped, error: 'ZCode quota response contained no usable limits', usageMetadata: { source: 'web', credentialSource: source, failureKind: 'parse' } }
  } catch {
    return safeProviderError('zcode', runtime, runtime.signal.aborted ? 'ZCode usage refresh was cancelled' : 'ZCode quota request failed', runtime.signal.aborted ? 'usage-unavailable' : 'network')
  }
}

export async function fetchWebProvider(provider: 'opencode-go' | 'minimax' | 'grok' | 'cursor' | 'zcode', runtime: ProviderRuntime, dataDir: string): Promise<ProviderSnapshot> {
  switch (provider) {
    case 'opencode-go': return fetchOpenCodeGoUsage(runtime, dataDir)
    case 'minimax': return fetchMiniMaxUsage(runtime, dataDir)
    case 'grok': return fetchGrokUsage(runtime)
    case 'cursor': return fetchCursorUsage(runtime)
    case 'zcode': return fetchZcodeUsage(runtime, dataDir)
  }
}
