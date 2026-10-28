import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startBrowserHarness, type BrowserTestHarness } from './harness'
import type { BrowserFamily, Cookie } from '../src/cookies/types'
import type { CookieTransport } from '../src/runtime/dependencies'
import { BrowserStore } from '../src/profiles/store'

type SourceRoots = Partial<Record<BrowserFamily, string>>

function makeSourceRoots(): { root: string; roots: SourceRoots } {
  const root = mkdtempSync(join(tmpdir(), 'quirky-cookie-sources-'))
  const roots: SourceRoots = {
    chrome: join(root, 'Chrome'),
    edge: join(root, 'Edge'),
    arc: join(root, 'Arc'),
    chromium: join(root, 'Brave'),
    comet: join(root, 'Comet'),
    helium: join(root, 'Helium'),
    firefox: join(root, 'Firefox'),
    safari: join(root, 'Cookies.binarycookies')
  }
  return { root, roots }
}

function cookie(name: string, value: string, domain: string, extra: Partial<Cookie> = {}): Cookie {
  return { name, value, domain, path: '/', secure: true, httpOnly: true, hostOnly: !domain.startsWith('.'), ...extra }
}

async function createPage(h: BrowserTestHarness): Promise<string> {
  const page = await h.client.callAny('quirky.browser/tabCreate', { url: `${h.fixtureUrl}events` }) as { browserPageId: string }
  return page.browserPageId
}

async function getCookies(h: BrowserTestHarness, page: string): Promise<Cookie[]> {
  return (await h.client.callAny('quirky.browser/cookieGet', { page }) as { cookies: Cookie[] }).cookies
}

async function seedCookie(h: BrowserTestHarness, page: string, value: Cookie): Promise<void> {
  await h.client.callAny('quirky.browser/cookieSet', {
    page,
    name: value.name,
    value: value.value,
    domain: value.domain,
    path: value.path,
    secure: value.secure,
    httpOnly: value.httpOnly,
    ...(value.sameSite === undefined ? {} : { sameSite: value.sameSite }),
    ...(value.expires === undefined ? {} : { expires: value.expires }),
    ...(value.partitionKey === undefined ? {} : { partitionKey: value.partitionKey })
  })
}

function canonical(cookies: Cookie[]): Cookie[] {
  return [...cookies].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

function cookieRow(name: string, value: string, domain: string, extra: Record<string, unknown> = {}) {
  return { name, value, domain, path: '/', secure: true, httpOnly: true, sameSite: 'Lax', ...extra }
}

function writeJson(home: string, rows: unknown[], name: string): string {
  const path = join(home, name)
  writeFileSync(path, JSON.stringify(rows))
  return path
}

function encryptChromium(value: string, host: string, password: string, marker: 'v10' | 'v11' = 'v10'): Buffer {
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
  const plaintext = Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from(value)])
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.from(' '.repeat(16)))
  return Buffer.concat([Buffer.from(marker), cipher.update(plaintext), cipher.final()])
}

function createChromiumDatabase(path: string, password: string): Database {
  const db = new Database(path)
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE meta (key TEXT, value TEXT);
    INSERT INTO meta VALUES ('version', '24');
    CREATE TABLE cookies (
      host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER,
      is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, is_partitioned INTEGER,
      top_frame_site_key TEXT, has_cross_site_ancestor INTEGER
    );`)
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 86_400 + 11_644_473_600) * 1_000_000n
  const insert = db.prepare(`INSERT INTO cookies VALUES (?, ?, ?, ?, '/', ?, 1, 1, 2, ?, ?, ?)`)
  const digestHost = '.decrypted.example.test'
  insert.run(digestHost, 'encrypted-v10', '', new Uint8Array(encryptChromium('v24-value-✓', digestHost, password)), expiry, 0, '', 0)
  insert.run(digestHost, 'encrypted-v11', '', new Uint8Array(encryptChromium('v11-value', digestHost, password, 'v11')), expiry, 0, '', 0)
  insert.run('.blocked.example.org', 'app-bound', '', new Uint8Array(Buffer.from('v20-app-bound')), expiry, 0, '', 0)
  insert.run('.partition.example.net', 'opaque-chip', 'ignored', new Uint8Array(), expiry, 1, 'opaque-partition-key', 1)
  return db
}

function createFirefoxDatabase(path: string): Database {
  const db = new Database(path)
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE moz_cookies (
      id INTEGER, originAttributes TEXT, name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER,
      isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER, rawSameSite INTEGER, isSession INTEGER, isDomain INTEGER
    );`)
  const expiry = Math.floor(Date.now() / 1000) + 3_600
  const insert = db.prepare('INSERT INTO moz_cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  insert.run(1, '', 'firefox-live', 'live-value', '.firefox.example.test', '/', expiry, 1, 1, 2, 2, 0, 1)
  insert.run(2, '', 'expired', 'expired-value', '.expired.example.test', '/', 1, 0, 0, 0, 0, 0, 1)
  insert.run(3, '^partitionKey=(https,shop.example)', 'opaque-chip', 'ignored', '.private.github.io', '/', expiry, 1, 1, 2, 2, 0, 1)
  insert.run(4, '', 'partition-sibling', 'must-not-import', '.private.github.io', '/', expiry, 1, 1, 1, 1, 0, 1)
  return db
}

