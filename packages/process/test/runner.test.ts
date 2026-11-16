import { afterEach, expect, test } from 'bun:test'
import { createProcessRunner, liveProcesses, stopAllProcesses, ProcessRunnerDisposedError, type OwnedProcessRunner } from '../src/api'
import type { StartChild } from '../src/child'

const runners: OwnedProcessRunner[] = []
function runner(owner = 'test', extra: { start?: StartChild; stallMs?: number } = {}) {
  const value = createProcessRunner({ owner, ...extra })
  runners.push(value)
  return value
}
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`${label} timed out after ${timeoutMs}ms`)
    await Bun.sleep(Math.min(10, remaining))
  }
}
async function started(value: OwnedProcessRunner, count = 1) {
  const until = Date.now() + 2_000
  while (value.live().length !== count && Date.now() < until) await Bun.sleep(10)
  expect(value.live()).toHaveLength(count)
  return value.live()
}
async function expectGone(pid: number) {
  const until = Date.now() + 2_000
  do {
    try { process.kill(pid, 0) } catch { return }
    await Bun.sleep(20)
  } while (Date.now() < until)
  throw new Error(`pid ${pid} survived`)
}

afterEach(async () => {
  await Promise.all(runners.splice(0).map(value => value.dispose()))
})

test('26: children are listed until their leader exits', async () => {
  const value = runner()
  const pending = value.run(['/bin/sh', '-c', 'sleep 0.2'], { timeoutMs: 5_000 })
  const [entry] = await started(value)
  expect(entry!.pid).toBeGreaterThan(0)
  expect(Number.isInteger(entry!.pid)).toBe(true)
  expect(entry!.owner).toBe('test')
  expect(entry!.command).toBe('/bin/sh')
  expect(Math.abs(Date.now() - entry!.startedAt)).toBeLessThan(5_000)
  expect(liveProcesses()).toContainEqual(entry)
  const result = await pending
  expect(result.exitCode).toBe(0)
  expect(value.live()).toEqual([])
  expect(liveProcesses()).not.toContainEqual(entry)
}, 15_000)

test('27: live entries are isolated by owner', async () => {
  const a = runner('a')
  const b = runner('b')
  const options = { timeoutMs: 5_000 }
  const pending = [a.run(['/bin/sleep', '0.15'], options), b.run(['/bin/sleep', '0.35'], options)]
  const [aEntry] = await started(a)
  const [bEntry] = await started(b)
  expect(aEntry!.owner).toBe('a')
  expect(bEntry!.owner).toBe('b')
  expect(a.live()).not.toContainEqual(bEntry)
  expect(b.live()).not.toContainEqual(aEntry)
  expect(liveProcesses()).toEqual(expect.arrayContaining([aEntry, bEntry]))
  await Promise.all(pending)
}, 15_000)

test('28: dispose immediately kills all groups and waits for aborted results', async () => {
  const value = runner()
  const pending = [
    value.run(['/bin/sh', '-c', 'sleep 30'], { timeoutMs: 5_000 }),
    value.run(['/bin/sh', '-c', "trap '' TERM; while :; do sleep 1; done"], { timeoutMs: 5_000 })
  ]
  const entries = await started(value, 2)
  await value.dispose()
  for (const entry of entries) await expectGone(entry.pid)
  for (const result of await Promise.all(pending)) {
    expect(result.stopped).toBe('aborted')
    expect(result.signal).toBe('SIGKILL')
  }
  expect(value.live()).toEqual([])
}, 15_000)

test('29: a disposed runner rejects every run and disposal is idempotent', async () => {
  const value = runner()
  await value.dispose()
  const error = await value.run(['/bin/echo', 'no'], { timeoutMs: 5_000 }).then(() => null, error => error)
  expect(error).toBeInstanceOf(ProcessRunnerDisposedError)
  expect(error.message).toBe('process runner "test" is disposed')
  await value.dispose()
  expect(value.live()).toEqual([])
}, 15_000)

test('30: stop-all waits for every aborted child without disposing runners', async () => {
  const a = runner('a')
  const b = runner('b')
  const pending = [a.run(['/bin/sleep', '30'], { timeoutMs: 5_000 }), b.run(['/bin/sleep', '30'], { timeoutMs: 5_000 })]
  const entries = [...await started(a), ...await started(b)]
  await stopAllProcesses()
  for (const entry of entries) await expectGone(entry.pid)
  for (const result of await Promise.all(pending)) expect(result.stopped).toBe('aborted')
  expect(liveProcesses()).toEqual([])
  const next = await Promise.all([a.run(['/bin/echo', 'a'], { timeoutMs: 5_000 }), b.run(['/bin/echo', 'b'], { timeoutMs: 5_000 })])
  expect(next.map(result => result.stdoutText)).toEqual(['a\n', 'b\n'])
}, 15_000)

