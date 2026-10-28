import { pbkdf2Sync } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { validateValue, type Schema } from '@quirky/protocol'
import { BrowserFault, fault } from '../runtime/errors'
import type { BrowserDependencies } from '../runtime/dependencies'
import { decryptChromiumValue, parseCookieJson, parseCookieRows, parseSafariBinaryCookies, registrableFamily, validateSourceProfile } from './policy'
import type { BrowserFamily, Cookie, ImportSource, SameSite } from './types'

export type DetectedBrowser = {
  family: BrowserFamily
  label: string
  profiles: Array<{ name: string; label: string }>
}

export type SourceCookies = {
  cookies: Cookie[]
  totalCookies: number
  skippedCookies: number
  unreadablePartitionDomains: string[]
  unreadableCookieDomains: string[]
  warnings: string[]
}

export type CookieSourceRequest = ImportSource

const FAMILY_LABELS: Record<BrowserFamily, string> = {
  chrome: 'Google Chrome',
  edge: 'Microsoft Edge',
  arc: 'Arc',
  chromium: 'Brave',
  comet: 'Comet',
  helium: 'Helium',
  firefox: 'Firefox',
  safari: 'Safari'
}

const ROW_SCHEMA: Schema = {
  type: 'object',
  properties: {
    host_key: { type: 'string' },
    host: { type: 'string' },
    name: { type: 'string' },
    value: { type: 'string' },
    path: { type: 'string' },
    encrypted_value: {},
    expires_utc: {},
    expiry: {},
    is_secure: {},
    is_httponly: {},
    isSecure: {},
    isHttpOnly: {},
    samesite: {},
    sameSite: {},
    rawSameSite: {},
    has_expires: {},
    isSession: {},
    isDomain: {},
    is_partitioned: {},
    top_frame_site_key: {},
    has_cross_site_ancestor: {},
    originAttributes: {}
  },
  required: ['name', 'value', 'path'],
  additionalProperties: true
}

const META_SCHEMA: Schema = {
  type: 'object',
  properties: { value: {} },
  required: ['value'],
  additionalProperties: true
}

const LABELS: Record<string, string> = {
  Default: 'Default',
  'default-release': 'Default release'
}
function profileLabel(name: string): string {
  return Object.hasOwn(LABELS, name) ? LABELS[name]! : name
}


function familyRoot(family: BrowserFamily, home: string): string {
  const roots: Record<BrowserFamily, string> = {
    chrome: join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
    edge: join(home, 'Library', 'Application Support', 'Microsoft Edge'),
    arc: join(home, 'Library', 'Application Support', 'Arc', 'User Data'),
    chromium: join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'),
    comet: join(home, 'Library', 'Application Support', 'Perplexity', 'Comet'),
    helium: join(home, 'Library', 'Application Support', 'Helium'),
    firefox: join(home, 'Library', 'Application Support', 'Firefox'),
    safari: join(home, 'Library', 'Cookies', 'Cookies.binarycookies')
  }
  return roots[family]
}

function sourceRoot(family: BrowserFamily, dependencies: BrowserDependencies): string {
  return dependencies.sourceRoots?.[family] ?? familyRoot(family, homedir())
}

function sourceUnavailable(detail: string): never {
  throw fault('browser_import_source_unavailable', detail)
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function readDirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    if (existsSync(path)) sourceUnavailable('source profile directory is inaccessible; close its browser and grant Full Disk Access if macOS denied access')
    return []
  }
}

function sourceCookieFile(path: string): boolean {
  try { return statSync(path).isFile() } catch (error) {
    if (isMissingFile(error)) return false
    return sourceUnavailable('source cookie database is inaccessible; close the source browser and grant Full Disk Access if macOS denied access')
  }
}

function chromiumCookieDatabase(profileDirectory: string): string | undefined {
  const networkDatabase = join(profileDirectory, 'Network', 'Cookies')
  if (sourceCookieFile(networkDatabase)) return networkDatabase
  const legacyDatabase = join(profileDirectory, 'Cookies')
  if (sourceCookieFile(legacyDatabase)) return legacyDatabase
  return undefined
}

