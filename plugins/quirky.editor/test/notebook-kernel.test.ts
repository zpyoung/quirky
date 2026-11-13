import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProcessRunner, liveProcesses, type OwnedProcessRunner, type SpawnExit, type SpawnOptions, type SpawnedProcess, type StopOptions } from '../../../packages/process/src/api'
import type { ProcessSpawner } from '@quirky/protocol'
import { KernelSession, type KernelFrame } from '../src/notebook/kernel'
import type { PythonEnvironment } from '../src/notebook/python'

const runners: OwnedProcessRunner[] = []
const roots: string[] = []

function runner(): OwnedProcessRunner {
  const value = createProcessRunner({ owner: 'quirky.editor' })
  runners.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(runners.splice(0).map((value) => value.dispose()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type Fixture = {
  process: ProcessSpawner
  calls: Array<{ argv: readonly string[]; options: SpawnOptions }>
  python: PythonEnvironment
  cwd: string
  bridgePath: string
  home: string
  quirkyHome: string
  runner: OwnedProcessRunner
}

function fixture(bridge: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'quirky-notebook-kernel-'))
  roots.push(root)
  const home = join(root, 'home')
  const quirkyHome = join(root, 'quirky-home')
  const cwd = join(root, 'work')
  mkdirSync(home, { recursive: true })
  mkdirSync(quirkyHome, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  const bridgePath = join(root, 'bridge.js')
  const interpreter = join(root, 'python')
  writeFileSync(bridgePath, bridge)
  writeFileSync(interpreter, '#!/bin/sh\nshift\nexec bun "$@"\n')
  chmodSync(interpreter, 0o755)
  const calls: Fixture['calls'] = []
  const processRunner = runner()
  return {
    process: {
      spawn(argv, options) {
        calls.push({ argv, options })
        return processRunner.spawn(argv, options)
      }
    },
    calls,
    python: {
      path: interpreter,
      name: 'fixture-python',
      version: '3.12',
      source: 'selected',
      hasIpykernel: true,
      hasPip: true,
      externallyManaged: false
    },
    cwd,
    bridgePath,
    home,
    quirkyHome,
    runner: processRunner
  }
}

const fakeBridge = `
const readline = require('node:readline')
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n')
send({ type: 'ready' })
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line)
  if (request.op !== 'execute') return
  if (request.code === 'exit-3') process.exit(3)
  if (request.code === 'done-exit') {
    process.stdout.write(JSON.stringify({ type: 'done', status: 'ok', execution_count: 7 }) + '\\n', () => process.exit(0))
    return
  }
  if (request.code === 'slow-exit') {
    process.stdout.write(JSON.stringify({ type: 'stream', content: { text: 'late' } }) + '\\n')
    setTimeout(() => process.exit(3), 50)
    return
  }
  if (request.code === 'stay') {
    send({ type: 'stream', content: { text: 'waiting' } })
    return
  }
  send({ type: 'stream', content: { text: 'hi' } })
  send({ type: 'done', status: 'ok', execution_count: 1 })
})
`

function sessionFrom(f: Fixture, timing?: { shutdownGraceMs?: number; exitDrainMs?: number }, onStatusChange?: (session: KernelSession) => void): KernelSession {
  return new KernelSession(f.process, f.python, f.cwd, f.bridgePath, f.home, onStatusChange, f.quirkyHome, timing)
}

function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

test('17-18: runs the fake bridge through the runner and shuts it down', async () => {
  const f = fixture(fakeBridge)
  const session = sessionFrom(f)
  const started = await session.start()
  expect(started.status).toBe('ready')
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0]!.argv).toEqual([f.python.path, '-u', f.bridgePath])
  expect(f.calls[0]!.options).toMatchObject({ timeoutMs: null, stdin: 'pipe', killGraceMs: 5000, stderrTailBytes: 16384, cwd: f.cwd })
  expect(f.calls[0]!.options.env).toMatchObject({
    HOME: f.home,
    QUIRKY_HOME: f.quirkyHome,
    USERPROFILE: f.home,
    XDG_CONFIG_HOME: join(f.home, 'xdg-config'),
    JUPYTER_CONFIG_DIR: join(f.home, 'jupyter', 'config'),
    JUPYTER_DATA_DIR: join(f.home, 'jupyter', 'data'),
    JUPYTER_RUNTIME_DIR: join(f.home, 'jupyter', 'runtime'),
    IPYTHONDIR: join(f.home, 'ipython')
  })
  const frames: KernelFrame[] = []
  expect(await session.execute('x', async (frame) => { frames.push(frame) })).toMatchObject({ status: 'ok', executionCount: 1 })
  expect(frames).toEqual([{ type: 'stream', content: { text: 'hi' } }])
  const pid = session.pid!
  expect(pid).toBeGreaterThan(0)
  expect(liveProcesses().some((entry) => entry.owner === 'quirky.editor' && entry.pid === pid)).toBe(true)
  await session.shutdown()
  expect(session.status).toBe('stopped')
  expect(f.runner.live()).toHaveLength(0)
  expect(processGone(pid)).toBe(true)
})

