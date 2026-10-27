/**
 * The error every remote operation throws: git's stderr turned into a stable `reason` and a
 * message that is safe to show, with credentials removed from everything the error carries.
 */
import { capOutput, classifyPushFailure, isPushHookFailure, stripAnsi } from './failure'

export type RemoteAction = 'push' | 'force-push' | 'pull' | 'fast-forward' | 'fetch' | 'rebase'

export type RemoteErrorReason =
  | 'non-fast-forward'
  | 'stale-lease'
  | 'auth'
  | 'network'
  | 'no-upstream'
  | 'detached'
  | 'divergent-policy'
  | 'local-changes'
  | 'untracked-overwrite'
  | 'conflicts'
  | 'hook'
  | 'lint'
  | 'invalid-base'
  | 'failed'

const CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s]+@/gi
const DETAIL_LIMIT = 200

/** `text` with the userinfo of every `scheme://user:pass@host` or `scheme://token@host` replaced by `***`. */
export function redactCredentials(text: string): string {
  return text.replace(CREDENTIALS, '$1***@')
}

/**
 * A failed remote operation. `message` is safe to show; `summary` and `output` are set for hook
 * and lint failures. Message and output are redacted and `output` is ANSI-stripped and capped at
 * 64 KiB, whatever the caller passed.
 */
export class RemoteError extends Error {
  readonly reason: RemoteErrorReason
  readonly summary?: string
  readonly output?: string

  constructor(reason: RemoteErrorReason, message: string, extra: { summary?: string; output?: string } = {}) {
    super(redactCredentials(message))
    this.name = 'RemoteError'
    this.reason = reason
    if (extra.summary !== undefined) this.summary = redactCredentials(extra.summary)
    if (extra.output !== undefined) this.output = redactCredentials(capOutput(stripAnsi(extra.output)))
  }
}

const AUTH = /Authentication failed|Permission denied|could not read Username|Host key verification failed|terminal prompts disabled/i
const NETWORK = /Could not resolve host|Connection refused|Connection timed out|unable to access|Network is unreachable|Could not read from remote repository/i
const SUBMODULE_PUSH = /failed to push all needed submodules|submodule paths contain changes|Pushing submodule/i
const PREFIXED = /^(fatal|error):/

const AUTH_MESSAGE = 'Authentication failed. Check your remote credentials.'
const NETWORK_MESSAGE = 'Network error. Check your connection.'
const FAILED_FALLBACK: Record<RemoteAction, string> = {
  push: 'Push failed.',
  'force-push': 'Force push failed.',
  pull: 'Pull failed.',
  'fast-forward': 'Fast-forward failed.',
  fetch: 'Fetch failed.',
  rebase: 'Rebase failed.'
}

/** The last run of `fatal:`/`error:` lines, else the last non-empty line, else ''. */
function lastErrorBlock(lines: string[]): string {
  const last = lines.map((l, i) => (PREFIXED.test(l) ? i : -1)).filter((i) => i >= 0).pop() ?? -1
  if (last === -1) return lines.filter((l) => l.length > 0).pop() ?? ''
  let first = last
  while (first > 0 && PREFIXED.test(lines[first - 1]!)) first--
  return lines.slice(first, last + 1).join(' ')
}

/**
 * Maps a failed remote command's output to a reason and a message, first match wins (submodule
 * push, non-fast-forward, stale lease, push hook, auth, network, no upstream, divergent policy,
 * local changes, untracked overwrite, conflicts, else the last git error). Credentials are
 * removed before anything is matched; only hook and lint results carry `summary` and `output`.
 */
export function normalizeRemoteError(
  action: RemoteAction,
  stderr: string,
  stdout: string
): { reason: RemoteErrorReason; message: string; summary?: string; output?: string } {
  const text = redactCredentials(stripAnsi([stderr, stdout].filter((s) => s.trim().length > 0).join('\n')))
  const pushing = action === 'push' || action === 'force-push'
  const done = (reason: RemoteErrorReason, message: string) => ({ reason, message })

  if (pushing && SUBMODULE_PUSH.test(text)) {
    const line = text.split('\n').filter((l) => /submodule/i.test(l)).pop() ?? ''
    return done('failed', `Push failed: ${line.replace(PREFIXED, '').trim().slice(0, DETAIL_LIMIT)}`)
  }
  if (/\[rejected\]/.test(text) && /non-fast-forward|fetch first/.test(text)) {
    return done('non-fast-forward', 'Push rejected: remote has newer commits (non-fast-forward). Please pull or sync first.')
  }
  if (/stale info/.test(text)) {
    return done('stale-lease', 'Force push rejected — remote changed since last fetch. Fetch first, then try again.')
  }
  if (pushing && isPushHookFailure(text)) {
    const hook = classifyPushFailure(text)
    return { reason: hook.reason, message: hook.summary, summary: hook.summary, output: hook.output }
  }
  if (AUTH.test(text)) return done('auth', AUTH_MESSAGE)
  if (NETWORK.test(text)) return done('network', NETWORK_MESSAGE)
  if (/no upstream|There is no tracking information/i.test(text)) {
    return done('no-upstream', 'Branch has no upstream. Publish the branch first.')
  }
  if (/Need to specify how to reconcile divergent branches/.test(text)) {
    return done('divergent-policy', 'Need to specify how to reconcile divergent branches.')
  }
  // untracked first: its wording also ends in "would be overwritten by merge"
  if (/untracked working tree files would be overwritten/.test(text)) {
    return done('untracked-overwrite', 'Pull would overwrite untracked files. Move, remove, or add them before pulling.')
  }
  if (/would be overwritten by merge|Your local changes to the following files would be overwritten/.test(text)) {
    return done('local-changes', 'Pull would overwrite local changes. Commit, stash, or discard them before pulling.')
  }
  if (/CONFLICT|Automatic merge failed|could not apply|Resolve all conflicts manually/.test(text)) {
    return done('conflicts', action === 'rebase' ? 'Rebase stopped with conflicts.' : 'Pull stopped with merge conflicts.')
  }

  const lines = text.split('\n').map((l) => l.trim())
  const detail = lastErrorBlock(lines)
  if (action === 'fast-forward') {
    return done('failed', detail ? `Fast-forward failed. ${detail.slice(0, DETAIL_LIMIT)}` : FAILED_FALLBACK[action])
  }
  return done('failed', detail || FAILED_FALLBACK[action])
}
