# fix-test-heimdall-1028 decisions

## D1: Repair the triaged Heimdall failures without changing authority boundaries
- **Question:** Which behavior and verification scope does this end-phase repair own?
- **Options:** relax assertions or authority checks; repair the root causes and retain behavioral regressions
- **Chose:** repair root causes across the eleven named Heimdall test files; coordinate any cross-plugin cause with its owning repair
- **Why:** The queue item explicitly requires consumer-visible repairs and removal rather than repinning of incidental assertions. Owner/worker identity and lease fencing remain binding.
- **Evidence:** docs/loop/reports/m7-test-triage.json groups[plugins/quirky.heimdall]; docs/loop/queue.json item fix-test-heimdall-1028
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** investigation identifies a necessary change owned by another repair
- **Source:** locked by docs/loop/LOOP.md

## D2: Use recorded baseline failures as the initial failing evidence
- **Question:** Must the reported failures be rerun before investigation?
- **Options:** rerun merely to confirm; accept the supplied triage evidence and verify changed paths after fixes
- **Chose:** treat the supplied baseline failures as ground truth, inspect their current data paths, and run the canonical suite after the repair wave
- **Why:** User-reported observations are authoritative; redundant confirmation is prohibited. New regression behaviors must have concrete before/after evidence where applicable.
- **Evidence:** docs/loop/reports/m7-test-triage.json baseline 97aaa12d9fdf91a966cbc78d5557e113fc9789b3; scripts/suite.ts:8-19,96-117
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the recorded error does not identify the current failing boundary
- **Source:** assumed — autonomous

## D3: Isolate three repair components and use the reachable cross-family reviewer
- **Question:** How should the independent root paths be implemented and reviewed?
- **Options:** overlapping edits in one tree; three disjoint component worktrees with parent-owned controls and final checks
- **Chose:** three OpenAI omp task implementers: orchestration adapter/worker fixtures, owner runtime/harness, and kernel/lease/power/shadow behavior. Parent owns controls/integration. Cap three; no checks, commits or staging by workers. Snapshot every tree before dispatch and audit at the barrier.
- **Why:** The adapter mutation contract is shared by several worker failures, but the owner harness and kernel fixture causes have separate write scopes. No shared public contract changes are planned. Fix items skip brainstorming/specs by LOOP.md.
- **Evidence:** source trace src/orchestration.ts:70-75 versus quirky.orchestration/src/services/contracts.ts:44-47; scratch wave-before.json; pi-watch --check resolves Gemini but not Opus/Sonnet; xd://lsp reports no configured servers
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a repair needs another component's file
- **Source:** assumed — autonomous

## D4: Replace obsolete control-test assumptions without relaxing authority
- **Question:** How should the stale control API fake and pre-federation foreign-target test be repaired?
- **Options:** add another fake forwarding alias and repin the old error; remove the mock-echo test and exercise current remote authority boundaries
- **Chose:** remove control-api.test.ts, whose only case echoes a mocked command receipt and exact log/event wording through a fake that lacks FleetService.command. Keep substantive stop-receipt timing coverage in control-plane.test.ts. Extend actual daemon control acceptance to distinguish malformed remote address, missing daemon incarnation, and a fully addressed but unavailable peer, while proving the local watcher is unchanged.
- **Why:** Federation requires both pairing revision and confirmed incarnation. A bare connection ID is not an authorized remote target. Changing production to accept it would bypass the current authority contract.
- **Evidence:** src/remote-fleet.ts:73-75,643-646,705-708; test/control-api.test.ts baseline; test/control-plane.test.ts stop receipt while reconciliation remains pending; test/control-acceptance.test.ts foreign-target scenario
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual daemon tests expose a distinct current command failure
- **Source:** assumed — autonomous

## D5: Fix missing mutation identity at the consumer, not the orchestration authority
- **Question:** Why did actual Heimdall worker dispatch fail with params.requestId required?
- **Options:** weaken service mutation validation; supply and verify the public mutation contract
- **Chose:** preflight registration derives one deterministic UUID from the owned Run and callback method, sends contractVersion 1, and validates the exact mutation/run/method/registered receipt before dispatch. Restart and lost-reply replay retain the identity. Missing positive contact remains non-billable.
- **Why:** serviceRegisterSubmissionPreflight is a durable mutation, not a read-only registration. Missing or mismatched registration evidence cannot authorize a start. Worker liveness and billable contact are distinct facts.
- **Evidence:** src/orchestration.ts registerSubmissionPreflight; quirky.orchestration/src/services/contracts.ts:44-47; test/orchestration.test.ts receipt refusal/replay/billing regressions; actual private worker smoke passed after the repair
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the public mutation contract changes or a replay returns a different exact registration
- **Source:** assumed — autonomous

