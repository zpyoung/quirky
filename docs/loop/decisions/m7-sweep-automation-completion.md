# m7-sweep-automation-completion decisions

## D1: Complete independent local provenance and actual phone composition
- **Question:** Which remaining flows can ship against the current landed owners?
- **Options:** infer attribution from api/name; add a parallel feature store; extend workspace metadata and actual phone pages.
- **Chose:** durable authenticated creation provenance, sidebar badge/navigation/deletion states, persisted desktop/phone hide filter and compact phone loop summaries.
- **Why:** automation dispatch currently passes createdBy api only; sidebar/filter lacks provenance; sb-mobile-app is now done and its actual workspace page explicitly disables the filter and omits summaries.
- **Evidence:** MapCompletion scout; packages/protocol/src/model.ts:22-97; plugins/quirky.automations/dispatch.ts:787-800; apps/mobile/src/pages/WorkspacesPage.tsx:44-50,148-180; prior sweep D9.
- **Reversibility:** medium (public attribution shape and persisted metadata)
- **Confidence:** high
- **Revisit if:** concurrent owner lands equivalent functionality before catch-up.
- **Source:** locked by docs/loop/decisions/m7-sweep-automation.md D9

## D2: Attribute only creation authorized by a live dispatch
- **Question:** How does a public worktree create distinguish real automation from arbitrary claimed snapshots?
- **Options:** trust supplied IDs/snapshots; infer from current run; consume an opaque single-use dispatch capability.
- **Chose:** new public WorktreeAutomationProvenance and request types; request token bound to automation/run/resolved repository and live dispatching state. Worktree calls quirky.automations/claimWorkspaceProvenance before side effects and persists the returned immutable snapshots with its row. Existing createdBy remains api; existing-workspace runs receive no attribution.
- **Why:** feature doc uses dispatch-authorized creation. A name prefix or generic api value cannot prove provenance; definition deletion must not erase snapshots. Restart-stranded dispatches already fail closed without automatic replay.
- **Evidence:** automations.md entry points and renderer creation provenance; dispatch.ts:787-828; worktree/src/daemon/create.ts:509-539; store.ts:53-109,141-178.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** public host routing extends local-only creation authority or exact-once retries are introduced.
- **Source:** assumed — autonomous

## D3: Resolve standard gray areas with existing surfaces and truthful uncertainty
- **Question:** What are the Visual/API/Data/Integration defaults for unattended brainstorming?
- **Options:** redesign cards/pages; extend current layouts and public navigation; add hidden-only state.
- **Chose:** current layouts with accessible badge/details/actions; immutable ID navigation; explicit checking/missing/history-unavailable/read-failure states; existing persisted client preference scope and phone storage; no heuristic backfill. Hide is off initially. Compact phone labels use completed counts/caps/reasons and deterministic needs-you/running/paused priority. Failed/disconnected reads invalidate cached labels; successful empty removes them. Full history and mutations stay denied to phones.
- **Why:** preserves essential consumers/purpose, scope, constraints, success scenarios and observable safety. Logic spec A1–A5 gives before/after examples and all consequential defaults. No human/visual/adhd prompt or external research swarm in this unattended loop.
- **Evidence:** automations.md:25-28; fork-loops.md:11-14; specs/2026-10-28-m7-sweep-automation-completion/logic.md Decisions Locked and A1–A5; sb-mobile-app D2,D7,D10.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a concrete consumer contract contradicts the chosen presentation.
- **Source:** assumed — autonomous

## D4: Keep SSH ledger flow whole behind the missing public authority
- **Question:** Can this item safely implement SSH workspace ownership/routing/import/evidence and selected-runtime availability now?
- **Options:** treat remote paths as local; invent ledger-private SSH generations; defer the isolated flow and ship independent local work.
- **Chose:** defer only this flow to one prerequisite-gated follow-up before land. Do not duplicate existing remote automation owners and do not add metadata-only scaffolding.
- **Why:** protocol has local Repo/Worktree paths and no host registration/incarnation/filesystem authority. Ledger normalization/import/evidence dereference local paths. Host fields are metadata, not an execution route. Canonical remote dispatch item is blocked; remote UI remains its existing owner.
- **Evidence:** MapLedgerHost scout; ledger/src/daemon/owners.ts:7-56,135-169; content.ts:29-52,169-190; imports.ts:195-251; engine.ts:755-800,1030-1070; prior remote dispatch D1–D4; canonical queue status.
- **Reversibility:** easy
- **Confidence:** high for inspected contracts; no remote runtime behavior claimed
- **Revisit if:** public host registration/generation lookup, remote workspace identity and fenced filesystem/execution land.
- **Source:** deferred: SSH ledger ownership/routing/import/evidence/selected-runtime availability

