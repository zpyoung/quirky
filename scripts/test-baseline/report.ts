import type { Verdict } from './types'

/** Hidden marker on the first line of the PR comment, so the workflow can find and update its own comment. */
export const COMMENT_MARKER = '<!-- test-baseline-verdict -->'

const SECTION_LINE_LIMIT = 50
const SHORT_COMMIT_LENGTH = 7
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * Turns a test key (`<file>\0<classname>\0<name>`) into `file > classname > name` for people to read.
 * A key without separators, such as a bare file path, comes back unchanged.
 */
export function displayKey(key: string): string {
  if (!key.includes('\0')) return key
  return key
    .split('\0')
    .filter((part) => part !== '')
    .join(' > ')
}

function plural(count: number, one: string, many: string = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

function shortCommit(commit: string): string {
  return commit.slice(0, SHORT_COMMIT_LENGTH)
}

function age(createdAt: string, now: Date): string | null {
  const elapsed = now.getTime() - new Date(createdAt).getTime()
  if (Number.isNaN(elapsed)) return null
  if (elapsed < MINUTE_MS) return 'less than a minute'
  if (elapsed < HOUR_MS) return plural(Math.floor(elapsed / MINUTE_MS), 'minute')
  if (elapsed < DAY_MS) return plural(Math.floor(elapsed / HOUR_MS), 'hour')
  return plural(Math.floor(elapsed / DAY_MS), 'day')
}

function baselineText(verdict: Verdict, now: Date): string {
  if (!verdict.baseline) return 'No baseline was available, so every failure counts as new.'
  const old = age(verdict.baseline.createdAt, now)
  const base = `Compared with the baseline from commit \`${shortCommit(verdict.baseline.commit)}\``
  return old ? `${base}, ${old} old.` : `${base}.`
}

function counts(verdict: Verdict): string {
  const parts = [
    plural(verdict.new.length, 'new failure'),
    plural(verdict.known.length, 'known failure'),
    `${verdict.flaky.length} flaky`,
    `${verdict.fixed.length} fixed`,
    `${verdict.missing.length} missing`,
  ]
  if (verdict.incomplete.length > 0) parts.push(`${verdict.incomplete.length} incomplete`)
  return parts.join(', ')
}

function section(title: string, note: string, items: string[]): string[] {
  if (items.length === 0) return []
  const lines = ['', `### ${title} (${items.length})`, note, '']
  for (const item of items.slice(0, SECTION_LINE_LIMIT)) lines.push(`- \`${displayKey(item)}\``)
  if (items.length > SECTION_LINE_LIMIT) lines.push('', `...and ${items.length - SECTION_LINE_LIMIT} more`)
  return lines
}

/**
 * Markdown for the PR comment and job summary. Starts with `COMMENT_MARKER`, opens with the result and
 * counts, then has one section per non-empty label. Each section lists at most 50 tests and counts the
 * rest, because GitHub limits comment size.
 */
export function renderComment(verdict: Verdict, now: Date): string {
  const lines = [COMMENT_MARKER, '']
  lines.push(verdict.ok ? '## Tests passed' : '## Tests failed', '')
  lines.push(counts(verdict) + '.')
  if (verdict.runBroken) {
    lines.push('', "The run itself broke, so this result can't be trusted. Check the failed jobs and run the check again.")
  }
  if (verdict.selection.mode === 'none') lines.push('', 'No tests were needed for this change.')
  lines.push('', baselineText(verdict, now))
  if (verdict.advisory) lines.push('', 'This result is advisory. The PR check decides.')

  lines.push(
    ...section('New failures', 'These fail now and did not fail in the baseline. They block the PR.', verdict.new),
    ...section('Known failures', 'These were already failing in the baseline. They do not block.', verdict.known),
    ...section('Flaky', 'These failed, then passed when their file ran again alone. They do not block.', verdict.flaky),
    ...section('Fixed', 'These failed in the baseline and pass now.', verdict.fixed),
    ...section('Missing', 'These are in the baseline but absent from a selected or deleted file. Review them.', verdict.missing),
    ...section('Incomplete', 'These selected files produced no results. They block the PR.', verdict.incomplete),
    ...section('Not checked on CI', 'These selected files do not run on CI. Run them locally.', verdict.notOnCi),
  )
  return lines.join('\n') + '\n'
}

/**
 * The local command's output: one line per failing test with its label, then a summary line that
 * starts with `advisory:` whenever the verdict is advisory and names the baseline commit or says
 * there was none.
 */
export function renderLocal(verdict: Verdict, _now: Date): string {
  const lines: string[] = []
  for (const key of verdict.new) lines.push(`new: ${displayKey(key)}`)
  for (const key of verdict.known) lines.push(`known: ${displayKey(key)}`)
  for (const key of verdict.flaky) lines.push(`flaky: ${displayKey(key)}`)
  for (const file of verdict.incomplete) lines.push(`incomplete: ${displayKey(file)}`)
  if (verdict.runBroken) lines.push("broken: the run itself broke, so this result can't be trusted")
  if (verdict.selection.mode === 'none') lines.push('No tests were needed for this change.')

  const against = verdict.baseline ? `against baseline ${shortCommit(verdict.baseline.commit)}` : 'no baseline'
  const parts = [plural(verdict.new.length, 'new failure'), plural(verdict.known.length, 'known failure'), `${verdict.flaky.length} flaky`]
  if (verdict.incomplete.length > 0) parts.push(`${verdict.incomplete.length} incomplete`)
  parts.push(against)
  lines.push(`${verdict.advisory ? 'advisory' : 'result'}: ${parts.join(', ')}`)
  return lines.join('\n') + '\n'
}
