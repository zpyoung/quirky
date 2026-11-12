import { describe, expect, spyOn, test } from 'bun:test'
import { GitError } from '../src/index'
import { git, gitScheduler, runGit } from '../src/run'

type TrackedStream = {
  stream: ReadableStream<Uint8Array>
  cancellations: number
}

type StubChild = {
  process: {
    stdout: ReadableStream<Uint8Array>
    stderr: ReadableStream<Uint8Array>
    exited: Promise<number>
    readonly exitCode: number | null
    kill(): void
  }
  kills: number
  stdoutCancellations(): number
  stderrCancellations(): number
}

function trackedOutputStream(bytes: Uint8Array, stalled: boolean, neverCancel = false): TrackedStream {
  const stats = { cancellations: 0 }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      if (!stalled) controller.close()
    },
    cancel() {
      stats.cancellations++
      if (neverCancel) return Promise.withResolvers<void>().promise
    }
  })
  return { stream, get cancellations() { return stats.cancellations } }
}

function makeChild(
  exitCode: number | null,
  stdout: TrackedStream,
  stderr: TrackedStream
): StubChild {
  let currentExitCode = exitCode
  let settled = false
  const { promise: exited, resolve: finish } = Promise.withResolvers<number>()
  const resolveExit = (code: number) => {
    if (settled) return
    settled = true
    currentExitCode = code
    finish(code)
  }
  if (exitCode !== null) resolveExit(exitCode)
  const child: StubChild = {
    process: {
      stdout: stdout.stream,
      stderr: stderr.stream,
      exited,
      get exitCode() { return currentExitCode },
      kill() {
        child.kills++
        if (currentExitCode === null) resolveExit(143)
      }
    },
    kills: 0,
    stdoutCancellations: () => stdout.cancellations,
    stderrCancellations: () => stderr.cancellations,
  }
  return child
}

async function withSpawnStub<T>(
  factory: (index: number) => StubChild,
  run: (context: { children: StubChild[]; calls: () => number }) => Promise<T>
): Promise<T> {
  const children: StubChild[] = []
  let calls = 0
  const spawn = spyOn(Bun, 'spawn')
  spawn.mockImplementation(() => {
    const index = calls++
    const child = factory(index)
    children.push(child)
    return child.process as unknown as ReturnType<typeof Bun.spawn>
  })
  try {
    return await run({ children, calls: () => calls })
  } finally {
    spawn.mockRestore()
  }
}

type ControlledTimer = {
  delay: number
  cleared: boolean
  handle: ReturnType<typeof setTimeout>
  fire(): void
  fireQueued(): void
}

async function withControlledTimers<T>(run: (timers: ControlledTimer[]) => Promise<T>): Promise<T> {
  const timers: ControlledTimer[] = []
  const setTimeoutMock = spyOn(globalThis, 'setTimeout')
  const clearTimeoutMock = spyOn(globalThis, 'clearTimeout')
  setTimeoutMock.mockImplementation(((callback: TimerHandler, delay?: number) => {
    if (typeof callback !== 'function') throw new Error('Expected a timer callback')
    let timer!: ControlledTimer
    const invoke = () => callback()
    timer = {
      delay: delay ?? 0,
      cleared: false,
      handle: undefined as unknown as ReturnType<typeof setTimeout>,
      fire() {
        if (timer.cleared) return
        timer.cleared = true
        invoke()
      },
      fireQueued() {
        timer.cleared = true
        invoke()
      }
    }
    timer.handle = timer as unknown as ReturnType<typeof setTimeout>
    timers.push(timer)
    return timer.handle
  }) as typeof globalThis.setTimeout)
  clearTimeoutMock.mockImplementation(((handle: ReturnType<typeof setTimeout>) => {
    const timer = timers.find((entry) => entry.handle === handle)
    if (timer) timer.cleared = true
  }) as typeof globalThis.clearTimeout)
  try {
    return await run(timers)
  } finally {
    clearTimeoutMock.mockRestore()
    setTimeoutMock.mockRestore()
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 64; index++) await Promise.resolve()
}

const encoder = new TextEncoder()
const stdoutBytes = encoder.encode('ok\n')
const stderrBytes = encoder.encode('diagnostic\n')

function standardChild(exitCode: number, stalled: 'stdout' | 'stderr' | 'both' | 'none', neverCancel = false): StubChild {
  const stdout = trackedOutputStream(stdoutBytes, stalled === 'stdout' || stalled === 'both', neverCancel)
  const stderr = trackedOutputStream(stderrBytes, stalled === 'stderr' || stalled === 'both', neverCancel)
  return makeChild(exitCode, stdout, stderr)
}

