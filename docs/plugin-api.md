# Plugin API 1.0

Plugin API 1.0 freezes Quirky's existing author-facing plugin contract at **1.0.0**. A plugin manifest declares the minimum stable API release it requires; compatible hosts accept it, and incompatible hosts refuse the plugin before executing its entrypoints.

## Stable imports and types

For TypeScript types, use the root `@quirky/protocol` export. Do not import implementation files from `packages/*/src` or depend on Quirky's private kernel or renderer modules. Plugins receive host services through their activation context; the API release does not promise new capabilities beyond the declarations that exist today.

The freeze covers the public declarations and their referenced contract types, including:

- [`PluginManifest`, `PluginContext` and `PluginModule`](../packages/protocol/src/plugins.ts): daemon entrypoints, manifest fields, activation services and contribution declarations.
- [`UiPluginContext` and `UiPluginModule`](../packages/protocol/src/ui.ts): UI modules, contribution providers, rendering and context services. The current UI contribution kinds are the `UI_KINDS` declared there.
- [`CliContext` and `CliModule`](../packages/protocol/src/cli.ts): module-backed CLI command handlers.
- [`ApiDescription` and CLI catalog entries](../packages/protocol/src/catalog.ts): published daemon API and command metadata.
- [`PLUGIN_API_VERSION` and compatibility rules](../packages/protocol/src/plugin-api.ts): the host API release and stable-floor comparison.
- [`ProcessRunner`, `ProcessSpawner`, `RunOptions`, `RunResult`, `SpawnOptions`, `SpawnedProcess`, `SpawnExit` and `StopOptions`](../packages/protocol/src/process.ts): daemon plugin subprocess capabilities, options and outcomes.
- [Protocol JSON schemas and daemon manifest parsing](../packages/protocol/src/kernel-schemas.ts)
  and [the manifest parser](../packages/daemon/src/plugins/manifest.ts): accepted manifest and contribution data.

Contribution IDs keep the form `kind:plugin-id/name`. API 1.0 freezes the existing contribution kinds, declaration schemas, ID rules, override behavior and lifecycle contract. The linked declarations and schema validators remain the detailed reference for each field and transitive type; this guide does not freeze private kernel or renderer DOM structures.

The current UI kind identifiers are `status-bar`, `sidebar-section`, `activity-item`, `panel`,
`view`, `overlay`, `command`, `keybinding`, `setting`, `settings-section`, `theme` and
`menu-item`. Daemon method/event declarations and CLI command declarations are part of the same
frozen contract; their exact schemas remain in the linked protocol declarations.

API 1.1 adds `whenSetting` to `panel`, `sidebar-section` and `activity-item`: the name of one of
the plugin's own boolean settings. The contribution, and the tool it projects, exist only while that
setting is `true`. A plugin that uses it declares `"apiVersion": "1.1.0"`.

API 1.2 adds `whenSetting` to `setting`, `command` and `keybinding`, and an optional manifest
`repository`. A `command` or `keybinding` with `whenSetting` leaves the UI model while that setting
is not `true`; a keybinding bound to a hidden command is unbound. A `setting` with `whenSetting`
stays in the model and in `setting.list`, which reports the field, so its value stays readable. For
a `setting` with `"menu": "view"`, the native View menu row appears, and can be toggled, only while
the named setting is `true`. `repository` is an `https://github.com/<owner>/<repo>` URL with exactly
those two path segments; the manifest loader rejects any other shape, and `plugin.list` returns it.
A plugin that uses either declares `"apiVersion": "1.2.0"`.

API 1.3 adds optional `coalesce` and `worktree` fields to event declarations and event overrides.
`coalesce` lists up to four distinct key paths into event data. Each path has one to four
dot-separated identifier segments (`[A-Za-z_][A-Za-z0-9_]*`). The coalescing key includes the event
type, any valid worktree tag, and the values at those paths; an empty list still separates emits by
event type and worktree tag. The kernel sends the first emit for a key immediately, then sends only
the latest held emit when the 250 ms window ends. A plugin's held emits go out before its next
uncoalesced event.
`emit` returns `true` when the event is sent or held, and `false` when disabled or overridden.
`worktree` names a key path containing the worktree ID; a non-empty string there is copied to the
event envelope's `worktreeId` without changing which clients receive it. Held events are dropped
when their plugin unloads. A plugin that uses either field declares `"apiVersion": "1.3.0"`.
A held event keeps a reference to the emitted payload; a plugin must not mutate it after `emit`.

