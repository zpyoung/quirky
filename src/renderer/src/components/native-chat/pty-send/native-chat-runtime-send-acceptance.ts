// Acceptance-aware body writes for the composer send pipeline: unlike the
// fire-and-forget `sendRuntimePtyInput`, every write here is confirmed before
// the caller is allowed to schedule the submit CR, so a rejected/suppressed
// write can never be followed by a CR as if the body had landed.

import {
  sendObservedWrite,
  type NativeChatDeliveryObserver,
  type SendOutcome
} from './native-chat-send-outcome'

/**
 * Sends `chunks` one at a time, stopping at the first rejection or
 * cancellation. A false/cancelled result means some bytes may already be on
 * screen (e.g. an earlier image in the loop) but the sequence as a whole did
 * not complete, so callers must treat it as `may-not-have-sent`.
 */
export function sendBodyAccepted(
  ptyId: string,
  chunks: readonly string[],
  isCancelled: () => boolean,
  delivery?: NativeChatDeliveryObserver
): Promise<boolean> {
  return chunks.reduce<Promise<boolean>>(
    (chain, bytes) =>
      chain.then((ok) => {
        if (!ok || isCancelled()) {
          return false
        }
        return sendObservedWrite(ptyId, bytes, isCancelled, delivery)
      }),
    Promise.resolve(true)
  )
}

/**
 * Runs `sendBodyAccepted`, then either `onAccepted` or a single
 * `may-not-have-sent` report — covering cancellation, rejection, and a thrown
 * transport error alike, so the caller never issues a follow-up write (the
 * submit CR) unless the body is confirmed on the PTY.
 */
export function runBodyAcceptedThen(
  ptyId: string,
  chunks: readonly string[],
  isCancelled: () => boolean,
  markSubmitted: () => void,
  reportOutcome: (outcome: SendOutcome) => void,
  onAccepted: () => void,
  delivery?: NativeChatDeliveryObserver
): void {
  sendBodyAccepted(ptyId, chunks, isCancelled, delivery)
    .then((accepted) => {
      if (isCancelled()) {
        reportOutcome('may-not-have-sent')
        return
      }
      if (!accepted) {
        // A rejected write leaves the composer empty, so confirmSubmitted would
        // misread that as a landed send — the CR must not follow it.
        markSubmitted()
        reportOutcome('may-not-have-sent')
        return
      }
      onAccepted()
    })
    .catch(() => {
      markSubmitted()
      reportOutcome('may-not-have-sent')
    })
}
