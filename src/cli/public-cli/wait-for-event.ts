import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/types'
import {
  PublicEventSchema,
  type PublicEvent,
  type PublicTopic
} from '../../shared/public-rpc/public-events'

export type WaitForEventOptions = {
  topics?: PublicTopic[]
  match: (event: PublicEvent) => boolean
  timeoutMs: number
}

export type WaitForEventResult<T> = { result: T; event: PublicEvent }

function isReadyFrame(frame: unknown): boolean {
  return typeof frame === 'object' && frame !== null && 'type' in frame && frame.type === 'ready'
}

/**
 * Runs `start()` and returns once an event matching `options.match` has been seen.
 *
 * The event stream is opened first and `start()` runs only after the server's `ready` frame, so an
 * event the call causes cannot arrive before anyone is listening. Rejects with `timeout` (exit 6)
 * when the call has not settled and a matching event has not arrived within `timeoutMs`, and with
 * whatever `start()` rejects with. `timeoutMs` bounds the whole operation, not just the event.
 */
export async function waitForEvent<T>(
  client: Pick<RuntimeClient, 'stream'>,
  options: WaitForEventOptions,
  start: () => Promise<T>
): Promise<WaitForEventResult<T>> {
  const stop = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let startCall: () => void = () => {}
  let started = false

  const result = new Promise<T>((resolve, reject) => {
    startCall = () => {
      if (started) {
        return
      }
      started = true
      start().then(resolve, reject)
    }
  })

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new RuntimeClientError(
          'timeout',
          `Timed out after ${options.timeoutMs}ms waiting for a matching event and the call to settle.`
        )
      )
    }, options.timeoutMs)
  })

  const event = new Promise<PublicEvent>((resolve, reject) => {
    const params = options.topics ? { topics: options.topics } : {}
    client
      .stream(
        'events.subscribe',
        params,
        (frame) => {
          if (isReadyFrame(frame)) {
            startCall()
            return
          }
          const parsed = PublicEventSchema.safeParse(frame)
          if (started && parsed.success && options.match(parsed.data)) {
            resolve(parsed.data)
          }
        },
        { signal: stop.signal, publicContract: true }
      )
      .then(
        () =>
          reject(
            new RuntimeClientError(
              'unavailable',
              'The event stream ended before a matching event arrived.'
            )
          ),
        reject
      )
  })

  try {
    const [settled, matched] = await Promise.race([Promise.all([result, event]), deadline])
    return { result: settled, event: matched }
  } finally {
    clearTimeout(timer)
    stop.abort()
  }
}