type LocalStateProfile = { name: string; label: string }

function localStateProfiles(root: string): LocalStateProfile[] | undefined {
  const localStatePath = join(root, 'Local State')
  if (!existsSync(localStatePath)) return undefined
  let value: unknown
  try {
    value = JSON.parse(readFileSync(localStatePath, 'utf8')) as unknown
  } catch {
    sourceUnavailable('Chromium Local State is unreadable; close the source browser and grant Full Disk Access if macOS denied access')
  }
  const profile = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>).profile
    : undefined
  const cache = typeof profile === 'object' && profile !== null && !Array.isArray(profile)
    ? (profile as Record<string, unknown>).info_cache
    : undefined
  if (typeof cache !== 'object' || cache === null || Array.isArray(cache) || Object.keys(cache).length === 0) return undefined
  return Object.entries(cache).map(([name, metadata]) => {
    const metadataName = typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).name
      : undefined
    const label = typeof metadataName === 'string' && metadataName !== '' ? metadataName : profileLabel(name)
    return { name, label }
  })
}

function chromiumProfiles(root: string): Array<{ name: string; label: string }> {
  if (!existsSync(root)) return []
  const directories = new Set(readDirectories(root))
  const declared = localStateProfiles(root)
  const candidates = declared ?? [...directories].map((name) => ({ name, label: profileLabel(name) }))
  return candidates
    .filter(({ name }) => name !== 'Crash Reports' && name !== 'ShaderCache' && directories.has(name) && isSafeProfileName(name))
    .filter(({ name }) => chromiumCookieDatabase(join(root, name)) !== undefined)
    .sort((a, b) => a.name === 'Default' ? -1 : b.name === 'Default' ? 1 : a.name.localeCompare(b.name))
}

function isSafeProfileName(name: string): boolean {
  try { validateSourceProfile(name); return true } catch { return false }
}

type FirefoxProfile = { name: string; label: string; cookiePath: string }

function sortFirefoxProfiles(profiles: FirefoxProfile[]): FirefoxProfile[] {
  return profiles.sort((a, b) => a.name === 'default-release' ? -1 : b.name === 'default-release' ? 1 : a.name.localeCompare(b.name))
}

function firefoxProfiles(root: string): FirefoxProfile[] {
  if (!existsSync(root)) return []
  const iniPath = join(root, 'profiles.ini')
  const profiles: FirefoxProfile[] = []
  const addProfile = (profileDirectory: string) => {
    const name = basename(profileDirectory)
    if (!isSafeProfileName(name) || profiles.some((profile) => profile.name === name)) return
    const cookiePath = join(profileDirectory, 'cookies.sqlite')
    if (!sourceCookieFile(cookiePath)) return
    profiles.push({ name, label: profileLabel(name), cookiePath })
  }
  if (!existsSync(iniPath)) {
    const profilesDirectory = join(root, 'Profiles')
    for (const name of readDirectories(profilesDirectory)) {
      if (isSafeProfileName(name)) addProfile(join(profilesDirectory, name))
    }
    return sortFirefoxProfiles(profiles)
  }

  let ini: string
  try { ini = readFileSync(iniPath, 'utf8') } catch {
    sourceUnavailable('Firefox profiles are inaccessible; close Firefox and grant Full Disk Access if macOS denied access')
  }
  const rootPath = resolve(root)
  let section: { path?: string; isRelative?: boolean } | undefined
  const addSection = () => {
    if (!section?.path || section.isRelative === undefined || section.path.includes('\0')) return
    let profileDirectory: string
    if (section.isRelative) {
      if (isAbsolute(section.path) || section.path.split(/[\\/]/).includes('..')) return
      profileDirectory = resolve(rootPath, section.path)
      const pathFromRoot = relative(rootPath, profileDirectory)
      if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) return
    } else {
      if (!isAbsolute(section.path)) return
      profileDirectory = resolve(section.path)
    }
    addProfile(profileDirectory)
  }
  for (const line of ini.split(/\r?\n/)) {
    const heading = /^\s*\[([^\]]+)\]\s*$/.exec(line)
    if (heading) {
      addSection()
      section = /^Profile\d+$/.test(heading[1]!) ? {} : undefined
      continue
    }
    if (!section) continue
    const profilePath = /^\s*Path\s*=\s*(.*?)\s*$/.exec(line)?.[1]
    if (profilePath !== undefined) section.path = profilePath
    const isRelative = /^\s*IsRelative\s*=\s*([01])\s*$/.exec(line)?.[1]
    if (isRelative !== undefined) section.isRelative = isRelative === '1'
  }
  addSection()
  return sortFirefoxProfiles(profiles)
}

