# Objective runner

The objective runner drafts a plan and implements its tasks one at a time on a Git worktree. It asks for approval before dispatching a planner and again before starting implementation. It does not verify task results, run checks or gates, review changes, or land them; it parks after workers report success for every task.

## Enroll and inspect

```sh
quirky heimdall create objective \
  --objective "Add a multiply function to math.ts" \
  --worktree path:/path/to/repository
```

Use a Git worktree for the objective. `heimdall objective <watcher-id>` shows its draft plan or implementation progress. The generated `quirky objective detail --watcher-id <watcher-id>` command provides the same objective detail.

## Approvals and reports

First approve the planner dispatch. When the planner returns a valid draft, review and approve that plan to activate it. The runner then dispatches one implementer per task, in plan order; the default implementation capability does not require another approval for each task.

Workers write reports to `.quirky/objective/<watcher-id>/<attempt-id>.json` in the selected worktree. The runner adds `/.quirky/objective/` to that repository's private Git exclude file, keeping reports out of `git status` and the workspace content identity.

## Limits

The runner validates report structure but does not verify report claims against changed files. It does not run acceptance criteria or enrollment gates, review the implementation, or land it. After workers report every task as successful, the watcher parks with `verification-unavailable`.
