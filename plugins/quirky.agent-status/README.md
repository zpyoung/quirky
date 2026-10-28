# Agent Status: Activity Dashboard

The Dashboard is a view of the durable Activity projection. It does not keep a second agent-status or acknowledgment store.

## Query and CLI

Call `quirky.agent-status/dashboard` with any of:

```json
{
  "text": "release",
  "project": "repo-id-or-name",
  "workspaceStatus": "in-review",
  "reviewStatus": "open",
  "showIdle": false
}
```

`workspaceStatus` accepts `todo`, `in-progress`, `in-review` or `done`. `reviewStatus` accepts `open`, `draft`, `merged`, `closed` or `no-review`. `project` accepts a selector supported by `quirky.worktree/list`. Omitted filters match all Activity threads.

The result contains `cards`, `total`, `hiddenIdle` and `unavailable`. `total` counts matching threads, including idle cards hidden by default. Session-boundary snapshots project to Idle; acknowledging a completed turn never changes its Done bucket. `showIdle: true` reveals idle cards. Review status comes from the public GitHub hosting API; when a lookup fails, `unavailable` names the workspace and `total` counts only known matches, with unknown rows excluded.

The matching CLI command is:

```sh
quirky agent-status dashboard --text release --project repo-id-or-name --workspace-status in-review --review-status open --show-idle --json
```

## Window controls

The public view is `view:quirky.agent-status/dashboard`; its input uses the same filter fields. `command:quirky.agent-status/openDashboard` opens it and `command:quirky.agent-status/toggleDashboard` opens or closes it with the supplied input. The sidebar entry is controlled by `setting:quirky.agent-status/dashboard-enabled` (default `false`).

Cards show the Activity prompt and readable detail. Opening one navigates to the exact live session and worktree, then acknowledges only the displayed Activity turn.

This build supports only the in-window view. `UiPluginContext` provides `openView` but no public pop-out/window-creation capability, so there is no pop-out mode and no `window.open` substitute.
