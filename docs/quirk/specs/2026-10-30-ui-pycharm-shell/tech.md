# Tech spec: PyCharm-style desktop shell

**Status:** Reviewed 2026-10-30
**Logic spec:** [logic.md](logic.md)

## Architecture

The host owns everything in this spec, and plugins change only where they draw their own chrome. Paths are relative to the repo root.

| Layer | Files | Role |
|---|---|---|
| Tokens | `packages/ui/src/design-system/tokens.css`, `tokens.ts`, `packages/protocol/src/ui.ts` | Color and size values, including the theme defaults that override `--ui-rail` at runtime |
| Icons | `scripts/gen-icons.ts` (new), `packages/ui/src/design-system/icons/` (new) | Generated subsets of Phosphor and Catppuccin, drawn by shared components |
| Shared components | `packages/ui/src/design-system/` | `ToolIcon`, `ControlIcon`, `FileIcon`, `ProjectTile`, `PopupMenu`, `ToolPanelFrame` |
| Tool registry | `packages/protocol/src/tool-slots.ts`, `packages/protocol/src/rpc.ts:135`, `packages/protocol/src/kernel-schemas.ts:583`, `packages/daemon/src/plugins/tool-layout.ts`, `ui-kinds.ts`, `ui-model.ts`, `layout.ts` | Tool identity, icon, hue, and placement |
| Shell | `packages/ui/src/shell/ToolShell.tsx`, `tool-shell.css`, `ShellChrome.tsx`, `chrome.css`, `attention.ts`, `packages/ui/src/App.tsx` | Frame, cards, stripes, window bar, status bar |
| Native window | `apps/desktop/src/bun/index.ts`, `apps/desktop/types/electrobun-main.d.ts` | Merged Mac title bar |
| Center tabs | `plugins/quirky.terminal/src/window/workspace/GroupView.tsx`, `packages/ui/src/design-system/terminal-workspace.css`, `plugins/quirky.terminal/src/layout/types.ts`, `layout/service.ts` | Tab icons, underline, overflow |
| Command palette | `packages/ui/src/plugins/CommandPalette.tsx`, `packages/ui/src/plugins/palette.ts` | Scope tabs and recents |
| Review tooling | `scripts/ui-review/`, `scripts/ui-review.ts`, `scripts/ui-lint.ts` | Screenshot review and lint |

The UI builds with `Bun.build` (`packages/ui/build.ts`), not Vite. Electrobun is the `2.0.5-quirky.1` fork, pinned in `apps/desktop/hutch.config.ts`, with its SDK under `~/.cache/quirky/electrobun-devkit/2.0.5-quirky.1/`.

## Code references

These anchors were checked against the tree at `e222d84f`. Re-resolve them before each dispatch.

