import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { expect, test } from 'bun:test'
import {
  decryptChromiumValue,
  normalizeCookieDomain,
  parseCookieJson,
  parseCookieRows,
  parseSafariBinaryCookies,
  planCookieImport,
  registrableFamily,
  validateSourceProfile
} from '../src/cookies/policy'
import type { Cookie } from '../src/cookies/types'

const cookie = (domain: string, name = 'sid', extra: Partial<Cookie> = {}): Cookie => ({
  name,
  value: `${name}-value`,
  domain,
  path: '/',
  secure: true,
  httpOnly: true,
  hostOnly: false,
  ...extra
})

function safariFile(): Buffer {
  const strings = ['.example.test', 'sid', '/', 'safari-value']
  const recordLength = 48 + strings.reduce((length, value) => length + Buffer.byteLength(value) + 1, 0)
  const record = Buffer.alloc(recordLength)
  record.writeUInt32LE(recordLength, 0)
  record.writeUInt32LE(5, 8)
  record.writeDoubleLE(2_000_000_000, 40)
  let offset = 48
  const offsets: number[] = []
  for (const value of strings) {
    offsets.push(offset)
    record.write(value, offset, 'utf8')
    offset += Buffer.byteLength(value) + 1
  }
  offsets.forEach((value, index) => record.writeUInt32LE(value, 16 + index * 4))

  const page = Buffer.alloc(12 + record.length)
  page.writeUInt32BE(0x100, 0)
  page.writeUInt32LE(1, 4)
  page.writeUInt32LE(12, 8)
  record.copy(page, 12)
  const file = Buffer.alloc(12 + page.length)
  file.write('cook', 0, 'ascii')
  file.writeUInt32BE(1, 4)
  file.writeUInt32BE(page.length, 8)
  page.copy(file, 12)
  return file
}

test('JSON cookie row parsing rejects invalid roots and keeps literal cookie data', () => {
  expect(() => parseCookieJson('{')).toThrow(/browser_import_invalid_json/)
  expect(() => parseCookieJson('{"cookie":[]}')).toThrow(/browser_import_not_array/)
  expect(() => parseCookieJson('[]')).toThrow(/browser_import_empty/)
  expect(() => parseCookieJson('[{"name":"sid","value":4,"domain":"example.test"}]')).toThrow(/browser_import_no_valid_cookies/)
  const parsed = parseCookieRows([
    { name: 'session', value: '@file:literal', domain: '.example.test', path: '/', secure: true, httpOnly: true },
    { name: '', value: 'invalid', domain: 'example.test' }
  ])
  expect(parsed.totalCookies).toBe(2)
  expect(parsed.cookies).toHaveLength(1)
  expect(parsed.cookies[0]?.value).toBe('@file:literal')
  expect(parsed.skippedCookies).toBe(1)
  const malformedPartition = parseCookieRows([
    { name: 'valid', value: 'value', domain: '.example.test' },
    { domain: '.example.test', partitionKeyOpaque: true }
  ])
  expect(malformedPartition.unreadablePartitionDomains).toEqual(['.example.test'])
})

test('source profile names are single safe directory segments', () => {
  expect(validateSourceProfile('Profile 2')).toBe('Profile 2')
  for (const unsafe of ['', '.', '..', '../Default', 'a/b', 'a\\b', `name${String.fromCharCode(0)}x`]) {
    expect(() => validateSourceProfile(unsafe)).toThrow(/invalid_argument/)
  }
})

test('private-aware public-suffix policy scopes tenants and refuses bare suffixes', () => {
  expect(normalizeCookieDomain('.EXAMPLE.test')).toBe('example.test')
  expect(normalizeCookieDomain('github.io')).toBeNull()
  expect(normalizeCookieDomain('co.uk')).toBeNull()
  expect(normalizeCookieDomain('foo..example.test')).toBeNull()
  expect(registrableFamily('one.github.io')).toBe('one.github.io')
  expect(registrableFamily('two.github.io')).toBe('two.github.io')
  expect(registrableFamily('example.co.uk')).toBe('example.co.uk')
})

test('import planning excludes Google and preserves every unreadable family across private suffix tenants', () => {
  const input = [
    cookie('.example.test', 'safe'),
    cookie('.google.com', 'google'),
    cookie('.one.github.io', 'readable-sibling'),
    cookie('.two.github.io', 'other-tenant')
  ]
  const plan = planCookieImport(input, {
    unreadablePartitionFamilies: new Set(['one.github.io']),
    unreadableFamilies: new Set(['two.github.io'])
  })
  expect(plan.cookies.map((item) => item.name)).toEqual(['safe'])
  expect(plan.domains).toEqual(['example.test'])
  expect(plan.googleCookiesSkipped).toBe(1)
  expect(plan.partitionSkippedCookies).toBe(1)
  expect(plan.skippedCookies).toBe(3)
})

test('unsafe unreadable rows without a safe registrable family refuse planning', () => {
  expect(() => planCookieImport([cookie('example.test', 'safe')], {
    unreadablePartitionFamilies: new Set(['']),
    unreadableFamilies: new Set()
  })).toThrow(/browser_import_source_unavailable/)
})

test('Chromium v10/v11 AES values validate the v24 host digest and reject app-bound values', () => {
  const hostKey = '.example.test'
  const key = pbkdf2Sync('fixture-key', 'saltysalt', 1003, 16, 'sha1')
  const iv = Buffer.from(' '.repeat(16))
  const payload = Buffer.concat([createHash('sha256').update(hostKey).digest(), Buffer.from('session-✓')])
  const cipher = createCipheriv('aes-128-cbc', key, iv)
  const encrypted = Buffer.concat([Buffer.from('v10'), cipher.update(payload), cipher.final()])
  expect(decryptChromiumValue(encrypted, key, hostKey, 24)).toBe('session-✓')
  expect(decryptChromiumValue(Buffer.from('plain-value'), key, hostKey, 24)).toBe('plain-value')
  expect(decryptChromiumValue(encrypted, key, '.other.test', 24)).toBeNull()
  expect(decryptChromiumValue(Buffer.from('v20app-bound'), key, hostKey, 24)).toBeNull()
})

test('Safari binarycookie parser decodes dates and flags and rejects truncated pages', () => {
  const parsed = parseSafariBinaryCookies(safariFile())
  expect(parsed).toHaveLength(1)
  expect(parsed[0]).toMatchObject({
    name: 'sid',
    value: 'safari-value',
    path: '/',
    secure: true,
    httpOnly: true,
    hostOnly: false,
    expires: 2_978_307_200
  })
  expect(parsed[0]?.domain.replace(/^\./, '')).toBe('example.test')
  expect(() => parseSafariBinaryCookies(Buffer.from('cook\0\0\0\x01'))).toThrow(/browser_import_source_unavailable/)
})
