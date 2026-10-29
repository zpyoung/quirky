# fix-test-orchestration-1028 decisions

## D1: Repair observed end-phase failures without weakening authority
- **Question:** Which workflow and contracts govern the claimed failure item?
- **Options:** build-first feature shortcut; end-phase diagnosis and verification.
- **Chose:** End-phase systematic diagnosis, existing behavioral regressions, canonical affected suite and required gates. No brainstorming/spec for a fix item. Separate federation transport/placement from local Ask/migration and preflight authorization.
- **Why:** m7-test-triage has landed and this item names its orchestration failures. Its referenced raw artifact URI is unavailable in this session; the same baseline output was subsequently found at `.quirk/build-loop/m7-test-triage/suite.log`. The committed grouped evidence remains authoritative.
- **Evidence:** docs/loop/reports/m7-test-triage.json groups.plugins/quirky.orchestration; docs/loop/LOOP.md End phase/Fix items.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a failure crosses another repair owner's boundary.
- **Source:** locked by docs/loop/LOOP.md

## D2: Keep exact remote identity, settlement and private-home invariants
- **Question:** May failures be repaired by relaxed selectors, method ceilings, caller authority or local fallback?
- **Options:** compatibility aliases and relaxed fences; trace producers and fix their actual contracts.
- **Chose:** No aliases, local fallback, spoofed evidence or changed authority. Preserve exact host placement, durable FIFO, committed home verdict before host settlement, archive-before-release, authenticated owner-namespaced callbacks and unknown-is-not-exited. Preserve isolated process homes/cleanup and leave other lane's structured/main.ts wait bridge untouched.
- **Why:** Earlier federation/Heimdall/core decisions bind this repair. No language servers are configured; use scoped source mapping.
- **Evidence:** m7-orchestration-worker-federation D2-D5,D10-D11; m7-orchestration-heimdall-unbuilt-flows; actual xd://lsp status.
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** evidence conflicts with a locked contract; record rather than silently override.
- **Source:** locked by docs/loop/decisions/m7-orchestration-worker-federation.md

## D3: Invalidate cached live terminal authority before asynchronous exit refresh
- **Question:** Why did a background Ask remain pending after the exact PTY exited?
- **Options:** infer exit from absence; poll or retry Ask; invalidate stale liveness before the existing independent proof refresh.
- **Chose:** On kernel PTY exit notification, remove the matching cached live authority synchronously, then run the existing exact host/PID/creation-time refresh. The intermediate state is unknown, not exited. Ask source and connection admission remain unchanged.
- **Why:** The kernel exit listener began an async list request but left live authority cached. The session changed event could reach Ask first, whose reconciliation returned on that stale live identity; no later event retried it. The new public plugin exit-observer regression failed twice with live:true, and the original A2 Ask case failed twice after fixing fixture dependencies. After synchronous invalidation both cases passed in the canonical two-file run.
- **Evidence:** packages/daemon/src/session-authority.ts onExit; packages/daemon/test/runtime-authority.test.ts exit subscriber regression; plugins/quirky.orchestration/test/acceptance-api.test.ts A2; canonical runs 1793232263164-50906,1793232309087-55766 and passing bg9.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** exact-process replacement or disconnect regressions show that unknown is being mistaken for exit.
- **Source:** assumed — autonomous

## D4: Preserve stable peer denial codes without exposing private error messages
- **Question:** Why did a bootstrap method-ceiling rejection return 409 rather than 403?
- **Options:** weaken the ceiling; normalize the actual orchestration error envelope.
- **Chose:** Read stable `error.data.reason` before string `error.code`, retaining generic response text. Keep authentication, pin, revision, incarnation and method checks unchanged.
- **Why:** orchestrationError stores its stable reason under data.reason; safeReason ignored it, replacing a real peer_unpaired/peer_method_forbidden denial with peer_call_failed. Existing bootstrap and forbidden-method HTTP regressions exercise the real listener.
- **Evidence:** src/errors.ts orchestrationError; src/peers.ts safeReason/handleRequest; historical suite.log peer-transport block.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** an allowed peer method emits an untrusted reason rather than the documented stable code.
- **Source:** assumed — autonomous

