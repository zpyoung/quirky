# Graphite theme: tech spec

**Status:** Reviewed. Logic spec: [logic.md](logic.md). Every section below names the `logic.md` heading that justifies it.

All paths are relative to the repo root. `R` means `src/renderer/src`, `M` means `R/assets/main.css`. Line numbers were taken at commit `40dbae7c24` and are guides, not contracts. Re-resolve them before editing.

## Architecture

The recolour has five independent surfaces. Each one has its own files, and they share only the token names pinned in [Data models](#data-models-and-pinned-shapes).

- **Renderer tokens** ([How the look reaches each surface](logic.md#how-the-look-reaches-each-surface)). Tailwind v4 maps every `--color-X` to a CSS variable in `@theme inline` (`M:58-171`). Light values live in `:root` (`M:175-296`) and dark values in `.dark` (`M:300-409`). The status and diff blocks are at `M:412-470`, the frozen security scope at `M:472-492`, and the chat derivation at `M:592-670`. `R/lib/document-theme.ts` `applyDocumentTheme` toggles `.dark`/`.light` on `<html>`, and `useDocumentDarkTheme()` (`R/hooks/use-document-dark-theme.ts:5`) is the renderer's resolved-mode hook.
- **Status and literal sweep** ([Hardcoded colours](logic.md#how-the-look-reaches-each-surface), [SC-2](logic.md#behaviour-and-scenarios)). Agent status renders through `R/components/sidebar/StatusIndicator.tsx`, `R/components/AgentStateDot.tsx`, `R/components/AgentWorkingSpinner.tsx`, `R/components/AgentProgressRing.tsx`, `R/components/AgentQuestionIcon.tsx` and `R/components/dashboard-popout/AgentKanbanCard.tsx`. Done and failed currently use raw `emerald-500`/`red-500` classes.
- **Terminal** ([SC-1, SC-4, SC-5](logic.md#behaviour-and-scenarios)). The catalog is a `Record<string, ITheme>` (`src/shared/terminal-themes/types.ts:1-3`), merged in `src/shared/terminal-themes/index.ts:15`, which throws on duplicate names. Defaults come from `src/shared/terminal-theme-selection.ts:11-12` and `src/shared/default-global-settings.ts:83-88`. Loading merges `{...defaults, ...persisted}` (`src/main/persistence/loading-store/normalize-loaded-global-settings.ts`), and the full object is written back on save. One-time migrations use boolean marker keys: a pure helper in `src/main/persistence/applying-settings/terminal-settings-migrations.ts`, called from `prepare-loaded-terminal-settings.ts` and stamped in `normalize-loaded-global-settings.ts`. `migrateTerminalTuiScrollSensitivityDefault` is the template. The renderer applies the theme in `R/components/terminal-pane/terminal-appearance.ts:137-169`, which already skips equal themes via `composedTerminalThemesEqual` (the xterm.js #6291 deferred item is already handled, so leave it alone). Mobile receives resolved colours, not a name (`src/shared/runtime-mobile-session-tab-contracts.ts:41-46`), so the protocol doesn't change.
- **Monaco and window background** ([SC-1, SC-6](logic.md#behaviour-and-scenarios)). Monaco is bootstrapped once in `R/lib/monaco-setup.ts` (bundled `monaco-editor` 0.55, `loader.config` at `:101`). Five components pass `theme={isDark ? 'vs-dark' : 'vs'}` to `@monaco-editor/react`, and two call `monaco.editor.setTheme` directly. Mode changes already switch the theme live without remounting, because no editor `key` includes `isDark`. Three windows hardcode `backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff'`, and nothing updates them after creation.
- **Mobile** ([Mobile](logic.md#decisions-locked), [SC-9, SC-10](logic.md#behaviour-and-scenarios)). Expo app, dark only. The tokens are in `mobile/src/theme/mobile-theme.ts` (`colors`, `onBrightColors`) and about 273 files import them. The terminal webview falls back to a Tokyo Night palette when desktop pushes nothing.

## Code references

### Renderer tokens (task T1)

- `M:175-296` and `M:300-409`: the core shadcn, sidebar, worktree-sidebar, editor-surface, agent and workspace-status tokens get the values in [Token map](#token-map).
- `M:182-198` and `M:301-317`: `--quirky-security-*` (17 tokens per mode). These stay **literal hex copies** of the new core values and are never `var()` aliases (see the fences).
- `M:412-470`: `--destructive`, `--status-*`, `--diff-added-ground`, `--diff-removed-ground` and the gutter mixes.
- `M:592-670`: `--chat-code-surface` and the inline-code tokens. In the default appearance (no terminal-driven native-chat palette), the chat code surface resolves to `--code-background`. With the terminal-driven palette (`R/components/native-chat/native-chat-appearance-style.ts:119-130`), the existing `color-mix` derivation stays.
- `M:58-171`: expose the new tokens (see [Data models](#data-models-and-pinned-shapes)).
- `M:1760-1772`: the spinner keyframes. Add the `agent-working-pulse` keyframes and class next to them.
- `.dark .x` rules in `M` (listed at `M:498, 580, 1375-1379, 1402-1881, 3068-3356`): re-check each one. Any hardcoded neutral `rgb()`/`lch()` value moves to a token. Black shadow `rgba` values stay.
- `M:783, 798, 806`: the scrollbar `rgba(121,121,121,…)` becomes a `color-mix` of `--muted-foreground`, matching `src/shared/styles/scrollbar-sleek.css`.
- `R/assets/markdown-preview.css` and `R/assets/rich-markdown-editor.css`: neutral grey and blue link literals move to tokens. Links use `--primary`. The `.hljs-*` colours stay.
- `R/assets/mobile-page.css:43-53`: the `--m-*` palette takes the mobile graphite values from [Token map](#token-map).
- `R/assets/fork-native-chat-coloring.css`: the `--tool-*`, `--hljs-*` and `--code-accent` values stay. Their contrast is re-measured against the graphite canvases in the tests below.
- `R/components/editor/mermaid-theme-colors.ts:3-23` and `R/components/editor/mermaid-config.ts:12-54`: both modes use `theme: 'base'` with `themeVariables` read from tokens. The light mode `'default'` branch goes away.
- `docs/STYLEGUIDE.md`: `:7-13` (monochrome becomes graphite with one teal accent and status-only hues), `:21-32`, `:71-86` (canvas references `#ffffff`/`#0a0a0a` become `#ffffff` surface plus `#eef0f3` rail in light, and `#16171b` surface plus `#0c0d0f` rail in dark, with the `--tool-*` ratio table re-measured), `:99`, and `:139-145`.

### Status and literal sweep (task T2)

- `R/components/sidebar/StatusIndicator.tsx:52-117`: failed changes `bg-red-500` to `bg-agent-failed`, and done changes `bg-emerald-500` to `bg-agent-done`. Inactive changes `bg-neutral-500/40` to `bg-muted-foreground/40`.
- `R/components/AgentStateDot.tsx:160-215`: done becomes `text-agent-done`. Unverifiable, unconfirmed and the unread bell (`amber-500`) become `agent-question`. Blocked and failed (`bg-red-500`) become `bg-agent-failed`, and idle becomes `bg-muted-foreground/40`.
- `R/components/AgentWorkingSpinner.tsx:44`: the rotating ring becomes an 8px blue dot with the `agent-working-pulse` class (mock Workspace screen, pin `status-working`). The exported name and props stay the same.
- `R/components/dashboard-popout/AgentKanbanCard.tsx:119-131, 228-281`: emerald becomes `agent-done`. The existing `agent-question` and `destructive` classes stay.
- `R/components/sidebar/workspace-status.ts:126-145` and `R/components/sidebar/worktree-list/rows/header-visuals.ts:27-41`: replace the hardcoded `#c7a594`, `#16a34a` and `#d4a300` classes with the `workspace-status-*` token classes.
- Neutral Tailwind classes, 41 hits in 10 files: `R/components/editor/PdfFind.tsx`, `R/components/browser-pane/assemble-chrome/BrowserFind.tsx`, `R/components/github/review-state-presentation.ts`, `R/components/browser-pane/annotate/browser-page-grab-toast.tsx`, `R/components/sidebar/AgentDashboardSidebarEntry.tsx`, `R/components/pull-request-page/presentation/state-badge.tsx`, plus the files above. Each one moves to a semantic token (`muted`, `muted-foreground`, `border`, `accent`, `secondary`).
- Fallback literals: `R/lib/left-sidebar-appearance.ts:98,102` changes `#000000`/`#fafafa` to the graphite rail/text values. (`native-chat-appearance-style.ts` belongs to T3, because its tests also pin the terminal default names.) `R/components/Landing.tsx:137` changes `#12181e` to a token.
- `R/components/ui/sonner.tsx:33-37`: `warning` toasts get a 2px left edge in `--agent-question`. If the code has a dedicated in-app toast announcing an agent that needs the user, it must use `toast.warning`. If no such toast exists, don't add one, because behaviour stays the same per SC-2.

### Terminal (task T3)

- `src/shared/terminal-themes/defaults.ts:3`: add `'Quirky Graphite Dark'` and `'Quirky Graphite Light'` with the values in [Terminal palettes](#terminal-palettes). Ghostty Default Style Dark and Builtin Tango Light stay in the catalog.
- `src/shared/terminal-theme-selection.ts:11-12`: the constants point at the new names. `src/shared/default-global-settings.ts:83,86` import those constants instead of using string literals. `:84,88` set the divider defaults to `#24262c` and `#e3e5ea`, and the defaults set the new marker to `true`.
- `src/shared/global-settings-types.ts` near `:138`: add the marker key.
- `src/main/persistence/applying-settings/terminal-settings-migrations.ts`: add `migrateTerminalGraphiteDefaults` (see Contracts).
- `src/main/persistence/loading-store/prepare-loaded-terminal-settings.ts:~76` (call the helper, then `markNeedsSave()` when needed) and `normalize-loaded-global-settings.ts:~101` (spread the result and stamp the marker).
- `src/main/import-from-orca/apply.ts:351-363`: an imported `terminalThemeDark`, `terminalThemeLight`, `terminalDividerColorDark` or `terminalDividerColorLight` value that equals the legacy Orca default is skipped, so it counts as unset. That way an Orca import never brings back the old default.
- `R/lib/terminal-theme.ts:20-21`: `DEFAULT_TERMINAL_DIVIDER_DARK`/`_LIGHT` use the new divider values.
- `R/components/terminal-pane/terminal-view-attributes-publisher.ts:35-50`: the fallback 16-colour ANSI table changes from Tango to Quirky Graphite Dark's ANSI.
- `R/components/native-chat/native-chat-appearance-style.ts:112-113`: the `#000000`/`#fafafa` fallbacks change to the graphite rail/text values. T3 owns this file and its two tests.
- `R/lib/terminal-title-contrast.ts:3-6`: `APP_SURFACE_COLORS` dark becomes `{r:22,g:23,b:27}` (`#16171b`). Light stays white.
- `R/components/settings/TerminalThemePicker.tsx:~161-185`: the 8-colour swatch strip shows on built-in rows as well as imported rows (mock Settings screen, pin `ansi-swatches`).
- Tests that compare against the old default names as the _default_ change to the new constants. Tests that use them as an ordinary named theme stay. The list is in [Testing strategy](#testing-strategy).

### Monaco and window background (task T4)

- New `R/lib/monaco-graphite-theme.ts`: exports the theme ids, `monacoThemeFor(isDark)` and `defineGraphiteMonacoThemes(monaco)`.
- `R/lib/monaco-setup.ts:82-101`: call `defineGraphiteMonacoThemes(monaco)` before `loader.config`, so the themes exist before any editor mounts.
- Replace `isDark ? 'vs-dark' : 'vs'` with `monacoThemeFor(isDark)` in `R/components/editor/MonacoEditor.tsx:277`, `DiffViewer.tsx:335`, `DiffSectionBody.tsx:210`, `R/components/automations/AutomationEditorPromptEditor.tsx:158`, `R/components/agent-session-continuation/fork-session-handoff/HandoffPreviewEditor.tsx:219`, `R/components/editor/IpynbCellEditor.tsx:167-169` and `R/components/editor/MonacoCodeExcerpt.tsx:39-41`.
- `HandoffPreviewEditor.tsx:55`: replace the non-reactive `resolveDocumentTheme(...)` with `useDocumentDarkTheme()`.
- New `src/main/window/window-background.ts` (see Contracts).
- `src/main/window/createMainWindow.ts:112`, `dashboard-popout-window.ts:163` and `workspace-space-window.ts:52`: take `backgroundColor` from the helper.
- `src/main/ipc/settings.ts:181-183`: after `nativeTheme.themeSource = args.theme`, repaint every open window.
- Register one `nativeTheme.on('updated')` listener in main startup, next to `src/main/startup/main-process-ready-runtime.ts:102`. It repaints all windows while the preference is `system`.
- `M` `:root`/`.dark`: `color-scheme: light`/`dark`. **This line belongs to T1**, not T4, because T1 owns `M`.
- Test harness mocks: `src/main/window/createMainWindow-test-harness.ts:53,78` and `src/main/ipc/pty-ipc-mock-registry.ts:55,70`.

### Mobile (task T5)

- `mobile/src/theme/mobile-theme.ts:4-72`: the values in [Token map](#token-map). Rename `accentBlue` to `accent` across all consumers (about 45 usages). Add `statusBlue`.
- `mobile/src/theme/mobile-theme-contrast.test.ts`: keep the 4.5 floors. They have to pass with the new values, so don't lower a threshold.
- `mobile/src/components/AgentStateDot.tsx:13-22` and `AgentSpinner.tsx:15-20`: working changes to `statusBlue`. Waiting, blocked and permission change to `statusAmber`, failed stays `statusRed`, and done changes to `statusGreen`. Replace the literals with tokens.
- `mobile/app.json`: `userInterfaceStyle: "dark"`. Splash, adaptive icon and the splash plugin `backgroundColor` change to `#0c0d0f`.
- `mobile/src/terminal/terminal-webview-html/theme.ts:4-27`: `DEFAULT_TERMINAL_THEME` changes to Quirky Graphite Dark. `mobile/src/terminal/terminal-webview-html/document-style.ts:104-149` changes the Tokyo Night selection-menu literals to graphite and teal. `mobile/src/terminal/document/terminal-theme.ts:28` `CONTRAST_APP_SURFACE` becomes `{r:22,g:23,b:27}`.
- `mobile/src/session/mobile-native-chat-visual-theme.ts:9-39`: `--primary` and `--ring` change to the accent.
- `mobile/src/notifications/desktop-notification-channel.ts:25`: `lightColor` changes to `#5fd0d6`.
- Real UI literals listed in the survey that duplicate a token (`TerminalShortcutSettings.tsx:385,388` red tints, `MobileHomeListHeader.tsx:57`, `ConfirmModal.tsx:121`) move to tokens. Repo and label palettes, brand colours and shadows stay.
- Tests that hardcode old colours (the list is in Testing strategy) get updated.

## Contracts and interfaces

**Token contract (T1 provides, T2 consumes).** After T1, every class in [Data models](#data-models-and-pinned-shapes) resolves in both modes. T2 never edits `M`.

**`migrateTerminalGraphiteDefaults`** ([SC-4, SC-5](logic.md#behaviour-and-scenarios)).

CONTRACT:

```ts
// src/main/persistence/applying-settings/terminal-settings-migrations.ts
export const LEGACY_TERMINAL_THEME_DARK = 'Ghostty Default Style Dark'
export const LEGACY_TERMINAL_THEME_LIGHT = 'Builtin Tango Light'
export const LEGACY_TERMINAL_DIVIDER_DARK = '#3f3f46'
export const LEGACY_TERMINAL_DIVIDER_LIGHT = '#d4d4d8'
export function migrateTerminalGraphiteDefaults(settings: Partial<GlobalSettings>): {
  settings: Pick<
    GlobalSettings,
    | 'terminalThemeDark'
    | 'terminalThemeLight'
    | 'terminalDividerColorDark'
    | 'terminalDividerColorLight'
    | 'terminalGraphiteDefaultsMigrated'
  >
  needsSave: boolean
}
```

- Precondition: none. It accepts any parsed settings object.
- When `terminalGraphiteDefaultsMigrated === true`, it returns the input values unchanged with `needsSave: false`. A key missing from the input comes back as its current default, so the caller's `{...defaults, ...result}` spread never writes `undefined` over a default.
- Otherwise each of the four keys is checked on its own. A value that is `undefined`, `''` or exactly the legacy value becomes the new default. Any other value is kept as it is. The marker comes back as `true` and `needsSave` as `true`.
- Postcondition: the function is idempotent. A second call with its own output returns `needsSave: false`.
- Fresh installs never run the move, because `buildDefaultSettings` sets the marker to `true`.
- A theme the user picks later, Ghostty included, is never changed, because the marker is already stamped.

**`window-background.ts`** ([SC-6](logic.md#behaviour-and-scenarios)).

CONTRACT:

```ts
export const WINDOW_BACKGROUND = { dark: '#0c0d0f', light: '#eef0f3' } as const
export function resolveWindowBackground(
  theme: GlobalSettings['theme'],
  systemPrefersDark: boolean
): '#0c0d0f' | '#eef0f3'
export function repaintAllWindowBackgrounds(theme: GlobalSettings['theme']): void
```

- `resolveWindowBackground` is pure. `'dark'` returns dark, `'light'` returns light, and `'system'` follows `systemPrefersDark`.
- At creation, the three window kinds pass `store.getSettings().theme` and `nativeTheme.shouldUseDarkColors`. If startup turns out to create a window before `themeSource` is set, the saved preference still wins, because only `'system'` reads the OS.
- `repaintAllWindowBackgrounds` calls `setBackgroundColor` on every non-destroyed `BrowserWindow`. It never shows, focuses or reorders a window.

**`monaco-graphite-theme.ts`** ([Decisions locked: Monaco](logic.md#decisions-locked)).

CONTRACT:

```ts
export const MONACO_THEME_DARK = 'quirky-graphite-dark'
export const MONACO_THEME_LIGHT = 'quirky-graphite-light'
export function monacoThemeFor(
  isDark: boolean
): typeof MONACO_THEME_DARK | typeof MONACO_THEME_LIGHT
export function defineGraphiteMonacoThemes(m: typeof import('monaco-editor')): void
```

- `defineGraphiteMonacoThemes` is safe to call more than once.
- Base themes: `vs-dark` and `vs` with `inherit: true`.
- Token rules use the v1 syntax values listed under [Decisions locked](logic.md#decisions-locked) (keyword, function, string, number, comment, type, constant, punctuation, per mode).
- Editor colours: `editor.background` is the surface colour, and `editor.foreground` is text. `editor.selectionBackground` is the accent at 22% alpha (`#5fd0d638` dark, `#14808a38` light). The line-number foreground is muted.
- Diff colours: `diffEditor.insertedTextBackground` and `diffEditor.removedTextBackground` take the v1 add and delete backgrounds, and the line backgrounds use the same colours.
- Monaco needs 6- or 8-digit hex, so pass hex values only and never `var()`.
- Live switching relies on the global `setTheme`, which already runs when the prop changes. No editor gets a theme-dependent `key`.

**Mermaid.** `getMermaidConfig(isDark, htmlLabels, colors?)` returns `theme: 'base'` whenever `colors` is present, in either mode. `readMermaidThemeColors()` reads these tokens: `--background`, `--foreground`, `--secondary` (primary fill), `--code-background` (secondary fill), `--card` (tertiary fill), `--muted-foreground` (node borders and lines), and `--chart-1` to `--chart-5` (pie slices `pie1` to `pie5`, so slices never share a fill). `MermaidBlock.tsx:99-100` passes `colors` in both modes.

## Data models and pinned shapes

### Token map

Values are dark / light. This map is the shape T1 builds and T2 relies on.

The light `--muted-foreground` and amber values follow the 2026-11-25 amendment in [logic.md](logic.md#status--amendments).

| Token                                                                                                        | Dark                                             | Light                  |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | ---------------------- |
| `--background`, `--card`, `--editor-surface`                                                                 | `#16171b`                                        | `#ffffff`              |
| `--popover`                                                                                                  | `#1b1c21`                                        | `#ffffff`              |
| `--foreground`, `--card-foreground`, `--popover-foreground`, `--secondary-foreground`, `--accent-foreground` | `#eceef2`                                        | `#1b1d22`              |
| `--primary`, `--ring`, `--sidebar-primary`, `--sidebar-ring`, `--worktree-sidebar-ring`                      | `#5fd0d6`                                        | `#14808a`              |
| `--primary-foreground`, `--sidebar-primary-foreground`                                                       | `#0c0d0f`                                        | `#ffffff`              |
| `--secondary`, `--muted`, `--accent`, `--sidebar-accent`, `--worktree-sidebar-accent`                        | `#22242b`                                        | `#e7e9ef`              |
| `--muted-foreground`                                                                                         | `#7c828d`                                        | `#646b76`              |
| `--border`, `--input`, `--sidebar-border`, `--worktree-sidebar-border`                                       | `#24262c`                                        | `#e3e5ea`              |
| `--sidebar`, `--worktree-sidebar`                                                                            | `#0c0d0f`                                        | `#eef0f3`              |
| `--sidebar-foreground`, `--worktree-sidebar-foreground`, `-accent-foreground` variants                       | `#eceef2`                                        | `#1b1d22`              |
| `--destructive`                                                                                              | `#ef6b73`                                        | `#d6455d`              |
| `--destructive-foreground`                                                                                   | `#0c0d0f`                                        | `#ffffff`              |
| `--agent-working` (set in both blocks)                                                                       | `#6fb3ff`                                        | `#2f74c0`              |
| `--agent-question`, `--status-warning`                                                                       | `#e5b454`                                        | `#a56e08`              |
| `--agent-question-text`, `--status-warning-foreground`                                                       | `#e5b454`                                        | `#855706`              |
| `--agent-done` (new), `--status-success`, `--workspace-status-review`                                        | `#4cc38a`                                        | `#1f9d63`              |
| `--agent-done-text` (new; done green used as text, or as a fill under text)                                  | `#4cc38a`                                        | `#167747`              |
| `--agent-failed` (new)                                                                                       | `#ef6b73`                                        | `#d6455d`              |
| `--workspace-status-progress`                                                                                | `var(--agent-working)`                           | `var(--agent-working)` |
| `--workspace-status-done` (v1 sand, so it stays distinct from review green)                                  | `#d6b58c`                                        | `#8f6a3a`              |
| `--code-background` (new)                                                                                    | `#101114`                                        | `#f6f7f9`              |
| `--code-header` (new)                                                                                        | `#1b1c21`                                        | `#eceef2`              |
| `--diff-added-ground`                                                                                        | `#3fb95024`                                      | `#2da44e1f`            |
| `--diff-removed-ground`                                                                                      | `#e5534b24`                                      | `#cf222e1a`            |
| `--chat-diff-added` (text; replaces the `color-mix` derivation at `M:660-665`)                               | `#a6f0b0`                                        | `#116329`              |
| `--chat-diff-removed` (text; replaces the `color-mix` derivation)                                            | `#ffb3ad`                                        | `#82071e`              |
| `--quirky-security-*`                                                                                        | literal copies of the matching core values above | same                   |

Notes on the map:

- The gutter mixes keep their current `color-mix` percentages over the new ground colours.
- `--chart-1` to `--chart-5` take v1's tile hues so they carry white text: dark `#3f6fd0`, `#7b52c6`, `#0f7f8a`, `#b4532f`, `#3a7d52`; light `#2f62c0`, `#6c42b8`, `#0b6f79`, `#a64624`, `#2f6f45`. Mermaid pie labels use `pieSectionTextColor: #ffffff`.
- `--git-decoration-*`, `--git-graph-*`, `--tool-*`, `--hljs-*`, `--code-accent`, `--ai-action-accent` and `--callout-*` keep their values, because they're categorical data hues, not chrome.
- Mobile (`mobile/src/theme/mobile-theme.ts`) uses these values:
  - Base colours: `bgBase #0c0d0f`, `bgPanel #16171b`, `bgRaised #22242b`, `borderSubtle #24262c`, `editorSurface #16171b`, `terminalBg #16171b`.
  - Composer: `composerSurface #16171b`, `composerBorder rgba(236,238,242,0.08)`, `composerControl #22242b`.
  - Text: `textPrimary #eceef2`, `textSecondary #a0a6b1`, `textMuted #8a909b`. The muted value is v1's comment grey, and it passes 4.5 on `#22242b`, which the 4.5 floor on `bgRaised` requires.
  - Accent and status: `accent #5fd0d6`, `onAccent #0c0d0f`, `statusBlue #6fb3ff`, `statusGreen #4cc38a`, `statusAmber #e5b454`, `statusRed #ef6b73`.
  - Skill tokens: `skillToken #5fd0d6`, `skillTokenSurface rgba(95,208,214,0.2)`.
  - Diffs: `diffAddedBg rgba(63,185,80,0.14)`, `diffDeletedBg rgba(229,83,75,0.14)`, `chatDiffAdded #a6f0b0`, `chatDiffRemoved #ffb3ad`.
  - Syntax uses the v1 dark set: comment `#8a909b`, keyword `#c79bff`, string `#6dd6b4`, number `#ff9d7a`, type `#5fd0d6`, function `#6fb3ff`, variable `#eceef2`, meta `#d6b58c`.
  - `onBrightColors.link` is `#0f6f78`.
  - `surfaceBright` is `#eceef2`.
  - `mergeGreen`, `statusPurple` and `gitDecoration*` stay as they are.
- `R/assets/mobile-page.css` mirrors the mobile base, text, accent and status values.

### Tailwind classes T2 uses

SCHEMA: `bg-agent-done`, `text-agent-done`, `border-agent-done`, `bg-agent-failed`, `text-agent-failed`, plus the existing `*-agent-working`, `*-agent-question`, `*-agent-question-text`, `*-workspace-status-{done,review,progress}`, and `bg-code-background`. The class `agent-working-pulse` is a CSS class defined in `M`:

- It runs a 1.6s ease-in-out infinite halo, a `box-shadow` that grows from 2px to 5px of `--agent-working` at 30% down to 12%.
- Under `prefers-reduced-motion: reduce` it shows a static 2px halo with no animation.

### Terminal palettes

SCHEMA: `ITheme` entries in `src/shared/terminal-themes/defaults.ts`:

- `'Quirky Graphite Dark'`:
  - Base: background `#16171b`, foreground `#eceef2`, cursor `#eceef2`, cursorAccent `#16171b`, selectionBackground `#5fd0d640`, selectionForeground `#eceef2`.
  - Normal ANSI: black `#101114`, red `#ef6b73`, green `#4cc38a`, yellow `#e5b454`, blue `#6fb3ff`, magenta `#bd8ee8`, cyan `#63c5cf`, white `#c5c9d2`.
  - Bright ANSI: brightBlack `#7c828d`, brightRed `#ff8b93`, brightGreen `#70dba5`, brightYellow `#f5ce7e`, brightBlue `#9fcbff`, brightMagenta `#d4acf4`, brightCyan `#8ddce3`, brightWhite `#eceef2`.
- `'Quirky Graphite Light'`:
  - Base: background `#ffffff`, foreground `#1b1d22`, cursor `#1b1d22`, cursorAccent `#ffffff`, selectionBackground `#14808a30`, selectionForeground `#1b1d22`.
  - Normal ANSI: black `#1b1d22`, red `#d6455d`, green `#1f9d63`, yellow `#a56e08`, blue `#2f74c0`, magenta `#9656b8`, cyan `#167f8b`, white `#c5c9d2`.
  - Bright ANSI: brightBlack `#646b76`, brightRed `#b62d46`, brightGreen `#167747`, brightYellow `#855706`, brightBlue `#215b9a`, brightMagenta `#784293`, brightCyan `#106570`, brightWhite `#f4f5f7`.

CONFIG: the marker key is `terminalGraphiteDefaultsMigrated?: boolean` in `GlobalSettings`.

## DO-NOT-CHANGE fences

- **`--quirky-security-*` stays literal hex.** `.plugin-security-chrome` (`M:472-492`) freezes the trust surfaces by re-declaring the core variables from these constants. If they became `var(--background)` aliases, a plugin that sets root tokens could restyle the consent dialog (SC-7). `R/components/ui/security-surface.test.tsx` and `chat-color-tokens.test.ts:98` must stay green.
- **`composedTerminalThemesEqual` and its call in `terminal-appearance.ts:167-169`.** This guard is what stops xterm from rebuilding its atlases and from dropping OSC palette changes. It's correct as it stands.
- **The protocol shape `RuntimeMobileTerminalTheme`** (`src/shared/runtime-mobile-session-tab-contracts.ts:41-46`). Old and new mobile clients depend on it (SC-9, SC-10). The palette travels as values, so nothing changes here.
- **The editor `key` props** (`MonacoEditor.tsx:272` `key={modelUri}` and the diff model paths). Adding `isDark` would remount editors on a mode switch, which breaks Done-when 4.
- **`src/shared/terminal-themes/` entries other than the two new ones.** Logic scope rules out catalog changes beyond the additions.
- **`R/components/editor/export-css.ts`, `R/components/feature-wall/*`, brand SVG fills (`status-bar/icons.tsx`, `tab-bar/shell-icons.tsx`), share-card and canvas drawing colours.** These are exported or marketing artwork and brand marks, not app chrome.
- **`terminalUseSeparateLightTheme` semantics** in `selectTerminalTheme`. Logic says Separate light theme behaves as it does today.

## Always, Ask, Never

**Always**

- Use the token or class from [Data models](#data-models-and-pinned-shapes). Never introduce a new hex in a component.
- Keep both modes in step. Every token you change in `:root` gets its `.dark` value in the same edit.
- Keep the changed-lines design-system gate (`pnpm run check:code-quality:changed`) green.
- Validate Electron UI only in the background with `QUIRKY_BACKGROUND_LAUNCH=1` and hidden-renderer CDP screenshots.

**Ask** (the orchestrator, who escalates to the owner)

- Any contrast pair that fails its floor with a value from the map.
- Any surface where the mock and the token map disagree.

**Never**

- Change a locked palette value without a dated amendment in logic.md.
- Add a theme picker, a named-theme registry or a `quirky theme` CLI.
- Add Windows or Linux branches.
- Run the full test suite or `pnpm typecheck` locally.

## Cross-cutting

- **Data migration:** the one-time terminal move above. **Rollback:** the old theme names stay in the catalog, so reverting the defaults commit leaves existing settings valid. A user who was moved keeps graphite until they pick another theme.
- **Remote and mixed versions:** everything is client-side. The terminal palette is pushed as resolved colours in the existing session-tab snapshot, so no RPC, schema or golden changes are needed (SC-9, SC-10, SC-11).
- **Folder workspaces:** no code here branches on workspace kind (SC-8).
- **Observability:** none needed.

## Testing strategy

Run one file at a time: `QUIRKY_ALLOW_LOCAL_TESTS=1 pnpm exec vitest run --config config/vitest.config.ts <file>` after `pnpm run build:packages`. For mobile, use `cd mobile && pnpm vitest run <file>`.

- **T1**
  - Update `R/assets/fork-native-chat-coloring/chat-color-tokens.test.ts` and `chat-tool-color-contrast.test.ts` for the graphite canvases. The `--tool-*` hues must still reach 4.5:1 on `#16171b`/`#0c0d0f` and `#ffffff`/`#eef0f3`.
  - Add one new contrast test, `R/assets/graphite-token-contrast.test.ts`. It parses `M` and asserts `--foreground` and `--muted-foreground` reach 4.5:1 against `--background` and `--sidebar`, and the five status tokens reach 3:1 against both canvases, in each mode. This is the regression guard for Done-when 2.
  - Update the Mermaid config tests.
- **T2:** update the existing tests for the touched status components that assert the old classes. Add no new tests.
- **T3**
  - Add cases to `terminal-settings-migrations.test.ts` for SC-4 (both on the old default), SC-5 (dark custom, light old), a marker already stamped, empty strings, and idempotence.
  - Update `normalize-loaded-global-settings.test.ts`, then update the import test beside `apply.ts` for skipping legacy values.
  - Re-run `R/lib/terminal-contrast-correction.test.ts`. The new dark theme's chromatic ANSI already exceed 3:1, so `ACCEPTED_BELOW_FLOOR` doesn't change.
  - Tests that compare against the old names as the default get updated: `src/shared/terminal-theme-selection.test.ts`, `src/shared/pty-owner-color-query-colors.test.ts`, `R/runtime/sync-runtime-graph/mobile-terminal-theme.test.ts`, `R/components/settings/TerminalThemeSections.lifecycle.test.ts`, `R/components/terminal-pane/terminal-appearance.test.ts`, `R/lib/terminal-theme.test.ts`, `R/components/native-chat/native-chat-appearance-style.test.ts`, `R/components/native-chat/use-native-chat-appearance-style.test.tsx`, `R/components/dashboard-popout/AgentTerminalPreview.settings-lifetime.test.tsx` and `src/shared/terminal-custom-themes.test.ts`.
- **T4**
  - Add `src/main/window/window-background.test.ts` for the pure resolver.
  - Update `R/components/editor/MonacoEditor.system-theme.test.tsx` for the new theme ids.
  - Update the harness mocks.
- **T5**
  - `mobile-theme-contrast.test.ts` must pass unchanged in its thresholds.
  - Update the tests that hardcode old colours: `src/terminal/terminal-webview-theme.test.ts`, `src/components/agent-monitoring-indicators.test.ts`, `src/components/MobileMarkdown.rendering.test.tsx`, `src/tasks/use-mobile-tasks-provider-view-projection.test.tsx`, `src/terminal/terminal-webview-engine-error.test.ts`, `src/worktree/workspace-filter-repos.test.ts`, `src/mobile-web-shell/ShellWaitingFrame.test.tsx`, `src/session/MobileNativeChatBackgroundTasks.test.tsx` and `src/session/use-mobile-native-chat-composer-tray.test.tsx`.
  - Regenerate the terminal document bundle with `node scripts/build-terminal-document-script.mjs` when `src/terminal/document/` changes.
- **Acceptance bar:** the screen rows in [Screens](logic.md#screens) are checked by a background CDP screenshot sweep after merge. That sweep is the Done-when 1 evidence, and it isn't a per-task gate.

## Non-goals

- The syntax token colours in chat code blocks (shiki `dark-plus`/`light-plus` in `R/lib/syntax-highlighting/syntax-highlighter.ts:88-91`) and the `--hljs-*` rich-markdown colours. Logic only asks for the code background and diff tints there.
- A new lint rule for raw colours in `.ts` files or inline styles. The existing changed-lines gate already blocks raw palette and arbitrary colour classes in added `.tsx` lines (`config/oxlint-design-system.json:31-35`, `config/scripts/check-changed-code-quality.mjs:59-64`).
- An inline pre-paint script in the HTML entries. The window background plus `nativeTheme.themeSource` (which Chromium resolves into `prefers-color-scheme` before JS runs) is enough for SC-6.
- A settings-reset path. None exists today.
