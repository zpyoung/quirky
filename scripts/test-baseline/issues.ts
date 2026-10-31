import type { Baseline, GhRunner, IssueAction, OpenIssue, Selection } from './types'

const FLAKE_THRESHOLD = 3
const FLAKE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const LABELS = ['test-failure', 'test-flake'] as const
type Label = (typeof LABELS)[number]

type PlanInput = {
  previous: Baseline | null
  current: Baseline
  openIssues: OpenIssue[]
  rangeSelection: Selection | null
  now: Date
}

function failuresOf(baseline: Baseline): Set<string> {
  const failed = new Set<string>()
  for (const [key, status] of Object.entries(baseline.tests)) if (status === 'failed') failed.add(key)
  for (const [file, info] of Object.entries(baseline.files)) if (info.fileError) failed.add(file)
  return failed
}

function fileOf(key: string): string {
  return key.split('\0')[0]
}

function describeTest(key: string): string {
  return key.split('\0').filter(Boolean).join(' > ')
}

function recentDates(baseline: Baseline, file: string, now: Date): string[] {
  const cutoff = now.getTime() - FLAKE_WINDOW_MS
  return (baseline.flakeHistory[file] ?? []).filter((date) => Date.parse(date) >= cutoff)
}

function marker(payload: { tests: string[] } | { file: string }): string {
  // escaped angle brackets keep a test name from ending the comment early
  const json = JSON.stringify(payload).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
  return `<!-- test-baseline:${json} -->`
}

function failureIssue(range: string, tests: string[], misses: string[]): IssueAction {
  const lines = [
    `These tests failed in the full run on main for the commit range ${range} and did not fail in the previous baseline.`,
    '',
    `Failures (${tests.length}):`,
    ...tests.map((key) => `- ${describeTest(key)}`),
  ]
  if (misses.length > 0) {
    lines.push(
      '',
      `Selection misses (${misses.length}): the pull request check for this range did not select the file of these failures, so the selection rules may need widening.`,
      ...misses.map((key) => `- ${describeTest(key)}`),
    )
  }
  lines.push('', marker({ tests }))
  return { kind: 'open', label: 'test-failure', title: `Test failures on main in ${range}`, body: lines.join('\n'), tests }
}

function flakeIssue(file: string, dates: string[]): IssueAction {
  const body = [
    `${file} was flagged flaky in ${dates.length} full runs on main within the last 7 days.`,
    '',
    'Dates:',
    ...dates.map((date) => `- ${date}`),
    '',
    'The file stays in the suite and keeps counting. This issue closes itself once 7 days of main runs show no flake from it.',
    '',
    marker({ file }),
  ].join('\n')
  return { kind: 'open', label: 'test-flake', title: `Flaky test file: ${file}`, body, file }
}

/**
 * Decides which GitHub issues a new main baseline should open or close. Pure: it reads the two
 * baselines and the issues already open, and returns actions for `applyIssueActions`.
 *
 * With no `previous` it returns nothing, so failures that already exist in the first baseline
 * open no issue. Otherwise it opens at most one failure issue for the failures that are new and
 * not already listed by an open failure issue, marks those whose file is outside `rangeSelection`
 * as selection misses (a null `rangeSelection` marks none), opens a flake issue for each file with
 * 3 or more flake dates in the 7 days before `now` and no open flake issue, and closes failure
 * issues whose tests all pass again and flake issues whose file has no recent flake dates.
 */
