# Notifications: tech spec

**Status:** Draft for build. Logic spec: [logic.md](logic.md). Decisions: [m1-notifications.md](../../../loop/decisions/m1-notifications.md).

Paths are relative to the repo root. Line numbers are from commit 8650dbc and drift; find the
symbol, not the line.

## Architecture

Seven units, built in waves (see [Build waves](#build-waves)):

| Unit | Where | Owns |
|---|---|---|
| K: kernel window presence and notify sound | `packages/protocol`, `packages/daemon`, `packages/ui` | `ui.window.activity`, `ui.window.changed`, `UiWindowInfo.present`, `sound` on `notify` |
| P: OSC notification fact | `packages/pty-host`, `packages/protocol/src/pty.ts`, `plugins/quirky.terminal` | the `notification` fact and `quirky.terminal/notification` |
| R: producers report | `plugins/quirky.agent-status`, `plugins/quirky.structured`, `plugins/quirky.ask` | `settled` events; no producer calls `context.notify` |
| M: markers on records and in the UI | `plugins/quirky.session`, `plugins/quirky.worktree`, `packages/ui/src/styles.css` | `Session.unread`, `setUnread`, `visibleSessions`, the bells |
| N: the notifications plugin | `plugins/quirky.notifications/` (new) | policy, markers, gates, cooldown, text, sounds, status, methods, CLI, settings view |
| S: sound files | `plugins/quirky.notifications/sounds/`, its generator script | nine WAVs |
| D: desktop shell | `apps/desktop` | banner, afplay, tray dot and menu, Show Menu Bar Icon, badge, quit reset, asset bundling |

Flow: producer event → N (via `context.subscribe`) → `ui.state` read → markers through
`quirky.session/setUnread` and `quirky.worktree/set` → `quirky.notifications/attention` and
`decided` events → gates → `context.notify({…, sound})` → kernel `notify` event → D (banner,
afplay) and the webview (toast). N recomputes the badge and emits `quirky.notifications/changed`;
D reads `quirky.notifications/status`.

Back-links: [Conceptual model](logic.md#conceptual-model), [Data flow](logic.md#data-flow).

## Code references

### K: kernel

- `packages/protocol/src/rpc.ts`: method map near `'ui.window.focused'` (line 99); `QuirkyEvent`
  union near `ui.state.changed` (line 140); `notify` event (lines 127-136).
- `packages/protocol/src/kernel-schemas.ts`: `CONNECTION_METHODS` (line 12), `ui.window.focused`
  schema (387-391), `KERNEL_EVENT_SCHEMAS` (447-), `notify` schema (448-461).
- `packages/protocol/src/ui.ts`: `UiWindowInfo` (156), `UiState` (169).
- `packages/protocol/src/plugins.ts`: `PluginNotification` (128-137).
- `packages/protocol/test/kernel-schemas.test.ts`: `EVENT_TYPES` (6-12) and the assertion at 113;
  `packages/daemon/test/plugins/api-describe.test.ts:69`.
- `packages/daemon/src/methods.ts`: `ui.window.focused` handler (240-245).
- `packages/daemon/src/plugins/layout.ts`: `windowFocused` (165-173), `windows()` (233-244),
  `dropConnection` (~213), `change()` broadcast (285-290); options `broadcast` (24-).
- `packages/daemon/src/types.ts`: `ClientConn.focusedAt` (14-15).
- `packages/daemon/src/notify.ts`: `Notifier` (3), `osascriptNotifier` (15), `sendNotification` (38-55).
- `packages/daemon/src/service.ts`: `Core.notify` (109-117).
- `packages/daemon/test/helpers.ts`: fake notifier (34-39).
- `packages/ui/src/shell.ts`: `browserWindowFocus` (8-23), `ShellOptions` (30, 51).
- `packages/ui/src/plugins/host.ts`: `HostDeps.windowFocus` (31), subscription (167), `connected()` (182), `reportFocus` (765-768).
- `packages/ui/src/main.tsx:11`.

### P: OSC fact

- `packages/pty-host/src/scanner.ts`: `ScanFact` (2-10), `MAX_OSC_PAYLOAD` (20), `MARKER` (21),
  `finishOsc` (193-205), `reportOsc` (207-229).
- `packages/protocol/src/pty.ts`: `PtyFact` (22-28).
- `packages/pty-host/src/session.ts`: `applyFact` (577-598).
- `plugins/quirky.terminal/src/terminal.ts`: `factEvent` (37-51); `plugins/quirky.terminal/main.ts:27-30`;
  manifest `bell` event (`quirky-plugin.json:567`).
- Tests: `packages/pty-host/test/scanner.test.ts` (bell 33, 777 passthrough 100-112, cap 122);
  `plugins/quirky.terminal/test/fact-event.test.ts`.

### R: producers

- `plugins/quirky.agent-status/src/apply.ts`: `ApplyResult` (21-26), notify computation (262-264).
- `plugins/quirky.agent-status/src/service.ts`: call site (256, 273), `commit` (277-282), `notify()` (465-483), setting read (481).
- `plugins/quirky.agent-status/quirky-plugin.json`: `notifications` setting (268-273), `changed` event (284).
- `plugins/quirky.agent-status/src/store.ts`: `NOTIFICATIONS_SETTING` (7), v1 import (32-62).
- `plugins/quirky.agent-status/src/types.ts`: `AgentRow` (34-74), `Outcome` (5).
- `plugins/quirky.agent-status/test/agent-status.test.ts`: `describe('notifications')` (438-526); `test/support.ts` `notifies`/`waitForNotifies` (158-160).
- `plugins/quirky.structured/main.ts`: `NOTIFICATIONS_SETTING` (23), `notifyEnabled` (50-56), `setStatus` (58-79), `LiveSession` (25), `appendMessage` (42); tests `test/structured.test.ts:141-168`.
- `plugins/quirky.ask/main.ts`: `announce` (26-32), calls (50, 54); tests `test/asks.test.ts:42-77`, `test/panel.test.ts:34-36`.
- `packages/daemon/src/v1-settings.ts:28-31` (v1 `notifications` import).

### M: markers

- `plugins/quirky.session/quirky-plugin.json`: `setStatus` (854), `changed` (978), `removed` (1075).
- `plugins/quirky.session/src/sessions.ts`: `setStatus` (314-331), `close` (300-310), `publish` (459-462).
- `plugins/quirky.session/src/records.ts`: row type (37), `toSession` (68), `sessionMigrations` (106-146), `insert` (180, 201), `update` (223, 238).
- `packages/protocol/src/model.ts`: `Session` (190-217), `Worktree` (25-, `unread` at 42).
- `plugins/quirky.session/src/window/SessionTabs.tsx` (32-38), `StatusDot.tsx` (21), `model.ts` (`SessionViewReport` 7-11, `report()` 95-108, `syncDaemonLayout` 238-258), `src/ui.tsx` (31-44).
- `plugins/quirky.worktree/src/Tree.tsx`: `WorktreeCard` (39), `open()` (40-43), status dot (55), name (56), `.unread-mark` (59); `src/StatusDot.tsx` (16); `src/report.ts` (`unread`).
- `packages/ui/src/styles.css`: glyph styles (213-312), `.unread-mark` (1154-1160).
- Tests to update: `plugins/quirky.worktree/test/ui.test.ts:399-405`, `test/window-tree.test.ts:192-220`.

### N, S: the new plugin

- Model manifest: `plugins/quirky.agent-status/quirky-plugin.json`; model view plugin: `plugins/quirky.agents` (view `quirky.agents/settings`, `src/window/`).
- Plugin context: `packages/protocol/src/plugins.ts:49-78`; UI context `packages/protocol/src/ui.ts:181-212`.
- Manifest validation: `packages/daemon/src/plugins/kinds.ts` (`ALLOWED_FIELDS` 18-24), `ui-kinds.ts` (`checkSetting` 88-123: `default` is required).
- CLI module model: `plugins/quirky.agent-status/cli.ts`; `packages/protocol/src/cli.ts:32-34`.
- Import fence: `plugins/test/imports.test.ts:59`.
- E2E harness: `plugins/quirky.agents/test/support/e2e.ts:117` (`startAgentsE2E`), `plugins/quirky.agent-status/test/e2e/support.ts:28` (`startStatusE2E`, `shim`), `plugins/quirky.terminal/test/e2e-support.ts:165` (`E2eHarness`, `h.run`, `h.events`).

### D: shell

- `apps/desktop/src/bun/index.ts`: tray (76-89), badge updater (91-99), `onConnected` (121-129), `showWindow` (69-74), `createWindow` (56-67).
- `apps/desktop/src/bun/events.ts`: `notificationFor`, `badgeCount`, `badgeLabel`, `shouldRefreshBadge`, `loadBadgeInputs`, `createBadgeUpdater`.
- `apps/desktop/src/bun/dock.ts:30` `setDockBadge(label)`.
- `apps/desktop/types/electrobun-main.d.ts` (stub).
- Electrobun SDK: `~/.hutch/releases/electrobun/2.0.4/macos-arm64/api/sdks/main/core/Tray.ts`, `core/Utils.ts:67`, `core/BrowserWindow.ts:306-350`, `events/windowEvents.ts`, `events/ApplicationEvents.ts`.
- `apps/desktop/scripts/bundle-plugins.ts:46-66`, `apps/desktop/scripts/bundle.ts:~54`; test `apps/desktop/test/bundle-plugins.test.ts:61`, `apps/desktop/test/events.test.ts`.

## Contracts and interfaces

### K1: window activity and presence

Back-link: [Conceptual model, viewing](logic.md#conceptual-model); D10, D11.

`CONTRACT:`
```
rpc 'ui.window.activity': { params: Record<string, never>; result: Ok }   // role 'ui' only; a CONNECTION_METHOD
UiWindowInfo = { connId: number; name?: string; focused: boolean; inputAt: number | null; present: boolean }
event { type: 'ui.window.changed'; windows: UiWindowInfo[] }
const DESKTOP_AWAY_MS = 180_000   // exported from @quirky/protocol
```

- `ui.window.activity` sets `conn.inputAt = Date.now()`. Non-window connection: `invalidParams`, as `windowFocused`.
- `present` is `inputAt !== null && now - inputAt < awayMs`. `awayMs` is `DESKTOP_AWAY_MS` unless the daemon was started with `QUIRKY_DESKTOP_AWAY_MS` (a positive integer; for tests).
- `ui.window.changed` is broadcast when a window's `focused` value changes, when an activity report turns a window from not present to present, and when a window connection drops. Not on every activity report.
- Window side: `HostDeps.windowActivity?: { subscribe(listener: () => void): () => void }`; `shell.ts` provides it from `pointerdown`, `pointermove`, `keydown` and `wheel` on `window` (capture). The host calls `ui.window.activity` on the first input and then at most once per 15 s while input continues (leading edge), and once on (re)connect if input happened in the last 15 s. Errors are swallowed like `reportFocus`.

### K2: notify sound

Back-link: [Data flow 5](logic.md#data-flow); D18, D19.

`CONTRACT:`
```
PluginNotification += { sound?: { file: string | null; volume: number } }
notify event       += { sound?: { file: string | null; volume: number } }   // schema: optional
Notifier = (n: { title: string; body: string; sound?: { file: string | null; volume: number } }) => void
```

- `file: null` means the system sound; `volume` is 0-100. Absent `sound` means silent.
- `osascriptNotifier` adds `sound name "default"` only when `sound.file === null`; it never plays files (N does, P-independent).
- `sendNotification` passes the whole notification to the notifier. Existing behaviour (broadcast always; notifier only with `desktop !== false` and no desktop client) is unchanged.

### P1: the notification fact

Back-link: [Program notifications (OSC)](logic.md#program-notifications-osc); D28.

`SCHEMA:`
```
ScanFact |= { kind: 'notification'; title: string | null; body: string; occasion: 'always' | 'unfocused' | 'invisible' }
PtyFact  |= the same
quirky.terminal event 'notification' data: { sessionId: string; title: string | null; body: string; occasion: 'always' | 'unfocused' | 'invisible' }
```

Parsing in `reportOsc` (code is the text before the first `;`):

- **9:** the rest is the text. `REGEX:` `^\d+(;|$)` on the rest means a ConEmu subcommand: no fact. Otherwise `{title: null, body: clean(rest)}`.
- **777:** the rest must start `notify;`; title is the field after it, body the remainder (may contain `;`). Other 777 payloads: no fact. `MARKER` handling in `finishOsc` is unchanged and runs first.
- **99:** `99;<metadata>;<payload>`; metadata is `:`-separated `k=v`. Keys used: `i` (id, default none), `d` (`0` = more chunks, anything else done; default done), `e` (`1` = base64 UTF-8), `p` (`title` default, `body`; any other value: ignore the sequence entirely), `o` (`always` default, `unfocused`, `invisible`; anything else: `always`). Unknown keys ignored. Chunks with the same `i` and `d=0` accumulate title and body (concatenated per field) until a chunk with done; a chunk without `i` completes on its own. Pending ids are capped at 16 per session (oldest dropped). Invalid base64: drop the chunk. Nothing is written back to the PTY.
- `clean(text)`: remove U+0000-U+001F, U+007F and U+0080-U+009F (tabs and newlines become spaces first), collapse runs of whitespace to one space, trim, cut to 256 code points with a trailing `…`, never splitting a surrogate pair. A fact needs a non-empty body or title; if only a title, body is `''`.
- Bytes are not stripped or held; they pass through as today. `MAX_OSC_PAYLOAD` still applies.
- `applyFact` emits `notification` facts like other facts. No PTY protocol version change unless the host handshake rejects unknown fact kinds (check `packages/pty-host/src/server.ts` and the daemon's PTY client; if it does, bump as m1-term-daemon did).
- `factEvent` maps it to `notification` with the session; the manifest declares the event with the schema above.

### R1: settled events

Back-link: [Delivery gates](logic.md#delivery-gates), [Banner text](logic.md#banner-text); D6, D31, D32.

`SCHEMA:`
```
quirky.agent-status/settled: { sessionId: string; worktreeId: string; agent: string; state: 'done' | 'waiting' | 'blocked';
  outcome: 'success' | 'cancellation' | 'failure' | null; interrupted: boolean; prompt: string | null;
  toolName: string | null; toolInput: string | null; lastAssistantMessage: string | null; at: number }
quirky.structured/settled: { sessionId: string; worktreeId: string; agent: string; state: 'done' | 'waiting';
  lastAssistantMessage: string | null; at: number }
```

- agent-status: `ApplyResult.notify` becomes `settled: 'done' | 'waiting' | 'blocked' | null` with the same condition (`stateChanged && settled && !ev.replay && n.sessionBoundary !== true`), and `blocked` kept distinct. Also emit `settled` from the title (`handleTitle`) and OSC 7501 (`handleReport`) paths when their commit moves the row into done, waiting or blocked from another state. `settled` is emitted after `commit`. `agent` is the session's agent id (`session.agent`); `toolInput` is the row's readable tool input. `notify()` and every `context.notify` call are removed; the `notifications` setting is removed from the manifest and `store.ts`'s v1 import of it is removed (N migrates it, below).
- A row that is not done (children or background work still running) never emits `settled: 'done'` (SC-17); this is the existing fold, asserted by a test.
- structured: `setStatus`'s done/waiting branch emits `settled` instead of `context.notify`; `notifyEnabled` and `NOTIFICATIONS_SETTING` go. `lastAssistantMessage` is the latest assistant message's text appended for that session in this activation, or null. `agent` is `'claude'` (the only structured agent today).
- ask: `announce` is removed; `created` and `surfaced` events are unchanged.

### M1: session unread

Back-link: [Unread markers](logic.md#unread-markers); D9, D35, D36.

`CONTRACT:`
```
Session += { unread?: 'agent' | 'bell' | 'notification' | null }
method quirky.session/setUnread: params { session: string; unread: 'agent' | 'bell' | 'notification' | null } → Session
```

- Migration 6 adds `unread TEXT` (null). `setUnread` NotFound for an unknown session; emits `changed {session}` only when the value changes. `quirky session` text output shows `unread <reason>` when set.
- `SessionViewReport += { visibleSessions: string[] }` — today `[active]` or `[]`.
- Tab: when `session.unread` is set, `SessionTabs` renders a bell glyph in place of `StatusDot`: `role="img"`, `className` includes `glyph-unread`, `aria-label` "Unread agent completion" | "Unread bell" | "Unread notification". Amber (`#f59e0b` family, a theme token if one exists).
- Card: `Tree.tsx` renders the same bell (`aria-label="Unread"`) in place of `StatusDot` when `worktree.unread`, adds a bold class to `.worktree-name`, and drops `.unread-mark` (and its CSS). `open()` keeps clearing `unread` through `quirky.worktree/set` (N treats it as Mark Read, below).

### N1: the plugin

Back-link: every section of [Behavior and scenarios](logic.md#behavior-and-scenarios).

Manifest `plugins/quirky.notifications/quirky-plugin.json`: `id: quirky.notifications`, `activation: startup`, `main: main.ts`, `cli: cli.ts`, `ui: dist/ui.js`, `dependencies: ["quirky.session", "quirky.worktree"]`.

`CONFIG:` settings (`setting:quirky.notifications/<id>`), titles and descriptions from D8 and Orca:

| id | type | default | notes |
|---|---|---|---|
| enabled | boolean | true | "Enable Notifications" |
| agentTaskComplete | boolean | true | "Agent Task Complete" |
| terminalBell | boolean | false | "Terminal Bell" |
| terminalNotifications | boolean | true | "Terminal Notifications" |
| sound | enum | system | values `system two-tone bong thump blip sonar blop ding clack beep custom` |
| customSoundPath | string | "" | empty means none |
| volume | number | 100 | minimum 0, maximum 100 |
| suppressWhenFocused | boolean | true | "Suppress While Focused" |
| showMenuBarIcon | boolean | true | "Show Menu Bar Icon" |

`CONTRACT:` methods (all with params/result schemas in the manifest)
```
status  (readOnly) {} → { badge: number; label: string; unreadWorktrees: { id: string; name: string }[];
                          unreadSessions: { id: string; worktreeId: string; reason: 'agent'|'bell'|'notification' }[];
                          pendingAsks: number; sound: { ok: true } | { ok: false; reason: string } }
send    { body: string; title?: string; session?: string; worktree?: string } → { delivered: boolean; reason: Reason }
test    {} → { delivered: boolean; reason: Reason }
preview { sound?: SoundId; path?: string; volume?: number } → { played: boolean; reason?: string }
Reason = 'delivered' | 'disabled' | 'source-disabled' | 'suppressed-focus' | 'cooldown'
```

`CONTRACT:` events
```
changed   { badge: number }                                     // when the status result changes
attention { source: 'agent' | 'bell' | 'program'; sessionId: string | null; worktreeId: string | null }
decided   { source: 'agent' | 'bell' | 'program' | 'ask' | 'test'; sessionId: string | null; worktreeId: string | null; result: Reason | 'superseded' | 'dropped' }
sound     { file: string; volume: number }                       // preview, for the shell
```

`CONTRACT:` CLI group `quirky notifications` (`cli.ts`): `status [--json]` (text: `badge N`, then one line per unread worktree and session, then `asks N`, then `sound ok|<reason>`); `send --body B [--title T] [--session S | --worktree W] [--json]` (prints the reason); `test [--json]`; `preview [--sound ID] [--path P] [--volume N] [--json]` (prints `played` or the reason). Selectors for `--session` and `--worktree` resolve like other groups (worktree selector through `quirky.worktree/resolve`).

UI: `view:quirky.notifications/settings` (title "Notifications") and `command:quirky.notifications/open-settings` ("Open notification settings").

#### N2: viewed

- On each decision and on `ui.window.changed`, `ui.state.changed`, `quirky.session/changed`, `quirky.session/removed`, N reads `ui.state`.
- Focused window: `windows.find(w => w.focused)`. Attended: focused and `present`.
- Shown worktree: `layout.view.id === 'view:quirky.session/worktree'` → `input.worktree`. Visible sessions: the focused window's report for that slot, `visibleSessions` when its `worktree` equals the shown worktree, plus `input.session` when set.
- Session viewed = attended and in visible sessions. Worktree viewed = attended and shown. Worktree open in a focused window (for `suppressed-focus`) = focused (presence not required) and shown.
- Auto-read: for each attended visible session with `unread`, `setUnread(null)`; if the shown worktree is unread, `quirky.worktree/set {unread:false}` as an own write.

#### N3: deciding an event

Sources: `quirky.agent-status/settled` and `quirky.structured/settled` → agent; `quirky.terminal/bell` → bell; `quirky.terminal/notification` and `send` → program; `quirky.ask/created` (ask `queued === false` and envelope status `pending`) and `quirky.ask/surfaced` → ask; `test` → test.

1. Occasion (program only): `unfocused` and a window is focused → `decided: dropped`, stop. `invisible` and the session is viewed → `dropped`, stop.
2. Markers (agent, bell, program): session (if any) not viewed → `setUnread(reason)`; its worktree not viewed → `quirky.worktree/set {unread:true}` as an own write. A `send` with only `--worktree` marks only the worktree.
3. `attention` event (agent, bell, program).
4. Bell only: hold 250 ms; if an agent event for the same session is decided in that time, `decided: superseded` and stop.
5. Gates in order (D13): `enabled` false → disabled; source switch (agent: `agentTaskComplete`; bell: `terminalBell`; program: `terminalNotifications`; ask and test: none) → source-disabled; `suppressWhenFocused` and the event's worktree is open in a focused window (not for test) → suppressed-focus; cooldown (not for test) → cooldown.
6. Delivered: `context.notify({title, body, sessionId?, worktreeId?, open: {view: 'view:quirky.session/worktree', input: {worktree, session}} when both exist, sound})`. When no client with role `desktop` is connected (`status.get`), N also plays the file itself (N5).
7. Emit `decided` with the result. `send` and `test` return it.

Cooldown: `Map<string, number>` keyed by worktree id or `'global'`, 5000 ms from the last delivered banner, max 50 keys (drop the oldest), reserved at delivery time.

Mark Read: on `quirky.worktree/changed` for W, N re-reads W; if its `unread` went from true to false and the change is not one of N's own pending writes (track ids written and consume one on the next observed change), clear every session of W with `setUnread(null)`.

Migration: on first activation (a store flag), if `setting:quirky.agent-status/notifications` has a stored `false` (read the settings store row; the setting is no longer declared) or the v1 settings file has `notifications: false` (`packages/daemon/src/v1-settings.ts`), set `agentTaskComplete` false. If the kernel offers no way to read an undeclared setting's stored value, add one to the kernel (read-only, plugin-scoped) rather than reading SQLite directly.

#### N4: banner text

Pure module `src/text.ts`; D16, D17, D29.

- `context = repo ? `${repo} / ${worktree}` : worktree`; repo label is `displayName ?? name` from `quirky.repo/resolve {selector: repoId}`, omitted for folder workspaces and `group:` repos; cut to 80.
- Agent label from `quirky.agents/get {agent}` `.label`, else the id capitalised; cut to 40.
- Status word table in [SC-19](logic.md#banner-text). Title `${context} - ${label} ${status}`.
- Body order: last message (180) → `Using ${tool}: ${input}` → `Using ${tool}` → `Tool input: ${input}` → `${label} ${status}.`; each cut to 180.
- Bell: `Bell in ${worktree || 'workspace'}` / `${repo} · Attention requested` or `Attention requested`.
- Program: `${worktree}: ${title}` or `Notification in ${worktree}`; body as given (already cleaned). No worktree: `Quirky: ${title}` / `Notification`.
- Test: `Quirky notifications are on` / `This is a test notification from Quirky.`.
- Ask: `ask.spec.title ?? 'Question'` / first question text.
- `cut(text, n)`: collapse whitespace, trim, at most `n` code units including a trailing `…`, never ending on a lone high surrogate.

#### N5: sounds

- `SoundId = 'system' | 'two-tone' | 'bong' | 'thump' | 'blip' | 'sonar' | 'blop' | 'ding' | 'clack' | 'beep' | 'custom'`; labels "System Default", "Two Tone", "Bong", "Thump", "Blip", "Sonar", "Blop", "Ding", "Clack", "Beep".
- Built-in file: `join(context.dir, 'sounds', `${id}.wav`)`.
- Custom check, in order, with these exact reasons: not absolute → "must be an absolute path"; missing → "does not exist"; extension not in `.ogg .mp3 .wav .m4a .aac .flac` (case-insensitive) → "must be .ogg, .mp3, .wav, .m4a, .aac or .flac"; larger than 10 MiB → "is over 10 MiB"; unreadable → "could not be read".
- Delivery sound: `system` → `{file: null, volume}`; built-in → `{file, volume}`; custom passing the check → `{file, volume}`; custom failing → no `sound` (silent) and `status.sound` reports the reason.
- Player: `QUIRKY_SOUND_PLAYER` env (an executable called with `<file> <volume 0-100>`) when set, else `afplay -v <volume/100> <file>`; spawned without waiting, stdio ignored, errors logged. Tests always set `QUIRKY_SOUND_PLAYER`.
- `preview`: resolves the sound (`path` implies custom), checks it, then emits `sound {file, volume}` and, with no desktop client, plays it itself. `system` → `{played: false, reason: "System Default has no preview"}`.

#### N6: settings view

`src/ui.tsx` + `src/window/`. Orca's page (D21) over the declared settings via `context.getSetting` and `setting.set`:

- Subtitle "Native desktop notifications for agent activity and terminal events."; rows in SC-47 order with D8 descriptions.
- Enable off: the dependent controls get `disabled` and a dimmed class; Show Menu Bar Icon does not (SC-49).
- Sound select: picking a built-in sets `sound` and calls `preview`. "Choose Custom File" shows a path input and a Use button; Use calls `preview {path}`; `played` → set `customSoundPath` then `sound = custom`; else show the reason under the field. `Custom: <path>` shows only while `sound === 'custom'` (SC-48).
- Volume: `<input type="range" min=0 max=100 step=5 aria-label="Notification sound volume">`, shown only when `sound !== 'system'`; saved on `change`, not `input`.
- Send Test Notification: calls `test`, toasts per [SC-50](logic.md#the-window).
- The view reports its state (`ui.report`): settings values and the custom-path error, for `quirky ui state`.

### S1: sound files

- `plugins/quirky.notifications/scripts/make-sounds.ts` writes `sounds/<id>.wav` for the nine built-ins: 16-bit PCM mono 22050 Hz, ≤ 0.6 s, peak ≤ -3 dBFS, short fade-in and fade-out. Deterministic (no randomness). The files are committed.
- Shapes: two-tone two steps (e.g. 880 then 660 Hz); bong low decaying tone; thump very low short thud; blip short high sine; sonar sweeping ping with echo; blop falling pitch drop; ding bright bell with harmonics; clack short noise-free click burst made of square partials; beep square-ish 1 kHz. Exact frequencies are the implementer's.
- A test regenerates into a temp dir and compares bytes with the committed files, and checks each header.

### D1: shell

Back-link: [Badge and tray](logic.md#badge-and-tray); D19, D24, D25, D39, D42.

- `events.ts`: `notificationFor` returns `{title, body, silent, soundFile, volume}`: `silent` is false only when `sound` is present with `file: null`; `soundFile` is `sound.file` when it is a string, else null. `badgeCount`/`loadBadgeInputs` are replaced by `loadBadge(call)` reading `quirky.notifications/status` (`MethodNotFound` → 0); `shouldRefreshBadge` becomes `quirky.notifications/changed` and `plugin.changed`.
- Sound: `playSound(file, volume)` via `QUIRKY_SOUND_PLAYER` or `afplay -v`, `Bun.spawn` unref'd, try/catch. Called after `Utils.showNotification` for delivered events with a file, and for `quirky.notifications/sound` events.
- Tray: a pure `trayState` reducer in `events.ts` (unit-tested) with inputs `attention`, `window focused`, `window visible` (`isVisible() && !isMinimized()`), `showMenuBarIcon`; outputs `{visible: boolean, dot: boolean}`. Attention event while the window isn't visible → dot; window `focus` event → no dot. Attention while visible → no dot.
- Rendering: normal `new Tray({title: 'Q'})`; with dot, the tray is replaced by `new Tray({title: 'Q', image: <amber dot png>, template: false, width: 16, height: 16})` (`remove()` then create; re-apply menu and handler). Show Menu Bar Icon off → `setVisible(false)` (or remove); on → visible. The setting is read with `setting.get` on connect and followed through `setting.changed`.
- Menu: `[Show Quirky] [divider] [Settings…] [divider] [Quit Quirky]`; Settings… = `showWindow()` then `callAny('ui.view.open', {id: 'view:quirky.notifications/settings'})`.
- Quit: `app.on('before-quit', …)` calls `setDockBadge('')`.
- Assets: `apps/desktop/scripts/make-tray-images.ts` writes `assets/tray-dot.png` and `@2x` (amber `#f59e0b` dot with a 1 px white ring, transparent background) with a minimal PNG encoder over `node:zlib`; committed; the bundle copies them into `resources`. `bundle-plugins.ts` copies a plugin's `sounds/` directory when it exists (update `bundle-plugins.test.ts:61`).
- Stub `types/electrobun-main.d.ts` grows: `Tray` options `{title?, image?, template?, width?, height?}`, `setVisible`, `remove`; `BrowserWindow.isVisible`, `isMinimized`; `Utils.showNotification` `subtitle?`, `silent?`; `app.on`.

## Data models

- `Session.unread` (M1), `UiWindowInfo` (K1), `notify.sound` (K2), `notification` fact (P1), settled events (R1), plugin settings, methods and events (N1).
- N's store: one table for its own state (the migration flag). Cooldown, pending own writes, held bells and chunk state are in memory only.

## DO-NOT-CHANGE fences

- `packages/pty-host/src/scanner.ts` `MARKER` handling in `finishOsc`: the shell-ready barrier depends on the exact payload being held and stripped (m1-term-daemon); only add codes in `reportOsc`.
- `apps/desktop/src/bun/dock.ts` FFI call: it runs on the main thread through `performSelectorOnMainThread`; calling AppKit directly can deadlock (notifications.md "Tray attention dot").
- `plugins/quirky.agent-status/src/apply.ts` state machine and fold: only the `notify` → `settled` result changes. The fold is m1-agent-status's locked behaviour (D14 there).
- `packages/daemon/src/notify.ts` broadcast-always behaviour: the webview toast and every subscriber depend on it.
- `plugins/quirky.session` view ID `view:quirky.session/worktree` and its `{worktree, session}` input: 15+ callers and m1-term-ui's override rely on it.

## Always / Ask / Never

- **Always:** start every test daemon with a temporary `HOME` and `QUIRKY_HOME` and set `QUIRKY_SOUND_PLAYER` to a recorder; kill what a test starts; declare every method, event and setting with schemas; write markers before gates; keep producers free of any notifications dependency.
- **Ask (decide and record in the decision log):** exact tone shapes; the bell glyph's markup; whether the PTY protocol needs a bump; the in-process test rig's shape.
- **Never:** run the CLI or a daemon on the real home (m1-agent-status D58); call `context.notify` from any plugin other than `quirky.notifications`; play a sound for an undelivered banner; touch `~/.claude`, `~/.codex` or `~/.quirky`; edit `docs/loop/LOOP.md`, `scripts/build-loop/` or `docs/loop/queue.json`.

## Cross-cutting

- **Security:** program text is untrusted; `clean()` runs in the host before anything stores or shows it. `send` is a normal API method (same token rules as every method). The custom sound path is read only for size and type checks; afplay runs it.
- **Observability:** every decision emits `decided`; delivery failures of the player are logged with `context.log`.
- **Migration:** session migration 6; the settings carry-over (N3); removing `quirky.agent-status/notifications` from the manifest leaves its stored row unread, which is fine.
- **Rollback:** disabling `quirky.notifications` stops all notifications and markers; producers keep working.

## Testing strategy

Each scenario's test, by file (new files unless marked):

- K: `packages/daemon/test/plugins/window-presence.test.ts` (activity, present, `ui.window.changed` rules, drop), `packages/ui/test/host-activity.test.ts` (throttle), kernel-schemas tests updated.
- P: `packages/pty-host/test/scanner.test.ts` (SC-29 to SC-34 parse cases, chunking, cleaning, ConEmu, marker unchanged), `plugins/quirky.terminal/test/fact-event.test.ts`, one `plugins/quirky.terminal/test/e2e.test.ts` case printing OSC 777 in a real PTY.
- R: agent-status `settled` tests replacing `describe('notifications')`, including SC-16 and SC-17; structured and ask tests updated to assert no `notify` and the new events.
- M: session `setUnread` and migration tests; `SessionTabs` and `Tree.tsx` window tests for the bells (SC-46 pieces); worktree SC-43 tests updated for the bell.
- N: unit tests for `text.ts` (SC-19 to SC-24), sounds check (SC-40), cooldown (SC-12, SC-13), occasion and bell hold (SC-27, SC-32) with an injected clock; an in-process rig for the policy (SC-1 to SC-18, SC-25, SC-26, SC-28, SC-35, SC-43); e2e CLI tests in `plugins/quirky.notifications/test/e2e/` on a daemon subprocess for every flow (SC-1, SC-7, SC-10, SC-11, SC-13, SC-36, SC-39, SC-40, SC-41, SC-42, SC-51, SC-52), each through `quirky` or the daemon API. Time-based e2e cases may shorten `QUIRKY_DESKTOP_AWAY_MS`.
- S: `plugins/quirky.notifications/test/sounds.test.ts` (determinism, headers).
- D: `apps/desktop/test/events.test.ts` (banner silence and sound, badge from status, tray reducer SC-44, menu SC-45, quit reset), `bundle-plugins.test.ts` (sounds copied).
- UI pass (LOOP.md step 6): SC-6, SC-46 to SC-50 with `quirk:using-apps-like-a-user --surface web`.
- Native: `docs/loop/native/m1-notifications.json` with the logic spec's native-only list.
- Gate: `bun run test`, `bun test scripts`, `bun run typecheck`.

## Build waves

- **W1 (parallel):** K, P, R, M, S. Each touches its own files. R's tests stop asserting `notify`; nothing notifies until W2, which is fine on the branch.
- **W2 (parallel):** N (daemon core, methods, CLI; depends on K, P, R, M), D (depends on K2, N1's event and method names, which are fixed above), N6 settings view (depends on N1's methods).
- **W3:** e2e CLI scenarios and the UI scenario tests.
- Then catch up with `build/roadmap` (see below), Final Round 1, the UI pass, the native file, land.

## Catch-up obligations (m1-term-ui)

If m1-term-ui has landed when this item catches up: its tab strip shows the M1 bell for a tab whose sessions include an unread one (the most recent reason), its worktree view's report adds `visibleSessions` (every pane of every visible tab, plus the open floating panel's visible panes), and N2 reads the report through the same slot ID. Record the result as a decision.

## Non-goals

Everything in the logic spec's [Scope and non-goals](logic.md#scope-and-non-goals); also no tray tooltip (Electrobun's Tray has none, D39), no PNG compositing onto the menu bar glyph (D42), and no notification history.
