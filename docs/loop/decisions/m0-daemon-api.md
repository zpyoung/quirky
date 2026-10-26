# m0-daemon-api decisions

## D1: Classify the item as an API design, and run both research phases
- **Question:** which domain the gray-area catalog draws from, and whether the research swarms run (quirk:brainstorming, checklist steps 2 and 7)
- **Options:** API; API plus Organization; skip research as covered by m0-registry
- **Chose:** API, with Organization's naming and exception areas added. Phase A ran two web-research agents (patterns, pitfalls); Phase B ran three, one per open option (store layout, migration runner, scheduler semantics).
- **Why:** the consumers are plugin authors and API clients, and m0-registry's research covered registries, not methods, stores, schedulers or launch hooks. Research swarms are pre-authorized by LOOP.md.
- **Evidence:** docs/loop/LOOP.md "Answering a skill's questions"; docs/roadmap.md M0 "Daemon API"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D2: Skip the visual companion and the adhd offer, use the standard gray-area set
- **Question:** brainstorming's visual companion offer and its Step 0 adhd offer
- **Options:** run them; skip them
- **Chose:** skip both
- **Why:** LOOP.md says to skip the parts that assume a person is there
- **Evidence:** docs/loop/LOOP.md "Skip the parts that assume a person is there"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D3: Select every gray area that matters for the daemon plugin API
- **Question:** which gray areas to drill into (brainstorming Gray Areas Step 1)
- **Options:** API: response-format, error-responses, authentication, versioning, rate-limiting, pagination; Organization: naming-convention, exception-handling
- **Chose:** naming-convention, response-format, error-responses, exception-handling, versioning (store migrations), rate-limiting (job pacing, event volume) and authentication (who may call plugin methods)
- **Why:** LOOP.md asks for every area that matters. Pagination is dropped because no method this item adds returns an unbounded list; plugins page their own methods' results.
- **Evidence:** docs/loop/LOOP.md "Gray areas"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D4: Plugin method wire names are `<pluginId>/<name>`
- **Question:** the JSON-RPC name a client sends to call a plugin's method (naming-convention)
- **Options:** `<pluginId>.<name>` (collides: plugin `acme` method `tools.refresh` and plugin `acme.tools` method `refresh` give the same name); strip `quirky.` for built-ins so `quirky.repo` + `list` is `repo.list` (collides with an installed plugin named `repo`); the contribution ID without the kind, `<pluginId>/<name>`; the full contribution ID `method:<pluginId>/<name>`
- **Chose:** `<pluginId>/<name>`. Kernel method names never contain `/`, and plugin IDs never do, so the split is unambiguous and nothing can collide. Calling a name with `/` whose method isn't in effect (unknown, disabled, owner invalid) returns the standard MethodNotFound error.
- **Why:** it is collision-free by construction (research: duplicate command IDs are a recurring activation failure in VS Code), it survives overrides because the ID stays the same, and LSP already uses `/` in JSON-RPC method names
- **Evidence:** packages/protocol/src/plugins.ts PLUGIN_ID_RE and CONTRIBUTION_NAME_RE; https://github.com/microsoft/vscode-python/issues/9578 ; https://github.com/AArnott/Nerdbank.JsonRpc/pull/71
- **Reversibility:** hard
- **Confidence:** medium
- **Revisit if:** m0-scripting's generated CLI or m0-port-v1 needs short dotted names for built-in groups and aliases prove messy
- **Source:** assumed — autonomous

