# Plugin API 1.0

## Status & amendments
Approved autonomously under LOOP.md. Tech spec: requested (public contract, loader, CLI catalog, and distribution cross subsystem boundaries).

**Amendments:** 2026-10-28 — accepted spec-review F1: propagate each plugin's floor to independently executing UI/CLI hosts and reject locally before importing, including already-connected older clients of a newer daemon. Actual stock-UI verification additionally requires disabling the sidebar-extras Source Control activity and editor Source Control command/keybinding in the sample pack; removing the pack restores these with the Git panel.

## Goal and scope
Freeze the existing plugin-author contract as API **1.0.0**, require every plugin to declare the minimum stable API release it needs, refuse incompatible code before execution, and publish the existing sample distro as a documented, installable repository artifact. This item owns API freeze, not another parity sweep.

Non-goals: a registry service, network publication or pushing a release, automatic updates, a new sandbox, changing feature behavior, changing the JSON-RPC handshake, adding a distro-level API requirement, or certifying all earlier parity/native scenarios. No feature docs are assigned to this item, so there are no additional Orca-defect scenarios.

## Conceptual model and data flow
The host exposes a stable plugin API release independently of its app version, wire-protocol version, catalog schema version, and each plugin's own version. A plugin manifest declares `apiVersion`, a minimum stable release. The daemon validates it through the shared manifest parser during discovery, inspection, direct installation, and distro inspection/installation, before importing any plugin module. Supported manifests enter the existing lazy activation and contribution lifecycle unchanged. Installed code without the declaration is invalid, not silently upgraded. UI module metadata and CLI command entries carry the declaring plugin's floor; each local executing host checks against its own API release before importing. A newer daemon cannot authorize newer-context code to execute in an older UI/CLI.

The sample remains `distros/sample`, a pack of one UI plugin which overrides the stock worktree sidebar and disables `quirky.git` plus the independently owned Source Control activity, editor command and keybinding. Installation, introspection and removal use existing public CLI/API paths. Repository publication means committed source and author-facing instructions; no remote or external registry is required or authorized.

## Key decisions & rationale
Recommended: a required stable SemVer minimum with same-major compatibility. The 1.0.0 host accepts 1.0.0; a later 1.x host retains older 1.x contracts. Reject another major, any release newer than the host, ranges, shorthand, prereleases and build suffixes. This makes missing capabilities fail before code executes and fulfills m0-registry D15's version-floor intent.

Rejected: exact-match-only versions (would force needless edits for compatible updates); ranges/npm engine syntax (adds a dependency and ambiguous downgrade behavior); optional default to 1.0.0 (silently blesses unstable plugins). Keep strict unknown manifest fields per m0-registry D14: additions requiring new fields require a newer API floor. Additive fields in the API catalog do not change its existing schema version.

## Decisions locked
- **Versioning:** `apiVersion` is a required string containing a canonical stable `major.minor.patch` triple, components nonnegative safe integers with no leading zeroes. Compatibility is equal major and target no newer than host. Plugin API starts at 1.0.0.
- **Errors and recovery:** missing, wrong-type/empty, malformed and unsupported declarations receive field-specific diagnostics. Discovery invalidates only that plugin; install/inspect rejects with existing InvalidParams errors. No entrypoint code is imported. An incompatible bundled plugin prevents the entire distro install before state is changed. Authors migrate explicitly.
- **Response format:** `api.describe` and thus `quirky api --json` include `pluginApiVersion: "1.0.0"`. Existing protocol/catalog/app versions remain separate.
- **Documentation and publication:** the public reference identifies daemon/UI/CLI contexts, manifests/contributions, lifecycle/override behavior, stable import boundary and compatibility policy. Existing source declarations remain the complete type reference. The sample's manifest targets 1.0.0 and a README gives CLI inspect/install/state/remove commands and observable expectations.
- **Trust, authentication, updates:** no changes to full-trust plugins, confirmation via `--yes` or existing ask, safe mode, selector authority, override IDs or explicit reinstall policy.
- **Platform:** build and verify on macOS only; Linux/Windows native behavior remains unverified and is recorded as deferred platform work, not silently claimed portable.