## D5: Apply one-spec build-first workflow with three disjoint implementers
- **Question:** Which workflow gates and worker contracts apply?
- **Options:** ordinary reviews/suites/dogfood now; current authoritative one-spec build-first mode.
- **Chose:** combined logic spec with final tech contracts; commit shared protocol types before at most three omp/OpenAI task implementers. No worker checks/commits. Parent integration owner runs final typecheck; broader tests/reviews/dogfood remain end-phase-owned. Reviewer pairing would be omp-task + cross-family reviewer when end phase requires it; no review dispatched now. Preserve inherited .serena unchanged through explicit paths and isolated worktrees.
- **Why:** current LOOP Build first overrides ordinary skill phases. Developer verification still requires narrow runtime evidence for changed behavior; this is not a broad suite or UI dogfood campaign. No language server is configured, as actual xd://lsp status reports.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md; xd://lsp status; initial git status shows only inherited untracked .serena.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** m7-test-triage starts end phase or typecheck reports integration diagnostics.
- **Source:** locked by docs/loop/LOOP.md

## D6: Restore the attributable misplaced worker patch without touching user state
- **Question:** How to handle a sidebar worker edit accidentally sent to a relative parent path?
- **Options:** accept malformed parent code; discard unrelated state; revert only the attributable patch and enforce absolute paths.
- **Chose:** parent read the file and HEAD baseline, attributed the exact diff, then reverted those changes through anchored edits. Worker continued only in its assigned tree after acknowledging the boundary. No unrelated state or inherited .serena was touched.
- **Why:** the malformed patch included a literal PUT directive and replaced the activate case opener. It was entirely this worker's change, not user work. Silently committing it would bypass the component barrier.
- **Evidence:** BuildSidebar self-report; parent file snapshot D573; exact git diff for sidebar-extras-ui.test.ts; restoration edit C6A4.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** another path crosses the assigned worktree boundary (stop that writer).
- **Source:** assumed — autonomous

## D7: Integrate three scoped components and retain written consumer regressions
- **Question:** Did the implementation remain within the committed public contracts?
- **Options:** accept reports without attribution; audit worker HEAD/scope at the settled barrier and integrate explicit paths.
- **Chose:** backend3f39d14b, sidebar28855c30 and phoned85a58a9 integrated after all workers returned. Each HEAD remained dbb01d3a; explicit owned paths only, inherited component .serena excluded. Removed each component worktree immediately after merge. Approved sidebar CLI file scope to complete the persisted filter's actual scriptable flag.
- **Why:** provider/storage, sidebar/preference and phone/policy components have disjoint source scopes. Structural plugin validation found no manifest/schema/provider/CLI mismatch across the four changed plugins; this is not a semantic code-review result.
- **Evidence:** component audit and commit/merge tool receipts; ValidateCompletionPlugins returned PASS structure-only, zero scoped warnings. New acceptance files: automations/test/provenance-api.test.ts; worktree/test/automation-provenance.test.ts,automation-sidebar.test.tsx,automation-sidebar-api.test.ts; mobile/test/loop-summaries.test.ts. Existing dispatch/sidebar-extras/mobile page/authorization consumers updated.
- **Reversibility:** medium
- **Confidence:** high for attribution/declarations; suites deliberately not executed
- **Revisit if:** end-phase consumer execution finds a behavioral gap.
- **Source:** assumed — autonomous

## D8: Repair observed integration diagnostics without weakening assertions
- **Question:** What did the typecheck and narrow runtime scenario actually find?
- **Options:** suppress diagnostics; defer a broken implemented path; repair each concrete source/type boundary.
- **Chose:** add the missing issue-time `const now = clock()` to provenance issuance; restore accidentally omitted separatorEnabled and mobile collapsed/open/toggle callbacks; type the provenance expected snapshot and capability assertions; use the repository-relative git testing import; update the existing no-provenance Tree fixture with neutral new props.
- **Why:** first real API run failed with `Automation dispatch failed: now is not defined` before workspace creation. Typecheck independently reported that free identifier plus four test/prop typing boundaries; second typecheck reached mobile and identified omitted existing render callbacks. No exception suppression, changed acceptance expectation, or broad test-failure debugging was used.
- **Evidence:** bg5 actual daemon failure; bg4 ten diagnostics; bg9 mobile RenderContext diagnostic; successful bg8 public API scenario after clock repair. Smoke's separate early dispatch_failed expectation was a fixture mistake: structured registration can return dispatched before native resolution; corrected scenario explicitly stops its returned structured session rather than asserting no launch.
- **Reversibility:** easy
- **Confidence:** high for observed failures and scoped repairs; final merged typecheck still required
- **Revisit if:** final typecheck or consumer execution reports another actual diagnostic.
- **Source:** assumed — autonomous

