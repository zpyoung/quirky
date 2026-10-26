# m0-ui-api decisions

## D1: Classify the item as an API and Visual design, and run both research phases
- **Question:** which domain the gray-area catalog draws from, and whether the research swarms run (quirk:brainstorming, checklist steps 2 and 7)
- **Options:** API only; Visual only; API plus Visual; skip research as covered by earlier items
- **Chose:** API plus Visual. Phase A ran two web-research agents (slot patterns, UI plugin pitfalls); Phase B ran three, one per approach (declared slots with mounted modules, code-first registration, iframe-isolated views).
- **Why:** the consumers are plugin authors (the API) and the person using the window (the slots). Earlier items researched registries and daemon APIs, not UI contribution points. LOOP.md pre-authorizes the swarms.
- **Evidence:** docs/loop/LOOP.md "Answering a skill's questions"; docs/roadmap.md M0 "UI API"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D2: Skip the visual companion and the adhd offer, use the standard gray-area set
- **Question:** brainstorming's visual companion offer and its Step 0 adhd offer
- **Options:** run them; skip them
- **Chose:** skip both
- **Why:** LOOP.md says to skip the parts that assume a person is there
- **Evidence:** docs/loop/LOOP.md "Skip the parts that assume a person is there"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D3: Select every gray area that matters for the UI plugin API
- **Question:** which gray areas to drill into (brainstorming Gray Areas Step 1)
- **Options:** API: response-format, error-responses, authentication, versioning, rate-limiting, pagination; Visual: layout-style, information-density, loading-pattern, empty-state, error-state, interaction-style; Organization: naming-convention, duplicate-handling
- **Chose:** naming-convention, layout-style (where each slot sits), loading-pattern (lazy UI code), error-state (a failing plugin UI), empty-state, interaction-style (commands and keybindings), duplicate-handling (keybinding conflicts), versioning (setting values against a changed schema), response-format (what the API returns about UI contributions) and authentication (serving plugin UI files)
- **Why:** LOOP.md asks for every area that matters. Pagination and rate limiting are dropped because no list here is unbounded and nothing here is called in a loop; information density is a theme and layout concern no plugin controls.
- **Evidence:** docs/loop/LOOP.md "Gray areas"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D4: The seven UI kinds are `view`, `panel`, `sidebar-section`, `command`, `keybinding`, `setting` and `theme`
- **Question:** naming-convention: what the manifest calls each slot kind the roadmap lists
- **Options:** VS Code's names (`views`, `viewsContainers`, `configuration`, `colors`); one kind per roadmap noun, singular, kebab-case; a `ui.` prefix on each kind
- **Chose:** one kind per roadmap noun, singular and kebab-case, matching the daemon kinds (`method`, `launch-hook`) and the IDs the registry's fixtures already use (`view:quirky.sample/sidebar`, `command:acme.tools/refresh`)
- **Why:** IDs read naturally (`sidebar-section:quirky.repos/list`), and `view` and `command` are already in use in m0-registry's specs. A `ui.` prefix adds length to every ID for no disambiguation, since no daemon kind shares these names.
- **Evidence:** docs/roadmap.md M0 "UI API"; docs/quirk/specs/2026-10-26-m0-registry/logic.md SC-2, SC-10; packages/daemon/src/plugins/kinds.ts
- **Reversibility:** hard
- **Confidence:** high
- **Source:** assumed — autonomous

## D5: Plugin UI code is one ES module named by a manifest `ui` field, loaded in the window only when needed
- **Question:** loading-pattern: how webview code reaches the window, and when it loads
- **Options:** a `ui` module loaded at window start; a `ui` module loaded when one of its contributions is first shown or run; one module per contribution
- **Chose:** a single `ui` module per plugin, imported the first time one of its in-effect views, panels or sidebar sections is shown, or one of its commands runs. Settings, keybindings and themes are data and never load code.
- **Why:** it carries m0-registry's lazy rule (D11, D23) into the window, so an unused plugin costs the webview nothing, which the memory budget depends on. One module per plugin keeps a plugin's UI state in one place.
- **Evidence:** docs/loop/decisions/m0-registry.md D11, D23; docs/architecture.md "Memory budget"; https://tabularis.dev/blog/plugin-ui-extensions
- **Reversibility:** medium
- **Confidence:** high
- **Source:** assumed — autonomous

