import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { ConfigWarning, ManagedProvider } from './types'
import { MANAGED_ID_RE } from './types'

const OWNER_FILE = 'owner.json'
const OWNER_VERSION = 1
const CLAUDE_HISTORY_DIRS = [
  'projects',
  'session-env',
  'file-history',
  'shell-snapshots',
  'todos',
  'paste-cache',
  'tasks',
  'plans',
  'transcripts'
] as const
const CODEX_RESOURCES = ['skills', 'hooks', 'plugins', 'plugin-state', 'profile-v2', 'themes', 'prompts', 'AGENTS.md'] as const

export type ProviderIdentity = {
  email: string | null
  organization: string | null
  authKind: 'oauth' | 'api-key' | 'none' | 'unknown'
  hasAuth: boolean
  identityKey: string | null
}

type OwnerRecord = { version: number; provider: ManagedProvider; id: string }
type CodexIdentity = ProviderIdentity & { providerAccountId: string | null; workspaceAccountId: string | null }

export type CodexConfigSyncResult = { kind: 'synced' } | { kind: ConfigWarning['kind']; message: string }

export class AccountProfiles {
  readonly root: string
  private readonly dataRoot: string
  private readonly historyRoot: string

  constructor(dataDir: string) {
    this.dataRoot = realpathSync.native(dataDir)
    this.root = join(this.dataRoot, 'profiles')
    this.historyRoot = join(this.root, 'claude', 'shared-history')
    this.ensureDirectories(this.dataRoot, this.root)
  }

  home(provider: ManagedProvider, id: string): string {
    this.assertId(id)
    return join(this.root, provider, id, 'home')
  }

  defaultHome(provider: ManagedProvider): string {
    return provider === 'claude' ? this.defaultClaudeHome() : this.defaultCodexHome()
  }

  async create(provider: ManagedProvider, id: string): Promise<string> {
    this.assertId(id)
    const home = this.home(provider, id)
    const accountDir = dirname(home)
    if (this.pathExists(accountDir)) {
      throw new Error('A managed account profile already exists at this identifier.')
    }
    this.ensureDirectories(this.root, accountDir)
    mkdirSync(home, { mode: 0o700 })
    chmodSync(home, 0o700)
    try {
      if (provider === 'claude') this.setupClaude(home)
      else this.setupCodex(home)
      this.writeOwner(provider, id, home)
      return home
    } catch (error) {
      this.removeIncomplete(provider, id, home)
      throw this.safeProfileError(error)
    }
  }

  ensureOwned(provider: ManagedProvider, id: string): string {
    const home = this.home(provider, id)
    this.assertOwned(provider, id, home)
    return home
  }

  assertOwned(provider: ManagedProvider, id: string, candidate: string): void {
    this.assertId(id)
    const expected = this.home(provider, id)
    if (resolve(candidate) !== expected || !isAbsolute(candidate)) {
      throw new Error('The managed account profile path is not trusted.')
    }
    this.assertNoLinks(this.root, expected)
    let homeStat
    let markerStat
    try {
      homeStat = lstatSync(expected)
      markerStat = lstatSync(this.ownerPath(expected))
    } catch {
      throw new Error('The managed account profile is missing or unavailable.')
    }
    if (homeStat.isSymbolicLink() || !homeStat.isDirectory() || markerStat.isSymbolicLink() || !markerStat.isFile()) {
      throw new Error('The managed account profile is not owned by Quirky.')
    }
    const realHome = realpathSync.native(expected)
    if (realHome !== expected) throw new Error('The managed account profile path is not canonical.')
    const owner = this.readOwner(expected)
    if (!owner || owner.version !== OWNER_VERSION || owner.provider !== provider || owner.id !== id) {
      throw new Error('The managed account profile is not owned by Quirky.')
    }
  }

  readIdentity(provider: ManagedProvider, home: string, includeEnvironmentApiKey = false): ProviderIdentity {
    if (provider === 'claude') return this.readClaudeIdentity(home, includeEnvironmentApiKey)
    return this.readCodexIdentity(home)
  }

