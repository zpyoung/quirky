# ui-restyle-worktrees decisions

## D1: Restyle the existing Worktrees UI owner, not a new repository tool
- **Question:** brainstorming purpose, consumers, scope and default placement
- **Options:** CSS repaint; new repo panel; in-place shared-component migration
- **Chose:** in-place migration, existing Worktrees left-top tool and repo APIs
- **Why:** repo has no UI bundle; all repository operations render under Worktrees. A second tool changes approved behavior and duplicates authority.
- **Evidence:** plugins/quirky.worktree/src/ui.tsx; quirky.repo manifest; ui-shell-slots D1/D3/D6; approved redesign lines23–59,194–202
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** an actual repository contribution is introduced
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D2: Keep comfortable name-plus-activity rows and preserve rich tree behavior
- **Question:** layout-style and information-density: row form, metadata priority, narrowing, grouping and activity source
- **Options:** flat single-line tree; expansive cards; shared two-line rows with secondary controls
- **Chose:** comfortable name/activity rows, canonical session activity/idle, shared status/count; retain nesting, groups, metadata, contextual actions and drag/reorder
- **Why:** parent explicitly requires name plus activity; presentation migration cannot remove shipped organization flows
- **Evidence:** approved redesign lines61–75; m1-worktrees D30–D35; Tree.tsx; useWorktreeAttention.ts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual narrow-panel smoke clips required actions
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D3: Use shared explicit empty/loading/error/form states
- **Question:** selected gray areas: loading pattern, empty state, error state and disabled actions
- **Options:** local decorative panels; hide absent/error data; shared components with preserved retry/cancel/error behavior
- **Chose:** shared components and tokens, Add project empty action, readable real loading/error states, unchanged cancel/trust/destructive semantics
- **Why:** approved design forbids bespoke plugin CSS and feature-behavior changes
- **Evidence:** parent lines83–119,149–164,194–202; shared design-system contracts.ts; existing dialog callbacks
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** shared components cannot represent an existing safety boundary
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D4: Preserve custom identity data while using semantic presentation colors
- **Question:** visual identity and theme behavior: status/project stored colors versus approved fixed palette
- **Options:** remove stored color feature; paint arbitrary values; retain editable identity data and render semantic token accents
- **Chose:** retain labels, icons/emoji, stored values and settings; use shared token colors for visual chrome/status semantics
- **Why:** avoids data loss while honoring the newer approved no-custom-themes/no-raw-colors presentation contract
- **Evidence:** Tree.tsx dynamic identity/status colors; StatusSettingsDialog.tsx; parent lines67–75,85,198–200
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** approved final review explicitly asks to render arbitrary identity colors
- **Source:** assumed — autonomous

## D5: Preserve host framing and existing interaction authority
- **Question:** interaction-style: panel frame, low-frequency options, menus, dialogs and focus
- **Options:** second nested frame; global buttons; existing host frame and shared in-panel controls
- **Chose:** existing frame/IDs/default slot, collapsible low-frequency controls, shared menus/dialogs; retain canonical API callbacks and stacked dialog/focus semantics
- **Why:** only the host places tools and owns layout; no new feature or shortcut is authorized
- **Evidence:** ui-shell-slots D3/D5/D6/D11; parent lines23–59,194–202; worktree Dialog.tsx
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** changed-surface smoke reveals an unreachable existing action
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D6: Use the explicit build-first override and three disjoint implementers
- **Question:** execution preflight, research/review, contracts/spec and verification
- **Options:** ordinary test/review campaign; item-specific build-first with minimum runtime proof
- **Chose:** one combined spec committed before implementation; existing shared signatures unchanged; three OpenAI task workers in isolated external worktrees, no worker checks/commits. Parent shared-style integration, scope audit, canonical UI lint/typecheck and minimum actual browser smoke. No test suites, formal review/backend probes or screenshot-model campaign.
- **Why:** item title explicitly selects build-first, matching authoritative LOOP; developer coding contract still requires real changed-surface proof. Capture-only is not visual sign-off.
- **Evidence:** authoritative LOOP Build first section; claimed queue title; ui-shell-slots D7/D12; ui-tokens-and-components D6/D9
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** operator changes item verification policy
- **Source:** locked by docs/loop/LOOP.md

## D7: Keep macOS proof and user-state boundaries explicit
- **Question:** platform scope and inherited untracked metadata
- **Options:** ambient profiles; isolated home/process scope; infer all-platform support
- **Chose:** fresh HOME/QUIRKY_HOME and owned browser/processes only; `.serena/` untouched. No native UI additions. Linux/Windows focus/context-menu/layout acceptance remains unverified.
- **Why:** hard loop isolation/platform rules; initial checkout contained only inherited untracked metadata
- **Evidence:** initial git status; LOOP hard rules/platform policy; scripts/ui-review/fixtures.ts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** supported platform policy expands
- **Source:** deferred: platform

