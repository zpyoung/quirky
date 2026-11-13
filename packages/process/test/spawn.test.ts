import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createProcessRunner,
  DEFAULT_STDERR_TAIL_BYTES,
  liveProcesses,
  ProcessStalledError,
  type OwnedProcessRunner,
  type SpawnOptions,
} from '../src/api'
import type { StartedChild, StartChild } from '../src/child'

let homeDir = ''
let previousQuirkyHome: string | undefined

beforeEach(() => {
  previousQuirkyHome = process.env.QUIRKY_HOME
  homeDir = mkdtempSync(join(tmpdir(), 'quirky-spawn-test-'))
  process.env.QUIRKY_HOME = homeDir
})

const runners: OwnedProcessRunner[] = []

function runner(extra: { start?: StartChild; stallMs?: number } = {}) {
  const value = createProcessRunner({ owner: 'test', ...extra })
  runners.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(runners.splice(0).map(value => value.dispose()))
  if (previousQuirkyHome === undefined) delete process.env.QUIRKY_HOME
  else process.env.QUIRKY_HOME = previousQuirkyHome
  rmSync(homeDir, { recursive: true, force: true })
})

async function readBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.byteLength
  }
  reader.releaseLock()
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new TextDecoder().decode(await readBytes(stream))
}

function controlledSource(cancel: () => Promise<void> | void = () => {}): {
  stream: ReadableStream<Uint8Array>
  controller: () => ReadableStreamDefaultController<Uint8Array>
  cancellations: () => number
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let cancellations = 0
  const stream = new ReadableStream<Uint8Array>({
    start(value) { controller = value },
    cancel() {
      cancellations++
      return cancel()
    },
  })
  return { stream, controller: () => controller, cancellations: () => cancellations }
}

function controlledChild(options: {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  onSignal?: (signal: 'SIGTERM' | 'SIGKILL') => void
}): StartedChild {
  const exit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>()
  return {
    pid: 900_010,
    stdout: options.stdout,
    stderr: options.stderr,
    exited: exit.promise,
    killGroup(signal) {
      options.onSignal?.(signal)
      exit.resolve({ exitCode: null, signal })
    },
  }
}

async function flushTerminalMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

test('1: stdout arrives while the child is still running', async () => {
  const value = runner()
  const child = value.spawn(['/bin/sh', '-c', 'printf a; sleep 0.5; printf b'], { timeoutMs: 5_000 })
  expect(child.pid).toBeGreaterThan(0)

  let exited = false
  void child.exited.then(() => { exited = true })
  const reader = child.stdout.getReader()
  const first = await reader.read()
  expect(first.done).toBe(false)
  expect(new TextDecoder().decode(first.value)).toBe('a')
  expect(exited).toBe(false)

  const chunks = [first.value!]
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    chunks.push(next.value)
  }
  reader.releaseLock()
  expect(new TextDecoder().decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))))).toBe('ab')

  const result = await child.exited
  expect(result.exitCode).toBe(0)
  expect(result.signal).toBeNull()
  expect(result).not.toHaveProperty('stopped')
  expect(result).not.toHaveProperty('spawnError')
  expect(Number.isInteger(result.durationMs)).toBe(true)
  expect(result.durationMs).toBeGreaterThanOrEqual(0)
}, 15_000)

test('2: exit codes and signals are reported without rejecting', async () => {
  const value = runner()
  const codeThree = value.spawn(['/bin/sh', '-c', 'exit 3'], { timeoutMs: 5_000 })
  const codeResult = await codeThree.exited
  expect(codeResult.exitCode).toBe(3)
  expect(codeResult.signal).toBeNull()
  expect(codeResult).not.toHaveProperty('stopped')

  const signaled = value.spawn(['/bin/sh', '-c', 'kill -TERM $$'], { timeoutMs: 5_000 })
  const signalResult = await signaled.exited
  expect(signalResult.exitCode).toBeNull()
  expect(signalResult.signal).toBe('SIGTERM')
  expect(signalResult).not.toHaveProperty('stopped')
}, 15_000)

