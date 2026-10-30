# Fast test feedback against a stored baseline

Agents and the maintainer get a test answer for a change in minutes, because only the tests that change can affect are run and the results are compared with a stored record of what main already did. PR checks run on GitHub. A later stage uses the same records to speed up the slowest files.

## Why this exists

Nothing tests a PR today. `build.yml` only typechecks and builds, so tests run by hand or in the loops, and a full run took 13 to 38 minutes on the shared host. When a test fails, the only way to learn whether main fails it too is a scratch worktree of `origin/main` (`docs/qa-loop/FIX.md`, step 5).

Two measurements shape the design:

- Time is concentrated. Logged per-file time adds up to about 84 minutes, and 50 files account for half of it. The figure is rough, because the host is shared and 226 of the 929 files have no history.
- Most changes are small. Of the last 300 non-merge commits, 121 touched only docs or scripts, and the median commit touched one area.

An earlier attempt, `docs/loop/decisions/fix-test-cost.md`, made the changed files about 12% faster but couldn't show a faster full suite, because the shared host is too noisy to compare runs. Running on GitHub gives a more consistent machine to measure on, though runner timing can still vary.

## Conceptual model

A **baseline** is one complete run on a main commit: every test's result, every file's duration, and which tests flaked. A change is judged only on tests that actually ran. Results are never inherited from the baseline, so nothing gets credit for a test it didn't run.

Each result on a change gets one label:

| Label | Meaning | Blocks a PR? |
|---|---|---|
| New failure | Fails now, and wasn't failing in the baseline, or the test is new | Yes |
| Known failure | Already failing in the baseline | No, listed |
| Flaky | Failed, then succeeded when its file reran alone | No, flagged |
| Fixed | Failing in the baseline, succeeds now | No, listed |
| Missing | In the baseline but absent from a selected file, or from a deleted test file | No, listed for review |

Comparison is per test, so a new failure still counts in a file that was already partly failing.

## How results flow

Three paths share one selection and one comparison.

A push to main starts a full run, and if pushes arrive during it, only the newest waits. Files run in parallel Linux jobs, split by duration, one process per file. The macOS-only files in `scripts/test-on-macos.txt` run on a Mac runner, and the 13 test files in `scripts/` join the run. The baseline is published only if every job finished. It's then compared with the previous baseline to file any issues.

A pull request runs the `Tests` check. It finds the newest baseline on an ancestor of the PR, selects tests from the difference between that baseline's commit and the PR, runs them in the same split, and posts the labels on the PR.

Before pushing, one local command runs the same selection on the Mac and compares against the same baseline. Its result is labelled advisory, because a Mac can fail tests a Linux baseline doesn't, and the PR check decides.

`bun run test` and the OVH host path stay as they are for the loops.

## Behavior and scenarios

### Selection

1. **SC-1: A plugin change selects its own tests and what depends on them**
   - **Given** a change to one file in a plugin's source
   - **When** tests are selected
   - **Then** the selection is the plugin's whole test directory, plus any test that imports the changed code
   - **Data before:** **Change**: `plugins/quirky.git/src/ai/agents.ts`
   - **Walkthrough:**
     1. The selector finds the 14 test files that import the changed code.
     2. The selector adds the rest of `plugins/quirky.git/test/`, including `test/scenarios/ai.test.ts`, which the import graph alone leaves out.
   - **Data after:** **Selection**: ✓ every file in `plugins/quirky.git/test/` and the importers

2. **SC-2: A daemon or CLI change selects every test that spawns one**
   - **Given** a change in `packages/daemon`, `packages/cli`, `packages/pty-host` or `packages/protocol`
   - **When** tests are selected
   - **Then** the selection includes every test that spawns the daemon or CLI, plus importers and that package's test directory
   - **Data before:** **Change**: `packages/daemon/src/main.ts`; the import graph alone selects 0 files
   - **Walkthrough:**
     1. The selector sees a change to a spawned entry point.
     2. The selector adds every test that spawns the daemon or CLI.
   - **Data after:** **Selection**: ✓ spawning tests across all plugins; ✓ `packages/daemon/test/`

3. **SC-3: Docs-only changes select nothing, and the check still reports**
   - **Given** a PR that changes only documentation
   - **When** the `Tests` check runs
   - **Then** it runs no tests and reports success, saying no tests were needed

