# m5-automations-dispatch decisions

## D1: Use daemon structured execution, never a hidden terminal
- **Question:** Which launch surface implements the feature doc's background runs?
- **Options:** Orca renderer/hidden PTY; existing daemon structured runners
- **Chose:** structured Claude/Codex through public APIs, no PTY/tab/focus mutation
- **Why:** The locked architecture explicitly includes automations in structured background agents.
- **Evidence:** docs/architecture.md:175-178,302-303; docs/loop/decisions/m5-structured-runner.md D3
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** architecture decision is explicitly superseded
- **Source:** locked by docs/architecture.md

## D2: Preserve raw-argument refusal and defer that incompatible flow
- **Question:** Can automation extras bypass structured runner's raw-args refusal?
- **Options:** silently map partial argv; implement terminal fallback; preserve binding refusal
- **Chose:** reject nonblank raw arguments before mutation; structured model/effort remain supported; one dependent follow-up names raw-args decision and remote flows
- **Why:** D6 binds downstream consumers to native options and explicitly refuses extras. No shell fallback or misleading partial support.
- **Evidence:** docs/loop/decisions/m5-structured-runner.md D6; plugins/quirky.structured/main.ts:480-486
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** binding structured extras decision changes
- **Source:** deferred: raw extra agent arguments

## D3: Capture local registry identity and fail closed for remote host flows
- **Question:** How to implement host fencing without a public host registration/execution API?
- **Options:** trust client runContext; infer remote host locally; capture local repo/workspace identity and refuse remote
- **Chose:** authoritative local repo/path/workspace instance capture; re-resolve every launch; remote SSH/runtime pin/re-pin/re-adoption deferred until public host execution and registration generations exist
- **Why:** Scout found no public host registration/generation API. Remote records must never switch to local execution. Explicit selector moves recapture; ordinary edits preserve orphans.
- **Evidence:** MapDispatchApis scout; quirky.repo/resolve and quirky.worktree/resolve schemas; automations.md Execution target, owner, and host fencing
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** public remote target methods land
- **Source:** deferred: remote host generation and execution

## D4: Resolve every relevant gray area autonomously
- **Question:** Brainstorming domain, defaults, purpose, success criteria and ambiguities
- **Options:** wait for a person; accept recommended defaults
- **Chose:** API/CLI/Data/Integration; resolve response shape, typed conflicts, auth, pagination, output/flags, exit truth, data mapping, idempotency, conflict handling and retry policy; preserve existing automation CLI/JSON shape; daemon auth; no automatic provider retry; each refused manual run visible; scheduled repeats fold
- **Why:** Nobody is watching. Feature doc, roadmap and earlier decisions define observable behavior. Purpose: unattended scheduled/manual agent work, consumer: CLI/API and later UI; success: native process executes one persisted run with truthful final evidence.
- **Evidence:** combined logic.md AC1-AC9; authoritative LOOP.md Answering a skill's questions
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a documented consumer flow contradicts the chosen defaults
- **Source:** locked by docs/loop/LOOP.md

## D5: Prefer public existing seams to duplicate runners
- **Question:** Which architecture and alternatives are viable?
- **Options:** public structured/check/worktree APIs; renderer launcher; private provider/check code imports
- **Chose:** automation policy composes the public APIs; three disjoint target/execution/integration components
- **Why:** Headless independence, public-plugin constraint, existing setup trust and process cleanup remain authoritative. No new workflow abstraction.
- **Evidence:** docs/roadmap.md:19-20,47-53,204-208; logic.md Technical decisions
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** an essential execution primitive is absent
- **Source:** assumed — autonomous

## D6: Claim durably and recheck before side effects
- **Question:** Concurrency, edits, deletion, duplicate dispatch and restart semantics
- **Options:** optimistic unclaimed launch; one durable claim and per-id lane
- **Chose:** persisted pending-to-dispatching, semantic definition/destination snapshots excluding scheduler bookkeeping; recheck after awaited preparation; ambiguous crash never relaunches; final rows cannot be overwritten
- **Why:** A queued record is not a successful agent; at-most-once launch is safer than duplicate unattended work.
- **Evidence:** automations.md Dispatch and Edge cases; m5-automations-core D1,D5,D10
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a durable external launch transaction becomes available
- **Source:** assumed — autonomous

