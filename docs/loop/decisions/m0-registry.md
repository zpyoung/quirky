# m0-registry decisions

## D1: Classify the item as an API and Organization design, and research it
- **Question:** which domain the brainstorming gray-area catalog draws from, and whether the Phase A research swarm runs (quirk:brainstorming, checklist steps 1-2)
- **Options:** API only; Organization only; API plus Organization; skip research as already known
- **Chose:** API plus Organization, with the two Phase A web-research agents
- **Why:** the registry is consumed by plugin authors (manifest format, IDs, override rules) and by the daemon API (introspection, enable and disable), and its core problem is naming and duplicate handling. Research swarms are pre-authorized by LOOP.md.
- **Evidence:** docs/loop/LOOP.md "Answering a skill's questions"; docs/roadmap.md M0 Registry bullet
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D2: Skip the visual companion and the adhd offer, use the standard gray-area set
- **Question:** brainstorming's visual companion offer and its Step 0 adhd offer
- **Options:** run them; skip them
- **Chose:** skip both, and use the standard catalog areas
- **Why:** LOOP.md says to skip the parts that assume a person is there, including both offers
- **Evidence:** docs/loop/LOOP.md "Skip the parts that assume a person is there"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D3: Select every gray area that matters for the registry
- **Question:** which gray areas to drill into (brainstorming Gray Areas Step 1)
- **Options:** API: error-responses, versioning, response-format; Organization: naming-convention, duplicate-handling, exception-handling, grouping-criteria; Integration: conflict-resolution
- **Chose:** naming-convention (ID format), duplicate-handling and conflict-resolution (override rules), exception-handling (bad manifests, activation failure), error-responses (what the API reports), versioning (manifest API version), response-format (introspection output)
- **Why:** LOOP.md asks for every area that matters. grouping-criteria is dropped because the only grouping is by plugin and by kind, which the ID format already fixes.
- **Evidence:** docs/loop/LOOP.md "Gray areas"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D4: Contribution IDs are `<kind>:<pluginId>/<name>`
- **Question:** the stable ID format (naming-convention gray area)
- **Options:** VS Code style `<publisher>.<name>` with kind implied by where it is declared; Backstage style `<kind>:<namespace>/<name>`; opaque UUIDs
- **Chose:** `<kind>:<pluginId>/<name>`, for example `command:quirky.scm/commit`. Kinds are lowercase dotted words, plugin IDs are lowercase words joined by `.` or `-` (64 chars max), names allow letters, digits, `.`, `_` and `-` (128 chars max).
- **Why:** putting the kind in the ID means an override can't change what kind of thing it replaces, and the same short name can exist in two kinds. The roadmap names Backstage as the model for overrides. Names allow camelCase because v1 method names such as `session.createStructured` will become contributions.
- **Evidence:** docs/roadmap.md M0 Registry; https://backstage.io/docs/frontend-system/architecture/extension-overrides/ ; Orca src/shared/plugins/plugin-id-format.ts
- **Reversibility:** hard
- **Confidence:** medium
- **Revisit if:** a later kind needs IDs that don't fit the name pattern, such as keybinding chords or file globs
- **Source:** assumed — autonomous

## D5: The `quirky.` plugin ID prefix is reserved for built-ins
- **Question:** whether an installed plugin may use any plugin ID (naming-convention, duplicate-handling)
- **Options:** any ID; reserve `quirky.` for built-ins
- **Chose:** reserve it. An installed plugin whose ID starts with `quirky.` is rejected as invalid.
- **Why:** contribution IDs carry the plugin ID, so a third party claiming `quirky.scm` could pass for a built-in in the install screen and in `quirky plugin list`. Overriding a built-in stays possible through `overrides`.
- **Evidence:** research finding 2 (duplicate owner IDs are a hard error in VS Code and Backstage)
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** distros need to ship plugins that look built-in
- **Source:** assumed — autonomous

## D6: A plugin's own contributions use short names, overrides use full IDs
- **Question:** how a manifest says "this replaces another plugin's contribution" (duplicate-handling, conflict-resolution)
- **Options:** same `contributes` list with an `override: true` flag on full IDs; a separate `overrides` list of full IDs; implicit override whenever an ID repeats
- **Chose:** `contributes` holds the plugin's own contributions by kind and short name, which the kernel prefixes with the plugin ID. `overrides` is a separate list of entries with full IDs. A repeated ID that isn't in `overrides` can't happen, because `contributes` IDs are always in the plugin's own namespace.
- **Why:** an override must be explicit and recorded (research finding 3), and keeping it in its own list makes the install screen's "what this plugin replaces" a direct read of the manifest
- **Evidence:** research finding 3; https://backstage.io/docs/frontend-system/architecture/extension-overrides/
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** plugin authors find the two lists confusing in practice
- **Source:** assumed — autonomous