test('19: a bridge that exits during execution fails the active cell', async () => {
  const session = sessionFrom(fixture(fakeBridge))
  expect((await session.start()).status).toBe('ready')
  expect(await session.execute('exit-3', async () => {})).toMatchObject({ status: 'dead' })
  expect(session.status).toBe('dead')
  expect(session.error).toBe('kernel bridge exited with code 3')
})

test('20: a missing interpreter reports its startup error and shuts down promptly', async () => {
  const f = fixture(fakeBridge)
  const python = { ...f.python, path: join(f.cwd, 'missing-python') }
  const transitions: string[] = []
  const session = new KernelSession(f.process, python, f.cwd, f.bridgePath, f.home, (value) => transitions.push(value.status), f.quirkyHome)
  const began = Date.now()
  const result = await session.start()
  expect(result.status).toBe('failed')
  const detail = result.status === 'failed' ? result.detail : ''
  expect(detail).toContain('ENOENT')
  expect(session.error).toBe(detail)
  expect(transitions).toEqual(['dead', 'stopping', 'stopped'])
  expect(session.status).toBe('stopped')
  expect(Date.now() - began).toBeLessThan(1000)
})

test('21: complete frames written before bridge exit are handled first', async () => {
  const session = sessionFrom(fixture(fakeBridge))
  expect((await session.start()).status).toBe('ready')
  expect(await session.execute('done-exit', async () => {})).toMatchObject({ status: 'ok', executionCount: 7 })
})

test('22: an unresolved frame callback cannot keep an exited bridge alive', async () => {
  const session = sessionFrom(fixture(fakeBridge))
  expect((await session.start()).status).toBe('ready')
  const began = Date.now()
  const result = await session.execute('slow-exit', () => new Promise<void>(() => {}))
  expect(result.status).toBe('dead')
  expect(session.status).toBe('dead')
  expect(Date.now() - began).toBeLessThan(3000)
})

test('23: shutdown invalidates a held frame callback and settles queued executions', async () => {
  const session = sessionFrom(fixture(fakeBridge), { shutdownGraceMs: 50 })
  expect((await session.start()).status).toBe('ready')
  const called = Promise.withResolvers<void>()
  const blocked = session.execute('stay', () => {
    called.resolve()
    return new Promise<void>(() => {})
  })
  const queued = session.execute('queued', async () => {})
  await called.promise
  await session.shutdown()
  expect(await blocked).toMatchObject({ status: 'dead' })
  expect(await queued).toMatchObject({ status: 'dead' })
  expect(session.status).toBe('stopped')
  expect(processGone(session.pid!)).toBe(true)
})


type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

type HandMade = {
  handle: SpawnedProcess
  push(value: string): void
  pushBytes(value: Uint8Array): void
  end(): void
  fail(error: unknown): void
  exit(value?: Partial<SpawnExit>): void
  stopCalls: StopOptions[]
}

function handMade(options: {
  write?: (value: string) => Promise<boolean>
  closeInput?: () => Promise<void>
  stderr?: () => string
  stop?: (options: StopOptions | undefined, exit: (value?: Partial<SpawnExit>) => void) => Promise<SpawnExit>
} = {}): HandMade {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stdout = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
  const exitResult = deferred<SpawnExit>()
  const stopCalls: StopOptions[] = []
  const exit = (value: Partial<SpawnExit> = {}) => {
    try { controller.close() } catch {}
    exitResult.resolve({ exitCode: 0, signal: null, durationMs: 0, ...value })
  }
  const handle: SpawnedProcess = {
    pid: 4242,
    stdout,
    stderrTail: options.stderr ?? (() => ''),
    write: options.write ?? (async () => true),
    closeInput: options.closeInput ?? (async () => {}),
    exited: exitResult.promise,
    stop: async (stopOptions) => {
      stopCalls.push(stopOptions ?? {})
      if (options.stop) return options.stop(stopOptions, exit)
      exit({ exitCode: null, signal: stopOptions?.signal ?? 'SIGTERM', stopped: 'stop' })
      return exitResult.promise
    }
  }
  const encoder = new TextEncoder()
  return {
    handle,
    push(value) { controller.enqueue(encoder.encode(value)) },
    pushBytes(value) { controller.enqueue(value) },
    end() { controller.close() },
    fail(error) { controller.error(error) },
    exit,
    stopCalls
  }
}

