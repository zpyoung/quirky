# Launch settings: tech spec

**Status:** Draft for build. Logic spec: [logic.md](logic.md). Decisions:
[m1-launch-settings.md](../../../loop/decisions/m1-launch-settings.md).

All paths are relative to the repo root `/Users/zpyoung/orca/workspaces/quirky/build-roadmap`.
Orca sources to port values and rules from are under `/Users/zpyoung/PycharmProjects/orca/src/shared/`
(abbreviated `ORCA/` below).

## Architecture

Everything lives in the built-in plugin `quirky.agents`, with small additions to `quirky.session`,
`quirky.structured` and the protocol's `Session` type ([logic: Data flow](logic.md#data-flow)).

- **Catalog data** sits in `plugins/quirky.agents/quirky-plugin.json`, as a `launchOptions` field on
  ten `agent` contributions. `core/entry.ts` validates it through a new `core/launch-options.ts`
  and stores it on `AgentEntry.launchOptions`.
- **Pure rules** go in new `core/` modules, none importing the plugin context:
  - `core/arg-occurrence.ts` finds and removes an option's occurrences in a token list (port of
    `ORCA/command-option-occurrence.ts` and `removeAgentArgOption` in
    `ORCA/agent-session-option-agent-args.ts`).
  - `core/selection.ts` validates a `{model, options}` selection against a catalog.
  - `core/extras.ts` validates extra arguments against the allowlist (port of
    `ORCA/automation-extra-agent-args.ts` `parseExtraAgentArgs`).
  - `core/resolve.ts` turns configured arguments, extras and a selection into argv, structured
    options, the snapshot and the summary in one pass.
  - `core/compose.ts` holds the named model-composition rules (`cursor`).
- `core/plan.ts` `buildLaunchPlan` calls `resolve` when a selection or extras are given.
- `src/service.ts` adds two read-only methods (`options`, `resolveLaunch`) and passes the new
  parameters through `plan` and `prepareLaunch`. `cli.ts` adds `options` and `resolve` and the
  launch flags on `plan`.
- `quirky.session` passes the parameters to `prepareLaunch`, stores the snapshot in a new column,
  copies it on resume and fork, and shows it on a new `quirky session get` command.
- `quirky.structured` resolves `structured: true` through `quirky.agents/resolveLaunch` and passes
  the result to the Claude runner, which puts it on the Agent SDK `Options`.

Key technologies: Bun, TypeScript, `bun:sqlite` stores through `PluginStore`, the
`@anthropic-ai/claude-agent-sdk` `query()` `Options.model` / `Options.effort`
(`plugins/quirky.structured/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`).

## Code references

