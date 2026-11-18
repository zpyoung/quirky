import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createProcessRunner,
  DEFAULT_STDERR_TAIL_BYTES,
  liveProcesses,
  type OwnedProcessRunner,
  type SpawnOptions,
} from '../src/api'
import type { StartChild } from '../src/child'

const runners: OwnedProcessRunner[] = []

function runner(extra: { start?: StartChild; stallMs?: number } = {}) {
  const value = createProcessRunner({ owner: 'test', ...extra })
  runners.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(runners.splice(0).map(value => value.dispose()))
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
  { name: 'piped stderr', argv: ['/bin/true'], options: { timeoutMs: 1_000, stderr: 'pipe' }, error: TypeError, message: 'stderr must be "tail" or "ignore"' },
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