`quirky.session-info/changed`, `quirky.git/changed`, `quirky.git/reviewChanged` and
`quirky.git/notesChanged` coalesce. `quirky.editor/changed` coalesces with one key for the
daemon, and `quirky.editor/explorerChanged` coalesces per worktree and still carries its
worktree tag. Editor clients refresh after their own actions rather than waiting for an event.
`quirky.terminal/title` and `quirky.terminal/cwd` coalesce per `sessionId`; a listener that needs
every title reads `context.pty.onFact`. `quirky.session/changed` coalesces per `session.id` and
`quirky.agent-status/changed` per `sessionId`; both carry a worktree tag. Session changes to
`status`, `providerSession.id` or `providerSession.transcriptPath` arrive at once and in order.
Agent-status changes to `row.state`, `row.agent`, `row.lead.providerSession`, `row.turnStartedAt`,
`row.question` or `row.heldPermission`, and every `row: null`, also arrive at once and in order.
Held permissions compare `toolUseId`, `toolName`, `input` and `childId`; undefined counts as a
value for both questions and held permissions. Other changes may merge into the latest event,
up to 250 ms late. `quirky.session/removed` cannot be followed by an older held session
change. Agent-status removals retain the worktree tag of their last announced row, even when
the session is no longer available; removals with no announced row remain untagged.
`quirky.agent-status/settled` carries a worktree tag and is not coalesced.

"quirky.tasks/changed" coalesces with one key for the daemon, and Tasks clients apply the result of their own actions rather than waiting for an event.

`quirky.reviews/changed` carries a worktree tag for updates confined to one Checks entry and its
Checks dialog; shared updates and evictions remain untagged. It coalesces per tag. Review draft
fields keep local input and request state themselves after their writes settle.

### API 1.4: Process runner

API 1.4 adds `context.process` to daemon plugin contexts. `context.process.run(argv, options)`
resolves with a `RunResult` for any exit code, including nonzero, and when a command is stopped
by timeout, abort or output overflow, or cannot start (reported in `spawnError`). It rejects for
bad arguments, a disposed runner, output that never ends after the command exits, or unexpected
pipe/child-exit failures. For those unexpected failures, it kills the process group and rejects
with the original error.

`cwd` defaults to the daemon's working directory. `env` is the whole child environment: it
defaults to `process.env` at call time, and a supplied value is not merged with it. The deadline
defaults to 30 seconds. The host kills the plugin's remaining children when its activation ends.
`deactivate` may still call `context.process.run`; the runner is disposed when deactivation
finishes. In API 1.4, the object exposes only `run`; `spawn` was added in API 1.6.

### API 1.5: Scoped UI subscriptions

API 1.5 adds `UiPluginContext.subscribe(listener, { worktreeId })`. A string leaves out plugin
events tagged with another worktree; `null` leaves out every tagged plugin event. Omitting the
option delivers every event. Untagged plugin events and all kernel events are always delivered,
even when their payload or a kernel event names another worktree. The scope is fixed at subscribe
time. A plugin that uses the option declares `"apiVersion": "1.5.0"`.

### API 1.6: Streaming and session-length processes

API 1.6 adds `context.process.spawn(argv, options): SpawnedProcess` to daemon plugins.
Use `run` for aggregated command output and `spawn` for streaming or session-length children.
Plugins using `spawn` declare `"apiVersion": "1.6.0"` or later. The manifest is a compatibility
floor, not a member switch: a supported older manifest gets both methods on a 1.6 host.

Import the types from root `@quirky/protocol`. The context's frozen `process` object supplies
`ProcessRunner & ProcessSpawner`, exposing exactly `run` and `spawn`, without `owner`, `live`
or `dispose`. A helper needing only spawning can accept `ProcessSpawner`; run-only helpers
can continue accepting `ProcessRunner`. See the [process declarations](../packages/protocol/src/process.ts)
for every option and handle member.