test('3: cwd and env are applied as complete spawn settings', async () => {
  const value = runner()
  const cwd = mkdtempSync(join(tmpdir(), 'quirky-spawn-cwd-'))
  try {
    const directory = value.spawn(['/bin/pwd'], { cwd, timeoutMs: 5_000 })
    expect(await readText(directory.stdout)).toBe(`${realpathSync(cwd)}\n`)
    expect((await directory.exited).exitCode).toBe(0)

    const environment = value.spawn(['/usr/bin/env'], { env: { ONLY: '1' }, timeoutMs: 5_000 })
    expect(await readText(environment.stdout)).toBe('ONLY=1\n')
    expect((await environment.exited).exitCode).toBe(0)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}, 15_000)

test('4: stderr tail is final when exited resolves', async () => {
  const child = runner().spawn(['/bin/sh', '-c', 'printf oops >&2; exit 2'], { timeoutMs: 5_000 })
  const result = await child.exited
  expect(result.exitCode).toBe(2)
  expect(child.stderrTail()).toBe('oops')
}, 15_000)

test('5: stderr is drained into a bounded UTF-8-safe tail', async () => {
  const value = runner()
  const large = value.spawn(
    ['/bin/sh', '-c', "head -c 100000 /dev/zero | tr '\\0' x >&2; printf END >&2"],
    { stderrTailBytes: 1_024, timeoutMs: 5_000 },
  )
  expect((await large.exited).exitCode).toBe(0)
  expect(large.stderrTail()).toHaveLength(1_024)
  expect(large.stderrTail().endsWith('END')).toBe(true)
  expect(DEFAULT_STDERR_TAIL_BYTES).toBe(16_384)

  const utf8 = value.spawn(['/bin/sh', '-c', "printf '\\303\\251Z' >&2"], { stderrTailBytes: 2, timeoutMs: 5_000 })
  expect((await utf8.exited).exitCode).toBe(0)
  expect(utf8.stderrTail()).toBe('Z')
}, 15_000)

test.each([
  { stderrTailBytes: undefined, expected: '\uFFFD\uFFFDoops' },
  { stderrTailBytes: 6, expected: '\uFFFD\uFFFDoops' },
  { stderrTailBytes: 5, expected: 'oops' },
])('stderr preserves leading invalid bytes unless truncated at $stderrTailBytes bytes', async ({ stderrTailBytes, expected }) => {
  const value = runner()
  const argv = ['/bin/sh', '-c', "printf '\\200\\277oops' >&2"]
  const child = value.spawn(argv, { stderrTailBytes, timeoutMs: 5_000 })
  expect((await child.exited).exitCode).toBe(0)
  expect(child.stderrTail()).toBe(expected)
  if (stderrTailBytes !== 5) expect(child.stderrTail()).toBe((await value.run(argv)).stderr)
}, 15_000)

test('an exact-capacity stderr tail keeps a complete leading multibyte character', async () => {
  const child = runner().spawn(['/bin/sh', '-c', "printf '\\303\\251Z' >&2"], {
    stderrTailBytes: 3,
    timeoutMs: 5_000,
  })
  expect((await child.exited).exitCode).toBe(0)
  expect(child.stderrTail()).toBe('éZ')
}, 15_000)

test('6: ignored output is discarded', async () => {
  const child = runner().spawn(
    ['/bin/sh', '-c', 'echo hi; echo oops >&2'],
    { stdout: 'ignore', stderr: 'ignore', timeoutMs: 5_000 },
  )
  const reader = child.stdout.getReader()
  expect(await reader.read()).toEqual({ value: undefined, done: true })
  reader.releaseLock()
  expect(child.stderrTail()).toBe('')
  expect((await child.exited).exitCode).toBe(0)
}, 15_000)

test('7: unread stdout backpressures the child until the caller reads', async () => {
  const child = runner().spawn(['/bin/sh', '-c', 'head -c 8388608 /dev/zero'], { timeoutMs: 10_000 })
  let exited = false
  void child.exited.then(() => { exited = true })
  await Bun.sleep(500)
  expect(exited).toBe(false)

  const bytes = await readBytes(child.stdout)
  expect(bytes.byteLength).toBe(8_388_608)
  expect((await child.exited).exitCode).toBe(0)
}, 15_000)

test('stdout cancellation stops reading without stopping the child', async () => {
  const child = runner().spawn(['/bin/sh', '-c', 'sleep 0.2; exit 0'], { timeoutMs: 5_000 })
  await child.stdout.cancel()
  const result = await child.exited
  expect(result.exitCode).toBe(0)
  expect(result).not.toHaveProperty('stopped')
}, 15_000)

test('8: an unstartable command and cwd return safe handles without live entries', async () => {
  const value = runner()
  const missingCommand = value.spawn(['/nonexistent/quirky-no-such-binary'], { timeoutMs: 5_000 })
  expect(missingCommand.pid).toBeNull()
  expect(await readText(missingCommand.stdout)).toBe('')
  expect(missingCommand.stderrTail()).toBe('')
  expect(await missingCommand.write('x')).toBe(false)
  const missingResult = await missingCommand.exited
  expect(missingResult.exitCode).toBeNull()
  expect(missingResult.signal).toBeNull()
  expect(missingResult.spawnError?.code).toBe('ENOENT')
  expect(missingResult.spawnError?.message.length).toBeGreaterThan(0)
  expect(value.live()).toEqual([])

  const invalidCwd = value.spawn(['/bin/pwd'], { cwd: '/nonexistent/quirky-no-such-directory', timeoutMs: 5_000 })
  expect(invalidCwd.pid).toBeNull()
  const cwdResult = await invalidCwd.exited
  expect(cwdResult.exitCode).toBeNull()
  expect(cwdResult.spawnError?.code).toBe('ENOENT')
  expect(value.live()).toEqual([])
  expect(liveProcesses()).not.toContainEqual(expect.objectContaining({ command: '/nonexistent/quirky-no-such-binary' }))
}, 15_000)


test('8-9: piped stderr preserves raw bytes without retaining a tail', async () => {
  const child = runner().spawn(['/bin/sh', '-c', `printf '\\357\\273\\277a\\377' >&2`], {
    timeoutMs: 5_000, stderr: 'pipe',
  })
  const bytes = await readBytes(child.stderr)
  expect(bytes).toEqual(new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0xff]))
  expect(child.stderrTail()).toBe('')
  expect((await child.exited).exitCode).toBe(0)
})