## D8: Extend the actual shared components and remove obsolete local implementations
- **Question:** shared contracts cannot initially express shipped context menus, accessible row actions, compact/progress rows and wide stacked dialogs
- **Options:** local CSS/components; remove feature details; additive shared presentation contracts
- **Chose:** committed contracts before use: Menu context position/submenus/current/title, ListRow accessible label/path/progress/compact, StatusDot progress, SectionHeader standard attributes/tooltips, Dialog wide sizing. Parent implements shared layout utilities and top-dialog focus. Delete the plugin Dialog implementation, unused local StatusDot adapter, and obsolete worktree-specific central CSS.
- **Why:** preserves real consumer behavior without a second UI convention or compatibility shim. Canonical lint is unchanged; both named plugins opt in.
- **Evidence:** shared contract commits f3c0a3cc/adc4c111/015eb0c5/32b9fe40/cfd5d952/15937556; item logic technical contracts; packages/ui/src/design-system and plugins/quirky.worktree/src
- **Reversibility:** medium (additive public component props)
- **Confidence:** high
- **Revisit if:** another area needs incompatible interaction semantics
- **Source:** assumed — autonomous

## D9: Repair observed layout and focus failures at their owners
- **Question:** minimum live smoke exposed long-branch row starvation, growing context menus and disabled-opener focus restoration
- **Options:** hide overflowing controls; shorten fixture strings; fix row composition and shared interaction geometry
- **Chose:** optional metadata joins the ellipsized secondary line with full tooltip; trailing chrome is bounded to attention/primary/menu, with extra actionable details below the row. Shared Menu observes its rendered size and window resize before clamping. Shared Dialog restores focus into the remaining parent when its opener is disabled.
- **Why:** a real long branch made a264px row scroll456px and its main action0px wide; after repair row/scroll are264px and main218.65625px. Expanded submenu bottom724.78125 exceeded600; atomic post-fix page read+screenshot shows bottom600. First trust cancellation kept the composer but lost focus to body; final real headless renderer proves2dialogs/topfocus →1dialog/parentfocus →0dialogs through Escape, with no cancelled worktree created.
- **Evidence:** actual isolated daemon/Git/Chromium smoke; lane evidence runtime.json, dark.png, light.png and stacked-trust-light.png; packages/ui/src/design-system/navigation.tsx/overlays.tsx; Tree.tsx
- **Reversibility:** easy
- **Confidence:** high for exercised paths
- **Revisit if:** end-phase real layout acceptance finds another unbounded field or nested focus transition
- **Source:** assumed — autonomous

## D10: Report exact build-first verification, not screenshot approval
- **Question:** which evidence supports this presentation cutover under the explicit build-first override?
- **Options:** claim all acceptance/model score; run prohibited suites/review campaigns; retain focused compiler/runtime evidence and limits
- **Chose:** initial full UIlint/root/mobile/prepared-desktop typecheck and actual UI build passed42.39s/11host-vendor files/25plugin modules. Subsequent UI builds include row/menu/focus fixes. Actual public API+browser paths cover default placement, real name/activity and pending count, status submenu mutation, metadata Save with branch/path retained, repo Cancel unchanged, UI Name create, primary deletion disabled, both themes, Ask removal without selection change and nested trust cancellation. Authored shared interaction regressions and migrate existing consumer tests; do not run suites or model visual scoring.
- **Why:** evidence must not turn capture or a compiler pass into visual approval. Initial lint rejected transparent border; remove the unnecessary border, not its rule. Compiler identified a dropped Notices actions import; restore it. No daemon API, CLI, persisted feature schema or native behavior changed.
- **Evidence:** observed compiler/build output; lane UI evidence; initial component/import audit; authoritative build-first contract
- **Reversibility:** easy
- **Confidence:** high within the named paths
- **Revisit if:** final visual review or the end phase rejects an appearance or behavior
- **Source:** locked by docs/loop/LOOP.md

## D11: Reuse the canonical context-menu owner delivered by the sole catch-up
- **Question:** how do incoming decisions compose with this branch's independently implemented context-menu extension?
- **Options:** retain two competing shared menu implementations; discard terminal behavior; migrate Worktrees to the newly landed canonical ContextMenu
- **Chose:** merge roadmap e897f88cf8d27eaa8dde246ac7baed144ad2acbf once; union all five plugin lint opt-ins. Read fix-test-packages-ui-1028, ui-restyle-editor and ui-restyle-terminal completely, including Progress. Preserve exact-window input/focus, Ask ownership and the incoming rich ContextMenu. Migrate all worktree menu builders to ContextMenuItem and import ContextMenu directly. Remove our temporary local adapter, Menu extension, duplicate CSS/token and superseded menu tests. Keep only disabled-title and measured viewport-clamp additions at the canonical context-menu owner.
- **Why:** two shared context-menu conventions would contradict the approved design-system goal. Incoming terminal menus have fuller nested/search/IME semantics. Additive tooltip/clamp changes preserve existing callers and actual primary-delete explanations; no daemon API changes or compatibility shims are introduced.
- **Evidence:** sole catch-up conflict only in scripts/ui-lint-plugins.json; incoming three decision logs; packages/ui/src/design-system/context-menu{,-contracts}.tsx/ts; worktree menu reference search; item spec composition amendment
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** post-merge compiler or actual Worktrees menu smoke rejects the composed contract
- **Source:** supersedes ui-restyle-worktrees D8 (Menu-extension clause only)

