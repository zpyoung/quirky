# Tech spec: scripting surface

**Status:** Draft for build. Logic spec: [logic.md](logic.md). Tier gate: the user requested a tech spec (Status line), and the work crosses the protocol, daemon and CLI packages.

All paths are relative to the repo root `/Users/zpyoung/orca/workspaces/quirky/build-roadmap`.

## Architecture

Three packages change. `packages/ui` and `apps/desktop` don't.

| Package | What it gains |
|---|---|
| `packages/protocol` | The schema type, declaration checker, value validator and flag-name helper; the kernel method and event schema tables; the `api.describe` method and catalog types; `CONNECTION_METHODS` |
| `packages/daemon` | `params`/`result`/`data`/`args` fields validated in manifests; params validation in `Dispatcher.dispatch` for kernel and plugin methods; the `api.describe` handler |
| `packages/cli` | Declarative command specs replacing `usage` strings and `FlagDefs`; generated plugin commands; JSON errors; suggestions; `quirky api`, `quirky api call`, `quirky skill show|install|status` |

Data moves like this. A manifest's schemas are checked by `checkSchemaDeclaration` (protocol) from `checkKindEntry` and `checkUiKindEntry`; failures join the existing `errors` list, so the plugin turns `invalid` through the path m0-registry built. At call time, `Dispatcher.dispatch` picks the schema (the kernel table, or the effective contribution's `data.params`) and runs `validateValue` before any plugin code is resolved. `api.describe` assembles the kernel tables and the effective `method`, `event` and `command` contributions. The CLI routes kernel commands as today; when the words name no kernel command it calls `api.describe`, turns each plugin method into a `Command` with `generatedCommands`, and routes again. `buildCatalog` merges kernel and generated commands into the catalog that `quirky api --json` prints and `renderSkill` turns into a skill file. The CLI and daemon share one validator, so their messages match ([logic D13](logic.md#key-decisions)).

## Code references

Create:

- `packages/protocol/src/schema.ts`: `Schema`, `SchemaType`, `checkSchemaDeclaration`, `validateValue`, `flagNameOf`, `RESERVED_FLAG_NAMES`. Export from `packages/protocol/src/index.ts`.
- `packages/protocol/src/kernel-schemas.ts`: `KERNEL_METHOD_SCHEMAS`, `KERNEL_EVENT_SCHEMAS`, `CONNECTION_METHODS`. Export from `index.ts`.
- `packages/protocol/src/catalog.ts`: `ApiDescription`, `ApiMethodEntry`, `ApiEventEntry`, `ApiUiCommandEntry`, `ApiCatalog`, `ApiCommandEntry`, `CATALOG_SCHEMA_VERSION`. Export from `index.ts`.
- `packages/cli/src/command-spec.ts` (distinct from the ask-spec parser at `packages/cli/src/commands/spec.ts`): `PositionalSpec`, `FlagSpec`, `usageOf`, `commandHelp`, `flagDefsOf`.
- `packages/cli/src/generated.ts`: `groupOf(pluginId)`, `generatedCommands(description)`, `paramsFromArgs`.
- `packages/cli/src/catalog.ts`: `buildCatalog`, `resolveCommands` (precedence and shadowing).
- `packages/cli/src/suggest.ts`: `suggestCommands(words, candidates)`.
- `packages/cli/src/format.ts` (or a function in `output.ts`): `formatGeneric(result)`.
- `packages/cli/src/skill.ts`: `renderSkill(catalog)`.
- `packages/cli/src/commands/api.ts`: `api`, `apiCall`.
- `packages/cli/src/commands/skill.ts`: `skillShow`, `skillInstall`, `skillStatus`.

Modify:

- `packages/protocol/src/rpc.ts`: `Methods` gains `'api.describe'` after `'plugin.activate'`; `PROTOCOL_VERSION` stays 1.
- `packages/protocol/src/plugins.ts`: no type change; `ContributionInfo.data` already carries manifest fields (`registry.ts:147-170`).
- `packages/daemon/src/plugins/kinds.ts`: `ALLOWED_FIELDS` (6-11) adds `params`, `result` to `method` and `data` to `event`; `checkKindEntry` (40) calls the schema checks.
- `packages/daemon/src/plugins/ui-kinds.ts`: `ALLOWED_FIELDS.command` (14-22) adds `args`; `checkUiKindEntry` (148) checks it.
- `packages/daemon/src/plugins/dispatch.ts`: `CONNECTION_METHODS` (6) imported from protocol instead of defined here; `dispatch` (34-53) validates params for kernel calls before `runKernel` and for plugin calls between finding `effective` (42) and `resolveImplementation` (44).
- `packages/daemon/src/methods.ts`: `createHandlers` (78) gains `'api.describe'` beside `plugin.activate` (~212); it reads `plugins.contributions({ kind })` and `core.status().daemonVersion`.
- `packages/cli/src/args.ts`: `FlagKind` (9) becomes the `FlagSpec` type set; `parseArgs` (22-63) takes the command name for its unknown-flag message, supports repeatable flags, `number` and `json` kinds, and refuses a following `--` token as a value.
- `packages/cli/src/commands/types.ts`: `Command` (19-26) loses `usage` and `flags: FlagDefs`, gains `positionals`, `flags: Record<string, FlagSpec>`, `methods`, `plugin`, and an optional `rawArgs`.
- Every file in `packages/cli/src/commands/` that defines a `Command`: declarations only; run code unchanged except where named below.
- `packages/cli/src/commands/index.ts`: `COMMANDS` (28-60) adds the new commands; `route` (74-96) takes a command list; `helpText` (103-116) is rebuilt on `commandHelp`/`usageOf`.
- `packages/cli/src/main.ts`: `run` (21-71) adds the catalog fallback, the `--json` pre-scan and JSON errors.
- `packages/cli/src/link.ts`: `DaemonLink` gains `callAny(method, params)` (backed by `QuirkyClient.callAny`, `packages/protocol/src/client.ts:90`); a failure to connect rejects with `DaemonUnavailableError`.
- `packages/cli/test/fixtures/fake-daemon.ts`: `handle()` (297-453) gains `api.describe`, built from seeded contributions; a seeder for plugin methods with schemas.
- Test fixtures listed under [Existing tests and fixtures](#existing-tests-and-fixtures).

## Contracts & interfaces

### Schemas ([Conceptual model](logic.md#conceptual-model), SC-2, logic D4)

`SCHEMA:`
```
type SchemaType = 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object' | 'null'
type Schema = {
  type?: SchemaType
  description?: string
  enum?: (string | number)[]
  items?: Schema
  properties?: Record<string, Schema>
  required?: string[]
  additionalProperties?: boolean
  minimum?: number
  maximum?: number
  default?: unknown
}
```

`CONTRACT:` `checkSchemaDeclaration(value: unknown, at: string, options?: { object?: boolean }): string[]`
- Returns one message per problem, each prefixed with `at` (for example `params.properties.when`); empty when valid. The caller prefixes the contribution label, giving SC-2's texts exactly.
- `options.object` requires `type: 'object'` at the top, with the message `<field> must be an object schema` (the caller words it, see the kind checks below).
- Rejects: a non-object value (`must be a schema object`); any key outside the list above (`unsupported keyword <k>`); an unknown `type` (`unknown type <t>`); `enum` that is not a non-empty array (`enum must be a non-empty list`), or has no `type` among `string`/`integer`/`number` (`enum needs type string, integer or number`), or has a value not of that type (`enum values must be strings` / `integers` / `numbers`); `required` naming a missing property (`required names undeclared property <p>`); `items` on a non-array or `properties`/`required`/`additionalProperties` on a non-object type when `type` is set; `minimum`/`maximum` that aren't finite numbers or sit on a non-numeric type; `minimum > maximum`; a non-boolean `additionalProperties`; a non-string `description`. Recurses into `items` and each property with `at` extended (`.items`, `.properties.<name>`).
- An empty object `{}` is valid and means any value.

`CONTRACT:` `validateValue(schema: Schema, value: unknown, at = 'params'): string | null`
- Returns the first failure message, or null. Depth-first, properties in declaration order, `required` checked before property values, array items by index.
- Messages (SC-3 is the authority): `<at> is required` (missing required property, where `at` is the property path), `<at> must be a string|an integer|a number|a boolean|an array|an object|null`, `<at> must be one of <v1>, <v2>`, `<at> must be at least <n>`, `<at> must be at most <n>`, `<at> is not allowed` (undeclared property when `additionalProperties` isn't `true`). Array items use `<at>[<i>]`.
- No coercion. An integer is a number for which `Number.isInteger` holds. A schema without `type` accepts any type but still applies `enum`, `minimum` and `maximum` to values of a matching kind.
- An object schema with no `properties` and no `additionalProperties` accepts no properties (that is how an omitted `params` refuses `{"verbose": true}`, SC-4).

`CONTRACT:` `flagNameOf(property: string): string` — inserts `-` before each uppercase letter and lowercases it (`worktreeId` → `worktree-id`, `fooBar` → `foo-bar`); other characters unchanged. `RESERVED_FLAG_NAMES = ['help', 'json', 'params']`: properties whose flag name is one of these get no flag.

### Kind checks ([Data flow](logic.md#data-flow) "Declaring", SC-2, logic D5)

- `method`: `params`, if present, is checked with `object: true`; a non-object-type top gives `<label>: params must be an object schema`. Other problems give `<label>: params: <message>` where the checker's `at` starts empty for the top (`params: unsupported keyword oneOf`) and is the property path below it (`params.properties.when: unknown type date`). Then two top-level properties with the same `flagNameOf` give `<label>: params <a> and <b> both map to --<flag>`. `result` is checked without `object`.
- `event`: `data` is checked without `object`; a non-object value gives `<label>: data must be a schema object`.
- UI `command`: `args` is checked like `params` (`<label>: args must be an object schema`).
- These run for `override` entries too, because `checkKindEntry` is already called for them with label `override <id>` (`manifest.ts:138`).

The exact text in SC-2's table is the acceptance bar; the checker's `at` strings are shaped to produce it.

### Kernel schema tables ([SC-6](logic.md#schemas-and-validation), logic D7)

`CONTRACT:`
```
KERNEL_METHOD_SCHEMAS: { [M in MethodName]: { description: string; params: Schema; result: Schema } }
KERNEL_EVENT_SCHEMAS: { [T in KernelEventType]: { description: string; data: Schema } }
  // KernelEventType = Exclude<QuirkyEvent, PluginEvent>['type']; data describes the event minus `type`
CONNECTION_METHODS: readonly ['client.hello', 'events.subscribe', 'terminal.attach', 'terminal.detach']
```
- Every `params` schema is `type: 'object'` with the properties of `ParamsOf<M>` (`packages/protocol/src/rpc.ts:29-141`) and `additionalProperties` unset (false).
- **A kernel schema never rejects what its handler accepts** (`packages/daemon/src/methods.ts`): required only where the handler requires a value; `minimum` only where the handler enforces one (`int(params, key, min)`); no `maximum` where the handler clamps (`ask.wait.timeoutMs`). Specifically: `git.diff.staged` optional; `settings.set` all three optional; `setting.set.value` required with schema `{}`; `ask.create.spec` and `ask.answer.answers` as `{ "type": "object", "additionalProperties": true }`-style loose objects (the handlers do the deep checks); `client.hello.role` an enum of the four roles; agent params an enum of `AGENT_KINDS`.
- `result` schemas describe the result types closely enough to be useful (top-level type and main properties); they are documentation (logic D6). Unions such as `AskAnswer` are `{}` with a description.
- Descriptions come from the doc comments in `rpc.ts` where present, otherwise one short sentence.

### Daemon validation ([Data flow](logic.md#data-flow) "Calling a method", SC-3 to SC-8, logic D6)

`CONTRACT:` in `Dispatcher.dispatch(method, params, from)`:
- Kernel method (`Object.hasOwn(handlers, method)`): `validateValue(KERNEL_METHOD_SCHEMAS[method].params, params)`; a message throws `invalidParams(message)` before `runKernel`. The plugin-caller check for `CONNECTION_METHODS` stays first.
- Plugin method: after `effective` is found and before `resolveImplementation`, validate against `effective.data.params` if present, else against `{ type: 'object' }` (no properties). The plugin is not activated on failure (SC-3 asserts `inactive`).
- `server.ts:152-155` keeps rejecting non-object params first. Results are never validated.

### `api.describe` ([Conceptual model](logic.md#conceptual-model) "The catalog", SC-1, SC-6, SC-8, logic D17)

`SCHEMA:`
```
Methods['api.describe'] = { params: Record<string, never>; result: ApiDescription }
ApiDescription = {
  schemaVersion: 1, daemonVersion: string, protocolVersion: number,
  methods: ApiMethodEntry[], events: ApiEventEntry[], uiCommands: ApiUiCommandEntry[]
}
ApiMethodEntry = { name: string, plugin: string | null, description?: string,
                   params: Schema, result: Schema, connection?: true }
ApiEventEntry = { name: string, plugin: string | null, description?: string, data: Schema | null }
ApiUiCommandEntry = { id: string, plugin: string, title: string, description?: string, args: Schema }
```
- Kernel methods: every key of `KERNEL_METHOD_SCHEMAS`, `connection: true` for `CONNECTION_METHODS`. Plugin methods: every effective `method` contribution; `name` is the contribution ID minus `method:`; `plugin` is the declaring plugin of the effective declaration; kernel entries have `plugin: null`, because `kernel` is itself a valid plugin ID (the overrider when overridden, SC-8); `params` defaults to `{ "type": "object" }`, `result` to `{}`.
- Kernel events by type; plugin events named `<pluginId>/<name>` with `data` or `null` when omitted. UI commands: effective `command` contributions with `title` defaulting to the name (as `ui-model.ts:206-215` does) and `args` defaulting to `{ "type": "object" }`.
- Each list sorted by `name` (or `id`), with plain string comparison.
- Activates no plugin.

### CLI command specs ([One command table](logic.md#conceptual-model), SC-16, logic D9)

`CONTRACT:`
```
type FlagSpec = { type: 'string' | 'integer' | 'number' | 'boolean' | 'json'; description: string;
                  required?: boolean; repeatable?: boolean; enum?: readonly (string | number)[] }
type PositionalSpec = { name: string; description: string; required: boolean }
type Command = { name: string; summary: string; positionals: PositionalSpec[];
                 flags: Record<string, FlagSpec>; methods: readonly string[];
                 plugin: string | null; rawArgs?: true; shadowedBy?: string; run(args: ParsedArgs, ctx: Context): Promise<void> }
usageOf(command): string          // e.g. 'wt create <repoId> <name> [--base <string>]'
commandHelp(command): string      // SC-16's block: usage, summary, options lines, global line
```
- `usageOf` renders required positionals as `<name>`, optional as `[<name>]`, then required flags as `--name <type>`, optional as `[--name <type>]`, booleans as `[--name]`, enums as `red|blue`, repeatable with a trailing `...`. Global flags are not in the usage line.
- `commandHelp` options lines: `--<name> <type>`, `required` column, description; then the global line `global: --json prints machine-readable JSON`. The first line still starts with `usage: quirky ` (tests at `cli.e2e.test.ts:301-308` rely on it).
- Kernel commands' `methods` follow the survey of `ctx.rpc.call` in each command: for example `session new` → `['worktree.list', 'session.create', 'session.createStructured']`, `open` and `help` → `[]`, `ask` → `['ask.create', 'ask.wait', 'ask.cancel']`. A test asserts each listed method exists in `KERNEL_METHOD_SCHEMAS`.
- For kernel commands, parse-time `required: true` gives `missing required flag --<name>`; run code may keep its own checks. A command with `rawArgs: true` gets its tokens after the command words unparsed in `args.positionals` (global `--json`, `--help` and `-h` still removed and honored) and parses them itself.

### Argument parsing ([Global flags](logic.md#help-and-errors), SC-10, SC-11, SC-18, logic D12, D13, D16)

`CONTRACT:` `parseArgs(argv, defs: Record<string, FlagSpec>, command: string): ParsedArgs` where `ParsedArgs.flags` values are `string | number | boolean | unknown[] | unknown` (JSON values parsed).
- Unknown long flag: `unknown flag --<x> for <command>` followed by a line `valid flags: --a, --b, --json, --help` (declared order, then globals). Unknown short flag keeps `unknown flag -x`.
- A valued flag at the end gives `--<x> requires a value`; followed by a token starting with `--` gives `--<x> requires a value; write --<x>=<value> for a value starting with --`. `--x=--y` is accepted. `-h` is still help; a token `-5` is a value.
- `integer`: `/^-?\d+$/` else `--<x> must be an integer, got "<raw>"`. `number`: a finite `Number(raw)` with non-empty trimmed text, else `--<x> must be a number, got "<raw>"`. `json`: `JSON.parse`, else `--<x> must be JSON: <parser message>`. `boolean`: as today (`--<x> is a switch; got "<raw>"`). `enum`: after type parsing, `--<x> must be one of a, b, got "<raw>"`.
- `repeatable`: each occurrence appends; otherwise the last occurrence wins (as today).
- The existing `args.test.ts:20-22` assertion that string flags take any next token, including dashed ones, is replaced by the new rule (logic amendment, SC-18).

### Generated commands ([Generated commands](logic.md#generated-commands), SC-9 to SC-15, logic D10 to D14)

`CONTRACT:`
- `groupOf(pluginId)`: the ID minus a leading `quirky.` (`BUILTIN_PLUGIN_PREFIX`, `packages/protocol/src/plugins.ts`).
- `generatedCommands(description: ApiDescription): Command[]`: one per `ApiMethodEntry` with a non-null `plugin`; the command's `name` = `<group> <method name after '/'>` (CLI words); `summary` = first line of the description or `''`; `positionals: []`; `methods: [entry.name]` (the RPC wire name, never the command words); flags: each top-level property whose `flagNameOf` isn't reserved, typed by its schema (`string`, `integer`, `number`, `boolean`; `enum` from the schema; `array` of a scalar type → that type with `repeatable`; anything else → `json`), `required` from the schema's `required` (documentation and help only: a generated command never runs the parse-time required check, because `--params` may supply the property); plus `params: { type: 'json', description: 'all params as one JSON object' }`.
- `paramsFromArgs(command, args, schema)`: starts from `--params` (must be a JSON object, else `--params must be a JSON object`), adds each flag under its property name; a property given both ways throws `UsageError('<prop> is given by both --params and --<flag>')`; then `validateValue(schema, params)` and a message throws `UsageError(message)`. Before `validateValue`, required properties missing from the merged object that have flags are reported as `missing required flag --a, --b` (all of them). When `validateValue`'s failing path starts at a top-level property that came from a flag, the message's `params.<prop>` prefix is replaced with `--<flag>` (`--priority must be at most 5`); a property from `--params` keeps the `params.` path (`params.title must be a string`). A positional token on a generated command is `unexpected argument "<t>"`.
- `run`: `paramsFromArgs`, then `ctx.rpc.callAny(method, params)`, then `ctx.out.result(result, () => formatGeneric(result))`.

`CONTRACT:` `resolveCommands(kernel: Command[], generated: Command[]): { active: Command[]; shadowed: Command[] }`
- Generated commands sorted built-ins (`plugin` starts with `quirky.`) before installed, then by name.
- A generated command is shadowed by a kernel command whose name equals it or is a word-prefix of it (`status` shadows `status list`), or by an earlier generated command with the same name. `shadowedBy` is set to `kernel <name>` or `<plugin> <name>` of the winner (for example `kernel status`).

`CONTRACT:` `formatGeneric(result: unknown): string` — SC-14's table is the authority. A table's columns are the union of keys whose values are scalars (string, number, boolean, null) in first-seen order, headed with the key upper-cased; non-scalar cells print as compact JSON; `null` cells as `-`.

### Routing and errors in `run` ([Running a CLI command](logic.md#data-flow), SC-13, SC-15 to SC-19, logic D15, D16, D20)

- `--json` mode is decided by a pre-scan of argv before `--`: the last occurrence of `--json`, `--json=true` or `--json=false` wins, as in parsing, and that one value drives both result and error output. Errors thrown during routing and parsing are therefore reported in JSON.
- Order: `route(argv, COMMANDS)`. Kernel `command` → run as today. Help (`--help`, `-h`, `help` command, no args) for the top level, a kernel command or a group that has kernel commands → offline help as today (`helpText`), with the top-level help ending in `run 'quirky api' to list every command, including plugins'`. Otherwise (`unknown`, `group` without help, or help for a non-kernel group) → `api.describe`, `generatedCommands`, `resolveCommands`, then `route(argv, [...COMMANDS, ...active])`. Still unknown → `UsageError('unknown command "<words>"')` with `suggestions = suggestCommands(words, names of active commands)`.
- `suggestCommands(words, candidates)`: candidates within Levenshtein distance 2 of the typed words joined by spaces, or that start with them, or whose first word equals the typed first word when that word is a known group (SC-15's `acme.notes list`); at most 3, by distance then name. Text mode adds a line `did you mean: quirky <c1>, quirky <c2>`. The typed words are the leading non-flag tokens up to two.
- Error document under `--json`: `{"error": {"code", "message", "suggestions"?}}` written with `ctx.out.jsonLine` to stdout; nothing on stderr. Codes: `UsageError` → `usage`; `DaemonUnavailableError` → `daemon-unavailable`; `RpcError` by `code`: -32602 `invalid-params`, -32004 `not-found`, -32009 `conflict`, -32601 `method-not-found`, -32001 `unauthorized`, anything else `internal`; any other error → `internal`.
- A command that has already printed its result and then fails (only `job run`, `packages/cli/src/commands/job.ts:60-75`) throws `CommandFailed`: exit 1, text mode prints `quirky: <message>` to stderr, JSON mode prints nothing more, so stdout stays one JSON document (`job.test.ts` relies on it).
- Exit codes: 0 ok, 2 `UsageError`, 1 everything else.

### `quirky api`, `api call`, `skill` ([Discovery and the skill](logic.md#discovery-and-the-skill), SC-20 to SC-23, logic D17 to D19)

`SCHEMA:`
```
ApiCatalog = ApiDescription & { commands: ApiCommandEntry[] }
ApiCommandEntry = { command: string, plugin: string | null, methods: string[], summary: string,
                    usage: string, positionals: { name, description, required }[],
                    flags: { name, type, description, required, repeatable, enum? }[], shadowedBy?: string }
```
- `buildCatalog(description, kernel, resolved)`: every kernel command, every active generated command and every shadowed one (with `shadowedBy`), sorted by `command`, then kernel first, then `plugin`.
- `quirky api`: text lists commands grouped by first word, `  <usage>  <summary>`, ends with `<n> methods, <m> events`; `--json` prints the catalog.
- `quirky api call <method> [--params <json>] [flags]`: a kernel command with `rawArgs: true` and a declared positional `method` (for help and the catalog); its flags can't be declared statically, so its run code takes the first raw token as the method, finds the method in `api.describe`, builds a `Command` for it as `generatedCommands` would (kernel methods too) and parses the remaining argv with it. Refuses `connection` methods with `UsageError('<m> needs a live connection and can\'t be called from the CLI')` and missing ones with `UsageError('unknown method <m>')`. Unknown flags are the target method's to judge.
- `renderSkill(catalog)`: frontmatter `name: quirky` and `description:` one line; sections in this order: discovering commands, conventions (`--json`, error document, exit codes), commands by group with one line `quirky <usage>  <summary>` each (active commands only). Deterministic: no timestamps, sorted input, `\n` line ends, trailing newline.
- `skill install --dir <dir>`: target `<dir>/quirky/SKILL.md`; same bytes → prints `up-to-date` and does not write; otherwise creates the folder, writes a temp file in it and renames, prints `installed`. `skill status --dir <dir>`: `missing`, `stale` or `up-to-date`, exit 0. `--json` prints `{"status": "<s>", "path": "<p>"}` for both. `--dir` is resolved against the cwd and is required.

## Data models / schemas

The catalog, `ApiDescription` and `Schema` shapes above are the only new wire shapes. No store table changes.

## Existing tests and fixtures

- Plugin method fixtures that are called with params now need a `params` schema, because an omitted one refuses every property (SC-4). Update each fixture's manifest rather than the call; for opaque params use `{ "type": "object", "additionalProperties": true }`. The survey found method fixtures in `packages/daemon/test/plugins/` (`dispatch`, `events-unit`, `events`, `host-extension`, `lifecycle`, `manifests`, `methods`, `runtime`, `ui-api`, `ui-wiring`) and `packages/ui/test/plugin-host.test.ts`; only those whose calls pass params change.
- Kernel calls in tests with extra or wrongly typed properties now fail with the schema's message; a test asserting a handler's own message for such input is updated to the schema's message only where the schema now catches it first.
- `packages/cli/test/args.test.ts:20-22` changes as noted in Argument parsing.
- `packages/cli/test/cli.e2e.test.ts:310` ("help never contacts the daemon") must still pass.

## DO-NOT-CHANGE fences

- `packages/daemon/src/plugins/registry.ts` `computeRegistry` and precedence (`beats`): the effective declaration, and so the schema an override brings, comes from it; m0-registry's tests pin it.
- The handlers' own validation in `packages/daemon/src/methods.ts`: it stays as a second check, and kernel schemas are written to accept everything it accepts (logic D7).
- Existing commands' run code and human output, except `job run`'s failure path: m0-port-v1's exit test needs v1 behavior unchanged.
- `PROTOCOL_VERSION` (`rpc.ts:18`): the change is additive.
- `docs/loop/LOOP.md` and `scripts/build-loop/`: protected by the loop.

## Always / Ask / Never

- **Always:** use fresh temp `QUIRKY_HOME`s with short prefixes (m0-registry D33); print the exact texts the logic spec's tables give; keep `schema.ts` free of Node and Bun APIs (the UI may import protocol); keep kernel schemas at least as permissive as their handlers.
- **Ask (decide and log as a decision):** the wording of method and event descriptions in the kernel tables; the skill's prose beyond the required sections; column widths in `quirky api` text.
- **Never:** coerce a flag value into another type; activate a plugin to list, help or validate; let a test or command write into the real `~/.quirky`, `~/.claude` or `~/.codex`; validate results or event data.

## Cross-cutting

- **Security:** no new endpoint; `api.describe` uses the existing token. Schemas come from trusted plugins (roadmap "Trust"); `checkSchemaDeclaration` still bounds recursion by the manifest's own nesting.
- **Performance:** a generated command costs one extra `api.describe` call; kernel commands and kernel help cost nothing new.
- **Migration and rollback:** none; manifests without the new fields keep their meaning except that plugin methods refuse params they never declared, which is the intended contract.
- **Platform:** nothing platform-specific; `skill install` uses `rename` within one folder.

## Testing strategy

Scenario tests are named `SC-<n>: <title>` and assert the logic spec's Then clauses and tables.

| File | Covers | How |
|---|---|---|
| `packages/protocol/test/schema.test.ts` | `checkSchemaDeclaration` messages, `validateValue` messages and no coercion, `flagNameOf` | Unit |
| `packages/protocol/test/kernel-schemas.test.ts` | Every `MethodName` has an entry (also by type); every `params` is an object schema that passes `checkSchemaDeclaration`; every `result` and event `data` passes it | Unit |
| `packages/daemon/test/plugins/schema-kinds.test.ts` | SC-2's table | Through `parseManifest`, like `kinds.test.ts` |
| `packages/daemon/test/plugins/scripting-api.test.ts` | SC-1, SC-3 to SC-8, SC-13, SC-15, SC-20 to SC-23 against a real daemon | `startHarness` with `builtinPluginsDir` and installed fixtures (`writeModulePlugin` with a marker for activation); `client.callAny`; `runCli(args, { home: harness.home })` from `packages/cli/test/fixtures/fake-daemon.ts` |
| `packages/daemon/test/kernel-schemas.test.ts` (or inside the file above) | SC-6: every existing kernel call shape still passes, wrong types fail | Real daemon |
| `packages/cli/test/generated.test.ts` | SC-9 to SC-12, SC-14, SC-16, SC-17 | `FakeDaemon` with a seeded catalog, or the real daemon where a flow needs one |
| `packages/cli/test/args.test.ts`, `run.test.ts` | Parsing rules, SC-18, SC-19, routing order, help stays offline | Unit and in-process `run` |
| `packages/cli/test/skill.test.ts` | `renderSkill` determinism and sections, install and status on a temp dir | Unit plus `runCli` |

Acceptance bar: `bun run test`, `bun test scripts` (except the queue-state test recorded in m0-daemon-api D31) and `bun run typecheck` pass, and every scenario SC-1 to SC-23 has a named test.

## Non-goals

- Running UI commands from the CLI or checking `args` in the window (m0-ui-bridge).
- Socket transport, selectors, `--version`, request IDs (m0-cli-core); `--yes` confirmations (m0-distros); moving v1's groups into plugins (m0-port-v1).
- Validating results or event data; positionals and custom formatters for generated commands; a catalog cache.