function handSession(handle: SpawnedProcess, timing?: { shutdownGraceMs?: number; exitDrainMs?: number }, onStatusChange?: (session: KernelSession) => void): KernelSession {
  const process: ProcessSpawner = { spawn: () => handle }
  const root = mkdtempSync(join(tmpdir(), 'quirky-notebook-kernel-hand-'))
  roots.push(root)
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  const python: PythonEnvironment = { path: '/fake/python', name: 'python', version: '3', source: 'selected', hasIpykernel: true, hasPip: true, externallyManaged: false }
  return new KernelSession(process, python, root, join(root, 'bridge.py'), home, onStatusChange, home, timing)
}

async function startHand(handle: HandMade, timing?: { shutdownGraceMs?: number; exitDrainMs?: number }, onStatusChange?: (session: KernelSession) => void): Promise<KernelSession> {
  const session = handSession(handle.handle, timing, onStatusChange)
  const started = session.start()
  handle.push('{"type":"ready"}\n')
  expect((await started).status).toBe('ready')
  return session
}

for (const callbackOutcome of ['resolve', 'reject'] as const) {
  test(`23a: shutdown drops buffered frames after a late callback ${callbackOutcome}`, async () => {
    const callback = deferred<void>()
    const called = deferred<void>()
    let frameCalls = 0
    const hand = handMade({
      write: async () => {
        hand.push('{"type":"stream","content":{"text":"held"}}\n{"type":"done","status":"ok","execution_count":9}\n{"type":"missing"}\n')
        return true
      }
    })
    const statuses: string[] = []
    const session = await startHand(hand, { shutdownGraceMs: 10 }, (value) => statuses.push(value.status))
    const first = session.execute('first', () => {
      frameCalls++
      called.resolve()
      return callback.promise
    })
    const second = session.execute('second', async () => {})
    await called.promise
    await session.shutdown()
    expect(await first).toMatchObject({ status: 'dead', executionCount: null })
    expect(await second).toMatchObject({ status: 'dead', executionCount: null })
    expect(session.status).toBe('stopped')
    const statusesAtStop = [...statuses]
    if (callbackOutcome === 'resolve') callback.resolve()
    else callback.reject(new Error('late callback failure'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(session.status).toBe('stopped')
    expect(session.executionCount).toBeNull()
    expect(frameCalls).toBe(1)
    expect(statuses).toEqual(statusesAtStop)
  })
}

for (const callbackOutcome of ['resolve', 'reject'] as const) {
  test(`23a: bridge exit drains only for its bound after callback ${callbackOutcome}`, async () => {
    const callback = deferred<void>()
    const called = deferred<void>()
    let frameCalls = 0
    const hand = handMade({
      write: async () => {
        hand.push('{"type":"stream","content":{"text":"held"}}\n{"type":"done","status":"ok","execution_count":9}\n{"type":"missing"}\n')
        return true
      }
    })
    const statuses: string[] = []
    const session = await startHand(hand, { exitDrainMs: 50 }, (value) => statuses.push(value.status))
    const first = session.execute('first', () => {
      frameCalls++
      called.resolve()
      return callback.promise
    })
    const second = session.execute('second', async () => {})
    await called.promise
    hand.exit({ exitCode: 3 })
    expect(await first).toMatchObject({ status: 'dead', executionCount: null })
    expect(await second).toMatchObject({ status: 'dead', executionCount: null })
    expect(session.status).toBe('dead')
    const statusesAtDeath = [...statuses]
    if (callbackOutcome === 'resolve') callback.resolve()
    else callback.reject(new Error('late callback failure'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(session.status).toBe('dead')
    expect(session.executionCount).toBeNull()
    expect(frameCalls).toBe(1)
    expect(statuses).toEqual(statusesAtDeath)
  })
}

test('24: shutdown does not wait for writes or closeInput before SIGKILL', async () => {
  const never = new Promise<boolean>(() => {})
  const hand = handMade({
    write: () => never,
    closeInput: () => new Promise<void>(() => {})
  })
  const session = await startHand(hand, { shutdownGraceMs: 50 })
  const execution = session.execute('blocked', async () => {})
  await session.shutdown()
  expect(hand.stopCalls).toEqual([{ signal: 'SIGKILL' }])
  expect(session.status).toBe('stopped')
  expect(await execution).toMatchObject({ status: 'dead' })
})

test('25: a failed write kills the kernel and makes interrupt a no-op', async () => {
  let hand!: HandMade
  hand = handMade({ write: async () => false })
  const session = await startHand(hand)
  expect(await session.execute('blocked', async () => {})).toMatchObject({ status: 'dead' })
  expect(hand.stopCalls).toHaveLength(1)
  expect(await session.interrupt()).toEqual({ interrupted: false, stalled: false })
})

test('interrupt reports and stops after its stdin write fails', async () => {
  let writes = 0
  const hand = handMade({ write: async () => ++writes === 1 })
  const session = await startHand(hand)
  const execution = session.execute('active', async () => {})
  expect(await session.interrupt()).toEqual({ interrupted: false, stalled: false })
  expect(await execution).toMatchObject({ status: 'dead' })
  expect(session.status).toBe('dead')
  expect(hand.stopCalls).toHaveLength(1)
})

test('an onFrame rejection before invalidation is a protocol failure', async () => {
  let hand!: HandMade
  hand = handMade({ write: async () => { hand.push('{"type":"stream"}\n'); return true } })
  const session = await startHand(hand)
  expect(await session.execute('reject-frame', async () => { throw new Error('callback failed') })).toMatchObject({ status: 'dead' })
  expect(session.error).toBe('callback failed')
  expect(hand.stopCalls).toHaveLength(1)
})

test('25a: protocol diagnostics and stderr form one 4,000-character tail', async () => {
  const hand = handMade({ stderr: () => 'é'.repeat(5000), write: async () => { hand.push('not json\n'); return true } })
  const session = await startHand(hand)
  const result = await session.execute('malformed', async () => {})
  const expected = `${'é'.repeat(3964)}\nkernel bridge sent malformed NDJSON`
  expect(result).toMatchObject({ status: 'dead', stderr: expected })
  expect(session.stderr).toBe(expected)
  expect((await session.execute('again', async () => {})).stderr).toBe(expected)
  expect(session.error).toBe('kernel bridge sent malformed NDJSON')
})

test('25a: non-protocol stderr remains available without being rewritten', async () => {
  const hand = handMade({ stderr: () => 'oops' })
  const session = await startHand(hand)
  expect(session.stderr).toBe('oops')
})

test('25b: a live stdout read failure kills active and queued executions once', async () => {
  const hand = handMade()
  const session = await startHand(hand)
  const first = session.execute('active', async () => {})
  const second = session.execute('queued', async () => {})
  hand.fail(new Error('read failed'))
  expect(await first).toMatchObject({ status: 'dead' })
  expect(await second).toMatchObject({ status: 'dead' })
  expect(session.error).toBe('kernel bridge stdout failed: read failed')
  expect(hand.stopCalls).toHaveLength(1)
})

test('25b: stdout read errors after shutdown invalidation do not change diagnostics', async () => {
  const hand = handMade({ closeInput: () => new Promise<void>(() => {}) })
  const session = await startHand(hand, { shutdownGraceMs: 10 })
  const beforeError = session.error
  const shutdown = session.shutdown()
  hand.fail(new Error('late read failure'))
  await shutdown
  expect(session.status).toBe('stopped')
  expect(session.error).toBe(beforeError)
  expect(session.stderr).toBe('')
})

test('stdout decoding preserves UTF-8 characters split between byte chunks', async () => {
  let hand!: HandMade
  hand = handMade({ write: async () => {
    const bytes = new TextEncoder().encode('{"type":"stream","content":{"text":"hé"}}\n{"type":"done","status":"ok","execution_count":2}\n')
    const split = bytes.indexOf(0xc3) + 1
    hand.pushBytes(bytes.slice(0, split))
    hand.pushBytes(bytes.slice(split))
    return true
  } })
  const session = await startHand(hand)
  const frames: KernelFrame[] = []
  expect(await session.execute('utf8', async (frame) => { frames.push(frame) })).toMatchObject({ status: 'ok', executionCount: 2 })
  expect(frames[0]!.content).toEqual({ text: 'hé' })
})
