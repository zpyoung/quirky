# Terminal panes: tech spec

**Status:** Draft for build. Logic spec: [logic.md](logic.md). Decisions: [m1-term-ui.md](../../../loop/decisions/m1-term-ui.md).

Paths are relative to the repo root `/Users/zpyoung/orca/workspaces/quirky/build-roadmap`. `QPT` is
`plugins/quirky.terminal`, `QPS` is `plugins/quirky.session`.

## Architecture

([logic: Conceptual model](logic.md#conceptual-model), [Data flow](logic.md#data-flow))

Five units, built in this order of dependency:

1. **Kernel UI API growth** (`packages/protocol/src/ui.ts`, `packages/daemon/src/plugins/{ui-kinds,ui-model,layout}.ts`, `packages/ui/src/plugins/host.ts`, `packages/ui/src/App.tsx`, `packages/ui/src/plugins/PluginSlot.tsx`, `packages/ui/src/components/useShortcuts.ts`): an `overlay` slot kind, keybinding `when`, `UiPluginContext.setContext` and `mountView`, the terminal-first rule.
2. **Kernel daemon growth** (`packages/daemon/src/plugins/{confirm,dispatch}.ts`; `packages/protocol/src/{pty,plugins}.ts`, `packages/pty-host/src/{session,server,screen}.ts`, `packages/pty-host/src/history/*`, `packages/daemon/src/plugins/pty-api.ts`, `packages/daemon/test/fixtures/fake-pty-host.ts`): a `describe` method may return `null` (no confirmation needed); PTY host ops `clear` and `resetModes`.
3. **`quirky.session` growth** (`QPS/quirky-plugin.json`, `QPS/src/sessions.ts`, `QPS/src/ui.tsx`): `create` takes `cwd`; the synthetic worktree `floating`; a new view `view:quirky.session/structured`.
4. **`quirky.terminal` daemon side** (`QPT/src/layout/*`, `QPT/src/quick-commands/*`, `QPT/src/processes.ts`, `QPT/src/open-external.ts`, `QPT/main.ts`, `QPT/quirky-plugin.json`, `QPT/cli.ts`): the pure layout tree, the `LayoutService` (store, reconciliation, every method), quick commands, the CLI group.
5. **`quirky.terminal` window side** (`QPT/src/ui.tsx`, `QPT/src/window/**`): the workspace view overriding `view:quirky.session/worktree`, the pane (xterm with search, links, paste, zoom, keys), menus, dialogs, the Quick Commands panel and the floating overlay.

Libraries: React 19 (external, shared through the import map), `@xterm/xterm` 5.5.0 with `@xterm/addon-fit` 0.10.0 and `@xterm/addon-webgl` 0.18.0 (as `QPS` pins them), plus `@xterm/addon-search`, `@xterm/addon-web-links`, `@xterm/addon-unicode11` and `@xterm/addon-clipboard` at the releases built for xterm 5.5.0 (0.15.0, 0.11.0, 0.8.0, 0.1.0; the implementer confirms with `bun add` and pins exact versions). The pty host keeps `@xterm/headless` 5.5.0.

## Code references

### Kernel UI

- `packages/protocol/src/ui.ts`: `UI_KINDS` :4 and `CODE_BACKED_KINDS` :7 gain `'overlay'`; the literal kind unions in `UiSlotEntry` :72 and `UiSlotState` :159 gain it; `UiModel` :126 gains `overlays: UiSlotEntry[]`; `UiKeybinding` :91 gains `when?: string`; `UiPluginContext` :181-209 gains `setContext` and `mountView`. New exports: `parseWhen`, `evaluateWhen`, `whenMentions`.
- `packages/protocol/src/kernel-schemas.ts:136-151` (`uiModel` result schema, required keys) gains `overlays`; keybinding item schema gains optional `when`.
- `packages/protocol/test/ui.test.ts:261-268` pins the kind lists; update to eight kinds, five code-backed.
- `packages/daemon/src/plugins/ui-kinds.ts`: `ALLOWED_FIELDS` :16-24 (`keybinding` gains `when`; new `overlay: ['title','description','order']`), `TITLE_REQUIRED` :28 gains `overlay`, `checkKeybinding` :48-64 validates `when` with `parseWhen`.
- `packages/daemon/src/plugins/ui-model.ts`: `resolveKeybindings` :99-171 groups by `chord + '\0' + canonicalWhen` instead of chord; reserved-chord shadowing (:148) applies to every group; distro bindings (:151, no `when`) shadow only the group with no `when`. The model literal :267-277 gains `overlays` (built like `panels`). The missing-ui warning :219 names overlays too.
- `packages/daemon/src/plugins/layout.ts`: `state()` :81-102 adds overlays to `slots` (`shown` per the Overlay slot contract; the window tells the daemon an overlay is mounted by reporting for it); `report()` :147 accepts overlay IDs.
- `packages/cli/src/commands/ui.ts:31-35` (`renderModel`) lists OVERLAYS.
- `packages/ui/src/plugins/host.ts`: `findSlot` :110 includes overlays; `runMount` :404 passes `input` only to views (unchanged) and `{report}` to overlays; `handleKey` :246 evaluates `when`; `contextFor` :636-702 adds `setContext` and `mountView` (tracked, cleaned on revoke like `setPanelBadge` :691).
- `packages/ui/src/App.tsx:35-58`: renders `<OverlayLayer/>` after `.layout` and before the palette, toasts and confirm host.
- `packages/ui/src/plugins/PluginSlot.tsx:15-19`: slot lookup includes overlays.
- `packages/ui/src/components/useShortcuts.ts:27`: unchanged capture listener; the terminal-first rule lives in `handleKey`.

### Kernel daemon

- `packages/daemon/src/plugins/confirm.ts`: `actionText` :138-146 returns `string | null` (null only from a `describe` method); `prepare` :72 returns `PreparedConfirmation | null`.
- `packages/daemon/src/plugins/dispatch.ts`: `confirmAndRun` :181-195 skips `request`/`consume` when `prepare` returned null.
- `packages/protocol/src/pty.ts`: `PTY_PROTOCOL_VERSION` :10 becomes 3; `PtyRequest` :81-119 and `PtyResults` :121-134 gain `clear` and `resetModes`; `packages/protocol/test/pty-protocol.test.ts:20` pins the version.
- `packages/pty-host/src/session.ts`: `SessionManager` gains `clear(sessionId)` and `resetModes(sessionId)`; both run inside `atRest` (:~546). `packages/pty-host/src/server.ts` `dispatch()` :172-211 gains the cases. `packages/pty-host/src/history/log.ts` (`HistoryLog`) gains a `clear` record kind; `history/reader.ts` (`pageBefore`, `composeReplay`, `textLinesAbove`) stops at the newest clear record; `history/restore.ts` `GROUND` :20-22 is the mode-reset sequence to reuse.
- `packages/protocol/src/plugins.ts:81-123` (`PluginPty`) gains `clear(sessionId): Promise<void>` and `resetModes(sessionId): Promise<void>`; `packages/daemon/src/plugins/pty-api.ts:104-186` implements them; `packages/daemon/test/fixtures/fake-pty-host.ts:116-204` answers them and records requests.

### quirky.session

- `QPS/quirky-plugin.json`: `create` params :221 gain `cwd`; CLI `new` gains `--cwd`; new `view` contribution `structured` (title "Structured session").
- `QPS/src/sessions.ts`: `create` :163 and `resolveWorktree` :587 (selector `floating`, or selector `current` with `caller.worktreeId === 'floating'`, resolve to `{id: 'floating', path: <cwd param or $HOME>, repoId: null}` without calling `quirky.worktree/resolve`); `newRecord` :452 takes the start cwd; `titleFor` :476 unchanged.
- `QPS/src/ui.tsx`: provides `view:quirky.session/structured` mounting `StructuredView` (`QPS/src/window/StructuredView.tsx`) for input `{session}`; keeps every existing provide.

### quirky.terminal

- `QPT/quirky-plugin.json`: new top-level `overrides` (the session view and the session commands, see Data models); new methods, events, settings, commands, keybindings, `cli-command`s, a `panel` `quick-commands`, an `overlay` `floating`.
- `QPT/main.ts:8-36`: wire `LayoutService` and `QuickCommandService` beside `TerminalService`; the store is opened once with one migrations array, `importMigrations` (`QPT/src/scrollback.ts:10`) first, because `runtime.ts:193-206` refuses a second `openStore` with a different count.
- `QPT/src/terminal.ts`: `write` :134 records that a session received driving input (for the exit rule); `factEvent` :37-48 unchanged; `onEvent` :238 keeps closing streams.
- `QPT/cli.ts`: new handlers; reuse `sessionIdOr` :12, `ctx.out.result`, `ctx.format.table`.
- New: `QPT/src/layout/tree.ts`, `QPT/src/layout/workspace.ts`, `QPT/src/layout/service.ts`, `QPT/src/layout/store.ts`, `QPT/src/quick-commands/{normalize,service}.ts`, `QPT/src/processes.ts`, `QPT/src/open-external.ts`, `QPT/src/window/workspace/**`, `QPT/src/window/pane/**`, `QPT/src/window/floating/**`, `QPT/src/window/quick-commands/**`.
- Reference code to port, not import (the import fence, `plugins/test/imports.test.ts` SC-24): `QPS/src/window/TerminalPane.tsx`, `replayGate.ts`, `terminalTheme.ts`, `NewSessionMenu.tsx`, `menuEntries.ts`, `PromptDialog.tsx`, `Dialog.tsx`, `StatusDot.tsx`, `status.ts`.

## Contracts & interfaces

### Keybinding `when` and context keys ([logic: Keybindings](logic.md#keybindings), [SC-68](logic.md#plugin-api-growth))

`CONTRACT:`
```
when grammar:   expr := or ; or := and ('||' and)* ; and := unary ('&&' unary)* ;
                unary := '!' unary | '(' expr ')' | key ; key := /[A-Za-z][A-Za-z0-9.]*/
parseWhen(text): {ok: true, canonical: string} | {ok: false, error: string}
evaluateWhen(canonical, keys: ReadonlyMap<string, boolean>): boolean   // unknown key = false
whenMentions(canonical, key): boolean   // key appears not under '!'
UiPluginContext.setContext(key: string, value: boolean | undefined): void
UiPluginContext.mountView(viewId: string, element: HTMLElement, input?: unknown): () => void
```

- `setContext` keys are window-global; a key set by a plugin is cleared when that plugin's UI session is revoked. Key names are free; the kernel gives two keys meaning: `terminalFocus` and `terminalKeysFirst`.
- `ui.contributions` lists `keybindings` in registry precedence order (the order `resolveKeybindings`' `beats()` ranks them, distro bindings first). `handleKey` takes the `active` bindings for the event's chord whose `when` is absent or evaluates true; a binding with a `when` beats one without; otherwise the first in list order wins. **Terminal-first rule:** when `terminalKeysFirst` and `terminalFocus` are both true, a binding fires only if `whenMentions(when, 'terminalFocus')`; otherwise the binding is skipped: `handleKey` calls `preventDefault()` (so the webview's own default for that chord, such as reload on `⌘R`, never runs) but not `stopPropagation()`, and reports the event as not consumed, so xterm still receives the key. `useShortcuts.ts:27` must not stop propagation in that case.
- `mountView` mounts an effective `view` contribution (lazily loading its plugin) into `element` with `{input}` and no `report`; the mount is not registered in the host's `slots` status and never sends `ui.report`. The returned function unmounts; revoking the caller unmounts too. A missing view throws `no contribution <id>`.

### Overlay slot ([SC-67](logic.md#plugin-api-growth))

- An `overlay` contribution is code-backed and mounted by the host for every effective overlay at window start (and after model refresh), into its own `div` inside a fixed full-window layer (`pointer-events: none` on the layer, the plugin's own content opts in). Mount props `{report}`. `ui.state` lists it in `slots` with `kind: 'overlay'`; `shown` is `report.shown` when the latest report is an object with a boolean `shown`, else true, while a window has it mounted, and false otherwise.

### Conditional confirmation ([logic: SC-14](logic.md#tabs))

- A destructive method's `describe` method may return `null`, meaning "nothing irreversible here": the dispatcher runs the call without an ask and without consuming any `confirmation`. A string keeps today's behaviour. Any other value is an Internal error (unchanged). Only `describe` methods can return null; `confirm` text cannot.

### PTY host `clear` and `resetModes` ([SC-34](logic.md#panes-and-splits))

- `clear(sessionId)`: inside `atRest`, the host's emulator runs xterm's `clear()` (the cursor's line becomes the first line, scrollback emptied), the log appends a `clear` record at the current output offset, the hot tail is replaced with the serialized cleared screen, and a checkpoint is written; every subscriber stream receives `ESC[H ESC[2J ESC[3J` followed by the serialized cleared screen, in order with live output, so every attached pane shows the cleared screen at once. Afterwards `history` returns only rows after the clear, `snapshot` and attach replay show only the kept line, and a cold restore restores only post-clear output. Offsets stay monotonic. Unknown session: the existing not-found error. An exited session can be cleared.
- `resetModes(sessionId)`: writes the mode-reset part of `GROUND` (mouse modes 1000/1002/1003/1006 off, bracketed paste off, application cursor off, cursor visible; not `?1049l`, not SGR) to the emulator, appends it to the log as output and sends it to subscribers, so every attached pane and a later restore see the modes off. Nothing is written to the process.
- Protocol 3 hosts answer both; the daemon treats a protocol 2 host as older and retires it the way it already does for older hosts (`packages/daemon/src/pty-client.ts:269-311`).

### Sessions ([SC-23](logic.md#panes-and-splits), [SC-55](logic.md#the-floating-workspace))

- `quirky.session/create` `cwd?: string`: an absolute existing directory, else invalid-params "cwd must be an existing directory"; the session's `cwd` and the spawn cwd are it; default the worktree path.
- Worktree selector `floating` (and `current` from a floating session) resolves to the synthetic worktree `{id: 'floating', name: 'Floating', path: cwd ?? $HOME, repoId: null}`; agents are allowed; `quirky session list --worktree floating` lists floating sessions.
- `view:quirky.session/structured` input `{session: string}`: renders the transcript and input of that structured session exactly as the session view does today.

### Layout service ([logic: The workspace and its layout](logic.md#the-workspace-and-its-layout))

All methods are on `quirky.terminal`. Each mutating method returns `{workspace: Workspace}` (the whole workspace after the change) and, on success, emits `quirky.terminal/layout {workspace: <id>, revision}`. Every mutating method accepts `revision?: integer`; a mismatch fails with conflict `workspace <id> is at revision <n>`. Each change runs as one store transaction and bumps the revision by exactly one.

Target resolution: `workspace?` (a worktree selector or `floating`; default the caller's worktree, or `floating` when the caller is a floating session), `tab`, `pane`, `group`, `split` IDs are global. `pane` methods also accept `session` (the pane showing it); the CLI's default pane is the one showing `$QUIRKY_SESSION_ID`. Unknown IDs fail not-found `no <kind> <id>`.

`CONTRACT:` methods (params → result):

| Method | Params | Notes |
|---|---|---|
| `workspace` | `{workspace?, ensure?: boolean}` | returns `{workspace}`; `ensure` creates the first tab when there is none (SC-1); not readOnly because of `ensure` |
| `newTab` | `{workspace?, group?, cwd?, agent?, prompt?, title?, quickCommand?}` | agent default `shell`; title default per D11; starts the session through `quirky.session/create` and binds it before returning |
| `closeTab` | `{tab, revision?}` | destructive, `describe: describeClose` |
| `closeTabs` | `{tab, which: 'others'\|'right'\|'left'}` | destructive, `describe: describeClose`; skips pinned |
| `describeClose` | `{tab?, pane?, which?}` | readOnly; `null` when no target session has a running child and none is an agent, else "Stop <command> in <tab title>?" / "Stop agent <title>?" naming each |
| `renameTab` | `{tab, title}` | `""` clears the custom title; ≤ 200 chars |
| `setTabColor` | `{tab, color}` | `none`, `blue`, `purple`, `pink`, `red`, `orange`, `yellow`, `green`, `teal`, `gray` |
| `pinTab` | `{tab, pinned}` | pinned tabs sort before unpinned within the group |
| `moveTab` | `{tab, group?, index?, split?: 'right'\|'left'\|'down'\|'up', of?: group}` | `group`+`index` moves; `split` makes a new group beside `of` (default the tab's group) |
| `activateTab` | `{tab?} \| {workspace?, group?, index}` \| `{workspace?, offset: 1\|-1, order?: 'position'\|'recent'}` | index is 1-based within the group |
| `reopenTab` | `{workspace?}` | not-found `no closed tab to reopen in <name>` |
| `splitPane` | `{pane, direction: 'right'\|'down'}` | shell in the source cwd (D15) |
| `closePane` | `{pane, revision?}` | destructive, `describe: describeClose` |
| `restartPane` | `{pane}` | only for a pane whose session has ended (status `exited`), else conflict `pane <id> is still running`; closes the old session and binds a fresh shell in its cwd to the same pane |
| `focusPane` | `{pane} \| {tab?, offset: 1\|-1}` | collapses an expanded pane first; `{pane}` also makes the pane's tab active in its group and that group the workspace's active group |
| `setPaneTitle` | `{pane, title}` | `""` clears; ≤ 200 chars |
| `expandPane` | `{pane, expanded}` | invalid-params with one pane |
| `equalize` | `{tab}` | |
| `resizeSplit` | `{split, ratio, revision?} \| {pane, share, revision?} \| {group, share, revision?}` | `ratio` is the first child's share; `pane`/`group` forms resolve the target's parent split and set the target's share; pane splits accept any value strictly between 0 and 1 (the window enforces the 50 px minimum when drawing and dragging), group splits 0.15–0.85, else invalid-params "a group divider stays between 0.15 and 0.85" |
| `movePane` | `{pane, toPane, edge: 'left'\|'right'\|'top'\|'bottom'} \| {pane, toTab}` | invalid-params for the last pane of a tab or a pane onto itself |
| `closeGroup` | `{group}` | appends its tabs, in order, to the first group of its sibling subtree (depth-first, `first` child first), makes the closed group's active tab active there, and replaces the parent split with the sibling (D17); invalid-params for the only group |
| `clearPane` / `resetPane` | `{pane}` | call `pty.clear` / `pty.resetModes` |
| `paneOf` | `{session}` | readOnly; `{workspace, tab, pane}` |
| `floating` | `{}` | readOnly; `FloatingState` |
| `setFloating` | `{open?, maximized?, bounds?, button?}` | returns `FloatingState`; emits `floating` |
| `openExternal` | `{target, reveal?}` | URL (http/https/mailto only) or absolute path; runs `open` / `open -R`; with env `QUIRKY_TEST_OPEN_LOG` set it appends `{target, reveal}` JSON lines there instead |

**One serial queue.** Every mutating method and every reconciliation pass runs through one async queue in `LayoutService` (FIFO, one at a time). `newTab`, `splitPane`, `restartPane` and quick-command runs call `quirky.session/create` inside their queue slot and bind the returned session before the slot ends; the `quirky.session/changed` event for that session is handled in a later slot, finds it bound, and does nothing. An external session therefore can't be adopted twice, and a revision check and its change can't interleave with another call.

Reconciliation (D10, D14, D35) runs on plugin start, on `quirky.session/changed` and `quirky.session/removed`, and after `pty.onReconnect`:
- A terminal or structured session of worktree W (or `floating`) held by no pane gets a new tab at the end of W's active group, (the queue guarantees sessions created by this plugin are already bound).
- A removed session's pane is removed (sibling promoted; first remaining pane active); an empty tab is removed (not offered for reopen); an empty group other than the last is removed.
- A session that becomes `exited` with exit code 0 and cause `exited`: its pane closes and the session is closed through `quirky.session/close`, unless it is a tab's only pane and never received driving input through `quirky.terminal/write` (then it stays). Any other exit keeps the pane; the workspace's pane entry carries `exit: {code, signal}` for the overlay. Cause `host-restart`/`host-lost` changes nothing (cold restore).
- Closed tabs record `{title (custom), color, cwd (start cwd), agent: 'shell'|<id>, closedAt}`, ten per workspace, newest first; tabs removed by a shell exit are not recorded.

Running-child detection (`QPT/src/processes.ts`): `runningChildOf(pid): {command: string} | null` from one `ps -A -o pid=,ppid=,comm=` call, the first direct child of the shell pid. Agent sessions (agent ≠ `shell`) count as running while their status isn't `exited`.

### Quick commands ([logic: Quick commands](logic.md#quick-commands))

`CONTRACT:` methods on `quirky.terminal`: `quickCommands {workspace?, all?}` (readOnly; the commands visible to that workspace's repo plus global ones, or every command with `all`), `addQuickCommand {label, kind?, agent?, command, appendEnter?, scope?: 'global'|'repo', repo?}`, `updateQuickCommand {id, ...same fields}`, `removeQuickCommand {id}` (destructive, confirm "Remove quick command {id}?"), `runQuickCommand {id, pane?, workspace?, group?}` (with `pane`: write into it; else a new tab). Each mutating call returns `{commands}` and emits `quickCommands {}`. Limits and normalization: label ≤ 80, command ≤ 4000, ≤ 40 commands, id from the label (lowercase, non-alphanumerics to `-`, ≤ 80), deduplicated with `-2`, `-3`; repo id ≤ 200; an agent command's agent must exist with `promptMode !== 'stdin-after-start'` (from `quirky.agents/get`). Running flattens with `; ` (trim each line, drop empty lines); new-tab runs write the flattened command plus `\r` right after the session is created (the host's shell-ready barrier holds it, m1-term-daemon D15); pane runs add `\r` only when `appendEnter`. The tab strip's choice: the group's `lastQuickCommand`, else the first repo command, else the first global one. Agent runs call `newTab {agent, prompt: command}`.

### Window ([logic: Behavior & scenarios](logic.md#behavior--scenarios))

- `QPT/src/ui.tsx` `activate` provides: `view:quirky.session/worktree` (the workspace view), `panel:quirky.terminal/quick-commands`, `overlay:quirky.terminal/floating`, every `command:` in the manifest, plus the overridden `command:quirky.session/*` entries.
- **View input** `{worktree, session?}`: on mount and whenever the input changes, a `session` that some pane of the workspace shows is focused through `focusPane {pane}` (which also activates its group and tab); an unknown session is ignored. The view never rewrites the layout's input.
- **View report** (`SCHEMA:` below) is sent after every render that changes it.
- **Pane layer** (`QPT/src/window/workspace/`): a tab's panes render as siblings in one flat container keyed by pane ID, each absolutely positioned from rectangles computed from the pane tree; the split tree renders only dividers. A split, close or move changes rectangles, never a pane's parent element, so no reshape remounts or reparents an xterm; the active pane is refocused after every reshape. Panes moved to another tab do remount (their tab changes) and reattach from the host.
- **Pane** (`QPT/src/window/pane/`): one component per mounted pane. It attaches with `quirky.terminal/attach {session, cols, rows, historyLines: scrollback}` and writes the replay through the ported input gate. Addons: fit, unicode11 (activated before the first write), search, web-links (custom handler), clipboard (OSC 52 when the setting allows; reads refused), WebGL while fewer than 12 panes hold a context (a module-level counter; on unmount the pane calls `WEBGL_lose_context.loseContext()` on its canvas's context before disposing the addon, and only then decrements; three losses in 60 s keep that pane on DOM). It sets `terminalFocus` on its xterm textarea's focus/blur only; the search box handles Enter, Shift+Enter, `⌘G`, `⌘⇧G` and Escape in its own keydown handler, since `terminalFocus` is false while it has focus. Resize: ResizeObserver plus rAF fit; PTY `resize` is sent only when cols/rows change and not while a drag is in progress (the workspace holds a "dragging" flag; on drag end each pane sends its final size once).
- **Keys inside the pane** (`attachCustomKeyEventHandler`): only the byte translations of D26 are handled there (returning false after writing the bytes); everything else passes to xterm. App shortcuts never reach xterm because the host's capture listener runs first.
- **Paste**: the pane handles `paste` events itself (prevents xterm's default), normalizes newlines to `\r`, wraps in `ESC[200~`/`ESC[201~` only when `term.modes.bracketedPasteMode`, and writes ≤ 64 KiB at once or 16 KiB chunks awaiting each `write`; > 16 MiB is refused with a toast; 30 s overall timeout.
- **Links**: a link provider for file paths (absolute, or relative to the pane's cwd from the `cwd` event or the session cwd) whose existence is checked through a batched daemon call `quirky.terminal/pathsExist {paths}` (readOnly, ≤ 50 paths, returns `{exists: boolean[]}`), wrapped so a throw returns no links; web-links for URLs; xterm's `linkHandler` for OSC 8.
- **Floating overlay**: renders a toggle button and, when `open`, a panel with the floating workspace using the same workspace components; geometry changes are local during drags and sent once through `setFloating`; it sets `floatingFocus` while focus is inside it.

## Data models / schemas

`SCHEMA:` workspace (method results and the stored row)
```
Workspace = { id: string /* worktree id or 'floating' */, revision: integer,
              root: GroupNode, activeGroup: string,
              closed: ClosedTab[] /* ≤10, newest first */ }
GroupNode = { kind: 'group', id: 'grp-<n>', tabs: Tab[], activeTab: string | null,
              recent: string[] /* tab ids, most recent first */, lastQuickCommand: string | null }
          | { kind: 'split', id: 'split-<n>', direction: 'right' | 'down', ratio: number, first: GroupNode, second: GroupNode }
Tab = { id: 'tab-<n>', defaultTitle: string, customTitle: string | null, liveTitle: string | null /* the active pane's latest OSC title */,
        color: 'none'|'blue'|'purple'|'pink'|'red'|'orange'|'yellow'|'green'|'teal'|'gray',
        pinned: boolean, root: PaneNode, activePane: string, expandedPane: string | null, createdAt: string }
PaneNode = { kind: 'pane', id: 'pane-<n>', session: string, title: string | null,
             exit: { code: number | null, signal: string | null } | null }
         | { kind: 'split', id: 'split-<n>', direction: 'right' | 'down', ratio: number, first: PaneNode, second: PaneNode }
ClosedTab = { title: string | null, defaultTitle: string, color: string, cwd: string, agent: string, closedAt: string }
```
Ratios are stored rounded to three decimals. `<n>` comes from one counter in the store (`meta` table), so IDs are unique across workspaces.

`SCHEMA:` store migrations (one array, in order)
```
1: CREATE TABLE imports (name TEXT PRIMARY KEY)            -- existing, unchanged
2: CREATE TABLE workspaces (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL)
3: CREATE TABLE quick_commands (id TEXT PRIMARY KEY, position INTEGER NOT NULL, data TEXT NOT NULL)
4: CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)   -- 'counter', 'floating'
```

`SCHEMA:` floating state
```
FloatingState = { enabled: boolean /* setting */, open: boolean, maximized: boolean,
                  bounds: { x: number, y: number, width: number, height: number } | null /* null = default placement */,
                  button: { x: number, y: number } | null }
```
Bounds are window-relative CSS px; width ≥ 420, height ≥ 280, else invalid-params.

`SCHEMA:` quick command
```
QuickCommand = { id: string, label: string, kind: 'terminal' | 'agent', agent: string | null,
                 command: string, appendEnter: boolean, scope: 'global' | 'repo', repo: string | null }
```

`SCHEMA:` view report (`view:quirky.session/worktree`)
```
{ worktree: string, active: string | null /* active pane's session */,
  tabs: [{ session: string, title: string, agent: string, status: DisplayStatus, tab: string, group: string, pane: string }],
  layout: Workspace, focusedPane: string | null,
  panes: [{ pane: string, session: string, cols: number, rows: number, fontSize: number, webgl: boolean,
            search: { query: string, regex: boolean, caseSensitive: boolean, current: number, total: number, more: boolean } | null,
            exitOverlay: boolean }],
  menu: { kind: string, target: string | null, items: [{ label: string, key: string | null, enabled: boolean, separator: boolean }] } | null,
  dialog: { kind: string, title: string } | null }
```
`tabs` lists one entry per pane of every tab in visual order (v1 callers read `tabs[i].session`). The floating overlay reports `{ state: FloatingState, layout: Workspace | null, focusedPane, panes }` with the same `panes` shape.

`CONFIG:` manifest additions to `QPT/quirky-plugin.json`
```
"overrides": [
  {"id": "view:quirky.session/worktree", "title": "Worktree"},
  {"id": "command:quirky.session/new-shell"}, {"id": "command:quirky.session/close-session"},
  {"id": "command:quirky.session/select-tab"}, {"id": "command:quirky.session/select-tab-1"} … "-9"
]
settings (id: type default [min..max] / values):
  font-family string "SF Mono"; font-size number 14 [10..24]; font-weight number 500 [100..900];
  font-weight-bold number 700 [100..900]; line-height number 1 [1..3]; cursor-style enum block [block,bar,underline];
  cursor-blink boolean true; scrollback number 2000 [500..10000] (existing); word-separators string " ()[]{}',\"`";
  option-as-alt enum auto [auto,both,left,right,off]; jis-yen-backslash boolean false;
  copy-on-select boolean false; trim-gutter-on-copy boolean true; allow-osc52 boolean true;
  right-click-paste boolean false; focus-follows-mouse boolean false; scroll-sensitivity number 1.15 [0.5..3];
  fast-scroll-sensitivity number 5 [1..10]; gpu-acceleration enum auto [auto,on,off];
  minimum-contrast number 1 [1..21]; inactive-pane-opacity number 0.9 [0..1]; divider-thickness number 3 [1..32];
  padding-x number 4 [0..512]; padding-y number 4 [0..512]; background-opacity number 1 [0..1];
  link-click enum actions [actions,open,terminal]; link-middle-click enum open [actions,open,terminal];
  confirm-close-running boolean true; confirm-close-pinned boolean true; ctrl-tab-order enum mru [mru,sequential];
  shortcut-policy enum app-first [app-first,terminal-first]; floating-enabled boolean true; floating-cwd string "~"
```

`CONFIG:` default keybindings added by `quirky.terminal` (`when` in brackets; `T` = `terminalFocus`)
```
mod+c copy [T]; mod+a select-all [T]; mod+v paste [T]; mod+f search [T]; mod+g search-next [T];
mod+shift+g search-previous [T]; mod+k clear [T]; mod+] focus-next-pane [T]; mod+[ focus-previous-pane [T];
mod+shift+enter toggle-expand-pane [T]; mod+w close-pane [T]; mod+d split-right [T]; mod+shift+d split-down [T];
mod+= zoom-in [T]; mod+shift+= zoom-in [T]; mod+- zoom-out [T]; mod+0 zoom-reset [T];
mod+r rename-tab; mod+shift+t reopen-tab; mod+alt+] next-tab; mod+alt+[ previous-tab;
mod+shift+] next-tab; mod+shift+[ previous-tab; ctrl+tab recent-tab; ctrl+pagedown next-tab;
ctrl+pageup previous-tab; ctrl+1..ctrl+9 select-tab-N; mod+alt+a toggle-floating; mod+alt+shift+a maximize-floating
```
`mod+t` (`new-shell`), `mod+w` (`close-session`) and `mod+1..9` (`select-tab-N`) stay `quirky.session`'s bindings, now running `quirky.terminal`'s overriding commands: `new-shell` opens a tab in the focused workspace (floating when `floatingFocus`), `close-session` closes the focused pane (or the tab when it has one pane). Commands without keys: `equalize`, `set-pane-title`, `clear-pane-title`, `reset-terminal`, `toggle-quick-commands`, `search-close`, `manage-quick-commands`, `minimize-floating`. Window-only commands take args where an agent needs them and return results as JSON: `search {query?, regex?, caseSensitive?}`, `zoom-in|zoom-out|zoom-reset {pane?}`, `copy {pane?}` → `{text}`, `select-all {pane?}`, `paste {text, pane?}` (the same chunked path as a real paste), `open-menu {kind: 'tab'|'pane'|'plus'|'quick-commands', target?}` and `close-menu` (the report's `menu` then lists the open menu's items).

`CONFIG:` CLI words (group `terminal`, alias `term`)
```
layout [--worktree W] [--json]
tab new [--worktree W|--workspace floating] [--agent A] [--cwd D] [--title T]
tab close <tab> | tab close-others|close-right|close-left <tab> | tab rename <tab> <title>
tab color <tab> <color> | tab pin <tab> | tab unpin <tab> | tab reopen [--worktree W]
tab move <tab> [--group G --index N | --split right|left|down|up [--of G]]
tab activate <tab> | tab activate --index N [--group G] | tab next | tab previous
pane split [pane] --direction right|down | pane close [pane] | pane restart [pane]
pane focus <pane> | pane focus --next|--previous | pane title [pane] <title>
pane expand [pane] | pane collapse [pane] | pane equalize --tab T | pane resize [pane] --ratio R
pane move <pane> (--to-pane P --edge left|right|top|bottom | --to-tab T) | pane clear [pane] | pane reset [pane] | pane get [pane]
group close <group> | group resize <group> --ratio R (the group's share) | group resize --split S --ratio R
quick-command list [--all] | add --label L --command C [--kind terminal|agent] [--agent A] [--no-enter] [--scope global|repo]
quick-command update <id> [...] | remove <id> | run <id> [--pane P]
floating state | show | hide | toggle | maximize | restore | bounds --x --y --width --height
open-link <url-or-path> [--reveal]
```
`[pane]` defaults to the pane showing `$QUIRKY_SESSION_ID`; `pane resize` resolves the pane's parent split and sets the pane's share. Every command supports `--json`.

## DO-NOT-CHANGE fences

- `docs/loop/LOOP.md`, `scripts/build-loop/**`, `docs/loop/queue.json`, `docs/loop/DECISIONS.md`: protected by the loop; touching them pauses it.
- `QPS/src/window/**` (the fallback view, its tabs and pane) and `QPS/test/ui.test.ts`: kept as the fallback view (D6) and edited by other lanes; port code from them, don't move or rewrite them.
- `packages/pty-host/src/history/log.ts` existing record kinds and offsets: cold restore and paging (m1-term-daemon) depend on them; only add the `clear` kind.
- The kernel `RESERVED_CHORDS` (`mod+shift+p`, `packages/protocol/src/ui.ts:221`): the palette depends on it; no `when` makes a reserved chord usable.
- `plugins/quirky.worktree/**`: lane 3 is rewriting it; floating resolution lives in `quirky.session` instead.

## Always / Ask / Never

**Always**
- Change layout only through `LayoutService` methods, each one transaction plus one revision bump plus one `layout` event.
- Key panes by pane ID so a reshape never disposes an xterm.
- Use a fresh temporary `QUIRKY_HOME` and temp `HOME` in every test that starts a process, and kill what it started; set `QUIRKY_TEST_OPEN_LOG` in any test that can reach `openExternal`.
- Validate bounds in code where the manifest schema subset can't (string lengths, ratios), as m1-launch-settings D31 found.

**Ask** (implementer's choice, record it in the task report)
- React component split inside `QPT/src/window/**`.
- The exact drag preview visuals, as long as the zones and thresholds hold.

**Never**
- Import another plugin's source (SC-24 fence); use `context.call`, `mountView` and events.
- Write to the real `~/.quirky`, `~/.claude` or `~/.codex`, or open a real browser or Finder window from a test.
- Send a PTY `resize` per frame during a drag.

## Cross-cutting

- **Security:** `openExternal` accepts only `http:`, `https:`, `mailto:` URLs and absolute paths, passes them as one argv element (never through a shell), and refuses anything else with invalid-params. OSC 52 writes are capped at 128 KiB of base64 and reads are never answered. Paths typed on drop are single-quote escaped.
- **Migration:** existing sessions get tabs by reconciliation on first start, one tab per session in `createdAt` order. The v1 report fields stay.
- **Rollback:** a distro disabling the overrides gets `quirky.session`'s view back (SC-70); the store tables are ignored by older builds.
- **Observability:** reconciliation logs one line per repaired workspace; the floating and layout events carry revisions so tests can wait for them.

## Testing strategy

- `packages/protocol/test/ui.test.ts`: `parseWhen`/`evaluateWhen`/`whenMentions`, kind lists.
- `packages/daemon/test/plugins/{ui-kinds,ui-model,layout}.test.ts`: `when` validation, per-`when` resolution, overlays in model and state.
- `packages/ui/test/plugin-host-unit.test.ts`: `setContext`, `mountView`, `when` dispatch, terminal-first rule; `packages/ui/test/layout-shell.test.ts`: overlay layer.
- `packages/daemon/test/` dispatcher/confirm tests: null describe runs without an ask; string still asks.
- `packages/pty-host/test/{host,manager}.test.ts`, `packages/daemon/test/pty-client.test.ts`: `clear` and `resetModes` (history, snapshot, replay and cold restore after each), protocol 3.
- `QPS/test/`: `cwd` param, floating selector, structured view provide.
- `QPT/test/layout-tree.test.ts` (pure): split, close, promote, move with edges, equalize weights, zone math, ratio clamps, ID allocation.
- `QPT/test/layout-service.test.ts` (plugin harness with fake session plugin and fake PTY host): every method, revision conflicts, reconciliation cases, exit rules, closed tabs, describeClose.
- `QPT/test/quick-commands.test.ts`: normalization, limits, scope, run paths.
- `QPT/test/window/*.test.ts` (happy-dom with a fake context in `QPT/test/ui-fake.ts`, modelled on `QPS/test/ui-fake.ts`): pane (attach, addons, search counts, paste chunking, link clicks, byte translations, zoom), workspace (menus, dialogs, drags, report shape).
- `QPT/test/e2e/*.test.ts` (real daemon and PTY host via `QPT/test/e2e-support.ts`, headless window from `packages/ui/test/fixtures/headless-window.ts` where a scenario is (UI)): one named test per SC-1…SC-75, named `SC-<n>: <title>`.
- `packages/ui/test/exit.e2e.test.ts`: still passes (SC-35 of m0-core reads `worktree`, `active`, `tabs`).
- Agent-launching tests use the fake agent CLIs and isolated `PATH` from `plugins/quirky.agents/test/support/e2e.ts` (`startAgentsE2E`).
- Acceptance bar: `bun run test`, `bun test scripts`, `bun run typecheck` pass; every SC has a test; the like-a-user web pass covers the (UI) scenarios.

## Non-goals

Everything in the logic spec's [Scope & non-goals](logic.md#scope--non-goals), plus: no change to how `quirky.session` stores sessions; no Linux/Windows key column; no daemon-side terminal search.
