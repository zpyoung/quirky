# Worktree controls

Reader: people and scripts managing worktrees — Decision: choose how the sidebar presents work, sleep or wake a safe subtree, or remove reviewed idle worktrees.

## Sidebar options

Options persist in the worktree plugin's SQLite store; no new global setting IDs are used. Defaults are project grouping, recent sorting, manual project order, detailed cards, all available card properties, sleeping worktrees shown, external worktrees hidden globally, and archived worktrees hidden.

- `groupBy`: `project`, `status`, `pr`, or `none`. PR grouping uses the worktree's recorded linked PR; rows without one use a “No pull request” lane. Parent and descendants stay together.
- `sortBy`: `recent`, `agent-activity`, `name`, `project`, or `manual`. Agent activity prioritizes sessions in `waiting` status, then uses persisted activity timestamps. Project sorting uses project name then activity.
- `projectOrderBy`: `manual` or `recent`; manual project order is persisted by `quirky.worktree/reorderProjects({projects:[...]})`.
- `compact`, `showProperties`, and `showSleeping` control card layout, available branch/note/PR/issue/automation/activity properties, and sleeping visibility. Hiding rows leaves a count and a temporary reveal control.
- `hideCliCreated`, `hideDefaultBranch`, `hideDetached`, `hideArchived`, `hideOtherClients`, and `filterRepoIds` filter only worktrees with authoritative local provenance/branch/project data or a caller-relative authenticated creator comparison.
- `hideOtherClients` hides only worktrees proven to come from a different authenticated UI installation. The UI reads its exact installation identity from `ui.window.self`; unknown, paired-phone, plugin and CLI origins remain visible. This UUID identifies an installation, not a machine. Host filters remain unavailable without authoritative host identity.

Read or update options through `quirky.worktree/options({})` and `quirky.worktree/setOptions({...})`. The CLI accepts the same choices, including `quirky worktree options --hide-other-clients` and `--show-other-clients`; `quirky worktree reorder --worktrees '["wt_first","wt_second"]'` still requires every non-primary sibling in that project, parent, and project-group membership.

```sh
quirky worktree options --group-by pr --sort-by agent-activity --project-order-by recent --hide-cli-created
quirky worktree reorder-projects --projects '["repo_web","repo_api"]'
```

## External worktrees and project identity

Only non-primary Git worktrees discovered with `createdBy: "external"` are external. The global default is `hide`; each project's `externalVisibility` may be `show`, `hide`, or `inherit`. Hidden rows remain on disk and in the review inbox. The inbox can show a project's worktrees, keep that project hidden, or suppress its review line without deleting anything.

Use `quirky.worktree/projectMetadata({repo})`, `setProjectMetadata({repo,identity?,externalVisibility?})`, `externalInbox({})`, and `suppressExternalInbox({repo,suppressed})`. Project Settings and `quirky worktree project-set <repo>` use the same owner. Project icons are safe plain-text emoji/symbols; tracker project defaults are saved only after the authenticated hosting provider resolves a credential-free HTTPS project URL. Provider failures do not mutate identity metadata.

## References, statuses, and workspace board

`linkReference({worktree,url,label?})` accepts absolute HTTP or HTTPS references, persists them independently of branch/path, and displays them as text rather than executing them. `references({worktree})` reads them and `unlinkReference({worktree,reference})` removes one by stable ID. The workspace details dialog has the same link/unlink controls.

`statusDefinitions({})` reads the built-ins and custom definitions; `setStatusDefinitions({statuses})` requires the four built-in IDs and refuses to remove a status that a workspace still uses. Status labels, colors and safe text icons persist into the board and status-group lanes. The sidebar's Workspace statuses editor and `quirky worktree status-set --statuses '<json>'` use the same API.

## Navigation and Open in

Opening a card records durable history for that exact kernel UI connection. `navigate({worktree,target?,window?})`, `navigationBack({window?})`, `navigationForward({window?})`, `navigationMove({direction,window?})`, `navigationIndex({index,window?})`, and `openIn({worktree,target,window?})` share one API across the UI and CLI. `window` is a live numeric `connId`, never a native auxiliary ID. Omitted window preserves singleton behavior and refuses when multiple windows are connected. CLI commands `back`, `forward`, `previous`, `next`, `index`, and `open-in` accept `--window <connId>`.

Keyboard controls are Mod+Alt+Left/Right for history, Mod+Shift+Up/Down for previous/next, and Mod+1…9 for index selection. They do not intercept typing in editable fields.

## Reversible sleep and wake

`quirky.worktree/sleepPreview({worktree,withDescendants?,window?})` checks the exact selected subtree and window. For known session/worktree and Git diff views, the owner resolves `input.worktree` selectors and absolute `input.path` values through canonical worktree matching. Sleep closes a uniquely resolved view in the selected subtree with `ui.window.view.close({connId,expectedView})`, passing the inspected view unchanged; a concurrently selected replacement is never closed. Unknown, ambiguous, or malformed workspace owners block sleep before visibility state changes, while unrelated views remain open. Sleep never closes a session, kills a terminal or agent, deletes history, or starts a replacement process; live work continues in the background. Omitted `window` is compatible only with a singleton window; CLI `sleep-preview` and `sleep` accept `--window <connId>`. `wake` restores visibility without starting a process.

