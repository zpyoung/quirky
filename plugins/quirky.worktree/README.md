# Worktree controls

Reader: people and scripts managing worktrees — Decision: choose how the sidebar presents work, sleep or wake a safe subtree, or remove reviewed idle worktrees.

## Sidebar options

Options are persisted in the worktree plugin's SQLite store; no new global setting IDs are used. Defaults are project grouping, recent sort, detailed cards, branch and comment properties shown, and sleeping worktrees visible.

- `groupBy`: `project`, `status`, or `none`. Project-group nesting and the Pinned section remain intact for every choice. Status groups keep each parent and its descendants together.
- `sortBy`: `recent`, `name`, or `manual`. Manual order can be changed by dragging sibling cards or with `quirky.worktree/reorder({worktrees:[...]})`; the list must contain every non-primary sibling in that project, parent and project-group membership.
- `compact`, `showBranch`, `showComment`, and `showSleeping` control card layout and properties. Hiding sleeping worktrees shows a count and a reveal control. The existing sidebar-extras activity and review preferences remain unchanged; their own hidden counts and reveal controls remain authoritative.

Read or update options through `quirky.worktree/options({})` and `quirky.worktree/setOptions({groupBy?,sortBy?,compact?,showBranch?,showComment?,showSleeping?})`. For example:

```sh
quirky worktree options --group-by status --sort-by manual --compact --hide-sleeping
quirky worktree reorder --worktrees '["wt_first", "wt_second"]'
```

## Reversible sleep and wake

`quirky.worktree/sleepPreview({worktree,withDescendants?})` checks the exact selected subtree and whether its active workspace view can be closed without affecting an unrelated window. `sleep` closes that exact view through public `ui.view.close` when a single-window layout identifies it, then persists visibility metadata. It never closes a session, kills a terminal or agent, deletes history, or starts a replacement process; live work continues in the background. When multiple windows or unreadable UI state make the target view ambiguous, sleep refuses with an explicit UI-lifecycle blocker. `wake` restores visibility without starting a process. Clicking a sleeping card wakes it before opening its session view.

```sh
quirky worktree sleep-preview id:wt_parent --with-descendants
quirky worktree sleep id:wt_parent --with-descendants
quirky worktree wake id:wt_parent --with-descendants
```

Sleep state and change timestamps survive daemon restart. The public UI API does not expose independent per-window layouts or close routes, so the plugin refuses ambiguous multi-window view closure rather than redirecting unrelated windows.

## Cleanup preview and removal

`quirky.worktree/cleanupPreview({})` lists worktrees idle for at least 30 days with a safety fingerprint, eligibility, and readable blocker details. Fingerprints are a current preview, not a durable deletion permit. `cleanupIgnore({worktreeId,fingerprint})` ignores only the matching suggestion; `cleanupRestoreIgnored({})` restores ignored suggestions.

A bulk request must name the exact selected fingerprints and set `confirmed:true`. The method is kernel-destructive: callers must also use `yes:true` or an answered confirmation. The UI asks for confirmation; the CLI requires `--confirm` for the reviewed selection and still honors global `--yes` or the normal ask flow.

```sh
quirky worktree cleanup-preview --json
quirky worktree cleanup-ignore wt_id --fingerprint 64-hex-fingerprint
quirky worktree cleanup-restore
quirky worktree cleanup-remove --selection '[{"worktreeId":"wt_id","fingerprint":"64-hex-fingerprint"}]' --confirm --yes
```

Every selected row is re-previewed immediately before canonical, non-forced removal. The operation never bypasses archive hooks, Git locks, dirty checks, branch preservation, or runtime-liveness checks. It reports each row independently; one refusal does not mark other rows successful.

The public evidence supports blockers for primary and folder workspaces, pins, active and recently visible workspaces, live terminals and agents, unknown runtime liveness, dirty editor buffers, Git registration/status errors and locks, dirty files, unpushed commits, unknown bases, descendants, and dismissed suggestions. Missing required session, editor, UI or sidebar-visit evidence remains an explicit unknown/error blocker.

## Evidence limits

The current public `Repo` and `Worktree` contracts do not expose host connectivity, an archived flag, or a generic volatile-local-context classification. The preview therefore does not invent `ssh-disconnected`, `archived` (the source's 7-day archived reason), or a generic `volatile-local-context` result. It offers the supported 30-day idle-clean path, reports concrete public session/editor/Git/UI risks, and fails closed when a required evidence API is unavailable. It cannot distinguish a remote-host failure from another Git status error without public host identity.

## Issue-derived startup prompts

Creating a GitHub issue worktree with an agent passes the raw issue URL through `quirky.worktree/create` to the public `quirky.session/create` API. That issue-derived prompt is left as a draft by default. `submitPrompt` can explicitly override the default; generic user-written prompts retain the session API's existing submitted default.

```sh
quirky worktree create --repo api --github '#4' --agent claude --draft-prompt
quirky worktree create --repo api --github '#4' --agent claude --submit-prompt
```