## D7: An override replaces the whole contribution, not a merge
- **Question:** whether an override's fields merge into the original or replace it (conflict-resolution)
- **Options:** deep merge like LazyVim `opts`; full replacement like Backstage
- **Chose:** full replacement of the declared data and of the implementation
- **Why:** replacement is predictable and needs no per-kind merge rules. Resolving an overridden ID activates the overriding plugin only, so a built-in whose contributions are all overridden is never loaded.
- **Evidence:** research finding 3 (Backstage overrides create a new extension rather than mutating the old one)
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** later kinds such as settings need partial overrides, for example changing only a default
- **Source:** assumed — autonomous

## D8: Override precedence is installed over built-in, then dependent over dependency, then a reported conflict
- **Question:** which override wins when two plugins override the same ID (conflict-resolution)
- **Options:** last loaded wins; reject both; a fixed precedence with a deterministic tie-break
- **Chose:** an installed plugin's override beats a built-in's. Within the same source, a plugin that depends on the other, directly or transitively, wins. Otherwise it is a conflict: the plugin whose ID sorts first wins, the other override is rejected, and a diagnostic on the losing plugin names the winner.
- **Why:** the winner must not depend on load or directory order (research finding 3). Dependency order lets a plugin deliberately override another override. Rejecting both would break two working plugins over one shared ID.
- **Evidence:** research findings 3 and 5
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** distros need an explicit priority field, or users hit conflicts often
- **Source:** assumed — autonomous

## D9: Disable works by plugin ID or contribution ID, before any code loads, and persists
- **Question:** what can be disabled, by whom, and when it applies (exception-handling, error-responses)
- **Options:** plugin IDs only; contribution IDs only; both
- **Chose:** both. The user (through the API and CLI) can disable any plugin or contribution ID. A plugin can disable contribution IDs through its manifest's `disables` list, which applies only while that plugin is enabled. Disabled IDs persist in the daemon's store across restarts. A disabled ID wins over every override of it. Disabling a plugin also disables plugins that depend on it, each with a diagnostic naming the cause.
- **Why:** the roadmap requires disable by ID for distros and lets plugins disable built-ins. Disable state must be applied without loading plugin code (research finding 4). Cascading is reported instead of refused so a distro can turn off a built-in that others need and see what else went with it.
- **Evidence:** docs/roadmap.md "Overrides" and M0 Registry; research finding 4; microsoft/vscode#54621
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** users expect disabling a plugin to be refused while dependents are enabled
- **Source:** locked by docs/roadmap.md (disable by ID); assumed — autonomous (cascade and persistence)

## D10: Enable and disable apply live, without a restart
- **Question:** whether a change to enabled state needs a daemon restart (exception-handling)
- **Options:** restart required; live recompute
- **Chose:** live. The registry recomputes, a newly disabled active plugin is deactivated, and a `plugin.changed` event goes out.
- **Why:** M0's exit test has an agent install a distro, check `quirky ui state` and revert it using only the CLI. A restart in between would make that test depend on daemon restarts.
- **Evidence:** docs/roadmap.md M0 exit test
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** plugins can't deactivate cleanly enough in process, for example because of leaked timers
- **Source:** assumed — autonomous

## D11: Plugins activate lazily on first use by default, or at startup when the manifest says so
- **Question:** what triggers activation (lazy activation)
- **Options:** VS Code style activation event list; lazy by default with an opt-in `startup`; always eager
- **Chose:** `activation` is `lazy` (the default) or `startup`. A lazy plugin's module is imported only when one of its effective contributions is first resolved, or when `plugin.activate` is called. Dependencies activate first. There is no wildcard trigger.
- **Why:** the roadmap requires that an unused plugin costs no memory. Research finding 1 says contributions should be the trigger and wildcard triggers rejected. Later items add event triggers when a feature needs one.
- **Evidence:** docs/roadmap.md "Lazy activation, so an unused plugin costs no memory"; https://code.visualstudio.com/api/references/activation-events
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a later feature needs to activate on an event no contribution covers
- **Source:** locked by docs/roadmap.md (lazy); assumed — autonomous (trigger set)

