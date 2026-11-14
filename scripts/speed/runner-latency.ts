import { open, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import type { RunnerLatency, RunnerSetting, TimerInterval, TimerWindow } from './contracts'
import { validateRunnerLatency } from './report'

const COMMAND_TIMEOUT_MS = 5000
const MAX_TEXT = 512
const MAX_SETTINGS_BYTES = 64 * 1024
const MAX_INTERVALS = 8192
const INTERVAL_MS = 16

type CommandResult = { exitCode: number | null; stdout?: string; stderr?: string; timedOut?: boolean }
type Executor = (command: string, args: readonly string[], timeoutMs: number) => Promise<CommandResult>
type Identity = { runId: string | null; runner: string }
type TimerClock<Handle> = { now(): number; setTimeout(callback: () => void, delayMs: number): Handle; clearTimeout(handle: Handle): void }
export type EpochWindow = { startEpochMs: number; endEpochMs: number }

const boundedText = (text: string): string => text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_TEXT)

/** Attempts independent CI-only settings experiments without treating unsupported settings as measurement failures. */
export async function configureRunnerLatency(options: Identity & {
  env: Record<string, string | undefined>; platform: string; execute: Executor
}): Promise<RunnerLatency> {
  const evidence: RunnerLatency = {
    version: 1, runId: options.runId, runner: options.runner,
    status: 'skipped', reason: 'not-github-macos', coalescing: null, appNap: null, timerCoalesceBgNsMax: null
  }
  if (options.env.GITHUB_ACTIONS !== 'true' || options.env.RUNNER_OS !== 'macOS' || options.platform !== 'darwin') return evidence
  evidence.status = 'attempted'
  evidence.reason = null
  const command = async (name: string, args: string[], errors: string[]): Promise<CommandResult | null> => {
    try {
      const result = await options.execute(name, args, COMMAND_TIMEOUT_MS)
      if (result.exitCode !== 0 || result.timedOut) {
        errors.push(boundedText(`${name}: ${result.timedOut ? 'timeout' : `exit ${result.exitCode}`}: ${result.stderr || result.stdout || 'no details'}`))
        return null
      }
      return result
    } catch (error) {
      errors.push(boundedText(`${name}: ${error instanceof Error ? error.message : String(error)}`))
      return null
    }
  }
  const readNumber = async (name: string, args: string[], errors: string[]): Promise<number | null> => {
    const result = await command(name, args, errors)
    if (!result) return null
    const text = (result.stdout ?? '').slice(0, MAX_TEXT).trim()
    const value = /^\d+$/.test(text) ? Number(text) : Number.NaN
    if (Number.isSafeInteger(value) && value >= 0) return value
    errors.push(boundedText(`${name}: invalid numeric readback`))
    return null
  }
  const setting = async (requested: 0 | 1, reader: [string, string[]], writer: [string, string[]]): Promise<RunnerSetting> => {
    const errors: string[] = []
    const before = await readNumber(...reader, errors)
    const written = await command(...writer, errors)
    const after = await readNumber(...reader, errors)
    const status = !written ? 'set-failed' : after === null ? 'readback-unavailable' : after === requested ? 'applied' : 'not-applied'
    return { requested, before, after, status, errors: errors.slice(0, 8) }
  }
  evidence.coalescing = await setting(0,
    ['sysctl', ['-n', 'kern.timer.coalescing_enabled']],
    ['sudo', ['-n', 'sysctl', '-w', 'kern.timer.coalescing_enabled=0']])
  evidence.appNap = await setting(1,
    ['defaults', ['read', 'NSGlobalDomain', 'NSAppSleepDisabled']],
    ['defaults', ['write', 'NSGlobalDomain', 'NSAppSleepDisabled', '-bool', 'YES']])
  evidence.timerCoalesceBgNsMax = await readNumber('sysctl', ['-n', 'kern.timer_coalesce_bg_ns_max'], evidence.coalescing.errors)
  evidence.coalescing.errors = evidence.coalescing.errors.slice(0, 8)
  return evidence
}

async function boundedRead(path: string): Promise<string> {
  const file = await open(path, 'r')
  try {
    if ((await file.stat()).size > MAX_SETTINGS_BYTES) throw new Error('settings-file-too-large')
    const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_SETTINGS_BYTES) throw new Error('settings-file-too-large')
    return buffer.toString('utf8', 0, bytesRead)
  } finally {
    await file.close()
  }
}

