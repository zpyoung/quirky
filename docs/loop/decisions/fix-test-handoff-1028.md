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

## D4: Prove the target boundary through an actual private daemon and public CLI
- **Question:** What runtime evidence covers this test-only repair without inferring correctness from assertions alone?
- **Options:** only run tests; use a fake Git daemon; exercise the actual daemon/PTY with real temporary Git and a fixture agent
- **Chose:** The actual subprocess daemon smoke rejected blank and whitespace create names with RPC code -32602 and reason invalid-target, accepted a named target preview without changing the exact worktree list, and returned the note through the public `handoff preview --json` CLI without creating a worktree. It exited 0 in 8.58s and printed HANDOFF_REAL_DAEMON_API_CLI_OK and HANDOFF_SMOKE_CLEANED. Owned process-scope shutdown and removal of its fixture root were asserted.
- **Why:** This exercises the preview boundary without changing production validation, Git or launch semantics. The first throwaway smoke printed only one viewport line, so terminal/history never contained it; that smoke exited 1 after cleanup. Changing only fixture output to the existing E2E 120-line chatty convention made scrollback available. No production correction followed from that fixture mistake.
- **Evidence:** .quirk/build-loop/fix-test-handoff-1028/macos-smoke.txt; scratch smoke.ts; existing test/e2e/handoff.e2e.test.ts chattyFake/history convention; observed macOS tool exits 1/20.32s then 0/8.58s
- **Reversibility:** easy
- **Confidence:** high for the named API and CLI observations
- **Revisit if:** preview mutates a worktree or a correctly prepared source fails validation
- **Source:** assumed — autonomous

## D5: Use a standard independent cross-family review of the exact source delta
- **Question:** Which reviewer and scope meet the unattended loop's bounded review requirement?
- **Options:** unavailable Opus/Sonnet; same-family reviewer; available Gemini with independent promote/refute contexts
- **Chose:** Opus and Sonnet preflights both exited 5 with no authenticated/shipping model. The mechanical selector verified google/gemini-3.1-pro-preview at high effort. Review source range 1f1de72b..57c0c0b0 only: 40 changed lines across the two tests. Use standard depth rather than suggested quick to retain a fresh independent refute. Stage verbatim item criteria, source delta and deterministic checks, withholding author reasoning, decision logs and commit messages. Actual model grants are read/grep/find/ls only, not shell or writes.
- **Why:** The change has no production/API contract delta, but deletions deserve the same correctness check as additions. Restricting tools avoids granting unsandboxed process execution; filesystem limits remain prompt-level, not OS sandboxing. One discovery round plus at most one fix batch remains the cap.
- **Evidence:** reviewer preflight tool outputs; .quirk/build-loop/fix-test-handoff-1028/review/{resolve,model}.json, run d2d0554b18d55b3a; source commit 57c0c0b01b4f1ec2c4b792d56859203383a5f948
- **Reversibility:** easy
- **Confidence:** high for model availability and captured scope; review outcome pending
- **Revisit if:** either model response fails transport/schema validation or deterministic evidence gate refuses its chain
- **Source:** locked by docs/loop/LOOP.md cross-family fallback and bounded review

## D6: Preserve the platform qualification boundary
- **Question:** Does macOS runtime smoke or the configured remote suite certify other platforms or native UI?
- **Options:** infer broad platform/native correctness; report only exercised checks
- **Chose:** Keep Linux/Windows qualification and native UI behavior with their existing owners. No UI/native code changed and no new native scenario is needed; the remote runner's results certify only those test executions.
- **Why:** LOOP locks macOS build/qualification scope. A fake provider executable checks daemon and CLI behavior, not real agent-provider authentication or native focus.
- **Evidence:** authoritative LOOP.md platforms/native rules; D4 smoke boundaries
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a supported-platform or native acceptance requirement changes
- **Source:** deferred: platform

