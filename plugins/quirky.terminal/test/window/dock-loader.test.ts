import { describe, expect, jest, test } from 'bun:test'
import { RpcError, RpcErrorCode } from '@quirky/protocol'
import type { DockState } from '../../src/window/dock/types'
import { DockLoader } from '../../src/window/dock/loader'

const timers = jest as typeof jest & { advanceTimersByTime(ms: number): void }

function state(overrides: Partial<DockState> = {}): DockState {
  return {
    pane: 'pane-a',
    session: 'session-a',
    tab: 'tab-a',
    revision: 1,
    enabled: true,
    supported: true,
    agent: null,
    docked: true,
    userUndocked: false,
    gutterRows: 5,
    mounted: true,
    passthrough: false,
    draft: '',
    attachments: [],
    disabledReason: null,
    activeSend: null,
    queuedSends: [],
    question: null,
    options: {
      model: null,
      effort: null,
      permission: null,
      choices: { model: [], effort: [], permission: [] },
      context: null,
      notice: null
    },
    notice: null,
    ...overrides
  }
}

async function withFakeTimers(run: () => Promise<void>): Promise<void> {
  timers.useFakeTimers()
  try {
    await run()
  } finally {
    timers.useRealTimers()
  }
}

async function advance(ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 1) {
    timers.advanceTimersByTime(1)
    await Promise.resolve()
  }
}

function deferred<T>() {
  return Promise.withResolvers<T>()
}

async function invalidReplyRetries(reply: unknown): Promise<void> {
  const expected = state()
  let calls = 0
  const failures: unknown[] = []
  const states: DockState[] = []
  const loader = new DockLoader({
    call: async () => {
      calls += 1
      return calls === 1 ? reply : expected
    },
    pane: 'pane-a',
    session: 'session-a',
    onState: (next) => states.push(next),
    onFailure: (error) => failures.push(error),
    retryDelaysMs: [5]
  })

  await withFakeTimers(async () => {
    await loader.load()
    await advance(20)
    expect(calls).toBe(2)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ message: 'The dock state response was invalid.' })
    expect(states).toEqual([expected])
  })
  loader.dispose()
}

describe('terminal dock loader', () => {
  test('retries failed reads and accepts the first valid state', () => withFakeTimers(async () => {
    const firstError = new Error('pane lookup timed out')
    const secondError = new Error('pane lookup timed out')
    const expected = state()
    let calls = 0
    const failures: unknown[] = []
    const states: DockState[] = []
    const loader = new DockLoader({
      call: async () => {
        calls += 1
        if (calls === 1) throw firstError
        if (calls === 2) throw secondError
        return expected
      },
      pane: 'pane-a',
      session: 'session-a',
      onState: (next) => states.push(next),
      onFailure: (error) => failures.push(error),
      retryDelaysMs: [5, 5, 5, 5, 5]
    })

    await loader.load()
    await advance(40)

    expect(calls).toBe(3)
    expect(failures).toEqual([firstError, secondError])
    expect(states).toEqual([expected])
    loader.dispose()
  }))

  test('stops after exhausting the configured retry delays', () => withFakeTimers(async () => {
    const error = new Error('pane lookup timed out')
    let calls = 0
    const failures: unknown[] = []
    const loader = new DockLoader({
      call: async () => {
        calls += 1
        throw error
      },
      pane: 'pane-a',
      session: 'session-a',
      onState: () => {},
      onFailure: (failure) => failures.push(failure),
      retryDelaysMs: [5, 5, 5]
    })

    await loader.load()
    await advance(60)

    expect(calls).toBe(4)
    expect(failures).toHaveLength(4)
    loader.dispose()
  }))

  test('does not retry when the dock method is missing', () => withFakeTimers(async () => {
    let calls = 0
    const failures: unknown[] = []
    const loader = new DockLoader({
      call: async () => {
        calls += 1
        throw new RpcError(RpcErrorCode.MethodNotFound, 'dock is unavailable')
      },
      pane: 'pane-a',
      session: 'session-a',
      onState: () => {},
      onFailure: (error) => failures.push(error),
      retryDelaysMs: [5, 5, 5]
    })

    await loader.load()
    await advance(30)

    expect(calls).toBe(1)
    expect(failures).toHaveLength(1)
    loader.dispose()
  }))

  test('settle and dispose cancel a pending retry', () => withFakeTimers(async () => {
    for (const cancel of ['settle', 'dispose'] as const) {
      let calls = 0
      const failures: unknown[] = []
      const loader = new DockLoader({
        call: async () => {
          calls += 1
          throw new Error('pane lookup timed out')
        },
        pane: 'pane-a',
        session: 'session-a',
        onState: () => {},
        onFailure: (error) => failures.push(error),
        retryDelaysMs: [5, 5, 5]
      })

      await loader.load()
      if (cancel === 'settle') loader.settle()
      else loader.dispose()
      await advance(30)

      expect(calls).toBe(1)
      expect(failures).toHaveLength(1)
      loader.dispose()
    }
  }))

  test('drops an overtaken rejection and an older response', () => withFakeTimers(async () => {
    const heldFailure = deferred<unknown>()
    let rejectedCalls = 0
    const rejectedFailures: unknown[] = []
    const rejectedLoader = new DockLoader({
      call: () => {
        rejectedCalls += 1
        return heldFailure.promise
      },
      pane: 'pane-a',
      session: 'session-a',
      onState: () => {},
      onFailure: (error) => rejectedFailures.push(error),
      retryDelaysMs: [5, 5]
    })
    const heldLoad = rejectedLoader.load()
    await Promise.resolve()
    expect(rejectedCalls).toBe(1)
    rejectedLoader.settle()
    heldFailure.reject(new Error('late failure'))
    await heldLoad
    await advance(30)
    expect(rejectedFailures).toHaveLength(0)
    expect(rejectedCalls).toBe(1)
    rejectedLoader.dispose()

    const heldResponse = deferred<unknown>()
    const newer = state({ revision: 2, draft: 'new' })
    const published: DockState[] = []
    let responseCalls = 0
    const responseLoader = new DockLoader({
      call: () => {
        responseCalls += 1
        return responseCalls === 1 ? heldResponse.promise : Promise.resolve(newer)
      },
      pane: 'pane-a',
      session: 'session-a',
      onState: (next) => published.push(next),
      onFailure: () => {},
      retryDelaysMs: [5, 5]
    })
    const olderLoad = responseLoader.load()
    await Promise.resolve()
    const newerLoad = responseLoader.load()
    await newerLoad
    heldResponse.resolve(state({ revision: 1, draft: 'old' }))
    await olderLoad

    expect(responseCalls).toBe(2)
    expect(published).toEqual([newer])
    responseLoader.dispose()
  }))

  test('retries a malformed response', async () => {
    await invalidReplyRetries({ pane: 'pane-a', session: 'session-a' })
  })

  test('retries a response for another pane', async () => {
    await invalidReplyRetries(state({ pane: 'pane-b', draft: 'foreign pane' }))
  })

  test('retries a response for another session', async () => {
    await invalidReplyRetries(state({ session: 'session-b', draft: 'foreign session' }))
  })
})