## D12: Every contribution is declared in the manifest, and code can only provide declared ones
- **Question:** whether a plugin can register contributions at runtime that its manifest doesn't list (lazy activation, response-format)
- **Options:** runtime registration allowed; declaration required
- **Chose:** declaration required. At activation a plugin provides implementations only for IDs its manifest declares in `contributes` or `overrides`. Providing anything else fails its activation.
- **Why:** lazy activation, `quirky api --json` and the install screen all need the full contribution list without running plugin code
- **Evidence:** docs/roadmap.md M0 Scripting surface and Distros; https://code.visualstudio.com/api/references/contribution-points
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** a feature needs dynamic contributions, such as one command per user-defined quick command
- **Source:** assumed — autonomous

## D13: A bad plugin never stops the daemon or other plugins
- **Question:** what happens on a bad manifest, a missing dependency, a cycle or a failing activation (exception-handling)
- **Options:** fail the daemon; skip the plugin with a diagnostic
- **Chose:** skip with a diagnostic. Load-time problems (unreadable or invalid manifest, unknown top-level field, directory name not matching the ID, duplicate plugin ID, reserved prefix, missing dependency, dependency cycle) mark the plugin `invalid`, and a cycle names every member. An activation that throws, rejects or takes longer than 10 seconds marks the plugin `failed` with the error, and its dependents fail to activate. There is no automatic retry; `plugin.activate` retries.
- **Why:** plugins run in process with full trust (locked), so per-plugin containment is the only isolation (research finding 6). A timeout can't stop a synchronous infinite loop in process; that limit comes with the trust decision.
- **Evidence:** docs/architecture.md Decisions (plugins in process); research findings 5 and 6
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a real plugin regularly hangs the daemon synchronously
- **Source:** assumed — autonomous

## D14: Unknown top-level manifest fields are rejected
- **Question:** strict or lenient manifest parsing (versioning)
- **Options:** ignore unknown fields; reject them
- **Chose:** reject unknown top-level fields; contribution entries keep free-form fields until later items give each kind a schema
- **Why:** the API is unstable until M7, so forward compatibility buys nothing yet, while a typo such as `contribute` would otherwise make a plugin silently contribute nothing
- **Evidence:** docs/roadmap.md "Plugin API growth"
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** M7 freezes the API and needs older hosts to accept newer manifests
- **Source:** assumed — autonomous

## D15: Manifests don't declare an API version yet
- **Question:** whether the manifest carries the plugin API version now (versioning)
- **Options:** add `apiVersion` now; leave it to M7
- **Chose:** leave it to M7
- **Why:** the roadmap puts API version declarations in M7, when the API freezes. Research finding 7 argues for a version floor, which M7 adds.
- **Evidence:** docs/roadmap.md M7 "Plugin manifests declare the API version they target"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/roadmap.md

## D16: The manifest is `quirky-plugin.json` in the plugin's directory
- **Question:** the manifest's file name and where plugins are found
- **Options:** a `quirky` field in `package.json`; a separate `quirky-plugin.json`
- **Chose:** `quirky-plugin.json`. Built-ins are found in one directory shipped with Quirky, installed plugins in `<QUIRKY_HOME>/plugins/<id>/`, and the directory name must equal the manifest ID.
- **Why:** a plugin pack or a UI-only plugin needs no `package.json`, and a fixed directory-to-ID rule makes duplicate installed IDs impossible
- **Evidence:** docs/v1.md "Files and environment" (everything lives under QUIRKY_HOME)
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** plugins get published as npm packages
- **Source:** assumed — autonomous

## D17: The registry is inspected and changed through `plugin.*` methods and a `quirky plugin` CLI group
- **Question:** the scripting surface for this item (response-format, error-responses)
- **Options:** no API until m0-scripting; hand-written methods now, as v1's are
- **Chose:** hand-written methods now: `plugin.list`, `plugin.contributions` (effective by default, every declaration with its status when `all` is set), `plugin.enable` and `plugin.disable` (taking a plugin or contribution ID), and `plugin.activate`. The CLI gets `quirky plugin list|contributions|enable|disable|activate`. Unknown IDs return NotFound. m0-scripting later moves them onto schemas.
- **Why:** LOOP.md requires each flow's test to drive Quirky through the CLI or the daemon API, so the registry needs an API now. Disabling is reversible, so it doesn't confirm.
- **Evidence:** docs/loop/LOOP.md step 6; docs/roadmap.md "Everything is scriptable"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D18: The kernel is not itself a built-in plugin
- **Question:** LOOP.md step 6 requires the feature to ship as a built-in plugin using only the public plugin API; how that applies to the plugin host
- **Options:** wrap the registry's own methods in a built-in plugin; treat the registry as kernel
- **Chose:** the registry and its `plugin.*` methods are kernel. The roadmap lists the plugin host as part of the core, and plugins can't contribute RPC methods until m0-daemon-api.
- **Why:** docs/roadmap.md "the core is a kernel (PTY host, daemon, API, UI shell, plugin host)"; a plugin can't host the system that loads it
- **Evidence:** docs/roadmap.md "What the order rests on"
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the user wants plugin management to be replaceable by a distro
- **Source:** locked by docs/roadmap.md

