import {
  sendRuntimePtyInput,
  sendRuntimePtyInputAcceptance
} from '@/runtime/runtime-terminal-inspection'
import { AGENT_TUI_CLEAR_INPUT_MAX } from '../../../../../shared/agent-tui-input-clear'
import type { NativeChatSendOptions } from '../native-chat-runtime-send'

export const NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT = '\x15'
export const NATIVE_CHAT_CLEAR_CONFIRM_MS = 140

/**
 * Claude Code takes any single stdin read of 64+ bytes as a paste, keeps a clear
 * burst's control bytes as literal text, and then refuses to submit ("Removed N
 * invisible characters"). A pty read can coalesce two writes, so each write
 * carries under half that.
 */
export const NATIVE_CHAT_CLEAR_CHUNK_MAX_BYTES = 31
export const NATIVE_CHAT_CLEAR_CHUNK_GAP_MS = 16

/** Splits a clear burst into writes that stay below the agent's paste threshold. */
function splitClearBurst(clearBytes: string): string[] {
  const chunks: string[] = []
  for (let start = 0; start < clearBytes.length; start += NATIVE_CHAT_CLEAR_CHUNK_MAX_BYTES) {
    chunks.push(clearBytes.slice(start, start + NATIVE_CHAT_CLEAR_CHUNK_MAX_BYTES))
  }
  return chunks
}

/**
 * Best-effort cleanup clear (e.g. after cancel) — not gating a body write,
 * so it stays on the fire-and-forget transport. Later chunks are paced through
 * `delay`, which must be owned by the PTY send queue so they cannot outlive the
 * line; the promise settles once the last chunk is written.
 */
export function clearUnsubmittedAgentInput(
  ptyId: string,
  options: NativeChatSendOptions | undefined,
  delay: (ms: number, fn: () => void) => void
): Promise<void> {
  const [first = '', ...rest] = splitClearBurst(
    options?.clearInput ?? NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT
  )
  sendRuntimePtyInput(ptyId, first, 'driving')
  return new Promise<void>((resolve) => {
    if (rest.length === 0) {
      resolve()
      return
    }
    rest.forEach((chunk, index) => {
      delay((index + 1) * NATIVE_CHAT_CLEAR_CHUNK_GAP_MS, () => {
        try {
          sendRuntimePtyInput(ptyId, chunk, 'driving')
        } finally {
          if (index === rest.length - 1) {
            resolve()
          }
        }
      })
    })
  })
}

/** Resolves true only once every chunk of the burst is accepted, in order. */
function sendClearBurstAccepted(
  ptyId: string,
  clearBytes: string,
  delay: (ms: number, fn: () => void) => void
): Promise<boolean> {
  const [first = '', ...rest] = splitClearBurst(clearBytes)
  return rest.reduce<Promise<boolean>>(
    (chain, chunk) =>
      chain.then((accepted) =>
        accepted
          ? new Promise<boolean>((resolve, reject) => {
              delay(NATIVE_CHAT_CLEAR_CHUNK_GAP_MS, () => {
                sendRuntimePtyInputAcceptance(ptyId, chunk, 'driving').then(resolve, reject)
              })
            })
          : false
      ),
    sendRuntimePtyInputAcceptance(ptyId, first, 'driving')
  )
}

/**
 * Clears the line, then hands off to `writeBody` — never before the clear
 * (and, when observed unclear, the maximal-clear escalation) is confirmed
 * accepted by the transport, so a rejected remote clear can't be followed by
 * a body that appends to residual text.
 */
export function clearThenWrite(
  ptyId: string,
  options: NativeChatSendOptions | undefined,
  delay: (ms: number, fn: () => void) => void,
  writeBody: () => void,
  rejectSend: () => void
): void {
  sendClearBurstAccepted(ptyId, options?.clearInput ?? NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT, delay)
    .then((cleared) => {
      if (!cleared) {
        rejectSend()
        return
      }
      const confirmCleared = options?.confirmCleared
      if (!confirmCleared) {
        writeBody()
        return
      }
      delay(NATIVE_CHAT_CLEAR_CONFIRM_MS, () => {
        let confirmed = false
        try {
          confirmed = confirmCleared()
        } catch {
          // An unreadable terminal is unconfirmed; the maximal clear remains safe.
        }
        if (confirmed) {
          writeBody()
          return
        }
        sendClearBurstAccepted(ptyId, AGENT_TUI_CLEAR_INPUT_MAX, delay)
          .then((escalated) => {
            if (!escalated) {
              rejectSend()
              return
            }
            writeBody()
          })
          .catch(rejectSend)
      })
    })
    .catch(rejectSend)
}

export function clearConfirmDurationMs(options?: NativeChatSendOptions): number {
  return options?.confirmCleared ? NATIVE_CHAT_CLEAR_CONFIRM_MS : 0
}