## D5: Exercise paired hosts as separate real daemon processes
- **Question:** Why did peer tests leave mail timers reading inactive stores?
- **Options:** hide timer errors; reorder component disposal; copy plugin code; use actual independent daemon processes.
- **Chose:** Migrate the two paired in-process test files to existing real-process acceptance fixtures. Preserve original production shutdown order. Remove the attempted mail-first reorder and plugin-copy experiment rather than shipping changes that did not address the root cause.
- **Why:** A temporary Bun experiment proved two symlink import aliases return the same module object and overwrite each other's state. In-process home/host activations therefore shared module-global service/disposal ownership, plus ambient process environment. Mail-first teardown did not fix the failure. Copying sources removed the timer errors but still misrepresented provider HOME/PATH and login-shell discovery. Separate real daemons match the production boundary without compatibility aliases or environment shims.
- **Evidence:** actual `bun /tmp/quirky-l8-module-probe.ts` exit0 reported sameModule:true, home:host, host:host; canonical artifact27 retained timer errors after reorder; copied-fixture run bg13 removed timers but retained provider unavailability; existing WorkerAcceptance and startAgentsE2E fixtures.
- **Reversibility:** easy
- **Confidence:** high for reproduced module collision; migrated acceptance verification pending
- **Revisit if:** real independent daemons exhibit the same lifetime failure.
- **Source:** assumed — autonomous

## D6: Repair faithful acceptance inputs and remove incidental assertions
- **Question:** Which reported failures were unsupported fixture inputs or assertion-library misuse rather than production defects?
- **Options:** add floating aliases, relax authentication, pin new wording or migration counts; use actual public setup and behavioral assertions.
- **Chose:** Include quirky.cli in both private builtin sets because worktree now requires it; use registered host workspaces only for existing remote placement; pair status-read peers reciprocally; publicly refresh both fake provider detections and prove distinct local/remote model snapshots; supply the heartbeat's required subject. Assert synchronous preflight denials through stable consumer_fenced plus zero mutation, removing the mock-forwarding test. Remove copied seed/schema/version/default-inventory and UI wording pins. Archived output checks exact provenance and known captured Ready bytes rather than equating live/archive identity encodings.
- **Why:** Current missing-method failures came from the absent transitive CLI dependency. Historical placement and mail failures occurred before valid federation effects. Agent detection caches startup misses; bootstrap is intentionally status-only. Bun rejects .rejects applied to an async function rather than a promise. Additional federation migrations legitimately follow policy; archive content/metadata derives a distinct identity.
- **Evidence:** first canonical current run artifact6 (15/26 files pass); fixture.ts; worktree manifest dependencies; peer transport model fixtures; setup-migration/public data checks; federation-engine/mail/surface tests; submission-preflight tests; workers/output.ts archive identity.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** canonical execution exposes a consumer defect after these valid setup preconditions.
- **Source:** assumed — autonomous

## D7: Coordinate disjoint source owners and use a reachable cross-family final reviewer
- **Question:** How are implementation and neighboring repair boundaries enforced?
- **Options:** concurrent overlapping writers; disjoint absolute path scopes with parent-owned fixture, lifecycle and kernel integration.
- **Chose:** Three omp/OpenAI implementers, no worker checks/commits; parent owns shared files and final gates. Public API signatures are unchanged. Actual Opus probe unavailable; Gemini google/gemini-3.1-pro-preview:high is ready for the one final C/S/X promote/refute round. No review has passed yet.
- **Why:** Worker scopes cover peer transport, federation acceptance and preflight assertions without shared writers. All returned with unchanged HEAD 2c352058. Ask/packages-daemon repairs were already done; sent the kernel boundary to Ask lane12 and Sessions lane3. Lane12's explicit reply reports no conflict and accepts unknown-before-refresh with unchanged credentials/admission. The structured wait bridge stays with lane10.
- **Evidence:** task transcript/path audit; actual pi-watch probes; accepted Orca send receipts (input acceptance only); /tmp/quirky-lane8-orchestration-reply.md; xd://lsp reports no configured servers.
- **Reversibility:** easy
- **Confidence:** high for completed source integration; final assurance remains pending
- **Revisit if:** another owner reports an overlapping source edit or final review cannot run.
- **Source:** assumed — autonomous

