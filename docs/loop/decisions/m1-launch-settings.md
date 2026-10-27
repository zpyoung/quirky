# m1-launch-settings decisions

## D1: Classify the item as Data, API, CLI and Integration work, and run research phases A and B
- **Question:** brainstorming step 2, domain detection and research swarms
- **Options:** classify as Data only; Data plus API, CLI and Integration
- **Chose:** Data (the catalog), API (resolution methods), CLI (flags on `quirky agents` and `quirky session create`) and Integration (session and structured launches consume it). Phase A ran two web researchers, Phase B one per approach.
- **Why:** the item's output is a catalog read through the API and CLI and applied by two launch paths
- **Evidence:** docs/roadmap.md M1 "Launch settings"; research/orca-features/launch-settings.md "How it works"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D2: Skip the visual companion and the adhd offer, and use the standard gray-area set
- **Question:** brainstorming steps 3 and 4 offers
- **Options:** offer them; skip them
- **Chose:** skip both
- **Why:** LOOP.md says to skip parts that assume a person is there and to use the standard gray areas
- **Evidence:** docs/loop/LOOP.md "Answering a skill's questions"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D3: Select every gray area that matters: data-mapping, input-format, conflict-resolution, error-handling, output-format and flag-design
- **Question:** brainstorming step 4, which gray areas to drill into
- **Options:** the Data, API, CLI and Integration catalog entries
- **Chose:** data-mapping (the catalog's shape as plugin authors and API callers see it), input-format (the selection a caller passes), conflict-resolution (picks against raw arguments), error-handling (invalid picks), output-format (what resolution returns and what a session records) and flag-design (CLI). Left out: pagination, rate-limiting, authentication, versioning, sync-direction, retry-policy and progress-reporting, which have no decision here (resolution is pure and synchronous, and the daemon's token covers auth).
- **Why:** LOOP.md asks for every area that matters
- **Evidence:** docs/loop/LOOP.md "Gray areas"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D4: This item builds the catalog, its resolution into argv and structured options, the launch snapshot, the extra-arguments allowlist, and their use by session and structured launches
- **Question:** scope: the feature doc's flows are mostly the automation editor (M5) and Source Control AI recipes (M2)
- **Options:** the catalog alone; the catalog plus the launch paths that exist today; the catalog plus automation and recipe editors
- **Chose:** in scope: the per-agent catalog as data, listing it, validating a selection, resolving a selection plus raw arguments into argv and into structured-session options, the run snapshot with provenance, the extra-arguments allowlist and merge, and passing all of these through `quirky.session/create`, `resume` and `quirky.structured/create`. Out of scope: the automation editor, run history and its CLI (m5-automations), the recipe rows, dialogs, text-generation wiring and "Set by action recipes" note (m2-source-control-notes-ai), model discovery and retirement (D17), the capability gate for paired hosts (D18), and fork-loops (m5-loops).
- **Why:** the roadmap says this lands in M1 "because it is the provider option catalog, and M2's AI commit messages need it" and "one catalog yields both argv and structured-session options". Session launch is the only launch path that exists now, so wiring it gives every in-scope flow a CLI-driven test.
- **Evidence:** docs/roadmap.md M1 "Launch settings", M2, M5; docs/loop/queue.json deps of m2-source-control-notes-ai and m5-structured-runner
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** M2 or M5 finds the API here can't carry what its editor needs
- **Source:** assumed — autonomous

