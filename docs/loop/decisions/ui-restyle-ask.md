# ui-restyle-ask decisions

## D1: Apply the approved graphite system without changing feature behavior
- **Question:** brainstorming purpose, placement, density, interaction and dark/light gray areas
- **Options:** recolor legacy CSS; rewrite feature state; retain handlers and migrate all owned controls to shared components/tokens
- **Chose:** shared controls and token-only structural layout, current tool/view/settings IDs and placement
- **Why:** the approved redesign forbids feature behavior changes and plugin-local CSS; existing shell owns frames and slots
- **Evidence:** docs/quirk/specs/2026-10-28-ui-redesign/logic.md:23-59,83-119,192-227; approved dark/light goldens personally read
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual surface smoke exposes inaccessible content or an unmapped surface
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D2: Preserve durable Ask, notification policy and structured-runner authority
- **Question:** loading/empty/error states, submission, preview, drafts, status and side-effect gray areas
- **Options:** reimplement behavior in shared controls; leave canonical hooks/RPCs and only change presentation
- **Chose:** unchanged hooks, validation/deadline/FIFO/draft semantics, attention gates and fail-closed approvals/provider ownership; honest current statuses and recovery controls
- **Why:** restyling cannot become a second behavioral authority. Later Ask sanitized rich formatting and inert links supersede the earlier plain-text preview proposal
- **Evidence:** m2-ask-parity D5–D19/D24/D30–D32; fix-test-ask-1028 D1/D4/D8–D9/D11–D12; fix-ask-regex-budget-20261027 D1–D4; m1-notifications D5–D18/D25/D33/D40/D54; m5-structured-runner D3–D6/D12–D19/D36–D40; ui-shell-slots D4–D5
- **Reversibility:** hard (consumer-visible authority remains unchanged)
- **Confidence:** high
- **Revisit if:** a source change requires altering an API, setting default or side-effect contract
- **Source:** locked by docs/loop/decisions/fix-test-ask-1028.md

## D3: Restyle the actual Structured transcript in Session, coordinating its existing owner
- **Question:** the named quirky.structured plugin has no UI module; transcript ownership differs from runtime ownership
- **Options:** invent a structured plugin UI; skip its visible surface; own the two existing Session transcript renderers
- **Chose:** StructuredView.tsx and MessageRow.tsx plus necessary semantic test selectors, leaving all other Session UI and full Session lint enrollment with concurrent ui-restyle-agents
- **Why:** this is the real user-visible Structured surface; a new parallel UI or empty lint-only change would not fulfill the item
- **Evidence:** plugins/quirky.session/src/window/StructuredView.tsx:1-121; MessageRow.tsx:1-29; queue status lane1 owns ui-restyle-agents; accepted one-off terminal message a1baa8bc-208a-4837-a64d-09c575394c2a
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the concurrent owner reports overlapping already-written source
- **Source:** assumed — autonomous

## D4: Add a shared read-only preview primitive instead of retaining plugin CSS
- **Question:** Ask's sandboxed preview embeds a standalone stylesheet and cannot inherit parent document tokens
- **Options:** remove rich preview; retain plugin CSS exemption; move only document presentation/security enclosure into shared ReadOnlyPreview
- **Chose:** additive public ReadOnlyPreview props sanitizedHtml/title; Ask keeps its sanitizer, the shared component keeps empty sandbox, no-referrer, networkless/scriptless CSP and live inherited theme
- **Why:** preserves formatted inert preview while eliminating plugin CSS and raw dimensions/colors. Shared stylesheet embeds canonical tokens, with controlled theme attribute only
- **Evidence:** plugins/quirky.ask/src/PreviewFrame.tsx:10-117; packages/ui/src/design-system/read-only-preview.tsx; existing selection-overlay token-text import pattern
- **Reversibility:** medium (one additive shared primitive)
- **Confidence:** high
- **Revisit if:** the minimum real iframe smoke finds lost security or theme behavior
- **Source:** assumed — autonomous

## D5: Follow build-first execution and preserve unrelated state
- **Question:** execution preflight, research, spec review, tests, source isolation and verification
- **Options:** standard review/test campaign; authoritative combined spec/contracts-first implementation
- **Chose:** one combined spec, at most three disjoint OpenAI task implementers, no worker checks/commits, parent scope barrier/typecheck/minimum actual renderer smoke; no reviewer probes because review is not run
- **Why:** authoritative LOOP and item title explicitly apply build-first. Unknown untracked probes/.quirk/.serena remain untouched; no human asks. No public API change beyond the additive shared UI contract
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md Build first; actual LSP status no servers; initial checkout clean tracked state
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** operator changes the phase policy
- **Source:** locked by docs/loop/LOOP.md

## D6: Bound verification to macOS and owned isolated renderer resources
- **Question:** platform and native/visual assurance scope
- **Options:** use inherited browser handles/provider accounts; fresh private ProcessScope daemon and Playwright Chromium for Testing
- **Chose:** fresh private home/Git config/browser profile, no provider run or native notification delivery; actual changed-control/theme smoke only, no full campaign or golden-model score claim
- **Why:** native banners/provider execution are unchanged and outside a presentation smoke. Prior branded Chrome updater touched real Library despite private HOME; do not repeat it or use shared prohibited handles
- **Evidence:** ui-restyle-ledger D9; ui-screenshot-review D1–D4/D9–D10/D14–D15
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Linux/Windows or native-host validation is explicitly scheduled
- **Source:** deferred: platform

## Progress
Combined spec, unchanged feature contracts and additive shared ReadOnlyPreview contract prepared. Next commit contracts, dispatch disjoint Ask/Notifications/Structured presentation workers, integrate lint/dependencies and remove obsolete global styles, catch up once, typecheck/build/minimum actual renderer smoke, record exact evidence and land through authoritative queue. No tests, full dogfood, review or screenshot scoring under build-first.