function createSafariCookies(expires: number): Buffer {
  const strings = ['.safari.example.test', 'safari', '/', 'safari-value']
  const length = 48 + strings.reduce((total, value) => total + Buffer.byteLength(value) + 1, 0)
  const record = Buffer.alloc(length)
  record.writeUInt32LE(length, 0)
  record.writeUInt32LE(5, 8)
  record.writeDoubleLE(expires - 978_307_200, 40)
  const offsets: number[] = []
  let cursor = 48
  for (const value of strings) {
    offsets.push(cursor)
    record.write(value, cursor, 'utf8')
    cursor += Buffer.byteLength(value) + 1
  }
  offsets.forEach((offset, index) => record.writeUInt32LE(offset, 16 + index * 4))
  const page = Buffer.alloc(12 + length)
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

async function expectReason(h: BrowserTestHarness, method: string, params: Record<string, unknown>, reason: string): Promise<void> {
  let caught: unknown
  try { await h.client.callAny(`quirky.browser/${method}`, params) } catch (error) { caught = error }
  expect(caught).toBeDefined()
  const message = caught instanceof Error ? caught.message : String(caught)
  expect(message.startsWith(`${reason}:`)).toBe(true)
}

async function finishJob(h: BrowserTestHarness, id: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const job = await h.client.callAny('quirky.browser/importGet', { id }) as Record<string, unknown>
    if (job.status === 'succeeded' || job.status === 'failed') return job
    await Bun.sleep(10)
  }
  throw new Error('cookie import job did not finish')
}

test('profile metadata migration keeps old records valid and persists imported source and page selection', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'quirky-browser-profile-store-'))
  try {
    const importedId = `profile_${'a'.repeat(32)}`
    writeFileSync(join(dataDir, 'browser-state.json'), JSON.stringify({
      profiles: [
        { id: 'default', label: 'Default', scope: 'default' },
        { id: importedId, label: 'Imported', scope: 'isolated' }
      ],
      pages: []
    }))
    const store = new BrowserStore(dataDir)
    const page = store.addPage({ worktreeId: null, profileId: 'default', url: 'about:blank', title: '' })
    expect(store.setPageProfile(page.browserPageId, importedId).profileId).toBe(importedId)
    const source = { browserFamily: 'chrome', profileName: 'Default', importedAt: 42 }
    store.markImported(importedId, source)
    expect(store.getProfile(importedId)).toMatchObject({ scope: 'imported', source })
    expect(() => store.deleteProfile(importedId)).toThrow(/browser_error/)
    const reloaded = new BrowserStore(dataDir)
    expect(reloaded.getProfile(importedId)).toMatchObject({ scope: 'imported', source })
    expect(reloaded.getProfile('default')).toMatchObject({ scope: 'default' })
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})