test('9: tail and ignored stderr expose empty closed streams and keep their existing tails', async () => {
  const value = runner()
  const tailed = value.spawn(['/bin/sh', '-c', 'printf tail >&2'], { timeoutMs: 5_000 })
  expect(await readText(tailed.stderr)).toBe('')
  expect((await tailed.exited).exitCode).toBe(0)
  expect(tailed.stderrTail()).toBe('tail')

  const ignored = value.spawn(['/bin/sh', '-c', 'printf ignored >&2'], {
    timeoutMs: 5_000, stderr: 'ignore',
  })
  expect(await readText(ignored.stderr)).toBe('')
  expect((await ignored.exited).exitCode).toBe(0)
  expect(ignored.stderrTail()).toBe('')

  const missing = value.spawn(['/nonexistent/quirky-empty-stderr'], { timeoutMs: 5_000, stderr: 'pipe' })
  expect(await readText(missing.stderr)).toBe('')
  expect((await missing.exited).spawnError?.code).toBe('ENOENT')
})

test.each([
  { kind: 'SIGTERM stop', signal: 'SIGTERM' as const, grace: false },
  { kind: 'SIGKILL stop', signal: 'SIGKILL' as const, grace: false },
  { kind: 'default disposal', signal: undefined, grace: false },
  { kind: 'graceful-mode disposal', signal: undefined, grace: true },
])('10-12, 13a: $kind ends pending reads and releases source locks', async ({ signal, grace }) => {
  const cancellation = Promise.withResolvers<void>()
  const sourceError = new Error('uncooperative cancellation rejected')
  const stdout = controlledSource(() => cancellation.promise)
  const stderr = controlledSource(() => cancellation.promise)
  const started = controlledChild({
    stdout: stdout.stream,
    stderr: stderr.stream,
  })
  const value = runner({ start: (() => started) as StartChild })
  const child = value.spawn(['/fake/stop-pending-read'], {
    timeoutMs: 5_000, stderr: 'pipe', groupGrace: grace,
  })
  const outputReader = child.stdout.getReader()
  const errorReader = child.stderr.getReader()
  const outputRead = outputReader.read()
  const errorRead = errorReader.read()
  let result
  if (signal) result = await child.stop({ signal })
  else {
    const disposal = value.dispose()
    result = await child.exited
    await disposal
  }
  expect(result.exitCode).toBeNull()
  expect(result.signal).toBe(signal ?? 'SIGKILL')
  expect(result.durationMs).toBeGreaterThanOrEqual(0)
  expect(Number.isInteger(result.durationMs)).toBe(true)
  expect(result.stopped).toBe(signal ? 'stop' : 'aborted')
  expect(await outputRead).toEqual({ value: undefined, done: true })
  expect(await errorRead).toEqual({ value: undefined, done: true })
  outputReader.releaseLock()
  errorReader.releaseLock()
  await flushTerminalMicrotasks()
  expect(stdout.cancellations()).toBe(1)
  expect(stderr.cancellations()).toBe(1)
  expect(stdout.stream.locked).toBe(false)
  expect(stderr.stream.locked).toBe(false)
  cancellation.reject(sourceError)
  await flushTerminalMicrotasks()
}, 5_000)

