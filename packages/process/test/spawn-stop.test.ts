import { afterEach, expect, test } from 'bun:test'
import { createProcessRunner, type OwnedProcessRunner, type SpawnOptions } from '../src/api'
import type { ChildExit, StartChild, StartedChild } from '../src/child'
import { executeSpawn } from '../src/spawn'

const runners: OwnedProcessRunner[] = []

function runner(extra: { start?: StartChild } = {}) {
  const value = createProcessRunner({ owner: 'test', ...extra })
  runners.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(runners.splice(0).map(value => value.dispose()))
})

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

async function readLine(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  let line = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) throw new Error('stdout ended before a line was read')
    line += new TextDecoder().decode(value)
    const newline = line.indexOf('\n')
    if (newline >= 0) return line.slice(0, newline)
  }
}

async function expectGone(pid: number) {
  const until = Date.now() + 1_000
  do {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await Bun.sleep(20)
  } while (Date.now() < until)
  throw new Error(`pid ${pid} survived`)
}

function closedStream() {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.close() } })
}

function childIgnoringTerm(signals: Array<'SIGTERM' | 'SIGKILL'>, pid: number): StartedChild {
  const { promise: exited, resolve } = Promise.withResolvers<ChildExit>()
  return {
    pid,
    stdout: closedStream(),
    stderr: closedStream(),
    exited,
    killGroup(signal) {
      signals.push(signal)
      if (signal === 'SIGKILL') resolve({ exitCode: null, signal: 'SIGKILL' })
    },
  }
}

