import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { daemonEntryHash, ensureDaemon, ensureHome, openPrivateLog, readRuntime, signalDaemon, waitForDaemonExit } from '../src/node'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qp-node-'))
  dirs.push(dir)
  return dir
}

const modeOf = (path: string) => statSync(path).mode & 0o777

describe('ensureHome', () => {
  test('creates the home private', () => {
    const home = join(tempDir(), 'home')
    ensureHome(home)
    expect(modeOf(home)).toBe(0o700)
  })

  test('tightens an existing home with loose permissions', () => {
    const home = tempDir()
    chmodSync(home, 0o755)
    ensureHome(home)
    expect(modeOf(home)).toBe(0o700)
  })

  test.skipIf(process.getuid?.() === 0)('refuses a home owned by someone else', () => {
    expect(() => ensureHome('/usr')).toThrow(/not owned by the current user/)
  })
})

describe('openPrivateLog', () => {
  test('creates the log 0600 inside a 0700 logs directory', () => {
    const path = join(tempDir(), 'logs', 'daemon.log')
    closeSync(openPrivateLog(path))
    expect(modeOf(path)).toBe(0o600)
    expect(modeOf(join(path, '..'))).toBe(0o700)
  })

  test('tightens a log that already exists', () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'logs'), { mode: 0o755 })
    const path = join(dir, 'logs', 'daemon.log')
    writeFileSync(path, 'old\n', { mode: 0o644 })
    chmodSync(path, 0o644)
    closeSync(openPrivateLog(path))
    expect(modeOf(path)).toBe(0o600)
    expect(modeOf(join(dir, 'logs'))).toBe(0o700)
  })
})

describe('ensureDaemon', () => {
  test('keeps the daemon log private even when it already exists loosely', async () => {
    const home = tempDir()
    chmodSync(home, 0o755)
    mkdirSync(join(home, 'logs'))
    const log = join(home, 'logs', 'daemon.log')
    writeFileSync(log, '', { mode: 0o644 })
    chmodSync(log, 0o644)
    const entry = join(home, 'noop.ts')
    writeFileSync(entry, 'process.exit(0)\n')
    await expect(ensureDaemon({ home, daemonEntry: entry, timeoutMs: 300 })).rejects.toThrow()
    expect(modeOf(home)).toBe(0o700)
    expect(modeOf(log)).toBe(0o600)
  })

  test('does not hand the daemon the markers of the agent session that started it', async () => {
    const home = tempDir()
    const marker = join(home, 'env.json')
    const entry = join(home, 'record-env.ts')
    writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.env))\n`)
    const saved = { CLAUDECODE: process.env.CLAUDECODE, CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID }
    process.env.CLAUDECODE = '1'
    process.env.CLAUDE_CODE_SESSION_ID = 'abc'
    try {
      await expect(ensureDaemon({ home, daemonEntry: entry, timeoutMs: 300 })).rejects.toThrow()
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    const env = JSON.parse(readFileSync(marker, 'utf8'))
    expect(env.CLAUDECODE).toBeUndefined()
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined()
    expect(env.QUIRKY_HOME).toBe(home)
  })

  test('starts the daemon in the home, not the caller directory', async () => {
    const home = tempDir()
    const marker = join(home, 'cwd.txt')
    const entry = join(home, 'record-cwd.ts')
    writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.cwd())\n`)
    await expect(ensureDaemon({ home, daemonEntry: entry, timeoutMs: 300 })).rejects.toThrow()
    expect(existsSync(marker)).toBe(true)
    expect(realpathSync(readFileSync(marker, 'utf8'))).toBe(realpathSync(home))
  })
})

