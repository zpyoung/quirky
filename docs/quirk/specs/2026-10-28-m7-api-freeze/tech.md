# Plugin API 1.0 technical specification

Status: approved autonomously under LOOP.md; [logic specification](logic.md). Paths below are relative to repository root `/Users/zpyoung/orca/workspaces/quirky/build-lane-12` and resolve identically within implementer worktrees.

## Architecture
Implements [conceptual model](logic.md#conceptual-model-and-data-flow). `@quirky/protocol` root re-exports `plugins.ts`, `ui.ts`, `cli.ts`, `catalog.ts` and `distro.ts`. Runtime loading already converges on `packages/daemon/src/plugins/manifest.ts:parseManifest`, called by `discover.ts` and `install.ts:readSource`; `distros.ts` inspects all bundled plugins before copying. Preserve those entrypoints rather than adding a second compatibility gate. The daemon builds `ApiDescription` in `packages/daemon/src/methods.ts`; the CLI spreads it into `ApiCatalog`.

## Code references
For [AC1–AC5](logic.md#behavior-and-acceptance-scenarios):
- `packages/protocol/src/plugins.ts:PluginContext`, `PluginModule`, `PluginManifest` (currently lines 51, 454, 460): add exported `PLUGIN_API_VERSION` and required manifest field. Root barrel already exports this file.
- `packages/protocol/src/ui.ts:UiPluginContext`, `UiPluginModule` (lines 284–368) and `src/cli.ts:CliContext`, `CliModule` (lines 1–38): stable author-facing surfaces; document, do not redesign.
- `packages/protocol/src/catalog.ts:ApiDescription` (line 52) and `src/kernel-schemas.ts:apiDescription` (line 237): expose the host API release in catalog data/schema.
- `packages/daemon/src/plugins/manifest.ts:FIELDS`, `requiredString`, `parseManifest` (lines 15, 38, 238): strict field allowlist and aggregate validation errors.
- `packages/daemon/src/plugins/install.ts:readSource`, `inspectPlugin` (lines 46, 104); `discover.ts:discoverPlugins`; `distros.ts:DistroService`: consume that shared parser without alternate compatibility rules.
- `packages/daemon/test/plugins/{manifest,discover,install,distros,api-describe}.test.ts`, `fixtures.ts`, and `registry.test.ts`: existing behavior tests and data factories.
- `packages/ui/test/exit.e2e.test.ts` (lines 12–24, 54–63, 99–136): existing CLI sample installation/removal plus headless UI coverage.
- `distros/sample/{quirky-distro.json,sample.sidebar/quirky-plugin.json,sample.sidebar/ui.js}`: published repository artifact, preserve stable override IDs.
- Other literal plugin fixtures under `plugins/*/test`, `apps/desktop/test`, and shared test support must migrate with their serialized manifests. Use searches for `quirky-plugin.json`, `PluginManifest`, and manifest builder calls; do not change unrelated model versions.

## Contracts & interfaces
Implements [decisions locked](logic.md#decisions-locked).

CONTRACT:
```ts
export const PLUGIN_API_VERSION = '1.0.0'
// PluginManifest gains a required field; not a literal type so newer hosts can accept older floors.
apiVersion: string
// ApiDescription gains a required host-release field, inherited by ApiCatalog.
pluginApiVersion: string
```

- The target parser accepts exactly three canonical unsigned decimal components (zero or no leading zeroes), each a safe integer. No whitespace, prefix, suffix, range, sign, leading zero, prerelease or build metadata. Compare numeric major/minor/patch, not lexicographic strings.
- Compatibility: target major equals host major; target minor/patch is lexicographically no newer than the host. The constant is the single source for runtime validation and catalog output.
- Missing apiVersion uses the existing requiredString missing-field diagnostic. Empty/non-string uses its existing field-type diagnostic. Malformed strings name apiVersion and the required stable major.minor.patch shape. Unsupported strings name target and host release. Error wording is not otherwise frozen.
- Parsing executes no plugin code and preserves aggregate reporting. Unsupported discovery stays invalid; direct/distro inspection and installation use existing InvalidParams behavior. No compatibility default or fallback is permitted in production.
- `api.describe` reports pluginApiVersion without activation. `CATALOG_SCHEMA_VERSION` stays 2 because this is additive. `PROTOCOL_VERSION` stays 2; the handshake is untouched.

## Data models / schemas
Implements [AC1](logic.md#ac1-compatible-plugin-and-version-discovery) and [AC5](logic.md#ac5-clean-declaration-cutover). `quirky-plugin.json` adds required apiVersion. All built-ins and sample bundled plugins use the literal `1.0.0`; do not change plugin package versions. `quirky-distro.json` is unchanged. The catalog schema lists pluginApiVersion as required string. Test factories may have a current-version default only in test code and must allow explicit missing/invalid declarations, including raw strings, for negative coverage; never inject versions into production manifest readers.

## DO-NOT-CHANGE fences
Implements [scope](logic.md#goal-and-scope).
- `docs/loop/LOOP.md`, `scripts/build-loop/**`, `docs/loop/queue.json`, `docs/loop/DECISIONS.md`: protected loop machinery and queue-owned state.
- `packages/protocol/src/rpc.ts:PROTOCOL_VERSION` and client.hello request/result: the wire contract is not the plugin API.
- Existing stable contribution IDs, trust/authority, confirmation, safe-mode, lazy activation and explicit-reinstall behavior: frozen existing semantics, not new feature scope.
- Existing historical specs and decisions: immutable historical choices; add this item's superseding decision instead of revising them.
- Real home/config state and external feature research directories: tests use fresh homes and cleanup owned children only.

## Always / Ask / Never
Implements [decisions locked](logic.md#decisions-locked). Always reuse the shared parser, migrate distributed manifests and author-facing docs, preserve lifecycle cleanup, and keep malformed inputs testable. Resolve questions autonomously and record them in this item's decision log. Never prompt a person, invent a release server, push, conflate version domains, add compatibility shims, or run build/tests/lint/formatters inside implementer tasks. The integration owner runs verification after all slices return.

## Cross-cutting
Implements [AC2](logic.md#ac2-refuse-incompatible-code-before-import) and [AC3](logic.md#ac3-distro-compatibility-is-preflighted). Full-trust code is unchanged but incompatibility must fail before import. Install rejection cannot mutate installed code/distro layers. Missing pre-freeze declarations require explicit author migration; there is no automatic rewrite or update. Reverting this commit is the source rollback, not a persisted schema migration. Only macOS checks are claimed.

## Testing strategy
Implements [acceptance scenarios](logic.md#behavior-and-acceptance-scenarios).
- Parser tests cover current, missing/type/empty/malformed/unsafe/future/different-major inputs; assert accepted values and semantic error categories, not whole incidental text.
- Real daemon API tests demonstrate accepted method activation, incompatible inspection/install refusal without marker/copy/state change, invalid discovered plugin containment, and bundled incompatibility rejection without distro mutation.
- Existing sample CLI/UI exit test exercises the actual pack. Extend only consumer-visible coverage (version introspection, inspect/install/state/remove), not tests of copied fields or source text.
- Required integration commands: `bun scripts/suite.ts packages apps plugins`, `bun test scripts`, `bun run typecheck`. Use the canonical integration checkout's suite runner if the worktree copy is stale, without modifying protected scripts. Run targeted files first and smoke the actual CLI against a fresh temporary home. Follow LOOP.md for the one final review round and accepted-finding fix batch.
- Public signature additions are committed before implementers. LSP references were attempted for PluginManifest and returned no language server; use literal reference search plus whole-repo typecheck to catch typed consumers.

## Non-goals
As [logic scope](logic.md#goal-and-scope): no feature parity reimplementation, network publishing, marketplace, native-window changes, distro API field, version-range expressions, or public import reorganization. The protocol package's own release number and app version are not changed solely to advertise plugin API 1.0.0.
