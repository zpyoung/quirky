# Graphite theme for Orca-based Quirky

Quirky gets back the look it had in v1: calm graphite surfaces, one teal accent, and colours reserved for agent status. It replaces the neutral gray inherited from Orca. This spec is for the owner, who uses Quirky as a daily driver, and for the agents that build it. It covers the desktop app, the terminal, the editor and Quirky Mobile.

## Status & amendments

**Status:** Draft

**Amendments:** none yet.

## The model

There is one look, **graphite + teal**. Settings stay as they are: **Theme** still offers System, Dark and Light, and each mode resolves to the graphite palette for that mode. There is no theme picker and no second palette.

The palette is v1's graphite set (tag `quirky-v1-final`, `packages/ui/src/design-system/tokens.css`), with three changes from v1:

- **The accent is teal**, not indigo. It is `#5fd0d6` in dark and `#14808a` in light. It marks primary buttons, focus rings, the active tab underline, the selected-row bar, links, switches and the editor selection tint.
- **Agent status colours.** Working is blue (`#6fb3ff` dark, `#2f74c0` light) with a halo and a slow pulse. Needs you is amber, failing is red, and done is green. This replaces Orca's yellow-working and orange-asking wherever a status shows.
- **Terminal ANSI blue becomes plain blue**, because in v1 that slot was the indigo accent.

It is a recolour only. Geist, Orca's sizing, spacing, radii and layout all stay. The new values replace the old ones in place in `main.css`. That is acceptable because Quirky is a hard fork: upstream changes arrive through a hand-picked upstream review, not automatic merges.

| Role                                           | Dark      | Light     |
| ---------------------------------------------- | --------- | --------- |
| Rail (sidebars, status bar, window background) | `#0c0d0f` | `#eef0f3` |
| Surface (tabs, terminal, editor)               | `#16171b` | `#ffffff` |
| Selected                                       | `#22242b` | `#e7e9ef` |
| Border                                         | `#24262c` | `#e3e5ea` |
| Text                                           | `#eceef2` | `#1b1d22` |
| Muted text                                     | `#7c828d` | `#80868f` |
| Accent (teal)                                  | `#5fd0d6` | `#14808a` |
| Working (blue)                                 | `#6fb3ff` | `#2f74c0` |
| Needs you (amber)                              | `#e5b454` | `#c98a0b` |
| Failing (red)                                  | `#ef6b73` | `#d6455d` |
| Done (green)                                   | `#4cc38a` | `#1f9d63` |

Code, diff and syntax colours are v1's values from the same file, listed in Decisions Locked.

## How the look reaches each surface

The app mode (System resolved to dark or light, or a pinned Dark or Light) is the one signal every surface follows. When it changes, every surface below switches together, live, without a reload and without remounting a terminal or editor.

- **Renderer chrome** reads the shared tokens: the core set plus the sidebar, worktree-sidebar, chat, status and destructive families. The frozen trust-dialog palette also moves to graphite, and plugins still can't restyle it.
- **Hardcoded colours** move onto tokens. About 200 Tailwind `neutral`/`zinc` classes and about 230 hex literals in renderer components bypass tokens today, and they would otherwise stay neutral.
- **The terminal** gets two new catalog entries, _Quirky Graphite Dark_ and _Quirky Graphite Light_, which become the defaults. Every other catalog theme and every custom, Warp or YAML theme stays pickable. _Separate light theme_ behaves as it does today.
- **The editor (Monaco)** gets a graphite theme for each mode, using v1 syntax colours and a teal selection.
- **Diffs, chat code blocks and Mermaid** take v1's add and delete tints and code background. Mermaid reads the tokens.
- **The native window background** uses the rail colour for the resolved mode before the renderer paints.
- **Quirky Mobile** has its own tokens, and they move to graphite, teal and the new status colours. It stays dark only. Its terminal already takes the palette desktop pushes.
- **`docs/STYLEGUIDE.md`** changes from "monochrome and quiet" to graphite with one teal accent and status-only hues. Its contrast floors are re-measured against the graphite canvases instead of `#fff` and `#0a0a0a`.

## Key decisions

- **One look, no picker.** A second palette would need maintaining with no reader asking for it, so Orca's neutral is dropped.
- **Teal replaces indigo.** The owner rejected indigo. Teal stays clear of the four status hues. Working blue sits nearest to it, so the working dot pulses, which reads as activity rather than selection.
- **Status hues follow meaning.** Blue for in progress, green for done, amber for waiting on you, red for broken. Amber is the only warm hue apart from red, so a waiting agent stands out.
- **The values go in place.** Quirky is a hard fork with hand-picked upstream ports, so a separate overlay file would add indirection without saving merges.
- **People on the old terminal defaults move once.** Anyone still on Orca's defaults lands on graphite, and anyone who chose a theme keeps it.

