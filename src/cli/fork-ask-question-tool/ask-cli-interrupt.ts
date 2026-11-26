import type { RuntimeClient } from '../runtime-client'

const CANCEL_TIMEOUT_MS = 2_000
const SIGINT_EXIT_CODE = 130
const SIGTERM_EXIT_CODE = 143

type SignalSource = {
  once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
}

/**
 * Cancels `askId` when the process is interrupted while blocked on it, so an abandoned ask does
 * not keep a card open for a human to answer into nothing. Best effort: a failed cancel never
 * blocks the exit. Returns the disposer that restores default signal handling.
 */
export function cancelAskOnInterrupt(
  client: Pick<RuntimeClient, 'call'>,
  askId: string,
  exit: (code: number) => void = (code) => process.exit(code),
  signals: SignalSource = process
): () => void {
  const handlerFor = (exitCode: number) => async (): Promise<void> => {
    try {
      await client.call('ask.cancel', { askId }, { timeoutMs: CANCEL_TIMEOUT_MS })
    } catch {
      // the host may already be gone; exiting matters more than the cancel
    }
    exit(exitCode)
  }
  const onSigint = handlerFor(SIGINT_EXIT_CODE)
  const onSigterm = handlerFor(SIGTERM_EXIT_CODE)
  signals.once('SIGINT', onSigint)
  signals.once('SIGTERM', onSigterm)
  return () => {
    signals.off('SIGINT', onSigint)
    signals.off('SIGTERM', onSigterm)
  }
}
