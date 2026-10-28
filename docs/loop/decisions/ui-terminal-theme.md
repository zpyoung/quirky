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

## D8: Preserve the existing theme API while superseding the old default palette
- **Question:** How does the approved redesign compose with earlier UI API decisions?
- **Options:** replace theme APIs; retain persistence/events and change built-in appearance data.
- **Chose:** Keep m0-ui-api D20's theme.list/theme.set, chosen-theme retention and live updates; the approved redesign supersedes the historical m0 tech spec's Quirky Dark default color literals. The logical default's reported appearance is the dark fallback; a window resolves system appearance locally.
- **Why:** Plugin/distro selection and missing-theme fallback remain intact; the approved graphite/system-following requirement changes only built-in appearance.
- **Evidence:** docs/loop/decisions/m0-ui-api.md D19–D20; docs/quirk/specs/2026-10-26-m0-ui-api/tech.md historical theme contract; approved redesign lines91–115.
- **Reversibility:** medium.
- **Confidence:** high.
- **Revisit if:** the API needs per-window resolved appearance reporting rather than a logical chosen-theme list.
- **Source:** supersedes m0-ui-api D19

## D9: Run only the published UI lint gate, never a substitute scanner
- **Question:** Is landing blocked by the independent tokens lane's unfinished UI lint implementation?
- **Options:** invent a temporary lint rule; wait for an unrelated lane; run the canonical gate when available.
- **Chose:** Run `bun scripts/ui-lint.ts` if the final roadmap merge publishes it; otherwise land terminal-only source without claiming lint passed. Lane5 explicitly directed not to wait for its unlanded gate. Its initial plugin enforcement list is empty; packages/ui is enforced.
- **Why:** The gate's implementation belongs to ui-tokens-and-components. A second scanner would diverge and its absence is not an unbuilt terminal flow.
- **Evidence:** lane5 coordination interjection: contracts c4961ba5, fixed command and scripts/ui-lint-plugins.json=[], scanner not yet runnable, no passing claim; explicit instruction not to wait.
- **Reversibility:** easy.
- **Confidence:** high.
- **Revisit if:** the canonical gate lands before this item and reports a violation in this source.
- **Source:** assumed — autonomous

## D10: Minimal live surface proof, not an end-phase campaign
- **Question:** Which verification was actually exercised?
- **Options:** claim complete suite/review coverage; record only observed commands and browser transitions.
- **Chose:** Record the exact minimal proof. `bun run typecheck` passed root, mobile and desktop; `bun packages/ui/build.ts` built the actual window and25 plugin UI modules. Fresh isolated HOME/QUIRKY_HOME real daemon+PTY smoke used hooks=false before startup. Source CLI listed built-ins, set light/readback, reset default. The actual browser Settings dialog saved app dark under light system preference, then terminal-only light while shell stayed dark. Reset via daemon API and system light→dark updated the same xterm DOM instance; colored real shell output stayed visible. No browser errors observed. Browser closed and owned daemon/PTY cleanup finished with service exit0.
- **Why:** This proves the changed surface minimally without running prohibited suites, review rounds or a full dogfood campaign. Initial smoke-host URL used an absent runtime.host field; browser used loopback and actual runtime.port. Initial emulation used an unsupported nested option; corrected to colorScheme. The first Save selector hit an unrelated plugin button; the owning .dialog-actions submit saved successfully. These were fixture/driver mistakes, not production fixes.
- **Evidence:** initial typecheck exit0/27.44s; final post-catch-up root+mobile+desktop typecheck exit0/26.99s; UI build output; terminal-theme-smoke readiness and exit0; actual screenshot captures light, dark pin and terminal-light/shell-dark; actual theme.list and setting.get readbacks.
- **Reversibility:** easy.
- **Confidence:** high.
- **Revisit if:** end-phase tests or the canonical screenshot review find a regression. All acceptance tests were authored, not run; no full-suite/native/system-OS-cycle/review claim.
- **Source:** assumed — autonomous

## Progress
Ready to land. Both disjoint components audited and merged: AppTheme1a6e6f37 and TerminalPaletted7b9c4a2; component worktrees removed. Acceptance tests authored, obsolete palette/wording/order copies removed rather than repinned. Public README/API descriptions updated. One roadmap catch-up brought only queue state changes, no incoming decision logs or source conflicts. Final root+mobile+desktop typecheck passed26.99s after that merge. Canonical scripts/ui-lint.ts is not yet published (exact path lookup returned absent); per explicit lane5 direction/D9, no substitute scanner or lint passing claim. Minimal real browser+daemon/PTY proof and cleanup observed (D10). Next: commit this checkpoint, detach and canonical queue land. No follow-up needed; every scoped flow implemented. No suites or review/dogfood campaign run.