## D8: Distinguish operator close from unexpected process exit in federation acceptance
- **Question:** Why did the added mail scenario fail to settle the home attempt after closing the host session?
- **Options:** classify an operator kill as infrastructure failure; generate the intended unexpected exit with the exact owned process.
- **Chose:** Match the recorded host worker `started` PID, then signal that exact private fixture process as the existing surface regression does. Retain the intentional refusal of operator_close/killed lifecycle reports.
- **Why:** session/close calls PTY forget, which kills and removes the terminal. The federation lifecycle deliberately does not treat that operator action as an unexpected process failure. The test's desired transition requires a positively observed unexpected exit, not a different interpretation of operator intent.
- **Evidence:** federation-mail-acceptance terminal scenario; packages/pty-host/src/session.ts forget; workers/lifecycle.ts operator_close/killed guard; federation-surface exact worker PID scenario.
- **Reversibility:** easy
- **Confidence:** high for source distinction; canonical proof pending
- **Revisit if:** the observed exact process exit does not reach the durable host observation and home settlement.
- **Source:** locked by docs/loop/decisions/m7-orchestration-worker-federation.md

## D9: Prove the changed runtime boundary through actual executables
- **Question:** What does smoke verification establish beyond typechecking and unit assertions?
- **Options:** infer behavior from tests; use live user state; launch owned private real daemons, PTYs, providers and CLI children.
- **Chose:** A throwaway executable scenario launched two private real daemon/PTY processes, refused bootstrap mutation with HTTP403/peer_unpaired without leaking its credential, inspected the exact peer through launched CLI, started the worker on the host only, stopped only that worker and preserved both coordinators. Cleanup removed both private homes. Remove the throwaway sources after proof.
- **Why:** The canonical one-file smoke passed with no retries in18.06s. Its first attempt used the wrong peer-status flag (--id); replacing it with documented --peer corrected only the smoke input. The canonical runner suppresses successful stdout, so the receipt claims the passing scenario, not independently observed JSON output.
- **Evidence:** `bun scripts/suite.ts plugins/quirky.orchestration/test/runtime-repair-smoke.test.ts` bg15 exit0,1passed/0failed/flaky:[]; private runtime-smoke-receipt.json. Both throwaway sources removed after passing.
- **Reversibility:** easy
- **Confidence:** high for exercised private CLI/runtime behavior; no UI/native/full-suite claim
- **Revisit if:** the caught-up source changes these runtime contracts.
- **Source:** assumed — autonomous

## D10: Use real-process outer fixture budgets without changing product deadlines
- **Question:** How should the migrated acceptance cases account for starting actual daemons and provider processes?
- **Options:** keep the implicit5-second unit-test budget; extend product/RPC readiness timeouts; adopt the existing real-process acceptance outer budget.
- **Chose:** Explicit120-second outer budgets matching federation-surface's real-process convention. Preserve existing inner worker readiness and observed-state deadlines, exact identity, replay and lifecycle assertions.
- **Why:** These tests now execute actual daemon/PTY/CLI processes rather than one-process fake host calls. The outer test guard must encompass the already-declared multi-step operations and teardown; it is not a product retry or a relaxed readiness criterion.
- **Evidence:** federation-engine/peer-transport migrated cases; federation-surface existing120_000 cases; unchanged --timeout-ms and eventual-state budgets.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** real execution exceeds a product boundary rather than the fixture guard.
- **Source:** assumed — autonomous

