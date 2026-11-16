import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { createIsolatedRuntimeEnvironment } from './ui-review/fixtures'
import {
  classifyStore,
  damageStore,
  installSweepStandIns,
  inventoryStores,
  JSON_STORES,
  REQUIRED_OWNERS,
  runCorruptionSweep,
  sweepFailures,
  type CorruptionMode,
  type InventoriedStore,
  type SweepResult
} from './corrupt-stores'

const roots: string[] = []
const repoRoot = join(import.meta.dir, '..')

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function damageResult(): SweepResult {
  return {
    mode: 'garbage',
    activeBefore: [...REQUIRED_OWNERS],
    firstStartReport: [{ id: 'unrelated.plugin', state: 'failed', reason: 'reported only' }],
    restartReport: [],
    thirdStartReport: [],
    stores: [
      {
        path: 'plugin-data/example/store.sqlite', kind: 'sqlite', damaged: true,
        damageChanged: true, outcome: 'quarantined', check: null
      },
      ...JSON_STORES.map((store) => ({
        path: store.path,
        kind: 'json' as const,
        damaged: true,
        damageChanged: true,
        outcome: store.expect === 'quarantine' ? 'quarantined' as const : 'rewritten' as const,
        check: { ok: true, detail: 'valid content' },
        siblingBytesMatch: true
      }))
    ],
    unlistedJson: ['plugin-data/other-plugin/settings.json'],
    mobileListenerHosts: ['127.0.0.1'],
    ownerGrants: [{ id: 'seed', name: 'sweep' }],
    credentialStatus: [{ provider: 'zcode', kind: 'base-url', configured: true, readable: true }],
    newCorruptOnThirdStart: [],
    standIns: {
      selfTest: { security: true, egress: true },
      calls: ['curl https://example.invalid/provider'],
      refusedEgress: ['https://example.invalid/provider']
    }
  }
}

function healthyResult(): SweepResult {
  const result = damageResult()
  result.mode = 'healthy'
  const grant = {
    grantId: 'ca7b9ef1-19fc-4b59-a3d7-9044c739578a', name: 'sweep',
    endpoint: 'ws://127.0.0.1:1', scope: 'owner-cli', createdAt: 1_700_000_000_000
  }
  Object.assign(result, { seededOwnerGrant: grant })
  result.ownerGrants = [{ ...grant }]
  result.stores = JSON_STORES.map((store) => ({
    path: store.path,
    kind: 'json',
    damaged: false,
    damageChanged: null,
    outcome: null,
    check: store.path === 'plugin-data/quirky.browser/browser-state.json'
      ? { ok: true, detail: 'browser bytes unchanged' }
      : null
  }))
  return result
}