test('11: a second stop returns the same exit object after canceling both source streams once', async () => {
  const stdout = controlledSource()
  const stderr = controlledSource()
  const started = controlledChild({ stdout: stdout.stream, stderr: stderr.stream })
  const child = runner({ start: (() => started) as StartChild }).spawn(['/fake/repeated-stop'], {
    timeoutMs: 5_000, stderr: 'pipe',
  })
  const first = await child.stop()
  const second = await child.stop()
  expect(second).toBe(first)
  expect(first.stopped).toBe('stop')
  expect(stdout.cancellations()).toBe(1)
  expect(stderr.cancellations()).toBe(1)
})

test('13a: EOF and consumer cancellation release both source reader locks', async () => {
  const stdoutEof = controlledSource()
  const stderrEof = controlledSource()
  stdoutEof.controller().close()
  stderrEof.controller().close()
  const naturalExit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>()
  const naturalChild: StartedChild = {
    pid: 900_011,
    stdout: stdoutEof.stream,
    stderr: stderrEof.stream,
    exited: naturalExit.promise,
    killGroup() {},
  }
  const completed = runner({ start: (() => naturalChild) as StartChild }).spawn(['/fake/eof'], {
    timeoutMs: 5_000, stderr: 'pipe',
  })
  const [out, err] = [readText(completed.stdout), readText(completed.stderr)]
  naturalExit.resolve({ exitCode: 0, signal: null })
  await Promise.all([out, err, completed.exited])
  await flushTerminalMicrotasks()
  expect(stdoutEof.stream.locked).toBe(false)
  expect(stderrEof.stream.locked).toBe(false)

  const stdoutCancel = controlledSource()
  const stderrCancel = controlledSource()
  const cancelExit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>()
  const cancelChild: StartedChild = {
    pid: 900_012,
    stdout: stdoutCancel.stream,
    stderr: stderrCancel.stream,
    exited: cancelExit.promise,
    killGroup() {},
  }
  const cancelled = runner({ start: (() => cancelChild) as StartChild }).spawn(['/fake/consumer-cancel'], {
    timeoutMs: 5_000, stderr: 'pipe',
  })
  await Promise.all([cancelled.stdout.cancel(), cancelled.stderr.cancel()])
  cancelExit.resolve({ exitCode: 0, signal: null })
  await cancelled.exited
  await flushTerminalMicrotasks()
  expect(stdoutCancel.stream.locked).toBe(false)
  expect(stderrCancel.stream.locked).toBe(false)
  expect(stdoutCancel.cancellations()).toBe(1)
  expect(stderrCancel.cancellations()).toBe(1)
})

