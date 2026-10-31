# Worktree controls

Reader: people and scripts managing worktrees — Decision: choose how the sidebar presents work, sleep or wake a safe subtree, or remove reviewed idle worktrees.

## Sidebar options

Worktrees is the host-managed tool in the left-top slot by default. Add project is a folder-plus
button in its panel header. Workspace options, Activity filters and More workspace tools stay inside
the header's options popover; the latter includes the board and status editor. Project management uses the existing `quirky.repo` API, not a second tool.
Rows show name plus activity, with selected branch/note/status metadata on the secondary line
and full text available on hover. The activity indicator's accessible name follows its displayed
activity; pending questions retain attention priority. Attention counts and contextual actions remain
independently clickable. Controls, menus, dialogs and both appearances use the shared graphite system.
Project Actions menus take keyboard focus when opened and close on Escape, including when the click
also activates the Worktrees panel.

Closing Rename or the Delete Workspace confirmation returns keyboard focus to that worktree's
Actions button while its row remains visible, including after a display-name change.

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

`statusDefinitions({})` reads the built-ins and custom definitions; `setStatusDefinitions({statuses})` requires the four built-in IDs and refuses to remove a status that a workspace still uses. Status labels, color metadata and safe text icons persist. The board and status-group lanes use shared semantic colors rather than arbitrary stored paint. More workspace tools opens the Workspace statuses editor; `quirky worktree status-set --statuses '<json>'` uses the same API.

## Navigation and Open in

Opening a card records durable history for that exact kernel UI connection. `navigate({worktree,target?,window?})`, `navigationBack({window?})`, `navigationForward({window?})`, `navigationMove({direction,window?})`, `navigationIndex({index,window?})`, and `openIn({worktree,target,window?})` share one API across the UI and CLI. `window` is a live numeric `connId`, never a native auxiliary ID. Omitted window preserves singleton behavior and refuses when multiple windows are connected. CLI commands `back`, `forward`, `previous`, `next`, `index`, and `open-in` accept `--window <connId>`.

Keyboard controls are Mod+Alt+Left/Right for history, Mod+Shift+Up/Down for previous/next, and Mod+1…9 for index selection. They do not intercept typing in editable fields.

## Reversible sleep and wake

`quirky.worktree/sleepPreview({worktree,withDescendants?,window?})` checks the target subtree and selected window. For session/worktree and Git diff views, it resolves `input.worktree` selectors and absolute `input.path` values through canonical worktree matching. Unknown, ambiguous, or malformed workspace owners block sleep before sleep state changes; unrelated views do not.

Sleep keeps the window layout unchanged, including the active view, exact input, selected worktree, and open-view tabs. For `view:quirky.session/worktree` and `view:quirky.git/diff` with a canonical worktree ID in `input.worktree`, the center shows a sleeping placeholder while its contribution stays mounted but hidden. Selector aliases and path-only inputs do not show the placeholder, so their view content remains visible. Menus owned by the sleeping view close while it is hidden; unrelated views and the row menu for Wake remain available.

Sleep does not close sessions, stop terminals or agents, delete history, or start replacement processes; live work continues in the background. Wake reveals the existing contribution without replaying its input or starting a process. CLI `sleep-preview` and `sleep` accept `--window <connId>`.

Sleeping rows lead with “Sleeping” instead of live session activity, even when activity is hidden. Their activity indicator stays idle and shows no progress; pending questions still keep their attention indicator. Wake restores the live session activity.

```sh
quirky worktree sleep-preview id:wt_parent --with-descendants
quirky worktree sleep id:wt_parent --with-descendants
quirky worktree wake id:wt_parent --with-descendants
```

Sleep state and change timestamps survive daemon restart. An explicit `window` targets that live `connId`; omitting `window` refuses an ambiguous multiwindow selection, and stale or missing identities refuse rather than redirecting another window.

Navigation history and cleanup use the same canonical owner resolution. Each live `connId` keeps history of canonical worktree IDs; unresolved, ambiguous, or malformed workspace views block sleep and cleanup, and only the exact resolved owner receives an active-workspace cleanup blocker. Sleep preserves sessions, PTYs, history, drafts, and buffers.

## Project ownership and removal

`quirky.worktree/ownedIds({repo})` returns the project's primary, currently listed, and durably recorded worktree IDs. Recorded IDs remain available when Git can no longer list a checkout, so project removal can still find its sessions. Removing a project forgets metadata rather than deleting its folders; ledger removal previews retain revision-guarded records for detachment and later recovery.

The Delete Workspace confirmation initially focuses Cancel, so Return dismisses it without deleting anything. To delete the workspace, explicitly choose Delete Workspace.

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