#### Deadlines and streams belong to the caller

`spawn` returns a handle synchronously, not a Promise. Its `stdout` is a demand-driven
`ReadableStream<Uint8Array>`; chunks are bytes, not lines or frames. Drain stdout or stop the child.
`stderrTail()` reads a bounded, automatically drained tail in `'tail'` mode, final when `exited`
resolves. With `stderr: 'pipe'`, read raw bytes from `stderr` instead.
`write` preserves call order and resolves whether bytes reached the pipe, not whether the child
consumed them. `write` and `closeInput` do not reject for a dead or closed pipe.

For a combined stdout/stderr cap, drain both concurrently and count each raw `chunk.byteLength`
before decoding. On overflow, cancel both readers and stop the child. Keep any call-level deadline
and abort listener active until `exited` and both drains settle; the leader can exit before output
finishes. Stream errors and `groupSurvived: true` must not turn a zero exit into success.
Start stdin writes without awaiting them before draining output or handling cancellation, because
a child may never read its input.

These defaults apply:

- `timeoutMs` is required: a positive finite number, or `null` for no deadline. Spawn has no
  implicit 30-second deadline.
- `cwd` is the daemon's working directory. `env` is `process.env` at call time; a supplied
  environment replaces it rather than merging.
- Stdin is `'ignore'`, stdout is `'pipe'`, stderr is `'tail'`, the stderr tail is 16,384 bytes,
  and kill grace is 2,000 ms.

`stop()` sends SIGTERM to the process group and escalates to SIGKILL after the grace period.
By default, a graceful stop closes piped stdout/stderr and discards their unread bytes, while
the automatic stderr tail continues draining through shutdown. With `groupGrace: true`, piped
output stays open through the remaining group grace, even after the leader exits.
A later graceful stop can only shorten that grace. `stop({ signal: 'SIGKILL' })` and disposal
end it and close all output immediately, then wait for bounded group cleanup.
The first stop reason wins. A stop during natural-exit group grace records its reason even though
the leader already exited. After cleanup, the completed result stays unchanged; a hard stop still
closes unread output without sending another signal. `stop` resolves to the same exit object as
`exited`. Cancelling stdout alone does not request process termination.

#### Start failures resolve; bad calls throw

Bad arguments/options and a disposed runner throw synchronously before returning a handle.
An unstartable command returns an inactive handle with `pid: null`, closed stdout and stderr,
an empty stderr tail, writes resolving `false`, and `spawnError` in its resolved exit. An
already-aborted signal returns an inactive handle whose exit is marked `stopped: 'aborted'`.
`exited` resolves for nonzero exits, explicit stop, timeout, abort and start failure; it does not
reject for those outcomes. A post-exit stdout stall errors with `ProcessStalledError` after group
cleanup and the existing 1,000 ms stall wait, without rerunning the command.

#### Activation ownership covers both methods

Run and spawn share one runner owned by the plugin ID for each activation attempt.
Both remain usable during `deactivate` and the activation disposer. Unload, disable,
replacement/reload and failed activation dispose that runner, immediately SIGKILL its remaining
process groups and await cleanup. A running child's exit is marked `aborted` unless an earlier
stop reason won; completed exits stay unchanged. After disposal, stale `spawn` throws
`ProcessRunnerDisposedError` synchronously, while stale `run` rejects. Re-enabling creates a
fresh runner and does not revive stale contexts. One plugin's disposal cannot stop another's children.

Normal daemon shutdown stops all shared-runner children, including kernel-owned children,
even if plugin deactivation throws. A natural leader exit also kills remaining members of its
process group. Ownership does not cover descendants that deliberately start a separate session;
daemon crashes or SIGKILL do not guarantee cleanup.

Spawn does not split shell strings, parse lines/frames, retry, deduplicate, cache, restart,
impose concurrency limits or apply run's total-output cap. It does not bound arbitrarily many
unawaited writes. Callers own their result/frame limits and must stop abandoned children.
There is no raw Bun subprocess, IPC, PTY, inherited stdio, arbitrary-signal API, sandbox or
detached/outliving option. Plugin code must use its context, never import `@quirky/process`.

