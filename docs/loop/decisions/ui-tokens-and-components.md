# ui-tokens-and-components decisions

## D1: Implement the approved system row, not the area restyles
- **Question:** brainstorming scope, layout, density, empty/error state and interaction gray areas
- **Options:** restyle the whole app now; build the specified reusable system and gallery; add a second UI toolkit
- **Chose:** the reusable system plus interactive both-theme gallery, exact upstream graphite palette, comfortable rows, labeled controls, one-action empty state and visible error/help states
- **Why:** the approved rollout gives shell, terminal and individual restyles separate owners; changing feature behavior here would collide with them
- **Evidence:** docs/quirk/specs/2026-10-28-ui-redesign/logic.md:89-119,168-190
- **Reversibility:** medium (public component props become consumer contracts)
- **Confidence:** high
- **Revisit if:** a named component cannot express an approved area flow
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D2: Enforce all UI source and only explicitly opted-in plugins
- **Question:** lint migration scope after the operator updated the claimed title
- **Options:** fail all existing plugins immediately; exclude historical UI through a violation baseline; fully tokenize UI source and start the enforced plugin list empty
- **Chose:** all packages/ui source, explicit initially empty plugin list, no violation baseline or suppression directives
- **Why:** the operator explicitly prevents un-restyled plugins blocking a land, while packages/ui is always enforced; canonical primitive definitions necessarily introduce raw values but ordinary declarations in those files are still checked
- **Evidence:** canonical queue.ts status called, then authoritative integration docs/loop/queue.json ui-tokens-and-components title read because status is summary-only; operator interjection 2026-10-28
- **Reversibility:** easy (each restyle adds its plugin IDs)
- **Confidence:** high
- **Revisit if:** a restyle needs a legitimate new shared component or semantic token
- **Source:** locked by operator update to ui-tokens-and-components title

## D3: Preserve legacy host geometry with centralized compatibility tokens
- **Question:** grouping, naming, duplicate and exception handling for raw values already in packages/ui
- **Options:** silently exempt existing CSS; change every existing layout to the new spacing scale now; preserve geometry through a central compatibility primitive file while new components use the approved scale
- **Chose:** central compatibility geometry/syntax tokens, semantic color mapping where appropriate, no CSS/pixel literals outside primitive definitions
- **Why:** packages/ui/src/styles.css has 3,811 lines and the new system must not prematurely restyle features or break existing dynamic measurements. Numeric styles with actual pixel semantics are covered, unitless values and measured dimensions remain legal
- **Evidence:** packages/ui/src/styles.css:1-130; packages/ui/src/App.tsx measured widths; item combined spec SC4 and SC6
- **Reversibility:** easy (owning restyles remove obsolete compatibility values)
- **Confidence:** medium
- **Revisit if:** a compatibility value changes appearance or hides a new raw-style violation
- **Source:** assumed — autonomous

## D4: Public package entrypoint and separate static gallery
- **Question:** API/import shape, gallery navigation and demonstration state
- **Options:** application-only relative imports; public React entrypoint plus gallery.html; new daemon gallery methods/window route
- **Chose:** @quirky/ui exports reusable components/types, @quirky/ui/styles.css shared CSS, and an ordinary UI build emits gallery.html showing all fifteen in both themes with local interactive demonstration state
- **Why:** plugins need a real public reuse path; static gallery does not need credentials, a router, daemon side effects or new RPC. Feature state remains daemon owned outside this purely presentational demonstration
- **Evidence:** packages/ui/package.json:1-31; packages/ui/build.ts:13-35,82-83; packages/ui/src/main.tsx:8-23; approved rollout row
- **Reversibility:** medium (import contract)
- **Confidence:** high
- **Revisit if:** a consumer must load the app shell to import a control
- **Source:** assumed — autonomous

## D5: Lane4 owns appearance resolution and terminal adapter
- **Question:** coordination of simultaneously claimed theme and system items
- **Options:** both items edit the theme hook; one item invents new preference RPC; share the existing theme.set API and data-theme selector with non-overlapping ownership
- **Chose:** lane4 owns useThemeVariables.ts, host themeVariablesOf/model protocols, existing Settings picker semantics, terminal-theme.ts and terminal consumers. This item owns styles.css, SettingsDialog style literals only, shared component tokens and package exports including ./terminal-theme -> ./src/terminal-theme.ts. Canonical document root data-theme is dark/light; local gallery scopes use the same attribute
- **Why:** default theme id follows system, explicit built-in dark/light IDs use existing theme.set; custom/Tango and terminal overrides retain existing behavior. No duplicate theme preference or ANSI data
- **Evidence:** lane4 operator coordination messages 2026-10-28; packages/ui/src/plugins/useThemeVariables.ts; packages/protocol/src/ui.ts current public token contract
- **Reversibility:** medium (cross-item seam)
- **Confidence:** high
- **Revisit if:** exact semantic values cannot be represented through the shared selector/variables
- **Source:** locked by lane4 ownership agreement

## D6: Build-first execution uses three disjoint implementers and one typecheck gate
- **Question:** execution skill preflight, research/review/testing and worktree choices
- **Options:** standard research/spec/review rounds; follow build-first override with combined spec/contracts and focused smoke
- **Chose:** one combined logic/technical spec, contracts committed before at most three OpenAI task implementers, isolated external worktrees, no worker checks/commits, one barrier and source-scope attribution audit before integration. No reviewer dispatched or backend claimed reachable because build-first forbids review rounds. Existing inherited .serena remains untouched. Parent runs typecheck and focused genuine runtime smoke required by the coding contract; suites/full dogfood remain unrun
- **Why:** authoritative LOOP Build first rules override the normal skill process. Scratch/worktrees live under /tmp/quirky-ui-lane5-QDaFyn5r, outside repo state. No human asks; recommended defaults answer all gray areas
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md Build first, test at the end; skills brainstorming/writing-specs/subagent-driven-development; LSP status returned no configured servers
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** typecheck or actual surface smoke shows a contract error
- **Source:** locked by docs/loop/LOOP.md