## D7: Explicit setup defaults to skip and never grants hook trust
- **Question:** Can a scheduled new workspace pause for setup consent?
- **Options:** auto-trust hooks; wait for interactive consent; preserve explicit skip/run and fail closed
- **Chose:** default skip; run uses worktree's existing trust enforcement without confirmation; setup failure prevents agent launch
- **Why:** Unattended execution must neither hang on a person nor silently run untrusted scripts.
- **Evidence:** automations.md Workspace policy and create step7; quirky.worktree/create trustSetupHash schema
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a save-time setup consent flow is introduced by the UI item
- **Source:** assumed — autonomous

## D8: Per-turn cursor controls reuse, completion and usage
- **Question:** How to avoid stale done evidence or attributing the same session's usage repeatedly?
- **Options:** session-wide done/usage; post-cursor structured journal evidence
- **Chose:** reuse only live done same-provider/workspace sessions owned by newest completed run; claim lane; snapshot cursor before send; only newer result/working evidence counts; immutable actual launch snapshot; native usage/cost only, otherwise explicit unavailable
- **Why:** A structured result can arrive before the launch acknowledgement. Durable journal replay avoids event-loss races and provider-wide totals cannot prove a run's spend.
- **Evidence:** automations.md Session reuse, completion and Usage attribution; structured/messages API
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** providers add normalized turn usage APIs
- **Source:** assumed — autonomous

## D9: Use OpenAI implementers and reachable Gemini cross-family review
- **Question:** SDD preflight pairing and workflow
- **Options:** omp task + opus; omp task + sonnet; omp task + Gemini
- **Chose:** IMPLEMENTER=omp-task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini high. One wave of three disjoint components, cap3; no successor/checkpoint. One final C/S/X promote/refute round and one blocker-fix batch.
- **Why:** Actual pi-watch --check rejected opus/sonnet; Gemini resolves google/gemini-3.1-pro-preview:high. Night mode requires contracts before implementers, one combined spec, no research swarm/spec review, one catch-up, affected suite/scripts/typecheck once. Run journal outside repo at /tmp/quirky-automations-dispatch-lane7.aKM80C.
- **Evidence:** iteration7 preflight output; bun1.4.0; RUN_BASE c6385407e1a7ae653a47223b3bb51dbaab5605b0
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** reviewer dispatch fails
- **Source:** locked by docs/loop/LOOP.md

## D10: Preserve unrelated files and validate macOS only
- **Question:** Dirty-tree handling and platform claims
- **Options:** stash/delete/commit inherited files; preserve them and isolate workers
- **Chose:** leave inherited .serena/, test-migrated.test.ts and test.ts untouched/unstaged; isolated component worktrees. Test homes isolate HOME and QUIRKY_HOME. Linux/Windows validation deferred.
- **Why:** Unrelated changes belong to the user; LOOP platforms are locked. No baseline full-suite rerun; final landing owns it.
- **Evidence:** initial git status; m5-automations-core D8; LOOP.md Platforms and Tests
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** platform-specific support is requested
- **Source:** deferred: platform

## D11: Checks owns cancellation after its caller context is revoked
- **Question:** Can automation dispose cancel an active precheck through a revoked context?
- **Options:** rely on best-effort caller cleanup; let the checks service cancel checks whose registered creator becomes inactive
- **Chose:** record the registered creating-plugin identity, reconcile on plugin.changed, and abort only that owner's checks; direct client checks remain independent
- **Why:** The kernel revokes context.call before deactivate. A real-process API regression left the owned check alive until its three-second observation failed. After service-owned cancellation the same regression passes and the unrelated client check remains alive. Check-ID reservation stays after the asynchronous owner lookup to retain uniqueness.
- **Evidence:** plugins/quirky.checks/test/owner.test.ts; initial0pass1fail waitFor timeout, then1pass0fail; quirky.ask/main.ts existing ownership precedent
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** kernel introduces an explicit caller-lifetime cancellation signal
- **Source:** assumed — autonomous