## D6: A slot gives the plugin one container element to mount into, and nothing else of the page
- **Question:** layout-style and the roadmap's "no access to the DOM structure": what a view, panel or sidebar section implementation is
- **Options:** a React component the host renders in its own tree; a `mount(element, props)` function that returns a cleanup; an iframe per contribution; a shadow root per contribution
- **Chose:** `mount(element, props)` returning a cleanup function. The host creates the element, the plugin owns everything inside it, and the host's own markup and class names are not part of the API. No shadow root.
- **Why:** a mount function doesn't tie the plugin API to the host's React version or its component tree, which is the contract Atom broke when it changed its DOM. A shadow root would also cut plugins off from the shared stylesheet that the built-ins of m0-port-v1 will want, and the trust decision means isolation isn't a security boundary anyway.
- **Evidence:** https://code.visualstudio.com/api/extension-capabilities/overview ; https://pulsar-edit.dev/docs/atom-archive/shadow-dom ; docs/roadmap.md "Trust"
- **Reversibility:** hard
- **Confidence:** medium
- **Revisit if:** built-in plugins in m0-port-v1 need to share host React context that a mount function can't carry
- **Source:** assumed — autonomous

## D7: The window shares its React with plugin UI modules through bare imports
- **Question:** loading-pattern: whether a plugin that uses React bundles its own copy
- **Options:** each plugin bundles React; the host provides `react`, `react-dom/client` and `react/jsx-runtime` as bare imports resolved to its own copy; the context hands plugins a React object
- **Chose:** the host resolves those three bare specifiers to its own copy, so a plugin module can `import { useState } from 'react'` and share one React. A plugin may use no framework at all.
- **Why:** two copies of React break hooks and cost memory per plugin. Built-in plugins will be React, and a bundled copy each would multiply the webview's base cost.
- **Evidence:** https://dev.to/r9v/the-two-reacts-bug-when-packages-arent-singletons-492h ; https://github.com/single-spa/single-spa/issues/1165
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** the host's React major version changes and plugins built for the old one break
- **Source:** assumed — autonomous

## D8: The daemon resolves UI contributions into one model the window and agents read
- **Question:** response-format: where slot contents, keybinding winners, setting schemas and themes are worked out, and what the API returns
- **Options:** the window computes everything from `plugin.contributions`; the daemon serves a resolved `ui.contributions` model; both
- **Chose:** a kernel method `ui.contributions` returns each slot's in-effect contributions in order with their owner and the owner's UI module URL, every keybinding with whether it is active, shadowed or unbound, and the setting and theme declarations. The window renders from it and refetches it on `plugin.changed`.
- **Why:** one resolver means the window, the CLI and agents agree on what is shown, and every slot rule becomes testable through the daemon API, as the roadmap requires. m0-ui-bridge then reads the same model.
- **Evidence:** docs/roadmap.md "Everything is scriptable"; docs/loop/LOOP.md step 6
- **Reversibility:** medium
- **Confidence:** high
- **Source:** assumed — autonomous

## D9: Sidebar sections and panels are ordered by a declared `order`, then by ID
- **Question:** layout-style: the order of several plugins' contributions in one slot
- **Options:** load order; a numeric `order` field then ID; alphabetical by title
- **Chose:** a numeric `order` (default 100, lower first), ties broken by contribution ID
- **Why:** the result never depends on load order, matching m0-registry D8, and a distro can reorder by overriding a contribution with a new `order`
- **Evidence:** docs/loop/decisions/m0-registry.md D8; https://jupyterlab.readthedocs.io/en/stable/extension/extension_points.html (rank)
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D10: Slot locations: sidebar sections under the repo list, panels in the right column, views in the main area
- **Question:** layout-style: where each slot sits in the v1 window
- **Options:** VS Code's activity bar and containers; fixed locations in the existing layout; a `location` field per contribution
- **Chose:** fixed locations in v1's layout. Sidebar sections stack under the repo list. Panels share the right column with source control, one open at a time, each with a toggle in the main header. Views open in the main area in place of the session view, one at a time, opened through the UI context or a command, and closing one returns to the session view.
- **Why:** it is the smallest change to the layout v1 users know. A `location` field has one possible value today, and tabs and layout persistence belong to m0-ui-bridge and m1-term-ui-core.
- **Evidence:** packages/ui/src/App.tsx; packages/ui/src/components/MainArea.tsx; docs/roadmap.md M0 "UI bridge"
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** m0-ui-bridge's layout model needs views as tabs from the start
- **Source:** assumed — autonomous