## D9: Record narrow runtime evidence without claiming suite, app or native clearance
- **Question:** What runtime proof is required before delivering these significant changes?
- **Options:** type-only claims; full forbidden pre-triage dogfood campaign; scoped temporary-home API and actual component observations.
- **Chose:** one real daemon/public API scenario and two ephemeral browser component surfaces. No acceptance suite, packaged app build, final semantic review, physical phone, native shell, notification or full-app dogfood run.
- **Why:** developer verification requires exercised behavior. API scenario created a generic API workspace and new-per-run automation workspace, rejected a forged request before creation, checked snapshots/no token leakage, proved ordinary API visibility and persisted hiding, renamed/deleted definition, restarted daemon and observed retained attribution/filter. Structured session was explicitly stopped; daemon/home cleanup awaited. Browser mounted production PageApp/WorkspacesPage and production Tree/useAutomationAvailability against controlled read fixtures, not a replacement UI.
- **Evidence:** bg8 exit0 in1.72s; phone browser390x844 showed detailed and compact `Loop 2/2 · paused: iteration cap reached`, saved filtering left only wt-ordinary, disconnect reported `Loop 2/2 · unverifiable`, no page errors. Desktop browser520x700 showed badge/snapshots, exact uiNavigate automation-original/run-original despite newer run, disabled only missing run, distinguished deleted definition and failed check. Ephemeral renderer initially had wrong guessed dependency paths and then two React versions; actual Bun resolution corrected fixture imports only. Tabs released and both final component services stopped.
- **Reversibility:** easy
- **Confidence:** high for exercised boundaries; physical/native/full-app visual fidelity unverified
- **Revisit if:** end-phase full app/native acceptance contradicts the component or API result.
- **Source:** assumed — autonomous

## D10: Retain the single unbuilt remote-ledger flow with its prerequisite
- **Question:** How is the independent remote ledger gap kept actionable without duplicating existing owners?
- **Options:** silently omit; duplicate remote automation work; one explicit ledger-only prerequisite follow-up.
- **Chose:** canonical queue add of m7-ledger-remote-host-flows, depending on this item. It names ownership/routing/import/evidence/selected-runtime availability, prohibits local SSH path reads, and instructs the claimant to block while the public host foundation is absent.
- **Why:** D4's isolated flow can remain deferred while durable local provenance and actual phone composition ship. There is no new test/review/debugging follow-up.
- **Evidence:** authoritative absolute queue.ts add /tmp/quirky-l12-remote-ledger-followup-r8.json returned exit0; MapLedgerHost and prior blocked remote-dispatch decision.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a public host foundation lands before that item's implementation.
- **Source:** deferred: SSH ledger ownership/routing/import/evidence/selected-runtime availability

## D11: Preserve concurrent panel admissions and local owner boundaries at catch-up
- **Question:** Which intent wins the single bridge-policy merge conflict?
- **Options:** keep only summary validation; keep only notification validation; compose independent bounded admissions.
- **Chose:** merge5478ed07 preserves read-only empty-parameter loop summaries plus incoming notificationTest, bounded notificationPoll and notificationCancel validators. Preserve all auto-merged panel routes/grants, source identity and host-power/orchestration lifecycle changes.
- **Why:** these methods have independent authorities; dropping either would erase a landed feature. No new incoming decision supplies the missing remote workspace registration/filesystem foundation.
- **Evidence:** conflict bridge-policy.ts:102–114, resolved DA34; final merged bridge smoke accepted summaries and notificationTest, rejected summary selectors and full loops/list; bg11 public API lifecycle exit0 in1.81s. ReadCatchupDecisions read all five parent-enumerated incoming logs: m4-hosting-ui-review-browser-routing, m5-loops-ui-visible-stop-close-review, m6-heimdall-host-power, m6-orchestration-idle-pointer-shutdown, sb-mobile-app-panels. Initial scout enumeration was unavailable; parent supplied the exact Git-range list, then scout read every listed log.
- **Reversibility:** easy
- **Confidence:** high for faithful contract composition; full suites remain unrun
- **Revisit if:** final typecheck or end-phase acceptance reports an integration mismatch.
- **Source:** locked by docs/loop/decisions/sb-mobile-app-panels.md D21

## D12: Delete incidental authorization-table assertions instead of repinning their import
- **Question:** How to fix the merged mobile test's removed allowlist import?
- **Options:** restore the table import to re-pin implementation membership; keep observable authorization-boundary assertions.
- **Chose:** delete only the two Object.hasOwn(MOBILE_METHOD_ALLOWLIST, ...) assertions in the new summary policy test. Retain accepted empty parameters, rejection of extra/identity fields and denial of full history/mutation methods.
- **Why:** incoming panel work removed the implementation-table import. The final merged typecheck reported two undefined names. Table-membership assertions duplicate wiring; the consumer-visible allow/deny boundary remains covered without importing the table.
- **Evidence:** bg10 typecheck two TS2304 diagnostics at authorization.test.ts:39,48; anchored deletion3353. No behavior assertion weakened and no new test execution.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** end-phase API acceptance disproves the public authorization boundary.
- **Source:** assumed — autonomous

## Progress
Final catch-up5478ed07 complete; all five incoming decision logs read and no new authority conflict found. Merged API lifecycle and strict bridge permission smoke passed (D11). Final `bun run typecheck` bg13 exited0 in23.45s, covering root and apps/mobile after the merged assertion cleanup. The single remote-ledger follow-up was added. All agents returned and component services/tabs are stopped. Commit this test/documentation delta, detach and invoke authoritative absolute queue.ts land m7-sweep-automation-completion; wait for land and the outstanding follow-up deps command before ending. Suites/reviews/full-app/native dogfood remain end-phase-owned. No other unbuilt flow is silently dropped.