## D12: Coordinate UI through additive public contracts, not shared edits
- **Question:** Lane6 started the automation UI concurrently from the landed core
- **Options:** duplicate runtime policy in UI; share committed types and public target/dispatch methods
- **Chose:** send contract commit cb9e08b01a41d5e5d0bbe5a14c1804e944aa6786 and exact API/owner shapes; lane6 merged it into parent and three UI component trees. Preserve additive UI registration/main and manifest contributions on integration.
- **Why:** Lane6 owns UI/editor/list/details/runs/OpenClaw and accepts structured-only execution, raw-argument refusal, owner snapshots and setup skip/no auto-consent. This lane owns runtime service/types/store policy. Executable integration hash will be sent after the source barrier.
- **Evidence:** lane6 interjections; accepted terminal-send request6ae237bf-0445-4de5-9ed0-44a6840847be; lane6 contract331fc251
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** either API contract changes
- **Source:** assumed — autonomous

## D13: Fix integration failures at their actual contract boundaries
- **Question:** Why did integration expose no automation methods and later misclassify deleted targets?
- **Options:** disable dispatch in tests; change kernel schema; fix the plugin declaration and authoritative-path checks
- **Chose:** use the kernel's documented flat schema subset instead of unsupported anyOf; lowercase CLI positional names; confirm local authoritative paths are directories after captured identity checks; retain normalized registry IDs from capture
- **Why:** plugin.list reported state invalid with ten unsupported-keyword errors and one positional-name error. After declaration repair the API ran; deleted registry paths then reached workspace creation and failed at spawn instead of target refusal. Existing API regressions now pass and target drift still reports owner-change before filesystem absence.
- **Evidence:** scratch activation.js plugin.list diagnostic; integrated API17cases, later combined93pass/1target-orderfailure; focused target6pass after ordering correction
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** remote registry paths become supported
- **Source:** assumed — autonomous

## D14: Preserve catalog opaque-model policy and immutable dispatched-provider identity
- **Question:** What should happen for an unlisted model or a provider edit after launch?
- **Options:** duplicate a closed model allowlist; trust current definition during observation; preserve the catalog and actual session snapshot
- **Chose:** accept opaque IDs when declared by the catalog; reject invalid effort/options. Fresh run snapshots always record the actual provider even without explicit picks; completion/usage use that snapshot, not a later edited definition.
- **Why:** m1-launch-settings D10 explicitly allows opaque Claude/Codex IDs. A new dispatcher regression timed out before the snapshot fix when the definition changed from Claude to Codex after launch; it passed in the93-test integration result after the correction.
- **Evidence:** docs/loop/decisions/m1-launch-settings.md D9-D10; test/dispatch.test.ts provider-edit regression red0pass1timeout then green among93passing tests
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** provider discovery introduces an authoritative closed list
- **Source:** locked by docs/loop/decisions/m1-launch-settings.md

## D15: Give background structured sessions an explicit durable no-auto-tab signal
- **Question:** Does structured launch alone preserve the person's active terminal tab?
- **Options:** accept terminal auto-adoption; make all structured reconciliation inactive; mark only background sessions explicitly
- **Chose:** optional public Session.background and structured/create background boolean, persisted by session/register and resume. Automations passes true. Terminal reconciliation excludes only unbound background sessions; ordinary structured behavior and explicitly bound sessions remain unchanged.
- **Why:** Actual daemon smoke logged automatic structured tab additions. Scout traced appendTab's default activation to both reconciliation predicates. This is a real focus-selection gap, not permission to use hidden PTYs or change interactive session behavior. Explicit View run uses view:quirky.session/worktree with worktree/session input; terminal/openSession is terminal-only.
- **Evidence:** terminal/src/layout/reconcile.ts:37-72; terminal/src/layout/ops.ts appendTab; session/src/window/model.ts:4,113-117; BackgroundTabPolicy scout correction
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the public layout contract adds an explicit background-session adopter
- **Source:** assumed — autonomous

