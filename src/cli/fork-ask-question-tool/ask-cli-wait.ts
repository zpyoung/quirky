import { RuntimeRpcFailureError, type RuntimeClient } from '../runtime-client'
import {
  pendingEnvelope,
  type AskEnvelope
} from '../../shared/fork-ask-question-tool/ask-answer-envelope'
import { resolveAskWaitClientTimeoutMs } from '../../shared/fork-ask-question-tool/ask-question-schema'
import { callWithTransportRetry, isRetryableTransportError } from './ask-cli-transport-retry'

const REACHABILITY_PROBE_TIMEOUT_MS = 2_000

/**
 * Answers whether the host is still reachable after a wait chunk lost its transport.
 * Any answer at all — including an RPC failure — counts as reachable, because it proves
 * the durable ask is still resumable; only a second bare transport failure does not.
 */
async function isRuntimeReachable(client: RuntimeClient): Promise<boolean> {
  try {
    await client.call('status.get', undefined, { timeoutMs: REACHABILITY_PROBE_TIMEOUT_MS })
    return true
  } catch (error) {
    return !isRetryableTransportError(error)
  }
}

/**
 * Blocks on one `ask.wait` chunk, resolving to a resumable pending envelope whenever the
 * ask survives — bare transport retries exhausted against a host that still answers, or a
 * host too busy to park another long poll. An unreachable host keeps its original
 * transport error so the caller still learns Quirky is not running.
 */
export async function waitAskChunkWithRetry(
  client: RuntimeClient,
  askId: string,
  chunkMs: number | undefined
): Promise<AskEnvelope> {
  try {
    const response = await callWithTransportRetry(() =>
      client.call<AskEnvelope>(
        'ask.wait',
        { askId, chunkMs },
        { timeoutMs: resolveAskWaitClientTimeoutMs(chunkMs) }
      )
    )
    return response.result
  } catch (error) {
    if (error instanceof RuntimeRpcFailureError && error.code === 'runtime_busy') {
      return pendingEnvelope(askId)
    }
    if (!isRetryableTransportError(error)) {
      throw error
    }
    if (!(await isRuntimeReachable(client))) {
      throw error
    }
    return pendingEnvelope(askId)
  }
}
