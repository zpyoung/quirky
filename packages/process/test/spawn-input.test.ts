import { afterEach, expect, test } from 'bun:test'
import { createProcessRunner, type OwnedProcessRunner } from '../src/api'

const runners: OwnedProcessRunner[] = []

function runner() {
  const value = createProcessRunner({ owner: 'test' })
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

test('9: a written line reaches cat and closeInput sends end of input', async () => {
  const child = runner().spawn(['/bin/cat'], { stdin: 'pipe', timeoutMs: 5_000 })
  expect(await child.write('abc\n')).toBe(true)
  const reader = child.stdout.getReader()
  const first = await reader.read()
  expect(first.done).toBe(false)
  let echoed = new TextDecoder().decode(first.value)
  const closed = child.closeInput()
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    echoed += new TextDecoder().decode(next.value)
  }
  reader.releaseLock()
  await closed
  expect(echoed).toBe('abc\n')
  expect((await child.exited).exitCode).toBe(0)
}, 15_000)

test('10: writes called without awaiting retain call order', async () => {
  const child = runner().spawn(['/bin/cat'], { stdin: 'pipe', timeoutMs: 5_000 })
  const first = child.write('1\n')
  const second = child.write('2\n')
  const third = child.write('3\n')
  const closed = child.closeInput()
  expect(await Promise.all([first, second, third])).toEqual([true, true, true])
  await closed
  expect(new TextDecoder().decode(await readBytes(child.stdout))).toBe('1\n2\n3\n')
  expect((await child.exited).exitCode).toBe(0)
}, 15_000)

test('11: Uint8Array writes preserve bytes exactly', async () => {
  const child = runner().spawn(['/bin/cat'], { stdin: 'pipe', timeoutMs: 5_000 })
  expect(await child.write(new Uint8Array([0, 255, 10]))).toBe(true)
  await child.closeInput()
  expect(await readBytes(child.stdout)).toEqual(new Uint8Array([0, 255, 10]))
  expect((await child.exited).exitCode).toBe(0)
}, 15_000)

test('12: closing input is idempotent and rejects later writes as false', async () => {
  const child = runner().spawn(['/bin/cat'], { stdin: 'pipe', timeoutMs: 5_000 })
  await child.closeInput()
  await child.closeInput()
  expect(await child.write('x')).toBe(false)
  expect(await readBytes(child.stdout)).toEqual(new Uint8Array())
  expect((await child.exited).exitCode).toBe(0)
}, 15_000)

test('13: writes after child exit resolve false without unhandled rejection', async () => {
  const child = runner().spawn(['/bin/sh', '-c', 'exit 0'], { stdin: 'pipe', timeoutMs: 5_000 })
  await child.exited
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    expect(await child.write('x')).toBe(false)
    await Bun.sleep(0)
    expect(unhandled).toEqual([])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
}, 15_000)

test('14: a blocked large write resolves false when the child is stopped', async () => {
  const child = runner().spawn(['/bin/sh', '-c', 'sleep 30'], { stdin: 'pipe', timeoutMs: 10_000 })
  let settled = false
  const pending = child.write(new Uint8Array(4 * 1024 * 1024)).then(result => {
    settled = true
    return result
  })
  // the child never reads stdin; allow the real pipe to fill before killing it
  await Bun.sleep(20)
  expect(settled).toBe(false)
  const result = await child.stop({ signal: 'SIGKILL' })
  expect(result.signal).toBe('SIGKILL')
  expect(await pending).toBe(false)
}, 15_000)

test('15: ignored stdin is already closed', async () => {
  const child = runner().spawn(['/bin/cat'], { timeoutMs: 5_000 })
  expect(await child.write('x')).toBe(false)
  expect(await readBytes(child.stdout)).toEqual(new Uint8Array())
  expect((await child.exited).exitCode).toBe(0)
}, 15_000)
