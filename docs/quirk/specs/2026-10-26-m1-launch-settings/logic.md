# Launch settings: a per-agent model and effort catalog that yields argv and structured options

## Status & amendments

**Status:** Approved (headless build loop; decisions in [m1-launch-settings.md](../../../loop/decisions/m1-launch-settings.md)). Tech spec: requested.

**Amendments:**
- 2026-10-26, tech-spec authoring: the launch CLI is `quirky session new` (with `--background` for
  structured sessions), not `create`; `quirky session get <session>` is added as a declared command.
  Extras that set the model shadow the whole pick (SC-15). Options carry no catalog default, since
  defaults are never injected (SC-8).
- 2026-10-26, Codex spec review ([D30](../../../loop/decisions/m1-launch-settings.md)): every agent
  launch records a snapshot, so a no-pick Yolo launch records its inherited arguments (SC-22);
  structured sessions store their snapshot too (SC-23); a shadowed pick is left out of the
  structured options (SC-13); options a launch can't carry, `--effort` with `--option effort`, and a
  repeated `--option` key are refused (SC-9); the CLI message for effort without a model is Orca's
  `--effort requires --model` (SC-9); fork keeps picks like resume (SC-21); the shell-syntax rule
  for extras is Orca's (SC-17).
- 2026-10-26, build ([D32](../../../loop/decisions/m1-launch-settings.md)): a structured launch for an
  agent other than claude keeps the existing "structured sessions support only the claude agent"
  refusal; the structured-key refusal of SC-24 is tested at the resolution level.

## Conceptual model

Orca lets an automation or a Source Control AI recipe pick a model and an effort level for the agent
it launches, instead of always taking the agent CLI's default
([launch-settings.md](../../../../research/orca-features/launch-settings.md)). Two ideas carry it,
and this item builds both for Quirky:

1. **A pick is a small value, turned into flags only at launch.** The caller stores
   `{model, options}`, for example `{model: "opus", options: {effort: "high"}}`. A per-agent catalog
   turns it into that agent's flags (`--model opus --effort high` for Claude,
   `-m gpt-5.5 -c model_reasoning_effort=high` for Codex) or into structured-session options
   (`{model: "opus", effort: "high"}` for the Claude Agent SDK). The same value works for either
   kind of launch.
2. **Every launch records what it applied and where each value came from**: a pick, the agent's
   inherited arguments, or extra arguments typed for this launch. History stays accurate after
   settings change.

The automation editor and the recipe rows that show these fields arrive with their own features
(m5-automations, m2-source-control-notes-ai). This item gives them the catalog, the rules and the
API, and uses them for the launches that exist today: terminal sessions (`quirky session new`,
`resume`, fork) and structured sessions (`quirky session new --background`) ([D4](../../../loop/decisions/m1-launch-settings.md)).

**The catalog is data on the agent.** m1-providers made each agent an `agent` contribution
([m1-providers D6](../../../loop/decisions/m1-providers.md)). Each one that supports launch
settings now carries a `launchOptions` block ([D5](../../../loop/decisions/m1-launch-settings.md)):

- how a model becomes flags (`--model {value}`), which flags already set a model (so they can be
  replaced), and the structured key it maps to (`model`);
- the models, each with a label, an optional description, and the options it supports;
- each option: an ID, a label, a kind (a select with choices, or a boolean), how a value becomes
  flags (`--effort {value}`), which flags already set it, and its structured key (`effort`);
- per model, which choices of an option it offers (Codex's GPT-5.5 stops at Extra high, GPT-5.6 Sol
  goes to Ultra);
- the options an unlisted model gets, if the agent accepts unlisted models at all;
- the extra-arguments allowlist.

Cursor folds its options into the model name (`claude-opus-4-8-thinking-high`). That is the one rule
data can't express, so the block names it (`composeModel: "cursor"`) and `quirky.agents` holds the
code. A plugin that replaces an agent through `overrides` brings its own `launchOptions`.

**The ten catalogs are Orca's** ([D6](../../../loop/decisions/m1-launch-settings.md)):

