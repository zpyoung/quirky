# Daemon plugin API: methods, events, stores, scheduler and launch hooks

## Status & amendments

**Status:** Approved (headless build loop; decisions in [m0-daemon-api.md](../../../loop/decisions/m0-daemon-api.md)). Tech spec: requested.

**Amendments:**
- 2026-10-26, before approval: Codex adversarial review. Defined how a plugin emits an event it overrides (full ID), made the no-overlap rule hold for runs that ignore their stop signal, spelled out the store interface, stated test isolation, and added `ZDOTDIR` to the reserved variables.
- 2026-10-26, during build: final review. Listener timing now promises a later event-loop turn rather than "after any reply": a method that emits and then keeps awaiting may see its listeners run before it replies (decision D42).

## Conceptual model

[m0-registry](../2026-10-26-m0-registry/logic.md) gave Quirky plugins that declare contributions
in a manifest and provide their implementations when they activate. It accepted any contribution
kind and gave a plugin nothing to do once active except `provide` and `log`. This item gives
daemon plugins the five things the roadmap says later features need
([roadmap.md](../../../roadmap.md#m0-plugin-kernel-with-v1-moved-onto-it)): RPC methods, events,
a store of their own with migrations, a scheduler, and hooks into agent launch.

Four of the five are **contribution kinds**, declared in the manifest like any other contribution,
so they can be listed, overridden and disabled by stable ID without loading code
([m0-registry D23](../../../loop/decisions/m0-registry.md)):

- A **method** (`method:<pluginId>/<name>`) is an RPC method any client can call. Its wire name is
  the ID without the kind, `<pluginId>/<name>`, such as `acme.tools/refresh`. Kernel methods keep
  their dotted names (`repo.list`, `plugin.list`), which never contain `/`, so the two can't
  collide.
- An **event** (`event:<pluginId>/<name>`) is something the plugin announces. Subscribers receive
  it as `{ type: "<pluginId>/<name>", data }` next to the kernel's own events.
- A **job** (`job:<pluginId>/<name>`) is work the scheduler runs on a fixed interval declared in the
  manifest.
- A **launch hook** (`launch-hook:<pluginId>/<name>`) runs before a terminal session starts and can
  add environment variables and agent arguments.

The fifth, the **store**, is not a contribution. Each plugin may open one SQLite database of its
own, kept under `<QUIRKY_HOME>/plugin-data/<pluginId>/`. The plugin passes an ordered list of
migrations when it opens it, and the kernel runs the ones the database hasn't seen yet. The store
it gets back is a small SQL interface, not a raw driver handle: `run`, `get` and `all` take a SQL
statement and positional parameters (`run` reports the rows changed and the last inserted row ID,
`get` returns one row or nothing, `all` returns every row), `exec` runs statements without
parameters, `transaction` runs a synchronous function atomically, and `version` reports how many
migrations the store has run. A migration is either SQL text or a function that receives this
same interface.

Everything a plugin gets is on the **plugin context** its `activate` receives: the existing
`provide` and `log`, plus `emit`, `subscribe`, `call`, `openStore`, `dataDir` and `error`. All of
it is revoked when the plugin deactivates: listeners are removed, the store is closed, running
jobs are told to stop, and the context's calls throw.

## Data flow

**Calling a method.** A client sends a JSON-RPC request named `acme.tools/refresh`. The daemon
finds no kernel method of that name, sees the `/`, and resolves `method:acme.tools/refresh` in the
registry. That activates `acme.tools` if it is lazy and inactive, as any resolve does. The kernel
calls the implementation with the params and a description of the caller, and sends back whatever
it returns. If the ID is in effect through an override, the overriding plugin's implementation
runs. If it isn't in effect at all, the client gets the same "unknown method" error as for any
other unknown name.

**Emitting and receiving events.** A plugin calls `context.emit("refreshed", data)`. A short
name like `refreshed` always means an event in the plugin's own namespace,
`event:acme.tools/refreshed`; to emit an event it overrides, a plugin passes the full ID, such as
`event:acme.tools/refreshed` from `acme.better`. If the event is in effect and owned by this plugin, the daemon sends
`{ type: "acme.tools/refreshed", data }` to every subscribed client and every plugin listener.
Plugin listeners registered with `context.subscribe` receive every event the daemon sends,
kernel and plugin alike. They are called on a later turn of the event loop, never inside the call that emitted, and a method that emits as its last step sends its reply first, so a slow or
failing listener never affects the emitter or other listeners.

**Opening a store.** A plugin calls `context.openStore(migrations)` during or after activation. The
kernel opens `<QUIRKY_HOME>/plugin-data/<pluginId>/store.db`, reads which migration the database
last ran, and runs each later one in order, each in its own transaction. If one fails, that step
rolls back, the database stays at the last good step, and `openStore` throws. If the database has
run more migrations than the plugin knows about (the plugin was downgraded), `openStore` refuses
and leaves the data alone.

**Running jobs.** After startup plugins have settled, the scheduler arms a timer for every job in
effect. When one fires, the scheduler resolves the job, which activates its plugin if needed, and
calls it with a stop signal. The next run is armed one interval after the run finishes, so runs of
one job never overlap. A run that outlives its timeout is recorded as timed out and its signal is
aborted, but the job counts as running until the run's code actually returns, and only then is the
next run armed. A run that ignores its signal therefore holds its job until it returns or its
plugin deactivates. Fixed delay also means a laptop waking from sleep runs an overdue job once, not once per missed
interval. Due times are wall-clock times that the scheduler re-checks at least once a minute,
because timers pause while the machine sleeps. The kernel records each job's last start, finish
and outcome, so after a restart an
overdue job runs promptly and a job that isn't due waits out the rest of its interval. When the
registry changes, the scheduler disarms jobs no longer in effect and arms new ones.

**Launching a terminal session.** Before the daemon asks the PTY host to start a session, it
collects the launch hooks in effect whose agent filter matches, in contribution ID order. Each
hook sees the session's details and the environment and extra arguments built so far, and returns
changes. The kernel applies them, refusing changes to variables it owns, and starts the session.
A hook that throws or takes too long is skipped with a warning, and the session starts without its
changes.

## Key decisions

Each is logged in full in [m0-daemon-api.md](../../../loop/decisions/m0-daemon-api.md).

- **Declared contributions, provided implementations** ([D13](../../../loop/decisions/m0-daemon-api.md)).
  Three approaches were weighed:
  1. **Methods, events, jobs and hooks declared in the manifest; code provides the implementations**
     (chosen). It extends m0-registry's model unchanged: listing, overriding and disabling need no
     code, and a lazy plugin loads only when something uses one of its contributions.
  2. **Imperative registration**: `context.registerMethod`, `context.schedule` and so on, after
     activation. Simpler to write, but a method or job isn't visible, overridable or disableable
     until its plugin has loaded, which m0-registry D23 rejected.
  3. **Typed service references** in the Backstage style, where each capability is a separately
     injected service. It suits multi-instance backends; for one in-process daemon it adds a
     dependency-injection layer without changing what a plugin can do.
- **Method wire names are `<pluginId>/<name>`** ([D4](../../../loop/decisions/m0-daemon-api.md)),
  following LSP's `textDocument/didOpen`. v1's method names stay kernel methods until m0-port-v1
  decides how they move ([D5](../../../loop/decisions/m0-daemon-api.md)).
- **One SQLite file per plugin, migrated forward only** ([D9](../../../loop/decisions/m0-daemon-api.md),
  [D10](../../../loop/decisions/m0-daemon-api.md)).
- **Fixed-delay jobs with a recorded last run** ([D15](../../../loop/decisions/m0-daemon-api.md),
  [D16](../../../loop/decisions/m0-daemon-api.md)).
- **Launch hooks fail open** ([D22](../../../loop/decisions/m0-daemon-api.md)): a broken hook never
  stops a session from starting.

## Behavior & scenarios

Fixtures are illustrative. Every scenario runs against a fresh temporary `QUIRKY_HOME` with a
fake PTY host, so no real agent CLI starts and the user's own state is never read or written.
Every scenario is driven through the daemon API (a client calling
methods and subscribing to events), the `quirky` CLI, or the session launch path that
`session.create` drives, with fixture plugins whose methods expose what the plugin observed.

### Methods

1. **SC-1: a client calls a plugin method, and a lazy plugin activates for it**
   - **Given** lazy `acme.tools` declares method `refresh` and provides a function returning `{ refreshed: params.count }`
   - **When** a client calls `acme.tools/refresh` with `{ count: 2 }`
   - **Then** `acme.tools` activates and the client receives `{ refreshed: 2 }`; the method's handler also received the caller's role (`cli`)
   - **Data before:** **acme.tools**: inactive; module not imported
   - **Walkthrough:**
     1. The client calls `acme.tools/refresh` with `{ count: 2 }`
     2. The kernel resolves `method:acme.tools/refresh` and activates `acme.tools`
     3. The handler runs and returns
   - **Data after:** **acme.tools**: ✓ active; reply ✓ `{ refreshed: 2 }`

2. **SC-2: an unknown or disabled plugin method is not found, and loads nothing**
   - **Given** `acme.tools` declares `refresh`, and the user has disabled `method:acme.tools/refresh`
   - **When** a client calls `acme.tools/refresh`, and then `acme.tools/nope`
   - **Then** both fail with the JSON-RPC "method not found" error, and `acme.tools` is still not imported

3. **SC-3: an overridden method runs the override**
   - **Given** `acme.tools` declares `refresh`, and `acme.better` overrides `method:acme.tools/refresh`
   - **When** a client calls `acme.tools/refresh`
   - **Then** `acme.better`'s implementation answers, and `acme.tools` is not loaded

4. **SC-4: plugin errors reach the client with the right code**
   - **Given** method `acme.tools/fail` throws, depending on its params, `context.error('not-found', 'no widget w1')`, `context.error('invalid-params', 'count must be positive')`, `context.error('conflict', 'busy')`, or a plain `Error('boom')`
   - **When** a client calls it with each
   - **Then** the client gets the matching error code with the message as written for the first three, and the internal error code with the message `acme.tools: boom` for the plain error; the daemon keeps serving
   - **Details:**

     | Thrown | Client sees |
     |---|---|
     | `error('not-found', 'no widget w1')` | NotFound, "no widget w1" |
     | `error('invalid-params', 'count must be positive')` | InvalidParams, "count must be positive" |
     | `error('conflict', 'busy')` | Conflict, "busy" |
     | `Error('boom')` | Internal, "acme.tools: boom" |

5. **SC-5: a method whose plugin can't activate reports why**
   - **Given** `acme.broken` declares `go`, and its activate throws `bad config`
   - **When** a client calls `acme.broken/go`
   - **Then** the call fails with Conflict "acme.broken failed to activate: bad config"

6. **SC-6: a plugin calls other methods through its context**
   - **Given** `acme.caller`'s method `relay` calls `context.call('acme.tools/refresh', { count: 3 })` and `context.call('repo.list', {})`
   - **When** a client calls `acme.caller/relay`
   - **Then** the result holds `{ refreshed: 3 }` and the repo list; `acme.tools` activated for the inner call, and its handler saw the caller as plugin `acme.caller`. A context call to a method that needs a client connection (`client.hello`, `events.subscribe`, `terminal.attach`, `terminal.detach`) fails with InvalidParams.

7. **SC-7: a method must be provided as a function**
   - **Given** `acme.tools` provides the string `"nope"` for `method:acme.tools/refresh`
   - **When** it activates
   - **Then** activation fails and the plugin is `failed` with a diagnostic saying the method must be a function. The same holds for jobs and launch hooks.

### Events

8. **SC-8: a plugin event reaches subscribed clients**
   - **Given** `acme.tools` declares event `refreshed`, and a client has subscribed to events
   - **When** `acme.tools` calls `context.emit('refreshed', { count: 2 })`
   - **Then** the client receives `{ type: 'acme.tools/refreshed', data: { count: 2 } }`

9. **SC-9: only a plugin's own events in effect are emitted**
   - **Given** `acme.tools` declares `refreshed` but not `other`, and the user has disabled `event:acme.tools/refreshed`
   - **When** `acme.tools` emits `other`, and then emits `refreshed`
   - **Then** emitting `other` throws "acme.tools does not declare event:acme.tools/other"; emitting `refreshed` returns false and sends nothing. When `acme.better` overrides `event:acme.tools/refreshed`, `acme.better` emits it with `context.emit('event:acme.tools/refreshed', data)`, which clients receive as `acme.tools/refreshed`, and `acme.tools`'s own emits of `refreshed` return false. A full ID the plugin neither declares nor overrides throws the same "does not declare" error.

10. **SC-10: plugin listeners see kernel and plugin events, and their failures are contained**
    - **Given** startup plugin `acme.watch` subscribes with a listener that records each event type, and startup plugin `acme.flaky` subscribes with a listener that throws
    - **When** a client adds a repo and `acme.tools` emits `refreshed`
    - **Then** `acme.watch` recorded `repo.changed` and `acme.tools/refreshed`, the add-repo call succeeded, and `acme.flaky`'s error was logged with its plugin ID
    - **Walkthrough:**
      1. The client calls `repo.add`
      2. The kernel broadcasts `repo.changed`
      3. Both listeners are called after `repo.add` has replied
      4. A client calls `acme.watch/seen`
    - **Data after:** **acme.watch/seen** ✓ `['repo.changed', 'acme.tools/refreshed']`

### Stores

11. **SC-11: a plugin's store persists and is its own**
    - **Given** `acme.notes` and `acme.todo` each open a store whose first migration creates a table named `items`
    - **When** a client adds an item through `acme.notes/add`, restarts the daemon, and lists items through `acme.notes/list` and `acme.todo/list`
    - **Then** `acme.notes` lists the item after the restart and `acme.todo` lists nothing; the two databases are separate files under `plugin-data/acme.notes/` and `plugin-data/acme.todo/`
    - **Data before:** **plugin-data/**: absent
    - **Walkthrough:**
      1. The client calls `acme.notes/add` with `{ text: "milk" }`
      2. The daemon restarts on the same home
      3. The client calls `acme.notes/list`, then `acme.todo/list`
    - **Data after:** **acme.notes items** ✓ `["milk"]`; **acme.todo items** ✓ `[]`

12. **SC-12: migrations run once each, in order, and new ones run on upgrade**
    - **Given** `acme.notes` v1 has migrations [create `items`], and the daemon has run it
    - **When** the plugin is replaced by v2 with migrations [create `items`, add column `done`, backfill `done = 0`] and the daemon restarts
    - **Then** only the second and third run; the store reports version 3, and the item from v1 is still there with `done = 0`
    - **Data before:** **store version**: 1; **items**: `milk`
    - **Data after:** **store version**: ✓ 3; **items**: ✓ `milk`, done 0

13. **SC-13: a failing migration rolls back its step and stops activation**
    - **Given** `acme.notes` v2's second migration has a SQL error, and its activate opens the store
    - **When** the plugin activates
    - **Then** activation fails with "acme.notes store migration 2 failed: …", the store stays at version 1 with its data, and once the migration is fixed and the plugin activated again, the store reaches version 3
    - **Data after:** **store version** ✓ 1 after the failure, ✓ 3 after the fix

14. **SC-14: a downgraded plugin can't open a newer store**
    - **Given** the store is at version 3, and the plugin is replaced by v1, which knows one migration
    - **When** the plugin opens its store
    - **Then** `openStore` throws "acme.notes store is at version 3, but the plugin knows 1 migrations", and the file is unchanged

15. **SC-15: a deactivated plugin's store is closed but kept**
    - **Given** `acme.notes` is active with an open store and one item
    - **When** the agent runs `quirky plugin disable acme.notes`, then `quirky plugin enable acme.notes` and calls `acme.notes/list`
    - **Then** the store handle the plugin kept from its first activation throws "acme.notes is no longer active" if used after the disable, and the item is listed after the enable

### Jobs

16. **SC-16: a job runs on its interval, and its lazy plugin loads only when it first runs**
    - **Given** lazy `acme.poll` declares job `tick` with interval `1s`, which appends to a marker file
    - **When** the daemon starts and a client checks the marker right away, then after about two seconds
    - **Then** right away `acme.poll` is not imported; later it is active and `tick` has run at least once; `quirky job list` shows `job:acme.poll/tick` with its last run `ok`

17. **SC-17: a job's runs never overlap**
    - **Given** job `acme.poll/slow` with interval `1s` takes three seconds per run
    - **When** it runs for about five seconds
    - **Then** at most one run is in progress at any time, and each run starts at least one second after the previous one finished

18. **SC-18: a job can be run now, and failures are recorded without stopping the schedule**
    - **Given** job `acme.poll/flaky` throws `upstream down` on its first run and succeeds after
    - **When** the agent runs `quirky job run job:acme.poll/flaky` twice
    - **Then** the first prints a failure with `upstream down`, the second succeeds, and `quirky job list` shows the last outcome `ok`; running a job that is already running fails with Conflict "job:acme.poll/flaky is already running"
    - **Data after:** **job:acme.poll/flaky** last run ✓ ok

19. **SC-19: a job that overruns its timeout is told to stop**
    - **Given** job `acme.poll/hang` has timeout `1s` and waits for its stop signal
    - **When** it runs
    - **Then** its signal is aborted after one second, the run is recorded `timed-out`, and once the run's code returns the job is armed for one interval later. A variant that ignores its signal and keeps going for three seconds stays `running` in `quirky job list` until it returns, and no second run starts in the meantime.

20. **SC-20: disabling a job or its plugin stops it, and enabling resumes it**
    - **Given** job `acme.poll/tick` runs every second
    - **When** the agent disables `job:acme.poll/tick`, waits two seconds, then enables it
    - **Then** no run starts while it is disabled, `quirky job list` doesn't list it then, and runs resume after the enable. Disabling plugin `acme.poll` instead aborts a run in progress and stops the job the same way.

21. **SC-21: an overdue job runs once after a restart, and a job not yet due waits**
    - **Given** job `acme.poll/daily` (interval `24h`) last finished 25 hours ago, and job `acme.poll/hourly` (interval `1h`) last finished 10 minutes ago
    - **When** the daemon starts
    - **Then** `daily` runs once shortly after startup, and `hourly`'s next run is about 50 minutes away, as `quirky job list` shows

### Launch hooks

22. **SC-22: a launch hook adds environment and arguments to an agent session**
    - **Given** `acme.env` declares launch hook `vars` for agent `claude`, which sets `ACME_TOKEN=abc` and adds the arguments `--model opus`
    - **When** a client creates a Claude session with prompt `hi`
    - **Then** the session's environment has `ACME_TOKEN=abc`, and its command runs `claude --settings <file> '--model' 'opus' 'hi'`, each added argument quoted for the shell
    - **Data after:** **session env** ✓ `ACME_TOKEN=abc`; **command** ✓ `claude --settings … '--model' 'opus' 'hi'`

23. **SC-23: a hook for other agents doesn't run, or load**
    - **Given** lazy `acme.env`'s hook is for `claude` only
    - **When** a client creates a shell session
    - **Then** the session has no `ACME_TOKEN`, and `acme.env` is not imported

24. **SC-24: several hooks run in ID order and see each other's changes**
    - **Given** hooks `launch-hook:acme.a/first` sets `STAGE=a`, and `launch-hook:acme.b/second` sets `STAGE=<previous STAGE>b`
    - **When** a client creates a Claude session
    - **Then** the session has `STAGE=ab`

25. **SC-25: a hook can't change the kernel's variables, and a broken hook doesn't block the launch**
    - **Given** one hook sets `QUIRKY_SESSION_ID=x` and `PATH=/evil` alongside `OK=1`, one throws `nope`, and one never returns
    - **When** a client creates a Claude session
    - **Then** the session starts within the hook timeout plus a margin, with the kernel's `QUIRKY_SESSION_ID` and `PATH` and with `OK=1`; each offending plugin carries a warning ("launch hook launch-hook:… tried to set reserved variable PATH", "launch hook … failed: nope", "launch hook … timed out after 5000 ms") in `quirky plugin list`

26. **SC-26: a disabled hook isn't applied**
    - **Given** the user has disabled `launch-hook:acme.env/vars`
    - **When** a client creates a Claude session
    - **Then** the session has no `ACME_TOKEN`

### Lifecycle and manifests

27. **SC-27: deactivation revokes everything the context handed out**
    - **Given** active `acme.all` has a listener, an open store, a running job and a saved reference to its context
    - **When** the agent disables `acme.all`
    - **Then** its listener receives no further events, its job's stop signal is aborted, and calling `emit`, `call` or `openStore` on the saved context, or using the saved store, throws "acme.all is no longer active"

28. **SC-28: bad declarations of the four kinds make the plugin invalid**
    - **Given** one installed plugin per problem below
    - **When** the daemon starts
    - **Then** each is `invalid` with the diagnostic shown, and valid plugins are unaffected
    - **Details:**

      | Declaration | Diagnostic says |
      |---|---|
      | job `tick` without `interval` | job tick: interval is required |
      | job `tick` with interval `500ms` | job tick: interval must be between 1s and 24h |
      | job `tick` with interval `soon` | job tick: interval must be a duration such as 30s, 5m or 2h |
      | launch hook with `agents: "claude"` | launch-hook vars: agents must be a list of agent names |
      | method `go` with field `handler` | method go: unknown field `handler` |
      | override of `job:acme.poll/tick` with interval `2d` | override job:acme.poll/tick: interval must be between 1s and 24h |

## Scope & non-goals

In scope: the four contribution kinds and their manifest fields, method dispatch from every
client, plugin events, plugin listeners, per-plugin stores with forward migrations and a data
directory, interval jobs with the `job.list` and `job.run` methods and a `quirky job` CLI group,
launch hooks for terminal sessions, and revoking all of it on deactivation.

Out of scope, each owned elsewhere:

- **Parameter and result schemas for methods and events, the generated CLI, and `quirky api`:**
  m0-scripting. Until then methods take any object, and plugin methods are called through the API
  or through `context.call`.
- **Moving v1's methods, events and tables into built-in plugins**, and whether v1's method names
  keep aliases: m0-port-v1.
- **UI contribution kinds** (views, panels, commands, keybindings, settings, themes): m0-ui-api.
- **Deleting a plugin's data when it is uninstalled**, and install consent: m0-distros.
- **Confirmations for irreversible plugin methods** (`quirky ask` unless `--yes`): m0-distros.
- **Launch hooks for structured sessions:** M5, which rebuilds the structured runners.
- **Agent definitions as contributions** (the 45 CLIs as data): M1's agent launch.
- **Cron schedules and jobs created at runtime** (for user automations): M5's automations.
- **Event filtering on `events.subscribe` and rate limits on plugin events:** added when a client
  needs them.
- **A plugin reading another plugin's store,** including one it overrides.

## Decisions Locked

All were made headless and are logged with options, evidence and confidence in
[m0-daemon-api.md](../../../loop/decisions/m0-daemon-api.md).

- **Naming convention:** method wire names `<pluginId>/<name>` (D4); v1 names untouched here (D5); plugin events as `{ type: "<pluginId>/<name>", data }` (D6); kinds `method`, `event`, `job`, `launch-hook` (D7) — assumed — fast-tracked
- **Response format:** a method's return value is its result, with `undefined` sent as `null` (D8); `job.list` and `job.run` shapes (D18) — assumed — fast-tracked
- **Error responses:** `context.error` maps to NotFound, InvalidParams and Conflict; anything else is Internal prefixed with the plugin ID (D8); unknown or disabled methods are "method not found" (D4) — assumed — fast-tracked
- **Exception handling:** listeners are called asynchronously and contained (D11); job failures are recorded, not retried early (D17); launch hooks fail open with a 5-second timeout (D22); a context call to a connection-bound method is refused (D12) — assumed — fast-tracked
- **Versioning:** stores migrate forward only, by an ordered list, and refuse a downgrade (D10) — assumed — fast-tracked
- **Rate limiting:** jobs never overlap and take at least 1 second between runs (D15); no limits on events or method calls (D25) — assumed — fast-tracked
- **Authentication:** plugin methods use the daemon token like every method; any client may call any method (D24, locked by roadmap.md "Agent access")
- **Storage:** one SQLite file per plugin plus a data directory (D9); job history in the kernel's store (D16) — assumed — fast-tracked
- **Launch hooks:** env and argument changes only, terminal sessions only, `PATH`, `ZDOTDIR` and `QUIRKY_*` reserved (D20, D21, D23) — assumed — fast-tracked

## Industry Insights

- **Hosts hand each plugin a small context and stamp the caller's identity on every call.**
  Backstage injects services such as the scheduler as dependencies; Grafana passes a plugin
  context with each resource call.
  https://backstage.io/docs/backend-system/core-services/scheduler/ ;
  https://github.com/grafana/grafana-plugin-sdk-go/blob/main/backend/resource.go
- **Name collisions between plugin commands are a recurring failure,** so wire names should be
  collision-free by construction or rejected at registration.
  https://github.com/microsoft/vscode-python/issues/9578 ;
  https://github.com/AArnott/Nerdbank.JsonRpc/pull/71
- **Listeners and timers that outlive their plugin are the common event-bus leak;** the fix is for
  the host to own every subscription and dispose of it on unload.
  https://github.com/NousResearch/hermes-agent/pull/112376 ;
  https://github.com/plures/pedantic/issues/194
- **A migration and its version bump must commit together.** Runners that split them left apps
  unable to start after a crash, and opening a newer database with an older app has lost user data.
  https://github.com/sparsileg/astryx/issues/301 ;
  https://bugzilla.mozilla.org/show_bug.cgi?id=1074817 ;
  https://docs.openclaw.ai/reference/database-schemas/versioning
- **SQLite's `PRAGMA foreign_keys` is a no-op inside a transaction, and ADD COLUMN can't add a
  primary key or unique column,** which plugin authors writing migrations need to know.
  https://www.sqlite.org/lang_altertable.html
- **A file per plugin isolates writes and makes uninstall a delete,** at the cost of no direct
  cross-plugin joins. Each open database has its own page cache (about 2 MB at the default),
  which is why stores open only on demand.
  https://www.sqlite.org/pragma.html ; https://www.sqlite.org/wal.html ;
  https://github.com/backstage/backstage/issues/36218
- **Timers pause or drift across macOS sleep,** so due times should be wall-clock and re-checked,
  and missed runs coalesced into one, as systemd's `Persistent=` does.
  https://github.com/nodejs/node/issues/20661 ; https://github.com/stablyai/orca/issues/28291 ;
  https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html
- **A run that can't be killed must be given a stop signal.** Backstage's stuck global task was
  fixed by passing the scheduler's AbortSignal into the job.
  https://github.com/backstage/backstage/issues/32641
- **`setTimeout` clamps delays over 2^31-1 ms to 1 ms,** so a long interval fires immediately
  unless it is capped or chunked. https://nodejs.org/api/timers.html
- **Extensions that each change a shared environment overwrite one another,** and login zsh on
  macOS resets `PATH` set before the shell starts.
  https://github.com/microsoft/vscode/issues/138109 ;
  https://github.com/microsoft/vscode/issues/188235
- **Slow extension startup delays terminals,** so launch-time hooks need a bound.
  https://github.com/microsoft/vscode/issues/144939

## Deferred Ideas

- `[tech-spec]` Where the method router, event fan-out, store manager, scheduler and hook runner
  live in `packages/daemon/src/plugins/`, and how the host builds the extended context.
- `[tech-spec]` How the extra arguments are spliced into the login-shell command string.
- Event filters on `events.subscribe` (D25).
- A `job.changed` event, if a UI needs live job status.
- Launch hooks that change `PATH`, if M1's agent providers need it (D21).
- Launch hooks for structured sessions in M5 (D23).

## Glossary

- **Plugin context:** the object a plugin's `activate` receives; everything it can do goes through it.
- **Wire name:** the JSON-RPC method name a client sends.
- **Kernel method:** a method the daemon itself implements, such as `repo.list` or `plugin.list`.
- **Listener:** a function a plugin registers with `context.subscribe` to receive events.
- **Store:** a plugin's own SQLite database under `plugin-data/<pluginId>/store.db`.
- **Migration:** one step in the ordered list a plugin passes to `openStore`, as SQL or a function.
- **Store version:** how many migrations the store has run.
- **Job:** a declared piece of work the scheduler runs on an interval.
- **Fixed delay:** the next run starts one interval after the previous one finished.
- **Launch hook:** a declared function that changes a terminal session's environment and agent
  arguments before it starts.
- **Reserved variable:** `PATH`, `ZDOTDIR` or any `QUIRKY_*` variable, which only the kernel sets.
