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

## D12: Compose concurrent exports and converge on the landed shared menu
- **Question:** the sole roadmap catch-up conflicted in public exports, shared React refs and lint enrollment, and revealed two independently authored ContextMenu implementations
- **Options:** discard another restyle; keep parallel menus/aliases; retain additive exports and migrate to the landed menu authority
- **Chose:** merge7a234811 unions selection-overlay/terminal-theme/editor-print/editor-theme exports, Ref/RefObject contracts and all7plugin lint opt-ins. Retain the landed context-menu implementation/body portal and its enabled/danger/checked field authority; migrate Git constructors, add only required heading/title/icon/detail/badge/group metadata, and remove our duplicate control/CSS. Keep only Popover in floating.tsx and adopt canonical ui-transparent
- **Why:** incoming terminal D2/D8 already establishes the shared searchable menu and overlay boundary. A duplicate export or field-alias converter would violate clean cutover and leave two standards. All6incoming decision logs were read in full, including untruncated Progress; preserve exact-window input/focus, Ask ownership/filtering, mobile grants and reported platform/native limits
- **Evidence:** merge conflicts in package.json/contracts.ts/ui-lint-plugins.json; merged design-system/index.ts duplicate exports; ui-restyle-terminal D2/D8; incoming browser/editor/UI/Ask/mobile decisions
- **Reversibility:** medium (shared presentation contracts)
- **Confidence:** high
- **Revisit if:** canonical menu migration loses an existing Git or terminal interaction
- **Source:** locked by incoming ui-restyle-terminal decisions

## D13: Fence final browser proof with a unique profile and explicit CDP
- **Question:** incoming editor/browser/terminal logs document cross-lane target reuse by the app.path helper
- **Options:** assume a named app.path handle is isolated; stop using it and launch a uniquely owned browser service
- **Chose:** final proof uses named headless Chrome service with private scratch profile, mock-keychain/basic password store and exact CDP56998. Previous handle still reported our exact private origin; release only that own-origin tab without browser kill, then stop further use of path-based targeting. Earlier captures are pre-isolation observations, not the final isolation receipt
- **Why:** own-origin guards prevented observed drift here, but an executable path alone is not cross-lane process/profile ownership evidence. Explicit process/profile/CDP is the safe documented contract
- **Evidence:** incoming ui-restyle-browser D9 and ui-restyle-editor D10/terminal D10; lane2-ui-git-exclusive-chrome PID588/profile chrome-user; explicit-CDP ownOrigin:true
- **Reversibility:** easy
- **Confidence:** high for explicit final ownership; earlier profile/OS credential-store behavior is not independently certified
- **Revisit if:** a browser URL fails the owned-origin guard
- **Source:** locked by incoming browser-isolation decisions

## D14: Reconfigure syntax highlighting when the canonical appearance changes
- **Question:** the settled light-to-dark screenshot retained dark, low-contrast light-theme syntax colors on the dark surface
- **Options:** accept stale engine colors; recreate the editor and lose transient state; reconfigure only the syntax compartment
- **Chose:** use the canonical data-theme appearance before computed-color fallback, and observe its changes through a disposed-with-editor CodeMirror ViewPlugin. Reconfigure only syntax highlighting through a Compartment; retain language, document, selection, notes and editor lifetime
- **Why:** syntaxExtensions previously selected a fixed highlighter once at editor construction. CSS variables updated chrome, but not library syntax rules. This is the theme behavior required by the approved redesign, not a new editor capability
- **Evidence:** initial settled final-dark screenshot15b8831e8f4bd928 showed low-contrast light syntax; plugins/quirky.git/src/view/theme.ts syntaxExtensions; final live-theme runtime receipt follows
- **Reversibility:** easy
- **Confidence:** high for identified source boundary; final actual appearance proof required
- **Revisit if:** actual dark/light toggling fails to update syntax or changes editor data
- **Source:** locked by approved redesign appearance behavior

## D15: Finish with current compiler/build and bounded owned-surface proof
- **Question:** what is verified after the sole catch-up, canonical-menu convergence and live-syntax repair?
- **Options:** reuse older receipts; claim full suites/golden approval; record fresh current gates and explicit limits
- **Chose:** final bun run typecheck plus actual UI build exited0/30.75s, including frozen install/UIlint/root/mobile/prepared-desktop and11host/vendor files25plugin modules. Fresh isolated daemon and uniquely owned CDP browser proved real stage/unstage, body-portal menu clamped at1148..1340 in1340viewport, real note card/Popover with Escape, clean Changes No changes/Open terminal presence, and visible Checks exact-worktree no-origin recovery. Settled screenshots show horizontal All Changes, both appearances and no document overflow. Actual keyword colors changed dark198/120/221 → light119/0/136 → dark again without reload or editor-text change
- **Why:** current source is exercised rather than inferred from earlier builds. Earlier pre-isolation Reviews empty/settings observations remain qualified, not populated-provider acceptance. Authored slot/menu/popover regressions remain unrun under build-first. Minimal fixture lacks quirky.session/list, so nested notes-send runtime acceptance is unproved; no fake fallback or product workaround was added. An immediate Retry read preceded async completion, so no successful Retry generation claim
- **Evidence:** bg12 full gate/build receipt; .quirk/build-loop/ui-restyle-git/proof.json and final-dark.png/final-light.png; actual API/DOM/menu/appearance readbacks; current-origin pageErrors[]/requestFailures[] while prior stopped-origin health refusals remain historical
- **Reversibility:** easy
- **Confidence:** high for exercised paths only; suites, golden85 score, provider/AI, native and foreign-platform acceptance unclaimed
- **Revisit if:** canonical merge-result gate or end-phase/visual owner finds a regression
- **Source:** locked by docs/loop/LOOP.md build-first verification boundary

