# Worktree controls

Reader: people and scripts managing worktrees — Decision: choose how the sidebar presents work, sleep or wake a safe subtree, or remove reviewed idle worktrees.

## Sidebar options

Options persist in the worktree plugin's SQLite store; no new global setting IDs are used. Defaults are project grouping, recent sorting, manual project order, detailed cards, all available card properties, sleeping worktrees shown, external worktrees hidden globally, and archived worktrees hidden.

- `groupBy`: `project`, `status`, `pr`, or `none`. PR grouping uses the worktree's recorded linked PR; rows without one use a “No pull request” lane. Parent and descendants stay together.
- `sortBy`: `recent`, `agent-activity`, `name`, `project`, or `manual`. Agent activity prioritizes sessions in `waiting` status, then uses persisted activity timestamps. Project sorting uses project name then activity.
- `projectOrderBy`: `manual` or `recent`; manual project order is persisted by `quirky.worktree/reorderProjects({projects:[...]})`.
- `compact`, `showProperties`, and `showSleeping` control card layout, available branch/note/PR/issue/automation/activity properties, and sleeping visibility. Hiding rows leaves a count and a temporary reveal control.
- `hideCliCreated`, `hideDefaultBranch`, `hideDetached`, `hideArchived`, and `filterRepoIds` filter only worktrees with authoritative local provenance/branch/project data.
- Desktop host and other-client filters are not offered: `Repo`/`Worktree` do not provide authoritative host or stable desktop-client identity. The separate `origins` API supplies immutable automation evidence and paired-device-relative other-client evidence; desktop callers receive unknown rather than an invented client identity.

Read or update options through `quirky.worktree/options({})` and `quirky.worktree/setOptions({...})`. The CLI accepts the same choices; `quirky worktree reorder --worktrees '["wt_first","wt_second"]'` still requires every non-primary sibling in that project, parent, and project-group membership.

```sh
quirky worktree options --group-by pr --sort-by agent-activity --project-order-by recent --hide-cli-created
quirky worktree reorder-projects --projects '["repo_web","repo_api"]'
```

## External worktrees and project identity

Only non-primary Git worktrees discovered with `createdBy: "external"` are external. The global default is `hide`; each project's `externalVisibility` may be `show`, `hide`, or `inherit`. Hidden rows remain on disk and in the review inbox. The inbox can show a project's worktrees, keep that project hidden, or suppress its review line without deleting anything.

Use `quirky.worktree/projectMetadata({repo})`, `setProjectMetadata({repo,identity?,externalVisibility?})`, `externalInbox({})`, and `suppressExternalInbox({repo,suppressed})`. `quirky worktree project-show <repo>` and `project-set <repo> --external-worktree-visibility show|hide|inherit` share those methods. Project icon, color, tracker key, and display name are stored under the owning project authority; the checkout path and branch are unchanged.

## References, statuses, and workspace board

`linkReference({worktree,url,label?})` accepts absolute HTTP or HTTPS references, persists them independently of branch/path, and displays them as text rather than executing them. `references({worktree})` reads them and `unlinkReference({worktree,reference})` removes one by stable ID. The workspace details dialog has the same link/unlink controls.

`statusDefinitions({})` reads the built-ins and custom definitions; `setStatusDefinitions({statuses})` requires the four built-in IDs and refuses to remove a status that a workspace still uses. The sidebar's Workspace board and status-group lanes use those persisted labels and colors. `quirky worktree status-list` and `status-set --statuses '<json>'` are the scriptable forms.

## Navigation and Open in

Opening a card records durable worktree history. `navigate({worktree,target?})`, `navigationBack({})`, `navigationForward({})`, `navigationMove({direction})`, `navigationIndex({index})`, and `openIn({worktree,target})` are the common API behind card clicks, the workspace menu, and CLI commands `back`, `forward`, `previous`, `next`, `index`, and `open-in`. Supported targets are the existing terminal workspace view and the public Git changes view. Stale history entries are skipped; when multiple windows are connected, navigation refuses because the public API cannot target one window exactly.

Keyboard controls are Mod+Alt+Left/Right for history, Mod+Shift+Up/Down for previous/next, and Mod+1…9 for index selection. They do not intercept typing in editable fields.

## Reversible sleep and wake

