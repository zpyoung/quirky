# Terminal panes

## Fork Agent Session

Agent terminal panes contribute **Fork Agent Session** to the public `quirky.terminal/pane` menu after Quick Commands. The menu is hidden on plain shell panes.

The registered command is `command:quirky.terminal/fork-agent-session({ session })`, where `session` is the exact source pane's terminal-session ID. It inspects that session through `quirky.session/get`, calls the public `quirky.session/resume({ session, fork: true })` provider resolver, verifies the distinct result still points to the source, and opens only that returned session. Missing, stale, shell or unsupported sources refuse; the command never substitutes a different session.

## Shortcuts and renderer extras

Terminal Settings exposes each declared shortcut's inherited, remapped, disabled or shadowed state. Save changes the binding by contribution ID; Disable removes its key; Reset restores the current inherited key. The public `keybinding.list`, `keybinding.set` and `keybinding.reset` APIs use the same persisted profile overrides. Commands retain their original context and terminal-input policy, and menu hints follow the effective binding.

Visible panes can load compatible image and font-ligature addons. Image rendering supports SIXEL and iTerm protocols, not Kitty graphics. Addons are bounded and disposed when their pane unmounts; returning to a pane replays its existing PTY history rather than starting another session.

## Documents in a terminal group

The group menu offers New Markdown, Open Markdown and Open File in Editor through the public editor owner. The picker captures the destination group, including a non-active split. New Markdown's initial buffer open uses that same group; it does not create an extra document tab in the previously active group. Document save, close and dirty-buffer behavior remain editor-owned.

## Mobile Emulator preview

New Mobile Emulator opens a read-only local iOS Simulator preview. It requires Xcode's `xcrun simctl` and an explicitly selected device UDID. It never boots, shuts down or controls a device, and never substitutes an implicit `booted` device. The preview reports unavailable, empty, shutdown, stale-frame and screenshot errors directly.

```sh
quirky terminal emulators --json
quirky terminal emulator-frame 11111111-2222-3333-4444-555555555555 --json
```

The example UDID must be replaced with one returned by `emulators`. The same operations are public methods `quirky.terminal/emulators` and `quirky.terminal/emulatorFrame({device})`. Visible previews request the next bounded frame one second after the previous request finishes; hiding the tab unmounts the preview and stops polling.