  codexDefaultProvider(): string | null {
    const config = this.readOptionalText(join(this.defaultCodexHome(), 'config.toml'))
    if (config === null) return null
    const provider = parseCodexConfig(config).model_provider
    if (provider === undefined) return null
    if (typeof provider !== 'string') throw new Error('Codex model_provider must be a string.')
    return provider.trim() || null
  }

  assertCodexOAuthAllowed(): void {
    let provider: string | null
    try {
      provider = this.codexDefaultProvider()
    } catch {
      return
    }
    if (provider !== null && provider.toLowerCase() !== 'openai') {
      throw new Error(`Quirky cannot add a Codex OAuth account while the system Codex configuration uses the custom provider "${provider}".`)
    }
  }

  syncCodexConfig(id: string): CodexConfigSyncResult {
    let home: string
    try {
      home = this.ensureOwned('codex', id)
    } catch {
      return { kind: 'sync-failed', message: 'The managed Codex settings home could not be verified; its last-synced settings were kept.' }
    }
    const source = join(this.defaultCodexHome(), 'config.toml')
    let sourceStat
    try {
      sourceStat = lstatSync(source)
    } catch (error) {
      return isMissing(error)
        ? { kind: 'source-missing', message: 'System Codex config.toml is missing; this account keeps its last-synced settings.' }
        : { kind: 'source-unreadable', message: 'System Codex config.toml could not be read; this account keeps its last-synced settings.' }
    }
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
      return { kind: 'source-unreadable', message: 'System Codex config.toml could not be read; this account keeps its last-synced settings.' }
    }
    let sourceContents: string
    try {
      sourceContents = readFileSync(source, 'utf8')
    } catch {
      return { kind: 'source-unreadable', message: 'System Codex config.toml could not be read; this account keeps its last-synced settings.' }
    }
    if (!sourceContents.trim()) {
      return { kind: 'source-empty', message: 'System Codex config.toml is empty; this account keeps its last-synced settings.' }
    }
    let parsedSource: Record<string, unknown>
    try {
      parsedSource = parseCodexConfig(sourceContents)
    } catch {
      return { kind: 'sync-failed', message: 'System Codex config could not be synchronized; this account kept its last-synced settings.' }
    }
    const modelProvider = parsedSource.model_provider
    if (modelProvider !== undefined && (typeof modelProvider !== 'string' || modelProvider.toLowerCase() !== 'openai')) {
      return { kind: 'sync-failed', message: 'System Codex config uses a custom model provider; this OAuth account kept its last-synced settings.' }
    }
    const target = join(home, 'config.toml')
    let current = ''
    try {
      const targetStat = lstatSync(target)
      if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
        return { kind: 'sync-failed', message: 'Codex settings could not be synchronized; this account keeps its last-synced settings.' }
      }
      current = readFileSync(target, 'utf8')
    } catch (error) {
      if (!isMissing(error)) {
        return { kind: 'sync-failed', message: 'Codex settings could not be synchronized; this account keeps its last-synced settings.' }
      }
    }
    const next = forceCodexFileCredentials(sourceContents)
    if (current === next) return { kind: 'synced' }
    try {
      this.replacePrivateFile(target, next)
      return { kind: 'synced' }
    } catch {
      return { kind: 'sync-failed', message: 'Codex settings could not be synchronized; this account keeps its last-synced settings.' }
    }
  }

  protectAuthFile(provider: ManagedProvider, home: string): void {
    const file = provider === 'claude' ? join(home, '.credentials.json') : join(home, 'auth.json')
    try {
      if (lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink()) chmodSync(file, 0o600)
    } catch (error) {
      if (!isMissing(error)) throw new Error('The provider credential file is unavailable.')
    }
  }

  remove(provider: ManagedProvider, id: string): void {
    const home = this.ensureOwned(provider, id)
    if (provider === 'claude') this.deleteClaudeKeychainCredential(home)
    const accountDir = dirname(home)
    try {
      rmSync(accountDir, { recursive: true, force: false })
    } catch {
      throw new Error('The managed account profile could not be removed. Close any provider process using it and retry.')
    }
  }

  private setupClaude(home: string): void {
    const defaultHome = this.defaultClaudeHome()
    this.copyOptionalFile(join(defaultHome, 'settings.json'), join(home, 'settings.json'))
    this.copyOptionalFile(join(defaultHome, 'CLAUDE.md'), join(home, 'CLAUDE.md'))
    for (const entry of ['commands', 'agents', 'skills', 'hooks', 'plugins']) {
      this.copyOptionalTree(join(defaultHome, entry), join(home, entry))
    }
    this.linkClaudeHistory(home, defaultHome)
  }

  private setupCodex(home: string): void {
    const defaultHome = this.defaultCodexHome()
    let config: string | null = null
    try {
      const source = this.readOptionalText(join(defaultHome, 'config.toml'))
      if (source !== null) {
        const modelProvider = parseCodexConfig(source).model_provider
        if (modelProvider === undefined || typeof modelProvider === 'string' && modelProvider.toLowerCase() === 'openai') {
          config = source
        }
      }
    } catch {
      // Config sync reports the source issue after the private profile is created.
    }
    this.writePrivateFile(join(home, 'config.toml'), forceCodexFileCredentials(config ?? ''))
    for (const entry of CODEX_RESOURCES) {
      const source = join(defaultHome, entry)
      const target = join(home, entry)
      if (entry === 'AGENTS.md') this.copyOptionalFile(source, target)
      else this.copyOptionalTree(source, target)
    }
  }

  private linkClaudeHistory(profileHome: string, defaultHome: string): void {
    for (const entry of CLAUDE_HISTORY_DIRS) {
      const target = join(profileHome, entry)
      if (this.pathExists(target)) continue
      const source = join(defaultHome, entry)
      let sourceIsDirectory = false
      try {
        const stat = lstatSync(source)
        sourceIsDirectory = stat.isDirectory() && !stat.isSymbolicLink()
      } catch (error) {
        if (!isMissing(error)) throw error
      }
      let shared = source
      if (!sourceIsDirectory) {
        shared = join(this.historyRoot, entry)
        if (!this.pathExists(shared)) this.ensureDirectories(this.historyRoot, shared)
      }
      symlinkSync(shared, target, 'dir')
    }
    const historyFile = join(profileHome, 'history.jsonl')
    if (this.pathExists(historyFile)) return
    const defaultHistory = join(defaultHome, 'history.jsonl')
    let sourceIsFile = false
    try {
      const stat = lstatSync(defaultHistory)
      sourceIsFile = stat.isFile() && !stat.isSymbolicLink()
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    if (sourceIsFile) {
      symlinkSync(defaultHistory, historyFile)
      return
    }
    const sharedHistory = join(this.historyRoot, 'history.jsonl')
    if (!this.pathExists(sharedHistory)) this.writePrivateFile(sharedHistory, '')
    symlinkSync(sharedHistory, historyFile)
  }

  private copyOptionalFile(source: string, target: string): void {
    let stat
    try {
      stat = lstatSync(source)
    } catch (error) {
      if (isMissing(error)) return
      throw new Error('Provider configuration could not be read.')
    }
    if (stat.isSymbolicLink() || !stat.isFile() || this.pathExists(target)) return
    try {
      this.ensureDirectories(this.dataRoot, dirname(target))
      copyFileSync(source, target)
      chmodSync(target, 0o600)
    } catch {
      throw new Error('Provider configuration could not be copied to the managed profile.')
    }
  }

  private copyOptionalTree(source: string, target: string): void {
    let stat
    try {
      stat = lstatSync(source)
    } catch (error) {
      if (isMissing(error)) return
      throw new Error('Provider resources could not be read.')
    }
    if (stat.isSymbolicLink()) return
    if (stat.isDirectory()) {
      if (this.pathExists(target)) return
      mkdirSync(target, { recursive: true, mode: 0o700 })
      chmodSync(target, 0o700)
      let names: string[]
      try {
        names = readdirSync(source)
      } catch {
        throw new Error('Provider resources could not be read.')
      }
      for (const name of names) this.copyOptionalTree(join(source, name), join(target, name))
      return
    }
    if (!stat.isFile() || this.pathExists(target)) return
    try {
      this.ensureDirectories(this.dataRoot, dirname(target))
      copyFileSync(source, target)
      chmodSync(target, 0o600)
    } catch {
      throw new Error('Provider resources could not be copied to the managed profile.')
    }
  }

  private readClaudeIdentity(home: string, includeEnvironmentApiKey: boolean): ProviderIdentity {
    const stateText = this.readOptionalText(join(home, '.claude.json'))
    const state = stateText === null ? null : parseRecord(stateText)
    const oauth = asRecord(state?.oauthAccount)
    const email = normalize(stringValue(oauth?.emailAddress) ?? stringValue(oauth?.email))
    const organization = normalize(stringValue(oauth?.organizationName) ?? stringValue(oauth?.organizationUuid))
    const credentialText = this.readOptionalText(join(home, '.credentials.json'))
    const credentials = credentialText === null ? null : parseRecord(credentialText)
    const oauthCredential = asRecord(credentials?.claudeAiOauth)
    const hasFileToken = Boolean(stringValue(oauthCredential?.accessToken) || stringValue(oauthCredential?.refreshToken))
    const keychain = hasFileToken ? { hasCredential: false, unavailable: false } : this.readClaudeKeychain(home, this.isManagedHomePath(home))
    const hasApiKey = Boolean(stringValue(state?.primaryApiKey)) || (includeEnvironmentApiKey && Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN))
    const hasAuth = hasFileToken || keychain.hasCredential || hasApiKey
    const authKind = hasFileToken || keychain.hasCredential ? 'oauth' : hasApiKey ? 'api-key' : keychain.unavailable ? 'unknown' : 'none'
    const identityKey = email ? `claude:${email.toLocaleLowerCase('en-US')}:${organization?.toLocaleLowerCase('en-US') ?? ''}` : null
    return { email, organization, authKind, hasAuth, identityKey }
  }

  private readCodexIdentity(home: string): CodexIdentity {
    const text = this.readOptionalText(join(home, 'auth.json'))
    if (text === null) return { email: null, organization: null, authKind: 'none', hasAuth: false, identityKey: null, providerAccountId: null, workspaceAccountId: null }
    const raw = parseRecord(text)
    if (!raw) return { email: null, organization: null, authKind: 'unknown', hasAuth: false, identityKey: null, providerAccountId: null, workspaceAccountId: null }
    const tokens = asRecord(raw.tokens)
    const idToken = stringValue(tokens?.id_token) ?? stringValue(tokens?.idToken)
    const claims = idToken ? parseJwtPayload(idToken) : null
    const authClaims = asRecord(claims?.['https://api.openai.com/auth'])
    const profileClaims = asRecord(claims?.['https://api.openai.com/profile'])
    const email = normalize(stringValue(claims?.email) ?? stringValue(profileClaims?.email))
    const providerAccountId = normalize(stringValue(tokens?.account_id) ?? stringValue(tokens?.accountId))
    const workspaceAccountId = normalize(stringValue(authClaims?.chatgpt_account_id) ?? stringValue(claims?.chatgpt_account_id))
    const organization = normalize(stringValue(authClaims?.chatgpt_workspace_name) ?? stringValue(authClaims?.workspace_name) ?? stringValue(raw.workspace_label))
    const authMode = stringValue(raw.auth_mode)?.toLowerCase() ?? ''
    const accessToken = stringValue(tokens?.access_token)
    const hasAuth = Boolean(accessToken || providerAccountId || workspaceAccountId || authMode)
    const authKind = !hasAuth ? 'none' : authMode.includes('api') || authMode === 'apikey' ? 'api-key' : 'oauth'
    const identity = providerAccountId ?? workspaceAccountId ?? email?.toLocaleLowerCase('en-US') ?? null
    return {
      email,
      organization,
      authKind,
      hasAuth,
      identityKey: identity === null ? null : `codex:${identity}`,
      providerAccountId,
      workspaceAccountId
    }
  }

  private readClaudeKeychain(home: string, managed: boolean): SecurityReadResult {
    const systemClaudeHome = join(process.env.HOME ?? '', '.claude')
    const service = managed || resolve(home) !== resolve(systemClaudeHome)
      ? `Claude Code-credentials-${claudeKeychainSuffix(home)}`
      : 'Claude Code-credentials'
    const account = keychainAccountName()
    const result = spawnSync('security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 4096,
      env: process.env
    })
    if (result.error) return { hasCredential: false, unavailable: true }
    if (result.status === 44 || /could not be found/i.test(result.stderr)) return { hasCredential: false, unavailable: false }
    if (result.status !== 0) return { hasCredential: false, unavailable: true }
    return { hasCredential: result.stdout.trim().length > 0, unavailable: false }
  }

  private deleteClaudeKeychainCredential(home: string): void {
    const service = `Claude Code-credentials-${claudeKeychainSuffix(home)}`
    const result = spawnSync('security', ['delete-generic-password', '-s', service, '-a', keychainAccountName()], {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 4096,
      env: process.env
    })
    if (result.error || (result.status !== 0 && result.status !== 44 && !/could not be found/i.test(result.stderr))) {
      throw new Error('The managed Claude credential could not be removed from Keychain.')
    }
  }

  private writeOwner(provider: ManagedProvider, id: string, home: string): void {
    this.writePrivateFile(this.ownerPath(home), `${provider}:${id}:${OWNER_VERSION}\n`)
  }

  private readOwner(home: string): OwnerRecord | null {
    try {
      const parts = readFileSync(this.ownerPath(home), 'utf8').trim().split(':')
      const provider = parts[0]
      const id = parts[1]
      const version = Number(parts[2])
      if ((provider !== 'claude' && provider !== 'codex') || !id || version !== OWNER_VERSION) return null
      return { version: OWNER_VERSION, provider, id }
    } catch {
      return null
    }
  }

  private ownerPath(home: string): string {
    return join(dirname(home), OWNER_FILE)
  }

  private defaultClaudeHome(): string {
    const override = process.env.CLAUDE_CONFIG_DIR?.trim()
    if (override) return resolve(override)
    return join(process.env.HOME ?? '', '.claude')
  }

  private defaultCodexHome(): string {
    const override = process.env.CODEX_HOME?.trim()
    if (override) return resolve(override)
    return join(process.env.HOME ?? '', '.codex')
  }

  private isManagedHomePath(home: string): boolean {
    const suffix = relative(this.root, resolve(home))
    return suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
  }

  private assertId(id: string): void {
    if (!MANAGED_ID_RE.test(id)) throw new Error('The managed account identifier is invalid.')
  }

  private ensureDirectories(root: string, target: string): void {
    const rootPath = resolve(root)
    const targetPath = resolve(target)
    const suffix = relative(rootPath, targetPath)
    if (suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
      throw new Error('Managed profile path escapes its private root.')
    }
    if (!existsSync(rootPath)) mkdirSync(rootPath, { recursive: true, mode: 0o700 })
    this.assertDirectory(rootPath)
    let cursor = rootPath
    if (suffix) {
      for (const part of suffix.split(sep)) {
        cursor = join(cursor, part)
        try {
          const stat = lstatSync(cursor)
          if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Managed profile path is not a private directory.')
        } catch (error) {
          if (!isMissing(error)) throw error
          mkdirSync(cursor, { mode: 0o700 })
        }
        chmodSync(cursor, 0o700)
      }
    }
  }

  private assertDirectory(path: string): void {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Managed profile root is not a private directory.')
  }

  private assertNoLinks(root: string, target: string): void {
    const rootPath = resolve(root)
    this.assertDirectory(rootPath)
    if (realpathSync.native(rootPath) !== rootPath) throw new Error('Managed profile root is not canonical.')
    const suffix = relative(rootPath, resolve(target))
    if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
      throw new Error('Managed profile path is outside its private root.')
    }
    let cursor = rootPath
    for (const part of suffix.split(sep)) {
      cursor = join(cursor, part)
      try {
        if (lstatSync(cursor).isSymbolicLink()) throw new Error('Managed profile path contains an unsafe link.')
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    }
  }

  private pathExists(path: string): boolean {
    try {
      lstatSync(path)
      return true
    } catch (error) {
      if (isMissing(error)) return false
      throw new Error('Managed profile is unavailable.')
    }
  }

  private writePrivateFile(path: string, contents: string): void {
    this.ensureDirectories(this.dataRoot, dirname(path))
    writeFileSync(path, contents, { flag: 'wx', mode: 0o600 })
    chmodSync(path, 0o600)
  }

  private replacePrivateFile(path: string, contents: string): void {
    this.ensureDirectories(this.dataRoot, dirname(path))
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, contents, { flag: 'wx', mode: 0o600 })
      chmodSync(temp, 0o600)
      renameSync(temp, path)
    } catch {
      rmSync(temp, { force: true })
      throw new Error('The private Codex config could not be atomically replaced.')
    }
  }

  private readOptionalText(path: string): string | null {
    try {
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() || !stat.isFile()) return null
      return readFileSync(path, 'utf8')
    } catch (error) {
      if (isMissing(error)) return null
      throw new Error('Provider account files are unavailable.')
    }
  }

  private removeIncomplete(provider: ManagedProvider, id: string, home: string): void {
    try {
      const owner = this.readOwner(home)
      if (owner && (owner.provider !== provider || owner.id !== id)) return
      this.assertNoLinks(this.root, home)
      const stat = lstatSync(home)
      if (stat.isDirectory() && !stat.isSymbolicLink()) rmSync(dirname(home), { recursive: true, force: true })
    } catch {
      // The setup error is primary; an unmarked partial profile cannot be selected or used.
    }
  }

  private safeProfileError(error: unknown): Error {
    if (error instanceof Error && /custom provider/i.test(error.message)) return error
    return new Error('The managed provider profile could not be prepared.')
  }
}

