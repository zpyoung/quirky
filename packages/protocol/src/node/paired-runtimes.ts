import { closeSync, chmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseMobileOffer, parseOwnerCliOffer, type MobilePairOffer } from '../paired-client/offers'
import type { OwnerCliPairOffer } from '../runtime-owner'

const STORE_FILENAME = 'paired-runtimes.json'
const STORE_VERSION = 2
const LEGACY_STORE_VERSION = 1
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type RuntimeOffer = MobilePairOffer | OwnerCliPairOffer
type RuntimeScope = RuntimeOffer['scope']

/** Secrets are private to QUIRKY_HOME and never included in summaries. */
export type StoredRuntimeTarget = {
  id: string
  name: string
  pairingCode: string
  endpoint: string
  publicKeyB64: string
  pairedDeviceId: string
  scope: RuntimeScope
  grantId: string | null
  createdAt: number
  lastUsedAt: number | null
}

export type ResolvedRuntimeTarget = StoredRuntimeTarget

export type PairedRuntimeSummary = {
  id: string
  name: string
  endpoint: string
  pairedDeviceId: string
  scope: RuntimeScope
  grantId?: string
  createdAt: number
  lastUsedAt: number | null
}

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

function parseRuntimeOffer(pairingCode: string): RuntimeOffer {
  try { return parseOwnerCliOffer(pairingCode) } catch (ownerError) {
    try { return parseMobileOffer(pairingCode) } catch { throw ownerError }
  }
}

function parseStoredTarget(value: unknown, legacy = false): ResolvedRuntimeTarget {
  const keys = legacy
    ? ['id', 'name', 'pairingCode', 'endpoint', 'pairedDeviceId', 'createdAt', 'lastUsedAt']
    : ['id', 'name', 'pairingCode', 'endpoint', 'publicKeyB64', 'pairedDeviceId', 'scope', 'grantId', 'createdAt', 'lastUsedAt']
  if (!isRecord(value) || !exactKeys(value, keys)) throw new Error('Saved paired runtime metadata is invalid')
  if (typeof value.id !== 'string' || !UUID.test(value.id) || typeof value.name !== 'string' ||
    value.name.trim().length === 0 || value.name.length > 80 || typeof value.pairingCode !== 'string' ||
    typeof value.endpoint !== 'string' || !validEndpoint(value.endpoint) ||
    typeof value.pairedDeviceId !== 'string' || !UUID.test(value.pairedDeviceId) || !Number.isFinite(value.createdAt) ||
    (value.lastUsedAt !== null && (typeof value.lastUsedAt !== 'number' || !Number.isFinite(value.lastUsedAt)))) {
    throw new Error('Saved paired runtime metadata is invalid')
  }
  const offer = legacy ? parseMobileOffer(value.pairingCode) : parseRuntimeOffer(value.pairingCode)
  const scope = legacy ? 'mobile' : value.scope as RuntimeScope
  const grantId = legacy ? null : value.grantId as string | null
  if ((scope !== 'mobile' && scope !== 'owner-cli') || offer.scope !== scope ||
    offer.endpoint !== value.endpoint || offer.pairedDeviceId !== value.pairedDeviceId ||
    (!legacy && offer.publicKeyB64 !== value.publicKeyB64) ||
    (scope === 'mobile' && grantId !== null) ||
    (scope === 'owner-cli' && (typeof grantId !== 'string' || grantId !== offer.pairedDeviceId))) {
    throw new Error('Saved paired runtime identity does not match its pinned offer')
  }
  return {
    id: value.id,
    name: value.name,
    pairingCode: value.pairingCode,
    endpoint: value.endpoint,
    publicKeyB64: offer.publicKeyB64,
    pairedDeviceId: value.pairedDeviceId,
    scope,
    grantId,
    createdAt: value.createdAt as number,
    lastUsedAt: value.lastUsedAt as number | null
  }
}

function readTargets(home: string): ResolvedRuntimeTarget[] {
  const path = savedRuntimeStorePath(home)
  let info
  try { info = lstatSync(path) } catch (error) {
    if (missingPath(error)) return []
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Saved paired runtime store is not a regular file')
  chmodSync(path, 0o600)
  let value: unknown
  try { value = JSON.parse(readFileSync(path, 'utf8')) as unknown } catch { throw new Error('Saved paired runtime store is invalid JSON') }
  if (!isRecord(value) || !exactKeys(value, ['version', 'runtimes']) ||
    (value.version !== STORE_VERSION && value.version !== LEGACY_STORE_VERSION) || !Array.isArray(value.runtimes)) {
    throw new Error('Saved paired runtime store is invalid')
  }
  const legacy = value.version === LEGACY_STORE_VERSION
  const targets = value.runtimes.map((target) => parseStoredTarget(target, legacy))
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const target of targets) {
    const normalizedName = target.name.toLocaleLowerCase('en-US')
    if (ids.has(target.id) || names.has(normalizedName)) throw new Error('Saved paired runtime identities are ambiguous')
    ids.add(target.id)
    names.add(normalizedName)
  }
  return targets
}

