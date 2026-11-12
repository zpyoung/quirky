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
- [`ProcessRunner`, `RunOptions` and `RunResult`](../packages/protocol/src/process.ts): daemon plugin subprocess commands, their options, and the results they resolve with.
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

API 1.2 adds `whenSetting` to `setting`, `command` and `keybinding`, and an optional manifest
`repository`. A `command` or `keybinding` with `whenSetting` leaves the UI model while that setting
is not `true`; a keybinding bound to a hidden command is unbound. A `setting` with `whenSetting`
stays in the model and in `setting.list`, which reports the field, so its value stays readable. For
a `setting` with `"menu": "view"`, the native View menu row appears, and can be toggled, only while
the named setting is `true`. `repository` is an `https://github.com/<owner>/<repo>` URL with exactly
those two path segments; the manifest loader rejects any other shape, and `plugin.list` returns it.
A plugin that uses either declares `"apiVersion": "1.2.0"`.

API 1.3 adds optional `coalesce` and `worktree` fields to event declarations and event overrides.
`coalesce` lists up to four distinct key paths into event data. Each path has one to four
dot-separated identifier segments (`[A-Za-z_][A-Za-z0-9_]*`). The coalescing key includes the event
type, any valid worktree tag, and the values at those paths; an empty list still separates emits by
event type and worktree tag. The kernel sends the first emit for a key immediately, then sends only
the latest held emit when the 250 ms window ends. A held emit can arrive after later events from
another key or event type.
`emit` returns `true` when the event is sent or held, and `false` when disabled or overridden.
`worktree` names a key path containing the worktree ID; a non-empty string there is copied to the
event envelope's `worktreeId` without changing which clients receive it. Held events are dropped
when their plugin unloads. A plugin that uses either field declares `"apiVersion": "1.3.0"`.
A held event keeps a reference to the emitted payload; a plugin must not mutate it after `emit`.

`quirky.session-info/changed`, `quirky.git/changed`, `quirky.git/reviewChanged` and
`quirky.git/notesChanged` coalesce. `quirky.editor/changed` coalesces with one key for the
daemon, and `quirky.editor/explorerChanged` coalesces per worktree and still carries its
worktree tag. Editor clients refresh after their own actions rather than waiting for an event.
`quirky.terminal/title` and `quirky.terminal/cwd` coalesce per `sessionId`; a listener that needs
every title reads `context.pty.onFact`. `quirky.session/changed`, `quirky.agent-status/changed`
and `quirky.agent-status/settled` carry a worktree tag and are not coalesced, because daemon
listeners act on the states in between.

### API 1.4: Process runner

API 1.4 adds `context.process` to daemon plugin contexts. `context.process.run(argv, options)`
resolves with a `RunResult` for any exit code, including nonzero, and when a command is stopped
by timeout, abort or output overflow, or cannot start (reported in `spawnError`). It rejects for
bad arguments, a disposed runner, output that never ends after the command exits, or unexpected
pipe/child-exit failures. For those unexpected failures, it kills the process group and rejects
with the original error.

`cwd` defaults to the daemon's working directory. `env` is the whole child environment: it
defaults to `process.env` at call time, and a supplied value is not merged with it. The deadline
defaults to 30 seconds. The host kills the plugin's remaining children when its activation ends.
`deactivate` may still call `context.process.run`; the runner is disposed when deactivation
finishes. The object exposes only `run`; `spawn` is not part of API 1.4.

### API 1.5: Scoped UI subscriptions

API 1.5 adds `UiPluginContext.subscribe(listener, { worktreeId })`. A string leaves out plugin
events tagged with another worktree; `null` leaves out every tagged plugin event. Omitting the
option delivers every event. Untagged plugin events and all kernel events are always delivered,
even when their payload or a kernel event names another worktree. The scope is fixed at subscribe
time. A plugin that uses the option declares `"apiVersion": "1.5.0"`.

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

## Window workspace context

Use `context.getLayout().worktree` for the window's selected workspace, not
`layout.view.input.worktree`. Opening a view with a nonempty `input.worktree`
selects that workspace; explicitly passing `worktree: null` clears it.
Global views that omit the workspace retain the selection without receiving it
in their input, so opening Activity or Agent settings does not clear
workspace-scoped panels or change Activity filters.

Closing the last view clears the selection; revealing another workspace view
selects its workspace. Each window has its own selection. A new auxiliary
window starts with only the workspace explicitly supplied in its view input.
View input remains the source for a view-specific target or filter, rather
than the window's current selection.

## Compatibility and diagnostics

