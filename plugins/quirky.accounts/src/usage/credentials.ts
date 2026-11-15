import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
  chmodSync,
  unlinkSync,
  type Stats
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { CredentialStatus, UsageTarget } from './types'

const CREDENTIAL_FILE = 'usage-credentials.json'
const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024
const ALLOWED_CREDENTIALS = {
  minimax: ['api-key', 'cookie', 'group-id', 'base-url', 'model'],
  'opencode-go': ['api-key', 'cookie'],
  zcode: ['api-key', 'base-url']
} as const
const ALLOWED_BASE_HOSTS = {
  minimax: ['platform.minimax.io', 'www.minimaxi.com'],
  zcode: ['api.z.ai', 'open.bigmodel.cn', 'dev.bigmodel.cn']
} as const

export type CredentialProvider = keyof typeof ALLOWED_CREDENTIALS
export type CredentialRead =
  | { status: 'found'; value: string }
  | { status: 'missing' }
  | { status: 'error' }
export type ClaudeCredentialSource = 'scoped-keychain' | 'legacy-keychain' | 'credentials-file' | 'none'
export type ClaudeCredential = {
  token: string | null
  hasRefreshableCredentials: boolean
  source: ClaudeCredentialSource
  keychainUnavailable: boolean
}
export type KeychainReader = (service: string, account: string) => Promise<CredentialRead>

type StoredCredentials = Record<string, Record<string, string>>
type StoreRead = { values: StoredCredentials; readable: boolean }
type CredentialFileIdentity = { dev: number; ino: number }
type CredentialStoreClassification =
  | { kind: 'missing' }
  | { kind: 'healthy'; values: StoredCredentials }
  | { kind: 'corrupt'; identity: CredentialFileIdentity }
  | { kind: 'unusable' }
type QuarantineResult =
  | { kind: 'quarantined'; path: string }
  | { kind: 'changed' }
  | { kind: 'moved-unexpected'; path: string }
  | { kind: 'occupied' | 'failed' }
type CredentialRecoveryHooks = {
  beforeIdentityCheck?(): void
  beforeRename?(): void
}

let credentialRecoveryHooks: CredentialRecoveryHooks | null = null

function credentialPath(dataDir: string): string {
  return join(dataDir, CREDENTIAL_FILE)
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isCredentialProvider(value: string): value is CredentialProvider {
  return value === 'minimax' || value === 'opencode-go' || value === 'zcode'
}

function emptyStoredCredentials(): StoredCredentials {
  return Object.create(null) as StoredCredentials
}

function isCredentialRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseStoredCredentials(value: unknown): StoredCredentials | null {
  if (!isCredentialRecord(value)) return null
  const output = emptyStoredCredentials()
  for (const [provider, rawKinds] of Object.entries(value)) {
    if (!isCredentialRecord(rawKinds)) return null
    const kinds = Object.create(null) as Record<string, string>
    for (const [kind, item] of Object.entries(rawKinds)) {
      if (typeof item !== 'string') return null
      kinds[kind] = item
    }
    output[provider] = kinds
  }
  return output
}

function classifyCredentialStore(dataDir: string): CredentialStoreClassification {
  const path = credentialPath(dataDir)
  let pathInfo: Stats
  try {
    pathInfo = lstatSync(path)
  } catch (error) {
    return isMissing(error) ? { kind: 'missing' } : { kind: 'unusable' }
  }
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) return { kind: 'unusable' }

  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    return isMissing(error) ? { kind: 'missing' } : { kind: 'unusable' }
  }

  let result: CredentialStoreClassification = { kind: 'unusable' }
  try {
    const info = fstatSync(fd)
    if (!info.isFile()) {
      result = { kind: 'unusable' }
    } else {
      const identity = { dev: info.dev, ino: info.ino }
      if (info.size > MAX_CREDENTIAL_FILE_BYTES) {
        result = { kind: 'corrupt', identity }
      } else {
        const buffer = Buffer.alloc(info.size)
        let length = 0
        while (length < buffer.length) {
          const bytesRead = readSync(fd, buffer, length, buffer.length - length, length)
          if (bytesRead === 0) break
          length += bytesRead
        }

        let parsed: unknown
        try {
          parsed = JSON.parse(buffer.subarray(0, length).toString('utf8')) as unknown
        } catch {
          result = { kind: 'corrupt', identity }
        }
        if (parsed !== undefined) {
          const values = parseStoredCredentials(parsed)
          result = values === null ? { kind: 'corrupt', identity } : { kind: 'healthy', values }
        }
      }
    }
  } catch {
    result = { kind: 'unusable' }
  }

  try {
    closeSync(fd)
  } catch {
    return { kind: 'unusable' }
  }
  return result
}