describe('replacing a daemon from another build', () => {
  /** A stand-in daemon with a selectable SIGTERM behavior. */
  function fakeDaemonEntry(
    home: string,
    name: string,
    reports: 'own-hash' | 'other-build' | 'no-hash',
    signalMode: 'exit' | 'quiet' | 'ignore' = 'exit'
  ): string {
    const entry = join(home, name)
    const hash =
      reports === 'own-hash'
        ? `, entryHash: require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(__filename)).digest('hex').slice(0, 16)`
        : reports === 'other-build' ? `, entryHash: 'other-build'` : ''
    const onSigterm =
      signalMode === 'exit'
        ? `process.on('SIGTERM', () => process.exit(0))`
        : signalMode === 'quiet'
          ? `process.on('SIGTERM', () => server.stop(true))`
          : `process.on('SIGTERM', () => {})`
    writeFileSync(
      entry,
      `const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ pid: process.pid }) })
require('node:fs').writeFileSync(${JSON.stringify(join(home, 'runtime.json'))}, JSON.stringify({ pid: process.pid, port: server.port, token: 't', hookToken: 'h', daemonVersion: '0', protocolVersion: 1, startedAt: Date.now()${hash} }))
${onSigterm}
setInterval(() => {}, 1000)
`
    )
    return entry
  }
  const started: number[] = []
  afterEach(() => {
    for (const pid of started.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  })
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  test('the entry hash follows the file content', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'a.js'), 'one')
    writeFileSync(join(dir, 'b.js'), 'one')
    writeFileSync(join(dir, 'c.js'), 'two')
    expect(daemonEntryHash(join(dir, 'a.js'))).toBe(daemonEntryHash(join(dir, 'b.js')))
    expect(daemonEntryHash(join(dir, 'a.js'))).not.toBe(daemonEntryHash(join(dir, 'c.js')))
  })

  describe('an entry in a source checkout', () => {
    const ENTRY = join('packages', 'daemon', 'src', 'main.ts')
    const put = (root: string, path: string, content: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), content)
    }
    function sourceCheckout(): string {
      const root = realpathSync(tempDir())
      put(root, ENTRY, 'entry')
      put(root, 'bun.lock', 'lock')
      put(root, 'packages/daemon/src/core.ts', 'core')
      put(root, 'packages/protocol/src/rpc.ts', 'rpc')
      put(root, 'packages/git/src/status.ts', 'status')
      put(root, 'plugins/quirky.git/main.ts', 'plugin')
      return root
    }

    for (const path of [
      'packages/daemon/src/core.ts',
      'packages/protocol/src/rpc.ts',
      'packages/git/src/status.ts',
      'plugins/quirky.git/main.ts',
      'bun.lock'
    ]) {
      test(`the hash changes when ${path} changes`, () => {
        const root = sourceCheckout()
        const before = daemonEntryHash(join(root, ENTRY))
        put(root, path, 'edited')
        expect(daemonEntryHash(join(root, ENTRY))).not.toBe(before)
      })
    }

    test('the hash changes when a source file is added', () => {
      const root = sourceCheckout()
      const before = daemonEntryHash(join(root, ENTRY))
      put(root, 'packages/daemon/src/added.ts', 'added')
      expect(daemonEntryHash(join(root, ENTRY))).not.toBe(before)
    })

    for (const path of [
      'packages/daemon/test/core.test.ts',
      'packages/ui/src/app.tsx',
      'packages/cli/src/main.ts',
      'packages/pty-host/src/main.ts',
      'plugins/quirky.git/dist/ui.js',
      'plugins/quirky.git/test/main.test.ts',
      'plugins/quirky.git/node_modules/dep/index.js',
      'plugins/quirky.mobile/assets/mobile/index.html'
    ]) {
      test(`the hash ignores ${path}`, () => {
        const root = sourceCheckout()
        const before = daemonEntryHash(join(root, ENTRY))
        put(root, path, 'edited')
        expect(daemonEntryHash(join(root, ENTRY))).toBe(before)
      })
    }

    // a daemon serves the UI and plugins of the checkout it started from
    test('two checkouts with the same sources hash differently', () => {
      expect(daemonEntryHash(join(sourceCheckout(), ENTRY))).not.toBe(daemonEntryHash(join(sourceCheckout(), ENTRY)))
    })

    test('a symlinked path hashes the same as the real one', () => {
      const root = sourceCheckout()
      const link = join(tempDir(), 'link')
      symlinkSync(root, link)
      expect(daemonEntryHash(join(link, ENTRY))).toBe(daemonEntryHash(join(root, ENTRY)))
    })

    /** A stand-in daemon that reports the real hash of its own entry, as `packages/daemon/src/main.ts` does. */
    function fakeSourceDaemon(root: string, home: string): string {
      const node = fileURLToPath(new URL('../src/node', import.meta.url))
      put(
        root,
        ENTRY,
        `import { daemonEntryHash } from ${JSON.stringify(node)}
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ pid: process.pid }) })
await Bun.write(${JSON.stringify(join(home, 'runtime.json'))}, JSON.stringify({ pid: process.pid, port: server.port, token: 't', hookToken: 'h', daemonVersion: '0', protocolVersion: 1, startedAt: Date.now(), entryHash: daemonEntryHash(process.argv[1]) }))
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1000)
`
      )
      return join(root, ENTRY)
    }

    test('a daemon is replaced after a source other than its entry changes', async () => {
      const root = sourceCheckout()
      const home = tempDir()
      const entry = fakeSourceDaemon(root, home)
      const old = await ensureDaemon({ home, daemonEntry: entry })
      started.push(old.pid)
      put(root, 'packages/daemon/src/core.ts', 'edited')
      const next = await ensureDaemon({ home, daemonEntry: entry, replaceStale: true })
      started.push(next.pid)
      expect(next.pid).not.toBe(old.pid)
      expect(alive(old.pid)).toBe(false)
    })

    test('a daemon is reused while its sources are unchanged', async () => {
      const root = sourceCheckout()
      const home = tempDir()
      const entry = fakeSourceDaemon(root, home)
      const first = await ensureDaemon({ home, daemonEntry: entry })
      started.push(first.pid)
      const again = await ensureDaemon({ home, daemonEntry: entry, replaceStale: true })
      expect(again.pid).toBe(first.pid)
    })
  })

  for (const reports of ['other-build', 'no-hash'] as const) {
    test(`a daemon reporting ${reports} is stopped and the current build started`, async () => {
      const home = tempDir()
      const old = await ensureDaemon({ home, daemonEntry: fakeDaemonEntry(home, 'old.js', reports) })
      started.push(old.pid)
      const next = await ensureDaemon({ home, daemonEntry: fakeDaemonEntry(home, 'current.js', 'own-hash'), replaceStale: true })
      started.push(next.pid)
      expect(next.pid).not.toBe(old.pid)
      expect(alive(old.pid)).toBe(false)
      expect(readRuntime(home)?.pid).toBe(next.pid)
    })
  }

  test('a daemon from the current build is reused', async () => {
    const home = tempDir()
    const entry = fakeDaemonEntry(home, 'current.js', 'own-hash')
    const first = await ensureDaemon({ home, daemonEntry: entry })
    started.push(first.pid)
    const again = await ensureDaemon({ home, daemonEntry: entry, replaceStale: true })
    expect(again.pid).toBe(first.pid)
  })

  test('without replaceStale a daemon from another build is left running', async () => {
    const home = tempDir()
    const old = await ensureDaemon({ home, daemonEntry: fakeDaemonEntry(home, 'old.js', 'other-build') })
    started.push(old.pid)
    const again = await ensureDaemon({ home, daemonEntry: fakeDaemonEntry(home, 'current.js', 'own-hash') })
    expect(again.pid).toBe(old.pid)
  })
  // These integration tests exercise real OS signals, which fake timers cannot advance.
  test('replaces a stale daemon that ignores SIGTERM within the configured stop timeout', async () => {
    const home = tempDir()
    const old = await ensureDaemon({
      home,
      daemonEntry: fakeDaemonEntry(home, 'old.js', 'other-build', 'ignore')
    })
    started.push(old.pid)

    const stopStartedAt = Date.now()
    const next = await ensureDaemon({
      home,
      daemonEntry: fakeDaemonEntry(home, 'current.js', 'own-hash'),
      replaceStale: true,
      stopTimeoutMs: 300,
      killWaitMs: 2000
    })
    started.push(next.pid)
    expect(Date.now() - stopStartedAt).toBeLessThan(5000)

    expect(next.pid).not.toBe(old.pid)
    expect(alive(old.pid)).toBe(false)
    expect(readRuntime(home)?.pid).toBe(next.pid)
  })

  test('kills a daemon whose health server closes but whose process stays alive', async () => {
    const home = tempDir()
    const old = await ensureDaemon({
      home,
      daemonEntry: fakeDaemonEntry(home, 'quiet.js', 'other-build', 'quiet')
    })
    started.push(old.pid)

    expect(signalDaemon(old.pid, 'SIGTERM')).toBe(true)
    expect(await waitForDaemonExit(old.pid, { timeoutMs: 300, killWaitMs: 2000 })).toBe('killed')
    expect(alive(old.pid)).toBe(false)
    expect(signalDaemon(old.pid, 'SIGTERM')).toBe(false)
  })

  test('does not send SIGKILL when a daemon exits on SIGTERM', async () => {
    const home = tempDir()
    const daemon = await ensureDaemon({
      home,
      daemonEntry: fakeDaemonEntry(home, 'normal.js', 'other-build')
    })
    started.push(daemon.pid)

    const nativeKill = process.kill.bind(process)
    const signals: unknown[] = []
    const kill = spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === daemon.pid) signals.push(signal)
      return nativeKill(pid, signal)
    })
    try {
      expect(signalDaemon(daemon.pid, 'SIGTERM')).toBe(true)
      expect(await waitForDaemonExit(daemon.pid, { timeoutMs: 300, killWaitMs: 200 })).toBe('exited')
    } finally {
      kill.mockRestore()
    }

    expect(signals).not.toContain('SIGKILL')
    expect(alive(daemon.pid)).toBe(false)
  })

  test('refuses to signal this process from either helper and while replacing a daemon', async () => {
    const home = tempDir()
    const entry = join(home, 'replacement.js')
    writeFileSync(entry, '')
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => Response.json({ pid: process.pid })
    })
    writeFileSync(
      join(home, 'runtime.json'),
      JSON.stringify({
        pid: process.pid,
        port: server.port,
        token: 't',
        hookToken: 'h',
        daemonVersion: '0',
        protocolVersion: 1,
        startedAt: Date.now(),
        entryHash: 'old-build'
      })
    )
    const kill = spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('process API should not be called')
    })
    try {
      expect(() => signalDaemon(process.pid, 'SIGTERM')).toThrow(
        `refusing to signal this process (pid ${process.pid})`
      )
      await expect(waitForDaemonExit(process.pid)).rejects.toThrow(
        `refusing to signal this process (pid ${process.pid})`
      )
      await expect(ensureDaemon({ home, daemonEntry: entry, replaceStale: true })).rejects.toThrow(
        `refusing to signal this process (pid ${process.pid})`
      )
      expect(kill).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
      server.stop(true)
    }
  })

  test('rejects invalid daemon pids before calling a process API', async () => {
    const pids: unknown[] = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '123']
    const calls: unknown[] = []
    const kill = spyOn(process, 'kill').mockImplementation((pid) => {
      calls.push(pid)
      throw new Error('process API reached')
    })
    try {
      for (const pid of pids) {
        expect(() => signalDaemon(pid as number, 'SIGTERM')).toThrow('invalid daemon pid')
        await expect(waitForDaemonExit(pid as number)).rejects.toThrow('invalid daemon pid')
      }
      expect(calls).toEqual([])
    } finally {
      kill.mockRestore()
    }
  })

  test('rejects a string pid read from runtime.json before signaling', async () => {
    const home = tempDir()
    const entry = join(home, 'replacement.js')
    writeFileSync(entry, '')
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => Response.json({ pid: '123' })
    })
    writeFileSync(
      join(home, 'runtime.json'),
      JSON.stringify({
        pid: '123',
        port: server.port,
        token: 't',
        hookToken: 'h',
        daemonVersion: '0',
        protocolVersion: 1,
        startedAt: Date.now(),
        entryHash: 'old-build'
      })
    )
    const calls: unknown[] = []
    const kill = spyOn(process, 'kill').mockImplementation((pid) => {
      calls.push(pid)
      throw new Error('process API reached')
    })
    try {
      await expect(ensureDaemon({ home, daemonEntry: entry, replaceStale: true })).rejects.toThrow(
        'invalid daemon pid'
      )
      expect(calls).toEqual([])
    } finally {
      kill.mockRestore()
      server.stop(true)
    }
  })

  test('rethrows signal errors other than ESRCH', () => {
    const pid = process.pid + 1
    const failure = Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    const calls: unknown[][] = []
    const kill = spyOn(process, 'kill').mockImplementation((receivedPid, signal) => {
      calls.push([receivedPid, signal])
      throw failure
    })
    try {
      let thrown: unknown
      try {
        signalDaemon(pid, 'SIGTERM')
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBe(failure)
      expect(calls).toEqual([[pid, 'SIGTERM']])
    } finally {
      kill.mockRestore()
    }
  })

  test('reports when SIGKILL is denied', async () => {
    const home = tempDir()
    const daemon = await ensureDaemon({
      home,
      daemonEntry: fakeDaemonEntry(home, 'unkillable.js', 'other-build', 'ignore')
    })
    started.push(daemon.pid)

    const nativeKill = process.kill.bind(process)
    const signals: unknown[] = []
    const kill = spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === daemon.pid) signals.push(signal)
      if (pid === daemon.pid && signal === 'SIGKILL') {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
      }
      return nativeKill(pid, signal)
    })
    try {
      await expect(waitForDaemonExit(daemon.pid, { timeoutMs: 0, killWaitMs: 100 })).rejects.toThrow(
        `quirkyd (pid ${daemon.pid}) did not stop within 0s and could not be killed`
      )
    } finally {
      kill.mockRestore()
    }

    expect(signals).toContain('SIGKILL')
    expect(alive(daemon.pid)).toBe(true)
  })
})
