import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProcessRunner, ProcessStalledError, type OwnedProcessRunner } from '../src/api'
import { startChild, type StartedChild, type StartChild } from '../src/child'

const runners: OwnedProcessRunner[] = []
const descendantPids = new Set<number>()
let homeDir = ''
let previousQuirkyHome: string | undefined
let nextOwner = 0

beforeEach(() => {
  previousQuirkyHome = process.env.QUIRKY_HOME
  homeDir = mkdtempSync(join(tmpdir(), 'quirky-spawn-group-'))
  process.env.QUIRKY_HOME = homeDir
})

afterEach(async () => {
  await Promise.all(runners.splice(0).map(value => value.dispose()))
  for (const pid of descendantPids) {
    try { process.kill(pid, 'SIGKILL') } catch {}
  }
  descendantPids.clear()
  if (previousQuirkyHome === undefined) delete process.env.QUIRKY_HOME
  else process.env.QUIRKY_HOME = previousQuirkyHome
  rmSync(homeDir, { recursive: true, force: true })
})

function runner(extra: { start?: StartChild; stallMs?: number } = {}) {
  const value = createProcessRunner({ owner: `spawn-group-${nextOwner++}`, ...extra })
  runners.push(value)
  return value
}


function closedStream() {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.close() } })
}

type GroupDouble = StartedChild & {
  finish(exitCode?: number | null, signal?: string | null): void
  signals: Array<{ signal: 'SIGTERM' | 'SIGKILL'; at: number }>
}

function groupDouble(options: {
  pid?: number
  stdout?: ReadableStream<Uint8Array>
  stderr?: ReadableStream<Uint8Array>
  groupAlive?: () => boolean
  onSignal?: (signal: 'SIGTERM' | 'SIGKILL', finish: (exitCode?: number | null, signal?: string | null) => void) => void
} = {}): GroupDouble {
  const exit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>()
  const signals: GroupDouble['signals'] = []
  const child: GroupDouble = {
    pid: options.pid ?? 900_000,
    stdout: options.stdout ?? closedStream(),
    stderr: options.stderr ?? closedStream(),
    exited: exit.promise,
    signals,
    finish(exitCode = 0, signal = null) { exit.resolve({ exitCode, signal }) },
    killGroup(signal) {
      signals.push({ signal, at: Date.now() })
      options.onSignal?.(signal, child.finish)
    },
    ...(options.groupAlive ? { groupAlive: options.groupAlive } : {}),
  }
  return child
}

function trackPid(pid: number): number {
  if (Number.isInteger(pid) && pid > 1) descendantPids.add(pid)
  return pid
}

function trackPidFile(path: string): number | undefined {
  try {
    return trackPid(Number(readFileSync(path, 'utf8').trim()))
  } catch {
    return undefined
  }
}

async function expectPidGone(pid: number, waitMs = 2_000): Promise<void> {
  const deadline = Date.now() + waitMs
  while (Date.now() <= deadline) {
    try { process.kill(pid, 0) } catch {
      descendantPids.delete(pid)
      return
    }
    await Bun.sleep(20)
  }
  throw new Error(`process ${pid} remained alive after ${waitMs}ms`)
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  reader.releaseLock()
  return new TextDecoder().decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))))
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 32; index++) await Promise.resolve()
}

type ControlledTimer = { id: number; at: number; run(): void }

type ControlledClock = {
  advance(milliseconds: number): Promise<void>
  restore(): void
}

let activeClock: ControlledClock | undefined

function controlledClock(): ControlledClock {
  const realNow = Date.now
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  let now = 0
  let nextId = 0
  let restored = false
  const timers = new Map<number, ControlledTimer>()
  const handles = new Set<number>()

  Date.now = () => now
  globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
    if (typeof callback !== 'function') throw new TypeError('Expected a timer callback')
    const id = --nextId
    handles.add(id)
    timers.set(id, { id, at: now + Math.max(0, delay ?? 0), run: () => callback() })
    return id as unknown as ReturnType<typeof globalThis.setTimeout>
  }) as unknown as typeof globalThis.setTimeout
  globalThis.clearTimeout = ((handle: ReturnType<typeof globalThis.setTimeout> | undefined) => {
    const id = Number(handle)
    if (handles.has(id)) {
      timers.delete(id)
      return
    }
    if (handle !== undefined) realClearTimeout(handle)
  }) as typeof globalThis.clearTimeout

  const clock: ControlledClock = {
    async advance(milliseconds) {
      const target = now + milliseconds
      for (;;) {
        let next: ControlledTimer | undefined
        for (const timer of timers.values()) {
          if (timer.at <= target && (!next || timer.at < next.at)) next = timer
        }
        if (!next) break
        timers.delete(next.id)
        now = next.at
        next.run()
        await flushMicrotasks()
      }
      now = target
      await flushMicrotasks()
    },
    restore() {
      if (restored) return
      restored = true
      timers.clear()
      globalThis.clearTimeout = realClearTimeout
      globalThis.setTimeout = realSetTimeout
      Date.now = realNow
      if (activeClock === clock) activeClock = undefined
    },
  }
  activeClock = clock
  return clock
}

async function advanceClock(milliseconds: number): Promise<void> {
  if (!activeClock) throw new Error('controlled clock is not active')
  await activeClock.advance(milliseconds)
}

test.each(['spawn', 'run'] as const)('1: %s waits for repeated group kills before settling', async mode => {
  let aliveUntil = 0
  let aliveCalls = 0
  const child = groupDouble({ groupAlive: () => { aliveCalls++; return Date.now() < aliveUntil } })
  const value = runner({ start: (() => child) as StartChild })
  const processHandle = mode === 'spawn'
    ? value.spawn(['/fake/repeat-kill'], { timeoutMs: 5_000 })
    : undefined
  let settled = false
  const pending = processHandle ? processHandle.exited : value.run(['/fake/repeat-kill'], { timeoutMs: 5_000 })
  void pending.then(() => { settled = true })
  aliveUntil = Date.now() + 45
  child.finish(4)
  await Bun.sleep(25)
  expect(settled).toBe(false)
  expect(value.live()).toHaveLength(1)
  const result = await pending
  expect(result.exitCode).toBe(4)
  expect(child.signals.length).toBeGreaterThanOrEqual(3)
  expect(child.signals.every(call => call.signal === 'SIGKILL')).toBe(true)
  for (let index = 1; index < 3; index++) {
    expect(child.signals[index]!.at - child.signals[index - 1]!.at).toBeGreaterThanOrEqual(7)
  }
  expect(value.live()).toEqual([])
  const signalCount = child.signals.length
  const aliveCallCount = aliveCalls
  await Bun.sleep(60)
  expect(child.signals).toHaveLength(signalCount)
  expect(aliveCalls).toBe(aliveCallCount)
  if (processHandle) expect(result.durationMs).toBeLessThan(30)
}, 5_000)