| Agent | Models | Options |
|---|---|---|
| claude | Fable, Opus, Sonnet, Haiku | Effort: Low, Medium, High, Extra high, Max (Haiku: none) |
| codex | GPT-5.6 Sol, Terra, Luna, GPT-5.5, GPT-5.2 Codex | Reasoning effort: Minimal up to Ultra (Sol, Terra), Max (Luna), Extra high (5.5, 5.2 Codex) |
| codebuddy | Default, Fast, Balanced, Primary, Deep | Reasoning effort: Minimal to Max |
| gemini | Gemini 3 Pro Preview, 3 Flash Preview, 2.5 Pro, 2.5 Flash | none |
| cursor | Auto, GPT-5.3 Codex, Claude Opus 4.8 | Effort Low–High, Fast mode, Thinking (composed into the model name) |
| grok | Grok 4.7, 4.6, 4.5 | Reasoning effort: Low up to Extra high (4.5: High) |
| muse | none listed | Reasoning effort: Minimal to Ultra |
| antigravity | none listed | Reasoning effort: Low–High |
| omp | none listed | none |
| opencode | none listed | none |

Claude's Fast mode is left out because it has no launch flag
([D7](../../../loop/decisions/m1-launch-settings.md)).

## Data flow

A caller (the CLI, an agent, later the automation scheduler) passes an agent, an optional selection
and optional extra arguments to a launch method. `quirky.agents` validates the selection against the
agent's catalog and the extras against its allowlist, then resolves all of them together with the
agent's configured arguments (the user's saved arguments, else the Yolo default):

1. Extras replace the configured flag for anything they set (model or effort).
2. A pick replaces the configured flag for its option. A pick whose flag the extras also set is not
   emitted: the extras win, and the result says so.
3. The arguments become: configured arguments (minus replaced flags), then extras, then pick flags,
   all before the configured arguments' own `--`. Hook arguments and the prompt follow, as
   m1-providers placed them.

The same resolution returns the structured options and the snapshot, so the snapshot always matches
the command ([D11](../../../loop/decisions/m1-launch-settings.md), [D12](../../../loop/decisions/m1-launch-settings.md)).

`quirky.session` spawns the command and stores the snapshot on the session as `launchSettings`. The
launch record keeps the resolved arguments, so resume and fork replay the same model and effort
([D16](../../../loop/decisions/m1-launch-settings.md)). `quirky.structured` passes the structured
options to the Agent SDK ([D19](../../../loop/decisions/m1-launch-settings.md)).
`quirky.agents/resolveLaunch` runs the resolution without launching, for previews and for the
editors M2 and M5 will build.

## Key decisions

- Catalog as data on each agent, with one named code rule for Cursor ([D5](../../../loop/decisions/m1-launch-settings.md)).
- Orca's catalogs, unchanged ([D6](../../../loop/decisions/m1-launch-settings.md)).
- Invalid picks are refused with Orca's messages, never clamped ([D9](../../../loop/decisions/m1-launch-settings.md)).
- Extras beat picks, picks beat configured arguments, and a beaten flag is removed, never repeated ([D11](../../../loop/decisions/m1-launch-settings.md)).
- One resolution makes the command and the snapshot ([D12](../../../loop/decisions/m1-launch-settings.md)).
- No UI here; the M2 and M5 editors read `quirky.agents/options` ([D20](../../../loop/decisions/m1-launch-settings.md)).

## Behavior & scenarios

Each scenario's test drives Quirky through the `quirky` CLI or the daemon API unless it says
"unit". Launch scenarios use the m1-providers e2e harness: a real daemon and PTY host on a temporary
`QUIRKY_HOME` and `HOME`, with fake agent CLIs that record the argv they were started with.

### The catalog

1. **SC-1: Claude's catalog lists four models, and choosing one shows the efforts it supports** (CLI)
   - **Given** a fresh daemon
   - **When** the agent runs `quirky agents options claude --json`
   - **Then** the result lists Fable ("Most capable for the hardest, longest-running tasks"), Opus
     ("Best for everyday, complex tasks"), Sonnet ("Efficient for routine tasks") and Haiku
     ("Fastest for quick answers"), in that order. Fable, Opus and Sonnet offer one option, Effort,
     with choices Low, Medium, High, Extra high and Max (values `low`, `medium`, `high`, `xhigh`,
     `max`). Haiku offers no options. Unlisted models are accepted and get the same Effort choices.
     `quirky agents options claude` without `--json` prints the same as a table.
   - **Data after:** **claude**: ✓ 4 models; ✓ Opus → Effort [low…max]; ✓ Haiku → none; ✓ unlisted models accepted

