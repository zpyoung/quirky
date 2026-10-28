import { createDecipheriv, createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { validateValue, type Schema } from '@quirky/protocol'
import { parse as parseDomain } from 'tldts'
import { fault } from '../runtime/errors'
import type { Cookie, SameSite } from './types'

export type ParsedCookies = {
  cookies: Cookie[]
  totalCookies: number
  skippedCookies: number
  unreadablePartitionDomains: string[]
}

export type CookieImportPlan = {
  cookies: Cookie[]
  domains: string[]
  skippedCookies: number
  googleCookiesSkipped: number
  partitionSkippedCookies: number
}

const PARTITION_SCHEMA: Schema = {
  type: 'object',
  properties: {
    topLevelSite: { type: 'string' },
    hasCrossSiteAncestor: { type: 'boolean' }
  },
  required: ['topLevelSite', 'hasCrossSiteAncestor'],
  additionalProperties: false
}

const COOKIE_ROW_SCHEMA: Schema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    value: { type: 'string' },
    domain: { type: 'string' },
    path: { type: 'string' },
    secure: { type: 'boolean' },
    httpOnly: { type: 'boolean' },
    hostOnly: { type: 'boolean' },
    sameSite: { type: 'string' },
    expires: { type: 'number' },
    expirationDate: { type: 'number' },
    partitionKey: PARTITION_SCHEMA,
    partitionKeyOpaque: { type: 'boolean' }
  },
  required: ['name', 'value', 'domain'],
  additionalProperties: true
}

const PRIVATE_SUFFIX_OPTIONS = { allowPrivateDomains: true } as const
const SAFARI_EPOCH_DELTA = 978_307_200

export function validateSourceProfile(name: string): string {
  if (name.length === 0 || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw fault('invalid_argument', 'source profile must be one safe directory segment')
  }
  return name
}

