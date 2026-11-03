# Tech spec: GitHub Actions is the only test runner

**Status:** Reviewed. Logic spec: [logic.md](logic.md).

## Architecture

Three independent pieces change, and none of them shares a file with another:

- **Test scripts** (`scripts/`): `scripts/suite.ts` loses every remote-host path and runs files on this machine only. `scripts/test-baseline/cli.ts` loses `run-files` and the host half of `affected`, which becomes list-only. CI's commands (`plan`, `run-shard`, `rerun`, `verdict`, `issues`) don't change. Back-link: [Decisions Locked → Retiring the hosts](logic.md#decisions-locked), SC-6, SC-7, SC-8.
- **Build workflow** (`.github/workflows/build.yml`): the macOS build skips draft PRs. Back-link: SC-1, SC-4, SC-5.
- **Docs**: every live doc that tells an agent where tests run. Back-link: [Scope & non-goals](logic.md#scope--non-goals).

## Code references

All paths are relative to the repository root.

### `scripts/suite.ts`

Remove these symbols and everything only they use: `Host`, `Remote`, `HostState`, `HostChoice`, `SLOT_BUSY`, `usableSlots`, `alive`, `landRunning`, `slowestFirst`, `slotDir`, `underLock`, `holdingSlot`, `slotted`, `slottedTestFile`, `hostLoad`, `chooseHost`, `sshTo`, `hostState`, `remoteConfig`, `hostFor`, `runInHostCopy`, `runRemote`, `RESULT_PREFIX`, the `--worker` branch of `main`, and the `homedir` import if it becomes unused. Remove `runSuite` and its helper `failures` too: after this change `main` no longer calls `runSuite`, and nothing else does (`grep -rn runSuite` lists only `suite.ts` and `suite.test.ts`).

`exec` (`suite.ts:57-100`) refers to `SLOT_BUSY` on line 86. With the flock case gone, that condition becomes just `profile`. Its `stdin` parameter was only for `runInHostCopy`, so remove it and pass `'ignore'` instead.

Keep these exports with unchanged signatures: `SuiteResult`, `TEST_FILE`, `bunTestFile`, `runFiles`, `discover`, `macosOnly`.

`main(argv)` becomes local-only:

CONTRACT: `main(argv: string[]): Promise<boolean>`. It installs dependencies with `installLocalDependencies(cwd)` (false when that fails), then returns `(await runFiles(cwd, discover(cwd, argv), flags, jobs)).ok`, where `flags` is the `-`-prefixed args and `jobs` is 1 when `QUIRKY_TEST_PROFILE=1` and `LOCAL_JOBS` otherwise. It never reads `remote-tests.json`, never runs `ssh` or `rsync`, and ignores `QUIRKY_TEST_LOCAL`.

CONFIG: `LOCAL_JOBS = 2`, a module constant in `suite.ts`. It matches the default `test:affected` used for local runs before this change (`FILES_AT_ONCE_LOCAL` in `runner.ts`). Running one file per process follows [Deferred Ideas](logic.md#deferred-ideas): daemon tests time out when they share a `bun test` process with happy-dom tests.

Rewrite the module docstring (lines 2-25) to describe what remains: each test file runs in its own process on this machine, two at a time; a failing file is rerun alone; flaky files go to `flakes.log`; dependencies install first when `package.json` exists. It must not mention a host, OVH, `remote-tests.json` or `QUIRKY_TEST_LOCAL`.

### `scripts/suite.test.ts`

- Delete the tests for removed behavior:
  - the five `runSuite` tests (:54-:81)
  - `the worker CLI preserves its suite result…` (:235)
  - `usableSlots` (:372)
  - `slowestFirst` (:379)
  - everything from :453 to the end, which covers `chooseHost`, `hostLoad`, `cliWithFakeSsh` and host runs
- Two tests call `runSuite` only as a way to start a real run: `actual bun test processes run unprofiled with isolated homes…` (:102-:127) and `a completed test run stops detached subprocess trees…` (:343). Switch them to `runFiles`, and keep what they assert.
- Keep the `runFiles`, `discover`, `macosOnly`, local-profile CLI (:200) and dependency-install CLI (:386) tests.
- The dependency-install test (:386) builds its fixture without `git init`. The CLI now finds files through `discover`, which runs `git ls-files`, so it would find nothing and pass without running anything. Make the fixture a git repo, and assert that the test file it imports actually ran.
- Add a test that runs the CLI (`bun scripts/suite.ts <dir>`) in a temporary git repo whose git common dir contains `build-loop/remote-tests.json` naming an unreachable host.
  - Assert that the files ran on this machine.
  - Put a fake `ssh` that fails loudly first on `PATH`, so any ssh call makes the test fail.
  - Adapt the `cliWithFakeSsh` helper (:525) for this test before you delete the host tests around it.
  - Prove the file ran with a marker file it writes, as the macOS-only test at :563 does.

### `scripts/test-baseline/report.ts` and `report.test.ts`

Remove `renderLocal` (`report.ts:102`) and its tests, because `affected` was its only production caller. Leave `renderComment` and everything else in `report.ts` alone.

### `scripts/test-baseline/cli.ts`

- Line 4: import only `bunTestFile` as a type from `../suite`.
- `Context`: remove `chooseHost`, `runInHost` and `stdin`. Keep `run`, because `run-shard` and `rerun` use it, and keep `download`.
- `USAGE`: remove the `run-files` line, and change the `affected` line to `affected   [--json]`.
- Remove `runFilesCommand`, `runFilesOnHost`, `FILE_RESULTS_PREFIX` and the `'run-files'` entry in `COMMANDS`.
- `affectedCommand`: see the contract below.
- The `runCli` docstring (:566-571): keep it accurate. `affected` still imports `graph` lazily.

### `scripts/test-baseline/cli.test.ts`

Remove `describe('with a test host')` (around :1028), the run-files argument cases (around :218-220) and `describe('run-files process output')` (around :1225). Rewrite the existing `affected` tests to match the list-only contract below. Every `affected` test must assert that `ctx.run` is never called.

### `scripts/test-baseline/runner.ts` and `runner.test.ts`

Remove `FILES_AT_ONCE_LOCAL`, which has no caller once `affected` stops running tests. Update the constants assertion at `runner.test.ts:49` to match.

### `scripts/test-support/repo-files.ts`

Remove the no-`.git` fallback, which existed only for the host's copy of the tree. CONTRACT: `repoFiles(repo: string): string[]` returns `git ls-files` output split on newlines, and throws an `Error` naming the repo when `git ls-files` fails. Callers: `scripts/test-baseline/select.test.ts:335` and `graph.test.ts:157`, both on checkouts that have `.git`, both locally and on GitHub. Update the docstring to match.

### `.github/workflows/build.yml`

CONFIG:
- `on.pull_request.types: [opened, synchronize, reopened, ready_for_review]`
- On `jobs.build`: `if: github.event_name != 'pull_request' || !github.event.pull_request.draft`

`release` already `needs: build` and only runs for tags, so it needs no change. Leave `push`, `workflow_dispatch`, `concurrency` and `env` as they are.

### Docs

- `AGENTS.md`, "Where tests run": rewrite the table and rules. These four rows and these rules must all hold:
  - Full suite: open a PR (a draft is fine) and add the `full-suite` label. Runs on GitHub Actions.
  - The tests your change affects: push to your draft PR. Runs on GitHub Actions. `bun run test:affected` lists what the push would run, and runs nothing.
  - One file while you edit: `bun test <file>`. Runs on this Mac.
  - Never run `bun run test`, `bun test` with no path, or `bun scripts/suite.ts <dirs>` here, because they run on this Mac. The exception is the build loop's final `queue.ts check`.
  - Keep the rules about reading the PR's Tests comment or `gh pr checks <number> --watch`, the label staying on, and `unset GITHUB_TOKEN`.
  - Replace the OVH-down rule: if GitHub Actions isn't running jobs, stop and report it, and don't fall back to running suites on this Mac.
  - Replace the "selected every test" rule: if `test:affected` says the next push runs the whole suite, that's expected for changes to shared test tooling.
  - Drop every mention of OVH and `QUIRKY_TEST_LOCAL`.
  - Add one line: draft PRs skip the macOS app build until marked ready.
- `README.md:246-250`, `docs/loop/README.md:37-63`, `docs/loop/LOOP.md:179-182`, and `docs/v1.md:227` ("remote-aware runner") and `:242` ("loaded test host"): replace the OVH or remote-host description with GitHub Actions through draft PRs, linking to `AGENTS.md` instead of restating its table.
- `docs/loop/LOOP.md:104` runs `bun scripts/suite.ts packages apps plugins`, which would now run the full suite on this Mac. Point it at a draft PR with the `full-suite` label.
- `docs/qa-loop/FIX.md:37` tells fixers to run `bun run test:affected` and read its `new` and `known` failures. `test:affected` no longer reports either, so tell fixers to push to their draft PR and read the Tests comment, where `new` failures are theirs.
- `scripts/test-on-macos.txt`: rewrite only the two-line header. These files run in the Tests workflow's macOS job and on this Mac, and the Linux shards skip them. Leave the per-file reasons alone.

## Contracts & interfaces

### `test:affected` (`bun scripts/test-baseline/cli.ts affected [--json]`)

How it picks the baseline and changed paths doesn't change (`cli.ts:481-506`). What changes is everything after the selection is known.

- **Runs nothing.** It never calls `ctx.run`, never spawns `bun test`, and never starts `ssh`, `rsync` or any other host.
- **Exit code** is 0 whenever a selection was made, 2 for a usage error (including the old `--list` and `--jobs` flags), and 1 for an unexpected error.
- **Text output, on stdout:**
  - `mode: 'some'`: one line per selected file, then a `why:` line, then one line per entry of `selection.reasons`, indented by two spaces.
  - `mode: 'none'`: `No tests are needed for this change.`, then the `why:` block.
  - `mode: 'all'`: `This change selects every test, so the next push runs the whole suite.`, then the `why:` block. Don't list the files.
- **JSON output** (`--json`), on stdout:

SCHEMA: `{ "mode": "none" | "some" | "all", "files": string[], "reasons": string[] }`. This is the existing `Selection` type from `scripts/test-baseline/types.ts:17`, printed with `JSON.stringify(selection, null, 2)`. For `mode: 'all'`, `files` lists every test file.

- **Stderr** keeps the existing baseline notes (`no baseline found…`, `baseline unavailable…`).

`selection.reasons` explains the selection one changed path at a time (`<path>: <rules fired>`). That's how this spec reads SC-6's "the rule that picked each"; it doesn't add new attribution for each test file.

## DO-NOT-CHANGE fences

- `.github/workflows/tests.yml`: the logic spec keeps the Tests workflow unchanged. Its trigger types already leave out `ready_for_review`, which is what SC-4 needs.
- `scripts/test-baseline/select.ts`, `shards.ts`, `baseline.ts`, `compare.ts` and `report.ts`: which files a push selects stays the same (Scope & non-goals).
- `cli.ts` `planCommand`, `runShardCommand`, `rerunCommand`, `verdictCommand` and `issuesCommand`: CI runs these, and this change keeps CI exactly as it is.
- `scripts/test-on-macos.txt` entries: the 18 macOS-pinned files stay the same, apart from the header comment.
- `docs/quirk/specs/**`, `docs/loop/decisions/**`, `docs/loop/BLOCKERS.md`, `docs/loop/DECISIONS.md` and `docs/loop/queue.json`: historical records keep their wording.
- Plugin READMEs (`plugins/*/README.md`): out of scope in the logic spec.
- `<git common dir>/build-loop/remote-tests.json`: stays on disk until OVH is cancelled (SC-10). No code in this branch reads or deletes it.

## Always / Ask / Never

- **Always:** keep `bunTestFile`, `runFiles`, `discover`, `macosOnly` and `TEST_FILE` exported with their current signatures. `runner.ts`, `cli.ts` and CI depend on them.
- **Always:** follow the repo's comment rules: no inline comments that narrate, and docstrings that state intent.
- **Ask:** any change to which files CI runs, or to how a PR comment reads.
- **Never:** run the full suite locally (`bun run test`, `bun scripts/suite.ts packages apps plugins`). Run single test files only.

## Cross-cutting

- **Rollback:** reverting the PR brings the OVH path back, as long as `remote-tests.json` is still on disk.
- **Older branches:** SC-10 holds with no code here, because old branches carry their own `suite.ts`.

## Testing strategy

Run these locally, as single files:

- `scripts/suite.test.ts`: `runFiles`, `discover`, `macosOnly` and test-home behavior are kept. A new test shows a CLI run with `remote-tests.json` present stays on this machine and never runs `ssh`.
- `scripts/test-baseline/cli.test.ts`: `affected` covers the some, none and all modes, `--json`, the usage error for `--list` and `--jobs`, and never calls `run`. `run-files` now gives a usage error (exit 2, unknown subcommand).
- `scripts/test-baseline/runner.test.ts`: the constants assertion is updated.
- `scripts/test-baseline/select.test.ts` and `graph.test.ts` still pass with the stricter `repoFiles`.
- `bun run typecheck` passes.
- The workflow change is checked on the draft PR, which the change selects in full because it touches `scripts/suite.ts`.

## Non-goals

- Any change to the Tests workflow, to selection, or to sharding.
- Deleting `remote-tests.json` or the OVH machine, or cleaning up Google resources. Those happen after merge, outside the repo.
- `research/qa-loop-harness/FIX.md`, which the logic spec's scope says is "updated in place". It lives in the main checkout's git-ignored `research/` repo, not in this worktree. The orchestrator edits it in place, to match `docs/qa-loop/FIX.md`, outside this PR.
