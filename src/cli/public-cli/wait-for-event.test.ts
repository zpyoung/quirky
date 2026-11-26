import { describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime/client'
import type { PublicEvent } from '../../shared/public-rpc/public-events'
import { exitCodeFor } from './exit-codes'
import { waitForEvent } from './wait-for-event'

function eventFrame(seq: number, type: string): PublicEvent {
  return { seq, at: 1000 + seq, topic: 'chat', type, data: { sessionId: 's1' } }
}

/** A stream the test drives by hand: frames go out only when `emit` is called. */
function controllableStream() {
  let deliver: (frame: unknown) => void = () => {}
  let signal: AbortSignal | undefined
  const stream = vi.fn<RuntimeClient['stream']>(async (_method, _params, onFrame, options) => {
    deliver = onFrame
    signal = options?.signal
    await new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve()
        return
      }
      signal?.addEventListener('abort', () => resolve(), { once: true })
    })
  })
  return {
    client: { stream },
    stream,
    emit: (frame: unknown) => deliver(frame),
    wasAborted: () => signal?.aborted === true
  }
}

const READY = { type: 'ready', subscriptionId: 'sub-1', cursor: 7 }

describe('waitForEvent', () => {
  it('opens events.subscribe with no cursor and the requested topics', async () => {
    const fake = controllableStream()
    const done = waitForEvent(
      fake.client,
      { topics: ['chat'], match: () => true, timeoutMs: 1000 },
      async () => 'ok'
    )
    fake.emit(READY)
    fake.emit(eventFrame(8, 'turn.finished'))
    await done
    expect(fake.stream).toHaveBeenCalledTimes(1)
    const [method, params, , options] = fake.stream.mock.calls[0]
    expect(method).toBe('events.subscribe')
    expect(params).toEqual({ topics: ['chat'] })
    expect(options).toMatchObject({ publicContract: true })
  })

  it('does not run start until the ready frame arrives', async () => {
    const fake = controllableStream()
    const start = vi.fn(async () => 'started')
    const done = waitForEvent(fake.client, { match: () => true, timeoutMs: 1000 }, start)

    await Promise.resolve()
    expect(fake.stream).toHaveBeenCalledTimes(1)
    expect(start).not.toHaveBeenCalled()

    fake.emit(READY)
    expect(start).toHaveBeenCalledTimes(1)

    fake.emit(eventFrame(8, 'turn.finished'))
    await expect(done).resolves.toMatchObject({ result: 'started' })
  })

  it('resolves with the call result and the first matching event, ignoring others', async () => {
    const fake = controllableStream()
    const done = waitForEvent(
      fake.client,
      { match: (event) => event.type === 'turn.finished', timeoutMs: 1000 },
      async () => ({ turnId: 't1' })
    )
    fake.emit(READY)
    fake.emit(eventFrame(8, 'turn.started'))
    fake.emit(eventFrame(9, 'turn.finished'))
    fake.emit(eventFrame(10, 'turn.finished'))
    await expect(done).resolves.toEqual({
      result: { turnId: 't1' },
      event: eventFrame(9, 'turn.finished')
    })
  })

  it('catches an event that arrives before start has resolved', async () => {
    const fake = controllableStream()
    let finishStart: (value: string) => void = () => {}
    const start = () =>
      new Promise<string>((resolve) => {
        finishStart = resolve
      })
    const done = waitForEvent(fake.client, { match: () => true, timeoutMs: 1000 }, start)
    fake.emit(READY)
    fake.emit(eventFrame(8, 'turn.finished'))
    finishStart('late')
    await expect(done).resolves.toMatchObject({ result: 'late', event: { seq: 8 } })
  })

  it('ignores frames that are not events', async () => {
    const fake = controllableStream()
    const match = vi.fn(() => true)
    const done = waitForEvent(fake.client, { match, timeoutMs: 1000 }, async () => 1)
    fake.emit(READY)
    fake.emit({ type: 'events.gap', from: 1, oldest: 5 })
    fake.emit({ nonsense: true })
    expect(match).not.toHaveBeenCalled()
    fake.emit(eventFrame(8, 'turn.finished'))
    await done
    expect(match).toHaveBeenCalledTimes(1)
  })

  it('closes the stream once it has settled', async () => {
    const fake = controllableStream()
    const done = waitForEvent(fake.client, { match: () => true, timeoutMs: 1000 }, async () => 1)
    fake.emit(READY)
    fake.emit(eventFrame(8, 'turn.finished'))
    await done
    expect(fake.wasAborted()).toBe(true)
  })

  it('rejects with timeout, exit 6, when no matching event arrives in time', async () => {
    const fake = controllableStream()
    const done = waitForEvent(fake.client, { match: () => false, timeoutMs: 20 }, async () => 1)
    fake.emit(READY)
    const error = await done.catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'timeout' })
    expect(exitCodeFor(error)).toBe(6)
    expect(fake.wasAborted()).toBe(true)
  })

  it('rejects with what start rejects with and closes the stream', async () => {
    const fake = controllableStream()
    const done = waitForEvent(fake.client, { match: () => true, timeoutMs: 1000 }, async () => {
      throw new Error('send failed')
    })
    fake.emit(READY)
    await expect(done).rejects.toThrow('send failed')
    expect(fake.wasAborted()).toBe(true)
  })

  it('rejects when the stream fails before ready, without running start', async () => {
    const start = vi.fn(async () => 1)
    const client = {
      stream: vi.fn<RuntimeClient['stream']>(async () => {
        throw Object.assign(new Error('socket gone'), { code: 'runtime_unavailable' })
      })
    }
    await expect(
      waitForEvent(client, { match: () => true, timeoutMs: 1000 }, start)
    ).rejects.toThrow('socket gone')
    expect(start).not.toHaveBeenCalled()
  })

  it('rejects as unavailable when the stream ends with no match', async () => {
    const client = { stream: vi.fn<RuntimeClient['stream']>(async () => {}) }
    const error = await waitForEvent(
      client,
      { match: () => true, timeoutMs: 1000 },
      async () => 1
    ).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'unavailable' })
  })
})
