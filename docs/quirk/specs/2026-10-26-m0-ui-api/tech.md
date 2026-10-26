# Tech spec: UI plugin API

**Status:** Draft for build. Logic spec: [logic.md](logic.md). Tier gate: the user requested a tech spec (Status line), and the work crosses the protocol, daemon, CLI and UI packages.

All paths are relative to the repo root `/Users/zpyoung/orca/workspaces/quirky/build-roadmap`.

## Architecture

Four packages change. Nothing new is added outside them.

| Package | What it gains |
|---|---|
| `packages/protocol` | UI types, chord parsing and matching, setting value checks, theme tokens, new `Methods` entries and events |
| `packages/daemon` | UI kind validation, the `ui` manifest field, a pure UI model builder, a `UiService` for settings and themes, two store tables, new kernel methods, `getSetting` on the plugin context, the `/plugins/` file route |
| `packages/cli` | `quirky ui contributions`, `quirky setting list|get|set|reset`, `quirky theme list|set` |
| `packages/ui` | A framework-free window plugin host, React slot components, a command palette, plugin keybinding dispatch, theme application, plugin settings in the Settings dialog, a build that shares React through an import map |

Data moves like this. The daemon's `PluginHost` computes the registry as today. A new pure function, `buildUiModel`, turns the effective contributions and plugin list into the UI model plus derived warnings. `UiService` serves the model, settings and themes to `methods.ts`. In the window, `WindowPluginHost` (in `packages/ui/src/plugins/host.ts`) fetches the model over the existing `Connection`, imports UI modules from `/plugins/<id>/<path>`, and exposes a subscribable state that React components render. The React layer stays thin: every rule a scenario checks lives in the host or in protocol helpers, so tests drive them without a DOM ([logic D28](logic.md#behavior--scenarios)).

Key libraries: Bun's bundler (`Bun.build`) for the UI with code splitting, browser import maps, React 19 `createRoot`, `bun:sqlite` in the daemon store.

## Code references

Create:

- `packages/protocol/src/ui.ts`: UI types, `THEME_TOKENS`, `DEFAULT_THEME`, `RESERVED_CHORDS`, `parseChord`, `chordFromKeyEvent`, `checkSettingValue`, `settingDeclarationOf`. Export from `packages/protocol/src/index.ts`.
- `packages/daemon/src/plugins/ui-kinds.ts`: field checks for the seven UI kinds, called from `checkKindEntry` in `packages/daemon/src/plugins/kinds.ts:38`.
- `packages/daemon/src/plugins/ui-model.ts`: pure `buildUiModel`.
- `packages/daemon/src/plugins/ui-service.ts`: `UiService`.
- `packages/daemon/src/plugin-files.ts`: `servePluginFile`.
- `packages/cli/src/commands/ui.ts`, `setting.ts`, `theme.ts`.
- `packages/ui/src/plugins/host.ts`: `WindowPluginHost`.
- `packages/ui/src/plugins/settingsGroups.ts`: pure grouping of plugin settings for the dialog.
- `packages/ui/src/plugins/PluginSlot.tsx`, `SidebarSections.tsx`, `PanelToggles.tsx`, `CommandPalette.tsx`, `ThemeVariables.tsx` (or equivalently named components, one job each).
- `packages/ui/src/vendor/react.ts`, `react-dom-client.ts`, `jsx-runtime.ts`: build entry points that re-export the full React APIs.

Modify:

