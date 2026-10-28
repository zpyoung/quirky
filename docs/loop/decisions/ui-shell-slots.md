# ui-shell-slots decisions

## D1: Follow the approved shell row without restyling feature interiors
- **Question:** brainstorming purpose, scope, layout, density and interaction defaults
- **Options:** rebuild all plugin UIs; CSS-only rearrangement; host structural migration with existing plugin content
- **Chose:** host structural migration, approved graphite shared components/tokens, six independent slots and center views
- **Why:** the approved rollout assigns feature interiors to later area owners and explicitly removes global plugin tabs/sidebar piles
- **Evidence:** docs/quirk/specs/2026-10-28-ui-redesign/logic.md:23-59,168-202
- **Reversibility:** medium (visible shell layout)
- **Confidence:** high
- **Revisit if:** a feature is unreachable through the new host
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D2: Keep per-user tool layout in the canonical daemon store
- **Question:** persistence, grouping and conflict resolution gray areas
- **Options:** localStorage; project/worktree preferences; existing profile-wide daemon ui_state
- **Chose:** existing profile-wide daemon ui_state with additive tools and exact-window center history
- **Why:** layout/focus must remain API-readable and scriptable; the store is already profile-global, not selected-worktree-owned
- **Evidence:** docs/architecture.md:317-324; packages/daemon/src/plugins/layout.ts:37-70,152-188,904-935
- **Reversibility:** hard (public state contract)
- **Confidence:** high
- **Revisit if:** user identity becomes independent of QUIRKY_HOME profiles
- **Source:** locked by docs/architecture.md

## D3: Project effective legacy contributions into tools and preserve original IDs
- **Question:** data mapping, duplicates and third-party exceptions
- **Options:** rename every declaration; retain separate old rails; effective host projection with explicit alias destinations
- **Chose:** panel/sidebar/activity projection; deduplicate existing alternate launchers into substantive content; preserve arbitrary third-party content; views/commands/status/settings/overlays retain canonical owners
- **Why:** a second registry or mass caller migration would change feature behavior and collide with area owners; top plugin tabs and sidebar piles still disappear
- **Evidence:** packages/protocol/src/ui.ts:87-105,169-208; packages/daemon/src/plugins/ui-model.ts; builtin manifest inventory captured through JSON parsing
- **Reversibility:** medium (projection can change without changing plugin IDs)
- **Confidence:** high
- **Revisit if:** a plugin needs explicit placement metadata rather than deterministic defaults
- **Source:** assumed — autonomous

## D4: Use durable pending asks as actionable Inbox authority
- **Question:** attention lifecycle, empty/error states and dismissal meaning
- **Options:** treat toast dismissal as answer; duplicate ask records; derive from public ask API and preserve canonical answer path
- **Chose:** host Inbox derives unresolved questions; eight-second corner toast disappears independently; failed answer retains question; no implicit focus/worktree change
- **Why:** pending asks already have durable sequence/answer authority while toasts are transient presentation
- **Evidence:** plugins/quirky.ask/src/store.ts; packages/ui/src/components/Toasts.tsx; approved spec scenarios2–3
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a non-question attention source requires durable acknowledgement
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D5: Retain exact-window and plugin-internal view behavior
- **Question:** center tabs, existing shortcuts and auxiliary-window integration
- **Options:** tab every installed plugin; replace feature-owned tabs; track actually opened center contributions while retaining inner feature tabs
- **Chose:** actually opened center view history with latest input and exact-window routing; auxiliary windows keep route-local views; existing plugin shortcut priority retained with host search trigger
- **Why:** installed-plugin navigation is explicitly removed, and replacing document/session ownership changes behavior beyond the redesign
- **Evidence:** packages/ui/src/components/MainArea.tsx:7-34; packages/ui/src/plugins/host.ts:377-395,1070-1084; packages/daemon/src/plugins/layout.ts:278-327
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** area restyles expose a direct host tab contract for their documents/sessions
- **Source:** assumed — autonomous

## D6: Reuse only the shared system and inherited theme resolver
- **Question:** visual component and error/loading/empty defaults
- **Options:** plugin CSS and raw literals; second toolkit; shared controls/tokens and host frames
- **Chose:** shared controls, ToolPanelFrame, readable loading/error with plugin name+Reload, EmptyState; shell-only token CSS; existing data-theme resolution
- **Why:** all packages/ui is lint-enforced and the dependency owns system contracts; plugin interiors are not opted into lint prematurely
- **Evidence:** ui-tokens-and-components D1–D10; @quirky/ui design-system public exports; parent spec:83-119
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a required host control cannot be expressed by a shared component
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D7: Execute one combined spec and three disjoint source components
- **Question:** execution skill preflight, research, review and verification
- **Options:** standard research/review campaigns; build-first combined spec/contracts and source workers
- **Chose:** contracts committed first, at most three OpenAI task implementers in external worktrees, no worker checks/commits, parent attribution barrier/typecheck/minimum actual smoke; no review backend probes because no review is run
- **Why:** authoritative LOOP build-first overrides the ordinary execution skills. No human asks. Inherited .serena stays untouched; no tests run until end phase
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md Build first section; language-server status returned no configured servers; combined item logic spec
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** authoritative LOOP enters the end phase
- **Source:** locked by docs/loop/LOOP.md