## D11: Preserve all contracts from the single roadmap catch-up
- **Question:** Did incoming Heimdall, Loops and Accounts work change this repair's authority?
- **Options:** reinterpret incoming behavior; reconcile the complete logs and keep their existing owners.
- **Chose:** Merge build/roadmap once after49ff9515 and read all three incoming decision logs, including raw long ending lines. Preserve Heimdall's exact mutation receipts, peer revision/incarnation and certified live identity despite null contact time; preserve Loops' owned lease-authenticated wait/cancel/drain bridge; retain UI-only Accounts/Vault control changes.
- **Why:** No binding conflict was found. The incoming loop boundary names these Orchestration failures as independently owned; this item neither duplicates the structured bridge nor changes Ask's wait guard.
- **Evidence:** Complete fix-test-heimdall-1028, fix-test-loops-1028 and ui-restyle-accounts logs; OrchestrationIncomingLogs scout; caught-up canonical typecheck exit0/32.91s; incoming-contracts.json private receipt.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** controller landing identifies a concrete concurrent source conflict.
- **Source:** locked by docs/loop/LOOP.md

## D12: Complete behavioral fixture transitions rather than bypass settlement or request schemas
- **Question:** What did real-process execution reveal after the initial fixture migration?
- **Options:** permit releasing active work and accept dispatchId as a task selector; honor the actual lifecycle and public request contract.
- **Chose:** Have the exact release target's real host process submit accepted worker_done before release; verify stopped/released processes are gone, retained/abandoned processes and both coordinators remain live. Inspect the process-exit Dispatch through its required taskId and wait for home failureCount1/statusfailed/process_exited before reading the owner projection. Replace peer-reader refusal wording pins with stable RPC Conflict.
- **Why:** The real worker-release correctly refused an unsettled Dispatch. Mail inspection used dispatchId against a taskId-only method. Its owner-only poll could then observe remote exited/assignmentfalse before the home lifecycle relay committed; the public authoritative workerShow transition is the correct synchronization point. No production aliases, lifecycle permissions or inner deadlines changed.
- **Evidence:** canonical bg16 and bg19 failures; workers/lifecycle.ts settled-Dispatch guard; dispatchShow schema; services/coordinator.ts workersForRun projection; surface's existing authoritative unexpected-exit regression; passing current27-file boundary plus typecheck in259.25s.
- **Reversibility:** easy
- **Confidence:** high for traced mismatches and current complete boundary proof
- **Revisit if:** actual valid settlement and task-qualified inspection still fail.
- **Source:** locked by docs/loop/decisions/m7-orchestration-worker-federation.md

## D13: Retain current passing scope without claiming the still-running full repository gate
- **Question:** What end-phase evidence is complete at final-review dispatch?
- **Options:** infer whole-repository success; record exactly the exercised passing boundary.
- **Chose:** Current canonical Orchestration plus kernel authority suite:27files passed,0failed,flaky:[], followed by successful canonical typecheck (UI lint/root/mobile/prepared desktop), combined259.25s. Caught-up full build passed with30plugins/26UI modules and retained missing-icon/no-release.baseUrl warnings. Real private executable smoke passed as D9 records. The full packages/apps/plugins/scripts run remains pending; no global suite pass is claimed.
- **Why:** Named acceptance cases now pass through valid public API/CLI and actual independent provider processes. No UI source changed in this repair, so no new visual/native acceptance campaign is claimed; setup UI tests preserve the unavailable-action behavior rather than wording.
- **Evidence:** bg21 full output; bg20 build; runtime-smoke-receipt.json; static plugin validation scoped PASS.
- **Reversibility:** easy
- **Confidence:** high for the completed gates only
- **Revisit if:** final review, the broader run or the controller identifies a concrete regression.
- **Source:** assumed — autonomous