export function detectBrowsers(dependencies: BrowserDependencies): { browsers: DetectedBrowser[] } {
  const browsers: DetectedBrowser[] = []
  for (const family of ['chrome', 'edge', 'arc', 'chromium', 'comet', 'helium'] as const) {
    const profiles = chromiumProfiles(sourceRoot(family, dependencies))
    if (profiles.length > 0) browsers.push({ family, label: FAMILY_LABELS[family], profiles })
  }
  const firefox = firefoxProfiles(sourceRoot('firefox', dependencies))
  if (firefox.length > 0) {
    browsers.push({ family: 'firefox', label: FAMILY_LABELS.firefox, profiles: firefox.map(({ name, label }) => ({ name, label })) })
  }
  const safari = sourceRoot('safari', dependencies)
  if (sourceCookieFile(safari)) browsers.push({ family: 'safari', label: FAMILY_LABELS.safari, profiles: [{ name: 'default', label: 'Safari' }] })
  return { browsers }
}

function resolveSelectedProfile(family: BrowserFamily, requested: string | undefined, dependencies: BrowserDependencies): { path: string; name?: string } {
  const root = sourceRoot(family, dependencies)
  if (family === 'safari') {
    if (requested !== undefined) throw fault('invalid_argument', 'Safari does not support a source profile selector')
    if (!sourceCookieFile(root)) return sourceUnavailable('Safari cookie source was not found; grant Full Disk Access if macOS denied access')
    return { path: root }
  }
  if (requested !== undefined) validateSourceProfile(requested)
  if (family === 'firefox') {
    const profiles = firefoxProfiles(root)
    const name = requested ?? profiles.find((profile) => profile.name === 'default-release')?.name ?? profiles[0]?.name
    if (!name) return sourceUnavailable('Firefox has no usable profile; close Firefox and grant Full Disk Access if macOS denied access')
    const selected = profiles.find((profile) => profile.name === name)
    if (!selected) return sourceUnavailable('selected Firefox profile is unavailable; close Firefox and grant Full Disk Access if macOS denied access')
    return { path: selected.cookiePath, name }
  }
  const profiles = chromiumProfiles(root)
  const name = requested ?? 'Default'
  if (!profiles.some((profile) => profile.name === name)) return sourceUnavailable('selected browser profile is unavailable; close the source browser and grant Full Disk Access if macOS denied access')
  const path = chromiumCookieDatabase(join(root, name))
  if (!path) return sourceUnavailable('selected browser profile has no cookie database; close the source browser and grant Full Disk Access if macOS denied access')
  return { path, name }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function cookieRow(rowValue: unknown): Record<string, unknown> | null {
  if (validateValue(ROW_SCHEMA, rowValue, 'database cookie')) return null
  return rowValue as Record<string, unknown>
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') {
    const number = Number(value)
    return Number.isSafeInteger(number) ? number : null
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const number = Number(value)
    return Number.isSafeInteger(number) ? number : null
  }
  return null
}

function booleanColumn(row: Record<string, unknown>, snake: string, camel?: string): boolean {
  const value = row[snake] ?? (camel ? row[camel] : undefined)
  return value === true || value === 1 || value === 1n
}

