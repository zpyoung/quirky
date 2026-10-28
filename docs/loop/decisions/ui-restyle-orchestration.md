# ui-restyle-orchestration decisions

## D1: Restyle all four desktop plugin surfaces without changing workflow authority
- **Question:** brainstorming purpose, layout, density, interaction and coverage defaults
- **Options:** cosmetic legacy-class patch; rebuild workflows; migrate every existing renderer contribution onto shared controls
- **Chose:** shared-component migration of orchestration, Heimdall, handoff and loops, including settings, overlays and secondary views; preserve IDs, default host slots, state machines, APIs and CLI
- **Why:** the approved redesign changes appearance and location, not feature behavior; shared controls avoid continuing visual divergence
- **Evidence:** docs/quirk/specs/2026-10-28-ui-redesign/logic.md:23-59,83-119,182,192-202; OrchestrationUiMap source map
- **Reversibility:** medium (visible composition)
- **Confidence:** high
- **Revisit if:** an existing flow cannot be expressed by the public shared components
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D2: Preserve pending, empty, failure, draft and safety behavior
- **Question:** brainstorming loading-pattern, empty-state, error-state and interaction gray areas
- **Options:** hide sparse/error states; invent new retry behavior; retain canonical transitions using shared feedback and controls
- **Chose:** preserve current read/request ownership, displayed failures, retries, draft values, approval/close/delete confirmations and exact record targets; shared semantic statuses and concise empty states
- **Why:** presentation must not launch, cancel, approve or discard anything implicitly; these plugins operate supervised agents and long-running loops
- **Evidence:** item logic SC1–SC4; plugins/quirky.handoff/src/window/model.ts; plugins/quirky.loops/src/ui.tsx closeChoiceCommand; plugins/quirky.orchestration/src/ui.tsx request guard
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** narrow runtime proof or end-phase tests demonstrate changed control semantics
- **Source:** assumed — autonomous

## D3: Reuse the canonical theme, component and lint authorities
- **Question:** implementation choices, theming, grouping and exception defaults
- **Options:** plugin-local styles; second toolkit; existing @quirky/ui components/tokens and canonical opt-in list
- **Chose:** public @quirky/ui imports, existing data-theme authority, all four IDs in scripts/ui-lint-plugins.json; remove obsolete local styles rather than exempting them
- **Why:** the approved system is mandatory and binding prior decisions prohibit baselines and duplicate theme state
- **Evidence:** ui-tokens-and-components D2/D4/D10; ui-terminal-theme D4; ui-shell-slots D3/D6
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a missing shared visual primitive requires an explicit shared-package addition
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D4: Use build-first combined spec and three isolated implementation components
- **Question:** execution workflow, backend pairing, research, review and verification
- **Options:** full skill research/review/suite campaigns; explicit item build-first override
- **Chose:** one combined logic/technical spec and committed unchanged shared API boundary; three OpenAI task implementers in external worktrees, no worker checks or commits. Parent audits all paths at the barrier, integrates, runs lint/typecheck/build and minimum real changed-surface smoke. No reviewer/probes, suites, screenshot scoring or full dogfood claimed
- **Why:** authoritative LOOP and exact queue title explicitly select build-first; no human decisions are requested. Existing .serena is unrelated user metadata and stays untouched
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md Build first section; item title; LSP status returned no configured servers
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the operator changes this item's verification policy
- **Source:** locked by docs/loop/LOOP.md

## D5: Verify on this Mac with wholly private runtime state
- **Question:** platform and process safety constraints
- **Options:** ambient user home/browser; private owned daemon and Chromium
- **Chose:** disposable HOME/QUIRKY_HOME/provider/XDG environment and owned-process scope; dedicated Chromium/CDP to avoid cross-lane target reuse. Linux/Windows and real native window acceptance remain unexercised
- **Why:** tests/smoke may not touch real user state and only macOS build is authorized
- **Evidence:** LOOP hard rules and platform policy; ui-restyle-terminal D13/iteration14 browser ownership observations
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** supported platform scope changes
- **Source:** deferred: platform

## D6: Add missing native fields and editor appearance once in the shared system
- **Question:** all three implementers identified multiline/select controls absent from public input-only TextField; handoff also injects its own CodeMirror theme
- **Options:** local native-styled controls/CSS; discard functional editor; add minimal shared primitives and scoped shared editor styles
- **Chose:** public TextArea and SelectField with native form/label/help/error semantics, shared wrapping readout/option-list utilities, central CodeMirror/secret-highlight token bridge. Existing functional editor and composed combobox retain their model behavior
- **Why:** every named plugin needs these controls; adding them once avoids four bespoke controls and preserves secret markers/editing. No CodeMirror dependency or state machine is added to the shared components
- **Evidence:** RestyleFleet/RestyleHandoff/RestyleLoops handoffs; plugins/quirky.handoff/src/window/PreviewEditor.tsx:28-39; packages/ui/src/design-system/contracts.ts:10
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** real browser proof exposes native form/selection/secret-mark regressions
- **Source:** assumed — autonomous

## Progress
Spec and shared unchanged API/type boundary recorded before worker dispatch. Planned disjoint components: orchestration+Heimdall, handoff, loops. Parent owns shared package integration if needed, lint opt-in, generated lock, docs and verification. No tests/review/dogfood run. Next commit contracts/spec, create three external worktrees, dispatch implementers, then barrier audit/integrate/typecheck/minimum live smoke, one roadmap catch-up and canonical land.