test('daemon import replaces only safe families and accepts explicit file and JSON bytes', async () => {
  const { root, roots } = makeSourceRoots()
  const h = await startBrowserHarness({ sourceRoots: roots })
  try {
    const page = await createPage(h)
    await seedCookie(h, page, cookie('old-example', 'old-value', '.example.test'))
    await seedCookie(h, page, cookie('other', 'keep-other', '.other.test'))
    await seedCookie(h, page, cookie('google', 'protected-google', '.google.com'))
    await seedCookie(h, page, cookie('other-tenant', 'keep-tenant', '.two.github.io'))
    await seedCookie(h, page, cookie('old-chip', 'old-partition', '.one.github.io', {
      partitionKey: { topLevelSite: 'https://shop.example', hasCrossSiteAncestor: true }
    }))
    const file = writeJson(h.home, [
      cookieRow('example-session', 'from-file', '.example.test'),
      cookieRow('google-source', 'never-import', '.accounts.google.com'),
      cookieRow('partitioned', 'chip-value', '.one.github.io', {
        partitionKey: { topLevelSite: 'https://shop.example', hasCrossSiteAncestor: false }
      }),
      cookieRow('bare-private-suffix', 'must-not-import', 'github.io')
    ], 'selected-cookies.json')
    const beforeFile = readFileSync(file)
    const fileResult = await h.client.callAny('quirky.browser/importCookies', {
      source: { kind: 'file', path: file },
      yes: true
    }) as { importedCookies: number; skippedCookies: number; googleCookiesSkipped?: number; domains: string[] }
    expect(fileResult).toMatchObject({
      importedCookies: 2,
      skippedCookies: 2,
      googleCookiesSkipped: 1,
      domains: ['example.test', 'one.github.io']
    })
    const afterFileImport = await getCookies(h, page)
    expect(afterFileImport).toContainEqual(expect.objectContaining({ name: 'example-session', value: 'from-file' }))
    expect(afterFileImport).not.toContainEqual(expect.objectContaining({ name: 'old-example' }))
    expect(afterFileImport).toContainEqual(expect.objectContaining({ name: 'other', value: 'keep-other' }))
    expect(afterFileImport).toContainEqual(expect.objectContaining({ name: 'google', value: 'protected-google' }))
    expect(afterFileImport).toContainEqual(expect.objectContaining({ name: 'other-tenant', value: 'keep-tenant' }))
    expect(afterFileImport).not.toContainEqual(expect.objectContaining({ name: 'old-chip' }))
    expect(afterFileImport).toContainEqual(expect.objectContaining({
      name: 'partitioned',
      value: 'chip-value',
      partitionKey: { topLevelSite: 'https://shop.example', hasCrossSiteAncestor: false }
    }))
    expect(readFileSync(file)).toEqual(beforeFile)

    const jsonResult = await h.client.callAny('quirky.browser/importCookies', {
      source: { kind: 'json', cookies: [
        cookieRow('readable-sibling', 'must-not-write', '.one.github.io'),
        { ...cookieRow('opaque-chip', 'unknown', '.one.github.io'), partitionKeyOpaque: true }
      ] },
      yes: true
    }) as { importedCookies: number; partitionSkippedCookies?: number; domains: string[] }
    expect(jsonResult).toMatchObject({ importedCookies: 0, partitionSkippedCookies: 2, domains: [] })
    const afterUnreadablePartition = await getCookies(h, page)
    expect(afterUnreadablePartition).toContainEqual(expect.objectContaining({ name: 'partitioned', value: 'chip-value' }))
    expect(afterUnreadablePartition).not.toContainEqual(expect.objectContaining({ name: 'readable-sibling' }))

    const invalidFile = join(h.home, 'invalid-cookie-source.json')
    writeFileSync(invalidFile, '{')
    const beforeInvalid = canonical(await getCookies(h, page))
    await expectReason(h, 'importCookies', { source: { kind: 'file', path: invalidFile }, yes: true }, 'browser_import_invalid_json')
    await expectReason(h, 'importCookies', { source: { kind: 'json', cookies: [] }, yes: true }, 'browser_import_empty')
    expect(canonical(await getCookies(h, page))).toEqual(beforeInvalid)
  } finally {
    await h.cleanup()
    rmSync(root, { recursive: true, force: true })
  }
})

