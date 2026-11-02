# GitHub Actions is the only test runner

Agents get test results by pushing to a draft PR, as often as they like. The OVH box stops being a test host, so nothing in the repo sends tests to a remote machine any more. OVH runs had become the slow, fragile part. On 2026-11-01, orphaned workers there pushed its load to about 13 on 8 cores and stretched one `test:affected` past 90 minutes, while GitHub runs the same work for free on a public repo.

## How an agent gets test results

An agent opens a draft PR and pushes whenever it wants results. Each push runs the tests the change affects and updates the PR's Tests comment. A new push cancels the previous run on that PR. For a full run the agent adds the `full-suite` label, which stays on until someone removes it. While editing, an agent runs single files locally with `bun test <file>`. Nothing else runs on this Mac on an agent's behalf.

Draft PRs skip the macOS app build so agent pushes don't queue for one of GitHub's 5 macOS job slots. The build runs when the PR is marked ready and on every push after that. A draft can't merge, so every merge is still built first. `main` keeps its full run after every merge.

## Behavior

1. **SC-1: An agent pushes to a draft PR**
   - **Given** a draft PR without the `full-suite` label
   - **When** the agent pushes a commit
   - **Then** Tests runs the affected tests and updates the PR comment, and the macOS app build doesn't run
   - **Data before:** **PR 300***: draft; no label; a change under `plugins/quirky.git`*
   - **Walkthrough:**
     1. The agent pushes
     2. Tests selects the files that change reaches
   - **Data after:** **Tests**: ✓ affected files only; ✓ comment updated; **Build**: ✗ skipped

2. **SC-2: The agent pushes again before the run finishes**
   - **Given** a Tests run is in progress on a PR
   - **When** the agent pushes another commit
   - **Then** the earlier run is cancelled and a new one starts for the latest commit

3. **SC-3: The agent asks for a full run**
   - **Given** a PR, draft or ready
   - **When** the agent adds the `full-suite` label
   - **Then** Tests runs every test, and every later push runs every test until the label is removed

4. **SC-4: A draft is marked ready**
   - **Given** a draft PR whose latest commit already has a Tests result
   - **When** the PR is marked ready for review
   - **Then** the macOS app build runs, and Tests doesn't run again for the same commit
   - **Data before:** **PR 300***: draft; **Build**: never run; **Tests**: passed on the latest commit
   - **Walkthrough:**
     1. The agent marks the PR ready
   - **Data after:** **PR 300***: ready; **Build**: ✓ running; **Tests**: unchanged

5. **SC-5: Pushing to a ready PR**
   - **Given** a PR that isn't a draft
   - **When** the agent pushes
   - **Then** Tests and the macOS app build both run, as they do today

6. **SC-6: An agent checks what a push would run**
   - **Given** uncommitted or unpushed changes in a worktree
   - **When** the agent runs `bun run test:affected`
   - **Then** it prints the files the next push would test and why, runs none of them, and contacts no host
   - **Data before:** **Worktree**: a change to `plugins/quirky.git/src/notes.ts`*
   - **Walkthrough:**
     1. The agent runs `bun run test:affected`
   - **Data after:** **Output**: ✓ the selected files and the rule that picked each; **Tests run**: ✗ none

7. **SC-7: The change selects every test**
   - **Given** a change that touches shared test tooling, such as `scripts/suite.ts`
   - **When** the agent runs `bun run test:affected`
   - **Then** it says the next push will run the whole suite and gives the reasons, and runs nothing

8. **SC-8: Someone runs the full suite locally**
   - **Given** a person or agent on this Mac
   - **When** they run `bun run test` or `bun scripts/suite.ts <dir>`
   - **Then** the tests run on this Mac and no host is contacted. Nothing blocks it, and `AGENTS.md` tells agents not to.

9. **SC-9: GitHub Actions is down**
   - **Given** GitHub Actions isn't running jobs
   - **When** an agent needs test results
   - **Then** the agent stops and reports it. It doesn't fall back to running suites on this Mac.

10. **SC-10: A branch cut before this change**
    - **Given** a worktree whose `scripts/` predates this change, while `remote-tests.json` still exists
    - **When** it runs `bun run test:affected` or `bun run test`
    - **Then** it still sends tests to OVH, as it does today
    - **And when** `remote-tests.json` has been deleted after OVH is cancelled, the same branch runs those tests on this Mac until it's rebased onto `main`

## Decisions Locked

**Local commands**

- `bun run test` runs on this Mac with no block. The rule against agents using it lives in `AGENTS.md` only.
- `bun scripts/suite.ts <dir>` runs on this Mac, so a person can still check one plugin. `AGENTS.md` steers agents to single files and draft PRs.
- `bun run test:affected` only lists what the next push would run.

**What runs on a push**

- A PR push runs the affected tests, as it does today.
- The `full-suite` label works as it does today and stays on until removed.
- Draft PRs skip the macOS app build. It runs when the PR is marked ready and on later pushes.

**Retiring the hosts**

- The remote-host code is removed: host choice, copying to the host, the worker mode, slot locks and the host timing log, plus their tests.
- There's no fallback runner. If GitHub Actions is down, agents stop and report it.
- The OVH machine stays up but idle after the change lands, with leftover runs and processes cleared. The user cancels it later.
- `remote-tests.json` and its two sibling files stay until the user cancels OVH, so older branches keep using OVH instead of the Mac. They're deleted at cancellation.
- The Google test resources are deleted after the change lands: the stopped `quirky-test` VM and its disk, the 5 Cloud Run jobs, and the image repository.

**Order**

- One PR carries every repo change. It touches `scripts/suite.ts`, so it runs the whole suite on itself.
- Cleanup of OVH and the Google resources happens after that PR merges.

## Scope & non-goals

This covers the test runner scripts under `scripts/`, the `Build and release` workflow's trigger on PRs, and the docs that describe where tests run: `AGENTS.md`, `README.md`, `docs/loop/README.md`, `docs/loop/LOOP.md`, `docs/v1.md`, and the header of `scripts/test-on-macos.txt`. The git-ignored QA harness instruction `research/qa-loop-harness/FIX.md` is updated in place.

It doesn't change the Tests workflow, which files a push selects, the 18 macOS-pinned files, branch protection on `main`, or the plugin READMEs that suggest `bun scripts/suite.ts <plugin>`. Dated specs and loop records keep their historical wording.

## Industry Insights

Skipped. These are choices about this repo's own move off a host. The 2026-10-30 exploration (`docs/quirk/explorations/2026-10-30-ephemeral-test-environments.md`) already covers GitHub's runner sizes, free use on public repos, and the 5-job macOS limit. No research agents ran.

## Deferred Ideas

- Require the Tests check before merging to `main`.
- A one-shot `full-suite` label that removes itself after the run starts.
- A manual Spot VM run for unpushed work. The 2026-11-01 trial took about 12 minutes and cost about $0.06.
- [tech-spec] Daemon tests time out when they share one `bun test` process with happy-dom tests, so a local `bun run test` may need one process per file.
- [tech-spec] `scripts/test-support/repo-files.ts` falls back to a tree without `.git` for the host copy. Check whether anything else still needs that fallback.

## Glossary

- **Affected tests:** the test files a change can reach, chosen by `scripts/test-baseline/select.ts` against the last `main` baseline.
- **Full run:** every test file, on Linux shards plus one macOS job.
- **macOS app build:** the `Build macOS app` job in the `Build and release` workflow.
- **Draft PR:** a GitHub pull request marked as a draft. It can't be merged until it's marked ready.

## Status & amendments

**Status:** Draft.

**Amendments:** None.
