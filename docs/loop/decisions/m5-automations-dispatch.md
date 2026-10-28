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

## Progress
Design and self-reviewed combined spec written. Shared dispatch-contract.ts committed before implementers. Next: implement three disjoint components, own-file behavioral tests, actual isolated daemon/CLI/native-process smoke, one affected gate and review, catch-up and queue land. Only this item this iteration. No human asks. Follow-up for the two explicitly constrained flows must be added once immediately before land.
