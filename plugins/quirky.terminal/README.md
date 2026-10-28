# Terminal panes

## Fork Agent Session

Agent terminal panes contribute **Fork Agent Session** to the public `quirky.terminal/pane` menu after Quick Commands. The menu is hidden on plain shell panes.

The registered command is `command:quirky.terminal/fork-agent-session({ session })`, where `session` is the exact source pane's terminal-session ID. It inspects that session through `quirky.session/get`, calls the public `quirky.session/resume({ session, fork: true })` provider resolver, verifies the distinct result still points to the source, and opens only that returned session. Missing, stale, shell or unsupported sources refuse; the command never substitutes a different session.

## Shortcuts and renderer extras

Terminal Settings exposes each declared shortcut's inherited, remapped, disabled or shadowed state. Save changes the binding by contribution ID; Disable removes its key; Reset restores the current inherited key. The public `keybinding.list`, `keybinding.set` and `keybinding.reset` APIs use the same persisted profile overrides. Commands retain their original context and terminal-input policy, and menu hints follow the effective binding.

Visible panes load bounded image and font-ligature renderers. Images support SIXEL/iTerm and direct Kitty PNG/RGB/RGBA transmission, chunking, deflate, static placement and basic deletion. Kitty animation, Unicode virtual placements, file/shared-memory transmission and advanced delete selectors are unsupported; no graphics command reads the filesystem. Kitty image storage and placement canvases have independent 8 MiB budgets, with bounded uploads and cancellable decoding. Hidden panes dispose these resources and replay the existing PTY history on return.

## Documents in a terminal group

The group menu offers New Markdown, Open Markdown and Open File in Editor through the public editor owner. The picker captures the destination group, including a non-active split. New Markdown's initial buffer open uses that same group; it does not create an extra document tab in the previously active group. Document save, close and dirty-buffer behavior remain editor-owned.

Floating documents use the editor-owned profile notes directory, resolved explicitly by `quirky.editor/documentRoot({worktree:"floating"})`. This does not grant access to HOME or arbitrary files. Markdown, editor and Browser tabs preserve the captured floating group and use their existing public owners and close/resource leases.

## Terminal appearance and command tabs

Terminal panes follow the app's dark/light appearance by default, using graphite palettes with all 16 ANSI colors. Dark and Light pin terminal panes; System follows the OS independently of the app. Appearance and terminal-setting changes apply to open panes without restarting them. Tango and bounded custom JSON palettes remain available; invalid custom data warns and falls back to the matching graphite palette.

The application Settings theme picker offers Follow system, Dark and Light. The same persisted choices are `quirky theme set default`, `quirky theme set dark` and `quirky theme set light`. Terminal-only overrides use the existing `setting:quirky.terminal/theme-mode` setting (`inherit`, `system`, `dark`, `light`); resetting it restores application following. The Session viewer follows the application, not the terminal-plugin override. Plugin and distro themes remain selectable.

`quirky.terminal/newTab` accepts a shell-only `command`, matching `quirky terminal tab new --command`. Background composition uses `activate:false`; configured default-tab commands retain the existing session exit status. Tab colors accept named presets or safe `#rgb`/`#rrggbb` values through the same API, CLI, persistence and renderer.


## Mobile Emulator preview

New Mobile Emulator opens a read-only local iOS Simulator preview. It requires Xcode's `xcrun simctl` and an explicitly selected device UDID. It never boots, shuts down or controls a device, and never substitutes an implicit `booted` device. The preview reports unavailable, empty, shutdown, stale-frame and screenshot errors directly.

```sh
quirky terminal emulators --json
quirky terminal emulator-frame 11111111-2222-3333-4444-555555555555 --json
```

The example UDID must be replaced with one returned by `emulators`. The same operations are public methods `quirky.terminal/emulators` and `quirky.terminal/emulatorFrame({device})`. Visible previews request the next bounded frame one second after the previous request finishes; hiding the tab unmounts the preview and stops polling.