## D5: Approach: each agent's model and option catalog is a `launchOptions` data block on its `agent` contribution, resolved by code in `quirky.agents`
- **Question:** brainstorming's 2–3 approaches
- **Options:** (A) a `launchOptions` block inside each `agent` contribution, with flag templates, conflict aliases and per-model choice lists as data, and the one rule data can't express (Cursor's model-name composition) named by a string; (B) port Orca's TypeScript catalog modules into `quirky.agents`, keyed by agent ID, with functions for flags and conflict removal; (C) a separate `agent-options` contribution kind that names an agent, so a plugin could add options to an agent it doesn't own
- **Chose:** A
- **Why:** m1-providers D6 made each agent data so a plugin can replace or disable it; B would make a replaced agent lose or keep the built-in's options depending on code it can't reach. Every Orca catalog rule except Cursor's composed model name is a template (`--effort {value}`), an alias list, or a value prefix (`-c model_reasoning_effort=`), so data covers them; Phase B research found declarative manifests stay reviewable and the host can inspect them without running code, with a named escape hatch for the rest (devcontainer features, mise). C was rejected because research found no app documents merge rules for several plugins adding models to one provider (VS Code leaves it unspecified, Backstage overrides replace inputs wholesale), and no Quirky user needs it today; a plugin that wants different options replaces the agent through `overrides`.
- **Evidence:** /Users/zpyoung/PycharmProjects/orca/src/shared/agent-session-option-catalog-*.ts; docs/loop/decisions/m1-providers.md D6; https://github.com/devcontainers/spec/blob/main/docs/specs/devcontainer-features.md; https://mise.jdx.dev/asdf-legacy-plugins.html; https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider; https://backstage.io/docs/frontend-system/architecture/extension-overrides/
- **Reversibility:** hard
- **Confidence:** medium
- **Revisit if:** a second agent needs a rule data can't express, or third parties need to add models to a built-in agent
- **Source:** assumed — autonomous

## D6: The catalog's agents, models, labels, descriptions and choice ceilings are Orca's
- **Question:** data-mapping: which agents get a catalog and with what contents
- **Options:** Orca's catalogs as they are; refresh them from today's vendor docs; only Claude and Codex
- **Chose:** Orca's ten: claude (Fable, Opus, Sonnet, Haiku; Effort Low–High, plus Extra high and Max except on Haiku, which has none), codex (GPT-5.6 Sol, Terra, Luna, GPT-5.5, GPT-5.2 Codex; Reasoning effort Minimal up to each model's ceiling), codebuddy, gemini, cursor, grok, muse, antigravity, omp, and opencode (model flag only). Agents Orca gives no catalog, including claude-agent-teams and openclaude, get none.
- **Why:** LOOP.md makes what the doc says Orca does the requirement; m1-providers D9 took Orca's IDs and labels the same way. Phase A research confirms Claude's current models accept low through max and Codex's levels vary per model, which Orca's per-model ceilings already express.
- **Evidence:** research/orca-features/launch-settings.md "Pick a model and effort", "The option catalog"; https://code.claude.com/docs/en/model-config
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a vendor renames a model alias (the data changes, not the code)
- **Source:** locked by research/orca-features/launch-settings.md

## D7: Claude's Fast mode is left out, and catalogs carry only options that change a launch
- **Question:** data-mapping: Orca's Claude Fast mode toggle has no launch flag, only a mid-session `/fast` command
- **Options:** keep it and ignore it at launch; leave it out
- **Chose:** leave it out. Every option in Quirky's catalog has a launch flag, a structured-session key, or composes into the model name (Cursor's Effort, Fast mode and Thinking).
- **Why:** Quirky has no native chat to send `/fast` to, so a Fast mode pick would be accepted and then do nothing
- **Evidence:** /Users/zpyoung/PycharmProjects/orca/src/shared/agent-session-option-catalog-claude-codex.ts CLAUDE_FAST_MODE
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the M3 terminal dock adds mid-session commands
- **Source:** assumed — autonomous

## D8: A selection is `{model?, options?}`, with Orca's bounds
- **Question:** input-format: the shape callers pass
- **Options:** Orca's `{model?, optionValues?}`; flat `{model?, effort?}`
- **Chose:** `model` (1–128 characters) and `options`, a map of up to 16 option IDs (1–64 characters) to a string or boolean. The keys `__proto__`, `constructor`, `prototype` and `model` are refused. No model and no options means "the agent's own default", which adds nothing to the command.
- **Why:** the doc's normalisation and RPC bounds; a flat shape can't carry Cursor's booleans or a future option without a schema change
- **Evidence:** research/orca-features/launch-settings.md "Data model"
- **Reversibility:** medium
- **Confidence:** high
- **Source:** locked by research/orca-features/launch-settings.md

