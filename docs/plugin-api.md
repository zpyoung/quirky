# Plugin API 1.0

Plugin API 1.0 freezes Quirky's existing author-facing plugin contract at **1.0.0**. A plugin manifest declares the minimum stable API release it requires; compatible hosts accept it, and incompatible hosts refuse the plugin before executing its entrypoints.

## Stable imports and types

For TypeScript types, use the root `@quirky/protocol` export. Do not import implementation files from `packages/*/src` or depend on Quirky's private kernel or renderer modules. Plugins receive host services through their activation context; the API release does not promise new capabilities beyond the declarations that exist today.

The freeze covers the public declarations and their referenced contract types, including:

- [`PluginManifest`, `PluginContext` and `PluginModule`](../packages/protocol/src/plugins.ts): daemon entrypoints, manifest fields, activation services and contribution declarations.
- [`UiPluginContext` and `UiPluginModule`](../packages/protocol/src/ui.ts): UI modules, contribution providers, rendering and context services. The current UI contribution kinds are the `UI_KINDS` declared there.
- [`CliContext` and `CliModule`](../packages/protocol/src/cli.ts): module-backed CLI command handlers.
- [`ApiDescription` and CLI catalog entries](../packages/protocol/src/catalog.ts): published daemon API and command metadata.
- [`PLUGIN_API_VERSION` and compatibility rules](../packages/protocol/src/plugin-api.ts): the host API release and stable-floor comparison.
- [Protocol JSON schemas and daemon manifest parsing](../packages/protocol/src/kernel-schemas.ts)
  and [the manifest parser](../packages/daemon/src/plugins/manifest.ts): accepted manifest and contribution data.

Contribution IDs keep the form `kind:plugin-id/name`. API 1.0 freezes the existing contribution kinds, declaration schemas, ID rules, override behavior and lifecycle contract. The linked declarations and schema validators remain the detailed reference for each field and transitive type; this guide does not freeze private kernel or renderer DOM structures.

The current UI kind identifiers are `status-bar`, `sidebar-section`, `activity-item`, `panel`,
`view`, `overlay`, `command`, `keybinding`, `setting`, `settings-section`, `theme` and
`menu-item`. Daemon method/event declarations and CLI command declarations are part of the same
frozen contract; their exact schemas remain in the linked protocol declarations.

API 1.1 adds `whenSetting` to `panel`, `sidebar-section` and `activity-item`: the name of one of
the plugin's own boolean settings. The contribution, and the tool it projects, exist only while that
setting is `true`. A plugin that uses it declares `"apiVersion": "1.1.0"`.

## Manifest declaration

Every plugin manifest must include `apiVersion`. It is independent of the plugin's own package `version`:

```json
{
  "id": "acme.example",
  "name": "Example sidebar",
  "version": "2.3.0",
  "apiVersion": "1.0.0",
  "ui": "ui.js",
  "contributes": {
    "sidebar-section": [
      { "id": "worktrees", "title": "Worktrees" }
    ]
  }
}
```

`apiVersion` is a minimum stable API release in canonical `major.minor.patch` form. Each component is a nonnegative safe integer with no leading zeroes except `0`. Ranges, shorthand versions, whitespace, prereleases and build suffixes are not accepted.

### UI command palette visibility

UI command declarations may include an optional `palette` boolean:

```json
{
  "contributes": {
    "command": [
      { "id": "open", "title": "Open", "palette": true },
      { "id": "control", "title": "Control", "palette": false }
    ]
  }
}
```

Omitting `palette` is equivalent to `true`. `false` hides the command from the
command palette only: it remains an effective UI command, can still be invoked
through UI command routing, and can still be bound to a keybinding.
Non-boolean values are invalid.

## Compatibility and diagnostics

A host supports a declared floor only when the target and host have the same major and the target is no newer than the host, compared numerically. Thus a 1.0.0 host accepts 1.0.0; a later 1.x host accepts earlier 1.x floors. A 1.0.0 host refuses 1.1.0, and a 2.x host does not treat 1.x as compatible.

The daemon validates manifests during discovery, inspection and installation. A malformed declaration makes that plugin invalid; direct or distro inspection/installation uses the existing invalid-parameter error path. Missing, wrong-type or empty values receive field diagnostics; malformed strings identify `apiVersion` and the required stable version shape; unsupported targets identify both the target and host release. No plugin entrypoint is imported to diagnose a floor, and no production default upgrades a missing declaration.

Local module hosts check the declaring plugin's floor independently. The CLI checks module-backed command metadata before importing a CLI module; generic RPC-only CLI commands do not need a local module gate. The UI host checks each plugin's module metadata before import and contains a failure to that plugin. The daemon's release does not authorize newer code in an older CLI or UI process.

## Lifecycle, cleanup and trust

The stable contract includes the existing daemon, CLI and UI activation shapes, context methods, contribution schemas and cleanup behavior. Daemon `activate(context)` may return an activation disposer; modules may also implement `deactivate()`. UI modules implement `activate(context)` and may implement `deactivate()`. UI mount functions return cleanup functions when they own DOM or other mounted resources. Context subscription methods return unsubscribe functions. Plugins should release resources they create and must not assume a context remains usable after its activation ends.

Manifest activation policy, dependencies, stable contribution IDs, schemas, overrides and existing cleanup semantics remain in effect. Plugin API compatibility is not a security boundary: plugins are full-trust code, not sandboxed. Install only code you trust; `--yes` skips the existing confirmation prompt but does not reduce the plugin's authority.

## Version domains and evolution

The plugin API release is separate from other version numbers:

- **Plugin API (`apiVersion`):** the minimum author-facing host contract a plugin requires.
- **Plugin package `version`:** the release of that plugin's own code.
- **Protocol package version (`@quirky/protocol`):** release of the package; it is not the Plugin API release.
- **Application version:** release of the Quirky app.
- **Daemon version:** the running daemon build reported as `daemonVersion` in `ApiDescription`.
- **Wire protocol version:** the client/daemon transport contract; Plugin API 1.0 does not change the handshake or protocol version.
- **Catalog schema version:** the shape version of `ApiDescription` and `ApiCatalog`; `pluginApiVersion` is additive and the catalog schema remains 2.

Use SemVer for future Plugin API releases: increment the **major** for incompatible author-contract changes, **minor** for backward-compatible author-facing additions, and **patch** for backward-compatible corrections. Set a plugin's `apiVersion` to the earliest stable release that supplies every API feature it uses. Hosts compare that minimum against their own `PLUGIN_API_VERSION`; they do not infer a floor from the package, application, daemon, wire or catalog version.

## Example

The [sample distro README](../distros/sample/README.md) walks through inspection, installation, UI state and removal. Its [bundled sidebar manifest](../distros/sample/sample.sidebar/quirky-plugin.json) is a complete small example of an API 1.0 declaration.