function sameFile(info: Stats, identity: CredentialFileIdentity): boolean {
  return info.isFile() && !info.isSymbolicLink() && info.dev === identity.dev && info.ino === identity.ino
}

function guardedQuarantine(path: string, identity: CredentialFileIdentity): QuarantineResult {
  const candidates = new Set<string>()
  let destination: string | undefined
  for (let attempt = 0; attempt < 3; attempt++) {
    let candidate = `${path}.corrupt-${Date.now()}-${randomBytes(4).toString('hex')}`
    while (candidates.has(candidate)) {
      candidate = `${path}.corrupt-${Date.now()}-${randomBytes(4).toString('hex')}`
    }
    candidates.add(candidate)
    try {
      lstatSync(candidate)
    } catch (error) {
      if (isMissing(error)) {
        destination = candidate
        break
      }
    }
  }
  if (!destination) return { kind: 'occupied' }

  credentialRecoveryHooks?.beforeIdentityCheck?.()
  let current: Stats
  try {
    current = lstatSync(path)
  } catch {
    return { kind: 'changed' }
  }
  if (!sameFile(current, identity)) return { kind: 'changed' }

  credentialRecoveryHooks?.beforeRename?.()
  try {
    renameSync(path, destination)
  } catch {
    return { kind: 'failed' }
  }

  try {
    if (sameFile(lstatSync(destination), identity)) return { kind: 'quarantined', path: destination }
  } catch {
    // A changed or missing destination remains untouched for manual recovery.
  }
  return { kind: 'moved-unexpected', path: destination }
}

function quarantineDiagnostic(result: Exclude<QuarantineResult, { kind: 'quarantined' }>): string {
  switch (result.kind) {
    case 'changed':
      return `${CREDENTIAL_FILE} changed during recovery; nothing was moved`
    case 'moved-unexpected':
      return `${CREDENTIAL_FILE} changed during recovery; a file was set aside as ${basename(result.path)}`
    case 'occupied':
    case 'failed':
      return `${CREDENTIAL_FILE} could not be set aside`
  }
}

function readCredentialStore(dataDir: string): StoreRead {
  const classification = classifyCredentialStore(dataDir)
  switch (classification.kind) {
    case 'missing':
      return { values: emptyStoredCredentials(), readable: true }
    case 'healthy':
      return { values: classification.values, readable: true }
    case 'unusable':
      return { values: emptyStoredCredentials(), readable: false }
    case 'corrupt': {
      const result = guardedQuarantine(credentialPath(dataDir), classification.identity)
      return {
        values: emptyStoredCredentials(),
        readable: result.kind === 'quarantined'
      }
    }
  }
}

/** Eagerly classifies and, when necessary, sets aside a corrupt credential store. */
export function recoverCredentialStore(dataDir: string): { quarantinedPath: string } | { diagnostic: string } | null {
  const classification = classifyCredentialStore(dataDir)
  if (classification.kind !== 'corrupt') return null
  const result = guardedQuarantine(credentialPath(dataDir), classification.identity)
  return result.kind === 'quarantined'
    ? { quarantinedPath: result.path }
    : { diagnostic: quarantineDiagnostic(result) }
}

