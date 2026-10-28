# m7-sweep-hosting decisions

## D1: Sweep all remaining GitHub flows and preserve the explicit exclusions
- **Question:** what does this parity sweep include beyond the four landed dependencies?
- **Options:** repeat only prior tests; audit both source documents and repair confirmed gaps; rebuild all hosting providers.
- **Chose:** audit every GitHub flow in hosting-api.md and hosting-ui.md, including earlier deferred GitHub flows. Exclude GitLab, Bitbucket, Gitea/Forgejo, Azure DevOps, Objective runner and PR sitter exactly as the claimed item specifies. Reuse quirky.hosting, quirky.tasks and quirky.reviews rather than create a second owner.
- **Why:** the queue explicitly asks for remaining flows, not only already-verified core behavior; roadmap parity and public scripting remain locked.
- **Evidence:** queue.ts wait --lane 8 returned m7-sweep-hosting; docs/roadmap.md:13–55; hosting-api.md and hosting-ui.md.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a confirmed gap requires changing a locked architectural decision.
- **Source:** locked by docs/roadmap.md; locked by item title

## D2: Use the unattended night-mode procedure and existing feature owners
- **Question:** how are brainstorm questions, specifications and implementation resolved without a person?
- **Options:** interactive questions; autonomous source-grounded defaults under LOOP.md.
- **Chose:** no asks or visual/adhd offers; one markdown logic spec with final technical contracts and self-review. Standard gray areas: API response/error/auth/rate-limit/pagination; Visual loading/empty/error/density/interaction; Integration auth/sync/conflict/retry/data mapping; Data persistence/ownership/idempotency; CLI flags/output/errors. Source-defined behavior and prior decisions win; explicit unknown/unavailable states beat fabricated empty success. API/CLI remain canonical for UI state and operations. Inspect earlier followups rather than treating them as exclusions.
- **Why:** authoritative LOOP.md night mode applies: observed local time 2026-10-28T02:47:48-0500, before its 4am target. Existing providers own auth and policy; renderer must not shell out or import private daemon internals.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md; m4-hosting-api-github D4–D10; m4-hosting-ui-tasks D3/D5/D8/D9; m4-hosting-ui-reviews D3/D5.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** this item's runtime evidence contradicts a prior binding decision; name and supersede it explicitly.
- **Source:** locked by docs/loop/LOOP.md

## D3: Pair OpenAI task implementers with the reachable Gemini reviewer
- **Question:** which reachable cross-family pair satisfies an omp lane?
- **Options:** task+Opus; task+Gemini; same-family fallback.
- **Chose:** IMPLEMENTER=task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini high. At most three disjoint implementation components; contracts committed before dispatch. Parent audits scope and owns all acceptance commands; workers skip checks/commits. Preserve unrelated untracked .serena state. RUN_BASE=2d00b2931121b5f1bf309d7dd155ea33d94d6c9b.
- **Why:** actual pi-watch --check reports Opus/Sonnet unavailable, Gemini google/gemini-3.1-pro-preview:high ready; Bun1.4.0 available. LSP status reports no configured language servers.
- **Evidence:** observed preflight output; xd://lsp status; git branch created from build/roadmap. Commands: bun run build; bun scripts/suite.ts for changed/importing directories; bun test scripts; bun run typecheck; queue.ts land owns whole-suite gate.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual reviewer dispatch fails; follow documented fallback and record it.
- **Source:** locked by docs/loop/LOOP.md

## D4: Repair three confirmed gaps without changing source-control ownership
- **Question:** which remaining flows are actionable and how should independent implementation be partitioned?
- **Options:** verify-only sweep; focused repairs in current owners; broad forge rewrite.
- **Chose:** one wave of three disjoint components: Hosting search batching/cursor reuse, repository-owned Project issue types with Tasks picker gates, and Reviews Browser routing with exact-worktree callers/descriptor. No semantic dependency edges or checkpoint round. Parent owns legacy fixture alignment, docs and final integration. Lane11 retains Git WorktreePanel/ladder/CommitArea/Markdown notes; public review lookup/createOpen contracts stay unchanged.
- **Why:** scouts found concrete deferred source paths, not speculative feature requests. Existing owner boundaries cover all three without a new provider or kernel abstraction.
- **Evidence:** HostingApiCoverage and HostingUiCoverage reports; item-search.ts:88–133; project-mutations.ts:250–256; ProjectsSurface.tsx:627–665; reviews/ui.tsx:129–137; user lane11 coordination; /tmp/quirky-lane11-hosting-sweep-reply.md.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a required behavior needs another public contract; publish it rather than copy uncommitted foreign source.
- **Source:** assumed — autonomous; locked by user lane11 ownership