function writeTargets(home: string, targets: ResolvedRuntimeTarget[]): void {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  chmodSync(home, 0o700)
  const path = savedRuntimeStorePath(home)
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Saved paired runtime store is not a regular file')
  } catch (error) {
    if (!missingPath(error)) throw error
  }
  const temporary = join(home, `.${STORE_FILENAME}.${randomUUID()}.tmp`)
  const descriptor = openSync(temporary, 'wx', 0o600)
  let open = true
  try {
    writeFileSync(descriptor, JSON.stringify({ version: STORE_VERSION, runtimes: targets }, null, 2))
    fsyncSync(descriptor)
    closeSync(descriptor)
    open = false
    renameSync(temporary, path)
    chmodSync(path, 0o600)
  } catch (error) {
    if (open) closeSync(descriptor)
    try { unlinkSync(temporary) } catch {}
    throw error
  }
}

export function savedRuntimeStorePath(home: string): string {
  return join(home, STORE_FILENAME)
}

export function summarizeSavedRuntimeTarget(target: ResolvedRuntimeTarget): PairedRuntimeSummary {
  return {
    id: target.id,
    name: target.name,
    endpoint: target.endpoint,
    pairedDeviceId: target.pairedDeviceId,
    scope: target.scope,
    ...(target.grantId === null ? {} : { grantId: target.grantId }),
    createdAt: target.createdAt,
    lastUsedAt: target.lastUsedAt
  }
}

export function listSavedRuntimeTargets(home: string): PairedRuntimeSummary[] {
  return readTargets(home).map(summarizeSavedRuntimeTarget)
}

export function addSavedRuntimeTarget(home: string, name: string, pairingCode: string): PairedRuntimeSummary {
  const normalizedName = name.trim()
  if (normalizedName.length === 0 || normalizedName.length > 80) throw new Error('Runtime name must be between 1 and 80 characters')
  const offer = parseRuntimeOffer(pairingCode)
  const targets = readTargets(home)
  if (targets.some((target) => target.name.toLocaleLowerCase('en-US') === normalizedName.toLocaleLowerCase('en-US'))) {
    throw new Error(`A saved runtime named ${JSON.stringify(normalizedName)} already exists`)
  }
  const target: ResolvedRuntimeTarget = {
    id: randomUUID(),
    name: normalizedName,
    pairingCode: pairingCode.trim(),
    endpoint: offer.endpoint,
    publicKeyB64: offer.publicKeyB64,
    pairedDeviceId: offer.pairedDeviceId,
    scope: offer.scope,
    grantId: offer.scope === 'owner-cli' ? offer.pairedDeviceId : null,
    createdAt: Date.now(),
    lastUsedAt: null
  }
  targets.push(target)
  writeTargets(home, targets)
  return summarizeSavedRuntimeTarget(target)
}

/** Returns the secret offer only for a connection setup; callers must never serialize it. */
export function resolveSavedRuntimeTarget(home: string, selector: string): ResolvedRuntimeTarget {
  const targets = readTargets(home)
  const byId = targets.find((target) => target.id === selector)
  if (byId) return byId
  const matches = targets.filter((target) => target.name.toLocaleLowerCase('en-US') === selector.toLocaleLowerCase('en-US'))
  if (matches.length === 0) throw new Error('saved runtime was not found')
  if (matches.length > 1) throw new Error('saved runtime is ambiguous')
  return matches[0]!
}

export function markSavedRuntimeTargetUsed(home: string, id: string, at = Date.now()): void {
  const targets = readTargets(home)
  const target = targets.find((candidate) => candidate.id === id)
  if (!target) throw new Error(`saved runtime ${JSON.stringify(id)} was not found`)
  target.lastUsedAt = at
  writeTargets(home, targets)
}

export function removeSavedRuntimeTarget(home: string, selector: string): PairedRuntimeSummary {
  const targets = readTargets(home)
  const byId = targets.findIndex((target) => target.id === selector)
  const matches = byId >= 0 ? [byId] : targets.flatMap((target, index) =>
    target.name.toLocaleLowerCase('en-US') === selector.toLocaleLowerCase('en-US') ? [index] : []
  )
  if (matches.length === 0) throw new Error('saved runtime was not found')
  if (matches.length > 1) throw new Error('saved runtime is ambiguous')
  const [removed] = targets.splice(matches[0]!, 1)
  writeTargets(home, targets)
  return summarizeSavedRuntimeTarget(removed!)
}