## D8: Bound dimensions and use opaque same-window drag state
- **Question:** resize limits, invalid data and drag trust gray areas
- **Options:** trust arbitrary DataTransfer bytes; unbounded geometry; validated IDs with same-window drag state and bounded dimensions
- **Chose:** validate effective IDs/slots at daemon mutation, side160–1200/bottom100–1000/splits0.15–0.85; source drag state is local gesture-only, destination persisted through API; small viewport rendering can contract without changing preference
- **Why:** corrupted stores and external drags cannot create inaccessible/oversized layouts; gesture state is not authority
- **Evidence:** item logic spec SC3–4 and public tool-slots.ts types
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** actual shell smoke exposes a narrow-window accessibility problem
- **Source:** assumed — autonomous

## D9: Remove the obsolete top/side activity-bar preference at cutover
- **Question:** coherence sweep found editor settings still configuring the removed global rail
- **Options:** retain an inert preference; preserve a second old rail; remove the dead preference while keeping meaningful panel width configuration
- **Chose:** remove activityBarPosition from editor setting/control/resolver/call and public layout/schema/CLI; panel width continues to target the same canonical tool authority
- **Why:** the approved six movable stripes replace old fixed top/side geometry. An inert setting or parallel rail contradicts the new shell. Parent owns the editor slice and shared contract removals; layout worker owns schema/CLI/daemon/test cutover
- **Evidence:** plugins/quirky.editor/src/ui.tsx:629-675; src/window/settings.ts and ExplorerPanel.tsx old control; packages/protocol/src/ui.ts and rpc.ts; approved spec:35-59
- **Reversibility:** medium (old preference ceases to be effective)
- **Confidence:** high
- **Revisit if:** a tool requires its own internal, distinct activity bar preference
- **Source:** supersedes m2-editor D11 (activity-position clause only), under the approved redesign

## D10: Recover two misplaced source slices through explicit parent ownership
- **Question:** all-worker attribution found two assigned worktrees clean while their source changes existed in the parent
- **Options:** discard owned completed source; conceal the boundary failure; stop writers, audit exact disjoint paths and replan parent integration
- **Chose:** stopped both writers; their admitted repository-relative tool paths resolved from the parent, not their assigned absolute roots. Parent assumes these exact daemon and attention path sets after the barrier, with no simultaneous writers. The shell slice remains isolated. One unauthorized CLI test path is admitted only for removing new mock-forwarding/wording cases and retaining real input-validation coverage
- **Why:** initial parent tracked baseline was clean, the parent editor changes are separately enumerated, all three source sets are disjoint, and no unrelated metadata is accepted. Source attribution must be verified rather than trusting worker reports. No isolated-tree execution claim is made for these two components
- **Evidence:** journal.json baselines; all four git HEAD/status inventories; ShellLayout and ShellAttention explicit tool-routing admissions; CLI test inspection
- **Reversibility:** easy (component path sets remain independently committable)
- **Confidence:** high
- **Revisit if:** the barrier audit finds a changed path or hash outside these known owners
- **Source:** assumed — autonomous

## D11: Repair observed shell composition defects at their real owners
- **Question:** actual surface smoke exposed clipped icon names, a tall status card, Tasks center navigation and missing worktree Ask attention
- **Options:** hide failures with CSS clipping; treat feature placement as complete; repair each public presentation/navigation seam
- **Chose:** host SVG glyphs for icon identifiers; unconfigured Usage setup stays behind its existing popover; Tasks navigation recognizes its actually open projected tool and closes that slot without replacing the center; worktree rows read canonical pending asks and show shared amber count/dot controls. Repeated ui.tool.open is idempotent; stripe toggling uses ui.tool.close explicitly
- **Why:** these are required host integration behaviors, not area restyles or new authority. The actual first smoke showed17overflowing icon labels, a154px status bar, an extra Tasks center tab, and a question with Inbox attention but no worktree count
- **Evidence:** initial/final browser observations; tool-shell SVG boundary; quirky.accounts Usage.tsx; quirky.tasks env.ts; quirky.worktree useWorktreeAttention.ts/Tree.tsx; final-runtime-proof.json
- **Reversibility:** medium (public location semantics)
- **Confidence:** high
- **Revisit if:** end-phase acceptance finds another contribution whose placement mutates unrelated center state
- **Source:** assumed — autonomous