## D7: Accept only the audited three-component source at the all-worker barrier
- **Question:** execution attribution and shared-file integration
- **Options:** trust worker summaries; audit all returned trees and the integration parent before committing
- **Chose:** all three returned at c4961ba565f6a51eab5e995a2144b9979f521486; exact changed paths matched their packet scopes, parent had no tracked delta and only inherited .serena. Committed components b5214151, gallery c2bffb42 and lint4793197f, then merged together. All three worktrees removed after path-only stashes preserved their inherited .serena copies; original parent metadata untouched
- **Why:** absolute assigned prefixes and a real barrier avoided the cross-worktree contamination seen in earlier iterations
- **Evidence:** tool-observed four HEAD values and four status inventories; component commit/merge output; worktree remove commands exited0
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** source attribution evidence contradicts a packet scope
- **Source:** assumed — autonomous

## D8: Fix scanner sibling traversal and theme-scope text inheritance from observed evidence
- **Question:** which integration defects require source changes
- **Options:** weaken lint/typecheck or ignore the visual; repair the underlying cursor and theme inheritance
- **Chose:** recursive CSS scanning returns the cursor after its closing brace and resumes through sibling/nested rules; retain a regression case with four exact downstream diagnostics. Every theme scope declares its text color from its own --ui-text so a light scope does not inherit resolved dark text. Toast expiration also keeps its original deadline across changing callback identities, with latest callback semantics, and the gallery preserves action versus dismissal outcomes
- **Why:** first typecheck reported void-to-number at scanner lines306/322, exposing the lost recursive cursor. Initial actual gallery screenshot showed near-white unstyled heading/prose on white despite correct token values. Callback-identity timer resets and action-output overwrites were direct integration invariants, not extra feature scope
- **Evidence:** first typecheck exit2; repaired typecheck exit0/28.87s root+mobile+desktop+UI lint; focused nested/sibling scanner output four exact rules/lines; screenshots15b85a92eff3712f before and15b85acd59737130 after, actual heading rgb236/238/242 dark and27/29/34 light
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** end-phase behavioral tests find an uncovered style context or focus/timer transition
- **Source:** assumed — autonomous

## D9: Record focused runtime proof without claiming suites or automated visual review
- **Question:** what verification actually ran under build-first
- **Options:** report only typecheck; run prohibited campaigns; focused production-path smoke and exact limits
- **Chose:** UI build emitted11 host/vendor files and25 plugin modules; actual gallery served through production serveStatic and driven in an isolated owned browser tab. Both themes rendered all15 categories with all10 exact semantic palette values. Real button, input, keyboard tabs/disabled skip, menu activation, toast action+dismissal, dialog focus/trap/Escape/restoration, sheet, empty-state, panel and agent-card transitions passed. Browser error list empty. Final fresh screenshot15b85afdbd337131 shows both live toasts/all categories, correct light prose and no horizontal overflow. Production lint fixture smoke proved empty-list exclusion, opted-in raw color/pixels, CSS file/import denial, canonical primitive-only exemption, exact diagnostics, invalid config, and restored shared-component acceptance; fixture directory removed
- **Why:** genuine changed-path runtime proof satisfies the coding contract while suites/review/full dogfood remain the end phase's work. Static linter intentionally does not evaluate arbitrary runtime computations or trace imported style maps; no security-sandbox claim
- **Evidence:** production UI build exit0 twice; lint-smoke.ts exit0/scenarios11 and fixtureRemoved:true; nested CSS smoke exit0; browser smoke final both-theme passed:true, error entries[], final visual screenshot metadata
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** end-phase tests or screenshot-review owner find a regression
- **Source:** assumed — autonomous

## D10: Compose landed theme exports and admit only the canonical shared stylesheet
- **Question:** final roadmap catch-up and plugin stylesheet reuse
- **Options:** trust an automatic JSON merge; discard the terminal subpath; preserve one complete export map and permit the shared CSS entrypoint
- **Chose:** sole roadmap catch-up brought ui-terminal-theme; read all D1–D10 and full Progress, no decision conflict. Git merged two exports keys without a textual conflict, making the latter hide the public component entrypoint; typecheck caught module resolution errors. Removed only the duplicate key while preserving root, styles.css and terminal-theme entries. Opted-in plugins may import @quirky/ui/styles.css (static/dynamic/require), never private plugin CSS
- **Why:** shared stylesheet reuse is the approved design, not plugin-owned CSS. Duplicate JSON keys are a semantic merge defect even when Git reports no conflict
- **Evidence:** caught-up typecheck initially exit2/module-not-found; corrected public export readback; final frozen-install/UIlint/root/mobile/desktop typing exit0/27.58s; caught-up UI build11 files/25 plugin modules exit0; direct shared/private CSS admission smoke exit0 with one exact private-import diagnostic
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a later restyle needs another public central style entry
- **Source:** assumed — autonomous

## Progress
Ready to land. All implementation source and acceptance tests committed; suites/review/full dogfood UNRUN under build-first. Exact focused runtime evidence is D8–D10. Sole roadmap catch-up completed and incoming theme decisions read; final typecheck including UIlint/root/mobile/desktop passed, composed exports readback preserved all three entries. Owned gallery tab closed, production-static smoke server stopped, all implementers returned, all component worktrees removed with inherited metadata preserved; parent .serena untouched. Next: commit this final checkpoint, detach, canonical absolute queue.ts land ui-tokens-and-components, await success, remove owned scratch and end exactly this iteration.
