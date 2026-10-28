import type { GitDiff, GitStatus, GitStatusEntry } from '@quirky/protocol'

export const DIFF_CHAR_CAP = 12_000
export const STATUS_OMITTED_LINE = '... additional changes omitted.'
export const CLEAN_TREE_LINE = 'Clean working tree.'
export const NO_CHANGES_LINE = 'No repository changes were reported.'
const BINARY_DIFF_LINE = '[binary diff omitted]'

function entryLabel(entry: GitStatusEntry): string {
  const path = entry.oldPath ? `${entry.oldPath} -> ${entry.path}` : entry.path
  return `${entry.area}: ${entry.status} ${path}`
}

/** The status lines of a brief: one per entry, a clean-tree line, and a note when the list was capped. */
export function statusLines(status: GitStatus): string[] {
  const lines = status.entries.map(entryLabel)
  if (lines.length === 0) lines.push(CLEAN_TREE_LINE)
  if (status.capped) lines.push(STATUS_OMITTED_LINE)
  return lines
}

/** The distinct changed paths in entry order, renames by their new path. */
export function changedPaths(status: GitStatus): string[] {
  return [...new Set(status.entries.map((entry) => entry.path))]
}

function diffEntry(status: GitStatus, diff: GitDiff): GitStatusEntry | undefined {
  const sameFile = status.entries.filter((entry) => entry.path === diff.path)
  return sameFile.find((entry) => (entry.area === 'staged') === diff.staged) ?? sameFile[0]
}

function diffHeading(status: GitStatus, diff: GitDiff): string {
  const entry = diffEntry(status, diff)
  if (entry) return `### ${entryLabel(entry)}`
  return `### ${diff.staged ? 'staged' : 'unstaged'}: modified ${diff.path}`
}

function diffBody(diff: GitDiff): string {
  if (diff.binary || diff.kind !== 'text' || diff.tooLarge) return BINARY_DIFF_LINE
  return `--- before\n${diff.original}\n+++ after\n${diff.modified}`
}

/**
 * The body of the "Repository state" block: branch, status lines, changed paths and, when
 * `diffs` is given, the capped diff bodies. `truncated` is true when the status list hit its
 * cap or the diff bodies were cut.
 */
export function formatRepoState(status: GitStatus, diffs?: GitDiff[]): { text: string; truncated: boolean } {
  const paths = changedPaths(status)
  const branch = status.branch ?? (status.detached ? 'detached HEAD' : 'unknown')
  const parts = [
    `Branch: ${branch}`,
    'Git status:',
    ...statusLines(status),
    'Changed file paths:',
    ...(paths.length > 0 ? paths : [NO_CHANGES_LINE])
  ]
  let truncated = status.capped
  if (diffs && diffs.length > 0) {
    const bodies = diffs.map((diff) => `${diffHeading(status, diff)}\n${diffBody(diff)}`).join('\n')
    parts.push('Included diff bodies:')
    if (bodies.length > DIFF_CHAR_CAP) {
      parts.push(bodies.slice(0, DIFF_CHAR_CAP), `[Diff bodies truncated at ${DIFF_CHAR_CAP} characters.]`)
      truncated = true
    } else {
      parts.push(bodies)
    }
  }
  return { text: parts.join('\n'), truncated }
}
