import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run } from '../../../packages/cli/src/main'
import { createDaemonLink } from '../../../packages/cli/src/link'
import { startBrowserHarness, type BrowserTestHarness } from './harness'
import type { Cookie } from '../src/cookies/types'
import type { CookieTransport } from '../src/runtime/dependencies'

async function createManagedPage(h: BrowserTestHarness): Promise<{ browserPageId: string }> {
  return await h.client.callAny('quirky.browser/tabCreate', { url: `${h.fixtureUrl}events` }) as { browserPageId: string }
}

async function liveCookies(h: BrowserTestHarness, page: string): Promise<Cookie[]> {
  return (await h.client.callAny('quirky.browser/cookieGet', { page }) as { cookies: Cookie[] }).cookies
}

async function seedLiveCookie(h: BrowserTestHarness, page: string, value: Cookie): Promise<void> {
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

function canonicalCookies(cookies: Cookie[]): Cookie[] {
  return [...cookies].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

function createCookieTransportProbe() {
  let setCalls = 0
  let deleteCalls = 0
  let activeSets = 0
  let maxConcurrentSets = 0
  let failingSetCall: number | undefined
  let failingDeleteCall: number | undefined

  return {
    get maxConcurrentSets() { return maxConcurrentSets },
    failSetAfter(calls: number) { failingSetCall = setCalls + calls },
    failDeleteAfter(calls: number) { failingDeleteCall = deleteCalls + calls },
    wrapCookieTransport(base: CookieTransport): CookieTransport {
      return {
        ...base,
        list(profileId) { return base.list(profileId) },
        async delete(profileId, cookie) {
          const call = ++deleteCalls
          await base.delete(profileId, cookie)
          if (call === failingDeleteCall) {
            failingDeleteCall = undefined
            throw new Error('injected CDP delete fault')
          }
        },
        async set(profileId, cookie) {
          const call = ++setCalls
          activeSets += 1
          maxConcurrentSets = Math.max(maxConcurrentSets, activeSets)
          try {
            await base.set(profileId, cookie)
            if (call === failingSetCall) {
              failingSetCall = undefined
              throw new Error('injected CDP set fault')
            }
          } finally { activeSets -= 1 }
        }
      }
    }
  }
}

function cookie(name: string, value: string, domain = '.example.test'): Cookie {
  return { name, value, domain, path: '/', secure: true, httpOnly: true, hostOnly: false }
}

function writeJsonSource(home: string, rows: unknown[], name = 'cookies.json'): string {
  const path = join(home, name)
  writeFileSync(path, JSON.stringify(rows))
  return path
}

function sourceRow(name: string, value: string, domain = '.example.test') {
  return { name, value, domain, path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }
}

function createSafariCookies(expires: number): Buffer {
  const strings = ['.safari.example', 'safari', '/', 'safari-value']
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

function createChromiumDb(path: string, passphrase: string): Database {
  const db = new Database(path)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE meta (key TEXT, value TEXT); INSERT INTO meta VALUES ("version", "24");')
  db.exec(`CREATE TABLE cookies (
    creation_utc INTEGER, host_key TEXT, top_frame_site_key TEXT, name TEXT, value TEXT,
    encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER,
    last_access_utc INTEGER, has_expires INTEGER, is_persistent INTEGER, priority INTEGER,
    samesite INTEGER, source_scheme INTEGER, source_port INTEGER, is_same_party INTEGER,
    is_partitioned INTEGER, has_cross_site_ancestor INTEGER
  )`)
  const host = '.example.test'
  const key = pbkdf2Sync(passphrase, 'saltysalt', 1003, 16, 'sha1')
  const plaintext = Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from('encrypted-session')])
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.from(' '.repeat(16)))
  const encrypted = Buffer.concat([Buffer.from('v10'), cipher.update(plaintext), cipher.final()])
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 86_400 + 11_644_473_600) * 1_000_000n
  const plaintextV11 = Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from('encrypted-session-v11')])
  const cipherV11 = createCipheriv('aes-128-cbc', key, Buffer.from(' '.repeat(16)))
  const encryptedV11 = Buffer.concat([Buffer.from('v11'), cipherV11.update(plaintextV11), cipherV11.final()])
  const insert = db.prepare(`INSERT INTO cookies (
    creation_utc,host_key,top_frame_site_key,name,value,encrypted_value,path,expires_utc,
    is_secure,is_httponly,has_expires,is_persistent,samesite,is_partitioned,has_cross_site_ancestor
  ) VALUES (1,?,?,?,?,?,?,?,?,?,1,1,?,?,?)`)
  insert.run(host, '', 'encrypted', '', new Uint8Array(encrypted), '/', expiry, 1, 1, 2, 0, 0)
  insert.run(host, '', 'encrypted-v11', '', new Uint8Array(encryptedV11), '/', expiry, 1, 1, 1, 0, 0)
  insert.run(host, '', 'plain-name', 'plain-value', new Uint8Array(), '/', expiry, 1, 1, 1, 0, 0)
  insert.run(host, '', 'app-bound', '', new Uint8Array(Buffer.from('v20unsupported')), '/', expiry, 1, 1, 1, 0, 0)
  insert.run('.one.github.io', 'https://shop.example', 'partitioned', 'partition-value', new Uint8Array(), '/', expiry, 1, 1, 1, 1, 1)
  return db
}