test('disposal while an exited child has a stalled pipe aborts without waiting out the stall or retrying', async () => {
  let starts = 0
  let settled = false
  const exited = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>()
  const signals: Array<'SIGTERM' | 'SIGKILL'> = []
  const value = runner('stall', {
    stallMs: 3_000,
    start: () => {
      starts++
      return {
        pid: 2_000_000_000,
        stdout: new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new TextEncoder().encode('part')) }
        }),
        stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }),
        exited: exited.promise,
        killGroup(signal) {
          signals.push(signal)
          if (signal === 'SIGKILL') exited.resolve({ exitCode: null, signal })
        }
      }
    }
  })
  const pending = value.run(['/fake/stall-dispose'], { rerunnable: true, timeoutMs: 5_000 })
    .then(result => { settled = true; return result }, error => { settled = true; return error })
  await started(value)
  exited.resolve({ exitCode: 0, signal: null })
  await waitFor(() => value.live().length === 0, 1_000, 'leader exit')
  expect(liveProcesses()).toEqual([])

  const disposedAt = Date.now()
  await withTimeout(value.dispose(), 1_500, 'dispose during post-exit stall')
  expect(Date.now() - disposedAt).toBeLessThan(1_500)
  expect(settled).toBe(true)
  const result = await withTimeout(pending, 1_000, 'stalled run settlement')
  expect(result).toMatchObject({
    stdoutText: 'part',
    stderr: '',
    exitCode: null,
    signal: null,
    stopped: 'aborted'
  })
  expect(starts).toBe(1)
  expect(signals).toEqual(['SIGKILL'])
  expect(value.live()).toEqual([])
}, 15_000)

test('stop-all while an exited rerunnable child has a stalled pipe aborts at once and prevents another attempt', async () => {
  let starts = 0
  let settled = false
  const firstExited = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>()
  const signals: Array<'SIGTERM' | 'SIGKILL'> = []
  const value = runner('stall-stop-all', {
    stallMs: 3_000,
    start: () => {
      starts++
      if (starts === 1) {
        return {
          pid: 2_000_000_001,
          stdout: new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(new TextEncoder().encode('first')) }
          }),
          stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }),
          exited: firstExited.promise,
          killGroup(signal) {
            signals.push(signal)
            if (signal === 'SIGKILL') firstExited.resolve({ exitCode: null, signal })
          }
        }
      }
      return {
        pid: 2_000_000_002,
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('second'))
            controller.close()
          }
        }),
        stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }),
        exited: Promise.resolve({ exitCode: 0, signal: null }),
        killGroup() {}
      }
    }
  })
  const pending = value.run(['/fake/stall-stop-all'], { rerunnable: true, timeoutMs: 5_000 })
    .then(result => { settled = true; return result }, error => { settled = true; return error })
  await started(value)
  firstExited.resolve({ exitCode: 0, signal: null })
  await waitFor(() => value.live().length === 0, 1_000, 'first leader exit')
  expect(liveProcesses()).toEqual([])

  const stoppedAt = Date.now()
  await withTimeout(stopAllProcesses(), 1_500, 'stop-all during post-exit stall')
  expect(Date.now() - stoppedAt).toBeLessThan(1_500)
  expect(settled).toBe(true)
  const result = await withTimeout(pending, 1_000, 'stalled run settlement after stop-all')
  expect(result).toMatchObject({
    stdoutText: 'first',
    stderr: '',
    exitCode: null,
    signal: null,
    stopped: 'aborted'
  })
  expect(starts).toBe(1)
  expect(signals).toEqual(['SIGKILL'])

  const next = await withTimeout(
    value.run(['/fake/after-stop-all'], { timeoutMs: 5_000 }),
    5_000,
    'run after stop-all'
  )
  expect(next.exitCode).toBe(0)
  expect(next.stdoutText).toBe('second')
  expect(starts).toBe(2)
}, 15_000)

test('retry attribution uses the argument snapshot even if the caller mutates argv', async () => {
  let starts = 0
  const retried = Promise.withResolvers<void>()
  const exited = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>()
  const value = runner('snapshot', {
    stallMs: 1,
    start: argv => {
      starts++
      expect(argv[0]).toBe('original-command')
      if (starts === 2) retried.resolve()
      return {
        pid: 2_000_000_000 + starts,
        stdout: starts === 1 ? new ReadableStream() : new ReadableStream({ start(controller) { controller.close() } }),
        stderr: new ReadableStream({ start(controller) { controller.close() } }),
        exited: starts === 1 ? Promise.resolve({ exitCode: 0, signal: null }) : exited.promise,
        killGroup(signal) {
          if (starts === 2) exited.resolve({ exitCode: null, signal })
        }
      }
    }
  })
  const argv = ['original-command']
  const pending = value.run(argv, { rerunnable: true, timeoutMs: 1_000 })
  argv[0] = 'changed-command'
  await retried.promise
  expect(value.live()[0]?.command).toBe('original-command')
  expect(liveProcesses()[0]?.command).toBe('original-command')
  exited.resolve({ exitCode: 0, signal: null })
  const result = await pending
  expect(result.exitCode).toBe(0)
  expect(starts).toBe(2)
}, 15_000)
