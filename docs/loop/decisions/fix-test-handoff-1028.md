# fix-test-handoff-1028 decisions

## D1: Use the original timeout and catalog diff as failing-before evidence
- **Question:** Which defects explain the two triaged handoff failures?
- **Options:** rerun to confirm the report; infer a production Git/target defect; read the preserved raw evidence and trace the implicated paths
- **Chose:** Treat the report as ground truth. Raw SC-6 output first reports a 5000ms test timeout (8856.07ms total), then an unhandled not-a-repository error. The catalog diff contains the shipped `openArchived` method absent from its exact expected inventory. Production create-target validation already rejects blank/whitespace names and preserves the preview/no-create boundary.
- **Why:** `HandoffRig.start` installs process-global fake Git and assigns the caller's rig only after setup completes. A timed-out setup can outlive the test and its cleanup, so the late Git error does not establish a handoff production defect. The exact slow startup operation is not established.
- **Evidence:** docs/loop/reports/m7-test-triage.json:1713-1733; compressed raw log member m7-test-triage.log:4689-4740,4911-4970; plugins/quirky.handoff/test/support.ts:141-207; src/daemon/service.ts:249-259
- **Reversibility:** easy
- **Confidence:** high for observed timeout and inventory drift; late Git lifecycle explanation is an inference
- **Revisit if:** bounded setup still fails or direct operation-level evidence identifies a production defect
- **Source:** assumed — autonomous

## D2: Correct the fixture deadline and delete the inventory mirror without changing production
- **Question:** What is the smallest repair preserving the consumer contract?
- **Options:** extend production deadlines; bypass Git creation or target validation; repin the method/event catalog; use the established full-daemon test budget and remove the incidental inventory assertion
- **Chose:** Set service.test.ts's integration-test budget to 60 seconds using Bun's existing convention. Retain all behavioral API assertions, especially SC-6 invalid blank/whitespace targets and no creation during a valid named preview. Delete service-drafts.test.ts's complete method/CLI/dependency inventory mirror and its unused ApiDescription type import. No replacement inventory, alias, manifest or production change.
- **Why:** One allowed plugin activation/deactivation can exceed the test's old five-second ceiling. The existing editor integration fixture uses this bounded test budget. Exact public inventory is owned by manifests and daemon catalog behavior, not duplicated in handoff draft tests. Existing handoff API/CLI tests exercise real operations including archived handoff, templates, drafts, launch and lineage.
- **Evidence:** packages/daemon/src/plugins/host.ts activation/deactivation timeout contract; plugins/quirky.editor/test/lifecycle.test.ts; docs/loop/decisions/fix-test-editor-1028.md D9; plugins/quirky.handoff/test/service.test.ts:159-176; service-drafts.test.ts:142-174; test/e2e/handoff.e2e.test.ts:126-169
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the canonical affected suite or actual private-daemon smoke exposes a consumer-visible regression
- **Source:** locked by triage item instructions and existing integration-test convention

## D3: Keep the unattended repair and evidence scope bounded
- **Question:** How should execution, review and platform qualification run?
- **Options:** new feature specs and research swarms; fix workflow with one scoped implementer, affected verification and one cross-family review round
- **Chose:** Follow the end-phase Fix items workflow, with no brainstorming/specs or human asks. One omp/OpenAI worker owns the two test files; parent owns decisions, verification and landing. Skip worker checks mid-flight and run the canonical affected suite afterward. Use private process homes and owned cleanup. Preserve inherited untracked .quirk/ and .serena/. No configured LSP server is available. One final review round and at most one accepted-finding fix batch.
- **Why:** These are repairs to already-built flows, not new features. No UI or native surface is changed, so actual daemon/API/CLI smoke is the runtime proof; no new native scenarios are required.
- **Evidence:** authoritative LOOP.md end phase and Fix items; initial source 1f1de72bdc82a7d1e872b51e1c16a72916e679a2; xd://lsp status
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a production or UI defect is directly traced to this repair
- **Source:** assumed — autonomous

## Progress
Root causes traced from authoritative raw triage; minimal two-file test repair delegated. Next: consume worker result, run canonical handoff/scripts suites and full typecheck, exercise actual private daemon API/CLI with real temporary Git, bounded cross-family review, catch up integration decisions once, then commit/detach/canonical land this item only. No verification success is claimed yet.