### API 1.7: In-place view input updates

API 1.7 adds `MountCleanup`, a cleanup function with an optional
`updateInput(input: unknown): boolean` hook. A mounted view can return `true` to accept
new input without replacing its DOM or resources. Returning `false`, omitting the hook,
or throwing makes the host clean up the old mount and mount a fresh child with the new input.
Plain cleanup functions and mounts returning `void` remain compatible.

While a view's module is loading, input updates coalesce so its mount receives the latest
input once. Failed or released mounts and non-view slots do not accept updates. Changing
the contribution's owner or module still ends the mount. Embedded `mountView` handles
do not use this hook. Plugins using the hook declare `"apiVersion": "1.7.0"` or later.

The terminal worktree view preserves mounted panes on same-worktree input updates.
Selecting a session focuses its terminal; later background layout revisions leave
focused text fields alone.

### API 1.8: Terminal stream recovery

API 1.8 adds optional `ClientStream.lagged`, `lag()` and `onLag(callback)` hooks.
`lag()` marks an open stream once, sends a binary `TerminalLagged` frame, and invokes its
lag callbacks. Registering `onLag` after lag invokes the callback immediately.
Daemon `send(bytes)` returns `false` once the stream is lagged or closed, and `true` when sent.
The public return type remains `boolean | void` for existing stream implementations.

`UiPluginContext.onStream(streamId, listener, { onLagged })` reports lost output once per
registration and suppresses subsequent bytes from that stream. A gap detected before registration,
including overflow of the client's 4 MiB early buffer, reports lag in a microtask unless disposed.
Unsubscribe and replace the stream rather than continuing to consume incomplete output.
Plugins using these hooks declare `"apiVersion": "1.8.0"`.

`quirky.terminal/resync({ streamId, historyLines? })` replaces a stream owned by the calling
connection and returns a fresh replay, offset, history cursor, dimensions, shell state and live
status. It does not restore an ended process. Requests for one connection and session are spaced
by two seconds. Desktop panes reset and replay under their input gate; phone viewers recover
in-band with a screen snapshot and only the live bytes after its offset.

### API 1.9: One-shot output policies

API 1.9 adds `outputMode` and `overflow` to `RunOptions`. Defaults remain `outputMode: 'separate'`
and `overflow: 'stop'`. In separate mode, `maxOutputBytes` applies independently to stdout and
stderr. In combined mode, both streams append to `stdout` and `stdoutText` under one shared cap;
`stderr` is empty, and bytes are combined in the order the drains observe chunks.

With `overflow: 'stop'`, exceeding the cap stops the process group as before. With
`overflow: 'truncate'`, the runner retains only each bounded prefix and continues draining both
streams so the command can finish. When any bytes are discarded, `RunResult.truncated` reports
which captured streams were cut; in combined mode, discarded bytes are attributed to stdout.
Exact-cap output is not marked truncated. Truncation does not disable deadlines, abort, activation
disposal or the existing post-exit stall and rerun behavior. A plugin using either option declares
`"apiVersion": "1.9.0"`.

Captured partial results on post-exit stall errors retain the same truncation flags.

Use the [process declarations](../packages/protocol/src/process.ts) for the complete option and
result types.

### API 1.10: Immediate emits

API 1.10 adds an option to daemon plugins' `context.emit`:

```ts
emit(event: string, data?: unknown, options?: { immediate?: boolean }): boolean
```

With `{ immediate: true }`, a coalesced event replaces what its key holds, sends the plugin's
other held events first, then goes out inside the call. Its fixed window stays armed; an idle
key starts a window. Only `true` requests immediate delivery. Plain events ignore the option
and always send the plugin's held events first. A plugin that passes the option declares
`"apiVersion": "1.10.0"` or later.

- Everything a plugin emitted before a plain event or immediate emit reaches clients and plugin
  listeners before that event, oldest emit first, unless a later emit replaced the same key.
- An immediate emit of an enabled event the plugin owns is delivered regardless of which
  other events are disabled or overridden. A disabled or overridden emit releases nothing.
- No order is promised between coalesced events with different keys when neither is immediate,
  between plugins' events, or between plugin and kernel events.