## D5: Follow repository owner capability, not Project owner
- **Question:** how should a personal Project containing an organization Issue discover and change issue types?
- **Options:** preserve temporary unsupported boundary; use Project-owner types; inspect the actual content repository owner.
- **Chose:** query Repository.owner typename and Organization.issueTypes; personal repositories return no organization types. Validate type availability/enabled state, page shape/cursor/issue identity and mutation readback; invalidate after accepted provider writes before response validation. Remove matching Project-owner UI gates. Preserve existing Project-field clear; no invented new Issue-type clear selector.
- **Why:** Project containers do not own their items' repository types. A missing/malformed connection is unavailable, not an authoritative empty list. This completes the temporary D38 ownership deferral without changing ambient Project authentication.
- **Evidence:** m4-hosting-api-github D38; actual ownership RED unsupported_operation, then2pass21assertions; malformed-page RED resolved unexpectedly, then final3pass31assertions in11.81seconds. Actual picker/web proof still pending.
- **Reversibility:** easy
- **Confidence:** high for API regressions; UI not yet verified
- **Revisit if:** GitHub changes supported RepositoryOwner/type connections.
- **Source:** supersedes m4-hosting-api-github D38 (temporary user-Project unsupported boundary only)

## D6: Correct fixture transport assumptions before accepting a red test
- **Question:** can setup/parser failures stand in for missing feature behavior?
- **Options:** count every red as TDD evidence; repair isolation/fixtures and observe the actual missing behavior.
- **Chose:** fixed a nested fixture template parse error, recognized host-qualified gh arguments, included Browser's real Editor dependency and used declared Browser methods before settings. No production deadline/semantic assertion relaxed. Search RED then returned correct rows/counts but made12provider calls instead of2 and replayed the first cursor block; Reviews RED reached a false app-route result with Browser active.
- **Why:** missing fixture data and unavailable plugin registration prove neither batching nor route behavior. Source tests must describe real provider transport.
- **Evidence:** bg5/bg8 fixture failures; bg11 two behavioral failures in5.62seconds; bg6/bg9 setup errors and bg12 actual route failure in4.12seconds. Baseline packaged Projects discovery worked, then fixture viewer/mixed-owner assumptions failed; guarded run20261028T075709-4945 is partial, not a product pass. Its service exited0 after owned cleanup.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a provider fixture again accepts an impossible shape or bypasses a required validation.
- **Source:** assumed — autonomous; locked by LOOP.md isolated-state and evidence requirements

## D7: Reconcile overlapping queue ownership through committed source only
- **Question:** another lane claimed the predecessor's API-parity followup while this sweep was building the same two repairs.
- **Options:** competing rewrites; copy dirty files; share isolated committed implementations and preserve independent acceptance.
- **Chose:** publish9cc24e68/eafde4d7 and6867676f; lane6 consumed the first two asaae21422/98a52de5 and retained independent regression/fixture work. Publish539aa1c9 for the observed picker correction. No foreign uncommitted source, queue edits or lookup/createOpen contract changes. Lane11 keeps Git panel/Markdown ownership.
- **Why:** the sweep includes earlier deferred flows, but queue titles overlap. Committed source avoids two incompatible implementations and gives each owner a reviewable baseline.
- **Evidence:** /tmp/quirky-lane8-hosting-parity-reply.md; accepted terminal messages toterm_db8088c9-c1ce-4c3f-8494-a392afc25805; /tmp/quirky-lane11-hosting-sweep-reply.md. The source-sharing receipt is not another lane's landing or verification result.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** another lane's independent boundary regression exposes a defect in this committed implementation.
- **Source:** assumed — autonomous

