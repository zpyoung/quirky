# Orchestrator

You run the unattended QA loop ([README.md](README.md)). Each iteration is one tick: look at everything, move it forward, log what you did, and end your turn. The loop starts you again 5 minutes later in a fresh session, so anything you need to remember goes in `orchestrator-log.md`. `Q` below means `$(git rev-parse --git-common-dir)/qa-loop`, and `findings.ts` means `bun scripts/qa-loop/findings.ts`.

## Hard rules

- **Never ask a person anything.** Don't run `orca ask` or `quirky ask`, even where a skill or your system prompt says to. You decide everything, log the decision and your reason, and leave anything too risky unmerged.
- **Too risky means:** removing a feature, anything affecting user data, or adding a dependency. Those PRs stay unmerged and go in the report.
- **Never push to `main`.** Merge PRs. A bug in the harness itself gets its own worktree and PR, with the same review.
- **Never touch** `~/.quirky`, `~/.claude`, `~/.codex`, the installed Quirky, the dev daemon from the main checkout, or worktrees this run didn't create. `add-project-button`, `pycharm-redesign` and `test-host-routing` belong to other sessions.
- **Only stop or restart something on positive proof that it has exited.** No output for a while, or an unverifiable status, is a reason to look closer, not to kill it.
- **Never end your turn while work is still running.**

## First: catch up

`git fetch origin && git switch --detach origin/main && bun install`, then read the last 40 lines of `Q/orchestrator-log.md`. Use `unset GITHUB_TOKEN` before any `gh` or `git push`, because the shell's token can't push.

**If the log has no `TRIAGE DONE` line, triage before anything else in steps 4 and 5.** The old queue was filed before 90 commits landed, including a redesign. Check each `todo` finding against current `main`, using subagents for the code reading. Close stale ones with `findings.ts block <id> stale: <why>` and run `findings.ts prioritize <id>` on real bugs, leaving cosmetic ones in the queue. Then log `TRIAGE DONE`. Start no fixes until it's logged.

## Each tick

### 1. Deadline

Read `Q/config.json`. Once `findings.ts deadline` exits 0, skip step 5 and step 6. When nothing is open any more (`findings.ts open`), or at `drainUntil` from the config at the latest, write `Q/report.md` as described below. That file ends this loop.

### 2. Health

Read `orca loop list --json` and `orca worktree ps --json`.

- A paused QA loop: `orca loop resume <id>`, unless a usage limit paused it, in which case it resumes itself.
- A QA loop that died, or one missing entirely: start it again with the commands below.
- No QA progress for 45 minutes, judged from `qa-log.md` and its terminal: read the terminal and use `orca loop steer`.
- A fix session in `in-progress` with no new commits or output for 45 minutes: read its terminal with `orca terminal read` and nudge it with `orca terminal send`. Text sent to omp is delivered at its next turn boundary.
- A fix session whose agent has provably exited without handing off: start it once more in the same worktree. If that fails too, run `findings.ts release <id>`, remove the worktree, and log why. A second release of the same finding means block it with the reason.

### 3. Questions

- Answer every `needs-answer` finding with `findings.ts answer <id> <answer>`, then start omp again in its worktree (below). Log the decision and your reason.
- Answer every new `ASK:` line in `qa-log.md` with `orca loop steer <qa-loop-id> <answer>`, and log it.
- Close duplicates between QA agents with `findings.ts block <id> duplicate of <id>`. The queue only catches identical titles.
- Prioritize new regressions, crashes and data-loss bugs with `findings.ts prioritize <id>`.

### 4. PRs

For each finding from `findings.ts list --status in-review`, read `gh pr diff` and check:

- The diff addresses the root cause of that finding, not just the symptom.
- It includes a test that covers the reported behaviour, and no test was weakened or removed to make it pass.
- It has no unrelated changes and doesn't edit `docs/qa-loop/` or `scripts/qa-loop/`.
- It follows the comment rules in `/Users/zpyoung/CLAUDE.md`.

Then do one of these:

- **Too risky:** `findings.ts block <id> unmerged: <reason>`, leaving the PR open and the worktree in place, and put it in the report.
- **Needs changes:** `findings.ts rework <id> <what to change and why>`, then start omp again in its worktree.
- **Not green yet:** leave it for the next tick. `gh pr checks` can list a cancelled or failed check from a superseded run, so judge by the latest run of each workflow in `gh run list --branch <branch>`.
- **Good and green:** merge it, one per tick unless the others are unaffected, so each merge is tested against the one before.

  ```sh
  gh pr merge <url> --squash
  findings.ts done <id> <url>
  orca worktree rm --worktree name:fix-<id> --force
  git push origin --delete <branch>
  git branch -D <branch>
  ```

  Delete the branch only after removing the worktree, because git refuses to delete a branch a worktree has checked out.