## D14: Treat the writable reviewer as failed and restore the captured source exactly
- **Question:** Can a review pass stand when a supposedly read-only reviewer mutates the work product?
- **Options:** trust its empty findings; accept the unrequested reversions; stop at the source checksum boundary and recover only attributed changes.
- **Chose:** Reject the original correctness stage as assurance. Preserve its raw trace, restore the ten named source/test files to commit33412520 through exact committed reads and specialized whole-file writes, and verify every reviewed SHA256 against source-before.json (including the untouched fixture). Preserve parent decision changes and all unrelated files. Retry only the failed correctness stage with read/search/list tools and no shell; complete the already-judged S claim once rather than rerolling it. Rerun the current acceptance/type gates.
- **Why:** Despite explicit no-write/no-local-test instructions, C-promote ran checkout/show overwrites, applied the review diff backwards, ran prohibited local tests, and created three root probes. The checksum guard stopped C/S gate emission. All model processes returned before recovery. Exactly attributed test-fixture.ts, fix-fixture.patch and result.json were read and removed; the initial unrelated diagnostic probes remain untouched. No reviewer-authored product change is retained.
- **Evidence:** C-promote.attempt0.stderr lines29–38,54–66,87–168; bg22 exit1/1011.99s; source-before.json; RestoreReviewSource exact SHA256 receipt and tool history; one process inventory found no owned review/test/probe process remaining. No blanket process or temporary-home cleanup was performed.
- **Reversibility:** easy for restored files; lost review independence cannot be retroactively repaired
- **Confidence:** high for attribution and byte restoration; original C/S read-context assurance is explicitly limited
- **Revisit if:** checksum-protected read-only recovery cannot complete or a fresh gate finds a real regression.
- **Source:** assumed — autonomous

## D15: Reject the private-home allegation without reintroducing an unmanaged CLI child
- **Question:** Does using the existing E2E CLI helper instead of a nested operatorHome violate private-home isolation?
- **Options:** restore unmanaged Bun.spawn and redundant nested home; retain the helper's fresh per-test private home and process-scope cleanup.
- **Chose:** Retain fixture.cli. The original S1 is rejected: startAgentsE2E creates a new temporary HOME/QUIRKY_HOME for each test and explicitly passes them to its CLI child, then cleans the whole owned process scope and root. A second nested HOME is not the safety invariant.
- **Why:** The recorded S1 quote also cited a line range from the reviewer-mutated source, so the deterministic evidence gate suppressed it as falsified. Its complete suppression is an assurance limitation, not a clean spec-review claim. No accepted product finding or code fix follows from this allegation.
- **Evidence:** S-merged.json and S-gate.json (PASS,0blocking,1/1suppressed); plugins/quirky.agents/test/support/e2e.ts fresh root/userHome/explicit CLI env/cleanup; peer-transport credential-file scenario.
- **Reversibility:** easy
- **Confidence:** high for private-home behavior; limited original spec-review provenance
- **Revisit if:** the helper reads ambient real homes or fails to clean its owned child.
- **Source:** assumed — autonomous

## D16: Complete the bounded review recovery without a clean-review claim
- **Question:** Did the failed-stage recovery identify a product fix or preserve the source snapshot?
- **Options:** count suppressed claims as proof of completeness; repair unsupported allegations; retain exact machine results and parent rulings.
- **Chose:** C/S/X machine gates PASS with0blocking/0advisory/0contested, but C suppressed3/3 claims and S suppressed1/1. Reject C1 because exact identity comparisons and actual method-denial requests remain; reject C2 because the removed positive test was mock forwarding and the real federation owner registration path now passes; reject C3 for the same private-home evidence as S1. No accepted code finding or fix batch. All reviewed source-before/source-after hashes match.
- **Why:** The recovered correctness promote/refute ran with read/search/list only and no shell. Its refutation did not establish a universal coverage guarantee; complete suppression and the original mutable C/S context remain explicit limits. Separate post-restoration canonical27-file suite and typecheck passed again in262.21s, with no retries. This is exercised source proof, not retroactive validation of the unauthorized local reviewer tests.
- **Evidence:** recovered-summary.json, C-readonly-gate/manifests, S-gate, X-gate, source-before/source-after; bg23 exit0/117.19s; bg24 current27/27 plus canonical typecheck exit0; private review-traces.tgz and verified-boundary.json.
- **Reversibility:** easy
- **Confidence:** high for unchanged bytes and passing exercised gates; bounded review assurance only
- **Revisit if:** a consumer regression demonstrates a missed safety transition.
- **Source:** assumed — autonomous