2. **SC-2: Codex's effort list stops at each model's ceiling** (CLI)
   - **Given** a fresh daemon
   - **When** the agent runs `quirky agents options codex --json`
   - **Then** the models are GPT-5.6 Sol, GPT-5.6 Terra, GPT-5.6 Luna, GPT-5.5 and GPT-5.2 Codex.
     The option is "Reasoning effort". Sol and Terra offer Minimal, Low, Medium, High, Extra high,
     Max and Ultra; Luna stops at Max; GPT-5.5 and GPT-5.2 Codex stop at Extra high.
   - **Data after:** **gpt-5.5** → ✓ minimal…xhigh, ✗ max, ✗ ultra; **gpt-5.6-sol** → ✓ minimal…ultra

3. **SC-3: each of the ten agents has its catalog, and the others say they have none** (API)
   - **Given** a fresh daemon
   - **When** `quirky.agents/options` is called for every agent in the catalog
   - **Then** the ten agents in the table above report `supported: true` with the models and options
     shown there. Every other agent, including claude-agent-teams, reports `supported: false` and no
     models.

4. **SC-4: the catalog says which extra arguments each agent accepts** (API)
   - **Given** a fresh daemon
   - **When** `quirky.agents/options` is called for claude, codex and aider
   - **Then** claude's allowlist reads "--model, --effort, --add-dir" with placeholder
     `--model opus --effort high --add-dir docs`; codex's reads "--model, -c model_reasoning_effort=…"
     with placeholder `-m model-id -c model_reasoning_effort=high`; aider has no allowlist and the
     message "Extra arguments aren't supported for this agent yet."

5. **SC-5: a plugin can replace an agent's catalog, and a malformed one is skipped** (API)
   - **Given** a test plugin that overrides `agent:quirky.agents/claude` with a copy whose
     `launchOptions` lists only one model, `opus`; a second test plugin that declares agent `bad`
     with a `launchOptions` whose effort choices are not a list
   - **When** the plugins load and `quirky agents options claude` and `quirky agents list --all` run
   - **Then** claude's catalog lists only Opus. `bad` is missing from the catalog and appears in
     `problems` with an error naming `launchOptions`. Disabling the override plugin brings back the
     built-in four models.

### Resolving a selection

6. **SC-6: a model and effort become the agent's flags, its structured options and a snapshot** (CLI)
   - **Given** claude's configured arguments are the Yolo default
   - **When** the agent runs `quirky agents resolve claude --model opus --effort high --json`
   - **Then** the result's added argv is `--model opus --effort high`; the full arguments are
     `--dangerously-skip-permissions --model opus --effort high`; the structured options are
     `{model: "opus", effort: "high"}`; the snapshot is
     `{agent: "claude", options: {model: {value: "opus", source: "explicit"}, effort: {value: "high", source: "explicit"}}, args: {value: "--dangerously-skip-permissions", source: "inherited"}}`;
     the summary is `Claude · Opus · Effort: high`. Nothing is launched.
   - **Data after:** **argv** ✓ `--model opus --effort high`; **structured** ✓ `{model, effort}`; **sessions** ✓ none created

7. **SC-7: Codex's effort goes through `-c`** (CLI)
   - **When** the agent runs `quirky agents resolve codex --model gpt-5.5 --effort low --json`
   - **Then** the added argv is `-m gpt-5.5 -c model_reasoning_effort=low`, and the summary is
     `Codex · GPT-5.5 · Reasoning effort: low`

