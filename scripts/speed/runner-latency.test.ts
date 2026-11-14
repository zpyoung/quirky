import { describe, expect, test } from 'bun:test'
import { configureRunnerLatency, createTimerProbe, readRunnerLatency, timerWindow } from './runner-latency'
import type { RunnerLatency } from './contracts'

const CI_ENV = { GITHUB_ACTIONS: 'true', RUNNER_OS: 'macOS', GITHUB_RUN_ID: 'run-123' }
const RUNNER = 'macos-15'
const TIMEOUT_MS = 5000

type CommandResult = { exitCode: number | null; stdout?: string; stderr?: string; timedOut?: boolean }
type Execute = (command: string, args: readonly string[], timeoutMs: number) => Promise<CommandResult>
type CommandCall = { command: string; args: string[]; timeoutMs: number }

function successfulExecutor(calls: CommandCall[], options: {
  sysctlBefore?: string
  sysctlAfter?: string
  defaultsBefore?: string
  defaultsAfter?: string
} = {}): Execute {
  let sysctlReads = 0
  let defaultsReads = 0
  return async (command, args, timeoutMs) => {
    calls.push({ command, args: [...args], timeoutMs })
    const operation = [command, ...args].join(' ')
    if (operation === 'sysctl -n kern.timer.coalescing_enabled') {
      sysctlReads += 1
      return { exitCode: 0, stdout: `${sysctlReads === 1 ? options.sysctlBefore ?? '1' : options.sysctlAfter ?? '0'}\n` }
    }
    if (operation === 'sysctl -n kern.timer_coalesce_bg_ns_max') return { exitCode: 0, stdout: '100000000\n' }
    if (operation === 'sudo -n sysctl -w kern.timer.coalescing_enabled=0') return { exitCode: 0, stdout: '' }
    if (operation === 'defaults read NSGlobalDomain NSAppSleepDisabled') {
      defaultsReads += 1
      return { exitCode: 0, stdout: `${defaultsReads === 1 ? options.defaultsBefore ?? '0' : options.defaultsAfter ?? '1'}\n` }
    }
    if (operation === 'defaults write NSGlobalDomain NSAppSleepDisabled -bool YES') return { exitCode: 0, stdout: '' }
    throw new Error(`Unexpected command: ${operation}`)
  }
}

function configureOptions(execute: Execute, env: Record<string, string | undefined> = CI_ENV, platform = 'darwin') {
  return { env, platform, runner: RUNNER, runId: 'run-123', execute }
}

function makeClock(startEpochMs: number) {
  let current = startEpochMs
  let nextHandle = 0
  const scheduled = new Map<number, { callback: () => void; dueEpochMs: number; delayMs: number }>()
  const cleared: number[] = []
  return {
    now: () => current,
    setTimeout(callback: () => void, delayMs: number): number {
      const handle = ++nextHandle
      scheduled.set(handle, { callback, dueEpochMs: current + delayMs, delayMs })
      return handle
    },
    clearTimeout(handle: number): void {
      cleared.push(handle)
      scheduled.delete(handle)
    },
    setNow(epochMs: number): void {
      current = epochMs
    },
    fireAt(epochMs: number): void {
      const next = [...scheduled.entries()].sort((left, right) => left[1].dueEpochMs - right[1].dueEpochMs)[0]
      if (!next) throw new Error('No timeout is scheduled')
      scheduled.delete(next[0])
      current = epochMs
      next[1].callback()
    },
    pendingCount: () => scheduled.size,
    pendingDelays: () => [...scheduled.values()].map((timeout) => timeout.delayMs),
    cleared,
  }
}

const APPLIED_EVIDENCE: RunnerLatency = {
  version: 1,
  runId: 'run-123',
  runner: RUNNER,
  status: 'attempted',
  reason: null,
  coalescing: { requested: 0, before: 1, after: 0, status: 'applied', errors: [] },
  appNap: { requested: 1, before: 0, after: 1, status: 'applied', errors: [] },
  timerCoalesceBgNsMax: 100000000,
}