## D19: Startup plugins settle before the daemon publishes runtime.json
- **Question:** whether the daemon waits for `startup` plugins
- **Options:** activate in the background after listening; await them, each bounded by the activation timeout
- **Chose:** await them before `runtime.json` is written. A failure is recorded and the daemon still starts.
- **Why:** a client that connects then sees settled plugin states, which keeps scripts and tests deterministic. Startup plugins are meant to be rare.
- **Evidence:** packages/daemon/src/daemon.ts startDaemon writes runtime.json last
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** startup plugins slow daemon start noticeably
- **Source:** assumed — autonomous

## D20: Disabled IDs live in their own store table, not in Settings
- **Question:** whether enabled state is part of `settings.get`/`settings.set`
- **Options:** add fields to Settings; a separate table changed only through `plugin.*`
- **Chose:** a separate table
- **Why:** one way to change a fact; `settings.set` would otherwise be a second, unvalidated path
- **Evidence:** packages/daemon/src/store.ts settings table; CLAUDE.md "Give each fact one home"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D21: This item has no Orca defects to test
- **Question:** LOOP.md step 4 asks for a test per Orca defect the item's feature docs record
- **Options:** none, since the item lists no docs; borrow defects from Orca's dropped plugin system
- **Chose:** none from feature docs. The research findings on plugin pitfalls (duplicate owners, load-order winners, crash containment) become acceptance criteria instead.
- **Why:** the item's `docs` field is empty, and Orca's plugin system isn't among the 28 feature docs
- **Evidence:** docs/loop/queue.json m0-registry; research/orca-features/README.md
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/queue.json

## D22: Resolve-time behavior is tested through the kernel's host interface
- **Question:** LOOP.md step 6 wants each flow's test driven through the CLI or daemon API, but resolving a contribution (SC-5, SC-11, SC-17) has no public caller until m0-daemon-api adds method contributions
- **Options:** add a `plugin.resolve` debug method; test resolve through the host interface inside a started daemon; defer those scenarios
- **Chose:** test them through the plugin host of a daemon started by the test harness, and give the API `plugin.activate` so activation order and failure are also driven through the API (SC-6, SC-23)
- **Why:** a resolve method would hand out implementations, which are in-process objects with no JSON form. m0-daemon-api's method contributions make resolve reachable from the API, and its tests cover it there.
- **Evidence:** docs/loop/LOOP.md step 6; logic.md SC-5, SC-11, SC-17
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** the reviewer reads step 6 as allowing no kernel-level flow tests at all
- **Source:** assumed — autonomous

## D23: Choose declarative contributions with lazily loaded code
- **Question:** brainstorming's approach proposal: declarative manifest, code-first registration, or a hybrid
- **Options:** declarative manifest with lazy code; code-first registration at startup; hybrid manifest with triggers only
- **Chose:** declarative manifest with lazy code (the recommended option)
- **Why:** it is the only one where listing, overriding and disabling run no plugin code. Code-first costs every plugin's parse and evaluation at startup (Theia measured about 0.34 s of module evaluation across about 90 modules; Obsidian users report multi-second starts) and can't list contributions statically. The hybrid has to load a plugin before its contributions can be overridden or disabled.
- **Evidence:** https://github.com/eclipse-theia/theia/issues/18196 ; https://forum.obsidian.md/t/new-plugin-make-your-obsidian-start-up-super-fast/87627 ; https://code.visualstudio.com/api/references/activation-events
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** many features turn out to need contributions computed at runtime
- **Source:** assumed — autonomous