function expiryFromChromium(value: unknown): number | undefined {
  try {
    const micros = BigInt(String(value ?? '0'))
    if (micros <= 0n) return undefined
    const seconds = Number(micros / 1_000_000n) - 11_644_473_600
    return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined
  } catch {
    return undefined
  }
}

function databaseSameSite(value: unknown): SameSite | undefined {
  const raw = numberValue(value)
  if (raw === 0) return 'None'
  if (raw === 1) return 'Lax'
  if (raw === 2) return 'Strict'
  return undefined
}

function decodeTopLevelSite(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.origin
  } catch {
    return null
  }
}

type SqliteFileState = {
  device: bigint
  inode: bigint
  size: bigint
  modifiedAt: bigint
  changedAt: bigint
}

function sqliteFileState(path: string): SqliteFileState | null {
  try {
    const stats = statSync(path, { bigint: true })
    return { device: stats.dev, inode: stats.ino, size: stats.size, modifiedAt: stats.mtimeNs, changedAt: stats.ctimeNs }
  } catch (error) {
    if (isMissingFile(error)) return null
    throw error
  }
}

function sameSqliteFileState(left: SqliteFileState | null, right: SqliteFileState | null): boolean {
  if (!left || !right) return left === right
  return left.device === right.device && left.inode === right.inode && left.size === right.size &&
    left.modifiedAt === right.modifiedAt && left.changedAt === right.changedAt
}

function removeSqliteSnapshotFiles(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { unlinkSync(path + suffix) } catch { /* retry cleanup; source paths are never touched */ }
  }
}

function copyStableSqliteAttempt(sourcePath: string, snapshotPath: string): boolean {
  removeSqliteSnapshotFiles(snapshotPath)
  const sourceWalPath = `${sourcePath}-wal`
  const databaseBefore = sqliteFileState(sourcePath)
  const walBefore = sqliteFileState(sourceWalPath)
  if (!databaseBefore) throw new Error('source SQLite database disappeared')

  copyFileSync(sourcePath, snapshotPath)
  chmodSync(snapshotPath, 0o600)
  if (walBefore) {
    try {
      copyFileSync(sourceWalPath, `${snapshotPath}-wal`)
      chmodSync(`${snapshotPath}-wal`, 0o600)
    } catch (error) {
      if (isMissingFile(error)) return false
      throw error
    }
  }

  const databaseAfter = sqliteFileState(sourcePath)
  const walAfter = sqliteFileState(sourceWalPath)
  if (!sameSqliteFileState(databaseBefore, databaseAfter) || !sameSqliteFileState(walBefore, walAfter)) return false

  const copiedDatabase = sqliteFileState(snapshotPath)
  const copiedWal = sqliteFileState(`${snapshotPath}-wal`)
  return copiedDatabase?.size === databaseBefore.size && (walBefore ? copiedWal?.size === walBefore.size : copiedWal === null)
}

const SQLITE_SNAPSHOT_ATTEMPTS = 5

async function snapshotSqlite(sourcePath: string, dataDir: string): Promise<{ snapshotPath: string; dispose(): void }> {
  const directory = mkdtempSync(join(dataDir, 'import-'))
  const snapshotPath = join(directory, 'source.sqlite')
  let keepSnapshot = false
  try {
    for (let attempt = 0; attempt < SQLITE_SNAPSHOT_ATTEMPTS; attempt += 1) {
      if (!copyStableSqliteAttempt(sourcePath, snapshotPath)) continue
      keepSnapshot = true
      return { snapshotPath, dispose: () => rmSync(directory, { recursive: true, force: true }) }
    }
    return sourceUnavailable('source cookie database changed while creating a consistent snapshot; close its browser and retry')
  } catch (error) {
    if (error instanceof BrowserFault) throw error
    return sourceUnavailable('source cookie database could not be snapshotted; close its browser and grant Full Disk Access if macOS denied access')
  } finally {
    if (!keepSnapshot) rmSync(directory, { recursive: true, force: true })
  }
}

