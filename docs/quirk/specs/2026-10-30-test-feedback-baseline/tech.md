# Tech spec: fast test feedback against a stored baseline

**Status:** Reviewed, ready for planning.
**Logic spec:** [logic.md](logic.md). It owns why and behavior. This document owns where and contracts.

## Architecture

Backs [How results flow](logic.md#how-results-flow) and [Key decisions](logic.md#key-decisions).

A new `scripts/test-baseline/` directory holds small modules behind one CLI. A new workflow, `.github/workflows/tests.yml`, and a new root script, `test:affected`, call that CLI. `scripts/suite.ts` gains one new export and otherwise stays as it is.

| Module | Job | Purity |
|---|---|---|
| `types.ts` | The schemas below | Types only |
| `junit.ts` | Turns one JUnit report into per-test results | Pure |
| `graph.ts` | Static import graph of tracked code files | Reads files |
| `select.ts` | Turns changed paths into a selection | Pure, given the graph and file lists |
| `shards.ts` | Splits files across jobs by duration | Pure |
| `runner.ts` | Runs files, one process each, and records results | Spawns tests |
| `compare.ts` | Labels results against a baseline | Pure |
| `baseline.ts` | Builds a baseline, and finds and fetches one | Calls `git` and `gh` |
| `report.ts` | Renders the PR comment, job summary and local output | Pure |
| `issues.ts` | Decides issue actions, then applies them | Decision is pure, apply calls `gh` |
| `cli.ts` | Subcommands that compose the above | Entry point |

Each module except `types.ts` gets a sibling `<module>.test.ts`, and `workflow.test.ts` checks the workflow file.

The GitHub flow is five jobs. `plan` selects and splits. `linux` (a matrix) and `macos` run files and upload results. `rerun` retries Linux failures alone. `tests`, displayed as `Tests`, compares, reports and publishes. Test code only ever runs in jobs holding a read-only token.

## Code references

Backs [How results flow](logic.md#how-results-flow). Paths are relative to the repo root.

- `scripts/suite.ts`
  - `bunTest` near line 123 is private and runs one `bun test` inside `withTestHome`. It sets a scratch `HOME` and `QUIRKY_HOME`.
  - `discover(cwd, args)` lists test files. `macosOnly(list)` parses a reason-annotated file list. `TEST_FILE` is the test-file regex. Export `TEST_FILE`; the other two are already exported.
  - `exec` and `withTestHome` hold the process-scope cleanup that must run on a timeout.
- `scripts/test-on-macos.txt` lists 18 macOS-only files. Read it, don't change its format.
- `scripts/test-support/process-scope.ts` needs `ps`, and on Linux `/proc/<pid>/environ`. Both exist on GitHub runners.
- `.github/workflows/build.yml` is the style to follow: `BUN_VERSION: 1.4.0`, `oven-sh/setup-bun@v2`, `actions/checkout@v4`, and a `concurrency` group on `github.ref`.
- `package.json` scripts get `test:affected`. The `test` script stays.
- `docs/qa-loop/FIX.md` step 5 and `docs/loop/LOOP.md` near line 179 get the doc changes. `README.md` near line 243 gets one line.

### Facts measured on Bun 1.4.0

- JUnit `<testcase>` carries `name`, `classname` and `file`. `file` is relative to the working directory. `classname` lists describes innermost first (`inner > outer`). Children are `<failure>` or `<skipped />`. `<testsuite>` elements nest.
- A file that fails to load exits 1 and writes no report at all.
- An error thrown between tests can exit 0 with a clean report, so exit 0 doesn't prove every test ran.
- `Bun.Transpiler.scanImports` plus `Bun.resolveSync` handled all 2,315 tracked code files in 767 ms with 0 unresolved local or `@quirky/*` imports, and it drops `import type`. A prototype selected 639 tests for `packages/protocol/src/catalog.ts`, 14 for `plugins/quirky.git/src/ai/agents.ts`, and 0 for `packages/daemon/src/main.ts`.

## Contracts and interfaces

Backs [Conceptual model](logic.md#conceptual-model) and [Behavior and scenarios](logic.md#behavior-and-scenarios).

### Selection

```
CONTRACT:
selectTests(input: {
  changed: { path: string; status: 'A' | 'M' | 'D' }[]
  testFiles: string[]
  graph: ImportGraph
  spawners: Set<string>
}): Selection
```

Preconditions: paths are repo-relative, and `testFiles` holds only files that exist at the selection's head.

Rules, applied per changed path and unioned. A rule earlier in this list wins for that path:

1. Docs: anything under `docs/` or `prototypes/`, any `*.md` not under a `test/` directory, and `LICENSE`. Selects nothing. A survey found no test reading these at runtime.
2. Run everything: any `package.json`, `bun.lock`, `tsconfig*.json`, `bunfig.toml`, anything under `.github/`, `scripts/suite.ts`, `scripts/test-support/`, `scripts/test-baseline/`, `scripts/test-on-macos.txt`, `scripts/test-not-on-ci.txt`, and any path that no other rule recognises. This includes `distros/`, because `packages/ui/test/exit.e2e.test.ts` reads it.
3. An area is `packages/<name>`, `apps/<name>`, `plugins/<name>`, or `scripts`. A changed path in an area selects every test file in that area, plus every test whose transitive imports reach the path. A deleted path selects its whole area, because the graph is built at the head and no longer holds it.
4. A `plugins/<name>` change also selects everything under `plugins/test/`, because `plugins/test/imports.test.ts` scans every plugin.
5. A change in `packages/daemon`, `packages/cli`, `packages/pty-host` or `packages/protocol`, or to any `quirky-plugin.json`, also selects every file in `spawners`. Every manifest is parsed at daemon discovery.

Postconditions: `mode` is `none` when no path selected anything, `all` when any path hit rule 2, and `some` otherwise. `files` is sorted and deduplicated, and `reasons` names the rule that fired per changed path, at most 20 entries.

Invariant: an empty `changed` list gives `mode: 'none'`. Selection never throws on an unknown path. It runs everything instead.

```
REGEX: spawn marker, tested against a file's text
daemon/src/main|DAEMON_MAIN|DAEMON_ENTRY|cli/src/main|CLI_MAIN|CLI_ENTRY|pty-host/src/main|PTY_HOST_ENTRY|\bstartDaemon\(|\bspawnCli\(
```

`findSpawners(graph, testFiles, readFile)` returns each test file whose transitive imports include a file matching the marker or a listed helper. `SPAWN_HELPERS` names `packages/cli/test/fixtures/fake-daemon.ts`, which builds its entry path with `join`. Matches in `apps/desktop/test/paths.test.ts`, a fake-filesystem test, are harmless over-selection.

Known miss class, accepted by SC-5: a plugin change that breaks another plugin's e2e test through the daemon's dynamic plugin import.

### Import graph

```
CONTRACT:
buildImportGraph(root: string, files: string[]): ImportGraph
ImportGraph.importersOf(path: string): Set<string>  // transitive, includes path itself
```

Covers files matching `\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$`. Uses the `tsx` loader for `.tsx` and `.jsx`, and `ts` otherwise. Skips `bun:` and `node:` specifiers, and drops anything resolving outside the root or under `node_modules`. A file that fails to scan, or an import that fails to resolve, is skipped rather than fatal, and the count is exposed on the graph so `plan` can print it. Requires `bun install` to have run, because `@quirky/*` resolves through workspace links.

### Splitting

```
CONTRACT:
splitShards(files: string[], durations: Record<string, number>, opts: { targetMs: number; maxShards: number }): string[][]
```

Assign longest first to the least-loaded shard. A file with no recorded duration counts as the median of known durations, or 5,000 ms when none are known. Shard count is `min(maxShards, ceil(total / targetMs))`, at least 1 when `files` isn't empty. Returns `[]` for no files. Output is deterministic for equal inputs, with ties broken by path.

```
CONFIG:
SHARD_TARGET_MS = 180000
MAX_SHARDS_PR = 6
MAX_SHARDS_MAIN = 12
FILES_AT_ONCE_CI = 3
FILES_AT_ONCE_LOCAL = 2
FILE_LIMIT_MS = 600000
RERUN_LIMIT = 5
```

These are starting values. The trial tunes them, because PR and main runs share 20 concurrent GitHub jobs.

### Running

`suite.ts` gains one export:

```
CONTRACT:
bunTestFile(cwd: string, args: string[], limitMs: number): Promise<{ code: number; output: string; timedOut: boolean }>
```

Runs like `bunTest` with `echo` off. At `limitMs` it reaps the process tree through the same scope cleanup and returns `timedOut: true`. It never leaves a process behind.

```
CONTRACT:
runTestFiles(opts: { cwd: string; files: string[]; platform: Platform; jobs: number; limitMs: number; run?: typeof bunTestFile }): Promise<FileResult[]>
rerunFailed(opts: same, results: FileResult[], limit: number): Promise<{ results: FileResult[]; skipped: boolean }>
```

`runTestFiles` postcondition: exactly one `FileResult` per input file, in input order. It never rejects because of a test failure. `fileError` follows from the attempt:

| Attempt | `fileError` |
|---|---|
| Timed out | `timeout` |
| Non-zero exit, no report | `no-report` |
| Non-zero exit, report has no failed test | `exit-mismatch` |
| Exit 0, or a failed test in the report | `null` |

An error thrown between tests can exit 0 with a report that lacks the tests it stopped. Those tests show as `missing`, which doesn't block. This is an accepted gap, and a full run or a review of the PR comment surfaces it.

`rerunFailed` reruns each file with a failed test or a `fileError`, one at a time, unless there are more than `limit`, in which case `skipped` is true and results are unchanged. As in today's runner, where the host and macOS groups count separately, the limit applies per platform group.

### Comparing

```
CONTRACT:
compareResults(input: { baseline: Baseline | null; results: FileResult[]; selection: Selection; deleted: string[]; notOnCi: string[]; advisory: boolean; runBroken: boolean }): Verdict
```

For each test in a file, the first matching row wins:

| Current result | Label |
|---|---|
| First attempt failed, rerun passed | `flaky` |
| Failed, and baseline has it failed | `known` |
| Failed otherwise, including not in baseline or no baseline | `new` |
| Passed, and baseline has it failed | `fixed` |

For each file-level result: a `fileError` still present after any rerun is `new`, unless the baseline's same file has a `fileError`, which makes it `known`. A `fileError` that a rerun cleared is `flaky`. A file with a `fileError` reports no `missing` tests, per SC-8.

`missing` is every baseline test in a selected, error-free file that's absent from its results, plus every baseline test in a `deleted` file. A `skipped` result is present, so it isn't missing.

`incomplete` lists every file in `selection.files` minus `notOnCi` that has no `FileResult`. It's how a job that lost a file shows up, and it fails the verdict.

`runBroken` is true when a job in the run failed or was cancelled, or when plan or results files can't be read. See [How a broken run is detected](#how-a-broken-run-is-detected).

Postconditions: `ok` is true only when `new` and `incomplete` are empty and `runBroken` is false. Duplicated test names in one file get a `#2`, `#3` suffix on their key, in report order. A test appears under one label at most. `notOnCi` is copied through for reporting and doesn't affect `ok`.

### Finding a baseline

```
CONTRACT:
findBaseline(opts: { cwd: string; head: string; repo: string; gh?: GhRunner }): Promise<{ commit: string; artifactId: number } | null>
fetchBaseline(found, opts): Promise<Baseline>
```

Lists artifacts named `test-baseline-<40 hex>` that aren't expired and were published by a run on this repository's `main` at the commit in the name, so a fork's or another branch's run can't pose as a baseline. Then walks `git rev-list --first-parent -n 500 <merge-base of head and origin/main>` newest first, and returns the first match. On `push`, the walk starts at the head's first parent, so a run never finds itself. Returns null when no ancestor has one, and throws a typed `BaselineUnavailable` when `gh` itself fails, because SC-11 and SC-12 treat those differently. `fetchBaseline` downloads through `gh api repos/<repo>/actions/artifacts/<id>/zip`, validates `version: 1`, and caches under `<git common dir>/test-baseline/<commit>.json` for local runs.

### Issues

```
CONTRACT:
planIssues(input: { previous: Baseline | null; current: Baseline; openIssues: OpenIssue[]; rangeSelection: Selection | null; now: Date }): IssueAction[]
```

With no `previous`, it files nothing, so an existing failure in the first baseline opens no issue. Failures in `current` but not `previous`, minus those already covered by an open failure issue, become one `open` action naming the range `previous.commit..current.commit`. Any failure whose file isn't in `rangeSelection`, which is the selection recomputed for that range, is marked as a selection miss. A failure issue whose listed tests are all no longer failing becomes a `close`. A file with at least 3 entries in `flakeHistory` and no open flake issue becomes an `open`. A flake issue whose file has an empty history becomes a `close`.

Open issues carry labels `test-failure` or `test-flake`, and keep their machine-readable list in a hidden `<!-- test-baseline:{json} -->` body comment.

### CLI

```
COMMAND: subcommands of bun scripts/test-baseline/cli.ts
plan       --event <pull_request|push|workflow_dispatch> --out <dir>
run-shard  --plan <dir> (--shard <index> | --macos) --out <file>
rerun      --plan <dir> --in <dir> --out <file>
verdict    --plan <dir> --in <dir> --out <dir> --jobs-ok <true|false>
issues     --plan <dir> --baseline <file>
affected   [--json] [--jobs <n>] [--list]
```

`plan` selects as follows. On `push` and `workflow_dispatch`, `selection` is `mode: 'all'` over `discover(cwd, [])`, which includes `scripts/`. On `pull_request`, it calls `findBaseline`, and a null result gives `mode: 'all'` with no baseline, per SC-11. Otherwise `changed` comes from `git diff --name-status --no-renames <baseline commit> HEAD`. `BaselineUnavailable` fails the `plan` job, so a `gh` outage shows as a broken run rather than an excused one.

`run-shard` and `rerun` exit 0 whenever they wrote results, because test failures aren't job failures. A failed job therefore always means the run itself broke. `verdict` exits 1 when the verdict isn't `ok` on a PR, and on `push` or `workflow_dispatch` only when the run is broken or incomplete. `verdict` writes `baseline.json` to its `--out` directory only on `push`, and only when the run is neither broken nor incomplete.

`verdict` and `issues` must run without `bun install`, so `cli.ts` imports `runner`, `graph` and `suite.ts` lazily inside the subcommands that need them. `affected` exits 1 on any `new` or `incomplete`, and prints `advisory:` as its summary line, per SC-12. `package.json` maps `test:affected` to `bun scripts/test-baseline/cli.ts affected`.

`affected` selects from the working tree against the baseline commit, including untracked files. `affected --list` prints the selection and runs nothing. On `BaselineUnavailable` it says so, selects from the merge base with `origin/main`, and passes `baseline: null`, so every failure is `new`.

## Data models

Backs [Conceptual model](logic.md#conceptual-model) and [How results flow](logic.md#how-results-flow).

```
SCHEMA:
Platform = 'linux' | 'macos'
TestStatus = 'passed' | 'failed' | 'skipped'
TestResult = { key: string; status: TestStatus }   // key = "<file>\0<classname>\0<name>[#n]"
FileError = 'timeout' | 'no-report' | 'exit-mismatch' | null
Attempt = { exitCode: number; fileError: FileError; tests: TestResult[] }
FileResult = { file: string; platform: Platform; durationMs: number; first: Attempt; rerun?: Attempt }

Selection = { mode: 'none' | 'some' | 'all'; files: string[]; reasons: string[] }

Baseline = {
  version: 1
  commit: string
  createdAt: string                // ISO 8601
  runId: string
  files: Record<string, { platform: Platform; durationMs: number; fileError: FileError; flaky: boolean }>
  tests: Record<string, TestStatus> // a flaky test is stored as passed
  flakeHistory: Record<string, string[]> // file -> ISO dates within the last 7 days
}

Verdict = {
  ok: boolean
  advisory: boolean
  baseline: { commit: string; createdAt: string } | null
  selection: Selection
  new: string[]; known: string[]; flaky: string[]; fixed: string[]; missing: string[]
  incomplete: string[]; notOnCi: string[]; runBroken: boolean
}

Plan = {                            // plan.json in the plan artifact
  event: string
  head: string
  baseline: { commit: string; createdAt: string } | null   // baseline.json sits beside it when set
  selection: Selection
  rangeSelection: Selection | null  // push only: the selection for previous baseline..head
  deleted: string[]                 // test files with status D in the diff
  notOnCi: string[]                 // selected files listed in scripts/test-not-on-ci.txt
  linuxShards: string[][]
  macos: string[]
}
```

`flakeHistory` carries forward from the previous baseline, so flake counts need no other storage. Only main runs write to it, per [Decisions Locked](logic.md#decisions-locked).

## Workflow

Backs [How results flow](logic.md#how-results-flow) and [Rollout](logic.md#rollout).

```
CONFIG: .github/workflows/tests.yml
on: pull_request; push (branches: main); workflow_dispatch
concurrency:
  group: tests-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
permissions: contents: read (workflow default)
```

| Job | Runs on | Token adds | Notes |
|---|---|---|---|
| `plan` | `ubuntu-latest` | `actions: read` | Full history and `bun install`, because selection needs both. Outputs `linux_shards` as a JSON array of shard indices such as `[0,1,2]`, and `has_macos` |
| `linux` | `ubuntu-latest`, matrix over `linux_shards` | none | `needs: plan`. `if` shards aren't empty. Installs `zsh` with apt. `timeout-minutes: 30` |
| `macos` | `macos-15` | none | `needs: plan`. `if` `has_macos`. Same as `linux`, and reruns its own failures with `RERUN_LIMIT` |
| `rerun` | `ubuntu-latest` | none | `needs: [plan, linux]`. `if` shards aren't empty and no job was cancelled. Decides from results with no install, and installs only when something needs rerunning |
| `tests` | `ubuntu-latest` | `pull-requests: write`, `issues: write` | `needs: [plan, linux, macos, rerun]`. `name: Tests`, `if: always()`. No `bun install`, and never executes test code |

Data moves between jobs only through these artifacts, each with 1-day retention, except the baseline:

| Artifact | Written by | Holds |
|---|---|---|
| `test-plan` | `plan` | `plan.json`, and `baseline.json` when one was found |
| `test-results-linux-<index>` | `linux` | `linux-<index>.json`, a `FileResult[]` |
| `test-results-macos` | `macos` | `macos.json`, a `FileResult[]` with `rerun` filled in |
| `test-results-rerun` | `rerun` | `rerun.json`, a `FileResult[]` holding only rerun files, with `rerun` filled in |
| `test-baseline-<sha>` | `tests` on `push` | `baseline.json`, kept 14 days |

`verdict` reads every `*.json` in `--in`, then overlays `rerun.json` by `file`, taking its `rerun` attempt. It reads the baseline only from the plan artifact and never searches again, so `plan` and `verdict` always compare against the same one. A `rerun.json` that's absent means nothing was rerun.

### How a broken run is detected

Two checks feed one result, and either one fails the verdict and blocks a baseline, per SC-15.

- The workflow passes `--jobs-ok ${{ !contains(needs.*.result, 'failure') && !contains(needs.*.result, 'cancelled') }}` to `verdict`. A `false` sets `runBroken`. A `skipped` job isn't a failure, because an empty selection skips the test jobs.
- `verdict` compares `selection.files` minus `notOnCi` with the results it found, which fills `incomplete`. It catches a matrix job that reported success without results. An unreadable plan or results file also sets `runBroken`.

- On `push`, when `out/baseline.json` exists, `tests` runs `issues --plan plan --baseline out/baseline.json`, then publishes the `test-baseline-${{ github.sha }}` artifact with `retention-days: 14`. A failed `issues` step blocks the upload, so the next run still sees the failure as new and retries. `previous` for `planIssues` is the plan artifact's `baseline.json`, and `rangeSelection` comes from `plan.json`, which means the `tests` job needs no history or install. The file holds `Baseline` JSON, and the artifact upload compresses it.
- On `pull_request`, `tests` writes the verdict to `$GITHUB_STEP_SUMMARY` and updates one PR comment found by a `<!-- test-baseline-verdict -->` marker. A failed comment post, as on a fork PR's read-only token, logs and doesn't change the result.
- `workflow_dispatch` behaves like `push` but never publishes a baseline or files issues.
- An empty selection skips the test jobs, and `tests` still runs and reports, per SC-3.

The `Tests` job is what a ruleset later requires. Making it required is a repo-settings action for the maintainer, per the [Rollout](logic.md#rollout) stages. `main` has no branch protection or rulesets today.

## DO-NOT-CHANGE fences

Backs [Scope and non-goals](logic.md#scope-and-non-goals).

- `scripts/suite.ts`: `runSuite`, `runFiles`, `rerunAlone`, `slotted`, `runRemote`, host selection and `main`. The loops and `queue.ts land` depend on them, and the OVH overflow logic only landed on 2026-10-30. Add the one export. Don't refactor.
- `package.json` `test` script. Loops and the README call it, and the logic spec keeps it unchanged.
- `.github/workflows/build.yml`. It's the release path, and this work doesn't touch building. New checks go in `tests.yml`.
- `scripts/test-on-macos.txt` format. `macosOnly` and the host path parse it.
- The contents of every existing test file during this stage. The speedup stage is separate, and [Decisions Locked](logic.md#decisions-locked) rules out removals.

## Always, ask, never

Always:

- Keep `compare`, `select`, `shards`, `junit` and `planIssues` pure, and test them without git or network.
- Run test code only in jobs with a read-only token.
- Give every failure a path to a visible result. An unexpected state fails the verdict rather than passing it.

Ask before:

- Setting the required-check ruleset, opening a PR, or pushing. All three are outward-facing.
- Adding a file to `scripts/test-not-on-ci.txt` for any reason other than a confirmed runner limitation, because that file removes coverage from PRs.

Never:

- Use `--parallel`, `--isolate`, `--shard`, `--timings` or `--changed` from Bun. The [Key decisions](logic.md#key-decisions) reject them.
- Inherit a result from a baseline. A test not run has no result.
- Quarantine or skip a test automatically.
- Add a dependency. Bun's built-ins cover all of this.

## Cross-cutting

Security: the PR path checks out PR code, so a PR can alter its own check. Fork PRs get a read-only token on `pull_request`, and merging still takes a maintainer, so this is a limit on what the check proves, not a privilege problem. Nothing uses `pull_request_target`, and no secrets are read beyond `github.token`.

Observability: run durations come from GitHub's run history, per [Success criteria](logic.md#success-criteria). `plan` prints the selection reasons and any graph scan misses.

Storage: a coalesced main run happens at most about 144 times a day at the 10-minute target. An estimated 15,000 keys of about 100 bytes compresses to well under 1 MB per artifact, so 14-day retention is small. The trial confirms the real size.

Rollback: delete `tests.yml`, or remove the ruleset once one exists. Nothing else depends on it, because `bun run test` is untouched.

Trial setup: `workflow_dispatch` needs the file on the default branch, so the first real run is the `pull_request` run on this branch's PR. With no baseline, every failure on it shows as `new`, and the check isn't required yet. `scripts/test-not-on-ci.txt` starts empty and uses the `macosOnly` format, per SC-17. It's created with a header comment in this stage. `macosOnly` returns an empty set when a file has no entries.

## Testing strategy

Backs [Behavior and scenarios](logic.md#behavior-and-scenarios). The acceptance bar is `bun test scripts/test-baseline` and `bun run typecheck`.

| File | Must cover |
|---|---|
| `junit.test.ts` | Nested suites, `classname` order, skipped, duplicated names, XML entities, empty and missing reports |
| `graph.test.ts` | Transitive importers in a temp repo, dynamic imports, type-only imports ignored, unresolved import counted, the real repo's `catalog.ts` and `agents.ts` selection sizes in a sane range |
| `select.test.ts` | SC-1 to SC-4 and rules 1 to 5, including `packages/daemon/src/main.ts` selecting `packages/daemon/test/shell-path.test.ts` and `plugins/quirky.git/src/ai/agents.ts` selecting `plugins/quirky.git/test/scenarios/ai.test.ts` |
| `shards.test.ts` | Balance, unknown durations, determinism, the cap, an empty list |
| `compare.test.ts` | Every label row, SC-6 to SC-11, no-baseline, a flake in a known-failing test, `incomplete`, `runBroken`, a not-on-CI file not counted as incomplete |
| `runner.test.ts` | Real temp test files that succeed, fail, fail to load, flake through a marker file and hang past a short limit. The limit on reruns. No process left behind |
| `baseline.test.ts` | Ancestor walk with a fake `gh`, null versus `BaselineUnavailable`, version check, `flakeHistory` carry-forward and 7-day pruning, no baseline from an incomplete run |
| `report.test.ts` | Each label section, the advisory line, baseline commit and age shown, not-on-CI listed |
| `issues.test.ts` | SC-5, SC-13, SC-14: first baseline silent, one issue per run, dedupe, selection miss, the 3-in-7-days threshold, closes |
| `workflow.test.ts` | Parses `tests.yml` with `Bun.YAML`: job named `Tests`, `if: always()`, `needs` as in the table, no write permission on `linux`, `macos`, `rerun` or `plan`, no `bun install` step in `tests`, no use of `pull_request_target` |
| `cli.test.ts` | `plan` on each event, including SC-11's null baseline and a failing `gh`, and `verdict` overlaying `rerun.json`, deciding `runBroken`, and writing `baseline.json` only when complete, using a temp repo and a fake `gh` |

The trial is what proves runner behaviour. Unit tests can't show that the suite works on GitHub, how long it takes, or whether `concurrency` gives newest-wins, because GitHub's docs page contradicts itself on running runs. Verifying these is part of [Rollout](logic.md#rollout).

## Non-goals

- The slow-file stage ([SC-18](logic.md#faster-full-suite)). It needs real baselines from GitHub, so it starts after the trial and isn't part of this build.
- Fixing tests that fail on GitHub runners. The trial lists them, and they get triaged then.
- Setting the required-check ruleset.
- Changes to `suite.ts` behaviour, the OVH or gcloud hosts, or how loops run tests. `LOOP.md` gains a pointer to the new command and keeps its `suite.ts` instructions.
- A dashboard, or storing history anywhere other than the baseline.