## D24: Built-in plugins live in a top-level `plugins/` directory, and packaging them waits for m0-port-v1
- **Question:** where built-ins sit in the repo and how the packaged app finds them (tech spec, Deferred Ideas `[tech-spec]`)
- **Options:** under `packages/plugins/`; a top-level `plugins/` directory; inside `packages/daemon`
- **Chose:** top-level `plugins/`, found through `QUIRKY_BUILTIN_PLUGINS_DIR` (set by the desktop shell to `<root>/plugins` in development and `<resources>/plugins` when packaged). Copying the directory into the packaged app is left to m0-port-v1, the first item with built-ins to ship.
- **Why:** `packages/*` are Bun workspaces with package.json files, and a plugin needs none. This item ships no built-ins, so a copy step would copy an empty directory.
- **Evidence:** package.json workspaces; apps/desktop/src/bun/paths.ts
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** built-in plugins need their own dependencies and so become workspaces
- **Source:** assumed — autonomous

## D25: Activation failures surface as Conflict errors, unknown IDs as NotFound
- **Question:** which JSON-RPC codes the `plugin.*` methods use (tech spec, error-responses)
- **Options:** Internal for activation failures; Conflict; a new plugin-specific code
- **Chose:** NotFound for an unknown ID or a contribution not in effect, InvalidParams for a malformed ID, Conflict for a disabled, invalid or failed plugin and for a missing implementation
- **Why:** these are the codes v1 already uses (packages/protocol/src/rpc.ts RpcErrorCode), and a failed or disabled plugin is a state conflict, not a daemon fault. Adding a code would change the protocol for no client that needs it.
- **Evidence:** packages/daemon/src/errors.ts
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D26: Build with Claude subagents implementing and Codex reviewing
- **Question:** subagent-driven-development preflight `backend_pairing`
- **Options:** claude-task + codex (recommended); claude-task + gemini; pi-codex + opus; same-family pairs
- **Chose:** claude-task + codex. Both `pi-watch --check codex` and `--check gemini` passed in a scratch directory. AUTHOR_FAMILY is anthropic.
- **Why:** LOOP.md step 5 names this pairing, and Codex was reachable
- **Evidence:** docs/loop/LOOP.md step 5
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D27: The build starts on a clean `build/m0-registry` with the specs committed
- **Question:** preflight `dirty_tree_action` and the start-on-main check
- **Options:** stash; commit; abort
- **Chose:** none needed. The tree was clean on `build/m0-registry`, not main.
- **Why:** git status was empty after the spec commit
- **Evidence:** `git status --porcelain` empty
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D28: Test commands are the repo's three LOOP.md commands
- **Question:** preflight `FULL_SUITE_CMD` and build command
- **Options:** `bun run test` plus `bun test scripts` plus `bun run typecheck`; per-package runs
- **Chose:** FULL_SUITE_CMD is `bun run test && bun test scripts && bun run typecheck`. The baseline was green before any change: 360 tests passed, scripts 14 passed, typecheck clean.
- **Why:** LOOP.md step 6 names these three, and there is no separate build step for the daemon
- **Evidence:** package.json scripts; baseline run on 2026-10-26
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D29: Spec review findings: fix the seven model findings, reject the pre-pass reference and heading findings
- **Question:** how to adjudicate the Codex adversarial review of logic.md and tech.md (LOOP.md step 4)
- **Options:** fix each confirmed finding; record a reason for each one not fixed
- **Chose:** fixed every model finding that stood after refutation: the "never loaded" contradiction with startup and dependency activation (logic F1), cycle-dependent invalidity (logic F3, tech F2), duplicate IDs being unrepresentable (tech F1), disable racing activation (tech F3, and logic F2, which the evidence gate dropped but tech F3 repeats), startup activation on enable contradicting the import fence (tech F4), and deactivate failures during a live disable (tech F5). Also took the contested tech F6 and gave every API-reachable scenario an API test. Rejected 55 pre-pass `unresolvable-reference` findings and both `failing-check` heading findings.
- **Why:** the reference findings name contribution IDs used as examples (`command:acme.tools/refresh`), plugin states, and files this item creates, none of which exist before the build. The heading check wants "Purpose" or "Overview", which the repo's writing rules forbid as headings, and "Decisions Locked", which belongs in logic.md (it is there), not tech.md. Verdicts were NEEDS_FIXES for both, reviewer gpt-6.1-sol (openai), independence full, depth standard, profile spec-design.
- **Evidence:** scratchpad gate.json for each spec; CLAUDE.md "Headings should tell the story on their own, so never Overview"
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the build's final review finds a spec gap these fixes missed
- **Source:** assumed — autonomous