export function normalizeCookieDomain(domain: string): string | null {
  const candidate = domain.trim().replace(/^\.+/, '')
  const bracketedIpv6 = candidate.startsWith('[') && candidate.endsWith(']')
  if (candidate === '' || /[/\\@?#%]/.test(candidate) || (!bracketedIpv6 && candidate.includes(':'))) return null
  try {
    const url = new URL(`https://${candidate}/`)
    const normalized = url.hostname.toLowerCase()
    if (url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash || normalized.endsWith('.') || normalized.includes('..')) return null
    if (isIP(normalized) || (normalized.startsWith('[') && normalized.endsWith(']'))) return normalized
    if (!normalized.includes('.')) return null
    const parsed = parseDomain(normalized, PRIVATE_SUFFIX_OPTIONS)
    if (parsed.hostname === null || parsed.domain === null && (parsed.isIcann === true || parsed.isPrivate === true)) return null
    return normalized
  } catch {
    return null
  }
}

export function registrableFamily(domain: string): string | null {
  const host = normalizeCookieDomain(domain)
  if (!host) return null
  if (isIP(host)) return host
  if (host.startsWith('[') && host.endsWith(']') && isIP(host.slice(1, -1)) === 6) return host
  const parsed = parseDomain(host, PRIVATE_SUFFIX_OPTIONS)
  if (parsed.hostname === null) return null
  if (parsed.domain === null) return parsed.isIcann === true || parsed.isPrivate === true ? null : host
  return parsed.domain
}

function sameSiteValue(value: unknown): SameSite | undefined {
  if (typeof value !== 'string') return undefined
  switch (value.toLowerCase()) {
    case 'strict': return 'Strict'
    case 'lax': return 'Lax'
    case 'none':
    case 'no_restriction': return 'None'
    default: return undefined
  }
}

function readablePartitionKey(value: unknown): value is NonNullable<Cookie['partitionKey']> {
  if (validateValue(PARTITION_SCHEMA, value, 'partitionKey')) return false
  try {
    const url = new URL((value as NonNullable<Cookie['partitionKey']>).topLevelSite)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function parseCookieRows(value: unknown): ParsedCookies {
  const rootFailure = validateValue({ type: 'array', items: {} }, value, 'source')
  if (rootFailure) throw fault('browser_import_not_array', 'cookie source must be a JSON array')
  const rows = value as unknown[]
  if (rows.length === 0) throw fault('browser_import_empty', 'cookie source contains no rows')

  const cookies: Cookie[] = []
  const unreadablePartitionDomains: string[] = []
  let skippedCookies = 0
  for (const row of rows) {
    const raw = typeof row === 'object' && row !== null && !Array.isArray(row) ? row as Record<string, unknown> : undefined
    const rawDomain = typeof raw?.domain === 'string' ? raw.domain : undefined
    const unreadablePartition = raw !== undefined &&
      (Object.hasOwn(raw, 'partitionKey') && !readablePartitionKey(raw.partitionKey) || raw.partitionKeyOpaque === true)
    if (unreadablePartition) unreadablePartitionDomains.push(rawDomain ?? '')
    const baseFailure = validateValue({
      type: 'object',
      properties: { name: { type: 'string' }, value: { type: 'string' }, domain: { type: 'string' } },
      required: ['name', 'value', 'domain'],
      additionalProperties: true
    }, row, 'cookie')
    if (baseFailure || !raw || rawDomain === undefined || unreadablePartition) {
      skippedCookies += 1
      continue
    }
    if (validateValue(COOKIE_ROW_SCHEMA, raw, 'cookie')) {
      skippedCookies += 1
      continue
    }
    const domain = normalizeCookieDomain(rawDomain)
    const name = (raw.name as string).trim()
    if (!domain || name === '') {
      skippedCookies += 1
      continue
    }
    const expiresValue = typeof raw.expires === 'number' ? raw.expires : raw.expirationDate
    const sameSite = sameSiteValue(raw.sameSite)
    const cookie: Cookie = {
      name,
      value: raw.value as string,
      domain,
      path: typeof raw.path === 'string' && raw.path !== '' ? raw.path : '/',
      secure: raw.secure === true,
      httpOnly: raw.httpOnly === true,
      hostOnly: typeof raw.hostOnly === 'boolean' ? raw.hostOnly : !rawDomain.trim().startsWith('.'),
      ...(sameSite ? { sameSite } : {}),
      ...(typeof expiresValue === 'number' && Number.isFinite(expiresValue) && expiresValue > 0 ? { expires: expiresValue } : {}),
      ...(raw.partitionKey === undefined ? {} : { partitionKey: raw.partitionKey as Cookie['partitionKey'] })
    }
    cookies.push(cookie)
  }
  if (cookies.length === 0) throw fault('browser_import_no_valid_cookies', 'cookie source has no valid cookie rows')
  return { cookies, totalCookies: rows.length, skippedCookies, unreadablePartitionDomains }
}

export function parseCookieJson(text: string): ParsedCookies {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    throw fault('browser_import_invalid_json', 'cookie source is not valid JSON')
  }
  return parseCookieRows(value)
}

function isGoogleDomain(domain: string): boolean {
  return domain === 'google.com' || domain.endsWith('.google.com')
}

export function planCookieImport(
  cookies: readonly Cookie[],
  options: { unreadablePartitionFamilies: ReadonlySet<string>; unreadableFamilies?: ReadonlySet<string> }
): CookieImportPlan {
  if (options.unreadablePartitionFamilies.has('') || options.unreadableFamilies?.has('')) {
    throw fault('browser_import_source_unavailable', 'an unreadable cookie has no safe registrable domain family')
  }
  const result: Cookie[] = []
  const domains = new Set<string>()
  let skippedCookies = 0
  let googleCookiesSkipped = 0
  let partitionSkippedCookies = 0
  for (const cookie of cookies) {
    const domain = normalizeCookieDomain(cookie.domain)
    const family = domain ? registrableFamily(domain) : null
    if (!domain || !family || (cookie.expires !== undefined && cookie.expires <= Date.now() / 1000)) {
      skippedCookies += 1
      continue
    }
    if (isGoogleDomain(domain)) {
      googleCookiesSkipped += 1
      skippedCookies += 1
      continue
    }
    if (options.unreadablePartitionFamilies.has(family)) {
      partitionSkippedCookies += 1
      skippedCookies += 1
      continue
    }
    if (options.unreadableFamilies?.has(family)) {
      skippedCookies += 1
      continue
    }
    result.push({ ...cookie, domain })
    domains.add(family)
  }
  return {
    cookies: result,
    domains: [...domains],
    skippedCookies,
    googleCookiesSkipped,
    partitionSkippedCookies
  }
}

export function decryptChromiumValue(encryptedValue: Uint8Array, key: Uint8Array, hostKey: string, databaseVersion: number): string | null {
  const encrypted = Buffer.from(encryptedValue)
  if (encrypted.length === 0) return null
  const marker = encrypted.subarray(0, 3).toString('ascii')
  if (marker === 'v20') return null
  let plaintext: Buffer
  if (marker === 'v10' || marker === 'v11') {
    if (key.byteLength !== 16 || encrypted.length <= 3) return null
    try {
      const decipher = createDecipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(' '.repeat(16)))
      plaintext = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()])
    } catch {
      return null
    }
    if (databaseVersion >= 24) {
      if (plaintext.length < 32) return null
      const expected = createHash('sha256').update(hostKey).digest()
      if (!plaintext.subarray(0, 32).equals(expected)) return null
      plaintext = plaintext.subarray(32)
    }
  } else {
    plaintext = encrypted
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
  } catch {
    return null
  }
}

