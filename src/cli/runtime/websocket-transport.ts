import type { PairedRuntimeConnection } from '../../shared/paired-runtime-connection'
import type { RemoteRuntimeRequestEnvelope } from '../../shared/remote-runtime-memory-limits'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import {
  sendRemoteRuntimeRequest,
  sendRemoteRuntimeRequestWithStatusPreflight,
  subscribeRemoteRuntimeRequest,
  type RemoteRuntimeSubscription
} from '../../shared/remote-runtime-client'
import { AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY } from '../../shared/agent-session-current-requests-capability'
import {
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../shared/protocol-version'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { isSafeTimerDelayMs, MAX_TIMER_DELAY_MS } from '../../shared/timer-delay'
import { RuntimeClientError, RuntimeRpcFailureError, type RuntimeRpcResponse } from './types'

/**
 * What the CLI adds to the shared remote capability set. The local socket reads as an in-process
 * caller and gets structured chat and current requests unconditionally; a paired socket gets them
 * only by naming them, so `quirky chat` behaves the same against either.
 */
export const CLI_REMOTE_CLIENT_CAPABILITIES: readonly RuntimeCapability[] = [
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY
]

export async function sendWebSocketRequest<TResult>(
  connection: PairedRuntimeConnection,
  method: string,
  params: unknown,
  timeoutMs: number,
  envelope?: RemoteRuntimeRequestEnvelope
): Promise<RuntimeRpcResponse<TResult>> {
  try {
    return await sendRemoteRuntimeRequest<TResult>(
      connection,
      method,
      params,
      timeoutMs,
      envelope,
      undefined,
      CLI_REMOTE_CLIENT_CAPABILITIES
    )
  } catch (error) {
    if (error instanceof RemoteRuntimeClientError) {
      throw new RuntimeClientError(error.code, error.message, error.data)
    }
    throw error
  }
}

export async function sendWebSocketRequestWithStatusPreflight<TResult>(
  connection: PairedRuntimeConnection,
  method: string,
  params: unknown,
  timeoutMs: number,
  validateStatus: (response: RuntimeRpcResponse<RuntimeStatus>) => void,
  envelope?: RemoteRuntimeRequestEnvelope
): Promise<RuntimeRpcResponse<TResult>> {
  try {
    return await sendRemoteRuntimeRequestWithStatusPreflight<TResult>(
      connection,
      method,
      params,
      timeoutMs,
      validateStatus,
      envelope,
      CLI_REMOTE_CLIENT_CAPABILITIES
    )
  } catch (error) {
    if (error instanceof RemoteRuntimeClientError) {
      throw new RuntimeClientError(error.code, error.message, error.data)
    }
    throw error
  }
}

export type WebSocketStreamOptions = {
  /** Bound on connecting and authenticating; the stream itself has no per-request timeout. */
  startTimeoutMs: number
  /** Wall-clock budget for the whole stream; unset means no limit. */
  timeoutMs?: number
  /** Aborting stops the stream cleanly: the promise resolves and no further frame is delivered. */
  signal?: AbortSignal
}

function isEndFrameResult(result: unknown): boolean {
  return (
    typeof result === 'object' && result !== null && (result as { type?: unknown }).type === 'end'
  )
}

/**
 * The remote counterpart of `sendStreamingRequest`: delivers each streamed result to `onFrame` and
 * resolves on the server's `{type:'end'}` frame or on abort. Rejects on a failure envelope, a
 * closed connection, or an elapsed `timeoutMs` (code `timeout`).
 */
export async function streamWebSocketRequest(
  connection: PairedRuntimeConnection,
  method: string,
  params: unknown,
  onFrame: (result: unknown) => void,
  options: WebSocketStreamOptions
): Promise<void> {
  const { signal, timeoutMs, startTimeoutMs } = options
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
    let subscription: RemoteRuntimeSubscription | null = null
    let settled = false
    let deadline: ReturnType<typeof setTimeout> | null = null

    const finish = (error?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      if (deadline) {
        clearTimeout(deadline)
      }
      signal?.removeEventListener('abort', onAbort)
      subscription?.close()
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

    subscribeRemoteRuntimeRequest<unknown>(
      connection,
      method,
      params,
      startTimeoutMs,
      {
        onResponse: (response) => {
          if (settled) {
            return
          }
          if (response.ok === false) {
            finish(new RuntimeRpcFailureError(response))
            return
          }
          if (isEndFrameResult(response.result)) {
            finish()
            return
          }
          try {
            onFrame(response.result)
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)))
          }
        },
        onError: (error) => finish(new RuntimeClientError(error.code, error.message, error.data)),
        onClose: () =>
          finish(
            new RuntimeClientError(
              'runtime_unavailable',
              'The remote Quirky runtime closed the stream before it ended.'
            )
          )
      },
      { signal, clientCapabilities: CLI_REMOTE_CLIENT_CAPABILITIES }
    ).then(
      (opened) => {
        subscription = opened
        if (settled) {
          opened.close()
        }
      },
      (error: unknown) => {
        if (signal?.aborted) {
          finish()
        } else if (error instanceof RemoteRuntimeClientError) {
          finish(new RuntimeClientError(error.code, error.message, error.data))
        } else {
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      }
    )
  })
}