## D9: An invalid selection is refused with Orca's messages, never clamped or dropped
- **Question:** error-handling: an option without a model, a model the agent doesn't offer, a level the model lacks
- **Options:** refuse; clamp to the nearest supported level (Claude's own behavior); drop silently (Orca's saved-data path)
- **Chose:** refuse, with Orca's CLI messages: "--effort requires --model" (as "effort requires a model" at the API), "Agent X does not support launch-time model selection.", "Agent X does not support model M.", "Agent X model M does not support effort E." A value outside the option's choices, a boolean where a choice is expected, or an option the model doesn't offer gets the last message.
- **Why:** the doc's CLI refuses these; Phase A research found clients that send unsupported levels cause 400s and silent drift (codex #46915, #55249, claude-code #30760), so a launcher should fail before the agent starts
- **Evidence:** research/orca-features/launch-settings.md "Set it from the CLI" (flag semantics); https://github.com/openai/codex/issues/46915; https://github.com/anthropics/claude-code/issues/30760
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by research/orca-features/launch-settings.md

## D10: A model ID the catalog doesn't list is accepted when the agent declares options for unknown models or lists no models at all
- **Question:** error-handling: opaque model IDs
- **Options:** Orca's CLI rule (only with `unknownModelOptions`); also accept for agents with an empty model list
- **Chose:** accept for claude, codex, codebuddy, grok, muse and antigravity (they declare options for unknown models, which such a model gets) and for omp and opencode (no model list, so any ID is passed to their model flag with no options). Refuse for gemini and cursor.
- **Why:** Orca's catalogs for omp and opencode list no models because their models are account-scoped; refusing every ID would make their catalogs unusable from the CLI. Phase B research found seeded lists go stale, so accepting opaque IDs where the vendor allows it avoids blocking a new model.
- **Evidence:** /Users/zpyoung/PycharmProjects/orca/src/shared/agent-session-option-catalog-omp.ts, -opencode.ts; https://claudeissues.com/issue/67299-explicit-model-with-deprecated-opus-ids-is-silently-remapped-to-the-current-defa
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** model discovery lands and can validate IDs against a live list
- **Source:** assumed — autonomous

