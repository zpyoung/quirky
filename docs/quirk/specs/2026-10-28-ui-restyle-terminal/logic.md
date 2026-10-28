# Terminal and agent composer: shared graphite presentation

**Status:** Approved parent design; autonomous slice decisions recorded under LOOP.md build-first.

## Why and conceptual model

Apply the approved [desktop redesign](../2026-10-28-ui-redesign/logic.md) to `quirky.terminal` and `quirky.terminal-dock`. The host continues to own center views, tool stripes, placement, global dialogs and toasts. Terminal workspace state, PTY lifecycle, composer drafts, provider recognition, questions, transport and settings remain with their existing owners. This item changes presentation, not those contracts.

Terminal sessions and Quick commands retain their bottom-left tool destinations. Worktree terminal views remain in center tabs, including existing internal group/tab/pane behavior. Floating terminal remains the existing in-renderer overlay, not a new native window. The embedded composer remains a separately mounted public dock view, not a terminal-plugin import of dock internals.

## Key decisions and rationale

- Use the public shared graphite controls, semantic tokens and central shared stylesheet. Remove terminal-owned stylesheet injection instead of tokenizing prohibited plugin CSS.
- Extend a shared control only where existing behavior cannot be expressed: nested/searchable context menus, rich draggable tab presentation, ref-addressable text fields, multiline fields and selects. State and actions stay in plugins. Do not remove menu keyboard/submenu behavior or composer capabilities to fit a simpler primitive.
- Central terminal layout CSS is host-owned presentation, using semantic design tokens, not copied legacy palette/geometry or a second plugin toolkit. Measured pane rectangles and persisted/user-configured terminal geometry remain data, not hardcoded visual styling.
- Preserve graphite terminal-theme ownership, custom/Tango overrides, terminal keyboard priority and all existing shortcuts.
- Rejected alternatives: retaining injected CSS violates the enforced contract; flattening terminal interactions into basic tabs/menus changes behavior; rewriting PTY or composer logic adds unrelated risk.

## Data flow

Existing daemon/plugin events update the existing controllers and composer state. Their React renderers supply content and callbacks to shared controls. Existing public UI mounting, command, confirmation and toast APIs retain all side effects. The resolved dark/light data-theme selector supplies semantic colors for every rendered surface; xterm continues to use its existing theme adapter.

## Behavior and acceptance scenarios

1. **Worktree terminal.** Given an opened worktree with terminal sessions, opening its center view displays graphite tabs, active indigo selection, semantic activity indicators and terminal output. Split, tab switch/rename/pin/close/reorder, drag/drop, pane actions and group resize still operate on the same IDs and controller calls. Example: two sessions `shell` and `agent`; switching to `agent` changes only the active tab and preserves both sessions.
2. **Context menus and dialogs.** Given an open tab/pane menu, arrow keys, nested submenus, disabled/destructive rows, optional search and Escape retain their current behavior. Rename/close/switcher dialogs keep their existing confirmation and focus semantics, now using the shared control surfaces. Example: Escape in a submenu returns to its parent without executing a command.
3. **Terminal accessories.** Search retains query, match status, regex/case toggles and Enter/Shift+Enter/Escape behavior. Mobile-driver, link preview, exit/restart, paste consent and emulator preview states remain readable in both themes. Example: a search query with no match still shows its exact status and leaves terminal input ownership unchanged.
4. **Sessions tool.** Existing live session list shows workspace/session identity, semantic status and separate row actions. Refresh, kill, kill-all and restart retain explicit confirmation and public RPC ownership. Empty state is a shared one-line state with one existing meaningful action; errors remain truthful. Example: cancelling Kill session leaves the session untouched.
5. **Quick commands.** Search/filter, repository/global grouping, run/drag/context menus, add/edit/delete, advanced fields, confirmation and current target selection remain intact. The panel, strip, picker and dialogs use shared controls. Example: editing a repo command leaves its scope/target/body unchanged until Save.
6. **Floating terminal.** Existing toggle, title bar, move/resize/maximize/close and menus retain their geometry/state behavior while using shared presentation. Example: maximizing then restoring retains its saved rectangle.
7. **Agent composer.** Existing embedded editor, highlighted overlay alignment, attachments, pickers, provider options, send/stop, context usage, offline/unsupported/passthrough notices and question/permission answering use the shared palette/controls. Example: with draft `Explain this`, attaching a file then cancelling a picker preserves that draft; disabled/offline state never enables an unsafe send.
8. **Settings and appearance.** Terminal shortcuts and dock experimental toggles retain values and daemon writes through shared form rows. Dark/light changes update all chrome without remounting the terminal or clearing a draft. Example: changing app appearance from dark to light changes composer/panel colors while the exact draft remains.
9. **Enforcement.** Both plugin IDs are added to `scripts/ui-lint-plugins.json`; canonical UI lint reports no plugin CSS/raw colors/raw pixel violations and remains part of typecheck. No scanner exemption or baseline is added.