- `packages/protocol/src/rpc.ts`: `Methods` (lines 28-141) and `QuirkyEvent` (148-159).
- `packages/protocol/src/plugins.ts`: `PluginManifest` (176-192) gains `ui?: string`; `PluginInfo` (10-22) gains `ui?: string`; `PluginContext` (42-61) gains `getSetting`.
- `packages/daemon/src/plugins/manifest.ts`: `FIELDS` (15-26) gains `ui`; `checkMain` (62-72) generalised to take the field name, and called for `ui` beside the call at line 177.
- `packages/daemon/src/plugins/kinds.ts`: `ALLOWED_FIELDS` (5-10) and `checkKindEntry` (38-58) delegate the UI kinds to `ui-kinds.ts`.
- `packages/daemon/src/plugins/host.ts`: `PluginHostOptions` (32-44) gains `deriveDiagnostics`; `recompute()` (190) calls it; `infoOf` (216) appends its warnings and the plugin's `ui`; the `Pick` unions at lines 19-30 and 354 and the `defaults` stub (354-369) gain `getSetting`; a public `pluginFiles(pluginId)` accessor.
- `packages/daemon/src/plugins/runtime.ts`: `createPluginRuntime` (46) builds the `UiService`, passes it to `createHandlers` (51), and adds `getSetting` to the context extension object (63-100) behind `guard()`.
- `packages/daemon/src/methods.ts`: `createHandlers` (77) gains the new handlers beside the `plugin.*` entries (196-211).
- `packages/daemon/src/store.ts`: two tables in the constructor's `CREATE TABLE` block (43-103) and their accessors.
- `packages/daemon/src/server.ts`: `ServerOptions` (19-27) gains `pluginFile`; the `/plugins/` branch goes after the hook branch (line 94) and before `serveStatic` (line 96).
- `packages/daemon/src/daemon.ts`: wire `deriveDiagnostics` into `new PluginHost` (156-170) and `pluginFile` into `startServer` (196-205).
- `packages/cli/src/commands/index.ts`: add the new commands to `COMMANDS` (25-50).
- `packages/cli/test/fixtures/fake-daemon.ts`: cases for the new methods in `handle()` (196-325).
- `packages/ui/build.ts`: vendor entries, `splitting`, `external`, an output-dir override.
- `packages/ui/src/index.html`: the import map before the module script.
- `packages/ui/src/connection.ts`: `callAny` and an event fan-out for the host; host refresh after `refreshAll` on (re)connect (`loop`, 96-127).
- `packages/ui/src/context.tsx`: `AppContextValue` gains `plugins: WindowPluginHost`.
- `packages/ui/src/main.tsx`: construct the host.
- `packages/ui/src/App.tsx`, `components/Sidebar.tsx`, `components/MainArea.tsx`, `components/useShortcuts.ts`, `components/SettingsDialog.tsx`, `terminal/TerminalPane.tsx`, `styles.css`: the slots, palette, key dispatch, plugin settings and theme.
- Tests listed under [Testing strategy](#testing-strategy), and the existing fixtures listed under [Existing fixtures](#existing-fixtures).

## Contracts & interfaces

### Protocol types ([Conceptual model](logic.md#conceptual-model), SC-2)

SCHEMA: UI model returned by `ui.contributions`
```
UiModel = {
  sidebarSections: UiSlotEntry[]   // order asc, then id
  panels: UiSlotEntry[]            // order asc, then id
  views: UiSlotEntry[]             // id asc
  commands: UiCommandEntry[]       // title asc (localeCompare), then id
  keybindings: UiKeybinding[]      // id asc
  settings: UiSettingEntry[]       // id asc
  themes: ThemeInfo[]              // the default theme first, then title asc
  theme: { chosen: string; active: string }   // 'default' or a theme ID
  modules: Record<string, { url: string; provides: string[] }>  // per plugin with a `ui` field and code-backed contributions in effect
}
UiSlotEntry = { id: string; kind: 'sidebar-section' | 'panel' | 'view'; plugin: string; title: string; order: number; module: string | null }
UiCommandEntry = { id: string; plugin: string; title: string; description?: string; module: string | null }
UiKeybinding = { id: string; plugin: string; key: string; command: string; status: 'active' | 'shadowed' | 'unbound'; shadowedBy?: string }
UiSettingEntry = { id: string; plugin: string } & SettingDeclaration
SettingDeclaration = { type: 'boolean' | 'number' | 'string' | 'enum'; title: string; description?: string; default: boolean | number | string; minimum?: number; maximum?: number; values?: string[] }
SettingInfo = UiSettingEntry & { value: boolean | number | string; stored?: { value: unknown; valid: boolean } }
ThemeInfo = { id: string; plugin: string | null; title: string; appearance: 'dark' | 'light'; colors: Record<ThemeToken, string> }
ThemeList = { chosen: string; active: string; themes: ThemeInfo[] }
```

- `plugin` on every entry is the plugin whose declaration is in effect, which for an override is the overriding plugin (`ContributionInfo.plugin` of the effective entry).
- `module` is `modules[plugin].url`, or null when that plugin has no `ui` field. `url` is `/plugins/<pluginId>/<ui>`, with `<ui>` normalised to forward slashes and no leading `./`.
- `provides` lists every contribution ID of a code-backed kind (`view`, `panel`, `sidebar-section`, `command`) that the plugin declares or overrides, whether or not that declaration is in effect. It is what the window lets the module `provide`.
- `title` defaults to the contribution name for `view` and `command`; `order` defaults to 100.
- `keybinding.key` is the canonical chord (below); `command` is always a full command ID.
- `shadowedBy` is the winning keybinding ID, or `kernel` for a reserved chord.
- `stored` is absent when no value is stored; `valid: false` when the stored value fails `checkSettingValue` against the current declaration.

CONFIG: theme tokens and the default theme (values from `packages/ui/src/styles.css:1-16` and `packages/ui/src/terminal/TerminalPane.tsx:42`)
```
THEME_TOKENS = bg, bg-raised, bg-hover, bg-active, border, text, muted, accent, amber, green, grey, dim, danger, terminal-background, terminal-foreground, terminal-cursor
DEFAULT_THEME = { id: 'default', plugin: null, title: 'Quirky Dark', appearance: 'dark',
  colors: bg #16181d, bg-raised #1d2027, bg-hover #262a33, bg-active #2d3240, border #2b2f3a, text #d7dae0, muted #8a909e,
          accent #4f8ff7, amber #f0b429, green #3fb950, grey #8b949e, dim #4a505c, danger #e5534b,
          terminal-background #16181d, terminal-foreground #d7dae0, terminal-cursor #d7dae0 }
```

A theme color is a hex color matching the REGEX below. Window tokens map to CSS custom properties `--<token>`; the three terminal tokens feed xterm's `theme.background`, `foreground` and `cursor`.

REGEX: theme color
```
^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$
```

### Chords ([Pressing a key](logic.md#data-flow), SC-15 to SC-18, logic D12)

CONTRACT: `packages/protocol/src/ui.ts`
```
parseChord(text: string): { ok: true; chord: string } | { ok: false; error: string }
chordFromKeyEvent(event: { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): string | null
RESERVED_CHORDS: readonly string[]   // mod+t, mod+w, mod+1 … mod+9, mod+shift+p
```

- Grammar: `+`-separated, case-insensitive; modifiers `mod`, `cmd`, `ctrl`, `alt`, `shift`, each at most once; exactly one key, last.
- Keys: `a`-`z`, `0`-`9`, `f1`-`f12`, `enter`, `escape`, `tab`, `space`, `backspace`, `delete`, `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`, and the punctuation `, . / ; ' [ ] \ - = ``.
- Canonical form: on macOS `cmd` is rewritten to `mod`; modifiers in the order `mod`, `ctrl`, `alt`, `shift`; key lowercase. `parseChord('Shift+Cmd+K')` gives `mod+shift+k`.
- Errors, exactly as SC-5 prints them after the `keybinding <name>: ` label: `key needs a modifier or a function key` (no `mod`, `cmd`, `ctrl` or `alt`, and the key isn't `f1`-`f12`), `key must end in one key` (no key, or two keys), `unknown key \`<k>\``, `unknown modifier \`<m>\``, `duplicate modifier \`<m>\``.
- `chordFromKeyEvent` reads letters from `code` (`KeyA` → `a`) and digits from `code` (`Digit1` → `1`), so Shift and Alt don't change them; F-keys and named keys from `key`; punctuation from `code`. It returns null for a bare modifier press. `metaKey` maps to `mod` on macOS.

### Setting values ([Changing settings](logic.md#data-flow), SC-19 to SC-21)

CONTRACT: `packages/protocol/src/ui.ts`
```
checkSettingValue(id: string, declaration: SettingDeclaration, value: unknown): string | null   // null when valid, else the message
```

Messages, exactly as SC-20 shows: `<id> must be a boolean`, `<id> must be a number` (finite numbers only), `<id> must be a string`, `<id> must be at least <minimum>`, `<id> must be at most <maximum>`, `<id> must be one of <v1>, <v2>`.

### UI kind validation ([SC-5](logic.md#the-ui-model), logic D31)

`checkKindEntry` hands the seven UI kinds to `ui-kinds.ts`, which applies the same unknown-field rule as daemon kinds (`<label>: unknown field \`<f>\``) and these fields. Labels are `<kind> <name>` or `override <full id>`, as today.

| Kind | Allowed fields | Rules |
|---|---|---|
| `sidebar-section`, `panel` | `title`, `description`, `order` | `title` required non-empty string; `order` a finite number |
| `view`, `command` | `title`, `description` | `title` a non-empty string when present |
| `keybinding` | `key`, `command`, `description` | `key` required, valid per `parseChord`; `command` required, a contribution name (resolved in the declaring plugin's namespace) or a full ID of kind `command` |
| `setting` | `type`, `default`, `title`, `description`, `minimum`, `maximum`, `values` | `type` one of the four; `title` required; `default` required and valid per `checkSettingValue`; `minimum`/`maximum` only on `number`, finite, `minimum <= maximum`; `values` required for `enum` and only allowed there, a non-empty list of distinct non-empty strings |
| `theme` | `title`, `appearance`, `colors`, `description` | `title` required; `appearance` `dark` or `light`; `colors` an object whose keys are in `THEME_TOKENS` and whose values match the color REGEX |

Message texts in SC-5 are normative. `description` must be a string, as for daemon kinds.

`ui` (manifest field) is validated exactly like `main`, with the message `field 'ui' must be a relative path inside the plugin directory, got '<value>'` for an escape and `field 'ui' must be a non-empty string` for a wrong type.

### Existing fixtures

These fixtures are inside the new rules once `view` and `command` titles are optional and `panel` needs a title, except the ones listed here, which the validation task updates in the same commit:

- `packages/daemon/test/plugins/kinds.test.ts:117-119` pins "leaves a command entry with arbitrary fields alone". Change it to assert the unknown-field errors for `anything` and `interval`, and add the same "leaves alone" assertion for a kind with no checker (for example `widget`).
- `packages/daemon/test/plugins/manifest.test.ts:113` and `packages/daemon/test/plugins/registry.test.ts:74` declare `panel` with no title. Add a title.

Any other fixture the new validation rejects is fixed the same way, by adding valid fields, never by loosening a rule.

### Host changes ([Data flow](logic.md#data-flow))

CONTRACT: `packages/daemon/src/plugins/host.ts`
```
PluginHostOptions.deriveDiagnostics?: (view: { effective: ContributionInfo[]; plugins: PluginInfo[] }) => Map<string, PluginDiagnostic[]>
PluginHost.pluginFiles(pluginId: string): { dir: string; ui: string } | null
```

- `recompute()` calls `deriveDiagnostics` once after the registry is computed, with the effective contributions and the plugin list as it would be listed without derived diagnostics. The result is cached until the next `recompute()`. `infoOf` appends the cached warnings after the registry diagnostics and before runtime warnings. Calling it must not emit `plugin.changed` (unlike `addWarning`, which does), so a model rebuild can't loop.
- `PluginInfo.ui` is the manifest's `ui` value when present.
- `pluginFiles` returns the directory and `ui` path of the plugin with that ID that is not `invalid` and declares `ui`. When two entries share an ID (an installed duplicate of a built-in), the valid one is returned. Null otherwise.

### UI model builder ([The UI model](logic.md#the-ui-model), SC-1 to SC-3, SC-6, SC-16 to SC-18)

CONTRACT: `packages/daemon/src/plugins/ui-model.ts`
```
buildUiModel(input: { effective: ContributionInfo[]; plugins: PluginInfo[]; chosenTheme: string }): { model: UiModel; warnings: Map<string, PluginDiagnostic[]> }
```

Pure, no I/O. It is used twice: by `deriveDiagnostics` (warnings only) and by `UiService` (model).

- Only effective contributions of the seven kinds are read; other kinds are ignored.
- Keybindings:
  1. A keybinding whose command ID isn't an effective `command` is `unbound`.
  2. The remaining keybindings are grouped by canonical chord. A chord in `RESERVED_CHORDS` makes every keybinding on it `shadowed` with `shadowedBy: 'kernel'`.
  3. Otherwise one per chord is `active`. The winner: the keybinding whose owner plugin is `installed` beats one from a `builtin`; with equal sources, an owner that depends on the other's owner (transitively, through `PluginInfo.dependencies`) wins; otherwise the owner ID that sorts first wins; within one plugin, the contribution ID that sorts first wins. This is the precedence of m0-registry D8 (`registry.ts:256-266`), reimplemented over `PluginInfo` because the registry's helper is private. The rest are `shadowed` by the winner.
- Warnings, keyed by the plugin that owns the losing or offending entry:
  - `<loser id> is shadowed by <winner id> on <chord>`
  - `<id> is shadowed by the window's own shortcut <chord>`
  - `declares commands, views, panels or sidebar sections but has no ui module` (once per plugin that owns an effective code-backed entry and has no `ui`)
- Themes: the default theme plus each effective `theme`, with `colors` completed from `DEFAULT_THEME`. `theme.active` is `chosenTheme` when it is the default or an effective theme ID, else `default`. `theme.chosen` is `chosenTheme`.
- Settings: each effective `setting`, as declared.

### UiService ([Changing settings](logic.md#data-flow), SC-19 to SC-27)

CONTRACT: `packages/daemon/src/plugins/ui-service.ts`
```
class UiService {
  constructor(options: { plugins: PluginHost; store: Store; broadcast: (event: QuirkyEvent) => void })
  contributions(): UiModel
  listSettings(filter: { pluginId?: string }): SettingInfo[]
  getSetting(id: string): SettingInfo                    // NotFound when not an effective setting
  setSetting(id: string, value: unknown): SettingInfo    // NotFound; InvalidParams with checkSettingValue's message
  resetSetting(id: string): SettingInfo                  // NotFound; deletes the stored value
  valueFor(pluginId: string, name: string): unknown      // for contexts; throws Error naming the ID when unknown
  listThemes(): ThemeList
  setTheme(id: string): ThemeList                        // NotFound unless 'default' or an effective theme ID
}
```

- The model is rebuilt from `plugins.contributions({})` and `plugins.list()` on each call; no cache to invalidate.
- `value` is the stored value when valid, else the default. A stored value is never deleted except by `resetSetting`, so a disabled plugin's settings and an invalid stored value survive (SC-21, SC-22).
- `setSetting` and `resetSetting` broadcast `{ type: 'setting.changed', id, value }` with the new effective value. `setTheme` broadcasts `{ type: 'theme.changed', chosen, active }`.
- `valueFor` resolves a short name to `setting:<pluginId>/<name>`; a full ID reads any effective setting. Unknown or not effective throws `Error('no setting <id>')`.

### Store tables

SCHEMA: added to the constructor's `CREATE TABLE IF NOT EXISTS` block in `packages/daemon/src/store.ts`
```
setting_values (id TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)   -- value is JSON
ui_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)                                      -- key 'theme' holds the chosen theme ID as JSON
```

CONTRACT: `Store`
```
getSettingValue(id: string): { value: unknown } | null
setSettingValue(id: string, value: unknown): void
deleteSettingValue(id: string): void
getUiState(key: string): unknown | null
setUiState(key: string, value: unknown): void
```

Never write plugin setting values into the existing `settings` table: `getSettings()` (304-310) spreads every row into v1's `Settings`.

### Daemon methods and events ([Behavior & scenarios](logic.md#behavior--scenarios))

SCHEMA: new `Methods` entries in `packages/protocol/src/rpc.ts`
```
'ui.contributions': { params: Record<string, never>; result: UiModel }
'setting.list':     { params: { pluginId?: string }; result: SettingInfo[] }
'setting.get':      { params: { id: string }; result: SettingInfo }
'setting.set':      { params: { id: string; value: unknown }; result: SettingInfo }
'setting.reset':    { params: { id: string }; result: SettingInfo }
'theme.list':       { params: Record<string, never>; result: ThemeList }
'theme.set':        { params: { id: string }; result: ThemeList }
```

SCHEMA: new `QuirkyEvent` members
```
{ type: 'setting.changed'; id: string; value: boolean | number | string }
{ type: 'theme.changed'; chosen: string; active: string }
```

- Errors use `packages/daemon/src/errors.ts`: `notFound('no setting <id>')`, `notFound('no theme <id>')`, `invalidParams(<checkSettingValue message>)`. A missing or non-string `id` is InvalidParams through the existing `str` helper (`methods.ts:22`); `value` is read raw from params and `undefined` is InvalidParams `value is required`.
- v1's `settings.get` and `settings.set` (`methods.ts:98-104`) are untouched.

### Plugin context `getSetting` (SC-23, logic D32)

CONTRACT: `packages/protocol/src/plugins.ts`
```
PluginContext.getSetting(name: string): unknown   // short name in the plugin's own namespace, or a full setting ID
```

Added to the context extension in `runtime.ts` behind `guard()`, delegating to `UiService.valueFor`. The `defaults` stub in `host.ts` throws like the others.

### Plugin file route ([Showing a slot](logic.md#data-flow), SC-28, logic D24)

CONTRACT: `packages/daemon/src/plugin-files.ts`
```
servePluginFile(lookup: (pluginId: string) => { dir: string } | null, pathname: string, method: string): Response
```

- `server.ts` sends GET and HEAD requests whose path starts with `/plugins/` here, before `serveStatic`. `ServerOptions.pluginFile` is `(id) => plugins.pluginFiles(id)`.
- The first segment is the plugin ID; the rest, percent-decoded, is the file path inside the plugin directory. 404 when the lookup is null, the path is empty or fails to decode (400 for a decode failure, as `serveStatic` does), the resolved path leaves the directory, the real path (after symlinks) leaves the directory's real path, or the target isn't a regular file. No `index.html` fallback.
- Content types come from the same map as `static.ts`; export it from `static.ts` rather than copying it. `.ts` files are not served as JavaScript (the map has no `.ts` entry, so they get `application/octet-stream`).
- No token, matching `serveStatic`.

### CLI ([SC-1](logic.md#the-ui-model), SC-19, SC-20, SC-25 to SC-27)

| Command | Calls | Human output |
|---|---|---|
| `quirky ui contributions` | `ui.contributions` | One section per slot (`SIDEBAR`, `PANELS`, `VIEWS`, `COMMANDS`, `KEYBINDINGS`, `SETTINGS`, `THEMES`), each a table: ID, PLUGIN, TITLE, ORDER for slots; ID, KEY, COMMAND, STATUS for keybindings (STATUS shows `shadowed by <x>`); empty sections omitted |
| `quirky setting list [--plugin <id>]` | `setting.list` | Table ID, TYPE, VALUE, DEFAULT; an invalid stored value adds `(stored <v> is invalid)` |
| `quirky setting get <id>` | `setting.get` | The value as JSON |
| `quirky setting set <id> <value>` | `setting.set` | The new value as JSON. `<value>` is parsed as JSON when it parses, otherwise used as a string, so `16` is a number and `grid` a string |
| `quirky setting reset <id>` | `setting.reset` | The default as JSON |
| `quirky theme list` | `theme.list` | Table ID, TITLE, APPEARANCE, with `*` on the active theme and `(chosen)` on a chosen theme that isn't active |
| `quirky theme set <id>` | `theme.set` | The active theme ID |

`--json` prints the method's result, through `ctx.out.result` as every command does. Errors exit 1 through the existing error path.

### Window plugin host ([Showing a slot](logic.md#data-flow), SC-4, SC-7 to SC-15, SC-23 to SC-26)

CONTRACT: `packages/ui/src/plugins/host.ts`
```
type HostDeps = {
  call(method: string, params: Record<string, unknown>): Promise<unknown>
  onEvent(listener: (event: QuirkyEvent) => void): () => void
  importModule(url: string): Promise<unknown>
  toast(title: string, body: string): void
  log(message: string): void
  activationTimeoutMs?: number            // default 10000
}
type SlotStatus = { status: 'loading' } | { status: 'mounted' } | { status: 'error'; message: string }
type HostState = {
  model: UiModel | null
  settings: SettingInfo[]
  plugins: Record<string, { state: 'idle' | 'loading' | 'active' | 'failed'; error?: string }>
  slots: Record<string, SlotStatus>          // keyed by mount handle key: contribution ID
  openView: { id: string; input?: unknown } | null
  openPanel: string | null
  themeVariables: Record<string, string>     // '--bg' → '#16181d', … plus terminal-* tokens under '--terminal-*'
}
class WindowPluginHost {
  constructor(deps: HostDeps)
  refresh(): Promise<void>                   // fetch ui.contributions and setting.list, reconcile
  getState(): HostState
  subscribe(listener: () => void): () => void
  mount(id: string, element: HTMLElement, props?: { input?: unknown }): () => void
  runCommand(id: string, args?: unknown): Promise<void>
  handleKey(event: { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean
  paletteCommands(filter: string): UiCommandEntry[]
  openView(id: string, input?: unknown): void
  closeView(): void
  togglePanel(id: string, open?: boolean): void
  stop(): void
}
```

CONTRACT: what a UI module exports and receives (exported as types from `packages/protocol/src/ui.ts` so plugin authors can import them)
```
UiPluginModule = { activate(context: UiPluginContext): void | Promise<void>; deactivate?(): void | Promise<void> }
UiPluginContext = {
  readonly pluginId: string
  log(message: string): void
  provide(contributionId: string, implementation: unknown): void
  call(method: string, params?: Record<string, unknown>): Promise<unknown>
  subscribe(listener: (event: QuirkyEvent) => void | Promise<void>): () => void
  getSetting(name: string): unknown
  executeCommand(id: string, args?: unknown): Promise<void>
  openView(id: string, input?: unknown): void
  closeView(): void
  togglePanel(id: string, open?: boolean): void
}
MountFunction = (element: HTMLElement, props: { input?: unknown }) => (() => void) | void
CommandHandler = (args?: unknown) => unknown
```

The host's rules, each tied to scenarios:

- **Lazy load (SC-7, SC-8).** `mount` and `runCommand` load the owner's module on first use; nothing else does. Load means `importModule(url)`, then `activate(context)`, both within `activationTimeoutMs` (else failed with `activation timed out`). One load per plugin is in flight at a time; concurrent callers share it. While loading, the slot is `loading`.
- **Provide (SC-12).** `provide` accepts only IDs in `model.modules[pluginId].provides`, and only during or after `activate`; any other ID makes the load fail with `<pluginId> does not declare <id>`. An implementation of a slot kind must be a function (the mount function); a command's must be a function.
- **Mount (SC-7, SC-9, SC-10).** `mount(id, element, props)` calls the implementation with exactly `element` and `{ input }` (for views; `{}` otherwise). The returned function, when called, runs the plugin's cleanup once. If the plugin activated without providing `id`, the slot is `error` with `<pluginId> did not provide <id>`.
- **Errors (SC-13).** Messages, exactly: `<pluginId> failed to load: <message>` (import), `<pluginId> failed to activate: <message>`, `<pluginId>: <message>` (mount throws), toast title `<command id> failed: <message>` (command throws or rejects; body the message). A plugin with no `ui` fails with `<pluginId> has no ui module` (SC-6). After a failure, the next `mount` or `runCommand` for that plugin loads again; a retried import appends `?attempt=<n>` to the URL so the browser doesn't reuse a failed fetch, and a module that imported but failed to activate is activated again without re-importing.
- **Teardown (SC-4, SC-13).** A cleanup or `deactivate` that throws is logged as `<pluginId>: cleanup failed: <message>` or `<pluginId>: deactivate failed: <message>`, and teardown continues. Deactivation revokes the context: its `call`, `provide`, `executeCommand` and slot actions throw `<pluginId> is not active`, and its subscribers receive nothing more.
- **Reconcile (SC-4).** `refresh()` runs on start, on every `plugin.changed` and after a reconnect. Mounted contributions no longer in the model, or now owned by another plugin, are cleaned up and their slots dropped; React re-renders and mounts what is new. An open view or panel no longer in the model is closed. A plugin that owns no code-backed entry in the new model is deactivated if active. A plugin that was loading when this happened finishes its load, mounts nothing that left, and is deactivated straight away if it owns nothing.
- **Views and panels (SC-9, SC-10, logic D10).** `openView` replaces any open view; `togglePanel` closes any other open panel. The host doesn't know about source control: `App` keeps v1's `scmOpen` and the host's `openPanel` mutually exclusive (opening one closes the other).
- **Commands and palette (SC-14).** `runCommand` of an ID not in the model rejects with `no command <id>`. `paletteCommands(filter)` returns the model's commands whose title contains `filter` case-insensitively, in model order.
- **Keys (SC-15 to SC-18).** `handleKey` computes `chordFromKeyEvent`, finds the `active` keybinding on that chord, runs its command (without awaiting) and returns true; otherwise false. It never handles a reserved chord.
- **Events (SC-11, SC-23).** Daemon events reach plugin subscribers on a later task, each listener's error logged with its plugin ID. `setting.changed` updates `settings` before plugin listeners see it, so `getSetting` inside a listener reads the new value. `theme.changed` refetches the model's theme part (calling `refresh()` is acceptable).
- **Theme (SC-25, SC-26).** `themeVariables` is computed from the model's active theme on every refresh.
- **getSetting.** Same resolution and error as the daemon's `valueFor`, over the host's cached `settings`.

### React shell (logic D10, D11, D22, SC-24)

- `PluginSlot` renders one `div` per contribution and calls `host.mount` in an effect, returning the dispose. It renders the contribution's title with a muted `Loading` line while the slot is `loading`, and an error box with the message for `error`. The plugin's element is a child `div` the plugin owns; the host's wrapper markup is not passed to the plugin.
- `Sidebar` renders the model's sidebar sections in order between `.repo-scroll`'s repo list and `AddRepoForm` (`Sidebar.tsx:75-85`). No sections, no markup.
- `MainArea`'s header (`MainArea.tsx:18-37`) gets one toggle button per panel after "Source control". `App` renders the open panel in the right column (`App.tsx:33-37`, reusing the `.scm-panel` column styling). `MainArea`'s body renders the open view in place of `SessionView`; selecting a session closes the view.
- `CommandPalette` opens on `mod+shift+p` (handled in `useShortcuts`, a reserved chord), filters with `host.paletteCommands`, runs on Enter, closes on Escape.
- `useShortcuts` keeps v1's handlers first (`useShortcuts.ts:15-34`); after them, in the same capture-phase listener, it calls `host.handleKey(event)` and on true calls `preventDefault()` and `stopPropagation()`.
- `SettingsDialog` keeps v1's form at the top, then renders `settingsGroups(host settings)` (groups by plugin ID, sorted by plugin ID, settings sorted by ID; checkbox for `boolean`, number input with min and max for `number`, text input for `string`, select for `enum`), then a theme picker over `model.themes`. Saving calls `setting.set` for each changed plugin setting and `theme.set` if the theme changed; a refused value shows under its field and keeps the dialog open.
- `ThemeVariables` (an effect in `App`) writes `host.getState().themeVariables` onto `document.documentElement.style`. `styles.css` keeps its `:root` defaults, so the page looks the same with no theme chosen. `TerminalPane` reads the three terminal tokens for `theme` at construction and assigns `term.options.theme` when they change.

### Sharing React ([SC-29](logic.md#serving-and-sharing), logic D7)

- `build.ts` builds `src/main.tsx` with `external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime']`, so `main.js` keeps bare imports of them, and builds `src/vendor/react.ts`, `react-dom-client.ts` and `jsx-runtime.ts` in one `splitting: true` build into `dist/vendor/`, so they share one React chunk.
- Each vendor entry re-exports the full named API of its package plus the default export where the package has one. Bun re-exporting a CommonJS package with `export *` may drop names; the build test (below) is the check, and the implementer lists names explicitly if needed.
- `index.html` gets, before the module script: CONFIG
  ```
  <script type="importmap">{"imports":{"react":"./vendor/react.js","react-dom/client":"./vendor/react-dom-client.js","react/jsx-runtime":"./vendor/jsx-runtime.js"}}</script>
  ```
  `react-dom` itself is not mapped: `main.js` imports only `react-dom/client`. If the bundle needs bare `react-dom`, map it too.
- `build.ts` takes the output directory from `QUIRKY_UI_OUT` when set (default `dist`), so the build test writes to a temp directory and never touches `packages/ui/dist`.

## DO-NOT-CHANGE fences

- `packages/daemon/src/plugins/registry.ts` `computeRegistry` and its precedence (`beats`, lines 256-266): the UI model reads its output and reimplements the order for keybindings; changing it would move every override outcome m0-registry tested.
- v1's `settings.get` / `settings.set`, the `Settings` type (`packages/protocol/src/model.ts:124-129`) and the `settings` table: m0-port-v1 moves them (logic D18).
- `serveStatic`'s SPA fallback (`static.ts:47-51`): the window's client routes depend on it. Only export its content-type map.
- The existing `plugin.*` method results, except the additive `PluginInfo.ui`: m0-registry's tests and the CLI rely on them.
- v1's shortcuts in `useShortcuts.ts` (Cmd+T, Cmd+W, Cmd+1 to Cmd+9): the M0 exit test requires v1 behavior unchanged.
- `docs/loop/LOOP.md` and `scripts/build-loop/`: protected by the loop.
- `PROTOCOL_VERSION` (`rpc.ts:18`): the changes are additive, so it stays 1.

## Always / Ask / Never

- **Always:** start every daemon in tests with a fresh temp `QUIRKY_HOME` and `builtinPluginsDir` pointing at a temp dir or null; keep home prefixes short (the PTY socket limit, m0-registry D33); put error and warning texts exactly as the logic spec's tables print them; keep `WindowPluginHost` free of React and DOM globals, so Bun tests can run it.
- **Ask (decide and log as a decision):** the CSS of the new components; exact human table layouts beyond the columns listed; whether `PluginSlot`'s error box offers a retry button.
- **Never:** let a plugin's element be the host's own wrapper or pass it any other host node; write plugin values into the `settings` table; serve a file outside a plugin directory; load a UI module for a contribution that isn't being shown or run; edit the real `~/.quirky`.

## Cross-cutting

- **Security:** `/plugins/` is unauthenticated, like the UI bundle (logic D24); the realpath check stops symlink escapes. Theme colors are hex only, so no CSS text reaches `style.setProperty` beyond a color. Plugin code is trusted (roadmap "Trust").
- **Observability:** window-side plugin errors go to `HostDeps.log` (the browser console in the app) with the plugin ID, and to the slot or a toast.
- **Migration:** the two tables are created with `IF NOT EXISTS`; nothing existing is migrated.
- **Rollback:** reverting the branch drops two unused tables' readers; stored values stay in the database harmlessly.
- **Platform:** `mod` as Cmd and the reserved chords are macOS meanings (logic D12, `deferred: platform`). `parseChord` and `chordFromKeyEvent` take the platform from one constant so Linux and Windows can change it in one place.

## Testing strategy

Scenario tests are named `SC-<n>: <title>` and assert the logic spec's Then clauses and tables.

| File | Covers | How |
|---|---|---|
| `packages/protocol/test/ui.test.ts` | Chord grammar, canonical form, every error text, `chordFromKeyEvent` with Shift and Alt, `checkSettingValue` messages | Unit |
| `packages/daemon/test/plugins/ui-kinds.test.ts` | Every rule in the validation table | Unit, through `parseManifest` like `kinds.test.ts` |
| `packages/daemon/test/plugins/ui-model.test.ts` | Ordering, defaults, keybinding precedence (installed, dependent, ID, same plugin), reserved chords, unbound before clash, theme completion, warnings | Unit over hand-built `ContributionInfo` and `PluginInfo` |
| `packages/daemon/test/plugins/ui-api.test.ts` | SC-1 to SC-3, SC-5, SC-6 (daemon half), SC-16 to SC-22 (daemon half), SC-25 to SC-28 | Real daemon through `startHarness`; fixture plugins through `writePlugin` / `writeModulePlugin`; events through `connectWithEvents`; CLI through `runCli(args, { home: harness.home })` from `packages/cli/test/fixtures/fake-daemon.ts`, which works against a real daemon because it sets `QUIRKY_HOME`; HTTP through `fetch` to `runtime.port`; restarts by stopping and starting a daemon on the same home |
| `packages/daemon/test/store.test.ts` (or the existing store test file) | The two tables' accessors | Unit |
| `packages/daemon/test/server.test.ts` | `/plugins/` routing order and SC-28's table, including a symlink escape | Real daemon |
| `packages/cli/test/ui.test.ts`, `setting.test.ts`, `theme.test.ts` | Human output, `--json`, value parsing, exit codes | `FakeDaemon` cases |
| `packages/ui/test/plugin-host.test.ts` | SC-4, SC-6 to SC-16, SC-18, SC-23, SC-25, SC-26 (window halves) | `WindowPluginHost` connected to a real daemon: `startHarness` imported from `packages/daemon/test/helpers.ts`, a `QuirkyClient` providing `call` and `onEvent`, and an `importModule` that `fetch`es the served URL, writes it under a per-test temp dir, and `import()`s that file. Elements are plain objects standing in for `HTMLElement` (the mount functions write to a field). Fixture UI modules are plain JavaScript with no imports |
| `packages/ui/test/settingsGroups.test.ts` | SC-24 | Unit over `SettingInfo[]` and `ThemeInfo[]`, plus a host test that the save path calls `setting.set` and `theme.set` on a real daemon |
| `packages/ui/test/build.test.ts` | SC-29 | Runs `build.ts` with `QUIRKY_UI_OUT` set to a temp dir; asserts the import map precedes the module script and maps the three specifiers to files that exist; asserts `main.js` imports `react` and `react/jsx-runtime` as bare specifiers and contains no copy of React (no `react.transitional.element` symbol string); imports `vendor/react.js` and asserts its exports include every key of `require('react')` |

Acceptance bar: `bun run test`, `bun test scripts` (except the queue-state test recorded in m0-daemon-api D31) and `bun run typecheck` all pass, and every scenario SC-1 to SC-29 has a named test.

## Non-goals

- Routing commands from the API to the window, layout in the daemon, `quirky ui state` (m0-ui-bridge).
- Moving v1's sidebar, session view, source control, shortcuts or settings into contributions (m0-port-v1).
- Schemas and a generated CLI for the new methods (m0-scripting).
- A real-browser test of the window; the host is tested without a DOM (logic D28).
- `when` clauses, chord sequences, user rebinding, setting scopes, bottom panels (logic Scope & non-goals).