test.each(['spawn', 'run'] as const)('2: %s reports a group still alive at the cleanup bound', async mode => {
  const child = groupDouble({ groupAlive: () => true })
  const value = runner({ start: (() => child) as StartChild })
  const process = mode === 'spawn'
    ? value.spawn(['/fake/permanent-group'], { timeoutMs: 5_000 })
    : undefined
  const startedAt = Date.now()
  if (process) child.finish(7)
  const pending = process ? process.exited : value.run(['/fake/permanent-group'], { timeoutMs: 5_000 }).then(result => result)
  if (!process) child.finish(7)
  const result = await pending
  const cleanupMs = Date.now() - startedAt
  expect(cleanupMs).toBeGreaterThanOrEqual(1_000)
  expect(cleanupMs).toBeLessThanOrEqual(1_300)
  expect(result.exitCode).toBe(7)
  expect(result.groupSurvived).toBe(true)
  expect(value.live()).toEqual([])
  const signals = child.signals.length
  await Bun.sleep(60)
  expect(child.signals).toHaveLength(signals)
  if (process) expect(result.durationMs).toBeLessThan(30)
}, 5_000)

test('3: spawn duration measures the leader exit, not group cleanup', async () => {
  const child = groupDouble({ groupAlive: () => true })
  const value = runner({ start: (() => child) as StartChild })
  const process = value.spawn(['/fake/duration'], { timeoutMs: 5_000 })
  child.finish(0)
  const result = await process.exited
  expect(result.durationMs).toBeLessThan(30)
  expect(result.groupSurvived).toBe(true)
}, 5_000)

test('4: disposal during spawn cleanup waits for the group and preserves the timeout reason', async () => {
  let aliveUntil = 0
  const child = groupDouble({
    groupAlive: () => Date.now() < aliveUntil,
    onSignal(signal, finish) {
      if (signal === 'SIGTERM') {
        aliveUntil = Date.now() + 45
        finish(null, 'SIGTERM')
      }
    },
  })
  const value = runner({ start: (() => child) as StartChild })
  const processHandle = value.spawn(['/fake/dispose-cleanup'], { timeoutMs: 25, killGraceMs: 0 })
  await Bun.sleep(35)
  const disposal = value.dispose()
  const result = await processHandle.exited
  await disposal
  expect(result.stopped).toBe('timeout')
  expect(result.groupSurvived).toBeUndefined()
  expect(value.live()).toEqual([])
}, 5_000)
test('M10: spawn disposal remains pending until group cleanup completes', async () => {
  let alive = true
  const cleanupStarted = Promise.withResolvers<void>()
  const child = groupDouble({
    groupAlive: () => alive,
    onSignal(signal) {
      if (signal === 'SIGKILL') cleanupStarted.resolve()
    },
  })
  const value = runner({ start: (() => child) as StartChild })
  const processHandle = value.spawn(['/fake/dispose-waits-for-group'], { timeoutMs: 5_000 })
  let disposed = false
  try {
    child.finish(0)
    await cleanupStarted.promise
    const disposal = value.dispose().then(() => { disposed = true })
    await flushMicrotasks()
    expect(disposed).toBe(false)
    expect(value.live()).toHaveLength(1)
    alive = false
    await processHandle.exited
    await disposal
    expect(disposed).toBe(true)
    expect(value.live()).toEqual([])
  } finally {
    alive = false
    child.finish(0)
    const disposal = value.dispose()
    await processHandle.exited
    await disposal
  }
}, 5_000)

test('4: run disposal during cleanup returns aborted only after the group is gone', async () => {
  let aliveUntil: number | undefined
  const child = groupDouble({
    groupAlive: () => {
      aliveUntil ??= Date.now() + 80
      return Date.now() < aliveUntil
    },
  })
  const value = runner({ start: (() => child) as StartChild })
  const pending = value.run(['/fake/run-dispose-cleanup'], { timeoutMs: 5_000 })
  child.finish(0)
  while (child.signals.length === 0) await Bun.sleep(1)
  let disposed = false
  const disposal = value.dispose().then(() => { disposed = true })
  await flushMicrotasks()
  expect(disposed).toBe(false)
  const result = await pending
  await disposal
  expect(result.stopped).toBe('aborted')
  expect(result.groupSurvived).toBeUndefined()
  expect(value.live()).toEqual([])
}, 5_000)

test.each(['spawn', 'run'] as const)('5: %s treats a double without groupAlive as a single kill', async mode => {
  const child = groupDouble()
  const value = runner({ start: (() => child) as StartChild })
  const process = mode === 'spawn' ? value.spawn(['/fake/no-group'], { timeoutMs: 5_000 }) : undefined
  if (process) child.finish(2)
  const pending = process ? process.exited : value.run(['/fake/no-group'], { timeoutMs: 5_000 })
  if (!process) child.finish(2)
  const result = await pending
  expect(result.exitCode).toBe(2)
  expect(result.groupSurvived).toBeUndefined()
  expect(child.signals.map(call => call.signal)).toEqual(['SIGKILL'])
}, 5_000)

test('6: spawn cleans up the fork race in default mode', async () => {
  const value = runner()
  const pidFile = join(homeDir, 'descendant.pid')
  const command = '(exec /bin/sleep 5) & echo $! > "$PID_FILE"; echo early; exit 0'
  for (let index = 0; index < 10; index++) {
    rmSync(pidFile, { force: true })
    const startedAt = Date.now()
    let pid: number | undefined
    try {
      const child = value.spawn(['/bin/sh', '-c', command], {
        env: { PID_FILE: pidFile }, timeoutMs: 10_000,
      })
      const [stdout, result] = await Promise.all([readText(child.stdout), child.exited])
      pid = trackPidFile(pidFile)
      expect(Date.now() - startedAt).toBeLessThan(900)
      expect(stdout).toBe('early\n')
      expect(result.exitCode).toBe(0)
      expect(result.groupSurvived).toBeUndefined()
      expect(pid).toBeGreaterThan(1)
    } finally {
      pid ??= trackPidFile(pidFile)
    }
    await expectPidGone(pid!, 900)
    await Bun.sleep(100)
    expect(() => process.kill(pid!, 0)).toThrow()
  }
}, 20_000)