## D16: Close owned proof resources without killing a shared browser profile
- **Question:** what can be safely stopped after final proof?
- **Options:** kill every observed Chrome PID; preserve shared-path processes and stop only exact owned resources
- **Chose:** release final own-origin explicit-CDP tab, stop uniquely owned Chrome service/profile, and stop all four private daemon scopes. Each daemon exited0 with GIT_UI_SMOKE_CLEANED true. All workers/children/checks returned and all component worktrees were removed. A final process snapshot still showed earlier helper PID83023 using shared .omp/browser-profiles/google-chrome-91d4e3efbae21d18/port56540; leave that shared-profile process untouched after releasing our own-origin tab, rather than risk another lane's browser
- **Why:** an application-path helper is not exclusive process ownership. The final unique chrome-user/CDP56998 service is stopped; no owned fixture daemon, PTY, browser tab or worker remains doing this item's work. Preserve inherited .quirk/.serena and only remove attributed scratch after land
- **Evidence:** explicit browser close; lane2-ui-git-exclusive-chrome stop; all four smoke service receipts, final v4 exit0/cleanup true; exact earlier-PID command snapshot
- **Reversibility:** easy
- **Confidence:** high for named owned resources; no assertion that shared browser processes belong exclusively to this lane
- **Revisit if:** an exclusively owned surviving child is identified by exact process/profile identity
- **Source:** locked by incoming browser-isolation decisions and operator resource directive

## D17: Complete the mandatory failed-land recovery without dropping concurrent contracts
- **Question:** canonical land rejected concurrent shared-field and lint-enrollment conflicts after source2f87ac80
- **Options:** retry unchanged or discard another restyle; follow required recovery and retain additive fields/opt-ins
- **Chose:** required recovery mergea0c1f056 unions RefObject with TextArea/SelectField native attribute imports and retains Ledger scrollBody default behavior plus all12plugin lint opt-ins. Read Accounts completion, Ledger and orchestration logs fully, including raw omitted qualifications. Their exact authority, native, test and browser-isolation limits remain intact
- **Why:** these are additive presentation/type/enforcement changes, not competing feature semantics. This second roadmap merge is required failed-land recovery, not an unsolicited catch-up. No source workaround, linter exception, golden threshold or test deadline changed
- **Evidence:** first canonical land exit1/1.19s; two actual conflict blocks; recovery merge/typecheck/build command exit0/36.07s including UIlint/root/mobile/prepared-desktop and11host/25plugin modules
- **Reversibility:** easy
- **Confidence:** high for the composed gate and fresh minimal surface proof
- **Revisit if:** controller merge-result gate identifies another actual conflict
- **Source:** locked by docs/loop/LOOP.md failed-land recovery procedure

## D18: Bound browser OS-isolation claims and verify the recovery with the testing distribution
- **Question:** incoming Ledger D9 records branded Chrome updater writes despite private HOME/profile
- **Options:** infer full OS isolation from a profile; inspect/restore real Library; use installed Chrome for Testing for final recovery proof and retain uncertainty
- **Chose:** no claim that earlier branded-browser runs independently isolated every macOS OS-directory/updater behavior; no real Library inspection/restoration. Final fresh recovery uses installed Playwright Chrome for Testing, private HOME/TMP/profile, background networking/component updates/breakpad disabled, mock keychain and exact owned CDP60848. Fresh actual Changes/diff rendered in both themes; base Dialog opened and Escape closed it; canonical BODY menu stayed inside1340viewport; browser errors[] and own-origin guard true
- **Why:** renderer correctness and browser OS-side-effect isolation are separate evidence claims. Incoming knowledge requires safer subsequent tooling, not editing user browser state. Earlier proof remains scoped. The recovery browser and fifth fixture daemon are stopped; all owned tabs/workers/checks are finished
- **Evidence:** testing-browser service PID91282 and exact profile/flags; recovery-dark.png/recovery-light.png; actual modal/menu/error readbacks; service stop and daemon exit0/cleanup receipt
- **Reversibility:** easy
- **Confidence:** high for named final owned resources and UI outcomes; earlier OS updater behavior remains uncertified
- **Revisit if:** another branded/native verification tool is proposed
- **Source:** locked by incoming ui-restyle-ledger D9 safety evidence

## Progress
Ready for canonical retry. First land of2f87ac80 failed on concurrent fields/enforcement; required recovery mergea0c1f056 preserves additive native field/ref contracts, scrollBody defaults and all12lint opt-ins. All3new incoming logs fully read. Fresh composed typecheck/UIlint/root/mobile/prepared-desktop plus UI build passed36.07s; fresh private Chrome-for-Testing actual dark/light modal/menu proof passed with errors[] and preserved prior D15limits. All5private fixture daemons, unique browsers, workers and checks have finished; shared-profile helper stays untouched. Commit recovery receipts, detach and retry canonical absolute land immediately; await actual result before removing owned scratch or ending this one item.
