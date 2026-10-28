# ui-restyle-agents decisions

## D1: Restyle the four existing feature owners without new behavior
- **Question:** Brainstorming essential scope, consumer, primary behavior and success criteria.
- **Options:** Repaint local controls; compose shared components; rebuild feature state and registrations.
- **Chose:** Public shared components and semantic tokens across all four plugin UI surfaces, preserving IDs, APIs/CLI, state/actions and exact-window routing.
- **Why:** The approved redesign is a presentation/placement change, not new features. Shared controls prevent another local styling convention.
- **Evidence:** docs/quirk/specs/2026-10-28-ui-redesign/logic.md:117-119,181,194-202; docs/roadmap.md:19-38,43-53.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** A consumer-visible flow needs an unavailable public component contract.
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D2: Keep host placement and authoritative status/detail semantics
- **Question:** Visual layout, density, interaction and responsive gray areas.
- **Options:** Add plugin chrome/tools; retain registered center views and projected tools; collapse detailed statuses into new daemon states.
- **Chose:** Existing center views remain views; Session info stays right-bottom; existing sidebar contributions remain projected tools. Comfortable shared rows/forms/cards, semantic presentation-only status mapping, wrapping/scrolling and reachable actions; retain detailed labels, freshness, unread/progress and drafts.
- **Why:** Shell already owns placement and mount/focus. Detailed statuses and session-info absence/stale data have locked semantics.
- **Evidence:** packages/daemon/src/plugins/tool-layout.ts:48-62; docs/quirk/specs/2026-10-28-ui-shell-slots/logic.md:36,56; m1-agent-status D3/D4/D16; m3-session-info D3/D4/D6/D18/D21; followup-m3-session-info-parity-20261027 D3/D7.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Real narrow-surface smoke shows unreachable actions or status misrepresentation.
- **Source:** locked by existing shell and feature decision logs

## D3: Preserve loading, error, empty and recovery behavior
- **Question:** Visual loading-pattern, empty-state, error-state and remaining essential gray areas.
- **Options:** Cosmetic placeholders/zero-filled telemetry; existing data states with shared presentation.
- **Chose:** Real loading/empty/error/retry states; missing telemetry never becomes zero; preserve stale values/retry, consent, transient copy feedback and session lifecycle actions. Native text/select/textarea/checkbox controls use shared FormRow/classes/tokens when no equivalent component exists.
- **Why:** No feature change is authorized, and the shared toolkit intentionally provides FormRow composition.
- **Evidence:** packages/ui/src/design-system/contracts.ts:8-33; docs/loop/decisions/m3-session-info.md D4/D21; approved parent non-goals.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Existing form semantics cannot be preserved through the shared composition API.
- **Source:** assumed — autonomous

## D4: Build-first contracts and three disjoint implementers
- **Question:** Skill questions, specification format, execution pair, dirty tree, research/review/test gates and decomposition.
- **Options:** Human questions and research/review campaigns; authoritative build-first with autonomous defaults.
- **Chose:** One self-reviewed markdown logic spec with final tech contracts, committed before three OpenAI omp-task implementers. Shared exported component contracts already exist; no new schema or API signature. Parent owns lint list/docs/integration, no worker checks or commits, isolated external trees and barrier scope audits. Preserve inherited untracked .quirk/ and .serena/. No reviewer dispatched or alias claimed reachable because formal rounds are forbidden. No human asks.
- **Why:** Authoritative LOOP build-first overrides normal skill questions/swarms/tech-doc split and review rounds; existing shared API is sufficient. LSP status reports no configured servers.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md; skills brainstorming/writing-specs/subagent-driven-development/writing-plans; xd://lsp status; scratch /tmp/quirky-agents25-FNeBJL.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A necessary shared component expansion needs an explicit parent-owned contract.
- **Source:** locked by docs/loop/LOOP.md

## D5: Enforce the four plugins without weakening lint
- **Question:** How do the existing optional plugin lint gates apply to this item?
- **Options:** Ignore old raw styling; suppress diagnostics; opt in all four and remove violations.
- **Chose:** Add quirky.agents, quirky.agent-status, quirky.session and quirky.session-info, unioning concurrent additions. No scanner weakening, suppression, violation baseline or private stylesheet. Preserve terminal theme adapter and public shared styles.
- **Why:** Every area restyle explicitly opts into the scanner; typecheck must enforce the same design system.
- **Evidence:** scripts/ui-lint-plugins.json; docs/loop/decisions/ui-tokens-and-components.md D2/D10; claimed queue title.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Typecheck identifies an actual missing semantic token, not a reason to bypass enforcement.
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D6: Narrow real-surface proof with explicit visual limits
- **Question:** Runtime evidence and screenshot review under build-first.
- **Options:** Claim approval from typecheck; run prohibited full campaigns; minimal real UI smoke/capture and honest limits.
- **Chose:** Typecheck gates land. Exercise changed renderer surfaces on isolated real daemon fixtures and inspect both-theme captures where supported. No suite, full dogfood or formal scoring campaign under build-first; capture is not a golden-review pass. Existing ui:review remains the end-phase scoring mechanism, threshold85 unchanged.
- **Why:** Developer coding contract requires actual surface proof; LOOP forbids broad test/review campaigns. The shell owner records the same boundary.
- **Evidence:** docs/quirk/specs/2026-10-28-ui-shell-slots/logic.md:48,60; ui-screenshot-review D3/D4/D5/D6/D8; scripts/ui-review/arguments.ts:37-69.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Authoritative item instructions explicitly enable a scoring campaign.
- **Source:** locked by docs/loop/LOOP.md