Existing terminal/dock behavioral suites are retained, with consumer-visible regression coverage for uncertain state/focus/keyboard boundaries if changed. No source-text/component-copy assertions are introduced. Under this item's explicit build-first policy, tests are authored, not run. Typecheck and a narrowly scoped actual browser/daemon surface smoke provide the exercised evidence; automated screenshot scoring/full dogfood remain the end-phase gate and are not claimed passed.

## Scope and non-goals

All built-in desktop UI of these two plugins, including terminal-owned tool panels, dialogs, settings, overlays and embedded composer. No phone redesign, shell placement changes, new feature/RPC/CLI vocabulary, provider logic, PTY replay/input changes, shortcut changes, native window behavior or palette rewrite. Other plugins and their legacy CSS remain owned by their restyle items.

## Decisions Locked

- Layout/density: current host slots; graphite shared comfortable controls; preserve rich terminal geometry.
- Loading/empty/error: existing state semantics; shared readable states/actions without fabricated data or success.
- Interaction: no removed terminal/composer capabilities, hidden consent, changed focus routing or shortcut precedence.
- Workflow: one combined spec with technical section, contracts first, at most three disjoint OpenAI implementers; no human prompts, research swarms or formal review campaign under build-first.

## Industry Insights

The approved parent design and landed shared-system/shell/theme/capture decisions are the research authority for this slice. No new research swarm is needed or permitted by LOOP.md. Existing shared controls provide keyboard/focus semantics; preserve richer terminal behavior by promoting missing reusable variants rather than implementing local substitutes.

## Deferred Ideas

None: no product flow is intentionally deferred. Automated screenshot scoring is an unrun verification gate under build-first, not an unbuilt product flow.

## Glossary

- **Terminal workspace:** existing controller-owned group/tab/pane layout inside a center view.
- **Dock:** public embedded agent-composer view below a supported terminal.
- **Measured geometry:** runtime pane rectangles/user preferences, distinct from static design dimensions.

## Technical decisions and contracts

- Public UI controls/tokens remain `@quirky/ui`; styles are loaded through the existing host stylesheet. No plugin CSS injection/import helper remains after cutover.
- If needed, add shared advanced variants with behavior matching the existing terminal controls; commit their prop/type contracts before implementation. No production protocol, contribution IDs, settings schemas or API signatures change.
- Component A owns terminal workspace/floating renderers and shared terminal layout/context-menu variants. Component B owns sessions, quick commands, terminal pane accessory UI and shortcut/emulator presentation. Component C owns dock composer/settings, the central dock stylesheet removal and all three shared stylesheet imports. Parent owns lint allowlist, shared contract declarations, integration repairs and evidence.
- Shared stylesheet files are disjoint: terminal workspace/floating, terminal tools/accessories, and dock. New CSS uses only canonical semantic color/font/spacing/radius/dimension tokens (derived calc/clamp accepted), zero and runtime measurements.
- No worker runs build/lint/typecheck/tests/formatters or commits. Parent accepts only after the all-writer scope barrier, then runs `bun scripts/ui-lint.ts`, `bun run typecheck`, `bun packages/ui/build.ts` and focused actual-surface smoke. Any tests later executed use `bun scripts/suite.ts <file-or-dir>` remotely per the lane's operator rule.
- Mac-only verification. Portable browser/CSS APIs preferred; Linux/Windows/native host validation is unexercised, not implied by web smoke.
- Shared ContextMenu portals to the renderer document body to escape plugin slot stacking/scroll boundaries; its test consumers query the owning document. The shared token set includes --ui-transparent for layered editor/overlay presentation. Search decoration colors come from the existing fully resolved TerminalPalette, never independent raw colors.

## Status & amendments

2026-10-28: self-reviewed against parent scope and all nine scenarios; no open human decisions or placeholders. Combined technical section follows LOOP.md build-first override; no separate tech.md or spec review round.

2026-10-28: integration amendments clarify exclusive stylesheet-import ownership, the shared context-menu portal boundary and canonical transparency/resolved-palette use. No product flow, shortcut, runtime authority or default slot changed. Decisions D7–D11 record observed compiler/browser evidence and verification limits.
