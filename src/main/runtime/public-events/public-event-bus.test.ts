import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PUBLIC_EVENT_BUFFER_MAX_AGE_MS,
  PUBLIC_EVENT_BUFFER_MAX_EVENTS,
  PublicEventBus,
  type PublicEventInput
} from './public-event-bus'

function chatEvent(sessionId = 's1'): PublicEventInput {
  return { topic: 'chat', type: 'turn.finished', data: { sessionId } }
}

function uiEvent(): PublicEventInput {
  return { topic: 'ui', type: 'focus.changed', data: { worktreeId: 'wt-1' } }
}

describe('PublicEventBus', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('numbers events from 1 and stamps the clock time', () => {
    let now = 1000
    const bus = new PublicEventBus(() => now)
    const seen: number[] = []
    bus.subscribe((event) => seen.push(event.seq))

    expect(bus.latestSeq()).toBe(0)
    bus.publish(chatEvent())
    now = 2000
    bus.publish(uiEvent())

    expect(seen).toEqual([1, 2])
    expect(bus.latestSeq()).toBe(2)
    expect(bus.since(0, ['chat', 'ui'])).toMatchObject([
      { seq: 1, at: 1000, topic: 'chat' },
      { seq: 2, at: 2000, topic: 'ui' }
    ])
  })

  it('replays only events after the cursor on the requested topics', () => {
    const bus = new PublicEventBus()
    bus.publish(chatEvent('a'))
    bus.publish(uiEvent())
    bus.publish(chatEvent('b'))

    const replay = bus.since(1, ['chat'])

    expect(replay).toMatchObject([{ seq: 3, data: { sessionId: 'b' } }])
  })

  it('replays nothing when no cursor is given', () => {
    const bus = new PublicEventBus()
    bus.publish(chatEvent())

    expect(bus.since(undefined, ['chat'])).toEqual([])
  })

  it('does not report a gap for a cursor at the oldest retained event', () => {
    const bus = new PublicEventBus()
    for (let index = 0; index < PUBLIC_EVENT_BUFFER_MAX_EVENTS + 1; index += 1) {
      bus.publish(chatEvent())
    }

    const replay = bus.since(1, ['chat'])

    expect(Array.isArray(replay)).toBe(true)
    expect(Array.isArray(replay) && replay.length).toBe(PUBLIC_EVENT_BUFFER_MAX_EVENTS)
  })

  it('keeps only the last 5000 events and reports what a stale cursor missed', () => {
    const bus = new PublicEventBus()
    for (let index = 0; index < PUBLIC_EVENT_BUFFER_MAX_EVENTS + 1; index += 1) {
      bus.publish(chatEvent())
    }

    expect(bus.since(0, ['chat'])).toEqual({ gap: { from: 1, oldest: 2 } })
  })

  it('drops events older than ten minutes even when the count bound is not reached', () => {
    let now = 0
    const bus = new PublicEventBus(() => now)
    bus.publish(chatEvent())
    bus.publish(chatEvent())
    now = PUBLIC_EVENT_BUFFER_MAX_AGE_MS + 1
    bus.publish(chatEvent())

    expect(bus.since(0, ['chat'])).toEqual({ gap: { from: 1, oldest: 3 } })
    expect(bus.since(2, ['chat'])).toMatchObject([{ seq: 3 }])
  })

  it('keeps an event that is exactly ten minutes old', () => {
    let now = 0
    const bus = new PublicEventBus(() => now)
    bus.publish(chatEvent())
    now = PUBLIC_EVENT_BUFFER_MAX_AGE_MS

    expect(bus.since(0, ['chat'])).toMatchObject([{ seq: 1 }])
  })

  it('reports a gap once every retained event has expired', () => {
    let now = 0
    const bus = new PublicEventBus(() => now)
    bus.publish(chatEvent())
    now = PUBLIC_EVENT_BUFFER_MAX_AGE_MS + 1

    expect(bus.since(0, ['chat'])).toEqual({ gap: { from: 1, oldest: 2 } })
    expect(bus.since(1, ['chat'])).toEqual([])
  })

  it('delivers live events until the listener unsubscribes', () => {
    const bus = new PublicEventBus()
    const listener = vi.fn()
    const unsubscribe = bus.subscribe(listener)

    bus.publish(chatEvent())
    unsubscribe()
    bus.publish(chatEvent())

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('keeps delivering to other listeners when one throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const bus = new PublicEventBus()
    const received: number[] = []
    bus.subscribe(() => {
      throw new Error('boom')
    })
    bus.subscribe((event) => received.push(event.seq))

    bus.publish(chatEvent())

    expect(received).toEqual([1])
  })
})
