# Feedback mode tech spec

**Status:** Draft for implementation. Complexity gate fired: crosses plugin, host and build boundaries, and touches more than three source files.

**Logic spec:** [logic.md](logic.md). Paths are relative to the repository root.

## Architecture

Back-link: [Conceptual model](logic.md#conceptual-model), [How a comment moves](logic.md#how-a-comment-moves).

The plugin has three layers, with dependencies in one direction:

- `plugins/quirky.feedback/src/ui.tsx` is a small stub loaded at window connect. It registers the command, tracks settings and context keys, and dynamically imports the mode on first activation. Plugin UI builds already use `splitting: true` (`packages/ui/build.ts`), so that import becomes a separate chunk.
- `plugins/quirky.feedback/src/mode/` holds the picker, comment card, tray, banner and chip. It renders in its own container appended to `document.body` and reads the host DOM directly, because plugin UI runs in the host document. It can't render inside the overlay mount: `.overlay-layer` is a stacking context at z-index 40, below context menus (60) and dialogs (1000), so a picker there couldn't cover a menu item (SC-4). The overlay mount is only the stub's lifecycle hook.
- `plugins/quirky.feedback/main.ts` is the lazy daemon entry that owns stored comments, reached only through `quirky.feedback/*` methods.

Pure modules `src/capture.ts`, `src/format.ts` and `src/issue.ts` have no React or daemon dependency.

## Code references

| Purpose | Anchor |
|---|---|
| Contribution field allowlist | `packages/daemon/src/plugins/ui-kinds.ts:19-32` |
| `whenSetting` filter and visibility list | `packages/daemon/src/plugins/ui-model.ts:340-345`, `:374`, `:387-395`, `:429-433` |
| View menu projection | `apps/desktop/src/bun/view-menu.ts:11-30` |
| Manifest field allowlist and type | `packages/daemon/src/plugins/manifest.ts:16-32`, `packages/protocol/src/plugins.ts:462` |
| UI context API | `packages/protocol/src/ui.ts:304-360` |
| Overlay mount and layer | `packages/ui/src/plugins/OverlayLayer.tsx:8-41` |
| Owner markers | `data-plugin-slot` at `packages/ui/src/plugins/PluginSlot.tsx:48`, `data-plugin-overlay` at `OverlayLayer.tsx:26`, `data-tool-panel` at `packages/ui/src/shell/ToolShell.tsx:702` |
| Native mask | `NATIVE_BROWSER_DEFAULT_MASKS` at `packages/ui/src/native-browser.ts:13` |
| Selection chrome | `createSelectionOverlay` at `packages/ui/src/design-system/selection-overlay.ts:15`, currently private |
| Markdown helpers | `plugins/quirky.browser/src/design/format.ts`, including `codeSpan`, `markdownText`, `feedbackBlock` |
| Annotate entry | `runFocusedBrowserDesign` at `plugins/quirky.browser/src/window/BrowserPaneWindow.tsx:241`, `focusedDesignActions` above it |
| Pane markers | `.qbp[data-browser-pane]` and `.qbp-native-host` at `BrowserPaneWindow.tsx:1006-1010`, `:1233`; terminal `[data-terminal-pane]` at `plugins/quirky.terminal/src/window/pane/TerminalPaneView.tsx:968` |
| Open URL | `quirky.terminal/openExternal`, scheme rules at `plugins/quirky.terminal/src/open-external.ts:19-24` |
| Atomic private file precedent | `plugins/quirky.accounts/src/usage/persistence.ts:218-236` |
| UI build | `packages/ui/build.ts:8`, `:17-68`; root `dev` script at `package.json:12` |
| UI lint enrollment | `scripts/ui-lint-plugins.json` |

## Contracts and interfaces

### Host: `whenSetting` on `setting`, `command` and `keybinding`

Back-link: [SC-2](logic.md#behavior-and-scenarios).

- `ui-kinds.ts` allows and validates `whenSetting` on these three kinds, as it already does for panels. `SettingDeclaration` (`packages/protocol/src/ui.ts:149`) and `settingInfo` (`kernel-schemas.ts:114`) gain the field.
- `command` and `keybinding` declarations whose setting is false leave the UI model. Filter them before `effectiveCommands` is built, so a hidden command's keybinding resolves as hidden rather than warning. `shown` reads `settings`, a `const` built after `commands` today, so build `settings` first.
- A `setting` with `whenSetting` stays in the model and in `setting.list`, so its value stays readable. `setting.list` entries carry `whenSetting`.
- `PLUGIN_API_VERSION` becomes `1.2.0` (`packages/protocol/src/plugin-api.ts:2`), covered in `packages/protocol/test/plugin-api.test.ts`, and `docs/plugin-api.md` documents both additions beside the API 1.1 note. A plugin using either declares `"apiVersion": "1.2.0"`.
- `loadViewMenuSettings` omits a `menu: "view"` row when its `whenSetting` sibling, in the same plugin, is not true. `toggleViewMenuSetting` refuses the same row.
- Existing manifests without the field behave exactly as they do today.

### Host: optional manifest `repository`

Back-link: [Decisions Locked](logic.md#decisions-locked).

SCHEMA: `repository?: string`, an `https://github.com/<owner>/<repo>` URL. The manifest loader rejects any other shape with its existing field-error style. It's added to `PluginManifest` (`packages/protocol/src/plugins.ts:462`) and `PluginInfo` (`:13`), and so appears on the existing plugin listing method for UI code to read. Built-in plugins don't set it, and the feedback plugin treats any id beginning `quirky.` as owned by `zpyoung/quirky`.

### Build: dev flavor and build info

Back-link: [Amendments](logic.md#status--amendments).

CONFIG: `QUIRKY_UI_DEV=1` selects the dev flavor. The root `dev` script sets it for the UI build only.

- Dev flavor: `minify: false`, and a Bun plugin that adds `data-quirky-source="<repo-relative-path>:<line>"` to intrinsic JSX elements in `packages/ui/src` and `plugins/*/src` `.tsx` files. It keeps `process.env.NODE_ENV` as production, so React stays on one runtime.
- Without the variable, the build's JS output differs only by the defines below. A test asserts no `data-quirky-source` in release output.
- `typescript`, if used by the transform, is imported only on the dev path.

CONFIG: all UI builds define `process.env.QUIRKY_BUILD_VERSION` from the `version` in `apps/desktop/electrobun.config.ts`, `process.env.QUIRKY_BUILD_COMMIT` from `git rev-parse --short HEAD` or `unknown`, and `process.env.QUIRKY_BUILD_CHANNEL` as `dev` or `release`. CI already stamps the config version before building (`.github/workflows`, step "Set app version from tag").

### Shared exports from `@quirky/ui`

- `@quirky/ui/annotation-markdown` exports the Markdown escaping and line helpers moved out of `plugins/quirky.browser/src/design/format.ts`. Browser's Markdown output stays byte-identical, proven by its existing `design-format` tests.
- `@quirky/ui/selection-overlay` additionally exports `createSelectionOverlay` and its styles. `selectionOverlayProgram` stays self-contained and unchanged.
- `@quirky/ui/desktop-bridge` exports `parseDesktopWindowRoute` from `packages/ui/src/desktop-bridge.ts:36`, so a plugin can tell an auxiliary window from the main one.

### Browser: Annotate a named pane

Back-link: [SC-7](logic.md#behavior-and-scenarios).

CONTRACT: `quirky.browser/design` accepts optional `pane: string` beside `action`.

- Files: the `design` args schema in `plugins/quirky.browser/quirky-plugin.json`, the handler at `plugins/quirky.browser/src/ui.tsx:102-106`, `runFocusedBrowserDesign` at `BrowserPaneWindow.tsx:241`, and the runner at `:507-511`. The README's command description at `plugins/quirky.browser/README.md:105` gains a line.
- With `pane`, the runner first focuses that pane's root, which runs the existing `onFocusCapture` path at `BrowserPaneWindow.tsx:1012` and so sets `focusedPaneId` and the `focused` prop. It then runs the action. It doesn't bypass the focus check.
- Without `pane`, behavior is unchanged. An unmounted or Watch pane returns `{ started: false, reason }`, and the feedback plugin shows the reason as a toast.

### Tray and markers

Back-link: [SC-1, SC-3, SC-8, SC-12, SC-13](logic.md#behavior-and-scenarios), [Amendments](logic.md#status--amendments).

- **Dots:** a comment finds its element only through its stored `selector`, re-queried with `document.querySelector`. Capture produces a selector unique at that moment, and terminal and browser panes use their pane marker. Re-query on mode start, layout change, resize and window scroll, at most once per animation frame. A miss hides the dot and marks the row "No longer on screen". A hit never updates stored context.
- **Tray rows:** show number, intent, comment, owner and any stale label. Clicking a row reopens its text for editing. Each row has delete, without confirmation. Clear uses `context.confirm`, and only then calls `clear`. The tray collapses to a one-line bar that stays in the mode, and the collapse state isn't stored.
- **Banner:** shows the mode text and an Exit button that sets `active` false.
- **Failures:** a failed daemon call keeps the card or row as it was, and shows a toast. `feedback_full` shows the limit message without opening a card.
- **Native masks:** the banner, card, tray and chip carry `data-quirky-native-mask`. The full-window selection host never does, because masking it would hide every Native page.
- **SC-7 order:** Annotate this page sets `active` false, waits for the mode to unmount, then runs `quirky.browser/design` with `action: annotate` and the pane. It runs through `context.call('ui.command.run', ...)`, because `context.executeCommand` discards the `{ started, reason }` result.

### Feedback daemon methods

Back-link: [SC-3, SC-8, SC-12, SC-13](logic.md#behavior-and-scenarios).

CONTRACT: `quirky.feedback/list`, `add`, `update`, `remove`, `clear`. All are declared in the manifest with parameter and result schemas.

- `list` returns comments in insertion order. `add` returns the comment, or fails with a `feedback_full` code at 50.
- `add` and `update` trim the comment, and reject empty text or more than 2,000 characters.
- `update` changes only comment text and intent. Captured context never changes.
- Every mutation writes the whole file atomically to `<context.dataDir>/comments.json`, mode 0600, following the accounts precedent.
- A corrupt file is renamed aside with a timestamp, the plugin starts empty, and `list` reports `recovered: true` so the tray can say so. It's never silently overwritten.

### Capture

CONTRACT: `captureElement(element, { includeReact }) -> Capture`, synchronous, and never throws for a connected element.

Precondition: the element is connected to the host document. `build` values fall back to `unknown` where the build defines are absent, as under `bun test`.

SCHEMA: `Capture` holds `kind` (`element` | `terminal-pane` | `browser-pane`), `owner` (plugin id or `quirky`), `elementPath`, `selector`, `role`, `accessibleName`, `visibleText`, `nearbyText`, `attributes`, `rect`, `computedStyles`, `component`, `source`, `sourceCaller`, and `build` (`version`, `commit`, `channel`). Nullable fields are null when unavailable.

- `owner` is the namespace from the nearest `data-plugin-slot`, `data-plugin-overlay` or `data-tool-panel` value, parsed with `parseContributionId` from `@quirky/protocol`.
- Secret redaction, attribute allowlist and text limits match `plugins/quirky.browser/src/design/payload.ts`. Move only what's needed, and never weaken it for this plugin.
- A target inside `[data-terminal-pane]` resolves to that element with `kind: terminal-pane`. Its `visibleText`, `nearbyText`, and any text-bearing attribute are null. Nothing under `.terminal-pane-screen` is read.
- `source` is the nearest `data-quirky-source`. If that path is in `packages/ui/src/design-system`, `sourceCaller` is the nearest ancestor source outside it.
- `component` reads `__reactFiber$` only when `includeReact` is true, which the mode passes in the dev channel.

### Picker

- Uses `createSelectionOverlay` in the host document. Hover and click resolve with `document.elementsFromPoint`, skip the feedback overlay's own nodes, and take the first remaining element, so a click on the surface never reaches the app. A point inside a control (an icon in a button) resolves to that control, because it carries the accessible name an agent needs.
- Pointer and mouse events whose target is the selection host are stopped with `stopImmediatePropagation` in a `window` capture listener, registered when the mode starts. The dismiss listeners on menus and popovers (`context-menu.tsx`, `navigation.tsx`, `floating.tsx`) listen on `window` and `document`, so this keeps an open menu open for selection (SC-4). The mode's container also stops `focusin` from bubbling to `document`, so opening a card doesn't dismiss a menu or trip a dialog's focus trap.
- While `context.confirm` is pending, the picker is suspended: the selection host is hidden, the mode's listeners pass everything through so the dialog takes Esc, and the container drops to `z-index: 0` so the dialog shows above it.
- While Option is held, the overlay host and its inner surface are both `pointer-events: none`, set with `important` priority. The host needs that priority because `createSelectionOverlay` sets it that way (`selection-overlay.ts:20-23`), and the surface needs it because its own `pointer-events: auto` would otherwise still take the click. Releasing Option restores it, and so does a window blur, so Option can't stick. `altKey` on pointer events corrects the state if a keydown was missed.
- Turning the mode on moves focus to the surface, so keys reach the host even if a terminal had focus. A Native page never forwards keys, so inside one the banner's Exit button and the View item are the ways out.
- Key listeners are on `window` in the capture phase. They handle Esc per SC-5 and stop propagation only for keys they consume.
- The chip is positioned from each `.qbp-native-host` rect and updates on layout and resize. Its pane id comes from `.qbp[data-browser-pane]`. Selection of Watch panes resolves to the whole `.qbp`.

### Mode lifecycle

- Settings: `enabled` (boolean, default true) and `active` (boolean, default false, `menu: "view"`, `whenSetting: "enabled"`, title "Feedback Mode").
- Command `quirky.feedback/toggle`, `palette: true`, `whenSetting: "enabled"`, toggles `active`. Keybinding `mod+alt+k`, `whenSetting: "enabled"`, with `when: "terminalFocus || !terminalFocus"`. That condition is always true, and mentioning `terminalFocus` lets it fire under `terminalKeysFirst` (`packages/ui/src/plugins/host.ts:352-375`). The manifest declares one `overlay`, provided by the stub, with `activation: "lazy"`.
- `OverlayLayer` also renders in auxiliary windows. In those, where `parseDesktopWindowRoute(location.href)` isn't null, the stub's overlay mount does nothing and it doesn't touch settings.
- In the main window, the stub's overlay mount turns `active` off once, so the mode never starts on after a restart. It subscribes to `setting.changed`, mounts the mode when `active` turns true, and unmounts when it turns false or `enabled` turns false.
- The dynamic import failing shows a toast, and sets `active` false.
- `active` also shows in the Settings window, like every View-menu setting, with the description "Turns selection on in the main window."

### Plugin scaffold

`plugins/quirky.feedback/` needs `quirky-plugin.json` with `apiVersion: "1.2.0"`, `package.json` modeled on `plugins/quirky.accounts/package.json`, `main.ts`, and `src/ui.tsx`. Run `bun install` to add its workspace entry to `bun.lock`, because `bun run typecheck` uses `--frozen-lockfile`.

### Output

CONTRACT: `formatCommentsAsMarkdown(comments) -> string`. Numbered heading per comment using the shared helpers, with Annotate's field order, plus `**Plugin:**` and `**App:**` lines. Terminal comments have no text fields.

CONTRACT: `buildIssueDrafts(comments, repositoryOf) -> { drafts: { repository, url, included, remaining }[], unrouted: Comment[] }`. Draft bodies contain only comment text, intent, owner, element path, component, source and build, and exclude every on-screen text, attribute and style field. URLs are percent-encoded and capped at 7,500 characters by whole comments. A single oversized comment is truncated with a visible marker, so a draft always holds at least one.

Copy writes with `navigator.clipboard.writeText`, and confirms only after it resolves. Drafts open through `quirky.terminal/openExternal`.

## Data models

SCHEMA: `Comment` is `{ id: string, createdAt: number, intent: "change" | "question", comment: string, capture: Capture }`. The file is `{ version: 1, comments: Comment[] }`.

## DO-NOT-CHANGE fences

- `selectionOverlayProgram`'s output: it's evaluated in untrusted guest pages, so `createSelectionOverlay` must stay self-contained under `toString()`.
- `plugins/quirky.browser/src/design/guest.ts` and `payload.ts` clamps: they're the security boundary for untrusted pages, so the host picker gets its own code rather than sharing guest strings.
- Annotate's Markdown output: agents and tests depend on it, so the helper move must be byte-preserving.
- Existing `quirky.browser/design` argless behavior: the public UI command documented in `plugins/quirky.browser/README.md`.
- Release UI bundles: no source attributes and no dev transform on the release path.

## Always / Ask / Never

**Always:** use `@quirky/ui` components and tokens, because the UI lint gate enforces them. Enroll `quirky.feedback` in `scripts/ui-lint-plugins.json`. Keep the stub free of mode imports except the dynamic one.

**Ask:** any change to a locked decision, per the logic spec's amendment rule.

**Never:** import another plugin's source. Read terminal contents. Commit from an implementer. Send comments anywhere without an explicit Copy or File issue action.

## Cross-cutting

- **Security:** comment files are 0600 in a 0700 directory. Issue drafts exclude on-screen text, and tests assert that with sentinel strings. URLs are percent-encoded, and the repository must match the validated GitHub shape before a draft is built.
- **Rollback:** removing the plugin directory removes the feature. The host's `whenSetting` additions and the manifest field are additive.
- **Test isolation:** tests touching git or a daemon must not leak `GIT_DIR` or write to the shared `.git/config`, which is currently an active problem in this repository.

## Testing strategy

- `packages/daemon/test/plugins/ui-model.test.ts`, `apps/desktop/test/view-menu.test.ts`: `whenSetting` on all three kinds, and manifests without it. Manifest tests cover `repository`.
- `packages/ui/test/`: dev flavor injects attributes, and release output has none. `selection-overlay` export stays self-contained.
- `plugins/quirky.browser/test/design-format.test.ts` and `design-ui.test.tsx`: unchanged output, and `pane` targeting.
- `plugins/quirky.feedback/test/`: store limits, atomic write, 0600 mode and corrupt-file recovery; capture owner, terminal no-text, and source caller; Markdown; drafts' sentinel exclusion, truncation and routing; the mode's click blocking, Option passthrough, Esc states and stub reset, using `@happy-dom/global-registrator`.
- The acceptance bar is `bun run typecheck && bun run test`. The 8-of-10 agent check runs against a built app after review, per [Key decisions](logic.md#key-decisions-and-rationale).

## Non-goals

This spec doesn't cover Deferred Ideas in the logic spec, or moving Browser Annotate onto the new plugin.
