/** The records the test-baseline tools pass between jobs and store. See the tech spec's Data models. */

export type Platform = 'linux' | 'macos'
export type TestStatus = 'passed' | 'failed' | 'skipped'

/** One test's result. `key` is `<file>\0<classname>\0<name>`, with `#2`, `#3` on repeats within a file. */
export type TestResult = { key: string; status: TestStatus }

/** Why a file produced no trustworthy per-test results; null when it did. */
export type FileError = 'timeout' | 'no-report' | 'exit-mismatch' | null

export type Attempt = { exitCode: number; fileError: FileError; tests: TestResult[] }

/** One test file's run. `rerun` is set only when the file ran a second time alone. */
export type FileResult = { file: string; platform: Platform; durationMs: number; first: Attempt; rerun?: Attempt }

export type Selection = { mode: 'none' | 'some' | 'all'; files: string[]; reasons: string[] }

export type ChangedPath = { path: string; status: 'A' | 'M' | 'D' }

/** The stored record of one complete run on a main commit. A flaky test is stored as passed. */
export type Baseline = {
  version: 1
  commit: string
  createdAt: string
  runId: string
  files: Record<string, { platform: Platform; durationMs: number; fileError: FileError; flaky: boolean }>
  tests: Record<string, TestStatus>
  flakeHistory: Record<string, string[]>
}

/** A run compared with a baseline. `ok` is what decides a PR check. */
export type Verdict = {
  ok: boolean
  advisory: boolean
  baseline: { commit: string; createdAt: string } | null
  selection: Selection
  new: string[]
  known: string[]
  flaky: string[]
  fixed: string[]
  missing: string[]
  incomplete: string[]
  notOnCi: string[]
  runBroken: boolean
}

/** What the `plan` job hands to every later job, as `plan.json` in the plan artifact. */
export type Plan = {
  event: string
  head: string
  baseline: { commit: string; createdAt: string } | null
  selection: Selection
  rangeSelection: Selection | null
  deleted: string[]
  notOnCi: string[]
  linuxShards: string[][]
  macos: string[]
}

/** Static imports between tracked code files, as repo-relative paths. */
export type ImportGraph = {
  /** Every file whose transitive imports reach `path`, including `path` itself. */
  importersOf(path: string): Set<string>
  /** Files that failed to scan plus imports that failed to resolve, so a run can report them. */
  misses: number
}

/** Runs `gh` with the given arguments. Rejects when `gh` itself fails. */
export type GhRunner = (args: string[]) => Promise<string>

export type OpenIssue = {
  number: number
  label: 'test-failure' | 'test-flake'
  tests: string[]
  file?: string
}

export type IssueAction =
  | { kind: 'open'; label: 'test-failure'; title: string; body: string; tests: string[] }
  | { kind: 'open'; label: 'test-flake'; title: string; body: string; file: string }
  | { kind: 'close'; number: number; comment: string }