## D11: Commands run in the window, from a command palette or a keybinding
- **Question:** interaction-style: how a person reaches a command
- **Options:** keybindings only; a command palette plus keybindings; menus
- **Chose:** a command palette (Cmd+Shift+P, filtered by title, Enter runs) listing every command in effect, plus keybindings. Command implementations live in the plugin's UI module.
- **Why:** a command without a keybinding is otherwise unreachable by a person until m0-ui-bridge routes API calls to it. Menus need a placement model no item has asked for.
- **Evidence:** https://code.visualstudio.com/api/references/contribution-points ; docs/roadmap.md M0 "UI bridge"
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D12: Keybindings are `mod+shift+k` chords that must include a modifier, or a function key
- **Question:** interaction-style: keybinding syntax, and keeping plugins from stealing typed keys
- **Options:** VS Code's syntax with platform variants; one portable syntax with `mod`; allow bare keys
- **Chose:** `+`-joined chords of `mod`, `cmd`, `ctrl`, `alt`, `shift` and one key, where `mod` is Cmd on macOS. A chord needs at least one of `mod`, `cmd`, `ctrl` or `alt`, unless the key is F1 to F12. Single chords only, no sequences. Keybindings fire even when a terminal has focus, as v1's Cmd+T does.
- **Why:** a bare key would fire while someone types into a terminal or form. `mod` keeps a manifest portable; what `mod` means elsewhere is platform work.
- **Evidence:** packages/ui/src/components/useShortcuts.ts; https://zed.dev/docs/key-bindings
- **Reversibility:** medium
- **Confidence:** high
- **Source:** deferred: platform

## D13: Two keybindings on one chord: one wins by registry precedence, and the other is reported as shadowed
- **Question:** duplicate-handling: two in-effect keybinding contributions bound to the same chord
- **Options:** last loaded wins silently (VS Code, Zed); both fire; a deterministic winner with the loser reported
- **Chose:** the winner is picked with m0-registry D8's precedence (installed over built-in, a dependent over its dependency, then the ID that sorts first). The loser is listed as `shadowed` by the winner in `ui.contributions` and its plugin gets a warning. A keybinding whose command isn't in effect is listed as `unbound` and never fires. A person or distro changes the outcome by disabling or overriding a keybinding by ID.
- **Why:** silent last-wins is the most reported keybinding complaint across editors. Reusing D8 means one precedence rule for everything.
- **Evidence:** https://www.reddit.com/r/Frontend/comments/1pga8le/does_anyone_else_keep_running_into_vs_code/ ; https://github.com/eclipse-theia/theia/issues/2209 ; docs/loop/decisions/m0-registry.md D8
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D14: No `when` clauses yet
- **Question:** interaction-style: whether commands, keybindings and slots take visibility or enablement conditions
- **Options:** VS Code-style `when` expressions with context keys; none, with command implementations deciding at run time
- **Chose:** none. A command that doesn't apply at the moment does nothing or reports why.
- **Why:** a context-key system is a language of its own, and no M0 contribution needs one. v1's shortcuts already check state inside the handler.
- **Evidence:** packages/ui/src/components/useShortcuts.ts
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** m1-term-ui-extras needs keybindings that differ by focused pane
- **Source:** assumed — autonomous

## D15: Settings are declared with a type and default, stored by the daemon, and set through `setting.*` methods
- **Question:** versioning and response-format: what a setting contribution declares, where values live, and how they are read and written
- **Options:** JSON Schema per setting; a small fixed set of types; plugin-owned storage with a settings tab it renders itself
- **Chose:** a `setting` contribution declares `type` (`boolean`, `number`, `string` or `enum`), `default`, `title`, and optionally `description`, `minimum`, `maximum` and `values`. The daemon stores values by setting ID and validates every write against the declaration. Kernel methods `setting.list`, `setting.get`, `setting.set` and `setting.reset`, with a `quirky setting` CLI group, read and change them, and each change sends `setting.changed`. Plugins read settings through their context, on both the daemon and the window side. The Settings dialog renders a form for every setting in effect, grouped by plugin.
- **Why:** four types cover v1's settings and Obsidian's declarative controls, and a form can be generated from them without plugin code. Storing values in the daemon makes them scriptable and shared by every window.
- **Evidence:** https://docs.obsidian.md/Plugins/User+interface/Settings ; https://code.visualstudio.com/api/references/contribution-points (configuration); packages/daemon/src/store.ts settings table
- **Reversibility:** medium
- **Confidence:** high
- **Source:** assumed — autonomous

## D16: A stored value that no longer fits its declaration reads as the default, and is kept
- **Question:** versioning: a plugin update changes a setting's type or range, or a setting's plugin is disabled
- **Options:** delete the stale value; keep it and read the default with a diagnostic; migrate values
- **Chose:** keep it. `setting.get` returns the default and marks the stored value invalid. A setting whose plugin is disabled or removed keeps its stored value, so enabling it again restores the user's choice.
- **Why:** deleting user data on a plugin downgrade or a disable is irreversible, and VS Code's open issue on renamed settings shows a migration API is its own project
- **Evidence:** https://github.com/microsoft/vscode/issues/91618
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D17: Settings have one scope, the user's
- **Question:** versioning: per-repo or per-worktree setting scopes
- **Options:** user only; user plus repo; VS Code's window, resource and language scopes
- **Chose:** user only
- **Why:** v1's settings are user-wide and no M0 item asks for another scope
- **Evidence:** packages/protocol/src/model.ts Settings
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** a later feature doc needs a per-repo setting
- **Source:** assumed — autonomous

