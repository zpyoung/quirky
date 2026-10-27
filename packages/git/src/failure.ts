/**
 * Turns the raw output of a failed commit or push into a reason and a one-line summary the UI can
 * show on a "blocked" card, with the full text kept for a details view.
 */

const MAX_OUTPUT_BYTES = 64 * 1024

const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g

const LINT = /\b(eslint|oxlint|lint-staged|lint)\b/i
const COMMIT_HOOK = /\b(pre-commit|precommit|husky|lint-staged)\b/i
const LOW_SIGNAL = [/^npm (warn|notice)\b/i, /^husky\b.*\bdeprecated\b/i]

const PUSH_REMOTE_ERRORS = [
  /Authentication failed|Permission denied|could not read Username|Host key verification failed|terminal prompts disabled/i,
  /non-fast-forward|fetch first/i,
  /protected branch|GH006/i,
  /Could not resolve host|Connection refused|Connection timed out|unable to access|Network is unreachable|Could not read from remote repository/i,
  /submodule/i
]
const PUSH_FAILED = /failed to push|error: failed to push some refs/i
const PUSH_TOOLING = /\b(husky|lint-staged|lefthook)\b/i

/** `text` without ANSI escape sequences or control characters other than `\n` and `\t`. */
export function stripAnsi(text: string): string {
  return text.replace(OSC, '').replace(CSI, '').replace(CONTROL, '')
}

/** `text` cut to at most 64 KiB of UTF-8, never ending in a split character. */
export function capOutput(text: string): string {
  if (Buffer.byteLength(text) <= MAX_OUTPUT_BYTES) return text
  return Buffer.from(text).subarray(0, MAX_OUTPUT_BYTES).toString('utf8').replace(/�+$/, '')
}

function cleaned(output: string): string {
  return capOutput(stripAnsi(output))
}

/**
 * Classifies a failed `git commit` from its combined output: `lint` for linters, `hook` for
 * pre-commit tooling, else `failed` with the first meaningful line as the summary. Only the first
 * 64 KiB is scanned and returned, ANSI stripped.
 */
export function classifyCommitFailure(output: string): { reason: 'lint' | 'hook' | 'failed'; summary: string; output: string } {
  const text = cleaned(output)
  if (LINT.test(text)) return { reason: 'lint', summary: 'Lint failed during commit.', output: text }
  if (COMMIT_HOOK.test(text)) return { reason: 'hook', summary: 'Pre-commit hook failed.', output: text }
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  const line = lines.find((l) => !LOW_SIGNAL.some((p) => p.test(l))) ?? lines[0]
  return { reason: 'failed', summary: line ?? 'Commit failed.', output: text }
}

/**
 * Whether a failed `git push` was blocked by a hook rather than by the remote: false for auth,
 * non-fast-forward, protected-branch, network and submodule errors; true for a declined hook, a
 * pre-push hook, or husky/lint-staged/lefthook output next to git's "failed to push".
 */
export function isPushHookFailure(output: string): boolean {
  const text = stripAnsi(output)
  if (PUSH_REMOTE_ERRORS.some((p) => p.test(text))) return false
  if (/hook declined/i.test(text) || /pre-push/i.test(text)) return true
  return PUSH_TOOLING.test(text) && PUSH_FAILED.test(text)
}

/** The reason and summary for a push that `isPushHookFailure` recognised; the output is ANSI-stripped and capped. */
export function classifyPushFailure(output: string): { reason: 'lint' | 'hook'; summary: string; output: string } {
  const text = cleaned(output)
  if (LINT.test(text)) return { reason: 'lint', summary: 'Lint failed during push.', output: text }
  return { reason: 'hook', summary: 'Pre-push hook failed.', output: text }
}