4. **SC-4: Anything unrecognised runs everything**
   - **Given** a change to the lockfile, a config file, the test runner, a workflow, or a path the rules don't recognise
   - **When** tests are selected
   - **Then** the selection is the full suite

5. **SC-5: A selection miss is caught after merge and named**
   - **Given** a merged change broke a test that its PR check didn't select
   - **When** the next full run on main finishes
   - **Then** the issue for that run calls it a selection miss, so the rule can be widened
   - **Data before:** **Baseline A**: `plugins/quirky.handoff/test/delivery.test.ts`* succeeds; **PR 101*** changed `plugins/quirky.git` and its check didn't select that file
   - **Walkthrough:**
     1. PR 101 merges and main moves.
     2. The full run finds the test failing and publishes **Baseline B**.
     3. The comparison sees that the failure is new and that PR 101's selection left the test out.
   - **Data after:** **Issue**: ✓ names the commit range from Baseline A to Baseline B; ✓ marks the failure as a selection miss

### Comparing results

6. **SC-6: A PR is blocked only by failures it's responsible for**
   - **Given** a PR's selected tests include a known failure and a new failure
   - **When** the check compares them with the baseline
   - **Then** the check fails on the new failure, and the known failure is listed without blocking
   - **Data before:** **Baseline**: "keeps tabs in order"* fails; "opens a pane"* succeeds
   - **Walkthrough:**
     1. The PR check runs both tests, and both fail.
     2. The comparison labels "keeps tabs in order" known and "opens a pane" new.
   - **Data after:** **Tests check**: ✗ failed on 1 new failure; **PR comment**: lists 1 new failure and 1 known failure

7. **SC-7: A new test must succeed**
   - **Given** a test that isn't in the baseline
   - **When** it fails on the PR
   - **Then** it's a new failure and blocks

8. **SC-8: A file that can't load counts against every test it held**
   - **Given** a selected file that fails to load, and that loaded in the baseline
   - **When** results are compared
   - **Then** the file is a new failure and blocks, rather than its tests being listed as Missing

9. **SC-9: A breakage from main that the baseline hasn't caught up with**
   - **Given** a commit on main broke a test after the newest baseline was recorded, and a PR's check fails on that test
   - **When** results are compared
   - **Then** it's labelled a new failure and blocks, and the PR comment names the baseline's commit and age
   - **Then** rerunning the check after a newer baseline lands relabels it as known, and the PR is no longer blocked by it

10. **SC-10: A flake gets through and is visible**
    - **Given** a test fails in the PR check and its file then succeeds when rerun alone
    - **When** results are compared
    - **Then** the check succeeds and the PR comment flags the flake
    - **Then** when more than five files fail, as in today's runner, nothing is rerun and each failure is judged against the baseline without a Flaky label

11. **SC-11: No usable baseline means nothing can be excused**
    - **Given** the PR has no ancestor with a baseline
    - **When** the check runs
    - **Then** it runs the full suite and every failure blocks

12. **SC-12: The pre-push command gives the same answer in the same terms**
    - **Given** an agent has an unpushed change
    - **When** it runs the local command
    - **Then** it sees the same labels, marked advisory, and the command exits non-zero on any new failure
    - **Then** if the baseline can't be fetched, the command says so, selects from the merge base with main, and treats every failure as new
    - **Walkthrough:**
      1. The agent runs the command in its worktree.
      2. The command prints one line per failing test with its label.
    - **Data after:** **Output**: `advisory: 1 new failure, 2 known failures, 0 flaky, against baseline <commit>`*

### Keeping main healthy

13. **SC-13: New failures on main file one issue per run**
    - **Given** a full run on main finds failures the previous baseline didn't have
    - **When** the baseline is published
    - **Then** one issue opens, naming the commit range and listing the failures, and PRs keep merging
    - **Then** failures already covered by an open issue don't open another, and the issue closes itself once a later baseline shows them all gone

14. **SC-14: A repeat flake gets an issue and keeps running**
    - **Given** a file was flagged flaky in 3 main runs within 7 days
    - **When** the third baseline is published
    - **Then** one issue opens with its history, and the file stays in the suite and keeps counting
    - **Then** the issue closes itself once 7 days of main runs show no flake from that file
    - **Then** flakes on PRs don't count towards the threshold, because a PR can cause its own flake