async function waitBounded<T>(promise: Promise<T>): Promise<T> {
  const { promise: timeout, reject } = Promise.withResolvers<never>()
  const timer = setTimeout(() => reject(new Error('process did not exit within 3 seconds')), 3_000)
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

function directSpawnWithoutKillGraceMs(start: StartChild, options: Omit<SpawnOptions, 'killGraceMs'>) {
  return executeSpawn(start, ['/fake/direct-spawn'], options as SpawnOptions & { killGraceMs: number }, 1_000, {
    onStart: () => () => {},
  })
}

function expectMissingGraceError(call: () => unknown) {
  let error: unknown
  try {
    call()
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(RangeError)
  expect((error as Error | undefined)?.message).toBe('graceMs must be zero or a positive finite number')
}

test('16: stop returns the exact exit object and ends a running child promptly', async () => {
  const child = runner().spawn(['/bin/sh', '-c', 'sleep 30'], { timeoutMs: 10_000 })
  const startedAt = Date.now()
  const stopped = await child.stop()
  expect(Date.now() - startedAt).toBeLessThan(1_000)
  expect(stopped).toBe(await child.exited)
  expect(stopped.exitCode).toBeNull()
  expect(stopped.signal).toBe('SIGTERM')
  expect(stopped.stopped).toBe('stop')
}, 15_000)

test('17: stop kills descendants in the child process group', async () => {
  const child = runner().spawn(['/bin/sh', '-c', 'sleep 30 & echo $!; wait'], { timeoutMs: 10_000 })
  const reader = child.stdout.getReader()
  const descendantPid = Number(await readLine(reader))
  expect(descendantPid).toBeGreaterThan(0)
  await child.stop()
  await expectGone(descendantPid)
  reader.releaseLock()
}, 15_000)

test('18: an ignored SIGTERM escalates to SIGKILL after the requested grace', async () => {
  const child = runner().spawn(
    ['/bin/sh', '-c', "trap '' TERM; printf 'ready\\n'; while :; do sleep 1; done"],
    { timeoutMs: 10_000 },
  )
  const reader = child.stdout.getReader()
  expect(await readLine(reader)).toBe('ready')
  const startedAt = Date.now()
  const result = await child.stop({ graceMs: 300 })
  const elapsed = Date.now() - startedAt
  expect(result.signal).toBe('SIGKILL')
  expect(result.stopped).toBe('stop')
  expect(elapsed).toBeGreaterThanOrEqual(250)
  expect(elapsed).toBeLessThan(3_000)
  reader.releaseLock()
}, 15_000)

test('19: SIGKILL can be requested immediately', async () => {
  const child = runner().spawn(
    ['/bin/sh', '-c', "trap '' TERM; while :; do sleep 1; done"],
    { timeoutMs: 10_000 },
  )
  const startedAt = Date.now()
  const result = await child.stop({ signal: 'SIGKILL' })
  expect(result.signal).toBe('SIGKILL')
  expect(Date.now() - startedAt).toBeLessThan(1_000)
}, 15_000)

test('20: a later harder stop accelerates the first stop and shares its result', async () => {
  const child = runner().spawn(
    ['/bin/sh', '-c', "trap '' TERM; printf 'ready\\n'; while :; do sleep 1; done"],
    { timeoutMs: 10_000 },
  )
  const reader = child.stdout.getReader()
  expect(await readLine(reader)).toBe('ready')
  const first = child.stop({ graceMs: 10_000 })
  await Bun.sleep(100)
  const harderStopAt = Date.now()
  const second = child.stop({ signal: 'SIGKILL' })
  const [firstResult, secondResult] = await Promise.all([first, second])
  expect(Date.now() - harderStopAt).toBeLessThan(1_000)
  expect(firstResult).toBe(secondResult)
  expect(firstResult).toBe(await child.exited)
  expect(firstResult.signal).toBe('SIGKILL')
  reader.releaseLock()
}, 15_000)

test('21: stop closes a pending stdout read and stdin', async () => {
  const child = runner().spawn(['/bin/cat'], { stdin: 'pipe', timeoutMs: 5_000 })
  const reader = child.stdout.getReader()
  const pendingRead = reader.read()
  await child.stop()
  expect(await pendingRead).toEqual({ value: undefined, done: true })
  reader.releaseLock()
  expect(await child.write('x')).toBe(false)
}, 15_000)

test('22: stop after natural exit returns the same un-stopped result and drops unread stdout', async () => {
  const child = runner().spawn(['/bin/sh', '-c', 'printf x'], { timeoutMs: 5_000 })
  const exited = await child.exited
  const stopped = await child.stop()
  expect(stopped).toBe(exited)
  expect(stopped.exitCode).toBe(0)
  expect(stopped).not.toHaveProperty('stopped')
  expect(stopped.signal).toBeNull()
  const reader = child.stdout.getReader()
  expect(await reader.read()).toEqual({ value: undefined, done: true })
  reader.releaseLock()
}, 15_000)

test('23: a deadline stops the child with SIGTERM', async () => {
  const startedAt = Date.now()
  const child = runner().spawn(['/bin/sh', '-c', 'sleep 30'], { timeoutMs: 200 })
  const result = await child.exited
  expect(Date.now() - startedAt).toBeLessThan(2_000)
  expect(result.stopped).toBe('timeout')
  expect(result.signal).toBe('SIGTERM')
}, 15_000)

test('24: timeoutMs null lets the child finish naturally', async () => {
  const child = runner().spawn(['/bin/sh', '-c', 'sleep 0.3'], { timeoutMs: null })
  const result = await child.exited
  expect(result.exitCode).toBe(0)
  expect(result).not.toHaveProperty('stopped')
}, 15_000)

test('25: abort stops the child with the aborted reason', async () => {
  const controller = new AbortController()
  const child = runner().spawn(['/bin/sh', '-c', 'sleep 30'], { signal: controller.signal, timeoutMs: 10_000 })
  setTimeout(() => controller.abort(), 100)
  const result = await child.exited
  expect(result.stopped).toBe('aborted')
  expect(result.signal).toBe('SIGTERM')
}, 15_000)

test('26: an already-aborted signal prevents starting a child', async () => {
  let starts = 0
  const value = createProcessRunner({
    owner: 'test',
    start: (() => {
      starts++
      throw new Error('already-aborted spawn must not start')
    }) as StartChild,
  })
  runners.push(value)
  const controller = new AbortController()
  controller.abort()
  const child = value.spawn(['/bin/sleep', '30'], { signal: controller.signal, timeoutMs: 10_000 })
  expect(child.pid).toBeNull()
  expect(await readText(child.stdout)).toBe('')
  expect(await child.exited).toEqual({ exitCode: null, signal: null, stopped: 'aborted', durationMs: 0 })
  expect(starts).toBe(0)
}, 15_000)

test('27: timeout remains the first stop reason when a later stop escalates', async () => {
  const child = runner().spawn(
    ['/bin/sh', '-c', "trap '' TERM; while :; do sleep 1; done"],
    { timeoutMs: 200 },
  )
  await Bun.sleep(400)
  await child.stop({ signal: 'SIGKILL' })
  const result = await child.exited
  expect(result.stopped).toBe('timeout')
  expect(result.signal).toBe('SIGKILL')
}, 15_000)

test('28: a quiet leftover is killed as soon as its leader exits', async () => {
  const child = runner().spawn(['/bin/sh', '-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { timeoutMs: 5_000 })
  const result = await child.exited
  expect(result.exitCode).toBe(0)
  expect(result).not.toHaveProperty('stopped')
  const pid = Number((await readText(child.stdout)).trim())
  expect(pid).toBeGreaterThan(0)
  await expectGone(pid)
}, 15_000)

test('29: a leftover holding stdout is killed instead of stalling the stream', async () => {
  const child = runner().spawn(['/bin/sh', '-c', 'sleep 30 & echo $!'], { timeoutMs: 5_000 })
  const startedAt = Date.now()
  const output = await readText(child.stdout)
  expect(Date.now() - startedAt).toBeLessThan(1_000)
  expect(Number(output.trim())).toBeGreaterThan(0)
  expect((await child.exited).exitCode).toBe(0)
}, 15_000)

test('30: the runner kill grace escalates stop, timeout, and abort', async () => {
  const stopSignals: Array<'SIGTERM' | 'SIGKILL'> = []
  const stopRunner = runner({ start: (() => childIgnoringTerm(stopSignals, 900_030)) as StartChild })
  const stoppedChild = stopRunner.spawn(['/fake/stop'], { timeoutMs: 5_000, killGraceMs: 50 })
  const stopped = await waitBounded(stoppedChild.stop())
  expect(stopSignals).toEqual(['SIGTERM', 'SIGKILL', 'SIGKILL'])
  expect(stopped.signal).toBe('SIGKILL')
  expect(stopped.stopped).toBe('stop')

  const timeoutSignals: Array<'SIGTERM' | 'SIGKILL'> = []
  const timeoutRunner = runner({ start: (() => childIgnoringTerm(timeoutSignals, 900_031)) as StartChild })
  const timedChild = timeoutRunner.spawn(['/fake/timeout'], { timeoutMs: 50, killGraceMs: 50 })
  const timedOut = await waitBounded(timedChild.exited)
  expect(timeoutSignals).toEqual(['SIGTERM', 'SIGKILL', 'SIGKILL'])
  expect(timedOut.signal).toBe('SIGKILL')
  expect(timedOut.stopped).toBe('timeout')

  const abortSignals: Array<'SIGTERM' | 'SIGKILL'> = []
  const abortRunner = runner({ start: (() => childIgnoringTerm(abortSignals, 900_032)) as StartChild })
  const controller = new AbortController()
  const abortedChild = abortRunner.spawn(['/fake/abort'], {
    timeoutMs: 5_000,
    killGraceMs: 50,
    signal: controller.signal,
  })
  controller.abort()
  const aborted = await waitBounded(abortedChild.exited)
  expect(abortSignals).toEqual(['SIGTERM', 'SIGKILL', 'SIGKILL'])
  expect(aborted.signal).toBe('SIGKILL')
  expect(aborted.stopped).toBe('aborted')
}, 15_000)

test('31: executeSpawn requires killGraceMs for an already-aborted spawn', () => {
  let starts = 0
  const controller = new AbortController()
  controller.abort()
  const handle = directSpawnWithoutKillGraceMs(() => {
    starts++
    throw new Error('an already-aborted spawn must not start')
  }, { timeoutMs: null, signal: controller.signal })
  expectMissingGraceError(() => handle.stop())
  expect(starts).toBe(0)
}, 15_000)

test('32: executeSpawn requires killGraceMs after a start failure', () => {
  const handle = directSpawnWithoutKillGraceMs(() => {
    throw new Error('start failed')
  }, { timeoutMs: null })
  expectMissingGraceError(() => handle.stop())
}, 15_000)

test('33: executeSpawn requires killGraceMs for an active child', async () => {
  const signals: Array<'SIGTERM' | 'SIGKILL'> = []
  const handle = directSpawnWithoutKillGraceMs(
    (() => childIgnoringTerm(signals, 900_033)) as StartChild,
    { timeoutMs: null },
  )
  try {
    expectMissingGraceError(() => handle.stop())
  } finally {
    await waitBounded(handle.stop({ signal: 'SIGKILL', graceMs: 0 }))
  }
}, 15_000)