## D5: v1's methods stay kernel methods in this item
- **Question:** whether this item renames or moves `repo.list` and the other v1 methods (naming-convention)
- **Options:** move them now; leave them and let m0-port-v1 decide renames or aliases
- **Chose:** leave them. Kernel methods are dispatched first; plugin methods are only consulted for names containing `/`.
- **Why:** moving v1 features is m0-port-v1's item, and it can choose between renaming (all clients are in this repo) and adding aliases with full knowledge of the UI and CLI changes
- **Evidence:** docs/loop/queue.json m0-port-v1; docs/roadmap.md "v1 as built-ins"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D6: Plugin events arrive as `{ type: "<pluginId>/<name>", data }`
- **Question:** how a plugin event looks to a subscribed client (naming-convention, response-format)
- **Options:** a wrapper `{ type: 'plugin.event', event, plugin, payload }`; the event's own type `<pluginId>/<name>` with the payload under `data`; the payload's fields spread at top level like kernel events
- **Chose:** `{ type: "<pluginId>/<name>", data }`. A plugin may emit only events it declares or overrides, and only while the ID is in effect with this plugin as owner. `emit` takes a short name for the plugin's own events and the full ID for an event it overrides (added after the logic-spec review, D28). Emitting an undeclared event throws; emitting a declared event that is disabled or owned by an override returns false and sends nothing.
- **Why:** the type is the same string as the method naming, so a client filters on `type` for both kernel and plugin events. A separate `data` field means a payload can never overwrite `type`. Dropping overridden emits keeps one owner per ID, as the registry does for implementations.
- **Evidence:** packages/protocol/src/rpc.ts QuirkyEvent; research: Backstage events service uses topics with publish and subscribe only (https://backstage.io/docs/reference/plugin-events-node/)
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** m0-port-v1 wants v1 events to keep their top-level fields when they move into plugins
- **Source:** assumed — autonomous

## D7: The four kinds are `method`, `event`, `job` and `launch-hook`
- **Question:** the contribution kind names (naming-convention)
- **Options:** `method`/`rpc`; `job`/`task`/`schedule`; `launch-hook`/`agent.launch`/`hook`
- **Chose:** `method`, `event`, `job`, `launch-hook`
- **Why:** `method` matches the architecture's "method groups"; `task` will mean orchestration tasks in M6, so `job` avoids the clash; `hook` alone would be confused with agent status hooks (`POST /hook/<agent>`)
- **Evidence:** docs/architecture.md "Method groups"; docs/roadmap.md M6 orchestration "tasks"; docs/v1.md "quirky-hook"
- **Reversibility:** hard
- **Confidence:** high
- **Source:** assumed — autonomous

## D8: Method results and errors
- **Question:** what a client receives from a plugin method (response-format, error-responses)
- **Options:** the return value as is; a wrapped `{ ok, value }`. For errors: plugin-chosen numeric codes; a fixed set through a context helper; everything Internal
- **Chose:** the return value is the result, with `undefined` sent as `null`. `context.error(kind, message)` builds an error for `invalid-params`, `not-found` or `conflict`, which reaches the client with that JSON-RPC code and the message unchanged. Anything else thrown becomes Internal with the message prefixed `<pluginId>: `. A plugin whose activation fails gives Conflict "<id> failed to activate: …" (m0-registry D25).
- **Why:** plugins can't import `@quirky/protocol` from `<QUIRKY_HOME>/plugins`, so the codes come through the context. The plugin-ID prefix on unexpected errors answers "which plugin broke" (research: users couldn't tell which extension crashed VS Code's host).
- **Evidence:** packages/daemon/src/errors.ts; packages/daemon/src/server.ts handleMessage; m0-registry D25
- **Reversibility:** medium
- **Confidence:** high
- **Source:** assumed — autonomous

## D9: Each plugin gets one SQLite file and a data directory of its own
- **Question:** where a plugin's store lives (versioning, storage)
- **Options:** tables in `quirky.db` with an enforced prefix; one SQLite file per plugin; a JSON key-value file per plugin, as Orca does
- **Chose:** `<QUIRKY_HOME>/plugin-data/<pluginId>/store.db`, opened only when the plugin calls `openStore`, plus `context.dataDir` pointing at that directory for other files. The store is not a contribution: it can't be overridden, and an overriding plugin doesn't get the overridden plugin's store. Data is kept when a plugin is disabled or deactivated.
- **Why:** the roadmap asks for migrations, which a key-value file doesn't need and can't express. A prefix in a shared database can't be enforced against raw SQL, and a failed plugin migration could lock the daemon's own database. A separate file is opened lazily, so an unused plugin costs nothing, and uninstall can delete one directory.
- **Evidence:** docs/roadmap.md M0 "per-plugin store namespaces with migrations"; Orca src/main/plugins/plugin-storage-store.ts (per-plugin files, "never a shared namespaced blob"); research: https://backstage.io/docs/backend-system/core-services/database/
- **Reversibility:** hard
- **Confidence:** medium
- **Revisit if:** a feature needs queries joining several plugins' data, or many open stores cost noticeable memory
- **Source:** assumed — autonomous

## D10: Stores migrate forward only, by an ordered list, and refuse a downgrade
- **Question:** how store migrations are declared and versioned (versioning)
- **Options:** a migrations directory in the plugin, named by number; an ordered list passed to `openStore` in code; versions in a table vs `PRAGMA user_version`; down migrations or not
- **Chose:** `openStore(migrations)` takes an ordered list whose entries are SQL strings or functions of the store. The version is the number of migrations run, kept in `PRAGMA user_version`. Each pending step and its version bump run in one transaction, so a failure leaves the store at the last good step and `openStore` throws "<id> store migration <n> failed: <message>". A store whose version is higher than the list's length is refused ("<id> store is at version <v>, but the plugin knows <n> migrations") and left untouched. There are no down migrations.
- **Why:** research shows the version bump must share the step's transaction (Astryx #301 bricked on a crash between them), and that silently opening or recreating a newer database loses data (Firefox bug 1074817). Code-declared lists keep migrations next to the code that depends on them and allow data migrations.
- **Evidence:** https://github.com/sparsileg/astryx/issues/301 ; https://bugzilla.mozilla.org/show_bug.cgi?id=1074817 ; https://www.sqlite.org/pragma.html ; https://docs.openclaw.ai/reference/database-schemas/versioning
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** plugin authors need to roll back a release without losing data
- **Source:** assumed — autonomous

## D11: Plugin listeners get every event, asynchronously, and are removed on deactivate
- **Question:** how daemon plugins receive kernel and plugin events (exception-handling)
- **Options:** synchronous delivery inside `broadcast`; asynchronous delivery after the emitter returns; per-type subscriptions
- **Chose:** `context.subscribe(listener)` returns an unsubscribe function. Each listener is called for every event on a later turn of the event loop (`setImmediate`, changed from a microtask after the tech-spec review, D29), in emit order. A throw or a rejected promise is logged with the plugin ID and affects nothing else. Every listener is removed when its plugin deactivates.
- **Why:** kernel code calls `broadcast` from inside its own operations (repo add, session status), so a listener must never run inside them or throw into them. Research found listeners outliving plugin unload and timers running after deactivate as common leaks, which the kernel prevents by owning removal.
- **Evidence:** packages/daemon/src/service.ts broadcast; https://github.com/NousResearch/hermes-agent/pull/112376 ; https://github.com/plures/pedantic/issues/194
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D12: Plugins call methods through `context.call`, except connection-bound ones
- **Question:** whether and how a plugin calls kernel methods and other plugins' methods (exception-handling)
- **Options:** no cross-plugin calls; direct imports between plugins; `context.call(method, params)` through the same dispatch as clients
- **Chose:** `context.call`, which resolves and activates the target like a client call, passes the caller as `{ role: 'plugin', pluginId }`, and rejects with the same errors a client would get. `client.hello`, `events.subscribe`, `terminal.attach` and `terminal.detach` need a client connection and fail with InvalidParams.
- **Why:** later built-ins (sessions, agent status) use each other's features, and going through the dispatcher keeps overrides and disables in force for plugin callers too. Direct imports would bypass the registry.
- **Evidence:** packages/daemon/src/methods.ts (the four handlers use `conn`); docs/roadmap.md "Features are plugins"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D13: Choose declared contributions with provided implementations
- **Question:** the overall approach (brainstorming "Propose 2-3 approaches")
- **Options:** declared in the manifest with implementations provided at activation; imperative registration after activation; Backstage-style typed service references
- **Chose:** declared in the manifest. Methods, events, jobs and launch hooks are contribution kinds; `provide` supplies the functions; stores and listeners are context capabilities.
- **Why:** it is the model m0-registry D23 already chose, so listing, overriding and disabling stay code-free and lazy plugins stay unloaded. Imperative registration would hide a job or method until its plugin loads. Typed services add an injection layer that one in-process daemon doesn't need.
- **Evidence:** m0-registry D12 and D23; https://backstage.io/docs/backend-system/core-services/scheduler/
- **Reversibility:** hard
- **Confidence:** high
- **Source:** supersedes nothing; extends m0-registry D23

## D14: The four kinds' manifest fields are validated, and unknown fields rejected
- **Question:** how strictly the manifest checks `method`, `event`, `job` and `launch-hook` entries (exception-handling)
- **Options:** accept any fields, as m0-registry does for every kind; validate known fields and allow extras; validate and reject unknown fields
- **Chose:** validate and reject unknown fields, for both `contributes` entries and `overrides` of these kinds. `method` and `event` take `description`; `job` takes `description`, `interval` (required), `initialDelay` and `timeout`; `launch-hook` takes `description` and `agents` (a list of agent names). Other kinds stay unchecked until their own item. `provide` for a method, job or launch hook must be given a function, or activation fails.
- **Why:** m0-registry D14 rejects unknown top-level fields to catch typos, and its logic spec hands kind schemas to this item. m0-scripting will add the `params` and `result` fields when it adds schemas. Agent names aren't checked against v1's five, because M1 adds 45 agents as data.
- **Evidence:** docs/quirk/specs/2026-10-26-m0-registry/logic.md "Out of scope"; m0-registry D14
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D15: Jobs run on a fixed delay, at least one second apart, never overlapping
- **Question:** job timing semantics (rate-limiting)
- **Options:** fixed rate (setInterval); fixed delay (next run one interval after the last finished); cron expressions
- **Chose:** fixed delay. `interval` is a duration (`<n>ms|s|m|h`) between 1 second and 24 hours. The first run of a job that has never run comes after `initialDelay`, which defaults to the interval, so a lazy plugin isn't loaded at startup by its job. Due times are wall-clock times, and the scheduler re-checks at least once a minute, so a job that fell due while the machine slept runs within a minute of waking, once. No jitter.
- **Why:** fixed delay can't overlap and coalesces missed runs (research: node-cron double runs and skipped slots after suspend). Timers pause during macOS sleep, so wall-clock due times with a periodic re-check are needed (nodejs/node #20661; Orca #28291). The 24-hour cap keeps every delay under setTimeout's 2^31 ms limit. One local daemon has no thundering herd for jitter to fix. Cron and runtime-created jobs belong to M5 automations.
- **Evidence:** https://github.com/nodejs/node/issues/20661 ; https://github.com/stablyai/orca/issues/28291 ; https://nodejs.org/api/timers.html ; https://github.com/phillt/bernard/issues/400
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** a feature needs runs aligned to clock times, or intervals over a day
- **Source:** assumed — autonomous

## D16: The kernel records each job's last run, and an overdue job runs once after a restart
- **Question:** whether job timing survives a daemon restart (rate-limiting, storage)
- **Options:** in-memory only; persist last start, finish and outcome in the kernel store
- **Chose:** persist in a kernel table keyed by job ID. After a restart a job that has run before is due one interval after its last finish, or immediately when that has passed or when its last run never finished. History follows the ID, so an override inherits it.
- **Why:** without it, a 24-hour job never runs when the daemon restarts daily. systemd's `Persistent=` and anacron solve the same problem the same way: one catch-up run, not one per missed slot.
- **Evidence:** https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html ; https://man7.org/linux/man-pages/man8/anacron.8.html
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D17: A job run gets a stop signal and a timeout, and failures are recorded, not retried early
- **Question:** what happens when a run fails, hangs or its plugin goes away (exception-handling)
- **Options:** no timeout; a timeout that only marks the run; a timeout that aborts a signal the job receives. On failure: retry with backoff; wait for the next interval
- **Chose:** each run receives an `AbortSignal` that aborts at the job's `timeout` (default 5 minutes, at most 24 hours), when its plugin deactivates, or when the daemon stops. A timed-out run is recorded `timed-out` at once, but the job stays `running` until the run's code returns, and the next run is armed one interval after that, so a run that ignores its signal holds its job rather than overlapping (tightened after the logic-spec review, D28). A throw is recorded `failed` with the message and logged with the plugin ID. The schedule continues either way, and a plugin that fails to activate fails that run the same way.
- **Why:** research's Backstage stuck-lock bug was fixed by passing the scheduler's AbortSignal into the job; an in-process run can't be killed, so the signal is the only stop. Backoff would hide a broken job's cadence for no benefit on one machine.
- **Evidence:** https://github.com/backstage/backstage/issues/32641 ; https://backstage.io/docs/backend-system/core-services/scheduler/
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a job that ignores its signal blocks an important job for long periods
- **Source:** assumed — autonomous

## D18: Jobs are inspected and run through `job.list` and `job.run`, with a `quirky job` CLI group
- **Question:** how a person or agent sees and triggers jobs (response-format)
- **Options:** no API; `job.*` kernel methods; fold into `plugin.*`
- **Chose:** `job.list` returns each job in effect with its owner, interval, state (`idle` or `running`), next run time and last run (start, finish, outcome `ok`, `failed` or `timed-out`, error). `job.run { id }` runs the job now, waits for it, and returns that run; Conflict when it is already running, NotFound when it isn't in effect. After a manual run the next scheduled run is one interval after it. `quirky job list` and `quirky job run <id>` print them.
- **Why:** the roadmap requires everything to be scriptable, and the jobs' scenarios need to be driven and checked through the API or CLI
- **Evidence:** docs/roadmap.md "Everything is scriptable"; docs/loop/LOOP.md step 6
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D19: Launch hooks are a sequential pipeline in contribution-ID order
- **Question:** how several plugins' launch hooks combine (exception-handling, conflict handling)
- **Options:** declarative env operations merged by the kernel (VS Code EnvironmentVariableCollection); a pipeline where each hook sees the result so far and returns changes
- **Chose:** a pipeline. Hooks in effect whose `agents` list includes the session's agent (or that have no list) run one at a time in contribution-ID order. Each receives the session (ID, worktree, cwd, agent, prompt) and the current environment additions and extra arguments, and returns `{ env?: { NAME: value | null }, args?: string[] }`. Later hooks see earlier changes. Resolving a hook activates its plugin, so a lazy plugin loads only for sessions its hooks match.
- **Why:** research found VS Code's shared collection lets one extension silently overwrite another's variable (#138109, #255676); a pipeline in a fixed order makes the result deterministic and lets a hook build on a previous value
- **Evidence:** https://github.com/microsoft/vscode/issues/138109 ; https://jupyterhub.readthedocs.io/en/stable/reference/api/spawner.html
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** two built-ins need a different order than their IDs give
- **Source:** assumed — autonomous

## D20: Launch hooks change only environment variables and agent arguments
- **Question:** what a launch hook may change (scope)
- **Options:** env only; env and extra arguments; the whole command, cwd or prompt; veto the launch
- **Chose:** env (set or remove, names matching `[A-Za-z_][A-Za-z0-9_]*`) and extra arguments appended after the kernel's own agent arguments and before the prompt. Arguments are ignored, with a warning, for shell sessions. Hooks can't veto, replace the command, or change cwd or prompt.
- **Why:** the later features that need launch hooks set per-launch settings (session info's `--settings`, agent status installers) and account environments (M3 accounts). Replacing the command is agent definitions' job in M1.
- **Evidence:** docs/roadmap.md M1 "Agent status", M3 "Session info" and "Accounts"; packages/daemon/src/launch.ts buildArgv
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** M1 or M3 needs a hook to change the command or cwd
- **Source:** assumed — autonomous

## D21: `PATH`, `ZDOTDIR` and `QUIRKY_*` are reserved from launch hooks
- **Question:** which variables a hook may not touch (exception-handling)
- **Options:** none; `QUIRKY_*` only; `QUIRKY_*` and `PATH`; those plus `ZDOTDIR`
- **Chose:** `QUIRKY_*`, `PATH` and `ZDOTDIR`. A hook's change to a reserved variable is dropped, the rest of its changes apply, and its plugin gets a warning naming the variable.
- **Why:** `QUIRKY_SESSION_ID`, `QUIRKY_HOOK_TOKEN` and the rest tie a session to the daemon. `PATH` is rewritten inside the login-shell command because login zsh resets it (research: VS Code #188235), so a hook's `PATH` in the process environment would be lost anyway, and the bin dir must stay first. `ZDOTDIR` points zsh shell sessions at Quirky's startup wrapper, which the kernel sets after hooks run.
- **Evidence:** packages/daemon/src/launch.ts buildSessionEnv and buildArgv; https://github.com/microsoft/vscode/issues/188235
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** M1's providers need a hook to add a directory to `PATH`
- **Source:** assumed — autonomous

## D22: A launch hook that fails or times out is skipped
- **Question:** what a broken hook does to a launch (exception-handling)
- **Options:** fail the launch; skip the hook and start the session
- **Chose:** skip it. A throw, a rejection, an activation failure or no answer within 5 seconds drops that hook's changes, logs it with the plugin ID, and adds a warning to the plugin ("launch hook <id> failed: …" or "… timed out after 5000 ms"). The session starts.
- **Why:** a third-party hook must never stop the user from starting an agent, and research shows slow extension startup delaying terminals (VS Code #144939). The warning keeps the failure visible in `quirky plugin list`.
- **Evidence:** https://github.com/microsoft/vscode/issues/144939 ; m0-registry D13
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** a hook that must apply (such as an account switch) silently not applying causes real harm
- **Source:** assumed — autonomous

## D23: Launch hooks apply to terminal sessions only
- **Question:** whether hooks apply to structured sessions too (scope)
- **Options:** both now; terminal only, with structured sessions in M5
- **Chose:** terminal sessions only
- **Why:** structured sessions run through the Claude SDK, whose options take flags as a map rather than argv, and M5 rebuilds the structured runners (Codex app-server, resume, model options). Designing the structured shape now would be redone there.
- **Evidence:** packages/daemon/src/structured/claude-runner.ts query options; docs/roadmap.md M5 "Shared seams first"
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** M3 accounts needs background Claude sessions to switch accounts before M5
- **Source:** assumed — autonomous

## D24: Plugin methods use the daemon's token, and any client may call any method
- **Question:** who may call a plugin method (authentication)
- **Options:** per-plugin permissions; the same token and access as every method
- **Chose:** the same token and access
- **Why:** the roadmap gives an agent in a session everything the user can do with the same token, and plugins run with full trust
- **Evidence:** docs/roadmap.md "Agent access" and "Trust"
- **Reversibility:** medium
- **Confidence:** high
- **Source:** locked by docs/roadmap.md

## D25: No rate limits on plugin events or method calls, and no event filters yet
- **Question:** whether plugin events or calls are limited (rate-limiting)
- **Options:** per-plugin event rate limits; subscription filters by type; neither
- **Chose:** neither. Plugin method calls have no timeout, because long-polls such as `ask.wait` are legitimate.
- **Why:** research found no reports of event storms in comparable systems, and every plugin is trusted and in process. Filters are a cheap addition to `events.subscribe` once a client needs them.
- **Evidence:** Phase A pitfalls research (no event-storm reports found)
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** a plugin's events flood the UI or a CLI watcher
- **Source:** assumed — autonomous

## D26: This item has no Orca defects to test
- **Question:** which Orca defects the logic spec must test against (LOOP.md step 4)
- **Options:** none, because the item lists no feature docs; borrow defects from Orca's plugin system
- **Chose:** none
- **Why:** the item's `docs` field is empty, and the defects LOOP.md means are those the feature docs record
- **Evidence:** docs/loop/queue.json m0-daemon-api `docs: []`
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/queue.json

## D27: Fast-track the remaining defaults
- **Question:** brainstorming's essential-coverage gate and the fast-track
- **Options:** keep asking; accept recommended defaults once the six essentials are covered
- **Chose:** accept defaults. Purpose, consumers, success criteria, hard constraints, scope and primary behavior are all established by the roadmap, the m0-registry specs and the code; everything after that takes its recommended default and is tagged `assumed — fast-tracked` in the logic spec.
- **Why:** LOOP.md treats the user as having elected the fast-track
- **Evidence:** docs/loop/LOOP.md "Answering a skill's questions"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D28: Logic-spec review: fix the three model findings, reject the pre-pass findings
- **Question:** how to adjudicate the Codex adversarial review of logic.md (LOOP.md step 4)
- **Options:** fix each confirmed finding; record a reason for each one not fixed
- **Chose:** fixed F1 (no way to emit an overridden event: `emit` now takes the full ID for overrides), F2 (timeout rescheduling contradicted no-overlap: a timed-out run now holds its job until its code returns) and F3 (no store interface: the logic spec now lists `run`, `get`, `all`, `exec`, `transaction` and `version`). Added a test-isolation sentence for F4 though the refute stage killed it. Rejected 33 pre-pass `unresolvable-reference` findings and the `failing-check` heading finding. Verdict NEEDS_FIXES; reviewer gpt-6.1-sol (openai), independence full, depth standard, profile spec-design.
- **Why:** the references are example contribution IDs, fixture names and symbols this item creates. The heading check wants "Purpose" or "Overview", which the repo's writing rules forbid as headings, as m0-registry D29 also found.
- **Evidence:** scratchpad ar-logic/gate.json; m0-registry D29; CLAUDE.md "never Overview or Details"
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the build's final review finds a gap these fixes missed
- **Source:** assumed — autonomous

## D29: Tech-spec review: fix all four model findings, reject the pre-pass findings
- **Question:** how to adjudicate the Codex adversarial review of tech.md (LOOP.md step 4)
- **Options:** fix each confirmed finding; record a reason for each one not fixed
- **Chose:** fixed F1 (microtask delivery would run listeners before the RPC reply, against SC-10: delivery now uses `setImmediate`), F2 (the duration regex rejected `2d`, so SC-28's range message was unreachable: the regex now accepts `d` and the range check rejects it), F3 (a timed-out run that settles later had no defined finish time: `finished_at` moves to the settle time through `recordJobSettled`, status stays `timed-out`) and F4 (full-ID emit excluded the plugin's own events and didn't check the kind: both fixed). Rejected the pre-pass `unresolvable-reference` findings (files and symbols this item creates) and the heading check, as in D28. Verdict NEEDS_FIXES; reviewer gpt-6.1-sol (openai), independence full, depth standard.
- **Why:** each finding named a concrete divergence between the two specs or within the tech spec
- **Evidence:** scratchpad ar-tech/gate.json
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D30: No closure review round on the specs
- **Question:** whether to re-review the specs after the fixes (adversarial-review "Running rounds")
- **Options:** a closure round per spec; go straight to the build
- **Chose:** go to the build
- **Why:** every fix was a local wording change, and the build's final review loop reviews the code against both specs anyway, as m0-registry D30 also decided
- **Evidence:** m0-registry D30
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** the final review finds a spec contradiction the fixes introduced
- **Source:** assumed — autonomous

## D31: The `bun test scripts` failure "starts at the plugin kernel" is loop state, not a defect of this item
- **Question:** LOOP.md step 6 requires `bun test scripts` to pass, and on the clean `build/roadmap` base it fails one test
- **Options:** edit the test (forbidden: `scripts/build-loop/` is protected); block the item; record it and require every other scripts test to pass
- **Chose:** record it. The test asserts that the live `docs/loop/queue.json`'s next item is `m0-registry`, which stopped being true when m0-registry was marked done. Every other scripts test must still pass, and this item changes nothing under `scripts/`.
- **Why:** the failure comes from queue progress in a file this item must not touch, and it fails identically on the base commit (535 package tests, 13 of 14 scripts tests, typecheck clean)
- **Evidence:** scripts/build-loop/queue.test.ts:72-75; baseline run on build/m0-daemon-api before any change
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a person fixes the test; then all 14 must pass
- **Source:** assumed — autonomous

## D32: Build with Claude subagents implementing and Codex reviewing
- **Question:** subagent-driven-development preflight `backend_pairing`
- **Options:** claude-task + codex (recommended); claude-task + gemini; same-family pairs
- **Chose:** claude-task + codex. `pi-watch --check codex` and `--check gemini` both passed in a scratch directory. AUTHOR_FAMILY is anthropic.
- **Why:** LOOP.md step 5 names this pairing, and Codex was reachable
- **Evidence:** docs/loop/LOOP.md step 5
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D33: The build starts on a clean `build/m0-daemon-api` with the specs committed
- **Question:** preflight `dirty_tree_action`, the start-on-main check and `FULL_SUITE_CMD`
- **Options:** stash; commit; abort. Test command: the three LOOP.md commands
- **Chose:** no action needed: the tree was clean after the spec commit (3ce0c32), not on main. FULL_SUITE_CMD is `bun run test && bun run typecheck && bun test scripts`, with the one known scripts failure from D31.
- **Why:** git status was empty; LOOP.md step 6 names the three commands
- **Evidence:** `git status --porcelain` empty; baseline 535 pass, typecheck clean
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D34: Build in four waves, modules before wiring before API scenarios
- **Question:** the inline decomposition (subagent-driven-development Step 3)
- **Options:** vertical slices each owning module, wiring and tests (they would all share the wiring files `daemon.ts`, `server.ts`, `service.ts` and serialize into one chain); layered waves
- **Chose:** wave 1: protocol types (T1), launch patching and the job-run table (T2). Wave 2: host extension (T3), kind validation and the `quirky job` CLI (T4), events and the dispatcher (T5), stores (T6), scheduler (T7), launch hooks (T8), each with unit tests. Wave 3: the wiring (T9). Wave 4: the API scenario tests SC-1 to SC-28, four tasks that each own one area's module and test files so they can fix what the scenarios expose.
- **Why:** every slice touches the same wiring files, so true vertical slices would serialize; layering keeps wave 2 six-wide with disjoint files
- **Evidence:** docs/quirk/specs/2026-10-26-m0-daemon-api/tech.md "Architecture"
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** wave 4 finds wiring defects that need a re-plan
- **Source:** assumed — autonomous

## D35: Resume wave 2 by finishing the interrupted drafts rather than discarding them
- **Question:** iteration 2 stopped with wave 2 dispatched; T3, T4, T6 and T8 left uncommitted drafts in their worktrees and T5, T7 left nothing (subagent-driven-development Step 5, resume)
- **Options:** reset the worktrees and redispatch from scratch; keep the drafts and redispatch each task with the draft as its starting point; accept the drafts that pass acceptance as is
- **Chose:** keep the drafts and redispatch every wave 2 task, telling the implementer the draft is unverified and must be checked against each numbered item. Each component is a single task, so the wave-end audit against WAVE_BASE covers the draft and the new work together.
- **Why:** all drafts sit inside their task's scope and T3, T4, T6 already pass acceptance, so a reset throws away work; accepting them untouched would skip checking items the killed worker may not have reached
- **Evidence:** audit of each worktree against its scope file; acceptance runs on T3 (166 pass), T4 (129 pass), T6 (29 pass)
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D36: A flaky scheduler test was a test race, fixed in the test
- **Question:** T7's acceptance run failed 2 of 5 times on "sync > does not record the outcome of a run whose job was disarmed" (subagent-driven-development Step 6, task acceptance failure)
- **Options:** accept as a flake; retry with a fresh worker told to find the root cause; change the scheduler
- **Chose:** retried once with a fresh worker. It found the scheduler correct: after re-enabling, the job is due at once, so a second legitimate run sometimes overwrote the row before the test read it. The test now asserts the sequence of store writes and marker order instead of reading the row, and failed 3 of 3 with the guard it checks removed.
- **Why:** the skill routes a failed acceptance to one retry; a timing-dependent assertion would keep failing the gate
- **Evidence:** packages/daemon/test/plugins/scheduler-unit.test.ts; 8 of 8 orchestrator reruns passed after the fix
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D37: Wave 2's own fixtures broke under its kind validation, and a scoped fixer made them valid
- **Question:** after merging wave 2, 10 tests in host-extension.test.ts and scheduler-unit.test.ts failed because T4's new kind validation rejected their fixture manifests (a job with no interval, timeouts under 1s, an unparseable interval) (Step 7, red gate)
- **Options:** loosen validation for tests; let the scheduler accept sub-second timeouts; fix the fixtures
- **Chose:** a wave-gate fixer owning only the two test files made every fixture manifest valid, used `1s` timeouts, and moved the "interval does not parse" test onto a stub host, since a manifest can no longer carry such a job
- **Why:** the validation is the contract (logic SC-28), and the defensive check in the scheduler still needs coverage
- **Evidence:** commit bdc67a9; `bun run test` 716 pass after it
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D38: Wave 2 checkpoint review: fix three defects, reject calling deactivate after a failed activate
- **Question:** adjudicating the wave 2 checkpoint review (three Codex lenses, depth standard, 10 findings that collapse to four defects) (Step 9)
- **Options:** for each defect, accept and fix or reject
- **Chose:** accepted, effective MEDIUM each: a throwing `extension.create` never got its `revoke` (C3, S2, X3); a custom kind named after an Object.prototype member such as `constructor` crashed manifest parsing and so discovery (C2, S3, X1); `job.list` reported a re-enabled job idle while its earlier run was still unsettled (S4). Rejected C1, S1, X2 (call the module's `deactivate` before `revoke` when `activate` fails).
- **Why:** the rejected change would alter when the host calls `deactivate`, which m0-registry's activation rules own (fence in the tech spec); the registry never calls `deactivate` for a failed `activate`. `revoke` already closes everything the context handed out (store, listeners, job signals), so nothing the plugin got from Quirky leaks. The tech spec's "after the module's deactivate settles" applies when a deactivate runs.
- **Evidence:** scratchpad cp-w2/{C,S,X}/gate.json; docs/quirk/specs/2026-10-26-m0-daemon-api/tech.md "Host changes" and "DO-NOT-CHANGE fences"; docs/loop/decisions/m0-registry.md D34
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** a plugin needs cleanup for resources it allocated itself before a failed activate; that is a registry change
- **Source:** assumed — autonomous

## D39: Wave 3 checkpoint review: fix the launch and close race
- **Question:** adjudicating the wave 3 (wiring) checkpoint review (three Codex lenses, depth standard) (subagent-driven-development Step 9)
- **Options:** accept and fix X1; reject it
- **Chose:** accepted X1 (MEDIUM): a session closed while its launch hooks were still running could still get a terminal after its row was deleted. `createSession` now fails with Conflict if the row is gone after the hooks or after the PTY create, and forgets the terminal in the second case. The correctness and spec lenses passed with no findings.
- **Why:** awaiting plugin hooks opened a window that v1's synchronous path didn't have, and a terminal with no session row is an orphan nobody can close
- **Evidence:** scratchpad cp-w3/X/gate.json; packages/daemon/src/service.ts `createSession`; test in packages/daemon/test/sessions.test.ts
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D40: The scenario tests are split by area, and each task may fix only its area's modules
- **Question:** wave 4's decomposition: who owns which files when a scenario exposes a defect (Step 3)
- **Options:** one task for all 28 scenarios; four area tasks with disjoint module scopes
- **Chose:** four tasks: T10 methods and events (SC-1 to SC-10; may fix dispatch.ts, events.ts), T11 stores and lifecycle (SC-11 to SC-15, SC-27; stores.ts, runtime.ts, host.ts), T12 jobs (SC-16 to SC-21; scheduler.ts, methods.ts, the job CLI), T13 launch hooks and manifests (SC-22 to SC-26, SC-28; launch-hooks.ts, kinds.ts, manifest.ts, service.ts, launch.ts). Scenario tests drive the daemon API with a real client; where a scenario names `quirky job list` or `quirky job run`, the test calls `job.list` or `job.run`, which is all those commands do, and packages/cli/test/job.test.ts covers the CLI's own output and exit codes. The unit test file T6 wrote took the name `stores.test.ts`, so the store scenarios live in `stores-api.test.ts`.
- **Why:** disjoint scopes let the four run in parallel; LOOP.md step 6 accepts a flow test that drives the daemon API
- **Evidence:** docs/loop/LOOP.md step 6; docs/quirk/specs/2026-10-26-m0-daemon-api/tech.md "Testing strategy"
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** the user wants the job scenarios driven through the `quirky` binary against a live daemon
- **Source:** assumed — autonomous

## D41: The daemon plugin API is kernel, not a built-in plugin
- **Question:** LOOP.md step 6 requires the feature to ship as a built-in plugin that uses only the public plugin API; how that applies to the API plugins are built on
- **Options:** wrap the job methods and CLI group in a built-in plugin; treat the plugin API, including `job.list`, `job.run` and `quirky job`, as kernel
- **Chose:** kernel, as m0-registry D18 decided for the plugin host. The `job.*` methods inspect the kernel's own scheduler, so a plugin couldn't implement them through the public API.
- **Why:** docs/roadmap.md lists the plugin host as part of the core; a plugin can't host the system that loads it
- **Evidence:** docs/loop/decisions/m0-registry.md D18; docs/roadmap.md "What the order rests on"
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the user wants job inspection to be replaceable by a distro
- **Source:** locked by docs/roadmap.md

## Progress
All four waves merged (6aa2257): `bun run test` 763 pass, typecheck clean, `bun test scripts` only the D31 failure. Next: the final review loop (round 1 over 3ce0c32..HEAD, three Codex lenses, depth deep), fixes, closure rounds, then LOOP.md step 7 (merge). Review driver: iteration-3 scratchpad `/private/tmp/claude-502/-Users-zpyoung-orca-workspaces-quirky-build-roadmap/20ad4b75-27c9-48ea-8053-2da47b7b6d4e/scratchpad/round.py`.