15. **SC-15: An incomplete run never becomes a baseline**
    - **Given** a job in a full run crashes or is cancelled
    - **When** the run ends
    - **Then** no baseline is published, the previous baseline stays in use, and the next push starts a new run

### Rollout

16. **SC-16: The check becomes required only after it has shown it can be trusted**
    - **Given** the workflows are ready
    - **When** they roll out
    - **Then** the order is: a GitHub trial with anything failing only there triaged, then a week as an advisory check, then required once a week passes with no false new failures
    - **Then** a false new failure means a blocking label on a test the PR didn't break and main didn't break either, such as a runner difference
    - **Rollout stages:**

      | Stage | Runs on | Can block a merge? | Moves on when |
      |---|---|---|---|
      | Trial | Manual GitHub runs | No | Runner-only failures are triaged and both targets have a measured time |
      | Advisory | Every PR and main push | No | A week with no false new failures |
      | Required | Every PR and main push | Yes | Stays required |

17. **SC-17: The trial decides where each macOS-only file runs**
    - **Given** the 18 files in `scripts/test-on-macos.txt`, mostly real Chrome tests
    - **When** the trial runs them on a macOS runner
    - **Then** files that work stay on that runner, and any that can't are listed as not checked on PRs and stay on the local Mac, so the gap is visible

### Faster full suite

18. **SC-18: Slow files are sped up by rank without losing tests**
    - **Given** baselines have recorded consistent per-file durations
    - **When** the slowest files are reworked in rank order
    - **Then** fixtures, waits and scheduling may change, every test name and assertion stays, and a PR that loses a test shows it as Missing
    - **Then** assertions are checked in review, because a baseline records test names and results rather than assertions

## Key decisions

The approach is a small repo-owned layer on the existing one-process-per-file runner. Bun's `--parallel`, `--shard` and `--changed` were rejected as the base, because open bugs around child processes, shard crashes and workspace selection could block or wrongly clear merges in a required check, and `FIX.md` already records that a whole plugin directory in one process hangs. A monorepo task runner was rejected because selection is per package by default and most of its speedup is result reuse, which this design rules out.

Baselines are recorded on GitHub rather than OVH because the PR check runs there. Comparing across machines would report runner differences as new failures.

The speed targets are aspirational until the trial measures them. A `packages/protocol` change selects 610 files with the import graph alone, so core changes are expected to run longer, and all checks and baselines share a limit of 20 concurrent GitHub jobs (5 on macOS).

### Success criteria

- A PR touching one area (one package, app or plugin, with no core-package or run-everything trigger) gets its verdict in a median of under 5 minutes from push, including queue time.
- A full baseline run finishes in a median of under 10 minutes, including queue time.
- Both medians are measured from GitHub's run history over the first two weeks after the check becomes required.
- The speedup stage ends with the same set of test names it started with.

### Decisions Locked

What runs when:

- The goal is fast answers on a change, plus a faster full suite and a stored baseline agents can compare against.
- The baseline is for comparing results with the known state before a change. Nothing is inherited from it.
- A new baseline is recorded after pushes to main, newest wins.
- Selection is the import graph plus hidden-dependency rules, and unrecognised paths run everything.
- A required PR check runs the selection and blocks on new failures.
- PR checks run on GitHub, not on our hosts. Baselines follow them there.
- Tests run on parallel Linux runners, with a macOS runner for the macOS-only files.
- Agents run the selection locally against the baseline before pushing, as advice. The PR check decides.

Flake policy:

- A test that fails and then succeeds alone gets through and is flagged on the PR.
- A repeat flake keeps running and gets an issue, after 3 flagged main runs in 7 days. Only main runs count.
- A new failure on main files one issue per run naming the commit range, and merging continues.

Protection and targets:

- No test is removed this round. Speedups may change fixtures, waits and scheduling only.
- The targets are a typical PR under 5 minutes and a full suite under 10.

Applied from the approved design without a separate question:

- Baselines are kept for 14 days. GitHub allows up to 90 and free storage is limited.
- A failure from main that the baseline hasn't caught yet blocks until a newer baseline lands (SC-9).
- When the baseline can't be fetched locally, every failure is treated as new (SC-12).

## Scope and non-goals