test.each(['stdout', 'stderr'] as const)('13: natural %s stall errors after cleanup and releases the source lock', async channel => {
  const stalled = controlledSource()
  const output = channel === 'stdout' ? stalled.stream : new ReadableStream<Uint8Array>({ start(controller) { controller.close() } })
  const errorOutput = channel === 'stderr' ? stalled.stream : new ReadableStream<Uint8Array>({ start(controller) { controller.close() } })
  const exit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>()
  const started: StartedChild = {
    pid: 900_013,
    stdout: output,
    stderr: errorOutput,
    exited: exit.promise,
    killGroup() {},
  }
  const child = runner({ start: (() => started) as StartChild, stallMs: 20 }).spawn(['/fake/natural-stall'], {
    timeoutMs: 5_000, stderr: 'pipe',
  })
  const reader = (channel === 'stdout' ? child.stdout : child.stderr).getReader()
  const pendingRead = reader.read().then(() => undefined, error => error)
  exit.resolve({ exitCode: 0, signal: null })
  expect((await child.exited).exitCode).toBe(0)
  const error = await pendingRead
  expect(error).toBeInstanceOf(ProcessStalledError)
  reader.releaseLock()
  await flushTerminalMicrotasks()
  expect(stalled.stream.locked).toBe(false)
}, 5_000)

test('13a: read errors release source locks after the terminal microtasks', async () => {
  const pipeError = new Error('stdout pipe failed')
  const stdout = new ReadableStream<Uint8Array>({ start(controller) { controller.error(pipeError) } })
  const stderr = controlledSource()
  stderr.controller().close()
  const exit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>()
  const started: StartedChild = {
    pid: 900_014,
    stdout,
    stderr: stderr.stream,
    exited: exit.promise,
    killGroup() {},
  }
  const child = runner({ start: (() => started) as StartChild }).spawn(['/fake/read-error'], {
    timeoutMs: 5_000, stderr: 'pipe',
  })
  const reader = child.stdout.getReader()
  const stderrRead = readText(child.stderr)
  const read = reader.read().then(() => undefined, error => error)
  exit.resolve({ exitCode: 0, signal: null })
  expect(await read).toBe(pipeError)
  expect(await stderrRead).toBe('')
  reader.releaseLock()
  await flushTerminalMicrotasks()
  expect(stdout.locked).toBe(false)
  expect(stderr.stream.locked).toBe(false)
})

test.each([
  { action: 'stop', groupGrace: false },
  { action: 'dispose', groupGrace: true },
])('10: $action settles with piped output nobody reads', async ({ action, groupGrace }) => {
  const stdout = controlledSource()
  const stderr = controlledSource()
  const started = controlledChild({ stdout: stdout.stream, stderr: stderr.stream })
  const value = runner({ start: (() => started) as StartChild })
  const child = value.spawn(['/fake/unread-stop'], {
    timeoutMs: 5_000, stderr: 'pipe', groupGrace,
  })
  if (action === 'stop') await child.stop()
  else await value.dispose()
  await flushTerminalMicrotasks()
  expect(stdout.cancellations()).toBe(1)
  expect(stderr.cancellations()).toBe(1)
  expect(stdout.stream.locked).toBe(false)
  expect(stderr.stream.locked).toBe(false)
}, 5_000)

test('many streamed chunks do not interfere with eventual group cleanup', async () => {
  let next = 0
  const stdout = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next === 4_096) controller.close()
      else controller.enqueue(new Uint8Array([next++ & 0xff]))
    },
  }, { highWaterMark: 0 })
  const exit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>()
  const started: StartedChild = {
    pid: 900_015,
    stdout,
    stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }),
    exited: exit.promise,
    killGroup() {},
    groupAlive() { return false },
  }
  const child = runner({ start: (() => started) as StartChild }).spawn(['/fake/many-output-reads'], {
    timeoutMs: null, stderr: 'ignore',
  })
  const bytes = await readBytes(child.stdout)
  expect(bytes.byteLength).toBe(4_096)
  exit.resolve({ exitCode: 0, signal: null })
  expect((await child.exited).exitCode).toBe(0)
  await flushTerminalMicrotasks()
  expect(stdout.locked).toBe(false)
})