## Behavior and acceptance scenarios

### AC1: Compatible plugin and version discovery
Before: a stock daemon on an isolated home, a plugin directory declaring package version `7.3.2` and `apiVersion: "1.0.0"`, with a declared method.
Walkthrough: inspect and install through the daemon API with explicit `yes`; invoke its method; read `api.describe` and CLI `api --json`.
After: the method's real result is returned, lazy activation works, and the catalog reports pluginApiVersion 1.0.0 independently of package/daemon/protocol versions.

### AC2: Refuse incompatible code before import
Before: plugin directories with absent, empty, non-string, malformed (`1`, `^1.0.0`, `01.0.0`, prerelease/build metadata), future minor/patch or different-major API targets. An entrypoint would write an observable marker if imported.
Walkthrough: discover, inspect/install via API; attempt activation for the discovered invalid plugin.
After: diagnostics name apiVersion and, for unsupported targets, both target and host. No entrypoint marker, method, copied installation or installation event is created. Other valid plugins still operate. Parser boundary tests cover unsafe integer components and whitespace as malformed.

### AC3: Distro compatibility is preflighted
Before: a valid installed distro or stock state; another distro contains an incompatible bundled plugin and settings/disables.
Walkthrough: inspect/install it via the daemon API.
After: InvalidParams names the bundled plugin/API mismatch. Existing distro, settings, plugin directories and effective contributions are unchanged; no bundled code executes.

### AC4: Published sample installs and reverts
Before: the checked-in `distros/sample` and a daemon with real stock built-ins in a fresh home.
Walkthrough: CLI `distro inspect`, `distro install … --yes`, `ui state --json`, catalog introspection, then `distro remove sample --yes` and inspect state again.
After install: the flat worktree sidebar is owned by sample.sidebar; source-control contribution and git CLI group are absent. After removal: the stock sidebar and source-control/git group return. The bundled UI module is usable through the existing declared UI API; existing sample UI exit coverage exercises the rendered surface.

### AC2b: Version-skewed local module hosts fail closed
Before: a 1.0.0 CLI or UI receives module metadata from a newer daemon requiring 1.1.0 (or metadata missing/malforming the floor). The module has an observable import side effect.
Walkthrough: invoke its CLI command or mount/activate its UI contribution.
After: the local host reports incompatibility without importing or activating the module. Supported 1.0.0 modules continue to execute. Missing metadata is not defaulted to the local/daemon release, and failures remain contained to the affected plugin/command.
### AC5: Clean declaration cutover

Every shipped built-in and bundled example plugin declares apiVersion 1.0.0. Test plugin factories/fixtures explicitly produce current manifests while preserving raw malformed-manifest tests. Existing manifest/lifecycle/distro/CLI tests and compile-time consumers continue to work. Historical specs/decision logs remain historical records, superseded explicitly by this item rather than rewritten.

## Industry insights
Repository-first research: roadmap.md M7; m0-registry D14-D15; m0-core D26-D30; actual protocol declarations and shared parser/install paths. No external research swarm: the loop's research inputs are the roadmap and binding decisions. The compatibility floor preserves older consumers rather than equating API, wire and package versions.

## Deferred ideas
None. A plugin marketplace, network release and version-range expression support are not required flows of this item.

## Glossary
- **Plugin API:** the stable author-facing daemon, UI and CLI context/module contracts and manifest/contribution rules.
- **API floor:** the earliest stable API release a plugin requires, not its own package release.
- **Wire protocol:** client/daemon transport handshake version; deliberately independent.
- **Distro:** a manifest and plugin pack layered onto stock Quirky, removable without rewriting user choices.

## Self-review
All five scenarios have explicit before/action/after examples; error cases precede activation and mutation; no human decisions or unspecified release destination remain. Existing install/override/safe-mode rules are preserved. Contract declarations, runtime enforcement, clean fixture cutover and sample documentation are separate implementation scopes.