test('6: rerunnable run cleans up the fork race without retrying', async () => {
  const value = runner()
  const pidFile = join(homeDir, 'run-descendant.pid')
  const countFile = join(homeDir, 'runs.txt')
  const command = 'printf x >> "$COUNT_FILE"; (exec /bin/sleep 5) & echo $! > "$PID_FILE"; echo early; exit 0'
  for (let index = 0; index < 5; index++) {
    rmSync(pidFile, { force: true })
    let pid: number | undefined
    try {
      const result = await value.run(['/bin/sh', '-c', command], {
        env: { COUNT_FILE: countFile, PID_FILE: pidFile }, timeoutMs: 10_000, rerunnable: true,
      })
      pid = trackPidFile(pidFile)
      expect(result.stdoutText).toBe('early\n')
      expect(result.exitCode).toBe(0)
      expect(result.groupSurvived).toBeUndefined()
      expect(pid).toBeGreaterThan(1)
    } finally {
      pid ??= trackPidFile(pidFile)
    }
    await expectPidGone(pid!, 900)
  }
  expect(readFileSync(countFile, 'utf8')).toBe('xxxxx')
}, 15_000)

function openSource() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let cancellations = 0
  const stream = new ReadableStream<Uint8Array>({
    start(value) { controller = value },
    cancel() { cancellations++ },
  })
  return {
    stream,
    controller: () => controller,
    cancellations: () => cancellations,
  }
}

function recordingStart(signals: Array<{ signal: 'SIGTERM' | 'SIGKILL'; at: number }>): StartChild {
  return (argv, init) => {
    const child = startChild(argv, init)
    const killGroup = child.killGroup.bind(child)
    child.killGroup = signal => {
      signals.push({ signal, at: Date.now() })
      killGroup(signal)
    }
    return child
  }
}

test('7: group signal helpers validate pids and treat only ESRCH as gone', () => {
  let pid = 0
  let failure: (Error & { code?: string }) | undefined = Object.assign(new Error('no such process'), { code: 'ESRCH' })
  const calls: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = []
  const fakeProc = () => ({
    pid,
    stdout: closedStream(),
    stderr: closedStream(),
    exited: Promise.resolve(0),
    exitCode: 0,
    signalCode: null,
  })
  const spawn = spyOn(Bun, 'spawn').mockImplementation(() => fakeProc() as ReturnType<typeof Bun.spawn>)
  const kill = spyOn(globalThis.process, 'kill').mockImplementation(((target: number, signal?: NodeJS.Signals | number) => {
    calls.push({ pid: target, signal })
    if (failure) throw failure
    return true
  }) as typeof process.kill)
  try {
    for (const invalidPid of [0, 1, -1, 1.5, Number.NaN]) {
      pid = invalidPid!
      const child = startChild(['/fake/invalid-pid'], {})
      child.killGroup('SIGKILL')
      expect(child.groupAlive?.()).toBe(false)
      expect(calls).toEqual([])
    }

    pid = 900_100
    const gone = startChild(['/fake/esrch'], {})
    expect(gone.groupAlive?.()).toBe(false)
    gone.killGroup('SIGTERM')
    expect(calls).toEqual([{ pid: -pid, signal: 0 }, { pid: -pid, signal: 'SIGTERM' }])

    calls.length = 0
    failure = undefined
    const present = startChild(['/fake/group-present'], {})
    expect(present.groupAlive?.()).toBe(true)
    present.killGroup('SIGTERM')
    expect(calls).toEqual([{ pid: -pid, signal: 0 }, { pid: -pid, signal: 'SIGTERM' }])

    for (const error of [
      Object.assign(new Error('permission denied'), { code: 'EPERM' }),
      new Error('unexpected process.kill failure'),
    ]) {
      calls.length = 0
      failure = error
      const alive = startChild(['/fake/group-alive'], {})
      expect(alive.groupAlive?.()).toBe(true)
      alive.killGroup('SIGKILL')
      expect(calls).toEqual([{ pid: -pid, signal: 0 }, { pid: -pid, signal: 'SIGKILL' }])
    }
  } finally {
    spawn.mockRestore()
    kill.mockRestore()
  }
}, 5_000)

// These cases exercise real Unix signal delivery and deliberately use wall-clock grace periods.
test('15: group grace lets a deadline descendant finish its SIGTERM handler', async () => {
  const marker = join(homeDir, 'terminated')
  const pidFile = join(homeDir, 'deadline-descendant.pid')
  const command = `(trap 'sleep 0.3; printf terminated > "$M"; exit 0' TERM; while :; do :; done) & echo $! > "$P"; wait`
  const startedAt = Date.now()
  const processHandle = runner().spawn(['/bin/sh', '-c', command], {
    env: { M: marker, P: pidFile }, timeoutMs: 200, killGraceMs: 5_000, groupGrace: true,
  })
  let pid: number | undefined
  try {
    const result = await processHandle.exited
    pid = trackPidFile(pidFile)
    expect(result.stopped).toBe('timeout')
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(readFileSync(marker, 'utf8')).toBe('terminated')
    expect(pid).toBeGreaterThan(1)
    await expectPidGone(pid!, 1_000)
  } finally {
    pid ??= trackPidFile(pidFile)
  }
}, 5_000)