| File | Change |
|---|---|
| `plugins/quirky.agents/src/core/types.ts` | add `LaunchCatalog` and its parts (SCHEMA below); `AgentEntry.launchOptions: LaunchCatalog \| null`; `LaunchSettings`, `Selection`, `Resolution`; `LaunchPlan.launchSettings: LaunchSettings \| null` |
| `plugins/quirky.agents/src/core/entry.ts` | add `'launchOptions'` to `KNOWN_FIELDS`; in `parse`, `launchOptions: data.launchOptions === undefined ? null : parseLaunchOptions(data.launchOptions)`; problems throw `Invalid` with messages starting `launchOptions` |
| `plugins/quirky.agents/src/core/launch-options.ts` | new: `parseLaunchOptions(value: unknown): LaunchCatalog` (throws `Error` with a sentence; `entry.ts` rewraps as `Invalid`) |
| `plugins/quirky.agents/src/core/arg-occurrence.ts` | new: `findOptionOccurrence`, `removeOption`, `hasOption` |
| `plugins/quirky.agents/src/core/selection.ts` | new: `validateSelection(entry, raw): ValidSelection` throwing `SelectionError` |
| `plugins/quirky.agents/src/core/extras.ts` | new: `parseExtraArgs(entry, text): ParsedExtras` throwing `SelectionError`; `extrasSummary(entry)` |
| `plugins/quirky.agents/src/core/compose.ts` | new: `COMPOSE_RULES: Record<'cursor', (model, values) => string>` (port of `composeModelValue` in `ORCA/agent-session-option-catalog-gemini-cursor.ts`) |
| `plugins/quirky.agents/src/core/resolve.ts` | new: `resolveLaunch(input): Resolution` and `formatSummary(entry, settings)` |
| `plugins/quirky.agents/src/core/plan.ts` | `LaunchPlanInput` gains `selection?: Selection`, `extraArgs?: string`; `buildLaunchPlan` resolves when either is present (see contract) |
| `plugins/quirky.agents/src/service.ts` | `AgentsService.options`, `AgentsService.resolveLaunch`; `plan` and `prepareLaunch` read `model`, `options`, `extraArgs`; map `SelectionError` to `invalid-params` in `guard` |
| `plugins/quirky.agents/main.ts` | provide `method:quirky.agents/options` and `method:quirky.agents/resolveLaunch` the way the existing twelve are provided |
| `plugins/quirky.agents/quirky-plugin.json` | `launchOptions` on claude, codex, codebuddy, gemini, cursor, grok, muse, antigravity, omp, opencode; method schemas for `options`, `resolveLaunch`; new params on `plan`, `prepareLaunch` and `launchSettings` on their results; `cli-command` `options`, `resolve`; flags `model`, `effort`, `option`, `extra-args` on `plan` |
| `plugins/quirky.agents/cli.ts` | handlers `options`, `resolve`; `plan` reads the new flags; a shared `selectionParams(flags, ctx)` |
| `packages/protocol/src/model.ts` | `LaunchSettings` type; `Session.launchSettings?: LaunchSettings \| null` |
| `plugins/quirky.session/src/records.ts` | third migration `ALTER TABLE sessions ADD COLUMN launch_settings TEXT`; read and write it in `toSession`, `insert`, `update` beside `launch` |
| `plugins/quirky.session/src/sessions.ts` | `create`: refuse `model`/`options`/`extraArgs` for `shell`; pass them to `quirky.agents/prepareLaunch`; `LaunchSpec` gains `launchSettings`; `start` stores it with `launch`. `resume`: the new record copies `old.launchSettings ?? null` |
| `plugins/quirky.session/quirky-plugin.json` | `create` params `model`, `options`, `extraArgs`; `launchSettings` in every `Session` result schema next to `launch`; `new` flags `model`, `effort`, `option`, `extra-args`; new `cli-command` `get` (`quirky.session/get`) |
| `plugins/quirky.session/cli.ts` | `new` passes the flags to either create method; new `get`; both print a `launch` row when `launchSettings` is set |
| `plugins/quirky.structured/quirky-plugin.json` | `create` params `model`, `options`, `extraArgs`; add `quirky.agents` to `dependencies` |
| `plugins/quirky.structured/main.ts` | `create`: refuse `extraArgs`; when `model` or `options` is given, call `quirky.agents/resolveLaunch` with `structured: true` before `quirky.session/register`; pass `resolution.structured` to `runner.start` |
| `plugins/quirky.structured/runner.ts` | `StructuredRunner.start(session, prompt, options?: StructuredLaunchOptions)` |
| `plugins/quirky.structured/claude-runner.ts` | spread `model` and `effort` from the options into the `query({options})` object built in `start` (around line 168) |

## Data models / schemas

`SCHEMA:` the `launchOptions` manifest block (one per agent; all names are literal):

```
launchOptions: {
  model: {
    flag: string[]                 // template; exactly one item contains "{value}", e.g. ["--model","{value}"]
    conflicts: Conflict[]          // what already sets the model, e.g. [{flags:["-m","--model"]},{flags:["-c","--config"],valuePrefix:"model="}]
    structured?: string            // key in structured options, e.g. "model"
  }
  options?: OptionDecl[]           // every option any model offers; IDs unique, never "model" or a reserved key
  models?: ModelDecl[]             // listed models, in display order; IDs unique
  unlisted?: "accept" | "refuse"   // default: "accept" when models is empty, else "refuse"
  unlistedOptions?: OptionUse[]    // options an unlisted model gets; only with unlisted "accept"
  composeModel?: "cursor"          // options marked composed fold into the model value through this rule
  valueFlags?: string[]            // flags whose next token is always a value, even when it starts with "-" (ORCA VALUE_OPTIONS)
  extraArgs?: {
    allowed: { kind: "model" | "effort" | "repeatable", flags: string[], valuePrefix?: string }[]
    placeholder: string
  }
}
Conflict  = { flags: string[], valuePrefix?: string }
OptionDecl = {
  id: string, label: string, type: "select" | "boolean",
  choices?: { value: string, label: string }[]    // required, non-empty, for select; absent for boolean
  flag?: string[]                                  // template with "{value}"; absent when composed or structured-only
  conflicts?: Conflict[]
  composed?: true                                  // requires composeModel
  structured?: string
}
ModelDecl = { id: string, label: string, description?: string, options: OptionUse[] }
OptionUse = { id: string, choices?: string[] }     // choices: a subset of the declared values, in declared order; absent = all
```

