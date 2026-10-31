# Quirky

Quirky is a memory-efficient rewrite of [Orca](https://github.com/zpyoung/orca) for running coding
agents in git worktrees. Quirky runs on macOS: you add repos, create worktrees, run shells and agents
in terminals that survive closing the app, see which agents are working, waiting or done, review
and commit diffs, answer `quirky ask` questions, and run background Claude and Codex sessions
without a terminal, with shared local checks. The measured v1 daemon and PTY host together used about 43 MB with eight busy terminals
(`research/memory-probe/quirky-v1-daemon.md`).

## Try it

```sh
bun install
bun run build
open apps/desktop/build/Quirky.app
```

The app starts the daemon, which keeps running after you close the window. To try it without
touching your real state, run `open -n --env QUIRKY_HOME=/tmp/qtest apps/desktop/build/Quirky.app`.
[apps/desktop/README.md](apps/desktop/README.md) covers installing to `~/Applications`, dev mode,
logs and cleanup.

Inside any Quirky terminal, the `quirky` command is on PATH: try `quirky status` or `quirky help`.

## Phone companion

`apps/mobile` contains the Expo companion for direct LAN or tailnet connections. It pairs with
`quirky mobile pair --address <reachable-desktop-address>` by scanning the QR, opening the
`quirky://pair` link, or pasting the code. Pairing pins the desktop key; bearer credentials stay
in the phone's secure store. No relay or cloud account is used.

Build the desktop normally to include its verified workspace/session page bundle. For an iOS
development build, run `bun run --filter '@quirky/mobile' ios` with Xcode configured. The custom
page-origin module requires a native development build, not Expo Go. To check the portable
client and page code, use `bun run typecheck:mobile` and `bun run build:mobile-pages`.

The companion opens workspaces, drives terminal sessions under an explicit input lease, and
answers agent questions. Workspace **Sleep** parks its views without stopping processes;
opening it wakes those views. **Stop sessions (retain history)** is a separate, explicit operation
that preserves PTY history and supported agents' resume identities. Unknown workspace origins
remain visible under automation/other-client filters. Markdown tabs use the actual editor
document and tab identity, with revision-guarded edits and saves. Markdown tabs remain available
when the optional Browser plugin is absent or disabled.

Workspace cards count the Terminal layout's current tabs, including Browser and Markdown;
split panes, background sessions and closed history do not add tabs. Unavailable counts are
omitted rather than inferred from session records. The same count-only batch is available with
`quirky terminal tab counts --json` or `quirky.terminal/tabCounts`; it exposes no tab contents.

Terminal links default to the phone's external browser. **Settings → Terminal links → Desktop
Chrome Watch** instead opens the URL in a new explicit Watch tab. It does not convert Native tabs
or silently fall back when Watch creation fails. Leaving or rebinding a page releases that
page's terminal and Watch stream leases without closing the shared phone connection or stopping
terminal processes.

**Browser (Chrome Watch)** is explicit opt-in, with a connection-owned stream and typed controls;
selecting an existing Native tab never converts it silently. Watch accepts typed character/key
events with optional key codes and up to 64 KiB of UTF-8 text. Interactive native chat, dictation,
and Native browser mirroring still need their recorded architecture or host prerequisites.
Signed distribution is tracked separately. Actual camera, secure-store,
WebView and keyboard checks remain in the [base native handoff](docs/loop/native/sb-mobile-app.json)
and [workspace/tab handoff](docs/loop/native/sb-mobile-app-prerequisites.json).

## Owner CLI access to another runtime

An **owner CLI grant gives full daemon access**, unlike the narrower phone companion grant.
Create it on the target runtime only for a client you trust with the same access as your local
CLI. It uses the existing pinned-key E2EE listener; no relay or second transport is required.

```sh
quirky mobile owner-pair --name 'My remote CLI' --address <reachable-address> --confirm --json
quirky cli runtime add --name remote --code '<offer from owner-pair>' --json
quirky --runtime remote api --json
quirky cli runtime call --target remote --method quirky.mobile/state --arguments '{}' --json
quirky --pairing-code '<offer from owner-pair>' mobile state --json
quirky mobile owner-grants --json
quirky mobile owner-revoke '<grant id>' --confirm --json
```

The offer is a secret. Save it only in the private runtime registry or another secure store;
grant and saved-runtime listings omit credentials. Revoking a grant closes its live connections
and rejects future calls. A phone offer cannot grant owner access, even if its client changes
the offer's scope or claims another role.

An explicit saved runtime or one-off pairing code never falls back to the local daemon.
`quirky.cli/runtimeCall` lets a local plugin call an exact saved **owner** target and returns
the safe runtime identity with the remote result. A disconnected mutation is not automatically
replayed when its outcome is uncertain. Existing saved phone targets keep phone authorization.

Workspace navigation and Sleep resolve `id:`, `name:`, `branch:` and absolute `path:` selectors
to their actual workspace owner before changing lifecycle state. Unknown or ambiguous workspace
views refuse the operation. Exact-window routing and compare-and-close preserve other windows
and a view selected concurrently.

The first-party UI stores a durable installation UUID and binds it to its authenticated connection.
It is not a machine or OS identity. Clearing browser storage creates a new installation identity;
old workspace origins remain unchanged, and absent origin evidence stays unknown.

### Owner-bound session features

Register a saved full-owner runtime through `quirky.worktree/remoteHostRegister` and attach its
workspaces through `quirky.worktree/remoteAttach`. Session features use those registrations,
the saved grant and host generation; workspace actions also bind the producer's filesystem
instance. Remote paths and matching local names never supply execution authority.

**Usage and AI Provider Accounts** follow the focused workspace's owner in each window.
Opening settings preserves that window's last workspace owner. An unavailable remote owner
does not show local account data instead. Browser sign-in and reauthentication stay local;
presentation preferences remain on this desktop. The fixed-operation API is
`quirky.accounts/ownerCall`; its CLI is `quirky accounts owner-call --owner '<OwnerSessionHostRef JSON>'
--operation list --operation-params '{}' --json`.

**Agent Session History** has a built-in provider for registered owners. Select `local`, `all`
or a registered host ID with `--host`; enabling on all computers runs locally first and reports
each remote outcome. Remote inspection withholds transcript paths and launch environments.
Resume uses `quirky vault resume '<session id>' --remote '<OwnerSessionWorkspaceRef JSON>'`,
exclusive with local worktree/group options. Remote Trash, system-open/reveal and copy-command
actions do not fall back to this computer.

**Handoff** includes registered remote workspace candidates, exact-target agent detection and
transcript probes, reviewed brief delivery, and host-qualified lineage. Query a captured target
with `quirky handoff target agents --remote '<OwnerSessionWorkspaceRef JSON>' --json`.
Remote history opens the review dialog in this desktop; it does not invoke a remote headless
window. Cross-host secret warnings remain review aids, not a security boundary.

The reference shapes are exported from
[`runtime-owner.ts`](packages/protocol/src/runtime-owner.ts). Current acceptance results and
the operator-directed repair item are recorded in the
[owner-feature decision log](docs/loop/decisions/m7-session-extras-owner-host-flows.md#d10-apply-the-operators-build-first-land-gate).


## Agent Session History

Open **Agent Session History** to browse agent-owned transcripts and resume a session in a
terminal. Workspace/Project filters follow the current context; select **All** to browse other
directories. Resume uses the agent's configured command and the transcript's original directory.
When the Accounts plugin is active, required account preparation must succeed before resume.
Explicit launch-home overrides keep their precedence; preparation failure does not start a process.

Transcript search is **off until explicitly enabled**. Before consent, the search box filters
titles only. Enabling stores a local searchable copy of unredacted conversations and up to 3,072
characters per tool result; authenticated clients can search that copy. Disable retains it.
**Clear search data** disables search and removes only the derived index, not original transcripts.

Vault owns the **Search every agent session** tip. A successful local enable marks it seen;
disable, clear and restart preserve that state. The tip never grants consent: when search is
off, the full disclosure and explicit **Enable** control remain available. Read the canonical
state with `quirky vault search-tip --json` or `quirky.vault/getSearchTip`.

The same core flows are scriptable:

```sh
quirky vault list --unlimited --json
quirky vault search --index-status --json
quirky vault search-tip --json
quirky vault enable
quirky vault search 'remembered words' --fresh --json
quirky vault resume '<id from list>'
quirky vault clear --yes
```

Advanced parity and verification obligations are tracked in
[the vault's open findings](docs/loop/BLOCKERS.md#m3-vault-open-review-findings) and the dependent
`m3-vault-parity-completion` queue item.

Run Vault acceptance with `bun scripts/suite.ts plugins/quirky.vault`. Its paired-host fixture
uses separate Vault module copies because both daemons run in one Bun process; disabling one
host must leave the other host's exact source searchable. Search-window scenarios wait for
settled failures before retrying and exercise term truncation within the public 512-character
query limit. Native Trash and OS integration remain separate checks.
All-scope searches remain usable while workspace context refreshes. Indexing discovers source
authority once per pass and still revalidates each file before reading it; opaque-ID inspection
continues to rediscover its current source. Candidate-limit checks wait for the real index to
finish, independently of the five-second fresh-search deadline.

## Terminal artifacts on the phone

In a local terminal session, open **More → Terminal artifacts** to browse files named in that
terminal's recent output. Artifact previews can open files outside the worktree without granting
the phone a general file-path API. Normal Files browsing remains worktree-contained.

Complete writable UTF-8 text and Markdown up to 48 KiB can be edited with **Save terminal artifact**.
Larger text is explicitly truncated and read-only. PNG, JPEG, GIF and WebP previews are bounded to
192 KiB; other binary files show metadata only. The artifact service currently supports macOS hosts.

The same operations are scriptable. Set the source IDs to the actual worktree and terminal session;
take `ARTIFACT_ID` and `GRANT` from the list result, and `REVISION` from the preview:

```sh
quirky terminal artifacts list "$WORKTREE_ID" "$SESSION_ID" --json
quirky terminal artifacts preview "$WORKTREE_ID" "$SESSION_ID" \
  --artifact-id "$ARTIFACT_ID" --grant "$GRANT" --json
quirky terminal artifacts save "$WORKTREE_ID" "$SESSION_ID" \
  --artifact-id "$ARTIFACT_ID" --grant "$GRANT" \
  --revision "$REVISION" --content-file ./draft.md --json
quirky terminal artifacts refresh "$WORKTREE_ID" "$SESSION_ID" \
  --artifact-id "$ARTIFACT_ID" --grant "$GRANT" --json
```

Grants belong to the authenticated caller and exact source session. They expire after five minutes;
retained source authority lasts at most thirty minutes. Refresh returns a replacement grant but
does not approve changed disk content. A stale revision, replaced file or lost source refuses the
save and preserves the phone draft. Reload content explicitly to adopt disk changes.

## Markdown diff images

Git's Markdown diff preview and the editor's Changes preview show the modified text, including
local images resolved relative to the Markdown source. Images must stay within the registered
worktree. Remote URLs, unsafe paths and missing images are not loaded. Historical diffs use
current worktree image files, not images from the historical commit.

Detached previews do not open editor buffers or change files. Each mounted preview owns a
separate resource lease; switching to Source, replacing the preview or unmounting it releases only
that lease, leaving other splits and ordinary editor previews intact.

The public `quirky.editor/markdownPreview` method is also available through the generated CLI:

```sh
LEASE_ID="$(uuidgen)"
quirky editor markdown-preview-resource --action render --lease-id "$LEASE_ID" \
  --worktree "id:$WORKTREE_ID" --path docs/Guide.md \
  --text '![Chart](images/chart.png)' --json
quirky editor markdown-preview-resource --action release --lease-id "$LEASE_ID" --json
```

Render returns sanitized `html`, `leaseId`, `worktreeId` and the normalized source `path`.
Release is idempotent and returns `released:false` for an unknown or already released lease.
Use a fresh lease ID for each render and release it when no longer needed. Up to 64 leases and
64 local images per render are supported; exceeding a bound fails without evicting another
preview. Text-only `quirky.editor/markdown` with `action:renderPreview` remains context-free and
does not load local images.

## How it's built

- **`packages/pty-host`:** `quirky-pty` owns every terminal and its history.
- **`packages/daemon`:** `quirkyd` serves the one API that the UI, the CLI and the desktop shell
  all use.
- **`packages/ui`:** the React UI, served by the daemon.
- **`packages/cli`:** the `quirky` command.
- **`apps/desktop`:** the Electrobun window.
- **`prototypes/`:** stack experiments, such as the native Swift shell.

A PR's checks run the tests its change affects. Add the `full-suite` label to run every test on
GitHub, on that push and later ones. `bun run test` runs the whole suite through the configured test
host instead, which agents don't use ([AGENTS.md](AGENTS.md)). Use `bun scripts/suite.ts <dirs>` for
affected packages and `bun test <file>` for a single file. Run `bun run test:affected` before you
push to check only the tests your change affects against the baseline from main. It also goes
through the test host, and it runs nothing when the change selects every test. It's advisory, and
the PR check decides whether a change can merge. Test workers drain their result output before
exiting so large runs survive slow pipes.

Verify shell integration with the explicit Bash 5.2/5.3 matrix. Supply two installed GNU Bash
executables (temporary source builds are sufficient):

```sh
bun run test:bash -- /path/to/bash-5.2/bin/bash /path/to/bash-5.3/bin/bash
```

The command rejects missing or wrong versions instead of skipping coverage. Each version runs
the real-PTY Bash cases with disposable homes. For a single runtime, set `QUIRKY_TEST_BASH` when
running `packages/daemon/test/shell-path.test.ts`; ordinary tests still use `/bin/bash`.
Empty, whitespace and comment input must not produce command completions, including when
`functrace` inherits DEBUG into the prompt helpers. Real commands still report their status
when history ignores duplicates, ignores leading spaces, or is disabled.

### Shared desktop UI components

`@quirky/ui` exports the shared graphite controls: Button, IconButton, TextField, ListRow,
SectionHeader, Tabs, Badge, StatusDot, Menu, Toast, Dialog (including sheets), EmptyState,
FormRow, ToolPanelFrame and InlineAgentCard. Import their styles from `@quirky/ui/styles.css`;
the desktop host already loads them. Components are controlled presentations: callers own
feature state and callbacks. Theme scopes use `data-theme="dark"` or `data-theme="light"`.
`Dialog` supports `scrollBody` when long content must scroll independently of its header and
action footer; the default retains whole-dialog scrolling. `placement="top"` anchors dynamic
search dialogs below the top edge instead of recentering as their content changes. The command
palette uses this placement so its search field stays still while filtering results.

After `bun run --filter './packages/ui' build`, open `/gallery.html` on the daemon's UI origin
to try every component in both themes. The gallery needs no RPC token and does not connect
to the daemon.

`bun run ui:lint` checks UI source for raw colors and pixel dimensions. Root
`bun run typecheck` runs the same gate. Plugin enforcement is staged:
`scripts/ui-lint-plugins.json` is the staged enforcement registry; each `ui-restyle-*` item
adds its plugin IDs. Worktree and repository management are enforced. Unlisted legacy plugins
are not checked. Listed plugins must remove their own CSS files, private CSS imports, style
elements and stylesheet injection; the canonical `@quirky/ui/styles.css` import is allowed.
Use shared controls and tokens instead.
Generated files ignored by Git are excluded from source discovery. Tracked source stays
checked even inside an ignored directory; standalone source-scanner calls still inspect
the supplied content.
Only custom-property values in the two central design-system token files may define raw
primitives. Existing host geometry remains in `compatibility-tokens.css` until its area restyle;
new shared controls use the approved semantic tokens and size scale. Static source analysis
does not evaluate arbitrary runtime style computations or trace imported style objects.

Worktrees remains the default left-top tool. It renders repository/project management through
the existing `quirky.repo` API rather than a separate repository panel. Rows use shared status
dots, attention counts and a second activity line; project/worktree dialogs and panel options
use the same graphite controls in both themes. Shared ContextMenu supports pointer-positioned
menus with nested actions; shared Dialog supports wide content and stacked focus ownership.

Release builds suppress the native browser context menu across the shell. Text fields,
editable content and selected text keep their native menus; app context menus still work.
Development builds retain the native browser menu for Inspect Element.

Narrow panels reflow header actions and row controls before they can crowd out names.
Section headings stay on one line with ellipsis; full project names remain available on hover.
The status bar reserves room for complete activity and needs-you metrics while usage adapts
to the remaining width. The Usage button draws its focus ring inside the control so it stays
visible at the window edge.

### Public plugin UI and grouping APIs

The desktop host places tools in six movable slots: left top/bottom, right top/bottom and
bottom left/right. Click an icon to open its tool or close that slot; drag it to another stripe
or use its Move menu. Slot sizes, split proportions and placements persist across projects
in the user profile. A lone bottom tool fills the dock; opening both bottom slots restores
their saved split and divider. Worktrees and Changes open on first launch.

`ui.contributions` exposes the effective `tools` projection alongside the original panel,
sidebar-section and activity-item registrations. Equivalent built-in launchers share a tool;
third-party content retains its own destination. Panels, sidebar sections and activity items
may declare `defaultSlot` and `icon`. Views remain center contributions; the host's center tabs
contain only opened views and retain each view's input in its exact window. Commands, settings,
overlays and status items keep their dedicated host regions.

Use the same public layout API from scripts:

```sh
quirky ui open-tool host:inbox
quirky ui move-tool panel:quirky.ledger/ledger right-bottom
quirky ui resize-tools --left 290 --right-split 0.6
quirky ui close-tool left-bottom
quirky ui state --json
```

`ui.tool.open` is idempotent; the stripe explicitly closes an already open tool.
The existing panel/sidebar APIs update the same tool state. The obsolete editor top/side
activity-bar setting is removed. ⌘K searches commands, tools, views and worktrees while
preserving contributed shortcut priority. The Search button qualifies its ⌘K hint as
“outside terminal”: with terminal focus, ⌘K clears terminal output; click Search to open
the palette without clearing it. Exact title matches rank first in nonempty searches;
tool locations use readable slot labels. Off-worktree questions raise eight-second corner
toasts and amber worktree/Inbox counts; dismissing a toast never answers its durable question.

Ledger opens in bottom left by default; the project action menu opens its full Project Ledger
page. Its chooser, scoped panel, entry forms, history, triage, guarded confirmations and
staleness settings use the shared dark/light controls and tokens. Entry selection still captures
immutable ID/revision snapshots; a presentation change never bypasses confirmation or revision
checks. Ledger is included in the canonical UI lint plugin list.

Setting declarations can provide optional `category` and `section` strings. The generic Settings
dialog groups these declarations by category and section; uncategorized settings retain their
plugin grouping, with the plugin's manifest `name` as the heading. Plugin and setting IDs remain
unchanged.

Git worktrees expose separate display membership (`projectGroupId`), monotonic activity
(`lastActivityAt`) and filesystem-instance identity (`instanceId`). `quirky wt create-group
<worktree> <name>` creates a group and assigns only that worktree with stale-assignment protection.
`quirky wt set <worktree> --project-group <group-id>` moves it; `--no-project-group` clears it.
These operations do not change its repository, path or lineage.
Loose worktree membership requires a Git worktree owned by a Git project. Folder projects use
project-group actions instead. Dragging changes membership only in Project grouping; manual
sibling ordering remains separate.

Project groups expose `parentId`. `quirky repo group create <name> --parent <group>` and
`quirky repo group set-parent <group> --parent <parent>` manage hierarchy; `--no-parent` clears it.
Deleting a group deletes its group subtree and releases loose worktree memberships without
deleting their Git worktrees or metadata.

The built-in `quirky.sidebar-extras` plugin adds cross-repository worktree placement, client-local
activity windows, a live Source Control dirty indicator, and configurable sidebar separators.
`quirky sidebar-extras set --workspace-activity-window week` changes the activity window;
`state`, `projection`, and `dirty` provide JSON readback with `--json`.
`activate --worktree <id>` records a visit; `activate --clear` clears it.
Preferences persist per client. Visit and departure stamps are keyed to filesystem-instance
identity, so replacing a worktree does not inherit its predecessor's recency.
Activity filters offers All, Live only, Past 24 hours, Past 7 days, Past 30 days, and Custom.
Custom days commit on Enter or blur; invalid values leave the last applied filter unchanged.
The selected workspace stays visible. “Show hidden” clears only activity filtering.
The separator switch is under Appearance > Window & Sidebar; it changes dividers, not row geometry.
Source Control decoration follows the active worktree even when the Changes tool is closed.

Workspace options also includes **Hide merged/closed reviews** and **Hide passing checks**.
Each enabled toggle adds one to the filter badge; Clear filters resets both and the activity window.
The same client-local preferences are scriptable:

```sh
quirky sidebar-extras set --hide-completed-review-workspaces=true --hide-passing-check-workspaces=true
quirky sidebar-extras set --hide-completed-review-workspaces=false --hide-passing-check-workspaces=false
quirky hosting cached-reviews --worktrees <worktree-id> --json
```

Review filters consume normal hosting lookup results without fetching or probing authentication.
Uncached, unavailable, expired, or identity/head-stale review data leaves a workspace visible to
the review filters. `sidebar-extras projection --json` reports combined `visibleIds`/`hiddenIds`,
activity-only `hiddenCount`, and separate `reviewHiddenIds`/`reviewHiddenCount`.

The [sidebar parity specification](docs/quirk/specs/2026-10-28-m2-sidebar-extras-followup/logic.md)
defines membership guards, activity freshness, recovery, and dirty-status race handling.
The root TypeScript configuration resolves both public `@quirky/protocol` entries directly to
workspace source, so newly added plugins do not need generated per-plugin links for typechecking.
Keep those mappings aligned with `packages/protocol/package.json` exports.

## Editor documents and shared review notes

The **Files** tool opens in the right-top slot by default; documents stay in center tabs.
Editor controls, Quick Open, Save As, dirty-close and notebook trust dialogs use the shared
graphite UI in dark and light. Source editing, Markdown modes, notebooks and file viewers keep
their existing commands and save guards. `quirky.editor` is included in the UI lint gate:
presentation changes must use `@quirky/ui` components and semantic tokens, with engine styles
owned by the shared UI package rather than injected plugin CSS.

Document headers keep File actions beside the path, with view modes, Changes and Save below.
Pinning, Explorer, Source Control, tab closing and font zoom are available in File actions, so
the header fits two rows in the default window with Worktrees and Files open. Markdown formatting
scrolls horizontally instead of adding rows; search and review-note controls still wrap.

New Markdown documents use collision-safe untitled placeholders. Save opens a relative-path
Save As dialog; cancelling keeps the draft. The public `quirky.editor/saveAs` method accepts
`bufferId`, `path` and `expectedRevision`, refuses existing destinations and preserves the
buffer and tab identities. Closing an untouched blank placeholder removes only that owned file;
template-created, edited and externally changed files are retained.

Source Control's Notes shelf includes both diff notes and Markdown review notes, including notes
whose editor tab has closed. `quirky git notes --worktree <id> --json` lists the same notes.
Copy, scoped clear and send use the canonical owner stores; confirmed sends remove only unchanged
snapshots, and concurrent edits survive. A shared delivery reservation prevents a Markdown note
from being sent simultaneously from its editor rail and Source Control.

Source Control resolves GitHub review state for the current branch and HEAD before offering
review creation, then hands the guarded preparation result to the existing Reviews composer.
The [parity sweep specification](docs/quirk/specs/2026-10-28-m7-sweep-editor-source-control/logic.md)
records the implemented flows and the remaining editor/hosted-target completion work.

## Docs

- [docs/v1.md](docs/v1.md): what v1 does and leaves out, and how the parts fit together.
- [docs/architecture.md](docs/architecture.md): the full design, its memory budget, and the
  decisions made so far.
- [docs/roadmap.md](docs/roadmap.md): the build order for every kept Orca feature and the plugin
  kernel, with each milestone's exit test.
- [plugins/README.md](plugins/README.md): built-in command groups, including the Heimdall
  fleet, watcher controls and optional Claude owner API.
- [docs/plugin-api.md](docs/plugin-api.md): the frozen Plugin API 1.0 author contract, compatibility
  policy and manifest/module lifecycle.
- [docs/stack-proposal.md](docs/stack-proposal.md): how the stack choice was settled, including the
  native Swift option, with the measurements.
- [research/orca-features/](research/orca-features/README.md): how each Orca feature Quirky keeps
  works, verified in the running app, with screenshots.
- `research/` is its own local git repo with no remote, ignored here, so the research and the
  screenshots never reach this repo's remote. Paths into it from these docs resolve only on the
  machine that has it.
- [BRIEF.md](BRIEF.md): the project's starting brief.