## Behaviour and scenarios

1. **SC-1: macOS switches appearance while Theme is System**
   - **Given** Theme is System, with a terminal running and a file open in the editor
   - **When** macOS switches from dark to light
   - **Then** chrome, terminal, editor, diffs and code blocks all switch to graphite light. The terminal keeps its scrollback, and nothing remounts.
   - **Data before:** **Window**: rail `#0c0d0f`; accent `#5fd0d6`; **Terminal**: _Quirky Graphite Dark_, 2,000 lines* of scrollback
   - **Walkthrough:**
     1. macOS reports light appearance.
     2. The app mode resolves to light, and every surface takes the light palette.
   - **Data after:** **Window**: ✓ rail `#eef0f3`; ✓ accent `#14808a`; **Terminal**: ✓ _Quirky Graphite Light_, ✓ the same 2,000 lines* of scrollback

2. **SC-2: Agent status across the app**
   - **Given** four worktrees whose agents are working, waiting on the user, failing and done
   - **When** the owner looks at the sidebar, tabs and status bar
   - **Then** each status shows its colour, and the toast that announces the waiting agent has an amber left edge. Toast timing and behaviour stay as Orca has them.
   - **Screen states:**

     | Worktree       | Dot                    | Second line               |
     | -------------- | ---------------------- | ------------------------- |
     | "quirky-theme" | ✓ blue, pulsing        | claude · editing main.css |
     | "fix-ledger"   | ✓ amber, count badge 1 | ✓ amber "needs you"       |
     | "mobile-sync"  | ✓ red, count badge 3   | tests failing             |
     | "docs-pass"    | ✓ green                | done                      |
     | "main"         | ✓ grey                 | idle                      |

3. **SC-3: Primary action and focus**
   - **Given** any dialog with a primary action
   - **When** the owner tabs to the primary button
   - **Then** the button is teal with dark text in dark mode (white text in light mode), and its focus ring is a 2px teal outline offset by 2px.

4. **SC-4: First launch after the update, terminal on the old default**
   - **Given** the owner's terminal settings are still on Orca's defaults
   - **When** Quirky launches for the first time after the update
   - **Then** both terminal themes move to Quirky Graphite, once. A later manual pick of Ghostty Default is never undone.
   - **Data before:** **Settings**: dark terminal theme "Ghostty Default Style Dark"; light terminal theme "Builtin Tango Light"
   - **Walkthrough:**
     1. Quirky sees the old defaults on first launch after the update.
     2. It swaps each one for the matching graphite theme and records that the move happened.
   - **Data after:** **Settings**: ✓ dark "Quirky Graphite Dark"; ✓ light "Quirky Graphite Light"; ✓ marked as moved

5. **SC-5: First launch after the update, custom terminal theme**
   - **Given** the owner picked "Tokyo Night" for dark and kept "Builtin Tango Light" for light
   - **When** Quirky launches for the first time after the update
   - **Then** Tokyo Night stays, and only the light side moves.
   - **Data before:** **Settings**: dark "Tokyo Night"; light "Builtin Tango Light"
   - **Data after:** **Settings**: ✓ dark "Tokyo Night" unchanged; ✓ light "Quirky Graphite Light"

6. **SC-6: No flash on launch or a new window**
   - **Given** the resolved mode is dark
   - **When** Quirky opens its first window, a new window or a popout
   - **Then** the first visible frame is the graphite rail colour `#0c0d0f`, never white or `#0a0a0a`. In light it is `#eef0f3`.

7. **SC-7: Plugin consent dialog**
   - **Given** a plugin ships its own CSS
   - **When** it asks for permission to run commands
   - **Then** the trust dialog shows on the graphite security surface with a teal Allow button, and the plugin's CSS doesn't change it.

8. **SC-8: Folder workspace**
   - **Given** a folder workspace that isn't a git worktree
   - **When** it is open
   - **Then** it looks exactly like a git worktree. The theme never depends on the workspace kind.

9. **SC-9: Old mobile client, new desktop**
   - **Given** a phone on an older Quirky Mobile is paired with an updated desktop
   - **When** the owner opens a terminal on the phone
   - **Then** the terminal uses the graphite palette desktop pushes, inside the phone's older neutral chrome. Nothing errors, because the palette travels as an ordinary terminal-theme value.