## D18: v1's own settings and `settings.*` methods stay as they are until m0-port-v1
- **Question:** naming-convention: how the new `setting.*` methods relate to v1's `settings.get` and `settings.set`
- **Options:** rename v1's settings into the new model now; keep both, with v1's moving when its features become plugins
- **Chose:** keep both. v1's three settings stay in their own form at the top of the Settings dialog.
- **Why:** v1's settings belong to features that m0-port-v1 moves into plugins, which will declare them as `setting` contributions. Moving them now would port v1 features ahead of that item.
- **Evidence:** docs/loop/queue.json m0-port-v1; docs/loop/decisions/m0-daemon-api.md D5
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D19: Themes declare colors for a fixed token set, and missing tokens fall back to the default theme
- **Question:** versioning: what a theme declares and what happens to tokens it leaves out
- **Options:** arbitrary CSS; a fixed token map; a token map plus terminal colors
- **Chose:** a `theme` contribution declares `title`, `appearance` (`dark` or `light`) and `colors`, a map over a fixed token set: the window's existing color variables plus the terminal's background, foreground and cursor. An unknown token makes the manifest invalid; a missing one takes the default theme's value. The default theme is the kernel's.
- **Why:** a fixed set is what keeps themes working when the UI changes, the same reason slots don't expose the DOM. Fallbacks let a theme set a few colors.
- **Evidence:** packages/ui/src/styles.css :root; packages/ui/src/terminal/TerminalPane.tsx:42; https://code.visualstudio.com/api/references/theme-color
- **Reversibility:** medium
- **Confidence:** high
- **Source:** assumed — autonomous

## D20: The active theme is chosen through `theme.list` and `theme.set`, and applies live
- **Question:** interaction-style: how a theme is picked, and what happens when the picked theme goes away
- **Options:** a regular setting; dedicated `theme.*` methods; a field on v1's Settings
- **Chose:** kernel methods `theme.list` (themes in effect, with the active one marked) and `theme.set <id>` (or `default`), a `quirky theme` CLI group, a `theme.changed` event, and a picker in the Settings dialog. The window applies the change without a reload. When the active theme stops being in effect, the window uses the default and keeps the choice, so it returns when the theme does.
- **Why:** the theme isn't owned by any plugin, so it can't be one plugin's `setting` contribution. Keeping the choice follows D16.
- **Evidence:** docs/loop/decisions/m0-registry.md D10
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D21: A failing plugin UI is contained to its slot or its command
- **Question:** error-state: a UI module that fails to load or activate, a mount that throws, or a command that throws
- **Options:** let it propagate; contain it per slot with a visible error; disable the plugin after repeated failures
- **Chose:** a slot whose plugin fails shows an error box in that slot naming the plugin and the message, and the rest of the window works. A command that fails shows an error toast naming the command. The next attempt (showing the slot again, running the command again) retries loading. Nothing is disabled automatically.
- **Why:** m0-registry D13's containment rule, applied in the window. Error boundaries miss event-handler and async errors, so the host has to wrap mount and command calls itself. Auto-disable stays deferred, as in m0-registry.
- **Evidence:** docs/loop/decisions/m0-registry.md D13; https://legacy.reactjs.org/docs/error-boundaries.html ; https://tabularis.dev/blog/plugin-ui-extensions
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D22: Empty slots show nothing, and a loading slot shows a placeholder
- **Question:** empty-state and loading-pattern: what a person sees in a slot with no contributions or whose module is still loading
- **Options:** hide the slot; show a placeholder message; a spinner
- **Chose:** a slot with no contributions takes no space. A contribution whose module is loading shows its title with a muted "Loading" line until it mounts.
- **Why:** v1's layout must look unchanged with no plugins installed, which the M0 exit test requires
- **Evidence:** docs/roadmap.md M0 exit test "v1 behaves as it does today"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D23: Enabling or disabling a UI contribution applies to the open window live
- **Question:** loading-pattern: what the window does on `plugin.changed`
- **Options:** require a reload; refetch the model and update the slots
- **Chose:** refetch `ui.contributions` and update every slot: unmount contributions that left, mount new ones. A plugin whose last UI contribution leaves has its UI `deactivate` called. Its module stays loaded, because a browser can't unload one, so a changed module on disk takes effect on the next window load.
- **Why:** m0-registry D10 made changes live in the daemon; a window that ignored them would disagree with `ui.contributions`
- **Evidence:** docs/loop/decisions/m0-registry.md D10
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D24: The daemon serves plugin UI files from the plugin's own directory, without a token
- **Question:** authentication: how the window fetches a plugin's UI module and the files it imports
- **Options:** behind the RPC token; like the built UI, on loopback without a token; inline the code through an RPC method
- **Chose:** `GET /plugins/<pluginId>/<path>` serves files inside the directory of a plugin that declares `ui` and isn't invalid, refusing any path that leaves the directory. No token, like the built UI it sits beside.
- **Why:** a module import can't send a header, and plugin code is no more secret than the UI bundle. Limiting it to declared plugin directories keeps it from being a general file server.
- **Evidence:** packages/daemon/src/static.ts; packages/daemon/src/server.ts
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** sb-mobile-daemon's non-loopback listener needs every route authenticated
- **Source:** assumed — autonomous