## D12: Record focused runtime proof without claiming the end-phase suite or visual score
- **Question:** what verification is actually supported under build-first
- **Options:** claim full acceptance; run prohibited campaigns; report only exercised compiler/runtime evidence
- **Chose:** full root/mobile/prepared-desktop typecheck and UI lint passed; actual UI build emitted11host/vendor files and25plugin modules. A fresh private HOME/QUIRKY_HOME daemon, real PTY and dedicated owned Chrome exercised defaults, slot replacement/close, native HTML5 Ledger drag, keyboard resize, public CLI move/resize/open, unified search, canonical breadcrumb, center input restoration, off-worktree question answer without navigation, and a7992ms toast expiry with its Ask still pending. Final cold-start source proved Tasks no-center-steal/close and worktree count removal after canonical answer. Recreating the real daemon handle on the same profile restored identical saved tool state; this is not a separate-process restart claim
- **Why:** evidence must distinguish minimum changed-surface proof from suites, full dogfood, native-host behavior and screenshot-review scoring, all unrun here. Authored regression tests cover remaining boundaries but no test pass is claimed
- **Evidence:** initial-runtime-proof.json, final-runtime-proof.json, exact-window-api-proof.json, final-readback.json and saved screenshots in the iteration evidence; typecheck/build command outputs
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** end-phase tests or the screenshot-review owner find a failure
- **Source:** locked by docs/loop/LOOP.md

## D13: Preserve exact-window evidence limits and peer test repairs
- **Question:** automation's second named browser handle reused the same actual target; lane1 announced overlapping test repairs
- **Options:** claim two visual windows; duplicate lane1's fixes; use a second real UI-role client for isolation and retain peer ownership
- **Chose:** one actual browser plus a second real authenticated UI-role API connection proved unchanged first-window view/history and isolated second-window input/history. Two-browser visual isolation is not claimed. Lane1 owns test-only gallery/theme/Questions/focus/dialog repairs; its handoff says no shared shell source changes, so the one roadmap catch-up preserves those tests without importing a partial topic
- **Why:** target reuse and selecting a different matching search command are driver observations, not proof of an application window bug. No duplicate debugging/review campaign or new dependency is warranted
- **Evidence:** exact-window-api-proof.json; actual ui.window.self/state/open responses; lane1 handoff and accepted terminal messages; /tmp/quirky-ui-shell-lane9-overlap.md
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** genuine two-window native acceptance contradicts the exact-window API result
- **Source:** assumed — autonomous

## D14: Keep platform and capture claims bounded to this Mac
- **Question:** where platform/native verification still differs from web surface proof
- **Options:** infer all web engines and OS shortcuts; test only macOS and retain the standing end-phase/native obligations
- **Chose:** macOS build/CLI and an owned Chromium surface only. Linux/Windows shortcut/drag geometry and real WKWebView/window-frame behavior still need their own platform acceptance. No new OS integration or native notification behavior was introduced
- **Why:** locked platform policy is macOS-only; no fake native capture or cross-platform pass is justified
- **Evidence:** workstation/tool outputs and actual browser application path; approved redesign desktop-only scope
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** platform support is expanded
- **Source:** deferred: platform

## D15: Compose the sole roadmap catch-up without weakening window identity
- **Question:** the final integration merge conflicted in windowSelf and an auxiliary-route regression
- **Options:** drop desktop identity; drop exact-window history initialization; combine both invariants
- **Chose:** merged exact target74d13c9124a7858822f504141b8490ca2688578f once. windowSelf initializes the window-local view/history and returns the authenticated optional desktopClientId. Auxiliary tests retain focused-route/report checks, new view history/restoration and unchanged-main assertions. All16incoming decision-log snapshots were read in full; no normative conflict found
- **Why:** kernel-authenticated installation identity and exact-window view isolation are independent obligations. The test now follows its actual changed auxiliary view rather than pinning the former one
- **Evidence:** merge1173471e; merge-incoming-decisions.json and IncomingShellDecisions report; fresh merged-api-proof.json showed independent UI connection IDs2/3, preserved distinct inputs/histories and idempotent Inbox opening
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the merged compiler or end-phase owner finds an actual contract mismatch
- **Source:** assumed — autonomous

## Progress
Ready to land. The sole roadmap catch-up is merge1173471e; all16incoming decision logs were read in full. Fresh post-merge bun run typecheck passed UIlint/root/mobile/prepared-desktop in161.45s, and merged exact-window/API smoke passed. Earlier actual browser/UI/CLI evidence is bounded in D12–D14; no suites/review/full dogfood/native acceptance/screenshot scoring pass is claimed. All workers/private browsers/runtime services have finished; all3component worktrees were removed with inherited metadata preserved. Next detach and run canonical queue land, await its authoritative verdict, archive the result and remove only owned scratch.