- Rail value: `tokens.css:4,44`, and `ui.ts:52,79` (`DEFAULT_THEME.colors.bg`, `LIGHT_THEME.bg`). `packages/ui/src/plugins/appearance.ts:14-15,68-70` maps `--ui-rail` to `bg` and writes it inline, so changing only `tokens.css` has no effect.
- Rail literals elsewhere: none need changing. `packages/protocol/src/terminal-theme.ts:18` is the terminal's ANSI black, and `scripts/ui-review/fixtures.ts:52` is a fill in a fixture image.
- Geometry: `fitToolShellGeometry` at `ToolShell.tsx:134-223`, `toolShellCssVariables` at `:236-267`, `splitHeights` at `:122-132`, `bottomRailHeight` at `:165-173`.
- Stripes: `ToolShell.tsx:300-327` (`TOOL_ICON_PATHS`, `ToolIcon`), `:361-439` (`ToolItem`, context menu, drag), `:484-534` (stripe nav and drop), `:681-708` (stripe and panel rendering). CSS at `tool-shell.css:2,21-30,50-142,163-177,262-326`.
- Activity-backed tool: Changes mounts `quirky.sidebar-extras` in its stripe cell (`ToolShell.tsx:391-413`, `plugins/quirky.sidebar-extras/src/ui.tsx:111`).
- Title and status bars: `ShellChrome.tsx:36-72`, `:75-112`. Toast actions: `ShellChrome.tsx:526-548`.
- Attention store: `attention.ts:22-44,131-189`.
- Tool projection: `tool-layout.ts:40-81` (`RULES`, `TOOL_ORDER`), `:103-142` (`projectTools`), `:187-212` (`resolveToolLayout`).
- Layout RPCs: `layout.ts:641-705`, `packages/daemon/src/methods.ts:301`, `packages/ui/src/plugins/host.ts:413-425`.
- Manifest allowlist: `ui-kinds.ts:21-24,206-207`. Plugin API version: `packages/protocol/src/plugin-api.ts`.
- Panel frame: `panels.tsx:73-123`, `contracts.ts:41-43`, `components.css:730-790`, `tool-shell.css:320-326`.
- Popup base: `context-menu.tsx`, `context-menu-contracts.ts:4-46`, `context-menu.css`, and search usage at `plugins/quirky.terminal/src/window/workspace/Overlays.tsx:8-37`.
- Selected rows: `components.css:305-308,1081-1094`, `editor-window.css:788`, `terminal-workspace.css:68`.
- Worktree scope: `plugins/quirky.worktree/src/control-types.ts:5-21` (`filterRepoIds`), `WorktreesSection.tsx:112-122,157-163`, `StockOptions.tsx:173-184`, `daemon/options.ts:4,76-77,125`, `daemon/navigation.ts:101`, `Tree.tsx:707-714`.
- Project identity: `plugins/quirky.worktree/src/daemon/project.ts:43-53,111-113`, `safe-icon.ts`, method `quirky.worktree/projectMetadataList`.
- Back and forward: methods `quirky.worktree/navigationBack` and `navigationForward`, with the handlers at `WorktreesSection.tsx:200-228`.
- Window: `apps/desktop/src/bun/index.ts:44,171-176,280-286`, and SDK `api/sdks/main/core/BrowserWindow.ts:15,38-47,124,199-228`, `api/preload/dragRegions.ts`.
- Window focus: `packages/ui/src/shell.ts:55-68`, `host.ts:250,269,1226-1229`, `main.tsx:12`.
- Tabs: `GroupView.tsx:27-158,196-228,282-296`, `terminal-workspace.css:40-69`, `layout/types.ts:54-70`, `layout/service.ts:554`. Callers of `openViewTab`: `plugins/quirky.editor/src/daemon/service.ts:371`, `plugins/quirky.git/src/view/hosted-tabs.ts:148,208`, `plugins/quirky.browser/src/.../pane-service.ts:812`, `plugins/quirky.loops/src/ui.tsx:175`, `plugins/quirky.terminal/src/.../commands.ts:237`.
- Palette: `CommandPalette.tsx:10-19,60-113,170-249`, `components/useShortcuts.ts:15-33`.
- Capture: `scripts/ui-review/capture.ts:30,36,128-141,416,429,454,583-586,653,744,990`. Review: `review.ts:36-39,204-214,370-381,637,659,692,699`. Contracts: `contracts.ts:4`. Defaults: `arguments.ts:5-8`.
- Lint: `scripts/ui-lint.ts:6,27-33,102-105,510,1055-1080`, `scripts/ui-lint-plugins.json`.
- Native masks over browser panes: recent commits `8b333c3f` and `ebec045a` show how an overlay keeps native browser panes usable. Every new popup has to follow the same path as `Popover` and `ContextMenu`.

## Contracts & interfaces

### Tokens ([Frame and cards](logic.md#frame-and-cards))

