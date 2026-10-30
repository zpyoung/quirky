import type { Baseline, FileError, FileResult, Selection, TestStatus, Verdict } from './types'

export type CompareInput = {
  baseline: Baseline | null
  results: FileResult[]
  selection: Selection
  deleted: string[]
  notOnCi: string[]
  advisory: boolean
  runBroken: boolean
}

type Judged = TestStatus | 'flaky'

function statuses(tests: { key: string; status: TestStatus }[]): Map<string, TestStatus> {
  const out = new Map<string, TestStatus>()
  for (const t of tests) if (out.get(t.key) !== 'failed') out.set(t.key, t.status)
  return out
}

function judge(first: TestStatus | undefined, rerun: TestStatus | undefined, reran: boolean): Judged | undefined {
  if (!reran) return first
  if (rerun === 'failed') return 'failed'
  if (first === 'failed') return rerun === undefined ? 'failed' : 'flaky'
  return first ?? rerun
}

function fileOf(key: string): string {
  const at = key.indexOf('\0')
  return at === -1 ? key : key.slice(0, at)
}

const sorted = (set: Set<string>): string[] => [...set].sort()

/**
 * Labels one run's results against a baseline. The verdict is `ok` only when nothing is new or
 * incomplete and the run itself held together.
 *
 * Contract:
 * - Pure: reads no files, runs no git, makes no network calls, and never mutates its input.
 * - A file with a rerun is judged from both attempts. A test that failed first and passed in the
 *   rerun is flaky, and a test that failed in the rerun, or failed first and is absent from it, is failed.
 * - Failed tests are known when the baseline has them failed and new otherwise. With no baseline,
 *   every failure is new, and fixed and missing stay empty.
 * - A file-level result is keyed by the bare file path in new, known and flaky. A file error still
 *   present after any rerun is new, or known when the baseline's same file had an error. One a
 *   rerun cleared is flaky.
 * - Missing covers baseline tests absent from an error-free result file, plus every baseline test
 *   in a deleted file. Incomplete is selected files, less notOnCi, that have no result.
 * - A test appears under one label at most, and every output array is sorted.
 */
export function compareResults(input: CompareInput): Verdict {
  const { baseline, results, selection, deleted, notOnCi, advisory, runBroken } = input
  const baselineTests = baseline?.tests ?? {}
  const baselineFiles = baseline?.files ?? {}

  const labelled = new Set<string>()
  const newKeys = new Set<string>()
  const known = new Set<string>()
  const flaky = new Set<string>()
  const fixed = new Set<string>()
  const missing = new Set<string>()
  const seen = new Set<string>()

  const baselineByFile = new Map<string, string[]>()
  for (const key of Object.keys(baselineTests)) {
    const file = fileOf(key)
    const list = baselineByFile.get(file)
    if (list) list.push(key)
    else baselineByFile.set(file, [key])
  }

  const label = (key: string, into: Set<string>): void => {
    if (labelled.has(key)) return
    labelled.add(key)
    into.add(key)
  }

  for (const result of results) {
    seen.add(result.file)
    const reran = result.rerun !== undefined
    const first = statuses(result.first.tests)
    const rerun = statuses(result.rerun?.tests ?? [])
    const present = new Set([...first.keys(), ...rerun.keys()])

    for (const key of present) {
      const status = judge(first.get(key), rerun.get(key), reran)
      const baselineFailed = baselineTests[key] === 'failed'
      if (status === 'flaky') label(key, flaky)
      else if (status === 'failed') label(key, baselineFailed ? known : newKeys)
      else if (status === 'passed' && baselineFailed) label(key, fixed)
    }

    const fileError: FileError = reran ? (result.rerun?.fileError ?? null) : result.first.fileError
    if (fileError) {
      label(result.file, baselineFiles[result.file]?.fileError ? known : newKeys)
    } else {
      if (reran && result.first.fileError) label(result.file, flaky)
      for (const key of baselineByFile.get(result.file) ?? []) if (!present.has(key)) missing.add(key)
    }
  }

  for (const file of deleted) for (const key of baselineByFile.get(file) ?? []) missing.add(key)

  const skip = new Set(notOnCi)
  const incomplete = new Set(selection.files.filter((f) => !skip.has(f) && !seen.has(f)))

  return {
    ok: newKeys.size === 0 && incomplete.size === 0 && !runBroken,
    advisory,
    baseline: baseline ? { commit: baseline.commit, createdAt: baseline.createdAt } : null,
    selection,
    new: sorted(newKeys),
    known: sorted(known),
    flaky: sorted(flaky),
    fixed: sorted(fixed),
    missing: sorted(missing),
    incomplete: sorted(incomplete),
    notOnCi: [...notOnCi].sort(),
    runBroken,
  }
}