export function planIssues(input: PlanInput): IssueAction[] {
  const { previous, current, openIssues, rangeSelection, now } = input
  if (!previous) return []

  const actions: IssueAction[] = []
  const failing = failuresOf(current)
  const wasFailing = failuresOf(previous)
  const covered = new Set<string>()
  for (const issue of openIssues) if (issue.label === 'test-failure') for (const test of issue.tests) covered.add(test)

  for (const issue of openIssues) {
    if (issue.label === 'test-failure' && issue.tests.every((test) => !failing.has(test))) {
      actions.push({ kind: 'close', number: issue.number, comment: 'None of the tests listed here fail in the latest baseline on main, so this issue is closed.' })
    }
    if (issue.label === 'test-flake' && issue.file !== undefined && recentDates(current, issue.file, now).length === 0) {
      actions.push({ kind: 'close', number: issue.number, comment: `${issue.file} has had no flake on main in the last 7 days, so this issue is closed.` })
    }
  }

  const fresh = [...failing].filter((key) => !wasFailing.has(key) && !covered.has(key)).sort()
  if (fresh.length > 0) {
    const selected = rangeSelection ? new Set(rangeSelection.files) : null
    const misses = selected ? fresh.filter((key) => !selected.has(fileOf(key))) : []
    actions.push(failureIssue(`${previous.commit}..${current.commit}`, fresh, misses))
  }

  const flakeIssueFiles = new Set(openIssues.filter((issue) => issue.label === 'test-flake').map((issue) => issue.file))
  for (const file of Object.keys(current.flakeHistory).sort()) {
    const dates = recentDates(current, file, now)
    if (dates.length >= FLAKE_THRESHOLD && !flakeIssueFiles.has(file)) actions.push(flakeIssue(file, dates))
  }

  return actions
}

function parseMarker(body: unknown): { tests?: unknown; file?: unknown } | null {
  if (typeof body !== 'string') return null
  const match = body.match(/<!-- test-baseline:(.*) -->\s*$/s)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[1])
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Lists the open issues labelled `test-failure` or `test-flake` in `repo` and reads the hidden
 * `<!-- test-baseline:{json} -->` comment from each body. An issue whose comment is missing or
 * doesn't fit its label is left out, so a hand-edited issue is never closed by the tool.
 * Rejects when `gh` fails.
 */
export async function readOpenIssues(gh: GhRunner, repo: string): Promise<OpenIssue[]> {
  const issues: OpenIssue[] = []
  for (const label of LABELS) {
    const out = await gh(['issue', 'list', '--repo', repo, '--state', 'open', '--label', label, '--json', 'number,body', '--limit', '1000'])
    const rows: { number: number; body: unknown }[] = JSON.parse(out || '[]')
    for (const row of rows) {
      const data = parseMarker(row.body)
      if (!data) continue
      if (label === 'test-failure' && Array.isArray(data.tests) && data.tests.every((test) => typeof test === 'string')) {
        issues.push({ number: row.number, label, tests: data.tests })
      }
      if (label === 'test-flake' && typeof data.file === 'string') {
        issues.push({ number: row.number, label, tests: [], file: data.file })
      }
    }
  }
  return issues
}

/**
 * Carries out the actions `planIssues` returned through `gh`. An open action creates its label
 * first when the repo lacks it, and a close action posts its comment before closing, so an issue
 * never closes without saying why. One failed action doesn't stop the rest; after all have run
 * it rejects with an error listing each action that failed.
 */
export async function applyIssueActions(actions: IssueAction[], gh: GhRunner, repo: string): Promise<void> {
  let existing: Promise<Set<string>> | null = null
  const ensured = new Map<Label, Promise<void>>()

  const ensureLabel = (label: Label): Promise<void> => {
    let done = ensured.get(label)
    if (!done) {
      done = (async () => {
        existing ??= gh(['label', 'list', '--repo', repo, '--json', 'name', '--limit', '1000']).then(
          (out) => new Set((JSON.parse(out || '[]') as { name: string }[]).map((row) => row.name)),
        )
        if (!(await existing).has(label)) await gh(['label', 'create', label, '--repo', repo])
      })()
      ensured.set(label, done)
    }
    return done
  }

  const failures: string[] = []
  for (const action of actions) {
    try {
      if (action.kind === 'open') {
        await ensureLabel(action.label)
        await gh(['issue', 'create', '--repo', repo, '--title', action.title, '--body', action.body, '--label', action.label])
      } else {
        await gh(['issue', 'comment', String(action.number), '--repo', repo, '--body', action.comment])
        await gh(['issue', 'close', String(action.number), '--repo', repo])
      }
    } catch (error) {
      const what = action.kind === 'open' ? `open "${action.title}"` : `close #${action.number}`
      failures.push(`${what}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (failures.length > 0) throw new Error(`${failures.length} issue action(s) failed:\n${failures.join('\n')}`)
}