describe('runGit output stalls', () => {
  for (const stalled of ['stdout', 'stderr', 'both'] as const) {
    test(`keeps successful mutation output when ${stalled} stalls`, async () => {
      const child = standardChild(0, stalled, stalled === 'both')
      await withSpawnStub(() => child, async ({ children, calls }) => {
        const result = await runGit(process.cwd(), ['tag', 'probe'], { stallMs: 20 })
        expect(result.exitCode).toBe(0)
        expect(Array.from(result.stdout)).toEqual(Array.from(stdoutBytes))
        expect(result.stderr).toBe('diagnostic\n')
        expect(result).not.toHaveProperty('timedOut')
        expect(calls()).toBe(1)
        expect(children[0]).toBe(child)
        expect(child.stdoutCancellations()).toBe(stalled === 'stdout' || stalled === 'both' ? 1 : 0)
        expect(child.stderrCancellations()).toBe(stalled === 'stderr' || stalled === 'both' ? 1 : 0)
        expect(child.process.stdout.locked).toBe(false)
        expect(child.process.stderr.locked).toBe(false)
        expect(gitScheduler.active).toBe(0)
      })
    })
  }

  test('git returns stdout when a successful mutation leaves both pipes open', async () => {
    const child = standardChild(0, 'both', true)
    await withSpawnStub(() => child, async ({ calls }) => {
      await expect(git(process.cwd(), ['tag', 'probe'], { stallMs: 20 })).resolves.toBe('ok\n')
      expect(calls()).toBe(1)
      expect(child.stdoutCancellations()).toBe(1)
      expect(child.stderrCancellations()).toBe(1)
      expect(gitScheduler.active).toBe(0)
    })
  })

  test('preserves complete output bytes without a stall', async () => {
    const stdout = Uint8Array.from([0x00, 0xff, 0x0a, 0x41])
    const stderr = encoder.encode('dïagnostic\n')
    const child = makeChild(0, trackedOutputStream(stdout, false), trackedOutputStream(stderr, false))
    await withSpawnStub(() => child, async ({ calls }) => {
      const result = await runGit(process.cwd(), ['tag', 'probe'], { stallMs: 20 })
      expect(Array.from(result.stdout)).toEqual(Array.from(stdout))
      expect(result.stderr).toBe('dïagnostic\n')
      expect(result.exitCode).toBe(0)
      expect(calls()).toBe(1)
      expect(gitScheduler.active).toBe(0)
    })
  })

  test('preserves a failed mutation exit and already-read diagnostics when stderr stalls', async () => {
    const child = standardChild(7, 'stderr')
    await withSpawnStub(() => child, async ({ calls }) => {
      const result = await runGit(process.cwd(), ['tag', 'probe'], { stallMs: 20 })
      expect(result).toMatchObject({ exitCode: 7, stderr: 'diagnostic\n' })
      expect(Array.from(result.stdout)).toEqual(Array.from(stdoutBytes))
      expect(result).not.toHaveProperty('timedOut')
      expect(calls()).toBe(1)
      expect(child.stderrCancellations()).toBe(1)
      expect(gitScheduler.active).toBe(0)
    })
  })

  test('git rejects a stalled nonzero mutation with the real exit and stderr', async () => {
    const child = standardChild(7, 'stderr')
    await withSpawnStub(() => child, async ({ calls }) => {
      const failure = await git(process.cwd(), ['tag', 'probe'], { stallMs: 20 }).then(
        () => undefined,
        (error: unknown) => error
      )
      expect(failure).toBeInstanceOf(GitError)
      expect(failure).toMatchObject({ exitCode: 7, stderr: 'diagnostic\n' })
      expect(calls()).toBe(1)
      expect(gitScheduler.active).toBe(0)
    })
  })

  test('read-only runs retry at most three stalls and never return partial output', async () => {
    const children = Array.from({ length: 3 }, () => standardChild(0, 'both'))
    await withSpawnStub((index) => children[index]!, async ({ calls }) => {
      const failure = await runGit(process.cwd(), ['status'], { readOnly: true, share: false, stallMs: 20 }).then(
        () => undefined,
        (error: unknown) => error
      )
      expect(failure).toBeInstanceOf(GitError)
      expect((failure as Error).message).toContain('after 3 attempts')
      expect(calls()).toBe(3)
      expect(gitScheduler.active).toBe(0)
    })
  })

  test('read-only retries discard stalled bytes and return only a complete attempt', async () => {
    const children = [
      standardChild(0, 'both'),
      standardChild(0, 'both'),
      makeChild(0, trackedOutputStream(encoder.encode('complete\n'), false), trackedOutputStream(encoder.encode('done\n'), false))
    ]
    await withSpawnStub((index) => children[index]!, async ({ calls }) => {
      const result = await runGit(process.cwd(), ['status'], { readOnly: true, share: false, stallMs: 20 })
      expect(Array.from(result.stdout)).toEqual(Array.from(encoder.encode('complete\n')))
      expect(result.stderr).toBe('done\n')
      expect(calls()).toBe(3)
      expect(gitScheduler.active).toBe(0)
    })
  })

  test('spawn errors still reject instead of being treated as partial output', async () => {
    const spawnError = new Error('spawn failed')
    await withSpawnStub(() => { throw spawnError }, async ({ calls }) => {
      const failure = await runGit(process.cwd(), ['tag', 'probe'], { stallMs: 20 }).then(
        () => undefined,
        (error: unknown) => error
      )
      expect(failure).toBeInstanceOf(GitError)
      expect(failure).toMatchObject({ exitCode: -1 })
      expect((failure as Error).message).toContain('spawn failed')
      expect(calls()).toBe(1)
      expect(gitScheduler.active).toBe(0)
    })
  })

  test('unrelated stream errors still reject instead of being treated as stalls', async () => {
    const streamError = new Error('stream failed')
    const brokenStderr = {
      stream: new ReadableStream<Uint8Array>({ start(controller) { controller.error(streamError) } }),
      cancellations: 0
    }
    const child = makeChild(0, trackedOutputStream(stdoutBytes, false), brokenStderr)
    await withSpawnStub(() => child, async ({ calls }) => {
      const failure = await runGit(process.cwd(), ['tag', 'probe'], { stallMs: 20 }).then(
        () => undefined,
        (error: unknown) => error
      )
      expect(failure).toBe(streamError)
      expect(calls()).toBe(1)
      expect(gitScheduler.active).toBe(0)
    })
  })
})