## D7: macOS renderer only, no new platform behavior
- **Question:** Platform certification and native-only effects.
- **Options:** Expand into Linux/Windows/native QA; keep current local renderer scope.
- **Chose:** Build/smoke on macOS only, portable existing React/CSS APIs. Linux/Windows renderer/platform certification remains unperformed; native clipboard/Finder/notifications retain existing owner scenarios.
- **Why:** LOOP locks platform scope and approved redesign changes no native feature behavior.
- **Evidence:** docs/loop/LOOP.md platforms; followup-m3-session-info-parity-20261027 D2; approved parent scope.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Supported platform matrix changes.
- **Source:** deferred: platform

## D8: Integrate only the audited disjoint component deltas
- **Question:** Worker attribution, shared dependencies and preserved interaction boundaries.
- **Options:** Trust worker reports; audit fixed HEAD/path scopes at the final barrier and integrate once.
- **Chose:** All three trees retained99cc1bb0 and exact assigned UI/test scopes. Integrated6c1b22c9,15ac66e8,88ba7c1b; removed all three component trees immediately. Parent added the existing @quirky/ui workspace dependency to agents/status/info manifests and regenerated bun.lock; session already declared it.
- **Why:** No overlapping source files or new public API were necessary. Full-title accordion activation and short Dashboard Open actions were restored before integration.
- **Evidence:** Tool-observed worker HEAD/path inventories and octopus merge; bun install --lockfile-only exit0.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Typecheck identifies a package boundary or meaningful consumer regression.
- **Source:** assumed — autonomous

## D9: Repair actual type diagnostics without repinning incidental tests
- **Question:** Initial integrated typecheck reported two missing menuLabels references and one string-versus-UiStatus assertion.
- **Options:** Cast categories and add a duplicate helper; reuse the menu label closure and remove the enum-copy test.
- **Chose:** Capture the existing openMenu closure for live menu updates. Delete the eleven-row semantic-enum mirror rather than cast/re-pin it; preserve label/freshness/progress/unread transition tests and meaningful action coverage.
- **Why:** The missing helper was a test migration error; asserting a copied enum table against a mapping function does not prove consumer behavior.
- **Evidence:** Initial bun run typecheck exit2/26.11s; UI lint itself produced no diagnostics. UI build emitted11host/vendor files and25plugin modules.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Final compiler output identifies another actual type error.
- **Source:** assumed — autonomous