## D7: Restore the required dependency closure in two handoff-owned fixtures
- **Question:** What explains newly reached archived handoff and manifest-activation failures in the affected gate?
- **Options:** remove Worktree's required CLI dependency; mock or alias worktree/list; include the actual required plugin in the handoff fixture subsets
- **Chose:** Add quirky.cli to the selected built-in sets in test/e2e/archived-vault.e2e.test.ts and test/manifest.test.ts. No production dependency or foreign plugin code changes.
- **Why:** The first gate passed 34 of 39 files, but the archived fixture failed with unknown quirky.worktree/list, including its configured isolated retry. The manifest fixture reported dependency quirky.worktree is invalid. Its selected subset omitted quirky.cli, which is explicitly required by the current Worktree manifest and has no further plugin dependencies. Full-builtins actual daemon smoke already passed; the difference is the stale selected fixture closure.
- **Evidence:** .quirk/build-loop/fix-test-handoff-1028/review/prepass.json; plugins/quirky.worktree/quirky-plugin.json:12-15; plugins/quirky.cli/quirky-plugin.json; handoff test/e2e/archived-vault.e2e.test.ts and manifest.test.ts selected plugin lists
- **Reversibility:** easy
- **Confidence:** high for the missing dependency; corrected gate pending
- **Revisit if:** activation still fails with the complete required dependency set
- **Source:** locked by current quirky.worktree manifest

- **Initial gate receipt:** canonical handoff/scripts check exit 1 (174.326s), 34/39 initial files passed, five failed. service-content.test.ts, service-transcript.test.ts and start.test.ts also failed; the prepass retains only the output tail, so their root causes are not inferred. Whole verification exited 1 in 226.36s. Full root/UI-lint/mobile/prepared-desktop typecheck passed in 51.810s. The subsequent corrected-fixture run preserves complete raw stdout/stderr rather than only the prepass tail.

## D8: Put the bounded full-daemon budget on the shared rig, not one consumer file
- **Question:** What explains the corrected-fixture gate's remaining draft and gone-session delivery failures?
- **Options:** change delivery/RPC deadlines; increase timeouts one failing test at a time; let the shared full-builtin rig own its existing integration-test budget
- **Chose:** Move setDefaultTimeout(60_000) from service.test.ts to test/support.ts, which owns HandoffRig. Restore service.test.ts to its original contents. Retain every service/draft/delivery assertion and all explicit per-test timeouts. No production timing, error handling, retry policy or fake-Git behavior changed.
- **Why:** The complete corrected-fixture run passed 37/39 files. The remaining delivery test timed out at 5000ms both initially (5131.14ms) and on the configured isolated retry (6086.91ms), with late ConnectionLost/not-a-repository cleanup errors. A draft-clear test also hit its 5000ms ceiling. Independent files using the same full-builtin rig were subject to the same undersized deadline, so a shared fixture contract removes duplicate per-file policy and prevents ordinary setup/delivery/teardown from outliving the runner's budget. Exact slow operations remain unidentified.
- **Evidence:** .quirk/build-loop/fix-test-handoff-1028/dependency-fixture-suite.log and result.json, exit 1/277.313s; delivery.test.ts:200-206; service-drafts.test.ts:40-45; support.ts HandoffRig consumers; source commit b5fb293df1d000de85a2887482a388c3e15cdf48
- **Reversibility:** easy
- **Confidence:** high for repeated observed deadline mismatch; no universal latency or hang-free claim
- **Revisit if:** a fully budgeted operation still times out or operation-level tracing reveals a hang
- **Source:** supersedes fix-test-handoff-1028 D2 for timeout ownership only

## D9: Consume lane 8's older broad failure inventory without changing repair ownership
- **Question:** Does the incoming whole-consumer snapshot supersede this item's current verification or the landed editor repair?
- **Options:** reopen completed work or file duplicate repairs; treat it as historical evidence and exercise this item's current handoff scope
- **Chose:** Read lane 8's exact handoff inventory. Its five files include delivery, service, service-drafts, archived-vault and manifest tests; the catalog and dependency failures agree with this item's traced causes. The new current gate independently reached the delivery timeout in D8. Preserve the broad snapshot as red and retain existing owners. Do not undo the completed editor repair or change Orchestration/Structured/other plugin production source.
- **Why:** The supplied snapshot preceded later lands and explicitly is not a new scope assignment. A current affected gate is required for this repair; it cannot certify the older full-suite snapshot or unrelated areas.
- **Evidence:** user lane 8 coordination message; /Users/zpyoung/orca/workspaces/quirky/build-lane-8/.quirk/build-loop/fix-test-orchestration-1028/full-consumer-failures.json handoff selection; D7/D8 current receipts
- **Reversibility:** easy
- **Confidence:** high for the stated ownership and evidence boundaries
- **Revisit if:** a current failure is causally traced to a different owner's source change
- **Source:** locked by user coordination instruction

