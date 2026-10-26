# Tech spec: plugin kernel and contribution registry

**Status:** Draft for build. Logic spec: [logic.md](logic.md). Gate fired: the user asked for it
(LOOP.md step 4), and the work crosses protocol, daemon, CLI and desktop packages.

## Architecture

The kernel lives in a new directory, `packages/daemon/src/plugins/`, inside `quirkyd`. Shared
shapes go in `@quirky/protocol` so the CLI, UI and plugin authors see the same types. Back-link:
[Conceptual model](logic.md#conceptual-model), [Data flow](logic.md#data-flow).

| File | Role |
| --- | --- |
| `packages/protocol/src/plugins.ts` (new) | `PluginInfo`, `ContributionInfo`, states, `PluginModule`, `PluginContext` types; ID regexes and `parseContributionId`/`formatContributionId` (pure, no Node imports) |
| `packages/protocol/src/rpc.ts` | add the five `plugin.*` entries to `Methods` and `{ type: 'plugin.changed' }` to `QuirkyEvent` |
| `packages/protocol/src/index.ts` | `export * from './plugins'` |
| `packages/daemon/src/plugins/manifest.ts` (new) | `parseManifest`: raw JSON text + directory facts → a validated manifest or a list of error strings |
| `packages/daemon/src/plugins/discover.ts` (new) | reads the two plugin directories into `DiscoveredPlugin[]`, sorted by directory name |
| `packages/daemon/src/plugins/registry.ts` (new) | `computeRegistry`: pure function from discovered plugins + disabled IDs to plugin statuses, contribution table and diagnostics |
| `packages/daemon/src/plugins/host.ts` (new) | `PluginHost`: owns discovery, the computed registry, runtime states, activation, deactivation, resolve, and enable/disable |
| `packages/daemon/src/store.ts` | new `disabled_ids` table and two methods |
| `packages/daemon/src/methods.ts` | `createHandlers(core, plugins)` gains the five `plugin.*` handlers |
| `packages/daemon/src/daemon.ts` | builds the host, loads it, activates startup plugins before `runtime.json`, stops it before the store closes |
| `packages/cli/src/commands/plugin.ts` (new) | `plugin list`, `plugin contributions`, `plugin enable`, `plugin disable`, `plugin activate` |
| `packages/cli/src/commands/index.ts` | add the five commands to `COMMANDS` |
| `apps/desktop/src/bun/paths.ts` | add `QUIRKY_BUILTIN_PLUGINS_DIR` (dev: `<root>/plugins`; packaged: `<resources>/plugins`) |
| `plugins/README.md` (new) | one paragraph: this directory holds built-in plugins, one per subdirectory |
| `docs/v1.md` | add the new env var and the `plugins/` home directory to the "Files and environment" tables |

No new dependencies. Plugin modules are imported with dynamic `import()` of an absolute path,
which Bun supports for `.ts` and `.js`.

## Code references

- `packages/daemon/src/methods.ts:73` `createHandlers(core: Core): Handlers`. `Handlers` is
  `{ [M in MethodName]: Handler<M> }`, so every new `Methods` entry needs a handler. Reuse the
  file's `str`/`optStr`/`optBool` param helpers.
- `packages/daemon/src/daemon.ts:105` `startDaemon(options)`. Insert the host after `new Core(...)`
  and `pty.connect()`, and before `writePrivateJson(runtimeFilePath(home), runtime)` (line ~175).
  In `stop()`, `await plugins.stop()` before `store.close()`.
- `packages/daemon/src/service.ts:127` `Core.broadcast(event)`: the host's `emit` callback.
- `packages/daemon/src/errors.ts` `notFound`, `conflict`, `invalidParams`: error codes for the API.
- `packages/daemon/src/store.ts:41-86` schema `CREATE TABLE IF NOT EXISTS` block; add the table
  there. `getSettings`/`setSettings` (line ~292) stay untouched.
- `packages/cli/src/commands/repo.ts` is the pattern for a command group (`takePositionals`,
  `ctx.rpc.call`, `ctx.out.result(json, () => text)`, `formatTable`, `formatRecord`).
- `packages/cli/src/args.ts` `FlagDefs` and `flagString`/boolean flags for `--kind`, `--plugin`,
  `--all`.
- `packages/cli/test/fixtures/fake-daemon.ts:144` the method `switch`: add `plugin.*` cases so CLI
  tests can run without a real daemon.
- `packages/daemon/test/helpers.ts` `startHarness(options)`: tests pass `builtinPluginsDir` and
  write fixtures into `<home>/plugins/`.
- `apps/desktop/src/bun/paths.ts` `RuntimeEnv`, `resolveRuntimeEnv`, `bundledEnv`;
  `apps/desktop/test/paths.test.ts` asserts the key list.

## Contracts & interfaces

### IDs ([Discovery and IDs](logic.md#discovery-and-ids))

REGEX: plugin ID `^[a-z0-9]+(?:[.-][a-z0-9]+)*$`, at most 64 chars.
REGEX: kind `^[a-z]+(?:[.-][a-z]+)*$`, at most 64 chars.
REGEX: contribution name `^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$`, at most 128 chars.
REGEX: full contribution ID `^(<kind>):(<pluginId>)/(<name>)$`, composed from the three above.

CONTRACT:
```ts
parseContributionId(id: string): { kind: string; namespace: string; name: string } | null
formatContributionId(kind: string, namespace: string, name: string): string
isPluginId(value: string): boolean
```

An ID with a `:` is a contribution ID; one without is a plugin ID. `quirky.` is the reserved
built-in prefix.

### Manifest ([Discovery and IDs](logic.md#discovery-and-ids), [Bad plugins](logic.md#bad-plugins))

File name `quirky-plugin.json`. Allowed top-level fields are exactly those in the schema below;
any other is an error naming the field. Contribution and override entries may carry any further
fields, which become the contribution's `data` (the entry minus its `id`).

SCHEMA:
```ts
type PluginManifest = {
  id: string                       // plugin ID regex
  name: string                     // non-empty
  version: string                  // non-empty; not checked as semver
  description?: string
  main?: string                    // relative path inside the plugin dir; no absolute, no escape via ..
  activation?: 'lazy' | 'startup'  // default 'lazy'
  dependencies?: string[]          // plugin IDs, no duplicates, not itself
  contributes?: Record<string /* kind */, Array<{ id: string /* name */ } & Record<string, unknown>>>
  overrides?: Array<{ id: string /* full contribution ID */ } & Record<string, unknown>>
  disables?: string[]              // full contribution IDs
}
```

Manifest errors (each a separate string, all reported):

- not valid JSON / not an object; a required field missing or of the wrong type; unknown field
- a regex failing for the plugin ID, a kind, a name, an override ID or a disables ID
- a duplicate name within one kind, a duplicate override ID, a duplicate dependency
- an override whose namespace is the plugin's own ID ("use contributes for your own IDs")
- `main` absolute or resolving outside the directory
- directory name ≠ `id`
- source `installed` and `id` starts with `quirky.`

CONTRACT:
```ts
parseManifest(text: string, at: { dirName: string; dir: string; source: PluginSource }):
  { ok: true; manifest: PluginManifest } | { ok: false; errors: string[] }
```

### Discovery

CONTRACT:
```ts
type DiscoveredPlugin = {
  id: string            // manifest id, or the directory name when the manifest is unusable
  dir: string           // absolute
  source: PluginSource
  manifest: PluginManifest | null
  errors: string[]      // load-time errors; non-empty means invalid
}
discoverPlugins(dirs: { builtin: string | null; installed: string }): DiscoveredPlugin[]
```

- Reads immediate subdirectories of each directory, skipping names starting with `.`. A missing
  directory yields nothing (not an error).
- A subdirectory without `quirky-plugin.json` is a `DiscoveredPlugin` with the error "no
  quirky-plugin.json".
- Built-ins come first, each list sorted by directory name. An installed plugin whose `id` equals
  a built-in's gets "duplicates the built-in plugin <id>". The built-in keeps working.

### Registry ([Overrides](logic.md#overrides), [Disabling](logic.md#disabling))

`computeRegistry` is pure and deterministic: the same inputs in any order give the same output.

CONTRACT:
```ts
computeRegistry(plugins: DiscoveredPlugin[], disabled: ReadonlySet<string>): Registry
type Registry = {
  plugins: Map<string, RegistryPlugin>     // by plugin id
  declarations: ContributionInfo[]         // every declaration from non-invalid plugins, sorted by id then plugin
  effective: Map<string, ContributionInfo> // contribution id -> the declaration in effect
}
type RegistryPlugin = {
  discovered: DiscoveredPlugin
  status: 'enabled' | 'disabled' | 'invalid'
  diagnostics: PluginDiagnostic[]          // load errors (error), cascade reasons, conflicts and warnings
}
```

Rules, applied in this order:

1. **Invalid:** plugins with `errors`. Then, repeatedly until stable: a plugin depending on an ID
   not in the discovered set is invalid ("dependency <id> is not installed"); one depending on an
   invalid plugin is invalid ("dependency <id> is invalid"). Then every plugin on a dependency
   cycle among the rest is invalid with "dependency cycle: <ids sorted, comma-separated>".
2. **Disabled:** a plugin whose ID is in `disabled` ("disabled by the user"). Then, repeatedly: a
   plugin depending on a disabled plugin is disabled ("dependency <id> is disabled").
3. **Declarations:** each non-invalid plugin's `contributes` entries become declarations under
   `<kind>:<pluginId>/<name>` with `override: false`; its `overrides` entries become declarations
   with `override: true`.
4. **Disabled IDs:** the union of `disabled` contribution IDs and the `disables` lists of enabled
   plugins. Every declaration of such an ID gets status `disabled`, with `disabledBy: 'user'` when
   the user list has it (user wins), else `'plugin'` and `disablingPlugin` (the lowest such plugin
   ID). Declarations from disabled plugins get `disabled` / `disabledBy: 'owner'`.
5. **Winner** among the remaining declarations of an ID (all from enabled plugins). Override
   candidates beat the base. Among overrides, `a` beats `b` when `a` is installed and `b`
   built-in, or both have the same source and `a` depends on `b` transitively. The unbeaten
   overrides are the maxima; the one with the lowest plugin ID wins. Other maxima are
   `rejected` with `conflictWith: <winner>`, and each rejected plugin gets the warning
   "override of <id> conflicts with <winner>". Everything else for that ID is `overridden` with
   `overriddenBy: <winner>`. The winner is `effective`.
6. **Override of nothing:** an effective override whose ID has no base declaration and whose
   namespace plugin is not discovered at all, or is discovered and enabled, gets a warning on its
   plugin: "override of <id> replaces nothing". No warning when the namespace plugin is disabled
   or invalid.

SCHEMA:
```ts
type PluginSource = 'builtin' | 'installed'
type PluginState = 'inactive' | 'activating' | 'active' | 'failed' | 'disabled' | 'invalid'
type PluginDiagnostic = { level: 'error' | 'warning'; message: string }
type PluginInfo = {
  id: string; name: string; version: string; description?: string
  source: PluginSource; dir: string
  activation: 'lazy' | 'startup'
  dependencies: string[]
  state: PluginState
  diagnostics: PluginDiagnostic[]     // registry diagnostics, then the last activation error if failed
}
type ContributionStatus = 'effective' | 'overridden' | 'disabled' | 'rejected'
type ContributionInfo = {
  id: string; kind: string; name: string
  plugin: string                      // the declaring plugin
  override: boolean
  status: ContributionStatus
  overriddenBy?: string
  disabledBy?: 'user' | 'plugin' | 'owner'
  disablingPlugin?: string
  conflictWith?: string
  data: Record<string, unknown>
}
```

For an invalid plugin with no usable manifest, `name` is the ID, `version` is `''`, `activation`
is `'lazy'` and `dependencies` is `[]`.

### Plugin module ([Activation](logic.md#activation))

SCHEMA:
```ts
type PluginContext = {
  readonly pluginId: string
  readonly dir: string
  log(message: string): void                       // goes to the daemon log, prefixed with the plugin ID
  provide(contributionId: string, implementation: unknown): void
}
type PluginModule = {
  activate(context: PluginContext): void | Promise<void>
  deactivate?(): void | Promise<void>
}
```

- `provide` throws `Error("<pluginId> does not declare <id>")` for an ID not in the plugin's
  `contributes` (as full IDs) or `overrides`. It throws `Error("<pluginId> is no longer active")`
  when called after the activation failed or the plugin was deactivated.
- A module without an `activate` export fails activation with "main module has no activate
  export".

### PluginHost

CONTRACT:
```ts
class PluginHost {
  constructor(options: {
    builtinDir: string | null
    installedDir: string                 // <home>/plugins
    store: Pick<Store, 'listDisabledIds' | 'setDisabledId'>
    emit(event: QuirkyEvent): void
    log(message: string): void
    activationTimeoutMs?: number         // default 10_000; also bounds each deactivate
  })
  load(): void                           // discover + compute; no plugin code runs
  activateStartup(): Promise<void>       // activates every enabled 'startup' plugin; never rejects
  list(): PluginInfo[]                   // sorted by id
  contributions(filter?: { kind?: string; pluginId?: string; all?: boolean }): ContributionInfo[]
  activate(pluginId: string): Promise<PluginInfo>
  resolve(id: string): Promise<{ contribution: ContributionInfo; implementation: unknown }>
  resolveImplementation(id: string): Promise<unknown>
  setEnabled(id: string, enabled: boolean): Promise<void>
  stop(): Promise<void>
}
```

- **`activate`:** NotFound for an unknown ID; Conflict "<id> is disabled" or "<id> is invalid".
  Already `active` → returns. `activating` → awaits the same in-flight promise, so `activate` runs
  once. Otherwise: activate each dependency (in manifest order) first; if one fails, this plugin
  becomes `failed` with "dependency <dep> failed to activate". Then import `main` (when set) and
  call `activate(context)`, racing the timeout ("activation timed out after <n> ms"). Success →
  `active`, appended to the activation order. Failure (throw, rejection, timeout, missing export)
  → `failed`, the error message recorded, the context revoked and any provided implementations
  dropped; the promise rejects with Conflict "<id> failed to activate: <message>". Calling
  `activate` on a `failed` plugin tries again. A plugin without `main` becomes `active` without
  importing anything. Each state change emits `plugin.changed`.
- **`resolve`:** NotFound "no contribution <id> is in effect" unless the ID is in
  `registry.effective`. Activates the effective declaration's plugin (errors as above), then
  returns that declaration and the implementation it provided, or `undefined`.
- **`resolveImplementation`:** as `resolve`, but Conflict "<plugin> did not provide <id>" when the
  implementation is `undefined`.
- **`setEnabled`:** InvalidParams when `id` is neither a plugin ID nor a contribution ID by regex.
  NotFound when it is not a discovered plugin ID, nor a contribution ID declared by any
  non-invalid plugin, and (for enable) not in the stored list. Otherwise writes the store,
  recomputes the registry, deactivates every plugin that was `active` and is now `disabled` (in
  reverse activation order), activates newly enabled `startup` plugins, and emits
  `plugin.changed` once. Idempotent.
- **`stop`:** deactivates `active` plugins in reverse activation order, each bounded by the
  timeout; a throw is logged and the next one still runs.
- Runtime state (`inactive` | `activating` | `active` | `failed`) is kept per plugin and reported
  only for registry status `enabled`; `disabled` and `invalid` come from the registry.

### Daemon API ([Behavior & scenarios](logic.md#behavior--scenarios))

SCHEMA:
```ts
'plugin.list':          { params: Record<string, never>; result: PluginInfo[] }
'plugin.contributions': { params: { kind?: string; pluginId?: string; all?: boolean }; result: ContributionInfo[] }
'plugin.enable':        { params: { id: string }; result: { ok: true } }
'plugin.disable':       { params: { id: string }; result: { ok: true } }
'plugin.activate':      { params: { pluginId: string }; result: PluginInfo }
// QuirkyEvent: | { type: 'plugin.changed' }
```

`plugin.contributions` without `all` returns only `effective` entries; with `all`, every
declaration. `PROTOCOL_VERSION` stays 1, since the change is additive.

### CLI

- `quirky plugin list`: table `ID STATE SOURCE VERSION`, then one indented line per diagnostic.
- `quirky plugin contributions [--kind <k>] [--plugin <id>] [--all]`: table `ID PLUGIN STATUS`
  (STATUS column only with `--all`; `overridden by X`, `disabled by user|X|owner`,
  `rejected (conflicts with X)`).
- `quirky plugin enable <id>` / `quirky plugin disable <id>`: prints `enabled <id>` /
  `disabled <id>`.
- `quirky plugin activate <pluginId>`: prints the plugin record (`id`, `state`).
- `--json` prints the method's result. An RPC error exits non-zero with the message, as other
  commands already do.

### Store

SCHEMA:
```sql
CREATE TABLE IF NOT EXISTS disabled_ids (id TEXT PRIMARY KEY, disabled_at INTEGER NOT NULL);
```

CONTRACT:
```ts
listDisabledIds(): string[]                       // sorted
setDisabledId(id: string, disabled: boolean): void // insert-or-ignore / delete
```

### Daemon wiring

CONFIG: `DaemonOptions.builtinPluginsDir?: string | null` (default
`process.env.QUIRKY_BUILTIN_PLUGINS_DIR ?? <repo root>/plugins`, computed from `import.meta.url`
the way `defaultUiDir()` is); `DaemonOptions.pluginActivationTimeoutMs?: number`.

CONFIG: installed plugins dir `<home>/plugins`, created with mode 0700 if missing.

`DaemonHandle` gains `plugins: PluginHost`, which the daemon tests use for the resolve scenarios
(D22).

## DO-NOT-CHANGE fences

- **`Settings` type and `settings.get`/`settings.set`** (`packages/protocol/src/model.ts`,
  `store.ts` settings table): disabled IDs must not leak into settings, because D20 gives them one
  home.
- **Existing `Methods` entries and `PROTOCOL_VERSION`**: v1 clients (desktop, UI, CLI) depend on
  them; this item only adds entries.
- **`docs/loop/LOOP.md`, `scripts/build-loop/`**: protected by the loop; touching them pauses it.
- **`packages/ui/`**: UI-side plugin loading is m0-ui-api. The UI compiles against `Methods`, so
  only the protocol addition reaches it.

## Always / Ask / Never

- **Always:** keep `computeRegistry` pure (no fs, no store, no clock), so the determinism tests can
  shuffle inputs. Report every load problem as a diagnostic; never throw out of `load()` or
  `activateStartup()`. Prefix every log line from plugin code with the plugin ID.
- **Ask (headless: decide and log a decision):** any change to a rule in the Registry section;
  any new top-level manifest field.
- **Never:** import a plugin module during `load()`, listing, or enable/disable of a plugin that
  isn't active. Never let one plugin's failure reject daemon startup. Never touch the real
  `~/.quirky` in tests.

## Cross-cutting

- **Security:** plugins are full trust and in process (locked). The only checks are the ones that
  keep IDs honest: the reserved prefix, directory equals ID, and `main` inside its directory.
- **Observability:** activation start, success, failure and deactivation are logged through the
  daemon's `log` with the plugin ID.
- **Migration:** the new table is created with `IF NOT EXISTS`; existing homes need nothing.
- **Platforms:** directory scanning and dynamic import are portable. Nothing here is macOS-only.

## Testing strategy

Acceptance bar: every scenario SC-1 to SC-24 has at least one named test, plus the three repo
commands (`bun run test`, `bun test scripts`, `bun run typecheck`) pass.

- `packages/protocol/test/plugins.test.ts`: ID regexes and parse/format round trips, including
  the 64/128 length limits and invalid shapes.
- `packages/daemon/test/plugins/manifest.test.ts`: each manifest error in the list above.
- `packages/daemon/test/plugins/registry.test.ts`: pure tests of rules 1-6, including SC-12's
  order independence (compute with the input reversed and shuffled and compare), SC-13, SC-14,
  SC-15, SC-19, SC-20, and the cycle message.
- `packages/daemon/test/plugins/host.test.ts`: `PluginHost` against fixture directories in a temp
  dir with fixture `.ts` modules (written by a helper) that record imports, activations and
  deactivations in a marker file: SC-4, SC-5, SC-8, SC-9 (both directions), SC-11, SC-17, SC-23
  (with a short timeout), SC-24.
- `packages/daemon/test/plugins/api.test.ts`: through `startHarness` and a real client: SC-1,
  SC-2, SC-3, SC-6, SC-7, SC-10, SC-16 (including a stop and a second `startDaemon` on the same
  home, and the `plugin.changed` events), SC-18, SC-21, SC-22, and that `status.get` still answers
  while a plugin is failing (SC-23).
- `packages/cli/test/plugin.test.ts` (or new cases in `cli.e2e.test.ts`): each `quirky plugin`
  command against `FakeDaemon`: the params it sends, table and `--json` output, and the non-zero
  exit for an RPC error (SC-21).
- `apps/desktop/test/paths.test.ts`: the new key, in dev and packaged layouts.

## Non-goals

Everything the logic spec's [Scope & non-goals](logic.md#scope--non-goals) excludes, plus:
copying `plugins/` into the packaged app's resources (no built-ins exist until m0-port-v1, which
adds the copy step), and any kind-specific validation of contribution data.
