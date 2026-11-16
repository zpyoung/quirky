import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { StateLoader } from '../src/window/loader'

const timers = jest as typeof jest & { advanceTimersByTime(ms: number): void }
beforeEach(() => { timers.useFakeTimers() })
afterEach(() => { timers.useRealTimers() })
async function advance(ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 1) {
    timers.advanceTimersByTime(1)
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
  }
}

describe('StateLoader', () => {
  test('retries failed reads and accepts the first state', async () => {
    let reads = 0
    const failures: unknown[] = []
    const states: string[] = []
    const loader = new StateLoader<string>({
      read: async () => {
        reads += 1
        if (reads < 3) throw new Error('offline')
        return 'state'
      },
      onState: (state) => states.push(state),
      onFailure: (error) => failures.push(error),
      retryDelaysMs: [5, 5, 5]
    })

    await loader.load()
    await advance(40)

    expect(reads).toBe(3)
    expect(failures).toHaveLength(2)
    expect(states).toEqual(['state'])
    loader.dispose()
  })

  test('stops after exhausting retries and a new load starts from the first delay', async () => {
    let reads = 0
    const failures: unknown[] = []
    const loader = new StateLoader<string>({
      read: async () => {
        reads += 1
        throw new Error('offline')
      },
      onState: () => {},
      onFailure: (error) => failures.push(error),
      retryDelaysMs: [5, 5, 5]
    })

    await loader.load()
    await advance(60)
    expect(reads).toBe(4)
    expect(failures).toHaveLength(4)

    await loader.load()
    await advance(60)
    expect(reads).toBe(8)
    expect(failures).toHaveLength(8)
    loader.dispose()
  })

  test('does not report a read rejected after settle', async () => {
    const held = Promise.withResolvers<string>()
    let reads = 0
    const failures: unknown[] = []
    const loader = new StateLoader<string>({
      read: () => {
        reads += 1
        return held.promise
      },
      onState: () => {},
      onFailure: (error) => failures.push(error),
      retryDelaysMs: [5, 5, 5]
    })

    const pending = loader.load()
    loader.settle()
    held.reject(new Error('late failure'))
    await pending
    await advance(30)

    expect(reads).toBe(1)
    expect(failures).toHaveLength(0)
    loader.dispose()
  })

  test('drops an older reply after a newer load', async () => {
    const held = Promise.withResolvers<string>()
    let reads = 0
    const states: string[] = []
    const loader = new StateLoader<string>({
      read: () => {
        reads += 1
        return reads === 1 ? held.promise : Promise.resolve('new')
      },
      onState: (state) => states.push(state),
      onFailure: () => {},
      retryDelaysMs: [5, 5, 5]
    })

    const first = loader.load()
    await loader.load()
    held.resolve('old')
    await first

    expect(states).toEqual(['new'])
    loader.dispose()
  })

  test('dispose cancels retries and suppresses held replies and later loads', async () => {
    let failedReads = 0
    const failedLoader = new StateLoader<string>({
      read: async () => {
        failedReads += 1
        throw new Error('offline')
      },
      onState: () => {},
      onFailure: () => {},
      retryDelaysMs: [5, 5, 5]
    })

    await failedLoader.load()
    failedLoader.dispose()
    await advance(30)
    expect(failedReads).toBe(1)

    const held = Promise.withResolvers<string>()
    const states: string[] = []
    let heldReads = 0
    const heldLoader = new StateLoader<string>({
      read: () => {
        heldReads += 1
        return held.promise
      },
      onState: (state) => states.push(state),
      onFailure: () => {},
      retryDelaysMs: [5, 5, 5]
    })

    const pending = heldLoader.load()
    heldLoader.dispose()
    held.resolve('late')
    await pending
    await heldLoader.load()

    expect(heldReads).toBe(1)
    expect(states).toEqual([])
  })
})
