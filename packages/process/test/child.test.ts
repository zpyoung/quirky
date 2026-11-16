import { afterEach, expect, test } from 'bun:test'
import { startChild, type StartChild, type StartedChild } from '../src/child'

const children: Array<{ child: StartedChild; exited: boolean }> = []

function start(argv: readonly string[], init: Parameters<StartChild>[1] = {}): StartedChild {
  const child = startChild(argv, init)
  const started = { child, exited: false }
  children.push(started)
  const deadline = setTimeout(() => child.killGroup('SIGKILL'), 10_000)
  void child.exited.then(() => {
    started.exited = true
    clearTimeout(deadline)
  })
  return child
}

afterEach(async () => {
  const started = children.splice(0)
  for (const entry of started) {
    if (!entry.exited) entry.child.killGroup('SIGKILL')
  }
  await Promise.all(started.map(({ child }) => child.exited))
})

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  reader.releaseLock()
  return text + decoder.decode()
}

async function processGroupId(pid: number): Promise<number> {
  const child = start(['/bin/ps', '-o', 'pgid=', '-p', String(pid)])
  const stdout = readText(child.stdout)
  const exit = await child.exited
  expect(exit.exitCode).toBe(0)
  return Number.parseInt((await stdout).trim(), 10)
}

async function waitForProcessToExit(pid: number): Promise<void> {
  const deadline = Date.now() + 1_000
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    if (Date.now() >= deadline) throw new Error(`process ${pid} is still running`)
    // detached descendants expose no completion event, so poll the operating system
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 20)
    await promise
  }
}

test('starts the child as a process-group leader', async () => {
  const child = start(['/bin/sleep', '30'])
  const childGroupId = await processGroupId(child.pid)
  const testGroupId = await processGroupId(process.pid)
  expect(childGroupId).toBe(child.pid)
  expect(childGroupId).not.toBe(testGroupId)
}, 15_000)

test('kills the whole process group with the requested signal', async () => {
  const child = start(['/bin/sh', '-c', 'sleep 30 & echo $!; wait'])
  const reader = child.stdout.getReader()
  let output = ''
  while (!output.includes('\n')) {
    const { done, value } = await reader.read()
    if (done) throw new Error('child exited before printing its descendant pid')
    output += new TextDecoder().decode(value, { stream: true })
  }
  const descendantPid = Number.parseInt(output.slice(0, output.indexOf('\n')).trim(), 10)
  expect(descendantPid).toBeGreaterThan(0)
  child.killGroup('SIGTERM')
  const exit = await child.exited
  reader.releaseLock()
  expect(exit.signal).toBe('SIGTERM')
  await waitForProcessToExit(descendantPid)
}, 15_000)

test('ignores a group kill after the child has exited', async () => {
  const child = start(['/bin/sh', '-c', 'exit 0'])
  const exit = await child.exited
  expect(exit.exitCode).toBe(0)
  expect(() => child.killGroup('SIGTERM')).not.toThrow()
}, 15_000)

test('throws the spawn error for a missing binary', async () => {
  let error: unknown
  try {
    start(['/nonexistent/quirky-no-such-binary'])
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(Error)
  expect((error as NodeJS.ErrnoException).code).toBe('ENOENT')
}, 15_000)

test('flushes byte-exact piped stdin and ends it after queued bytes', async () => {
  const child = start(['/bin/cat'], { stdin: 'pipe' })
  const output = new Response(child.stdout).arrayBuffer()
  expect(child.stdin).toBeDefined()
  child.stdin!.write(new Uint8Array([0, 255, 10]))
  await child.stdin!.flush()
  await child.stdin!.end()
  expect(new Uint8Array(await output)).toEqual(new Uint8Array([0, 255, 10]))
  const exit = await child.exited
  expect(exit.exitCode).toBe(0)
}, 15_000)

test('discards stdout without exposing a pipe', async () => {
  const child = start(['/bin/sh', '-c', 'printf ignored'], { stdout: 'ignore' })
  const first = await child.stdout.getReader().read()
  expect(first.done).toBe(true)
  const exit = await child.exited
  expect(exit.exitCode).toBe(0)
}, 15_000)