## D6: Give fixtures truthful private workspace authority instead of suppressing lease failures
- **Question:** Why did power, owner, native worker and billing scenarios still fail after the first repair wave?
- **Options:** bypass leases or extend all deadlines; repair their actual fixture identity and filesystem prerequisites
- **Chose:** power and billing fixtures create canonical private directories; owner acceptance supplies an owner-local worktree plugin with honest folder inventory and the existing resolver; native controls resolve the exact registered worktree before authorizing its path. Shared structured fixtures and production lease checks stay unchanged.
- **Why:** the first canonical gate exposed lease-unverifiable at the billing/native boundaries. Source tracing showed nonexistent fixed paths, an owner resolver without scoped list, and borrowed Git IDs paired with an unrelated fixture folder. The owner disconnected-harness errors followed the first 5-second pending-owner timeout; an unsupported blanket 60-second change was rejected and restored.
- **Evidence:** first canonical Heimdall gate 22/28 files passed, artifact18; workspace-lifecycle.ts:33-62; test/control-fixture.ts authorize; test/owner-fakes/worktree-plugin; static plugin validation found no structural errors
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** an actual failing scenario presents valid canonical workspace and inventory evidence
- **Source:** assumed — autonomous

## D7: Drive the test read fence explicitly and drain its public API call
- **Question:** Why did the real fleet worker smoke time out before entering its read fence?
- **Options:** wait past the five-minute idle cadence; explicitly reconcile through the public API
- **Chose:** arm the fixture fence, request public reconciliation until that read is entered, and retain/drain each pending pulse on release or cleanup. Propagate pulse failures. The end-to-end test has an explicit 180-second outer bound covering its existing 90-second worker, 30-second fence and CLI/report limits.
- **Why:** actual private runner inspection showed idle delayMs 300000, while the fence waits only 30000. The failure was a test scheduling assumption, not missing worker authority. Extending that inner wait would conceal the cause. A default five-second test deadline also cannot cover those existing bounded subprocess operations.
- **Evidence:** initial smoke failed and cleaned; diagnostic artifact23 runner pacing; repaired actual API/CLI smoke passed in 10.34 seconds with one live assignment before report, zero afterward, same retained live process, then cleanup
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** reconciliation completes without reaching the armed read or cleanup leaves an outstanding pulse
- **Source:** assumed — autonomous

## D8: Preserve the exercised authority scenarios while correcting their last setup errors
- **Question:** What do the four failures in the second canonical gate prove?
- **Options:** weaken the observed expectations; correct each exact scenario precondition
- **Chose:** supply the running billing attempt's actual dispatch ID; inject failure in a runner's suspend operation rather than an intentionally isolated observer; request JSON explicitly for list/show CLI parsing; run the multi-worker concurrency scenario on a real private registered Git workspace instead of borrowing a fake repository ID for a folder.
- **Why:** owner/native acceptance now execute successfully without deadline increases. The remaining errors concern unassociated attempt evidence, the wrong fault-injection boundary, human CLI output parsed as JSON, and the locked folder concurrency cap of one. None warrants a production authority change.
- **Evidence:** second canonical gate 23/27 files passed, artifact28; runner.ts:164-166,634-636; fleet-worker-fixture.ts readEvidence; control-plane.ts:310-314; repaired real worker smoke passed before these test-only corrections
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the targeted four-file gate identifies a current production violation after these preconditions hold
- **Source:** assumed — autonomous

## D9: Report the integrated pre-review gate and runtime evidence with their actual limits
- **Question:** What evidence supports this end-phase repair after catching up integration?
- **Options:** claim zero initial failures or native parity; report exact canonical retry and real-runtime receipts
- **Chose:** sole catch-up to integration 6bdde8b7 produced source 005adb5e. Read all incoming Ask D1–D12, Settings D1–D11 and Worktrees D1–D17 logs and Progress completely; no Heimdall authority conflict. Final full typecheck/UI lint/root/mobile/prepared desktop passed in 37.43 seconds. Scripts passed 12 files in 49.15 seconds. Heimdall's 27-file canonical suite passed in 99.45 seconds after its configured isolated retries: initial 24 passed/3 failed, then acceptance 7 tests/43 assertions, fleet worker 1/12 and owner 17/113 all passed alone.
- **Why:** these are the runner's actual outcomes, not proof that under-load startup/deadline behavior was repaired. No retry policy or those three files' startup/owner deadlines were changed. The separate current-source private daemon/API/CLI smoke passed in 7.99 seconds: exact attested worker running count 1 before accepted CLI report and 0 afterward, with the same retained live process. Private process/home cleanup was observed.
- **Evidence:** canonical final bg13–bg16 outputs; ignored iteration12 verification.json and incoming-decisions.json; watcher fd41cf2f-00a4-4954-bf29-8d6dc20a3ed7, Dispatch ctx_81af3a33238d, incarnation 7c99bcfb-1893-4730-9659-a46b219be8ab
- **Reversibility:** easy
- **Confidence:** high for exercised paths; no real OS sleep cycle, UI or native-banner acceptance claim
- **Revisit if:** the controller or dedicated native run reports a concrete failure
- **Source:** assumed — autonomous