function createFirefoxDatabase(path: string): Database {
  const db = new Database(path)
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE moz_cookies (
    id INTEGER, originAttributes TEXT, name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER,
    isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER, rawSameSite INTEGER, isSession INTEGER, isDomain INTEGER
  )`)
  return db
}

async function reason(client: BrowserTestHarness['client'], method: string, params: Record<string, unknown>, expected: string): Promise<void> {
  let error: unknown
  try { await client.callAny(`quirky.browser/${method}`, params) } catch (caught) { error = caught }
  expect(error).toBeDefined()
  const message = error instanceof Error ? error.message : String(error)
  expect(message.startsWith(`${expected}:`)).toBe(true)
}
// The public import-job contract exposes status through importGet rather than a completion event.
async function waitForAsync<T>(read: () => Promise<T | false>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== false) return value
    await Bun.sleep(25)
  }
  throw new Error('asynchronous condition did not finish before timeout')
}

async function finishJob(client: BrowserTestHarness['client'], id: string) {
  return waitForAsync(async () => {
    const job = await client.callAny('quirky.browser/importGet', { id }) as { status: string }
    return job.status === 'succeeded' || job.status === 'failed' ? job : false
  }, 30_000)
}

test('SC-12: detection requires cookie files, keeps Firefox profile paths private, and rejects unsafe selectors', async () => {
  const h = await startBrowserHarness()
  try {
    const chromeDefault = join(h.sourceRoots.chrome!, 'Default')
    const chromeSecondary = join(h.sourceRoots.chrome!, 'Profile 2')
    mkdirSync(chromeDefault, { recursive: true })
    mkdirSync(chromeSecondary, { recursive: true })
    writeFileSync(join(h.sourceRoots.chrome!, 'Local State'), '{}')
    const firefoxProfiles = join(h.sourceRoots.firefox!, 'Profiles')
    const defaultReleaseDirectory = join(firefoxProfiles, 'default-release')
    const researchDirectory = join(firefoxProfiles, 'research')
    mkdirSync(defaultReleaseDirectory, { recursive: true })
    mkdirSync(researchDirectory, { recursive: true })
    mkdirSync(join(firefoxProfiles, 'ghost'), { recursive: true })

    const emptyDetection = await h.client.callAny('quirky.browser/detectBrowsers', {}) as { browsers: Array<{ family: string }> }
    expect(emptyDetection.browsers.some((browser) => ['chrome', 'firefox', 'safari'].includes(browser.family))).toBe(false)

    mkdirSync(join(chromeDefault, 'Network'), { recursive: true })
    const chromeDb = createChromiumDb(join(chromeDefault, 'Network', 'Cookies'), 'synthetic-safe-storage-key')
    chromeDb.close()
    const defaultFirefoxDb = createFirefoxDatabase(join(defaultReleaseDirectory, 'cookies.sqlite'))
    defaultFirefoxDb.close()
    const fallbackDetection = await h.client.callAny('quirky.browser/detectBrowsers', {}) as { browsers: Array<{ family: string; profiles: Array<{ name: string }> }> }
    expect(fallbackDetection.browsers.find((browser) => browser.family === 'chrome')?.profiles.map((profile) => profile.name)).toEqual(['Default'])
    expect(fallbackDetection.browsers.find((browser) => browser.family === 'firefox')?.profiles.map((profile) => profile.name)).toEqual(['default-release'])

    const researchDb = createFirefoxDatabase(join(researchDirectory, 'cookies.sqlite'))
    researchDb.close()
    const externalProfileDirectory = join(h.home, 'external-firefox-profile')
    mkdirSync(externalProfileDirectory, { recursive: true })
    const externalDb = createFirefoxDatabase(join(externalProfileDirectory, 'cookies.sqlite'))
    externalDb.close()
    writeFileSync(join(h.sourceRoots.firefox!, 'profiles.ini'), `[Profile0]
Name=default-release
IsRelative=1
Path=Profiles/default-release
Default=1
[Profile1]
Name=research
IsRelative=1
Path=Profiles/research
[Profile2]
Name=ghost
IsRelative=1
Path=Profiles/ghost
[Profile3]
Name=external
IsRelative=0
Path=${externalProfileDirectory}
`)
    const browsers = await h.client.callAny('quirky.browser/detectBrowsers', {}) as { browsers: Array<{ family: string; profiles: Array<{ name: string }> }> }
    expect(browsers.browsers.find((browser) => browser.family === 'chrome')?.profiles.map((profile) => profile.name)).toEqual(['Default'])
    expect(browsers.browsers.find((browser) => browser.family === 'firefox')?.profiles.map((profile) => profile.name)).toEqual([
      'default-release', 'external-firefox-profile', 'research'
    ])
    expect(browsers.browsers.some((browser) => browser.family === 'safari')).toBe(false)
    expect(JSON.stringify(browsers)).not.toContain(h.sourceRoots.chrome!)
    expect(JSON.stringify(browsers)).not.toContain(h.sourceRoots.firefox!)
    expect(JSON.stringify(browsers)).not.toContain(externalProfileDirectory)
    expect(h.spawnCount()).toBe(0)
    await reason(h.client, 'importCookies', { source: { kind: 'browser', family: 'chrome', profile: '../escape' }, yes: true }, 'invalid_argument')
    const sourceFile = writeJsonSource(h.home, [sourceRow('cookie', 'value')], 'variant-source.json')
    await reason(h.client, 'importCookies', { source: { kind: 'file', path: sourceFile, family: 'chrome' }, yes: true }, 'invalid_argument')
    await reason(h.client, 'importCookies', { source: { kind: 'browser', family: 'chrome', path: sourceFile }, yes: true }, 'invalid_argument')
    await reason(h.client, 'importCookies', { source: { kind: 'browser', family: 'safari', profile: 'Default' }, yes: true }, 'invalid_argument')
    expect(h.spawnCount()).toBe(0)
  } finally { await h.cleanup() }
})

test('SC-13: JSON import jobs expose redacted state and write only validated safe cookies', async () => {
  const h = await startBrowserHarness()
  try {
    let confirmationRefusal: unknown
    try {
      await h.client.callAny('quirky.browser/importStart', { source: { kind: 'file', path: join(h.home, 'not-read-before-confirmation.json') } })
    } catch (error) { confirmationRefusal = error }
    expect(confirmationRefusal).toBeDefined()
    expect((await h.client.callAny('quirky.browser/importList', {}) as { jobs: unknown[] }).jobs).toEqual([])
    expect(h.spawnCount()).toBe(0)

    const page = await createManagedPage(h)
    await seedLiveCookie(h, page.browserPageId, cookie('unrelated', 'keep', '.other.test'))
    expect(await liveCookies(h, page.browserPageId)).toContainEqual(expect.objectContaining({ name: 'unrelated', value: 'keep' }))

    const path = writeJsonSource(h.home, [sourceRow('session', 'secret-value'), { name: '', value: 2, domain: '.example.test' }])
    const started = await h.client.callAny('quirky.browser/importStart', { source: { kind: 'file', path }, yes: true }) as { id: string }
    const job = await finishJob(h.client, started.id) as { status: string; profileId: string; result?: { totalCookies: number; importedCookies: number; skippedCookies: number; domains: string[] }; [key: string]: unknown }
    expect(job).toMatchObject({ status: 'succeeded', profileId: 'default', result: { totalCookies: 2, importedCookies: 1, skippedCookies: 1, domains: ['example.test'] } })
    expect(JSON.stringify(job)).not.toContain(path)
    expect(JSON.stringify(job)).not.toContain('secret-value')
    const cookies = await liveCookies(h, page.browserPageId)
    expect(cookies).toContainEqual(expect.objectContaining({ name: 'session', value: 'secret-value', hostOnly: false }))
    expect(cookies).toContainEqual(expect.objectContaining({ name: 'unrelated', value: 'keep' }))
    const subdomainCookies = await h.client.callAny('quirky.browser/cookieGet', {
      page: page.browserPageId,
      url: 'https://sub.example.test/'
    }) as { cookies: Cookie[] }
    expect(subdomainCookies.cookies).toContainEqual(expect.objectContaining({ name: 'session', value: 'secret-value' }))
    expect((await h.client.callAny('quirky.browser/importList', { profile: 'default', status: 'succeeded' }) as { jobs: Array<{ id: string }> }).jobs.map((item) => item.id)).toContain(started.id)
    await reason(h.client, 'importGet', { id: 'missing-job' }, 'browser_import_not_found')
    await reason(h.client, 'importCookies', { source: { kind: 'file', path: writeJsonSource(h.home, [], 'empty.json') }, yes: true }, 'browser_import_empty')
    const malformed = join(h.home, 'malformed.json')
    writeFileSync(malformed, '{')
    await reason(h.client, 'importCookies', { source: { kind: 'file', path: malformed }, yes: true }, 'browser_import_invalid_json')
    const notArray = join(h.home, 'object.json')
    writeFileSync(notArray, '{"cookie":[]}')
    await reason(h.client, 'importCookies', { source: { kind: 'file', path: notArray }, yes: true }, 'browser_import_not_array')
    await reason(h.client, 'importCookies', { source: { kind: 'file', path: writeJsonSource(h.home, [{ name: 'bad', value: 1, domain: '.example.test' }], 'invalid-rows.json') }, yes: true }, 'browser_import_no_valid_cookies')
    const failedStart = await h.client.callAny('quirky.browser/importStart', { source: { kind: 'file', path: malformed }, yes: true }) as { id: string }
    const failedJob = await finishJob(h.client, failedStart.id) as { status: string; error?: { code: string; message: string } }
    expect(failedJob.status).toBe('failed')
    expect(failedJob.error?.code).toBe('browser_import_invalid_json')
    expect(failedJob.error?.message.startsWith('browser_import_invalid_json:')).toBe(true)
    expect(failedJob.error?.message).not.toContain(malformed)
    expect(await liveCookies(h, page.browserPageId)).toContainEqual(expect.objectContaining({ name: 'session', value: 'secret-value' }))
  } finally { await h.cleanup() }
}, 60_000)
test('SC-13: JSON import mutates cookies in the owned live Chrome profile', async () => {
  const h = await startBrowserHarness()
  try {
    const page = await h.client.callAny('quirky.browser/tabCreate', { url: `${h.fixtureUrl}events` }) as { browserPageId: string }
    const domain = new URL(h.fixtureUrl).hostname
    const source = writeJsonSource(h.home, [{ name: 'live-import', value: 'chrome-cookie', domain, path: '/', secure: false, httpOnly: true }], 'live-import.json')
    const summary = await h.client.callAny('quirky.browser/importCookies', {
      source: { kind: 'file', path: source },
      yes: true
    }) as { importedCookies: number; domains: string[] }
    expect(summary).toMatchObject({ importedCookies: 1, domains: [domain] })
    expect((await h.client.callAny('quirky.browser/cookieGet', { page: page.browserPageId, url: `${h.fixtureUrl}events` }) as { cookies: Array<{ name: string; value: string }> }).cookies).toContainEqual(expect.objectContaining({ name: 'live-import', value: 'chrome-cookie' }))
  } finally { await h.cleanup() }
}, 60_000)

test('SC-14: Chromium import snapshots live WAL rows, decrypts v10/v11 and reports app-bound failures', async () => {
  const h = await startBrowserHarness()
  const databasePath = join(h.sourceRoots.chrome!, 'Default', 'Network', 'Cookies')
  mkdirSync(join(h.sourceRoots.chrome!, 'Default', 'Network'), { recursive: true })
  const db = createChromiumDb(databasePath, 'synthetic-safe-storage-key')
  try {
    const page = await createManagedPage(h)
    const beforeDb = readFileSync(databasePath)
    const beforeWal = readFileSync(`${databasePath}-wal`)
    const result = await h.client.callAny('quirky.browser/importCookies', { source: { kind: 'browser', family: 'chrome', profile: 'Default' }, yes: true }) as { totalCookies: number; importedCookies: number; skippedCookies: number; domains: string[]; warning?: { code: string } }
    expect(result).toMatchObject({ totalCookies: 5, importedCookies: 4, skippedCookies: 1, domains: ['example.test', 'one.github.io'] })
    expect(result.warning?.code).toBe('browser_import_decryption_skipped')
    const imported = await liveCookies(h, page.browserPageId)
    expect(imported).toContainEqual(expect.objectContaining({ name: 'encrypted', value: 'encrypted-session' }))
    expect(imported).toContainEqual(expect.objectContaining({ name: 'encrypted-v11', value: 'encrypted-session-v11' }))
    expect(imported).toContainEqual(expect.objectContaining({ name: 'plain-name', value: 'plain-value' }))
    expect(imported).toContainEqual(expect.objectContaining({ name: 'partitioned', partitionKey: { topLevelSite: 'https://shop.example', hasCrossSiteAncestor: true } }))
    expect(imported.some((item) => item.name === 'app-bound')).toBe(false)
    expect(readFileSync(databasePath)).toEqual(beforeDb)
    expect(readFileSync(`${databasePath}-wal`)).toEqual(beforeWal)
    expect(readdirSync(join(h.home, 'plugin-data', 'quirky.browser')).filter((name) => name.startsWith('import-'))).toEqual([])
    expect(db.query('SELECT COUNT(*) AS count FROM cookies').get()).toMatchObject({ count: 5 })
  } finally { db.close(); await h.cleanup() }
}, 60_000)

test('SC-15: Firefox profile paths and Safari cookie files preserve import semantics', async () => {
  const h = await startBrowserHarness()
  const firefoxPath = join(h.sourceRoots.firefox!, 'Profiles', 'default-release', 'cookies.sqlite')
  const firefoxWalPath = `${firefoxPath}-wal`
  mkdirSync(join(h.sourceRoots.firefox!, 'Profiles', 'default-release'), { recursive: true })
  const db = createFirefoxDatabase(firefoxPath)
  const expiry = Math.floor(Date.now() / 1000) + 3600
  db.prepare('INSERT INTO moz_cookies VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('', 'live', 'firefox-value', '.firefox.example', '/', expiry, 1, 1, 2, 2, 0, 1)
  db.prepare('INSERT INTO moz_cookies VALUES (2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('', 'expired', 'old', '.expired.example', '/', 1, 0, 0, 0, 0, 0, 1)
  db.prepare('INSERT INTO moz_cookies VALUES (3, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('^partitionKey=(https,shop.example)', 'opaque', 'partition-value', '.private.github.io', '/', expiry, 1, 1, 2, 2, 0, 1)
  db.prepare('INSERT INTO moz_cookies VALUES (4, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('', 'partition-sibling', 'must-not-import', '.private.github.io', '/', expiry, 1, 1, 1, 1, 0, 1)

  const externalProfileDirectory = join(h.home, 'external-firefox-profile')
  mkdirSync(externalProfileDirectory, { recursive: true })
  const externalPath = join(externalProfileDirectory, 'cookies.sqlite')
  const externalWalPath = `${externalPath}-wal`
  const externalDb = createFirefoxDatabase(externalPath)
  externalDb.prepare('INSERT INTO moz_cookies VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('', 'absolute-profile', 'external-value', '.external.example', '/', expiry, 1, 1, 2, 2, 0, 1)
  writeFileSync(join(h.sourceRoots.firefox!, 'profiles.ini'), `[Profile0]
Name=default-release
IsRelative=1
Path=Profiles/default-release
Default=1
[Profile1]
Name=external
IsRelative=0
Path=${externalProfileDirectory}
`)

  // Live Chrome caps new cookies at 400 days; the parser's far-future epoch case is a separate unit test.
  const safariExpires = Math.floor(Date.now() / 1000) + 86_400
  const safariPath = h.sourceRoots.safari!
  rmdirSync(safariPath)
  writeFileSync(safariPath, createSafariCookies(safariExpires))
  try {
    const page = await createManagedPage(h)
    const firefoxBytes = readFileSync(firefoxPath)
    const firefoxWalBytes = readFileSync(firefoxWalPath)
    const externalBytes = readFileSync(externalPath)
    const externalWalBytes = readFileSync(externalWalPath)
    const safariBytes = readFileSync(safariPath)
    const firefox = await h.client.callAny('quirky.browser/importCookies', { source: { kind: 'browser', family: 'firefox', profile: 'default-release' }, yes: true }) as { importedCookies: number; partitionSkippedCookies?: number; warning?: { code: string } }
    expect(firefox.importedCookies).toBe(1)
    expect(firefox.partitionSkippedCookies).toBe(2)
    expect(firefox.warning?.code).toBe('browser_import_partition_skipped')
    const afterFirefox = await liveCookies(h, page.browserPageId)
    const firefoxCookie = afterFirefox.find((item) => item.name === 'live')
    expect(firefoxCookie).toMatchObject({ value: 'firefox-value', hostOnly: false, secure: true, httpOnly: true, sameSite: 'Strict' })
    expect(afterFirefox.some((item) => item.name === 'opaque' || item.name === 'expired' || item.name === 'partition-sibling')).toBe(false)
    const firefoxSubdomain = await h.client.callAny('quirky.browser/cookieGet', {
      page: page.browserPageId,
      url: 'https://sub.firefox.example/'
    }) as { cookies: Cookie[] }
    expect(firefoxSubdomain.cookies).toContainEqual(expect.objectContaining({ name: 'live', value: 'firefox-value' }))

    const external = await h.client.callAny('quirky.browser/importCookies', {
      source: { kind: 'browser', family: 'firefox', profile: 'external-firefox-profile' },
      yes: true
    }) as { importedCookies: number }
    expect(external.importedCookies).toBe(1)
    const externalCookie = (await liveCookies(h, page.browserPageId)).find((item) => item.name === 'absolute-profile')
    expect(externalCookie).toMatchObject({ value: 'external-value', hostOnly: false })
    const externalSubdomain = await h.client.callAny('quirky.browser/cookieGet', {
      page: page.browserPageId,
      url: 'https://sub.external.example/'
    }) as { cookies: Cookie[] }
    expect(externalSubdomain.cookies).toContainEqual(expect.objectContaining({ name: 'absolute-profile', value: 'external-value' }))

    const safari = await h.client.callAny('quirky.browser/importCookies', { source: { kind: 'browser', family: 'safari' }, yes: true }) as { importedCookies: number }
    expect(safari.importedCookies).toBe(1)
    const afterSafari = await liveCookies(h, page.browserPageId)
    expect(afterSafari).toContainEqual(expect.objectContaining({ name: 'live', value: 'firefox-value' }))
    const safariCookie = afterSafari.find((item) => item.name === 'safari')
    expect(safariCookie).toMatchObject({ value: 'safari-value', secure: true, httpOnly: true, hostOnly: false, expires: safariExpires })
    const safariSubdomain = await h.client.callAny('quirky.browser/cookieGet', {
      page: page.browserPageId,
      url: 'https://sub.safari.example/'
    })
    expect(safariSubdomain).toMatchObject({
      cookies: expect.arrayContaining([expect.objectContaining({ name: 'safari', value: 'safari-value' })])
    })
    expect(readFileSync(firefoxPath)).toEqual(firefoxBytes)
    expect(readFileSync(firefoxWalPath)).toEqual(firefoxWalBytes)
    expect(readFileSync(externalPath)).toEqual(externalBytes)
    expect(readFileSync(externalWalPath)).toEqual(externalWalBytes)
    expect(readFileSync(safariPath)).toEqual(safariBytes)
  } finally { db.close(); externalDb.close(); await h.cleanup() }
}, 60_000)

test('SC-16: replacement keeps Google, unrelated and sibling private-suffix identities while preserving CHIPS keys', async () => {
  const h = await startBrowserHarness()
  try {
    const page = await createManagedPage(h)
    await seedLiveCookie(h, page.browserPageId, cookie('existing', 'unrelated', '.other.test'))
    await seedLiveCookie(h, page.browserPageId, cookie('google', 'protected', '.google.com'))
    await seedLiveCookie(h, page.browserPageId, cookie('other-tenant', 'keep', '.two.github.io'))
    const source = writeJsonSource(h.home, [
      sourceRow('safe', 'new', '.example.test'),
      sourceRow('google', 'do-not-import', '.google.com'),
      { ...sourceRow('partitioned', 'chip', '.one.github.io'), partitionKey: { topLevelSite: 'https://shop.example', hasCrossSiteAncestor: false } },
      sourceRow('bare-private-suffix', 'do-not-import', 'github.io'),
    ])
    const result = await h.client.callAny('quirky.browser/importCookies', { source: { kind: 'file', path: source }, yes: true }) as { importedCookies: number; googleCookiesSkipped?: number; domains: string[] }
    expect(result).toMatchObject({ importedCookies: 2, skippedCookies: 2, googleCookiesSkipped: 1, domains: ['example.test', 'one.github.io'] })
    const imported = await liveCookies(h, page.browserPageId)
    expect(imported).toContainEqual(expect.objectContaining({ name: 'google', value: 'protected' }))
    expect(imported).toContainEqual(expect.objectContaining({ name: 'existing', value: 'unrelated' }))
    expect(imported).toContainEqual(expect.objectContaining({ name: 'other-tenant', value: 'keep' }))
    expect(imported).toContainEqual(expect.objectContaining({ name: 'partitioned', partitionKey: { topLevelSite: 'https://shop.example', hasCrossSiteAncestor: false } }))
    expect(imported).toContainEqual(expect.objectContaining({ name: 'safe', value: 'new' }))
    const beforeUnsafe = canonicalCookies(imported)
    const unsafeSource = writeJsonSource(h.home, [
      { ...sourceRow('unsafe-partition', 'opaque', 'com'), partitionKeyOpaque: true },
      sourceRow('safe-sibling', 'must-not-write', '.safe.example')
    ], 'unreadable-partition.json')
    await reason(h.client, 'importCookies', { source: { kind: 'file', path: unsafeSource }, yes: true }, 'browser_import_source_unavailable')
    expect(canonicalCookies(await liveCookies(h, page.browserPageId))).toEqual(beforeUnsafe)
  } finally { await h.cleanup() }
}, 60_000)

test('SC-17: failed replacement rolls back exact live identities and concurrent imports serialize per profile', async () => {
  const probe = createCookieTransportProbe()
  const h = await startBrowserHarness({ wrapCookieTransport: probe.wrapCookieTransport })
  try {
    const page = await createManagedPage(h)
    const original = cookie('old', 'old-value')
    const outside = cookie('outside', 'keep', '.outside.test')
    await seedLiveCookie(h, page.browserPageId, original)
    await seedLiveCookie(h, page.browserPageId, outside)
    const beforeFailure = canonicalCookies(await liveCookies(h, page.browserPageId))
    const source = writeJsonSource(h.home, [sourceRow('new-a', 'a'), sourceRow('new-b', 'b')])
    probe.failSetAfter(2)
    await reason(h.client, 'importCookies', { source: { kind: 'file', path: source }, yes: true }, 'browser_error')
    expect(canonicalCookies(await liveCookies(h, page.browserPageId))).toEqual(beforeFailure)

    const success = await h.client.callAny('quirky.browser/importCookies', { source: { kind: 'file', path: source }, yes: true }) as { importedCookies: number }
    expect(success.importedCookies).toBe(2)
    const afterSuccess = await liveCookies(h, page.browserPageId)
    expect(afterSuccess).toContainEqual(expect.objectContaining({ name: 'new-a', value: 'a' }))
    expect(afterSuccess).toContainEqual(expect.objectContaining({ name: 'new-b', value: 'b' }))
    expect(afterSuccess).toContainEqual(expect.objectContaining({ name: 'outside', value: 'keep' }))
    expect(afterSuccess.some((item) => item.name === 'old')).toBe(false)

    const firstSource = writeJsonSource(h.home, [sourceRow('first-family', 'one', '.first.test')], 'first-family.json')
    const secondSource = writeJsonSource(h.home, [sourceRow('second-family', 'two', '.second.test')], 'second-family.json')
    const [first, second] = await Promise.all([
      h.client.callAny('quirky.browser/importCookies', { source: { kind: 'file', path: firstSource }, yes: true }) as Promise<{ importedCookies: number }>,
      h.client.callAny('quirky.browser/importCookies', { source: { kind: 'file', path: secondSource }, yes: true }) as Promise<{ importedCookies: number }>
    ])
    expect(first.importedCookies).toBe(1)
    expect(second.importedCookies).toBe(1)
    const afterConcurrent = await liveCookies(h, page.browserPageId)
    expect(afterConcurrent).toContainEqual(expect.objectContaining({ name: 'first-family', value: 'one' }))
    expect(afterConcurrent).toContainEqual(expect.objectContaining({ name: 'second-family', value: 'two' }))
    expect(probe.maxConcurrentSets).toBe(1)
  } finally { await h.cleanup() }
}, 60_000)

test('SC-17: rollback failure has a distinct unsafe-replacement error and never returns a summary', async () => {
  const probe = createCookieTransportProbe()
  const h = await startBrowserHarness({ wrapCookieTransport: probe.wrapCookieTransport })
  try {
    const page = await createManagedPage(h)
    const original = cookie('old', 'old-value')
    await seedLiveCookie(h, page.browserPageId, original)
    const beforeFailure = canonicalCookies(await liveCookies(h, page.browserPageId))
    const source = writeJsonSource(h.home, [sourceRow('new-a', 'a'), sourceRow('new-b', 'b')], 'rollback-failure.json')
    probe.failSetAfter(2)
    probe.failDeleteAfter(2)
    await reason(h.client, 'importCookies', { source: { kind: 'file', path: source }, yes: true }, 'browser_unsafe_replace')
    expect(canonicalCookies(await liveCookies(h, page.browserPageId))).toEqual(beforeFailure)
  } finally { await h.cleanup() }
}, 60_000)


async function runBrowserCli(h: BrowserTestHarness, argv: string[]) {
  let stdout = ''
  let stderr = ''
  const client = await h.daemon.connect('cli')
  const code = await run({
    argv,
    env: { QUIRKY_HOME: h.home },
    cwd: h.home,
    writer: { stdout: (text) => { stdout += text }, stderr: (text) => { stderr += text } },
    link: createDaemonLink(async () => client, { yes: argv.includes('--yes') }),
    openDesktopApp: async () => ({ ok: false, reason: 'not used' })
  })
  return { code, stdout, stderr }
}

test('SC-18: real CLI import flags reach the importer and mixed selectors fail as usage', async () => {
  const h = await startBrowserHarness()
  try {
    const page = await createManagedPage(h)
    const path = writeJsonSource(h.home, [sourceRow('cli-cookie', 'cli-value')], 'cli-cookies.json')
    const result = await runBrowserCli(h, ['browser', 'import', 'file', '--path', path, '--yes', '--json'])
    expect(result).toMatchObject({ code: 0 })
    expect(JSON.parse(result.stdout)).toMatchObject({ importedCookies: 1, domains: ['example.test'] })
    expect(result.stderr).toBe('')
    expect(await liveCookies(h, page.browserPageId)).toContainEqual(expect.objectContaining({ name: 'cli-cookie', value: 'cli-value' }))
    const missingSource = join(h.home, 'source-must-not-be-read.json')
    expect(existsSync(missingSource)).toBe(false)
    const jobsBeforeInvalid = await h.client.callAny('quirky.browser/importList', {}) as { jobs: unknown[] }
    const cookiesBeforeInvalid = canonicalCookies(await liveCookies(h, page.browserPageId))
    const spawnCountBeforeInvalid = h.spawnCount()
    const invalid = await runBrowserCli(h, ['browser', 'import', 'start', '--file', missingSource, '--browser', 'chrome', '--yes', '--json'])
    expect(invalid.code).toBe(2)
    expect(existsSync(missingSource)).toBe(false)
    expect(await h.client.callAny('quirky.browser/importList', {})).toEqual(jobsBeforeInvalid)
    expect(canonicalCookies(await liveCookies(h, page.browserPageId))).toEqual(cookiesBeforeInvalid)
    expect(h.spawnCount()).toBe(spawnCountBeforeInvalid)
    const partitionKey = { topLevelSite: 'https://shop.example', hasCrossSiteAncestor: false }
    const partitionJson = JSON.stringify(partitionKey)
    const cookieSet = await runBrowserCli(h, [
      'browser', 'cookie', 'set', '--page', page.browserPageId, '--name', 'cli-partition',
      '--value', 'partition-value', '--domain', '.example.test', '--secure',
      '--partition-key', partitionJson, '--json'
    ])
    expect(cookieSet).toMatchObject({ code: 0 })
    expect(JSON.parse(cookieSet.stdout)).toEqual({ success: true })
    expect(await liveCookies(h, page.browserPageId)).toContainEqual(expect.objectContaining({ name: 'cli-partition', partitionKey }))
    const cookieDelete = await runBrowserCli(h, [
      'browser', 'cookie', 'delete', '--page', page.browserPageId, '--name', 'cli-partition',
      '--domain', '.example.test', '--partition-key', partitionJson, '--yes', '--json'
    ])
    expect(cookieDelete.code).toBe(0)
    expect(JSON.parse(cookieDelete.stdout)).toEqual({ deleted: true })
    const profileResult = await runBrowserCli(h, ['browser', 'tab', 'profile', 'create', '--label', 'CLI Review', '--json'])
    expect(profileResult.code).toBe(0)
    const profileOutput = JSON.parse(profileResult.stdout) as { profile: { id: string } }
    const reviewId = profileOutput.profile.id
    const cloneResult = await runBrowserCli(h, ['browser', 'tab', 'profile', 'clone', '--profile', reviewId, '--page', page.browserPageId, '--json'])
    expect(cloneResult.code).toBe(0)
    const clone = JSON.parse(cloneResult.stdout) as { browserPageId: string; sourceBrowserPageId: string; profileId: string }
    expect(clone).toMatchObject({ sourceBrowserPageId: page.browserPageId, profileId: reviewId })
    expect(await liveCookies(h, clone.browserPageId)).toContainEqual(expect.objectContaining({ name: 'cli-cookie', value: 'cli-value' }))
    expect(JSON.parse((await runBrowserCli(h, ['browser', 'tab', 'profile', 'show', '--page', clone.browserPageId, '--json'])).stdout))
      .toMatchObject({ browserPageId: clone.browserPageId, profileId: reviewId })
    const defaulted = await runBrowserCli(h, ['browser', 'tab', 'profile', 'use-default', '--page', clone.browserPageId, '--json'])
    expect(JSON.parse(defaulted.stdout)).toMatchObject({ browserPageId: clone.browserPageId, profileId: 'default' })
    const deletedProfile = await runBrowserCli(h, ['browser', 'tab', 'profile', 'delete', '--profile', reviewId, '--yes', '--json'])
    expect(JSON.parse(deletedProfile.stdout)).toMatchObject({ deleted: true, profileId: reviewId })
    const opened = await runBrowserCli(h, ['browser', 'open-url', '--url', `${h.fixtureUrl}first`, '--json'])
    expect(opened.code).toBe(0)
    const openedPage = JSON.parse(opened.stdout) as { browserPageId: string }
    const execOpen = await runBrowserCli(h, [
      'browser', 'exec', '--page', page.browserPageId, '--command', `open ${h.fixtureUrl}second`, '--json'
    ])
    expect(JSON.parse(execOpen.stdout)).toMatchObject({ result: { url: `${h.fixtureUrl}second`, title: 'Second' } })
    expect((await h.client.callAny('quirky.browser/tabShow', { page: clone.browserPageId }) as { tab: { url: string } }).tab.url).toBe(`${h.fixtureUrl}events`)
    const execNavigation = await runBrowserCli(h, [
      'browser', 'exec', '--page', page.browserPageId, '--command', `navigate ${h.fixtureUrl}events`, '--json'
    ])
    expect(JSON.parse(execNavigation.stdout)).toMatchObject({ result: { url: `${h.fixtureUrl}events`, title: 'Events' } })
    const closed = await runBrowserCli(h, ['browser', 'tab', 'close', '--page', openedPage.browserPageId, '--yes', '--json'])
    expect(JSON.parse(closed.stdout)).toEqual({ closed: true })
  } finally { await h.cleanup() }
}, 60_000)
