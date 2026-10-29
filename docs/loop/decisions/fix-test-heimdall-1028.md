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

## Progress
Repair wave active: all eleven triage entries read, ownership scout completed, three isolated implementers dispatched after snapshots. Parent removed obsolete mock-echo API test and expanded real remote-refusal coverage. No checks executed mid-flight. Reviewer binding is Gemini (cross-family fallback because Opus/Sonnet unavailable). Tests run through bun scripts/suite.ts with fresh private homes and cleanup. No human decisions requested.