describe('runner latency settings experiment', () => {
  test('guards every setting command on both CI flags and Darwin', async () => {
    const rejectedEnvironments = [
      { env: { ...CI_ENV, GITHUB_ACTIONS: undefined }, platform: 'darwin' },
      { env: { ...CI_ENV, GITHUB_ACTIONS: 'false' }, platform: 'darwin' },
      { env: { ...CI_ENV, RUNNER_OS: undefined }, platform: 'darwin' },
      { env: { ...CI_ENV, RUNNER_OS: 'Linux' }, platform: 'darwin' },
      { env: CI_ENV, platform: 'linux' },
    ]
    for (const { env, platform } of rejectedEnvironments) {
      const calls: CommandCall[] = []
      const evidence = await configureRunnerLatency(configureOptions(successfulExecutor(calls), env, platform))
      expect(evidence).toMatchObject({ status: 'skipped', reason: 'not-github-macos' })
      expect(calls).toEqual([])
    }
  })

  test('reads each setting before and after its independent write and records successful values', async () => {
    const calls: CommandCall[] = []
    const evidence = await configureRunnerLatency(configureOptions(successfulExecutor(calls)))
    const commands = calls.map(({ command, args }) => [command, ...args].join(' '))
    const coalescingWrite = commands.indexOf('sudo -n sysctl -w kern.timer.coalescing_enabled=0')
    const appNapWrite = commands.indexOf('defaults write NSGlobalDomain NSAppSleepDisabled -bool YES')
    const coalescingReads = commands.flatMap((command, index) => command === 'sysctl -n kern.timer.coalescing_enabled' ? [index] : [])
    const appNapReads = commands.flatMap((command, index) => command === 'defaults read NSGlobalDomain NSAppSleepDisabled' ? [index] : [])

    expect(evidence).toMatchObject({
      status: 'attempted',
      reason: null,
      coalescing: { requested: 0, before: 1, after: 0, status: 'applied', errors: [] },
      appNap: { requested: 1, before: 0, after: 1, status: 'applied', errors: [] },
      timerCoalesceBgNsMax: 100000000,
    })
    expect(coalescingReads).toHaveLength(2)
    expect(coalescingReads[0]).toBeLessThan(coalescingWrite)
    expect(coalescingWrite).toBeLessThan(coalescingReads[1]!)
    expect(appNapReads).toHaveLength(2)
    expect(appNapReads[0]).toBeLessThan(appNapWrite)
    expect(appNapWrite).toBeLessThan(appNapReads[1]!)
    expect(calls.every((call) => call.timeoutMs === TIMEOUT_MS)).toBe(true)
    expect(calls.every((call) => !call.command.includes('sh'))).toBe(true)
  })

  test('keeps the App Nap experiment independent when the sysctl write fails', async () => {
    const calls: CommandCall[] = []
    const base = successfulExecutor(calls, { sysctlAfter: '1' })
    const execute: Execute = async (command, args, timeoutMs) => {
      const operation = [command, ...args].join(' ')
      if (operation === 'sudo -n sysctl -w kern.timer.coalescing_enabled=0') {
        calls.push({ command, args: [...args], timeoutMs })
        return { exitCode: 1, stderr: 'permission denied' }
      }
      return base(command, args, timeoutMs)
    }
    const evidence = await configureRunnerLatency(configureOptions(execute))

    expect(evidence).toMatchObject({
      status: 'attempted',
      coalescing: { requested: 0, before: 1, after: 1, status: 'set-failed' },
      appNap: { requested: 1, before: 0, after: 1, status: 'applied' },
    })
    expect(calls.some(({ command, args }) => [command, ...args].join(' ') === 'defaults write NSGlobalDomain NSAppSleepDisabled -bool YES')).toBe(true)
  })

  test('classifies read-back mismatches and unavailable read-backs without stopping the other setting', async () => {
    const cases: { name: string; options: Parameters<typeof successfulExecutor>[1]; failReadback?: boolean; expected: string; after: number | null }[] = [
      { name: 'a write that leaves the old value', options: { sysctlAfter: '1' }, expected: 'not-applied', after: 1 },
      { name: 'a read-back command failure', options: {}, failReadback: true, expected: 'readback-unavailable', after: null },
    ]
    for (const scenario of cases) {
      const calls: CommandCall[] = []
      const base = successfulExecutor(calls, scenario.options)
      let sysctlReads = 0
      const execute: Execute = async (command, args, timeoutMs) => {
        const operation = [command, ...args].join(' ')
        if (operation === 'sysctl -n kern.timer.coalescing_enabled') {
          sysctlReads += 1
          if (scenario.failReadback && sysctlReads === 2) {
            calls.push({ command, args: [...args], timeoutMs })
            return { exitCode: 1, stderr: 'read failed' }
          }
        }
        return base(command, args, timeoutMs)
      }
      const evidence = await configureRunnerLatency(configureOptions(execute))
      expect(evidence.coalescing).toMatchObject({ status: scenario.expected, after: scenario.after })
      expect(evidence.appNap).toMatchObject({ status: 'applied', after: 1 })
      expect(calls.some(({ command, args }) => [command, ...args].join(' ') === 'defaults write NSGlobalDomain NSAppSleepDisabled -bool YES')).toBe(true)
    }
  })

  test('records bounded timeout, spawn, and missing-key errors while experimental failures remain non-fatal', async () => {
    const calls: CommandCall[] = []
    const base = successfulExecutor(calls, { sysctlAfter: '1' })
    let defaultsReads = 0
    const execute: Execute = async (command, args, timeoutMs) => {
      const operation = [command, ...args].join(' ')
      if (operation === 'sudo -n sysctl -w kern.timer.coalescing_enabled=0') {
        calls.push({ command, args: [...args], timeoutMs })
        return { exitCode: null, stderr: 't'.repeat(1000), timedOut: true }
      }
      if (operation === 'defaults read NSGlobalDomain NSAppSleepDisabled') {
        defaultsReads += 1
        calls.push({ command, args: [...args], timeoutMs })
        if (defaultsReads === 1) return { exitCode: 1, stderr: 'The key NSAppSleepDisabled does not exist' }
        return { exitCode: 0, stdout: '1\n' }
      }
      if (operation === 'defaults write NSGlobalDomain NSAppSleepDisabled -bool YES') {
        calls.push({ command, args: [...args], timeoutMs })
        throw new Error('spawn defaults ENOENT')
      }
      return base(command, args, timeoutMs)
    }
    const evidence = await configureRunnerLatency(configureOptions(execute))
    const settingErrors = [...(evidence.coalescing?.errors ?? []), ...(evidence.appNap?.errors ?? [])]

    expect(evidence.status).toBe('attempted')
    expect(evidence.coalescing).toMatchObject({ status: 'set-failed', before: 1, after: 1 })
    expect(evidence.appNap).toMatchObject({ status: 'set-failed', before: null, after: 1 })
    expect(calls.some(({ command, args }) => [command, ...args].join(' ') === 'defaults write NSGlobalDomain NSAppSleepDisabled -bool YES')).toBe(true)
    expect(settingErrors.length).toBeGreaterThan(0)
    expect(settingErrors.every((error) => error.length <= 512)).toBe(true)
    expect(settingErrors.join(' ')).toContain('spawn defaults ENOENT')
    expect(evidence.coalescing!.errors.join(' ')).not.toContain('t'.repeat(513))
  })
})