function readDatabaseRows(database: Database, table: string): unknown[] {
  const tableResult = database.query('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', table) as unknown
  const tableFailure = validateValue({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: true }, tableResult, 'sqlite table')
  if (tableFailure) return sourceUnavailable('source cookie database is missing its expected cookie table')
  try { return database.query(`SELECT * FROM "${table}"`).all() as unknown[] } catch {
    return sourceUnavailable('source cookie database could not be read; close its browser and grant Full Disk Access if macOS denied access')
  }
}

async function keyFor(family: BrowserFamily, dependencies: BrowserDependencies): Promise<Buffer | null> {
  if (dependencies.keyProvider) return await dependencies.keyProvider(family)
  return await productionKeyProvider(family)
}

function partitionKeyFor(row: Record<string, unknown>, domain: string): { partitionKey?: Cookie['partitionKey']; unreadable: boolean } {
  const partitioned = booleanColumn(row, 'is_partitioned') || typeof row.top_frame_site_key === 'string' && row.top_frame_site_key !== ''
  if (!partitioned) return { unreadable: false }
  const topLevelSite = decodeTopLevelSite(row.top_frame_site_key)
  if (!topLevelSite || typeof row.has_cross_site_ancestor !== 'number' && typeof row.has_cross_site_ancestor !== 'bigint') {
    return { unreadable: true }
  }
  return {
    partitionKey: { topLevelSite, hasCrossSiteAncestor: booleanColumn(row, 'has_cross_site_ancestor') },
    unreadable: false
  }
}

function chromiumCookie(row: Record<string, unknown>, domain: string, value: string): Cookie | null {
  if (typeof row.name !== 'string' || typeof row.path !== 'string') return null
  const partition = partitionKeyFor(row, domain)
  if (partition.unreadable) return null
  const expires = expiryFromChromium(row.expires_utc)
  const sameSite = databaseSameSite(row.samesite)
  return {
    name: row.name,
    value,
    domain,
    path: row.path || '/',
    secure: booleanColumn(row, 'is_secure'),
    httpOnly: booleanColumn(row, 'is_httponly'),
    hostOnly: !domain.startsWith('.'),
    ...(sameSite ? { sameSite } : {}),
    ...(expires ? { expires } : {}),
    ...(partition.partitionKey ? { partitionKey: partition.partitionKey } : {})
  }
}

