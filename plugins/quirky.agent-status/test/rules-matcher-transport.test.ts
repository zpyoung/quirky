import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import type { PluginContext, ProcessSpawner, SpawnedProcess, SpawnExit, SpawnOptions, StopOptions } from '@quirky/protocol'
import { fileURLToPath } from 'node:url'
import { createProcessRunner, ProcessStalledError, type OwnedProcessRunner } from '../../../packages/process/src/api'
import { Matcher } from '../src/rules/matcher'
import { AgentStatusService } from '../src/service'
import type { ActivityFeed } from '../src/activity'
import type { RowStore } from '../src/store'
import type { Origin, RuleFile } from '../src/rules/types'

const encoder = new TextEncoder()
const origin: Origin = { kind: 'built-in', path: '/rules/fake.json' }
const file: RuleFile = { agent: 'fake', rules: [{ id: 'busy', state: 'working', region: 'screen', all: [{ regex: 'esc to interrupt' }] }] }
const input = { title: '', lines: ['esc to interrupt'], quietForMs: null }
const match = { line: 'build: 3 tests', match: 'tests', groups: [] }
const shutdown = { unavailable: 'the matcher was shut down' }
const invalid = { unavailable: 'could not read from the matcher process: invalid matcher frame' }
const cleanups: (() => void | Promise<void>)[] = []
const deferred = <T>() => Promise.withResolvers<T>()
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }

class Child implements SpawnedProcess {
  pid: number | null = 12345
  readonly exit = deferred<SpawnExit>()
  readonly exited = this.exit.promise
  readonly writes: string[] = []
  readonly stops: (StopOptions | undefined)[] = []
  readonly stopped = deferred<SpawnExit>()
  controller!: ReadableStreamDefaultController<Uint8Array>
  cancellations = 0
  ended = false
  holdStop = false
  holdExit = false
  writeResult: (data: string) => Promise<boolean> = async () => true
  readonly stdout = new ReadableStream<Uint8Array>({
    start: (controller) => { this.controller = controller },
    cancel: () => { this.cancellations++; this.ended = true }
  })
  readonly stderr = new ReadableStream<Uint8Array>({ start: controller => controller.close() })
  stderrTail() { return '' }
  write(data: string | Uint8Array) {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
    this.writes.push(text)
    return this.writeResult(text)
  }
  async closeInput() { this.eof() }
  stop(options?: StopOptions) {
    this.stops.push(options)
    if (!this.holdStop) this.finish()
    return this.stopped.promise
  }
  send(value: unknown) { this.bytes(encoder.encode(`${JSON.stringify(value)}\n`)) }
  bytes(value: Uint8Array) { if (!this.ended) this.controller.enqueue(value) }
  eof() { if (!this.ended) { this.ended = true; this.controller.close() } }
  fail(error: Error) { if (!this.ended) { this.ended = true; this.controller.error(error) } }
  finish() {
    const value: SpawnExit = { exitCode: null, signal: 'SIGKILL', durationMs: 0 }
    this.eof()
    if (!this.holdExit) this.exit.resolve(value)
    this.stopped.resolve(value)
  }
}

class Recorder implements ProcessSpawner {
  readonly calls: { argv: readonly string[]; options: SpawnOptions; child: Child }[] = []
  readonly children: Child[] = []
  error: Error | undefined
  spawn(argv: readonly string[], options: SpawnOptions) {
    if (this.error) throw this.error
    const child = this.children.shift() ?? new Child()
    this.calls.push({ argv: [...argv], options, child })
    return child
  }
}

type Fixture = { recorder: Recorder; child: Child; matcher: Matcher }

function fixture(scale = '1') {
  const recorder = new Recorder()
  const child = new Child()
  recorder.children.push(child)
  const matcher = new Matcher(recorder, { env: scale === 'absent' ? {} : { QUIRKY_TEST_AGENT_STATUS_TIME_SCALE: scale } })
  cleanups.push(async () => {
    matcher.dispose()
    for (const call of recorder.calls) call.child.finish()
    await flush()
    for (const call of recorder.calls) expect(call.child.stdout.locked).toBe(false)
  })
  return { recorder, child, matcher }
}

