import { afterEach, expect, test } from 'bun:test'
import { createProcessRunner, liveProcesses, stopAllProcesses, ProcessRunnerDisposedError, type OwnedProcessRunner } from '../src/api'
import type { StartChild } from '../src/child'

const runners: OwnedProcessRunner[] = []
function runner(owner = 'test', extra: { start?: StartChild; stallMs?: number } = {}) {
  const value = createProcessRunner({ owner, ...extra })
  runners.push(value)
  return value
}
async function started(value: OwnedProcessRunner, count = 1) {
  const until = Date.now() + 1_000
  while (value.live().length !== count && Date.now() < until) await Bun.sleep(10)
  expect(value.live()).toHaveLength(count)
  return value.live()
}
async function expectGone(pid: number) {
  const until = Date.now() + 1_000
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
  const pending = [a.run(['/bin/sleep', '0.2'], options), b.run(['/bin/sleep', '0.2'], options)]
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

test('disposal while an exited child has a stalled pipe prevents another attempt', async () => {
  let starts = 0
  const exited = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>()
  const value = runner('stall', {
    stallMs: 25,
    start: () => {
      starts++
      return {
        pid: 2_000_000_000,
        stdout: new ReadableStream(),
        stderr: new ReadableStream({ start(controller) { controller.close() } }),
        exited: exited.promise,
        killGroup() {}
      }
    }
  })
  const pending = value.run(['fake'], { rerunnable: true, timeoutMs: 1_000 }).then(result => result, error => error)
  expect(value.live()).toHaveLength(1)
  exited.resolve({ exitCode: 0, signal: null })
  await exited.promise
  expect(value.live()).toEqual([])
  expect(liveProcesses()).toEqual([])
  await value.dispose()
  await pending
  expect(starts).toBe(1)
  expect(value.live()).toEqual([])
})

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
})
