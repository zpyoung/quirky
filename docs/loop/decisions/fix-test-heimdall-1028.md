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

## Progress
Repair wave active: all eleven triage entries read, ownership scout completed, three isolated implementers dispatched after snapshots. Parent removed obsolete mock-echo API test and expanded real remote-refusal coverage. No checks executed mid-flight. Reviewer binding is Gemini (cross-family fallback because Opus/Sonnet unavailable). Tests run through bun scripts/suite.ts with fresh private homes and cleanup. No human decisions requested.
