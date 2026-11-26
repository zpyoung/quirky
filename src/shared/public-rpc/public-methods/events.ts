import { z } from 'zod'
import {
  EventsGapFrameSchema,
  EventsReadyFrameSchema,
  PublicEventSchema,
  PublicTopicSchema
} from '../public-events'
import { definePublicMethod, type PublicMethodSpec } from '../public-method-spec'

/** Defined here until an rpc-contract params entry exists; the RPC method imports it from this file. */
export const EventsSubscribeParams = z.object({
  topics: z.array(PublicTopicSchema).min(1).optional(),
  after: z.number().int().nonnegative().optional()
})

export const EventsUnsubscribeParams = z.object({
  subscriptionId: z.string().min(1)
})

const EventsEndFrameSchema = z.object({ type: z.literal('end') })

/** A frame is the ready frame, a gap notice, a bare public event, or the end marker. */
export const EventsFrameSchema = z.union([
  EventsReadyFrameSchema,
  EventsGapFrameSchema,
  EventsEndFrameSchema,
  PublicEventSchema
])

export const EVENT_PUBLIC_METHODS: readonly PublicMethodSpec[] = [
  definePublicMethod({
    method: 'events.subscribe',
    cliPath: ['events'],
    summary: 'Stream Quirky events (chat turns, UI focus, notifications, workspace, activity)',
    stability: 'stable',
    effect: 'read',
    params: EventsSubscribeParams,
    result: EventsFrameSchema,
    errors: ['invalid_argument', 'unavailable'],
    streaming: true
  }),
  definePublicMethod({
    method: 'events.unsubscribe',
    cliPath: ['events', 'unsubscribe'],
    summary: 'End an event stream by its subscription id',
    stability: 'stable',
    effect: 'mutate',
    params: EventsUnsubscribeParams,
    result: z.object({ unsubscribed: z.boolean() }),
    positionals: ['subscriptionId'],
    errors: ['invalid_argument', 'unavailable']
  })
]