10. **SC-10: New mobile client, old desktop**
    - **Given** an updated phone is paired with an older desktop
    - **When** the owner opens the app
    - **Then** the phone's chrome is graphite and its terminal shows whatever palette that desktop pushes.

11. **SC-11: Remote host on an older version**
    - **Given** the updated desktop is connected to an older remote host
    - **When** the owner works in a remote worktree
    - **Then** everything is graphite, because the theme is client-side only.

## Screens

The signed-off mock (version 1) is at [mock/mock.html](mock/mock.html), and its inventory is at [mock/screens.md](mock/screens.md). The UX review closed as Looks right with no pins. The owner opened the Workspace and Editor & diff screens.

| Screen               | State | Acceptance                                                                                                                                |
| -------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace            | dark  | Matches mock: sidebar status rows, teal selected bar and tab underline, terminal palette, status bar, amber needs-you toast               |
| Workspace            | light | Matches mock in the light palette                                                                                                         |
| Editor & diff        | dark  | Matches mock: v1 syntax colours, teal selection tint, v1 diff add and delete tints                                                        |
| Editor & diff        | light | Matches mock in the light palette                                                                                                         |
| Chat                 | dark  | Matches mock: user bubble, inline and block code on the code background, teal link, teal Send                                             |
| Chat                 | light | Matches mock in the light palette                                                                                                         |
| Settings: Appearance | dark  | Matches mock: System / Dark / Light with a teal underline, Quirky Graphite terminal defaults, ANSI swatches, teal switch, teal focus ring |
| Settings: Appearance | light | Matches mock in the light palette                                                                                                         |
| Trust dialog         | dark  | Matches mock: graphite security surface, teal Allow                                                                                       |
| Trust dialog         | light | Matches mock in the light palette                                                                                                         |
| Mobile worktrees     | dark  | Matches mock: graphite rows with status dots, terminal, teal primary button                                                               |

No gaps: every mocked element maps to an existing component. Mobile light is skipped by decision.

## Done when

1. A screenshot sweep in dark and light shows no leftover Orca-neutral surfaces or accents. It covers the sidebar, terminal, editor, diff, chat, settings, kanban and dashboard, and dialogs including trust, plus mobile in dark.
2. Text meets 4.5:1 and status marks meet 3:1 against the graphite canvases.
3. No white or near-black flash appears on launch, on a new window or on a popout.
4. Switching mode never remounts a terminal or editor.
5. People on the old terminal defaults land on Quirky Graphite after the update, and custom picks survive.

## Scope and non-goals

These are out of scope:

- v1's tool-slot layout, density, type scale and system font.
- A theme picker, a named-theme registry, plugin theme contributions, and bringing `quirky theme` back to the CLI.
- A light mode for Quirky Mobile.
- Changes beyond colour: no new shadows, radii or motion, apart from the working-dot pulse.
- Changes to the terminal catalog beyond adding the two Quirky Graphite entries.

## Decisions locked

**Scope**

- Accent: teal (`#5fd0d6` dark, `#14808a` light) on primary actions, focus rings, the active tab, selection and links. It replaced indigo at the owner's request.
- Agent status: working is blue (`#6fb3ff` / `#2f74c0`) with a halo and slow pulse; needs you is amber (`#e5b454` / `#c98a0b`); failing is red (`#ef6b73` / `#d6455d`); done is green (`#4cc38a` / `#1f9d63`).
- UI font: Geist stays.
- Density: Orca's sizing stays, so the theme is colour only.

**Coexistence with the Orca look**

- Graphite replaces neutral. Settings stay System / Dark / Light.
- Both v1 palettes, dark and light, come over.
- Trust dialogs go graphite and stay frozen against plugins.
- There is no `quirky theme` CLI command.

**Terminal, editor and other surfaces**

- Terminal: _Quirky Graphite Dark_ and _Quirky Graphite Light_ join the catalog as the defaults. The ANSI palette is v1's, except blue (`#6fb3ff` / `#2f74c0`) and bright blue.
- People on the old defaults move to graphite once, and custom picks stay.
- Monaco gets a graphite theme with v1 syntax colours and switches live with the mode. Dark: keyword `#c79bff`, function `#6fb3ff`, string `#6dd6b4`, number `#ff9d7a`, comment `#8a909b`, type `#5fd0d6`, constant `#d6b58c`, punctuation `#a0a6b1`. Light: keyword `#7f4fc9`, function `#2a6cb5`, string `#1a7a5c`, number `#b4532f`, comment `#5c6570`, type `#0f6f78`, constant `#8f6a3a`, punctuation `#57606a`.
- Diffs and code use v1's values. Dark: code background `#101114`, code header `#1b1c21`, add `#3fb95024` / `#a6f0b0`, delete `#e5534b24` / `#ffb3ad`. Light: code background `#f6f7f9`, code header `#eceef2`, add `#2da44e1f` / `#116329`, delete `#cf222e1a` / `#82071e`. Mermaid follows the tokens.

