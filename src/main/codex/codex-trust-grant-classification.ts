import { WSL_CODEX_NOT_FOUND_MESSAGE } from '../codex-accounts/wsl-codex-command'

export type CodexTrustGrantFallbackReason =
  | 'disabled'
  | 'no-managed-entries'
  | 'unsupported'
  | 'unsupported-cached'
  | 'verify-failed'
  | 'retry-cached'
  | 'error'

/** Closed classification of `reason: 'error'` fallbacks. Only timeout and
 *  unsupported carry a stable error name, so the rest are matched on the
 *  bounded message shapes each layer produces — never forwarded raw. */
export type CodexTrustGrantErrorClass =
  | 'binary-missing'
  | 'timeout'
  | 'entry-failed'
  | 'early-exit'
  | 'rpc-failed'
  | 'unexpected'

export function classifyCodexTrustGrantError(error: unknown): CodexTrustGrantErrorClass {
  if (!(error instanceof Error)) {
    return 'unexpected'
  }
  if (error.name === 'CodexAppServerTimeoutError') {
    return 'timeout'
  }
  const message = error.message
  if (message.includes('codex trust-grant entry')) {
    return 'entry-failed'
  }
  if (
    /^spawn (?:.*[\\/])?codex(?:\.(?:cmd|exe|bat))? ENOENT$/.test(message) ||
    message.includes(WSL_CODEX_NOT_FOUND_MESSAGE)
  ) {
    return 'binary-missing'
  }
  if (message.includes('exited before completing the session')) {
    return 'early-exit'
  }
  if (/codex app-server \S+ failed:/.test(message)) {
    return 'rpc-failed'
  }
  return 'unexpected'
}