describe('runGit process deadlines and output stalls', () => {
  test('does not kill or time out a child that exited before its deadline', async () => {
    await withControlledTimers(async (timers) => {
      const child = standardChild(0, 'stdout')
      await withSpawnStub(() => child, async ({ calls }) => {
        const resultPromise = runGit(process.cwd(), ['tag', 'probe'], { timeoutMs: 5, stallMs: 20 })
        await flushMicrotasks()
        expect(calls()).toBe(1)
        const deadline = timers.find((timer) => timer.delay === 5)
        expect(deadline).toBeDefined()
        expect(deadline!.cleared).toBe(true)
        deadline!.fireQueued()
        expect(child.kills).toBe(0)
        const outputGuards = timers.filter((timer) => timer.delay === 20 && !timer.cleared)
        expect(outputGuards.length).toBeGreaterThan(0)
        for (const guard of outputGuards) guard.fire()
        const result = await resultPromise
        expect(result).toMatchObject({ exitCode: 0, stderr: 'diagnostic\n' })
        expect(Array.from(result.stdout)).toEqual(Array.from(stdoutBytes))
        expect(result).not.toHaveProperty('timedOut')
        expect(child.kills).toBe(0)
        expect(child.stdoutCancellations()).toBe(1)
        expect(child.stderrCancellations()).toBe(0)
        expect(gitScheduler.active).toBe(0)
      })
    })
  })

  test('kills a live child at its deadline and preserves timed-out exit through a pipe stall', async () => {
    await withControlledTimers(async (timers) => {
      const stdout = trackedOutputStream(stdoutBytes, true, true)
      const stderr = trackedOutputStream(stderrBytes, false)
      const child = makeChild(null, stdout, stderr)
      await withSpawnStub(() => child, async ({ calls }) => {
        const resultPromise = runGit(process.cwd(), ['tag', 'probe'], { timeoutMs: 5, stallMs: 20 })
        await flushMicrotasks()
        expect(calls()).toBe(1)
        const deadline = timers.find((timer) => timer.delay === 5)
        expect(deadline).toBeDefined()
        deadline!.fire()
        await flushMicrotasks()
        const outputGuards = timers.filter((timer) => timer.delay === 20 && !timer.cleared)
        expect(outputGuards.length).toBeGreaterThan(0)
        for (const guard of outputGuards) guard.fire()
        const result = await resultPromise
        expect(result).toMatchObject({ exitCode: 143, stderr: 'diagnostic\n', timedOut: true })
        expect(Array.from(result.stdout)).toEqual(Array.from(stdoutBytes))
        expect(child.kills).toBe(1)
        expect(stdout.cancellations).toBe(1)
        expect(gitScheduler.active).toBe(0)
      })
    })
  })
})
