import { describe, expect, setSystemTime, test } from 'bun:test'
import { createGitScheduler, DEFAULT_GIT_CONCURRENCY } from '../src/scheduler'

function deferred<T>() {
  return Promise.withResolvers<T>()
}

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}


describe('git scheduler', () => {
  test('defaults to eight slots and rejects invalid concurrency limits', () => {
    expect(DEFAULT_GIT_CONCURRENCY).toBe(8)
    expect(createGitScheduler().active).toBe(0)
    for (const concurrency of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createGitScheduler({ concurrency })).toThrow()
    }
  })

  test('bounds active work and releases a slot when work throws synchronously', async () => {
    const scheduler = createGitScheduler({ concurrency: 2 })
    const gates = Array.from({ length: 7 }, () => deferred<number>())
    const started: number[] = []
    const calls = gates.map((gate, index) => scheduler.withSlot('read', undefined, async () => {
      started.push(index)
      return await gate.promise
    }))

    expect(started).toEqual([0, 1])
    expect(scheduler.active).toBe(2)
    expect(scheduler.peakActive).toBe(2)

    for (let index = 0; index < calls.length; index++) {
      gates[index].resolve(index)
      await calls[index]
      expect(started).toEqual(Array.from({ length: Math.min(index + 3, calls.length) }, (_, i) => i))
    }
    await Promise.all(calls)
    expect(scheduler.active).toBe(0)

    const error = new Error('sync failure')
    const failed = await scheduler.withSlot('read', undefined, () => {
      throw error
    }).then(() => null, (reason) => reason)
    expect(failed).toBe(error)
    expect(scheduler.active).toBe(0)
    const next = await scheduler.withSlot('read', undefined, async () => 'released')
    expect(next).toEqual({ timedOut: false, value: 'released' })
  })

  test('transfers a released slot to its waiter before a synchronous arrival can barge', async () => {
    const scheduler = createGitScheduler({ concurrency: 1 })
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()]
    const started: string[] = []
    const a = scheduler.withSlot('read', undefined, async () => {
      started.push('A')
      return await gates[0].promise
    })
    const b = scheduler.withSlot('read', undefined, async () => {
      started.push('B')
      return await gates[1].promise
    })
    let c!: Promise<unknown>
    const afterA = a.then(() => {
      c = scheduler.withSlot('read', undefined, async () => {
        started.push('C')
        return await gates[2].promise
      })
    })

    gates[0].resolve('A')
    await afterA
    expect(started).toEqual(['A', 'B'])
    gates[1].resolve('B')
    await b
    expect(started).toEqual(['A', 'B', 'C'])
    expect(scheduler.peakActive).toBe(1)
    gates[2].resolve('C')
    await c
  })

  test('drains FIFO writes ahead of reads queued earlier', async () => {
    const scheduler = createGitScheduler({ concurrency: 1 })
    const gates = new Map(['A', 'R1', 'R2', 'W1', 'W2'].map((name) => [name, deferred<void>()]))
    const started: string[] = []
    const enqueue = (name: string, kind: 'read' | 'write') => scheduler.withSlot(kind, undefined, async () => {
      started.push(name)
      await gates.get(name)!.promise
      return name
    })
    const a = enqueue('A', 'read')
    const r1 = enqueue('R1', 'read')
    const r2 = enqueue('R2', 'read')
    const w1 = enqueue('W1', 'write')
    const w2 = enqueue('W2', 'write')

    gates.get('A')!.resolve()
    await a
    expect(started).toEqual(['A', 'W1'])
    gates.get('W1')!.resolve()
    await w1
    expect(started).toEqual(['A', 'W1', 'W2'])
    gates.get('W2')!.resolve()
    await w2
    expect(started).toEqual(['A', 'W1', 'W2', 'R1'])
    gates.get('R1')!.resolve()
    await r1
    expect(started).toEqual(['A', 'W1', 'W2', 'R1', 'R2'])
    gates.get('R2')!.resolve()
    await r2
    expect(scheduler.active).toBe(0)
  })

  test('expires queued work without invoking it and passes only its remaining budget on grant', async () => {
    const started = Date.now()
    setSystemTime(started)
    try {
      const scheduler = createGitScheduler({ concurrency: 1 })
      const holder = deferred<void>()
      const held = scheduler.withSlot('read', undefined, async () => holder.promise)
      let expiredWorkRan = false
      const expired = scheduler.withSlot('read', 20, async () => {
        expiredWorkRan = true
        return 'expired'
      })
      let remainingTimeoutMs: number | undefined
      const waiting = scheduler.withSlot('read', 500, async (remaining) => {
        remainingTimeoutMs = remaining
        return 'granted'
      })

      // the native deadline callback is the signal; Bun's pinned types expose no timer advancement API.
      expect(await expired).toEqual({ timedOut: true })
      expect(expiredWorkRan).toBe(false)
      setSystemTime(started + 55)
      holder.resolve()
      await held
      expect(await waiting).toEqual({ timedOut: false, value: 'granted' })
      expect(remainingTimeoutMs).toBeGreaterThan(0)
      expect(remainingTimeoutMs).toBeLessThan(500)
    } finally {
      setSystemTime()
    }
  })

  test('advances the write epoch on entry and in finally, including synchronous failure', async () => {
    const scheduler = createGitScheduler()
    const gate = deferred<void>()
    let entryEpoch = 0
    const write = scheduler.withWrite(async () => {
      entryEpoch = scheduler.writeEpoch
      await gate.promise
      return 'written'
    })

    expect(scheduler.writeEpoch).toBe(1)
    await flushMicrotasks()
    expect(entryEpoch).toBe(1)
    gate.resolve()
    expect(await write).toBe('written')
    expect(scheduler.writeEpoch).toBe(2)

    const error = new Error('write failure')
    let failedEntryEpoch = 0
    const failed = scheduler.withWrite(() => {
      failedEntryEpoch = scheduler.writeEpoch
      throw error
    }).then(() => null, (reason) => reason)
    expect(failedEntryEpoch).toBe(3)
    expect(scheduler.writeEpoch).toBe(4)
    expect(await failed).toBe(error)
    expect(scheduler.writeEpoch).toBe(4)
  })

  test('batches same-turn reads and clones every result in a shared cohort', async () => {
    const scheduler = createGitScheduler()
    const gate = deferred<{ entries: number[] }>()
    const value = { entries: [1] }
    let runs = 0
    let clones = 0
    const run = () => {
      runs++
      return gate.promise
    }
    const clone = (result: { entries: number[] }) => {
      clones++
      return structuredClone(result)
    }
    const first = scheduler.shareRead('same', run, clone)
    const second = scheduler.shareRead('same', run, clone)

    expect(runs).toBe(0)
    await flushMicrotasks()
    expect(runs).toBe(1)
    gate.resolve(value)
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(clones).toBe(2)
    expect(firstResult).not.toBe(value)
    expect(secondResult).not.toBe(value)
    expect(firstResult).not.toBe(secondResult)
    firstResult.entries.push(2)
    expect(secondResult.entries).toEqual([1])
  })

  test('returns the original value without cloning for a solo caller', async () => {
    const scheduler = createGitScheduler()
    const value = { entries: [1] }
    let clones = 0
    const result = await scheduler.shareRead('solo', async () => value, (item) => {
      clones++
      return structuredClone(item)
    })
    expect(result).toBe(value)
    expect(clones).toBe(0)
  })

  test('runs one post-arrival waiting cohort before settling the active caller', async () => {
    const scheduler = createGitScheduler()
    const firstGate = deferred<string>()
    const waitingGate = deferred<string>()
    const events: string[] = []
    const clone = structuredClone
    const first = scheduler.shareRead('key', () => {
      events.push('run:first')
      return firstGate.promise
    }, clone)
    const firstSettled = first.then((value) => {
      events.push('settled:first')
      return value
    })
    await flushMicrotasks()
    const waiting = scheduler.shareRead('key', () => {
      events.push('run:waiting')
      return waitingGate.promise
    }, clone)
    const sameWaiting = scheduler.shareRead('key', () => {
      events.push('run:duplicate')
      return Promise.resolve('duplicate')
    }, clone)

    firstGate.resolve('first')
    expect(await firstSettled).toBe('first')
    expect(events).toEqual(['run:first', 'run:waiting', 'settled:first'])
    waitingGate.resolve('waiting')
    expect(await Promise.all([waiting, sameWaiting])).toEqual(['waiting', 'waiting'])
  })

  test('rejects every caller in a failed cohort and starts a fresh run afterward', async () => {
    const scheduler = createGitScheduler()
    const error = new Error('read failed')
    let runs = 0
    const first = scheduler.shareRead('failure', () => {
      runs++
      throw error
    }, structuredClone)
    const second = scheduler.shareRead('failure', () => {
      runs++
      return Promise.resolve('unexpected')
    }, structuredClone)
    const failures = Promise.all([
      first.then(() => null, (reason) => reason),
      second.then(() => null, (reason) => reason),
    ])

    expect(await failures).toEqual([error, error])
    expect(runs).toBe(1)
    const recovered = await scheduler.shareRead('failure', () => {
      runs++
      return Promise.resolve('fresh')
    }, structuredClone)
    expect(recovered).toBe('fresh')
    expect(runs).toBe(2)
  })

  test('promotes a waiting cohort before rejecting the active caller', async () => {
    const scheduler = createGitScheduler()
    const firstGate = deferred<string>()
    const waitingGate = deferred<string>()
    const events: string[] = []
    const first = scheduler.shareRead('key', () => {
      events.push('run:first')
      return firstGate.promise
    }, structuredClone)
    const firstRejected = first.then(() => null, (error) => {
      events.push('rejected:first')
      return error
    })
    await flushMicrotasks()
    const waiting = scheduler.shareRead('key', () => {
      events.push('run:waiting')
      return waitingGate.promise
    }, structuredClone)

    const error = new Error('active failed')
    firstGate.reject(error)
    expect(await firstRejected).toBe(error)
    expect(events).toEqual(['run:first', 'run:waiting', 'rejected:first'])
    waitingGate.resolve('fresh')
    expect(await waiting).toBe('fresh')
  })
})