## D10: Accept only the fresh affected-gate receipt for the final shared-fixture source
- **Question:** What does verification of b5fb293d establish after D7/D8?
- **Options:** relabel earlier failed gates as passing; run the complete affected gate and preserve both historical failures and the new result
- **Chose:** The final canonical command `bun scripts/suite.ts plugins/quirky.handoff scripts` exited 0 in 211.960s: 39/39 remote test files passed, zero failures, no isolated retries/flaky entries, zero macOS-only files. Full `bun run typecheck` exited 0 in 46.210s, including frozen install, UI lint, root/mobile TypeScript and prepared desktop. The deterministic prepass exited 0 in 258.407s.
- **Why:** This covers every shared-rig consumer and both corrected selected-dependency fixtures rather than only the original two tests. Actual macOS daemon/API/CLI smoke remains the independent runtime proof; no production source changed between it and this final test delta. Earlier failed gates and their incomplete first-run diagnostics remain recorded, not overwritten.
- **Evidence:** .quirk/build-loop/fix-test-handoff-1028/final-{tests,types}.{log,result.json}; review-final/prepass.json; D4 runtime proof; source b5fb293df1d000de85a2887482a388c3e15cdf48
- **Reversibility:** easy
- **Confidence:** high for exercised checks only
- **Revisit if:** landing's merge-result typecheck fails or independent current behavior evidence contradicts the scoped receipt
- **Source:** assumed — autonomous

- **Final review capture:** run f1a7df056a5bfe9c, 41 changed lines in the four handoff test files, artifact hash 3f15a1ff2b3f71b21cee8a5a71d043d64c94ee7eb3046a8998769a46e4a0f8a6. The source range is 1f1de72b..b5fb293d; a supported fixed diff-file capture with `plugins/quirky.handoff/test` path scope withholds the intervening decision-log commit and its author reasoning. Gate hashing rechecks that captured artifact, not a claim of reviewing every file in the branch. No model review had begun on the earlier superseded capture.

## D11: Finish the single independent review round without manufacturing a fix batch
- **Question:** What did the completed cross-family promote/refute protocol find, and what remains before landing?
- **Options:** infer a whole-repository guarantee; repeat discovery to search for findings; consume the bounded result and land the verified scoped repair
- **Chose:** Both actual first-attempt Gemini dispatches exited 0 and emitted empty arrays. Deterministic claims, merge, gate and manifest completed. Verdict PASS at standard depth, full cross-family independence, zero findings, advisories, suppressions, limitations, questions or contested entries; no excluded/unreviewed paths within the captured four-test-file scope. No finding fix batch or additional review round is needed. Keep the initial failed prepass unchanged and retain all raw prompts/responses.
- **Why:** The cap is one final review round plus a batch for accepted findings, not repeated discovery until a reviewer produces work. The fixed source capture excludes author decision rationale; the manifest says nothing about unrelated source or native/platform qualification.
- **Evidence:** .quirk/build-loop/fix-test-handoff-1028/review-final/{promote,refute,claims,merged,gate,manifest}.json and first-attempt raw/process records; review driver exit 0/107.69s; run f1a7df056a5bfe9c
- **Reversibility:** easy
- **Confidence:** high for protocol completion and scoped verdict, not a completeness guarantee
- **Revisit if:** new independent current evidence contradicts this repair
- **Source:** locked by docs/loop/LOOP.md bounded final round

- **Delivery boundary:** no production, public API, UI, native, protected loop or shared queue/decision-index file was edited. All in-scope target/draft/delivery behavior tests remain. No unbuilt flow was identified, so no follow-up queue item is needed. All delegated and verification/review jobs have returned, and the actual smoke's owned daemon/PTY/process scope was removed. Scratch programs are outside the repository and will be removed after authoritative land; audit receipts remain under the inherited untracked .quirk directory.

## Progress
Ready for canonical landing of this item only. Final source b5fb293d passes 39/39 affected test files with no flaky entries, full typecheck, actual private macOS daemon/API/CLI smoke, and the one standard independent Gemini review round. Historical red receipts and evidence limits remain in D4/D7–D11. Sole normal integration catch-up was already up to date, with no incoming decision logs then. Commit this decision receipt, detach, run canonical queue land fix-test-handoff-1028, await its merge-result receipt, and remove only owned scratch after success. On a concrete land failure, follow required recovery rather than claiming completion.
