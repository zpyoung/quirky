import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, test } from 'bun:test'
import type { ProcessSpawner, SpawnExit, SpawnOptions, SpawnedProcess, StopOptions } from '@quirky/protocol'
import { createProcessRunner, type OwnedProcessRunner } from '../../../packages/process/src/api'
import { startChrome } from '../src/runtime/chrome'
import { BrowserFault } from '../src/runtime/errors'
import { createBrowserSpawn, browserDependencies } from '../src/runtime/defaults'
import type { BrowserChild, BrowserDependencies, BrowserSpawnOptions } from '../src/runtime/dependencies'
import { startNativeHelper } from '../src/runtime/native'
import { stopOwned } from '../src/runtime/process'

const BROWSER_ROOT = resolve(import.meta.dir, '..')
let nextRunnerId = 0

function createRunner(): OwnedProcessRunner {
  return createProcessRunner({ owner: `quirky.browser.lifecycle-test-${++nextRunnerId}` })
}

async function withFixture(
  run: (root: string, runner: OwnedProcessRunner) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'quirky-browser-lifecycle-'))
  const runner = createRunner()
  try {
    await run(root, runner)
  } finally {
    await runner.dispose()
    rmSync(root, { recursive: true, force: true })
  }
}

function child(
  pid: number | null,
  exit: SpawnExit = { exitCode: 0, signal: null, durationMs: 1 },
  stops: StopOptions[] = []
): BrowserChild {
  return {
    pid,
    exited: Promise.resolve(exit),
    async stop(options) {
      stops.push(options ?? {})
      return exit
    }
  }
}

function expectUnavailable(error: unknown, detail: string): void {
  expect(error).toBeInstanceOf(BrowserFault)
  expect(error).toMatchObject({
    reason: 'browser_unavailable',
    message: `browser_unavailable: ${detail}`
  })
}

function expectProcessGone(pid: number): void {
  let error: unknown
  try { process.kill(pid, 0) } catch (reason) { error = reason }
  expect(error).toMatchObject({ code: 'ESRCH' })
}

type NativeTemporaryPaths = { socketDir: string; socketAliasRoot: string; helperHome: string }

function nativeTemporaryPaths(options: BrowserSpawnOptions): NativeTemporaryPaths {
  const socketAccessDir = options.env.AGENT_BROWSER_SOCKET_DIR!
  return {
    socketDir: realpathSync(socketAccessDir),
    socketAliasRoot: dirname(socketAccessDir),
    helperHome: options.env.HOME!
  }
}

test('createBrowserSpawn uses the shared runner with ignored streams and no timeout', () => {
  const quirkyHome = mkdtempSync(join(tmpdir(), 'quirky-browser-spawn-home-'))
  try {
    const calls: Array<{ command: readonly string[]; options: SpawnOptions }> = []
    const fakeChild = child(17)
    const processRunner: Pick<ProcessSpawner, 'spawn'> = {
      spawn(command, options) {
        calls.push({ command: [...command], options })
        return fakeChild as SpawnedProcess
      }
    }
    const spawn = createBrowserSpawn(processRunner)
    const env = { QUIRKY_HOME: quirkyHome }
    const options: BrowserSpawnOptions = {
      cwd: quirkyHome,
      env,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore'
    }

    expect(spawn(['/bin/sleep', '30'], options)).toBe(fakeChild)
    expect(calls).toEqual([{
      command: ['/bin/sleep', '30'],
      options: {
        cwd: options.cwd,
        env,
        timeoutMs: null,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore'
      }
    }])
  } finally {
    rmSync(quirkyHome, { recursive: true, force: true })
  }
})

test('Chrome uses a recording launcher and stops its owned sleep child', async () => {
  await withFixture(async (profileRoot, runner) => {
    const launched: string[][] = []
    const processSpawn = createBrowserSpawn(runner)
    const dependencies: BrowserDependencies = {
      ...browserDependencies(BROWSER_ROOT, runner),
      chromePath: process.execPath,
      spawn(command, options) {
        launched.push([...command])
        const userDataDir = command.find((arg) => arg.startsWith('--user-data-dir='))!.slice('--user-data-dir='.length)
        writeFileSync(join(userDataDir, 'DevToolsActivePort'), '9222\n/devtools/browser/launch-test\n')
        return processSpawn(['/bin/sleep', '30'], options)
      }
    }
    const chrome = await startChrome(profileRoot, dependencies)
    const pid = chrome.child.pid
    await chrome.asyncClose()

    expect(launched).toHaveLength(1)
    expect(launched[0]![0]).toBe(process.execPath)
    expect(launched[0]!.includes('--use-mock-keychain')).toBe(process.platform === 'darwin')
    expect((await chrome.child.exited).stopped).toBe('stop')
    if (typeof pid === 'number') expectProcessGone(pid)
  })
})

test('startChrome rejects a null pid immediately without stopping the inactive child', async () => {
  await withFixture(async (profileRoot, runner) => {
    const stops: StopOptions[] = []
    const inactive = child(null, {
      exitCode: null,
      signal: null,
      spawnError: { code: 'ENOENT', message: 'not found' },
      durationMs: 0
    }, stops)
    const dependencies: BrowserDependencies = {
      ...browserDependencies(BROWSER_ROOT, runner),
      chromePath: process.execPath,
      spawn: () => inactive
    }
    const error = await startChrome(profileRoot, dependencies).then(() => undefined, (reason: unknown) => reason)

    expectUnavailable(error, 'the configured Chrome executable could not be started')
    expect(stops).toEqual([])
  })
})