describe('runner latency evidence ingestion', () => {
  test('accepts bounded evidence only for the expected run and runner identity', async () => {
    const reader = async (_path: string) => JSON.stringify(APPLIED_EVIDENCE)
    await expect(readRunnerLatency('/tmp/settings.json', { runId: 'run-123', runner: RUNNER }, reader)).resolves.toEqual(APPLIED_EVIDENCE)

    for (const expected of [
      { runId: 'stale-run', runner: RUNNER },
      { runId: 'run-123', runner: 'linux-runner' },
    ]) {
      const evidence = await readRunnerLatency('/tmp/settings.json', expected, reader)
      expect(evidence).toMatchObject({ status: 'unavailable' })
      expect(evidence.coalescing).toBeNull()
      expect(evidence.appNap).toBeNull()
    }
  })

  test('returns unavailable evidence for missing, malformed, and oversized settings files', async () => {
    const unreadable = await readRunnerLatency('/tmp/missing.json', { runId: 'run-123', runner: RUNNER }, async () => { throw new Error('ENOENT') })
    const malformed = await readRunnerLatency('/tmp/malformed.json', { runId: 'run-123', runner: RUNNER }, async () => '{')
    const oversized = await readRunnerLatency('/tmp/oversized.json', { runId: 'run-123', runner: RUNNER }, async () => ' '.repeat(64 * 1024 + 1))
    for (const evidence of [unreadable, malformed, oversized]) {
      expect(evidence).toMatchObject({ status: 'unavailable' })
      expect(evidence.coalescing).toBeNull()
      expect(evidence.appNap).toBeNull()
    }
  })
})

