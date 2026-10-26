# UI plugin API: declared slots for views, panels, sidebar sections, commands, keybindings, settings and themes

## Status & amendments

**Status:** Approved (headless build loop; decisions in [m0-ui-api.md](../../../loop/decisions/m0-ui-api.md)). Tech spec: requested.

**Amendments:**
- 2026-10-26, before approval: Codex adversarial review. Unbound keybindings drop out before clashes are settled (SC-18); a disable during a module load and a throwing cleanup or `deactivate` now have defined outcomes (SC-4, SC-13); the Settings dialog has its own scenario (SC-24).

## Conceptual model

[m0-registry](../2026-10-26-m0-registry/logic.md) gave Quirky plugins that declare contributions in
a manifest, and [m0-daemon-api](../2026-10-26-m0-daemon-api/logic.md) gave daemon plugins methods,
events, stores, jobs and launch hooks. Neither lets a plugin put anything in the window. This item
adds the window's half of the plugin API: seven UI contribution kinds, the slots in the window
that show them, and a way for plugin code to run in the webview
([roadmap.md](../../../roadmap.md#m0-plugin-kernel-with-v1-moved-onto-it)).

The seven kinds are declared in the manifest like every other contribution, so each has a stable
ID and can be listed, overridden and disabled without loading code ([D4](../../../loop/decisions/m0-ui-api.md)):

| Kind | ID example | What it is | Shown in |
|---|---|---|---|
| `sidebar-section` | `sidebar-section:acme.notes/list` | A titled block in the left sidebar | Under the repo list, by `order` |
| `panel` | `panel:acme.notes/outline` | A side panel with a toggle | The right column, one at a time |
| `view` | `view:acme.notes/page` | Content for the main area, opened with an input | The main area, in place of the session view |
| `command` | `command:acme.notes/new` | An action with a title | The command palette, keybindings |
| `keybinding` | `keybinding:acme.notes/new-key` | A chord bound to a command | Fires its command |
| `setting` | `setting:acme.notes/fontSize` | A typed, user-editable value with a default | The Settings dialog |
| `theme` | `theme:acme.notes/solar` | A set of window and terminal colors | The theme picker |

Four kinds need code: views, panels and sidebar sections render something, and commands run
something. A plugin provides that code in a **UI module**, one ES module named by the manifest's
`ui` field, which the window imports the first time it needs one of the plugin's contributions
([D5](../../../loop/decisions/m0-ui-api.md)). The other three kinds are data, so keybindings,
settings and themes work without loading any plugin code.

A view, panel or sidebar section is implemented as a **mount function**. The window creates an
empty element for the contribution, calls `mount(element, props)`, and calls the cleanup it
returns when the contribution leaves the screen. The plugin owns what is inside that element and
nothing else: the window's own markup and class names are not part of the API, which is the
roadmap's "no access to the DOM structure" ([D6](../../../loop/decisions/m0-ui-api.md)). A plugin
can render with the window's own React, which the window shares through the bare imports `react`,
`react-dom/client` and `react/jsx-runtime`, or with no framework at all ([D7](../../../loop/decisions/m0-ui-api.md)).

The daemon resolves every UI contribution into one **UI model**, which `ui.contributions` returns:
each slot's contributions in order with their owner and module URL, each keybinding's outcome, and
the settings and themes in effect ([D8](../../../loop/decisions/m0-ui-api.md)). The window renders
from it, and agents read the same model.

Settings and the active theme are state the daemon keeps, so they are read and changed through
kernel methods and CLI groups, `setting.*` and `theme.*`, by the window, the CLI and agents alike.

## Data flow

**Startup.** The daemon validates each plugin's UI contributions along with the rest of its
manifest. When the window connects, it fetches `ui.contributions`, applies the active theme's
colors, and draws v1's layout plus any slots that have contributions. Nothing has imported a
plugin's UI module yet.

**Showing a slot.** When a sidebar section renders, a panel is toggled open, or a view is opened,
the window looks up the contribution's owner and imports that plugin's UI module from the daemon
(`/plugins/<pluginId>/<path>`), once per window. It calls the module's `activate` with a UI
context, during which the plugin provides implementations for the contributions it declared. The
window then calls the contribution's mount function with a fresh element. While the module loads,
the slot shows the contribution's title and a "Loading" line.

**Running a command.** The palette or a keybinding asks the window to run a command ID. The window
finds the command in the model, loads its owner's UI module if needed, and calls the
implementation with any arguments. A command reaches the slots through its context: it can open a
view with an input, close it, or toggle a panel, and it can call any daemon method.

**Pressing a key.** The window listens for key chords before the focused element does, as v1's
shortcuts already do, so a keybinding fires even when a terminal has focus. Only chords with a
modifier (or a function key) can be bound, so typing is never captured. The model lists each
keybinding as `active`, `shadowed` (another keybinding or the kernel owns the chord) or `unbound`
(its command isn't in effect); only active ones fire. Unbound keybindings are set aside before
clashes are settled, so a keybinding whose command is gone never takes a chord from one that
works.

**Changing settings.** The Settings dialog shows v1's settings, then a generated form for every
setting in effect, grouped by plugin, then the theme picker. Saving calls `setting.set` or
`theme.set`. The daemon validates the value against the declaration, stores it, and sends
`setting.changed` or `theme.changed`. Every window applies a theme change without a reload, and a
plugin's code reads current values through its context on either side.

**A plugin is enabled or disabled.** The daemon sends `plugin.changed`. The window refetches the
model, unmounts contributions that are no longer in effect (calling their cleanups), mounts new
ones where their slot is showing, and recomputes keybindings and the theme. A plugin whose last
UI contribution left has its UI `deactivate` called and its context revoked. Its module stays
loaded, since a browser can't unload one. If a contribution leaves while its module is still
loading, the load and `activate` finish, nothing is mounted for it, and the plugin is deactivated
straight away if none of its UI contributions remains. A cleanup or `deactivate` that throws is
logged with the plugin's ID and doesn't stop the rest of the teardown: the context is revoked
regardless.

## Key decisions

Each is logged in full, with options and evidence, in [m0-ui-api.md](../../../loop/decisions/m0-ui-api.md).

- **Declared slots, lazily imported modules, host-made elements** ([D29](../../../loop/decisions/m0-ui-api.md)).
  Three approaches were weighed:
  1. **Slots declared in the manifest and resolved by the daemon; UI modules imported on first use
     mount into an element the window creates** (chosen). Listing, overriding and disabling run no
     plugin code, and an unused plugin costs the webview nothing. Grafana runs this shape with one
     shared React.
  2. **Code-first registration**, where every UI module loads at window start and registers its
     commands, views and settings tab (Obsidian, JupyterLab). It is simpler for authors, but
     startup pays for every plugin (one Obsidian plugin added 2.5 s), and commands can't be listed
     or rebound until their code runs, which m0-registry D23 rejected.
  3. **Iframe-isolated views** that talk to the window over `postMessage` (VS Code webviews,
     Figma). It isolates plugins from each other, but each view costs a document and its own
     framework, keyboard shortcuts break at the frame edge, and the trust decision already says
     plugins aren't sandboxed.
- **One resolver for the UI model, in the daemon** ([D8](../../../loop/decisions/m0-ui-api.md)), so the
  window, the CLI and agents agree on what is shown.
- **Keybinding clashes are reported, never silent** ([D13](../../../loop/decisions/m0-ui-api.md),
  [D30](../../../loop/decisions/m0-ui-api.md)). m0-registry D8's precedence picks the winner.
- **Settings have four types and live in the daemon** ([D15](../../../loop/decisions/m0-ui-api.md));
  a stored value that stops fitting reads as the default and is kept ([D16](../../../loop/decisions/m0-ui-api.md)).
- **Themes color a fixed token set** ([D19](../../../loop/decisions/m0-ui-api.md)), so a theme keeps
  working when the window's markup changes.
- **A failing plugin UI stays in its slot** ([D21](../../../loop/decisions/m0-ui-api.md)).

## Behavior & scenarios

Fixtures are illustrative. Every scenario runs against a fresh temporary `QUIRKY_HOME` with a fake
PTY host. Scenarios about what the daemon decides are driven through the daemon API or the `quirky`
CLI. Scenarios about what the window does are driven through the window's plugin host (the part of
the webview that loads modules, mounts contributions and dispatches commands and keys) connected
to a real `quirkyd` and loading plugin files the daemon serves, with stand-in elements in place of
a real page ([D28](../../../loop/decisions/m0-ui-api.md)). Each scenario says which.

### The UI model

1. **SC-1: sidebar sections are listed in order, and nothing loads** (API, CLI)
   - **Given** installed `acme.notes` declares sidebar sections `list` (order 20) and `tags` (no order), and installed `acme.files` declares `tree` (order 20); each plugin's UI module records its import in a marker file
   - **When** the agent runs `quirky ui contributions`
   - **Then** the sidebar sections are listed as `acme.files/tree`, `acme.notes/list`, then `acme.notes/tags`, each with its title, order, owner and module URL; neither UI module has been imported
   - **Data before:** **Marker files**: absent
   - **Walkthrough:**
     1. The daemon starts
     2. The agent runs `quirky ui contributions`
   - **Data after:** sidebar ✓ `sidebar-section:acme.files/tree` (20), ✓ `sidebar-section:acme.notes/list` (20), ✓ `sidebar-section:acme.notes/tags` (100); **Marker files**: ✓ still absent

2. **SC-2: every UI kind appears in the model** (API)
   - **Given** `acme.notes` declares one contribution of each of the seven kinds, with `ui` set to `ui.js`
   - **When** a client calls `ui.contributions`
   - **Then** the reply has the sidebar section, panel, view and command with module URL `/plugins/acme.notes/ui.js`, the keybinding as `active`, the setting with its declared type and default, and the theme with all its colors filled in

3. **SC-3: an override replaces a slot's contribution and its code** (API)
   - **Given** built-in `quirky.sample` declares `sidebar-section:quirky.sample/repos` (title "Repos"*, order 10), and installed `acme.sidebar` overrides it (title "Acme"*, order 5)
   - **When** a client calls `ui.contributions`
   - **Then** the section is listed once, with title "Acme", order 5, owner `acme.sidebar`, and `acme.sidebar`'s module URL

4. **SC-4: disabling a UI contribution removes it live** (API, window)
   - **Given** the window's plugin host is showing `sidebar-section:acme.notes/list`, mounted
   - **When** the agent runs `quirky plugin disable sidebar-section:acme.notes/list`
   - **Then** `plugin.changed` arrives, the model no longer lists the section, the window host calls its cleanup and drops it from the sidebar, and `acme.notes`'s UI `deactivate` runs because none of its contributions is still shown. After `quirky plugin enable`, the section mounts again without re-importing the module.
   - **Walkthrough:**
     1. The agent disables the section
     2. The daemon sends `plugin.changed`
     3. The window host refetches the model and unmounts the section
     4. The agent enables the section, and the window host mounts it again
   - **Data after:** **Sidebar**: ✓ section back; **Module imports**: ✓ one
   - When the disable arrives while the section's module is still loading, the module finishes loading and activating, the section is never mounted, and the plugin's UI is deactivated with its context revoked.

5. **SC-5: malformed UI contributions make the plugin invalid** (API)
   - **Given** one installed plugin per problem below
   - **When** the daemon starts
   - **Then** each is `invalid` with a diagnostic naming the problem, and the valid plugins work normally
   - **Details:**

     | Problem | Diagnostic says |
     |---|---|
     | sidebar section `list` with no `title` | `sidebar-section list: title is required` |
     | panel `p` with `order: "high"` | `panel p: order must be a number` |
     | command `go` with field `icon` | `command go: unknown field \`icon\`` |
     | keybinding `k` with `key: "x"` | `keybinding k: key needs a modifier or a function key` |
     | keybinding `k` with `key: "mod+shift"` | `keybinding k: key must end in one key` |
     | keybinding `k` with no `command` | `keybinding k: command is required` |
     | setting `size` of type `number` with default `"big"` | `setting size: default must be a number` |
     | setting `mode` of type `enum` with no `values` | `setting mode: values is required for an enum` |
     | theme `t` with color `sparkle` | `theme t: unknown color \`sparkle\`` |
     | theme `t` with `appearance: "blue"` | `theme t: appearance must be dark or light` |
     | `ui: "../x.js"` | `field 'ui' must be a relative path inside the plugin directory` |

6. **SC-6: code-backed contributions without a UI module carry a warning** (API, window)
   - **Given** `acme.bare` declares a command `go` and a setting `size`, and has no `ui` field
   - **When** a client lists plugins and the window host runs `command:acme.bare/go`
   - **Then** `acme.bare` is valid with the warning "declares commands, views, panels or sidebar sections but has no ui module", its setting works, and running the command fails with "acme.bare has no ui module"

### Loading and mounting in the window

7. **SC-7: a sidebar section's module loads when the section is shown** (window)
   - **Given** `acme.notes` has sidebar section `list`; its UI module records its import and, in `activate`, provides a mount function that writes "3 notes" into the element and records each cleanup
   - **When** the window host starts and renders the sidebar
   - **Then** the module is imported once, `activate` runs once, the section's element contains "3 notes", and the mount received only that element and its props
   - **Data before:** **Marker file**: absent
   - **Walkthrough:**
     1. The window host fetches the model
     2. The sidebar renders `sidebar-section:acme.notes/list`, showing "Loading"
     3. The module loads and activates
     4. The section mounts
   - **Data after:** **Marker file**: ✓ one import; **Section**: ✓ "3 notes"

8. **SC-8: contributions that aren't shown never load their plugin** (window)
   - **Given** `acme.outline` declares only a panel `outline` and a view `page`, and its module records its import
   - **When** the window host starts and renders the sidebar and the main area, with no panel open and no view opened
   - **Then** `acme.outline`'s module has not been imported, and the panel's toggle is shown with its title

9. **SC-9: a panel toggles open and closed, one at a time** (window)
   - **Given** panels `acme.outline/outline` and `acme.notes/side`
   - **When** the window host toggles `outline` open, then toggles `side` open, then toggles `side` closed
   - **Then** `outline` mounts; opening `side` cleans up `outline` and mounts `side`; closing `side` cleans it up and leaves the right column empty. Opening a plugin panel also closes v1's source control panel, and opening source control closes a plugin panel.

10. **SC-10: a command opens a view with an input** (window)
    - **Given** `acme.notes` declares command `open` and view `page`; the command calls `context.openView('view:acme.notes/page', { noteId: 'n1' })`
    - **When** the window host runs `command:acme.notes/open`
    - **Then** the main area shows `view:acme.notes/page` mounted with props `{ input: { noteId: 'n1' } }` in place of the session view; `context.closeView()` cleans it up and returns the main area to the session view. Opening another view first cleans up the current one.

11. **SC-11: a UI module talks to the daemon through its context** (window)
    - **Given** `acme.notes`'s UI module calls `context.call('repo.list', {})` and `context.call('acme.notes/count', {})` (a daemon method of its own) during mount, and subscribes to events through `context.subscribe`
    - **When** its sidebar section mounts and a client then adds a repo
    - **Then** the mount received the repo list and the count, and the subscriber recorded `repo.changed`. After the plugin's UI deactivates, its listener receives nothing and its context's calls throw.

12. **SC-12: a UI module can only provide what its plugin declared** (window)
    - **Given** `acme.notes`'s `activate` provides an implementation for `command:acme.notes/undeclared`, and a second plugin `acme.lazy` activates without providing its declared sidebar section `list`
    - **When** the window host shows each plugin's contributions
    - **Then** `acme.notes`'s UI is `failed` with a message naming the undeclared ID, and its slots show that error; `acme.lazy`'s section shows "acme.lazy did not provide sidebar-section:acme.lazy/list". A plugin may provide an override's implementation under the overridden ID.

13. **SC-13: plugin UI failures stay in their slot** (window)
    - **Given** `acme.broken`'s module throws on import, `acme.throws`'s mount throws `boom`, `acme.cmd`'s command throws `nope`, and `acme.notes` works
    - **When** the window host shows all their sidebar sections and runs `acme.cmd`'s command
    - **Then** `acme.broken`'s section shows an error naming the plugin and the import error, `acme.throws`'s shows "acme.throws: boom", running the command produces an error toast "command:acme.cmd/go failed: nope", and `acme.notes`'s section is mounted. Showing `acme.throws`'s section again retries the mount, and a later load of `acme.broken` retries the import.
    - **Details:**

      | Failure | Shown |
      |---|---|
      | Import throws | Section error: "acme.broken failed to load: …" |
      | `activate` throws `bad` | Section error: "acme.x failed to activate: bad" |
      | `mount` throws `boom` | Section error: "acme.throws: boom" |
      | Command throws `nope` | Toast: "command:acme.cmd/go failed: nope" |
      | Cleanup throws during a disable | Logged as "acme.x: cleanup failed: …"; the section is removed and the context revoked |
      | `deactivate` throws | Logged as "acme.x: deactivate failed: …"; the context is revoked |

### Commands and keybindings

14. **SC-14: the command palette lists commands in effect** (window, API)
    - **Given** commands `acme.notes/new` ("New note"*) and `acme.files/open` ("Open file"*), and the user has disabled `command:acme.files/open`
    - **When** the palette is opened and filtered by "note"
    - **Then** it offers "New note" only; choosing it runs `command:acme.notes/new`. With the filter cleared it lists every command in effect, sorted by title.

15. **SC-15: a keybinding runs its command, also from inside a terminal** (window)
    - **Given** keybinding `acme.notes/new-key` binds `mod+shift+n` to `command:acme.notes/new`
    - **When** the window host receives Cmd+Shift+N, once with a terminal focused
    - **Then** the command runs both times and the key event is consumed, so the terminal never sees it. Cmd+N without Shift runs nothing.

16. **SC-16: two keybindings on one chord: one wins, and the other is reported** (API, window)
    - **Given** built-in `quirky.sample` and installed `acme.keys` both bind `mod+k`, to different commands
    - **When** a client calls `ui.contributions`, the window host receives Cmd+K, and then the agent disables `acme.keys`'s keybinding
    - **Then** `acme.keys`'s keybinding is `active` and `quirky.sample`'s is `shadowed` by it, `quirky.sample` carries the warning "keybinding:quirky.sample/k is shadowed by keybinding:acme.keys/k on mod+k", and Cmd+K runs `acme.keys`'s command. After the disable, `quirky.sample`'s keybinding is active and Cmd+K runs its command.

17. **SC-17: the window's own shortcuts are reserved** (API)
    - **Given** `acme.keys` binds `mod+t`
    - **When** a client calls `ui.contributions`
    - **Then** the keybinding is `shadowed` by `kernel`, with a warning on `acme.keys`, and Cmd+T still opens a new shell

18. **SC-18: a keybinding whose command isn't in effect is unbound** (API, window)
    - **Given** keybinding `acme.notes/new-key` binds `mod+shift+n` to `command:acme.notes/new`, and the user has disabled the command
    - **When** a client calls `ui.contributions`, and the window host receives Cmd+Shift+N
    - **Then** the keybinding is `unbound` and nothing runs; the event is not consumed. When a lower-precedence keybinding of another plugin binds the same chord to a command that is in effect, that one is `active` and runs, because unbound keybindings never take part in a clash.

### Settings

19. **SC-19: a setting is read, changed, persisted and reset** (CLI, API)
    - **Given** `acme.notes` declares setting `fontSize` (number, default 13, minimum 8, maximum 32)
    - **When** the agent runs `quirky setting get setting:acme.notes/fontSize`, `quirky setting set setting:acme.notes/fontSize 16`, restarts the daemon, gets it again, then runs `quirky setting reset setting:acme.notes/fontSize`
    - **Then** it reads 13 (default), then 16 after the set and after the restart, then 13 after the reset; the set and the reset each send `setting.changed` with the ID and new value
    - **Data before:** **Stored values**: none
    - **Walkthrough:**
      1. The agent reads the setting
      2. The agent sets it to 16, and a subscribed client receives `setting.changed`
      3. The daemon restarts
      4. The agent reads it, and resets it
    - **Data after:** **Stored values**: ✓ none; value ✓ 13

20. **SC-20: invalid values are refused** (CLI, API)
    - **Given** the `fontSize` setting from SC-19, and an enum setting `mode` with values `list` and `grid`
    - **When** the agent sets `fontSize` to `"big"`, to 40, `mode` to `tiles`, and sets `setting:acme.notes/ghost`
    - **Then** the first three fail with InvalidParams naming the rule, the last fails with NotFound, each CLI call exits non-zero, and the stored values are unchanged
    - **Details:**

      | Call | Error |
      |---|---|
      | `fontSize` = `"big"` | InvalidParams: setting:acme.notes/fontSize must be a number |
      | `fontSize` = 40 | InvalidParams: setting:acme.notes/fontSize must be at most 32 |
      | `mode` = `tiles` | InvalidParams: setting:acme.notes/mode must be one of list, grid |
      | `ghost` = 1 | NotFound: no setting setting:acme.notes/ghost |

21. **SC-21: a stored value that no longer fits reads as the default, and is kept** (API)
    - **Given** `fontSize` is stored as 30, and `acme.notes` is updated so its maximum is 24
    - **When** the daemon restarts and a client calls `setting.get`
    - **Then** the value is 13 (the default) and the reply marks the stored value 30 as invalid; restoring the maximum to 32 reads 30 again

22. **SC-22: settings of a disabled plugin are kept** (API)
    - **Given** `fontSize` is stored as 16
    - **When** the agent disables `acme.notes`, lists settings, then enables it and reads `fontSize`
    - **Then** the setting isn't listed while its plugin is disabled, and reads 16 after the enable

23. **SC-23: plugin code reads settings on both sides** (API, window)
    - **Given** `acme.notes`'s daemon method `size` returns `context.getSetting('fontSize')`, and its sidebar section shows `context.getSetting('fontSize')` and re-renders on `setting.changed`
    - **When** a client calls `acme.notes/size`, the section mounts, and then the agent sets `fontSize` to 20
    - **Then** the method returns 13 and then 20, and the section shows 13 and then 20. `getSetting` with a full ID reads another plugin's setting, and an unknown name throws.

24. **SC-24: the Settings dialog lists every setting in effect, grouped by plugin** (window)
    - **Given** `acme.notes` declares `fontSize` (number, 8 to 32) and `mode` (enum: list, grid), `acme.files` declares `hidden` (boolean), and `acme.solar` declares a theme
    - **When** the window host builds the Settings dialog and the person changes `fontSize` to 18 and picks Solar
    - **Then** the dialog shows v1's settings first, then an `acme.files` group with a checkbox for `hidden`, then an `acme.notes` group with a number field (8 to 32) for `fontSize` and a choice of list or grid for `mode`, each showing its current value, then the theme picker; saving calls `setting.set` for `fontSize` with 18 and `theme.set` with Solar's ID. A value the daemon refuses is shown as that setting's error and the dialog stays open.

### Themes

25. **SC-25: a theme is listed, chosen and applied live, with missing colors filled in** (CLI, API, window)
    - **Given** `acme.solar` declares theme `solar` (appearance light) with only `bg` and `text` set
    - **When** the agent runs `quirky theme list`, then `quirky theme set theme:acme.solar/solar`, restarts the daemon, and lists again
    - **Then** the list shows the default theme (active) and Solar; after the set, `theme.changed` arrives, the window host applies Solar's `bg` and `text` and the default theme's value for every other token, Solar is listed as active, and it is still active after the restart. `quirky theme set default` returns to the default.

26. **SC-26: a chosen theme that goes away falls back, and comes back** (API, window)
    - **Given** Solar is the active theme
    - **When** the agent disables `acme.solar`, then enables it
    - **Then** while it is disabled, `theme.list` marks the default as in use and keeps Solar as the chosen theme, and the window host applies the default colors; after the enable, Solar applies again

27. **SC-27: an unknown theme is refused** (CLI)
    - **When** the agent runs `quirky theme set theme:acme.ghost/x`
    - **Then** it fails with NotFound and exits non-zero, and the active theme is unchanged

### Serving and sharing

28. **SC-28: the daemon serves plugin UI files, and only those** (API)
    - **Given** `acme.notes` declares `ui: "dist/ui.js"`, which imports `./chunk.js`; `acme.bare` has no `ui`; `acme.bad` is invalid
    - **When** a client requests each path below
    - **Then** the responses are as listed
    - **Details:**

      | Request | Response |
      |---|---|
      | `/plugins/acme.notes/dist/ui.js` | 200, JavaScript |
      | `/plugins/acme.notes/dist/chunk.js` | 200, JavaScript |
      | `/plugins/acme.notes/%2e%2e/secret` | 404 |
      | `/plugins/acme.bare/anything.js` | 404 |
      | `/plugins/acme.bad/ui.js` | 404 |
      | `/plugins/acme.ghost/ui.js` | 404 |

29. **SC-29: plugin UI modules share the window's React** (build)
    - **Given** the built window
    - **When** its page is inspected
    - **Then** it declares bare imports for `react`, `react-dom/client` and `react/jsx-runtime` that resolve to the same React module the window itself runs on, so a plugin importing `react` gets the window's copy

## Scope & non-goals

In scope: the seven UI kinds and their manifest validation; the `ui` manifest field; the UI model
and `ui.contributions`; the window's plugin host (lazy loading, mounting, cleanup, error
containment, the palette, keybinding dispatch, theme application); the slots added to v1's layout;
the `setting.*` and `theme.*` methods with their events and the `quirky ui`, `quirky setting` and
`quirky theme` CLI groups; `getSetting` on both plugin contexts; serving plugin UI files; sharing
React.

Out of scope, each owned by a later item:

- **Routing UI commands from the API to the window, layout and focus in the daemon, open tabs,
  `quirky ui state`:** m0-ui-bridge. Here, commands run only from the palette and keybindings, and
  which view and panel are open is the window's own state.
- **Schemas for the new methods and the generated CLI:** m0-scripting.
- **Moving v1's sidebar, session view, source control, shortcuts and settings into built-in
  contributions:** m0-port-v1 ([D26](../../../loop/decisions/m0-ui-api.md), [D18](../../../loop/decisions/m0-ui-api.md)).
- **The install screen listing a plugin's contributions, distros, safe mode:** m0-distros.
- **Tabs, splits, a bottom panel and layout persistence:** m1-term-ui-core.
- **Keybinding sequences, user keybinding customization beyond disable and override, `when`
  conditions:** m1-term-ui-extras, or whichever item first needs them ([D14](../../../loop/decisions/m0-ui-api.md)).
- **Per-repo settings, setting renames and migrations:** not planned ([D16](../../../loop/decisions/m0-ui-api.md), [D17](../../../loop/decisions/m0-ui-api.md)).
- **Isolating plugins from each other in the window:** excluded by the trust decision.
- **Unloading a changed UI module without reloading the window:** impossible in a browser ([D23](../../../loop/decisions/m0-ui-api.md)).
- **What `mod` and the reserved shortcuts mean on Linux and Windows:** platform work ([D12](../../../loop/decisions/m0-ui-api.md)).

## Decisions Locked

All were made headless and are in the decision log with options, evidence and confidence.

- **Naming convention:** kinds `view`, `panel`, `sidebar-section`, `command`, `keybinding`, `setting`, `theme` (D4); kernel methods `ui.contributions`, `setting.*`, `theme.*`, keeping v1's `settings.*` (D18) — assumed — fast-tracked
- **Layout style:** fixed slot locations in v1's layout (D10); order by `order` then ID (D9); mount into a host element, no DOM access (D6) — assumed — fast-tracked
- **Loading pattern:** one `ui` module per plugin, loaded on first show or run (D5); shared React through bare imports (D7); live updates on `plugin.changed` (D23) — assumed — fast-tracked
- **Error state:** failures contained to their slot or command, retried on the next attempt (D21); field validation and a warning for a missing `ui` (D31) — assumed — fast-tracked
- **Empty state:** an empty slot takes no space; a loading one shows its title and "Loading" (D22) — assumed — fast-tracked
- **Interaction style:** a command palette plus keybindings (D11); modifier chords only (D12); no `when` clauses (D14); theme picker and `theme.*` (D20) — assumed — fast-tracked
- **Duplicate handling:** keybinding clashes resolved by registry precedence and reported (D13); kernel shortcuts reserved (D30) — assumed — fast-tracked
- **Versioning:** four setting types (D15); stale values read as default and kept (D16); user scope only (D17); fixed theme tokens with fallback (D19) — assumed — fast-tracked
- **Response format:** one daemon-resolved UI model (D8); the UI context's shape (D32) — assumed — fast-tracked
- **Authentication:** plugin UI files served on loopback without a token, from declared plugin directories only (D24) — assumed — fast-tracked
- **Approach:** declared slots with lazily imported mount modules (D29) — assumed — fast-tracked
- **Ownership:** the UI API is kernel (D25, locked by roadmap.md); no Orca defects to test (D27, locked by queue.json)

## Industry Insights

- **Extensions get no access to the host's DOM,** so that the host stays free to change its UI;
  class names and structure are internal. https://code.visualstudio.com/api/extension-capabilities/overview
- **Atom's packages broke when it removed its editor's shadow DOM,** because they styled and queried
  internal structure. https://pulsar-edit.dev/docs/atom-archive/shadow-dom
- **VS Code declares views, commands, keybindings, configuration and themes in the manifest;**
  configuration is a JSON Schema subset, and themes are color maps over named keys with fallbacks.
  https://code.visualstudio.com/api/references/contribution-points ;
  https://code.visualstudio.com/api/references/theme-color
- **Silent last-wins keybinding conflicts are a recurring complaint** in VS Code, Zed and Theia;
  users build their own conflict detectors. https://zed.dev/docs/key-bindings ;
  https://www.reddit.com/r/Frontend/comments/1pga8le/does_anyone_else_keep_running_into_vs_code/ ;
  https://github.com/eclipse-theia/theia/issues/2209
- **Obsidian moved to declarative settings in 1.13** so it can render, search, persist and
  validate them without plugin code. https://docs.obsidian.md/plugins/guides/migrate-declarative-settings
- **Code-first plugin loading makes startup pay for every plugin:** one Obsidian plugin added about
  2.5 s in `onload`, and cold starts over 7 s are reported. https://github.com/Automattic/harper/issues/2601 ;
  https://forum.obsidian.md/t/lately-plugins-take-a-lot-more-time-to-load-at-first-obsidian-startup-after-a-pc-boot-reboot-or-after-waiting-some-time-between-2-obsidian-launches/114182
- **Renamed settings strand user values,** and VS Code still has no migration hook.
  https://github.com/microsoft/vscode/issues/91618
- **Two copies of React break hooks,** so the host must own React; Grafana shares one React with
  every plugin. https://dev.to/r9v/the-two-reacts-bug-when-packages-arent-singletons-492h ;
  https://grafana.com/blog/react-19-is-coming-to-grafana-what-plugin-developers-need-to-know/
- **Import maps resolve dynamic `import()` too,** and must be declared before any module loads.
  https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/script/type/importmap
- **Many React roots on one page are supported;** context doesn't cross roots, so shared state goes
  through an external store. https://react.dev/reference/react-dom/client/createRoot
- **Error boundaries miss event-handler and async errors,** so a host must wrap plugin calls itself.
  https://react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary
- **A minimal slot host lazy-imports on first render and gives each contribution its own error
  boundary.** https://tabularis.dev/blog/plugin-ui-extensions
- **Iframe views cost memory and break shortcuts:** VS Code calls retained webviews "high memory
  overhead", and shortcuts don't cross an iframe. https://code.visualstudio.com/api/extension-guides/webview ;
  https://github.com/microsoft/vscode/issues/65333

## Deferred Ideas

- `[tech-spec]` How the window bundles React so plugins and the window share one copy (D7).
- `[tech-spec]` Where UI kind validation lives beside the daemon kinds, and how existing fixtures
  with `view` and `command` contributions stay valid.
- `[tech-spec]` How the window's plugin host is split from the React shell so tests can drive it.
- `[tech-spec]` How a test loads a served plugin UI module in Bun, which can't import over HTTP.
- Disabling a plugin UI automatically after repeated failures (D21).
- Setting deprecation and rename support (D16).
- Command enablement and visibility conditions (D14).

## Glossary

- **UI kinds:** the seven contribution kinds this item adds; see the table in the conceptual model.
- **Slot:** a place in the window that shows contributions of one kind.
- **UI module:** a plugin's one ES module for the window, named by its manifest's `ui` field.
- **Mount function:** what a view, panel or sidebar section provides: `mount(element, props)`,
  returning a cleanup.
- **UI context:** what a UI module's `activate` receives.
- **UI model:** the daemon's resolved view of all UI contributions, returned by `ui.contributions`.
- **Window plugin host:** the part of the webview that loads UI modules, mounts contributions, and
  runs commands and keybindings.
- **Chord:** a key plus modifiers, written like `mod+shift+n`. `mod` is Cmd on macOS.
- **Active, shadowed, unbound:** a keybinding's outcome. Active fires; shadowed lost its chord to
  another keybinding or the kernel; unbound points at a command that isn't in effect.
- **Default theme:** the kernel's own colors, used when no theme is chosen or the chosen one isn't
  in effect.
- **Token:** one named color a theme can set.