## D11: Precedence: per-launch extra arguments beat picks, and picks beat the agent's configured arguments; a beaten flag is removed, never repeated
- **Question:** conflict-resolution: a pick, the agent's configured arguments and per-launch extra arguments can each set the model or effort
- **Options:** picks always win (Orca's launch builder); raw arguments always win (Orca's snapshot builder); extras > picks > configured arguments
- **Chose:** extras > picks > configured. Extras replace the configured model or effort flag. A pick replaces the configured flag; a pick whose flag the extras also set is not emitted and is reported as set by the extra arguments. Catalog defaults are never injected for options left unset.
- **Why:** the doc records the recipe UI disabling a pick "Set by CLI arguments" (raw per-launch arguments win) and the launch builder letting a pick beat configured defaults; extras are the most specific input, typed for this launch. Phase A research: duplicate model or effort flags stop Codex from starting (Orca PR #25382), so the beaten flag must be removed.
- **Evidence:** research/orca-features/launch-settings.md "From saved value to command line", "Open questions", "Pick a model and effort for a Source Control AI action" step 3; https://github.com/stablyai/orca/pull/25382
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** M2's recipe surface needs configured arguments to beat picks
- **Source:** assumed — autonomous

## D12: The snapshot comes from the same resolution as the command, so it can't misreport provenance
- **Question:** output-format: Orca's open question, where the snapshot uses raw-args-win rules while the launch lets the pick win
- **Options:** compute the snapshot separately (Orca); return it from the one resolution that builds argv
- **Chose:** one resolution returns the argv, the structured options and the snapshot. The snapshot records each pick as `explicit` with its value, or `extra-args` without a value when extras set it (Orca's `raw_args`, renamed to Quirky's kebab-case values and to say which raw arguments); and the effective arguments with source `explicit` (extras present) or `inherited`. It is null when there are neither picks nor arguments.
- **Why:** the doc flags the two code paths as possibly disagreeing; one path makes the test "the snapshot matches the command" hold by construction
- **Evidence:** research/orca-features/launch-settings.md "Run snapshot", "Open questions" first bullet
- **Reversibility:** medium
- **Confidence:** high
- **Source:** assumed — autonomous

## D13: A command override that already sets a flag a pick or extra needs fails the launch
- **Question:** error-handling: the user's command override contains `--model`
- **Options:** fail with Orca's message; let both through
- **Chose:** fail with "Agent command override conflicts with the requested launch preferences. Remove model or effort flags from the command override."
- **Why:** Orca's rule; removing tokens from a user's command override would rewrite their command
- **Evidence:** research/orca-features/launch-settings.md "From saved value to command line" step 3
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by research/orca-features/launch-settings.md

## D14: Extra arguments use Orca's per-agent allowlist and checks
- **Question:** input-format and error-handling for raw per-launch arguments
- **Options:** Orca's allowlist; free text like configured arguments; no extras in this item
- **Chose:** Orca's rules as data on the catalog: claude `--model`, `--effort`, repeatable `--add-dir`; codex `-m/--model`, `-c/--config model_reasoning_effort=<level>`; codebuddy `--model`, `--effort`; cursor `-m/--model`; grok `-m/--model`, `--effort`/`--reasoning-effort`; omp `--model`. At most 4096 bytes, no control characters or line breaks, shell-style quoting only, no `--`, every token an allowed option with a value, model and effort at most once each. Other agents: "Extra arguments aren't supported for this agent yet." Messages are Orca's.
- **Why:** the doc's validation rules; extras exist for unattended launches (automations, recipes) where free text is the injection risk the allowlist closes
- **Evidence:** research/orca-features/launch-settings.md "Add raw arguments to an automation" step 3; /Users/zpyoung/PycharmProjects/orca/src/shared/automation-extra-agent-args.ts
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by research/orca-features/launch-settings.md

## D15: Picks and extras sit where configured arguments sit: before the arguments' `--` terminator
- **Question:** data-mapping: where generated flags go in the command
- **Options:** before the terminator; at the end
- **Chose:** configured arguments (minus beaten flags), then extras, then pick flags, all before the configured arguments' own `--`; hook arguments and the prompt keep their m1-providers positions
- **Why:** Orca inserts structured flags and extras before the terminator; after it they'd be read as positionals
- **Evidence:** research/orca-features/launch-settings.md "From saved value to command line" steps 2–3; plugins/quirky.agents/src/core/plan.ts buildLaunchPlan
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by research/orca-features/launch-settings.md

## D16: A session stores its snapshot, and resume and fork replay the resolved arguments
- **Question:** output-format: where the run snapshot lives before automations exist, and what resume does with picks
- **Options:** snapshot on the session record; return it only from the launch call
- **Chose:** `quirky.session/create` takes `model`, `options` and `extraArgs`; the session record gains `launchSettings` (the snapshot), shown by `quirky session get` as a `Launch:` line (`Claude · Opus · Effort: high`). The launch record's arguments are the resolved arguments, so resume and fork replay the same model and effort, and the resumed session copies the snapshot.
- **Why:** history must not change when settings change (the doc's snapshot rule), and m1-providers D24 already makes resume replay the launch record. The doc's "reused sessions keep the session's original settings" is the same rule.
- **Evidence:** research/orca-features/launch-settings.md "Run snapshot", "Reused session"; docs/loop/decisions/m1-providers.md D24
- **Reversibility:** medium
- **Confidence:** high
- **Source:** assumed — autonomous

## D17: Model discovery and retirement wait for the first item that saves picks
- **Question:** scope: Orca probes a host's model list and strips retired models from saved automations
- **Options:** build the probes now; defer
- **Chose:** defer. Nothing in this item saves a pick, so nothing can go stale; a caller passing a retired ID gets the agent's own failure, or D9's refusal for agents with a closed list. m2-source-control-notes-ai and m5-automations, which save picks, own discovery, retirement and the "Saved model X is not in the current model list." note.
- **Why:** retirement in the doc acts on saved automations; Orca's probes run from native chat, which Quirky dropped
- **Evidence:** research/orca-features/launch-settings.md "Model retirement"; https://docs.litellm.ai/docs/proxy/sync_models_github
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** a user hits a retired seeded model before M2
- **Source:** assumed — autonomous

## D18: No capability flag; callers find the API through `api.describe`
- **Question:** compatibility: Orca's `agent-launch-overrides.v1` capability for paired remote hosts
- **Options:** add a capability string; rely on the method schemas
- **Chose:** no capability string. Quirky has no paired hosts, and `quirky api` already lists each method and its parameters, so an older daemon is detected by the missing method or parameter.
- **Why:** the capability exists because old Orca hosts silently drop unknown fields; Quirky's daemon refuses unknown parameters (m0-scripting)
- **Evidence:** research/orca-features/launch-settings.md "Compatibility"; docs/loop/decisions/m0-scripting.md
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D19: The catalog yields structured options, and `quirky.structured/create` uses them
- **Question:** "one catalog yields both argv and structured-session options": which structured launch consumes them now
- **Options:** expose them in the resolution only; also pass them to the Claude structured runner
- **Chose:** each catalog entry names the structured key for the model and each option (`model`, `effort` for Claude). `quirky.structured/create` takes `model` and `options`, resolves them through `quirky.agents`, and passes the result to the Agent SDK (`Options.model`, `Options.effort`). Extras are refused for structured sessions: "Extra arguments can't be applied to a structured session." An agent with no structured keys refuses picks there.
- **Why:** the Agent SDK takes `model` and `effort` directly, so the wiring is small and proves the claim. The Codex app-server runner is m5-structured-runner's and will read the same keys.
- **Evidence:** plugins/quirky.structured/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts (`model?`, `effort?`); docs/roadmap.md M5 "Shared seams first"
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D20: No UI in this item, so no UI or native scenarios
- **Question:** the doc's Model and Effort selects live in the automation editor and recipe rows
- **Options:** build a picker now (e.g. in the new-session menu); leave the UI to the items that own those editors
- **Chose:** no UI. M2's recipe rows and M5's automation editor render their own fields from `quirky.agents/options`. The Agents view is unchanged.
- **Why:** Orca has no standalone page for this feature ("everything is per automation or per recipe"); a new-session model picker would be a Quirky invention
- **Evidence:** research/orca-features/launch-settings.md "There is no standalone Settings page for this feature"
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** the user wants per-tab model choice in the new-session menu
- **Source:** locked by research/orca-features/launch-settings.md

## D21: API: `quirky.agents/options` lists an agent's catalog and `quirky.agents/resolveLaunch` previews a resolution
- **Question:** output-format: which methods the plugin adds
- **Options:** fold everything into `get`; two new read-only methods plus parameters on the launch methods
- **Chose:** `options {agent}` returns the models, each model's options with choices and labels, the unknown-model rule, whether structured keys exist, and the extra-arguments allowlist with Orca's placeholder (`--model opus --effort high --add-dir docs`). `resolveLaunch {agent, model?, options?, extraArgs?, structured?}` returns the argv the selection adds, the full arguments, the structured options, the snapshot, the options set by extras, and the summary line, using the agent's saved configuration and launching nothing. `plan` and `prepareLaunch` take the same three parameters; `prepareLaunch`'s plan carries the snapshot.
- **Why:** M2 and M5 editors need the catalog and a preview without launching; separate read-only methods keep `get` small
- **Evidence:** plugins/quirky.agents/src/service.ts; docs/roadmap.md "Everything is scriptable"
- **Reversibility:** medium
- **Confidence:** medium
- **Source:** assumed — autonomous

## D22: CLI: `--model`, `--effort`, repeatable `--option key=value` and `--extra-args=` on launch commands, plus `quirky agents options` and `quirky agents resolve`
- **Question:** flag-design
- **Options:** Orca's `--model`/`--effort`/`--extra-agent-args`; a JSON blob flag
- **Chose:** `quirky session new` (terminal, and structured with `--background`) and `quirky agents resolve <agent>` take `--model <id>`, `--effort <level>` (shorthand for `--option effort=<level>`), repeatable `--option key=value` (`true`/`false` for booleans) and `--extra-args=<text>`. `quirky agents options <agent>` prints the catalog. `--json` prints the method result. The name is `--extra-args` because Quirky's agent commands already call configured arguments `args`.
- **Why:** Orca's flag names where they exist; `--option` covers Cursor's booleans without a flag per option
- **Evidence:** research/orca-features/launch-settings.md "Set it from the CLI"; plugins/quirky.agents/cli.ts
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D23: Windows shell quoting for picks and extras is not built
- **Question:** the doc's Windows case: quoting follows the PTY's shell (`cmd`, `powershell`)
- **Options:** build it; defer
- **Chose:** defer; tokenizing and quoting stay POSIX, as m1-providers D13 decided for agent arguments
- **Why:** LOOP.md: macOS only, log each Windows gap
- **Evidence:** research/orca-features/launch-settings.md "Windows shell quoting"; docs/loop/decisions/m1-providers.md D13
- **Reversibility:** medium
- **Confidence:** high
- **Source:** deferred: platform

## D24: The doc's Orca defects become tests
- **Question:** which recorded Orca defects this item must prove absent
- **Options:** —
- **Chose:** (1) the snapshot can report a pick as set by raw arguments while the launch used the pick: test that the snapshot and the argv agree in every precedence case; (2) a structured Effort pick plus a raw `--effort` in extras is accepted without saying which applies: test that one `--effort` reaches argv and the result names effort as set by the extras; (3) effort without a model is silently ignored in saved data: refused (D9); (4) a pick plus a configured model flag emits two model flags (Orca PR #25382, found by Phase A research): test exactly one. The automation detail page hiding model and effort, and the run history row arriving late, belong to m5-automations and are named in the spec's non-goals.
- **Why:** LOOP.md step 4 asks a test per recorded defect
- **Evidence:** research/orca-features/launch-settings.md "Open questions", "Add raw arguments" step 2, "Edge cases"; https://github.com/stablyai/orca/pull/25382
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D25: A malformed `launchOptions` block makes the agent entry invalid, as any other malformed field does
- **Question:** error-handling for plugin-declared catalog data
- **Options:** skip the whole agent with a diagnostic (m1-providers D7); keep the agent without options
- **Chose:** skip the agent with a diagnostic, like every other entry field. A plugin replacing a built-in agent through `overrides` supplies its own `launchOptions` or has none.
- **Why:** one rule for entry validation; a half-applied entry would launch differently from what its author wrote
- **Evidence:** docs/loop/decisions/m1-providers.md D7, D8
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** supersedes m1-providers D7 (extends it to the new field)

## D26: Skip Phase C deep research
- **Question:** brainstorming's optional deep validation
- **Options:** run it; skip
- **Chose:** skip
- **Why:** the approach ports Orca's working rules into the data shape m1-providers already validated; Phases A and B covered the open risks (duplicate flags, unsupported levels, stale IDs, override merging)
- **Evidence:** D5, D9, D11, D17
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D27: Fast-track the remaining questions with the recommended defaults
- **Question:** brainstorming steps 5–6, the remaining clarifying questions after the essential-coverage check
- **Options:** —
- **Chose:** purpose (the catalog M2 and M5 build on), constraints (locked decisions, macOS, plugin API only), success criteria (every flow and defect has a CLI or API test) and non-goals are settled by D4–D25; everything else takes the recommended option
- **Why:** LOOP.md: treat the user as having accepted stated defaults
- **Evidence:** docs/loop/LOOP.md "Answering a skill's questions"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D28: One Codex adversarial review covers both specs and stands in for the tech-spec reviewer
- **Question:** writing-specs asks for a tech-spec reviewer pass and LOOP.md asks for one adversarial review over both specs
- **Options:** run both; run the adversarial review only
- **Chose:** the adversarial review only, with the tech-spec rubric checks in its criteria
- **Why:** LOOP.md replaces the user's spec review with one Codex pass; m1-providers D42 did the same
- **Evidence:** docs/loop/LOOP.md step 4; docs/loop/decisions/m1-providers.md D42
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D29: Build with Claude subagents implementing and Codex reviewing
- **Question:** subagent-driven-development preflight backend pairing
- **Options:** claude-task + codex (Recommended); other cross-family pairs
- **Chose:** claude-task + codex; `pi-watch --check codex` passed (openai-codex/gpt-6.1-sol). Full suite `bun run test && bun run typecheck`, plus `bun test scripts` at the end.
- **Why:** LOOP.md step 5 names this pair
- **Evidence:** docs/loop/LOOP.md step 5
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D30: Spec review: eight findings accepted and fixed, 41 prepass findings dismissed
- **Question:** what to do with the Codex adversarial review of both specs (verdict NEEDS_FIXES, 3 HIGH, 45 MEDIUM, 1 LOW)
- **Options:** fix each; dismiss with a reason
- **Chose:** fixed: F2 (a no-pick launch must still record its inherited arguments, so `buildLaunchPlan` always resolves the snapshot while leaving the command unchanged), F3 (structured sessions store their snapshot through a new optional `launchSettings` on `quirky.session/register`), F4 (a shadowed pick is left out of the structured options), F5 (the CLI refuses `--effort` with `--option effort` and a repeated `--option` key), F6 (an option a launch can't carry is refused, per transport), F7 (every non-unit scenario gets a CLI or API test, and fork is tested), F9 (the shell-syntax rule for extras is exactly Orca's `divergesFromShell`, so `docs#old` passes), F10 (the CLI says Orca's `--effort requires --model`). Dismissed: F11–F51, the deterministic prepass flagging command-shaped prose (`quirky ...`, `--model ...`), method and contribution IDs the specs create, choice values, and the feature-doc link, which points into the local-only research repo outside this worktree (the m1-providers specs use the same link).
- **Why:** each accepted finding changed what an implementer would build or what a test would prove; the dismissed ones are not defects in the specs
- **Evidence:** /private/tmp/claude-502/-Users-zpyoung-orca-workspaces-quirky-build-roadmap/0dae7158-2102-4966-acd5-0f7bd686e990/scratchpad/sr1/gate.json; docs/quirk/specs/2026-10-26-m1-launch-settings/logic.md Amendments
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D31: Selection bounds are enforced in `validateSelection`, not in method schemas
- **Question:** SDD wave 2: the plugin manifest's schema subset has no `minLength`, `maxLength`, `maxProperties` or typed `additionalProperties`, and a manifest using them is skipped
- **Options:** grow the kernel's schema subset; enforce the bounds in code
- **Chose:** method schemas declare `model` as a string and `options` as an object, with the bounds in their descriptions; `validateSelection` refuses the rest as `invalid launch selection: <why>`
- **Why:** growing the kernel schema is out of this item's scope, and every launch path goes through `validateSelection`
- **Evidence:** packages/protocol/src/schema.ts `checkSchemaDeclaration`; plugins/quirky.agents/src/core/selection.ts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the schema subset grows length and size keywords (M7 API freeze)
- **Source:** assumed — autonomous

## D32: A structured launch for an agent other than claude keeps its existing refusal
- **Question:** SDD wave 2: SC-24 expected "Agent X does not support launch-time model selection." for a structured agent without structured keys, but `quirky.structured/create` already refuses every agent but claude first
- **Options:** move the check after resolution; keep the existing refusal
- **Chose:** keep "structured sessions support only the claude agent" for non-claude agents; the catalog's structured-key refusal is tested at the resolution level (`resolveLaunch` with `structured: true`)
- **Why:** claude is the only structured runner until m5-structured-runner, and the existing message is more accurate for the user
- **Evidence:** plugins/quirky.structured/main.ts create; plugins/quirky.agents/test/core/resolve.test.ts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** m5-structured-runner adds a Codex runner
- **Source:** assumed — autonomous

## D33: Checkpoint reviews: five findings accepted and fixed
- **Question:** what to do with the two checkpoint reviews (waves 1–2, and wave 3 with its fix batch)
- **Options:** fix; dismiss
- **Chose:** fixed all: a model ID of `--` split the command around hook arguments (models starting with `-` are refused, and the hook-argument position honours value flags); `unlistedOptions` with `unlisted: "refuse"` was accepted when empty; a command override wrapped in `env --` hid its model flag from the conflict check; the text form of `quirky agents options` dropped model descriptions; a model or option value with NUL or control characters was accepted and failed only at spawn
- **Why:** each was a reproduced defect against the contract
- **Evidence:** scratchpad cp1/ and cp2/ gate.json under /private/tmp/claude-502/-Users-zpyoung-orca-workspaces-quirky-build-roadmap/0dae7158-2102-4966-acd5-0f7bd686e990/scratchpad
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## Progress
All four waves merged (b69fa1d), checkpoint fixes F1 merged, F2 in flight. Next: merge F2, catch up with build/roadmap, Final Round 1 plus one fix batch, verify (no UI scenarios, no native scenarios), land.