async function started(f: Fixture) {
  await flush()
  expect(f.recorder.calls).toHaveLength(1)
  return f.child
}

async function ready(f: Fixture) {
  await started(f)
  f.child.send({ ready: true })
  await flush()
}

function clock() {
  let now = 100_000
  let next = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const delays: number[] = []
  const set = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, delay = 0) => {
    const id = ++next
    delays.push(delay)
    timers.set(id, { at: now + delay, fn })
    return id
  }) as typeof setTimeout)
  const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(((id: number) => { timers.delete(Number(id)) }) as typeof clearTimeout)
  const date = spyOn(Date, 'now').mockImplementation(() => now)
  cleanups.unshift(() => {
    try { expect(timers.size).toBe(0) }
    finally { set.mockRestore(); clear.mockRestore(); date.mockRestore() }
  })
  return {
    delays,
    now: () => now,
    async advance(ms: number) {
      const end = now + ms
      for (;;) {
        const first = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!first) break
        now = first[1].at
        timers.delete(first[0])
        first[1].fn()
        await flush()
      }
      now = end
      await flush()
    }
  }
}

function watch<T>(promise: Promise<T>) {
  let done = false
  void promise.then(() => { done = true })
  return () => done
}

afterEach(async () => {
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'matcher fixture cleanup failed')
})

