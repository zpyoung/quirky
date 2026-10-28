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

## Progress
Claimed lane5; approved upstream spec and source seams read, combined slice spec self-reviewed, prop contracts written before implementers. Next: commit contracts/spec, dispatch components/tokens, gallery and lint+legacy-tokenization as disjoint source owners; integrate, typecheck, focused runtime proof, catch up once/read incoming decisions and land.
