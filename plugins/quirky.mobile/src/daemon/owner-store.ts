import { closeSync, chmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

const STORE_FILENAME = 'owner-grants.json'
const STORE_VERSION = 1
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TOKEN = /^[0-9a-f]{48}$/

export type OwnerGrantRecord = {
  grantId: string
  name: string
  endpoint: string
  token: string
  createdAt: number
}

export type OwnerGrantSummary = {
  grantId: string
  name: string
  endpoint: string
  scope: 'owner-cli'
  createdAt: number
}

export type OwnerAuthenticationResult =
  | { status: 'paired'; grant: OwnerGrantRecord }
  | { status: 'unauthorized' }
  | { status: 'registry_unavailable' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function missingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function validEndpoint(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'ws:' || url.protocol === 'wss:') && !!url.hostname &&
      !url.username && !url.password && !url.search && !url.hash && (url.pathname === '' || url.pathname === '/')
  } catch {
    return false
  }
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function writeSecureAtomic(path: string, content: string): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Owner grant registry is not a regular file')
  } catch (error) {
    if (!missingPath(error)) throw error
  }
  const temporary = join(directory, `.${basename(path)}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`)
  const descriptor = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(descriptor, content, 'utf8')
    fsyncSync(descriptor)
  } catch (error) {
    closeSync(descriptor)
    try { unlinkSync(temporary) } catch {}
    throw error
  }
  closeSync(descriptor)
  try {
    renameSync(temporary, path)
    chmodSync(path, 0o600)
    syncDirectory(directory)
  } catch (error) {
    try { unlinkSync(temporary) } catch {}
    throw error
  }
}

function parseGrant(value: unknown): OwnerGrantRecord {
  if (!isRecord(value) || !exactKeys(value, ['grantId', 'name', 'endpoint', 'token', 'createdAt']) ||
    typeof value.grantId !== 'string' || !UUID.test(value.grantId) ||
    typeof value.name !== 'string' || value.name.trim() !== value.name || value.name.length === 0 || value.name.length > 80 ||
    typeof value.endpoint !== 'string' || !validEndpoint(value.endpoint) ||
    typeof value.token !== 'string' || !TOKEN.test(value.token) ||
    typeof value.createdAt !== 'number' || !Number.isSafeInteger(value.createdAt) || value.createdAt <= 0) {
    throw new Error('Owner grant record is invalid')
  }
  return {
    grantId: value.grantId,
    name: value.name,
    endpoint: value.endpoint,
    token: value.token,
    createdAt: value.createdAt
  }
}

function summary(grant: OwnerGrantRecord): OwnerGrantSummary {
  return {
    grantId: grant.grantId,
    name: grant.name,
    endpoint: grant.endpoint,
    scope: 'owner-cli',
    createdAt: grant.createdAt
  }
}

/** Durable authority for full-owner CLI grants; corruption disables this registry until repaired. */
export class OwnerGrantStore {
  readonly path: string
  private grantsValue: OwnerGrantRecord[] = []
  registryAvailable = false

  constructor(dataDir: string) {
    this.path = join(dataDir, STORE_FILENAME)
    try {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 })
      chmodSync(dataDir, 0o700)
      this.load()
    } catch {
      this.grantsValue = []
      this.registryAvailable = false
    }
  }

  get hasGrants(): boolean {
    return this.registryAvailable && this.grantsValue.length > 0
  }

  grants(): OwnerGrantSummary[] {
    this.ensureAvailable()
    return this.grantsValue.map(summary)
  }

  create(name: string, endpoint: string): OwnerGrantRecord {
    this.ensureAvailable()
    if (name.trim() !== name || name.length === 0 || name.length > 80) throw new Error('Owner grant name must be a trimmed string of 1 to 80 characters')
    if (!validEndpoint(endpoint)) throw new Error('Owner grant endpoint is invalid')
    if (this.grantsValue.some((grant) => grant.name.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'))) {
      throw new Error(`An owner grant named ${JSON.stringify(name)} already exists`)
    }
    const grant: OwnerGrantRecord = {
      grantId: randomUUID(),
      name,
      endpoint,
      token: randomBytes(24).toString('hex'),
      createdAt: Date.now()
    }
    this.persist([...this.grantsValue, grant])
    return { ...grant }
  }

  authenticate(token: string): OwnerAuthenticationResult {
    if (!this.registryAvailable) return { status: 'registry_unavailable' }
    if (!TOKEN.test(token)) return { status: 'unauthorized' }
    const candidate = Buffer.from(token, 'hex')
    let matched: OwnerGrantRecord | undefined
    for (const grant of this.grantsValue) {
      const expected = Buffer.from(grant.token, 'hex')
      if (timingSafeEqual(candidate, expected)) matched = grant
    }
    return matched ? { status: 'paired', grant: { ...matched } } : { status: 'unauthorized' }
  }

  isCurrentCredential(grantId: string, token: string): boolean {
    if (!this.registryAvailable || !TOKEN.test(token)) return false
    const grant = this.grantsValue.find((entry) => entry.grantId === grantId)
    if (!grant) return false
    return timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(grant.token, 'hex'))
  }

  revoke(grantId: string): boolean {
    this.ensureAvailable()
    const index = this.grantsValue.findIndex((grant) => grant.grantId === grantId)
    if (index < 0) return false
    const next = this.grantsValue.filter((_, current) => current !== index)
    this.persist(next)
    return true
  }

  private load(): void {
    let info
    try { info = lstatSync(this.path) } catch (error) {
      if (missingPath(error)) {
        this.registryAvailable = true
        return
      }
      throw error
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Owner grant registry is not a regular file')
    chmodSync(this.path, 0o600)
    const raw = JSON.parse(readFileSync(this.path, 'utf8')) as unknown
    if (!isRecord(raw) || !exactKeys(raw, ['version', 'grants']) || raw.version !== STORE_VERSION || !Array.isArray(raw.grants)) {
      throw new Error('Owner grant registry is invalid')
    }
    const grants = raw.grants.map(parseGrant)
    const ids = new Set<string>()
    const tokens = new Set<string>()
    const names = new Set<string>()
    for (const grant of grants) {
      const normalizedName = grant.name.toLocaleLowerCase('en-US')
      if (ids.has(grant.grantId) || tokens.has(grant.token) || names.has(normalizedName)) throw new Error('Owner grant identities are ambiguous')
      ids.add(grant.grantId)
      tokens.add(grant.token)
      names.add(normalizedName)
    }
    this.grantsValue = grants
    this.registryAvailable = true
  }

  private persist(grants: OwnerGrantRecord[]): void {
    this.ensureAvailable()
    try {
      writeSecureAtomic(this.path, JSON.stringify({ version: STORE_VERSION, grants }, null, 2))
      this.grantsValue = grants.map((grant) => ({ ...grant }))
    } catch {
      this.registryAvailable = false
      throw new Error('Owner grant registry is unavailable')
    }
  }

  private ensureAvailable(): void {
    if (!this.registryAvailable) throw new Error('Owner grant registry is unavailable')
  }
}