test('16: group grace delivers stdout and raw stderr emitted by the TERM handler', async () => {
  const pidFile = join(homeDir, 'term-output-sleep.pid')
  const command = `trap 'echo got-term; echo err-term >&2; exit 7' TERM; echo before; sleep 30 & echo $! > "$P"; wait`
  const processHandle = runner().spawn(['/bin/sh', '-c', command], {
    env: { P: pidFile }, timeoutMs: 300, stderr: 'pipe', groupGrace: true,
  })
  let pid: number | undefined
  try {
    const output = readText(processHandle.stdout)
    const errorOutput = readText(processHandle.stderr)
    const result = await processHandle.exited
    pid = trackPidFile(pidFile)
    expect(await output).toBe('before\ngot-term\n')
    expect(await errorOutput).toBe('err-term\n')
    expect(result.exitCode).toBe(7)
    expect(result.stopped).toBe('timeout')
    expect(pid).toBeGreaterThan(1)
    await expectPidGone(pid!, 1_000)
  } finally {
    pid ??= trackPidFile(pidFile)
  }
}, 5_000)

test('16: group grace preserves bytes written to both streams after stop is requested', async () => {
  const stdout = openSource()
  const stderr = openSource()
  const child = groupDouble({ stdout: stdout.stream, stderr: stderr.stream, groupAlive: () => false })
  const value = runner({ start: (() => child) as StartChild })
  const processHandle = value.spawn(['/fake/grace-output'], {
    timeoutMs: 5_000, stderr: 'pipe', groupGrace: true,
  })
  const output = readText(processHandle.stdout)
  const errorOutput = readText(processHandle.stderr)
  const stopping = processHandle.stop()
  stdout.controller().enqueue(new TextEncoder().encode('late-out'))
  stderr.controller().enqueue(new TextEncoder().encode('late-err'))
  stdout.controller().close()
  stderr.controller().close()
  child.finish(7, 'SIGTERM')
  const [result, out, err] = await Promise.all([stopping, output, errorOutput])
  expect(out).toBe('late-out')
  expect(err).toBe('late-err')
  expect(result.exitCode).toBe(7)
  expect(result.stopped).toBe('stop')
}, 5_000)

test('17: graceful stop closes pending readers after one stall wait', async () => {
  const stdout = openSource()
  const stderr = openSource()
  const child = groupDouble({
    stdout: stdout.stream,
    stderr: stderr.stream,
    groupAlive: () => false,
    onSignal(signal, finish) {
      if (signal === 'SIGTERM') finish(null, 'SIGTERM')
    },
  })
  const value = runner({ start: (() => child) as StartChild, stallMs: 80 })
  const processHandle = value.spawn(['/fake/grace-reader-end'], {
    timeoutMs: 5_000, stderr: 'pipe', groupGrace: true,
  })
  const outputReader = processHandle.stdout.getReader()
  const errorReader = processHandle.stderr.getReader()
  const outputRead = outputReader.read()
  const errorRead = errorReader.read()
  const result = await processHandle.stop()
  expect(result.stopped).toBe('stop')
  expect(stdout.cancellations()).toBe(0)
  expect(stderr.cancellations()).toBe(0)
  expect(await outputRead).toEqual({ value: undefined, done: true })
  expect(await errorRead).toEqual({ value: undefined, done: true })
  outputReader.releaseLock()
  errorReader.releaseLock()
  expect(stdout.cancellations()).toBe(1)
  expect(stderr.cancellations()).toBe(1)
  expect(stdout.stream.locked).toBe(false)
  expect(stderr.stream.locked).toBe(false)
}, 5_000)

test('17: unconsumed graceful streams are cancelled once after exit settles', async () => {
  const stdout = openSource()
  const stderr = openSource()
  const child = groupDouble({
    stdout: stdout.stream,
    stderr: stderr.stream,
    groupAlive: () => false,
    onSignal(signal, finish) {
      if (signal === 'SIGTERM') finish(null, 'SIGTERM')
    },
  })
  const processHandle = runner({ start: (() => child) as StartChild, stallMs: 80 }).spawn(['/fake/grace-unread'], {
    timeoutMs: 5_000, stderr: 'pipe', groupGrace: true,
  })
  await processHandle.stop()
  expect(stdout.cancellations()).toBe(0)
  expect(stderr.cancellations()).toBe(0)
  await Bun.sleep(150)
  expect(stdout.cancellations()).toBe(1)
  expect(stderr.cancellations()).toBe(1)
  expect(await readText(processHandle.stdout)).toBe('')
  expect(await readText(processHandle.stderr)).toBe('')
  expect(stdout.stream.locked).toBe(false)
  expect(stderr.stream.locked).toBe(false)
}, 5_000)

test('18: natural leader exit gives a ready descendant SIGTERM', async () => {
  const ready = join(homeDir, 'ready-term')
  const pidFile = join(homeDir, 'term-descendant.pid')
  const signals: Array<{ signal: 'SIGTERM' | 'SIGKILL'; at: number }> = []
  const processHandle = runner({ start: recordingStart(signals) }).spawn(
    ['/bin/sh', '-c', `(: > "$R"; exec /bin/sleep 30) >/dev/null 2>&1 & echo $! > "$P"; while [ ! -e "$R" ]; do :; done; exit 0`],
    { env: { R: ready, P: pidFile }, timeoutMs: 5_000, killGraceMs: 5_000, groupGrace: true },
  )
  const startedAt = Date.now()
  let pid: number | undefined
  try {
    const result = await processHandle.exited
    pid = trackPidFile(pidFile)
    expect(result.exitCode).toBe(0)
    expect(result.stopped).toBeUndefined()
    expect(Date.now() - startedAt).toBeLessThan(900)
    expect(signals.map(call => call.signal)).toEqual(['SIGTERM'])
    expect(pid).toBeGreaterThan(1)
    await expectPidGone(pid!, 1_000)
  } finally {
    pid ??= trackPidFile(pidFile)
  }
}, 5_000)

