import { ChangedOnDiskError, GitError, NotAllowedError, RemoteError, classifyCommitFailure, redactCredentials } from '@quirky/git'
import type { PluginContext, PluginErrorKind } from '@quirky/protocol'
import { OutsideWorktreeError } from './paths'

/** git's own explanation for a failure: its stderr when it has one, else the error message. */
export function gitMessage(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr
  if (typeof stderr === 'string' && stderr.trim()) return stderr.trim()
  return error instanceof Error ? error.message : String(error)
}

function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return redactCredentials(value)
  if (Array.isArray(value)) return value.map(redactDeep)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item)]))
  }
  return value
}

const isPluginError = (error: unknown): boolean => typeof (error as { code?: unknown } | null)?.code === 'number'

/** The error constructors the handlers share; every message and `data` field is credential-redacted. */
export type Errors = {
  /** A plugin error of `kind` whose `data` is `{reason, ...extra}`. */
  reasoned(kind: PluginErrorKind, reason: string, message: string, extra?: Record<string, unknown>): Error
  /**
   * What a failed commit, or a merge/rebase/cherry-pick commit, reports: `lint`, `hook` or
   * `failed` with the summary as the message and `data {reason, summary, output}`. Non-git errors pass through.
   */
  commitFailure(error: unknown): unknown
  /** Maps git, remote, eligibility and path errors to reasoned plugin errors; anything else is returned unchanged. */
  translate(error: unknown): unknown
}

export function createErrors(context: Pick<PluginContext, 'error'>): Errors {
  const reasoned: Errors['reasoned'] = (kind, reason, message, extra = {}) =>
    Object.assign(context.error(kind, redactCredentials(message)), {
      data: redactDeep({ reason, ...extra })
    })

  const commitFailure: Errors['commitFailure'] = (error) => {
    if (!(error instanceof GitError)) return error
    const { reason, summary, output } = classifyCommitFailure(error.stderr)
    return reasoned('conflict', reason, summary, { summary, output })
  }

  const translate: Errors['translate'] = (error) => {
    if (isPluginError(error)) return error
    if (error instanceof OutsideWorktreeError) return reasoned('invalid-params', 'outside-worktree', error.message)
    if (error instanceof NotAllowedError) return reasoned('invalid-params', 'not-allowed', error.message)
    if (error instanceof ChangedOnDiskError) return reasoned('conflict', 'changed-on-disk', error.message)
    if (error instanceof RemoteError) {
      const extra = { ...(error.summary !== undefined && { summary: error.summary }), ...(error.output !== undefined && { output: error.output }) }
      return reasoned(error.reason === 'invalid-base' ? 'invalid-params' : 'conflict', error.reason, error.message, extra)
    }
    if (error instanceof GitError) return reasoned('conflict', 'failed', gitMessage(error))
    return error
  }

  return { reasoned, commitFailure, translate }
}
