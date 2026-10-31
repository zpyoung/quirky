# Terminal panes

## Background Claude sessions

**New tab → Claude (background)** runs Claude without a PTY and opens its transcript in the group where the menu was opened. The selected tab shows the session state; the transcript shows the prompt, output and follow-up input. Background sessions started elsewhere are not automatically added to terminal groups.

Foreground agent sessions follow the permission mode in Agent settings. Background Claude sessions instead use tool approval; requests that need approval appear in Quirky, regardless of that foreground setting.

If the session starts but its tab cannot be opened, the dialog keeps the submitted prompt read-only and offers **Open session** for that same session; it does not launch another agent.

## Terminal sessions

The Terminal sessions dock keeps its scrollable session rows inset from both panel edges, including in narrow docks.

## Closing running terminals

Closing a terminal with a running command or agent asks for confirmation unless **Don't ask again for running terminals** is enabled. The confirmation starts with **Cancel** focused, so Return or Space keeps the terminal running; select **Stop and Close** or **Stop Agent** to stop it.

When a pane closes, its sibling takes the removed pane's space. If the closed pane was active, focus moves to the first pane in its promoted sibling subtree; closing an inactive pane leaves focus unchanged.

## Fork Agent Session

Agent terminal panes contribute **Fork Agent Session** to the public `quirky.terminal/pane` menu after Quick Commands. The menu is hidden on plain shell panes.

The registered command is `command:quirky.terminal/fork-agent-session({ session })`, where `session` is the exact source pane's terminal-session ID. It inspects that session through `quirky.session/get`, calls the public `quirky.session/resume({ session, fork: true })` provider resolver, verifies the distinct result still points to the source, and opens only that returned session. Missing, stale, shell or unsupported sources refuse; the command never substitutes a different session.

## Shortcuts and renderer extras

Terminal Settings exposes each declared shortcut's inherited, remapped, disabled or shadowed state. Save changes the binding by contribution ID; Disable removes its key; Reset restores the current inherited key. The public `keybinding.list`, `keybinding.set` and `keybinding.reset` APIs use the same persisted profile overrides. Commands retain their original context and terminal-input policy, and menu hints follow the effective binding.

Visible panes load bounded image and font-ligature renderers. Images support SIXEL/iTerm and direct Kitty PNG/RGB/RGBA transmission, chunking, deflate, static placement and basic deletion. Kitty animation, Unicode virtual placements, file/shared-memory transmission and advanced delete selectors are unsupported; no graphics command reads the filesystem. Kitty image storage and placement canvases have independent 8 MiB budgets, with bounded uploads and cancellable decoding. Hidden panes dispose these resources and replay the existing PTY history on return.

## Documents in a terminal group

The group menu offers New Markdown, Open Markdown and Open File in Editor through the public editor owner. The picker captures the destination group, including a non-active split. New Markdown's initial buffer open uses that same group; it does not create an extra document tab in the previously active group. Document save, close and dirty-buffer behavior remain editor-owned.

In a horizontally scrollable group, resizing the tab strip or changing the selected tab's title scrolls it back into view. Narrowing the window or renaming an open file does not require selecting another tab to reveal its Close control. Manual scrolling still lets you browse other tabs without changing the selection.

Tabs clipped at either edge move into the N more menu instead of showing a cut-off icon or Close control. Selecting one reveals it in the strip. A tab wider than the viewport remains visible while it fills the available width. The strip snaps tab starts to its leading edge; trailing scroll space lets the last tab align there too.

Floating documents use the editor-owned profile notes directory, resolved explicitly by `quirky.editor/documentRoot({worktree:"floating"})`. This does not grant access to HOME or arbitrary files. Markdown, editor and Browser tabs preserve the captured floating group and use their existing public owners and close/resource leases.

The floating panel and toggle stay below Usage popovers and public modal overlays, including while the window is inactive. Open dialogs make background controls inert, so the floating toggle is unavailable to pointer input and assistive technology until the dialog closes.

## Terminal appearance and command tabs

Terminal panes follow the app's dark/light appearance by default, using graphite palettes with all 16 ANSI colors. Dark and Light pin terminal panes; System follows the OS independently of the app. Appearance and terminal-setting changes apply to open panes without restarting them. Tango and bounded custom JSON palettes remain available; invalid custom data warns and falls back to the matching graphite palette.

The application Settings theme picker offers Follow system, Dark and Light. The same persisted choices are `quirky theme set default`, `quirky theme set dark` and `quirky theme set light`. Terminal-only overrides use the existing `setting:quirky.terminal/theme-mode` setting (`inherit`, `system`, `dark`, `light`); resetting it restores application following. The Session viewer follows the application, not the terminal-plugin override. Plugin and distro themes remain selectable.

`quirky.terminal/newTab` accepts a shell-only `command`, matching `quirky terminal tab new --command`. Background composition uses `activate:false`; configured default-tab commands retain the existing session exit status. Tab colors accept named presets or safe `#rgb`/`#rrggbb` values through the same API, CLI, persistence and renderer.

Terminal accessories render above the terminal only while they contain content. Empty accessory mounts, including the account switcher on plain shell sessions, stay hidden so they cannot obscure the prompt.


## Mobile Emulator preview

New Mobile Emulator opens a read-only local iOS Simulator preview. It requires Xcode's `xcrun simctl` and an explicitly selected device UDID. It never boots, shuts down or controls a device, and never substitutes an implicit `booted` device. The preview reports unavailable, empty, shutdown, stale-frame and screenshot errors directly.

```sh
quirky terminal emulators --json
quirky terminal emulator-frame 11111111-2222-3333-4444-555555555555 --json
```

The example UDID must be replaced with one returned by `emulators`. The same operations are public methods `quirky.terminal/emulators` and `quirky.terminal/emulatorFrame({device})`. Visible previews request the next bounded frame one second after the previous request finishes; hiding the tab unmounts the preview and stops polling.

## Verification

Run `bun scripts/suite.ts plugins/quirky.terminal` from the repository root. The runner keeps artifact capability/descriptor and iOS Simulator scenarios on macOS: those production APIs intentionally reject unsupported platforms, even when a test supplies a local file or an owned `xcrun` fixture. The remaining portable scenarios run on the configured remote test host. All process scenarios use private homes and reap their owned processes.
