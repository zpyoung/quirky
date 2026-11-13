import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ProcessSpawner, SpawnExit, SpawnOptions, SpawnedProcess, StopOptions } from '@quirky/protocol'
import { readCookieSource, readKeychainKey } from '../src/cookies/sources'
import type { BrowserDependencies } from '../src/runtime/dependencies'
import type { BrowserFamily } from '../src/cookies/types'

type FakeChild = Pick<SpawnedProcess, 'pid' | 'stdout' | 'exited' | 'stop'>
type SpawnCall = { argv: readonly string[]; options: SpawnOptions }

const successfulExit: SpawnExit = { exitCode: 0, signal: null, durationMs: 0 }
const keychainItems: Array<[BrowserFamily, string]> = [
  ['chrome', 'Chrome Safe Storage'],
  ['edge', 'Microsoft Edge Safe Storage'],
  ['arc', 'Arc Safe Storage'],
  ['chromium', 'Brave Safe Storage'],
  ['comet', 'Comet Safe Storage'],
  ['helium', 'Helium Safe Storage']
]

let bunSpawnGuard: { mockRestore(): void } | undefined
let bunSpawnCalls = 0

beforeEach(() => {
  bunSpawnCalls = 0
  bunSpawnGuard = spyOn(Bun, 'spawn').mockImplementation(() => {
    bunSpawnCalls += 1
    throw new Error('unexpected direct process launch in fake Keychain test')
  })
})

afterEach(() => {
  const calls = bunSpawnCalls
  bunSpawnGuard?.mockRestore()
  bunSpawnGuard = undefined
  expect(calls).toBe(0)
})

function withPlatform<T>(platform: string, action: () => Promise<T>, securityBinary = true): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  const originalExistsSync = fs.existsSync
  Object.defineProperty(process, 'platform', {
    configurable: true,
    enumerable: descriptor?.enumerable ?? true,
    writable: true,
    value: platform
  })
  const existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation((path) => {
    if (path === '/usr/bin/security') return securityBinary
    return originalExistsSync(path)
  })
  return action().finally(() => {
    existsSyncSpy.mockRestore()
    if (descriptor) Object.defineProperty(process, 'platform', descriptor)
    else Reflect.deleteProperty(process, 'platform')
  })
}

function makeChild(options: {
  chunks?: Uint8Array[]
  exit?: SpawnExit
  pid?: number | null
  pendingOutput?: boolean
  pendingAfterChunks?: boolean
  readError?: boolean
} = {}): { child: SpawnedProcess; stops: StopOptions[]; wasCancelled(): boolean } {
  const chunks = options.chunks ?? []
  const exit = options.exit ?? successfulExit
  const stops: StopOptions[] = []
  let index = 0
  let cancelled = false
  let exitResolved = false
  const { promise: exited, resolve: resolveExit } = Promise.withResolvers<SpawnExit>()
  const settleExit = (value: SpawnExit) => {
    if (exitResolved) return
    exitResolved = true
    resolveExit(value)
  }
  if (!options.pendingOutput && !options.pendingAfterChunks) settleExit(exit)
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      if (options.readError) controller.error(new Error('fixture stream failure'))
    },
    pull(controller) {
      if (options.pendingOutput || options.readError) return
      if (index < chunks.length) controller.enqueue(chunks[index++]!)
      else if (!options.pendingAfterChunks) controller.close()
    },
    cancel() {
      cancelled = true
    }
  })
  const child = {
    pid: options.pid === undefined ? 123 : options.pid,
    stdout,
    get stderr(): never {
      throw new Error('Keychain stderr must remain ignored')
    },
    exited,
    async stop(stopOptions?: StopOptions) {
      stops.push(stopOptions ?? {})
      settleExit(exit)
      return await exited
    }
  } as unknown as SpawnedProcess
  return { child, stops, wasCancelled: () => cancelled }
}

function fakeSpawner(child: FakeChild, calls: SpawnCall[]): Pick<ProcessSpawner, 'spawn'> {
  return {
    spawn(argv, options) {
      calls.push({ argv: [...argv], options })
      return child as SpawnedProcess
    }
  }
}