test.each([false, true])('22: SIGKILL stop after group completion closes remaining streams (groupGrace=%s)', async groupGrace => {
  const stdout = controlledSource()
  const stderr = controlledSource()
  stdout.controller().enqueue(new TextEncoder().encode('unread-out'))
  stderr.controller().enqueue(new TextEncoder().encode('unread-err'))
  const exit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>()
  const signals: Array<'SIGTERM' | 'SIGKILL'> = []
  const started: StartedChild = {
    pid: 900_016,
    stdout: stdout.stream,
    stderr: stderr.stream,
    exited: exit.promise,
    killGroup(signal) { signals.push(signal) },
    groupAlive() { return false },
  }
  const child = runner({ start: (() => started) as StartChild }).spawn(['/fake/late-hard-stop'], {
    timeoutMs: 5_000, stderr: 'pipe', groupGrace,
  })
  exit.resolve({ exitCode: 0, signal: null })
  const result = await child.exited
  const signalsAtExit = signals.length
  expect(result.exitCode).toBe(0)
  expect(result.stopped).toBeUndefined()

  expect(await child.stop({ signal: 'SIGKILL' })).toBe(result)
  expect(signals).toHaveLength(signalsAtExit)
  expect(await readText(child.stdout)).toBe('')
  expect(await readText(child.stderr)).toBe('')
  await flushTerminalMicrotasks()
  expect(stdout.cancellations()).toBe(1)
  expect(stderr.cancellations()).toBe(1)
  expect(stdout.stream.locked).toBe(false)
  expect(stderr.stream.locked).toBe(false)
}, 5_000)

test('22: disposal after graceful group cleanup closes remaining output without a new signal', async () => {
  const stdout = controlledSource()
  const stderr = controlledSource()
  stdout.controller().enqueue(new TextEncoder().encode('unread'))
  const exit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>()
  const groupChecked = Promise.withResolvers<void>()
  const signals: Array<'SIGTERM' | 'SIGKILL'> = []
  const started: StartedChild = {
    pid: 900_017,
    stdout: stdout.stream,
    stderr: stderr.stream,
    exited: exit.promise,
    killGroup(signal) { signals.push(signal) },
    groupAlive() {
      groupChecked.resolve()
      return false
    },
  }
  const value = runner({ start: (() => started) as StartChild, stallMs: 10_000 })
  const child = value.spawn(['/fake/dispose-after-group'], {
    timeoutMs: 5_000, groupGrace: true,
  })
  exit.resolve({ exitCode: 0, signal: null })
  await groupChecked.promise
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(value.live()).toHaveLength(1)

  const disposal = value.dispose()
  const result = await child.exited
  await disposal
  expect(result.exitCode).toBe(0)
  expect(result.stopped).toBeUndefined()
  expect(signals).toEqual([])
  expect(await readText(child.stdout)).toBe('')
  await flushTerminalMicrotasks()
  expect(stdout.cancellations()).toBe(1)
  expect(stderr.cancellations()).toBe(1)
  expect(stdout.stream.locked).toBe(false)
  expect(stderr.stream.locked).toBe(false)
}, 5_000)