Plain text entered in Smart mode becomes the default display label; the worktree folder and default branch still use the sanitized name. An Advanced display name overrides it. Linked GitHub sources keep their title by default, and blank names leave the generated suggestion as a placeholder.

The create dialog, API and CLI support sparse paths, safe `keepMain` fast-forwards, and agent model/option choices. Launch picks are checked by the public `quirky.agents/resolveLaunch` owner before a worktree is created, then passed to `quirky.session/create`; a receipt reports materialized sparse paths, successfully linked shared directories, the primary-checkout update outcome, and the session's actual launch settings. Sparse paths are restricted to tracked repository-relative files/directories. `--keep-main` only fast-forwards a clean primary checkout on the exact selected remote-tracking branch when it is strictly behind; it never resets or falls back to a local base.

```sh
quirky worktree create --repo api --name sparse --sparse-paths '["src"]' --keep-main
quirky wt project-set api --shared-directories '[".env.local"]'
```

Project Settings and `quirky wt project-set --shared-directories '[".env.local","config/private"]'` store per-project shared paths. The existing carry owner validates and links those ignored directories together with `EffectiveHooks.sharedDirectories`. Add Project and project Worktree Location expose the public native `desktop.folder.pick` dialog; cancellation keeps the typed draft, and shells without the picker return a conflict instead of imitating it in the browser.

Configured `defaultTabs` are parsed from the selected commit, validated before create, and composed through `quirky.terminal/newTab` with `activate:false`; command text shares setup trust, and exact tab colors are set through the terminal owner. A bounded pool of at most three detached, locked preparations expires after five minutes, is hidden from ordinary worktree lists only while its exact recorded lock identity is intact, and is claimed by canonical create only for an exact repo/base/owner match. VM recipes use the Lima lifecycle and guest attachment owner described below, never ordinary shell tabs. `worktree host-list` still reports authenticated federation peers, not owner-grant registrations. `quirky worktree create --on-runtime runtime:<selector> --repo <remote-repo> <name>` creates only on that saved owner runtime and returns its exact identity and result; it does not implicitly attach a local mirror or activate a remote path locally. Unknown and phone-scoped targets fail without local fallback.

Desktop creator IDs are stored only from an authenticated `role:ui` hello and compared caller-relatively through `quirky.worktree/origins`; the public projection never returns those IDs. A valid ID from the exact `ui.window.self` connection is an installation UUID, not hardware or an OS account. Identityless UI, phone, plugin, owner-CLI, legacy and external origins remain unknown for desktop comparison; a socket or window connection ID is never a creator identity.

## Registered remote owner workspaces

Register a saved **owner-cli** target, then refresh its actual workspaces. The Remote workspaces sidebar exposes the same registration, explicit replacement, refresh and exact-window navigation flow.

Open Remote workspaces from its server icon in the tool rail. Its padded panel uses the shared form controls for saved-runtime registration, owner replacement, refresh and workspace navigation, including connected and unavailable host states.

```sh
quirky worktree remote-host-add <saved-target-id>
quirky worktree remote-refresh <registered-host-id>
quirky worktree remote-list --host <registered-host-id> --json
quirky worktree remote-open <mirror-id> --window <conn-id>
quirky worktree remote-call <mirror-id> --operation changes
```

`quirky.cli/hostIdentity` issues a persisted host UUID and a fresh activation generation. `quirky.cli/runtimeCall` optionally accepts `expectedRuntime:{id,endpoint,grantId}` and `expectedHost:{hostId,generation}`. It checks the saved credential pin before connecting, then checks host identity on the same authenticated connection before forwarding. Registered workspace operations always supply both pins; a label, UI installation UUID or path cannot substitute for either.

Host registrations and mirror snapshots survive local restarts. `remoteHostList`/`remoteHostStatus` probe connectivity, while `remoteList` retains snapshots, including unavailable ones. A remote restart, changed grant, revoked credential or replaced workspace instance invalidates old selections. Explicit `remote-host-add <target> --replace` accepts the current authenticated registration; refresh produces current instance-bound mirrors. The sidebar also supports replacing a registration with a different saved target. Unknown state never means inactive or safe.

The remote-specific view reads owner-fenced changes/diffs, sessions and terminal screens; shell creation/input stays on the selected owner and exact workspace. `remoteCall` accepts only its fixed operation set and rejects foreign sessions, arbitrary method overrides and unsafe paths. Remote paths are displayed as owner data, never inserted into local worktree rows or opened as local folders.

Direct removal uses the current mirror fingerprint and canonical non-forced, safe-only removal with a final filesystem-instance check. Cleanup uses the separate live canonical cleanup fingerprint and its eligibility/blockers:

```sh
quirky worktree remote-remove <mirror-id> --fingerprint <mirror-fingerprint> --confirm --yes
quirky worktree remote-cleanup-preview <mirror-id> --json
quirky worktree remote-cleanup-remove <mirror-id> --fingerprint <cleanup-fingerprint> --confirm --yes
quirky worktree remote-host-forget <host-id> --detach --confirm --yes
```

Confirmed source deletion forwards that consent to the owner rather than opening a second hidden ask. Lost or unverified outcomes are not replayed. Host forget/detach removes local registration and mirror rows only; it does not delete remote workspaces or shared saved credentials.

## Trusted Lima environment recipes

Prerequisites: macOS, a genuine Lima installation (`limactl` on `PATH`, or absolute `QUIRKY_LIMACTL`), repository `environmentRecipes`, and recipe scripts that provision a guest with the `quirky` CLI and a reachable owner-cli daemon. Quirky does not install Lima or replace the guest with a local shell. VM environments is available from the remote sidebar and the New workspace dialog's recipe area.

```sh
quirky worktree vm-doctor --json
quirky worktree vm-recipes <project> --json
quirky worktree vm-create <project> <recipe-id> --trust-hash <reviewed-sha256>
quirky worktree vm-list --json
quirky worktree vm-show <vm-id> --json
quirky worktree vm-suspend <vm-id> --instance <instance-id>
quirky worktree vm-resume <vm-id> --instance <instance-id>
quirky worktree vm-destroy <vm-id> --instance <instance-id> --yes
```

Consent hashes the normalized recipe ID, name, description, checkout mode and every lifecycle command/disable flag. The UI shows the commands and exact hash before one-shot approval. Existing VM records retain their immutable approved snapshot. Scripts run with user privileges, not in a sandbox.

Lifecycle command search prepends the verified Lima executable's directory without adding an implicit working-directory entry when inherited `PATH` is absent or empty. Existing nonempty `PATH` entries remain the host's policy; this is not a sandbox. Use an explicit `./...` command when a trusted recipe intentionally executes a project file.

Create scripts run from the local project directory and receive `QUIRKY_VM_NAME`, `QUIRKY_VM_OPERATION_ID` and `QUIRKY_VM_OUTPUT_PATH`; the output path is a pre-created private mode-0600 file. Additional recipe/repo metadata and the selected Lima executable are provided in the environment. Write at most 16 KiB of JSON, with no extra keys:

- `checkoutMode: provisioned-root`: `{"pairingCode":"<guest owner offer>","workspaceSelector":"<exact guest worktree ID>"}`
- `checkoutMode: orca-worktree`: `{"pairingCode":"<guest owner offer>","repo":"<guest project selector>","name":"<guest worktree name>"}`

The service verifies Lima's actual instance directory identity and compares `quirky api call quirky.cli/hostIdentity --json` inside the guest with the authenticated saved endpoint. Only then does it attach the existing guest workspace or perform canonical guest creation. Credentials and script stdout are not public receipts. `worktree create --environment-recipe <id> --trust-environment-recipe-hash <hash>` uses this same owner; supported ordinary create choices pass to the guest in `orca-worktree` mode. `provisioned-root` refuses choices it cannot honor instead of ignoring them.

Suspend/resume/destroy run only configured commands and verify the resulting backend state. A stopped Lima guest is powered off, not a RAM-preserving pause. Lifecycle requests require the observed instance fence; a same-name replacement with a different backend directory identity refuses before scripts. Active create operations cannot be suspended, resumed or destroyed concurrently. Resume reauthenticates the current guest generation and reattaches the original workspace instance; historical mirror IDs or a detached local mirror registry do not authorize or prevent that fresh attachment. Failed records retain historical evidence, not a current connection guarantee. Destroy retires attachments and the exact saved target created by this VM only after backend absence is proved; unrelated credentials remain.

Provisioning can outlast a normal request timeout. Inspect the existing durable record with `vm-list`/`vm-show`; a new create is a different VM, not a retry. Failed/interrupted records keep their backend and attachment evidence. Unverified backend instances or uncertain guest-create outcomes refuse replay; explicit resume/reconciliation and destroy retain those safety checks.

VM subprocess groups and prepared-checkout resources belong to one plugin activation. Stopping or replacing another daemon's activation cannot dispose this activation's resources.

## Issue-derived startup prompts

Creating a GitHub issue worktree with an agent passes the raw issue URL through `quirky.worktree/create` to the public `quirky.session/create` API. That issue-derived prompt is left as a draft by default. `submitPrompt` can explicitly override the default; generic user-written prompts retain the session API's existing submitted default.

```sh
quirky worktree create --repo api --github '#4' --agent claude --draft-prompt
quirky worktree create --repo api --github '#4' --agent claude --submit-prompt
```