test('daemon import reads Chromium Local State profiles, decrypts v24 rows, and skips unreadable families', async () => {
  const { root, roots } = makeSourceRoots()
  const chromeRoot = roots.chrome!
  const databasePath = join(chromeRoot, 'Default', 'Network', 'Cookies')
  mkdirSync(join(chromeRoot, 'Default', 'Network'), { recursive: true })
  writeFileSync(join(chromeRoot, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Synthetic Default' } } } }))
  const password = 'synthetic-safe-storage-key'
  const db = createChromiumDatabase(databasePath, password)
  const h = await startBrowserHarness({
    sourceRoots: roots,
    keyProvider: async (family) => family === 'chrome' ? Buffer.from(password) : null
  })
  try {
    const page = await createPage(h)
    await seedCookie(h, page, cookie('blocked-old', 'preserve-blocked', '.blocked.example.org'))
    await seedCookie(h, page, cookie('partition-old', 'preserve-partition', '.partition.example.net'))
    const beforeDatabase = readFileSync(databasePath)
    const beforeWal = readFileSync(`${databasePath}-wal`)
    const spawnCountBeforeDetection = h.spawnCount()
    const detected = await h.client.callAny('quirky.browser/detectBrowsers', {}) as {
      browsers: Array<{ family: string; profiles: Array<{ name: string; label: string }> }>
    }
    expect(h.spawnCount()).toBe(spawnCountBeforeDetection)
    expect(detected.browsers.find((browser) => browser.family === 'chrome')?.profiles).toEqual([
      { name: 'Default', label: 'Synthetic Default' }
    ])
    expect(JSON.stringify(detected)).not.toContain(root)
    await expectReason(h, 'importCookies', {
      source: { kind: 'browser', family: 'chrome', profile: '../escape' },
      yes: true
    }, 'invalid_argument')
    const result = await h.client.callAny('quirky.browser/importCookies', {
      source: { kind: 'browser', family: 'chrome', profile: 'Default' },
      yes: true
    }) as { totalCookies: number; importedCookies: number; skippedCookies: number; domains: string[]; warning?: { code: string } }
    expect(result).toMatchObject({
      totalCookies: 4,
      importedCookies: 2,
      skippedCookies: 2,
      domains: ['example.test'],
      partitionSkippedCookies: 1,
      warning: { code: 'browser_import_partition_skipped' }
    })
    const imported = await getCookies(h, page)
    expect(imported).toContainEqual(expect.objectContaining({ name: 'encrypted-v10', value: 'v24-value-✓' }))
    expect(imported).toContainEqual(expect.objectContaining({ name: 'encrypted-v11', value: 'v11-value' }))
    expect(imported).toContainEqual(expect.objectContaining({ name: 'blocked-old', value: 'preserve-blocked' }))
    expect(imported).toContainEqual(expect.objectContaining({ name: 'partition-old', value: 'preserve-partition' }))
    expect(imported).not.toContainEqual(expect.objectContaining({ name: 'app-bound' }))
    expect(imported).not.toContainEqual(expect.objectContaining({ name: 'opaque-chip' }))
    expect(readFileSync(databasePath)).toEqual(beforeDatabase)
    expect(readFileSync(`${databasePath}-wal`)).toEqual(beforeWal)
    expect(readdirSync(join(h.home, 'plugin-data', 'quirky.browser')).filter((entry) => entry.startsWith('import-'))).toEqual([])
  } finally {
    db.close()
    await h.cleanup()
    rmSync(root, { recursive: true, force: true })
  }
})

test('daemon imports Firefox SQLite/WAL and Safari binarycookies without modifying source bytes', async () => {
  const { root, roots } = makeSourceRoots()
  const firefoxRoot = roots.firefox!
  const firefoxProfile = join(firefoxRoot, 'Profiles', 'default-release')
  mkdirSync(firefoxProfile, { recursive: true })
  writeFileSync(join(firefoxRoot, 'profiles.ini'), '[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/default-release\n')
  const firefoxPath = join(firefoxProfile, 'cookies.sqlite')
  const firefoxDb = createFirefoxDatabase(firefoxPath)
  const safariPath = roots.safari!
  const safariExpires = Math.floor(Date.now() / 1000) + 86_400
  writeFileSync(safariPath, createSafariCookies(safariExpires))
  const h = await startBrowserHarness({ sourceRoots: roots })
  try {
    const page = await createPage(h)
    await seedCookie(h, page, cookie('partition-old', 'preserve-private', '.private.github.io'))
    const beforeFirefox = readFileSync(firefoxPath)
    const beforeFirefoxWal = readFileSync(`${firefoxPath}-wal`)
    const beforeSafari = readFileSync(safariPath)
    const firefox = await h.client.callAny('quirky.browser/importCookies', {
      source: { kind: 'browser', family: 'firefox', profile: 'default-release' },
      yes: true
    }) as { importedCookies: number; partitionSkippedCookies?: number }
    expect(firefox).toMatchObject({ importedCookies: 1, partitionSkippedCookies: 2 })
    const afterFirefox = await getCookies(h, page)
    expect(afterFirefox).toContainEqual(expect.objectContaining({ name: 'firefox-live', value: 'live-value', sameSite: 'Strict' }))
    expect(afterFirefox).toContainEqual(expect.objectContaining({ name: 'partition-old', value: 'preserve-private' }))
    expect(afterFirefox).not.toContainEqual(expect.objectContaining({ name: 'expired' }))
    expect(afterFirefox).not.toContainEqual(expect.objectContaining({ name: 'partition-sibling' }))
    const safari = await h.client.callAny('quirky.browser/importCookies', {
      source: { kind: 'browser', family: 'safari' },
      yes: true
    }) as { importedCookies: number }
    expect(safari.importedCookies).toBe(1)
    expect(await getCookies(h, page)).toContainEqual(expect.objectContaining({
      name: 'safari', value: 'safari-value', secure: true, httpOnly: true, hostOnly: false, expires: safariExpires
    }))
    expect(readFileSync(firefoxPath)).toEqual(beforeFirefox)
    expect(readFileSync(`${firefoxPath}-wal`)).toEqual(beforeFirefoxWal)
    expect(readFileSync(safariPath)).toEqual(beforeSafari)
  } finally {
    firefoxDb.close()
    await h.cleanup()
    rmSync(root, { recursive: true, force: true })
  }
})

test('daemon replacement rolls back exact cookie values, reports jobs, and drains imports on shutdown', async () => {
  const { root, roots } = makeSourceRoots()
  let failSetName: string | undefined = 'new-b'
  let failRollbackDelete = false
  let blockedSet: string | undefined
  const { promise: enteredBlockedSet, resolve: announceBlocked } = Promise.withResolvers<void>()
  const { promise: blockedGate, resolve: releaseBlocked } = Promise.withResolvers<void>()
  const sourceWrites: string[] = []
  let recordDrainWrites = false
  const h = await startBrowserHarness({
    sourceRoots: roots,
    wrapCookieTransport(base: CookieTransport): CookieTransport {
      return {
        ...base,
        async delete(profileId, value) {
          await base.delete(profileId, value)
          if (failRollbackDelete && value.name === 'new-a') {
            failRollbackDelete = false
            throw new Error('injected rollback delete failure')
          }
        },
        async set(profileId, value) {
          if (recordDrainWrites && value.name.startsWith('new-')) sourceWrites.push(value.name)
          if (blockedSet === value.name) {
            blockedSet = undefined
            announceBlocked()
            await blockedGate
          }
          await base.set(profileId, value)
          if (value.name === failSetName) {
            failSetName = undefined
            throw new Error('injected cookie set failure')
          }
        }
      }
    }
  })
  let cleanupFinished = false
  try {
    const page = await createPage(h)
    await seedCookie(h, page, cookie('old', 'old-value', '.rollback.example.test'))
    await seedCookie(h, page, cookie('outside', 'keep', '.outside.example.test'))
    const before = canonical(await getCookies(h, page))
    const failedSource = writeJson(h.home, [
      cookieRow('new-a', 'a', '.rollback.example.test'),
      cookieRow('new-b', 'b', '.rollback.example.test')
    ], 'rollback-source.json')
    await expectReason(h, 'importCookies', { source: { kind: 'file', path: failedSource }, yes: true }, 'browser_error')
    expect(canonical(await getCookies(h, page))).toEqual(before)

    failSetName = 'new-b'
    failRollbackDelete = true
    await expectReason(h, 'importCookies', { source: { kind: 'file', path: failedSource }, yes: true }, 'browser_unsafe_replace')
    expect(canonical(await getCookies(h, page))).toEqual(before)

    const malformed = join(h.home, 'job-malformed.json')
    writeFileSync(malformed, '{')
    const started = await h.client.callAny('quirky.browser/importStart', {
      source: { kind: 'file', path: malformed },
      yes: true
    }) as { id: string }
    const job = await finishJob(h, started.id)
    expect(job).toMatchObject({ status: 'failed', error: { code: 'browser_import_invalid_json' } })
    expect(JSON.stringify(job)).not.toContain(malformed)
    const listed = await h.client.callAny('quirky.browser/importList', {
      profile: 'default', status: 'failed'
    }) as { jobs: Array<{ id: string }> }
    expect(listed.jobs.map((item) => item.id)).toContain(started.id)

    const drainingSource = writeJson(h.home, [
      cookieRow('new-a', 'a', '.drain.example.test'),
      cookieRow('new-b', 'b', '.drain.example.test')
    ], 'draining-source.json')
    recordDrainWrites = true
    blockedSet = 'new-a'
    const draining = await h.client.callAny('quirky.browser/importStart', {
      source: { kind: 'file', path: drainingSource },
      yes: true
    }) as { id: string }
    await enteredBlockedSet
    let cleanupPromise: Promise<void> | undefined
    cleanupPromise = h.cleanup().then(() => { cleanupFinished = true })
    // Cleanup must stay pending while its injected CDP write is blocked; no shutdown event is exposed before completion.
    await Bun.sleep(25)
    expect(cleanupFinished).toBe(false)
    releaseBlocked()
    await cleanupPromise
    expect(cleanupFinished).toBe(true)
    expect(sourceWrites.filter((name) => name === 'new-a' || name === 'new-b')).toContain('new-a')
    expect(sourceWrites.filter((name) => name === 'new-a' || name === 'new-b')).not.toContain('new-b')
  } finally {
    releaseBlocked()
    if (!cleanupFinished) await h.cleanup()
    rmSync(root, { recursive: true, force: true })
  }
})