A host supports a declared floor only when the target and host have the same major and the target is no newer than the host, compared numerically. Thus a 1.0.0 host accepts 1.0.0; a later 1.x host accepts earlier 1.x floors. A 1.0.0 host refuses 1.1.0, and a 2.x host does not treat 1.x as compatible.

The daemon validates manifests during discovery, inspection and installation. A malformed declaration makes that plugin invalid; direct or distro inspection/installation uses the existing invalid-parameter error path. Missing, wrong-type or empty values receive field diagnostics; malformed strings identify `apiVersion` and the required stable version shape; unsupported targets identify both the target and host release. No plugin entrypoint is imported to diagnose a floor, and no production default upgrades a missing declaration.

Local module hosts check the declaring plugin's floor independently. The CLI checks module-backed command metadata before importing a CLI module; generic RPC-only CLI commands do not need a local module gate. The UI host checks each plugin's module metadata before import and contains a failure to that plugin. The daemon's release does not authorize newer code in an older CLI or UI process.

## Lifecycle, cleanup and trust

The stable contract includes the existing daemon, CLI and UI activation shapes, context methods, contribution schemas and cleanup behavior. Daemon `activate(context)` may return an activation disposer; modules may also implement `deactivate()`. UI modules implement `activate(context)` and may implement `deactivate()`. UI mount functions return cleanup functions when they own DOM or other mounted resources. Context subscription methods return unsubscribe functions. Plugins should release resources they create and must not assume a context remains usable after its activation ends.

The daemon also calls `deactivate()` after an `activate()` that threw or timed out, so it must cope with partial setup. The daemon retries a failed plugin on a delay from 1 second to 5 minutes; `quirky plugin activate <id>` retries immediately, including its dependencies.

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

Plugin API **1.1.0** adds Native page requests to `UiPluginContext.nativeBrowser`: `pageRequestsAvailable`, the `onPageRequest`, `onPageRequestExpired` and `onDownload` mount options, and the handle's `answer()` and `cancelDownload()`. All of them are optional, so 1.0.0 plugins are unaffected.

Use SemVer for future Plugin API releases: increment the **major** for incompatible author-contract changes, **minor** for backward-compatible author-facing additions, and **patch** for backward-compatible corrections. Set a plugin's `apiVersion` to the earliest stable release that supplies every API feature it uses. Hosts compare that minimum against their own `PLUGIN_API_VERSION`; they do not infer a floor from the package, application, daemon, wire or catalog version.

## Releases since 1.0.0

- **1.1.0** adds `UiPluginContext.nativeDropPaths(files)`: the original absolute paths of an OS file
  drop the window just received, or null where the desktop shell can't report them (browser
  shells, Linux, Windows, runtimes without the capability). A plugin that calls it declares
  `apiVersion` 1.1.0.
- **1.2.0** adds an optional `hue` to `panel`, `sidebar-section` and `activity-item`: one of the
  names in [`UI_TOOL_HUES`](../packages/protocol/src/tool-hues.ts), used to color the tool's icon. A
  plugin that sets it declares `apiVersion` 1.2.0.
- **1.3.0** adds optional `coalesce` and `worktree` fields to event declarations and overrides. The
  kernel sends the first emit immediately and only the latest held emit per key at the end of a
  250 ms window; held emits can arrive after events from other keys, and are dropped when the plugin
  unloads. A declared worktree path with a non-empty string is copied to the event's `worktreeId`.
  A plugin that uses either field declares `apiVersion` 1.3.0.
- **1.4.0** adds `context.process.run(argv, options)` for daemon plugins. It resolves for any exit
  code, including nonzero, timeout, abort, output overflow and spawn errors. It rejects bad
  arguments, a disposed runner, stalled output after exit, and unexpected pipe/child-exit
  failures. Defaults are the daemon's working directory, `process.env` at call time (a supplied
  environment replaces it) and a 30-second deadline. Children are killed when activation ends;
  `deactivate` may still call `run`. Only `run` is exposed; `spawn` is not part of this release.
  A plugin that uses it declares `apiVersion` 1.4.0.
- **1.5.0** adds optional worktree scoping to `UiPluginContext.subscribe`. Untagged plugin events
  and kernel events remain unfiltered. A plugin that uses the option declares `apiVersion` 1.5.0.

## Example

The [sample distro README](../distros/sample/README.md) walks through inspection, installation, UI state and removal. Its [bundled sidebar manifest](../distros/sample/sample.sidebar/quirky-plugin.json) is a complete small example of an API 1.0 declaration.
