# Graphite terminal themes

Status: Approved parent-design slice; autonomous choices recorded under `docs/loop/decisions/ui-terminal-theme.md`.

Reader: redesign implementers — Decision: preserve the theme contract while implementing desktop terminal colors.

## Why and conceptual model

The approved [desktop redesign](../2026-10-28-ui-redesign/logic.md) requires matching graphite dark/light terminal palettes, system-following appearance, and a persisted Settings override. The existing default terminal inherits only three colors, leaving ANSI colors unrelated to the app.

The application appearance and terminal override are separate choices. The default application theme follows the system; explicit Dark or Light choices pin the app. A terminal normally follows the resolved application appearance. Its existing Settings choice can instead follow the system independently or force dark/light. Existing Tango and bounded custom palettes remain available; this redesign does not remove existing behavior.

## Behavior and scenarios

1. **Fresh default:** given no saved theme choice and a dark system, opening the desktop shows graphite dark shell and all 16 terminal ANSI colors. Switching the system to light changes the existing shell and terminals to graphite light without replacing the xterm instances or losing output/selection.
2. **Application pin:** given the system is light, selecting Dark in Settings persists through the existing `theme.set` API. The app and inherited terminals stay dark when the system changes; selecting Follow system restores following. Explicit Light behaves symmetrically.
3. **Terminal pin:** given the app is dark, saving terminal `theme-mode=light` through Settings or `setting.set` makes terminal panes light without recoloring the shell. Changing the system/app does not override this terminal pin. Resetting the setting restores app following.
4. **Independent system mode:** given the app is pinned dark and terminal mode is system, a light system makes the terminal light and leaves the app dark. Existing dark/light palette choices apply in their matching mode.
5. **Custom application theme:** given an existing plugin theme, retain its declared terminal background/foreground/cursor and select graphite ANSI colors by its declared resolved appearance, not the system appearance or guessed luminance.
6. **Invalid custom terminal palette:** unsupported JSON keys, CSS expressions, arrays, oversized JSON, and invalid color values use the complete matching graphite fallback and existing warning path. No partial invalid palette is applied.
7. **Every desktop terminal:** both main terminal panes and the public Session viewer consume the same palette definition and update when resolved application appearance changes. The existing terminal-only overrides apply to terminal-plugin panes; the session viewer continues to follow the app as before.
8. **Scriptability:** theme list/set expose Follow system, Dark and Light through existing CLI/API. Saved theme/terminal settings survive a daemon restart. No new command or preference store is introduced.

Acceptance coverage includes app pin versus independent system precedence, live updates and listener cleanup, persisted CLI/API choices, complete ANSI color application, custom-theme inheritance, custom-palette rejection, and no xterm remount on appearance changes. Tests are authored under build-first rules; the end phase runs the suite. No separate Orca defect is listed for this approved slice.

## Key decisions and rationale

Use the existing theme ID `default` for Follow system, with built-in `dark` and `light` IDs for pins. This avoids an additional setting whose precedence could conflict with `theme.set` or distro themes. Existing plugin theme IDs and distro selection remain valid. The daemon reports the logical default choice; each window resolves its local system appearance.

Publish the resolved appearance as root `data-theme=dark|light`, shared with the tokens/gallery lane. Use one central pure palette data module, not hardcoded plugin color literals. Preserve existing terminal preference names and values.

Rejected: infer light/dark from background luminance (wrong for explicit theme appearance); always follow system (ignores application pins); remove Tango/custom settings (changes existing feature behavior).

## Scope and non-goals

In scope: desktop graphite ANSI/base colors, app appearance plumbing required to follow the system, persisted application and terminal pins, both desktop xterm paths, shared-token composition.

Non-goals: phone palettes, terminal layout/fonts/search styling, keyboard changes, new custom-theme editor, shell-slot redesign, screenshot-review infrastructure, or native-window appearance controls. The tokens/components lane owns canonical CSS tokens/components and UI lint; this slice adds no local CSS or raw inline color literals.

## Decisions locked

- Match approved graphite surface/text/accent/state colors in both appearances.
- Default terminals follow resolved application appearance; terminal pins never change shell colors.
- Follow system uses the existing default theme ID; pin choices use dark/light.
- Shared `data-theme` selector is the live appearance authority.
- Existing plugin, distro, Tango and custom choices remain functional.
- macOS is the only exercised platform; portable browser media-query API is used.

## Industry insights

Use the approved parent design's research; no new research swarm under build-first rules. The existing plugin Settings and theme APIs supply persistence/events, rather than introducing a second preference mechanism.

## Deferred ideas

None. Broader terminal restyling remains the existing `ui-restyle-terminal` item; no new follow-up is needed for this slice.

## Glossary

- **App appearance:** the resolved dark/light value, after a system-following or explicit application theme choice.
- **Terminal override:** existing terminal mode/palette preferences, independent of shell colors.
- **Graphite palette:** base, selection/cursor colors and all 16 ANSI slots from one central definition.

## Technical decisions and implementation contracts

- `packages/protocol/src/terminal-theme.ts` exports `TerminalAppearanceMode`, `TerminalPalette`, `TERMINAL_ANSI_KEYS`, and `GRAPHITE_TERMINAL_PALETTES`. Raw palette values belong here; consumers use the constants.
- Built-in `DEFAULT_THEME`, `DARK_THEME`, `LIGHT_THEME` retain the existing `ThemeInfo` shape. `default` remains the API fallback and now means Follow system; dark/light are explicit built-ins.
- `packages/ui/src/plugins/useThemeVariables.ts` resolves active default against `(prefers-color-scheme: light)`, applies theme CSS variables and root `data-theme`, and removes its media-query listener on teardown. It sets namespaced `--ui-rail/surface/selected/border/text/muted/accent/working/needs-you/failing` aliases from resolved theme variables, composing with lane5's design-system CSS.
- New public `@quirky/ui/terminal-theme` is a DOM adapter for terminal CSS variables and resolved appearance. Existing plugin helpers become consumers; xterm configuration remains plugin-owned.
- Worker AppTheme owns daemon theme model/service and UI appearance/settings behavior and tests, excluding styles.css and design-system files. Worker TerminalPalette owns terminal/session palette consumers, their tests/docs, and the new DOM adapter. Parent owns this spec, decision log, shared protocol contracts/data, integration package exports/lockfile and final checks.
- One wave with two disjoint components; no ordering-only dependency. All shared contracts are committed before dispatch. Workers never commit or run checks; parent audits and integrates after both return.
- Verification: minimal changed-surface browser smoke, root typecheck (including UI lint when its owning lane lands), and no suite/review campaign under build-first rules.

## Status & amendments

2026-10-28: self-reviewed against parent lines 91–115, 145–148, 173, 194–227. Every terminal-theme flow is assigned; phone and broader restyle remain excluded. Combined logic/technical spec per LOOP build-first override; no separate tech document.