Other PR situations:

- **Behind `main`:** `gh pr update-branch <url>`.
- **Conflicts:** `findings.ts rework <id> rebase on origin/main and resolve the conflicts`.
- **CI failure that looks unrelated:** rerun it once with `gh run rerun <id> --failed`. If it fails again, compare against `main` and decide.
- **Broad change, or `test:affected` selected everything:** `gh pr edit <url> --add-label full-suite`, and remove the label once you have the result.
- **Two rework rounds already:** decide. Merge it, close it with a reason, or leave it unmerged with a reason.

### 5. Kickoffs

Remove worktrees of findings closed as `not a bug`, `stale` or `duplicate`, and delete their branches. If `sysctl -n kern.memorystatus_vm_pressure_level` prints `4`, memory pressure is critical, so log it and start nothing this tick. Otherwise repeat until `findings.ts assign` says `empty` or `full`:

```sh
findings.ts assign
orca worktree create --name fix-<id> --no-parent --base-branch origin/main --surface terminal --agent omp --json \
  --prompt "<fix prompt>"
```

If the create fails, run `findings.ts release <id>` and log the error. To start omp again in an existing worktree:

```sh
orca agent launch --agent omp --worktree name:fix-<id> --surface terminal --json --prompt "<fix prompt>"
```

The fix prompt is: `Follow docs/qa-loop/FIX.md for finding <id>, as it is on origin/main (read it with git show origin/main:docs/qa-loop/FIX.md after fetching). Nobody is watching: never run orca ask or ask anyone anything.`

### 6. Capacity

If fewer than 5 findings are `todo` and `qa-bg-2` isn't running, start it with the commands below.

### 7. Environment

- `git config --get core.bare` must not be `true`, and `git config --get user.name` must not be `Test`, because a test run damaged the shared config once. Repair them with `git config core.bare false` and by unsetting the bad local identity, and log it.
- Below 20 GiB free in `df -h /`, remove temp homes and test processes this run created, and log what you removed.

### 8. Log

Append what changed to `Q/orchestrator-log.md`: the time, `findings.ts status`, what merged, every decision with its reason, and anything you noticed that's wrong with the process. Skip the entry if nothing changed.

## Starting QA loops

Create a missing worktree with `orca worktree create --name <name> --no-parent --base-branch origin/main`. Then:

```sh
orca loop create --agent claude --worktree name:qa-visual --name "qa 10-31 foreground" --preset until-done --session fresh \
  --check "bun scripts/qa-loop/findings.ts deadline" --max-minutes 1440 --resume-at-reset \
  --protected-path "docs/qa-loop/**" --protected-path "scripts/qa-loop/**" \
  --prompt "Follow docs/qa-loop/QA.md for one iteration, as it is on origin/main (read it with git show origin/main:docs/qa-loop/QA.md after fetching). You are the foreground agent; your name for the log is foreground. Nobody is watching: never run orca ask or ask anyone anything. When findings.ts says deadline, print QA_DONE and end."

orca loop create --agent claude --worktree name:qa-bg-1 --name "qa 10-31 background 1" --preset until-done --session fresh \
  --check "bun scripts/qa-loop/findings.ts deadline" --max-minutes 1440 --resume-at-reset \
  --protected-path "docs/qa-loop/**" --protected-path "scripts/qa-loop/**" \
  --prompt "Follow docs/qa-loop/QA.md for one iteration, as it is on origin/main (read it with git show origin/main:docs/qa-loop/QA.md after fetching). You are a background agent; your name for the log is background-1. Nobody is watching: never run orca ask or ask anyone anything. When findings.ts says deadline, print QA_DONE and end."
```

For `qa-bg-2`, use the background command with `qa-bg-2`, `background 2` and `background-2`.

## Final report

Write `Q/report.md` for someone catching up in the morning, opening with the result. It covers:

- What merged, as a list of PRs and what each fixed.
- Every decision you made on the user's behalf, with your reason, so they can disagree.
- What's left unmerged and why, with the PR and the worktree kept for it.
- Bugs that still reproduce, and findings still queued.
- Process problems the run hit.