- `rail` takes the logic spec's values in both `tokens.css` and `ui.ts`.
- New size token `--ui-card-gap: 5px`, since 5 isn't on the spacing scale.
- New hue tokens `--ui-hue-<name>` in dark and light, using the [icon table](logic.md#icons) values. Names: `blue, violet, teal, coral, magenta, slate, azure, sand, mint, lilac, rose, tan, cyan, plum`.
- New tile tokens `--ui-tile-1` to `--ui-tile-8`, none equal to a status color.
- Cards have corner `--ui-radius-window` and no border lines, per the logic spec. `surface` is the card fill, and `.tool-shell__panel` and the center region both become cards.
- `.qt-strip` and other `--ui-rail` consumers that now sit inside a card move to `--ui-surface`: `terminal-workspace.css:43,155,226,256`, `terminal-dock.css:3`. `editor-*.css` and other uses of `rail` as a secondary background inside a card stay as they are unless the review flags them.

### Tool identity ([Icons](logic.md#icons))

`CONTRACT:`
```
type UiToolHue = 'blue' | 'violet' | 'teal' | 'coral' | 'magenta' | 'slate' | 'azure'
  | 'sand' | 'mint' | 'lilac' | 'rose' | 'tan' | 'cyan' | 'plum'
type UiToolEntry = { id; title; icon: ToolIconName; hue: UiToolHue; defaultSlot; contributionId; aliases }
```

- `RULES` and the host Inbox entry supply `icon` and `hue` per the logic spec's table.
- Manifests may set `hue` next to `icon`, and `ALLOWED_FIELDS` gains it. `PLUGIN_API_VERSION` gets a minor bump.
- Resolution order is `source.icon ?? body.icon ?? rule.icon`, and the same for `hue`.
- `RULES` gains rows for three tools that are unruled today: `sidebar-section:quirky.worktree/remote-workspaces` is `hard-drives`/`slate`, and `sidebar-section:quirky.agent-status/activity` and `/dashboard` are `pulse`/`coral` and `gauge`/`mint`. The `"icon": "server"` at `plugins/quirky.worktree/quirky-plugin.json:3244` is removed, because `source.icon` would otherwise win.
- Any other unruled tool falls back to `pulse`/`slate` for an activity item, `sidebar`/`slate` for a sidebar section, and `squares-four`/`slate` otherwise. These replace today's `activity`, `panel-left` and `panel-right`.
- An unknown name at render time draws the first-letter fallback in `--ui-muted` and never throws.

### Generated icons ([Icons](logic.md#icons))

- `scripts/gen-icons.ts` writes `packages/ui/src/design-system/icons/generated-tools.ts` (Phosphor Duotone), `generated-controls.ts` (Phosphor Regular) and `generated-files.ts` (Catppuccin Mocha and Latte), plus the exported name lists the lint rule reads. It rejects any SVG containing `script`, `foreignObject`, `image`, an event attribute, or an external `href`.
- The Phosphor source is `@phosphor-icons/core`, as a pinned root `devDependency`. Catppuccin is vendored at one recorded commit under `packages/ui/src/design-system/icons/catppuccin/{mocha,latte}/`, with its `LICENSE`, because it has no stable npm package.
- Generated files are committed and only include named icons, because every plugin bundle would otherwise carry about 1,500 icons.
- `file-icon-map.ts` maps filename and extension to a Catppuccin name, covering the languages in this repo plus Markdown, JSON, CSS, shell, Python, Rust and Go, and falling back to `file`.

`CONTRACT:`
```
ToolIcon({ name: string; hue: UiToolHue; size?: number })   // duotone, colored by --ui-hue-<hue>
ControlIcon({ name: string; size?: number })                // regular weight, currentColor
FileIcon({ path: string; size?: number })                   // Mocha or Latte by active theme
ProjectTile({ name: string; color?: string | null; size?: number })
```

`ProjectTile` uses `color` unless it exactly matches a status token, and otherwise picks `--ui-tile-n` from a stable hash of `name`. Letters are the first letters of the first two hyphen, underscore or space separated words, or else the first two letters of the name, in uppercase.

### Lint rule ([Scenario 10](logic.md#behavior-and-scenarios))

New rule `ui/tool-icon-hue`. It checks every plugin `quirky-plugin.json` and `tool-layout.ts` `RULES` for tool `icon` names in the generated list and `hue` values in the palette, and it reports `file:line:col`. `generated-*.ts` joins the primitive-file exemption at `ui-lint.ts:102-105`.

### Overflow ([Stripes](logic.md#stripes))

- `UiToolLayout.placements` values become `UiToolSlot | 'overflow'`, and `ui.tool.move` accepts `'overflow'`, which closes the tool if open.
- Sites that must accept it: the `savedPlacements` loop in `resolveToolLayout`, `requireToolSlot` and `moveTool` in `layout.ts`, `rpc.ts:135`, `kernel-schemas.ts:583`, and `host.moveTool`. `ui.tool.open` on a tool in `'overflow'` restores its default slot. `getToolShellOpenSlots` and `open` still hold only real slots. A stored `'overflow'` survives a layout resolve, and an unknown value still falls back to the default slot.
- The stripe context menu gains "Remove from stripe". Choosing a tool in the overflow list opens it and restores it to its default slot.
- Tools that don't fit are computed by the renderer only and never persisted. A `ResizeObserver` on the stripe moves trailing tools from the lower group, then the upper group, into the left stripe's overflow. The foot group and the open tool always stay visible.

### Stripes and geometry ([Stripes](logic.md#stripes), [Frame and cards](logic.md#frame-and-cards))

- One `nav` per side, 42 wide, with three groups in the logic spec's order. Group positions follow from flow and no longer depend on `splitHeights`.
- Each group is a drop target for its slot, so `onMove(id, slot)` stays the same. Slot names, `placements`, `open` and `getToolShellOpenSlots` don't change.
- `fitToolShellGeometry` drops `bottomRailHeight` and `--tool-bottom-rail`, gains the card gap, and keeps its size bounds and center minimums. Bottom panels span the width between the stripes.
- The 40×40 overlay anchor at `tool-shell.css:136-142` moves to the bottom right of the center card. It must stay above the status bar and clear of the toast stack.
- The open tool's icon gets a full-width `--ui-selected` block, not the `aria-pressed` button fill.
- Host-drawn icon for every tool. `quirky.sidebar-extras` stops drawing its own icon, keeping only its badge and menu behavior.

### Focus ([Focus](logic.md#focus))

- `:focus-within` isn't enough, because WebKit doesn't focus buttons on click. `ToolShell` tracks the focused panel in renderer state, from capture-phase `pointerdown` and `focusin` on `[data-tool-panel]` and on the center card, and sets `data-panel-focused` on that element only.
- Header buttons are visible when the panel has `data-panel-focused`, `:hover` or `:focus-within`. Hidden buttons use `opacity: 0`, never `display: none` or `visibility: hidden`, so they stay in the tab order and appear when focused.
- `.ui-list-row--selected` is `--ui-accent` under `[data-panel-focused]` and `--ui-selected` otherwise. `StatusDot` inside an accent row gets the ring.
- Window inactive: `browserWindowFocus()` also sets `data-window-inactive` on `.app`, and CSS dims the whole window. Electrobun fires `blur`, confirmed in the native scenario. Native browser panes aren't dimmed, which is accepted.
- `useRegion('panel')` stays for keyboard region routing and does not drive this.
- Row-level buttons in Changes, Ledger and Worktrees follow the same reveal, using `git-rows.css`, `ledger-rows.css` and `worktree-tree.css`.

### Panel frame ([Panels](logic.md#panels))

`CONTRACT:`
```
ToolPanelFrameProps = { title: string; tabs?: ReactNode; tools?: ReactNode; actions?: ReactNode; onMinimize?: () => void; children }
ToolPanelToolsProps = { children }   // portals into the nearest frame's left rail, like ToolPanelActions
ToolPanelTabsProps = { children }    // portals into the nearest frame's header, after the title
```

- Nesting keeps working: a nested frame forwards `tabs`, `tools` and `actions` to the host frame and renders only its body.
- When the frame is under 320 wide, the rail renders as a row under the header. This is a container query, not a window one.
- The minimize glyph becomes `ControlIcon name="minus"`.

### Shared popup ([Popups](logic.md#popups))

`CONTRACT:`
```
PopupMenu({ anchor: HTMLElement; items: PopupItem[]; title?: string; searchPlaceholder?: string; onClose })
PopupItem = ContextMenuItem + { lead?: ReactNode; subtitle?: string; selected?: boolean; trailing?: ReactNode }
```

- It wraps `ContextMenuList`, reusing its keyboard handling and `heading`, `key` and `header` slots. It adds anchor positioning, a pill on `selected`, an optional title and optional search.
- A popup takes keyboard focus only after positioning makes it visible: the search field in a searchable popup, or the menu otherwise. Typing filters immediately, and arrow navigation and Escape work immediately after opening it.
- Only one is open at a time, enforced by a module-level current-popup handle, so opening one closes the last. Escape closes it and returns focus to its anchor.
- It renders with `role="menu"`, or `role="dialog"` when it has a search field, so `NATIVE_BROWSER_DEFAULT_MASKS` in `packages/ui/src/native-browser.ts` masks it over native browser panes.
- `anchor` is an element, not `Popover`'s ref, because the window bar and status bar own their buttons. If `anchor` leaves the DOM, it closes.

### Window bar ([Window bar](logic.md#window-bar))

- Main window only: `titleBarStyle: 'hiddenInset'` plus a `trafficLightOffset` that centers the lights in the 40-high bar. Auxiliary and popup windows keep the default. Condition on `lifecycle.kind`.
- Update `electrobun-main.d.ts` so the stub accepts both options.
- The bar has class `electrobun-webkit-app-region-drag`. Every interactive child carries `electrobun-webkit-app-region-no-drag`, because resolution walks ancestors and a control would otherwise start a window move.
- Space for the traffic lights is always reserved on the main window, including in browser-rendered captures.
- Fullscreen behavior and the offset's units are unverified, so the native scenario checks them.
- `ShellTitleBar` is replaced by `WindowBar` in a new `packages/ui/src/shell/WindowBar.tsx`, 40 high. `ProjectSwitcher` and `WorktreeSwitcher` sit in the same file. Data comes from `useAttention()`.
- Project switcher rows, in order: All projects with total worktrees and working count, each repo with its `ProjectTile`, worktree count, working count (`sessions` with status `working`) and needs-you count (`asks` by worktree), then Add project.
- Worktree switcher rows: New worktree, then worktrees in scope with a status dot and an activity line, using the same mapping as the Worktrees panel's rows. Under All projects, a `heading` row per project. Selecting one calls `quirky.worktree/navigate`.
- New worktree runs `command:quirky.worktree/new-worktree`. Add project runs a new `command:quirky.worktree/add-project` that opens the Worktrees tool and then the existing `AddProjectDialog`.
- `Search` keeps its accessible name, "Search commands, tools, views, and worktrees". Settings moves into Overflow.
- Back and forward call the existing navigation methods with the window's connection id from `ui.window.self`.
- New agent runs `command:quirky.agents/new-agent-tab`, and its caret lists installed agents' tab commands (`new-<agent>-tab`) from the same source as the `+` tab menu in `Overlays.tsx`.

### Project narrowing ([Project narrowing](logic.md#project-narrowing))

- The scope is the existing `filterRepoIds` option, with no new state. It already persists, is global to the user, and drives both the panel filter and `navigationOrder`.
- `attention.ts` gains `filterRepoIds` and `projectIdentities`, read from `quirky.worktree/options` and `projectMetadataList`, refreshed on `optionsChanged` and `projectMetadataChanged`.
- The needs-you count, Inbox and toasts ignore `filterRepoIds`, and the breadcrumb names the selected worktree's project regardless of it.
- Empty array means All projects. One id means that project. More than one, which is reachable from the panel's Projects list, shows "N projects" in the switcher.
- Picking a project writes `filterRepoIds` through `quirky.worktree/setOptions`. If the selected worktree falls outside it, the shell navigates to that project's highest `lastActivityAt` worktree. With no worktrees, the panel shows its empty state and the selection stays.
- The daemon's `quirky.worktree/navigate` clears `filterRepoIds` when the target's repo is outside the filter, so every entry point honors the rule in one place.
- The toast gains an "Open worktree" action that calls `navigate`.
- Under All projects, the project section header shows `ProjectTile` in place of the icon prefix at `Tree.tsx:710`.

### Status bar ([Status bar](logic.md#status-bar))

- Right-side order is working, needs-you, ahead and behind, checks, usage, file type. File type opens no popup. Plugin `order` values are set to fit around the host items, and `quirky.accounts/usage` keeps its `order: 30`.
- The breadcrumb leads with `ProjectTile`.
- Host items, in `packages/ui/src/shell/StatusBar.tsx`: breadcrumb, working count, needs-you count.
- Plugin items registered as `status-bar` contributions with `order`: `quirky.git` (ahead and behind, polling `quirky.git/status` at most every 10 seconds while mounted and on worktree events), `quirky.reviews` (checks rollup from `checksGet`), and the existing `quirky.accounts/usage`.
- `StatusBarItem` and `PopupMenu` are the shared parts, and plugins use them for their popups. `quirky.accounts/usage` keeps its existing popover, because account switching and sign-in don't fit a list popup.
- Breadcrumb file and file type come from the active center tab. `quirky.terminal` exposes the active tab's `icon` value to the shell through a state method and a change event, adding them if none exist. With no file tab, the breadcrumb stops at the worktree and file type is hidden.
- `data-region="status-bar"` stays on the footer.

### Center tabs ([Center tabs and ⌘K](logic.md#center-tabs-and-k))

`SCHEMA:`
```
ViewTab.icon?: { kind: 'tool'; name: ToolIconName; hue: UiToolHue } | { kind: 'file'; path: string } | { kind: 'control'; name: string }
```

- `openViewTab` and `rekeyViewTabs` accept `icon`, and `quirky.terminal/activeTabIcon` returns the active tab's. The editor passes `{kind:'file', path}`, git passes `{kind:'tool', name:'git-diff', hue:'azure'}`, and the browser passes `{kind:'control', name:'globe'}`.
- Terminal and agent tabs draw `terminal-window` or `robot`. The existing status glyph stays, because tabs are where agent status lives.
- Close shows only on the active or hovered tab. Tabs don't shrink. A tab counts as hidden when less than half of it shows.
- `viewport` geometry at `GroupView.tsx:196-228` counts hidden tabs, and the scroll buttons are replaced by a "N more" button opening `PopupMenu`.
- The accent underline shows on the selected tab of every group, not only the active group.

### ⌘K ([Center tabs and ⌘K](logic.md#center-tabs-and-k))

- Scope tabs filter `PaletteEntry.kind`: All is everything, Worktrees is `worktree`, Commands is `command`, Files is a new `file` kind.
- Search ranks case-insensitive title matches as exact, prefix, then substring, ahead of metadata-only matches across all kinds. Equal-ranked entries keep their source order; an empty query keeps the existing recents and scope order.
- Files calls the existing `quirky.editor/quickOpen` (`action: 'search'`, fuzzy file names) debounced at 150ms, returning nothing and showing the empty state if the plugin is absent. `quirky.editor/search` matches file contents, so it doesn't fit. Picking a file uses `quirky.editor/open` and records it with `quickOpen`'s `action: 'record'`.
- Recents are the last 10 ids in `UiLayout.paletteRecents`, persisted by the daemon, because a daemon-served page's origin changes with its port and `localStorage` wouldn't survive. `ui.palette.recent { id }` records one.
- Entries show `ToolIcon` or `FileIcon`, and section headers split recents from matches.

### Review tooling ([How we know it's done](logic.md#how-we-know-its-done))

- `.app .layout` becomes `.shell-workspace`, which stays the shell's fixed root. The `button.panel-toggle` count check at `capture.ts:429` is removed and replaced by waiting for `.tool-shell__stripe`. The Settings selector and `openPanel` are repaired to the current DOM.
- Viewport becomes 1400×880 at `deviceScaleFactor: 2`, the size check at `capture.ts:137-138` and `:744` becomes 2800×1760, and `GOLDEN_ROOT` and `APPROVED_GOLDEN_PATHS` move to this spec's `img/`.
- `references` becomes per target: `goldenFor(targetId, theme)` returns `shell` by default, and `scoped` and `popups` for `host:scoped` and `host:popups`. The threshold, the per-image rule and the five dimensions don't change.
- The reviewer prompt tells it the traffic lights are native and absent from these captures.
- Fixtures gain three projects with worktrees covering every status dot.
- Selector smoke test: a new test runs the real capture for `host:shell` only, so the next DOM change fails loudly.

### Native verification ([Scenario 6](logic.md#behavior-and-scenarios))

A new `docs/loop/native/ui-pycharm-shell.json` covers the merged bar, dragging, traffic lights, fullscreen, and window inactive dimming, run with `quirk:using-apps-like-a-user --surface native` against the built app.

## Data models / schemas

`SCHEMA:`
```
UiToolLayout.placements: Record<toolId, UiToolSlot | 'overflow'>
UiLayout.paletteRecents?: string[]   // at most 10, newest first
UiToolEntry.hue: UiToolHue
ViewTab.icon?: see Center tabs
```

The hue-to-tool mapping:

`CONFIG:`
```
worktrees=blue inbox=violet tasks=teal heimdall=coral automations=magenta mobile=slate
changes=azure files=sand checks=mint ask=lilac reviews=rose session-info=slate vault=sand
ledger=tan terminal-sessions=cyan quick-commands=plum problems=rose
remote-workspaces=slate activity=coral dashboard=mint
```

## DO-NOT-CHANGE fences

- `packages/protocol/src/tool-slots.ts:4` slot names, and `ui.tool.open`, `ui.tool.close` semantics. The 10-28 slot rules stand, and tests and saved layouts depend on them.
- `[data-region="status-bar"]`. `plugins/quirky.orchestration/src/ui.tsx:74` and `setup-placement.ts` use it to place their overlay.
- `.shell-workspace`. The capture tool and `App.tsx`'s `ResizeObserver` key off it.
- `ToolPanelFrame` nesting at `panels.tsx:78-88`. Many plugin views rely on a nested frame forwarding into the host header.
- The status dot colors and meanings in `tokens.css`. The logic spec keeps them reserved.
- `filterRepoIds` storage and `navigationOrder`. Navigation shortcuts already depend on them.
- Review threshold 85 and the per-image rule at `arguments.ts:6` and `review.ts:699`. Moving them would make the sign-off meaningless.
- `docs/loop/LOOP.md`, `scripts/build-loop/`. Protected paths, and touching them pauses the loop.

## Always / Ask / Never

**Always**

- Use shared components and tokens, with no raw colors or pixels.
- Keep every test on a fresh `QUIRKY_HOME` and never touch the real `~/.quirky`.
- Run the task's acceptance commands as written.

**Ask** (orchestrator decides or escalates)

- A change that conflicts with a locked decision in the logic spec.
- Any change to a file outside a task's `scope.files`.

**Never**

- Add Material Theme icons. Their EULA forbids derivative works, and Quirky is MIT.
- Commit screenshots of the user's real PyCharm, which show personal paths.
- Weaken a test to make it pass. Failures already listed in the baseline stay listed.
- Tint the window bar, or add a setting for hiding controls.

## Cross-cutting

- **Security:** generated SVGs are inlined, so the generator's rejection list above is the guard. The drag region gets no new RPC surface.
- **Migration:** saved layouts have no `'overflow'` values, so nothing migrates. `resolveToolLayout` must keep accepting existing layouts. Saved plugin themes carrying their own `bg` keep it.
- **Rollback:** revert the branch. Layout and `paletteRecents` additions are ignored by older code.
- **Platform:** the devkit is macOS arm64 only. `hiddenInset` is `deferred: platform` for Linux and Windows.

## Testing strategy

| Area | Tests | Must cover |
|---|---|---|
| Geometry and stripes | `packages/ui/test/tool-shell.test.ts`, `layout-shell.test.ts` | No bottom rail, card gap, three groups, drop to each slot, overflow on short windows, Remove from stripe |
| Focus and frame | `packages/ui/test/design-system.test.tsx` and a new `panel-focus.test.ts` | Reveal on focus and hover, keyboard reachability, accent vs unfocused selection, tabs and tools portals, nesting |
| Popup | new `packages/ui/test/popup-menu.test.tsx` | One open at a time, Escape returns focus, search, pill, heading rows |
| Narrowing | `packages/ui/test/shell-attention.test.ts`, `plugins/quirky.worktree/test/` | Scenarios 1 to 4 |
| Window bar | new `packages/ui/test/window-bar.test.tsx`; `settings-*.test.ts`, `sidebar-activity.test.ts`, and the terminal `features-settings` and `features-keys` tests move to opening Settings via Overflow | Drag and no-drag classes, Settings reachable, New agent |
| Tabs | `plugins/quirky.terminal/test/` | Scenario 11, close visibility, icons |
| ⌘K | `packages/ui/test/plugins/` palette tests | Scope filters, recents, no Files source |
| Icons and lint | new `scripts/gen-icons.test.ts`, `scripts/ui-lint.test.ts` | Rejection list, scenario 10 |
| Capture | `scripts/ui-review/*.test.ts` | Golden mapping, real `host:shell` capture |

The gate is `bun run typecheck`, `bun run build`, then `bun scripts/suite.ts packages apps plugins scripts`, compared against the baseline failure list. The final bar is the logic spec's [How we know it's done](logic.md#how-we-know-its-done).

## Non-goals

- Fixing the failing tests already in the baseline.
- A Problems or Checks output tool. Neither is registered today, so the right foot group is empty until one exists.
- Dimming native browser panes when the window is inactive.
- Linux and Windows window chrome.
- Restyling plugin panel contents beyond moving titles, tabs and tools into the shared frame.