Every option has at least one of `flag`, `composed`, `structured` (logic D7). The ten blocks carry
the values in [logic: The ten catalogs](logic.md#conceptual-model), copied from:

| Agent | Source | Notes |
|---|---|---|
| claude | `ORCA/agent-session-option-catalog-claude-codex.ts` `CLAUDE_SESSION_OPTION_CATALOG` | effort `--effort {value}`, structured `effort`; model structured `model`; `unlistedOptions: [{id:"effort"}]`; Haiku `options: []`; `valueFlags` = ORCA `VALUE_OPTIONS.claude`; no Fast mode |
| codex | same file, `CODEX_SESSION_OPTION_CATALOG` | model flag `-m {value}`, conflicts `-m/--model` and `-c/--config` prefix `model=`; effort `["-c","model_reasoning_effort={value}"]`, conflicts `--reasoning-effort` and `-c/--config` prefix `model_reasoning_effort=`; per-model `choices` up to the ceiling; unlisted get all seven |
| codebuddy | `ORCA/agent-session-option-catalog-codebuddy.ts` | |
| gemini | `ORCA/agent-session-option-catalog-gemini-cursor.ts` | no options, `unlisted: "refuse"` |
| cursor | same file | `composeModel: "cursor"`, options `effort`, `fastMode`, `thinking` marked `composed`; `valueFlags` = ORCA `VALUE_OPTIONS.cursor`; `unlisted: "refuse"` |
| grok | `ORCA/agent-session-option-catalog-grok.ts` | effort `--reasoning-effort {value}`, conflicts `--effort`, `--reasoning-effort` |
| muse | `ORCA/agent-session-option-catalog-muse.ts` | `models: []` |
| antigravity | `ORCA/agent-session-option-catalog-antigravity.ts` | `models: []` |
| omp | `ORCA/agent-session-option-catalog-omp.ts` | `models: []`, no options |
| opencode | `ORCA/agent-session-option-catalog-opencode.ts` | `models: []`, model flag `--model {value}` conflicts `-m/--model` |

`extraArgs.allowed` is `EXTRA_AGENT_ARG_OPTIONS` in `ORCA/automation-extra-agent-args.ts` (claude,
codex, codebuddy, cursor, grok, omp); `placeholder` is what Orca's `getExtraAgentArgsPlaceholder`
produces for that agent.

`SCHEMA:` method `quirky.agents/options`:

```
params: { agent: string }
result: {
  agent: string, label: string, supported: boolean,
  models: { id, label, description: string | null, options: OptionInfo[] }[],
  unlisted: "accept" | "refuse", unlistedOptions: OptionInfo[],
  structured: boolean,                               // true when the model has a structured key
  extraArgs: { supported: boolean, allowed: string | null, placeholder: string | null, message: string | null }
}
OptionInfo = { id, label, type: "select" | "boolean", choices: { value, label }[] | null }   // choices narrowed to the model's subset
```

`allowed` is Orca's `allowedOptionList` text (`--model, --effort, --add-dir`); `message` is
"Extra arguments aren't supported for this agent yet." when unsupported. `supported: false` agents
return empty lists and `unlisted: "refuse"`.

`SCHEMA:` method `quirky.agents/resolveLaunch` (readOnly):

```
params: { agent: string, model?: string (1..128), options?: object (<=16 props, values string|boolean),
          extraArgs?: string, structured?: boolean }
result: {
  added: string[],            // the pick's flags as emitted (empty when shadowed or no pick)
  args: string,               // full arguments the launch would use, shell-quoted (joinCommand); "" for structured
  structured: Record<string, string | boolean>,   // {} when no pick
  shadowed: string[],         // option IDs (incl. "model") picked but set by the extra arguments
  launchSettings: LaunchSettings | null
}
```

`SCHEMA:` `LaunchSettings` (protocol `packages/protocol/src/model.ts`, also returned by
`prepareLaunch`/`plan` as `launchSettings`):

```
LaunchSettings = {
  agent: string
  options: Record<string, { value?: string | boolean, source: "explicit" | "extra-args" }>   // "model" is a key
  args?: { value: string, source: "explicit" | "inherited" }
  summary: string             // "Claude · Opus · Effort: high"; computed at launch so history never changes
}
```

`args.value` is the configured arguments after extras replaced flags, plus the extras, without the
pick flags, joined with `joinCommand`. It is present only when non-empty. `source` is `explicit` when
extras were given, else `inherited`. The snapshot is `null` when `options` is empty and `args` is
absent.

`summary`: the agent label, then the model's label (the ID for an unlisted model) when the model is
`explicit`, then for each other `explicit` option in declared order `<label>: <value>` (a boolean
`true` shows the label alone, `false` shows `<label>: Off`).

`SCHEMA:` new params: `quirky.agents/plan` and `prepareLaunch` take `model`, `options`, `extraArgs`
as in `resolveLaunch`; `quirky.session/create` takes the same three; `quirky.structured/create`
takes the same three (`extraArgs` only to refuse it with the logic spec's message).

`CONFIG:` store column `sessions.launch_settings TEXT` (JSON or NULL), added by a third migration in
`sessionMigrations` (`plugins/quirky.session/src/records.ts`, after the migration that added
`launch` around line 112).

## Contracts & interfaces

`CONTRACT:` `parseLaunchOptions(value: unknown): LaunchCatalog` — throws on: a non-object; a
template without exactly one `{value}` item; empty `flags`; duplicate option or model IDs; an option
ID that is `model`, `__proto__`, `constructor` or `prototype`; a select without choices; a model
`OptionUse` naming an undeclared option or a choice outside the declared values; `composed` without
`composeModel`; an option with none of `flag`, `composed`, `structured`; `unlistedOptions` with
`unlisted: "refuse"`; unknown keys at any level. The thrown sentence starts with `launchOptions`.
An invalid block makes the agent invalid (logic D25), reported through the existing `problems`.

`CONTRACT:` `findOptionOccurrence(tokens, aliases, stopAtTerminator, valueFlags) -> {index, consumed, value?} | null`
and `removeOption(tokens, conflict: Conflict, valueFlags) -> string[]` behave as the Orca functions
they port: `--flag value`, `--flag=value`, `-fvalue` for single-dash aliases, a value only consumed
when it doesn't start with `-`, scanning stops at the first `--` that isn't a flag's value, and a
`valuePrefix` conflict removes only occurrences whose value starts with it. `hasOption` is
`removeOption(...).length < tokens.length`.

`CONTRACT:` `validateSelection(entry, raw: {model?: unknown, options?: unknown}) -> ValidSelection`
where `ValidSelection = {model: string, values: Record<string, string|boolean>, listed: boolean} | null`
(null: no model and no options). Errors (`SelectionError`, messages exact):

- options without a model: `<first option id> requires a model`
- `entry.launchOptions === null`: `Agent <id> does not support launch-time model selection.`
- unlisted model with `unlisted: "refuse"`: `Agent <id> does not support model <model>.`
- an option ID the model doesn't offer, a value outside the model's choices, or a type mismatch:
  `Agent <id> model <model> does not support <option> <value>.` (booleans print `true`/`false`)
- model empty after trim, longer than 128, more than 16 options, an ID longer than 64 or reserved:
  rejected at the schema where possible, and here otherwise, as `invalid launch selection: <why>`

The model is trimmed. Options are copied into a null-prototype object.

`CONTRACT:` `parseExtraArgs(entry, text) -> {tokens: string[], kinds: Set<'model'|'effort'|'repeatable'>} | null`
(null for blank text). Checks and messages are `parseExtraAgentArgs`'s, in its order, with the
agent's `label` in place of Orca's display name. "Shell syntax": scanning the raw text outside
single quotes, `$` or a backtick; outside any quotes, any of `; & | < > ( ) * ? [ ] { } #`, or `~`
at the start of a word. The message quotes the raw word that contains it
(`$(pwd) uses shell syntax that extra arguments don't allow.`).

`CONTRACT:` `resolveLaunch(input) -> Resolution`, with
`input = {entry, commandTokens: string[], configuredArgs: string[], selection: ValidSelection, extras: ParsedExtras | null, structured: boolean}`.
Pure. Steps, in order (logic D11, D15):

1. If `structured`: extras given → `SelectionError("Extra arguments can't be applied to a structured session.")`;
   a selection on an agent whose model has no `structured` key →
   `Agent <id> does not support launch-time model selection.`; return `structured` built from the
   model's and each option's `structured` keys, `added: []`, `args: ""`, and a snapshot with every
   pick `explicit`.
2. `args` = `configuredArgs`. For each extras kind present: `model` removes every model conflict;
   `effort` removes every conflict of the option with ID `effort`. Then the extras tokens are inserted
   before `args`' terminator (`--` found by `findOptionOccurrence` with `valueFlags`), or appended.
3. With a selection: the model is shadowed when extras have kind `model`; then every picked option is
   shadowed too. Otherwise an option is shadowed when the extras contain any of its conflicts. A
   non-shadowed model removes its conflicts from `args`; a non-shadowed flagged option removes its
   conflicts from `args`. A composed option is never shadowed on its own.
4. `added` = model flag with the value (composed through `COMPOSE_RULES[composeModel]` when the
   catalog has one and the model is listed), then each non-shadowed, non-composed option's flag, in
   declared option order. `added` goes before `args`' terminator, after the extras.
5. If `added` or the extras would set a model or effort that `commandTokens` already set (any model
   conflict, or any conflict of option `effort`, found in `commandTokens` past index 0) →
   `SelectionError("Agent command override conflicts with the requested launch preferences. Remove model or effort flags from the command override.")`.
   Check only when `entry`'s command is overridden (the caller passes `commandTokens: []` otherwise).
6. Snapshot as in the schema. Invariant (SC-15): an option is `explicit` iff its value is in `added`
   (directly or composed), `extra-args` iff it was picked and shadowed; `added` and `args` together
   never contain two occurrences of a model or effort conflict.

`CONTRACT:` `buildLaunchPlan` with neither `selection` nor `extraArgs` is unchanged byte for byte
(every existing `plan.test.ts` case still passes, `record.args` is still the raw configured text).
With either, the user args are the resolution's tokens and `record.args = joinCommand(tokens)`, so
`buildResumePlan` replays them; `launchSettings` is set. Hook args and the prompt keep their positions.

`CONTRACT:` `AgentsService.resolveLaunch(params)` uses the agent's saved config exactly as
`prepareLaunch` would (`config.args ?? entry.yolo ?? ''`, `stripArgs` applied), passes the command
tokens only when `config.command` is non-blank, launches nothing, writes no trust record, and emits
no event. Unknown agent → `not-found`; every `SelectionError` and `PlanError` → `invalid-params` with
the message unchanged. A disabled agent still resolves (it's a preview); `prepareLaunch` keeps
refusing it.

`CONTRACT:` `SessionService.create`: for `agent === 'shell'` with any of the three params →
`invalid-params` "Agent shell does not support launch-time model selection." before any record is
inserted. Otherwise the params go to `prepareLaunch`; its failure already deletes the record through
`start` (sessions.ts `start` catch block), so no session survives and nothing is spawned.
`launchSettings` is stored in the same `records.update` as `launch`.

`CONTRACT:` `quirky.structured/create`: `extraArgs` present → `invalid-params` with the logic
message, before `quirky.session/register`. Resolution failure → `invalid-params`, nothing
registered. `runner.start(session, prompt, structured)` where `structured` may be `{}`; the Claude
runner sets `options.model`/`options.effort` only for keys present.

## DO-NOT-CHANGE fences

- `plugins/quirky.agents/src/core/plan.ts` `buildResumePlan` and `spliceClaudeResume`: resume
  replays the record (m1-providers D24); this item only changes what the record holds at launch.
- `plugins/quirky.agents/src/core/shell.ts` `tokenize`, `quote`, `joinCommand`: the injection-safety
  contract of m1-providers D12; extras are tokenized with `tokenize`, and the shell-syntax scan is a
  separate pass in `extras.ts`.
- Existing `agent` entries' non-`launchOptions` fields in `quirky-plugin.json`: their values are
  pinned by `test/core/manifest.test.ts` against Orca.
- `plugins/quirky.session/src/records.ts` existing migrations: append a migration, never edit one,
  because installed stores have already run them.
- `plugins/quirky.agents/src/trust.ts`: `resolveLaunch` must not reach it.

## Always / Ask / Never

- **Always:** keep `core/` free of the plugin context; give every new method and CLI command a
  schema; keep messages exactly as the logic spec and this file state; keep option maps
  null-prototype; run tests on temporary `QUIRKY_HOME` and `HOME` through the existing harnesses.
- **Ask (decide and record as a decision):** flag help texts; table layout of `quirky agents
  options`; internal type names.
- **Never:** inject catalog defaults for unset options; let a pick, extras or a catalog template
  produce text that reaches a shell unquoted; touch `~/.claude`, `~/.codex` or `~/.quirky`; change
  `docs/loop/` protected files or `scripts/build-loop/`.

## Cross-cutting

- **Security:** template substitution produces whole argv tokens, which `joinCommand` quotes; a model
  ID or option value can't add a token. Extras pass the allowlist and the shell-syntax scan before
  tokenizing. Reserved keys are refused.
- **Migration:** the new column is nullable; old rows read as `launchSettings: null`. The protocol
  version stays 2 (an optional field, as m1-providers D10).
- **Observability:** none beyond the snapshot; a skipped `launchOptions` block is logged through the
  existing catalog problem log line.
- **Rollback:** a daemon without this item ignores the column.

## Testing strategy

Unit (`bun test`, under `plugins/quirky.agents/test/core/`):

- `launch-options.test.ts`: each parse failure above; a full valid block round-trips.
- `arg-occurrence.test.ts`: the ported Orca cases (`ORCA/agent-session-option-catalog-removers.test.ts`)
  plus `valueFlags` and terminator handling.
- `selection.test.ts`: SC-9 (every row), SC-10, SC-11 refusal of `auto` options, bounds.
- `extras.test.ts`: SC-17 every row, repeatable `--add-dir`, blank text.
- `resolve.test.ts`: SC-6, SC-7, SC-8, SC-11, SC-12 (all four spellings), SC-13, SC-14, SC-16, and
  SC-15 as a generated matrix over claude and codex asserting the invariant in step 6.
- `plan.test.ts`: existing cases unchanged; a selection's flags land before `--` and before hook
  args; `record.args` replays through `buildResumePlan` (SC-21 at unit level).
- `manifest.test.ts`: SC-1–SC-4 data: each of the ten blocks equals Orca's models, labels,
  descriptions, choice lists and allowlists; every other agent has no block.

API and CLI e2e (`plugins/quirky.agents/test/e2e/launch-settings.e2e.test.ts`, `startAgentsE2E`):
SC-1, SC-2, SC-3, SC-4 through `quirky agents options`; SC-5 with two new fixture plugins under
`test/e2e/fixtures/` installed through `plugin.install` (as `catalog.e2e.test.ts` does); SC-6, SC-7,
SC-9, SC-13, SC-17 through `quirky agents resolve`; SC-18–SC-22 through `quirky session new`,
`quirky session get` and `quirky session resume` with fake `claude` and `codex`, asserting the
fake's recorded argv.

Session and structured unit tests: `plugins/quirky.session/test/records.test.ts` (migration, round
trip), `sessions-launch.test.ts` (shell refusal, snapshot stored, resume copies it);
`plugins/quirky.structured/test/claude-runner.test.ts` (SC-23: the fake `query` receives `model` and
`effort`, and neither without a pick), `structured.test.ts` (SC-24 refusals; nothing registered).

Acceptance bar: `bun run test`, `bun test scripts`, `bun run typecheck` pass; every SC-1–SC-24 is
named in a test title.

## Non-goals

Everything in [logic: Scope & non-goals](logic.md#scope--non-goals), plus: no model listing probes,
no mid-session commands, no UI module changes, no change to `quirky.agents/get` or `list` results.
