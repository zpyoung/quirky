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

## D3: Reuse the committed Structured transcript restyle from its actual owner
- **Question:** the named quirky.structured plugin has no UI module; transcript ownership differs from runtime ownership
- **Options:** invent a structured plugin UI; skip its visible surface; reuse the existing Session transcript restyle from its actual owner
- **Chose:** reuse Lane1's committed StructuredView.tsx, MessageRow.tsx and structured-view.test.ts in 6c1b22c9 via the final roadmap catch-up; no duplicate worker. Lane1 retains full Session lint enrollment/dependency
- **Why:** Lane1 explicitly reported these files already changed/committed and typechecked, and will not rewrite them further. The real Structured surface is covered without conflicting implementations
- **Evidence:** plugins/quirky.session/src/window/StructuredView.tsx:1-121; MessageRow.tsx:1-29; Lane1 coordination interjection in this session; commit6c1b22c9 on build/ui-restyle-agents
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the source merge does not contain these committed renderers or violates their existing behavioral contracts
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

## D7: Integrate audited disjoint deltas and preserve the incoming restyle contracts
- **Question:** component attribution and the sole roadmap catch-up
- **Options:** accept worker reports without checking scope; duplicate Structured changes; audit HEAD/scope and reuse committed incoming source
- **Chose:** both component HEADs remained089808f1 with exact assigned tracked deltas; parent committed Ask3f6e7113 and Notifications4a5d2dfe, merged and removed both trees. Empty unused Structured tree removed. Catch-up85327495 retained agents/git changes and unioned the sole lint-list conflict
- **Why:** avoids cross-worktree writes and competing implementations. Both incoming decision logs were read in full; agents D1–D15 and git D1–D18 preserve exact-window routing, existing authority and bounded proof. No behavioral contract conflict was found
- **Evidence:** actual HEAD/status/diff barrier; AskIncomingConstraints result; source merge85327495; full Session and all three item plugin IDs present in canonical lint list
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** an actual controller merge/type failure requires recovery
- **Source:** assumed — autonomous

## D8: Isolate the preview CSS-text import from the host module graph
- **Question:** actual renderer reload lost all shared token definitions even though typecheck and UI build exited0
- **Options:** duplicate tokens in plugin CSS; tolerate unstyled controls; move the preview primitive to its own public subpath
- **Chose:** clean cutover to `@quirky/ui/read-only-preview`, no root re-export. Ask remains its sole consumer. The helper still embeds canonical tokens for the opaque frame
- **Why:** before the change, served main.css had zero --ui-* definitions and computed --ui-space-12 was empty; after isolating the CSS-text import and rebuilding, main.css defines --ui-space-12:12px and actual controls compute4px8px padding. The observed root module graph caused a CSS-text/stylesheet import collision; no bundler-wide guarantee is inferred
- **Evidence:** known-red-token-omission.webp; actual fetch/computed-style observations; final build and browser token/padding proof; source consumer grep
- **Reversibility:** medium (public presentation subpath)
- **Confidence:** high
- **Revisit if:** bundler import-mode isolation is explicitly fixed and verified
- **Source:** supersedes ui-restyle-ask D4 (export location only)

## D9: Repair visible composition and typography without changing input authority
- **Question:** first actual Ask screenshot duplicated text/number/date labels and stretched optional badges; source inspection found missing selected-option styling and mono size used as a font family
- **Options:** hide fields; add plugin CSS; use existing shared variant/layout/form semantics correctly
- **Chose:** option primary/secondary variant plus wrapping; one visible label per basic question, grouped legends retained, optional badge stays compact, plain pre-wrap text without split/map arrays. Notification row IDs are per-instance. Structured code uses actual monospace family and shared mono size. Dead Ask/Notifications/Structured global rules removed after consumer search
- **Why:** these are presentation composition fixes; original controlled values, handlers, draft timing, validation and canonical response shapes remain unchanged
- **Evidence:** initial-duplicate-labels.webp versus ask-final-dark.webp; QuestionField/AskCard/NotificationsView/MessageRow source; actual Structured pre computes ui-monospace,Menlo,monospace at11.5px
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** end-phase behavior tests find a control/label regression
- **Source:** assumed — autonomous