## D25: The UI plugin API is kernel, not a built-in plugin
- **Question:** LOOP.md step 6 requires the feature to ship as a built-in plugin on the public API; how that applies to the API itself
- **Options:** wrap `ui.contributions`, `setting.*` and `theme.*` in a built-in plugin; treat them as kernel, like m0-registry D18 and m0-daemon-api D41
- **Chose:** kernel. A plugin can't host the slots it fills, and the default theme has to exist before any plugin loads.
- **Why:** docs/roadmap.md lists the UI shell and plugin host as the core
- **Evidence:** docs/loop/decisions/m0-registry.md D18; docs/loop/decisions/m0-daemon-api.md D41
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/roadmap.md

## D26: v1's sidebar, session view and source control stay hard-wired until m0-port-v1
- **Question:** scope: whether this item moves any v1 surface into a slot
- **Options:** move them now; add slots beside them and leave them for m0-port-v1
- **Chose:** add the slots beside v1's surfaces. m0-port-v1 turns them into built-in contributions.
- **Why:** the queue gives that move to m0-port-v1, which depends on this item and on m0-ui-bridge
- **Evidence:** docs/loop/queue.json m0-port-v1
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D27: This item has no Orca defects to test
- **Question:** LOOP.md step 4 asks for a test per Orca defect in the item's feature docs
- **Options:** n/a
- **Chose:** none; the item's `docs` field is empty
- **Why:** the defects live in feature docs, and this item names none
- **Evidence:** docs/loop/queue.json m0-ui-api
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/queue.json