function readCString(record: Buffer, offset: number, end: number): string | null {
  if (!Number.isInteger(offset) || offset < 48 || offset >= end) return null
  const terminator = record.indexOf(0, offset)
  if (terminator === -1 || terminator >= end) return null
  return record.subarray(offset, terminator).toString('utf8')
}

function parseSafariCookie(record: Buffer): Cookie | null {
  if (record.length < 48) return null
  const size = record.readUInt32LE(0)
  if (size < 48 || size > record.length) return null
  const flags = record.readUInt32LE(8)
  const urlOffset = record.readUInt32LE(16)
  const nameOffset = record.readUInt32LE(20)
  const pathOffset = record.readUInt32LE(24)
  const valueOffset = record.readUInt32LE(28)
  const name = readCString(record, nameOffset, size)
  const rawDomain = readCString(record, urlOffset, size)
  if (!name || !rawDomain) return null
  const domain = normalizeCookieDomain(rawDomain)
  if (!domain) return null
  const path = readCString(record, pathOffset, size) ?? '/'
  const value = readCString(record, valueOffset, size) ?? ''
  const rawExpires = record.readDoubleLE(40)
  const expires = rawExpires > 0 ? Math.round(rawExpires + SAFARI_EPOCH_DELTA) : undefined
  if (expires !== undefined && expires <= Date.now() / 1000) return null
  return {
    name,
    value,
    domain,
    path,
    secure: (flags & 1) !== 0,
    httpOnly: (flags & 4) !== 0,
    hostOnly: !rawDomain.startsWith('.'),
    ...(expires === undefined ? {} : { expires })
  }
}

export function parseSafariBinaryCookies(input: Uint8Array): Cookie[] {
  const bytes = Buffer.from(input)
  if (bytes.length < 8 || bytes.subarray(0, 4).toString('ascii') !== 'cook') {
    throw fault('browser_import_source_unavailable', 'Safari cookie source has an invalid binarycookie header')
  }
  const pageCount = bytes.readUInt32BE(4)
  if (pageCount > 10_000 || 8 + pageCount * 4 > bytes.length) {
    throw fault('browser_import_source_unavailable', 'Safari cookie source has a truncated page index')
  }
  const pageSizes: number[] = []
  let cursor = 8
  for (let index = 0; index < pageCount; index += 1) {
    pageSizes.push(bytes.readUInt32BE(cursor))
    cursor += 4
  }
  const cookies: Cookie[] = []
  for (const pageSize of pageSizes) {
    if (pageSize < 16 || cursor + pageSize > bytes.length) {
      throw fault('browser_import_source_unavailable', 'Safari cookie source contains a truncated page')
    }
    const page = bytes.subarray(cursor, cursor + pageSize)
    cursor += pageSize
    if (page.readUInt32BE(0) !== 0x100) throw fault('browser_import_source_unavailable', 'Safari cookie source contains an unknown page format')
    const count = page.readUInt32LE(4)
    if (count > 100_000 || 8 + count * 4 > page.length) throw fault('browser_import_source_unavailable', 'Safari cookie page has an invalid cookie index')
    for (let index = 0; index < count; index += 1) {
      const offset = page.readUInt32LE(8 + index * 4)
      if (offset < 8 + count * 4 || offset >= page.length) throw fault('browser_import_source_unavailable', 'Safari cookie page has an out-of-range cookie record')
      const cookie = parseSafariCookie(page.subarray(offset))
      if (cookie) cookies.push(cookie)
    }
  }
  if (cursor !== bytes.length) throw fault('browser_import_source_unavailable', 'Safari cookie source has trailing or truncated page data')
  return cookies
}
