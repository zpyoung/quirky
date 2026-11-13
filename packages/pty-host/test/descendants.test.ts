import { describe, expect, test } from 'bun:test'
import { ProcessRunnerDisposedError } from '@quirky/process'
import type { ProcessRunner, RunResult } from '@quirky/protocol'
import {
  PROCESS_SCAN_DEADLINE_MS,
  PROCESS_SCAN_TIMEOUT_MS,
  createProcessTables,
  descendantsIn,
  parseProcessTable,
} from '../src/descendants'

type Run = ProcessRunner['run']
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }

function deferred<T>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

function result(text = '', extra: Partial<RunResult> = {}): RunResult {
  return {
    stdout: new TextEncoder().encode(text),
    stdoutText: text,
    stderr: '',
    exitCode: 0,
    signal: null,
    durationMs: 0,
    ...extra
  }
}

async function microtask(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

const empty = parseProcessTable('')

describe('process tables', () => {
  test('parses only rows containing two integer pids', () => {
    expect(parseProcessTable('  12  1\nnot-a-row\n13 2 trailing\n14 nope\n15 3\n')).toEqual({
      children: new Map([[1, [12]], [3, [15]]])
    })
  })

  test('walks every descendant of the root and tracked roots once, excluding roots through cycles', () => {
    const table = parseProcessTable('2 1\n3 2\n4 90\n5 4\n6 5\n2 6\n6 3\n7 7\n8 8\n9 3\n')

    expect(descendantsIn(table, 1, [4, 1, 4])).toEqual([2, 5, 3, 6, 9])
    expect(descendantsIn(table, 7)).toEqual([])
  })

  test('exports the scan defaults from the process contract', () => {
    expect(PROCESS_SCAN_TIMEOUT_MS).toBe(1000)
    expect(PROCESS_SCAN_DEADLINE_MS).toBe(1250)
  })

  test('two fresh calls in one turn share a scan started on a microtask', async () => {
    const held = deferred<RunResult>()
    const calls: Array<{ argv: readonly string[]; options?: Parameters<Run>[1] }> = []
    const tables = createProcessTables({
      run(argv, options) {
        calls.push({ argv, options })
        return held.promise
      }
    })

    const first = tables.fresh()
    const second = tables.fresh()
    expect(calls).toHaveLength(0)
    await microtask()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.argv).toEqual(['ps', '-A', '-o', 'pid=,ppid='])
    expect(calls[0]!.options).toMatchObject({ timeoutMs: 1000, killGraceMs: 0 })
    expect(calls[0]!.options?.signal).toBeInstanceOf(AbortSignal)

    held.resolve(result('2 1\n'))
    const [one, two] = await Promise.all([first, second])
    expect(one).toBe(two)
    expect(one).toEqual(parseProcessTable('2 1\n'))
    tables.close()
  })

  test('fresh called during a scan queues a newer scan and never joins the older table', async () => {
    const firstRun = deferred<RunResult>()
    const secondRun = deferred<RunResult>()
    const calls: Array<Deferred<RunResult>> = [firstRun, secondRun]
    let count = 0
    const tables = createProcessTables({
      run() {
        return calls[count++]!.promise
      }
    })

    const first = tables.fresh()
    await microtask()
    const afterRequest = tables.fresh()
    firstRun.resolve(result('2 1\n'))
    expect(await first).toEqual(parseProcessTable('2 1\n'))
    await microtask()
    expect(count).toBe(2)
    secondRun.resolve(result('3 1\n'))
    expect(await afterRequest).toEqual(parseProcessTable('3 1\n'))
    tables.close()
  })

  test('fresh calls while a scan runs share one queued next scan', async () => {
    const firstRun = deferred<RunResult>()
    const nextRun = deferred<RunResult>()
    let count = 0
    const tables = createProcessTables({
      run() {
        return (count++ === 0 ? firstRun : nextRun).promise
      }
    })

    const active = tables.fresh()
    await microtask()
    const queued = [tables.fresh(), tables.fresh(), tables.fresh()]
    firstRun.resolve(result('2 1\n'))
    await active
    await microtask()
    expect(count).toBe(2)
    nextRun.resolve(result('4 1\n'))
    expect(await Promise.all(queued)).toEqual(Array(3).fill(parseProcessTable('4 1\n')))
    tables.close()
  })

  test('recent joins a currently running scan', async () => {
    const held = deferred<RunResult>()
    let count = 0
    const tables = createProcessTables({ run: () => (count++, held.promise) })

    const fresh = tables.fresh()
    await microtask()
    const recent = tables.recent(50)
    held.resolve(result('2 1\n'))
    expect(await recent).toEqual(parseProcessTable('2 1\n'))
    expect(await fresh).toEqual(parseProcessTable('2 1\n'))
    expect(count).toBe(1)
    tables.close()
  })

  test('recent reuses a scan through its age limit and refreshes after it', async () => {
    let now = 0
    let count = 0
    const tables = createProcessTables(
      {
        run() {
          count++
          return Promise.resolve(result(`${count + 1} 1\n`))
        }
      },
      { now: () => now }
    )

    expect(await tables.fresh()).toEqual(parseProcessTable('2 1\n'))
    now = 49
    expect(await tables.recent(50)).toEqual(parseProcessTable('2 1\n'))
    expect(count).toBe(1)
    now = 51
    expect(await tables.recent(50)).toEqual(parseProcessTable('3 1\n'))
    expect(count).toBe(2)
    tables.close()
  })

  test('reuses the empty table after a failed scan inside the recent window', async () => {
    let now = 0
    let count = 0
    const tables = createProcessTables(
      {
        run() {
          count++
          return Promise.resolve(result('', { exitCode: 1 }))
        }
      },
      { now: () => now }
    )

    expect(await tables.fresh()).toEqual(empty)
    now = 49
    expect(await tables.recent(50)).toEqual(empty)
    expect(count).toBe(1)
    now = 51
    expect(await tables.recent(50)).toEqual(empty)
    expect(count).toBe(2)
    tables.close()
  })

  test('returns empty tables for every unsuccessful runner outcome', async () => {
    const failures: Array<[string, Run]> = [
      ['exit-nonzero', async () => result('', { exitCode: 1 })],
      ['spawn-error', async () => result('', { exitCode: null, spawnError: { code: 'ENOENT', message: 'missing' } })],
      ['timeout', async () => result('', { exitCode: null, stopped: 'timeout' })],
      ['signal', async () => result('', { exitCode: null, signal: 'SIGKILL' })],
      ['throws', async () => { throw new ProcessRunnerDisposedError('test') }]
    ]

    for (const [name, run] of failures) {
      const tables = createProcessTables({ run })
      expect(await tables.fresh(), name).toEqual(empty)
      tables.close()
    }
  })

  test('gives every waiter an empty table at the deadline and aborts the lone run', async () => {
    const held = deferred<RunResult>()
    let signal: AbortSignal | undefined
    let count = 0
    const tables = createProcessTables(
      {
        run(_argv, options) {
          count++
          signal = options?.signal
          return held.promise
        }
      },
      { deadlineMs: 30 }
    )

    const fresh = tables.fresh()
    await microtask()
    expect(await fresh).toEqual(empty)
    expect(signal?.aborted).toBe(true)
    expect(count).toBe(1)
    tables.close()
  })

  test('a never-settling scan produces empty at the configured deadline with no retry', async () => {
    let count = 0
    let signal: AbortSignal | undefined
    const tables = createProcessTables(
      {
        run(_argv, options) {
          count++
          signal = options?.signal
          return new Promise<RunResult>(() => {})
        }
      },
      { deadlineMs: 30 }
    )

    expect(await tables.fresh()).toEqual(empty)
    expect(signal?.aborted).toBe(true)
    expect(count).toBe(1)
    tables.close()
  })

  test('drops a valid late result and starts one new scan for fresh and recent callers', async () => {
    const firstRun = deferred<RunResult>()
    const secondRun = deferred<RunResult>()
    let count = 0
    const tables = createProcessTables(
      {
        run() {
          return (count++ === 0 ? firstRun : secondRun).promise
        }
      },
      { deadlineMs: 20 }
    )

    expect(await tables.fresh()).toEqual(empty)
    firstRun.resolve(result('9 1\n'))
    await microtask()
    const recent = tables.recent(50)
    const fresh = tables.fresh()
    await microtask()
    expect(count).toBe(2)
    secondRun.resolve(result('3 1\n'))
    expect(await Promise.all([recent, fresh])).toEqual([parseProcessTable('3 1\n'), parseProcessTable('3 1\n')])
    tables.close()
  })

  test('handles a late rejection and permits the next scan without an unhandled rejection', async () => {
    const firstRun = deferred<RunResult>()
    let count = 0
    const tables = createProcessTables(
      {
        run() {
          count++
          return count === 1 ? firstRun.promise : Promise.resolve(result('3 1\n'))
        }
      },
      { deadlineMs: 20 }
    )

    expect(await tables.fresh()).toEqual(empty)
    firstRun.reject(new ProcessRunnerDisposedError('late'))
    await microtask()
    expect(await tables.fresh()).toEqual(parseProcessTable('3 1\n'))
    expect(count).toBe(2)
    tables.close()
  })

  test('close resolves active and queued waiters empty, aborts the run, and prevents later runs', async () => {
    const held = deferred<RunResult>()
    let signal: AbortSignal | undefined
    let count = 0
    const tables = createProcessTables({
      run(_argv, options) {
        count++
        signal = options?.signal
        return held.promise
      }
    })

    const active = tables.fresh()
    await microtask()
    const queued = tables.fresh()
    const recent = tables.recent(50)
    tables.close()
    expect(await Promise.all([active, queued, recent])).toEqual([empty, empty, empty])
    expect(signal?.aborted).toBe(true)
    expect(await tables.fresh()).toEqual(empty)
    expect(await tables.recent(50)).toEqual(empty)
    expect(count).toBe(1)
  })

  test('never runs two scans concurrently, including while a timed-out call is unsettled', async () => {
    const firstRun = deferred<RunResult>()
    const secondRun = deferred<RunResult>()
    const firstStarted = deferred<void>()
    const secondStarted = deferred<void>()
    let firstRunnerPromise: Promise<RunResult> | undefined
    let count = 0
    let inFlight = 0
    let highestInFlight = 0
    const tables = createProcessTables(
      {
        run() {
          count++
          inFlight++
          highestInFlight = Math.max(highestInFlight, inFlight)
          const held = count === 1 ? firstRun : secondRun
          const running = held.promise.finally(() => inFlight--)
          if (count === 1) {
            firstRunnerPromise = running
            firstStarted.resolve()
          } else {
            secondStarted.resolve()
          }
          return running
        }
      },
      { deadlineMs: 20 }
    )

    const initial = tables.fresh()
    await firstStarted.promise
    expect(await initial).toEqual(empty)
    expect(await Promise.all([
      tables.fresh(),
      tables.fresh(),
      tables.fresh(),
      tables.recent(50),
      tables.recent(50)
    ])).toEqual(Array(5).fill(empty))
    expect(count).toBe(1)

    firstRun.resolve(result('2 1\n'))
    await firstRunnerPromise!.then(() => {})
    const next = tables.fresh()
    await secondStarted.promise
    expect(count).toBe(2)
    expect(highestInFlight).toBe(1)

    secondRun.resolve(result('3 1\n'))
    expect(await next).toEqual(parseProcessTable('3 1\n'))
    tables.close()
  })
})