export function isSameIdentity(provider: ManagedProvider, left: ProviderIdentity, right: ProviderIdentity): boolean {
  if (provider === 'claude') {
    if (!left.email || !right.email || left.email.toLocaleLowerCase('en-US') !== right.email.toLocaleLowerCase('en-US')) return false
    return !left.organization || !right.organization || left.organization.toLocaleLowerCase('en-US') === right.organization.toLocaleLowerCase('en-US')
  }
  if (left.email && right.email && left.email.toLocaleLowerCase('en-US') !== right.email.toLocaleLowerCase('en-US')) return false
  return left.identityKey !== null && left.identityKey === right.identityKey
}

export function isProviderAuth(identity: ProviderIdentity): boolean {
  return identity.hasAuth && identity.authKind === 'oauth'
}

export function redactProviderError(provider: ManagedProvider): string {
  return provider === 'claude' ? 'Claude sign-in failed. Retry or check the Claude CLI.' : 'Codex sign-in failed. Retry or check the Codex CLI.'
}

function parseCodexConfig(contents: string): Record<string, unknown> {
  const parsed: unknown = Bun.TOML.parse(contents)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Codex config must be a TOML table.')
  }
  return parsed as Record<string, unknown>
}

function forceCodexFileCredentials(contents: string): string {
  const lines = contents.split(/\r?\n/)
  let inSection = false
  let found = false
  const updated = lines.map((line) => {
    if (/^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(line)) inSection = true
    if (!inSection && /^\s*cli_auth_credentials_store\s*=/.test(line)) {
      found = true
      return 'cli_auth_credentials_store = "file"'
    }
    return line
  })
  if (!found) updated.unshift('cli_auth_credentials_store = "file"')
  return `${updated.join('\n').replace(/\n+$/, '')}\n`
}

function parseJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length < 2 || !parts[1]) return null
  try {
    const value: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return asRecord(value)
  } catch {
    return null
  }
}

function parseRecord(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return asRecord(value)
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function normalize(value: string | null): string | null {
  return value?.trim() || null
}

function claudeKeychainSuffix(home: string): string {
  return createHash('sha256').update(home.normalize('NFC')).digest('hex').slice(0, 8)
}

function keychainAccountName(): string {
  const value = process.env.USER || process.env.USERNAME || 'claude-code-user'
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : 'claude-code-user'
}

function isMissing(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  return code === 'ENOENT' || code === 'ENOTDIR'
}