## D16: Normalize per-run evidence to the feature contract without compatibility aliases
- **Question:** Can the UI consume check-runner field names and provider-specific cost keys directly?
- **Options:** make each consumer reinterpret raw provider/check data; publish one automation evidence shape
- **Chose:** precheck stdout/stderr and completedAt, retaining the last4000characters and truncation flags. Usage has known/unavailable status, provider/model, input/output/cacheRead/cacheWrite/reasoningOutput/total token counts, estimatedCostUsd (null without evidence), collectedAt and structured_turn attribution. Native diagnostics remain in failed output snapshots. Existing known amounts are not downgraded.
- **Why:** A direct regression found completed reuse records lacked status, totalTokens and estimatedCostUsd; a failed runner lost its diagnostic output. Three focused regressions failed before normalization and the23dispatcher cases passed after. Two precheck field regressions also failed before the contract mapping and then passed with all23cases. Codex input includes cached tokens and output includes reasoning, so total does not double-count them.
- **Evidence:** test/dispatch.test.ts native usage/reuse/failed-output/precheck cases; feature automations.md Usage attribution and Prechecks; accepted lane6 evidence-contract message1de82abb-cf4d-494c-b0fa-9a380f5c9ec0
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a provider exposes an independently attributable actual charge
- **Source:** locked by automations.md

## D17: Preserve the caught-up hosting UI public contracts
- **Question:** Do incoming reviews/tasks decisions change automation runtime ownership?
- **Options:** rewrite shared UI seams; preserve the unrelated feature contracts
- **Chose:** read both incoming logs through CatchupDecisions; preserve Reviews D3-D4,D6,D8,D12,D16,D20-D22 and Tasks D6-D10,D14-D20,D22-D24. No product conflict. Their implementation-model pairing describes their runs, not which provider an automation may execute.
- **Why:** Generic UI metadata, public feature routes, existing worktree creation, flat schemas, structured settled evidence and no-focus background operations agree with this runtime. No feature-specific shell import was added.
- **Evidence:** catch-up merge dc6631e0e45d6846b95c44f40259d1bb1d0645aa; CatchupDecisions read-only report
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** incoming API changes contradict a captured dispatch contract
- **Source:** locked by docs/loop/decisions/m4-hosting-ui-reviews.md

## D18: Subtract Claude's cumulative cost baseline, but not its per-turn tokens
- **Question:** Does each result in a reused SDK streaming query carry per-turn cost?
- **Options:** assume every result is per-turn; mark all reuse usage unavailable; inspect the primary SDK accounting contract and persist the needed baseline
- **Chose:** result usage is per-turn main-agent-loop tokens; total_cost_usd is cumulative across the streaming query and includes subagents. Persist the preceding result's nonnegative cost before submitting a reused prompt, then subtract it. Missing baseline or decreasing total yields unavailable cost. Estimates are not billing data.
- **Why:** Local runner code proved one query handles multiple prompts but did not define accounting scope. The official documentation explicitly distinguishes these fields. A focused regression reported0.102 instead of0.012 after a prior0.09 result before the fix; all23dispatcher tests then passed with103assertions.
- **Evidence:** https://code.claude.com/docs/en/agent-sdk/cost-tracking#track-costs-in-streaming-input-mode ; test/dispatch.test.ts reused-query cost case
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the installed SDK changes streaming accounting semantics or native conversation-reset support changes
- **Source:** assumed — autonomous

## D19: Remove the obsolete manual-result handoff instead of retaining aliases or no-op APIs
- **Question:** Should the core-only claim/updateRun methods remain after the dispatcher owns every production run?
- **Options:** alias claim to dispatch and reject all updateRun calls; clean cutover to dispatch/runs
- **Chose:** remove both production method declarations/registrations and service closures, result parsers and their dead bounds helpers. Keep private store claim/update primitives used by the dispatcher. The sole public forged-result caller now observes method-not-found.
- **Why:** No production caller used either old handoff method. Aliasing one and exposing a permanently rejected second method is misleading. Existing store regressions retain transitions/retention/output coverage; native dispatcher regressions cover final evidence; definition metadata bounds remain in service/API tests.
- **Evidence:** repository-wide caller search; main.ts/service.ts/manifest removal; test/store.test.ts and test/dispatch.test.ts
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a separately owned external dispatcher contract is explicitly introduced
- **Source:** assumed — autonomous