test('19: natural leader exit gives an ignoring descendant the full grace before SIGKILL', async () => {
  const ready = join(homeDir, 'ready-ignore-term')
  const pidFile = join(homeDir, 'ignore-term-descendant.pid')
  const signals: Array<{ signal: 'SIGTERM' | 'SIGKILL'; at: number }> = []
  const processHandle = runner({ start: recordingStart(signals) }).spawn(
    ['/bin/sh', '-c', `(trap '' TERM; : > "$R"; exec /bin/sleep 30) >/dev/null 2>&1 & echo $! > "$P"; while [ ! -e "$R" ]; do :; done; exit 3`],
    { env: { R: ready, P: pidFile }, timeoutMs: 5_000, killGraceMs: 700, groupGrace: true },
  )
  const startedAt = Date.now()
  let pid: number | undefined
  try {
    const result = await processHandle.exited
    const elapsed = Date.now() - startedAt
    pid = trackPidFile(pidFile)
    expect(result.exitCode).toBe(3)
    expect(elapsed).toBeGreaterThanOrEqual(600)
    expect(elapsed).toBeLessThan(2_000)
    expect(signals[0]?.signal).toBe('SIGTERM')
    expect(signals.filter(call => call.signal === 'SIGKILL').length).toBeGreaterThanOrEqual(1)
    expect(signals.slice(1).every(call => call.signal === 'SIGKILL')).toBe(true)
    expect(pid).toBeGreaterThan(1)
    await expectPidGone(pid!, 1_000)
  } finally {
    pid ??= trackPidFile(pidFile)
  }
}, 5_000)

test('20: a natural exit with no remaining group member sends no SIGTERM', async () => {
  const signals: Array<{ signal: 'SIGTERM' | 'SIGKILL'; at: number }> = []
  const processHandle = runner({ start: recordingStart(signals) }).spawn(['/bin/sh', '-c', 'echo hi'], {
    timeoutMs: 5_000, groupGrace: true,
  })
  const startedAt = Date.now()
  expect(await readText(processHandle.stdout)).toBe('hi\n')
  const result = await processHandle.exited
  expect(result.exitCode).toBe(0)
  expect(Date.now() - startedAt).toBeLessThan(500)
  expect(signals).toEqual([])
}, 5_000)

test('21: group grace cleans up a descendant missed by the natural-exit TERM race', async () => {
  const pidFile = join(homeDir, 'grace-descendant.pid')
  const signals: Array<{ signal: 'SIGTERM' | 'SIGKILL'; at: number }> = []
  rmSync(pidFile, { force: true })
  const processHandle = runner({ start: recordingStart(signals) }).spawn(
    ['/bin/sh', '-c', `(exec /bin/sleep 5) & echo $! > "$PID_FILE"; echo early; exit 0`],
    { env: { PID_FILE: pidFile }, timeoutMs: 10_000, killGraceMs: 700, groupGrace: true },
  )
  let pid: number | undefined
  try {
    const [output, result] = await Promise.all([readText(processHandle.stdout), processHandle.exited])
    pid = trackPidFile(pidFile)
    expect(output).toBe('early\n')
    expect(result.exitCode).toBe(0)
    expect(result.groupSurvived).toBeUndefined()
    expect(pid).toBeGreaterThan(1)
    await expectPidGone(pid!, 2_000)
    expect(signals.filter(call => call.signal === 'SIGTERM')).toHaveLength(1)
  } finally {
    pid ??= trackPidFile(pidFile)
  }
}, 5_000)

test('22: abort during natural-exit grace does not extend its deadline', async () => {
  let alive = true
  const child = groupDouble({
    groupAlive: () => alive,
    onSignal(signal) {
      if (signal === 'SIGKILL') alive = false
    },
  })
  const value = runner({ start: (() => child) as StartChild })
  const abort = new AbortController()
  const processHandle = value.spawn(['/fake/abort-grace'], {
    timeoutMs: 5_000, killGraceMs: 400, groupGrace: true, signal: abort.signal,
  })
  child.finish(0)
  while (child.signals.length === 0) await Bun.sleep(1)
  const leaderExitedAt = child.signals[0]!.at
  await Bun.sleep(100)
  abort.abort()
  const result = await processHandle.exited
  const kill = child.signals.find(call => call.signal === 'SIGKILL')
  expect(result).toMatchObject({ exitCode: 0, signal: null, stopped: 'aborted' })
  expect(kill).toBeDefined()
  expect(kill!.at - leaderExitedAt).toBeGreaterThanOrEqual(380)
  expect(kill!.at - leaderExitedAt).toBeLessThan(600)
  expect(child.signals.map(call => call.signal)).toEqual(['SIGTERM', 'SIGKILL'])
}, 5_000)

test('22: an aborted natural-exit group that empties before grace sends no SIGKILL', async () => {
  let emptyAt: number | undefined
  const child = groupDouble({
    groupAlive: () => {
      emptyAt ??= Date.now() + 180
      return Date.now() < emptyAt
    },
  })
  const abort = new AbortController()
  const processHandle = runner({ start: (() => child) as StartChild }).spawn(['/fake/early-empty-grace'], {
    timeoutMs: 5_000, killGraceMs: 400, groupGrace: true, signal: abort.signal,
  })
  child.finish(0)
  while (child.signals.length === 0) await Bun.sleep(1)
  await Bun.sleep(100)
  abort.abort()
  const result = await processHandle.exited
  expect(result).toMatchObject({ exitCode: 0, signal: null, stopped: 'aborted' })
  expect(child.signals.map(call => call.signal)).toEqual(['SIGTERM'])
}, 5_000)

