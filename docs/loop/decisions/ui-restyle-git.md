# ui-restyle-git decisions

## D1: Apply the approved graphite contract without changing features
- **Question:** purpose, scope, layout style, density, interaction and essential-coverage questions from brainstorming
- **Options:** CSS-only recolor; new feature UI; full shared-component migration preserving existing behavior
- **Chose:** existing shared components/tokens across all Git and Reviews surfaces, comfortable density, original state/actions/labels and host routing
- **Why:** the approved redesign explicitly excludes new behavior and shortcuts and forbids private plugin CSS
- **Evidence:** docs/quirk/specs/2026-10-28-ui-redesign/logic.md:23-59,83-119,192-227
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a required existing flow cannot be expressed with the shared system
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D2: Restyle the review-owned Checks panel, not a new runner surface
- **Question:** grouping, duplicate handling and API/data-mapping gray areas
- **Options:** add a quirky.checks UI; move Checks ownership; preserve the existing review-owned tool and backend-only runner
- **Chose:** preserve panel:quirky.reviews/checks and existing Git/Reviews IDs/right-top defaults; enroll quirky.checks in lint without inventing a UI
- **Why:** the standalone runner exposes daemon/CLI only; creating another panel changes behavior
- **Evidence:** plugins/quirky.checks/quirky-plugin.json; plugins/quirky.reviews/src/ui.tsx; packages/daemon/src/plugins/tool-layout.ts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the runner acquires a genuine separate UI requirement
- **Source:** assumed — autonomous

## D3: Preserve lifecycle and recovery while using shared empty/error/form controls
- **Question:** loading, empty, error, selection, confirmation and accessibility gray areas
- **Options:** remove dense controls to match a mockup; preserve flows while replacing presentation
- **Chose:** preserve all existing actions, worktree draft/notice ownership and view inputs; shared rows/buttons/forms/dialogs/status and readable errors; clean Changes uses No changes/Open terminal
- **Why:** a restyle cannot discard feature capabilities; parent scenario6 fixes the clean-state copy
- **Evidence:** approved parent:149-164; plugins/quirky.git/src/SourceControl.tsx; panel/WorktreePanel.tsx; quirky.reviews/src/ui.tsx
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** actual changed-surface smoke exposes inaccessible or lost controls
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D4: Reuse existing public contracts and split three disjoint implementation scopes
- **Question:** build execution, contracts, file coupling and task granularity
- **Options:** one monolithic worker; three independent plugin-source slices; a shared new toolkit
- **Chose:** commit combined logic/tech contract first; three OpenAI task implementers for Git panel/notes, Git views/AI and Reviews/Checks in external worktrees. Parent owns lint enrollment and integration. No new type/schema/API signatures required
- **Why:** these source sets are disjoint and already communicate through existing props/public APIs; shared components suffice for controls and forms
- **Evidence:** docs/quirk/specs/2026-10-28-ui-restyle-git/logic.md Technical contracts; packages/ui/src/design-system/contracts.ts/index.ts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a worker identifies a genuine shared component gap
- **Source:** assumed — autonomous

## D5: Follow build-first gates and preserve inherited metadata
- **Question:** unattended skill preflight, testing, spec review, backend pairing and dirty-tree action
- **Options:** standard swarms/reviews/suites; build-first combined spec and typecheck plus minimal actual smoke
- **Chose:** no asks, research swarms, formal review rounds or test suites. At most three task implementers; no reviewer backend claimed/probed because none dispatched. Existing .quirk/.serena stay untouched; workers write only absolute assigned paths. Parent runs typecheck and bounded actual web smoke
- **Why:** authoritative LOOP and item title explicitly use build-first; runtime proof satisfies the coding contract without a full campaign. LSP status returned no configured servers
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md Build first; canonical queue wait item title; xd://lsp status
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** authoritative process changes this item's gate
- **Source:** locked by docs/loop/LOOP.md

## D6: Keep state isolated and platform claims macOS-only
- **Question:** integration safety and platform behavior
- **Options:** real user repositories/accounts; temporary homes and fixtures only
- **Chose:** fresh private HOME/QUIRKY_HOME, local Git fixtures, owned browser and process cleanup; no account activation, provider credentials, real OS notifications or native window proof. Linux/Windows UI engine/control behavior still requires platform acceptance
- **Why:** LOOP forbids tests touching real state and locks builds to macOS
- **Evidence:** docs/loop/LOOP.md Hard rules/What is already decided; ui-screenshot-review D5/D7
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** platform scope expands
- **Source:** deferred: platform

## Progress
Design/source mapping complete. Combined scoped logic/technical contract ready to commit before implementer dispatch. Next: three disjoint source components, barrier audit/integration and lint enrollment; bounded actual UI smoke and typecheck; one roadmap catch-up with incoming decisions read; canonical land.