## D20: Prove native dispatch and no-auto-tab behavior through isolated real clients
- **Question:** What runtime evidence establishes the integrated behavior rather than worker mock claims?
- **Options:** unit tests alone; actual daemon/CLI with the scripted native Codex app-server
- **Chose:** real daemon main and CLI children under a fresh HOME and QUIRKY_HOME, with the scripted native protocol process and ProcessScope cleanup. The final smoke passed in64.18seconds: paused manual launch bypassed precheck, native model/effort arrived, completion and live reuse worked, terminal root/UI layout stayed identical, failed provider became failed, new-per-run workspace completed, the real60-second scheduler produced skipped_precheck with exit7/output, history stayed readable, deleting the definition retained its workspace.
- **Why:** The first smoke stopped at an incidental error-word assertion, which was deleted. The second correctly hit the fixture's deliberately reused provider ID while an older connection still owned it; stopping that completed fixture connection after reuse proof released it before fresh-conversation cases. No production ownership fence was weakened. Final daemon stderr had no tab-repair messages; the temporary home was confirmed removed.
- **Evidence:** AUTOMATION_DISPATCH_NATIVE_CLI_SMOKE_PASS; manual29fa5eee-e3b4-4c83-87c0-dc8ae9902d63, reusedcec1712a-78b2-4be6-b7de-2972ed2218d2, session s_14062c73a0a7, new workspace wt_a09dc668168f, scheduled5fc25bd9-e341-4254-b32a-311897f6f489; background API regression1pass26assertions
- **Reversibility:** easy
- **Confidence:** high for exercised native-protocol/CLI/API paths; no live model billing or browser/native-window verification claimed
- **Revisit if:** a real provider diverges from its native protocol fixture
- **Source:** assumed — autonomous

## D21: Repair five test-only TypeScript diagnostics without repeating the broad suite
- **Question:** Which part of the final affected gate failed?
- **Options:** rerun the entire broad chain; preserve its actual component outcomes and repair the compiler diagnostics directly
- **Chose:** the protocol/automations/structured/checks/session/terminal affected suite and scripts reached typecheck through an && chain; scripts reported68pass0fail562assertions. Typecheck exited2. A focused compiler command exposed five diagnostics in two automation test fixtures; fixed optional params, literal fixture typing and a union guard. Focused29tests and frozen-install/typecheck then passed, with no production-source change.
- **Why:** The prepass retains only a bounded output tail, which obscured compiler diagnostics behind intentionally failing script-test fixture output. It is not evidence the outer scripts suite failed. The first broad result remains recorded as a failed combined gate, not relabeled pass. Production hashes matched the captured artifact before the focused repair.
- **Evidence:** review/prepass.initial-failed.json exit2 after735759ms; focused compiler output; a8783ed2; review/prepass.json focused command exit0/26677ms,29tests162assertions,593installs607packages unchanged
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a production change requires broader regression verification
- **Source:** assumed — autonomous

## D22: Replace the three user-reported session snapshot pins with semantic assertions
- **Question:** Lane6 reported background:false whole-record equality failures and assigned the three session files to this lane
- **Options:** rerun to confirm or repin the default; preserve original migration/readback behavior and remove unrelated field pins
- **Chose:** no confirmation rerun. Legacy-exit migration asserts retained original row/location/state and exit semantics. CLI JSON asserts identity/provider/worktree/launch settings. Record tests assert launch/provider/prompt persistence, corruption isolation and launch-setting changes, not the whole evolving Session object. No background:false expectation was added.
- **Why:** The optional background field should not invalidate unrelated consumer contracts. The source already omits false on readback; the tests still needed the requested semantic repair instead of keeping brittle snapshots by accident.
- **Evidence:** user-reported sessions.test.ts754,cli.test.ts599,records.test.ts141/171/195/230; audited commitbcdaea1b3fa66582e9093c06f4e7707446fec5dc; exact three-file command169pass0fail488assertions8.30s; accepted lane6 repair messagec3e68fb2-0f89-4c14-a0f9-af09aab338ec
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a removed field was actually part of that test's original consumer contract
- **Source:** assumed — autonomous

