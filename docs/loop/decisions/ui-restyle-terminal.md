# ui-restyle-terminal decisions

## D1: Preserve all terminal behavior and existing contribution destinations
- **Question:** brainstorming purpose, consumers, scope, layout and interaction gray areas
- **Options:** redesign terminal behavior; restyle only visible center pane; cover both plugins' desktop surfaces while preserving feature contracts
- **Chose:** all desktop surfaces of quirky.terminal and quirky.terminal-dock; existing center views, bottom-left tools and floating renderer overlay unchanged
- **Why:** the approved parent explicitly excludes new features, phone UI and shortcut changes; the claimed item names both plugins
- **Evidence:** docs/quirk/specs/2026-10-28-ui-redesign/logic.md:23-59,83-119,176,192-202; ui-shell-slots D1,D3,D5
- **Reversibility:** medium (presentation only; feature APIs preserved)
- **Confidence:** high
- **Revisit if:** an existing flow becomes inaccessible in the shared rendering
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D2: Shared controls and semantic tokens replace injected plugin CSS
- **Question:** layout density, loading, empty, error and component-gap gray areas
- **Options:** tokenize injected CSS; simplify interactions to basic components; central shared terminal layout and reusable advanced variants
- **Chose:** shared controls and host-owned semantic-token layout; promote existing rich searchable/nested menu behavior into shared ContextMenu/ContextMenuList; remove obsolete plugin style injectors and local menu implementation, migrate callers
- **Why:** lint forbids plugin CSS even when tokenized; simplifying submenus, rich tabs or composer input would violate behavior preservation. Existing FormRow can own raw native select/textarea/checkbox controls with shared field styling
- **Evidence:** scripts/ui-lint.ts rules and source traversal; shared design-system contracts; terminal Menu.tsx; approved parent:85,117-119
- **Reversibility:** medium (shared menu prop contract)
- **Confidence:** high
- **Revisit if:** another area requires incompatible menu semantics
- **Source:** assumed — autonomous

## D3: Keep terminal-theme and runtime geometry authorities intact
- **Question:** dark/light precedence, sizes and platform boundaries
- **Options:** rewrite xterm preferences; freeze terminal geometry to token sizes; retain theme adapter and measured/persisted geometry
- **Chose:** retain terminal custom/Tango/system/inherit settings and existing appearance adapter; tokenize static chrome dimensions only; preserve measured/persisted pane and composer geometry
- **Why:** earlier theme decisions bind this item; geometry/PTY changes are not a visual restyle
- **Evidence:** ui-terminal-theme D2–D4,D8; DockHost.tsx and workspace GroupView.tsx runtime rectangle styles
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the actual restyled surface exposes a measured layout regression
- **Source:** locked by docs/loop/decisions/ui-terminal-theme.md

## D4: Use one combined spec and three disjoint OpenAI implementation components
- **Question:** execution skill research, spec, backend, testing and review preflight
- **Options:** normal full research/review/suite campaign; explicit build-first item policy
- **Chose:** combined logic/technical spec and shared menu types committed first; at most three OpenAI task implementers in isolated external worktrees, no worker checks or commits, all-writer attribution barrier. No reviewer alias probing or review dispatched; normal omp cross-family choice would be opus, not claimed reachable. Parent runs canonical UI lint/typecheck/build and minimum actual changed-surface browser smoke, no suites or screenshot scoring campaign
- **Why:** item title explicitly applies build-first; LOOP.md forbids suite/review/dogfood campaigns during this mode. Higher coding contract still requires actual changed-surface proof. No human asks or research swarm; parent approved design and four dependency decision logs are the research
- **Evidence:** authoritative git show build/roadmap:docs/loop/LOOP.md; claimed queue title; read skills brainstorming/writing-specs/writing-plans/subagent-driven-development/TDD; lsp status no configured servers
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** operator changes this item's build-first gate
- **Source:** locked by docs/loop/LOOP.md

## D5: Leave inherited metadata untouched and isolate every runtime
- **Question:** dirty-tree handling and test state ownership
- **Options:** stash inherited .serena; edit ambient user homes; preserve unrelated metadata and use private homes
- **Chose:** leave inherited untracked .serena unchanged; external owned worktrees/scratch and fresh HOME/QUIRKY_HOME for smoke; close owned browser/runtime and remove owned scratch after land
- **Why:** unrelated changes belong to the user and LOOP forbids real-state testing
- **Evidence:** initial git status --short --branch; LOOP hard rules; lane notes operator rule requires all future tests through remote bun scripts/suite.ts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a needed capability is unavailable in isolated state
- **Source:** locked by docs/loop/LOOP.md

## D6: Keep native and other-platform acceptance unclaimed
- **Question:** which platform verification is supported by the implementation environment
- **Options:** infer all-platform/native success; portable CSS/browser APIs with macOS-only web smoke
- **Chose:** macOS build and an owned Chromium actual app surface only; Linux/Windows/native-host focus, resize and system appearance still need platform acceptance
- **Why:** no native changes are requested; LOOP locks macOS-only build/testing
- **Evidence:** LOOP platform rule; approved parent desktop-only scope
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** supported build/test platforms expand
- **Source:** deferred: platform

## Progress
Design/spec and public advanced-menu types ready for contracts commit. Three disjoint source slices follow: workspace/floating plus shared context-menu/layout; sessions/quick commands/pane accessories/shortcut/emulator plus shared tool CSS; dock composer/settings plus shared dock CSS. Parent owns shared stylesheet cutover/imports, lint opt-in, typecheck and minimal real browser proof. No tests, scoring review, full dogfood or native acceptance has run.