**Mobile**

- Mobile is rethemed in the same pass: graphite, teal and the new status colours.
- Mobile stays dark only.

**Success**

- Done means the screenshot sweep, with no neutral left and the contrast floors met.
- Graphite shows from the first frame.

**Approach and review**

- Approach: edit `main.css` token values in place, plus terminal, Monaco, window and mobile adapters and a sweep of hardcoded neutrals.
- UX review: signed off as Looks right at mock v1, with no pins.

## Industry insights

- **Fork theme isolation.** Keeping fork colours in files upstream never edits keeps syncs conflict-free ([Heimdall #402](https://github.com/tinkermonkey/heimdall/issues/402), [t3code #194](https://github.com/Yarden-zamir/t3code/pull/194)). It isn't needed here: Quirky is a hard fork with hand-picked ports, so in-place edits cost little.
- **Literals are the real cost.** Token overrides can't reach hardcoded colours. Teams found around 110 of them in one fork ([Heimdall #402](https://github.com/tinkermonkey/heimdall/issues/402)), and literal drift caused most of the breakage in a similar Electron theming effort ([clanker #48](https://github.com/Bynzski/clanker/issues/48)). This is why the neutral sweep is in scope.
- **Dark mode exposes token mistakes.** Tokens that share a light-mode value break only in dark ([Island](https://www.island.io/blog/teaching-ai-to-migrate-code)), and merged hover and press states lose their feedback in dark ([Reviewable](https://www.reviewable.io/blog/repainting-our-app-mid-flight/)). The sweep covers both modes.
- **Light-theme ANSI fails first.** Dark-tuned white and yellow vanish on light backgrounds ([Claude Code #40071](https://github.com/anthropics/claude-code/issues/40071), [hello-halo #276](https://github.com/openkursar/hello-halo/issues/276)). v1's light palette already sets explicit, darker slots.
- **The window flash comes from the native background.** A window created with a hardcoded background flashes before CSS loads, so set it from the saved mode ([clanker #48](https://github.com/Bynzski/clanker/issues/48), [Electron dark mode](https://www.electronjs.org/docs/latest/tutorial/dark-mode)).
- **Terminal theme churn.** Reassigning an equal xterm theme object rebuilds WebGL atlases ([xterm.js #6291](https://github.com/xtermjs/xterm.js/issues/6291)), so apply the palette only when it changes.
- **Monaco themes are global and can go stale.** `setTheme` affects every editor, and some apps saw editors stay on the old theme until remount ([termiHub #4356](https://github.com/armaxri/termiHub/issues/4356), [beatbax #247](https://github.com/kadraman/beatbax/issues/247)).

## Deferred ideas

- A theme picker or plugin theme contributions, for when a second theme exists. Orca's plugin marketplace already lists a `themes` kind.
- A light mode for Quirky Mobile.
- Bringing back `quirky theme list/set`.
- v1's tool-slot layout, which needs its own brainstorm.
- [tech-spec] A changed-lines check that blocks new raw neutral classes and hex literals in renderer code, so the sweep stays done.
- [tech-spec] How the terminal-default move is marked as done, so it runs once and survives a settings reset.
- [tech-spec] How Monaco switches theme live without remounting, given that `setTheme` is global.
- [tech-spec] Applying the xterm palette only when its value changes (xterm.js #6291).
- [tech-spec] Where the native window background is chosen before the first window is created, for main windows and popouts.
- [tech-spec] Handling the `.dark .x` override rules in `main.css` and the separate `fork-native-chat-coloring.css`, `--worktree-sidebar-*` and `--quirky-security-*` families.
- [tech-spec] Updating `mobile-theme-contrast.test.ts` thresholds for the new mobile palette.

## Glossary

- **Graphite:** the v1 neutral family: rail, surface, selected, border, text and muted.
- **Rail:** the dimmer chrome colour behind sidebars, the status bar and the native window background.
- **Surface:** the work area, meaning tabs, terminal and editor.
- **Accent:** the single brand hue, teal, used for actions, focus and selection.
- **Needs you:** an agent is waiting on the owner.
- **Old terminal defaults:** Orca's shipped terminal themes, "Ghostty Default Style Dark" and "Builtin Tango Light".
- **Sweep:** a screenshot pass over every main screen in both modes, checked for leftover neutral and for contrast.