## D23: Bound escaped native precheck evidence as JSON, not only as characters
- **Question:** Can a normalized4000-character stdout/stderr pair exceed the existing64KiB metadata invariant?
- **Options:** trust character caps; reject a successful check because its evidence is large; retain bounded tails with truthful truncation flags
- **Chose:** enforce the serialized UTF-8 JSON budget after normalization, shrinking only the longer output tail as needed and setting its truncation flag. The bounded command/result identity and exit evidence remain intact. An invalid internal record whose non-output metadata alone is oversized fails explicitly rather than looping.
- **Why:** A concrete valid control-character command and two bounded streams serialized to72251bytes before the fix. The boundary regression failed at65536; all25dispatcher tests then passed with108assertions. No provider launch retry or unrelated validation framework was added.
- **Evidence:** test/dispatch.test.ts control-character expansion regression, red72251bytes and green25pass0fail; dispatch.ts checkEvidence
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the public metadata budget changes
- **Source:** locked by docs/loop/decisions/m5-automations-core.md D11

## D24: Retain the real CLI/native-protocol smoke as a permanent flow test
- **Question:** How do the in-memory race regressions satisfy LOOP's public-client acceptance requirement?
- **Options:** discard the passing smoke; preserve its real-client flows as an isolated permanent test
- **Chose:** translate the same smoke into native-cli.test.ts using the existing typed structured CLI fixture convention. It launches the actual daemon and CLI, speaks the native Codex app-server protocol, exercises the real scheduler interval and cleans its ProcessScope/home in finally. No production mock launcher or copied-argument-only test substitutes for it.
- **Why:** The throwaway smoke proves current execution but would not prevent a later public API/CLI regression. The owned test passed1/0 with30assertions in67.34seconds before one incidental usage-message assertion was removed. The final focused gate re-exercises the retained version.
- **Evidence:** plugins/quirky.automations/test/native-cli.test.ts; AutoCliRegression observed command output; prior D20 runtime proof
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the public native protocol or CLI changes
- **Source:** locked by docs/roadmap.md

## D25: Derive the real scheduler acceptance deadline from both clock phases
- **Question:** Why can the native test see no scheduled row after its fixed85-second wait?
- **Options:** treat a passing retry as flaky clearance; change the daemon interval; derive the test's bound from the saved due time and independently phased poll
- **Chose:** keep the real60-second daemon timer unchanged. The test waits through saved nextRunAt plus one complete poll interval and10seconds transport margin; its outer watchdog covers the two possible minutes plus setup/cleanup. Removed the temporary manual-tick failure diagnostic.
- **Why:** The combined focused gate observed200pass/1timeout and never reached typecheck. A source-backed calculation using the real occurrence function proves a normal counterexample: daemon04:00:57, creation04:01:13, due04:02:00, firsttick04:01:57 (not due), secondtick04:02:57, or104000ms after creation. The original failing run's precise phase was not retained, so that phase is not claimed as observed. An instrumented different-phase run passed201/0/684assertions; it is not by itself proof of flakiness. The inadequate test bound is independently demonstrated.
- **Evidence:** failed focused prepass; actual nextAutomationOccurrenceAfter calculation; SchedulerIsolation source audit; instrumented six-file run201pass0fail136.88s
- **Reversibility:** easy
- **Confidence:** high for the invalid old bound and corrected phase calculation
- **Revisit if:** scheduler cadence or recurrence alignment changes
- **Source:** assumed — autonomous

## Progress
All original components and the background blocker-fix component are integrated and their owned worktrees removed. Source runtime hash959f4eb8 sent to lane6; optional false-background output now omitted and its incidental default assertion removed. Final native CLI smoke passed and all processes/home were cleaned. One integration catch-up is done. Next: commit final docs/wire cleanup, run the prepared affected prepass once, fix concrete diagnostics, run exactly one final C/S/X review and blocker-fix batch, add the single constrained-flow follow-up, then detach and authoritative queue land. No human asks or second item.
