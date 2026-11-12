import { afterEach, expect, test } from 'bun:test'
import {
  createProcessRunner,
  liveProcesses,
  ProcessRunnerDisposedError,
  stopAllProcesses,
  type OwnedProcessRunner,
} from '../src/api'

const runners: OwnedProcessRunner[] = []

function runner(owner = 'test') {
  const value = createProcessRunner({ owner })
  runners.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(runners.splice(0).map(value => value.dispose()))
})

async function waitForLive(value: OwnedProcessRunner, count: number) {
  const until = Date.now() + 1_000
  while (value.live().length !== count && Date.now() < until) await Bun.sleep(10)
  expect(value.live()).toHaveLength(count)
  return value.live()
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

test('34: spawned children are listed while alive and removed after stop', async () => {
  const value = runner()
  const child = value.spawn(['/bin/sh', '-c', 'sleep 5'], { timeoutMs: 10_000 })
  if (child.pid === null) throw new Error('child did not start')
  const [entry] = await waitForLive(value, 1)
  expect(entry).toEqual({
    pid: child.pid,
    owner: 'test',
    command: '/bin/sh',
    startedAt: expect.any(Number),
  })
  expect(Math.abs(Date.now() - entry!.startedAt)).toBeLessThan(5_000)
  expect(liveProcesses()).toContainEqual(entry)

  await child.stop()
  expect(value.live()).toEqual([])
  expect(liveProcesses()).not.toContainEqual(entry)
}, 15_000)

test('35: dispose kills spawned and running children and waits for both', async () => {
  const value = runner()
  const child = value.spawn(
    ['/bin/sh', '-c', "trap '' TERM; while :; do sleep 1; done"],
    { timeoutMs: 10_000 },
  )
  const pendingRead = child.stdout.getReader().read()
  const pendingRun = value.run(['/bin/sh', '-c', 'sleep 5'], { timeoutMs: 10_000 })
  const entries = await waitForLive(value, 2)
  const runEntry = entries.find(entry => entry.command === '/bin/sh' && entry.pid !== child.pid)
  expect(runEntry).toBeDefined()

  await value.dispose()
  await expectGone(child.pid!)
  await expectGone(runEntry!.pid)
  const result = await child.exited
  expect(result.stopped).toBe('aborted')
  expect(result.signal).toBe('SIGKILL')
  expect(await pendingRead).toEqual({ value: undefined, done: true })
  expect((await pendingRun).stopped).toBe('aborted')
  expect(value.live()).toEqual([])
}, 15_000)

test('36: spawn after dispose throws ProcessRunnerDisposedError', async () => {
  const value = runner()
  await value.dispose()
  let thrown: unknown
  try {
    value.spawn(['/bin/cat'], { timeoutMs: 1_000 })
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(ProcessRunnerDisposedError)
  expect((thrown as Error).message).toBe('process runner "test" is disposed')
}, 15_000)

test('37: stopAll kills children across runners without disposing either runner', async () => {
  const a = runner('a')
  const b = runner('b')
  const childA = a.spawn(['/bin/sh', '-c', 'sleep 30'], { timeoutMs: 10_000 })
  const childB = b.spawn(['/bin/sh', '-c', 'sleep 30'], { timeoutMs: 10_000 })
  await waitForLive(a, 1)
  await waitForLive(b, 1)

  await stopAllProcesses()
  await expectGone(childA.pid!)
  await expectGone(childB.pid!)
  expect((await childA.exited).stopped).toBe('aborted')
  expect((await childB.exited).stopped).toBe('aborted')
  expect(liveProcesses()).toEqual([])

  const nextA = a.spawn(['/bin/echo', 'a'], { timeoutMs: 5_000 })
  const nextB = b.spawn(['/bin/echo', 'b'], { timeoutMs: 5_000 })
  expect(await readText(nextA.stdout)).toBe('a\n')
  expect(await readText(nextB.stdout)).toBe('b\n')
  expect((await nextA.exited).exitCode).toBe(0)
  expect((await nextB.exited).exitCode).toBe(0)
}, 15_000)