`quirky.worktree/sleepPreview({worktree,withDescendants?})` checks the exact selected subtree and whether its active workspace view can be closed without affecting an unrelated window. `sleep` closes that exact view through public `ui.view.close` when a single-window layout identifies it, then persists visibility metadata. It never closes a session, kills a terminal or agent, deletes history, or starts a replacement process; live work continues in the background. When multiple windows or unreadable UI state make the target view ambiguous, sleep refuses with an explicit UI-lifecycle blocker. `wake` restores visibility without starting a process. Clicking a sleeping card wakes it before opening its session view.

```sh
quirky worktree sleep-preview id:wt_parent --with-descendants
quirky worktree sleep id:wt_parent --with-descendants
quirky worktree wake id:wt_parent --with-descendants
```

Sleep state and change timestamps survive daemon restart. The public UI API does not expose independent per-window layouts or close routes, so the plugin refuses ambiguous multi-window view closure rather than redirecting unrelated windows.

## Cleanup preview and removal

`quirky.worktree/cleanupPreview({})` includes 30-day idle candidates (`idle-clean`) and worktrees explicitly archived for at least seven days (`archived-7day`). Both carry a current safety fingerprint and readable blockers. `archive({worktree,archivedAt?})` and `quirky worktree archive <worktree> [--off]` set or clear archived metadata; changing that timestamp invalidates an older preview fingerprint. `cleanupIgnore({worktreeId,fingerprint})` ignores only the matching suggestion; `cleanupRestoreIgnored({})` restores ignored suggestions.

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

The plugin now owns the archived timestamp, but neither public `Repo` nor `Worktree` provides host connectivity or generic volatile-local-context evidence. `cleanupContext.volatile` and `cleanupContext.remoteConnected` therefore remain `null`; the classifier does not invent remote-disconnected or volatile-context blockers, and unknown runtime evidence never proves process death. Cleanup still rechecks current evidence through canonical non-forced removal.
 
## Creation parity limits

Existing create behavior remains the canonical `quirky.worktree/create` service. It keeps GitHub issue/PR drafts, setup and issue-command decisions, issue-command execution, and public `EffectiveHooks.sharedDirectories` carry behavior. This revision extends that create path rather than adding a second one.

The create dialog, API and CLI support sparse paths, safe `keepMain` fast-forwards, and agent model/option choices. Launch picks are checked by the public `quirky.agents/resolveLaunch` owner before a worktree is created, then passed to `quirky.session/create`; a receipt reports materialized sparse paths, successfully linked shared directories, the primary-checkout update outcome, and the session's actual launch settings. Sparse paths are restricted to tracked repository-relative files/directories. `--keep-main` only fast-forwards a clean primary checkout on the exact selected remote-tracking branch when it is strictly behind; it never resets or falls back to a local base.

```sh
quirky worktree create --repo api --name sparse --sparse-paths '["src"]' --keep-main
quirky wt project-set api --shared-directories '[".env.local"]'
```

Project Settings and `quirky wt project-set --shared-directories '[".env.local","config/private"]'` store per-project shared paths. The existing carry owner validates and links those ignored directories together with `EffectiveHooks.sharedDirectories`. Add Project and project Worktree Location expose the public native `desktop.folder.pick` dialog; cancellation keeps the typed draft, and shells without the picker return a conflict instead of imitating it in the browser.

Default tabs and environment recipes remain unsupported by the current public owners (`quirky.repo/hooks` reports both); create API/CLI requests are explicitly refused before creating a worktree. A prepared-checkout pool and host runs remain separate flows and are not represented by local clones or fallback execution.

Paired-phone origin filters have their own authoritative producer and consumer. They do not establish desktop-client or host identity for this sidebar. Generic per-window workspace layouts/close routes remain unavailable; sleep and navigation refuse ambiguous multiple-window routing rather than affecting an unrelated window.
## Issue-derived startup prompts

Creating a GitHub issue worktree with an agent passes the raw issue URL through `quirky.worktree/create` to the public `quirky.session/create` API. That issue-derived prompt is left as a draft by default. `submitPrompt` can explicitly override the default; generic user-written prompts retain the session API's existing submitted default.

```sh
quirky worktree create --repo api --github '#4' --agent claude --draft-prompt
quirky worktree create --repo api --github '#4' --agent claude --submit-prompt
```
