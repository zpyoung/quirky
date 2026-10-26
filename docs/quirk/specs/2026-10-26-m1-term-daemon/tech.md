# m1-term-daemon tech spec

**Status:** Draft for build. **Logic spec:** [logic.md](logic.md). **Decisions:** [m1-term-daemon.md](../../../loop/decisions/m1-term-daemon.md).

All paths are relative to the repo root. The tier gate fired on three criteria: the work crosses the
PTY host, daemon and plugin boundaries, touches far more than three files, and the logic spec's
Status records "Tech spec: requested".

## Architecture

Four layers change, each depending only on the contracts of the one below it
([Conceptual model](logic.md#conceptual-model)):

1. **Protocol** (`packages/protocol/src/pty.ts`, `plugins.ts`, `model.ts`): PTY protocol 2, the
   snapshot, history and fact shapes, the grown `PluginPty` and `PluginLaunch`, and the new
   `Session` fields.
2. **PTY host** (`packages/pty-host/src`): the session manager is split into small units: a framed
   history log, checkpoints and meta, an output scanner, the shell-ready barrier, the screen
   (live emulator plus serializer), a history reader that renders log windows through a scratch
   emulator, and a stored-session loader for sessions that live only on disk.
3. **Kernel** (`packages/daemon/src`): `pty-client.ts` gains the version retire-or-refuse step and
   `restartHost`; `plugins/pty-api.ts` exposes the new members; `launch.ts` writes shell
   integration (OSC 133, OSC 7, ready marker) into the zsh and bash wrappers.
4. **Plugins**: `quirky.session` records exit details and restores; `quirky.terminal` gains
   methods, events, CLI commands, a Terminal Sessions panel and startup activation; the session
   view's pane passes `historyLines` and re-attaches a lost session.

Libraries: `@xterm/headless` 5.5.0 stays pinned; add `@xterm/addon-serialize` **0.13.0** (exact) to
`packages/pty-host/package.json` ([D25](../../../loop/decisions/m1-term-daemon.md)). It was installed
and checked against headless 5.5.0 on the build machine. Nothing else is added. The desktop bundle
(`apps/desktop/scripts/bundle.ts:14-18`) inlines the host with `Bun.build`, so the addon must be
importable as an ES module with no workers or assets (it is).

`COMMAND:` add the dependency

```
bun add --cwd packages/pty-host @xterm/addon-serialize@0.13.0 --exact
```

## Code references

### Protocol (`packages/protocol/src`)

| File | Change |
|---|---|
| `pty.ts` | `PTY_PROTOCOL_VERSION = 2`. New and changed request and result types in [PTY protocol 2](#pty-protocol-2). `PtyEvent` becomes the union of `exit` and `fact`. Export `ShellState`, `ExitCause`, `PtySnapshot`, `PtyFact`, `PtyHistoryPage`. |
| `plugins.ts:81-99` | `PluginPty` grows as in [Plugin API](#plugin-api). `PluginLaunch` (`plugins.ts:~113`) gains `shellReady(): boolean`. |
| `model.ts:36-47` | `Session` gains `exitSignal: string \| null`, `exitCause: ExitCause \| null`, `restorable: boolean`. `ExitCause` is exported from `pty.ts` and re-used. |
| `frames.ts` | Unchanged. |

### PTY host (`packages/pty-host/src`)

| File | Change |
|---|---|
| `session.ts` | `SessionManager` keeps its public shape and delegates: output goes through `scanner` → `history/log` → `tail` → `screen` → sinks; input goes through `barrier`. Emulator scrollback becomes 0 (`EMULATOR_SCROLLBACK` removed); `DEFAULT_TAIL_BYTES = 256 * 1024`. `create` takes `shellReady`, `shellReadyTimeoutMs`, `restore`. `kill` takes `reason`. `list` returns in-memory and stored sessions. New `snapshot`, `history`. `read` returns history lines plus the screen. `finalize` records `exitSignal`/`exitCause`, writes a final checkpoint and `meta.json`. `shutdown()` ends every session as `host-restart`. |
| `log.ts` | Replaced by `history/log.ts`. `RotatingLog` and its tests go. |
| `history/log.ts` (new) | `HistoryLog`: the framed, rotating, append-only log ([Log format](#log-format)). Opens for append on restore; starts fresh on create. Torn-tail tolerant reader `readSegments(dir)`. |
| `history/checkpoint.ts` (new) | `writeCheckpoint(dir, cp)` (tmp file, fsync, rename, 0600) and `readCheckpoint(dir)` returning `null` on any parse or validation failure. |
| `history/meta.ts` (new) | `writeMeta`, `readMeta` for `meta.json` ([Session directory](#session-directory)). |
| `history/reader.ts` (new) | `renderWindow` and `pageBefore` ([History paging](#history-paging)); also builds the attach replay block. |
| `history/restore.ts` (new) | `rebuildScreen(dir, screen)`: checkpoint, then log after it, with the fallback ladder of [D19](../../../loop/decisions/m1-term-daemon.md). |
| `screen.ts` (new) | `Screen`: the live `@xterm/headless` terminal (scrollback 0) plus `SerializeAddon`; `write`, `resize`, `settled()`, `snapshot()`, `modes`, `cursor`, a `seeding` switch that suppresses query replies, and the reply sink used today by `term.onData` (`session.ts:149-151`). |
| `scanner.ts` (new) | `OutputScanner`: split-safe ESC/CSI/OSC/DCS state machine ([Scanner](#scanner)). |
| `barrier.ts` (new) | `ShellReadyBarrier` ([Shell-ready barrier](#shell-ready-barrier)). |
| `stored.ts` (new) | `StoredSessions`: scans `<home>/sessions/*/meta.json` at host start and serves `list`, `read`, `snapshot`, `history`, `forget` for sessions not in memory. |
| `server.ts:114-147` | Dispatch gains `snapshot`, `history`; `subscribe`, `create`, `kill`, `list`, `shutdown` per [PTY protocol 2](#pty-protocol-2). Fact events go to every authenticated connection, like exit events (`server.ts:62`). |
| `client.ts` | `hello()` unchanged in shape; tests use it. |
| `tail.ts` | Unchanged. `TailBuffer` gains an optional starting `total` so a restored session continues its output position. |
| `pty-process.ts` | Unchanged. |
| `main.ts` | Unchanged. |

### Kernel (`packages/daemon/src`)

| File | Change |
|---|---|
| `pty-client.ts:179-199` | `openAndHello`: on a hello rejected with `unsupported protocol version <ours>, host speaks <theirs>` ([REGEX](#pty-protocol-2)), if theirs < ours, hello again at theirs, send `shutdown`, wait for the socket to close, then continue `establish` (which spawns our host); if theirs > ours, fail `connect()` with `quirky-pty speaks protocol <theirs>; this quirkyd speaks <ours>. Stop it or upgrade Quirky.` and do not spawn. New `restartHost(): Promise<{ pid: number }>`: send `shutdown`, wait for close, `connect()` (spawns a fresh host), return `hostPid`; the reconnect handlers fire once afterwards. `dispatch` (:220-242) routes `fact` events to new `onFact` handlers and passes the whole exit payload to `onExit` handlers. |
| `plugins/pty-api.ts:73-116` | New members per [Plugin API](#plugin-api). `onExit` listeners receive `(sessionId, exitCode, exit)`. New `onFact`. |
| `plugins/runtime.ts:141-168` | `launch.shellReady()` returns `shellKind(options.shell)` is `zsh` or `bash`. |
| `launch.ts:22-50` | Export `shellKind`. `launch.ts:138-185` (`zshWrapperFiles`, `bashRcfile`): add shell integration after the user's rc files are sourced ([Shell integration](#shell-integration)). |
| `daemon.ts` | No change. |

### Plugins

| File | Change |
|---|---|
| `plugins/quirky.session/src/records.ts:6-138` | Second migration (append to the array at :64-85): `ALTER TABLE sessions ADD COLUMN exit_signal TEXT`, `exit_cause TEXT`, `restorable INTEGER NOT NULL DEFAULT 0`. The shared `INSERT` (:32-33) is also used by the v1 import inside migration 1, which runs before the columns exist: give the v1 import its own frozen statement and let `insert` write the new columns. `Row`, `toSession`, `insert` and `update` (:126-138) cover `exitSignal`, `exitCause`, `restorable` and `agent`. |
| `plugins/quirky.session/src/sessions.ts` | `create` passes `shellReady: agent === 'shell' && context.launch.shellReady()` to `spawn`. `finish(sessionId, exit)` takes `{ exitCode, exitSignal, exitCause, restorable }`. `reconcile` per [Reconcile](#reconcile). New `restore` ([Restore](#restore)). |
| `plugins/quirky.session/main.ts:19-21` | Register `restore`; `onExit` passes the exit details. |
| `plugins/quirky.session/quirky-plugin.json` | Method `restore` (params `{session}`, result `Session`); the six inlined `Session` schemas (`list`, `get`, `create`, `register`, `setStatus` results, `changed` event, :28-614) gain the three fields as optional properties, untyped where null is allowed, as `exitCode` is; CLI command `restore` with positional `session`. `plugins/quirky.structured/quirky-plugin.json`'s two copies gain them too. Every test literal typed `Session` gains the fields (list in [Testing strategy](#testing-strategy)). |
| `plugins/quirky.session/cli.ts` | `restore` command printing `restored <id>` or `<id> is already running`. |
| `plugins/quirky.session/src/window/TerminalPane.tsx:77-91` | Pass `historyLines: scrollback` to attach. |
| `plugins/quirky.session/src/window/SessionView.tsx:48-58` | When the shown session turns `exited` with `restorable: true`, re-attach once (remount the pane), which restores it. |
| `plugins/quirky.terminal/quirky-plugin.json` | `activation: "startup"`; `attach` params gain `historyLines` and result fields; new methods, events, CLI commands, panel, command and `ui` entry per [Manifest](#manifest). |
| `plugins/quirky.terminal/main.ts` | Register new handlers; `context.pty.onFact` → `context.emit(<fact kind>, ...)`. |
| `plugins/quirky.terminal/src/terminal.ts` | `attach` restores a restorable session first and uses `subscribe` mode `screen`; `onReconnect` uses mode `raw`; `write`/`send` refuse ended sessions ([D9](../../../loop/decisions/m1-term-daemon.md)); new `snapshot`, `history`, `sessions`, `kill`, `killAll`, `restartHost`. `killAll` calls the kill path directly, not through `context.call` (the dispatcher would ask again: only kernel calls skip confirmation, `dispatch.ts:188-193`). |
| `plugins/quirky.terminal/cli.ts` | Commands `snapshot`, `history`, `sessions`, `kill`, `kill-all`, `restart-host`. |
| `plugins/quirky.terminal/src/ui.tsx` (new), `src/window/SessionsPanel.tsx` (new) | `activate(context: UiPluginContext)` provides `panel:quirky.terminal/sessions` (mount pattern of `plugins/quirky.git/src/ui.tsx:7-17`, reporting its rows through `report`) and `command:quirky.terminal/manage-sessions` (`context.togglePanel('panel:quirky.terminal/sessions', true)`). Kill and restart use `context.confirm({title, body, confirmLabel})` then call with `yes: true`, as `plugins/quirky.worktree/src/actions.ts:52-79` does. A row click calls `context.openView('view:quirky.session/worktree', { worktree, session })` (the string is inlined; plugins can't import each other). Refreshes on `quirky.session/changed` and `quirky.session/removed` and on Refresh. |
| `plugins/quirky.terminal/package.json` | `dependencies` gain `react`, `react-dom` (same versions as `plugins/quirky.session/package.json`); the fence test reads only `dependencies`. Dev: `@types/react`, `@types/react-dom`, `@happy-dom/global-registrator` as in quirky.session. |
| `plugins/quirky.terminal/test/fakes/quirky.session/` | The fake session plugin gains `restore` and the new `Session` fields, so terminal tests can drive restore. |
| `packages/daemon/test/fixtures/fake-pty-host.ts:65-149` | Speak version 2; add `snapshot`, `history` cases; `subscribe` honours `mode`; `kill` records `reason`; `list` returns `state`; `exit` takes the new payload; new `fact(sessionId, fact)`. Update `FakeSession` literals in `plugins/quirky.session/test/support.ts:86`. |

## Contracts & interfaces

### PTY protocol 2

Back-links: [Data flow](logic.md#data-flow), [D17](../../../loop/decisions/m1-term-daemon.md).

`SCHEMA:` requests (each with `id: number`, as today)

```
hello      { token, version: 2 }                                   -> { version: 2, pid }
create     { sessionId, cwd, argv, env, cols, rows,
             shellReady?: boolean, shellReadyTimeoutMs?: number,   (default 15000)
             restore?: boolean }                                    -> { pid, restored: boolean, cwd, cols, rows }
resize     { sessionId, cols, rows }                               -> {}
kill       { sessionId, signal?: string, reason?: 'killed' }       -> {}
forget     { sessionId }                                           -> {}      (in memory or stored)
list       {}                                                      -> PtySessionInfo[]
subscribe  { sessionId, mode?: 'screen' | 'raw', historyLines? }   -> PtySubscription
unsubscribe{ sessionId }                                           -> {}
read       { sessionId, lines }                                    -> { lines, cols, rows, alt }
snapshot   { sessionId }                                           -> PtySnapshot
history    { sessionId, lines?, before?: string, format?: 'text' | 'ansi' } -> PtyHistoryPage
shutdown   {}                                                      -> {}
```

`SCHEMA:` types

```
ShellState = 'pending' | 'ready' | 'timed_out' | 'unsupported'
ExitCause  = 'exited' | 'killed' | 'host-restart' | 'host-lost'
PtySessionInfo = { sessionId, state: 'running' | 'exited' | 'restorable', pid (0 when stored),
                   alive, exitCode: number|null, exitSignal: string|null, exitCause: ExitCause|null,
                   cols, rows, argv, cwd (last known: OSC 7 else start cwd), title: string|null,
                   shellState, createdAt, offset }
PtySubscription = { replay: base64, offset, historyCursor: string|null, cols, rows, shellState }
PtySnapshot = { ansi, cols, rows, cursor: { x, y }, modes: { alternateScreen, bracketedPaste,
                mouseTracking, applicationCursor }, cwd, title: string|null, shellState, offset }
PtyHistoryPage = { lines: string[], cursor: string|null }
PtyFact = { kind: 'bell' } | { kind: 'command-finished', exitCode: number|null }
        | { kind: 'title', title } | { kind: 'cwd', cwd }
PtyEvent = { type: 'exit', sessionId, exitCode, exitSignal, exitCause }
         | { type: 'fact', sessionId, fact: PtyFact }
```

`REGEX:` the version rejection the kernel parses (the host's text at `server.ts:107`, unchanged)

```
^unsupported protocol version (\d+), host speaks (\d+)$
```

Contracts:

- **`create` without `restore`** behaves as today but writes `meta.json`, starts a fresh log, and
  rejects a session id already in memory. A stored session with the same id is forgotten first.
- **`create` with `restore: true`** requires a stored session in state `restorable` with that id,
  else fails `session <id> is not restorable`. It rebuilds the screen
  ([Restore algorithm](#restore-algorithm)), ignores the request's `cwd`, `cols` and `rows` in favour
  of the recovered ones (the request's values are the fallback when nothing was recovered or the
  cwd no longer exists), spawns `argv`, and returns `restored: true` with what it used.
- **`subscribe` mode `screen`** (default) returns the composed replay
  ([History paging](#history-paging)) of `historyLines` (default 2000, clamped 0..10000); mode
  `raw` returns today's contract: base64 of the hot tail ending at `offset`, from a line boundary
  once wrapped. In both modes the first DATA frame after the response starts at `offset`. A stored
  (not running) session can't be subscribed: `session <id> is not running`.
- **`read`** returns `lines` history lines (text) above the visible screen rows, trailing blank rows
  dropped, as today's shape. Works on stored sessions.
- **`kill`** with `reason: 'killed'` sends `signal` (default `SIGKILL` when a reason is given, else
  `SIGTERM`) to the process group and records cause `killed` for the coming exit.
- **`shutdown`** ends every running session with cause `host-restart` (SIGHUP, then SIGKILL after
  1 s, as `SessionManager.shutdown` does today), writes their final checkpoints and meta with
  `restorable: true`, sends their exit events, replies, then stops. Stored sessions are untouched.
- **Exit details:** `exitCode` is `proc.exitCode` when it is a number, else `128 + signum` of
  `proc.signalCode` (`os.constants.signals`), with `exitSignal` the signal name; cause `killed` if a
  `kill` with a reason preceded it, `host-restart` during `shutdown`, else `exited`.
- **Unknown session:** every session-scoped request on an id neither in memory nor stored fails
  `unknown session: <id>` (the text `quirky.session` matches at `sessions.ts:16`).

### Session directory

Back-links: [D18](../../../loop/decisions/m1-term-daemon.md), [D19](../../../loop/decisions/m1-term-daemon.md).

`<home>/sessions/<sessionId>/` (0700), files 0600:

`SCHEMA:` `meta.json`

```
{ version: 1, sessionId, argv: string[], startCwd, cwd (last known), cols, rows, createdAt,
  endedAt: number|null, exitCode: number|null, exitSignal: string|null,
  exitCause: ExitCause|null, restorable: boolean }
```

Written on create, on each checkpoint (cwd, size), and at exit. A stored session is `restorable`
when `endedAt` is null (the host died: report cause `host-lost`) or `restorable` is true (cause
`host-restart`); otherwise `exited` with its recorded exit.

`SCHEMA:` `checkpoint.json`

```
{ version: 1, offset: number, cols, rows, ansi: string, cwd, title: string|null, savedAt: number }
```

`ansi` is `Screen.snapshot().ansi` taken when the emulator had parsed exactly `offset` output bytes.

### Log format

Back-links: [D18](../../../loop/decisions/m1-term-daemon.md), [D24](../../../loop/decisions/m1-term-daemon.md).

`SCHEMA:` segment files `output.log` (current) and `output.1.log` (previous)

```
header  16 bytes: magic "QPTL" | u8 format=1 | 3 bytes zero | u64le startOffset
record  [kind u8][length u32le][payload]
  0x01 output   payload = raw output bytes (marker already removed)
  0x02 resize   payload = u16le cols, u16le rows
  0x03 restore  payload = empty; marks where a restored incarnation begins
```

- `startOffset` is the output position of the segment's first output byte. Output positions are
  absolute for the session's whole life, across rotations and restores.
- Every new segment's first record is a resize carrying the current size.
- A segment passing 16 MiB is renamed over `output.1.log` and a new `output.log` starts.
- Reading: a record whose length runs past the end of file is a torn tail and is dropped with
  everything after it; an unknown kind or a bad magic makes that segment unreadable.
- Writes go through one fd with `writeSync`; an I/O error disables the session's history
  (logged once to stderr, which the kernel sends to `logs/pty-host.log`) and the terminal goes on.

### Checkpoints

Back-links: [SC-15](logic.md#checkpoints-and-cold-restore).

- The first output after a checkpoint arms a 5 s timer (`CHECKPOINT_INTERVAL_MS`, overridable in
  `SessionManagerOptions` for tests). On fire: await `screen.settled()` (an empty write's
  callback), record `offset` = bytes fed to the screen, serialize, write the checkpoint and meta.
  Up to 4 sessions write at once.
- A final checkpoint is written at exit and during `shutdown`. An idle session writes nothing.

### Restore algorithm

Back-links: [SC-17](logic.md#checkpoints-and-cold-restore), [SC-20](logic.md#checkpoints-and-cold-restore), [SC-21](logic.md#checkpoints-and-cold-restore).

1. With `screen.seeding = true` (query replies dropped): if a readable checkpoint exists, write its
   `ansi` at its size, then replay the log records after its `offset` (outputs and resizes in
   order); if not, replay every readable segment from the start; if no log either, write
   `[history could not be read]\r\n`.
2. Append the **ground**: leave the alternate screen, turn off mouse reporting, bracketed paste and
   application cursor keys, show the cursor, reset SGR, then `\r\n`. Append a `restore` record and
   the ground as an output record to the log, so history and replays see the same bytes.
3. `seeding = false`; spawn the shell at the recovered size in the recovered cwd; the output
   position continues from the log's last position plus the ground.
4. Meta: `endedAt` null, cause and exit cleared, `restorable` false.

### History paging

Back-links: [D6](../../../loop/decisions/m1-term-daemon.md), [D7](../../../loop/decisions/m1-term-daemon.md), [SC-8](logic.md#reattach-and-snapshots), [SC-11](logic.md#paged-history), [SC-14](logic.md#paged-history).

- **Cursor:** opaque string `h1.<output position>` (base 10). Callers must treat it as opaque. A
  position older than the oldest retained output clamps to the oldest; a malformed cursor fails
  `invalid history cursor`.
- **Window:** for "the N lines before position P", read records backwards from P through the
  segments until the window holds N + rows newlines, the oldest output is reached, or 8 MiB has been
  read; move the window start forward to just after a newline (unless it is the oldest output);
  note the size in force at the window start (the last resize record before it).
- **Render:** a scratch `Terminal` at that size with `scrollback = N + rows + 64`, fed the window's
  outputs and resizes in order, `seeding` style (no reply sink).
- **`history` page before cursor P:** rows are all the scratch buffer's rows except trailing blank
  ones; when P is "now" (no `before`), the scratch screen's rows are excluded so the page ends where
  the live screen begins. Return the last `lines` of them that start a line (a wrapped row stays with
  its line), oldest first; `cursor` is the window start, or null if it is the oldest output.
  `text` rows are `translateToString(true)`; `ansi` rows are the serializer's output for the same
  range, split per line.
- **Attach replay (`subscribe` mode `screen`):** render the window before "now", then write
  `ESC[H ESC[2J` and the live `Screen.snapshot().ansi` into the scratch terminal, then serialize the
  scratch terminal with `scrollback: historyLines`, then append an absolute cursor position
  (`ESC[<y+1>;<x+1>H` from the live cursor). `historyCursor` is the window start when older output
  exists, else null. A prototype of this composition reproduced scrollback and screen exactly in
  a fresh terminal.

### Scanner

Back-links: [D16](../../../loop/decisions/m1-term-daemon.md), [SC-30](logic.md#bells-and-osc-133) to [SC-33](logic.md#bells-and-osc-133), [SC-3](logic.md#opening-a-terminal-and-the-shell-ready-barrier).

`CONTRACT:`

```
class OutputScanner {
  push(chunk: Uint8Array): { bytes: Uint8Array; facts: ScanFact[] }
}
type ScanFact = PtyFact | { kind: 'ready' } | { kind: 'prompt' } | { kind: 'command-start' }
```

- States: ground, ESC, CSI, OSC (terminated by BEL or ESC \\), DCS/SOS/PM/APC strings (terminated
  by ESC \\, contents ignored). State carries across `push` calls.
- BEL in ground is a `bell` fact; BEL ending an OSC is not.
- OSC `0;t` and `2;t` give `title` (only when it differs from the last title); `7;file://host/path`
  gives `cwd` (percent-decoded path, only on change); `133;D[;n]` gives `command-finished` with `n`
  or null; `133;A` and `133;C` give `prompt` and `command-start` (host-internal); `777;quirky-shell-ready`
  gives `ready`.
- The ready marker's bytes are removed from `bytes`, including when split across chunks. Bytes of an
  OSC that might be the marker are held only until that OSC ends or stops matching; every other byte
  is returned in the same `push` call. OSC payloads over 4 KiB are dropped without a fact.

### Shell-ready barrier

Back-links: [D15](../../../loop/decisions/m1-term-daemon.md), [SC-2](logic.md#opening-a-terminal-and-the-shell-ready-barrier), [SC-4](logic.md#opening-a-terminal-and-the-shell-ready-barrier), [SC-5](logic.md#opening-a-terminal-and-the-shell-ready-barrier).

`CONTRACT:`

```
class ShellReadyBarrier {
  constructor(options: { enabled: boolean; timeoutMs: number; deliver(bytes: Uint8Array): void })
  readonly state: ShellState          // 'unsupported' when not enabled, else starts 'pending'
  input(bytes: Uint8Array): void      // queued while pending, else delivered
  ready(): void                       // pending -> ready, flushes the queue in order
  dispose(): void
}
```

- On timeout: `pending` → `timed_out`, flush. After a restore the barrier starts `pending` again
  when `shellReady` was requested.
- Emulator query replies (no-subscriber path) go through the barrier like any input.
- Queue cap 1 MiB; input beyond it while pending is dropped and logged.

### Shell integration

Back-links: [D15](../../../loop/decisions/m1-term-daemon.md), [D16](../../../loop/decisions/m1-term-daemon.md).

In the generated wrappers (`launch.ts:138-185`), after the user's files are sourced:

- **zsh** (`.zshrc` wrapper): `autoload -Uz add-zsh-hook`; a `preexec` hook sets a "ran" flag and
  prints OSC 133;C; a `precmd` hook prints OSC 133;D;$? only when the flag is set (then clears it),
  then OSC 7 with `$HOST` and `$PWD`, then OSC 133;A, and on its first run only OSC 777;quirky-shell-ready.
  Hooks are added, never replacing the user's.
- **bash** (rcfile): the same output from a function prepended to `PROMPT_COMMAND`, with the "ran"
  flag set by a `DEBUG` trap that ignores the prompt function itself (bash 3.2 has no `PS0`). If the
  user's rc already set a `DEBUG` trap, keep theirs and skip 133;C and the ran flag (then 133;D is
  printed only when `$?` or `HISTCMD` changed) rather than replace it.
- Both were prototyped on this machine (zsh 5.9, bash 3.2.57): codes 0, 1 and 7 reported in order,
  nothing for an empty line, `exit 3` recorded as 3.
- The wrappers apply only to shell sessions (`agent === 'shell'`); agent sessions keep
  `commandArgv` with no integration and `shellReady: false`.

### Plugin API

Back-links: [Scope & non-goals](logic.md#scope--non-goals), [SC-41](logic.md#lifecycle-and-the-plugin).

`CONTRACT:` `PluginPty` after this item (unchanged members omitted)

```
spawn(sessionId, { argv, cwd, env, cols, rows, shellReady?, restore? })
  : Promise<{ pid; restored: boolean; cwd; cols; rows }>
subscribe(sessionId, options?: { mode?: 'screen' | 'raw'; historyLines?: number }): Promise<PtySubscription>
snapshot(sessionId): Promise<PtySnapshot>
history(sessionId, options?: { lines?; before?; format? }): Promise<PtyHistoryPage>
kill(sessionId, signal?, options?: { reason?: 'killed' }): Promise<void>
restartHost(): Promise<{ pid: number }>
onExit(listener: (sessionId, exitCode: number | null, exit: { exitSignal; exitCause }) => void): () => void
onFact(listener: (sessionId, fact: PtyFact) => void): () => void
```

`PluginLaunch.shellReady(): boolean` is true when the configured shell is zsh or bash.

### Reconcile

Back-links: [SC-16](logic.md#checkpoints-and-cold-restore), [SC-19](logic.md#checkpoints-and-cold-restore).

`sessions.ts:146-163`. For each non-exited terminal record: host `running` → leave; `exited` →
finish with its exit details, `restorable` false; `restorable` → finish with `exitCode` null, its
`exitCause` (`host-lost` or `host-restart`), `restorable` true; absent → finish with `exitCode`
null, cause `host-lost`, `restorable` false. An `exited` record that the host now lists as
`restorable` with cause `host-restart` (the exit event was lost) is updated to restorable.

### Restore

Back-links: [D10](../../../loop/decisions/m1-term-daemon.md), [SC-17](logic.md#checkpoints-and-cold-restore), [SC-18](logic.md#checkpoints-and-cold-restore).

`quirky.session/restore {session}`:

- Running (`status` not `exited`): return the record unchanged.
- Exited and not restorable: conflict `session <id> ended normally and can't be restored` (cause
  `exited`) or `session <id> was killed and can't be restored` (cause `killed`).
- Restorable: run launch hooks for agent `shell`, `spawn` with `restore: true`, `shellArgv()`,
  `env` for agent `shell`, `shellReady` as in create, the record's cwd and 80x24 as fallbacks.
  On success update `status: running`, `agent: 'shell'`, clear exit fields, `restorable: false`,
  emit `changed`. Concurrent restores of one session share one in-flight promise.
- `quirky.terminal/attach` on a restorable session calls `quirky.session/restore` first and returns
  `restored: true`.

### Manifest

Back-links: [SC-40](logic.md#lifecycle-and-the-plugin), [D12](../../../loop/decisions/m1-term-daemon.md) to [D14](../../../loop/decisions/m1-term-daemon.md).

`quirky.terminal` (`quirky-plugin.json`):

| Contribution | Shape |
|---|---|
| method `attach` | params + `historyLines` (integer 0..10000); result + `historyCursor` (string or null), `cols`, `rows`, `restored` (boolean), `shellState` |
| method `snapshot` | `readOnly`; params `{session}`; result `PtySnapshot` |
| method `history` | `readOnly`; params `{session, lines? 1..10000, before?, format? text\|ansi}`; result `{lines, cursor}` |
| method `sessions` | `readOnly`; params `{}`; result `{sessions: PtySessionInfo[]}` with each row's `worktreeId` and `workspace` label (last two cwd segments) |
| method `kill` | `destructive`, confirm "Kill this session?" with the Orca body; params `{session}`; result `{ok: true}` |
| method `killAll` | `destructive`, confirm "Kill all terminal sessions?"; result `{killedCount, remainingCount, killedSessionIds}` |
| method `restartHost` | `destructive`, confirm "Restart the terminal service?" ("Open terminals and agents will restart."); result `{pid}` |
| events | `bell {sessionId}`, `commandFinished {sessionId, exitCode}`, `title {sessionId, title}`, `cwd {sessionId, cwd}` |
| CLI commands | `snapshot [session]`, `history [session] --lines --before --ansi`, `sessions`, `kill <session> --yes`, `kill-all --yes`, `restart-host --yes` |
| panel | `sessions`, title "Terminal Sessions" |
| command | `manage-sessions`, title "Terminal: Manage Sessions", opens the panel |
| `ui` | `dist/ui.js` (built from `src/ui.tsx` by `packages/ui/build.ts:38-53`, no list to edit) |

`kill-all` polls `list` every 100 ms up to 65 times. The panel's buttons show the Orca dialog text
from the UI's own confirm and then call with `yes: true`, as other built-in panels do for
destructive calls; the CLI and API go through the kernel's ask.

## DO-NOT-CHANGE fences

- **`packages/protocol/src/frames.ts`** — the PTY_DATA/PTY_JSON framing and the WebSocket terminal
  frame are shared with the window and the CLI; this item adds requests, not frame kinds.
- **`plugins/quirky.session/src/window/replayGate.ts`** — the input gate is what keeps replies to
  queries inside the replay from reaching the shell (SC-21 depends on it); reuse it as is.
- **`SessionService.create`'s close-during-start handling (`sessions.ts:47-93`)** — m0 fixed races
  there; add the `shellReady` field only.
- **`packages/daemon/src/daemon.ts:240-250` (`stop` leaves the host running)** — sessions must
  outlive `quirkyd` (SC-6).
- **`packages/pty-host/src/writer.ts`** — the socket backpressure queue is shared by host and
  client; output flow control is out of scope.
- **`quirky session list` and `session new` text output (`plugins/quirky.session/cli.ts:4-37`)** — pinned by `packages/cli/test/v1-words.e2e.test.ts:77-81` as v1's words; the new fields show only in `--json`.
- **`plugins/quirky.session/src/agents.ts`, `AGENT_KINDS`** — m1-providers (another lane) is
  rewriting agent launch there; touching it guarantees a merge conflict.

## Always / Ask / Never

- **Always:** keep session ids, cwd and env handling as they are; use fresh temp `QUIRKY_HOME`s
  (short `/tmp/q*` paths for socket length) and kill every host and daemon a test starts; keep
  history best effort (a disk error never fails a terminal call except `history`/`read` on that
  session); write checkpoints atomically; keep the plugins on `context.pty` only.
- **Ask (record as a decision instead, headless):** any change to the replay contract the pane
  sees beyond `historyLines`; any new dependency; raising a bound in SC-37.
- **Never:** answer terminal queries from the emulator while `seeding`; replay a log window that
  doesn't start at a line start (except the oldest output); delete history on host start; send
  `shutdown` to a newer host; touch `~/.quirky`, `~/.claude`, `~/.codex`.

## Cross-cutting

- **Security:** session dirs 0700 and files 0600 as today (`log.ts:9-12`). OSC 7 paths are only
  reported and used as the restore cwd after `existsSync` and a directory check; otherwise the start
  cwd. Title and cwd strings are capped at 4 KiB.
- **Migration:** a v1-protocol host is retired by the kernel ([PTY protocol 2](#pty-protocol-2)).
  Old raw `output.log` files without the `QPTL` header are treated as unreadable (no meta → the
  session isn't stored). `quirky.session` gains a migration; old rows get `restorable` 0.
- **Rollback:** reverting the item leaves `sessions/*/` directories a v1 host would wipe on create;
  nothing else persists.
- **Observability:** host logs (stderr → `logs/pty-host.log`) one line per disabled history,
  unreadable checkpoint or log segment, retire, and restore.

## Testing strategy

Back-links: every scenario in [Behavior & scenarios](logic.md#behavior--scenarios).

| Test file | Covers |
|---|---|
| `packages/pty-host/test/scanner.test.ts` (new) | Every fact kind; BEL inside OSC; DCS skipped; marker removed whole, split at every byte position; byte-at-a-time input (SC-3, SC-30, SC-32, SC-33) |
| `packages/pty-host/test/barrier.test.ts` (new) | Pending queue order, ready flush, timeout flush, unsupported pass-through, cap (SC-2, SC-4, SC-5) with a fake shell script that prints the marker after a delay |
| `packages/pty-host/test/log.test.ts` (new, replaces log rotation tests) | Framing, start offsets across rotation, resize record per segment, torn tail, bad magic, append after restore (SC-12, SC-20) |
| `packages/pty-host/test/snapshot.test.ts` (new) | Colours, cursor on a full last row (xterm #6165), scroll region (#6233), alt screen with bracketed paste and mouse modes, round trip into a fresh terminal (SC-7, SC-10) |
| `packages/pty-host/test/history.test.ts` (new) | Pages cover every line once, cursor null at oldest, text vs ansi, carriage-return redraw renders once, window across a resize, attach replay composition, 40 MiB rotation keeps newest 32 MiB (SC-8, SC-11, SC-12, SC-13, SC-14) |
| `packages/pty-host/test/restore.test.ts` (new) | Checkpoint cadence and idle cost, restore from checkpoint plus log, the four damage cases, queries in history produce no input, stored sessions served from disk, `forget` on stored (SC-15, SC-19, SC-20, SC-21, SC-39) |
| `packages/pty-host/test/host.test.ts` | Version 2 hello; exit details for status, signal (143, SIGTERM), `kill` reason (137, SIGKILL, `killed`); `shutdown` → `host-restart`; `list` states (SC-23, SC-34, SC-36) |
| `packages/pty-host/test/memory.test.ts` (new) | SC-37 against the real host process, measuring its RSS with `ps -o rss=` |
| `packages/daemon/test/launch.test.ts` | Wrappers: real zsh and bash emit 133 A/C/D, OSC 7 and the marker; user rc still sourced first (SC-1, SC-31) |
| `packages/daemon/test/pty-client.test.ts` | Retire a version 1 fake host; refuse a version 3 one; `restartHost` (SC-38, SC-25) |
| `plugins/quirky.session/test/sessions.test.ts` | Migration, reconcile matrix, restore matrix, exit details (SC-16, SC-18, SC-22) |
| `plugins/quirky.terminal/test/terminal.test.ts`, `cli.test.ts` | New methods, confirm and `--yes`, events from facts, refusals, attach restores (SC-22 to SC-25, SC-40) |
| `plugins/quirky.terminal/test/ui.test.ts` (new) | The panel with `fakeContext` from `plugins/quirky.session/test/ui-fake.ts` (SC-26 to SC-29) |
| `plugins/quirky.session/test/ui.test.ts` | Pane passes `historyLines`; a restorable session re-attaches once (SC-17, SC-28) |
| `plugins/quirky.terminal/test/e2e.test.ts` (new) | Real `quirkyd` process, real host, real CLI (`spawnCli`/`runCli` from `packages/cli/test/fixtures/fake-daemon.ts:536-565`, passing `QUIRKY_PTY_HOST_ENTRY` unset so the real host runs), a real temp git repo: SC-1, SC-2, SC-6, SC-9, SC-16, SC-17 (API attach), SC-18, SC-19, SC-23 to SC-25, SC-34, SC-35, SC-39. Kills the daemon and the host (`<home>/pty.pid`) in cleanup |
| `plugins/test/imports.test.ts` | Unchanged; must still pass (SC-41) |
| Literal fixes | `Session` literals in `plugins/quirky.session/test/{support.ts:104, ui-fake.ts:20}`, `plugins/quirky.terminal/test/{support.ts:60, fakes/quirky.session/main.ts:43}`, `plugins/quirky.worktree/test/{ui-report.test.ts:27, status.test.ts:15, ui.test.ts:51}`, `plugins/quirky.agent-status/test/agent-status.test.ts:33`, `plugins/quirky.structured/test/{claude-runner.test.ts:68, fakes/world.ts:47,125}`, `apps/desktop/test/events.test.ts:22`; `ui-fake.ts:139` attach result gains the new fields |

Acceptance bar: `bun run test`, `bun test scripts` and `bun run typecheck` pass; every SC has a named
test; the UI scenarios (SC-6, SC-17, SC-26 to SC-29) pass under `quirk:using-apps-like-a-user` on a
built app.

## Non-goals

Everything in [Scope & non-goals](logic.md#scope--non-goals). Also: no pane-side paging UI (the
pane only passes `historyLines`), no change to output flow control, no change to `quirky.agent-status`
(it can subscribe to the new events in m1-agent-status).
