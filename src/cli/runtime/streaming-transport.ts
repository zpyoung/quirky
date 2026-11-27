import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { findTransport, type RuntimeMetadata } from '../../shared/runtime-bootstrap'
import type { ExpectedRuntimeSource } from '../../shared/runtime-rpc-envelope'
import { MAX_TIMER_DELAY_MS, isSafeTimerDelayMs } from '../../shared/timer-delay'
import { isKeepaliveFrame, RuntimeRpcEnvelopeSchema } from './envelope-schema'
import { runtimeAccessDeniedError } from './runtime-access-denied'
import type { PublicRequestFields } from './transport'
import { RuntimeClientError, RuntimeRpcFailureError } from './types'

export type StreamingRequestOptions = {
  /** Aborting stops the stream cleanly: the promise resolves and no further frame is delivered. */
  signal?: AbortSignal
  /** Wall-clock budget for the whole stream; keepalives do not extend it. Unset means no limit. */
  timeoutMs?: number
  publicRequest?: PublicRequestFields
  expectedRuntimeSource?: ExpectedRuntimeSource
}

function isEndFrameResult(result: unknown): boolean {
  return (
    typeof result === 'object' && result !== null && (result as { type?: unknown }).type === 'end'
  )
}

function invalidFrameError(): RuntimeClientError {
  return new RuntimeClientError(
    'invalid_runtime_response',
    'The Quirky runtime returned an invalid response frame.'
  )
}

/**
 * Sends one request over the local unix socket and delivers every `streaming: true` success frame's
 * `result` to `onFrame`. Resolves when the server sends `{type:'end'}`, or when `signal` aborts.
 * Rejects on a failure envelope, a socket that closes before the end frame, or an elapsed
 * `timeoutMs` (code `timeout`). There is no per-request timeout: a quiet stream is a healthy one.
 */
export async function sendStreamingRequest(
  metadata: RuntimeMetadata,
  method: string,
  params: unknown,
  onFrame: (result: unknown) => void,
  options: StreamingRequestOptions = {}
): Promise<void> {
  const { signal, timeoutMs } = options
  if (timeoutMs !== undefined && !isSafeTimerDelayMs(timeoutMs)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Stream timeout must be an integer between 0 and ${MAX_TIMER_DELAY_MS}ms.`
    )
  }
  if (signal?.aborted) {
    return
  }
  return await new Promise<void>((resolve, reject) => {
    const transport = findTransport(metadata, 'unix', 'named-pipe')
    if (!transport) {
      reject(
        new RuntimeClientError(
          'runtime_unavailable',
          'No compatible transport found in Quirky runtime metadata.'
        )
      )
      return
    }
    const socket = createConnection(transport.endpoint)
    const requestId = randomUUID()
    let buffered = ''
    let settled = false
    let deadline: ReturnType<typeof setTimeout> | null = null

    const finish = (error?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      buffered = ''
      if (deadline) {
        clearTimeout(deadline)
      }
      signal?.removeEventListener('abort', onAbort)
      socket.destroy()
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }

    const onAbort = (): void => finish()
    signal?.addEventListener('abort', onAbort, { once: true })

    if (timeoutMs !== undefined) {
      deadline = setTimeout(() => {
        finish(
          new RuntimeClientError('timeout', 'Timed out waiting for the Quirky runtime stream.')
        )
      }, timeoutMs)
    }

    const handleLine = (line: string): void => {
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        finish(invalidFrameError())
        return
      }
      if (isKeepaliveFrame(raw)) {
        return
      }
      const parsed = RuntimeRpcEnvelopeSchema.safeParse(raw)
      if (!parsed.success || '_keepalive' in parsed.data) {
        finish(invalidFrameError())
        return
      }
      // the envelope schema strips `streaming`, so the flag is read from the raw frame
      const streaming = (raw as { streaming?: unknown }).streaming === true
      const frame = parsed.data
      if (frame.id !== requestId) {
        finish(
          new RuntimeClientError(
            'invalid_runtime_response',
            'The Quirky runtime returned a mismatched response id.'
          )
        )
        return
      }
      if (frame._meta?.runtimeId && frame._meta.runtimeId !== metadata.runtimeId) {
        finish(
          new RuntimeClientError(
            'runtime_unavailable',
            'The Quirky runtime changed while the request was in flight. Retry the command.'
          )
        )
        return
      }
      if (frame.ok === false) {
        finish(new RuntimeRpcFailureError(frame))
        return
      }
      if (isEndFrameResult(frame.result)) {
        finish()
        return
      }
      try {
        onFrame(frame.result)
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
        return
      }
      // a runtime that answers a stream method with one plain response has nothing more to send
      if (!streaming) {
        finish()
      }
    }

    socket.setEncoding('utf8')
    socket.once('error', (error) => {
      finish(
        runtimeAccessDeniedError(error, metadata.pid) ??
          new RuntimeClientError(
            'runtime_unavailable',
            'Could not connect to the running Quirky app. Restart Quirky and try again.'
          )
      )
    })
    socket.once('close', () => {
      finish(
        new RuntimeClientError(
          'runtime_unavailable',
          'The Quirky runtime closed the connection before the stream ended. Restart Quirky and try again.'
        )
      )
    })
    socket.on('data', (chunk: string) => {
      buffered += chunk
      let newlineIndex = buffered.indexOf('\n')
      while (newlineIndex !== -1 && !settled) {
        const line = buffered.slice(0, newlineIndex)
        buffered = buffered.slice(newlineIndex + 1)
        if (line.trim().length > 0) {
          handleLine(line)
        }
        newlineIndex = buffered.indexOf('\n')
      }
    })
    socket.on('connect', () => {
      socket.write(
        `${JSON.stringify({
          id: requestId,
          authToken: metadata.authToken,
          method,
          params,
          publicContract: options.publicRequest?.publicContract,
          confirm: options.publicRequest?.confirm,
          caller: options.publicRequest?.caller,
          expectedRuntimeSource: options.expectedRuntimeSource
        })}\n`
      )
    })
  })
}
