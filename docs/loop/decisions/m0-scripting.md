# m0-scripting decisions

## D1: Classify the item as a CLI and API design, and run both research phases
- **Question:** which domain the gray-area catalog draws from, and whether the research swarms run (quirk:brainstorming, checklist steps 2 and 7)
- **Options:** CLI only; API only; CLI plus API; skip research as covered by earlier items
- **Chose:** CLI plus API. Phase A ran two web-research agents (schema-driven CLI patterns, generated-CLI pitfalls); Phase B ran three, one per approach (a CLI built at run time from the daemon's catalog, schemas registered in code at activation, CLI source generated at build time).
- **Why:** the consumers are agents and people at a shell (the CLI) and plugin authors declaring methods (the API). Earlier items researched registries, daemon APIs and UI slots, not CLI generation. LOOP.md pre-authorizes the swarms.
- **Evidence:** docs/loop/LOOP.md "Answering a skill's questions"; docs/roadmap.md M0 "Scripting surface"
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

## D3: Select every gray area that matters for the scripting surface
- **Question:** which gray areas to drill into (brainstorming Gray Areas Step 1)
- **Options:** CLI: output-format, flag-design, progress-reporting, error-recovery, exit-codes; API: response-format, error-responses, authentication, versioning, rate-limiting, pagination; Organization: naming-convention, duplicate-handling
- **Chose:** flag-design (how a schema becomes flags), output-format (generated commands' text and JSON), error-recovery (unknown commands and flags), exit-codes, error-responses (errors under `--json`), response-format (the `quirky api --json` catalog), versioning (the catalog's version and schema changes), naming-convention (command group names) and duplicate-handling (two sources for the same command words)
- **Why:** LOOP.md asks for every area that matters. Progress reporting is dropped because no command here runs long; pagination and rate limiting because the catalog is bounded by installed plugins and is read once per invocation; authentication because the CLI keeps the daemon token m0-daemon-api D24 settled.
- **Evidence:** docs/loop/LOOP.md "Gray areas"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D4: Schemas are a flat subset of JSON Schema
- **Question:** flag-design and response-format: what language a contribution's schema is written in
- **Options:** full JSON Schema; a flat JSON Schema subset; TypeScript types extracted at build time; a Quirky-specific mini-language
- **Chose:** a JSON Schema subset with the keywords `type` (`string`, `integer`, `number`, `boolean`, `array`, `object`, `null`), `description`, `enum`, `items`, `properties`, `required`, `additionalProperties` (boolean only), `minimum`, `maximum` and `default` (documentation only). `{}` means any value. An `enum` needs a `type` of `string`, `integer` or `number`, and its values must all have that type. No `$ref`, `allOf`, `anyOf`, `oneOf` or `pattern`. A schema using anything else makes the contribution invalid, with a diagnostic naming the keyword.
- **Why:** every schema stays valid JSON Schema, so agents and tools that read MCP `inputSchema` or OpenRPC read Quirky's as is. A flat subset maps cleanly to flags; Jargon's generator flattens `allOf` and silently loses constraints when properties repeat. Plugin manifests are JSON, so TypeScript types aren't available to the daemon.
- **Evidence:** https://github.com/trans/jargon ; https://modelcontextprotocol.io/specification/2025-06-18/server/tools ; https://spec.open-rpc.org/
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** a later feature's method needs a union type that `{}` with a description can't document well enough
- **Source:** assumed — autonomous

## D5: Methods declare `params` and `result`, events declare `data`, UI commands declare `args`
- **Question:** which contributions carry schemas, since the roadmap says every method, command and event declares one
- **Options:** require every schema field; make them optional with a defined meaning when omitted; also add schemas to jobs, launch hooks and slots
- **Chose:** `method` gains `params` and `result`, `event` gains `data`, and UI `command` gains `args`. `params` must be `type: object`. Omitting `params` declares a method that takes no parameters, omitting `args` a command that takes none, omitting `data` an event that carries none, and omitting `result` a result of any shape. Jobs, launch hooks, views, panels, sidebar sections, keybindings and themes take no caller input, and settings are already typed, so they get no new field.
- **Why:** an omitted field still states a contract, which keeps the many existing fixtures valid (as m0-ui-api D35 did for titles) while every method still has a schema the CLI and catalog can use
- **Evidence:** packages/daemon/src/plugins/kinds.ts:6-11; packages/daemon/src/plugins/ui-kinds.ts:14-22; docs/roadmap.md M0 "Scripting surface"
- **Reversibility:** medium
- **Confidence:** high
- **Source:** assumed — autonomous

## D6: The daemon validates every call's params against the method's schema, and leaves results and event data unchecked
- **Question:** error-responses: what the schema enforces at run time
- **Options:** documentation only; validate params only; validate params, results and emitted event data
- **Chose:** every method call, kernel or plugin, from a client or a plugin, is checked against its `params` schema before any plugin code is activated or run. A mismatch is an InvalidParams error whose message names the first failing path, for example `params.limit must be an integer`. Nothing is coerced: `"5"` is not an integer. Properties a schema doesn't declare are rejected unless it sets `additionalProperties: true`. Results and event data are not checked.
- **Why:** a plugin then never sees input its schema rules out, and the catalog can't promise what the daemon doesn't enforce. Strict requests with tolerant responses is the default Speakeasy uses, so a plugin's sloppy result degrades documentation rather than breaking callers.
- **Evidence:** https://www.speakeasy.com/mcp/tool-design/generate-mcp-tools-from-openapi ; https://rest.sh/blog/turn-an-openapi-spec-into-a-cli-without-generating-code/
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** plugins' results drift from their schemas often enough that agents are misled
- **Source:** assumed — autonomous

## D7: Kernel methods and events get schemas too, in one table checked against the protocol types
- **Question:** response-format: whether `quirky api --json` covers the kernel's own 47 methods and its events
- **Options:** list plugin contributions only; give every kernel method and event a schema in a table the type checker keeps complete
- **Chose:** every kernel method and kernel event has a schema in `@quirky/protocol`, in a table keyed by method name and event type so a new method without a schema fails `bun run typecheck`. The daemon validates kernel calls against it as D6 says, ahead of the handlers' own checks, which stay.
- **Why:** the roadmap says `quirky api --json` lists every method, and an agent needs the kernel's methods most. Enforcing the table makes a wrong schema fail the existing tests rather than mislead agents.
- **Evidence:** packages/protocol/src/rpc.ts:27-151; docs/roadmap.md M0 "Scripting surface"
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a kernel schema turns out stricter than a real client's calls, which the existing suite would show
- **Source:** assumed — autonomous

## D8: UI commands' `args` are declared and listed here; running them from the CLI waits for m0-ui-bridge
- **Question:** scope: whether this item makes UI commands callable from the CLI
- **Options:** route UI commands to the window now; declare and list their `args` and leave routing to m0-ui-bridge
- **Chose:** declare `args`, validate the schema in the manifest, and list UI commands with their `args` in `quirky api --json`. Routing a UI command to the window and checking its arguments there belongs to m0-ui-bridge.
- **Why:** the queue gives "UI commands as API commands routed to the window" to m0-ui-bridge, which depends on this item
- **Evidence:** docs/loop/queue.json m0-ui-bridge
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/queue.json

## D9: One command table drives parsing, validation, help, suggestions and the catalog
- **Question:** flag-design: how the kernel's hand-written commands relate to the generated ones
- **Options:** keep hand-written usage strings beside a separate catalog; give each kernel command a declarative spec (positionals, typed flags with descriptions, summary, the methods it calls) from which usage, help, parsing and the catalog all derive
- **Chose:** the declarative spec. Hand-written commands keep their own run code and output formatting, but their usage line, help and catalog entry are generated from the spec, the same way generated commands' are.
- **Why:** this is the design cli.md credits for Orca's surface never drifting between help, validation and `agent-context`
- **Evidence:** research/orca-features/cli.md intro and "Command table and validation"
- **Reversibility:** medium
- **Confidence:** high
- **Source:** locked by research/orca-features/cli.md

## D10: A plugin's methods become `quirky <group> <method>`, where the group is the plugin ID without the `quirky.` prefix
- **Question:** naming-convention: which words select a generated command
- **Options:** the full plugin ID as the group; the plugin ID with the built-in prefix dropped; a group name the manifest declares; one flat `quirky call <method>` only
- **Chose:** each in-effect plugin `method` contribution `<pluginId>/<name>` becomes `quirky <group> <name>`, where `<group>` is the plugin ID, minus the reserved `quirky.` prefix for built-ins. So `acme.notes/add` is `quirky acme.notes add` and a future built-in `quirky.repo/list` is `quirky repo list`.
- **Why:** it needs no new manifest field and keeps every installed plugin's group unique, since plugin IDs are. Dropping the prefix lets m0-port-v1 move a v1 group into a built-in plugin without renaming the commands people and agents already type.
- **Evidence:** docs/loop/decisions/m0-registry.md D5; docs/roadmap.md M0 "v1 as built-ins"
- **Reversibility:** hard
- **Confidence:** medium
- **Revisit if:** m0-port-v1 needs a built-in group whose name can't be a plugin ID
- **Source:** assumed — autonomous

## D11: When two sources give the same command words, kernel beats built-in beats installed, and the loser is reported
- **Question:** duplicate-handling: a kernel command, a built-in's generated command and an installed plugin's generated command can share words (`quirky repo list`, or an installed plugin with ID `plugin`)
- **Options:** refuse the later plugin; merge silently; a fixed precedence with the shadowed command reported
- **Chose:** precedence by exact command words: kernel, then built-in, then installed. Commands with different words in the same group coexist. A kernel command also owns its words as a prefix, so a generated `status list` is shadowed by the kernel `status`. A shadowed command stays in `quirky api --json` marked with what shadows it, and its method stays callable through `quirky api call`.
- **Why:** silent overwrite is the reported failure (two plugins' `analyze` commands, last install wins), and refusing would block m0-port-v1's move of kernel groups into built-ins, where the kernel command is deleted in the same change
- **Evidence:** https://github.com/microsoft/apm/issues/1120 ; docs/loop/decisions/m0-registry.md D8
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D12: Each param is a kebab-case flag, objects take JSON, and `--params` passes the whole object
- **Question:** flag-design: how a `params` schema becomes flags on a generated command
- **Options:** flags named exactly as the properties; kebab-case flags; dot notation for nested objects; JSON text for nested values; positionals for required params
- **Chose:** each top-level property `fooBar` is the flag `--foo-bar`. Strings, numbers, integers and enums take one value, booleans are switches (`--x`, `--x=false`), arrays of scalars repeat the flag, and objects, arrays of objects and `{}` values take JSON text. `--params '<json>'` gives the whole params object; naming the same property both ways is a usage error. No positionals. Properties named `help`, `json` or `params` are reachable only through `--params`. Two properties that map to the same flag make the method's contribution invalid.
- **Why:** kebab-case matches the existing flags (`--timeout-ms`). Dot notation strains on arrays of objects, which the research found no good answer for, while JSON text always works. Flags-only keeps generated commands predictable for agents; `--params` covers anything the flag form can't express.
- **Evidence:** packages/cli/src/commands/ask.ts:56; https://github.com/trans/jargon
- **Reversibility:** hard
- **Confidence:** medium
- **Revisit if:** people find flag-only commands for single-ID methods tedious enough to want positionals
- **Source:** assumed — autonomous

## D13: The CLI parses flag values strictly and checks the schema before calling
- **Question:** error-recovery and exit-codes: what happens to a value that doesn't fit
- **Options:** coerce leniently and let the daemon decide; parse strictly by declared type, check required params and the schema in the CLI, then let the daemon check again
- **Chose:** strict. An integer flag takes only integer text, a number only a finite number, a boolean only no value, `true` or `false`, an enum only a listed value, and JSON flags only valid JSON. A string param stays a string even if it looks like a number. Missing required params are a usage error naming every missing flag, and the assembled params object, `--params` included, is checked against the whole schema with the daemon's messages (`params.title must be a string`). These exit 2 without calling the method; the daemon's own check (D6) still applies and its InvalidParams exits 1.
- **Why:** no coercion is the lesson from Restish; catching the error in the CLI gives a usage message with the flag name instead of a property path
- **Evidence:** https://rest.sh/blog/turn-an-openapi-spec-into-a-cli-without-generating-code/ ; packages/cli/src/main.ts:20
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D14: Generated commands print a generic text form, and `--json` prints the raw result
- **Question:** output-format for commands no one wrote a formatter for
- **Options:** always JSON; a generic text form; plugin-declared templates
- **Chose:** with `--json`, the method's result as one JSON document, as every command does today. Without it: a string or number as is; `null` or `{ "ok": true }` as `ok`; an object as `key: value` lines with nested values as compact JSON; an array of objects as a table whose columns are the scalar keys; any other array as one compact JSON value per line.
- **Why:** this mirrors Orca's fallback (`key: value` lines for commands without a formatter) and the CLI's existing tables, with no new manifest field
- **Evidence:** research/orca-features/cli.md "Output modes"; packages/cli/src/output.ts
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D15: Under `--json`, errors are a JSON document on stdout, and the exit codes stay 0, 1 and 2
- **Question:** error-responses and exit-codes for scripted callers
- **Options:** keep errors as text on stderr in every mode; print a JSON error on stdout under `--json`; adopt Orca's full envelope (`id`, `ok`, `result`, `_meta`) for results too
- **Chose:** under `--json` an error prints `{"error": {"code", "message", "suggestions"?}}` on stdout and nothing on stderr. `code` is `usage`, `daemon-unavailable`, or the RPC error's name (`invalid-params`, `not-found`, `conflict`, `method-not-found`, `unauthorized`, `internal`). Exit codes stay 0 (ok), 1 (runtime error) and 2 (usage error). Results are not wrapped.
- **Why:** an agent reading stdout gets a parseable failure, as Orca's `--json` gives. Wrapping successes would break every existing `--json` consumer and test for no gain.
- **Evidence:** research/orca-features/cli.md "Output modes" step 2; packages/cli/src/main.ts:20
- **Reversibility:** medium
- **Confidence:** high
- **Source:** assumed — autonomous

## D16: Unknown commands and flags get suggestions, drawn from generated commands too
- **Question:** error-recovery
- **Options:** a bare error; Orca's "Did you mean" for commands and a list of valid flags for flags
- **Chose:** an unknown command word prints `unknown command "<words>"` and up to three closest command paths (edit distance up to 2, or a matching prefix), from kernel and generated commands. An unknown flag names the command's valid flags. A flag that needs a value and gets none stays an error, and so does one followed by a token starting with `--`, which says to write `--flag=<value>` for such a value. All exit 2.
- **Why:** these are the recoveries cli.md verified in Orca, and the valued-flag rule exists because a shell-eaten value once sent a prompt twice
- **Evidence:** research/orca-features/cli.md "Run a command" step 3 and "Global flags"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by research/orca-features/cli.md

## D17: `quirky api --json` returns one versioned catalog of methods, events, UI commands and CLI commands
- **Question:** response-format and versioning of the discovery output
- **Options:** Orca's `agent-context` shape (commands only); an OpenRPC document (methods only); one Quirky catalog with all four, carrying `schemaVersion`
- **Chose:** `{ schemaVersion: 1, daemonVersion, protocolVersion, methods, events, uiCommands, commands }`, each list sorted by name. Methods and events carry their schema, their source (`kernel` or the plugin ID) and description; commands carry their words, summary, usage, positionals, flags (name, type, description, enum, repeatable, required) and `methods`, every method they may call (one for a generated command, none for `open`), plus `shadowedBy` when shadowed. Only in-effect contributions appear; an overridden method shows the overriding declaration. Text mode prints commands grouped by group with their summaries. `schemaVersion` rises only on a breaking change to this shape.
- **Why:** an agent needs both the methods (for the API) and the commands (for the CLI) from one call; Orca's commands-only listing leaves the RPC surface undiscoverable. A `schemaVersion` matches Orca's and lets agents detect a change.
- **Evidence:** research/orca-features/cli.md "Agent discovery" and "Command table and validation"; https://spec.open-rpc.org/
- **Reversibility:** medium
- **Confidence:** high
- **Source:** assumed — autonomous

## D18: `quirky api call <method>` calls any method, with the same flag mapping
- **Question:** scope: kernel methods with no CLI command (`git.diff`, `terminal.resize`, `structured.messages`) and shadowed plugin methods are otherwise unreachable from the CLI
- **Options:** no generic caller; generate commands for kernel methods too; one generic `api call`
- **Chose:** `quirky api call <method> [--params <json>] [--<param> ...]` calls any listed method, mapping flags from its schema as D12 does, and prints the result as D14 does. The four connection-bound methods (`client.hello`, `events.subscribe`, `terminal.attach`, `terminal.detach`) are refused with a usage error.
- **Why:** the roadmap says an agent can drive anything a person can through the CLI. Generating kernel commands would collide with the hand-written ones until m0-port-v1 retires them.
- **Evidence:** docs/roadmap.md "Everything is scriptable"; packages/daemon/src/plugins/dispatch.ts:6
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D19: The agent skill is generated from the live catalog and shown or installed through `quirky skill`
- **Question:** what "ships an agent skill generated from the same list" means, and how an agent gets it
- **Options:** a static SKILL.md committed in the repo; generated at run time from the live catalog; installed automatically into agent skill folders
- **Chose:** `quirky skill show` prints a Claude-style `SKILL.md` (frontmatter `name: quirky` and a description, then how to discover commands, the `--json`, error and exit-code conventions, and one line per command grouped by group). `quirky skill install --dir <dir>` writes `<dir>/quirky/SKILL.md` and reports `installed` or `up-to-date`; `quirky skill status --dir <dir>` reports `up-to-date`, `stale` or `missing` without writing. `--dir` is required. The text is deterministic for a given catalog, with no timestamps, and holds no per-flag detail, which `--help` and `quirky api --json` give.
- **Why:** generating from the live catalog includes installed plugins and can't go stale. One line per command keeps the skill's context cost down, which the MCP research names as the main risk of large tool lists. A required `--dir` keeps tests and the CLI from writing into `~/.claude` (v1.md "Running it").
- **Evidence:** research/orca-features/cli.md "Where to find it" (Agent skills, `orca skills get`); https://www.speakeasy.com/mcp/tool-design/generate-mcp-tools-from-openapi ; docs/v1.md
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** agents need per-flag detail in the skill to use a command without running `--help`
- **Source:** assumed — autonomous

## D20: The CLI reads the catalog from the daemon on each invocation that needs it, with no cache
- **Question:** versioning: how the CLI learns plugin commands, and how it avoids Orca's stale-bundle drift
- **Options:** cache the catalog on disk with a sync command (Restish); fetch per invocation when needed; generate CLI code at build time
- **Chose:** fetch per invocation through a new `api.describe` method, only when the command words aren't a kernel command, or for `api`, `skill`, help and suggestions. Kernel commands never fetch it.
- **Why:** Orca's `ledger list` and `host list` read as unknown commands, and its automation flags were rejected, because the CLI bundle predated the app. Restish's cache lags until `api sync`. The daemon is local, so one more call costs little.
- **Evidence:** research/orca-features/cli.md lines on `ledger list`, `host list` and automation flags ("stale bundle"); https://rest.sh/blog/turn-an-openapi-spec-into-a-cli-without-generating-code/
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D21: The scripting surface is kernel, not a built-in plugin
- **Question:** LOOP.md step 6 requires the feature to ship as a built-in plugin on the public API; how that applies to the CLI generator, catalog and schema validation
- **Options:** wrap `api.describe` and the skill in a built-in plugin; treat them as kernel, like m0-registry D18, m0-daemon-api D41 and m0-ui-api D25
- **Chose:** kernel. Param validation sits in the dispatch path every plugin method goes through, and the CLI generator is the CLI.
- **Why:** docs/roadmap.md lists the API and CLI as part of the core; a plugin can't host the schema checks of the system that dispatches to it
- **Evidence:** docs/loop/decisions/m0-registry.md D18; docs/loop/decisions/m0-daemon-api.md D41; docs/loop/decisions/m0-ui-api.md D25
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/roadmap.md

## D22: The only Orca CLI defect belongs to m0-cli-core; this item tests the stale-surface hazard instead
- **Question:** LOOP.md step 4 asks for a test per Orca defect in the item's feature docs
- **Options:** n/a
- **Chose:** the feature-doc index lists one CLI defect, `orca --version` failing in a from-source build, and `--version` is m0-cli-core's. This item adds two tests anyway: a plugin method enabled or disabled at run time appears in or leaves `quirky api --json` and the CLI with no rebuild (Orca's stale-bundle hazard), and a valued flag given no value is refused.
- **Why:** the queue gives `--version` to m0-cli-core; the stale-bundle case is a hazard cli.md records even though the index doesn't list it as a defect
- **Evidence:** research/orca-features/README.md "Orca defects found along the way"; docs/loop/queue.json m0-cli-core; research/orca-features/cli.md "Global flags", "Verified in the app"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/queue.json

## D23: cli.md's other flows are out of scope here
- **Question:** scope: which of cli.md's flows this item covers
- **Options:** n/a (a scope boundary)
- **Chose:** in scope: help at root, group and command level; unknown command and flag errors; the global `--json` and `--help`; the syntax rules (`--flag value`, `--flag=value`, switches, repeated flags, missing values); text and JSON output and JSON errors; agent discovery (`quirky api --json`); the bundled skill guide. Out of scope: finding and authenticating to the daemon, selectors, `--version` and idempotent request IDs (m0-cli-core); `status` and `open` (already exist, m0-cli-core); remote runtimes, environments and pairing; registering the shell command and the Settings card with its skill row; each feature's own command group (its milestone); caller identity variables; passthrough and streaming commands.
- **Why:** LOOP.md says a slice's other flows go in the non-goals, and the queue splits cli.md between this item and m0-cli-core
- **Evidence:** docs/loop/LOOP.md step 3; docs/loop/queue.json m0-scripting and m0-cli-core
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/queue.json

## D24: Choose schemas declared in the manifest, a daemon catalog, and a CLI that builds plugin commands from it at run time
- **Question:** brainstorming's approach proposal
- **Options:** (1) schemas in the manifest, validated by the daemon and served as a catalog the CLI reads each time it needs plugin commands; (2) schemas registered in code when a plugin activates (zod or TypeBox objects passed to `provide`); (3) CLI source generated from the schemas at build time (Azure's aaz, Speakeasy)
- **Chose:** (1), the recommended option
- **Why:** it is the only one that lists and validates a plugin's methods without running its code, which m0-registry D23 locked; oclif and VS Code both moved to static declarations for that reason (oclif's manifest took `--version` from 0.65 s to 0.05 s by not importing 3,105 modules). Code-registered schemas would force activation just to print help. Build-time generation can't see plugins installed after the build, and version skew between a generated CLI and its server is exactly Orca's stale-bundle failure. Runtime catalogs elsewhere (Restish, Google's Workspace CLI) add a disk cache because their server is remote; Quirky's daemon is local, so D20 drops the cache.
- **Evidence:** https://github.com/vercel/workflow/pull/4376 ; https://code.visualstudio.com/api/references/activation-events ; https://azure.github.io/aaz-dev-tools/pages/faq/ ; https://rest.sh/blog/turn-an-openapi-spec-into-a-cli-without-generating-code/ ; https://github.com/googleworkspace/cli ; docs/loop/decisions/m0-registry.md D23
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** fetching the catalog makes plugin commands noticeably slower than kernel ones
- **Source:** assumed — autonomous

## D25: Fast-track the remaining defaults
- **Question:** brainstorming's essential-coverage gate and fast-track
- **Options:** keep asking; fast-track once the six essentials are covered
- **Chose:** fast-track. Purpose, consumers, success criteria, hard constraints, scope boundary and primary behavior are settled by roadmap.md, cli.md, LOOP.md and D4 to D24. Every remaining default-able choice takes its recommended default and is tagged in the spec's Decisions Locked.
- **Why:** LOOP.md treats the user as having elected to accept stated defaults
- **Evidence:** docs/loop/LOOP.md "Answering a skill's questions"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D26: Logic-spec review: fix six model findings, reject the pre-pass findings
- **Question:** adjudicating the Codex adversarial review of logic.md (spec-design profile, standard depth, reviewer gpt-6.1-sol, independence full)
- **Options:** for each finding, amend the spec or reject it with a reason
- **Chose:** amended for six. F1: SC-19 had `--params '{"title":1}'` reaching the daemon although D13 checks the schema in the CLI; the CLI now checks the whole params object, `--params` included, and exits 2, while a daemon InvalidParams example uses a check the schema can't express (an empty `repo.add` path). F2 (refuted by the reviewer, kept anyway): routing for a generated command that extends a kernel command's words was undefined, so a kernel command now shadows those (SC-13). F3: discovery runs only at daemon start, so SC-23 enables a disabled plugin instead of installing one. F4: `--prompt --json` used to take `--json` as the prompt; a valued flag followed by `--...` is now missing its value (SC-11, SC-18). F5: an untyped or mixed enum had two flag readings, so an enum needs a type (SC-2). F6: `open` calls no method and `session new` two, so catalog commands carry a `methods` list (SC-20). Rejected F7 (the pre-pass wants a Purpose or Overview heading the rubric doesn't require) and the 42 unresolvable-reference findings, which are fixture names, commands and files the spec defines.
- **Why:** each amended finding named a contract two implementers would build differently
- **Evidence:** scratchpad lr1/gate.json and merged.json; docs/loop/decisions/m0-ui-api.md D34 (same pre-pass rejections)
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D27: No closure review round on the logic spec
- **Question:** whether to re-run the review after the fixes
- **Options:** a closure round; none, as m0-registry D30 and m0-daemon-api D30 chose
- **Chose:** none. The fixes are local to the scenarios named, and the tech spec gets its own review.
- **Why:** consistent with earlier items; the final code review checks behavior against the amended scenarios
- **Evidence:** docs/loop/decisions/m0-registry.md D30
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## Progress
Logic spec written, reviewed and amended (D26). Next: write tech.md beside it and review it with Codex.