## D28: Window-only behavior is tested through the window's plugin host against a real daemon
- **Question:** LOOP.md step 6 wants each flow driven through the CLI or daemon API, and the window's state can't be read through the API until m0-ui-bridge
- **Options:** browser automation of the built window; test the window's plugin host module directly against a real `quirkyd`; skip window behavior
- **Chose:** every rule the daemon owns (slot contents and order, keybinding outcomes, settings, themes, file serving, live changes) is tested through the API and CLI against a real `quirkyd`. What only the window does (lazy import, mount and cleanup, error containment, keybinding dispatch, theme application) is tested by driving the window's plugin host, the module the React shell renders from, against the same real daemon and its served plugin files, with stand-in elements. m0-ui-bridge adds `quirky ui state` checks of the same flows.
- **Why:** the repo has no DOM test library, and its UI tests already test logic modules rather than rendered components. Driving the host against the real daemon still covers the API path end to end.
- **Evidence:** packages/ui/test/*.test.ts; docs/loop/queue.json m0-ui-bridge
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** m0-ui-bridge finds a window behavior these tests missed
- **Source:** assumed — autonomous

## D29: Choose declared slots with lazily imported modules that mount into host elements
- **Question:** brainstorming's approach proposal
- **Options:** (1) slots declared in the manifest, resolved by the daemon, with UI modules imported on first use that mount into a host element; (2) code-first registration, where every UI module loads at window start and registers commands, views and settings tabs (Obsidian, JupyterLab); (3) iframe-isolated views talking to the host over `postMessage` (VS Code webviews, Figma)
- **Chose:** (1), the recommended option
- **Why:** it is the only one where listing, overriding and disabling UI contributions runs no plugin code, which m0-registry D23 locked. Code-first loading is where Obsidian's multi-second starts come from (one plugin added 2.5 s in `onload`), and its commands can't be listed or rebound without loading code. Iframes cost a document and a framework copy per view, break keyboard shortcuts at the frame boundary (VS Code #65333), and buy isolation the trust decision says Quirky doesn't need. Grafana runs the chosen shape in production with one shared React.
- **Evidence:** https://github.com/Automattic/harper/issues/2601 ; https://github.com/microsoft/vscode/issues/65333 ; https://code.visualstudio.com/api/extension-guides/webview ; https://grafana.com/blog/react-19-is-coming-to-grafana-what-plugin-developers-need-to-know/ ; docs/loop/decisions/m0-registry.md D23
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** third-party plugins need isolation from each other after all
- **Source:** assumed — autonomous

## D30: The window's own shortcuts are reserved, and a plugin keybinding on one is shadowed by the kernel
- **Question:** duplicate-handling: a plugin keybinding on Cmd+T, Cmd+W, Cmd+1 to Cmd+9 or the palette's Cmd+Shift+P
- **Options:** let the plugin win; let the kernel win and report it; make the manifest invalid
- **Chose:** the kernel wins, and the keybinding is listed as `shadowed` by `kernel` with a warning on its plugin
- **Why:** these shortcuts are v1 behavior that the M0 exit test keeps. They become overridable contributions when m0-port-v1 moves them into plugins. Rejecting the whole manifest over one keybinding would be harsher than D13's rule for plugin-to-plugin clashes.
- **Evidence:** packages/ui/src/components/useShortcuts.ts; docs/roadmap.md M0 exit test
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D31: UI kinds' fields are validated, and a plugin with UI contributions but no `ui` module gets a warning
- **Question:** error-state: malformed UI contributions, and code-backed UI contributions whose plugin has no UI module
- **Options:** accept anything; validate fields and reject unknown ones, as m0-daemon-api D14 does; also make a plugin without `ui` invalid
- **Chose:** each UI kind's fields are checked and unknown fields rejected, which makes the plugin invalid with a diagnostic per problem. A plugin whose views, panels, sidebar sections or commands are in effect but which has no `ui` field stays valid with a warning, and those contributions fail in the window with an error naming the plugin.
- **Why:** consistent with daemon kinds. A missing `ui` module is only a problem for contributions that are shown or run, so it shouldn't take down the plugin's settings, themes or daemon side.
- **Evidence:** docs/loop/decisions/m0-daemon-api.md D14; packages/daemon/src/plugins/kinds.ts
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D32: The window-side plugin context mirrors the daemon's, plus slot actions
- **Question:** response-format: what a UI module's `activate` receives
- **Options:** the daemon context's shape; a separate, larger UI API; a minimal context with only `provide`
- **Chose:** `pluginId`, `provide`, `log`, `call` (any daemon method, through the window's connection), `subscribe` (daemon events), `getSetting`, plus `executeCommand`, `openView`, `closeView` and `togglePanel`. It is revoked when the plugin's UI deactivates, as the daemon context is. Daemon-side contexts also gain `getSetting`.
- **Why:** one mental model across both sides. The four slot actions are what commands need to reach the slots; everything else goes through the daemon API, which is already scriptable.
- **Evidence:** packages/protocol/src/plugins.ts PluginContext
- **Reversibility:** medium
- **Confidence:** medium
- **Source:** assumed — autonomous

## D33: Fast-track the remaining defaults
- **Question:** brainstorming's essential-coverage gate and fast-track
- **Options:** keep asking; fast-track once the six essentials are covered
- **Chose:** fast-track. Purpose, consumers, success criteria, hard constraints, scope boundary and primary behavior are all settled by roadmap.md, LOOP.md and D4 to D32. Every remaining default-able choice takes its recommended default and is tagged in the spec's Decisions Locked.
- **Why:** LOOP.md treats the user as having elected to accept stated defaults
- **Evidence:** docs/loop/LOOP.md "Answering a skill's questions"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D34: Logic-spec review: fix four model findings, keep D28 against the fifth, reject the pre-pass findings
- **Question:** adjudicating the Codex adversarial review of logic.md (spec-design profile, standard depth, reviewer gpt-6.1-sol, independence full)
- **Options:** for each finding, amend the spec or reject it with a reason
- **Chose:** amended for four. F2: unbound keybindings now drop out before clashes are settled, so they never take a chord from a working one (SC-18). F3: a disable during a module load lets the load and `activate` finish, mounts nothing and deactivates (SC-4, data flow). F5: a throwing cleanup or `deactivate` is logged and teardown and revocation complete anyway (SC-13). F6: the Settings dialog got its own scenario (SC-24). Kept D28 against F1 (window flows are driven through the window's plugin host rather than the CLI): the window's state has no API until m0-ui-bridge, and the host is driven against a real daemon over its API. Rejected F7 (the pre-pass wants a Purpose or Overview heading the rubric doesn't require, and the repo's writing rules forbid "Overview") and the 40 unresolvable-reference findings, which are fixture contribution IDs and paths the spec defines, not files.
- **Why:** each amended finding named a real gap an implementer would otherwise fill two ways; F4 was refuted by the reviewer itself
- **Evidence:** scratchpad lr1/gate.json and merged.json; docs/loop/decisions/m0-registry.md D29 (same pre-pass rejections)
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D35: `title` is optional for views and commands and required for panels and sidebar sections
- **Question:** tech spec, existing fixtures: about thirty daemon test fixtures declare `view` and `command` contributions with only an `id`, and two declare a `panel` with no title
- **Options:** require `title` on every code-backed kind and rewrite the fixtures; make it optional where a name is a usable fallback
- **Chose:** optional for `view` and `command`, defaulting to the contribution name; required for `panel` and `sidebar-section`, whose title is the only label a person sees on the toggle or section header. The two panel fixtures and the `kinds.test.ts` test that pins "arbitrary fields are left alone" for `command` are updated.
- **Why:** a command name such as `refresh` reads fine in the palette, while an untitled panel toggle or section header would be blank. Keeping most fixtures valid keeps m0-registry's tests meaningful without churn.
- **Evidence:** packages/daemon/test/plugins/host.test.ts:120-216, api.test.ts:80-446, kinds.test.ts:117-119, manifest.test.ts:113, registry.test.ts:74
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D36: Tech-spec mechanisms: two new store tables, derived warnings through a host hook, React shared by marking it external
- **Question:** the `[tech-spec]` Deferred Ideas from the logic spec
- **Options:** for values, the v1 `settings` table or new tables; for warnings, `addWarning` or a derived-diagnostics hook; for React, a shared chunk or bare imports resolved by an import map in both the window and plugins; for tests, a DOM library or a framework-free host
- **Chose:** `setting_values` and `ui_state` tables (v1's `getSettings` spreads every `settings` row into its result); a `deriveDiagnostics` option that `recompute` calls, because `addWarning` emits `plugin.changed` and would loop; `main.js` built with React external so the window and plugins resolve the same import-map URLs; a `WindowPluginHost` with injected `call`, `onEvent` and `importModule`, tested against a real daemon with a fetch-to-temp-file importer, since Bun can't import over HTTP
- **Why:** each is the smallest change that keeps an existing contract (v1 settings, no event loops, one React by construction, no new test dependency)
- **Evidence:** packages/daemon/src/store.ts:304-310; packages/daemon/src/plugins/host.ts:176-209; packages/ui/build.ts:10-17
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** Bun's bundler can't re-export React's CommonJS API from the vendor entries
- **Source:** assumed — autonomous

## D37: Tech-spec review: fix six model findings, refute one, reject the pre-pass findings
- **Question:** adjudicating the Codex adversarial review of tech.md (spec-design profile, standard depth, reviewer gpt-6.1-sol, independence full)
- **Options:** for each finding, amend the tech spec or reject it with a reason
- **Chose:** fixed F1 (the model builder now takes every declaration, so `provides` includes disabled and overridden IDs), F2 (a load keeps the `provides` list it started with), F4 (module URL segments are percent-encoded), F5 (a failed or timed-out activation revokes its context without calling `deactivate`, as m0-daemon-api D38 does), F6 (`quirky ui contributions` prints a MODULE column, which SC-1 asks for) and F7 (the host gains `saveSettings`, so SC-24's save path is testable without a DOM). F3 (keybinding precedence can cycle) was refuted by the reviewer: the registry's algorithm removes dominated candidates before the ID tie-break, and the spec points the implementer at it. Rejected the 97 pre-pass findings: unresolvable references to files and symbols the spec says to create, and the Purpose/Overview heading check, as in D34.
- **Why:** each fixed finding named a contract two implementers would build differently
- **Evidence:** scratchpad tr1/gate.json and merged.json
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D38: Build with Claude subagents implementing and Codex reviewing
- **Question:** subagent-driven-development's preflight backend pairing
- **Options:** claude-task + codex (recommended); claude-task + gemini; pi-codex + opus; same-family pairs
- **Chose:** claude-task + codex. `pi-watch --check codex` and `--check gemini` both passed (gemini is the tiebreak family). The tree was clean on `build/m0-ui-api` with both specs committed. Baseline: 769 tests pass, typecheck clean, `bun test scripts` 13 of 14 (the D31 queue-state test).
- **Why:** LOOP.md step 5 names this pairing
- **Evidence:** docs/loop/LOOP.md step 5; scratchpad journal.md
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D39: Build in four waves: protocol, then modules, then wiring and the React shell, then scenario tests
- **Question:** subagent-driven-development Step 3 decomposition
- **Options:** one task per package; modules first with scenario tests last, as m0-daemon-api D34 did
- **Chose:** W1: T1 protocol types and helpers, plus compile stubs in host.ts and methods.ts. W2 (six parallel components): T2 UI kind validation, T3a the UI model builder, T3bc store tables and the plugin file server, T4 the CLI groups, T5 the window plugin host, T6 the React-sharing build. W3: T3d daemon wiring (host hook, UiService, methods, context, routes), T7 the React shell. W4: T8 daemon scenario tests, T9 window scenario tests, each allowed to fix only its own area's modules (as m0-daemon-api D40).
- **Why:** every later task needs the protocol types, and the scenario tests need the wiring. Splitting W2 by file keeps the six components disjoint.
- **Evidence:** docs/quirk/specs/2026-10-26-m0-ui-api/tech.md "Code references"
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D40: Skip wave 1's checkpoint review
- **Question:** subagent-driven-development Step 7 runs a checkpoint review after every wave with a successor
- **Options:** review the protocol wave; skip it with a reason
- **Chose:** skip. Wave 1 added types, pure chord and setting helpers with 27 unit tests, and throwing stubs; every later wave builds against those types, and the final loop reviews them with everything else.
- **Why:** the skill allows skipping a genuinely trivial non-final wave with a recorded reason
- **Evidence:** commit 9efa279 (merged as 8917b45)
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D41: Wave 2's work was restored from the object store after a failed commit step, and committed on the feature branch directly
- **Question:** the wave-end commit loop used a bash-only expansion under zsh, so no component commit was made, and the worktree cleanup that followed removed the uncommitted trees
- **Options:** re-dispatch all six tasks; restore the files from the blobs `git add -A` had already written
- **Chose:** restore. `git fsck --unreachable` found exactly 32 blobs written in the last half hour, one per changed file the audit had listed. Each was mapped back by content, and every modified file's blob diffed against HEAD by a size consistent with its task. The six tasks were then committed one per task straight onto `build/m0-ui-api` instead of through component merges. The full gate on the result passed: 1006 tests, typecheck clean.
- **Why:** the audited, accepted content was intact in the object store, so re-running six implementers would only have produced different, unreviewed code
- **Evidence:** commits fbf02b8 to 4c0c8a2; scratchpad acc-*.log (per-task acceptance before the loss) and gate-w2.log
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a review finds a file that doesn't match its task's report
- **Source:** assumed — autonomous

## D42: Wave 2 checkpoint: accept all nine findings, which collapse to six host defects
- **Question:** adjudicating the wave 2 checkpoint review (three Codex lenses, standard depth, range 8917b45..4c0c8a2)
- **Options:** for each finding, fix or reject
- **Chose:** fixed all, in the window plugin host. A load that completes after `stop()` no longer activates (C1, S2, X2). `deactivate` is bounded by the activation timeout and the context is revoked when it settles or times out (C2, X1). A `setting.changed` during a refresh beats that refresh's snapshot (C3). Subscribers registered during `activate` receive events (C4). An undeclared `provide` after activation fails the plugin, as the provide contract says (S1). Command failures are logged with the plugin ID as well as toasted (S3).
- **Why:** each was reproduced by the reviewer with a script against the host, and each would leave a plugin running or a value stale in a way the logic spec's lifecycle rules forbid
- **Evidence:** scratchpad cp-w2/{C,S,X}/gate.json; regression tests named C1, C2, C3, C4, S1, S3 in packages/ui/test/plugin-host-unit.test.ts
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D43: Wave 3 checkpoint: fix both shell defects
- **Question:** adjudicating the wave 3 checkpoint review (three Codex lenses, standard depth, range 1bb2375..022d1d9)
- **Options:** fix or reject each
- **Chose:** fixed both. C1 and S1: a shown slot whose owner changes (an override enabled or disabled) stayed empty, because `PluginSlot` didn't remount on an owner change; it now does. C2: Cmd+1 to Cmd+9 on the already-selected session didn't close an open view; it now closes it whenever it selects a session. The security lens passed.
- **Why:** both break a stated rule: SC-3's override takes over a slot live, and selecting a session closes the view (tech.md "React shell")
- **Evidence:** scratchpad cp-w3/{C,S,X}/gate.json
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## Progress
Building. Waves 1-3 merged with checkpoints closed (D40-D43); wave 4 (T8 daemon scenario suite, T9 window scenario suite) dispatched from b6bb471. Next: audit and merge wave 4, full gate, final review loop over b7613ba..HEAD (deep, three Codex lenses), then LOOP.md step 6-7. If this session stops early, check for leftover worktrees under the session scratchpad wt/ and branches build/m0-ui-api-w4-*.