async function parseChromium(sourcePath: string, family: BrowserFamily, dataDir: string, dependencies: BrowserDependencies): Promise<SourceCookies> {
  const snapshot = await snapshotSqlite(sourcePath, dataDir)
  try {
    const database = new Database(snapshot.snapshotPath, { readonly: true, create: false })
    try {
      const meta = database.query('SELECT value FROM meta WHERE key = ?').get('version') as unknown
      let version = 0
      if (!validateValue(META_SCHEMA, meta, 'sqlite meta')) {
        const rawVersion = (meta as Record<string, unknown>).value
        const parsed = Number(rawVersion)
        if (Number.isInteger(parsed) && parsed >= 0) version = parsed
      }
      const rows = readDatabaseRows(database, 'cookies')
      const encryptedRows: Array<{ row: Record<string, unknown>; encrypted: Uint8Array }> = []
      const cookies: Cookie[] = []
      const unreadablePartitionDomains: string[] = []
      const unreadableCookieDomains: string[] = []
      let skippedCookies = 0
      const warnings = new Set<string>()
      for (const candidate of rows) {
        const candidateRecord = recordValue(candidate)
        const row = cookieRow(candidate)
        if (!row) {
          skippedCookies += 1
          if (typeof candidateRecord?.host_key === 'string') {
            unreadableCookieDomains.push(candidateRecord.host_key)
            warnings.add('malformed-source-row')
          }
          continue
        }
        const domain = typeof row.host_key === 'string' ? row.host_key : null
        if (!domain || typeof row.name !== 'string' || typeof row.value !== 'string') {
          skippedCookies += 1
          continue
        }
        const encrypted = row.encrypted_value instanceof Uint8Array ? row.encrypted_value : new Uint8Array()
        if (row.value === '' && encrypted.length > 0) {
          const marker = Buffer.from(encrypted).subarray(0, 3).toString('ascii')
          if (marker === 'v10' || marker === 'v11') encryptedRows.push({ row, encrypted })
          else {
            skippedCookies += 1
            unreadableCookieDomains.push(domain)
            warnings.add('unsupported-encryption')
          }
          continue
        }
        const partition = partitionKeyFor(row, domain)
        if (partition.unreadable) {
          unreadablePartitionDomains.push(domain)
          skippedCookies += 1
          continue
        }
        const cookie = chromiumCookie(row, domain, row.value)
        if (!cookie) {
          skippedCookies += 1
          continue
        }
        cookies.push(cookie)
      }
      if (encryptedRows.length > 0) {
        let password: Buffer | null = null
        try { password = await keyFor(family, dependencies) } catch { /* missing key access is handled per cookie as a safe decryption skip */ }
        const key = password ? pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1') : null
        for (const { row, encrypted } of encryptedRows) {
          const domain = row.host_key as string
          const value = key ? decryptChromiumValue(encrypted, key, domain, version) : null
          if (value === null) {
            skippedCookies += 1
            unreadableCookieDomains.push(domain)
            warnings.add('decryption-skipped')
            continue
          }
          const partition = partitionKeyFor(row, domain)
          if (partition.unreadable) {
            unreadablePartitionDomains.push(domain)
            skippedCookies += 1
            continue
          }
          const cookie = chromiumCookie(row, domain, value)
          if (!cookie) {
            skippedCookies += 1
            continue
          }
          cookies.push(cookie)
        }
      }
      return {
        cookies,
        totalCookies: rows.length,
        skippedCookies,
        unreadablePartitionDomains,
        unreadableCookieDomains,
        warnings: [...warnings]
      }
    } finally {
      database.close()
    }
  } catch (error) {
    if (error instanceof BrowserFault) throw error
    return sourceUnavailable('source cookie database could not be parsed; close its browser and grant Full Disk Access if macOS denied access')
  } finally {
    snapshot.dispose()
  }
}