/** Test-only: installs callbacks at guarded-quarantine identity and rename boundaries. */
export function setCredentialRecoveryHooksForTests(hooks: CredentialRecoveryHooks | null): void {
  credentialRecoveryHooks = hooks
}

function validateBaseUrl(provider: 'minimax' | 'zcode', value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Credential base URL is invalid')
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (parsed.pathname !== '/' && parsed.pathname !== '') ||
    (parsed.port !== '' && parsed.port !== '443') ||
    !(ALLOWED_BASE_HOSTS[provider] as readonly string[]).includes(parsed.hostname.toLowerCase())
  ) {
    throw new Error('Credential base URL is not allowlisted')
  }
  return parsed.origin
}

function validateCredential(provider: CredentialProvider, kind: string, value: string): string {
  if (!(ALLOWED_CREDENTIALS[provider] as readonly string[]).includes(kind)) {
    throw new Error('Credential kind is not supported for this provider')
  }
  if (typeof value !== 'string' || value.trim().length === 0 || /[\u0000\r\n]/.test(value)) {
    throw new Error('Credential value is invalid')
  }
  if (kind === 'base-url') {
    if (provider === 'opencode-go') throw new Error('Credential base URL is not supported for this provider')
    return validateBaseUrl(provider, value.trim())
  }
  const normalized = value.trim()
  if ((kind === 'api-key' && normalized.length > 16_384) || (kind === 'cookie' && normalized.length > 32_768)) {
    throw new Error('Credential value is invalid')
  }
  return normalized
}

// Local-file threat model: Quirky owns this 0600 file beneath its already-0700 data directory; the
// host account and disk-encryption boundary protect it. It is never returned, logged, or emitted.
function persistCredentialsSync(dataDir: string, values: StoredCredentials): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const path = credentialPath(dataDir)
  const temp = join(dataDir, `.${CREDENTIAL_FILE}.${randomUUID()}.tmp`)
  const fd = openSync(temp, 'wx', 0o600)
  try {
    writeFileSync(fd, JSON.stringify(values), 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(temp, path)
    chmodSync(path, 0o600)
  } catch (error) {
    try { unlinkSync(temp) } catch { /* temporary entry may already be gone */ }
    throw error
  }
}

export function credentialStatuses(dataDir: string): CredentialStatus[] {
  const store = readCredentialStore(dataDir)
  return Object.entries(ALLOWED_CREDENTIALS).flatMap(([provider, kinds]) =>
    kinds.map((kind) => ({
      provider,
      kind,
      configured: typeof store.values[provider]?.[kind] === 'string',
      readable: store.readable
    }))
  )
}

export function readStoredCredential(dataDir: string, provider: CredentialProvider, kind: string): string | null {
  if (!(ALLOWED_CREDENTIALS[provider] as readonly string[]).includes(kind)) return null
  return readCredentialStore(dataDir).values[provider]?.[kind] ?? null
}

export function writeStoredCredential(dataDir: string, provider: string, kind: string, value: string): CredentialStatus {
  if (!isCredentialProvider(provider)) throw new Error('Credential provider is not supported')
  const typedProvider = provider
  const normalized = validateCredential(typedProvider, kind, value)
  const store = readCredentialStore(dataDir)
  if (!store.readable) throw new Error('Credential storage is not readable')
  const values = store.values
  values[provider] = { ...values[provider], [kind]: normalized }
  persistCredentialsSync(dataDir, values)
  return { provider, kind, configured: true, readable: true }
}

export function clearStoredCredential(dataDir: string, provider: string, kind: string): CredentialStatus {
  if (!isCredentialProvider(provider)) throw new Error('Credential provider is not supported')
  const typedProvider = provider
  if (!(ALLOWED_CREDENTIALS[typedProvider] as readonly string[]).includes(kind)) {
    throw new Error('Credential kind is not supported for this provider')
  }
  const store = readCredentialStore(dataDir)
  if (!store.readable) throw new Error('Credential storage is not readable')
  const values = store.values
  const kinds = { ...values[provider] }
  delete kinds[kind]
  if (Object.keys(kinds).length > 0) values[provider] = kinds
  else delete values[provider]
  persistCredentialsSync(dataDir, values)
  return { provider, kind, configured: false, readable: true }
}