## D12: Keep the final compiler and runtime receipts bounded to what ran
- **Question:** does the composed branch satisfy the build-first gate, and what did the final smoke actually establish?
- **Options:** reuse the earlier compiler result; claim a full post-merge visual campaign; record the composed gate and partial narrow runtime evidence
- **Chose:** the eight-file test continuation was scope/HEAD audited, committed fe5b6f95, merged and its worktree removed. Delete incidental class/color/depth/copy pins rather than re-pin them; preserve hierarchy/state/membership/navigation/trust/refusal/cancellation coverage using semantic controls. Two test-helper TypeScript mismatches were corrected at the helpers. Final full UIlint/root/mobile/prepared-desktop typecheck plus actual UI build passed exit0 in31.90s, emitting11host/vendor files and25plugin modules. No suites ran.
- **Why:** the fresh merged app showed canonical primary Delete disabled with its real explanation, and its192px-wide root menu clamped to viewport bottom469. A later managed-browser submenu/Escape attempt lost reliable event/navigation control; a separate explicit-CDP attempt remained aborted despite healthy private HTTP and public daemon status. Do not turn those driver failures into product fixes or a claimed full post-merge interaction pass. Earlier real status mutation, all other D9–D10 flows and final repaired stacked-focus replay remain valid pre-catch-up evidence.
- **Evidence:** final compiler/build output31.90s; tests barrier HEAD8de9061/eight declared paths; canonical menu browser readback at owned origin57563; private HTTP/status receipts; both daemon services exited0/homeRemoved:true; browser handles released and dedicated Chrome service stopped
- **Reversibility:** easy
- **Confidence:** high for compiler and named runtime paths; no complete model/native/end-phase acceptance claim
- **Revisit if:** the existing final visual/end-phase workflow supplies a real application failure
- **Source:** locked by docs/loop/LOOP.md build-first boundary

## D13: Do not infer complete native browser-state isolation from HOME alone
- **Question:** what isolation limit did the explicitly owned Chrome diagnostic reveal?
- **Options:** hide native startup side effects; attempt to roll back unknown user updater state; retain evidence and avoid speculative real-state cleanup
- **Chose:** stop the owned diagnostic Chrome, release its attachment and remove only owned scratch/profile data after land. Its log shows native allocator/display-link warnings and GoogleUpdater accessing/writing the user's Library despite the temporary HOME and unique browser profile. Do not delete or restore unrelated Library files without their prior state. No Quirky, Claude or Codex real home was edited by the application fixture.
- **Why:** macOS native services may resolve account directories independently of HOME; the log disproves a stronger no-side-effects browser claim. This is a diagnostic-harness/platform limit, not permission to change production behavior or fabricate validation. Prefer a verified testing-browser distribution/isolated OS account for later native-browser acceptance.
- **Evidence:** proc://worktree-l12-chrome-cdp diagnostic output; explicit Chrome PID29004/profile chrome-cdp; private daemon home and status; original user metadata unchanged
- **Reversibility:** medium
- **Confidence:** high for observed log entries; prior updater state and exact external-file deltas unknown
- **Revisit if:** the browser harness supplies a verified account-state isolation boundary
- **Source:** deferred: platform

## D14: Preserve additive public props during required failed-land recovery
- **Question:** canonical land refused a concurrent shared-contract merge; how should both restyles compose?
- **Options:** discard TextField input refs; discard worktree progress; combine independent prop additions and retry the controller
- **Chose:** follow failed-land recovery only: merge roadmap e1b24c25417bcfddafe105d46aa01b9fe36fbad5, preserve React19 TextField ref typing and StatusDot progress together. Retain all lint enrollments/exports/tokens. Read ui-restyle-browser D1–D13/Progress and m3-accounts-complete-user-acceptance-20261028 D1–D17/Progress fully, including the untruncated reviewer limit. Preserve Browser focused-Find draft ownership, exact profile/CDP isolation qualifications, Accounts strict reset envelope/queued-progress/auth and native evidence boundaries.
- **Why:** the sole conflict is adjacent independent lines in the shared contract, not competing interaction authorities. Existing TextField spreads the input props and shared status rendering already consumes progress. Neither capability needs an alias or producer change.
- **Evidence:** first canonical land exit1/1.39s; exact contracts.ts conflict; incoming decision logs; union resolution
- **Reversibility:** easy
- **Confidence:** high for composition; fresh recovery typecheck/build is still required
- **Revisit if:** the composed gate or canonical retry names another failure
- **Source:** locked by docs/loop/LOOP.md failed-land retry procedure

## Progress
First canonical landing refused concurrent contracts; required recovery D14 is resolved, pending fresh compiler/build before retry. Original sole catch-up c6a1c69a and tests fe5b6f95 remain intact. All four component worktrees and owned runtimes are already removed/stopped. Earlier source proof and limitations remain D9–D13; no suite/model/native clearance is inferred. Next: commit recovery, run typecheck/build, record its actual result, detach and retry canonical queue land. Preserve evidence and remove owned scratch only after authoritative success.
