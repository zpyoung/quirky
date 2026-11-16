import { afterEach, expect, jest, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { SpawnExit } from '@quirky/protocol'
import { startChrome } from '../src/runtime/chrome'
import { BrowserFault } from '../src/runtime/errors'
import type { BrowserChild, BrowserDependencies, BrowserProcess } from '../src/runtime/dependencies'

const timerControls = jest as unknown as {
  useFakeTimers(): void
  advanceTimersByTime(milliseconds: number): void
  useRealTimers(): void
}

afterEach(() => timerControls.useRealTimers())

type ProcessIdentity = {
  pid: number
  ppid: number
  pgid: number
  uid: number
  started: string
  executable: string
  argv: readonly string[]
}

type ProcessAccess = {
  snapshot(): Promise<readonly ProcessIdentity[]>
  inspect(pid: number): Promise<ProcessIdentity | null>
  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void
}

const PROFILE_IN_USE = 'browser_unavailable: the owned browser profile is in use; its process could not be safely reclaimed'

function chromeIdentity(userDataDir: string, overrides: Partial<ProcessIdentity> = {}): ProcessIdentity {
  return {
    pid: 41_101,
    ppid: 1,
    pgid: 41_101,
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    started: 'Mon Nov 16 12:34:56 2026',
    executable: realpathSync(process.execPath),
    argv: [
      process.execPath,
      '--headless=new',
      `--user-data-dir=${userDataDir}`,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-default-apps',
      'about:blank'
    ],
    ...overrides
  }
}

function fakeAccess(
  identities: readonly ProcessIdentity[],
  onSignal?: (identity: ProcessIdentity, signal: 'SIGTERM' | 'SIGKILL') => void,
  onInspect?: (identity: ProcessIdentity, count: number) => ProcessIdentity | null | undefined,
  onSnapshot?: () => Promise<readonly ProcessIdentity[]>
): { access: ProcessAccess; signals: Array<[number, 'SIGTERM' | 'SIGKILL']>; current: Map<number, ProcessIdentity> } {
  const current = new Map(identities.map((identity) => [identity.pid, identity]))
  const signals: Array<[number, 'SIGTERM' | 'SIGKILL']> = []
  const inspectCounts = new Map<number, number>()
  return {
    current,
    signals,
    access: {
      async snapshot() { return onSnapshot ? onSnapshot() : identities },
      async inspect(pid) {
        const identity = current.get(pid)
        if (!identity) return null
        const count = (inspectCounts.get(pid) ?? 0) + 1
        inspectCounts.set(pid, count)
        const inspected = onInspect?.(identity, count)
        return inspected === undefined ? identity : inspected
      },
      signal(pid, signal) {
        const identity = current.get(pid)
        if (!identity) throw new Error('unexpected signal to an absent process')
        signals.push([pid, signal])
        onSignal?.(identity, signal)
      }
    }
  }
}

function pendingChild(pid = 41_900): BrowserChild {
  return {
    pid,
    exited: new Promise<SpawnExit>(() => {}),
    async stop() {
      return { exitCode: null, signal: null, durationMs: 0 }
    }
  }
}

function processRunner(): BrowserProcess {
  return {
    async run() {
      return { stdout: new Uint8Array(), stdoutText: '', stderr: '', exitCode: 0, signal: null, durationMs: 0 }
    },
    spawn() {
      throw new Error('Chrome must be launched through the browser spawn dependency')
    }
  } as unknown as BrowserProcess
}

async function withProfile(
  run: (profileRoot: string) => Promise<void>,
  prefix = 'quirky-browser-reclaim-'
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const profilePath = join(root, 'profile')
  mkdirSync(profilePath, { mode: 0o755 })
  const profileRoot = join(realpathSync(dirname(root)), basename(root), 'profile')
  try {
    await run(profileRoot)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function markerPath(profileRoot: string): string {
  return join(profileRoot, 'chrome-profile', 'DevToolsActivePort')
}

function dependencies(
  profileRoot: string,
  access: ProcessAccess,
  spawn: (command: string[], userDataDir: string) => BrowserChild
): BrowserDependencies {
  return {
    runtimeRoot: profileRoot,
    process: processRunner(),
    chromePath: process.execPath,
    chromeProcesses: access,
    spawn(command) {
      const userDataArgument = command.find((argument) => argument.startsWith('--user-data-dir='))
      if (!userDataArgument) throw new Error('new Chrome launch omitted its private profile argument')
      return spawn(command, userDataArgument.slice('--user-data-dir='.length))
    }
  } as BrowserDependencies
}

function expectProfileRefusal(error: unknown): void {
  expect(error).toBeInstanceOf(BrowserFault)
  expect(error).toMatchObject({ reason: 'browser_unavailable', kind: 'conflict', message: PROFILE_IN_USE })
}

async function settleMicrotasks(): Promise<void> {
  for (let count = 0; count < 12; count += 1) await Promise.resolve()
}

async function advanceFakeTime(milliseconds: number): Promise<void> {
  let remaining = milliseconds
  while (remaining > 0) {
    const step = Math.min(25, remaining)
    timerControls.advanceTimersByTime(step)
    await settleMicrotasks()
    remaining -= step
  }
}

function mode(path: string): number {
  return statSync(path).mode & 0o777
}

test('reclaims only the exact orphan and returns the newly spawned endpoint', async () => {
  await withProfile(async (profileRoot) => {
    const userDataDir = join(profileRoot, 'chrome-profile')
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(markerPath(profileRoot), '9111\n/devtools/browser/old\n')
    const matching = chromeIdentity(userDataDir)
    const samePrefix = chromeIdentity(`${userDataDir}-other`, { pid: 41_102, pgid: 41_102 })
    const embedded = chromeIdentity(userDataDir, {
      pid: 41_103,
      pgid: 41_103,
      argv: [process.execPath, `--proxy-server=--user-data-dir=${userDataDir}`, '--headless=new']
    })
    const fake = fakeAccess([matching, samePrefix, embedded], (identity, signal) => {
      if (identity.pid === matching.pid && signal === 'SIGTERM') fake.current.delete(identity.pid)
    })
    let launched = 0
    const chrome = await startChrome(profileRoot, dependencies(profileRoot, fake.access, (_command, launchedDir) => {
      launched += 1
      expect(fake.current.has(matching.pid)).toBe(false)
      expect(existsSync(join(launchedDir, 'DevToolsActivePort'))).toBe(false)
      writeFileSync(join(launchedDir, 'DevToolsActivePort'), '9333\n/devtools/browser/fresh\n')
      return pendingChild()
    }))

    expect(fake.signals).toEqual([[matching.pid, 'SIGTERM']])
    expect(launched).toBe(1)
    expect(chrome.cdpUrl).toBe('http://127.0.0.1:9333')
    expect(chrome.browserWebSocketUrl).toBe('ws://127.0.0.1:9333/devtools/browser/fresh')
    expect(readFileSync(markerPath(profileRoot), 'utf8')).toBe('9333\n/devtools/browser/fresh\n')
  })
})

test('refuses every held or mismatched owner without clearing the marker or changing permissions', async () => {
  await withProfile(async (profileRoot) => {
    const userDataDir = join(profileRoot, 'chrome-profile')
    mkdirSync(userDataDir, { recursive: true })
    const cases: Array<{ name: string; update: (identity: ProcessIdentity) => ProcessIdentity }> = [
      { name: 'live parent', update: (identity) => ({ ...identity, ppid: 41_001 }) },
      { name: 'another UID', update: (identity) => ({ ...identity, uid: identity.uid + 1 }) },
      { name: 'PID zero', update: identity => ({ ...identity, pid: 0, pgid: 0 }) },
      { name: 'PID one', update: identity => ({ ...identity, pid: 1, pgid: 1 }) },
      { name: 'negative PID', update: identity => ({ ...identity, pid: -41, pgid: -41 }) },
      { name: 'different executable', update: (identity) => ({ ...identity, executable: '/not/configured/chrome' }) },
      {
        name: 'non-headless launch',
        update: (identity) => ({ ...identity, argv: identity.argv.filter((argument) => argument !== '--headless=new') })
      },
      {
        name: 'non-loopback debugging address',
        update: (identity) => ({
          ...identity,
          argv: identity.argv.map((argument) => argument === '--remote-debugging-address=127.0.0.1'
            ? '--remote-debugging-address=0.0.0.0'
            : argument)
        })
      },
      {
        name: 'duplicate user-data-dir with the target second',
        update: (identity) => ({
          ...identity,
          argv: [
            identity.argv[0]!,
            '--headless=new',
            '--user-data-dir=/unrelated/profile',
            `--user-data-dir=${userDataDir}`,
            '--remote-debugging-address=127.0.0.1',
            '--remote-debugging-port=0'
          ]
        })
      },
      {
        name: 'duplicate two-argument user-data-dir with the target second',
        update: (identity) => ({
          ...identity,
          argv: [
            identity.argv[0]!,
            '--headless=new',
            '--user-data-dir',
            '/unrelated/profile',
            '--user-data-dir',
            userDataDir,
            '--remote-debugging-address=127.0.0.1',
            '--remote-debugging-port=0'
          ]
        })
      },
      {
        name: 'duplicate headless ownership flag',
        update: (identity) => ({ ...identity, argv: [...identity.argv, '--headless=new'] })
      }
    ]

    for (const item of cases) {
      chmodSync(profileRoot, 0o750)
      chmodSync(userDataDir, 0o751)
      writeFileSync(markerPath(profileRoot), '9111\n/devtools/browser/old\n')
      const rootMode = mode(profileRoot)
      const dataMode = mode(userDataDir)
      const identity = item.update(chromeIdentity(userDataDir))
      const fake = fakeAccess([identity])
      let launched = 0
      const error = await startChrome(profileRoot, dependencies(profileRoot, fake.access, (_command, launchedDir) => {
        launched += 1
        writeFileSync(join(launchedDir, 'DevToolsActivePort'), '9333\n/devtools/browser/competitor\n')
        return pendingChild()
      })).then(() => undefined, (reason: unknown) => reason)

      expectProfileRefusal(error)
      expect(fake.signals).toEqual([])
      expect(launched).toBe(0)
      expect(readFileSync(markerPath(profileRoot), 'utf8')).toBe('9111\n/devtools/browser/old\n')
      expect(mode(profileRoot)).toBe(rootMode)
      expect(mode(userDataDir)).toBe(dataMode)
    }
  })
})

test('matches a two-argument profile path by canonical directory equality without flattening literal path characters', async () => {
  await withProfile(async (profileRoot) => {
    const userDataDir = join(profileRoot, 'chrome-profile')
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(markerPath(profileRoot), '9111\n/devtools/browser/old\n')
    const alias = `${profileRoot}//./chrome-profile`
    const matching = chromeIdentity(userDataDir, {
      argv: [
        process.execPath,
        '--headless=new',
        '--user-data-dir',
        alias,
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0'
      ]
    })
    const samePrefix = chromeIdentity(`${userDataDir}-other`, { pid: 41_102, pgid: 41_102 })
    const embedded = chromeIdentity(userDataDir, {
      pid: 41_103,
      pgid: 41_103,
      argv: [process.execPath, `--proxy-server=--user-data-dir=${userDataDir}`, '--headless=new']
    })
    const fake = fakeAccess([samePrefix, embedded, matching], (identity, signal) => {
      if (identity.pid === matching.pid && signal === 'SIGTERM') fake.current.delete(identity.pid)
    })
    let launched = 0
    const chrome = await startChrome(profileRoot, dependencies(profileRoot, fake.access, (_command, launchedDir) => {
      launched += 1
      writeFileSync(join(launchedDir, 'DevToolsActivePort'), '9333\n/devtools/browser/fresh\n')
      return pendingChild()
    }))

    expect(fake.signals).toEqual([[matching.pid, 'SIGTERM']])
    expect(launched).toBe(1)
    expect(chrome.browserWebSocketUrl).toBe('ws://127.0.0.1:9333/devtools/browser/fresh')
  }, "quirky browser '\"; $\\世界\n")
})

test('treats a holder that disappears before TERM as reclaimed', async () => {
  await withProfile(async (profileRoot) => {
    const userDataDir = join(profileRoot, 'chrome-profile')
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(markerPath(profileRoot), '9111\n/devtools/browser/old\n')
    const matching = chromeIdentity(userDataDir)
    const fake = fakeAccess([matching], undefined, (_identity, count) => count === 1 ? null : undefined)
    let launched = 0
    const chrome = await startChrome(profileRoot, dependencies(profileRoot, fake.access, (_command, launchedDir) => {
      launched += 1
      expect(existsSync(join(launchedDir, 'DevToolsActivePort'))).toBe(false)
      writeFileSync(join(launchedDir, 'DevToolsActivePort'), '9333\n/devtools/browser/fresh\n')
      return pendingChild()
    }))

    expect(fake.signals).toEqual([])
    expect(launched).toBe(1)
    expect(chrome.cdpUrl).toBe('http://127.0.0.1:9333')
  })
})

test('validates every matching holder before signalling any of them', async () => {
  await withProfile(async (profileRoot) => {
    const userDataDir = join(profileRoot, 'chrome-profile')
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(markerPath(profileRoot), '9111\n/devtools/browser/old\n')
    const valid = chromeIdentity(userDataDir)
    const held = chromeIdentity(userDataDir, { pid: 41_102, pgid: 41_102, ppid: 41_001 })
    const fake = fakeAccess([valid, held])
    let launched = 0
    const error = await startChrome(profileRoot, dependencies(profileRoot, fake.access, () => {
      launched += 1
      return pendingChild()
    })).then(() => undefined, (reason: unknown) => reason)

    expectProfileRefusal(error)
    expect(fake.signals).toEqual([])
    expect(fake.current.has(valid.pid)).toBe(true)
    expect(launched).toBe(0)
    expect(readFileSync(markerPath(profileRoot), 'utf8')).toBe('9111\n/devtools/browser/old\n')
  })
})

test('fails closed when process inspection is denied or malformed', async () => {
  await withProfile(async (profileRoot) => {
    const userDataDir = join(profileRoot, 'chrome-profile')
    mkdirSync(userDataDir, { recursive: true })
    const matching = chromeIdentity(userDataDir)
    const accesses: ProcessAccess[] = [
      fakeAccess([matching], undefined, undefined, async () => { throw new Error('inspection denied') }).access,
      fakeAccess([matching], undefined, () => { throw new Error('inspection denied') }).access,
      fakeAccess([], undefined, undefined, async () => [null as unknown as ProcessIdentity]).access
    ]

    for (const access of accesses) {
      writeFileSync(markerPath(profileRoot), '9111\n/devtools/browser/old\n')
      let launched = 0
      const error = await startChrome(profileRoot, dependencies(profileRoot, access, () => {
        launched += 1
        return pendingChild()
      })).then(() => undefined, (reason: unknown) => reason)

      expectProfileRefusal(error)
      expect(launched).toBe(0)
      expect(readFileSync(markerPath(profileRoot), 'utf8')).toBe('9111\n/devtools/browser/old\n')
    }
  })
})
test('escalates from TERM to KILL at five seconds and launches only after disappearance', async () => {
  await withProfile(async (profileRoot) => {
    const userDataDir = join(profileRoot, 'chrome-profile')
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(markerPath(profileRoot), '9111\n/devtools/browser/old\n')
    const matching = chromeIdentity(userDataDir)
    const startedAt = Date.now()
    const signalTimes: Array<[string, number]> = []
    const fake = fakeAccess([matching], (identity, signal) => {
      signalTimes.push([signal, Date.now() - startedAt])
      if (signal === 'SIGKILL') fake.current.delete(identity.pid)
    })
    let launched = 0
    timerControls.useFakeTimers()
    const operation = startChrome(profileRoot, dependencies(profileRoot, fake.access, (_command, launchedDir) => {
      launched += 1
      expect(existsSync(join(launchedDir, 'DevToolsActivePort'))).toBe(false)
      writeFileSync(join(launchedDir, 'DevToolsActivePort'), '9333\n/devtools/browser/fresh\n')
      return pendingChild()
    }))

    await settleMicrotasks()
    expect(fake.signals).toEqual([[matching.pid, 'SIGTERM']])
    await advanceFakeTime(4_999)
    expect(fake.signals).toEqual([[matching.pid, 'SIGTERM']])
    await advanceFakeTime(1)
    await advanceFakeTime(100)
    const chrome = await operation

    expect(signalTimes).toEqual([['SIGTERM', 0], ['SIGKILL', 5_000]])
    expect(fake.current.has(matching.pid)).toBe(false)
    expect(launched).toBe(1)
    expect(chrome.browserWebSocketUrl).toBe('ws://127.0.0.1:9333/devtools/browser/fresh')
  })
})

test('refuses PID reuse before TERM without touching the stale marker', async () => {
  await withProfile(async (profileRoot) => {
    const userDataDir = join(profileRoot, 'chrome-profile')
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(markerPath(profileRoot), '9111\n/devtools/browser/old\n')
    const matching = chromeIdentity(userDataDir)
    const fake = fakeAccess([matching], undefined, (identity, count) => (
      count === 1 ? { ...identity, started: 'a different process start' } : undefined
    ))
    let launched = 0
    const error = await startChrome(profileRoot, dependencies(profileRoot, fake.access, () => {
      launched += 1
      return pendingChild()
    })).then(() => undefined, (reason: unknown) => reason)

    expectProfileRefusal(error)
    expect(fake.signals).toEqual([])
    expect(launched).toBe(0)
    expect(readFileSync(markerPath(profileRoot), 'utf8')).toBe('9111\n/devtools/browser/old\n')
  })
})

test('refuses PID reuse at escalation instead of sending KILL to the replacement process', async () => {
  await withProfile(async (profileRoot) => {
    const userDataDir = join(profileRoot, 'chrome-profile')
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(markerPath(profileRoot), '9111\n/devtools/browser/old\n')
    const matching = chromeIdentity(userDataDir)
    let termAt: number | null = null
    const fake = fakeAccess([matching], (_identity, signal) => {
      if (signal === 'SIGTERM') termAt = Date.now()
    }, (identity) => (
      termAt !== null && Date.now() - termAt >= 5_000
        ? { ...identity, started: 'PID was reused before escalation' }
        : undefined
    ))
    let launched = 0
    timerControls.useFakeTimers()
    const outcome = startChrome(profileRoot, dependencies(profileRoot, fake.access, () => {
      launched += 1
      return pendingChild()
    })).then(() => undefined, (reason: unknown) => reason)

    await settleMicrotasks()
    expect(fake.signals).toEqual([[matching.pid, 'SIGTERM']])
    await advanceFakeTime(5_000)
    const error = await outcome

    expectProfileRefusal(error)
    expect(fake.signals).toEqual([[matching.pid, 'SIGTERM']])
    expect(launched).toBe(0)
    expect(readFileSync(markerPath(profileRoot), 'utf8')).toBe('9111\n/devtools/browser/old\n')
  })
})

test('refuses to launch when the verified root survives the final KILL wait', async () => {
  await withProfile(async (profileRoot) => {
    const userDataDir = join(profileRoot, 'chrome-profile')
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(markerPath(profileRoot), '9111\n/devtools/browser/old\n')
    const matching = chromeIdentity(userDataDir)
    const signalTimes: Array<[string, number]> = []
    const startedAt = Date.now()
    const fake = fakeAccess([matching], (_identity, signal) => {
      signalTimes.push([signal, Date.now() - startedAt])
    })
    let launched = 0
    timerControls.useFakeTimers()
    const outcome = startChrome(profileRoot, dependencies(profileRoot, fake.access, () => {
      launched += 1
      return pendingChild()
    })).then(() => undefined, (reason: unknown) => reason)

    await settleMicrotasks()
    await advanceFakeTime(5_999)
    expect(fake.signals).toEqual([[matching.pid, 'SIGTERM'], [matching.pid, 'SIGKILL']])
    await advanceFakeTime(1)
    const error = await outcome

    expectProfileRefusal(error)
    expect(signalTimes).toEqual([['SIGTERM', 0], ['SIGKILL', 5_000]])
    expect(launched).toBe(0)
    expect(readFileSync(markerPath(profileRoot), 'utf8')).toBe('9111\n/devtools/browser/old\n')
  })
})


test('rejects an escaping chrome-profile symlink before touching its marker or permissions', async () => {
  await withProfile(async (profileRoot) => {
    const home = dirname(profileRoot)
    const outside = join(home, 'outside')
    mkdirSync(outside, { mode: 0o750 })
    chmodSync(outside, 0o750)
    const outsideMarker = join(outside, 'DevToolsActivePort')
    writeFileSync(outsideMarker, '9111\n/devtools/browser/outside\n')
    symlinkSync(outside, join(profileRoot, 'chrome-profile'), 'dir')
    chmodSync(profileRoot, 0o750)
    const outsideMode = mode(outside)
    const rootMode = mode(profileRoot)
    const markerBytes = readFileSync(outsideMarker)
    expect(dirname(realpathSync(outside))).toBe(dirname(realpathSync(profileRoot)))

    const fake = fakeAccess([chromeIdentity(join(profileRoot, 'chrome-profile'))])
    let launched = 0
    const error = await startChrome(profileRoot, dependencies(profileRoot, fake.access, () => {
      launched += 1
      return pendingChild()
    })).then(() => undefined, (reason: unknown) => reason)

    expectProfileRefusal(error)
    expect(fake.signals).toEqual([])
    expect(launched).toBe(0)
    expect(readFileSync(outsideMarker)).toEqual(markerBytes)
    expect(mode(outside)).toBe(outsideMode)
    expect(mode(profileRoot)).toBe(rootMode)
  })
})

test('allows a contained chrome-profile symlink through normal ownership checks', async () => {
  await withProfile(async (profileRoot) => {
    const target = join(profileRoot, 'contained-profile')
    const userDataDir = join(profileRoot, 'chrome-profile')
    mkdirSync(target)
    symlinkSync(target, userDataDir, 'dir')
    writeFileSync(join(target, 'DevToolsActivePort'), '9111\n/devtools/browser/old\n')
    const matching = chromeIdentity(userDataDir)
    const fake = fakeAccess([matching], (identity, signal) => {
      if (signal === 'SIGTERM') fake.current.delete(identity.pid)
    })
    let launched = 0
    const chrome = await startChrome(profileRoot, dependencies(profileRoot, fake.access, (_command, launchedDir) => {
      launched += 1
      expect(existsSync(join(launchedDir, 'DevToolsActivePort'))).toBe(false)
      writeFileSync(join(launchedDir, 'DevToolsActivePort'), '9333\n/devtools/browser/fresh\n')
      return pendingChild()
    }))

    expect(fake.signals).toEqual([[matching.pid, 'SIGTERM']])
    expect(launched).toBe(1)
    expect(chrome.browserWebSocketUrl).toBe('ws://127.0.0.1:9333/devtools/browser/fresh')
  })
})
