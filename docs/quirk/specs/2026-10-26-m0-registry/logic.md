# Plugin kernel: manifests, loading, lazy activation and the contribution registry

## Status & amendments

**Status:** Approved (headless build loop; decisions in [m0-registry.md](../../../loop/decisions/m0-registry.md)). Tech spec: requested.

**Amendments:** none yet.

## Conceptual model

Quirky's features are going to be plugins, built-in and third-party alike, on one API
([roadmap.md](../../../roadmap.md#what-the-order-rests-on)). This item builds the part every later
item stands on: how `quirkyd` finds plugins, decides which of their contributions are in effect,
and loads a plugin's code only when something needs it.

A **plugin** is a directory holding a manifest. The manifest names the plugin, says what it
**contributes** (commands, views, methods and so on, each with a short name), which other
plugins' contributions it **overrides**, which contribution IDs it **disables**, which plugins it
**depends on**, and whether it activates lazily or at startup. A plugin may also have a daemon
code module, which is imported only when the plugin activates.

Every contribution has a **stable ID** of the form `<kind>:<pluginId>/<name>`, such as
`command:quirky.scm/commit`. The kernel builds the ID from the plugin's own ID and the short
name, so a plugin can only create IDs in its own namespace. To replace someone else's
contribution, a plugin lists that full ID under its overrides.

The **registry** is what the kernel derives from all manifests plus the user's disabled list. For
each ID it holds every declaration, picks the one **in effect**, and records why the rest aren't:
overridden, disabled, or rejected in a conflict. It is computed from manifests alone, so listing
contributions, overriding them and disabling them never runs plugin code.

**Activation** imports a plugin's module and calls it, so the plugin can provide implementations
for the contributions it declared. A lazy plugin activates the first time one of its in-effect
contributions is resolved, or when asked to through the API. Its dependencies activate first. A
plugin whose contributions are all overridden or disabled is never loaded.

## Data flow

At startup `quirkyd` reads every manifest from the built-in plugins directory and from
`<QUIRKY_HOME>/plugins/`, and the disabled list from its store. It validates each manifest, checks
dependencies, and computes the registry. It then activates the `startup` plugins and, once they
have settled, publishes `runtime.json`, so a client that connects sees settled states.

When later kernel code needs a contribution (a command to run, a method to call, a view to
show), it resolves the ID. The registry finds the declaration in effect and makes sure its plugin
is active, activating dependencies first, and hands back the declared data with the implementation
the plugin provided.

When the user or an agent enables or disables an ID through `quirky plugin` or the `plugin.*`
methods, the kernel saves the disabled list, recomputes the registry, deactivates any active
plugin that just became disabled, and sends a `plugin.changed` event. No restart is involved.

When the daemon stops, it deactivates active plugins in the reverse of the order they activated.

## Key decisions

Each is logged in full, with options and evidence, in the item's decision log
([m0-registry.md](../../../loop/decisions/m0-registry.md)).

- **Declarative contributions with lazy code** ([D12](../../../loop/decisions/m0-registry.md)). Three
  approaches were weighed:
  1. **Declared in the manifest, code loaded on first use** (chosen). Listing, overriding and
     disabling need no code, and an unused plugin costs nothing. The price is that a plugin can't
     add contributions at runtime.
  2. **Code-first registration**: every plugin module is imported at startup and registers what it
     contributes. This is simpler for authors, but every plugin costs memory at startup and the
     install screen can't list contributions without running code.
  3. **Hybrid**: the manifest lists triggers only, and code registers contributions after
     activation. Disabling or overriding a contribution then requires loading its plugin first.
- **IDs carry the kind and the owner** ([D4](../../../loop/decisions/m0-registry.md)), and `quirky.` is
  reserved for built-in plugin IDs ([D5](../../../loop/decisions/m0-registry.md)).
- **Overrides are explicit and replace the whole contribution**
  ([D6](../../../loop/decisions/m0-registry.md), [D7](../../../loop/decisions/m0-registry.md)).
- **The winner never depends on load order** ([D8](../../../loop/decisions/m0-registry.md)): an
  installed plugin beats a built-in, a dependent beats its dependency, and otherwise the plugin
  whose ID sorts first wins and the loser gets a conflict diagnostic.
- **Disabled beats everything** and applies live ([D9](../../../loop/decisions/m0-registry.md),
  [D10](../../../loop/decisions/m0-registry.md)).
- **A bad plugin never takes down the daemon or other plugins**
  ([D13](../../../loop/decisions/m0-registry.md)).

## Behavior & scenarios

The fixtures are illustrative. "Built-in" means found in the built-in plugins directory, and
"installed" means found under `<QUIRKY_HOME>/plugins/`. Every scenario is driven through the
`plugin.*` daemon methods or the `quirky plugin` CLI, except SC-5 and SC-17, which are kernel
paths that later items reach through their own methods ([D22](../../../loop/decisions/m0-registry.md)).

### Discovery and IDs

1. **SC-1: plugins from both places are listed**
   - **Given** a built-in plugin `quirky.sample` and an installed plugin `acme.tools`
   - **When** a client lists plugins
   - **Then** both are listed with their name, version, source (built-in or installed), state and diagnostics; neither has activated
   - **Data before:** **Built-in dir**: `quirky.sample` v0.1.0*; **Plugins dir**: `acme.tools` v1.2.0*
   - **Walkthrough:**
     1. The agent runs `quirky plugin list`
   - **Data after:** ✓ `quirky.sample`, built-in, inactive; ✓ `acme.tools`, installed, inactive

2. **SC-2: own contributions get full IDs**
   - **Given** `acme.tools` contributes a command named `refresh` and a view named `panel`
   - **When** a client lists contributions
   - **Then** they appear as `command:acme.tools/refresh` and `view:acme.tools/panel`, each owned by `acme.tools`, with the data the manifest declared
   - **Walkthrough:**
     1. The agent runs `quirky plugin contributions --plugin acme.tools`
   - **Data after:** ✓ `command:acme.tools/refresh` (title "Refresh"*); ✓ `view:acme.tools/panel`

3. **SC-3: contributions can be filtered by kind**
   - **Given** the plugins from SC-2
   - **When** a client lists contributions of kind `command`
   - **Then** only command contributions are returned

### Activation

4. **SC-4: an unused plugin is never loaded**
   - **Given** `acme.tools` has a daemon module that records its import in a marker file
   - **When** the daemon starts and a client lists plugins and contributions
   - **Then** `acme.tools` is inactive and its module has not been imported
   - **Data before:** **Marker file**: absent
   - **Walkthrough:**
     1. The daemon starts
     2. The agent runs `quirky plugin list` and `quirky plugin contributions`
   - **Data after:** **Marker file**: ✓ still absent; **acme.tools**: inactive

5. **SC-5: resolving a contribution activates its owner, dependencies first**
   - **Given** `acme.tools` depends on `acme.base`, both lazy and inactive
   - **When** kernel code resolves `command:acme.tools/refresh`
   - **Then** `acme.base` activates, then `acme.tools`, and the resolve returns the command's declared data and the implementation `acme.tools` provided
   - **Walkthrough:**
     1. The kernel resolves `command:acme.tools/refresh`
     2. `acme.base` activates
     3. `acme.tools` activates and provides the implementation
   - **Data after:** **acme.base**: ✓ active; **acme.tools**: ✓ active; activation order ✓ base, then tools

6. **SC-6: a plugin can be activated through the API**
   - **Given** lazy `acme.tools` depending on `acme.base`
   - **When** the agent runs `quirky plugin activate acme.tools`
   - **Then** both are active, dependency first, and the command prints the plugin's new state

7. **SC-7: startup plugins are active when the daemon is reachable**
   - **Given** `acme.watch` declares startup activation
   - **When** the daemon starts and a client connects
   - **Then** `acme.watch` is already active

8. **SC-8: concurrent activation runs the plugin once**
   - **Given** lazy `acme.tools`
   - **When** two activations of it are requested at the same time
   - **Then** its activate function runs once and both requests see it active

9. **SC-9: a plugin can only provide what it declared**
   - **Given** `acme.tools` tries, during activation, to provide an implementation for `command:acme.tools/undeclared`
   - **When** it activates
   - **Then** activation fails, the plugin is `failed`, and its diagnostic names the undeclared ID. The reverse also holds: when a plugin activates without providing a contribution it declared, resolving that contribution's implementation fails with an error naming the plugin and the ID, never a bare "not found".

### Overrides

10. **SC-10: an installed plugin overrides a built-in contribution**
    - **Given** built-in `quirky.sample` contributes `view:quirky.sample/sidebar`, and installed `acme.sidebar` overrides that ID
    - **When** a client lists contributions
    - **Then** `view:quirky.sample/sidebar` is in effect with `acme.sidebar`'s data and owner; listing every declaration shows the built-in's declaration as overridden by `acme.sidebar`
    - **Data before:** **quirky.sample** declares the sidebar, title "Repos"*; **acme.sidebar** overrides it, title "Acme"*
    - **Walkthrough:**
      1. The agent runs `quirky plugin contributions`
      2. The agent runs `quirky plugin contributions --all`
    - **Data after:** in effect ✓ `view:quirky.sample/sidebar`, owner `acme.sidebar`, title "Acme"; all ✓ the `quirky.sample` declaration, overridden by `acme.sidebar`

11. **SC-11: resolving an overridden ID loads only the overriding plugin**
    - **Given** SC-10's plugins, both lazy
    - **When** kernel code resolves `view:quirky.sample/sidebar`
    - **Then** `acme.sidebar` activates and `quirky.sample` stays inactive

12. **SC-12: two plugins overriding the same ID have a deterministic winner**
    - **Given** installed `acme.one` and `acme.two` both override `view:quirky.sample/sidebar`, and neither depends on the other
    - **When** the registry is computed, whatever the order the directories are read in
    - **Then** `acme.one` wins because its ID sorts first; `acme.two`'s override is rejected, and `acme.two` carries a conflict diagnostic naming `acme.one`
    - **Data after:** in effect ✓ owner `acme.one`; **acme.two**: diagnostic "override of view:quirky.sample/sidebar conflicts with acme.one" ✓

13. **SC-13: a dependent's override beats its dependency's**
    - **Given** `acme.two` depends on `acme.one`, and both override `view:quirky.sample/sidebar`
    - **When** the registry is computed
    - **Then** `acme.two`'s override is in effect and there is no conflict diagnostic

14. **SC-14: an installed override beats a built-in override**
    - **Given** built-in `quirky.other` and installed `acme.zed` both override `view:quirky.sample/sidebar`
    - **When** the registry is computed
    - **Then** `acme.zed` wins, though `quirky.other` sorts first, and there is no conflict diagnostic

15. **SC-15: an override of an ID nobody declares still takes effect, with a warning**
    - **Given** `acme.sidebar` overrides `view:quirky.missing/sidebar`, which no plugin declares
    - **When** the registry is computed
    - **Then** the ID is in effect, owned by `acme.sidebar`, and `acme.sidebar` carries a warning that the override replaces nothing. When the target's plugin exists but is disabled, there is no warning.

### Disabling

16. **SC-16: a contribution can be disabled and re-enabled by ID, and it persists**
    - **Given** `command:acme.tools/refresh` is in effect
    - **When** the agent runs `quirky plugin disable command:acme.tools/refresh`, restarts the daemon, then runs `quirky plugin enable command:acme.tools/refresh`
    - **Then** after the disable the ID is not in effect (listing every declaration shows it disabled by the user), it stays disabled after the restart, and after the enable it is in effect again; each change sends a `plugin.changed` event
    - **Data before:** **Disabled list**: empty
    - **Walkthrough:**
      1. The agent disables the command
      2. The daemon restarts
      3. The agent lists contributions: the command is absent
      4. The agent enables the command
    - **Data after:** **Disabled list**: ✓ empty; the command ✓ in effect

17. **SC-17: a disabled contribution can't be resolved**
    - **Given** `command:acme.tools/refresh` is disabled
    - **When** kernel code resolves it
    - **Then** the resolve fails as not found, and `acme.tools` doesn't activate

18. **SC-18: disabling a plugin removes its contributions and disables its dependents**
    - **Given** `acme.tools` depends on `acme.base`, and `acme.base` is active
    - **When** the agent runs `quirky plugin disable acme.base`
    - **Then** `acme.base` is deactivated and disabled, `acme.tools` is disabled with a diagnostic naming `acme.base`, and neither plugin's contributions are in effect. Enabling `acme.base` again makes both inactive and their contributions in effect.
    - **Walkthrough:**
      1. The agent disables `acme.base`
      2. The kernel calls `acme.base`'s deactivate
    - **Data after:** **acme.base**: ✓ disabled; **acme.tools**: ✓ disabled, "dependency acme.base is disabled"

19. **SC-19: a plugin's own disables apply only while it is enabled**
    - **Given** `acme.minimal` disables `view:quirky.sample/scm`
    - **When** the registry is computed, then the agent disables `acme.minimal`
    - **Then** the view is disabled by `acme.minimal` at first, and in effect again once `acme.minimal` is disabled

20. **SC-20: disabled beats override**
    - **Given** `acme.sidebar` overrides `view:quirky.sample/sidebar`
    - **When** the agent disables `view:quirky.sample/sidebar`
    - **Then** the ID is not in effect at all, from either plugin

21. **SC-21: unknown IDs are refused**
    - **Given** no plugin or contribution named `acme.nope`
    - **When** the agent runs `quirky plugin disable acme.nope`, or `quirky plugin enable` of an ID that isn't disabled and doesn't exist
    - **Then** the command fails with a not-found error and a non-zero exit, and the disabled list is unchanged

### Bad plugins

22. **SC-22: an invalid plugin is reported and skipped**
    - **Given** one installed plugin for each problem: a manifest that isn't JSON, an unknown top-level field, a directory name that doesn't match the ID, an installed ID starting with `quirky.`, an installed ID that duplicates a built-in, a dependency that doesn't exist, and two plugins that depend on each other
    - **When** the daemon starts
    - **Then** each is listed as `invalid` with a diagnostic saying what is wrong (a cycle names every member), none of their contributions are in effect, and every valid plugin works normally
    - **Details:**

      | Problem | Diagnostic says |
      |---|---|
      | Not JSON | the manifest can't be parsed |
      | Unknown field `contribute` | unknown field `contribute` |
      | Directory `acme-x`, ID `acme.x` | directory name doesn't match the ID |
      | Installed `quirky.fake` | the `quirky.` prefix is reserved for built-ins |
      | Installed `quirky.sample` again | duplicates the built-in plugin |
      | Depends on `acme.ghost` | dependency `acme.ghost` is not installed |
      | `acme.a` and `acme.b` depend on each other | dependency cycle: acme.a, acme.b |

23. **SC-23: a failing activation is contained**
    - **Given** `acme.broken`'s activate throws, `acme.slow`'s never settles, and `acme.after` depends on `acme.broken`
    - **When** the agent activates each of them
    - **Then** `acme.broken` is `failed` with the error message; `acme.slow` is `failed` after the activation timeout; activating `acme.after` fails because its dependency failed; the daemon keeps answering other calls; and activating `acme.broken` again tries again
    - **Data after:** **acme.broken**: ✓ failed, "boom"*; **acme.slow**: ✓ failed, "activation timed out"; **acme.after**: ✓ failed, "dependency acme.broken failed to activate"

24. **SC-24: stopping the daemon deactivates plugins in reverse order**
    - **Given** `acme.base` then `acme.tools` activated
    - **When** the daemon stops
    - **Then** `acme.tools` deactivates before `acme.base`, and an error thrown by one deactivate doesn't stop the other

## Scope & non-goals

In scope: manifest format and validation, discovery from the two directories, the registry with
stable IDs, overrides and disables, lazy and startup activation of daemon modules, the disabled
list's persistence, and the `plugin.*` methods and `quirky plugin` commands that inspect and change
them.

Out of scope, each owned by a later item:

- **Kind schemas and real contribution kinds** (methods, events, store namespaces, scheduler,
  agent-launch hooks): m0-daemon-api. Until then the registry accepts any kind name and any
  fields in a contribution's data.
- **Webview-side plugin loading and UI slots:** m0-ui-api. The registry already lists UI
  contributions, since they are declared in the manifest.
- **Schemas for the `plugin.*` methods and a generated CLI:** m0-scripting.
- **Installing and uninstalling plugins, the install screen, distros, `--disable-plugins` safe
  mode and update policy:** m0-distros. Here, installed plugins are directories someone put in
  `<QUIRKY_HOME>/plugins/`.
- **Moving v1's features into built-in plugins:** m0-port-v1. This item ships no built-in plugins
  of its own; tests use fixtures.
- **Manifest API version declarations:** M7.
- **Event-based activation triggers:** added by whichever later item needs one.
- **Stopping a plugin that loops synchronously:** impossible in process, which the locked trust
  decision accepts.

## Decisions Locked

All decisions were made headless and are in the decision log with options, evidence and
confidence. The gray areas resolved:

- **Naming convention:** IDs are `<kind>:<pluginId>/<name>` (D4); `quirky.` is reserved (D5); the manifest is `quirky-plugin.json` and the directory name equals the ID (D16) — assumed — fast-tracked
- **Duplicate handling and conflict resolution:** explicit `overrides` list (D6); full replacement (D7); installed, then dependent, then ID order with a diagnostic (D8) — assumed — fast-tracked
- **Exception handling:** bad plugins are `invalid` or `failed` and contained, with a 10-second activation timeout (D13); disabling cascades to dependents (D9) — assumed — fast-tracked
- **Error responses:** unknown IDs return not found (D17) — assumed — fast-tracked
- **Versioning:** unknown top-level fields rejected (D14); no API version until M7 (D15, locked by roadmap.md)
- **Response format:** contributions list effective entries by default and every declaration with its status on request (D17) — assumed — fast-tracked
- **Activation:** lazy by default, `startup` opt-in, no wildcard (D11); declared contributions only (D12); startup plugins settle before `runtime.json` (D19) — assumed — fast-tracked
- **Storage:** the disabled list has its own table (D20); changes apply live (D10) — assumed — fast-tracked

## Industry Insights

- **Contributions should be the activation trigger, and wildcard triggers rejected.** VS Code
  discourages `*` and since 1.74 activates an extension from its contributed commands and views
  without extra declarations. https://code.visualstudio.com/api/references/activation-events
- **IDs carry kind and owner, and the namespace defaults to the plugin.** Backstage uses
  `kind:namespace/name`, and an override sets the target's namespace explicitly.
  https://backstage.io/docs/frontend-system/architecture/extensions/
- **An override is a new object under the same ID,** and Backstage does not document which of two
  colliding overrides wins, so precedence must be explicit.
  https://backstage.io/docs/frontend-system/architecture/extension-overrides/
- **Disable must work without loading code,** and dependents complicate it: VS Code users couldn't
  disable Azure extensions that others depended on. https://github.com/microsoft/vscode/issues/54621
  ; https://backstage.io/docs/frontend-system/building-apps/configuring-extensions/
- **Reject cycles and name every member.** Split ownership in Eclipse compiled and then failed at
  runtime. https://nirmalsasidharan.wordpress.com/2010/09/02/split-packages-an-osgi-nightmare/
- **Contain each plugin's failures and tag errors with its ID;** users couldn't find which
  extension crashed VS Code's host. https://github.com/microsoft/vscode/issues/274095 ;
  https://github.com/continuedev/continue/issues/6612
- **Declare an API floor** once the API is versioned (Obsidian plugins that under-declared
  `minAppVersion` broke at runtime), which M7 adds.
  https://github.com/philoserf/obsidian-metadator/issues/270
- **Manifest and code drift is the main cost of declaring contributions statically;** projects
  catch it with a check that cross-references code against the manifest, and VS Code's commonest
  failure is a declared command that was never registered ("command not found").
  https://github.com/cleat-team/cleat/issues/2656 ; https://github.com/microsoft/vscode/issues/48605
- **Lazy activation can miss events fired before load** (lazy.nvim #1049), so event triggers need
  care when a later item adds them. https://github.com/folke/lazy.nvim/issues/1049

## Deferred Ideas

- `[tech-spec]` Where built-in plugins live in the repo and how the packaged app points the daemon
  at them.
- `[tech-spec]` The shape of the activation context and how a plugin provides an implementation.
- An explicit priority field for overrides, if conflicts turn out to be common (D8).
- Automatic disabling of a plugin that keeps failing to activate.

## Glossary

- **Plugin:** a directory with a `quirky-plugin.json` manifest and optional daemon code.
- **Built-in plugin:** one shipped with Quirky in its built-in plugins directory.
- **Installed plugin:** one under `<QUIRKY_HOME>/plugins/<id>/`.
- **Contribution:** one thing a plugin adds, declared in its manifest under a kind and a name.
- **Kind:** the type of a contribution, such as `command` or `view`.
- **Stable ID:** `<kind>:<pluginId>/<name>`, the same across restarts and versions.
- **Override:** a declaration under another plugin's ID that replaces it.
- **In effect:** the one declaration of an ID that the registry uses.
- **Disabled list:** the IDs the user turned off, stored by the daemon.
- **Activation:** importing a plugin's daemon module and calling it so it can provide
  implementations.
- **Resolve:** looking up an ID in effect and activating its plugin if needed.
- **Plugin states:** `inactive`, `activating`, `active`, `failed` (activation went wrong),
  `disabled` (by the user or a disabled dependency) and `invalid` (rejected at load).