```sh
quirky worktree sleep-preview id:wt_parent --with-descendants
quirky worktree sleep id:wt_parent --with-descendants
quirky worktree wake id:wt_parent --with-descendants
```

Sleep state and change timestamps survive daemon restart. Exact `ui.window.state`, `ui.window.view.open`, and compare-and-close routes isolate each live `connId`; stale, missing, or ambiguous identities refuse rather than redirecting another window.

Navigation history and cleanup use the same canonical owner resolution. Each live `connId` keeps history of canonical worktree IDs; unresolved, ambiguous, or malformed workspace views block sleep and cleanup, and only the exact resolved owner receives an active-workspace cleanup blocker. Sleep preserves sessions, PTYs, history, drafts, and buffers.

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

Cleanup evidence includes every live window's exact layout, the terminal owner's durable pane/session bindings, `quirky.session/list`, editor buffers/close requests, sidebar visits, and Git state. Missing or malformed evidence remains a blocker; each evidence snapshot contributes to the fingerprint and is re-read before canonical non-forced removal.

## Evidence limits

Local cleanup context is false for a registered local repo owner only when that repo evidence is present. Remote worktree rows without an authoritative host stamp remain `null` and blocked. Volatile context is derived conservatively from the public terminal workspace plus exact session status: live or unknown context blocks; no screen or missing route is treated as proof of inactivity.
 
## Creation parity limits

Existing create behavior remains the canonical `quirky.worktree/create` service. It keeps GitHub issue/PR drafts, setup and issue-command decisions, issue-command execution, and public `EffectiveHooks.sharedDirectories` carry behavior. This revision extends that create path rather than adding a second one.

The create dialog, API and CLI support sparse paths, safe `keepMain` fast-forwards, and agent model/option choices. Launch picks are checked by the public `quirky.agents/resolveLaunch` owner before a worktree is created, then passed to `quirky.session/create`; a receipt reports materialized sparse paths, successfully linked shared directories, the primary-checkout update outcome, and the session's actual launch settings. Sparse paths are restricted to tracked repository-relative files/directories. `--keep-main` only fast-forwards a clean primary checkout on the exact selected remote-tracking branch when it is strictly behind; it never resets or falls back to a local base.

```sh
quirky worktree create --repo api --name sparse --sparse-paths '["src"]' --keep-main
quirky wt project-set api --shared-directories '[".env.local"]'
```

Project Settings and `quirky wt project-set --shared-directories '[".env.local","config/private"]'` store per-project shared paths. The existing carry owner validates and links those ignored directories together with `EffectiveHooks.sharedDirectories`. Add Project and project Worktree Location expose the public native `desktop.folder.pick` dialog; cancellation keeps the typed draft, and shells without the picker return a conflict instead of imitating it in the browser.

Configured `defaultTabs` are parsed from the selected commit, validated before create, and composed through `quirky.terminal/newTab` with `activate:false`; command text shares setup trust, and exact tab colors are set through the terminal owner. A bounded pool of at most three detached, locked preparations expires after five minutes, is hidden from ordinary worktree lists only while its exact recorded lock identity is intact, and is claimed by canonical create only for an exact repo/base/owner match. `environmentRecipes` still require a real VM runtime and attachment owner; they are refused rather than run as local shell commands. `worktree host-list` reports authenticated peer IDs/revisions/fingerprints. `quirky worktree create --on-runtime runtime:<selector> --repo <remote-repo> <name>` calls `quirky.worktree/create` through `quirky.cli/runtimeCall` on a saved owner-cli target and returns its exact runtime identity and remote create result. It does not create a local mirror or activate a remote path in the local UI. Unknown and phone-scoped targets fail without local fallback; default-tab and trust choices still pass through the canonical create pipeline on the selected runtime.

Desktop creator IDs are stored only from an authenticated `role:ui` hello and compared caller-relatively through `quirky.worktree/origins`; the public projection never returns those IDs. A valid ID from the exact `ui.window.self` connection is an installation UUID, not hardware or an OS account. Identityless UI, phone, plugin, owner-CLI, legacy and external origins remain unknown for desktop comparison; a socket or window connection ID is never a creator identity.
## Issue-derived startup prompts

Creating a GitHub issue worktree with an agent passes the raw issue URL through `quirky.worktree/create` to the public `quirky.session/create` API. That issue-derived prompt is left as a draft by default. `submitPrompt` can explicitly override the default; generic user-written prompts retain the session API's existing submitted default.

```sh
quirky worktree create --repo api --github '#4' --agent claude --draft-prompt
quirky worktree create --repo api --github '#4' --agent claude --submit-prompt
```
