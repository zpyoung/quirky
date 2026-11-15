# Objective runner

The objective runner plans and implements work in registered Git or folder workspaces, verifies worker changes against dispatch-time baselines, runs shell criteria and enrollment gates, applies tiered review, repairs failed plans, and lands verified work at the requested bar.

## Enroll and inspect

```sh
quirky heimdall create objective \
  --objective "Add a multiply function to math.ts" \
  --worktree path:/path/to/repository
```

Use a registered Git worktree, folder project, or group-folder workspace. Folder objectives accept only `files-on-disk` and run at concurrency one, including when creation requests a higher valid cap. Later concurrency raises are refused. `heimdall objective <watcher-id>` and `quirky objective detail --watcher-id <watcher-id>` show the plan, checks, gates, verdicts, territory overruns, Git state, and landing evidence.

## Plans and changes

Approve the planner dispatch, then review and approve its draft plan. Tasks run in plan order. Each worker dispatch durably captures the workspace baseline; pre-existing dirty or untracked files are not blamed on that task. The runner rejects observed changes outside the plan's write territory and observed changes missing from the worker's `filesModified` report. Objective reports are retained under `.quirky/objective/<watcher-id>/`. Git workspaces exclude reports through their private exclude file; folder observation excludes the exact root subtrees `.quirky/objective` and `.orca/heimdall/lease`, plus `.git` entries at any depth. The lease location and shared ownership authority are unchanged.

Index suppression flags do not exempt tracked writes or deletions from these checks, including after a restart or index reload. Only paths genuinely omitted by sparse checkout retain their indexed contents when absent.

Folder baselines hash file bytes, executable status and symlink targets without following links or using Git. Other hidden files, ignored files, dependency directories and sibling `.quirky` content remain observed. Other `.orca` paths, including `.orca/heimdall/lease-other` and nested `src/.orca/heimdall/lease`, remain observed too. Two matching complete observations are required; unreadable, unsupported or unstable trees fail closed. These observations enforce reported changes, not a worker sandbox.

After all active-plan tasks succeed, the runner executes shell-checkable criteria in plan order, then enrollment gates. Check and gate results belong to the exact workspace content identity: a changed tree invalidates old evidence, and a check raced by a workspace edit is discarded.

## Review and repair

The review tier controls post-check work: `express` skips reviewers; `standard` requires a read-only reviewer; `full` requires a reviewer followed by an integrator. Reviewer workspace edits are rejected. Integrators may edit only inside write territory; their edits trigger fresh checks, gates, and review before landing.

Three failed attempts for a task, a failing check or gate, or a blocking verdict can start a repair replan. Repairs preserve succeeded and running tasks: a patch cannot change them. Each revision allows at most three applied repair episodes, with up to three planner attempts per episode; after two unaccepted repair attempts, the next planner dispatch requires approval.

Required checks and reviews must be verified after the latest repair, even when file contents stay unchanged.

Reject an unapproved pending plan draft with:

```sh
quirky objective reject-draft --watcher-id <id> [--digest <digest>] [--reason <text>]
```

The next planner attempt receives the rejection feedback. Three rejected drafts at one stage park the watcher.

## Landing and limits

`files-on-disk` records a verified local landing. `committed-local-branch` additionally commits only changed paths inside write territory, with a `Quirky-Objective-Attempt` trailer; outside-territory dirty and staged files remain untouched. This bar requires an attached branch; a detached `HEAD` waits idle until a branch is checked out.

A committed landing verifies the recorded commit against the reviewed content inside write territory. Suppression flags cannot authorize a no-op that leaves reviewed changes uncommitted; an unverifiable index configuration stops landing.

The `check`, `review`, and `land` capability policies gate required checks, reviews, and landing actions. If a required capability is off, the watcher parks. Reaching the selected bar makes the watcher terminally landed, except that `merged` waits for the pinned sitter to observe a merge.

For Git worktrees, `pushed-ref` additionally verifies the exact published commit. `hosted-review` confirms a matching GitHub review and atomically hands it to a sitter with merge off. `merged` hands off with merge gated, and completion requires that sitter to observe the pinned review merged. Hosted bars require authenticated GitHub resolution. Each external mutation needs its own target-bound approval when `land` is gated; ambiguous outcomes block retries until original-target reads confirm the effect. GitLab hosting is not supported.

Folders never initialize Git or enter commit, push, hosted-review or sitter-handoff paths. Their files-on-disk landing requires the same current-content check and tiered-review evidence as Git workspaces.
