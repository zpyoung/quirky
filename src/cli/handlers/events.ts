import type { CommandHandler } from '../dispatch'
import {
  getOptionalNonNegativeIntegerFlag,
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag
} from '../flags'
import { RuntimeClientError } from '../runtime/types'
import { PUBLIC_TOPICS, type PublicTopic } from '../../shared/public-rpc/public-events'

function parseTopics(raw: string | undefined): PublicTopic[] | undefined {
  if (raw === undefined) {
    return undefined
  }
  const requested = raw
    .split(',')
    .map((topic) => topic.trim())
    .filter((topic) => topic.length > 0)
  const topics = requested.filter((topic): topic is PublicTopic =>
    PUBLIC_TOPICS.some((known) => known === topic)
  )
  if (topics.length !== requested.length || topics.length === 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--topic takes a comma-separated list of: ${PUBLIC_TOPICS.join(', ')}`
    )
  }
  return topics
}

function frameType(frame: unknown): unknown {
  return typeof frame === 'object' && frame !== null && 'type' in frame ? frame.type : undefined
}

export const EVENTS_HANDLERS: Record<string, CommandHandler> = {
  events: async ({ flags, client }) => {
    const topics = parseTopics(getOptionalStringFlag(flags, 'topic'))
    const after = getOptionalNonNegativeIntegerFlag(flags, 'after')
    const until = getOptionalStringFlag(flags, 'until')
    const timeoutMs = getOptionalPositiveIntegerFlag(flags, 'timeout')
    const params = {
      ...(topics ? { topics } : {}),
      ...(after === undefined ? {} : { after })
    }
    const stop = new AbortController()
    let matched = false
    try {
      await client.stream(
        'events.subscribe',
        params,
        (frame) => {
          console.log(JSON.stringify(frame))
          if (until !== undefined && frameType(frame) === until) {
            matched = true
            stop.abort()
          }
        },
        { signal: stop.signal, timeoutMs, publicContract: true }
      )
    } catch (error) {
      // a bare --timeout is a listening window, so running out of time is a normal finish
      if (until === undefined && error instanceof RuntimeClientError && error.code === 'timeout') {
        return
      }
      throw error
    }
    if (until !== undefined && !matched) {
      throw new RuntimeClientError(
        'unavailable',
        `The event stream ended before an event of type ${until} arrived.`
      )
    }
  }
}