describe('owned matcher transport', () => {
  test('lazily starts exactly one owned worker and reuses ordered JSONL requests', async () => {
    const f = fixture()
    expect(f.recorder.calls).toEqual([])
    const first = f.matcher.matchLines('tests', false, ['build: 3 tests'])
    await started(f)
    expect(f.recorder.calls[0]!.argv).toEqual([process.execPath, fileURLToPath(new URL('../src/rules/matcher-worker.ts', import.meta.url))])
    expect(f.recorder.calls[0]!.options).toEqual({ timeoutMs: null, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
    expect(f.child.writes).toEqual([])
    f.child.send({ ready: true })
    await flush()
    expect(f.child.writes).toEqual(['{"id":1,"op":"line","pattern":"tests","ignoreCase":false,"lines":["build: 3 tests"]}\n'])
    f.child.send({ id: 1, result: match })
    expect(await first).toEqual(match)
    const second = f.matcher.matchLines('zzz', false, ['x'])
    await flush()
    expect(JSON.parse(f.child.writes[1]!).id).toBe(2)
    expect(f.recorder.calls).toHaveLength(1)
    f.child.send({ id: 2, result: null })
    expect(await second).toBeNull()
  })

  test('incremental frames preserve large UTF-8 strings, escaping, CRLF and unrelated ids', async () => {
    const f = fixture()
    const text = `${'a'.repeat(70_000)}尾🙂"\\\n`
    const result = { line: text, match: text, groups: [text] }
    const pending = f.matcher.matchLines('.*', false, [text])
    const done = watch(pending)
    await started(f)
    f.child.bytes(encoder.encode('{"ready":'))
    await flush()
    expect(f.child.writes).toEqual([])
    f.child.bytes(encoder.encode('true}\r\n'))
    await flush()
    expect(JSON.parse(f.child.writes[0]!).lines).toEqual([text])
    f.child.bytes(encoder.encode('{"ready":true}\n{"id":999,"result":null}\n'))
    const bytes = encoder.encode(JSON.stringify({ id: 1, result }))
    const suffix = bytes.indexOf(0xe5)
    f.child.bytes(bytes.slice(0, suffix))
    for (const byte of bytes.slice(suffix)) f.child.bytes(Uint8Array.of(byte))
    await flush()
    expect(done()).toBe(false)
    f.child.bytes(encoder.encode('\n'))
    expect(await pending).toEqual(result)
  })

  test('spawn exceptions resolve unavailable without a raw fallback', async () => {
    const f = fixture()
    f.recorder.error = new Error('disposed fixture')
    expect(await f.matcher.matchLines('x', false, ['x'])).toEqual({ unavailable: 'could not start the matcher process: disposed fixture' })
    expect(f.recorder.calls).toHaveLength(0)
  })

  test('failed spawn diagnostics win over closed stdout', async () => {
    const f = fixture()
    f.child.pid = null
    f.child.eof()
    f.child.exit.resolve({ exitCode: null, signal: null, durationMs: 0, spawnError: { code: 'ENOENT', message: 'missing fixture' } })
    const pending = f.matcher.matchLines('x', false, ['x'])
    await started(f)
    expect(await pending).toEqual({ unavailable: 'could not start the matcher process: missing fixture' })
    expect(f.child.stops).toEqual([{ signal: 'SIGKILL' }])
  })

  test('a startup read rejection is unavailable and releases the reader', async () => {
    const f = fixture()
    const pending = f.matcher.matchLines('x', false, ['x'])
    await started(f)
    f.child.fail(new Error('read fixture'))
    expect(await pending).toEqual({ unavailable: 'could not read from the matcher process: read fixture' })
    expect(f.child.stops).toEqual([{ signal: 'SIGKILL' }])
  })

  test('readiness uses an unscaled 5000 ms timer', async () => {
    const time = clock()
    const f = fixture('0.2')
    const pending = f.matcher.matchLines('x', false, ['x'])
    const done = watch(pending)
    await started(f)
    expect(time.delays).toContain(5000)
    await time.advance(4999)
    expect(done()).toBe(false)
    await time.advance(1)
    expect(await pending).toEqual({ unavailable: 'the matcher process did not start in time' })
    expect(f.child.stops).toEqual([{ signal: 'SIGKILL' }])
  })

  for (const scale of ['absent', '1', '0', '-1', 'no', '0.2', '0.4']) {
    test(`execution budget includes blocked writes at scale ${scale}`, async () => {
      const time = clock()
      const f = fixture(scale)
      f.child.writeResult = () => deferred<boolean>().promise
      const pending = f.matcher.matchLines('x', false, ['x'])
      const done = watch(pending)
      await ready(f)
      const budget = scale === '0.2' ? 50 : scale === '0.4' ? 100 : 250
      expect(time.delays).toContain(budget)
      await time.advance(budget - 1)
      expect(done()).toBe(false)
      await time.advance(1)
      expect(await pending).toEqual({ timedOut: true })
      expect(f.child.stops).toEqual([{ signal: 'SIGKILL' }])
    })
  }

  test('replacement waits for cleanup while disposal answers the retirement queue immediately', async () => {
    const time = clock()
    const f = fixture('0.2')
    f.child.holdStop = true
    const first = f.matcher.matchLines('x', false, ['x'])
    await ready(f)
    await time.advance(50)
    expect(await first).toEqual({ timedOut: true })
    const second = f.matcher.matchLines('x', false, ['x'])
    const secondDone = watch(second)
    await flush()
    expect(f.recorder.calls).toHaveLength(1)
    expect(secondDone()).toBe(false)
    expect(f.matcher.dispose()).toBeUndefined()
    f.matcher.dispose()
    expect(await second).toEqual(shutdown)
    expect(await f.matcher.matchLines('x', false, ['x'])).toEqual(shutdown)
    f.child.finish()
    await flush()
    expect(f.recorder.calls).toHaveLength(1)
  })

  test('a stopped generation is replaced only after its held cleanup completes', async () => {
    const time = clock()
    const f = fixture('0.2')
    f.child.holdStop = true
    const first = f.matcher.matchLines('x', false, ['x'])
    await ready(f)
    await time.advance(50)
    expect(await first).toEqual({ timedOut: true })
    const next = new Child()
    f.recorder.children.push(next)
    const pending = f.matcher.matchLines('tests', false, ['build: 3 tests'])
    await flush()
    expect(f.recorder.calls).toHaveLength(1)
    f.child.finish()
    await flush()
    expect(f.recorder.calls).toHaveLength(2)
    next.send({ ready: true })
    await flush()
    expect(JSON.parse(next.writes[0]!).id).toBe(2)
    next.send({ id: 2, result: match })
    expect(await pending).toEqual(match)
  })

  for (const operation of ['evaluate', 'line'] as const) {
    test(`queued ${operation} expires without a write but an executing deadline does not cancel`, async () => {
      const time = clock()
      const f = fixture()
      const first = f.matcher.matchLines('tests', false, ['build: 3 tests'], time.now() + 5)
      await ready(f)
      const pending = operation === 'evaluate'
        ? f.matcher.evaluate(file, input, origin, time.now() + 10)
        : f.matcher.matchLines('tests', false, ['build: 3 tests'], time.now() + 10)
      await time.advance(10)
      expect(await pending).toEqual({ expired: true })
      expect(f.child.writes).toHaveLength(1)
      f.child.send({ id: 1, result: match })
      expect(await first).toEqual(match)
      await flush()
      expect(f.child.writes).toHaveLength(1)
      const expired = await f.matcher.matchLines('x', false, ['x'], time.now() - 1)
      expect(expired).toEqual({ expired: true })
      expect(f.recorder.calls).toHaveLength(1)
    })
  }

  test('deadline stops governing a request as soon as startup begins', async () => {
    const time = clock()
    const f = fixture()
    const pending = f.matcher.matchLines('x', false, ['x'], time.now() + 5)
    const done = watch(pending)
    await started(f)
    await time.advance(10)
    expect(done()).toBe(false)
    f.child.send({ ready: true })
    await flush()
    f.child.send({ id: 1, result: null })
    expect(await pending).toBeNull()
  })

  for (const phase of ['starting', 'ready', 'idle'] as const) {
    for (const event of ['EOF', 'exit'] as const) {
      test(`${event} while ${phase} retires the child and lazily recovers`, async () => {
        const f = fixture()
        const pending = f.matcher.matchLines('x', false, ['x'])
        await started(f)
        if (phase !== 'starting') await ready(f)
        if (phase === 'idle') { f.child.send({ id: 1, result: null }); expect(await pending).toBeNull() }
        if (event === 'EOF') f.child.eof()
        else f.child.exit.resolve({ exitCode: 1, signal: null, durationMs: 0 })
        if (phase !== 'idle') expect(await pending).toEqual({ unavailable: phase === 'starting' ? 'the matcher process exited before it was ready' : 'the matcher process exited' })
        await flush()
        expect(f.child.stops).toEqual([{ signal: 'SIGKILL' }])
        expect(f.recorder.calls).toHaveLength(1)
        expect(f.child.stdout.locked).toBe(false)
        const replacement = new Child()
        f.recorder.children.push(replacement)
        const next = f.matcher.matchLines('x', false, ['x'])
        await flush()
        expect(f.recorder.calls).toHaveLength(2)
        replacement.send({ ready: true })
        await flush()
        replacement.send({ id: JSON.parse(replacement.writes[0]!).id, result: null })
        expect(await next).toBeNull()
      })
    }
  }

  for (const failure of ['false', 'throw', 'reject', 'read', 'stall'] as const) {
    test(`${failure} pipe failure is observed and retires its generation`, async () => {
      const f = fixture()
      if (failure === 'false') f.child.writeResult = async () => false
      if (failure === 'throw') f.child.writeResult = () => { throw new Error('write fixture') }
      if (failure === 'reject') f.child.writeResult = async () => { throw new Error('write fixture') }
      const pending = f.matcher.matchLines('x', false, ['x'])
      await ready(f)
      if (failure === 'read') f.child.fail(new Error('read fixture'))
      if (failure === 'stall') f.child.fail(new ProcessStalledError('fixture', 1))
      const result = await pending
      if (failure === 'stall') expect(result).toEqual({ unavailable: expect.stringContaining('could not read from the matcher process:') })
      else expect(result).toEqual({ unavailable: failure === 'read'
        ? 'could not read from the matcher process: read fixture'
        : `could not reach the matcher process: ${failure === 'false' ? 'stdin is closed' : 'write fixture'}` })
      expect(f.child.stops).toEqual([{ signal: 'SIGKILL' }])
    })
  }

  const badFrames = ['no-json\n', '\n', 'null\n', '[]\n', 'true\n', '{"id":0,"result":null}\n', '{"id":1.5,"result":null}\n', '{"id":9007199254740992,"result":null}\n', '{"id":1}\n', '{"ready":false}\n', '{"id":1,"result":null}']
  for (const beforeReady of [true, false]) {
    for (const bad of [...badFrames, Uint8Array.of(0xff, 10)]) {
      test(`invalid frame ${JSON.stringify(bad)} ${beforeReady ? 'before' : 'after'} readiness fails closed`, async () => {
        const f = fixture()
        const pending = f.matcher.matchLines('x', false, ['x'])
        await started(f)
        if (!beforeReady) await ready(f)
        f.child.bytes(typeof bad === 'string' ? encoder.encode(bad) : bad)
        if (typeof bad === 'string' && !bad.endsWith('\n')) f.child.eof()
        expect(await pending).toEqual(invalid)
        expect(f.child.stops).toEqual([{ signal: 'SIGKILL' }])
        const replacement = new Child()
        f.recorder.children.push(replacement)
        const recovered = f.matcher.matchLines('tests', false, ['build: 3 tests'])
        await flush()
        expect(f.recorder.calls).toHaveLength(2)
        replacement.send({ ready: true })
        await flush()
        replacement.send({ id: JSON.parse(replacement.writes[0]!).id, result: match })
        expect(await recovered).toEqual(match)
      })
    }
  }

  for (const [name, bytes] of [
    ['invalid lead byte', [Uint8Array.of(0xff)]],
    ['split incomplete sequence', [Uint8Array.of(0xe5), Uint8Array.of(0xb0)]]
  ] as const) {
    test(`invalid UTF-8 inside response JSON (${name}) retires the reader and recovers`, async () => {
      const f = fixture()
      const pending = f.matcher.matchLines('x', false, ['x'])
      await ready(f)
      f.child.bytes(encoder.encode('{"id":1,"result":{"line":"'))
      for (const chunk of bytes) {
        f.child.bytes(chunk)
        await flush()
      }
      f.child.bytes(encoder.encode('","match":"x","groups":[]}}\n'))
      expect(await pending).toEqual(invalid)
      expect(f.child.stops).toEqual([{ signal: 'SIGKILL' }])
      await flush()
      expect(f.child.stdout.locked).toBe(false)
      expect(f.child.cancellations).toBe(1)
      const replacement = new Child()
      f.recorder.children.push(replacement)
      const recovered = f.matcher.matchLines('tests', false, ['build: 3 tests'])
      await flush()
      expect(f.recorder.calls).toHaveLength(2)
      replacement.send({ ready: true })
      await flush()
      replacement.send({ id: JSON.parse(replacement.writes[0]!).id, result: match })
      expect(await recovered).toEqual(match)
    })
  }

  for (const rejection of [false, true]) {
    test(`late ${rejection ? 'rejected' : 'closed'} write cannot stop a newer generation`, async () => {
      const time = clock()
      const f = fixture('0.2')
      const write = deferred<boolean>()
      f.child.holdExit = true
      f.child.writeResult = () => write.promise
      const first = f.matcher.matchLines('x', false, ['x'])
      await ready(f)
      await time.advance(50)
      expect(await first).toEqual({ timedOut: true })
      const replacement = new Child()
      f.recorder.children.push(replacement)
      const second = f.matcher.matchLines('x', false, ['x'])
      const done = watch(second)
      await flush()
      expect(f.recorder.calls).toHaveLength(2)
      replacement.send({ ready: true })
      await flush()
      if (rejection) write.reject(new Error('late fixture'))
      else write.resolve(false)
      f.child.exit.resolve({ exitCode: 1, signal: null, durationMs: 0 })
      await flush()
      expect(done()).toBe(false)
      expect(replacement.stops).toEqual([])
      replacement.send({ id: 2, result: null })
      expect(await second).toBeNull()
    })

    test(`late ${rejection ? 'rejected' : 'closed'} write on the same child cannot stop its next waiter`, async () => {
      const f = fixture()
      const write = deferred<boolean>()
      f.child.writeResult = () => write.promise
      const first = f.matcher.matchLines('x', false, ['x'])
      await ready(f)
      f.child.send({ id: 1, result: null })
      expect(await first).toBeNull()
      f.child.writeResult = async () => true
      const second = f.matcher.matchLines('x', false, ['x'])
      const done = watch(second)
      await flush()
      if (rejection) write.reject(new Error('late fixture'))
      else write.resolve(false)
      f.child.send({ id: 1, result: match })
      await flush()
      expect(done()).toBe(false)
      expect(f.child.stops).toEqual([])
      f.child.send({ id: 2, result: null })
      expect(await second).toBeNull()
    })
  }

  test('buffered data from a retired reader cannot answer a replacement request', async () => {
    const time = clock()
    const f = fixture('0.2')
    const release = deferred<void>()
    let held = false
    const getReader = f.child.stdout.getReader.bind(f.child.stdout)
    const readerSpy = spyOn(f.child.stdout, 'getReader').mockImplementation((() => {
      const reader = getReader()
      return {
        closed: reader.closed,
        async read() {
          const value = await reader.read()
          if (held && !value.done) await release.promise
          return value
        },
        cancel: reader.cancel.bind(reader),
        releaseLock: reader.releaseLock.bind(reader)
      }
    }) as typeof f.child.stdout.getReader)
    cleanups.push(() => { release.resolve(); readerSpy.mockRestore() })
    const first = f.matcher.matchLines('x', false, ['x'])
    await ready(f)
    held = true
    f.child.send({ id: 2, result: match })
    await flush()
    await time.advance(50)
    expect(await first).toEqual({ timedOut: true })
    const replacement = new Child()
    f.recorder.children.push(replacement)
    const second = f.matcher.matchLines('x', false, ['x'])
    const done = watch(second)
    await flush()
    expect(f.recorder.calls).toHaveLength(2)
    replacement.send({ ready: true })
    await flush()
    release.resolve()
    await flush()
    expect(done()).toBe(false)
    expect(replacement.stops).toEqual([])
    expect(f.child.stdout.locked).toBe(false)
    replacement.send({ id: 2, result: null })
    expect(await second).toBeNull()
  })

  test('disposal preserves an expired queued answer and never replaces a stopped child', async () => {
    const time = clock()
    const f = fixture()
    f.child.holdStop = true
    const active = f.matcher.matchLines('x', false, ['x'])
    await ready(f)
    const expired = f.matcher.matchLines('x', false, ['x'], time.now() + 10)
    const queued = f.matcher.evaluate(file, input, origin)
    await time.advance(10)
    expect(await expired).toEqual({ expired: true })
    f.matcher.dispose()
    expect(await active).toEqual(shutdown)
    expect(await queued).toEqual(shutdown)
    expect(await expired).toEqual({ expired: true })
    f.child.finish()
    await flush()
    expect(f.child.writes).toHaveLength(1)
    expect(f.recorder.calls).toHaveLength(1)
  })

  for (const phase of ['starting', 'executing', 'writing'] as const) {
    test(`dispose immediately settles active and queued work while ${phase}`, async () => {
      const f = fixture()
      f.child.holdStop = true
      if (phase === 'writing') f.child.writeResult = () => deferred<boolean>().promise
      const first = f.matcher.matchLines('x', false, ['x'])
      const second = f.matcher.evaluate(file, input, origin)
      await started(f)
      if (phase !== 'starting') await ready(f)
      f.matcher.dispose()
      f.matcher.dispose()
      await expect(Promise.all([first, second])).resolves.toEqual([shutdown, shutdown])
      expect(f.child.stops.length).toBeGreaterThan(0)
      expect(f.child.stops.every((options) => options?.signal === 'SIGKILL')).toBe(true)
      expect(await f.matcher.matchLines('x', false, ['x'], Date.now() - 1)).toEqual({ expired: true })
      f.child.finish()
      await flush()
      expect(f.recorder.calls).toHaveLength(1)
      expect(f.child.stdout.locked).toBe(false)
    })
  }
})

function owned() {
  const runner = createProcessRunner({ owner: 'g2-72-test' })
  cleanups.push(() => runner.dispose())
  return runner
}

function assertGone(pid: number) {
  expect(() => process.kill(pid, 0)).toThrow()
}

describe('real runner owns the matcher', () => {
  test('pathological regex exits before replacement while the event loop keeps ticking', async () => {
    const runner = owned()
    const matcher = new Matcher(runner, { env: { QUIRKY_TEST_AGENT_STATUS_TIME_SCALE: '0.2' } })
    cleanups.push(() => matcher.dispose())
    expect(await matcher.matchLines('tests', false, ['build: 3 tests'])).toEqual(match)
    expect(runner.live()).toHaveLength(1)
    expect(runner.live()[0]!.owner).toBe('g2-72-test')
    const pid = runner.live()[0]!.pid
    let beats = 0
    // a fake clock cannot show event-loop progress during a real pathological regex
    const timer = setInterval(() => { beats++ }, 5)
    try {
      expect(await matcher.matchLines('a+a+a+a+$', false, [`${'a'.repeat(30_000)}!`])).toEqual({ timedOut: true })
      expect(await matcher.evaluate(file, input, origin)).toEqual({ verdict: { rule: 'busy', state: 'working', origin } })
    } finally { clearInterval(timer) }
    console.log(`g2-72 matcher heartbeat ticks: ${beats}`)
    expect(beats).toBeGreaterThan(0)
    assertGone(pid)
    expect(runner.live()).toHaveLength(1)
    matcher.dispose()
    await runner.dispose()
    expect(runner.live()).toEqual([])
  })

  for (const pending of [false, true]) {
    test(`runner revocation owns ${pending ? 'pending' : 'idle'} worker and refuses replacement`, async () => {
      const runner = owned()
      const matcher = new Matcher(runner)
      cleanups.push(() => matcher.dispose())
      expect(await matcher.matchLines('tests', false, ['build: 3 tests'])).toEqual(match)
      expect(runner.live()).toHaveLength(1)
      const pid = runner.live()[0]!.pid
      const work = pending ? matcher.matchLines('a+a+a+a+$', false, [`${'a'.repeat(30_000)}!`]) : null
      await flush()
      await runner.dispose()
      if (work) expect(await work).toHaveProperty('unavailable')
      expect(runner.live()).toEqual([])
      assertGone(pid)
      expect(await matcher.matchLines('x', false, ['x'])).toEqual({ unavailable: expect.stringContaining('could not start the matcher process:') })
      expect(runner.live()).toEqual([])
    })
  }

  test('service waitOutput uses context runner and shutdown stops that child', async () => {
    const runner: OwnedProcessRunner = owned()
    const now = Date.now()
    const context = {
      pluginId: 'quirky.agent-status', dir: '/fixture/plugin', home: process.env.QUIRKY_HOME,
      process: runner, log: () => {}, emit: () => true,
      call: async (method: string) => method === 'quirky.session/get' ? { id: 's1', kind: 'terminal', status: 'running' } : [],
      pty: { list: async () => [], read: async () => ({ lines: ['build: 3 tests'], cols: 80, rows: 24, alt: false }) }
    } as unknown as PluginContext
    const service = new AgentStatusService(context, { get: () => null } as unknown as RowStore, {} as ActivityFeed, async () => true, () => now)
    cleanups.push(() => service.shutdown())
    expect(runner.live()).toEqual([])
    expect(await service.waitOutput('s1', { pattern: 'tests', ignoreCase: false, lines: 200, timeoutMs: 1000 })).toEqual({ status: 'matched', ...match, at: now })
    expect(runner.live()).toHaveLength(1)
    const pid = runner.live()[0]!.pid
    expect(service.shutdown()).toBeUndefined()
    await runner.dispose()
    expect(runner.live()).toEqual([])
    assertGone(pid)
  })
})

test('matcher no longer needs a spawn exemption and admits the spawn API', async () => {
  const baseline = await Bun.file(new URL('../../../scripts/spawn-lint-baseline.json', import.meta.url)).json()
  const manifest = await Bun.file(new URL('../quirky-plugin.json', import.meta.url)).json()
  expect(Object.hasOwn(baseline, 'plugins/quirky.agent-status/src/rules/matcher.ts')).toBe(false)
  const [major, minor] = manifest.apiVersion.split('.').map(Number)
  expect(major > 1 || (major === 1 && minor >= 6)).toBe(true)
})
