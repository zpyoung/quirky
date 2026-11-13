import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { ProcessRunner, RunOptions, RunResult } from '@quirky/protocol'
import { createProcessRunner, type OwnedProcessRunner } from '../../../packages/process/src/api'
import { defaultPs, parsePsOutput, runningChildOf, type ProcessRow } from '../src/processes'

const TABLE = `    1     0 /sbin/launchd
  100     1 /usr/bin/login
  101   100 -zsh
  250   101 /bin/sleep
  251   101 /usr/bin/vim
  300     1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
  301   300 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper
`
const PS_ARGV = ['ps', '-A', '-o', 'pid=,ppid=,comm=']
const PROCESS_TABLE = '250 101 /bin/sleep\n251 101 /usr/bin/vim\n'

function runResult(stdoutText: string, overrides: Partial<RunResult> = {}): RunResult {
  return {
    stdout: new TextEncoder().encode(stdoutText),
    stdoutText,
    stderr: '',
    exitCode: 0,
    signal: null,
    durationMs: 0,
    ...overrides
  }
}

function standIn(read: () => Promise<RunResult>) {
  const calls: { argv: string[]; options?: RunOptions }[] = []
  const runner: ProcessRunner = {
    run: async (argv, options) => {
      calls.push({ argv: [...argv], ...(options === undefined ? {} : { options }) })
      return read()
    }
  }
  return { runner, calls }
}

const failures: { name: string; result?: RunResult; reject?: Error }[] = [
  { name: 'nonzero exit', result: runResult('250 101 /bin/sleep\n', { exitCode: 1 }) },
  { name: 'signal termination', result: runResult('250 101 /bin/sleep\n', { exitCode: null, signal: 'SIGTERM' }) },
  { name: 'signal reported with exit code', result: runResult('250 101 /bin/sleep\n', { signal: 'SIGTERM' }) },
  {
    name: 'spawn failure',
    result: runResult('250 101 /bin/sleep\n', { exitCode: null, spawnError: { code: 'ENOENT', message: 'no ps' } })
  },
  { name: 'spawn failure reported with exit code', result: runResult('250 101 /bin/sleep\n', { spawnError: { code: 'ENOENT', message: 'no ps' } }) },
  { name: 'timeout', result: runResult('250 101 /bin/sleep\n', { exitCode: null, signal: 'SIGTERM', stopped: 'timeout' }) },
  { name: 'timeout reported with exit code', result: runResult('250 101 /bin/sleep\n', { stopped: 'timeout' }) },
  { name: 'abort', result: runResult('250 101 /bin/sleep\n', { exitCode: null, signal: 'SIGTERM', stopped: 'aborted' }) },
  { name: 'overflow', result: runResult('250 101 /bin/sleep\n', { exitCode: null, signal: 'SIGTERM', stopped: 'overflow' }) },
  { name: 'runner rejection', reject: new Error('runner failed') }
]

let syncSpawn: { mockRestore(): void } | undefined
const started: Bun.Subprocess[] = []
const ownedRunners: OwnedProcessRunner[] = []
let nextOwner = 0

beforeEach(() => {
  syncSpawn = spyOn(Bun, 'spawnSync').mockImplementation(() => {
    throw new Error('sync process entrypoint forbidden')
  })
})

afterEach(async () => {
  syncSpawn?.mockRestore()
  for (const child of started.splice(0)) {
    child.kill('SIGKILL')
    await child.exited
  }
  await Promise.all(ownedRunners.splice(0).map((runner) => runner.dispose()))
})

function realRunner() {
  const owned = createProcessRunner({ owner: `terminal-process-test-${nextOwner++}` })
  ownedRunners.push(owned)
  const calls: { argv: string[]; options?: RunOptions }[] = []
  const runner: ProcessRunner = {
    run: (argv, options) => {
      calls.push({ argv: [...argv], ...(options === undefined ? {} : { options }) })
      return owned.run(argv, options)
    }
  }
  return { runner, calls }
}

describe('parsePsOutput', () => {
  test('reads pid, ppid and the command basename', () => {
    expect(parsePsOutput(TABLE).slice(0, 4)).toEqual([
      { pid: 1, ppid: 0, command: 'launchd' },
      { pid: 100, ppid: 1, command: 'login' },
      { pid: 101, ppid: 100, command: '-zsh' },
      { pid: 250, ppid: 101, command: 'sleep' }
    ])
  })

  test('keeps commands whose path contains spaces', () => {
    expect(parsePsOutput(TABLE).filter((r) => r.pid >= 300)).toEqual([
      { pid: 300, ppid: 1, command: 'Google Chrome' },
      { pid: 301, ppid: 300, command: 'Google Chrome Helper' }
    ])
  })

  test('skips blank and malformed lines', () => {
    expect(parsePsOutput('\n  12 3\nPID PPID COMM\nx y z\n  7 1 /bin/ok\n')).toEqual([{ pid: 7, ppid: 1, command: 'ok' }])
    expect(parsePsOutput('')).toEqual([])
  })
})