### API 1.11: Bounded process groups and raw stderr

API 1.11 adds `stderr: 'pipe'` to `SpawnOptions`. In this mode, `SpawnedProcess.stderr` delivers
raw bytes on demand and `stderrTail()` is always empty. In `'tail'` and `'ignore'` modes, `stderr`
is an empty closed stream and `stderrTail()` retains its existing behavior.

API 1.11 also adds the opt-in `groupGrace: true` spawn option. It gives the whole process group the
grace period: a natural leader exit sends one SIGTERM to a remaining group, and members already
given a graceful stop keep the unspent grace after their leader exits. A stop during that grace can
shorten it. A SIGKILL stop or disposal ends output immediately. Without `groupGrace`, the runner
keeps API 1.6's immediate group cleanup and output-stop behavior.

After a leader exits, both `run` and `spawn` repeat SIGKILL every 10 ms until its process group is
gone or the one-second cleanup bound expires. They remain in the live table while cleanup runs;
`spawn.exited` and `run()` settle after cleanup, without waiting for an output reader. A result
includes `groupSurvived: true` when members remain at the bound. `spawn`'s `durationMs` still
measures the leader's exit; `run`'s `durationMs` measures the result.

Piped output stays open through a graceful group grace and closes quietly within one stall wait
after the group ends. A requested stop is not reported as an output stall. A natural-exit output
stall still fails with `ProcessStalledError`, with its wait starting after group cleanup.

### API 1.12: Method deadlines and stalled jobs

Plugin methods may declare `timeout`, a duration string from `1s` through `24h`, including in
method overrides. A plugin using this field declares `"apiVersion": "1.12.0"` or later.
Read-only plugin methods without a declared timeout have a 300-second deadline; mutating methods
without one have a 600-second deadline. Both defaults apply to plugins targeting older API releases.
A method that works longer by design must declare `timeout`.
The clock starts when the handler is called, after activation and authorization. Kernel methods
are unchanged. The deadline applies to client, plugin and kernel-sourced calls to plugin methods.

A deadline rejects the call with `RpcErrorCode.Timeout` (`-32011`) and data
`{ reason: 'timeout', method, timeoutMs }`. The handler may still finish or change state:
plugins run in process and cannot be forcibly stopped. Its late result or error is logged and
dropped; it can no longer forward methods as the original caller.

For a mutating call with a request ID, the recorded outcome is the Timeout, not the handler's
eventual result. Repeating that request ID returns the same error without invoking the handler
again. Read state to determine what the timed-out handler did.

