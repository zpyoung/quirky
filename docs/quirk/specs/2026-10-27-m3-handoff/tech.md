# Session handoff: tech spec

**Status:** Draft for build. Logic spec: [logic.md](logic.md). Tier gate: crosses subsystem
boundaries (kernel UI, three existing plugins, a new plugin) and touches far more than 3 files; also
requested in the logic spec's Status.

## Architecture

A new built-in plugin `plugins/quirky.handoff` (daemon `main.ts`, `cli.ts`, window `src/ui.tsx`)
owns every handoff rule ([Conceptual model](logic.md#conceptual-model)). It reads other plugins only
through `context.call`:

- `quirky.session/get|list` (source record, `providerSession`, `agent`, `cwd`, `worktreeId`)
- `quirky.agent-status/get` (prompt, last message, state, `lastHookAt`) and its `changed` event
- `quirky.terminal/history` (capture), `paneOf`, `workspace`, `newTab`, `focusPane`
- `quirky.worktree/list|show|create`, `quirky.repo/show`
- `quirky.git/status|diff`
- `quirky.agents/list|deliver`, setting `quirky.agents/default-agent`
- `quirky.editor/state` when present (D19)
- `quirky.session/setBadge` (new, B below)

Four kernel and plugin growths land first, each usable by any plugin:

| Code | Growth | Where |
|---|---|---|
| K | Shell toasts with kind, persistence, actions, dismiss command; toasts in `ui.state` | packages/protocol, packages/ui, packages/daemon |
| M | `menu-item` UI contribution kind; the terminal pane menu lists items for `quirky.terminal/pane` | packages/protocol, packages/daemon, plugins/quirky.terminal |
| B | Session badges: `Session.badges`, `quirky.session/setBadge`, chips in both tab strips | packages/protocol, plugins/quirky.session, plugins/quirky.terminal |
| T | `quirky.terminal/newTab` returns `session`, `tab`, `pane`, and takes `activate` | plugins/quirky.terminal |

Then the plugin in four parts:

| Code | Part | Files |
|---|---|---|
| C | Pure core: brief composer, repo-state formatter, template normalizer and substitution, secret scan, token estimate, bounded capture, fences | `plugins/quirky.handoff/src/core/*.ts` |
| P | Transcript probe and per-session path history | `plugins/quirky.handoff/src/daemon/probe.ts`, `history.ts` |
| H | Daemon service: methods, store, drafts, preferences, launch, delivery, lineage, badges, events; manifest; CLI | `plugins/quirky.handoff/main.ts`, `cli.ts`, `quirky-plugin.json`, `src/daemon/*.ts` |
| W | Window: dialog overlay with CodeMirror preview, settings view, menu command, toast wiring, UI commands and reports | `plugins/quirky.handoff/src/ui.tsx`, `src/window/*.tsx` |
| E | End-to-end tests per scenario | `plugins/quirky.handoff/test/**` |

Libraries: React 19 (window), CodeMirror 6 `@codemirror/state`, `@codemirror/view` (same versions
as `plugins/quirky.git/package.json`), bun:sqlite through `context.openStore`.

## Code references

### K: shell toasts ([Delivery](logic.md#delivery), D37)

- `packages/ui/src/lib/state.ts:10-17` `Toast`: add `kind` values `success`, `warning`; optional
  `key` (string, a plugin-chosen id; a new toast with the same key replaces the old), `persistent`,
  `detail` (second line), `actions`, `onDismiss`. `reduce` 'event' case at :53-61 copies the new
  notify fields.
- `packages/ui/src/components/Toasts.tsx:5-19`: skip the `TOAST_MS` timer when `persistent`; render
  action buttons; an action runs `host.executeCommand(command, args)` then dismisses unless
  `keepOpen`; a dismiss (button or timer) runs `onDismiss` when set.
- `packages/ui/src/plugins/host.ts:793` `toast`: accept an optional third `ToastOptions` argument;
  `HostDeps.toast` at :31 carries it.
- `packages/protocol/src/ui.ts:229` `UiPluginContext.toast(title, body, options?)`.
- `packages/protocol/src/plugins.ts:134-148` `PluginNotification` and `rpc.ts:129-142` notify event:
  add optional `kind`, `key`, `persistent`, `detail`, `actions`, `onDismiss`.
- `ui.state` toasts: add `toasts: UiToastState[]` to `UiState` (`packages/protocol/src/ui.ts:189`),
  the `uiState` schema (`packages/protocol/src/kernel-schemas.ts:197-204`), and
  `LayoutService.state()` (`packages/daemon/src/plugins/layout.ts:~112-139`). A new role-`ui` method
  `ui.shell.report {toasts}` (`packages/daemon/src/methods.ts` beside `ui.report` at :236) stores the
  latest per window connection (dropped in `dropConnection`); the window sends it from the store on
  every toast change. `ui.state.toasts` is the focused window's list, else the latest.
- A new role-`ui` routed command is not needed: an action is a command id plus args, so a script
  presses it with `ui.command.run`; `ui.toast.dismiss {key}` (daemon method routed to the window
  like `ui.command.run`, `layout.ts:~228-250`) dismisses by key and runs `onDismiss`.

### M: menu contributions ([Opening a handoff](logic.md#opening-a-handoff), D9)

- `packages/protocol/src/ui.ts:4` `UI_KINDS`: add `menu-item`. Entry type `UiMenuItemEntry` beside
  `UiCommandEntry` (:83); `UiModel` (:128-152) gains `menuItems`.
- `packages/daemon/src/plugins/ui-kinds.ts:15-24` `ALLOWED_FIELDS['menu-item']` and
  `checkUiKindEntry` (:159) validation; `packages/daemon/src/plugins/ui-model.ts:248`
  `buildUiModel` collects effective entries.
- `plugins/quirky.terminal/src/window/workspace/controller.ts:84-86` `WorkspaceOptions`: add
  `paneMenuContributions?: (pane: PaneLeaf, session: Session | undefined) => MenuItem[]`; splice
  its rows after the Quick Commands row (`controller.ts:861`), before the separator at :862.
  `report()` (:1074-1094) already lists every row's label.
- `plugins/quirky.terminal/src/ui.tsx:~37-38` `workspaceSlots`: fill it from the window model's
  `menuItems` where `menu === 'quirky.terminal/pane'` and `when` matches; `onSelect` runs
  `context.executeCommand(item.command, { session: leaf.session })`.

### B: session badges ([Lineage](logic.md#lineage), D40)

- `packages/protocol/src/model.ts:193-222` `Session`: add `badges?: Record<string, SessionBadge>`.
- `plugins/quirky.session/src/records.ts:~147-150`: append a migration adding a `badges` TEXT
  column (JSON), as `agent_status` and `unread` were added.
- `plugins/quirky.session/src/sessions.ts:343-351` beside `setUnread`: `setBadge`, emits `changed`.
  Manifest `plugins/quirky.session/quirky-plugin.json`: method `setBadge`; `Session` result schemas
  gain `badges`.
- `plugins/quirky.terminal/src/window/workspace/GroupView.tsx:~74-78`: after the title span, one chip
  per badge of the tab's lead session; click runs the badge command with its args, stopping
  propagation so the tab click doesn't also fire.
- `plugins/quirky.session/src/window/SessionTabs.tsx:38`: the same chip after `.tab-title`.

### T: newTab ([Starting](logic.md#starting), D34)

- `plugins/quirky.terminal/src/layout/service.ts:406` `newTab`: return
  `{ workspace, session, tab, pane }` from `addTab` (:424-441, which builds the tab at :440).
- `NewTabSpec` (:32-40) and the manifest params (`plugins/quirky.terminal/quirky-plugin.json:661-696`)
  gain `activate` (default true). `false` appends without `ops.activate` (`ops.ts:133`, called from
  `appendTab` :143-147). Result schema (:697-707) gains `session`, `tab`, `pane`.

### C, P, H, W: the plugin

- Template: `plugins/quirky.notifications/` (manifest fields, `main.ts:13` `activate`, `cli.ts:13`
  `commands`, `src/ui.tsx` view and command provide, `package.json`).
- Overlay precedent: `plugins/quirky.terminal/src/window/floating/FloatingOverlay.tsx:93-158`
  (always mounted, reports `shown`). Escape: own `window` keydown with `stopPropagation`, as
  `plugins/quirky.worktree/src/Dialog.tsx:5-17`.
- CodeMirror precedent: `plugins/quirky.git/src/view/ConflictFile.tsx:2-3`, `src/view/theme.ts`.
- Delivery: `plugins/quirky.agents/src/delivery.ts:45` behind `quirky.agents/deliver`
  (`plugins/quirky.agents/quirky-plugin.json:1657`).
- Capture: `quirky.terminal/history` (`plugins/quirky.terminal/src/terminal.ts:184`, pages with
  `before`, `format: 'text'`).
- Worktree create: `plugins/quirky.worktree/quirky-plugin.json:140-381` (`repo`, `name`, `base`,
  `activate`).
- Git: `plugins/quirky.git/quirky-plugin.json:15-226` status (`entries`, `capped`, `branch`, `head`),
  `:228-372` diff (`original`, `modified`, `binary`, `tooLarge`, `source`).

## Contracts and interfaces

### K1: toasts

CONTRACT:
```
type ToastAction = { label: string; command: string; args?: unknown; keepOpen?: boolean }
type ToastOptions = { kind?: 'info'|'success'|'warning'|'error'; key?: string; persistent?: boolean;
  detail?: string; actions?: ToastAction[]; onDismiss?: { command: string; args?: unknown } }
UiToastState = { key: string|null; kind; title; body; detail: string|null; persistent: boolean;
  actions: { label: string; command: string; args?: unknown }[] }
```
- Invariants: an existing toast with the same `key` is replaced in place, without running the
  replaced toast's `onDismiss`; a non-persistent toast
  still auto-dismisses at 6 s; `onDismiss` runs exactly once per toast, on the button, the timer or
  `ui.toast.dismiss`, never after an action already dismissed it.
- Errors: an action whose command fails shows the shell's error toast and keeps the original.

### M1: menu items

Additive API amendment, 2026-10-28: Handoff continues to use the pane target and `{ session }`. The shared menu-item API also accepts `quirky.terminal/tab`; tab commands receive `{ worktree, workspace, group }`, preserving Browser's `after: 'quick-commands'` placement. Tab contributions appear before Agent settings, with the unconditioned Loop row last by stable ID and visible only in the blank/static + menu. Handoff's pane `when` and `after` behavior remains unchanged. See the [loop UI contract](../2026-10-28-m5-loops-ui/tech.md#contracts--interfaces).


SCHEMA (manifest `contributes['menu-item']` entry):
```
{ id: string; menu: 'quirky.terminal/pane' | 'quirky.terminal/tab'; title: string; command: string;
  when?: { agent?: 'any' }; after?: 'quick-commands' }
```
- `when.agent: 'any'` matches when the pane's session `agent !== 'shell'`. Items of disabled or
  overridden plugins are absent. The command receives `{ session }`.

### B1: session badges

CONTRACT: `quirky.session/setBadge { session: string; key: string; badge: SessionBadge | null } -> { session: Session }`
where `SessionBadge = { label: string; tooltip?: string; command?: string; args?: unknown }`.
- The stored key is `<caller plugin id>/<key>`, so plugins can't overwrite each other. Handoff
  uses one key per lineage record (`lineage:<id>`) on each end, so a session in several handoffs
  carries several badges; each badge's command is `command:quirky.handoff/jump` with
  `{session, lineage}`. `null`
  removes. Unknown session: not-found error. Emits `quirky.session/changed`.

### T1: newTab

CONTRACT: `quirky.terminal/newTab { …existing, activate?: boolean } -> { workspace, session: string, tab: string, pane: string }`
- `activate: false` leaves the workspace's active group, active tab and focus unchanged.

### H1: methods

All take a `source`, which is `{ session: string }` or
`{ archived: { agent: string; providerSessionId?: string; transcriptPath?: string; title?: string; worktree?: string; cwd?: string; prompt?: string; lastMessage?: string } }`.
A `controls` object is:

SCHEMA:
```
{ target: { worktree: string } | { create: { name: string; base?: string } };
  agent?: string; relationship: 'continues'|'reviews'|'branches-from';
  context: 'focused'|'full';
  include: { repoState: boolean; diffBodies: boolean; openEditorTabs: boolean };
  templateId: string|null; note: string }
```

| Method | Params | Result | Errors (reason) |
|---|---|---|---|
| `prepare` | `{source}` | `{ source: SourceInfo, candidates: Candidate[], canCreateWorktree, agents: {state:'ready'|'failed', list:{id,label}[]}, controls: Controls (seeded: draft, prefs, source), draft: Draft|null, templates: Template[] }` | `no-context`, not-found |
| `preview` | `{source, controls, recapture?: boolean, body?: string}` | `Preview` | `no-context`, `invalid-target` |
| `probe` | `{source, target?}` | `{verdict:'usable'|'unverifiable'|'unreachable'|'none', path:string|null, reason:string|null, candidate:'reported'|'session-id'|'history'|'project-scan'|null}` | |
| `start` | `{source, controls, body?: string, shown?: string, wait?: boolean}` | `{ child: {session, tab, worktreeId}, lineageId: string|null, worktreeCreated: string|null, delivery: Outcome|'pending' }` | `no-context`, `source-changed` (data `{preview}`), `agent-unavailable`, `launch-failed`, `worktree-create-failed` (data `{message}`), `invalid-target` |
| `resend` | `{session}` | `{delivery: Outcome}` | `no-brief` |
| `discard` | `{session}` | `{discarded: boolean}` | |
| `lineage` | `{session?}` | `{records: LineageRecord[]}` | |
| `jump` | `{session, lineage?: string}` | `{focused: {session, pane}, lineageId}` | `no-live-pane`, `worktree-removed`, `no-lineage` |
| `templates` | `{}` | `{templates: Template[], custom: boolean, limit: 24}` | |
| `templateMutate` | `{op:'add'|'update'|'remove'|'reset', template?: {id?, name, body}, id?: string}` | `{templates, custom, warnings: ('duplicate-name')[]}` | `limit`, `invalid` |
| `draft` | `{source, draft: Draft|null}` | `{ok:true}` | |

- `preview` with `body` (a detached preview) skips composition and analyzes `body`: `brief` is
  `body`, and `characters`, `tokens` and `secrets` describe it; warnings still come from the
  controls and probe. The window calls it on every edit (debounced) so markers and cost follow.
- A failure after `create` succeeded (agent check, launch) carries `data.worktreeCreated: {id, name, path}`
  on its error; the window sets the target to that worktree and turns create mode off.
- `jump` without `lineage` uses the newest record naming `session` on either side.
- `start` `body` set means detached: sent verbatim. `shown` set (attached): recompose with a fresh capture;
  if the composed text differs from `shown`, fail `source-changed` with the fresh `Preview`. Neither
  set: compose and send (CLI default).
- `Preview = { brief, notice, characters, tokens, warnings: {code, message}[], secrets: {rule, start, end, excerpt}[], probe, repoState: 'ok'|'failed'|'off'|'none', busy: boolean, live: boolean, contextAvailable: boolean }`.
  Warning codes: `no-transcript-context`, `diff-truncated`, `no-context`, `repo-state-failed`,
  `transcript-unreachable`, `transcript-unverifiable`, `full-unavailable`, `no-live-pane`,
  `secrets`. Messages are the logic spec's exact strings.
- `start` order: create worktree → resolve body → append notice → check agent in
  `quirky.agents/list` installed and enabled (`agent-unavailable`) → `newTab {workspace, group,
  agent, cwd: target path, activate:false}` (`launch-failed` on throw) → retain brief → write
  lineage (swallow errors) → set badges → clear draft → write prefs (swallow errors) → start
  delivery. With `wait`, resolve after the outcome; else return `delivery: 'pending'`.
- Group choice: same worktree → `quirky.terminal/paneOf {session}` gives the tab; its group from
  `quirky.terminal/workspace`; else the target workspace's `activeGroup`.

### H2: delivery outcome

`Outcome = 'delivered' | 'resent' | 'retry-failed' | 'unobservable'`.
- Call `quirky.agents/deliver {sessionId: child, agent, text, submit: true}`.
- `pasted` → `delivered`. Otherwise watch the child's agent-status row for up to 10 s: a row whose
  `state` is `working` with `turnStartedAt` after the launch → `delivered`.
- Positive idle evidence: `deliver` returned `not-delivered` and the child's row exists with
  `lastHookAt` set and state `done`. Then resend once: `pasted` → `resent`, else `retry-failed`.
- Anything else → `unobservable`.
- Emit `quirky.handoff/delivery {child, lineageId, outcome}` and a notify event carrying the K1 toast
  (key `handoff:<child>`; `retry-failed` and `unobservable` persistent with the "Resend brief" action
  `command:quirky.handoff/resend-confirm {session}` with `keepOpen: true`, and `onDismiss` →
  `command:quirky.handoff/discard`). A successful resend emits the "The handoff brief was sent."
  toast with the same key, which replaces the persistent one without running its `onDismiss`.
- `resend`: one in-flight promise per child; success deletes the retained brief and returns
  `delivered`. The retained brief is dropped on `discard` and on `quirky.session/removed`.

### P1: probe

CONTRACT: `probeTranscript(input: { agent: string; sessionId: string|null; providerSessionId: string|null; reportedPath: string|null; cwd: string; history: string[]; claimed: Set<string>; env: { HOME, CLAUDE_CONFIG_DIR?, CODEX_HOME? } }) -> ProbeResult`
- Roots: claude `${CLAUDE_CONFIG_DIR ?? HOME/.claude}/projects`; codex `${CODEX_HOME ?? HOME/.codex}/sessions`; other agents have none (a reported path is `unverifiable: undiscoverable-path`).
- Before probing a live or ended source, the service calls the optional read-only public method
  `quirky.accounts/sessionHome {session}`. It returns `{provider, home}` from the recorded account
  session, or `{provider: null, home: null}` when absent. `quirky accounts session-home --session`
  exposes the same lookup without preparing a launch or changing selection.
- A matching provider's absolute recorded home supplies `CLAUDE_CONFIG_DIR` or `CODEX_HOME` for the
  probe. Explicitly unset launch variables have an absolute HOME-based home recorded by Accounts;
  they are not represented as a null home. Missing Accounts/no record keeps the daemon environment.
  Operational errors propagate; malformed provenance is unverifiable. Containment checks remain.
- Candidate order and verdict rules: logic spec [Transcript](logic.md#transcript), D25. Paths are
  `realpath`-normalized before the root check; a `.jsonl` suffix is required.
- Session-id lookup: claude `projects/*/<id>.jsonl`; codex `sessions/**/rollout-*-<id>.jsonl`.
- Project scan (claude): folder `projects/<cwd with every non-alphanumeric char replaced by '-'>`;
  newest two by mtime; within 300,000 ms of each other → withheld (`none`).
- History: `history.ts` subscribes to `quirky.session/changed` and keeps, per session, the last 5
  distinct `providerSession.transcriptPath` values (newest first), for at most 256 sessions (least
  recently updated evicted). Memory only.

### C1: composer

CONTRACT: `composeBrief(input: ComposeInput) -> { brief: string; notice: string; warnings: Warning[] }`;
`fenceFor(text) -> string` (backticks, length max(3, longest run + 1));
`formatRepoState(status, diffs?) -> { text, truncated }`; `applyTemplate(body, vars) -> string`;
`scanSecrets(text) -> SecretHit[]`; `estimateTokens(text) -> number`;
`boundCapture(lines: string[]) -> string|null`; `normalizeTemplates(list) -> Template[]`.
- Pure: no I/O, deterministic, unit-tested alone.
- Diff cap `12_000` characters; capture `36_000` characters; template name 80, body 8,000, catalog 24.

REGEX (secret rules, flags as shown; hits sorted by start, excerpt = first 4 chars + `…`):
```
aws-access-key-id   /AKIA[0-9A-Z]{16}/g
github-token        /gh[pousr]_[A-Za-z0-9]{36,255}/g
stripe-key          /sk_(?:live|test)_[A-Za-z0-9]{10,}/g
slack-token         /xox[baprs]-[A-Za-z0-9-]{10,}/g
private-key-header  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g
env-assignment      /(?:api_key|secret|token|password|passwd|credential)s?\s*[=:]\s*[A-Za-z0-9_\/+=-]{16,}/gi
```

Token estimate: a line inside a Markdown fence is code (4.5), a line starting with `+`, `-` or `@@`
outside a fence (excluding `---`/`+++` headers counted as diff too) is diff (3.5), every other line
including fence markers is prose (6.5); characters include each line's newline; sum of
`chars / rate`, rounded up, minimum 1.

Escape stripping for capture: CSI, OSC (BEL or ST terminated), single-character ESC sequences and
remaining C0 controls other than `\n` and `\t`.

### W1: window

- Overlay `overlay:quirky.handoff/dialog`, always mounted, reports
  `{ shown, source, controls, candidates, agents, preview: { text, detached, stale: string[], warnings, secrets, characters, tokens }, busy: { working, waiting }, canStart, disabled: string[], starting, error, templateEditor }`.
- UI commands (each `{ok:true}` or `{ok:false, reason}`): `open {session}`, `set {field, value}`,
  `edit {text}`, `regenerate`, `wait-idle`, `capture`, `start`, `cancel {via:'button'|'escape'}`,
  `save-template {name}`, `search {query}`, `resend-confirm {session}`, `open-settings`. Settings view
  `view:quirky.handoff/settings` reports `{templates, custom, count, limit, editor, confirm}` with
  commands `template-add`, `template-edit`, `template-remove`, `templates-reset`.
- The dialog recomposes with `preview` 150 ms after the last control change, dropping answers older
  than the latest request. Busy state follows `quirky.agent-status/changed` for the source.
- `resend-confirm` on "Cancel" does nothing (the toast stays); otherwise it uses `context.confirm({title: 'The brief may already have arrived. Sending again can create a duplicate turn.', confirmLabel: 'Send again'})` then `quirky.handoff/resend`.

### H3: CLI group `handoff`

CONFIG (cli-command ids and flags):
```
preview <session>   --worktree --new-worktree <name> --base <ref> --agent --relationship
                    --context focused|full --no-repo-state --diff-bodies --no-editor-tabs
                    --template <id> --note <text> --source-agent --provider-session
                    --transcript --last-message --title --cwd
start <session>     (preview flags) --brief <text|@file> --wait
resend <session>
lineage             --session
jump <session>
templates list | add --name --body | edit <id> --name --body | rm <id> | reset
```
`<session>` is optional when `--source-agent` describes an archived source.

## Data models

- `Session.badges?: Record<string, SessionBadge>` (B1); `UiState.toasts` (K1); `UiModel.menuItems` (M1).
- Handoff store (`context.openStore`), append-only migrations:
  - `lineage(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, record TEXT NOT NULL)`; index on
    `created_at`. After each insert, delete rows beyond the newest 500.
  - `kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)` with keys `templates` (absent → built-ins),
    `prefs` (`{lastAgent, includeToggles, lastTemplateId}`).

SCHEMA (lineage record):
```
{ id: uuid; createdAt: number; relationship: 'continues'|'reviews'|'branches-from';
  parent: { session: string|null; agent: string|null; providerSessionId: string|null;
            transcriptPath: string|null; worktreeId: string|null; title: string|null };
  child:  { …same, tab: string|null } }
```
- Validation on read: UUID id, non-negative safe-integer `createdAt`, known relationship, agent a
  string or null; failing rows are skipped. Child enrichment sets `providerSessionId` only while
  null, on `quirky.session/changed` for the child.
- Drafts, retained briefs, path history, in-flight resends: memory only.

## DO-NOT-CHANGE fences

- `plugins/quirky.agents/src/delivery.ts` and `src/core/paste.ts`: handoff uses `deliver` as is;
  its ready, paste and Enter timing is m1-providers D21/D40 and other callers depend on it.
- The existing pane menu rows and their order (`controller.ts:850-885`): m1-term-ui D18 locks them;
  contributed rows are only inserted after Quick Commands.
- `quirky.session/setUnread` and the `unread` column: m1-notifications depends on their meaning;
  badges are a separate field.
- Existing `newTab` callers get the same behavior: `activate` defaults to true and the result only
  gains fields.
- Notify events without the new fields render exactly as today (info, 6 s).

## Always / Ask / Never

- **Always:** run every daemon, CLI and fake agent with a fresh temporary `HOME` and `QUIRKY_HOME`
  (m1-agent-status D58); call other plugins only through `context.call`; keep the logic spec's
  strings byte-for-byte; declare every method, event, command, view, menu item and CLI command in
  the manifest with schemas.
- **Ask (record a decision, don't stop):** exact chip styling; debounce length; how many history
  pages a capture reads (enough for 800 lines).
- **Never:** import another plugin's files; write into the source session; read the real
  `~/.claude` or `~/.codex` in tests; block Start on secrets.

## Cross-cutting

- Security: the brief may carry secrets; it is never logged, and the retained brief lives in memory
  only. The locked notice is not a boundary (logic spec).
- Observability: `context.log` one line per start with child id and outcome, no brief text.
- Migration: session `badges` column and the handoff store are additive.
- Rollback: disabling `quirky.handoff` removes the menu item, badges stop updating, and stored
  badges remain as data on sessions.

## Testing strategy

- C: `plugins/quirky.handoff/test/core/*.test.ts` — composer order and fences (SC-4, SC-19, SC-20),
  repo state (SC-14–SC-16), secrets (SC-39), tokens (SC-41), capture (SC-31), templates (SC-22,
  SC-23).
- P: `test/probe.test.ts` with a temp HOME holding fake `.claude/projects` and `.codex/sessions`
  trees and controlled mtimes (SC-25–SC-30).
- H: `test/service.test.ts` on `startHarness({builtinPluginsDir})` with fake git and fake PTY
  (`plugins/quirky.notifications/test/support.ts` `Rig` pattern), hooks posted through
  `Rig.hook` (SC-2, SC-5–SC-13, SC-17, SC-18 with a test plugin declaring `quirky.editor/state`,
  SC-32, SC-34, SC-35, SC-37, SC-38, SC-42, SC-44–SC-47, SC-51, SC-52, SC-55–SC-57, SC-60–SC-62).
- Delivery and CLI: `test/e2e/*.e2e.test.ts` on `startAgentsE2E`
  (`plugins/quirky.agents/test/support/e2e.ts`) with `pasteFake`/`silentFake` style fakes and the
  agent-status shim (SC-43, SC-48–SC-50, SC-64).
- K, M, B, T: tests beside each changed file (`packages/ui/test`, `packages/daemon/test/plugins`,
  `plugins/quirky.terminal/test`, `plugins/quirky.session/test`), covering the fences above.
- W: happy-dom mount tests (`plugins/quirky.ask/test/ui.test.ts` pattern) for report shape and
  commands (SC-63); the UI scenarios (SC-1, SC-3, SC-21, SC-24, SC-33, SC-36, SC-40, SC-50, SC-53,
  SC-54, SC-58, SC-59) run in the step 6 UI pass.
- Bar: `bun run test`, `bun test scripts`, `bun run typecheck` green; each SC has a named test.

## Build waves

1. K, M, B, T, C, P in parallel (disjoint files).
2. H (needs C, P, T, B, K's notify fields).
3. W and E in parallel (W needs K, M; E needs H).

## Non-goals

For this handoff slice: everything the logic spec's [Scope and non-goals](logic.md#scope-and-non-goals)
excludes; a general menu system beyond the pane contribution; badge placement outside the two tab strips.
