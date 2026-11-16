import { closeSync, chmodSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
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

type FileIdentity = { dev: number; ino: number }
type OwnerGrantRecoveryHooks = {
  beforeIdentityCheck?(): void
  beforeRename?(): void
}
type QuarantineResult =
  | { outcome: 'quarantined'; path: string }
  | { outcome: 'changed' }
  | { outcome: 'moved-unexpected'; path: string }
  | { outcome: 'occupied' | 'failed' }

let recoveryHooksForTests: OwnerGrantRecoveryHooks | null = null

/** Test-only: installs callbacks inside owner-grant recovery. */
export function setOwnerGrantRecoveryHooksForTests(hooks: OwnerGrantRecoveryHooks | null): void {
  recoveryHooksForTests = hooks
}

function guardedQuarantine(path: string, identity: FileIdentity): QuarantineResult {
  let destination: string | null = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = `${path}.corrupt-${Date.now()}-${randomBytes(4).toString('hex')}`
    try {
      lstatSync(candidate)
    } catch (error) {
      if (missingPath(error)) {
        destination = candidate
        break
      }
    }
  }
  if (!destination) return { outcome: 'occupied' }

  recoveryHooksForTests?.beforeIdentityCheck?.()
  let current
  try {
    current = lstatSync(path)
  } catch {
    return { outcome: 'changed' }
  }
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) {
    return { outcome: 'changed' }
  }

  recoveryHooksForTests?.beforeRename?.()
  try {
    renameSync(path, destination)
  } catch {
    return { outcome: 'failed' }
  }

  try {
    const moved = lstatSync(destination)
    return moved.isFile() && !moved.isSymbolicLink() && moved.dev === identity.dev && moved.ino === identity.ino
      ? { outcome: 'quarantined', path: destination }
      : { outcome: 'moved-unexpected', path: destination }
  } catch {
    return { outcome: 'moved-unexpected', path: destination }
  }
}

function recoveryDiagnostic(result: Exclude<QuarantineResult, { outcome: 'quarantined' }>): string {
  if (result.outcome === 'changed') return `${STORE_FILENAME} changed during recovery; nothing was moved`
  if (result.outcome === 'moved-unexpected') {
    return `${STORE_FILENAME} changed during recovery; a file was set aside as ${basename(result.path)}`
  }
  return `${STORE_FILENAME} could not be set aside`
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

/** Durable authority for full-owner CLI grants; malformed data is quarantined so owners can pair again. */
export class OwnerGrantStore {
  readonly path: string
  private grantsValue: OwnerGrantRecord[] = []
  private recoveredFromValue: string | null = null
  private recoveryDiagnosticValue: string | null = null
  registryAvailable = false

  get recoveredFrom(): string | null {
    return this.recoveredFromValue
  }

  get recoveryDiagnostic(): string | null {
    return this.recoveryDiagnosticValue
  }

  constructor(dataDir: string) {
    this.path = join(dataDir, STORE_FILENAME)
    try {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 })
      this.load()
      if (this.registryAvailable) chmodSync(dataDir, 0o700)
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

    const descriptor = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const opened = fstatSync(descriptor)
      if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) {
        throw new Error('Owner grant registry changed while opening')
      }
      const identity = { dev: opened.dev, ino: opened.ino }
      const content = readFileSync(descriptor, 'utf8')
      let raw: unknown
      try {
        raw = JSON.parse(content) as unknown
      } catch {
        this.recover(identity)
        return
      }

      if (isRecord(raw) && typeof raw.version === 'number' && Number.isInteger(raw.version) && raw.version > STORE_VERSION) return

      let grants: OwnerGrantRecord[]
      try {
        if (!isRecord(raw) || !exactKeys(raw, ['version', 'grants']) || raw.version !== STORE_VERSION || !Array.isArray(raw.grants)) {
          throw new Error('Owner grant registry is invalid')
        }
        grants = raw.grants.map(parseGrant)
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
      } catch {
        this.recover(identity)
        return
      }

      fchmodSync(descriptor, 0o600)
      this.grantsValue = grants
      this.registryAvailable = true
    } finally {
      closeSync(descriptor)
    }
  }

  private recover(identity: FileIdentity): void {
    const result = guardedQuarantine(this.path, identity)
    if (result.outcome === 'quarantined') {
      this.recoveredFromValue = result.path
      this.grantsValue = []
      this.registryAvailable = true
      return
    }
    this.recoveryDiagnosticValue = recoveryDiagnostic(result)
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