Unanswered handlers have passed their deadline or outlived their revoked activation without
settling. Counts last for the daemon process and survive plugin reloads. Once a method has four
or more unanswered handlers, new calls fail before activation with Timeout and data
`{ reason: 'stalled', method, unanswered }`, reporting the real count. Calls already admitted may
still time out and increase that count beyond four. See
[API 1.14 running-handler limit](#api-114-running-handler-limit).
The plugin carries one warning while the count is at least four. Finishing handlers clears it
once fewer than four remain; a daemon restart also clears the count.

A job that has not settled five seconds after its timeout remains `running`, with no next run.
`JobInfo.stalled` reports `{ handlers }`, and the plugin carries a warning. `job.run` rejects
Conflict with `{ reason: 'stalled' }`; the CLI shows `stalled` in the STATE column.
No replacement starts in that activation until the old handler settles, then the next run is
due one interval later. Reloading the plugin permits another run only below the shared bound
of four. Revoked contexts cannot act through their former activation.

### API 1.13: Host output-gap recovery

`context.pty.onLagged(listener)` reports a session whose host output subscription was shed.
Before calling any listener, the daemon invalidates that session's shared subscription holds
and pending subscribe attempts. Other sessions are unchanged. Listeners can immediately
`subscribe` again; an older promise cannot restore its hold or release a replacement.
The registration returns a remover and is removed on plugin revocation. Listener failures
are logged without stopping other plugins. Plugins using it declare `"apiVersion": "1.13.0"`.

The host bounds each subscription at 4 MiB and each connection at 32 MiB, counting encoded
queued and subscribe-held output, including the remainder of a started frame. Shedding drops
unstarted output, not the process or durable history. Desktop terminal attachments report
stream lag and recover through `quirky.terminal/resync`. Phone attachments keep their stream
ids, reacquire the host subscription, and receive a reset/snapshot before live output resumes.
Agent readiness resets its scanner and reacquires output within the original delivery deadline;
a gap never retries a paste already committed.

Daemon WebSocket output is limited to 4 MiB per stream and 8 MiB of binary output per
connection, counting outstanding wire bytes. JSON and lag markers share a bounded 16 MiB
FIFO when the native socket cannot accept them. Terminal output is not queued again:
`send` returns `false` and lags the stream. Accepted bytes remain accounted until native
drainage, even after their stream closes. Unrecoverable control backpressure closes with 1013.

### API 1.14: Running-handler limit

By default, a plugin method may have at most 1,024 running handlers. A handler is running from
dispatcher admission until its promise settles, even if its caller has already received a timeout.
Kernel methods are not counted.

When a method is at its limit, additional calls fail before plugin code runs with
`RpcErrorCode.Busy` (`-32012`) and data `{ reason: 'busy', method, running, limit }`. A Busy
refusal runs no plugin code, so callers may safely retry it later. Direct Busy and `stalled`
admission refusals are not recorded under a request ID, so a later retry with that ID runs the
method instead of replaying the refusal. If a handler runs and propagates a refusal from a
nested call, its error is recorded normally: retrying must not repeat the outer handler's effects.

A method's first refusal adds a warning to the plugin; later refusals do not duplicate it. The
warning clears when that method's running count falls to half the limit. A plugin that depends on
this error declares `"apiVersion": "1.14.0"`.

## Manifest declaration

Every plugin manifest must include `apiVersion`. It is independent of the plugin's own package `version`:

```json
{
  "id": "acme.example",
  "name": "Example sidebar",
  "version": "2.3.0",
  "apiVersion": "1.0.0",
  "ui": "ui.js",
  "contributes": {
    "sidebar-section": [
      { "id": "worktrees", "title": "Worktrees" }
    ]
  }
}
```

`apiVersion` is a minimum stable API release in canonical `major.minor.patch` form. Each component is a nonnegative safe integer with no leading zeroes except `0`. Ranges, shorthand versions, whitespace, prereleases and build suffixes are not accepted.

### UI command palette visibility

UI command declarations may include an optional `palette` boolean:

```json
{
  "contributes": {
    "command": [
      { "id": "open", "title": "Open", "palette": true },
      { "id": "control", "title": "Control", "palette": false }
    ]
  }
}
```

Omitting `palette` is equivalent to `true`. `false` hides the command from the
command palette only: it remains an effective UI command, can still be invoked
through UI command routing, and can still be bound to a keybinding.
Non-boolean values are invalid.

## Window workspace context

Use `context.getLayout().worktree` for the window's selected workspace, not
`layout.view.input.worktree`. Opening a view with a nonempty `input.worktree`
selects that workspace; explicitly passing `worktree: null` clears it.
Global views that omit the workspace retain the selection without receiving it
in their input, so opening Activity or Agent settings does not clear
workspace-scoped panels or change Activity filters.

Closing the last view clears the selection; revealing another workspace view
selects its workspace. Each window has its own selection. A new auxiliary
window starts with only the workspace explicitly supplied in its view input.
View input remains the source for a view-specific target or filter, rather
than the window's current selection.

## Compatibility and diagnostics

A host supports a declared floor only when the target and host have the same major and the target is no newer than the host, compared numerically. Thus a 1.0.0 host accepts 1.0.0; a later 1.x host accepts earlier 1.x floors. A 1.0.0 host refuses 1.1.0, and a 2.x host does not treat 1.x as compatible.

The daemon validates manifests during discovery, inspection and installation. A malformed declaration makes that plugin invalid; direct or distro inspection/installation uses the existing invalid-parameter error path. Missing, wrong-type or empty values receive field diagnostics; malformed strings identify `apiVersion` and the required stable version shape; unsupported targets identify both the target and host release. No plugin entrypoint is imported to diagnose a floor, and no production default upgrades a missing declaration.

Local module hosts check the declaring plugin's floor independently. The CLI checks module-backed command metadata before importing a CLI module; generic RPC-only CLI commands do not need a local module gate. The UI host checks each plugin's module metadata before import and contains a failure to that plugin. The daemon's release does not authorize newer code in an older CLI or UI process.

## Store recovery

The daemon checks existing non-empty `quirky.db` and plugin `store.db` files when opening them.
It runs SQLite's full integrity check when the main file plus WAL is at most 32 MiB, and the
quick check above that size. The quick check does not detect mismatches between indexes and rows.
Validation checks a writable snapshot in a private temporary directory while the original stays
read-only. Snapshot copies use filesystem cloning when available. Repair reads committed WAL
rows without checkpointing them into the original main file that will be quarantined.

A corrupt store is repaired into a checked copy when possible; otherwise it is replaced with an
empty database and plugin migrations run again. The original file and any WAL/SHM sidecars stay
beside the store as `<file>.corrupt-<timestamp>-<8 hex>`, with one suffix shared by the three files.
Quirky never deletes these originals. Lock, permission, migration and schema-version errors do
not trigger recovery.

Kernel recoveries are logged. Plugin recoveries also appear as warning diagnostics in `plugin.list`,
including when a later migration fails. `context.openStore` and the plugin API version are unchanged.

## Lifecycle, cleanup and trust

The stable contract includes the existing daemon, CLI and UI activation shapes, context methods, contribution schemas and cleanup behavior. Daemon `activate(context)` may return an activation disposer; modules may also implement `deactivate()`. UI modules implement `activate(context)` and may implement `deactivate()`. UI mount functions return cleanup functions when they own DOM or other mounted resources. Context subscription methods return unsubscribe functions. Plugins should release resources they create and must not assume a context remains usable after its activation ends.

The daemon also calls `deactivate()` after an `activate()` that threw or timed out, so it must cope with partial setup. The daemon retries a failed plugin on a delay from 1 second to 5 minutes; `quirky plugin activate <id>` retries immediately, including its dependencies.

Manifest activation policy, dependencies, stable contribution IDs, schemas, overrides and existing cleanup semantics remain in effect. Plugin API compatibility is not a security boundary: plugins are full-trust code, not sandboxed. Install only code you trust; `--yes` skips the existing confirmation prompt but does not reduce the plugin's authority.

## Version domains and evolution

The plugin API release is separate from other version numbers:

- **Plugin API (`apiVersion`):** the minimum author-facing host contract a plugin requires.
- **Plugin package `version`:** the release of that plugin's own code.
- **Protocol package version (`@quirky/protocol`):** release of the package; it is not the Plugin API release.
- **Application version:** release of the Quirky app.
- **Daemon version:** the running daemon build reported as `daemonVersion` in `ApiDescription`.
- **Wire protocol version:** the client/daemon transport contract; Plugin API 1.0 does not change the handshake or protocol version.
- **Catalog schema version:** the shape version of `ApiDescription` and `ApiCatalog`; `pluginApiVersion` is additive and the catalog schema remains 2.

Plugin API **1.1.0** adds Native page requests to `UiPluginContext.nativeBrowser`: `pageRequestsAvailable`, the `onPageRequest`, `onPageRequestExpired` and `onDownload` mount options, and the handle's `answer()` and `cancelDownload()`. All of them are optional, so 1.0.0 plugins are unaffected.

Use SemVer for future Plugin API releases: increment the **major** for incompatible author-contract changes, **minor** for backward-compatible author-facing additions, and **patch** for backward-compatible corrections. Set a plugin's `apiVersion` to the earliest stable release that supplies every API feature it uses. Hosts compare that minimum against their own `PLUGIN_API_VERSION`; they do not infer a floor from the package, application, daemon, wire or catalog version.

The PTY wire protocol remains v4 for the opt-in `hello.sessionLagged === true` extension.
Only clients advertising that exact boolean receive `{ type: 'lagged', sessionId }`.
Older v4 clients still close and reconnect on subscription overflow; older hosts may ignore
the capability. This explicit negotiation is the exception to bumping the PTY version for
a new event, and does not change authentication or version refusal.

## Releases since 1.0.0

- **1.1.0** adds `UiPluginContext.nativeDropPaths(files)`: the original absolute paths of an OS file
  drop the window just received, or null where the desktop shell can't report them (browser
  shells, Linux, Windows, runtimes without the capability). A plugin that calls it declares
  `apiVersion` 1.1.0.