test('22: a graceful stop shortens natural-exit grace from its request time', async () => {
  let alive = true
  const child = groupDouble({
    groupAlive: () => alive,
    onSignal(signal) {
      if (signal === 'SIGKILL') alive = false
    },
  })
  const processHandle = runner({ start: (() => child) as StartChild }).spawn(['/fake/shorten-grace'], {
    timeoutMs: 5_000, killGraceMs: 400, groupGrace: true,
  })
  child.finish(0)
  while (child.signals.length === 0) await Bun.sleep(1)
  const leaderExitedAt = child.signals[0]!.at
  await Bun.sleep(50)
  const stoppedAt = Date.now()
  const pending = processHandle.stop({ graceMs: 60 })
  const result = await pending
  const kill = child.signals.find(call => call.signal === 'SIGKILL')
  expect(result.stopped).toBe('stop')
  expect(kill).toBeDefined()
  expect(kill!.at - stoppedAt).toBeGreaterThanOrEqual(50)
  expect(kill!.at - stoppedAt).toBeLessThan(150)
  expect(kill!.at - leaderExitedAt).toBeLessThan(200)
}, 5_000)
test('M5: a later stop cannot extend natural-exit grace', async () => {
  const clock = controlledClock()
  let alive = true
  const termSent = Promise.withResolvers<void>()
  let firstKillAt: number | undefined
  const child = groupDouble({
    groupAlive: () => alive,
    onSignal(signal) {
      if (signal === 'SIGTERM') termSent.resolve()
      if (signal === 'SIGKILL') {
        firstKillAt ??= Date.now()
        alive = false
      }
    },
  })
  const value = runner({ start: (() => child) as StartChild })
  const processHandle = value.spawn(['/fake/one-way-grace'], {
    timeoutMs: 5_000, killGraceMs: 1_000, groupGrace: true,
  })
  try {
    child.finish(0)
    await termSent.promise
    await advanceClock(200)
    const stopped = processHandle.stop({ graceMs: 2_000 })
    await advanceClock(799)
    expect(firstKillAt).toBeUndefined()
    await advanceClock(1)
    expect(firstKillAt).toBe(1_000)
    const result = await processHandle.exited
    await stopped
    expect(result.stopped).toBe('stop')
  } finally {
    alive = false
    child.finish(0)
    await advanceClock(20)
    await processHandle.exited
    await value.dispose()
    clock.restore()
  }
}, 5_000)
test('M6: graceful streams remain open for one stall window after exit', async () => {
  const clock = controlledClock()
  const stdout = openSource()
  const stderr = openSource()
  const child = groupDouble({
    stdout: stdout.stream,
    stderr: stderr.stream,
    groupAlive: () => false,
    onSignal(signal, finish) {
      if (signal === 'SIGTERM') finish(null, 'SIGTERM')
    },
  })
  const value = runner({ start: (() => child) as StartChild, stallMs: 80 })
  const processHandle = value.spawn(['/fake/grace-output-window'], {
    timeoutMs: 5_000, stderr: 'pipe', groupGrace: true,
  })
  const output = readText(processHandle.stdout)
  const errorOutput = readText(processHandle.stderr)
  try {
    const stopping = processHandle.stop()
    const result = await processHandle.exited
    expect(result.stopped).toBe('stop')
    expect(stdout.cancellations()).toBe(0)
    expect(stderr.cancellations()).toBe(0)
    stdout.controller().enqueue(new TextEncoder().encode('late-out'))
    stderr.controller().enqueue(new TextEncoder().encode('late-err'))
    await advanceClock(79)
    expect(stdout.cancellations()).toBe(0)
    expect(stderr.cancellations()).toBe(0)
    await advanceClock(1)
    await stopping
    expect(stdout.cancellations()).toBe(1)
    expect(stderr.cancellations()).toBe(1)
    expect(await Promise.all([output, errorOutput])).toEqual(['late-out', 'late-err'])
    expect(stdout.stream.locked).toBe(false)
    expect(stderr.stream.locked).toBe(false)
  } finally {
    try { stdout.controller().close() } catch {}
    try { stderr.controller().close() } catch {}
    child.finish(null, 'SIGTERM')
    await advanceClock(100)
    await processHandle.exited
    await Promise.all([output, errorOutput].map(read => read.catch(() => '')))
    await value.dispose()
    clock.restore()
  }
}, 5_000)
test('M2: output stall time starts only after process-group cleanup', async () => {
  const clock = controlledClock()
  let alive = true
  const cleanupStarted = Promise.withResolvers<void>()
  const stdout = openSource()
  const child = groupDouble({
    stdout: stdout.stream,
    groupAlive: () => alive,
    onSignal(signal) {
      if (signal === 'SIGKILL') cleanupStarted.resolve()
    },
  })
  const value = runner({ start: (() => child) as StartChild, stallMs: 50 })
  const processHandle = value.spawn(['/fake/stall-after-cleanup'], {
    timeoutMs: 5_000,
  })
  const reader = processHandle.stdout.getReader()
  let settled = false
  const read = reader.read().then(
    value => { settled = true; return { kind: 'read' as const, value } },
    error => { settled = true; return { kind: 'error' as const, error } },
  )
  try {
    child.finish(0)
    await cleanupStarted.promise
    await advanceClock(100)
    expect(settled).toBe(false)
    alive = false
    await advanceClock(10)
    await processHandle.exited
    await advanceClock(49)
    expect(settled).toBe(false)
    await advanceClock(1)
    expect(settled).toBe(true)
    const outcome = await read
    expect(outcome.kind).toBe('error')
    if (outcome.kind === 'error') expect(outcome.error).toBeInstanceOf(ProcessStalledError)
  } finally {
    alive = false
    child.finish(0)
    try { stdout.controller().close() } catch {}
    await advanceClock(100)
    await processHandle.exited
    await read
    reader.releaseLock()
    await value.dispose()
    clock.restore()
  }
}, 5_000)
test('M11: a surviving group cancels the tailed stderr source at its cleanup bound', async () => {
  const clock = controlledClock()
  const stderr = openSource()
  stderr.controller().enqueue(new TextEncoder().encode('diagnostic'))
  const cleanupStarted = Promise.withResolvers<void>()
  const child = groupDouble({
    stderr: stderr.stream,
    groupAlive: () => true,
    onSignal(signal) {
      if (signal === 'SIGKILL') cleanupStarted.resolve()
    },
  })
  const value = runner({ start: (() => child) as StartChild, stallMs: 50 })
  const processHandle = value.spawn(['/fake/surviving-tail'], { timeoutMs: 5_000 })
  let settled = false
  const pending = processHandle.exited.then(result => {
    settled = true
    return result
  })
  try {
    child.finish(7)
    await cleanupStarted.promise
    await advanceClock(999)
    expect(settled).toBe(false)
    await advanceClock(1)
    expect(settled).toBe(true)
    const result = await pending
    expect(result.groupSurvived).toBe(true)
    expect(processHandle.stderrTail()).toBe('diagnostic')
    expect(stderr.cancellations()).toBe(1)
  } finally {
    try { stderr.controller().close() } catch {}
    child.finish(7)
    await advanceClock(1_020)
    await pending
    await value.dispose()
    clock.restore()
  }
}, 5_000)
test('M14: a natural leader exit clears its deadline before cleanup', async () => {
  const clock = controlledClock()
  let alive = true
  const cleanupStarted = Promise.withResolvers<void>()
  const stdout = openSource()
  const child = groupDouble({
    stdout: stdout.stream,
    groupAlive: () => alive,
    onSignal(signal) {
      if (signal === 'SIGKILL') cleanupStarted.resolve()
    },
  })
  const value = runner({ start: (() => child) as StartChild, stallMs: 500 })
  const processHandle = value.spawn(['/fake/clear-deadline'], {
    timeoutMs: 100,
  })
  let outputSettled = false
  const output = readText(processHandle.stdout).then(text => {
    outputSettled = true
    return text
  })
  try {
    child.finish(0)
    await cleanupStarted.promise
    await advanceClock(150)
    expect(outputSettled).toBe(false)
    stdout.controller().enqueue(new TextEncoder().encode('after-deadline'))
    stdout.controller().close()
    alive = false
    await advanceClock(10)
    const result = await processHandle.exited
    expect(result.stopped).toBeUndefined()
    expect(await output).toBe('after-deadline')
  } finally {
    alive = false
    child.finish(0)
    try { stdout.controller().close() } catch {}
    await advanceClock(20)
    await processHandle.exited
    await output.catch(() => '')
    await value.dispose()
    clock.restore()
  }
}, 5_000)

