# m0-core decisions

## D1: Classify the item as an API, CLI, Organization and Visual design, and run every research phase
- **Question:** which domains the gray-area catalog draws from, and whether the research swarms run (quirk:brainstorming, checklist steps 2 and 7)
- **Options:** one domain; several; skip research as covered by earlier items
- **Chose:** API (plugin API growth, confirmations, request IDs), CLI (socket transport, selectors, `--version`, plugin command groups), Organization (which v1 feature goes in which built-in plugin, naming) and Visual (the window's layout moving into the daemon). Phase A ran two web-research agents (kernel-port and distro patterns; pitfalls). Phase B ran one per approach.
- **Why:** the item is four earlier items merged into one. Its consumers are agents at a shell, plugin and distro authors, and the person at the window. Earlier items researched registries, daemon APIs, UI slots and CLI generation, not distros, safe mode, socket transports or moving features into plugins.
- **Evidence:** docs/loop/queue.json m0-core; docs/roadmap.md M0
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

## D3: Keep m0-core as one item with one pair of specs, built in waves
- **Question:** brainstorming's scope check says to decompose a request that spans independent subsystems
- **Options:** split into four specs and build them across iterations; one logic spec and one tech spec covering all four parts, built in dependency-ordered waves
- **Chose:** one pair of specs with four parts (CLI core, UI bridge, v1 as built-ins, distros and safety), built in waves. If an iteration runs out of room, the Progress section names the next wave.
- **Why:** the user merged the four queue items into one on purpose (commit 9a0ae1e), and the parts share one exit test. The loop cannot split a queue item (LOOP.md: change queue.json only through `queue.ts set`).
- **Evidence:** git show 9a0ae1e; docs/loop/LOOP.md "Hard rules"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/queue.json

## D4: Select every gray area that matters for m0-core
- **Question:** which gray areas to drill into (brainstorming Gray Areas Step 1)
- **Options:** CLI: output-format, flag-design, progress-reporting, error-recovery, exit-codes; API: response-format, error-responses, authentication, versioning, rate-limiting, pagination; Organization: grouping-criteria, naming-convention, duplicate-handling, exception-handling; Visual: layout-style, empty-state, error-state, interaction-style; Data: idempotency
- **Chose:** grouping-criteria (which feature goes in which plugin), naming-convention (plugin IDs, method and event names, CLI groups), duplicate-handling (CLI alias collisions), exception-handling (a disabled built-in and its dependents), flag-design (selectors, `--yes`, `--version`, `--retry-request`), output-format (ported commands' text), error-recovery and error-responses (selector, confirmation and request-ID errors), exit-codes, authentication (the unix socket), versioning (renamed methods), response-format (`quirky ui state`), idempotency (request IDs), layout-style (what the shell keeps and what moves into plugins), empty-state (a feature switched off)
- **Why:** LOOP.md asks for every area that matters. Progress reporting matters only for confirmations, which error-recovery covers. Pagination and rate limiting have no new consumer here. Interaction style stays v1's.
- **Evidence:** docs/loop/LOOP.md "Gray areas"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D5: v1 moves into eight built-in plugins, one per roadmap feature
- **Question:** grouping-criteria: which v1 feature goes in which built-in plugin
- **Options:** one plugin for all of v1; one per roadmap feature; finer splits (separate launch, hook and notification plugins)
- **Chose:** eight plugins, one per feature the roadmap names: `quirky.repo` (repos), `quirky.worktree` (worktrees and the sidebar), `quirky.session` (session records, agent launch, the session view), `quirky.terminal` (terminal input and output), `quirky.agent-status` (hooks, status changes, finish notifications), `quirky.git` (source control and its panel), `quirky.ask` (asks and the Questions panel) and `quirky.structured` (structured background sessions). Dependencies: worktree on repo; session on worktree; terminal, agent-status and structured on session; git on worktree; structured also on ask.
- **Why:** the roadmap lists exactly these eight, and a distro can then switch off or replace each one by ID, which is the point of the move. Finer splits would add plugins no distro asked to replace.
- **Evidence:** docs/roadmap.md M0 "v1 as built-ins"; docs/v1.md "Daemon behaviour"
- **Reversibility:** hard
- **Confidence:** medium
- **Revisit if:** a distro needs to replace agent launch without replacing session records
- **Source:** assumed — autonomous

## D6: v1's methods are renamed to their plugin's namespace, with no aliases, and the protocol version goes to 2
- **Question:** naming-convention and versioning: what v1's wire names become once their features are plugins
- **Options:** keep `repo.list` and the rest as kernel aliases; rename to `<pluginId>/<name>` and bump the protocol version; rename and keep both names for a release
- **Chose:** rename to `<pluginId>/<name>` (`repo.list` becomes `quirky.repo/list`, `session.createStructured` becomes `quirky.structured/create`, `git.status` becomes `quirky.git/status`), drop v1's `settings.get` and `settings.set` (their three settings become plugin settings), and set `PROTOCOL_VERSION` to 2. The UI, CLI and desktop shell move to the new names in the same change.
- **Why:** m0-daemon-api D4 fixes plugin wire names as `<pluginId>/<name>`, and every client is in this repo, so aliases would only keep two names alive. The version bump makes an old client fail at `client.hello` instead of calling missing methods.
- **Evidence:** docs/loop/decisions/m0-daemon-api.md D4, D5; packages/protocol/src/rpc.ts:20
- **Reversibility:** hard
- **Confidence:** high
- **Source:** supersedes m0-daemon-api D5

## D7: v1's events become the plugins' events
- **Question:** naming-convention: what v1's events become
- **Options:** keep them as kernel events that plugins emit through a privileged hook; rename them to plugin events
- **Chose:** plugin events, shaped `{ type: "<pluginId>/<name>", data }` as m0-daemon-api D6 fixed: `quirky.repo/changed`, `quirky.worktree/changed`, `quirky.session/changed`, `quirky.session/removed`, `quirky.git/changed`, `quirky.ask/created`, `quirky.ask/resolved` and `quirky.structured/message`. `notify` stays a kernel event, because notifications are a kernel service (D12).
- **Why:** a plugin can only emit events in its own namespace, and that is what makes a replacement plugin's events distinguishable
- **Evidence:** docs/loop/decisions/m0-daemon-api.md D6; packages/protocol/src/rpc.ts QuirkyEvent
- **Reversibility:** hard
- **Confidence:** high
- **Source:** assumed — autonomous

## D8: v1's CLI words stay, with `wt` and `term` as group aliases
- **Question:** naming-convention and duplicate-handling: the CLI groups of the new plugins, given m0-scripting D10 makes a group the plugin ID minus `quirky.`
- **Options:** plugin IDs `quirky.wt` and `quirky.term` so the groups match v1; IDs named for the feature, with a manifest field for extra group words; v1's words dropped
- **Chose:** IDs named for the feature, and a new manifest field `cliAliases` listing extra words for the plugin's group: `quirky.worktree` takes `wt`, `quirky.terminal` takes `term`. An alias that collides with another group or command loses by m0-scripting D11's precedence and is reported in `plugin.list` diagnostics.
- **Why:** "v1 behaves as it does today", and agent skills already call `quirky wt` and `quirky term`. Feature-named IDs read better in contribution IDs, which are hard to change later.
- **Evidence:** docs/v1.md "CLI"; docs/loop/decisions/m0-scripting.md D10, D11
- **Reversibility:** medium
- **Confidence:** high
- **Source:** assumed — autonomous

## D9: Plugins ship CLI commands as `cli-command` contributions, with an optional CLI module for custom run code
- **Question:** flag-design and output-format: how a plugin keeps v1's positionals, env defaults, the `ask` long-poll loop and v1's text output, since generated commands have only flags
- **Options:** keep v1's commands hand-written in the kernel CLI calling plugin methods; method-level CLI hints only; a `cli-command` kind declared in the manifest, run either generically against a method or by code from a manifest `cli` module the CLI imports
- **Chose:** the `cli-command` kind. Each declares its words under the plugin's group (an empty `words` is the bare group, as `quirky ask` needs), a summary, positionals, flags and the methods it may call. One with a `method` and no code maps positionals and flags to that method's params and prints the generic form. Run code comes from the plugin's `cli` ES module, which the CLI imports only when that command runs. A plugin's own `cli-command` beats its generated command for the same words.
- **Why:** kernel copies of v1's commands would shadow the plugins' groups, so the plugins wouldn't really own them. Hints can't express the `ask` loop. Declaring the commands keeps m0-registry D12 (every contribution is declared, code only provides it) and lets help, suggestions and `quirky api --json` list them without loading code.
- **Evidence:** packages/cli/src/commands/ask.ts; packages/cli/src/generated.ts; docs/loop/decisions/m0-registry.md D12
- **Reversibility:** hard
- **Confidence:** medium
- **Revisit if:** third-party plugins never use the CLI module and it costs more than it gives
- **Source:** assumed — autonomous

## D10: Repo and worktree selectors resolve in the daemon, with the caller's cwd and identity
- **Question:** flag-design and error-recovery: the selector grammar and where it resolves
- **Options:** resolve on the client as Orca does for `current`; resolve in the plugin, with the CLI sending its cwd and identity at `client.hello`
- **Chose:** methods take `repo` and `worktree` params as selector strings. Repo: `id:<id>`, `name:<name>`, `path:<path>`. Worktree: `id:<id>`, `name:<name>`, `branch:<branch>`, `path:<path>` (the worktree containing that path, innermost first), and `current` or `active` (the caller's `QUIRKY_WORKTREE_ID`, else the worktree containing the caller's cwd). A bare value is tried as an ID, then a name, then (worktrees) a branch. An omitted `worktree` means `current`. No match is NotFound naming the selector and the grammar; several matches is Conflict listing each match's `id:` selector. The CLI sends `cwd`, `sessionId` and `worktreeId` (from its env) in `client.hello`, and plugin methods see them on the caller. `quirky.repo/resolve` and `quirky.worktree/resolve` expose the matcher. Session IDs stay plain IDs, defaulting to the caller's `QUIRKY_SESSION_ID`.
- **Why:** generated commands and API callers then get selectors without client code, and the UI can pass plain IDs. There are no remote runtimes yet, so sending the cwd is safe. Orca's grammar is kept so agent habits carry over.
- **Evidence:** research/orca-features/cli.md "Selectors"; packages/cli/src/commands/support.ts:43
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** remote runtimes arrive and a remote cwd means nothing on the daemon's machine
- **Source:** assumed — autonomous

## D11: The plugin API grows by six members so the built-ins need nothing private
- **Question:** grouping-criteria: what the v1 features need that m0-daemon-api's context lacks
- **Options:** a privileged context for built-ins only; kernel RPC primitives (`pty.spawn` and the like) open to every client; new context members on the public plugin API
- **Chose:** new public context members: `pty` (spawn, write, resize, read, kill, list and forget PTY sessions, with data and exit listeners), `notify` (D12), `launchEnvironment` (the kernel-reserved env every session needs: `PATH` with Quirky's `bin`, `ZDOTDIR`, `QUIRKY_HOME`, the hook URL and token), `runLaunchHooks` (the launch-hook pipeline, so a session plugin can apply other plugins' hooks), `home` (the state directory, read-only) and connection streams for methods declared `connection: true` (the caller gets `openStream`, so `terminal.attach` can send binary frames). The hook endpoint stays in the kernel and delivers each authenticated POST to plugins as a kernel `hook.received` event.
- **Why:** the roadmap requires built-ins to use only the public API and lets the API grow in the same milestone. Public context members keep spawn access to plugins, which already run with full trust, rather than to every API client.
- **Evidence:** docs/roadmap.md "When a milestone is done"; packages/protocol/src/plugins.ts PluginContext; packages/daemon/src/service.ts
- **Reversibility:** hard
- **Confidence:** medium
- **Source:** assumed — autonomous

## D12: Notifications are a kernel service, and each plugin decides when to notify
- **Question:** grouping-criteria: where v1's notification logic lives
- **Options:** in agent-status; a kernel service that plugins call
- **Chose:** `context.notify({ title, body, sessionId?, worktreeId? })` broadcasts the `notify` event and, when no desktop client is connected, shows the notification with osascript, as v1 does. The `notifications` setting moves to `quirky.agent-status`, which skips the call when it is off. `quirky.ask` notifies when an ask is created.
- **Why:** architecture.md puts desktop surfaces and the no-window fallback in the daemon, and more than one plugin notifies
- **Evidence:** docs/architecture.md "Method groups" (last paragraph); docs/v1.md "Status transitions"
- **Reversibility:** medium
- **Confidence:** high
- **Source:** locked by docs/architecture.md

## D13: v1's settings become plugin settings
- **Question:** naming-convention: where `worktreesRoot`, `terminalScrollback` and `notifications` go
- **Options:** keep v1's kernel settings; move each to the plugin that reads it
- **Chose:** `setting:quirky.worktree/worktreesRoot`, `setting:quirky.terminal/scrollback` (500 to 10000, default 2000) and `setting:quirky.agent-status/notifications`, read with `context.getSetting` and set with `setting.set`
- **Why:** m0-ui-api D18 deferred this move to the port. Settings a plugin declares disappear with it, so a distro that turns a feature off takes its settings with it.
- **Evidence:** docs/loop/decisions/m0-ui-api.md D18; packages/protocol/src/model.ts Settings
- **Reversibility:** medium
- **Confidence:** high
- **Source:** supersedes m0-ui-api D18

## D14: v1 data carries over on upgrade
- **Question:** exception-handling: what happens to a v1 home's repos, sessions, asks and settings when the plugins take over
- **Options:** start empty; each plugin imports its v1 table once from `quirky.db`
- **Chose:** each plugin's first store migration copies its v1 rows from `<home>/quirky.db` when that file has them (repos; sessions; asks; structured messages; the three settings). The kernel leaves the v1 tables in place.
- **Why:** sessions in the PTY host outlive the daemon, and losing their records on upgrade would orphan running agents. A one-time copy costs little.
- **Evidence:** packages/daemon/src/store.ts; docs/v1.md "Files and environment"
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D15: A disabled built-in takes its dependents with it, and the window shows what is left
- **Question:** exception-handling and empty-state: what the window and CLI do when a distro or the user turns a built-in off
- **Options:** refuse to disable built-ins; disable with the m0-registry cascade and show empty states
- **Chose:** the m0-registry cascade applies (disabling `quirky.session` also disables terminal, agent-status and structured). Its slots, commands, CLI group and methods disappear live. A call to its methods is MethodNotFound, and its CLI words become unknown commands. The shell keeps working with whatever slots remain, and an empty main area says so.
- **Why:** the exit test turns source control off, and m0-registry D9 already defines the cascade
- **Evidence:** docs/loop/decisions/m0-registry.md D9; docs/roadmap.md M0 "Exit test"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/decisions/m0-registry.md

## D16: The CLI talks to the daemon over a unix socket, authenticated by the runtime token in `client.hello`
- **Question:** authentication: how the CLI reaches and authenticates to the daemon
- **Options:** keep the WebSocket; a unix socket with the token in each request line (Orca); a unix socket with the token once in `client.hello`
- **Chose:** the daemon also listens on a unix socket, mode 0600, at `<home>/quirkyd.sock`, or under a private short directory `/tmp/quirky-<uid>/` (mode 0700) named by a hash of the home when that path would pass 100 bytes. `runtime.json` gains its path. Messages are the same JSON-RPC 2.0 objects, one per line. The first must be `client.hello` carrying the runtime token, and a wrong or missing token closes the connection. Connections over the socket carry no binary frames, so `connection: true` methods that stream refuse them with InvalidParams naming the WebSocket. A stale socket file is removed at startup once no daemon answers on it. The CLI uses only the socket. The desktop shell and the window keep the WebSocket.
- **Why:** architecture.md fixes a unix socket and the same token file for the CLI. One hello carries the token, as the WebSocket's URL carries it once per connection. The short-directory rule is the fix the 104-byte `sun_path` limit needs on macOS.
- **Evidence:** docs/architecture.md "Transport and auth"; research/orca-features/cli.md "How the CLI finds and authenticates"; https://github.com/zsa/kontroll/issues/27 ; https://github.com/raine/workmux/issues/293
- **Reversibility:** medium
- **Confidence:** high
- **Source:** locked by docs/architecture.md

## D17: The PTY host's socket follows the same short-path rule
- **Question:** m0-registry D33 logged that a long `QUIRKY_HOME` breaks `pty.sock` and handed socket paths to the CLI-core item
- **Options:** leave it; apply the daemon socket's rule to `pty.sock`
- **Chose:** apply the same rule, so a home whose `pty.sock` path would pass 100 bytes puts it in the short private directory
- **Why:** one rule for both sockets, and D33 named this item as the owner. Default homes are short, so nothing moves for them.
- **Evidence:** docs/loop/decisions/m0-registry.md D33
- **Reversibility:** easy
- **Confidence:** high
- **Source:** supersedes m0-registry D33

## D18: `quirky --version` prints the CLI's version and works in a from-source build
- **Question:** flag-design: what `--version` prints, given Orca's fails in a from-source build
- **Options:** the daemon's version (needs the daemon); the CLI's version from its own `package.json`, offline
- **Chose:** `quirky --version` and `quirky -v`, as the only argument, print `quirky <version>` from `packages/cli/package.json` and exit 0 without contacting the daemon. `--json` prints `{"version":"..."}`. `quirky status` keeps reporting the daemon's version.
- **Why:** Orca's defect is reading a version the from-source build never stamped. The CLI's `package.json` always has one, so the from-source run is the test.
- **Evidence:** research/orca-features/cli.md "Version"; research/orca-features/README.md "Orca defects"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by research/orca-features/cli.md

## D19: Mutating calls carry a request ID, and the daemon returns the first outcome to a retry
- **Question:** idempotency: how a lost reply is retried without doing the work twice
- **Options:** per-method idempotency keys in params (Orca's ask); one request-envelope `requestId` handled by the kernel for every method
- **Chose:** a JSON-RPC request may carry a top-level `requestId` (1 to 128 characters). For a method not declared `readOnly`, the kernel records the outcome (result or error) with a digest of the method and params for 24 hours, in its own store. A repeat with the same ID and digest gets the recorded outcome without running again; one still running waits for it; one with a different digest is Conflict ("request ID reused with different params"). Kernel read methods and plugin methods declared `readOnly: true` are never recorded. The CLI sends a fresh UUID with every call, retries a call whose connection dropped before the reply up to twice with the same ID, and names the ID in the error so `--retry-request <id>` can reissue the command.
- **Why:** this is Stripe's model (store the first response, reject reuse with different params, prune after a day), and one envelope field covers plugin methods without touching their schemas
- **Evidence:** https://docs.stripe.com/api/idempotent_requests ; research/orca-features/cli.md "Lost reply on a mutating call"; research/orca-features/ask.md "Registration and the wait loop"
- **Reversibility:** medium
- **Confidence:** high
- **Source:** assumed — autonomous

## D20: Irreversible methods confirm through an ask unless the call passes `yes`
- **Question:** error-recovery, error-responses and exit-codes: how confirmations work for agents and people
- **Options:** the CLI prompts on a TTY; the daemon blocks the call until an ask is answered; the daemon refuses with a confirmation-required error naming a fresh ask, and the call is repeated with that ask's ID once it is answered
- **Chose:** the third. Methods declare `destructive: true` and a `confirm` text with `{param}` placeholders. A call without `yes: true` or a `confirmation` ask ID creates a confirm ask (through `quirky.ask/create`) and fails with ConfirmationRequired (code -32010) whose data names the ask and the action. A repeat with `confirmation: <askId>` runs only if that ask was answered Yes for the same method and params, once. Declined fails with Conflict "declined". With `quirky.ask` off, the error says to pass `--yes`. The CLI turns ConfirmationRequired into a wait: it prints the action and the ask ID to stderr, waits on the ask as `quirky ask wait` does, then repeats the call. `--yes` skips it. A declined confirmation exits 1. The window asks with its own dialog and then passes `yes`. Destructive: `quirky.worktree/remove`, `plugin.install`, `plugin.uninstall`, `distro.install` and `distro.remove`.
- **Why:** the roadmap's rule names exactly these actions, and agents in PTYs can answer TTY prompts themselves, so the gate has to be a person answering an ask. A blocking call would hide what it is waiting for. Failing closed with the flag's name in the message is what the research recommends.
- **Evidence:** docs/roadmap.md "Agent access"; https://github.com/Kleanthismits/git_flash/issues/42 ; https://github.com/codekiln/langstar/pull/739
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** agents find the two-step call awkward enough to pass `--yes` by habit
- **Source:** locked by docs/roadmap.md (ask unless `--yes`); assumed — autonomous (the protocol)

## D21: The daemon owns the window's layout, focus and visible view
- **Question:** layout-style and response-format: what "layout and focus live in the daemon" covers, and the shape of `quirky ui state`
- **Options:** the window reports its state and the daemon mirrors it; the daemon holds the layout and the window renders it; a generic tab model now
- **Chose:** the daemon holds the layout: the open view (contribution ID and input), the open panel (or none), whether the sidebar is shown, and which of sidebar, view or panel has focus. It is persisted, so a reopened window shows the same thing. `ui.state` returns that layout, the connected windows, and each slot shown with its plugin, title and the JSON its plugin last reported. Layout changes are daemon methods (`ui.view.open`, `ui.view.close`, `ui.panel.open`, `ui.panel.close`, `ui.sidebar.set`, `ui.focus`), broadcast as `ui.state.changed`, and the window applies them. The selected worktree and session are the session view's input, so selection lives in the daemon too. No tabs model beyond that: the session view's tabs are the worktree's sessions, with the active one in the input.
- **Why:** the roadmap requires layout, focus, open tabs and the visible view to live in the daemon. A daemon-held layout can't drift from what the window shows, which mirroring could. Tab groups and splits are M1's term-ui work.
- **Evidence:** docs/roadmap.md M0 "UI bridge"; docs/roadmap.md M1 "Terminal panes"; https://github.com/contour-terminal/contour/pull/2176
- **Reversibility:** hard
- **Confidence:** medium
- **Source:** locked by docs/roadmap.md (what lives in the daemon); assumed — autonomous (the shape)

## D22: Plugin slots report their own content as JSON
- **Question:** response-format: how an agent reads what a plugin's slot shows, since the daemon can't see inside a slot
- **Options:** nothing inside slots; each mounted slot may report a JSON summary that `ui.state` includes
- **Chose:** a mounted slot's context gets `report(state)`. The window sends it to the daemon (latest wins, 64 KiB cap, cleared on unmount), and `ui.state` includes it under the slot. The built-ins report what they show: the sidebar its repos and worktrees with status, the session view its tabs and active session, the source-control panel its worktree and file counts, the Questions panel its pending asks.
- **Why:** agents read what the window shows as JSON, never screenshots, and only the plugin knows its own content
- **Evidence:** docs/roadmap.md "Everything is scriptable"
- **Reversibility:** medium
- **Confidence:** medium
- **Source:** assumed — autonomous

## D23: Plugin UI commands run in the window when called through the API
- **Question:** error-recovery: how `ui.command.run` reaches the window, and what happens with no window or several
- **Options:** broadcast to every window; send to one window and wait for its reply
- **Chose:** `ui.command.run { id, args }` checks `args` against the command's declared schema, sends it to one window (the last one to report focus, else the last to connect) and waits up to 30 seconds for that window's result. No window connected is Conflict "no Quirky window is open". A command whose module fails reports the error. CLI: `quirky ui run <commandId> [--args <json>]`, and each layout method has a `quirky ui` command (`open-view`, `close-view`, `open-panel`, `close-panel`, `sidebar`, `focus`).
- **Why:** UI commands are API commands routed to the open window. One target window keeps a command from running twice. m0-scripting D8 left checking `args` to this item.
- **Evidence:** docs/roadmap.md M0 "UI bridge"; docs/loop/decisions/m0-scripting.md D8
- **Reversibility:** medium
- **Confidence:** high
- **Source:** locked by docs/roadmap.md

## D24: v1's window surfaces become the built-ins' UI contributions, and the shell keeps only the chrome
- **Question:** layout-style: what stays in the shell
- **Options:** keep v1's surfaces hard-wired and add plugin copies; move each into its plugin's UI module
- **Chose:** move them. `quirky.worktree` contributes the sidebar section with repos, worktrees, add-repo, new-worktree and remove-worktree; `quirky.session` the session view (tabs, new-session menu, terminal pane, structured transcript); `quirky.git` the source-control panel; `quirky.ask` the Questions panel. The shell keeps the header, panel toggles, command palette, settings dialog, toasts, the connection banner and the confirm dialog.
- **Why:** a distro can only replace or switch off what is a contribution, and the exit test replaces the sidebar and switches source control off. m0-ui-api D26 deferred this move to the port.
- **Evidence:** docs/loop/decisions/m0-ui-api.md D26; docs/roadmap.md M0 "Exit test"
- **Reversibility:** medium
- **Confidence:** high
- **Source:** supersedes m0-ui-api D26

## D25: Ask cards move into a Questions panel that opens itself
- **Question:** layout-style: where asks show once they are a plugin, since a plugin can't draw over the main area
- **Options:** a new overlay slot kind; a panel that opens when an ask is pending (Orca's right-sidebar Questions panel)
- **Chose:** the `quirky.ask` panel `questions`. When an ask is created and no panel is open, the plugin opens it through `ui.panel.open`. Each pending ask shows as a card in creation order, so a second ask is visible at once (the Orca defect test).
- **Why:** it is Orca's placement and needs no new slot kind. v1's cards over the main area move into the right column, which is the one visible change to v1.
- **Evidence:** research/orca-features/ask.md "Where to find it", "Queued asks"
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** opening the panel by itself steals the source-control panel at a bad moment often enough to matter
- **Source:** assumed — autonomous

## D26: A distro is applied as an overlay that removing it takes away
- **Question:** what a distro manifest holds and how install and revert work
- **Options:** copy the distro's values into the user's settings and record the old ones to restore; keep the distro as a separate layer under the user's own choices
- **Chose:** `quirky-distro.json` holds `id`, `name`, `version`, optional `description`, `plugins` (directories inside the distro), `disable` (plugin or contribution IDs), `settings` (setting ID to value), optional `theme` and optional `keybindings` (chord to command ID). Installing copies its plugins into `<home>/plugins/` and records the distro. Its settings, theme and disables are a layer: a setting reads the user's stored value, else the distro's, else the default; the theme is the user's choice, else the distro's; an ID is off if the user or the distro turned it off. Distro keybindings beat built-in and plugin keybindings on the same chord. Removing the distro deletes its plugins and its layer, so everything it changed reads as before, and anything the user set afterwards stays. One distro at a time: installing a second is Conflict until the first is removed. A plugin ID already installed outside the distro is Conflict. Methods `distro.inspect`, `distro.install`, `distro.list`, `distro.remove`; CLI group `quirky distro`.
- **Why:** the roadmap's distro is a manifest naming plugins, settings, keybindings, theme and which built-ins are off. Overrides that removal deletes are how VS Code profiles and LazyVim revert, with no restore bookkeeping that can drift.
- **Evidence:** docs/roadmap.md "Distros"; https://code.visualstudio.com/docs/configure/profiles ; https://www.lazyvim.org/configuration/plugins
- **Reversibility:** hard
- **Confidence:** medium
- **Revisit if:** users want two distros layered at once
- **Source:** locked by docs/roadmap.md (what the manifest names); assumed — autonomous (the overlay)

## D27: Plugin install lists what the plugin contributes and confirms through an ask
- **Question:** what the "install screen listing what a plugin contributes" is
- **Options:** a dedicated window view; the confirmation ask, whose question lists the contributions, plus `inspect` for the CLI
- **Chose:** `plugin.inspect { path }` and `distro.inspect { path }` read a manifest without running code and return the plugin, version and every contribution by kind and ID, with overrides and disables. `plugin.install { path }` and `distro.install { path }` are destructive (D20), so their confirm ask's question carries that listing, and the window shows it as an ask card. Reinstalling an installed plugin asks again and shows the old and new versions and any contribution added or removed. `plugin.uninstall { id }` removes an installed plugin's directory and data. CLI: `quirky plugin inspect|install|uninstall`, and `install` prints the listing before it waits.
- **Why:** consent has to show the contributions, and an update that adds capabilities should re-prompt, as Chrome does. Reusing the ask keeps one consent path for the CLI, the window and agents.
- **Evidence:** https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings ; https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security
- **Reversibility:** medium
- **Confidence:** medium
- **Source:** assumed — autonomous

## D28: Quirky never updates plugin code on its own
- **Question:** what "no silent auto-update" requires
- **Options:** an opt-in updater; no updater, only explicit installs
- **Chose:** no updater. The daemon runs installed plugins from the copy made at install and never re-reads a distro's or plugin's source directory. Changed plugin code takes an explicit reinstall, which confirms. The desktop shell has no updater either.
- **Why:** the 2026 Nx Console compromise reached users through automatic extension updates within minutes
- **Evidence:** https://www.stepsecurity.io/blog/nx-console-vs-code-extension-compromised ; https://www.cisa.gov/news-events/alerts/2026/05/28/supply-chain-compromises-impact-nx-console-and-github-repositories
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/roadmap.md

## D29: Safe mode runs stock Quirky for one daemon run and writes nothing
- **Question:** what `--disable-plugins` does and how it is reached
- **Options:** a persisted toggle; a launch flag for the daemon, reached through a restart command
- **Chose:** `quirkyd --disable-plugins` (or `QUIRKY_DISABLE_PLUGINS=1`) loads built-ins only, ignores the user's and the distro's disables, and skips the distro layer, for that run only. Installed plugins are listed as disabled with the reason "safe mode". `status.get` reports `safeMode`. `quirky daemon restart [--disable-plugins]` stops the daemon (new kernel method `daemon.stop`) and starts it again, and sessions survive because the PTY host does.
- **Why:** VS Code's `--disable-extensions` is launch-scoped and leaves installed extensions in place. Ignoring stored disables is what makes it stock Quirky.
- **Evidence:** https://code.visualstudio.com/docs/configure/command-line ; docs/architecture.md "Processes"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D30: The sample distro switches source control off and replaces the sidebar
- **Question:** what the exit test's sample distro contains
- **Options:** a test fixture; a distro shipped in the repo
- **Chose:** `distros/sample/` in the repo, with plugin `sample.sidebar` overriding `sidebar-section:quirky.worktree/worktrees` with a flat worktree list, and `disable: ["quirky.git"]`. The exit test drives it only through the CLI: `quirky distro install distros/sample --yes`, `quirky ui state --json` (sidebar section owned by `sample.sidebar`, no source-control panel or `git` CLI group), then `quirky distro remove sample --yes` and the stock state again.
- **Why:** the roadmap's exit test names exactly these steps, and a distro in the repo doubles as an example for authors
- **Evidence:** docs/roadmap.md M0 "Exit test"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/roadmap.md

## D31: Port v1 for real, growing the public plugin API, rather than facades or raw RPC primitives
- **Question:** brainstorming step 8: which approach moves v1 into plugins
- **Options:** A, feature code moves into the plugins, and the kernel grows the public context (D11); B, facade plugins that declare methods and delegate to kernel internals through a privileged context; C, the kernel exposes low-level primitives (`pty.spawn` and the like) as public RPC methods and plugins use only `context.call`
- **Chose:** A
- **Why:** B fails the rule that built-ins use only the public API, and the research shows privileged-only APIs leave third parties unable to match or replace built-ins (VS Code proposed APIs, Firefox experiments, Chrome component extensions). C opens process spawning to every API client and pushes terminal streaming through JSON. A costs the most code, but it is the only one that tests the plugin API the way the roadmap asks.
- **Evidence:** https://code.visualstudio.com/api/advanced-topics/using-proposed-api ; https://firefox-source-docs.mozilla.org/toolkit/components/extensions/webextensions/basics.html ; https://github.com/neovim/neovim/blob/master/runtime/doc/api.txt ; https://github.com/microsoft/vscode/blob/main/extensions/git/README.md
- **Reversibility:** hard
- **Confidence:** high
- **Source:** locked by docs/roadmap.md (built-ins use only the public API); assumed — autonomous (the approach)

## D32: In scope from cli.md and ask.md: the CLI core and v1's ask flows
- **Question:** which flows of the two feature docs this item owns
- **Options:** n/a
- **Chose:** cli.md: running a command in text and JSON; error output and exit codes; finding and authenticating to the daemon over the socket; selectors; `--version`; idempotent retry of a lost reply; caller identity from the session env; `status` and `open` as v1 has them. ask.md: registering an ask and waiting in chunks, `ask wait`, `ask cancel`, answering or declining a card (answered, partial and declined), a second ask while one is pending, and asks surviving a daemon restart. Out of scope, in the spec's non-goals: remote runtimes, `serve`, environments, pairing, `agent-context` (covered by `quirky api`), M1's command groups, Windows and WSL paths; and ask.md's number and date questions, defaults, timeouts with defaults, credential refusal, drafts, previews, hand-off, liveness, the wait concurrency cap, the 3-minute notification and Claude suppression flags (M2's ask parity).
- **Why:** roadmap M1 says the CLI core landed in M0 and M1 adds the command groups. M2 owns ask parity.
- **Evidence:** docs/roadmap.md M1 "CLI", M2 "orca ask parity"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/roadmap.md

## D33: Two Orca defects get tests here
- **Question:** LOOP.md step 4 asks for a test per Orca defect the item's docs record
- **Options:** n/a
- **Chose:** `orca --version` failing in a from-source build (D18), and the queued second ask that never appears. Quirky's Questions panel shows every pending ask, and the test registers two asks, answers the first and checks that the second is still listed by `quirky.ask/list`, still in the panel's reported state, and resolves its own waiter when answered. The fresh sequence number itself is M2's work.
- **Why:** both are in the defect index for these docs. The second-ask test costs little and guards the port of asks.
- **Evidence:** research/orca-features/README.md "Orca defects found along the way"; research/orca-features/ask.md "Queued asks"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D34: Ported commands keep v1's text output, and exit codes stay 0, 1 and 2
- **Question:** output-format and exit-codes for the ported commands and the new ones
- **Options:** generic output for every plugin command; v1's formatters moved into each plugin's CLI module
- **Chose:** each plugin's CLI module keeps v1's tables and records for its commands. New kernel commands print short records. Exit codes stay as m0-scripting D15 fixed them: 0 ok, 1 runtime error (including a declined confirmation and a selector that matches nothing), 2 usage. Under `--json`, a confirmation-required, selector or request-ID error is the usual error document with codes `confirmation-required`, `declined`, `not-found` or `conflict`.
- **Why:** "v1 behaves as it does today", and scripts parse `--json` rather than text
- **Evidence:** docs/loop/decisions/m0-scripting.md D15; packages/cli/src/output.ts
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D35: Fast-track the remaining defaults
- **Question:** brainstorming's essential-coverage gate and the remaining clarifying questions
- **Options:** n/a
- **Chose:** the six essentials are covered: purpose (the roadmap's M0 items), users (agents, people at the window, plugin and distro authors), success (the M0 exit test and LOOP.md step 6), constraints (the locked decisions, macOS only), scope (D32) and failure behavior (D15, D19, D20, D23). Remaining build-only questions go to the tech spec.
- **Why:** LOOP.md treats the user as having elected the stated defaults
- **Evidence:** docs/loop/LOOP.md "Answering a skill's questions"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D36: Tech-spec mechanisms: built-ins as workspace packages, UI modules built by the UI build, a headless window for tests
- **Question:** writing-specs tech-spec rubric: the build-only questions the logic spec deferred
- **Options:** for plugin UI: bundle on request in the daemon, or a build step; for module resolution: plugins outside the workspace, or `plugins/*` as workspace packages; for window tests: scripted fake windows only, or the real `App` under happy-dom
- **Chose:** `plugins/*` become workspace packages (Bun's isolated installs give a file outside a package no `@quirky/protocol`); `packages/ui/build.ts` bundles each built-in's `src/ui.tsx` to `dist/ui.js` with the app's React externals; tests render the real `App` under happy-dom and map module URLs to the TSX sources. Request records, confirmations and the distro are new kernel tables; the layout is a `ui_state` row; routed commands go out as a targeted `ui.command.request` event and come back through `ui.command.reply`. The hook endpoint answers 200 for any session once the token checks, because the daemon no longer knows sessions.
- **Why:** a daemon bundler would cost the memory budget and still need resolution in a packaged app. The real `App` is the only way an exit-test report proves what the window shows.
- **Evidence:** packages/daemon/node_modules (isolated installs); packages/ui/build.ts:12-33; packages/daemon/src/plugin-files.ts
- **Reversibility:** medium
- **Confidence:** medium
- **Source:** assumed — autonomous

## D37: One spec review pass over both specs, with the tech-spec reviewer folded into it
- **Question:** LOOP.md step 4 replaces the user's spec review with one adversarial pass over both specs; the tech-spec rubric also asks for its reviewer
- **Options:** run both; one Codex adversarial pass whose criteria include the rubric's checks (anchors, fidelity, contracts, buildability)
- **Chose:** one pass, depth deep, spec-design profile, Codex reviewer through pi-watch, with the rubric's checks in the criteria
- **Why:** the user trimmed the review rounds in commit 9a0ae1e, and the criteria cover what the rubric's reviewer checks
- **Evidence:** docs/loop/LOOP.md step 4; git show 9a0ae1e
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D38: Build with Claude subagents implementing and Codex reviewing
- **Question:** subagent-driven-development preflight: backend pairing, dirty tree, test runner
- **Options:** the reachable pairs `claude-task + codex`, `claude-task + gemini`, `pi-codex + gemini`
- **Chose:** `claude-task + codex` (IMPLEMENTER claude-task, AUTHOR_FAMILY anthropic, REVIEWER_ALIAS codex). The tree holds only this item's own decision-log edits, committed before RUN_BASE. FULL_SUITE_CMD is `bun run test && bun run typecheck`; the baseline ran 1362 tests green in 72 s.
- **Why:** LOOP.md names this pairing, and `pi-watch --check codex` passed
- **Evidence:** docs/loop/LOOP.md step 5
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D39: Build in five waves: a scaffold, kernel modules, plugins beside v1, the switch-over with the UI port, then scenario tests
- **Question:** writing-plans decomposition and wave shape
- **Options:** remove v1 first and port everything at once; build the plugins beside v1's kernel code, then switch over in one wave
- **Chose:** W1 a scaffold (every new type, schema, stub module and wiring, so later tasks own disjoint files); W2 kernel modules (socket transport, dispatch pipeline, context growth, install/distro/safe mode, layout, manifest kinds and CLI catalog, CLI core); W3 the eight plugins, running beside v1's kernel methods under their new names; W4 the switch-over (remove v1 from the kernel and CLI, protocol 2, the shell rendering the daemon's layout, the plugins' UI modules, the desktop shell); W5 the sample distro, the exit test and a sweep that gives every scenario a named test. Checkpoint reviews after W2, W3 and W4.
- **Why:** the gate stays green at every wave, because v1 keeps working until W4 swaps it out, and the scaffold gives the many tasks that would touch `methods.ts`, `daemon.ts` and `store.ts` one owner
- **Evidence:** packages/daemon/src/methods.ts:25 (Handlers is exhaustive over Methods); docs/loop/decisions/m0-scripting.md D32
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D40: Spec review: fix five model findings, reject the pre-pass findings
- **Question:** the adversarial review over both specs (D37) returned 97 blocking findings
- **Options:** fix each; reject with a reason
- **Chose:** fixed the five model findings. F1 (CRITICAL): a confirmation bound selector text, so approving `wt rm current` in one worktree authorized it from another; the confirmation now binds method, params, the caller's identity and the action text, which a `describe` method resolves (`quirky.worktree/describeRemove`). F3: the notifications setting now reaches the desktop shell through `notify.desktop`. F10: request IDs hash the method name so they fit 128 characters. F11: SC-54's example chord was kernel-reserved; it uses `mod+shift+d`, and a distro binding on a reserved chord is shadowed with a warning. F12: a v1 scrollback outside the new range is clamped on import. Rejected 91 pre-pass `unresolvable-reference` findings (contribution IDs, commands and fixtures the specs plan to create, and quoted CLI lines) and F13, the pre-pass's Purpose/Overview heading check, since the rubric sets the headings.
- **Why:** each model finding was a real gap with a cheap fix. The pre-pass findings name things this item creates, as in earlier items' reviews.
- **Evidence:** scratchpad sr1/gate.json; docs/loop/decisions/m0-scripting.md D26
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D41: W3 starts while W2's checkpoint review runs, with fakes of sibling plugins in each plugin's tests
- **Question:** subagent-driven-development ordering (checkpoint review before the next wave) and how plugins that depend on each other are built in parallel
- **Options:** wait for the review, then build the plugins in dependency order across three waves; build all eight in one wave against fake siblings, while the review of W2 runs
- **Chose:** W3 dispatches during the W2 checkpoint review, because W3 writes only `plugins/**` and any W2 fix writes only `packages/**`, so neither can see the other's half-finished work. Each plugin's tests run it against small fake plugins with its siblings' IDs. Real plugins meet in W4's integration and W5's scenario tests. During the coexistence wave the test harness loads no built-ins by default (`builtinPluginsDir: null`), so v1's tests don't pick up half-built plugins. Test seams are in-process globals (`@quirky/git` `useTestGit`, `__QUIRKY_TEST_STRUCTURED_RUNNER__`) and `QUIRKY_TEST_ENTER_DELAY_MS`, instead of tech.md's module-path variables, since the harness runs the daemon in the test's process.
- **Why:** dependency-ordered waves would turn six parallel tasks into a three-deep chain with three extra checkpoints
- **Evidence:** packages/daemon/test/helpers.ts:28 (in-process daemon); docs/quirk/specs/2026-10-26-m0-core/tech.md "Test seams"
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** W4's integration finds plugins that pass against fakes and fail against each other
- **Source:** assumed — autonomous

## D42: W2 checkpoint: accept all nine findings, which collapse to seven defects
- **Question:** subagent-driven-development Step 9, adjudicating the W2 checkpoint review (three Codex lenses, standard depth)
- **Options:** accept; reject with a reason
- **Chose:** accepted all. C1 and S1 (HIGH): module-backed CLI commands looked up handlers by full contribution ID instead of name. C2 (HIGH): a reinstalled plugin kept running its old module from Bun's import cache. C4: a distro reinstall with unchanged versions left old code active. C3 and S2: distro disables reported as the user's. X1: a failed rename during a distro reinstall lost the old plugin. X2: an oversized socket line was dispatched when its newline arrived in the same chunk. X3: a stream opened after its connection closed never cleaned up. Fixed in three disjoint fix components (CLI, plugin host lifecycle, socket and streams), dispatched beside W3 because W3 writes only `plugins/**`.
- **Why:** each came with a reproduction against the code
- **Evidence:** scratchpad cp-w2/{C,S,X}/gate.json
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D43: W3 checkpoint: accept all eight findings, which collapse to five defects
- **Question:** subagent-driven-development Step 9, adjudicating the W3 checkpoint review (three Codex lenses, standard depth)
- **Options:** accept; reject with a reason
- **Chose:** accepted all. C1, S1 and X1 (HIGH): structured permission prompts read `id` from `quirky.ask/create`, which returns `{askId}`, so they could never be answered; the sibling fake returned the whole Ask and hid it. C2 and X2: disabling quirky.ask during a pending wait left a timer that threw against the closed store. X3: disabling quirky.structured left its runners running. X4: a non-forced worktree removal whose session close then failed left processes in a deleted directory. S2: terminal tests loaded the real session plugin instead of a fake. Fixed in four disjoint plugin components before W4 starts, because W4 rewrites those plugins' manifests and sources.
- **Why:** each came with a reproduction or a file-line quote that shows the defect
- **Evidence:** scratchpad cp-w3/{C,S,X}/gate.json
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D44: W4 calls the tasks made inside their briefs, accepted at audit
- **Question:** what to accept from the W4 switch-over tasks' own judgment calls, and how to close the merged tree's leftovers
- **Options:** accept each call; send it back; fix at integration
- **Chose:** accepted these. The session view binds `mod+1`..`mod+9` to commands `select-tab-1`..`select-tab-9` (the keybinding kind carries no args) and keeps `select-tab {index}`. Creating a worktree opens its session view, as v1 selected it. The shell deleted v1-only modules with nothing left to serve (`actions.ts`, `lib/persist.ts`, `lib/settingsForm.ts`, `AddRepoForm.tsx`, `StatusDot.tsx`). Plugin UI modules carry their own copies of `Dialog` and `StatusDot` because they may not import the shell. The questions panel overrides `ask-stack`'s absolute position inline. The 19 typecheck errors and 5 test failures left by parallel tasks (stale v1 names in tests) were fixed in one integration task. `plugins/*/dist/` is ignored. Logic examples that write a setting as `<pluginId>/<name>` stay as written, since the kernel accepts that form beside the full ID (SC-54's test covers it), so no amendment.
- **Why:** each keeps v1's behaviour or follows a constraint the spec sets (public API only, keybinding shape)
- **Evidence:** run journal; merges 00211d8 (W4), U1's merge, 7ca3d23 (integration)
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D45: W4 checkpoint: accept all six findings, which collapse to four defects
- **Question:** subagent-driven-development Step 9, adjudicating the W4 checkpoint review (three Codex lenses, standard depth). The full 856 KB diff failed all three lenses, so the rerun reviewed the non-test source with deleted files left out and moves as renames, with the tests readable through the reviewers' tools.
- **Options:** accept; reject with a reason
- **Chose:** accepted all. S1 (HIGH): the window loaded a plugin's UI module only to mount a slot, so the Questions badge (SC-31) never appeared until the panel opened; the window now keeps every enabled plugin's UI module active. C2, S2 and X2: the session view checked whether structured sessions were available only on mount, in both directions. C3: a scrollback change didn't reach a mounted terminal. X1: removing an ask locally could discard an in-flight refresh carrying a new ask. Fixed in three disjoint components (window host, session UI module, ask UI module).
- **Why:** each came with a reproduction against the code
- **Evidence:** scratchpad cp-w4/{C,S,X}/gate.json
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D46: Final Round 1: accept all thirteen findings, which collapse to seven defects
- **Question:** subagent-driven-development final loop, adjudicating Final Round 1 (three Codex lenses, deep, over 0c6a3c0..7ea2baa). The round ran as two partitions of the non-test source (kernel, CLI and git; window, desktop, plugins and distros) because the branch diff is too large for one prompt.
- **Options:** accept; reject with a reason
- **Chose:** accepted all. Kernel side: concurrent installs of two distros both succeeded (HIGH, three lenses); a lost reply followed by a failed reconnect dropped the request ID the user needs to retry; `quirky distro inspect` left out the reserved-chord warning the confirmation shows. Plugin side: the session view kept the active tab in window memory instead of the daemon's layout (HIGH, D21); a terminal that exited before its spawn resolved went back to running; a mounted terminal could keep the old theme's colors; disabling `quirky.terminal` during an attach left the new stream open. Fixed in one batch of four disjoint components.
- **Why:** each came with a reproduction against the code
- **Evidence:** scratchpad fr1-K/{C,S,X}/gate.json and fr1-P/{C,S,X}/gate.json
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## Progress

Step 6, final review. W1 to W5 merged with checkpoint fix batches after W2, W3 and W4; HEAD 7ea2baa, gate 1976 pass, typecheck clean, every SC has a named test. Final Round 1 running over 0c6a3c0..7ea2baa in two partitions (kernel and CLI; window, desktop, plugins and distros) because the branch diff is too large for one prompt. Next: adjudicate (D46), one fix batch, leftovers to BLOCKERS.md, verify, merge into build/roadmap.
