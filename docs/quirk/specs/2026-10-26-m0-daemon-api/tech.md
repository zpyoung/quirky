# Tech spec: daemon plugin API

**Status:** Draft for build. Logic spec: [logic.md](logic.md). Gate fired: the user asked for it
(LOOP.md step 4), and the work crosses the protocol, daemon and CLI packages.

## Architecture

Four new modules sit beside the m0-registry kernel in `packages/daemon/src/plugins/`, and one
composition module wires them into the host's activation context. Back-link:
[Conceptual model](logic.md#conceptual-model), [Data flow](logic.md#data-flow).

| File | Role |
| --- | --- |
| `packages/protocol/src/plugins.ts` | extend `PluginContext`; add `PluginCaller`, `PluginErrorKind`, `PluginStore`, `StoreMigration`, `StoreValue`, `MethodHandler`, `JobHandler`, `LaunchHook`, `LaunchHookInput`, `LaunchPatch`, `JobInfo`, `JobRun`; add `RESERVED_LAUNCH_ENV`, `parseDuration` and the duration bounds |
| `packages/protocol/src/rpc.ts` | add `job.list` and `job.run` to `Methods`; add `PluginEvent` to `QuirkyEvent` |
| `packages/protocol/src/client.ts` | add `QuirkyClient.callAny(method, params)` for methods outside `Methods` |
| `packages/daemon/src/plugins/kinds.ts` (new) | validation of `method`, `event`, `job` and `launch-hook` entry data, used by `manifest.ts` |
| `packages/daemon/src/plugins/manifest.ts` | call `kinds.ts` from `checkContributes` and `checkOverrides` |
| `packages/daemon/src/plugins/host.ts` | `extension` option (extra context members and revoke), function check in `provide`, `addWarning` |
| `packages/daemon/src/plugins/dispatch.ts` (new) | `Dispatcher`: one entry point for kernel and plugin methods, used by the server and by `context.call` |
| `packages/daemon/src/plugins/events.ts` (new) | `PluginEvents`: emit checks and listener fan-out |
| `packages/daemon/src/plugins/stores.ts` (new) | `openPluginStore`: the SQLite file, migrations and the `PluginStore` wrapper |
| `packages/daemon/src/plugins/scheduler.ts` (new) | `Scheduler`: arming, running, recording and listing jobs |
| `packages/daemon/src/plugins/launch-hooks.ts` (new) | `runLaunchHooks`: the hook pipeline |
| `packages/daemon/src/plugins/runtime.ts` (new) | `createPluginRuntime`: builds the four services and the host `extension` from them |
| `packages/daemon/src/server.ts` | route every request through `Dispatcher.dispatch` |
| `packages/daemon/src/methods.ts` | `createHandlers(core, plugins, scheduler)`; `job.list`, `job.run` |
| `packages/daemon/src/service.ts` | `CoreOptions.onEvent` and `CoreOptions.prepareLaunch`; `createSession` applies the launch result |
| `packages/daemon/src/launch.ts` | `buildArgv` takes `extraArgs`; `buildSessionEnv` takes `envPatch` |
| `packages/daemon/src/store.ts` | `job_runs` table and four methods |
| `packages/daemon/src/daemon.ts` | build the runtime, start and stop the scheduler, new options |
| `packages/cli/src/commands/job.ts` (new) | `job list`, `job run <id>` |
| `packages/cli/src/commands/index.ts` | register the two commands |
| `packages/cli/test/fixtures/fake-daemon.ts` | `job.list` and `job.run` cases |
| `docs/v1.md` | `plugin-data/` in the "Files and environment" table |

No new dependencies. Stores use `bun:sqlite`, as `packages/daemon/src/store.ts` does.

## Code references

- `packages/daemon/src/plugins/host.ts`
  - `PluginHostOptions` (line ~18): add `extension?: ContextExtension`.
  - `contextFor(entry, attempt)` (line ~315): spread `extension.create(...)` into the returned
    context; `provide` checks the kind (see [Host changes](#host-changes)).
  - `run()` failure branch (line ~260), `deactivate()` (line ~375): call `extension.revoke(id)`
    after the module's `deactivate` settles, or right after revoking when no module was imported.
  - `Runtime.warnings` (line ~42): `addWarning` appends here.
  - `resolve`, `resolveImplementation`, `contributions` are used as they are.
- `packages/daemon/src/plugins/manifest.ts` `checkContributes` (line ~105) and `checkOverrides`
  (line ~130): after the existing checks pass for an entry, call `checkKindEntry`.
- `packages/daemon/src/server.ts` `handleMessage` (line ~118): replace the `handlers` lookup and
  call with `dispatcher.dispatch(method, params, { conn })`. Keep the `client.hello`-first check,
  the params-object check and the `DaemonError` mapping.
- `packages/daemon/src/methods.ts` `createHandlers` (line ~76) and the `Handlers` type.
- `packages/daemon/src/service.ts`
  - `Core.broadcast` (line ~127): after sending to clients, call `options.onEvent?.(event)`.
  - `Core.createSession` (line ~279): before `pty.request('create', …)`, await
    `options.prepareLaunch?.(…)` and pass its result to `buildArgv` and `buildSessionEnv`.
- `packages/daemon/src/launch.ts` `buildArgv` (line ~52), `buildSessionEnv` (line ~90),
  `shellQuote` (line ~20).
- `packages/daemon/src/errors.ts` `DaemonError`, `invalidParams`, `notFound`, `conflict`,
  `internal`.
- `packages/daemon/src/store.ts` schema block (line ~41), `close()`.
- `packages/daemon/src/daemon.ts` `startDaemon` (line ~105): `plugins.load()` and
  `activateStartup()` (line ~165), `createHandlers` (line ~173), `stop()` (line ~205).
- `packages/protocol/src/client.ts` `QuirkyClient.call` (line ~86).
- `packages/cli/src/commands/plugin.ts` is the pattern for `job.ts` (`takePositionals`,
  `ctx.rpc.call`, `ctx.out.result`, `formatTable`).
- Tests: `packages/daemon/test/helpers.ts` `startHarness`, `waitFor`;
  `packages/daemon/test/plugins/fixtures.ts` `writePlugin`, `writeModulePlugin`, `moduleSource`,
  `readMarker`; `packages/daemon/test/fixtures/fake-pty-host.ts` records each `create` request's
  `argv` and `env`.

## Contracts & interfaces

### Protocol types ([Conceptual model](logic.md#conceptual-model))

SCHEMA:
```ts
type PluginErrorKind = 'invalid-params' | 'not-found' | 'conflict'
type PluginCaller = { role: ClientRole; name?: string } | { role: 'plugin'; pluginId: string }
type StoreValue = string | number | bigint | boolean | null | Uint8Array
type PluginStore = {
  readonly version: number
  run(sql: string, ...params: StoreValue[]): { changes: number; lastInsertRowid: number }
  get<T = Record<string, unknown>>(sql: string, ...params: StoreValue[]): T | null
  all<T = Record<string, unknown>>(sql: string, ...params: StoreValue[]): T[]
  exec(sql: string): void                          // one or more statements, no params
  transaction<T>(work: () => T): T                 // synchronous; rolls back on throw
}
type StoreMigration = string | ((store: PluginStore) => void)
type PluginContext = {
  readonly pluginId: string
  readonly dir: string
  readonly dataDir: string                         // <home>/plugin-data/<pluginId>, exists (0700)
  log(message: string): void
  provide(contributionId: string, implementation: unknown): void
  emit(event: string, data?: unknown): boolean
  subscribe(listener: (event: QuirkyEvent) => void | Promise<void>): () => void
  call(method: string, params?: Record<string, unknown>): Promise<unknown>
  openStore(migrations: StoreMigration[]): PluginStore
  error(kind: PluginErrorKind, message: string): Error
}
type MethodHandler = (params: Record<string, unknown>, caller: PluginCaller) => unknown
type JobHandler = (run: { jobId: string; signal: AbortSignal }) => void | Promise<void>
type LaunchHookInput = {
  sessionId: string; worktreeId: string; repoId: string; cwd: string
  agent: string; prompt?: string
  env: Readonly<Record<string, string>>            // additions from earlier hooks only
  args: readonly string[]                          // extra args from earlier hooks
}
type LaunchPatch = { env?: Record<string, string | null>; args?: string[] }
type LaunchHook = (launch: LaunchHookInput) => LaunchPatch | void | Promise<LaunchPatch | void>
type JobRunStatus = 'running' | 'ok' | 'failed' | 'timed-out'
type JobRun = { startedAt: number; finishedAt: number | null; status: JobRunStatus; error?: string }
type JobInfo = {
  id: string; plugin: string
  intervalMs: number; timeoutMs: number
  state: 'idle' | 'running'
  nextRunAt: number | null                         // null while running
  lastRun: JobRun | null
}
type PluginEvent = { type: `${string}/${string}`; data: unknown }   // added to QuirkyEvent
```

CONFIG: `RESERVED_LAUNCH_ENV = ['PATH', 'ZDOTDIR']`, plus every name starting `QUIRKY_`.

REGEX: duration `^(\d+)(ms|s|m|h|d)$`. `parseDuration(text): number | null` returns milliseconds, so
`2d` parses (to 172_800_000) and then fails the range check rather than the format check.

CONFIG: interval 1000..86_400_000 ms; `initialDelay` 0..86_400_000 ms (default: the interval);
`timeout` 1000..86_400_000 ms (default 300_000).

`QuirkyClient.callAny(method: string, params: Record<string, unknown>): Promise<unknown>` sends
any method name. `PROTOCOL_VERSION` stays 1: every change is additive.

### Kind validation ([SC-28](logic.md#lifecycle-and-manifests))

CONTRACT:
```ts
checkKindEntry(kind: string, label: string, entry: Record<string, unknown>, errors: string[]): void
```

- Applies only to kinds `method`, `event`, `job`, `launch-hook`; other kinds return untouched.
- `label` is `<kind> <name>` for a `contributes` entry and `override <full id>` for an override,
  where the kind comes from the parsed override ID.
- Allowed fields besides `id`: `method`, `event`: `description`. `job`: `description`, `interval`,
  `initialDelay`, `timeout`. `launch-hook`: `description`, `agents`.
- Messages, each prefixed `<label>: `: `unknown field \`<f>\``; `description must be a string`;
  `interval is required`; `<field> must be a duration such as 30s, 5m or 2h`; `interval must be
  between 1s and 24h`; `initialDelay must be between 0s and 24h`; `timeout must be between 1s and
  24h`; `agents must be a list of agent names` (non-array, empty array, or a non-string or empty
  item).

### Host changes

CONTRACT:
```ts
type ContextExtension = {
  create(plugin: { id: string; dir: string }, isRevoked: () => boolean):
    Pick<PluginContext, 'dataDir' | 'emit' | 'subscribe' | 'call' | 'openStore' | 'error'>
  revoke(pluginId: string): void
}
PluginHost.addWarning(pluginId: string, message: string): void  // appends to runtime warnings, emits plugin.changed
```

- `create` runs once per activation attempt, before the module's `activate`. `isRevoked` returns
  the attempt's `revoked` flag.
- `revoke` runs exactly once per attempt that called `create`: on activation failure, on disable
  during activation, on deactivate (live or at stop). It runs after the module's `deactivate`
  settles, so a store handle the plugin holds stays usable inside `deactivate`.
- `provide(id, impl)`: when `id`'s kind is `method`, `job` or `launch-hook` and `impl` is not a
  function, throw `Error("<id> must be provided as a function")`.
- Without `extension` the host behaves exactly as today (the m0-registry tests construct it that
  way).

### Dispatcher ([Calling a method](logic.md#data-flow), SC-1 to SC-6)

CONTRACT:
```ts
class Dispatcher {
  constructor(handlers: Handlers, plugins: PluginHost, log: (m: string) => void)
  dispatch(method: string, params: Record<string, unknown>,
           from: { conn: ClientConn } | { pluginId: string }): Promise<unknown>
}
const CONNECTION_METHODS = ['client.hello', 'events.subscribe', 'terminal.attach', 'terminal.detach']
```

- A name in `handlers` runs the kernel handler. From a plugin, a `CONNECTION_METHODS` name rejects
  InvalidParams "<method> needs a client connection"; other kernel handlers get a detached
  `ClientConn` (role `null`, never added to `Core`'s clients).
- A name containing `/` is `method:<name>`. When `plugins.contributions()` has no effective
  contribution with that ID, or the name isn't a valid contribution ID, reject MethodNotFound
  `unknown method: <name>` without activating anything.
- Otherwise `plugins.resolveImplementation(id)` (activation errors pass through as Conflict),
  then call it with `params` and the caller: `{ role, name }` from the connection, or
  `{ role: 'plugin', pluginId }`.
- Any other name rejects MethodNotFound `unknown method: <name>`.
- A `DaemonError` thrown by the handler passes through unchanged. Anything else becomes
  `internal("<owner>: <message>")`, where owner is the effective declaration's `plugin`.
- `undefined` results become `null`. No timeout.

### Events ([Emitting and receiving events](logic.md#data-flow), SC-8 to SC-10)

CONTRACT:
```ts
class PluginEvents {
  constructor(plugins: PluginHost, broadcast: (event: QuirkyEvent) => void, log: (m: string) => void)
  emit(pluginId: string, event: string, data: unknown): boolean
  subscribe(pluginId: string, listener: (event: QuirkyEvent) => unknown): () => void
  deliver(event: QuirkyEvent): void          // Core.onEvent target
  removeAll(pluginId: string): void
}
```

- `event` without `:` means `event:<pluginId>/<event>`. With `:` it is a full ID, and when its
  kind isn't `event` throw `Error("<id> is not an event")`. The full ID must be one of the plugin's
  own `contributes.event` entries (as `event:<pluginId>/<name>`) or one of its `overrides`.
  Otherwise throw `Error("<pluginId> does not declare <full id>")`.
- If the ID is not effective, or its effective `plugin` is not `pluginId`, return false. Else
  broadcast `{ type: <id without "event:">, data: data ?? null }` and return true. A
  non-serializable `data` throws from `broadcast` to the emitter.
- `deliver` schedules each listener with `setImmediate`, in registration order, so a listener
  never runs inside `emit` or `broadcast`. A call that emits as its last step replies first (the
  server sends that reply in a microtask continuation, which runs before `setImmediate`); a method
  that emits and then awaits more work may have its listeners run before it replies. A throw or a
  rejection is logged as `<pluginId>: listener failed: <message>`.

### Stores ([Opening a store](logic.md#data-flow), SC-11 to SC-15)

CONTRACT:
```ts
openPluginStore(options: { home: string; pluginId: string; migrations: StoreMigration[];
  isActive: () => boolean }): { store: PluginStore; close(): void }
pluginDataDir(home: string, pluginId: string): string   // <home>/plugin-data/<pluginId>
```

- `extension.create` makes `pluginDataDir` with mode 0700 (recursive) before returning, and
  `dataDir` is that path.
- File `<dataDir>/store.db`, `PRAGMA journal_mode = WAL`. `version` is `PRAGMA user_version`.
- `migrations` must be an array of strings or functions, else throw. For each index
  `i >= user_version`: `BEGIN IMMEDIATE`, run it (string: `exec`; function: call with the store
  handle; a returned promise is a failure "migrations must be synchronous"), set
  `PRAGMA user_version = i + 1`, `COMMIT`. On any throw: `ROLLBACK`, close the database, throw
  `Error("<pluginId> store migration <i+1> failed: <message>")`.
- `user_version > migrations.length`: close without writing and throw
  `Error("<pluginId> store is at version <v>, but the plugin knows <n> migrations")`.
- `context.openStore` returns the same handle on a second call in one attempt when the count
  matches, and throws "<pluginId> already opened its store with <n> migrations" otherwise. After
  `close()`, every handle method throws "<pluginId> is no longer active".
- `transaction` is SQLite's deferred transaction around a synchronous `work`.

### Scheduler ([Running jobs](logic.md#data-flow), SC-16 to SC-21)

CONTRACT:
```ts
class Scheduler {
  constructor(options: { plugins: PluginHost; store: Pick<Store, 'listJobRuns' | 'recordJobStart' | 'recordJobFinish' | 'recordJobSettled'>;
    log(m: string): void; now?: () => number; recheckMs?: number })
  start(): void                 // arms every effective job; call after activateStartup
  sync(): void                  // on plugin.changed: disarm jobs no longer effective, arm new ones
  list(): JobInfo[]             // effective jobs, sorted by id
  run(id: string): Promise<JobRun>
  revokePlugin(pluginId: string): void   // abort its runs' signals and forget them
  stop(): void                  // clear timers, abort running signals, ignore later outcomes
}
```

- **Due time** of an armed job: never run before → arm time + `initialDelay`; ran before →
  `max(lastFinished + interval, now)`; a last run with no finish → now. `now` is `Date.now()`
  by default. The timer is `setTimeout(min(due - now, recheckMs))` (default `recheckMs` 60_000);
  on wake it re-checks against `now()` and runs if due, else re-arms.
- **A run:** record start; resolve the job through `plugins.resolveImplementation(id)` (activation
  failure → `failed` with its message); call it with `{ jobId, signal }`. The signal aborts at
  `timeout`, on `revokePlugin(owner)`, or on `stop()`. Outcomes: resolves → `ok`; throws →
  `failed` with the message, logged `<owner>: job <id> failed: <message>`; timeout → recorded
  `timed-out` with `finished_at` set to that moment and error `timed out after <n> ms`. When a
  timed-out run's handler later settles, its outcome is ignored except that `finished_at` is
  updated to the settle time (`recordJobSettled`), so the restart rule measures from when the
  job really became free.
- **No overlap:** the job stays `running`, and is not re-armed, until its handler's promise settles,
  even after a timeout. Then the next due time is one interval after the settle. `revokePlugin`
  forgets the stuck run, so a re-activated plugin's job starts fresh.
- `run(id)`: NotFound "no job <id> is in effect" when not effective; Conflict "<id> is already
  running"; otherwise runs it as above and resolves with the finished `JobRun` (a failed run
  resolves, it doesn't reject).
- Outcomes that arrive after `stop()` or after their job was disarmed are not recorded.

### Launch hooks ([Launching a terminal session](logic.md#data-flow), SC-22 to SC-26)

CONTRACT:
```ts
runLaunchHooks(options: { plugins: PluginHost; input: Omit<LaunchHookInput, 'env' | 'args'>;
  timeoutMs: number; warn(pluginId: string, message: string): void })
  : Promise<{ env: Record<string, string | null>; args: string[] }>
```

- Hooks: effective `launch-hook` contributions whose `data.agents` is absent or includes
  `input.agent`, sorted by ID. Each runs alone, bounded by `timeoutMs` (default 5000) covering
  resolve and call together.
- For each returned `env` entry: a name that fails `^[A-Za-z_][A-Za-z0-9_]*$` or a value that is
  neither a string without NUL nor `null` is dropped with warning "launch hook <id> set invalid
  variable <name>"; a reserved name is dropped with "launch hook <id> tried to set reserved
  variable <name>". `args` must be an array of strings without NUL, else all of them are dropped
  with "launch hook <id> returned invalid args". For `agent === 'shell'`, args are dropped with
  "launch hook <id> returned args for a shell session, which take none".
- A throw, a rejection, an activation failure: warning "launch hook <id> failed: <message>". A
  timeout: "launch hook <id> timed out after <n> ms". The hook's changes are discarded and the
  pipeline continues.
- `warn` is `host.addWarning` plus a log line.

### Launch wiring

CONTRACT:
```ts
buildArgv(options: { agent; prompt?; home; shell; extraArgs?: string[] }): string[]
buildSessionEnv(options: { …existing; envPatch?: Record<string, string | null> }): Record<string, string>
CoreOptions.prepareLaunch?: (input: Omit<LaunchHookInput, 'env' | 'args'>) =>
  Promise<{ env: Record<string, string | null>; args: string[] }>
CoreOptions.onEvent?: (event: QuirkyEvent) => void
```

- `extraArgs` go after the kernel's own arguments and before the prompt, each `shellQuote`d;
  ignored for `shell`.
- `envPatch` applies after the copied base environment, `TERM` and `COLORTERM`, and before the
  kernel's zsh wrapper variables, `QUIRKY_*` and `PATH`: a string sets, `null` deletes.
- `Core.createSession` calls `prepareLaunch` after the session row is inserted (so `sessionId`
  exists) and before `pty.request('create')`. `prepareLaunch` never rejects.

### Daemon API and CLI ([SC-16](logic.md#jobs), [SC-18](logic.md#jobs))

SCHEMA:
```ts
'job.list': { params: Record<string, never>; result: JobInfo[] }
'job.run':  { params: { id: string }; result: JobRun }
```

- `quirky job list`: table `ID PLUGIN INTERVAL STATE NEXT LAST` (interval as the shortest
  duration string, next and last as local ISO times, last with its status and error).
- `quirky job run <id>`: prints the run's status, duration and error; exits 1 when the status is
  not `ok`. `--json` prints the method's result.

### Store table

SCHEMA:
```sql
CREATE TABLE IF NOT EXISTS job_runs (
  id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, finished_at INTEGER,
  status TEXT NOT NULL, error TEXT
);
```

CONTRACT:
```ts
listJobRuns(): Map<string, JobRun>
recordJobStart(id: string, at: number): void            // upsert: status 'running', finished_at NULL, error NULL
recordJobFinish(id: string, at: number, status: 'ok' | 'failed' | 'timed-out', error?: string): void
recordJobSettled(id: string, at: number): void          // sets finished_at only when status is 'timed-out'
```

### Daemon wiring

CONFIG: `DaemonOptions.launchHookTimeoutMs?: number` (default 5000);
`DaemonOptions.schedulerRecheckMs?: number` (default 60_000).

`createPluginRuntime({ home, plugins, core, store, log, launchHookTimeoutMs, schedulerRecheckMs })`
returns `{ extension, dispatcher, events, scheduler, prepareLaunch }`. Because `Core` needs
`onEvent` and `prepareLaunch` at construction and the host needs `extension`, `startDaemon`
passes late-bound closures (as it already does for `hookUrl`). Order in `startDaemon`: build
store, PTY client, `Core`, `PluginHost`, runtime; `plugins.load()`; `activateStartup()`;
`scheduler.start()`; listen; write `runtime.json`. The host's `emit` also calls
`scheduler.sync()` on `plugin.changed`. `stop()`: server, `scheduler.stop()`, `plugins.stop()`,
PTY, store.

`extension.revoke(pluginId)` calls `events.removeAll`, `scheduler.revokePlugin`, and closes the
plugin's store.

## DO-NOT-CHANGE fences

- **Existing `Methods` entries, `QuirkyEvent` members and `PROTOCOL_VERSION`**: v1 clients
  depend on them, and renaming v1 methods is m0-port-v1's call (D5).
- **The registry rules** in `registry.ts` and the activation rules in `host.ts` other than the
  listed hooks: m0-registry's locked decisions own them.
- **`buildSessionEnv`'s kernel variables and PATH export**: agents and the hook shim depend on
  them (docs/v1.md "Files and environment").
- **`docs/loop/LOOP.md`, `scripts/build-loop/`**: protected; touching them pauses the loop.
- **`packages/ui/`**: UI-side work is m0-ui-api; only the protocol type addition reaches it.

## Always / Ask / Never

- **Always:** route every client request and every `context.call` through `Dispatcher`. Revoke
  everything an attempt created when the attempt ends. Prefix every log line about plugin code
  with the plugin ID. Keep each store and each kind's data inside its plugin's namespace.
- **Ask (headless: decide and log a decision):** a new field on any of the four kinds; a change to
  the reserved variable list; any change to job timing rules.
- **Never:** activate a plugin to list jobs, methods or events. Start a job run while the same
  job's previous run is unsettled. Let a launch hook stop a session from starting. Touch the real
  `~/.quirky`, `~/.claude` or `~/.codex` in tests, or launch a real agent CLI.

## Cross-cutting

- **Security:** full trust, in process (locked). Reserved variables protect the session's link to
  the daemon, not against a hostile plugin.
- **Observability:** activation, listener failures, job failures and hook failures log with the
  plugin ID; hook problems also show as plugin warnings.
- **Migration:** `job_runs` is `IF NOT EXISTS`; homes without `plugin-data/` need nothing.
- **Platforms:** nothing here is macOS-only. The `PATH`/login-shell handling is POSIX-shell
  specific, as v1's already is.

## Testing strategy

Acceptance bar: every scenario SC-1 to SC-28 has a named test that drives the daemon API (a real
client from `startHarness`) or the `quirky` CLI, plus the three LOOP.md commands pass. Every test
uses a fresh temporary `QUIRKY_HOME`, the fake PTY host and fake git, and kills what it starts.

- `packages/daemon/test/plugins/kinds.test.ts`: every message in [Kind validation](#kind-validation-sc-28) and `parseDuration`.
- `packages/daemon/test/plugins/methods.test.ts`: SC-1 to SC-7 through `client.callAny` and a
  `relay` fixture for `context.call`.
- `packages/daemon/test/plugins/events.test.ts`: SC-8 to SC-10 with `connectWithEvents`.
- `packages/daemon/test/plugins/stores.test.ts`: SC-11 to SC-15, restarting `startDaemon` on the
  same home and swapping fixture plugin versions between starts; reads `user_version` with
  `bun:sqlite` directly for the version assertions.
- `packages/daemon/test/plugins/scheduler.test.ts`: SC-16 to SC-21 with `1s` intervals and a small
  `schedulerRecheckMs`; SC-21 seeds `job_runs` in `quirky.db` before starting the daemon.
- `packages/daemon/test/plugins/launch-hooks.test.ts`: SC-22 to SC-26 through `session.create`,
  asserting on the fake PTY host's recorded `argv` and `env`; a small `launchHookTimeoutMs` for
  the timeout case.
- `packages/daemon/test/plugins/lifecycle.test.ts`: SC-27.
- `packages/daemon/test/sessions.test.ts`: `buildArgv` with `extraArgs` and `buildSessionEnv` with
  `envPatch`.
- `packages/cli/test/job.test.ts`: `job list` and `job run` against `FakeDaemon`, including the
  exit code for a failed run.
- The m0-registry tests must still pass unchanged.

## Non-goals

Everything in the logic spec's [Scope & non-goals](logic.md#scope--non-goals), plus: a generic
`quirky call` command (m0-scripting generates CLI groups), limits on store size, and backup of
plugin stores.