## D30: No closure review round on the specs
- **Question:** whether to run adversarial-review's optional closure pass over the spec fixes
- **Options:** run one closure round per spec; rely on the build's final review loop
- **Chose:** rely on the build's final review loop, whose spec-compliance lens reads the amended specs against the code
- **Why:** LOOP.md requires fixing confirmed findings, which is done; a closure pass costs two more Codex dispatches per spec, and the final deep review covers the same contracts with the code in hand
- **Evidence:** docs/loop/LOOP.md step 4; quirk:subagent-driven-development Step 8
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** the final review finds defects that trace to the spec fixes
- **Source:** assumed — autonomous

## D31: Build in three waves of five tasks, and skip wave 1's checkpoint review
- **Question:** subagent-driven-development Steps 3-4 decomposition, and Step 7's optional checkpoint skip
- **Options:** one task per file (more waves and checkpoints); five vertical tasks in three waves; one task
- **Chose:** wave 1: protocol types, and the store table with the desktop path and docs. Wave 2: manifest, discovery and registry, and the CLI group. Wave 3: the host, daemon wiring and the API tests. Wave 1's checkpoint is skipped because it is declarative types, one table and docs, with a green gate (377 tests). Wave 1 also put placeholder `plugin.*` handlers in methods.ts so the repo typechecks between waves; wave 3 replaces them.
- **Why:** each split lands tasks in different components, which buys parallelism; the host and its API tests are one sequential run, so they stay one task (writing-plans granularity economics)
- **Evidence:** quirk:writing-plans "Task-Boundary Granularity Economics"; scratchpad run journal
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D32: Wave 2 checkpoint findings: fix all four defects
- **Question:** adjudicating the wave 2 checkpoint review (subagent-driven-development Step 9, Tier 3)
- **Options:** fix each; dismiss with a reason
- **Chose:** fixed all seven findings, which were four defects: dependency IDs weren't validated (C1, S1, X2), `plugin list` crashed on a line break inside a cell (C2, X1), a contribution of a disabled plugin was attributed to the user instead of its disabled owner (S2), and a FIFO named `quirky-plugin.json` could block discovery (X3). tech.md now states owner-first attribution, dependency ID validation and the regular-file check.
- **Why:** each reproduced with a one-line command in the review; owner-first attribution names the more fundamental cause, and the spec's rule 4 was ambiguous about order
- **Evidence:** run journal checkpoint-w2; commit "fix(plugins): validate dependency IDs..."
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D33: A long QUIRKY_HOME breaks the PTY host's socket; logged, not fixed here
- **Question:** a manual smoke test of `quirky plugin` against a real daemon in a scratch home found the first command waiting 15 s for the daemon
- **Options:** fix it in this item; log it for a later item
- **Chose:** log it. The cause is that `<QUIRKY_HOME>/pty.sock` was 140 bytes, over macOS's 104-byte unix socket path limit, so quirky-pty can't listen. It happens identically on the commit before this item. Every plugin command then worked against the real daemon: list, contributions, activate, disable, the not-found error with exit 1, and `--json`.
- **Why:** it is pre-existing PTY host behavior and outside this item's scope; m0-cli-core (unix socket for the CLI) and m1-term-daemon own socket paths and should place sockets under a short runtime directory or fail with a clear message
- **Evidence:** packages/pty-host/src/server.ts:47 `join(home, 'pty.sock')`; smoke run on 2026-10-26
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** users set QUIRKY_HOME to a deep path
- **Source:** deferred: platform

## D34: The final review loop closed after three rounds with no open finding
- **Question:** subagent-driven-development Steps 8-10, adjudicating the final deep review (Tier 3) and when to exit
- **Options:** fix each accepted finding and run another closure round; exit with findings open
- **Chose:** round 1 (whole branch, three Codex lenses, deep) found four defects, all fixed: a plugin disabled mid-activation skipped its deactivate when activate then failed or timed out (HIGH); resolve could hand back a result after a disable completed in between; multi-line plugin log messages lost the plugin prefix after the first line; and a repeated invalid contribution name hid its duplicate error (LOW). Round 2 (closure over the fix delta) kept one: an import slower than the activation timeout still called activate later. Fixed. Round 3 passed on all three lenses with no findings.
- **Why:** the loop exits on a completed round with no accepted finding above LOW and a green build; that held at round 3 with 535 tests passing
- **Evidence:** run journal rounds 1-3; reviewer gpt-6.1-sol (openai), independence full, depth deep, profile code-diff
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## Progress
Done. Merged into build/roadmap; `bun run test` (535 pass), `bun test scripts` (14 pass) and `bun run typecheck` all pass on the merge result.