function firefoxPartitionAttribute(value: unknown): boolean {
  if (typeof value !== 'string') return false
  let decoded = value
  try { decoded = decodeURIComponent(value) } catch { /* retain opaque attributes as unreadable */ }
  return /(?:^|\^)partitionKey=/i.test(decoded) || /partitionKey=\(/i.test(decoded)
}

async function parseFirefox(sourcePath: string, dataDir: string): Promise<SourceCookies> {
  const snapshot = await snapshotSqlite(sourcePath, dataDir)
  try {
    const database = new Database(snapshot.snapshotPath, { readonly: true, create: false })
    try {
      const rows = readDatabaseRows(database, 'moz_cookies')
      const cookies: Cookie[] = []
      const unreadablePartitionDomains: string[] = []
      const unreadableCookieDomains: string[] = []
      const warnings = new Set<string>()
      let skippedCookies = 0
      for (const candidate of rows) {
        const candidateRecord = recordValue(candidate)
        const row = cookieRow(candidate)
        if (!row) {
          skippedCookies += 1
          if (typeof candidateRecord?.host === 'string') {
            unreadableCookieDomains.push(candidateRecord.host)
            warnings.add('malformed-source-row')
          }
          continue
        }
        if (typeof row.host !== 'string' || typeof row.name !== 'string' || typeof row.value !== 'string') {
          skippedCookies += 1
          if (typeof row.host === 'string') {
            unreadableCookieDomains.push(row.host)
            warnings.add('malformed-source-row')
          }
          continue
        }
        if (firefoxPartitionAttribute(row.originAttributes)) {
          unreadablePartitionDomains.push(row.host)
          skippedCookies += 1
          continue
        }
        const expiry = numberValue(row.expiry)
        const sameSite = databaseSameSite(row.rawSameSite ?? row.sameSite)
        cookies.push({
          name: row.name,
          value: row.value,
          domain: row.host,
          path: typeof row.path === 'string' && row.path !== '' ? row.path : '/',
          secure: booleanColumn(row, 'isSecure'),
          httpOnly: booleanColumn(row, 'isHttpOnly'),
          hostOnly: !booleanColumn(row, 'isDomain'),
          ...(sameSite ? { sameSite } : {}),
          ...(expiry !== null && expiry > 0 ? { expires: expiry } : {})
        })
      }
      return { cookies, totalCookies: rows.length, skippedCookies, unreadablePartitionDomains, unreadableCookieDomains, warnings: [...warnings] }
    } finally {
      database.close()
    }
  } catch (error) {
    if (error instanceof BrowserFault) throw error
    return sourceUnavailable('Firefox cookie database could not be parsed; close Firefox and grant Full Disk Access if macOS denied access')
  } finally {
    snapshot.dispose()
  }
}

export async function readCookieSource(
  source: CookieSourceRequest,
  dataDir: string,
  dependencies: BrowserDependencies
): Promise<SourceCookies> {
  if (source.kind === 'file') {
    if (!source.path || !isAbsolute(source.path)) throw fault('invalid_argument', 'cookie file path must be absolute')
    let text: string
    try { text = readFileSync(source.path, 'utf8') } catch {
      return sourceUnavailable('cookie source file is unavailable or unreadable')
    }
    const parsed = parseCookieJson(text)
    return { ...parsed, unreadableCookieDomains: [], warnings: [] }
  }
  if (source.kind === 'json') {
    const parsed = parseCookieRows(source.cookies)
    return { ...parsed, unreadableCookieDomains: [], warnings: [] }
  }
  const profile = resolveSelectedProfile(source.family, source.profile, dependencies)
  if (source.family === 'safari') {
    let bytes: Buffer
    try { bytes = readFileSync(profile.path) } catch {
      return sourceUnavailable('Safari cookie source is unreadable; grant Full Disk Access and close Safari')
    }
    const cookies = parseSafariBinaryCookies(bytes)
    return { cookies, totalCookies: cookies.length, skippedCookies: 0, unreadablePartitionDomains: [], unreadableCookieDomains: [], warnings: [] }
  }
  if (source.family === 'firefox') return await parseFirefox(profile.path, dataDir)
  return await parseChromium(profile.path, source.family, dataDir, dependencies)
}

export async function productionKeyProvider(family: BrowserFamily): Promise<Buffer | null> {
  const service: Partial<Record<BrowserFamily, string>> = {
    chrome: 'Chrome Safe Storage',
    edge: 'Microsoft Edge Safe Storage',
    arc: 'Arc Safe Storage',
    chromium: 'Brave Safe Storage',
    comet: 'Comet Safe Storage',
    helium: 'Helium Safe Storage'
  }
  const item = service[family]
  if (!item || process.platform !== 'darwin' || !existsSync('/usr/bin/security')) return null
  const child = Bun.spawn(['/usr/bin/security', 'find-generic-password', '-w', '-s', item], {
    stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', env: { ...process.env }
  })
  const timeout = Promise.withResolvers<null>()
  const timer = setTimeout(() => timeout.resolve(null), 5_000)
  try {
    const output = async (): Promise<string | null> => {
      const reader = child.stdout.getReader()
      const chunks: Buffer[] = []
      let totalBytes = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) return Buffer.concat(chunks, totalBytes).toString('utf8')
          totalBytes += value.byteLength
          if (totalBytes > 4_096) {
            child.kill('SIGKILL')
            await reader.cancel()
            return null
          }
          chunks.push(Buffer.from(value))
        }
      } finally {
        reader.releaseLock()
      }
    }
    const result = await Promise.race([Promise.all([output(), child.exited]), timeout.promise])
    if (result === null) {
      child.kill('SIGKILL')
      await child.exited
      return null
    }
    const [text, code] = result
    if (code !== 0 || text === null || text.trim() === '') return null
    return Buffer.from(text.trim())
  } catch {
    child.kill('SIGKILL')
    await child.exited
    return null
  } finally {
    clearTimeout(timer)
  }
}