- **1.2.0** adds an optional `hue` to `panel`, `sidebar-section` and `activity-item`: one of the
  names in [`UI_TOOL_HUES`](../packages/protocol/src/tool-hues.ts), used to color the tool's icon. A
  plugin that sets it declares `apiVersion` 1.2.0.
- **1.3.0** adds optional `coalesce` and `worktree` fields to event declarations and overrides. The
  kernel sends the first emit immediately and only the latest held emit per key at the end of a
  250 ms window; held emits go out before the plugin's next uncoalesced event, and are dropped
  when the plugin unloads. A declared worktree path with a non-empty string is copied to the event's `worktreeId`.
  A plugin that uses either field declares `apiVersion` 1.3.0.
- **1.4.0** adds `context.process.run(argv, options)` for daemon plugins. It resolves for any exit
  code, including nonzero, timeout, abort, output overflow and spawn errors. It rejects bad
  arguments, a disposed runner, stalled output after exit, and unexpected pipe/child-exit
  failures. Defaults are the daemon's working directory, `process.env` at call time (a supplied
  environment replaces it) and a 30-second deadline. Children are killed when activation ends;
  `deactivate` may still call `run`. API 1.4 exposes only `run`; API 1.6 adds `spawn`.
  A plugin that uses it declares `apiVersion` 1.4.0.