test('M15: abort after default-mode leader exit does not cut forwarded output', async () => {
  const clock = controlledClock()
  let alive = true
  const cleanupStarted = Promise.withResolvers<void>()
  const stdout = openSource()
  const child = groupDouble({
    stdout: stdout.stream,
    groupAlive: () => alive,
    onSignal(signal) {
      if (signal === 'SIGKILL') cleanupStarted.resolve()
    },
  })
  const abort = new AbortController()
  const value = runner({ start: (() => child) as StartChild, stallMs: 500 })
  const processHandle = value.spawn(['/fake/detached-abort-listener'], {
    timeoutMs: null, signal: abort.signal,
  })
  const output = readText(processHandle.stdout)
  let enqueueError: unknown
  try {
    child.finish(0)
    await cleanupStarted.promise
    abort.abort()
    try {
      stdout.controller().enqueue(new TextEncoder().encode('after-abort'))
      stdout.controller().close()
    } catch (error) {
      enqueueError = error
    }
    alive = false
    await advanceClock(10)
    await processHandle.exited
    expect(enqueueError).toBeUndefined()
    expect(await output).toBe('after-abort')
  } finally {
    alive = false
    child.finish(0)
    try { stdout.controller().close() } catch {}
    await advanceClock(20)
    await processHandle.exited
    await output.catch(() => '')
    await value.dispose()
    clock.restore()
  }
}, 5_000)
test('M3: spawn treats a throwing groupAlive as a possibly live group', async () => {
  let checks = 0
  const child = groupDouble({
    groupAlive() {
      if (checks++ === 0) throw Object.assign(new Error('permission unknown'), { code: 'EPERM' })
      return false
    },
  })
  const value = runner({ start: (() => child) as StartChild })
  const processHandle = value.spawn(['/fake/throwing-spawn-group-check'], {
    timeoutMs: 5_000, killGraceMs: 0, groupGrace: true,
  })
  try {
    child.finish(0)
    const result = await processHandle.exited
    expect(child.signals.some(call => call.signal === 'SIGTERM')).toBe(true)
    expect(result.groupSurvived).toBeUndefined()
  } finally {
    child.finish(0)
    await processHandle.exited
    await value.dispose()
  }
}, 5_000)

test('M4: kill cleanup retries after groupAlive throws', async () => {
  let checks = 0
  const child = groupDouble({
    groupAlive() {
      if (checks++ === 0) throw new Error('group state unavailable')
      return false
    },
  })
  const value = runner({ start: (() => child) as StartChild })
  const processHandle = value.spawn(['/fake/throwing-kill-group-check'], { timeoutMs: 5_000 })
  try {
    child.finish(0)
    const result = await processHandle.exited
    expect(child.signals.filter(call => call.signal === 'SIGKILL').length).toBeGreaterThanOrEqual(2)
    expect(result.groupSurvived).toBeUndefined()
  } finally {
    child.finish(0)
    await processHandle.exited
    await value.dispose()
  }
}, 5_000)
test('M13: disposal during cleanup shares one kill loop and cleanup goes quiet', async () => {
  const clock = controlledClock()
  let alive = true
  const firstKill = Promise.withResolvers<void>()
  const child = groupDouble({
    groupAlive: () => alive,
    onSignal(signal) {
      if (signal === 'SIGKILL') firstKill.resolve()
    },
  })
  const value = runner({ start: (() => child) as StartChild })
  const processHandle = value.spawn(['/fake/shared-kill-loop'], { timeoutMs: 5_000 })
  try {
    child.finish(0)
    await firstKill.promise
    const disposal = value.dispose()
    await flushMicrotasks()
    expect(child.signals.filter(call => call.signal === 'SIGKILL')).toHaveLength(1)
    alive = false
    await advanceClock(10)
    await processHandle.exited
    await disposal
    expect(value.live()).toEqual([])
    const signalsAtSettle = child.signals.length
    await advanceClock(50)
    expect(child.signals).toHaveLength(signalsAtSettle)
  } finally {
    alive = false
    child.finish(0)
    const disposal = value.dispose()
    await advanceClock(20)
    await processHandle.exited
    await disposal
    clock.restore()
  }
}, 5_000)

test.each(['spawn', 'run'] as const)('M17: %s reports a surviving group at the exact one-second bound', async mode => {
  const clock = controlledClock()
  let alive = true
  const killStarted = Promise.withResolvers<void>()
  const child = groupDouble({
    groupAlive: () => alive,
    onSignal(signal) {
      if (signal === 'SIGKILL') killStarted.resolve()
    },
  })
  const value = runner({ start: (() => child) as StartChild })
  const pending = mode === 'spawn'
    ? value.spawn(['/fake/exact-cleanup-bound'], { timeoutMs: 5_000 }).exited
    : value.run(['/fake/exact-cleanup-bound'], { timeoutMs: 5_000 })
  let settled = false
  void pending.then(() => { settled = true })
  try {
    child.finish(7)
    await killStarted.promise
    await advanceClock(999)
    expect(settled).toBe(false)
    await advanceClock(1)
    expect(settled).toBe(true)
    const result = await pending
    expect(result.exitCode).toBe(7)
    expect(result.groupSurvived).toBe(true)
  } finally {
    alive = false
    child.finish(7)
    const disposal = value.dispose()
    await advanceClock(20)
    await pending
    await disposal
    clock.restore()
  }
}, 5_000)