## D10: Exercise actual contributions while keeping capture and native limits explicit
- **Question:** What runtime evidence applies to changed code versus another plugin's override?
- **Options:** Claim the terminal owner's view proves session fallback; use actual owner projections and an explicit disabled-terminal fixture.
- **Chose:** Actual isolated daemon served rebuilt assets. Agents default selection, command Enter-save and Reset, Activity apply/filter, Dashboard apply/clear and exact-session Open, Session info full-title accordion plus wrapped/scroll-reachable identity actions, transcript navigation and history no-match/restore were observed. Settings Save changed actual root theme to light; inspected both-theme Agents/Activity/Dashboard/Session info/History/Transcript captures. The terminal plugin normally overrides the worktree view; disabled it through public plugin.disable in this disposable home to exercise the real session fallback's shared tabs/menu/prompt. Typed prompt appeared and Escape closed the dialog without starting a provider.
- **Why:** Disabling a supported built-in selects the genuine fallback contribution, not a copied component story. Provider executable/transcript/status payloads are explicitly disposable fixtures; no real provider authentication, send/resume, native clipboard/Finder, structured provider turn, full dogfood or independent golden score is claimed.
- **Evidence:** .quirk/build-loop/ui-restyle-agents/*-{dark,light}.png; actual hidden browser and process-scoped daemon. Browser error inventory contains one helper-generated invalid-selector error from an incorrect waitFor call, not app code; corrected helpers inspected the intended state. No hidden test override or injected product style.
- **Reversibility:** easy
- **Confidence:** high for named observed paths; unexercised boundaries remain unclaimed
- **Revisit if:** End-phase suites or independent golden scoring identify a mismatch.
- **Source:** assumed — autonomous

## D11: Union concurrent restyles and retain their shared-system ownership
- **Question:** The sole roadmap catch-up conflicted in the additive lint enrollment list and brought three binding decision logs.
- **Options:** Drop another area's enforcement; preserve all eight plugin IDs and incoming exports/tokens/engine styles.
- **Chose:** Read ui-restyle-browser D1–D13, ui-restyle-editor D1–D13 and ui-restyle-terminal D1–D13/Progress completely. Union all lint IDs. Preserve ContextMenu/body portals, editor-print/selection-overlay exports, KaTeX/content-color ownership, terminal theme/geometry and exact-window routing. Remove Session Info's redundant nested panel frame: the host already draws its tool title. Shorten Activity's visible Open action just as Dashboard's.
- **Why:** Shared components and source scopes compose additively; no alternate authority is needed. Actual screenshots exposed the duplicate title and internal-ID button. Incoming headless-GPU observations explain why blank terminal pixels do not establish a PTY/state defect; this item changes no GPU defaults or terminal runtime.
- **Evidence:** Sole roadmap merge conflict in scripts/ui-lint-plugins.json; actual inspected Session Info and Activity screenshots; incoming decision logs, including complete untruncated Progress.
- **Reversibility:** easy
- **Confidence:** high for source composition; final caught-up build/typecheck and fresh surface proof remain next
- **Revisit if:** Canonical gate identifies a concrete integration failure.
- **Source:** locked by incoming restyle decision logs

## D12: Verify current source in an explicitly owned browser and preserve failed infrastructure evidence
- **Question:** What passed after catch-up, and how is concurrent browser ownership fenced?
- **Options:** Reuse earlier screenshots as final evidence; use an exclusively owned profile/CDP for current assets.
- **Chose:** Full caught-up UIlint/root/mobile/prepared-desktop typecheck exit0/41.47s; current renderer build emitted11host/vendor files and25plugin modules. Final owned Chromium CDP58092/profile under item scratch showed short Activity Open, exact-session navigation, single host-owned Session info header, title-collapse false/expand true, wrapped action reachability and both-theme current captures. Final browser error entries empty; light document width/scrollWidth both1340.
- **Why:** Fresh current-source proof verifies the final corrections without pretending all earlier captures came from the merged tree. The first dedicated installed Google Chrome stayed about:blank through navigation timeouts; stopped it and used existing Playwright Chromium with mock-keychain. Its logs show Chrome invoked ambient GoogleUpdater despite HOME override; no agent-authored edit or rollback of user configuration was attempted. The final Chromium used a separate explicit profile/endpoint and only the owned app origin.
- **Evidence:** .quirk/build-loop/ui-restyle-agents/proof.json and final-{activity,session-info}-{dark,light}.png; actual typecheck/build output; dedicated browser service receipts and observed URL.
- **Reversibility:** easy
- **Confidence:** high for named current renderer paths; earlier broader smoke retains its pre-catch-up qualification
- **Revisit if:** End-phase suite, native or independent visual acceptance identifies a concrete regression.
- **Source:** assumed — autonomous

## D13: Honor the late structured-surface ownership interjection without duplicate edits
- **Question:** Lane8 announced ownership of StructuredView.tsx, MessageRow.tsx and their semantic test selectors after this lane had already committed them.
- **Options:** Revert committed working migration; concurrently rewrite it; report the existing commit and stop further edits.
- **Chose:** Report6c1b22c9 and the three exact files immediately, retain the completed migration and session enrollment/dependency, and make no further edit to those files. Sent the same coordination to the observed exact lane8 omp terminal; receipt accepted:true/input_accepted, not a claim of delivery/turn start. Lane8's announced /tmp artifact was absent when checked.
- **Why:** The interjection explicitly allows reporting already changed files; reuse avoids two presentation migrations while preserving that lane's ask/notifications/structured ownership.
- **Evidence:** User interjection;6c1b22c9; Orca exact worktree/agent terminal discovery and send requestc68576f8-83cd-411e-88ef-86e2c9f307b1.
- **Reversibility:** easy
- **Confidence:** high for local file/receipt facts
- **Revisit if:** Canonical land reports an actual source conflict.
- **Source:** locked by user ownership interjection

## Progress

Ready for canonical land. Current source and all four plugin migrations complete; sole catch-up retained incoming shared-system contracts and eight-plugin lint enforcement. Final caught-up typecheck/build and isolated current-source proof passed within D12 limits; suites/review/full dogfood/golden scoring remain unrun under build-first. Every worker returned and component worktrees removed. All owned browser handles released; both exclusively owned browser services stopped. Scoped daemon/PTY cleanup printed AGENTS25_CLEANED; its lingering readline process was then explicitly stopped through the service owner. No product flow deferred or review-only follow-up added. Next: commit receipts, detach and canonical queue land; after success remove owned scratch/helper files and end exactly this item.
