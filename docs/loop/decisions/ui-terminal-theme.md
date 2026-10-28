# ui-terminal-theme decisions

## D1: Implement only the approved desktop terminal-theme slice
- **Question:** Which redesign flows belong to this item?
- **Options:** whole terminal restyle; graphite colors and appearance/override plumbing only.
- **Chose:** Graphite colors and required appearance/override plumbing, including both desktop xterm paths.
- **Why:** The approved rollout separates ui-terminal-theme from ui-restyle-terminal and excludes the phone app.
- **Evidence:** docs/quirk/specs/2026-10-28-ui-redesign/logic.md:115,145-148,173,176,194-201.
- **Reversibility:** easy (palette/data plumbing remains independent of layout).
- **Confidence:** high.
- **Revisit if:** the approved parent scope is amended.
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D2: Follow system is the existing default application theme; dark/light pin it
- **Question:** How should default appearance and Settings pins compose with existing theme selection?
- **Options:** new app setting with another precedence layer; existing theme API with default=system and dark/light built-ins; always follow system regardless of theme choice.
- **Chose:** Existing theme API, default logical system choice, explicit dark/light built-ins; retain plugin/distro theme IDs.
- **Why:** One persisted authority and one event path; a window resolves its own system appearance without making daemon-side guesses.
- **Evidence:** packages/protocol/src/ui.ts:35-70; packages/daemon/src/plugins/ui-service.ts:49-53,160-173; approved redesign scenario5.
- **Reversibility:** medium (public IDs and existing default semantics).
- **Confidence:** high.
- **Revisit if:** remote windows require a shared host-system appearance rather than their own local one.
- **Source:** assumed — autonomous

## D3: Preserve existing terminal overrides and validated custom/Tango behavior
- **Question:** Does the redesign replace existing preference modes?
- **Options:** remove old modes; add a parallel setting; preserve inherit/system/dark/light and palette choices.
- **Chose:** Preserve existing modes, make their default palettes graphite; inherit follows resolved app appearance rather than raw system appearance.
- **Why:** The parent redesign explicitly changes appearance, not feature behavior; existing settings already support persistence and live updates.
- **Evidence:** plugins/quirky.terminal/src/window/pane/settings.ts:7-13,43-50; appearance.ts:19-44; approved parent non-goals.
- **Reversibility:** easy.
- **Confidence:** high.
- **Revisit if:** the parent explicitly authorizes removal of custom/Tango preferences.
- **Source:** assumed — autonomous

## D4: Share resolved appearance through data-theme and central palette data
- **Question:** Which appearance signal prevents independent system guesses and divergent palettes?
- **Options:** luminance heuristic; per-plugin media queries; root data-theme and shared pure palette constants.
- **Chose:** Root data-theme=dark|light, central protocol palette data, public UI DOM adapter.
- **Why:** Declared plugin theme appearance and app pins remain authoritative; every ANSI slot updates together. Lane5 owns styles.css/design-system contracts, not runtime theme behavior.
- **Evidence:** lane5 coordination interjection; packages/ui/src/plugins/useThemeVariables.ts; packages/ui/src/plugins/host.ts:164-169; approved graphite token table.
- **Reversibility:** medium (shared appearance selector).
- **Confidence:** high.
- **Revisit if:** the tokens lane publishes a conflicting selector; coordinate before integration rather than duplicate it.
- **Source:** assumed — autonomous

## D5: Use build-first two-component implementation and minimal verification
- **Question:** Which workflow applies while redesign items run alongside the queued end phase?
- **Options:** full research/spec/review/dogfood pipeline; LOOP build-first combined spec, contracts first, at most3 implementers, typecheck gate.
- **Chose:** LOOP build-first with two disjoint OpenAI task implementers. Cross-family reviewer would be opus via pi-watch, but review/probe dispatch is skipped under the explicit no-review build-first rule, not claimed passed. No test suites run; write acceptance coverage, use minimal browser changed-surface smoke to satisfy coding-agent verification, then typecheck/UI lint.
- **Why:** Authoritative LOOP and item title explicitly select build-first; no human asks, research swarms, or review campaigns.
- **Evidence:** build/roadmap:docs/loop/LOOP.md Build first, test at the end; ui-terminal-theme queue title.
- **Reversibility:** easy.
- **Confidence:** high.
- **Revisit if:** an operator changes the verification phase policy.
- **Source:** locked by docs/loop/LOOP.md

## D6: Keep inherited user metadata and test only isolated state
- **Question:** What should happen to the inherited untracked .serena directory and real user homes?
- **Options:** stash/edit metadata; leave unrelated metadata untouched; use ambient preferences for smoke.
- **Chose:** Leave .serena untouched; fresh HOME/QUIRKY_HOME for any process smoke, no real .quirky/.claude/.codex edits.
- **Why:** Unrelated state belongs to the user; loop test isolation is mandatory.
- **Evidence:** initial git status; LOOP hard rules; prior lane isolation observations.
- **Reversibility:** easy.
- **Confidence:** high.
- **Revisit if:** an explicit task requires that metadata.
- **Source:** locked by docs/loop/LOOP.md

## D7: Use portable browser appearance APIs, with macOS-only verification
- **Question:** Is OS-specific appearance plumbing needed?
- **Options:** native macOS observer; portable matchMedia and root selector.
- **Chose:** Browser media query; Linux/Windows native integration and verification remain unexercised.
- **Why:** Existing terminal paths already expose the browser preference and no native capability is needed for palette changes.
- **Evidence:** plugins/quirky.terminal/src/window/pane/TerminalPaneView.tsx:304-308,841-859.
- **Reversibility:** easy.
- **Confidence:** high.
- **Revisit if:** a supported native shell fails to propagate OS appearance changes.
- **Source:** deferred: platform

## Progress
Claimed after canonical wait returned ui-terminal-theme. Approved parent spec read and slice self-reviewed. Shared contracts/data committed before two implementers; next integrate disjoint app appearance and terminal palette work, minimal surface smoke, typecheck/UI lint, catch up once and land. No test/review campaign passed or claimed.
