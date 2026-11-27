import { RuntimeRpcFailureError, type RuntimeClient } from '../runtime-client'
import {
  pendingEnvelope,
  type AskEnvelope
} from '../../shared/fork-ask-question-tool/ask-answer-envelope'
import {
  ASK_DEFAULT_CHUNK_MS,
  resolveAskWaitClientTimeoutMs
} from '../../shared/fork-ask-question-tool/ask-question-schema'
import { callWithTransportRetry, isRetryableTransportError } from './ask-cli-transport-retry'

export const ASK_CLI_BUSY_BACKOFF_MS = 1_000
export const ASK_CLI_BUSY_JITTER_MS = 1_000
export const ASK_CLI_TRANSPORT_LOSS_PAUSE_MS = 2_000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pauseBeforeRetry(error: unknown): number | null {
  if (error instanceof RuntimeRpcFailureError && error.code === 'runtime_busy') {
    return ASK_CLI_BUSY_BACKOFF_MS + Math.random() * ASK_CLI_BUSY_JITTER_MS
  }
  return isRetryableTransportError(error) ? ASK_CLI_TRANSPORT_LOSS_PAUSE_MS : null
}

/**
 * Blocks on `ask.wait` for one chunk and resolves to the envelope, or to a resumable `pending`
 * envelope once the chunk budget is spent. A host that sheds the wait as busy, or drops the
 * transport (an app restart), is retried inside that budget, because the ask is durable and a
 * restarted host resumes it. That patience applies only once the runtime has answered at least
 * once (`hasContactedRuntime` for a caller that already registered); a runtime that never answered
 * keeps the short transport retry and then throws, so "Quirky is not running" still surfaces.
 */
export async function waitAskChunkWithRetry(
  client: RuntimeClient,
  askId: string,
  chunkMs: number | undefined,
  hasContactedRuntime = false
): Promise<AskEnvelope> {
  let contacted = hasContactedRuntime
  const deadline = Date.now() + (chunkMs ?? ASK_DEFAULT_CHUNK_MS)
  let attemptChunkMs = chunkMs
  for (;;) {
    try {
      const response = await callWithTransportRetry(() =>
        client.call<AskEnvelope>(
          'ask.wait',
          { askId, chunkMs: attemptChunkMs },
          { timeoutMs: resolveAskWaitClientTimeoutMs(attemptChunkMs) }
        )
      )
      return response.result
    } catch (error) {
      if (error instanceof RuntimeRpcFailureError) {
        contacted = true
      }
      if (!contacted && isRetryableTransportError(error)) {
        throw error
      }
      const pause = pauseBeforeRetry(error)
      if (pause === null) {
        throw error
      }
      if (Date.now() + pause >= deadline) {
        return pendingEnvelope(askId)
      }
      await delay(pause)
      attemptChunkMs = Math.max(deadline - Date.now(), 1)
    }
  }
}