In scope: the baseline, selection, comparison, the `Tests` check, the local command, issue filing, the rollout, and the slow-file stage. `FIX.md` step 5 and the matching text in `docs/loop/LOOP.md` change to use the new command.

Out of scope:

- Removing, merging or quarantining tests.
- Reusing results for tests that weren't run.
- Selecting tests from recorded traces.
- Changing the OVH or gcloud host setup, or how the loops use them.
- Running the full suite on every PR.
- A dashboard. GitHub's run history and the PR comment are the reporting surface.

## Industry insights

Evidence was thin overall. Most sources are vendor docs, issues and PRs rather than independent studies.

- Open Bun issues back the choice of the existing runner: lost child exits under `--parallel` ([#43697](https://github.com/oven-sh/bun/issues/43697)), exit segfaults with `--isolate --shard` in about 4 of 40 runs ([#43056](https://github.com/oven-sh/bun/issues/43056)), inflated timings under contention ([#40283](https://github.com/oven-sh/bun/issues/40283)), and `--changed` missing workspace packages ([#44162](https://github.com/oven-sh/bun/issues/44162)).
- Two small repos report shorter CI from `--shard`: [folio-assistant](https://github.com/litlfred/folio-assistant/pull/1824) went from 6.8 minutes to a slowest shard of 3.4.
- Selection always misses something. Meta's predictive selection is reported to catch over 95% of failing tests while running under a third of them ([paper](https://arxiv.org/pdf/1810.05286)), and Gradle's documented remedy for a miss is adding the test to must-run criteria ([Develocity](https://docs.gradle.com/enterprise/predictive-test-selection/)). This is why misses are named and turned into rules. The Meta figure comes from a search snippet.
- Retries can hide real bugs. One team's cleanup of 63 flaky tests found 5 ([specstory](https://specstory.com/learning/debugging/test-retries)), though that's an anecdote. This is why flakes are flagged rather than silent.
- Coverage can't show a test is redundant, and one repo's 741 removal candidates would have saved about 9 seconds of CI ([shipmill #837](https://github.com/shipmill/shipmill/issues/837)). This supports no removals this round.
- Trace-based selection doesn't fit yet: pytest-testmon [dropped subprocess measurement](https://www.testmon.org/blog/new-in-testmon-100/), and Datadog's version [excludes `pull_request` events](https://docs.datadoghq.com/tests/test_impact_analysis/).
- GitHub limits on a public repo: standard runners are [free](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), Linux runners have 4 vCPUs and 16 GB, macOS runners have 3 and 7 GB, and the Free plan allows [20 concurrent jobs, 5 on macOS](https://docs.github.com/en/actions/reference/limits).

## Deferred ideas

- Trace-based selection, if selection misses pile up.
- Removing redundant tests with mutation evidence, if the slow-file stage stalls.

Build-only questions for the tech spec:

- `[tech-spec]` The baseline's stored format, and how a run finds the newest ancestor baseline.
- `[tech-spec]` How many Linux jobs to use, and where duration data comes from on a run with no history.
- `[tech-spec]` Where the selection rules live, and how spawning tests are identified. 25 test-side files name a product entry point by path, and the daemon loads plugins with a dynamic import.
- `[tech-spec]` Whether selection uses `bun test --changed` or builds its own graph, given [#44162](https://github.com/oven-sh/bun/issues/44162).
- `[tech-spec]` Whether GitHub's `concurrency` setting gives newest-wins as documented, because its docs page contradicts itself on running runs.
- `[tech-spec]` Runner setup for tests that need `/bin/zsh`, Chrome or `flock`.
- `[tech-spec]` Which documentation paths count as docs-only, given that some tests may read docs.
- `[tech-spec]` How this rebases onto the `suite.ts` host-overflow change on main (`50dd0f72`).

## Glossary

- **Baseline:** the stored record of one complete test run on a main commit.
- **Selection:** the test files a change can affect, according to the rules in SC-1 to SC-4.
- **Verdict:** the labelled result of comparing a run with a baseline.
- **Full run:** every test file, on GitHub, for a main commit.
- **Selection miss:** a failure on main in a test that the responsible PR's check didn't select.
- **False new failure:** a blocking label on a test that neither the PR nor main broke.
- **Area:** one package, app or plugin.

## Status & amendments

**Status:** Draft, awaiting user review.

**Amendments:** None.