const badSpawnCalls: ReadonlyArray<{
  name: string
  argv: readonly string[]
  options: unknown
  error: typeof TypeError | typeof RangeError
  message: string
}> = [
  { name: 'empty argv', argv: [], options: { timeoutMs: 1_000 }, error: TypeError, message: 'argv must name a command' },
  { name: 'missing timeout', argv: ['/bin/true'], options: {}, error: RangeError, message: 'timeoutMs must be a positive finite number or null' },
  { name: 'zero timeout', argv: ['/bin/true'], options: { timeoutMs: 0 }, error: RangeError, message: 'timeoutMs must be a positive finite number or null' },
  { name: 'negative timeout', argv: ['/bin/true'], options: { timeoutMs: -1 }, error: RangeError, message: 'timeoutMs must be a positive finite number or null' },
  { name: 'NaN timeout', argv: ['/bin/true'], options: { timeoutMs: Number.NaN }, error: RangeError, message: 'timeoutMs must be a positive finite number or null' },
  { name: 'infinite timeout', argv: ['/bin/true'], options: { timeoutMs: Number.POSITIVE_INFINITY }, error: RangeError, message: 'timeoutMs must be a positive finite number or null' },
  { name: 'negative kill grace', argv: ['/bin/true'], options: { timeoutMs: 1_000, killGraceMs: -1 }, error: RangeError, message: 'killGraceMs must be zero or a positive finite number' },
  { name: 'zero stderr tail', argv: ['/bin/true'], options: { timeoutMs: 1_000, stderrTailBytes: 0 }, error: RangeError, message: 'stderrTailBytes must be a positive integer' },
  { name: 'fractional stderr tail', argv: ['/bin/true'], options: { timeoutMs: 1_000, stderrTailBytes: 1.5 }, error: RangeError, message: 'stderrTailBytes must be a positive integer' },
  { name: 'inherited stdin', argv: ['/bin/true'], options: { timeoutMs: 1_000, stdin: 'inherit' }, error: TypeError, message: 'stdin must be "pipe" or "ignore"' },
  { name: 'inherited stdout', argv: ['/bin/true'], options: { timeoutMs: 1_000, stdout: 'inherit' }, error: TypeError, message: 'stdout must be "pipe" or "ignore"' },
  { name: 'unknown stderr', argv: ['/bin/true'], options: { timeoutMs: 1_000, stderr: 'other' }, error: TypeError, message: 'stderr must be "tail", "ignore" or "pipe"' },
]

test('33: invalid spawn arguments throw synchronously before starting a child', () => {
  let starts = 0
  const value = runner({ start: (() => { starts++; throw new Error('must not start') }) as StartChild })
  for (const invalid of badSpawnCalls) {
    let thrown: unknown
    try {
      value.spawn(invalid.argv, invalid.options as SpawnOptions)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(invalid.error)
    expect((thrown as Error).message).toBe(invalid.message)
    expect(starts).toBe(0)
  }
}, 15_000)

test('33: an invalid stop grace throws without signaling the child', async () => {
  const signals: Array<'SIGTERM' | 'SIGKILL'> = []
  const exited = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>()
  const started = {
    pid: 900_000,
    stdout: new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }),
    stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }),
    exited: exited.promise,
    killGroup(signal: 'SIGTERM' | 'SIGKILL') {
      signals.push(signal)
      exited.resolve({ exitCode: null, signal })
    },
  }
  const value = runner({ start: (() => started) as StartChild })
  const child = value.spawn(['/fake/stop-validation'], { timeoutMs: 5_000 })
  let thrown: unknown
  try {
    child.stop({ graceMs: -1 })
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(RangeError)
  expect((thrown as Error).message).toBe('graceMs must be zero or a positive finite number')
  expect(signals).toEqual([])
  await child.stop({ signal: 'SIGKILL' })
  expect(signals.every(signal => signal === 'SIGKILL')).toBe(true)
}, 15_000)

test('a stderr-tail allocation failure cannot leave an untracked child', () => {
  let starts = 0
  const value = runner({
    start: () => {
      starts++
      return {
        pid: 900_001,
        stdout: new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }),
        stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }),
        exited: Promise.resolve({ exitCode: 0, signal: null }),
        killGroup() {},
      }
    },
  })
  expect(() => value.spawn(['/fake/allocation'], { timeoutMs: 1_000, stderrTailBytes: 2 ** 53 })).toThrow(RangeError)
  expect(starts).toBe(0)
}, 15_000)