test('22: SIGKILL stop ends both streams immediately during natural-exit grace', async () => {
  let alive = true
  const termSent = Promise.withResolvers<void>()
  const stdout = openSource()
  const stderr = openSource()
  const child = groupDouble({
    stdout: stdout.stream,
    stderr: stderr.stream,
    groupAlive: () => alive,
    onSignal(signal) {
      if (signal === 'SIGTERM') termSent.resolve()
      if (signal === 'SIGKILL') alive = false
    },
  })
  const value = runner({ start: (() => child) as StartChild })
  const processHandle = value.spawn(['/fake/hard-stop-grace'], {
    timeoutMs: 5_000, killGraceMs: 400, groupGrace: true, stderr: 'pipe',
  })
  const out = processHandle.stdout.getReader()
  const err = processHandle.stderr.getReader()
  const outputRead = out.read()
  const errorRead = err.read()
  let outputDone = false
  let errorDone = false
  void outputRead.then(() => { outputDone = true })
  void errorRead.then(() => { errorDone = true })
  try {
    child.finish(0)
    await termSent.promise
    const stopping = processHandle.stop({ signal: 'SIGKILL' })
    await flushMicrotasks()
    expect(outputDone).toBe(true)
    expect(errorDone).toBe(true)
    const result = await stopping
    expect(result.stopped).toBe('stop')
    expect(child.signals.map(call => call.signal)).toEqual(['SIGTERM', 'SIGKILL'])
    expect(await outputRead).toEqual({ value: undefined, done: true })
    expect(await errorRead).toEqual({ value: undefined, done: true })
  } finally {
    alive = false
    child.finish(0)
    try { stdout.controller().close() } catch {}
    try { stderr.controller().close() } catch {}
    await processHandle.exited
    await Promise.all([outputRead, errorRead].map(read => read.catch(() => undefined)))
    out.releaseLock()
    err.releaseLock()
    await value.dispose()
  }
}, 5_000)
test('B2: a pre-exit hard stop starts group cleanup without the prior grace deadline', async () => {
  let alive = true
  let leaderExited = false
  let leaderExitedAt = 0
  let firstKillAfterExitAt: number | undefined
  const child = groupDouble({
    groupAlive: () => alive,
    onSignal(signal) {
      if (signal === 'SIGKILL' && leaderExited) {
        firstKillAfterExitAt ??= Date.now()
        alive = false
      }
    },
  })
  const value = runner({ start: (() => child) as StartChild })
  const processHandle = value.spawn(['/fake/pre-exit-hard-stop'], {
    timeoutMs: 5_000, killGraceMs: 800, groupGrace: true,
  })
  try {
    void processHandle.stop()
    void processHandle.stop({ signal: 'SIGKILL' })
    leaderExitedAt = Date.now()
    leaderExited = true
    child.finish(0)
    const result = await processHandle.exited
    expect(result).toMatchObject({ exitCode: 0, stopped: 'stop' })
    expect(firstKillAfterExitAt).toBeDefined()
    expect(firstKillAfterExitAt! - leaderExitedAt).toBeLessThan(250)
  } finally {
    leaderExited = true
    alive = false
    child.finish(0)
    await processHandle.exited
    await value.dispose()
  }
}, 5_000)


test('22: disposal during natural-exit grace hard-kills and waits for the group', async () => {
  let alive = true
  const child = groupDouble({
    groupAlive: () => alive,
    onSignal(signal) {
      if (signal === 'SIGKILL') alive = false
    },
  })
  const value = runner({ start: (() => child) as StartChild })
  const processHandle = value.spawn(['/fake/dispose-grace'], {
    timeoutMs: 5_000, killGraceMs: 400, groupGrace: true,
  })
  child.finish(0)
  while (child.signals.length === 0) await Bun.sleep(1)
  const disposal = value.dispose()
  const [result] = await Promise.all([processHandle.exited, disposal])
  expect(result).toMatchObject({ exitCode: 0, signal: null, stopped: 'aborted' })
  expect(child.signals.map(call => call.signal)).toEqual(['SIGTERM', 'SIGKILL'])
}, 5_000)

test('23: timeout remains the first stop reason through abort and stop', async () => {
  let alive = true
  const child = groupDouble({
    groupAlive: () => alive,
    onSignal(signal, finish) {
      if (signal === 'SIGTERM' && child.signals.length === 1) finish(0)
      if (signal === 'SIGKILL') alive = false
    },
  })
  const abort = new AbortController()
  const processHandle = runner({ start: (() => child) as StartChild }).spawn(['/fake/first-reason'], {
    timeoutMs: 40, killGraceMs: 400, groupGrace: true, signal: abort.signal,
  })
  while (child.signals.length === 0) await Bun.sleep(1)
  abort.abort()
  void processHandle.stop()
  const result = await processHandle.exited
  expect(result.stopped).toBe('timeout')
}, 5_000)

test('24: abort during natural-exit grace stops an ignoring descendant without a stream error', async () => {
  const ready = join(homeDir, 'ready-abort')
  const pidFile = join(homeDir, 'abort-descendant.pid')
  const abort = new AbortController()
  const processHandle = runner().spawn(
    ['/bin/sh', '-c', `(trap '' TERM; : > "$R"; exec /bin/sleep 30) & echo $! > "$P"; while [ ! -e "$R" ]; do :; done; echo early; exit 0`],
    { env: { R: ready, P: pidFile }, timeoutMs: 5_000, killGraceMs: 800, groupGrace: true, signal: abort.signal },
  )
  const startedAt = Date.now()
  let pid: number | undefined
  const output = readText(processHandle.stdout)
  const abortTimer = setTimeout(() => abort.abort(), 300)
  try {
    const result = await processHandle.exited
    pid = trackPidFile(pidFile)
    expect(result).toMatchObject({ exitCode: 0, stopped: 'aborted' })
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(700)
    expect(Date.now() - startedAt).toBeLessThan(1_800)
    expect(await output).toBe('early\n')
    expect(pid).toBeGreaterThan(1)
    await expectPidGone(pid!, 1_000)
  } finally {
    clearTimeout(abortTimer)
    pid ??= trackPidFile(pidFile)
  }
}, 5_000)
