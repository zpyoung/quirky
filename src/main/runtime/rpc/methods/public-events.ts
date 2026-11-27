import { randomUUID } from 'node:crypto'
import { PUBLIC_TOPICS } from '../../../../shared/public-rpc/public-events'
import {
  EventsSubscribeParams,
  EventsUnsubscribeParams
} from '../../../../shared/public-rpc/public-methods/events'
import { defineMethod, defineStreamingMethod } from '../core'

const SUBSCRIPTION_ID_PREFIX = 'public-events-'

export const PUBLIC_EVENT_METHODS = [
  defineStreamingMethod({
    name: 'events.subscribe',
    permission: 'workspace',
    params: EventsSubscribeParams,
    handler: async (params, { runtime, connectionId, signal }, emit) => {
      const bus = runtime.publicEvents
      const topics = params.topics ?? PUBLIC_TOPICS
      const wanted = new Set<string>(topics)
      const subscriptionId = `${SUBSCRIPTION_ID_PREFIX}${randomUUID()}`

      await new Promise<void>((resolve) => {
        let closed = false
        let stopListening = (): void => {}
        const onAbort = (): void => runtime.cleanupSubscription(subscriptionId)
        const cleanup = (): void => {
          if (closed) {
            return
          }
          closed = true
          stopListening()
          signal?.removeEventListener('abort', onAbort)
          emit({ type: 'end' })
          resolve()
        }
        runtime.registerSubscriptionCleanup(subscriptionId, cleanup, connectionId)

        // Nothing publishes between the cursor read, the replay and the listener, so no event is lost or doubled.
        const cursor = bus.latestSeq()
        emit({ type: 'ready', subscriptionId, cursor })
        const missed = bus.since(params.after, topics)
        if (!Array.isArray(missed)) {
          emit({ type: 'events.gap', ...missed.gap })
        }
        const replay = Array.isArray(missed)
          ? missed
          : bus.retainedAfter(missed.gap.oldest - 1, topics)
        for (const event of replay) {
          emit(event)
        }
        stopListening = bus.subscribe((event) => {
          if (wanted.has(event.topic)) {
            emit(event)
          }
        })

        if (signal?.aborted) {
          onAbort()
        } else {
          signal?.addEventListener('abort', onAbort, { once: true })
        }
      })
    }
  }),
  defineMethod({
    name: 'events.unsubscribe',
    permission: 'workspace',
    params: EventsUnsubscribeParams,
    handler: async ({ subscriptionId }, { runtime, connectionId }) => {
      if (!subscriptionId.startsWith(SUBSCRIPTION_ID_PREFIX)) {
        return { unsubscribed: false }
      }
      return {
        unsubscribed: runtime.cleanupSubscriptionIfOwnedByConnection(subscriptionId, connectionId)
      }
    }
  })
]