describe('helpers', () => {
  test('stand-ins reject the exact credential and network self-tests', () => {
    const root = temporaryRoot('quirky-corrupt-stores-helpers-')
    const installed = installSweepStandIns(root)
    const temp = join(root, 'tmp')
    mkdirSync(temp, { recursive: true })
    const env = {
      ...createIsolatedRuntimeEnvironment(root, { repoRoot }),
      HOME: root,
      QUIRKY_HOME: join(root, '.quirky'),
      TMPDIR: temp,
      PATH: [installed.fakebin, dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter),
      BUN_OPTIONS: `--preload=${installed.preload}`,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0'
    }

    const security = Bun.spawnSync(
      ['/bin/sh', '-c', 'security find-generic-password -s quirky-corrupt-stores-self-test'],
      { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
    )
    expect(security.exitCode).toBe(97)
    expect(readFileSync(installed.standInLog, 'utf8')).toBe('security find-generic-password -s quirky-corrupt-stores-self-test\n')

    const url = 'https://example.invalid/quirky-corrupt-stores-self-test'
    const egress = Bun.spawnSync(
      [process.execPath, '-e', `await fetch('${url}').then(() => process.exit(3), () => process.exit(0))`],
      { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
    )
    expect(egress.exitCode).toBe(0)
    expect(readFileSync(installed.egressLog, 'utf8')).toBe(`${url}\n`)
    expect(readFileSync(installed.standInLog, 'utf8')).toBe('security find-generic-password -s quirky-corrupt-stores-self-test\n')
  })

  test('inventory includes only lstat-regular store files and excludes scoped, hidden, sidecar and corrupt paths', () => {
    const root = temporaryRoot('quirky-corrupt-stores-inventory-')
    const home = join(root, '.quirky')
    const pluginData = join(home, 'plugin-data')
    const nested = join(pluginData, 'example')
    const tmp = join(home, 'tmp')
    const outside = join(root, 'outside')
    mkdirSync(nested, { recursive: true })
    mkdirSync(tmp, { recursive: true })
    mkdirSync(outside, { recursive: true })

    writeFileSync(join(home, 'runtime.json'), '{}')
    writeFileSync(join(home, 'settings.json'), '{}')
    writeFileSync(join(pluginData, 'valid.db'), 'db')
    writeFileSync(join(nested, 'valid.sqlite'), 'sqlite')
    writeFileSync(join(nested, 'valid.sqlite3'), 'sqlite3')
    writeFileSync(join(pluginData, 'metadata.json'), '{}')
    writeFileSync(join(nested, 'store.json.corrupt-123-abcdef12'), '{}')
    writeFileSync(join(nested, 'store.corrupt-123-abcdef12.json'), '{}')
    writeFileSync(join(nested, 'wal.sqlite-wal'), 'sidecar')
    writeFileSync(join(nested, 'shm.sqlite-shm'), 'sidecar')
    writeFileSync(join(nested, 'journal.sqlite-journal'), 'sidecar')
    writeFileSync(join(nested, '.hidden.json'), '{}')
    writeFileSync(join(tmp, 'transient.json'), '{}')
    mkdirSync(join(nested, 'directory.json'))

    writeFileSync(join(outside, 'external.json'), '{}')
    mkdirSync(join(outside, 'directory'))
    writeFileSync(join(outside, 'directory', 'nested.json'), '{}')
    symlinkSync(join(outside, 'external.json'), join(pluginData, 'linked.json'))
    symlinkSync(join(outside, 'directory'), join(pluginData, 'linked-directory'))

    const stores = inventoryStores(home)
    expect(stores).toEqual(([
      { path: 'plugin-data/metadata.json', kind: 'json' },
      { path: 'plugin-data/valid.db', kind: 'sqlite' },
      { path: 'plugin-data/example/valid.sqlite', kind: 'sqlite' },
      { path: 'plugin-data/example/valid.sqlite3', kind: 'sqlite' },
      { path: 'settings.json', kind: 'json' }
    ] satisfies InventoriedStore[]).sort((left, right) => left.path.localeCompare(right.path)))
    expect(existsSync(join(outside, 'external.json'))).toBe(true)
    expect(existsSync(join(outside, 'directory', 'nested.json'))).toBe(true)
  })

  test.each([
    ['json garbage', 'json', 'garbage'],
    ['json truncate', 'json', 'truncate'],
    ['json shape', 'json', 'shape']
  ] as const)('%s writes the specified JSON damage bytes', (_name, kind, mode) => {
    const root = temporaryRoot('quirky-corrupt-stores-damage-')
    const file = join(root, 'store.json')
    const original = Buffer.from('{"valid":true,"payload":"abcdefgh"}')
    writeFileSync(file, original)
    const expected = mode === 'garbage'
      ? Buffer.alloc(8192, 0x41)
      : mode === 'truncate'
        ? original.subarray(0, Math.floor(original.length / 2))
        : Buffer.from('{"quirkyCorruptStoreSweep":[1]}')

    const written = damageStore(file, kind, mode)
    expect(written).toEqual(expected)
    expect(written.equals(original)).toBe(false)
    expect(readFileSync(file).equals(written)).toBe(true)
  })

  test.each([
    ['sqlite garbage', 'garbage'],
    ['sqlite truncate', 'truncate']
  ] as const)('%s writes the specified SQLite damage bytes', (_name, mode) => {
    const root = temporaryRoot('quirky-corrupt-stores-sqlite-damage-')
    const file = join(root, 'store.sqlite')
    const database = new Database(file)
    database.exec('CREATE TABLE sample (value TEXT)')
    database.exec("INSERT INTO sample VALUES ('sqlite fixture')")
    database.close()
    const original = readFileSync(file)
    const wal = `${file}-wal`
    const shm = `${file}-shm`
    writeFileSync(wal, Buffer.from('prewritten wal'))
    writeFileSync(shm, Buffer.from('prewritten shm'))

    const truncateLength = Math.min(original.length - 1, Math.max(100, Math.floor(original.length / 2) - 37))
    const expected = mode === 'garbage' ? Buffer.alloc(8192, 0x41) : original.subarray(0, truncateLength)

    const written = damageStore(file, 'sqlite', mode)
    expect(written).toEqual(expected)
    expect(written.equals(original)).toBe(false)
    expect(readFileSync(file).equals(written)).toBe(true)
    expect(existsSync(wal)).toBe(false)
    expect(existsSync(shm)).toBe(false)
  })

  test('SQLite shape damage changes bytes after the header of a real one-page bun:sqlite database', () => {
    const root = temporaryRoot('quirky-corrupt-stores-sqlite-shape-')
    const file = join(root, 'one-page.sqlite')
    const database = new Database(file)
    database.exec('CREATE TABLE transient (value TEXT)')
    database.exec('DROP TABLE transient')
    database.exec('VACUUM')
    database.exec('PRAGMA user_version = 1')
    const pageCount = database.query('PRAGMA page_count').get() as { page_count: number }
    database.close()

    const original = readFileSync(file)
    const encodedPageSize = original.readUInt16BE(16)
    const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize
    expect(original.subarray(0, 16).toString()).toBe('SQLite format 3\u0000')
    expect(pageCount.page_count).toBe(1)
    expect(original.length).toBe(pageSize)

    const written = damageStore(file, 'sqlite', 'shape')
    expect(written.equals(original)).toBe(false)
    expect(written.subarray(0, 100)).toEqual(original.subarray(0, 100))
    expect(written.subarray(100)).toEqual(Buffer.alloc(pageSize - 100, 0xa5))
    expect(readFileSync(file).equals(written)).toBe(true)
  })

  test('SQLite shape damage preserves page one and fills the rest of a real multi-page bun:sqlite database', () => {
    const root = temporaryRoot('quirky-corrupt-stores-sqlite-shape-')
    const file = join(root, 'multi-page.sqlite')
    const database = new Database(file)
    database.exec('CREATE TABLE sample (value TEXT)')
    const insert = database.prepare('INSERT INTO sample VALUES (?)')
    database.exec('BEGIN')
    const value = 'x'.repeat(512)
    for (let index = 0; index < 100; index++) insert.run(value)
    database.exec('COMMIT')
    insert.finalize()
    const pageCount = database.query('PRAGMA page_count').get() as { page_count: number }
    database.close()

    const original = readFileSync(file)
    const encodedPageSize = original.readUInt16BE(16)
    const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize
    expect(pageCount.page_count).toBeGreaterThan(1)
    expect(original.length).toBeGreaterThan(pageSize)

    const written = damageStore(file, 'sqlite', 'shape')
    expect(written.equals(original)).toBe(false)
    expect(written.subarray(0, pageSize)).toEqual(original.subarray(0, pageSize))
    expect(written.subarray(pageSize)).toEqual(Buffer.alloc(original.length - pageSize, 0xa5))
    expect(readFileSync(file).equals(written)).toBe(true)
  })

  test('classification recognizes both quarantine names and ignores siblings that existed before damage', () => {
    const root = temporaryRoot('quirky-corrupt-stores-classify-')
    const home = join(root, '.quirky')
    const directory = join(home, 'plugin-data', 'quirky.accounts')
    mkdirSync(directory, { recursive: true })
    const store: InventoriedStore = { path: 'plugin-data/quirky.accounts/usage-credentials.json', kind: 'json' }
    const file = join(home, store.path)
    const damaged = Buffer.from('{broken')
    writeFileSync(file, damaged)

    const oldSibling = 'plugin-data/quirky.accounts/usage-credentials.json.corrupt-100-00000000'
    writeFileSync(join(home, oldSibling), damaged)
    const prior = new Set([oldSibling])
    expect(classifyStore(home, store, damaged, prior)).toBe('untouched')

    const feedbackSibling = 'plugin-data/quirky.accounts/usage-credentials.corrupt-200-abcdef12.json'
    writeFileSync(join(home, feedbackSibling), damaged)
    expect(classifyStore(home, store, damaged, prior)).toBe('quarantined')

    rmSync(join(home, feedbackSibling))
    rmSync(file)
    const ordinarySibling = 'plugin-data/quirky.accounts/usage-credentials.json.corrupt-300-abcdef12'
    writeFileSync(join(home, ordinarySibling), damaged)
    expect(classifyStore(home, store, damaged, prior)).toBe('quarantined')
  })

  test('classification distinguishes rewritten from untouched content without a new sibling', () => {
    const root = temporaryRoot('quirky-corrupt-stores-classify-')
    const home = join(root, '.quirky')
    const directory = join(home, 'plugin-data', 'example')
    mkdirSync(directory, { recursive: true })
    const store: InventoriedStore = { path: 'plugin-data/example/store.json', kind: 'json' }
    const file = join(home, store.path)
    const damaged = Buffer.from('{broken')

    writeFileSync(file, damaged)
    expect(classifyStore(home, store, damaged, new Set())).toBe('untouched')
    writeFileSync(file, Buffer.from('{"recovered":true}'))
    expect(classifyStore(home, store, damaged, new Set())).toBe('rewritten')
  })

  test('sweepFailures accepts a passing fixture and does not fail for reported plugin failures or stand-in activity', () => {
    expect(sweepFailures(damageResult())).toEqual([])
  })

  test.each(['garbage', 'truncate', 'shape'] as const)('tolerates only the exact second-start registry error in %s mode', (mode) => {
    const result = Object.assign(damageResult(), {
      mode,
      mobileListenerHosts: ['127.0.0.1', null, '127.0.0.1'],
      mobileStateErrors: [null, 'Mobile device registry unavailable. Mobile pairing data was damaged and set aside. Run quirky mobile reset-pairing --confirm to start over; every paired device must pair again.', null]
    })
    expect(sweepFailures(result)).toEqual([])
    result.mobileListenerHosts[1] = '0.0.0.0'
    expect(sweepFailures(result)).toEqual(['listener-host:0.0.0.0'])
  })

  test.each([
    ['garbage', 0, 'Mobile device registry unavailable. Mobile pairing data was damaged and set aside. Run quirky mobile reset-pairing --confirm to start over; every paired device must pair again.'],
    ['garbage', 2, 'Mobile device registry unavailable. Mobile pairing data was damaged and set aside. Run quirky mobile reset-pairing --confirm to start over; every paired device must pair again.'],
    ['healthy', 1, 'Mobile device registry unavailable. Mobile pairing data was damaged and set aside. Run quirky mobile reset-pairing --confirm to start over; every paired device must pair again.'],
    ['garbage', 1, 'Mobile device registry unavailable'],
    ['garbage', 1, 'another error'],
    ['garbage', 1, null]
  ] as const)('refuses unavailable listener for %s start %s with %s', (mode, index, error) => {
    const result = Object.assign(mode === 'healthy' ? healthyResult() : damageResult(), {
      mobileListenerHosts: ['127.0.0.1', '127.0.0.1', '127.0.0.1'] as (string | null)[],
      mobileStateErrors: [null, null, null] as (string | null)[]
    })
    result.mobileListenerHosts[index] = null
    result.mobileStateErrors[index] = error
    expect(sweepFailures(result)).toEqual(['listener-host:null'])
  })

  const commonFailures: Array<{ name: string; expected: string; violate(result: SweepResult): void }> = [
    {
      name: 'security stand-in self-test', expected: 'self-test:security',
      violate: (result) => { result.standIns.selfTest.security = false }
    },
    {
      name: 'egress stand-in self-test', expected: 'self-test:egress',
      violate: (result) => { result.standIns.selfTest.egress = false }
    },
    ...REQUIRED_OWNERS.map((id) => ({
      name: `required owner ${id}`, expected: `required-owner-inactive:${id}`,
      violate: (result: SweepResult) => { result.activeBefore = result.activeBefore.filter((activeId) => activeId !== id) }
    })),
    {
      name: 'plugin loses activity after restart', expected: 'inactive-after-restart:quirky.browser',
      violate: (result) => { result.restartReport.push({ id: 'quirky.browser', state: 'failed', reason: 'recovery failed' }) }
    },
    {
      name: 'plugin loses activity after the third start', expected: 'inactive-after-third-start:quirky.mobile',
      violate: (result) => { result.thirdStartReport.push({ id: 'quirky.mobile', state: 'inactive', reason: 'third start failed' }) }
    },
    {
      name: 'required store is missing', expected: 'missing-store:plugin-data/quirky.browser/browser-state.json',
      violate: (result) => { result.stores = result.stores.filter((store) => store.path !== 'plugin-data/quirky.browser/browser-state.json') }
    },
    {
      name: 'listener is not loopback', expected: 'listener-host:0.0.0.0',
      violate: (result) => { result.mobileListenerHosts = ['0.0.0.0'] }
    },
    {
      name: 'store is requarantined on the third start', expected: 'requarantined-on-third-start:browser-state.json',
      violate: (result) => { result.newCorruptOnThirdStart.push('browser-state.json') }
    },
    {
      name: 'damage did not change the original bytes', expected: 'damage-noop:plugin-data/example/store.sqlite',
      violate: (result) => {
        const store = result.stores.find((candidate) => candidate.kind === 'sqlite')!
        store.damageChanged = false
      }
    },
    {
      name: 'SQLite corruption was not quarantined', expected: 'sqlite-not-quarantined:plugin-data/example/store.sqlite',
      violate: (result) => {
        const store = result.stores.find((candidate) => candidate.kind === 'sqlite')!
        store.outcome = 'rewritten'
      }
    },
    {
      name: 'JSON content check failed', expected: 'json-check:plugin-data/quirky.browser/browser-state.json:invalid browser metadata',
      violate: (result) => {
        const store = result.stores.find((candidate) => candidate.path === 'plugin-data/quirky.browser/browser-state.json')!
        store.check = { ok: false, detail: 'invalid browser metadata' }
      }
    },
    {
      name: 'JSON content check is missing', expected: 'json-check:plugin-data/quirky.browser/browser-state.json:content check missing',
      violate: (result) => {
        const store = result.stores.find((candidate) => candidate.path === 'plugin-data/quirky.browser/browser-state.json')!
        store.check = null
      }
    },
    {
      name: 'quarantined sibling bytes did not match the damage', expected: 'sibling-bytes:plugin-data/quirky.browser/browser-state.json',
      violate: (result) => {
        const store = result.stores.find((candidate) => candidate.path === 'plugin-data/quirky.browser/browser-state.json')!
        store.siblingBytesMatch = false
      }
    }
  ]

  test.each(commonFailures)('reports exactly the %s failure string', ({ violate, expected }) => {
    const result = damageResult()
    violate(result)
    expect(sweepFailures(result)).toEqual([expected])
  })

  test.each([
    ['plugin-data/quirky.browser/browser-state.json', 'quarantine'],
    ['plugin-data/quirky.mobile/owner-grants.json', 'quarantine'],
    ['plugin-data/quirky.accounts/usage-credentials.json', 'quarantine'],
    ['plugin-data/quirky.mobile/e2ee-keypair.json', 'quarantine'],
    ['plugin-data/quirky.mobile/devices.json', 'quarantine'],
    ['daemon-identity.json', 'rewrite']
  ] as const)('reports the exact JSON outcome failure for %s', (path, expectation) => {
    const result = damageResult()
    const store = result.stores.find((candidate) => candidate.path === path)!
    store.outcome = expectation === 'quarantine' ? 'untouched' : 'quarantined'
    expect(sweepFailures(result)).toEqual([`json-outcome:${path}:expected ${expectation} got ${store.outcome}`])
  })

  test.each([
    ['third-start quarantine', 'healthy-quarantine:browser-state.json', (result: SweepResult) => { result.newCorruptOnThirdStart.push('browser-state.json') }],
    ['restart quarantine', 'healthy-quarantine:some-store.json.corrupt-1-aabbccdd', (result: SweepResult) => {
      ;(result as SweepResult & { newCorruptAfterRestart?: string[] }).newCorruptAfterRestart = ['some-store.json.corrupt-1-aabbccdd']
    }],
    ['owner grants', 'healthy-owner-grants', (result: SweepResult) => { result.ownerGrants = [{ id: 'other', name: 'not-sweep' }] }],
    ['credential status', 'healthy-credential', (result: SweepResult) => { result.credentialStatus = [{ provider: 'zcode', kind: 'base-url', configured: false, readable: true }] }],
    ['browser metadata bytes', 'healthy-browser-bytes', (result: SweepResult) => {
      const browser = result.stores.find((store) => store.path === 'plugin-data/quirky.browser/browser-state.json')!
      browser.check = { ok: false, detail: 'browser bytes changed' }
    }]
  ] as const)('reports the exact healthy-mode %s failure string', (_name, expected, violate) => {
    const result = healthyResult()
    violate(result)
    expect(sweepFailures(result)).toEqual([expected])
  })

  test.each([
    ['grantId', 'f67ad93b-6f99-457c-8001-ac7c153b9218'],
    ['endpoint', 'ws://127.0.0.1:2'],
    ['scope', 'mobile'],
    ['createdAt', 1_700_000_000_001]
  ] as const)('healthy mode detects replacement of the seeded grant %s', (field, value) => {
    const result = healthyResult()
    expect(sweepFailures(result)).toEqual([])
    const grants = result.ownerGrants as Record<string, unknown>[]
    grants[0]![field] = value
    expect(sweepFailures(result)).toEqual(['healthy-owner-grants'])
  })

  test('healthy mode rejects a name-only grant instead of the persisted seed', () => {
    const result = healthyResult()
    result.ownerGrants = [{ name: 'sweep' }]
    expect(sweepFailures(result)).toEqual(['healthy-owner-grants'])
  })

  test('CLI validation failures exit 2 and print usage without starting a sweep', () => {
    const root = temporaryRoot('quirky-corrupt-stores-cli-')
    const existingOut = join(root, 'already-exists.jsonl')
    writeFileSync(existingOut, 'preserve me')
    const cases: Array<{ name: string; args: string[] }> = [
      { name: 'unknown flag', args: ['--unexpected', '--out', join(root, 'unknown.jsonl')] },
      { name: 'unknown mode', args: ['--mode', 'invalid', '--out', join(root, 'mode.jsonl')] },
      { name: 'missing output', args: ['--mode', 'garbage'] },
      { name: 'existing output', args: ['--out', existingOut] }
    ]

    for (const { name, args } of cases) {
      const child = Bun.spawnSync([process.execPath, join(import.meta.dir, 'corrupt-stores.ts'), ...args], {
        cwd: repoRoot,
        stdout: 'pipe',
        stderr: 'pipe'
      })
      expect(child.exitCode, name).toBe(2)
      expect(child.stderr.toString(), name).toMatch(/usage:/i)
    }
    expect(readFileSync(existingOut, 'utf8')).toBe('preserve me')
  })
})

describe('real daemon', () => {
  for (const mode of ['garbage', 'truncate', 'shape', 'healthy'] as const satisfies readonly CorruptionMode[]) {
    test(`${mode} mode recovers the real daemon and its stores`, async () => {
      const result = await runCorruptionSweep({ mode, repoRoot })
      console.log(JSON.stringify({
        mode,
        firstStartReport: result.firstStartReport,
        restartReport: result.restartReport,
        thirdStartReport: result.thirdStartReport,
        unlistedJson: result.unlistedJson
      }))
      expect(sweepFailures(result)).toEqual([])
    }, 150_000)
  }
})