export function homeDirectory(): string {
  const value = process.env.HOME?.trim()
  return value ? resolve(value) : homedir()
}

export function claudeConfigDir(target: UsageTarget): string {
  if (target.home) return resolve(target.home)
  const custom = process.env.CLAUDE_CONFIG_DIR?.trim()
  return resolve(custom || join(homeDirectory(), '.claude'))
}

export function codexHome(target: UsageTarget): string {
  if (target.home) return resolve(target.home)
  const custom = process.env.CODEX_HOME?.trim()
  return resolve(custom || join(homeDirectory(), '.codex'))
}

export function getClaudeKeychainService(configDir: string): string {
  const digest = createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8)
  return `Claude Code-credentials-${digest}`
}

function keychainAccountName(): string {
  const candidate = process.env.USER?.trim() || process.env.USERNAME?.trim() || ''
  return /^[A-Za-z0-9._-]+$/.test(candidate) ? candidate : 'claude-code-user'
}

function emptyClaudeCredential(source: ClaudeCredentialSource, keychainUnavailable = false): ClaudeCredential {
  return { token: null, hasRefreshableCredentials: false, source, keychainUnavailable }
}

function parseClaudeCredential(value: string, source: ClaudeCredentialSource): ClaudeCredential {
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return emptyClaudeCredential(source)
    const nested = 'claudeAiOauth' in parsed ? parsed.claudeAiOauth : parsed
    if (typeof nested !== 'object' || nested === null || Array.isArray(nested)) return emptyClaudeCredential(source)
    const token = 'accessToken' in nested && typeof nested.accessToken === 'string' && nested.accessToken.length > 0
      ? nested.accessToken
      : null
    const hasRefreshableCredentials = 'refreshToken' in nested && typeof nested.refreshToken === 'string' && nested.refreshToken.length > 0
    return { token, hasRefreshableCredentials, source, keychainUnavailable: false }
  } catch {
    return emptyClaudeCredential(source)
  }
}

export async function resolveClaudeOAuthCredential(options: {
  configDir: string
  systemDefault: boolean
  keychain: KeychainReader
}): Promise<ClaudeCredential> {
  let keychainUnavailable = false
  const account = keychainAccountName()
  const scoped = await options.keychain(getClaudeKeychainService(options.configDir), account)
  if (scoped.status === 'found') {
    const credential = parseClaudeCredential(scoped.value, 'scoped-keychain')
    if (credential.token) return credential
  } else if (scoped.status === 'error') {
    keychainUnavailable = true
  }
  if (options.systemDefault) {
    const legacy = await options.keychain('Claude Code-credentials', account)
    if (legacy.status === 'found') {
      const credential = parseClaudeCredential(legacy.value, 'legacy-keychain')
      if (credential.token) return credential
    } else if (legacy.status === 'error') {
      keychainUnavailable = true
    }
  }
  try {
    const raw = await readFile(join(options.configDir, '.credentials.json'), 'utf8')
    return { ...parseClaudeCredential(raw, 'credentials-file'), keychainUnavailable }
  } catch (error) {
    if (!isMissing(error)) keychainUnavailable = true
  }
  return emptyClaudeCredential('none', keychainUnavailable)
}

export async function readClaudeCredentialForTarget(
  target: UsageTarget,
  runKeychain: KeychainReader
): Promise<ClaudeCredential> {
  return resolveClaudeOAuthCredential({
    configDir: claudeConfigDir(target),
    systemDefault: target.accountId === null,
    keychain: runKeychain
  })
}

export function managedCodexAuthPath(target: UsageTarget): string {
  return join(codexHome(target), 'auth.json')
}

export function credentialProviderAllowedPairs(): Readonly<Record<CredentialProvider, readonly string[]>> {
  return ALLOWED_CREDENTIALS
}