/** Accepts only bounded, validated settings evidence from this runner invocation. */
export async function readRunnerLatency(path: string | undefined, identity: Identity, reader = boundedRead): Promise<RunnerLatency> {
  const unavailable = (reason: string): RunnerLatency => ({
    version: 1, ...identity, status: 'unavailable', reason, coalescing: null, appNap: null, timerCoalesceBgNsMax: null
  })
  if (!path) return unavailable('settings-file-missing')
  try {
    const text = await reader(path)
    if (Buffer.byteLength(text) > MAX_SETTINGS_BYTES) return unavailable('settings-file-too-large')
    const result = validateRunnerLatency(JSON.parse(text))
    if (!result || result.runId !== identity.runId || result.runner !== identity.runner || identity.runner !== 'macos-15') return unavailable('settings-file-invalid-or-stale')
    return result
  } catch {
    return unavailable('settings-file-unreadable')
  }
}

/** Selects complete timer intervals intersecting a sample, including wakes after the paint endpoint. */
export function timerWindow(intervals: readonly TimerInterval[], bounds: EpochWindow, pending?: { requestedEpochMs: number; dueEpochMs: number }): TimerWindow {
  const { startEpochMs: start, endEpochMs: end } = bounds
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start
    || pending && (!Number.isFinite(pending.requestedEpochMs) || !Number.isFinite(pending.dueEpochMs) || pending.dueEpochMs < pending.requestedEpochMs)
    || intervals.some(interval =>
      !Object.values(interval).every(Number.isFinite) || interval.requestedEpochMs > interval.dueEpochMs || interval.dueEpochMs > interval.wokeEpochMs
      || interval.lateMs < 0 || Math.abs(interval.wokeEpochMs - interval.dueEpochMs - interval.lateMs) > 0.001)) {
    return { status: 'unavailable', reason: 'invalid-timer-clock', intervals: [], pendingLateAtEndMs: null }
  }
  return {
    status: 'complete', reason: null,
    intervals: intervals.filter(interval => interval.requestedEpochMs < end && interval.wokeEpochMs >= start),
    pendingLateAtEndMs: pending && pending.requestedEpochMs < end ? Math.max(0, end - pending.dueEpochMs) : null
  }
}

/** Captures controller scheduling evidence without catch-up work or waits at the measured endpoint. */
export function createTimerProbe<Handle = NodeJS.Timeout>(clock: TimerClock<Handle> = {
  now: () => performance.timeOrigin + performance.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay) as Handle,
  clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout)
}) {
  const intervals: TimerInterval[] = []
  let handle: Handle | undefined
  let pending: { requestedEpochMs: number; dueEpochMs: number } | undefined
  let active = false
  let overflow = false
  const schedule = () => {
    const requestedEpochMs = clock.now()
    pending = { requestedEpochMs, dueEpochMs: requestedEpochMs + INTERVAL_MS }
    handle = clock.setTimeout(() => {
      if (!active || !pending) return
      const wokeEpochMs = clock.now()
      if (intervals.length === MAX_INTERVALS) overflow = true
      else intervals.push({ ...pending, wokeEpochMs, lateMs: wokeEpochMs - pending.dueEpochMs })
      schedule()
    }, INTERVAL_MS)
  }
  return {
    start() { if (active) return; active = true; schedule() },
    stop(bounds?: EpochWindow): TimerWindow {
      active = false
      if (handle !== undefined) clock.clearTimeout(handle)
      handle = undefined
      if (overflow) return { status: 'unavailable', reason: 'timer-buffer-overflow', intervals: [], pendingLateAtEndMs: null }
      return timerWindow(intervals, bounds ?? { startEpochMs: Number.NaN, endEpochMs: Number.NaN }, pending)
    }
  }
}

async function executeCommand(command: string, args: readonly string[], timeoutMs: number): Promise<CommandResult> {
  const child = Bun.spawn([command, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  let timedOut = false
  const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    let text = ''
    const decoder = new TextDecoder()
    const reader = stream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (text.length < MAX_TEXT) text += decoder.decode(value, { stream: true }).slice(0, MAX_TEXT - text.length)
      }
    } finally {
      reader.releaseLock()
    }
    return text
  }
  try {
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, collect(child.stdout), collect(child.stderr)])
    return { exitCode, stdout, stderr, timedOut }
  } finally {
    clearTimeout(timeout)
  }
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ options: { configure: { type: 'boolean' }, out: { type: 'string' } }, strict: true, allowPositionals: false })
    if (!values.configure || !values.out) throw new Error('usage: bun scripts/speed/runner-latency.ts --configure --out <path>')
    const evidence = await configureRunnerLatency({ env: process.env, platform: process.platform,
      runner: process.env.QUIRKY_SPEED_RUNNER || 'local', runId: process.env.GITHUB_RUN_ID || null, execute: executeCommand })
    await writeFile(values.out, `${JSON.stringify(evidence, null, 2)}\n`)
  } catch (error) {
    console.error(boundedText(error instanceof Error ? error.message : String(error)))
    process.exitCode = 2
  }
}