function interceptKeychainTimeout(): {
  scheduled: Array<{ delay: number; handle: ReturnType<typeof setTimeout>; fire(): void; cleared: boolean }>
  restore(): void
} {
  const setTimeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout')
  const clearTimeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'clearTimeout')
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const scheduled: Array<{ delay: number; handle: ReturnType<typeof setTimeout>; fire(): void; cleared: boolean }> = []
  globalThis.setTimeout = ((callback: Parameters<typeof globalThis.setTimeout>[0], delay?: number) => {
    if (delay !== 5_000) return realSetTimeout(callback as never, delay as never)
    const handle = { keychainTimeout: scheduled.length } as unknown as ReturnType<typeof setTimeout>
    scheduled.push({ delay, handle, fire: callback as () => void, cleared: false })
    return handle
  }) as typeof globalThis.setTimeout
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    const timer = scheduled.find((entry) => entry.handle === handle)
    if (timer) {
      timer.cleared = true
      return
    }
    return realClearTimeout(handle)
  }) as typeof globalThis.clearTimeout
  return {
    scheduled,
    restore() {
      if (setTimeoutDescriptor) Object.defineProperty(globalThis, 'setTimeout', setTimeoutDescriptor)
      else Reflect.deleteProperty(globalThis, 'setTimeout')
      if (clearTimeoutDescriptor) Object.defineProperty(globalThis, 'clearTimeout', clearTimeoutDescriptor)
      else Reflect.deleteProperty(globalThis, 'clearTimeout')
    }
  }
}

test('reads each Chromium-family Safe Storage item through the injected spawner', async () => {
  await withPlatform('darwin', async () => {
    for (const [family, item] of keychainItems) {
      const key = Buffer.from('fixture-key')
      const fake = makeChild({ chunks: [Buffer.from(` ${key.toString()}\n`)] })
      const calls: SpawnCall[] = []
      const result = await readKeychainKey(family, fakeSpawner(fake.child, calls))
      expect(result?.equals(key)).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.argv).toEqual(['/usr/bin/security', 'find-generic-password', '-w', '-s', item])
      const { env, ...options } = calls[0]!.options
      expect(options).toEqual({ timeoutMs: 5_000, killGraceMs: 0, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
      if (!env) throw new Error('missing environment copy')
      expect(Object.keys(env).length === Object.keys(process.env).length).toBe(true)
      expect(Object.entries(process.env).every(([name, value]) => env[name] === value)).toBe(true)
      expect(env !== process.env).toBe(true)
    }
  })
})

test('does not spawn for unsupported families or platforms', async () => {
  const calls: SpawnCall[] = []
  const child = makeChild({ chunks: [Buffer.from('fixture-key')] })
  await withPlatform('darwin', async () => {
    expect(await readKeychainKey('firefox', fakeSpawner(child.child, calls))).toBeNull()
    expect(await readKeychainKey('safari', fakeSpawner(child.child, calls))).toBeNull()
  })
  await withPlatform('linux', async () => {
    expect(await readKeychainKey('chrome', fakeSpawner(child.child, calls))).toBeNull()
  })
  expect(calls).toHaveLength(0)
})

test('does not spawn when the macOS security executable is absent', async () => {
  await withPlatform('darwin', async () => {
    const calls: SpawnCall[] = []
    const child = makeChild({ chunks: [Buffer.from('fixture-key')] })
    expect(await readKeychainKey('chrome', fakeSpawner(child.child, calls))).toBeNull()
    expect(calls).toHaveLength(0)
  }, false)
})

test('accepts stdout at the 4096-byte boundary', async () => {
  await withPlatform('darwin', async () => {
    const bytes = Buffer.alloc(4_096, 0x6b)
    const fake = makeChild({ chunks: [bytes] })
    const result = await readKeychainKey('chrome', fakeSpawner(fake.child, []))
    expect(result?.byteLength).toBe(4_096)
    expect(fake.stops).toHaveLength(0)
  })
})

test('stops and cancels the stdout reader when output exceeds the cap', async () => {
  await withPlatform('darwin', async () => {
    const fake = makeChild({ chunks: [Buffer.alloc(4_096, 0x61), Buffer.from([0x62])], pendingAfterChunks: true })
    const result = await readKeychainKey('chrome', fakeSpawner(fake.child, []))
    expect(result).toBeNull()
    expect(fake.stops).toEqual([{ signal: 'SIGKILL' }])
    expect(fake.wasCancelled()).toBe(true)
  })
})

test('returns null for every unsuccessful child exit state', async () => {
  const failures: SpawnExit[] = [
    { exitCode: 7, signal: null, durationMs: 0 },
    { exitCode: null, signal: 'SIGTERM', durationMs: 0 },
    { exitCode: 0, signal: null, stopped: 'timeout', durationMs: 0 },
    { exitCode: 0, signal: null, stopped: 'aborted', durationMs: 0 },
    { exitCode: 0, signal: null, stopped: 'stop', durationMs: 0 },
    { exitCode: 0, signal: null, spawnError: { code: 'ENOENT', message: 'fixture failure' }, durationMs: 0 }
  ]
  await withPlatform('darwin', async () => {
    for (const exit of failures) {
      const fake = makeChild({ chunks: [Buffer.from('fixture-key')], exit })
      expect(await readKeychainKey('chrome', fakeSpawner(fake.child, []))).toBeNull()
    }
  })
})

test('does not return an empty or whitespace-only successful Keychain response', async () => {
  await withPlatform('darwin', async () => {
    for (const chunks of [[], [Buffer.from(' \t\n\r ')]] as Uint8Array[][]) {
      const fake = makeChild({ chunks })
      expect(await readKeychainKey('chrome', fakeSpawner(fake.child, []))).toBeNull()
    }
  })
})

test('returns null without throwing on synchronous spawn errors and pid-null handles', async () => {
  await withPlatform('darwin', async () => {
    const calls: SpawnCall[] = []
    const throwingSpawner: Pick<ProcessSpawner, 'spawn'> = {
      spawn() {
        calls.push({ argv: [], options: { timeoutMs: 5_000 } })
        throw new Error('fixture spawn failure')
      }
    }
    expect(await readKeychainKey('chrome', throwingSpawner)).toBeNull()
    const inactive = makeChild({ pid: null, exit: { exitCode: null, signal: null, spawnError: { code: 'ENOENT', message: 'fixture' }, durationMs: 0 } })
    expect(await readKeychainKey('chrome', fakeSpawner(inactive.child, calls))).toBeNull()
    expect(inactive.stops).toHaveLength(0)
    expect(calls).toHaveLength(2)
  })
})

test('returns null and stops the child when stdout reading fails', async () => {
  await withPlatform('darwin', async () => {
    const fake = makeChild({ readError: true })
    expect(await readKeychainKey('chrome', fakeSpawner(fake.child, []))).toBeNull()
    expect(fake.stops).toEqual([{ signal: 'SIGKILL' }])
  })
})

test('enforces the whole-call timeout and stops without waiting five seconds', async () => {
  await withPlatform('darwin', async () => {
    const timers = interceptKeychainTimeout()
    try {
      const fake = makeChild({ pendingOutput: true })
      const calls: SpawnCall[] = []
      const resultPromise = readKeychainKey('chrome', fakeSpawner(fake.child, calls))
      expect(timers.scheduled.map((timer) => timer.delay)).toEqual([5_000])
      timers.scheduled[0]!.fire()
      expect(await resultPromise).toBeNull()
      expect(fake.stops).toEqual([{ signal: 'SIGKILL' }])
      expect(fake.wasCancelled()).toBe(true)
      expect(timers.scheduled[0]?.cleared).toBe(true)
    } finally {
      timers.restore()
    }
  })
})

function encryptedCookie(value: string, host: string, password: string): Buffer {
  const key = pbkdf2Sync(password, 'saltysalt', 1_003, 16, 'sha1')
  const plaintext = Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from(value)])
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.from(' '.repeat(16)))
  return Buffer.concat([Buffer.from('v10'), cipher.update(plaintext), cipher.final()])
}