describe('defaultPs', () => {
  test('reads the process table with the shared runner', async () => {
    const process = standIn(async () => runResult(PROCESS_TABLE))

    await expect(Promise.resolve().then(() => defaultPs(process.runner))).resolves.toBe(PROCESS_TABLE)
    expect(process.calls).toEqual([{ argv: PS_ARGV, options: { rerunnable: true } }])
  })

  for (const failure of failures) {
    test(`rejects ${failure.name} without interpreting partial output`, async () => {
      const result = () => (failure.reject ? Promise.reject(failure.reject) : Promise.resolve(failure.result!))
      const direct = standIn(result)
      await expect(Promise.resolve().then(() => defaultPs(direct.runner))).rejects.toThrow()
      expect(direct.calls).toEqual([{ argv: PS_ARGV, options: { rerunnable: true } }])

      const lookup = standIn(result)
      expect(await runningChildOf(101, () => defaultPs(lookup.runner))).toBeNull()
      expect(lookup.calls).toEqual([{ argv: PS_ARGV, options: { rerunnable: true } }])
    })
  }
})


describe('runningChildOf', () => {
  test('awaits the process table and returns the first direct child basename', async () => {
    const process = standIn(async () => runResult(PROCESS_TABLE))

    expect(await runningChildOf(101, () => defaultPs(process.runner))).toEqual({ command: 'sleep' })
    expect(process.calls).toEqual([{ argv: PS_ARGV, options: { rerunnable: true } }])
  })

  test('a process with no children, or an unknown one, has none', async () => {
    const process = standIn(async () => runResult(PROCESS_TABLE))

    expect(await runningChildOf(250, () => defaultPs(process.runner))).toBeNull()
    expect(await runningChildOf(300000, () => defaultPs(process.runner))).toBeNull()
    expect(process.calls).toEqual([
      { argv: PS_ARGV, options: { rerunnable: true } },
      { argv: PS_ARGV, options: { rerunnable: true } }
    ])
  })

  test('does not count grandchildren', async () => {
    const process = standIn(async () => runResult('1 0 /sbin/launchd\n2 1 /bin/zsh\n3 2 /bin/sleep\n'))

    expect(await runningChildOf(1, () => defaultPs(process.runner))).toEqual({ command: 'zsh' })
    expect(await runningChildOf(250, () => defaultPs(process.runner))).toBeNull()
    expect(process.calls).toEqual([
      { argv: PS_ARGV, options: { rerunnable: true } },
      { argv: PS_ARGV, options: { rerunnable: true } }
    ])
  })

  test('a rejected async table supplier gives null', async () => {
    await expect(runningChildOf(101, async () => Promise.reject(new Error('no ps')))).resolves.toBeNull()
  })

  test('a real ps call sees the sleep this test started as its child', async () => {
    const sleeper = Bun.spawn(['sleep', '30'], { stdio: ['ignore', 'ignore', 'ignore'] })
    started.push(sleeper)
    const runner = realRunner()
    let row: ProcessRow | undefined
    for (let i = 0; i < 40 && row?.command !== 'sleep'; i++) {
      row = parsePsOutput(await defaultPs(runner.runner)).find((r) => r.pid === sleeper.pid)
      if (row?.command !== 'sleep') await Bun.sleep(25)
    }
    expect(row).toEqual({ pid: sleeper.pid, ppid: process.pid, command: 'sleep' })
    expect(await runningChildOf(process.pid, () => defaultPs(runner.runner))).not.toBeNull()
    expect(runner.calls.length).toBeGreaterThan(0)
    expect(runner.calls.every((call) => call.argv.join(' ') === PS_ARGV.join(' ') && call.options?.rerunnable === true)).toBe(true)
  })

  test('a real ps call names the child of a shell', async () => {
    const shell = Bun.spawn(['/bin/sh', '-c', 'sleep 30 & wait'], { stdio: ['ignore', 'ignore', 'ignore'] })
    started.push(shell)
    const runner = realRunner()
    let found: { command: string } | null = null
    for (let i = 0; i < 40 && !found; i++) {
      found = await runningChildOf(shell.pid, () => defaultPs(runner.runner))
      if (!found) await Bun.sleep(25)
    }
    expect(found).toEqual({ command: 'sleep' })
    shell.kill('SIGKILL')
    await shell.exited
    expect(await runningChildOf(shell.pid, () => defaultPs(runner.runner))).toBeNull()
    expect(runner.calls.length).toBeGreaterThan(0)
    expect(runner.calls.every((call) => call.argv.join(' ') === PS_ARGV.join(' ') && call.options?.rerunnable === true)).toBe(true)
  })
})