test('startChrome maps synchronous spawn failures without stopping a child', async () => {
  await withFixture(async (profileRoot, runner) => {
    const dependencies: BrowserDependencies = {
      ...browserDependencies(BROWSER_ROOT, runner),
      chromePath: process.execPath,
      spawn() {
        throw new Error('ENOENT')
      }
    }
    const error = await startChrome(profileRoot, dependencies).then(() => undefined, (reason: unknown) => reason)

    expectUnavailable(error, 'the configured Chrome executable could not be started')
  })
})

test('startNativeHelper rejects a null pid immediately and removes all temporary directories', async () => {
  await withFixture(async (profileRoot, runner) => {
    const stops: StopOptions[] = []
    const inactive = child(null, {
      exitCode: null,
      signal: null,
      spawnError: { code: 'ENOENT', message: 'not found' },
      durationMs: 0
    }, stops)
    let paths: NativeTemporaryPaths | undefined
    const dependencies: BrowserDependencies = {
      ...browserDependencies(BROWSER_ROOT, runner),
      spawn(command, options) {
        expect(command).toEqual([expect.any(String)])
        paths = nativeTemporaryPaths(options)
        return inactive
      }
    }
    const error = await startNativeHelper(profileRoot, 'ws://127.0.0.1/devtools/browser/test', dependencies)
      .then(() => undefined, (reason: unknown) => reason)

    expectUnavailable(error, 'the pinned native browser helper could not be started')
    expect(stops).toEqual([])
    expect(paths).toBeDefined()
    expect(existsSync(paths!.socketDir)).toBe(false)
    expect(existsSync(paths!.socketAliasRoot)).toBe(false)
    expect(existsSync(paths!.helperHome)).toBe(false)
  })
})

test('startNativeHelper cleans temporary directories after a synchronous spawn failure', async () => {
  await withFixture(async (profileRoot, runner) => {
    let paths: NativeTemporaryPaths | undefined
    const dependencies: BrowserDependencies = {
      ...browserDependencies(BROWSER_ROOT, runner),
      spawn(command, options) {
        expect(command).toEqual([expect.any(String)])
        paths = nativeTemporaryPaths(options)
        throw new Error('ENOENT')
      }
    }
    const error = await startNativeHelper(profileRoot, 'ws://127.0.0.1/devtools/browser/test', dependencies)
      .then(() => undefined, (reason: unknown) => reason)

    expectUnavailable(error, 'the pinned native browser helper could not be started')
    expect(paths).toBeDefined()
    expect(existsSync(paths!.socketDir)).toBe(false)
    expect(existsSync(paths!.socketAliasRoot)).toBe(false)
    expect(existsSync(paths!.helperHome)).toBe(false)
  })
})

test('stopOwned forwards the requested startup and shutdown grace periods', async () => {
  const stops: StopOptions[] = []
  const owned = child(17, { exitCode: 0, signal: null, durationMs: 1 }, stops)

  await stopOwned(owned, 500)
  await stopOwned(owned, 5_000)

  expect(stops).toEqual([{ graceMs: 500 }, { graceMs: 5_000 }])
})

test('stopOwned resolves after bounded cleanup reports a surviving process-group member', async () => {
  const exit: SpawnExit = { exitCode: 0, signal: null, groupSurvived: true, durationMs: 1 }
  const stops: StopOptions[] = []
  const settled = Promise.withResolvers<SpawnExit>()
  const owned: BrowserChild = {
    pid: 17,
    exited: settled.promise,
    async stop(options) {
      stops.push(options ?? {})
      return settled.promise
    }
  }
  const stopping = stopOwned(owned, 5_000)
  settled.resolve(exit)

  await stopping
  expect(stops).toEqual([{ graceMs: 5_000 }])
  expect(await owned.exited).toEqual(exit)
})

test('the shared runner owns and disposes real sleep fixtures', async () => {
  await withFixture(async (root, runner) => {
    const quirkyHome = join(root, 'quirky-home')
    mkdirSync(quirkyHome, { recursive: true })
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') env[key] = value
    }
    env.QUIRKY_HOME = quirkyHome
    const spawn = createBrowserSpawn(runner)
    const options: BrowserSpawnOptions = {
      cwd: root,
      env,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore'
    }

    const graceful = spawn(['/bin/sleep', '30'], options)
    const gracefulPid = graceful.pid
    await stopOwned(graceful, 5_000)
    expect((await graceful.exited).stopped).toBe('stop')
    if (typeof gracefulPid === 'number') {
      expectProcessGone(gracefulPid)
    }

    const forced = spawn(['/bin/sleep', '30'], options)
    const forcedExit = await forced.stop({ signal: 'SIGKILL' })
    expect(forcedExit.signal).toBe('SIGKILL')
    await runner.dispose()
    expect(runner.live()).toHaveLength(0)
  })
})