8. **SC-8: no pick adds nothing** (API)
   - **Given** claude's configured arguments are empty (Manual)
   - **When** `resolveLaunch {agent: "claude"}` is called
   - **Then** the added argv is empty, the structured options are empty and the snapshot is null.
     With the Yolo default instead, the snapshot holds only
     `args: {value: "--dangerously-skip-permissions", source: "inherited"}`. Catalog defaults (Claude's
     High, Codex's Medium) are never added for an option left unset.

9. **SC-9: invalid picks are refused with Orca's messages** (CLI)
   - **When** each of these runs
   - **Then** it exits non-zero, prints the message, and launches nothing:

     | Command | Message |
     |---|---|
     | `quirky agents resolve claude --effort low` | `--effort requires --model` (the API says `effort requires a model`) |
     | `quirky agents resolve claude --model haiku --effort low` | `Agent claude model haiku does not support effort low.` |
     | `quirky agents resolve codex --model gpt-5.5 --effort ultra` | `Agent codex model gpt-5.5 does not support effort ultra.` |
     | `quirky agents resolve aider --model gpt-4o` | `Agent aider does not support launch-time model selection.` |
     | `quirky agents resolve gemini --model gemini-9` | `Agent gemini does not support model gemini-9.` |
     | `quirky agents resolve claude --model opus --option speed=fast` | `Agent claude model opus does not support speed fast.` |
     | `quirky agents resolve cursor --model claude-opus-4-8 --option thinking=maybe` | `Agent cursor model claude-opus-4-8 does not support thinking maybe.` |

     The CLI also refuses `--effort` together with `--option effort=…`, and the same `--option` key
     twice, before calling the daemon. An option the launch can't carry is refused: a structured-only
     option on a terminal launch, or an option with no structured key on a structured launch, gets
     `Agent <id> option <option> can't be applied to a <terminal|structured> launch.`

     At the API, a model longer than 128 characters, more than 16 options, an option ID longer than 64
     characters, or an option named `__proto__`, `constructor`, `prototype` or `model` is refused
     as invalid parameters.

10. **SC-10: unlisted models pass where the agent allows them** (API)
    - **When** `resolveLaunch` is called with claude `claude-opus-5-5` + effort `max`, codex
      `gpt-7` + effort `ultra`, and omp `anthropic/sonnet`
    - **Then** they resolve to `--model claude-opus-5-5 --effort max`, `-m gpt-7 -c model_reasoning_effort=ultra`
      and `--model anthropic/sonnet`. omp with any option is refused (it has no options), and gemini
      with an unlisted model is refused (SC-9).

11. **SC-11: Cursor folds its options into the model name** (unit and API)
    - **When** `resolveLaunch` is called for cursor with `claude-opus-4-8` + thinking `true` + effort
      `high`, with `gpt-5.3-codex` + effort `low` + fastMode `true`, and with `auto`
    - **Then** the added argv is `--model claude-opus-4-8-thinking-high`,
      `--model gpt-5.3-codex-low-fast` and `--model auto`. `auto` with any option is refused.

### Precedence

12. **SC-12: a pick replaces the configured model flag instead of repeating it** (API; Orca defect, PR #25382)
    - **Given** codex's configured arguments are `--model gpt-5.4 --search`
    - **When** `resolveLaunch {agent: "codex", model: "gpt-5.5"}` is called
    - **Then** the full arguments are `--search -m gpt-5.5`: one model flag. The same holds for
      `-m`, `--model=`, and `-c model=` spellings in the configured arguments, and for Claude's
      `--effort` against an effort pick.
    - **Data before:** **codex arguments**: `--model gpt-5.4 --search`
    - **Data after:** **argv**: ✓ `--search -m gpt-5.5`; ✗ `gpt-5.4`

13. **SC-13: extra arguments beat a pick, and the result says so** (CLI; Orca defect)
    - **Given** claude's configured arguments are the Yolo default
    - **When** the agent runs
      `quirky agents resolve claude --model opus --effort low --extra-args="--effort high --add-dir docs" --json`
    - **Then** the full arguments are
      `--dangerously-skip-permissions --effort high --add-dir docs --model opus`, with exactly one
      `--effort`, whose value is `high`. The result lists `effort` as set by the extra arguments.
      The snapshot has `model: {value: "opus", source: "explicit"}`,
      `effort: {source: "extra-args"}` (no value) and
      `args: {value: "--dangerously-skip-permissions --effort high --add-dir docs", source: "explicit"}`.
      The summary is `Claude · Opus`. The structured options are `{model: "opus"}`: a shadowed pick
      is left out of them.
    - **Data after:** **argv** ✓ one `--effort high`; ✗ `--effort low`; **snapshot** ✓ effort from extras

14. **SC-14: extra arguments replace the configured model flag** (API)
    - **Given** claude's configured arguments are `--model sonnet --dangerously-skip-permissions`
    - **When** `resolveLaunch {agent: "claude", extraArgs: "--model opus --add-dir docs"}` is called
    - **Then** the full arguments are `--dangerously-skip-permissions --model opus --add-dir docs`
      and the snapshot's args source is `explicit`

15. **SC-15: the snapshot always agrees with the command** (unit; Orca defect, the doc's open question)
    - **Given** every combination of: a model pick or none; an effort pick or none; configured
      arguments with a model flag, an effort flag, both or neither; extras with a model, an effort,
      both or neither
    - **When** each is resolved for claude and for codex
    - **Then** for each option the snapshot marks `explicit` exactly when that pick's flag is in the
      argv with the picked value, and `extra-args` exactly when the pick was made but not emitted
      because the extras set that option's flag or the model flag (extras that set the model shadow
      the whole pick, since options belong to the picked model). The argv never holds two model flags
      or two effort flags.

16. **SC-16: a command override that sets the model fails the launch** (API)
    - **Given** claude's command override is `claude --model sonnet`
    - **When** `resolveLaunch {agent: "claude", model: "opus"}` is called, and again with extras
      `--model opus`
    - **Then** both are refused with "Agent command override conflicts with the requested launch
      preferences. Remove model or effort flags from the command override." Without a pick or
      extras the override launches as before.

### Extra arguments

17. **SC-17: extra arguments are checked against the allowlist** (CLI)
    - **When** `quirky agents resolve <agent> --extra-args=<text>` runs with each of these
    - **Then** it is refused with the message shown:

      | Agent | Extra arguments | Message |
      |---|---|---|
      | claude | `--verbose` | `"--verbose" isn't allowed in extra arguments for Claude. Allowed: --model, --effort, --add-dir.` |
      | claude | `docs` | `"docs" isn't an option. Extra arguments for Claude accept only: --model, --effort, --add-dir.` |
      | claude | `--add-dir docs -- x` | `"--" isn't allowed in extra arguments.` |
      | claude | `--effort` | `"--effort" needs a value.` |
      | claude | `--model opus --model sonnet` | `Extra arguments set the model more than once.` |
      | claude | `--add-dir $(pwd)` | `$(pwd) uses shell syntax that extra arguments don't allow.` |
      | claude | 4097 bytes | `Extra arguments must be 4 KB or less.` |
      | claude | text with a newline | `Extra arguments cannot contain control characters or line breaks.` |
      | codex | `-c sandbox=none` | `"-c sandbox=none" isn't allowed. Codex extra arguments accept only "-c model_reasoning_effort=<level>".` |
      | aider | `--model x` | `Extra arguments aren't supported for this agent yet.` |

      `--add-dir docs --add-dir src` is accepted (repeatable), and empty or blank text means no
      extras.

### Launching a session

18. **SC-18: a session starts with the picked model and effort, and shows what it used** (CLI)
    - **Given** the e2e harness with a fake `claude`
    - **When** the agent runs `quirky session new --agent claude --model opus --effort high --prompt hi`
    - **Then** the fake claude's argv contains `--model opus --effort high` once each, before the
      prompt. `quirky session get <id> --json` shows `launchSettings` equal to SC-6's snapshot, and
      `quirky session get <id>` prints `Launch: Claude · Opus · Effort: high`.
    - **Data after:** **Session 1**: ✓ argv `… --model opus --effort high hi`; ✓ `launchSettings` stored

19. **SC-19: extra arguments reach a session** (CLI)
    - **When** the agent runs `quirky session new --agent claude --extra-args="--add-dir docs"`
    - **Then** the fake claude's argv contains `--add-dir docs`, and the session's snapshot has
      `args.source` `explicit` and no options

20. **SC-20: an invalid pick creates no session** (CLI)
    - **When** the agent runs `quirky session new --agent claude --model haiku --effort low`,
      and `quirky session new --agent shell --model opus`
    - **Then** both exit non-zero (the first with SC-9's message, the second with "Agent shell does
      not support launch-time model selection."), and `quirky session list` shows no new session and
      no process was spawned

21. **SC-21: resume and fork keep the session's original model and effort** (CLI; the doc's reused-session rule)
    - **Given** a codex session created with `--model gpt-5.5 --effort low` and provider session
      `abc`; afterwards codex's configured arguments were changed to `--model gpt-5.4`
    - **When** the agent runs `quirky session resume <session>`
    - **Then** the new session runs `codex … -m gpt-5.5 -c model_reasoning_effort=low … resume abc`
      with no `gpt-5.4`, and its `launchSettings` equal the old session's. `quirky session resume
      <session> --fork` does the same with `fork abc`.
    - **Data before:** **Session 1**: codex, gpt-5.5, low, provider `abc`; **codex arguments now**: `--model gpt-5.4`
    - **Data after:** **Session 2**: ✓ `-m gpt-5.5 -c model_reasoning_effort=low`; ✗ `gpt-5.4`; ✓ same `launchSettings`

22. **SC-22: a session with no pick records only its inherited arguments** (CLI)
    - **When** `quirky session new --agent claude` runs with claude on Manual, and again on Yolo
    - **Then** on Manual the session's `launchSettings` is null and `quirky session get` prints no
      `Launch:` line. On Yolo it is `{agent: "claude", options: {}, args: {value:
      "--dangerously-skip-permissions", source: "inherited"}, summary: "Claude"}`, and the command is
      what it was before this item. Sessions recorded before this item have no `launchSettings` and still list and resume.

### Structured sessions

23. **SC-23: a structured session gets the same pick as SDK options** (API, with the runner's fake query)
    - **When** `quirky session new --background --agent claude --model opus --effort high --prompt hi` runs
    - **Then** the runner starts the Agent SDK query with `options.model` `opus` and
      `options.effort` `high`, and the structured session's `launchSettings` records both as
      `explicit` with the summary `Claude · Opus · Effort: high`; with no pick, neither option is set
      and `launchSettings` is null

24. **SC-24: structured sessions refuse extras and agents without structured keys** (API)
    - **When** `quirky.structured/create` is called with `extraArgs`, and with an agent whose catalog
      has no structured keys
    - **Then** the first is refused with "Extra arguments can't be applied to a structured session."
      and the second with "Agent X does not support launch-time model selection."; no session is
      registered

### Orca defects this item must not have

| Orca defect (from the doc and research) | Scenario |
|---|---|
| The run snapshot can say a pick was set by raw arguments while the launch used the pick (open question) | SC-15, SC-13 |
| A structured Effort pick plus a raw `--effort` was accepted with no word on which applies | SC-13 |
| Effort without a model is silently ignored in saved data | SC-9 |
| A pick plus a configured model flag put two model flags on the command (Orca PR #25382) | SC-12, SC-15 |

## Scope & non-goals

In scope: the catalog as data, listing it, validating and resolving selections and extras, the
snapshot, and their use by session create, resume, fork and structured create
([D4](../../../loop/decisions/m1-launch-settings.md)).

Not in this item:

- The automation editor's Model, Effort and Extra agent arguments fields, the reuse-session note,
  the detail page and run history (where Orca hides model and effort and shows the run row late),
  and `quirky automations create|edit --model --effort --extra-agent-args` with `inherit`:
  m5-automations.
- Source Control AI action recipes: rows, per-project overrides, dialogs, "Set by CLI arguments",
  "Set by action recipes", and the text-generation flag rules: m2-source-control-notes-ai.
- Model discovery, retirement of saved models, and the "Saved model X is not in the current model
  list." note ([D17](../../../loop/decisions/m1-launch-settings.md)).
- The `agent-launch-overrides.v1` capability and paired hosts ([D18](../../../loop/decisions/m1-launch-settings.md)).
- Fork-loops' launch overrides: m5-loops.
- Any UI ([D20](../../../loop/decisions/m1-launch-settings.md)); there are no UI or native-only
  scenarios.
- Windows quoting for picks and extras ([D23](../../../loop/decisions/m1-launch-settings.md), deferred: platform).

## Decisions Locked

- **data-mapping:** `launchOptions` on each agent contribution (D5); Orca's ten catalogs (D6); no
  Fast mode (D7); flags go before the configured `--` (D15); a malformed block skips the agent (D25).
- **input-format:** `{model?, options?}` with Orca's bounds (D8); extras follow Orca's allowlist (D14).
- **conflict-resolution:** extras > picks > configured arguments, beaten flags removed (D11); a
  conflicting command override fails (D13).
- **error-handling:** refuse with Orca's messages (D9); unlisted models pass where the agent allows
  them (D10).
- **output-format:** one resolution yields argv, structured options and the snapshot (D12); the
  session stores the snapshot and resume replays the resolved arguments (D16); `options` and
  `resolveLaunch` methods (D21).
- **flag-design:** `--model`, `--effort`, `--option key=value`, `--extra-args=` (D22).

## Industry Insights

- Duplicate model or effort flags can stop an agent CLI from starting; conflicts must be resolved
  before building argv, with explicit user flags replacing generated ones
  ([Orca PR #25382](https://github.com/stablyai/orca/pull/25382),
  [agent-layer PR #248](https://github.com/conn-castle/agent-layer/pull/248)).
- Sending an effort level a model doesn't list fails or drifts
  ([codex #46915](https://github.com/openai/codex/issues/46915),
  [codex #55249](https://github.com/openai/codex/issues/55249),
  [claude-code #30760](https://github.com/anthropics/claude-code/issues/30760)), so levels are
  checked per model before launch.
- Claude's effort levels and defaults vary per model, and unsupported levels are clamped by the CLI
  ([Claude Code model config](https://code.claude.com/docs/en/model-config)); Quirky refuses instead,
  as Orca's CLI does, so a pick never silently means something else.
- Seeded model lists go stale; tools that hardcode IDs see 404s or silent remaps
  ([claude issue 67299](https://claudeissues.com/issue/67299-explicit-model-with-deprecated-opus-ids-is-silently-remapped-to-the-current-defa),
  [LiteLLM model sync](https://docs.litellm.ai/docs/proxy/sync_models_github)), which is why
  unlisted IDs pass for agents that allow them.
- Declarative manifests stay reviewable and inspectable without running code, with named escape
  hatches for logic they can't express
  ([devcontainer features](https://github.com/devcontainers/spec/blob/main/docs/specs/devcontainer-features.md),
  [mise](https://mise.jdx.dev/asdf-legacy-plugins.html)).
- No extensible app documents merge rules for several plugins adding models to one provider
  ([VS Code LM provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider),
  [Backstage overrides](https://backstage.io/docs/frontend-system/architecture/extension-overrides/)),
  so the catalog stays with the agent and is replaced whole.

## Deferred Ideas

- Model discovery probes (`claude` model list, `grok models`, `cursor-agent models`,
  `omp models --json`) and retirement of saved picks: for the first item that saves picks.
- A model picker in the new-session menu ([D20](../../../loop/decisions/m1-launch-settings.md)).
- Claude Fast mode, once Quirky can send mid-session commands ([D7](../../../loop/decisions/m1-launch-settings.md)).
- `[tech-spec]` The exact data schema of `launchOptions`, the shell-syntax character set for extras,
  and how the CLI maps `--effort` and `--option` onto `options`.

## Glossary

- **Pick / selection:** a `{model, options}` value naming a model and option values for one agent.
- **Configured arguments:** the agent's saved arguments in `quirky.agents`, else its Yolo default.
- **Extra arguments (extras):** raw arguments passed for one launch, limited to the agent's allowlist.
- **Resolution:** turning an agent, a selection and extras into argv, structured options and a
  snapshot.
- **Snapshot (`launchSettings`):** what a launch applied and where each value came from: `explicit`
  (a pick), `extra-args` (the extras set it), `inherited` (the agent's configured arguments).
- **Structured options:** the same pick expressed as a structured runner's options (`model`,
  `effort` for the Agent SDK).
- **Unlisted model:** a model ID not in the agent's catalog.