## D8: Keep model findings, autonomous rulings and protocol limits separate
- **Question:** what did the single final cross-family review actually establish?
- **Options:** report three clean passes; apply every hypothesis; adjudicate against the contract and retain limitations.
- **Chose:** actual Gemini high C/S/X promote and fresh refute stages over the frozen21d10e8b source. Reject C1: missing/unloaded source context deliberately refuses rather than choosing another workspace; this is a structured error, not an app crash, and every actual UI caller supplies its target. S1 was refuted because accepted/uncertain provider writes must invalidate stale cache; S2 failed evidence resolution. X promoted no findings.
- **Why:** an unproven fallback expectation conflicts with the exact-source/fail-closed contract. Machine verdicts do not decide product policy or certify untouched code.
- **Evidence:** /tmp/quirky-l8-hosting-review/C-gate.json NEEDS_FIXES (C1HIGH/LOWconfidence), S-gate.json PASS/two suppressions, X-gate.json PASS/zero findings; actual CLI prepass passed. C/S context contained code excerpts. Empty X claims made the excerpt tool fall back to877323characters of the full incoming diff; pi-watch hit ARG_MAX before launch. A bounded raw-pi @file retry on the same verified Gemini model completed, but that fallback included unrelated incoming docs/author reasoning. Therefore X refute lacks the intended context withholding despite its machine independence flag. No full independent-review guarantee or second review round is claimed.
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** a concrete missing-context caller or a stronger independent review contradicts this ruling.
- **Source:** assumed — autonomous

## D9: Preserve the actual selected type before async options load
- **Question:** why did a successfully saved Bug render blank after Board→Table?
- **Options:** eager-fetch/focus to conceal the gap; reset the saved value; render its current ID/name until options arrive.
- **Chose:** render the current option only when absent from loaded choices, keep the empty placeholder for no selection, and avoid duplicates. No new API, cache, focus manipulation or DOM-test framework.
- **Why:** the controlled select heldTYPE_BUG while its sole placeholder hadvalueempty. The provider and daemon already retained Bug. Loading choices on focus only hid a real display bug.
- **Evidence:** guarded20261028T093651-8202 obs7 selectedBug, obs11 blank selector (goalFAIL retained). Isolated one-line fix539aa1c9 had unchanged baseline/scope audit and a passing Project API regression. Fresh packaged20261028T095840-a759 passed its exact closure: savedBug visible before focus, Task selected, Board→Table retained visibleTask before refocus. Avatarfixture DNS console/network findings remain in that passing report. No native guest or live GitHub state touched.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** another async-choice control loses a valid current value on remount.
- **Source:** locked by hosting-ui.md visible field-edit behavior

## D10: Repair the missing provider read rather than suppress its UI error
- **Question:** why did the first packaged Review smoke show invalid details despite loaded REST review/comments/files?
- **Options:** ignore/suppress the error; relax detail validation; implement the missing real gh read in the isolated fixture.
- **Chose:** detailGhSource now implements gh pr view with exact requested JSON fields and host-qualified repository routing. Add a public Review hydration regression. The stronger fixture exposed one existing cross-repository test using source-owner GraphQL content for upstream-owner; provide explicit per-repository fixture responses without weakening source_mismatch or no-mutation assertions.
- **Why:** workItemDetails legitimately returned null when the fixture returned null for every pr view. Its absence had allowed metadata-only tests to miss the detail read. A source-qualified fake provider must not return another repo's body/identity.
- **Evidence:**20261028T100136-9f7f obs1 partial setup, no route action; new hydration API case passed1test/2assertions. First corrected Reviews gate4/5 files passed, one source-qualified detail case failed again on isolated retry; that actual failure remains recorded. Faithful runtime20261028T100616-138d rendered author/body/comments, actionable legacy rerun refusal and README patch; its UI Open on host revealed Browser with exactPR12 URL and the same feature workspace. Driver classified that final route UNSETTLED; formal goal remains partial, not manufacturedPASS. Web Native-unavailable disclosure is expected; no GitHub guest rendering is claimed.
- **Reversibility:** easy
- **Confidence:** high for traced fixture boundary and observed route
- **Revisit if:** the final corrected source-qualified gate or normal controller gate fails.
- **Source:** assumed — autonomous; locked by LOOP.md isolated-state/evidence requirements