- **1.5.0** adds optional worktree scoping to `UiPluginContext.subscribe`. Untagged plugin events
  and kernel events remain unfiltered. A plugin that uses the option declares `apiVersion` 1.5.0.
- **1.6.0** adds [`context.process.spawn`](#api-16-streaming-and-session-length-processes) for
  streaming and session-length daemon children under the same activation owner as `run`.
  A plugin that uses it declares `apiVersion` 1.6.0 or later.
- **1.7.0** adds [`MountCleanup.updateInput`](#api-17-in-place-view-input-updates) for mounted
  views that preserve their DOM and resources when accepting new input.
  A plugin that uses it declares `apiVersion` 1.7.0 or later.
- **1.8.0** adds [terminal stream lag hooks and recovery](#api-18-terminal-stream-recovery).
- **1.9.0** adds opt-in combined capture and truncate-on-overflow policies to `context.process.run`.
  Separate capture and stop-on-overflow remain the defaults. A plugin using either option declares
  `apiVersion` 1.9.0.
- **1.10.0** adds [`context.emit` immediate delivery](#api-110-immediate-emits) and sends a plugin's
  held events before its next uncoalesced event. A plugin that passes the option declares
  `apiVersion` 1.10.0 or later.
- **1.11.0** adds raw stderr piping and opt-in process-group grace to
  [`context.process.spawn`](#api-111-bounded-process-groups-and-raw-stderr). `run` and `spawn` wait
  for bounded process-group cleanup and report `groupSurvived: true` if members remain at the
  bound. A plugin using these additions declares `apiVersion` 1.11.0.
- **1.12.0** adds [method deadlines and stalled-job diagnostics](#api-112-method-deadlines-and-stalled-jobs),
  a 300-second read-only method default, and reload-safe refusal once four handlers are unanswered.
- **1.13.0** adds [`PluginPty.onLagged`](#api-113-host-output-gap-recovery), invalidating
  session subscriptions before notifying plugins and bounding host and daemon output queues.
- **1.14.0** adds the [per-method running-handler limit](#api-114-running-handler-limit): 1,024
  handlers per plugin method by default. Calls over the limit fail with Busy before plugin code
  runs; Busy and stalled refusals are not stored under request IDs.

## Example

The [sample distro README](../distros/sample/README.md) walks through inspection, installation, UI state and removal. Its [bundled sidebar manifest](../distros/sample/sample.sidebar/quirky-plugin.json) is a complete small example of an API 1.0 declaration.