describe('controller timer probe', () => {
  test('captures 44 ms lateness for a 16 ms timeout waking at 100060', () => {
    const clock = makeClock(100000)
    const probe = createTimerProbe(clock)
    probe.start()
    clock.fireAt(100060)
    expect(clock.pendingDelays()).toEqual([16])
    const window = probe.stop({ startEpochMs: 100000, endEpochMs: 100060 })

    expect(window).toMatchObject({
      status: 'complete',
      reason: null,
      intervals: [{ requestedEpochMs: 100000, dueEpochMs: 100016, wokeEpochMs: 100060, lateMs: 44 }],
      pendingLateAtEndMs: null,
    })
    expect(clock.pendingCount()).toBe(0)
  })

  test('reports 34 ms of pending lateness at 100050 and cancels the unwoken timeout', () => {
    const clock = makeClock(100000)
    const probe = createTimerProbe(clock)
    probe.start()
    clock.setNow(100050)
    const window = probe.stop({ startEpochMs: 100000, endEpochMs: 100050 })

    expect(window).toMatchObject({ status: 'complete', intervals: [], pendingLateAtEndMs: 34 })
    expect(clock.pendingCount()).toBe(0)
    expect(clock.cleared).toHaveLength(1)
  })

  test('records zero lateness for an on-time wake and stops the self-rescheduling chain', () => {
    const clock = makeClock(100000)
    const probe = createTimerProbe(clock)
    probe.start()
    clock.fireAt(100016)
    const window = probe.stop({ startEpochMs: 100000, endEpochMs: 100016 })

    expect(window.intervals).toEqual([{ requestedEpochMs: 100000, dueEpochMs: 100016, wokeEpochMs: 100016, lateMs: 0 }])
    expect(window.pendingLateAtEndMs).toBeNull()
    expect(clock.pendingCount()).toBe(0)
    expect(clock.cleared).toHaveLength(1)
  })
})

test('joins overlapping sleeps even when they wake after paint, without attributing drain waits', () => {
  const intervals = [{ requestedEpochMs: 100008, dueEpochMs: 100024, wokeEpochMs: 100060, lateMs: 36 }]
  expect(timerWindow(intervals, { startEpochMs: 100010, endEpochMs: 100050 })).toEqual({
    status: 'complete', reason: null, intervals, pendingLateAtEndMs: null
  })
  expect(timerWindow(intervals, { startEpochMs: 100061, endEpochMs: 100070 })).toEqual({
    status: 'complete', reason: null, intervals: [], pendingLateAtEndMs: null
  })
})

test('rejects inconsistent timer clocks rather than clamping them into evidence', () => {
  for (const interval of [
    { requestedEpochMs: 100008, dueEpochMs: 100024, wokeEpochMs: 100020, lateMs: -4 },
    { requestedEpochMs: 100008, dueEpochMs: 100024, wokeEpochMs: 100060, lateMs: 35 },
    { requestedEpochMs: Number.NaN, dueEpochMs: 100024, wokeEpochMs: 100060, lateMs: 36 }
  ]) {
    expect(timerWindow([interval], { startEpochMs: 100010, endEpochMs: 100050 })).toMatchObject({
      status: 'unavailable', intervals: [], pendingLateAtEndMs: null
    })
  }
})

test('marks an invalid pending timer clock unavailable even before a wake', () => {
  const clock = makeClock(Number.NaN)
  const probe = createTimerProbe(clock)
  probe.start()
  expect(probe.stop({ startEpochMs: 100000, endEpochMs: 100050 })).toMatchObject({
    status: 'unavailable', reason: 'invalid-timer-clock', intervals: [], pendingLateAtEndMs: null
  })
  expect(clock.pendingCount()).toBe(0)
})