## D17: Keep the full consumer failure inventory and route uncovered cases explicitly
- **Question:** Does the broad common-kernel consumer run pass, and who owns its remaining failures?
- **Options:** claim only the small green gate; repair every other lane's area here; preserve the full red inventory and assign exact uncovered cases.
- **Chose:** Record full command exit1/2742.89s:877remote files,682passed/195failed, no retries because the failure count exceeded the runner cap. Mac13files initially10passed/3failed; Browser extras still failed its retry, which stopped before Mobile/Terminal retries. Scripts were included and reported no failed script file. Preserve198 unique failed-file headers and exact test/error names in the private full-consumer-failures.json. The two old Orchestration fixture failures in this broad snapshot are closed by the subsequent current27/27 gates, including the post-restoration repeat.
- **Why:** The broad snapshot preceded the final test-only fixes and several later lands by other lanes; it is not a current integration certification or195 newly diagnosed product bugs. Existing active/queued Git, Tasks, Terminal, Vault, Hosting, Handoff, Worktree, Ledger, CLI, Repo, Agents, Accounts, Protocol, Reviews, sidebar and Browser/mobile/sessions owners remain authoritative. Eight accepted one-off Orca sends shared the exact inventory with active owners; those receipts prove input acceptance only. No aliases or other-plugin patches were added here.
- **Evidence:** bg17 full raw output/run1793233308424-27725; full-consumer-failures.json and coordination-receipts.json; actual integration queue ownership read; bg24 current Orchestration/authority27/27 plus typecheck.
- **Reversibility:** easy
- **Confidence:** high for observed failure counts/names and routing; causes of other areas' failures remain unclaimed
- **Revisit if:** the canonical current integration reproduces an uncovered failure after its owning repair lands.
- **Source:** assumed — autonomous

## D18: Queue one concrete post-restyle shared-boundary repair rather than hide unowned cases
- **Question:** What about failures not named by the completed baseline repair titles?
- **Options:** lose them in broad output; duplicate every package repair; queue one exact shared-boundary packet.
- **Chose:** Canonical queue add created `fix-test-post-restyle-boundaries-1028`, depending on this item. It names the exact eight failing files/cases: daemon UI-kind/sidebar-activity declarations and daemon lock; shared design-system native field values; Ask controls/result summary and another-panel preservation; Notifications custom-path/report controls and loop-notification identity. It requires current integration first, canonical runner/private homes, removal of incidental mirrors instead of repinning, and no inferred load cause for lock results.
- **Why:** Those exact cases were absent from the completed baseline repair titles. The end phase is active, so newly observed test/defect repairs are normal runnable fix items, not an unbuilt-feature deferral or a second item claimed by this lane. Existing named baseline repairs are not duplicated.
- **Evidence:** integration queue read confirms statustodo/deps[fix-test-orchestration-1028]; /tmp/quirky-l8-shared-boundary-followup.json accepted by canonical queue add; exact selected rows in full-consumer-failures.json.
- **Reversibility:** easy
- **Confidence:** high for exact observed cases and durable queue ownership; the next owner must consume any newer fixes before editing
- **Revisit if:** current integration already closes a selected case.
- **Source:** assumed — autonomous

## Progress
All owned verification/review/agent jobs returned. Source remains exactly33412520; current Orchestration/authority27/27 and canonical typecheck passed after exact restoration. Build and real private executable smoke passed within recorded limits. One final review round/recovery complete, no accepted product finding open; provenance limits retained. Full common-consumer run remains truthfully red and is dispositioned by D17–D18, the complete private inventory, accepted coordination receipts and one durable uncovered-boundary queue item. Single catch-up already complete. Next commit these docs/BLOCKERS, detach, run canonical land for this one item and await the receipt; remove only owned scratch after success. No second claim/global completion marker.
