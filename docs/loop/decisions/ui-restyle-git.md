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

## D7: Fill shared-system gaps rather than dropping existing behavior
- **Question:** implementers found flat Menu cannot express context submenus/metadata or checkbox toggles, Dialog cannot express nonmodal note preview, and plugins lack a shared CodeMirror adapter
- **Options:** remove interactions; keep local custom controls/CSS; extend shared Menu/dialog families and publish a generic editor adapter
- **Chose:** ContextMenu/ContextMenuItem, optional MenuItem.checked, nonmodal anchored Popover and @quirky/ui/editor-theme editorTheme with generic conflict decorations. Remove local PopupMenu and shellTheme after callers migrate, no aliases. Persistent notices may use Toast duration0 with caller-owned action controls where auto-dismiss would change behavior
- **Why:** approved design requires shared coverage when the fifteen component families cannot express existing flows; no plugin CSS exemption is needed
- **Evidence:** plugins/quirky.git/src/panel/Menu.tsx; src/notes/NotesPreview.tsx; src/view/theme.ts; worker gap reports; packages/ui/src/design-system/contracts.ts
- **Reversibility:** medium (additive public presentation APIs)
- **Confidence:** high
- **Revisit if:** actual smoke or acceptance tests find viewport/focus/engine-theme regressions
- **Source:** assumed — autonomous

## D8: Integrate only the audited source slices at the all-worker barrier
- **Question:** worker attribution, test ownership and concurrency
- **Options:** trust completion messages; audit returned paths/HEADs and explicitly reconcile remaining consumers
- **Chose:** all three worktrees stayed at 7b6fbb30762c5e25bc728d7629bbd0cdab9f5865; tracked path sets were disjoint and parent held only its declared shared edits. Commits beae996b/4de15ab4/7db1f87e were merged and component worktrees removed immediately. Parent migrated remaining conflict-window selectors and portal-scoped notes assertions; removed incidental note-spacing/dialog-copy assertions rather than repinning them
- **Why:** actual source, not reports, determines attribution. Views' attempted conflict-selector edit was rejected; its earlier completion claim did not close that consumer
- **Evidence:** all-worker HEAD/status inventory artifact11; integration command outputs; plugins/quirky.git/test/window/conflicts.test.ts and test/ui/notes-view.test.ts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a remaining consumer still relies on old presentation selectors
- **Source:** assumed — autonomous

## D9: Record the nested-dispatch deviation rather than claiming strict cap compliance
- **Question:** Views spawned another implementer after receiving a three-slice task
- **Options:** conceal the nested process; stop all work; bound further dispatch and retain disjoint ownership
- **Chose:** parent forbade further nested implementers; the already-started disjoint AI child finished, both nested children returned before the outer task, and no writes overlapped. Strict three-implementer-process concurrency compliance is not claimed
- **Why:** source scopes remained isolated, but the initial worker's nested dispatch exceeded the intended item-wide process cap; source correctness does not erase that process deviation
- **Evidence:** RestyleGitViews.MapGitViewsAi and RestyleGitViews.RestyleGitAI completion receipts; parent messages; scratch journal
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** subsequent dispatches fail to respect the item-wide cap
- **Source:** assumed — autonomous

## D10: Repair actual build/compiler and renderer boundaries without weakening enforcement
- **Question:** final integration gate and actual surface smoke exposed failures
- **Options:** suppress diagnostics/skip surfaces; fix the owners of the broken boundaries
- **Chose:** declare @quirky/ui workspace dependencies in both plugins and update bun.lock; use ui.[ext] entry naming so extracted shared CSS cannot collide with ui.js; retain canonical transparency token instead of raw transparent; restore lost span/openState/test helper identifiers and correct helper argument order/nullability. Keep Badge tooltip on a semantic wrapper. Use valid observer rootMargin 100% 0%, not CSS's unitless-zero spelling. Wrap long GitHub status text instead of putting it inside a nowrap badge. Shared section headers wrap actions without crushing their title
- **Why:** production build rejected missing package imports then identical JS/CSS output names; lint rejected14 raw-color literals; tsc identified lost identifiers and one unsupported Badge prop; actual browser threw the observer SyntaxError and showed clipped status text/vertical toolbar title
- **Evidence:** build/typecheck artifacts14/18 and subsequent command outputs; initial actual browser screenshots/errors; packages/ui/build.ts; Git CombinedDiff.tsx/GitHubReview.tsx; shared editor-theme.ts/components.css
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** final caught-up typecheck or actual renderer exposes another boundary
- **Source:** assumed — autonomous

## D11: Use six-slot ownership for Checks visibility and respect genuine document visibility
- **Question:** Checks mount/polling still read obsolete layout.panel during the tool-slot cutover
- **Options:** retain legacy panel authority; force polling while hidden; read canonical tools.open plus document visibility
- **Chose:** both Checks mount refresh and polling visibility read all six canonical open slots, preserving hidden-document pause. Author a mounted daemon/API regression for initial right-top open with panel:null, move to bottom-left, replacement and close. No legacy panel fallback
- **Why:** ui.tool.open can change tool visibility independently of legacy panel. Initial smoke's unrefreshed Checks was also a genuinely hidden document, so that observation alone did not prove the old panel predicate caused it. An explicitly headless owned browser with a visible page established the proper precondition and refreshed actual state to the expected no-origin error
- **Evidence:** ChecksPanel.tsx:783,840; authored review-link-ui.test.tsx regression; actual document.visibilityState and public ui.state/reviews.state observations; final headless Checks screenshot
- **Reversibility:** medium (visibility/polling ownership)
- **Confidence:** high
- **Revisit if:** moved/hidden slot acceptance contradicts the canonical open-tool projection
- **Source:** assumed — autonomous

## Progress
All three source components and two compiler fixers returned; all component worktrees removed. Full pre-catch-up typecheck (UIlint/root/mobile/prepared-desktop) passed once; later slot regression/header wrapping and removal of1500obsolete Git CSS lines await the final caught-up gate. Actual isolated macOS renderer exercised stage/unstage, commit eligibility, context menu, base dialog, notes preview/Escape, diff rendering, dark/light, Reviews empty/settings and visible Checks no-origin recovery. Fixture declarations include genuine Browser settings without activating native/browser/provider code; no real accounts/homes or native-window proof. No suites, formal/golden review, populated provider review flow or native run is claimed. Next commit, sole roadmap catch-up/read incoming decisions, final gate and focused reload, canonical land.
