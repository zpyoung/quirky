import { afterEach, expect, test } from 'bun:test'
import { createProcessRunner, ProcessStalledError, type OwnedProcessRunner } from '../src/api'
import type { ChildExit, StartChild, StartedChild } from '../src/child'

const runners: OwnedProcessRunner[] = []
let nextPid = 800_000

function runner(start: StartChild) {
  const value = createProcessRunner({ owner: 'spawn-stall-test', start, stallMs: 50 })
  runners.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(runners.splice(0).map(value => value.dispose()))
})

function stream(chunks: readonly Uint8Array[] = [], close = true): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      if (close) controller.close()
    },
  })
}

function fakeChild(options: {
  stdout?: ReadableStream<Uint8Array>
  stderr?: ReadableStream<Uint8Array>
  exited?: Promise<ChildExit>
  killGroup?: (signal: 'SIGTERM' | 'SIGKILL') => void
} = {}): StartedChild {
  return {
    pid: nextPid++,
    stdout: options.stdout ?? stream(),
    stderr: options.stderr ?? stream(),
    exited: options.exited ?? Promise.resolve({ exitCode: 0, signal: null }),
    killGroup: options.killGroup ?? (() => {}),
  }
}

test('30: a naturally exited child reports a stalled stdout read', async () => {
  const child = fakeChild({ stdout: stream([new TextEncoder().encode('part')], false) })
  const value = runner((() => child) as StartChild)
  const spawned = value.spawn(['/fake/stalled-stdout'], { timeoutMs: 5_000 })
  const reader = spawned.stdout.getReader()

  const first = await reader.read()
  expect(first.done).toBe(false)
  expect(new TextDecoder().decode(first.value)).toBe('part')
  const result = await spawned.exited
  expect(result.exitCode).toBe(0)

  const error = await reader.read().then(() => undefined, reason => reason)
  expect(error).toBeInstanceOf(ProcessStalledError)
  expect((error as ProcessStalledError).attempts).toBe(1)
  expect((error as Error).message).toBe('/fake/stalled-stdout exited but its output did not end')
  reader.releaseLock()
}, 15_000)

test('31: stopping a child closes a stalled stdout read without rejecting', async () => {
  const exited = Promise.withResolvers<ChildExit>()
  const child = fakeChild({
    stdout: stream([], false),
    exited: exited.promise,
    killGroup: () => exited.resolve({ exitCode: null, signal: 'SIGTERM' }),
  })
  const spawned = runner((() => child) as StartChild).spawn(['/fake/stopped-stdout'], { timeoutMs: 5_000 })
  const reader = spawned.stdout.getReader()
  const pendingRead = reader.read()

  const result = await spawned.stop()
  expect(result.stopped).toBe('stop')
  expect(await pendingRead).toEqual({ value: undefined, done: true })
  reader.releaseLock()
}, 15_000)

test('32: a stalled stderr is abandoned while its final tail is returned', async () => {
  const child = fakeChild({ stderr: stream([new TextEncoder().encode('warn')], false) })
  const spawned = runner((() => child) as StartChild).spawn(['/fake/stalled-stderr'], { timeoutMs: 5_000 })
  const result = await spawned.exited
  expect(result.exitCode).toBe(0)
  expect(spawned.stderrTail()).toBe('warn')
}, 15_000)