## D11: Retain the larger remaining acceptance under its already-queued owners
- **Question:** does this focused repair/verification sweep establish all25 original Tasks scenarios, Project default-agent readiness and all native effects?
- **Options:** silently imply exhaustive parity; create duplicate followups; retain exact existing acceptance owners and bounds.
- **Chose:** do not claim an exhaustive25-flow web or live-provider campaign. Existing m4-hosting-ui-tasks-complete-remaining-flows owns the full built-web list/issue/composer/workspace/Project campaign, especially real Project direct-create/default-agent/ready-gated single context delivery, sticky-all later-repo/deep-link variants and overlapping source/view/write/index/comment-lag boundaries. Existing m4-hosting-api-github-parity is actively extending independent API boundary regressions from this source. Existing m4-hosting-ui-review-browser-routing retains broader stack/modifier/native routing acceptance; this sweep supplies its implemented core rather than silently marking that item done. New native handoff remains pending.
- **Why:** the item title permits larger remaining flows as followup work. These exact items already exist; adding duplicates would not complete their acceptance. ProjectLaunchSeam found a reachable implementation but no turnkey combined local-bare GitHub/real-PTY/default-agent fixture; separate feature tests are not end-to-end delivery proof. Only exercised outcomes are reported here.
- **Evidence:** current queue entries and titles read through queue.json; Tasks originalSC01–SC25; BLOCKERS Tasks deferred parity entry; ProjectLaunchSeam source/test map. Current guarded Projects run has SettingsPASS, layoutsPARTIAL because Today visibly scrolled toOctober but driver returnedNO_EFFECT, and the old typeFAIL closed by the separate passing rebuilt run. Larger/native acceptance is not deleted.
- **Reversibility:** easy
- **Confidence:** high for recorded ownership and evidence bounds
- **Revisit if:** the named followup supplies the missing composed acceptance evidence.
- **Source:** deferred: larger existing Tasks/API/review-routing acceptance, authorized by item title

## D12: Use the final composed checks and retain actual UI/tool bounds
- **Question:** which verification is current after catchup, the picker fix and faithful provider-fixture corrections?
- **Options:** reuse historical green claims; rerun the changed boundaries and distinguish every result.
- **Chose:** one normal roadmap catchup, all incoming Automation and Orchestration UI decisions read; no conflicting Hosting contract. First composed Hosting/Tasks/Reviews/Worktree suite57/57files/no retries; scripts68pass574assertions; root types/build passed. After539aa1c9: Tasks4/4files/no retries, full typecheck and packaged22-UI-module/29-plugin build passed. After source-qualified fixture repair: Reviews5/5files/no retries and final full typecheck passed. All owned model/check/smoke processes returned; each private runtime service exited0 after scope cleanup.
- **Why:** no source acceptance, visual failure or intermediate gate is relabeled. Model findings and broader/native acceptance remain qualified underD8/D11. A380-second remote Reviews invocation is recorded as a slow-suite advisory, not proof of a load cause: inspect per-file timings and slot wait before optimization; pytest-xdist is not applicable to this Bun suite, and no runner configuration changed.
- **Evidence:** bg26/27/28/29, bg37/38/36, failedbg40 then correctedbg41, finalbg42. Review/Project/picker reports named inD9/D10; all end reports and actual screenshots read. The first failed Project run intentionally kept its owned browser; it was explicitly closed after the report for unattended cleanup. No goal result was changed to obtain cleanup or a pass. Private review raw data/manifests are archived under `.quirk/build-loop/m7-sweep-hosting/`.
- **Reversibility:** easy
- **Confidence:** high for exercised checks and runtime paths; no exhaustive parity/native guarantee
- **Revisit if:** normal queue-owned merged verification reports a concrete failure or conflict.
- **Source:** locked by docs/loop/LOOP.md verification and normal landing procedure

## Progress
Ready for normal land: committed implementations and picker correction verified; generated CLI and actual rebuilt surfaces exercised; final changed-package/type/build gates green with intermediate failures/tool limits retained above. One catchup complete, incoming logs read, no owned agents/jobs/runtime services active, component worktrees removed. Existing larger/native acceptance owners remain explicit. Commit the final fixture/evidence documentation, detach and invoke the authoritative queue.ts land m7-sweep-hosting; wait for the actual controller result in this turn and handle only concrete recovery failures. No second work item.