## D10: Report exact compiler and real-renderer evidence, not full parity or golden approval
- **Question:** what this build-first item has actually verified
- **Options:** claim complete suite/native/provider/golden approval; run prohibited campaigns; retain bounded command and surface receipts
- **Chose:** final canonical `bun run typecheck` passed UIlint/root/mobile/prepared-desktop in31.79s. Final UIbuild emitted11host files and25plugin modules. Actual owned renderer exercised six Ask input types and submission with canonical answered envelope, dark→light mounted preview (empty sandbox, inert a without href, zero scripts, actual dark/light body backgrounds), notification dependent/independent switches, relative-path refusal, native range keyboard commit saved5%, and test-feedback toast with intercepted native notifier
- **Why:** genuine visible proof, without launching accounts/providers/native banners or claiming independent screenshot scores. Structured smoke uses explicitly seeded private exited-session/journal fixtures, then public view/messages APIs: assistant/tool/system rows, expanded tool details, Show all events filter, ended state, dark/light and1000x700 no horizontal overflow. This is not provider send/resume/approval-turn acceptance. Pageerrors remained[]
- **Evidence:** .quirk/build-loop/ui-restyle-ask/receipts.json and13screenshots including known-red; bg3 first typecheck37.19s, bg5 final31.79s; actual supervisor/API/browser output
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** end-phase suites, native runs or independent golden review reveal a defect
- **Source:** locked by docs/loop/LOOP.md

## D11: Recover the controller's real concurrent merge failure and re-exercise current composition
- **Question:** first authoritative land refused the concurrent roadmap merge
- **Options:** bypass the queue gate; drop incoming source; perform the required recovery merge and preserve both restyles
- **Chose:** recovery61013dd6 brings Tasks/Worktrees; keep unioned lint enrollment and remove both obsolete Notification and workspace-activity-controls rules after no current source consumers. All incoming Tasks D1–D10 and Worktrees D1–D17 decisions read in full; shared contracts/menu ownership/exact routing remain composed
- **Why:** the controller failure is the only reason for this second roadmap merge. Its two conflicts are overlapping dead-CSS removals and additive lint entries, not competing feature behavior. No suppressed diagnostics or product retries/deadlines
- **Evidence:** bg6 exit1 concurrent merge refusal; merge61013dd6; AskRecoveryConstraints report; bg7 canonical typecheck exit0 in31.28s and rebuilt11host/25plugin modules
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a subsequent controller attempt reports another concrete merge or type failure
- **Source:** assumed — autonomous

## D12: Keep pre-recovery and current-source proof distinct
- **Question:** shared styles changed in recovery, so earlier renderer proof cannot stand in for final composition
- **Options:** relabel earlier screenshots as current; run a full campaign; repeat only affected current integration paths
- **Chose:** a new private runtime/CDP exercised merged Ask option selection/submission, actual12px host token, sandboxed inert preview dark→light, notification off/dependent-disabled/menu-bar-independent state and no horizontal overflow. Pageerrors[]; both screenshots retained separately. No new provider/native action
- **Why:** confirms rebuilt composition without duplicating full six-input/fixture-transcript work or claiming tests/scoring. Earlier six-input canonical envelope, Structured fixture/filter/mono proof and notification range/refusal/test receipts remain explicitly pre-recovery
- **Evidence:** .quirk/build-loop/ui-restyle-ask/recovery-receipt.json; recovery-current-ask-dark.webp and recovery-current-notifications-light.webp; supervisorask-restyle-l8-recovery-ui
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** final source changes after these gates
- **Source:** locked by docs/loop/LOOP.md

## Progress
Ready for canonical retry. Candidate includes required recovery61013dd6, both incoming logs read in full, canonical types/UIlint/root/mobile/preparedDesktop passed31.28s, current rebuild and new isolated renderer proof passed. All owned browser/runtime resources stopped and component trees removed. Next commit these receipts/docs, detach and retry authoritative queue land ui-restyle-ask, awaiting its result in this turn. Earlier bounded receipts remain qualified; no suites, full dogfood, review, native/provider-turn or golden score claim.
