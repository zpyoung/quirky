# Objective runner

The objective runner plans and implements work in a Git worktree, verifies worker changes against dispatch-time baselines, runs shell criteria and enrollment gates, applies tiered review, repairs failed plans, and lands verified work at a local bar.

## Enroll and inspect

```sh
quirky heimdall create objective \
  --objective "Add a multiply function to math.ts" \
  --worktree path:/path/to/repository
```

Use a Git worktree. `heimdall objective <watcher-id>` and `quirky objective detail --watcher-id <watcher-id>` show the plan, checks, gates, verdicts, territory overruns, Git state, and landing evidence.

## Plans and changes

Approve the planner dispatch, then review and approve its draft plan. Tasks run in plan order. Each worker dispatch captures the workspace baseline; pre-existing dirty or untracked files are not blamed on that task. The runner rejects observed changes outside the plan's write territory and observed changes missing from the worker's `filesModified` report. Objective reports are stored under `.quirky/objective/<watcher-id>/` and excluded through the repository's private Git exclude file.

After all active-plan tasks succeed, the runner executes shell-checkable criteria in plan order, then enrollment gates. Check and gate results belong to the exact workspace content identity: a changed tree invalidates old evidence, and a check raced by a workspace edit is discarded.

## Review and repair

The review tier controls post-check work: `express` skips reviewers; `standard` requires a read-only reviewer; `full` requires a reviewer followed by an integrator. Reviewer workspace edits are rejected. Integrators may edit only inside write territory; their edits trigger fresh checks, gates, and review before landing.

Three failed attempts for a task, a failing check or gate, or a blocking verdict can start a repair replan. Repairs preserve succeeded and running tasks: a patch cannot change them. Each revision allows at most three applied repair episodes, with up to three planner attempts per episode; after two unaccepted repair attempts, the next planner dispatch requires approval.

Reject an unapproved pending plan draft with:

```sh
quirky objective reject-draft --watcher-id <id> [--digest <digest>] [--reason <text>]
```

The next planner attempt receives the rejection feedback. Three rejected drafts at one stage park the watcher.

## Local landing and limits

`files-on-disk` records a verified local landing. `committed-local-branch` additionally commits only changed paths inside write territory, with a `Quirky-Objective-Attempt` trailer; outside-territory dirty and staged files remain untouched. This bar requires an attached branch; a detached `HEAD` waits idle until a branch is checked out.

The `check`, `review`, and `land` capability policies gate required checks, reviews, and landing actions. If a required capability is off, the watcher parks. Reaching the selected local bar makes the watcher terminally landed.

The remote bars `pushed-ref`, `hosted-review`, and `merged` remain unsupported and are refused at enrollment pending a follow-up after g12-5, g12-7, and g12-10.