test('reads an encrypted Chromium cookie through injected process without a keyProvider', async () => {
  await withPlatform('darwin', async () => {
    const root = mkdtempSync(join(tmpdir(), 'quirky-keychain-source-'))
    const password = 'fixture-safe-storage-key'
    const cookieValue = 'fixture-cookie-value'
    const host = '.fixture.example'
    const chromeRoot = join(root, 'Chrome')
    const profile = join(chromeRoot, 'Default')
    const dataDir = join(root, 'data')
    mkdirSync(profile, { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    const database = new Database(join(profile, 'Cookies'))
    database.exec(`
      CREATE TABLE meta (key TEXT, value TEXT);
      INSERT INTO meta VALUES ('version', '24');
      CREATE TABLE cookies (
        host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER,
        is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, is_partitioned INTEGER,
        top_frame_site_key TEXT, has_cross_site_ancestor INTEGER
      );
    `)
    database.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      host, 'fixture-session', '', encryptedCookie(cookieValue, host, password), '/', 0, 1, 1, 1, 0, '', 0
    )
    database.close()

    const child = makeChild({ chunks: [Buffer.from(`${password}\n`)] })
    const calls: SpawnCall[] = []
    const logs: string[] = []
    const process = fakeSpawner(child.child, calls)
    const dependencies = {
      runtimeRoot: root,
      process,
      spawn() {
        throw new Error('unexpected browser process launch in SQLite fixture')
      },
      log(message: string) {
        logs.push(message)
      },
      sourceRoots: { chrome: chromeRoot }
    } as unknown as BrowserDependencies
    try {
      const source = await readCookieSource({ kind: 'browser', family: 'chrome' }, dataDir, dependencies)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.argv).toEqual(['/usr/bin/security', 'find-generic-password', '-w', '-s', 'Chrome Safe Storage'])
      expect(source.cookies.length).toBe(1)
      expect(logs.some((message) => message.includes(password) || message.includes(cookieValue))).toBe(false)
      expect(source.cookies[0]?.value === cookieValue).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