## D10: Run one bounded independent review and retain its exact snapshot boundary
- **Question:** Did the repair receive the reachable cross-family review chosen in preflight?
- **Options:** treat unavailable Opus as a pass; skip independent judgment; use the verified Gemini fallback
- **Chose:** standard promote/refute in two fresh Gemini contexts, with a focused passing canonical orchestration-file prepass, captured code/README patch only, verbatim task criteria and no author decision rationale. Mechanical gate PASS: zero findings, advisories, suppressions, limitations, questions or excluded/unreviewed paths for snapshot 005adb5e. No source HEAD moved during that review.
- **Why:** real dispatches and parseable empty arrays establish the review happened. Its PASS means no finding met the review bar on that snapshot, not complete correctness or clearance of the later D11 correction. Initial review harness select-model argument failure was fixed by resuming that stage only, not rerunning successful setup.
- **Evidence:** ignored review/promote.stdout, refute.stdout, claims.json, gate.json and manifest.json; artifact hash 50fb3d869d8829313254cfd1442e96c6309c6747553e65c37289cfe4846d42ba; Gemini gemini-3.1-pro-preview/high, full cross-family independence
- **Reversibility:** easy
- **Confidence:** high for the recorded protocol and scope only
- **Revisit if:** a concrete counterexample contradicts the reviewed contract
- **Source:** assumed — autonomous

## D11: Preserve certified liveness when heartbeat metadata is null
- **Question:** Does a nullable lastContactAtMs invalidate the public service's positively certified live state and exact identity?
- **Options:** keep the added timestamp-only downgrade; preserve the existing service state contract and remove that unrequested production change
- **Chose:** preserve state: live with exact identity and active assignment even when lastContactAtMs is null. Remove this repair's temporary worker-evidence.ts downgrade entirely, restoring its prior production behavior. Keep a real billing regression: certified live observations start/extend time, positive exit closes at the last known proof, malformed contact metadata cannot extend it.
- **Why:** ServiceWorkerView explicitly allows nullable contact metadata alongside evidence-derived liveness (core D11). An absent heartbeat timestamp is not contradictory process evidence. The narrowed regression failed before correction at the missing worker-dispatched interval, both initial and configured retry; only the newly introduced downgrade was removed. This parent-found issue was not a Gemini finding.
- **Evidence:** quirky.orchestration/src/services/contracts.ts:12-19; docs/loop/decisions/m6-heimdall-core.md D11; actual canonical bg19 failed expected true/received false at orchestration.test.ts interval-open assertion; revised test and production state projection
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the public service explicitly changes what state: live certifies
- **Source:** supersedes fix-test-heimdall-1028 D5 (contact-timestamp interpretation only)

## D12: Close the final narrowed repair with fresh consumer-visible proof
- **Question:** Does the exact D11 correction pass the end-phase gates before submission?
- **Options:** reuse the pre-correction results; rerun the affected paths and report the current outcomes
- **Chose:** final canonical Heimdall suite passed all 27 files with zero failures and no retries in 32.16 seconds. Full frozen-install/UI lint/root/mobile/prepared-desktop typecheck passed in 30.98 seconds. Actual private worker API/CLI smoke passed in 7.04 seconds, preserving exact live process identity after the accepted report while running work dropped from 1 to 0. Cleanup printed completion. Integrated scripts remain passed 12 files in 49.15 seconds; no script source or imported script dependency changed afterward.
- **Why:** D11 now has failing-before/passing-after regression evidence, and the real daemon path is exercised after the source narrowing. Final production change is confined to the Heimdall adapter's public preflight mutation contract; worker liveness projection returns to its original contract.
- **Evidence:** canonical bg19 red, bg20 27/27 green, bg21 typecheck exit0, bg22 actual smoke/cleanup; watcher a8bd79a2-7a65-462e-9e3f-87e54c14f0aa, Dispatch ctx_3eb909f6e1b1, incarnation 6ed9ccf5-4ad7-42ff-a848-594a5c347e5b
- **Reversibility:** easy
- **Confidence:** high for exercised API/CLI, lifecycle, lease, power-binding and owner cases; real OS sleep/native notification/UI acceptance unchanged
- **Revisit if:** authoritative landing or the existing native handoff reports a concrete failure
- **Source:** assumed — autonomous

## Progress
Ready for canonical land. Initial components and later fixture repairs were scope-audited; all implementers and the static validator returned. Three component worktrees were removed after preserving their unknown metadata; parent .serena remains untouched. One integration catch-up completed; all three incoming decision logs read completely. One cross-family standard review completed (D10); parent narrowed an additional contract risk with explicit red/green proof (D11–D12). Current Heimdall 27/27, full typecheck and real private daemon/API/CLI smoke pass; integrated scripts pass. No owned runtime/browser process or review job remains. Commit final correction/evidence, detach and invoke the canonical absolute queue.ts land fix-test-heimdall-1028; await its actual result in this turn. No complete UI/native-cycle or whole-queue completion claim.
