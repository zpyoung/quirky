# m6-heimdall-core decisions

## D1: Preserve the queue's kernel-only boundary
- **Question:** brainstorming purpose, consumers, scope and acceptance
- **Options:** full source feature; deterministic core slice in queue
- **Chose:** kind registry/contract, enrollment/refusals/re-arm, journal/database/retention/traces, schedules/pacing/tick/gates/write-ahead attempts, budgets/parking/stop, worker adapter/mailbox/shutdown. Exclude leases, fleets, judgment, owner layer, controls/CLI/UI and concrete kinds.
- **Why:** roadmap names the kernel before concrete kinds; queue explicitly limits this item.
- **Evidence:** docs/roadmap.md:218-228; queue wait lane11; external heimdall.md Kernel pieces through stop predicates, Workers/mailbox, Shutdown
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** queue scope changes
- **Source:** locked by docs/loop/queue.json

## D2: Resolve all design questions autonomously under night mode
- **Question:** brainstorming gray areas, approval and specification format
- **Options:** ask a person; source-grounded autonomous defaults
- **Chose:** select API responses/errors/authentication/idempotency, data retention/generation and integration conflict/recovery/mapping areas. Discriminated outcomes preserve uncertainty; authority rederived by kind; exact fingerprint/approval scopes; facts durable, bounded resolved diagnostics; union active intervals; no blind replay. One markdown logic spec with technical section, self-review against source; no research swarm/visual/adhd/user wait.
- **Why:** authoritative unattended loop requires these defaults. AC1-11 state every in-scope observable behavior and boundary.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md Night mode and Answering a skill's questions; logic.md Decisions locked and AC1-11
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** an uncovered source flow conflicts
- **Source:** locked by docs/loop/LOOP.md

## D3: Keep kinds replaceable through declared public method hooks
- **Question:** registry/API design alternatives and data mapping
- **Options:** import private executable registry; serializable hook descriptors; move kernel into daemon
- **Chose:** built-in quirky.heimdall plugin. registerKind is plugin-only, validates declaring namespace for all hooks, persists descriptor, wraps hooks with context.call. Internal WatcherKind retains typed callbacks; public execute returns effect or worker request handled under the persisted attempt.
- **Why:** context.call is an RPC value boundary, not callback transport; direct imports bypass overrides. Existing provide/method conventions already expose caller pluginId and lazy activation.
- **Evidence:** packages/protocol/src/plugins.ts:50-82; packages/daemon/src/plugins/dispatch.ts:199-229; m0-daemon-api D12-D13; KernelContext source investigation
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** typed services are added to public plugin API
- **Source:** locked by docs/loop/decisions/m0-daemon-api.md

## D4: Preserve private-store downgrade refusal and forward-schema diagnostics
- **Question:** source newer-schema read-only behavior versus existing storage contract
- **Options:** silently open/migrate future schema; preserve refusal and inspect read-only
- **Chose:** context.openStore migrations, dataDir/store.db, FULL/foreign keys/busy5000; downgrade refusal prevents schedules/mutations. A readable newer schema can be inspected through a strictly read-only handle without migration or purge.
- **Why:** m0 D9/D10 bind one private database and refuse downgrade; source requires honest forward-schema diagnostics. Neither permits modifying a future database.
- **Evidence:** m0-daemon-api D9-D10; packages/daemon/src/plugins/stores.ts:92-121; heimdall.md Persistence and Edge cases
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** future schema cannot be read even diagnostically
- **Source:** locked by docs/loop/decisions/m0-daemon-api.md

## D5: OpenAI implementers and verified Gemini fallback review
- **Question:** SDD preflight model pairing, wave shape and checks
- **Options:** omp tasks/Opus; omp tasks/Gemini; same-family fallback
- **Chose:** IMPLEMENTER=omp-task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini. Three disjoint external component worktrees, one wave, cap3. Type-only contracts committed before dispatch. Parent owns shared-contract integration. Workers do not run builds/tests/formatters mid-flight; parent runs owned checks after barrier per harness requirements. One final review round and blocking fix batch under night mode.
- **Why:** Opus/Sonnet have no authenticated shipping model. Gemini verified google/gemini-3.1-pro-preview:high, Flash google/gemini-flash-latest:medium; Codex and Terra verified but same-family. No whole-suite baseline; land owns whole suite.
- **Evidence:** six pi-watch --check alias probes in /tmp; current LOOP Night mode
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual reviewer dispatch fails
- **Source:** assumed — autonomous

## D6: Implement against early dependencies without fabricating authority
- **Question:** worker orchestration readiness and coordinator authority
- **Options:** wait idle; forge a runtime caller from plugin identity; implement core and coordinate a safe service seam
- **Chose:** merged build/m6-orchestration-workers contracts. Continue independent core slices now; require a distinct plugin-service coordinator seam before worker smoke/landing. Never widen or fabricate RuntimeCallerEvidence. Sent automated lane9 an authority-gap/ownership request; reply path /tmp/quirky-lane11-orchestration-service-reply.md.
- **Why:** current dependency exposes session-attested coordinator types only; PluginContext.call has pluginId but no process attestation. Headless minted handles are not live worker credentials. Early-item workflow forbids ending only because a dependency is pending.
- **Evidence:** contracts.ts RuntimeCallerEvidence; runtime-contracts.ts; worker-integration.ts requireCoordinator; dispatch.ts callerOf; OrchestrationContract follow-up; orca terminal send accepted request0fbbba2c-d492-4515-80b9-e5838c5c9834 (delivery not attested)
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** service identity requires changing a locked authority decision
- **Source:** locked by docs/loop/decisions/m6-orchestration-core.md

## D7: Verify macOS and isolate every process
- **Question:** platform and process-safety boundaries
- **Options:** add untested OS integrations; portable core/macOS tests with explicit host hooks
- **Chose:** explicit suspend/wake methods, no Electron import; macOS verification only. Linux/Windows power integration and lifecycle verification deferred. Fresh temporary QUIRKY_HOME/HOME for all started daemons; owned processes always stopped; no CPU stress or real user state.
- **Why:** platform and isolation are locked; prior lane instruction forbids local CPU stress.
- **Evidence:** LOOP Hard rules and platform decisions; lane11 notes
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** another platform is authorized
- **Source:** deferred: platform

## D8: Add scoped service coordinator authority without weakening worker identity
- **Question:** confirmed missing prerequisite after the initial real-daemon smoke
- **Options:** fabricate session evidence; defer worker adapter; add owner-scoped service methods
- **Chose:** lane11 owns additive orchestration serviceRunCreate/Show, serviceWorkerStart, serviceCheck and serviceWorkerRelease after integrating lane1/lane9. Derive pluginId only from kernel PluginCaller, stable owner(pluginId,key), explicit Run on every call, separate service provenance/receipt namespace and null session coordinator. Ordinary methods remain session-authenticated. Worker launch/report/heartbeat/archive/close retain exact runtime attestation and custody. A schema-declared message-arrived event exposes only post-commit mailbox arrivals.
- **Why:** both prerequisite lanes confirmed this public extension and reserved service modules/hub integration to lane11. Missing API is reachable implementation work, not permission to forge authority or silently omit the adapter.
- **Evidence:** /tmp/quirky-lane11-orchestration-service-reply.md:23-35, lane1 confirmation; source contracts.ts RuntimeCallerEvidence and worker-integration.ts; services/contracts.ts
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** actual core/worker implementation cannot preserve scoped ownership with the public seam
- **Source:** assumed — autonomous

## D9: Confirm missing APIs through an actual isolated quirkyd process
- **Question:** runtime evidence before implementing the feature
- **Options:** infer absence from files; exercise daemon RPC
- **Chose:** actual packages/daemon/src/main.ts process under createProcessScope, fresh QUIRKY_HOME and HOME; call Heimdall inspect and serviceRunCreate.
- **Why:** both returned -32601 unknown method; daemon exited0 through owned cleanup. Hooks were written only beneath the temporary user HOME. This is missing-feature evidence, not a passing feature test.
- **Evidence:** /tmp/quirky-heimdall-l11-before.ts; smoke output REAL_DAEMON_MISSING_KERNEL_AND_SERVICE_APIS_CONFIRMED and daemonExit0
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** final smoke fails to exercise the same actual process/API surface
- **Source:** assumed — autonomous

## D10: Publish a fenced control seam without implementing lane10's controls
- **Question:** incoming lane10 request for safe runner mutations, deletion and host access
- **Options:** drain first then fence; fence synchronously before draining; duplicate the control plane in core
- **Chose:** optional generic Runner.withControl(operation,drain), provided in production; it synchronously fences new action commits before any drain and serializes control operations. KernelStore.remove atomically removes target state/history without any worker effect. Exported KernelService exposes readonly store/registry, runner(watcherId), inspect and lifecycle methods. Lane10 owns all listed control/fleet/API/CLI/UI files, untouched by lane11.
- **Why:** draining before fencing permits a new action to start behind the current tick. Store deletion is not worker authority. The published host accessors avoid control code importing private internals.
- **Evidence:** user lane10 interjection; plugins/quirky.heimdall/src/contracts.ts Runner/KernelStore; /tmp/quirky-lane10-core-control-reply.md; implementer messages confirming service exports
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** lane10 KernelControlHost needs a narrower adapter
- **Source:** assumed — autonomous

## D11: Expose exact worker identity only through a non-consuming owner read
- **Question:** lane10 fleet/detail needs worker identity and pending questions without consuming mail
- **Options:** use serviceCheck for refresh; expose incarnation in generic DispatchRow; owned serviceRunShow projection
- **Chose:** serviceRunShow returns owned Run, worker views with nullable session/incarnation and evidence-derived live/exited/unverifiable state, plus question rows joined to original body. Verify kernel caller plugin owns Run before disclosure. No check/ack, generation rotation, pointer delivery or mutation receipt on refresh. serviceReply supplies positive exact-question result; serviceWorkerStop takes expected session/incarnation and enters existing guarded lifecycle only after equality/owner checks.
- **Why:** consuming mail to draw fleet changes supervision state; a generic dispatch read must not grant exact stop authority. Null or unverifiable identity is never guessed from PID/handle.
- **Evidence:** lane10 user interjection; services/contracts.ts ServiceRunDetail/ServiceWorkerView/ServiceQuestionView; /tmp/quirky-lane10-core-control-reply.md Final signatures
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** prerequisite worker projection cannot provide verified owner-only identity
- **Source:** assumed — autonomous

## D12: Preserve owner configuration while reserving owner execution to lane12
- **Question:** lane12 owner item requests configuration and an owner-step insertion seam
- **Options:** duplicate owner behavior in core; publish inert configuration and explicit integration point
- **Chose:** optional Claude owner config/model/effort and intervention capability persist through enrollment. Lane12 owns owner/*, typed deviation vocabulary and kind owner adapter. Runner has a documented insertion point after mailbox/recovery/stop/budget and before disabled/paused. No speculative owner runtime or nonexistent owner-module import in this item. Hub integration is serialized with lane10 after core merge.
- **Why:** source owner is Claude-only and core item explicitly excludes owner execution. Keeping the step reachable before disabled/paused does not grant general kind actions a gate bypass.
- **Evidence:** lane12 user interjection; contracts.ts OwnerConfig and enrollment fields; /tmp/quirky-lane12-owner-core-reply.md; runner implementer confirmation
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** lane12 publishes a different source-grounded hook contract
- **Source:** assumed — autonomous

## D13: Repair escaped adapter writes before accepting the wave
- **Question:** completed component audit found no adapter source in its assigned worktree
- **Options:** accept escaped main edits; discard code; pause and transfer exact declared-scope output
- **Chose:** pause writers, obtain adapter's exact physical-path acknowledgement, preserve its six new scoped source/test/manifest files and move them losslessly into the assigned adapter worktree using specialized MV. Runner confirmed correct absolute source; no runner files moved. Preserve unrelated .serena metadata. Require absolute file-tool paths and retain final barrier audit/check gate.
- **Why:** relative file-tool paths inherited the parent workspace, despite the task naming a separate worktree. Bash cwd does not retarget file tools. Accepting untracked main edits would bypass isolation and attribution; discarding would lose authored work.
- **Evidence:** adapter HEAD6764039 scope audit returned only .serena/project.local.yml; agent actual pwd/path acknowledgement; move snapshot hashes DBF5/157C/898C/1FCE/8793/0521; /tmp/quirky-heimdall-l11-routing-repair.md
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** another component writes outside its absolute target
- **Source:** assumed — autonomous

## D14: Preserve Run sender authority for owner-to-worker messages
- **Question:** lane12 owner message-worker cannot use raw session send without losing Run authority
- **Options:** raw session input; generic unscoped service send; exact owned-Run dispatch mailbox method
- **Chose:** serviceSend takes explicit owned runId, dispatchId, body and durable request identity; proves membership, emits a normal mailbox message with canonical Run sender, uses the same receipt store and post-commit arrival pipeline. It cannot spoof worker_done/heartbeat or answer a question implicitly. serviceReply remains exact question handling; generic workerShow/read follows owned-run membership proof.
- **Why:** service identity is real coordinator authority, not a process/session credential. Message and question semantics must stay distinct.
- **Evidence:** lane12 follow-up user interjection; services/contracts.ts ServiceSendParams/result; /tmp/quirky-lane12-owner-core-reply.md
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** existing core messaging cannot represent distinct service sender provenance
- **Source:** assumed — autonomous

## D15: Restore the actual landed Codex resolver omitted by a dependency merge
- **Question:** lane10 reports desktop build fails because structured/main.ts imports missing ./codex-path
- **Options:** rerun to reconfirm; invent fallback; restore the real landed dependency module
- **Chose:** accept the reported failure as ground truth; inspect source/history, restore codex-path.ts exactly from build/roadmap, and include it before core landing. No resolver behavior or provider fallback changed.
- **Why:** build/m5-structured-runner has already been deleted after landing. The helper exists on build/roadmap from ef16bc50; merging that ancestor reports already-up-to-date, because a later dependency history merge retains deletion2aba9d9c. Restoring the exact committed source repairs the incomplete merge without substituting another implementation.
- **Evidence:** user lane10 build report; main.ts:17; git full-history path log; source hash46b00aeb0851d2b540b1498d51969e689a3bf33d matches both restored file and build/roadmap blob. No build rerun to reconfirm.
- **Reversibility:** easy
- **Confidence:** high for exact source restoration; runtime/build verification remains pending
- **Revisit if:** final merged dependency build fails after the actual helper is present
- **Source:** assumed — autonomous

## D16: Replace a failed persistence writer without discarding its regression source
- **Question:** the store agent acknowledged production modules were absent after rejected oversized mutations
- **Options:** continue reporting planned files; discard its tests; stop the writer and repartition concrete implementation
- **Chose:** cancel/fence the original writer, preserve its test file, parent implements actual store.ts in its assigned worktree, and a fresh bounded registry/enrollment task owns only those two modules in a new isolated worktree. Correct mechanical test imports and real failure injection; delete forwarding-only assertions rather than pinning implementation details. No checks during in-flight edits.
- **Why:** failed mutations executed nothing; source absence was confirmed by the writer and both integrating lanes. Repartitioning produces actual reachable code while preserving behavioral requirements and test provenance. All file-tool paths are absolute.
- **Evidence:** agent cancellation result; physical-path/source acknowledgement; /tmp/quirky-lane11-source-checkpoint.md; actual store.ts written and preserved enrollment-store.test.ts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** replacement scope cannot satisfy the same AC1-4 contract
- **Source:** assumed — autonomous

## D17: Make RPC description and worker-request replies explicit
- **Question:** serializable kind hooks cannot return callbacks or synchronous RPC results
- **Options:** pass dispatch callbacks over RPC; guess result keys; publish exact serializable replies
- **Chose:** KindExecuteReply is ExecuteResult or `{worker:WorkerRequest}`, never both. Registry uses the internal dispatchWorker capability under the recorded attempt. Description hooks support async results; runner awaits description and rechecks its lifecycle fence before storing trace JSON. Nullable owner config and optional naturalKey/dispatch/message/trigger deviation fields preserve lane12's published types without importing or running owner modules.
- **Why:** Promise-as-JSON loses the trace summary; callbacks cannot cross the shared RPC boundary. Exact wire fields let operator smoke drive real worker effects rather than fake forwarding.
- **Evidence:** contracts.ts KindExecuteReply/WatcherKind; runner readSnapshot integration correction; /tmp/quirky-lane10-core-control-reply.md Exact result; lane12 published owner/contracts.ts
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** actual hook API proof shows a different source-grounded serialization need
- **Source:** assumed — autonomous

## D18: Accept source checkpoints only with observed behavioral checks
- **Question:** integrated kernel components exposed both real defects and incidental test expectations
- **Options:** trust handoff reports; pin observed revision counts/trace wording; exercise invariants and repair causes
- **Chose:** actual SQLite migration regression proved mailbox sequence reuse (expected101, got2), then passed after preserving the prior autoincrement watermark. Capability regression proved inherited constructor allowed an ungranted action, then passed after requiring an own explicit on/gated grant. Contact-loss regression proved8000ms charged instead of1000ms, then passed with checkpoint-only close. Fixed runner's timing constants import from the owning budget module, without re-export shims. Deleted incidental attempt-row-count/trace-wording assertions; retained the32-effect bound and strengthened unresolved-to-terminal transition proof.
- **Why:** append-only attempt revisions legitimately create multiple rows per effect; trace summary wording is not the terminal safety invariant. Actual counters, permission boundaries, durable cursor identity and positive outcome transitions are consumer-visible.
- **Evidence:** targeted migration/capability/contact red-green outputs; final integrated five-file check51pass0fail172assertions; contact targeted rerun1pass0fail3assertions. Resolver real-child smoke also passed. No daemon/API/worker/whole-feature pass claim from these unit checks.
- **Reversibility:** easy
- **Confidence:** high for exercised paths; service backend and full API verification remain pending
- **Revisit if:** actual daemon or dependency integration shows a contract mismatch
- **Source:** assumed — autonomous

## D19: Retain budget history as facts and release only positively resolved trace pins
- **Question:** retention and stopped pacing edge regressions after the first source checkpoint
- **Options:** treat budget rows as reclaimable diagnostics; keep trace pins forever; follow durable budget/temporary pin contracts
- **Chose:** interval-open/checkpoint/close are facts, not resolved observations. Positive resolution of all known attempts releases temporary trace pins before applying the50-row ring; unknown pin contexts remain conservative. A stopped pacing policy returns no timer even when prior gate/error backoff is nonzero.
- **Why:** actual regression showed320ms of completed work shrinking to250ms under the observation ring; a resolved watcher retained60pinned traces instead of50; stopped policy scheduled120000ms rather than no timer. Each failed before and passed after the bounded fix. No terminal or worker outcome is inferred from absence.
- **Evidence:** three targeted Bun regression outputs; runner interval classes, store attemptRetention/retain, pacingDelay stopped boundary; owner handoff requires owner-in-flight intervals use fact class too
- **Reversibility:** easy
- **Confidence:** high for exercised boundaries
- **Revisit if:** full kernel/API gates show a changed budget or pin lifecycle
- **Source:** assumed — autonomous

## D20: Apply the aged-item night-mode exit policy
- **Question:** whether to begin a new final-review campaign after source/dependency integration
- **Options:** start a new review/dogfood round; follow the authoritative already-aged item rule
- **Chose:** finish all reachable API/worker behavior, affected checks, scripts, typecheck and actual smoke, then land without starting an unstarted review campaign. Existing reported blockers still require fixes. Readiness probes/scratch directories were not review rounds.
- **Why:** first spec commit6764039 is2026-10-27T18:51:54-05:00; observed clock2026-10-28T02:17:27Z makes the item at least145minutes old. Night mode explicitly says already-aged items land as soon as own checks pass and skip review/dogfood not yet started. No reachable acceptance invariant is removed.
- **Evidence:** observed git commit timestamp/date output; current LOOP Night mode; no pi-watch review prompt was dispatched
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the operator changes the night-mode instruction
- **Source:** locked by docs/loop/LOOP.md

## D21: Defer automatic native host-power binding behind a real trusted publisher
- **Question:** scheduling source requires actual OS sleep/wake, but the existing public daemon API supplies no native power source
- **Options:** pretend asynchronous subscription is native binding; infer sleep from timer delay; add an unverified native IOKit/ack subsystem now; separate the native producer flow
- **Chose:** ship/test explicit runner suspend/resume and conservative known-contact accounting, and track automatic macOS power binding in dependent item m6-heimdall-host-power, now confirmed todo in the authoritative queue. The follow-up must provide an in-process trusted daemon producer plus pre-sleep fencing/ack callback, bind all runners, clean up native subscriptions and verify on an idle macOS/native host. No helper processes or elapsed-delay inference.
- **Why:** repository evidence finds no sleep/wake producer. Generic plugin subscriptions deliver asynchronously after the emitter, so merely subscribing cannot fence work before a native sleep acknowledgement. Native provider/ack semantics are a separate missing kernel capability; night mode forbids starting this new native flow after the item is aged. Remaining supervision works without claiming automatic host-power integration.
- **Evidence:** HostLifecycleSeam source report; daemon.ts:132-150, desktop index.ts:141-142,166-207, plugin events.ts:61-70; runner suspend/resume tests; /tmp/quirky-heimdall-l11-host-power-item.json
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a trusted native host publisher/public acknowledgement seam becomes available
- **Source:** deferred: automatic host sleep/wake binding

## D22: Wire the concrete service facade through the actual shared worker components
- **Question:** service source ports alone do not make the eight endpoints executable
- **Options:** stub a service backend; duplicate state; compose real core/message/worker instances
- **Chose:** actual service coordinator and handlers share OrchestrationCore receipts/store, OrchestrationMessages, and registered WorkerComponents. Main applies core, worker and service migrations in order and provides all eight methods. Owner views enumerate supervised Dispatches without consuming mail and separate assignmentActive from liveness. Ordinary session useRun cannot bind service-owned Runs.
- **Why:** a headless plugin principal is coordinator authority, never process attestation. Shared lifecycle/archive/close checks and after-commit events must remain real rather than be replaced by a fixture.
- **Evidence:** src/services/coordinator.ts, main.ts, core.ts and messaging.ts; real service admission test1pass19assertions; broader worker/API verification remains pending
- **Reversibility:** medium
- **Confidence:** high for source composition; runtime acceptance remains gated
- **Revisit if:** actual worker/answer/stop/release smoke exposes a missing or duplicated authority path
- **Source:** assumed — autonomous

## D23: Use the supported manifest subset and actual core nesting policy
- **Question:** real daemon and worker-start diagnostics exposed metadata and undeclared-setting dependencies
- **Options:** loosen global validators; swallow errors/default an undeclared setting; correct metadata and share the existing policy
- **Chose:** remove unsupported minLength from the service key schema while retaining semantic non-empty validation. Keep reset confirmation and remove duplicate primary alias. Worker preamble uses the same MAX_NESTED_DEPTH=1 as core admission, not an undeclared nestedWorkerMaxDepth setting; the later settings slice owns protected configuration.
- **Why:** actual plugin.list rejected orchestration for minLength; after that repair service admission passed. A real launched worker then failed at authority_attached because the missing setting threw. Adding a phantom configurable knob would disagree with the current enforced cap; a silent catch would hide the defect.
- **Evidence:** service discovery diagnostic and owned cleanup; core.serviceRunCreate key validation; worker-readiness result failed/authority_attached/no-setting; core cap and workers/start.ts shared import
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the settings slice provides a real protected, uniform dynamic-depth policy
- **Source:** assumed — autonomous

## D24: Make provider fixtures input-driven and retain real caller authentication
- **Question:** real worker startup never observed composer readiness, while default five-second test bounds hid the configured twenty-second operation result
- **Options:** relax production readiness; timer-based fake working state; actual provider UI/input barriers with correctly bounded tests
- **Chose:** reuse the launched acceptance-agent transport, advertise the bracketed paste it handles, and enqueue real CLI work only after its observed turn_started event. Worker tests use the existing sixty-second E2E convention; production readiness limits are unchanged. Correct CLI numeric text20000 rather than a JavaScript underscore literal. Remove asymmetric matcher mutations of reused identities; keep primitive authentication/outcome invariants.
- **Why:** the old timer emitted working without a delivered prompt; actual readiness diagnostic returned failed after20117ms and no input. The new fixture reached the next genuine authority stage rather than spoof readiness or caller evidence. Whole-daemon1532ms shutdown includes other plugins; replace the incidental exact1500ms assertion with blocked-hook fencing and durable unknown-outcome restart proof, not a larger timing pin.
- **Evidence:** real readiness diagnostic before/after fixture change; Bun default-five-second timeout output; user-confirmed asymmetric matcher mutation; actual kernel API6pass35assertions after the stronger lifecycle test
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual guarded worker flow still fails with the corrected transport
- **Source:** assumed — autonomous

## D25: Preserve actual native provider identity and forward journal versions
- **Question:** dependency merge resolution diverged from verified native-provider semantics
- **Options:** persist a fabricated fresh/idle native ID; journal receipt/launch reorder; keep provider-confirmed IDs and stable migrations
- **Chose:** Claude stores fresh native IDs only after SDK init, keeps known real resume identity/transcript and current-run guards, and treats failed results honestly. Preserve journal v1 and send receipts v2; add launch options as v3 so existing v2 stores migrate correctly. Preserve real Codex connection/path helpers exactly.
- **Why:** Quirky session/lease identity is not the provider conversation ID. Reordering a completed migration can skip required tables in existing homes.
- **Evidence:** scoped NativeDependencyCoherence comparison with7f789885; claude-runner.ts/journal.ts/native tests; codex-connection blob b354974c894cb2eeb9032200919b2c3b13a7d3b4 unchanged
- **Reversibility:** medium
- **Confidence:** high for source reconciliation; owned native gates remain required
- **Revisit if:** actual native child/session history checks fail
- **Source:** assumed — autonomous

## D26: Publish executable service source without overstating unresolved worker checks
- **Question:** downstream control/owner lanes need real endpoint providers to exercise their actual callers
- **Options:** publish interfaces only; hide current failures; publish the concrete checkpoint with exact evidence
- **Chose:** publish all eight real facade providers/main/manifest and the isolated c8639c31 admission repair. Source-backed ordinary/core native dependency reconciliations remain included; no owner/control item is imported. Both service and session worker placement now admit the actually supported native Claude and Codex agents, retaining the public structured capability check.
- **Why:** real service tests now reach owner/mailbox/worker logic. The latest run has4pass/2fail, exposing a live-supervised-worker transition error in stop and a failed early-report release setup; those remain blocking fixes, not a passing feature claim. The corrected real provider smoke reached ready/input_accepted/observed with a genuine live assignment in2092ms.
- **Evidence:** actual service4pass2fail output; real readiness smoke and owned cleanup; kernel units63pass273assertions; kernel daemon API6pass35assertions; user native Codex admission report and runtime.ts two supported-agent guards
- **Reversibility:** easy
- **Confidence:** high for executable source and stated evidence
- **Revisit if:** remaining actual worker flows or required final gates fail
- **Source:** assumed — autonomous

## D27: Use canonical Session launch settings, not a second private snapshot
- **Question:** whether the dependency reconciliation should retain journal launch-options v3 after the public session snapshot was restored
- **Options:** maintain two sources; prefer private options over the public snapshot; use the canonical Session.launchSettings only
- **Chose:** remove the unlanded private launch-options table, migration, codec and methods; create uses resolved native values and resume uses launchOptionsFromSnapshot(old). Preserve journal v1 and send receipts v2 unchanged, account preparation, real provider identity and lease environment.
- **Why:** the public session record already persists model/effort and provenance. A private preferred copy can diverge. All owned executions use disposable homes; the private third step was an unlanded item addition, not a deployed migration to preserve. This supersedes D25 only for the duplicate launch-options migration.
- **Evidence:** NativeCanonicalAudit source report; structured journal/main references; identical real SQLite history smoke passed before and after removal, retaining messages, sequence and completed receipt identity; lane12 canonical-source correction
- **Reversibility:** medium
- **Confidence:** high for history preservation; final structured API gates remain required
- **Revisit if:** evidence shows a non-disposable deployed home applied the private third migration
- **Source:** supersedes m6-heimdall-core D25

## D28: Persist an exact logical stop fence before asynchronous process control
- **Question:** correct-identity worker stop hit the public live-worker Task guard, then exposed a missing durable post-commit checkpoint
- **Options:** weaken manual Task guards; claim stopped before close; add a narrow internal fence and accepted checkpoint
- **Chose:** blockTaskForWorkerStop validates the supervised Task/Dispatch and persisted stopping state inside acceptance. Keep manual transitions guarded and preserve exact identity. Stop and release persist accepted identity-only checkpoints before effects; pending replay remains operation_unknown, not stopped or released.
- **Why:** revoking scheduling is a synchronous logical fence, distinct from positive process termination. An interrupted effect cannot be reported as success.
- **Evidence:** actual service stop task_not_startable, then post-commit checkpoint rejection; worker/core coordinated seam and checkpoint source; final actual stop/release verification remains pending
- **Reversibility:** medium
- **Confidence:** high for the invariant; runtime confirmation remains gated
- **Revisit if:** actual exact-stop or ambiguous-close proofs fail
- **Source:** assumed — autonomous

## D29: Keep structured accepted-work observation distinct from startup acknowledgement
- **Question:** native fixtures reached initialize/thread/start/turn/start but no assistant, tool or result evidence
- **Options:** treat optimistic working as ready; inflate deadlines; emit input-driven accepted-work evidence from the external fixture
- **Chose:** preserve the production observer. Apply isolated session pointer fix42791478 so worker_start reaches structured/send's existing startup wait while mailbox_pointer retains busy refusal. Use existing input-driven native approval/output behavior, never timer-fake readiness.
- **Why:** a valid native turn ID proves request acknowledgement, not accepted work. Liveness also does not imply an active assignment; the earlier run_required report had an already-failed Dispatch, so active status filters remain unchanged.
- **Evidence:** actual attached child worker-show identity with failed Dispatch; native request/working/provider-ID diagnostics; peer14pointer checks58assertions; ordinary sender active filters and structured observer source
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a real output-producing native provider cannot reach ready through the unchanged observer
- **Source:** assumed — autonomous

## D30: Separate logical receipt identity from a fresh CLI transport invocation
- **Question:** a completed CLI retry returned the same Run but replayed:false because generic RPC caching intercepted the call before the plugin ledger
- **Options:** bypass daemon caching by parameter shape; add method metadata; weaken the documented replay result; use the existing explicit transport request-ID option
- **Chose:** expose the existing CallOptions.requestId through the CLI call surface. Only explicit durable orchestration mutation calls supply a fresh transport UUID per invocation; logical params.requestId remains stable. Connection-loss resends keep their transport identity. Other methods retain the existing generic retry behavior.
- **Why:** the feature contract requires completed logical receipts to report replayed:true and pending live requests to join, while abandoned pending receipts remain operation_unknown. The two ledgers must not mask each other or create duplicate effects.
- **Evidence:** affected CLI retry failure; DaemonLink.nextRequestId and daemon RequestLog trace; orchestration.md mutation idempotency lines538-554; existing protocol CallOptions requestId
- **Reversibility:** medium
- **Confidence:** high for the contract; final CLI verification remains required
- **Revisit if:** connection-loss resends or another method's generic idempotency changes
- **Source:** locked by /Users/zpyoung/PycharmProjects/PERSONAL/quirky/research/orca-features/orchestration.md

## D31: Describe real Codex structured model and effort support in the catalog
- **Question:** a detected and enabled Codex was refused because its public launch catalog lacked structured model mapping
- **Options:** fake the runtime capability; remove validation; declare the actual native mappings
- **Chose:** add model/effort mappings through the existing agent launch catalog and keep the runtime gate and option validation. Native Codex receives the same public app-server option names it already implements.
- **Why:** provider support and the public catalog must agree. A local runtime override would leave create/resume and worker launch inconsistent.
- **Evidence:** native kernel readonly evidence211; agents/options structured contract and service calculation; CodexRunner public model/effort inputs; catalog source correction
- **Reversibility:** easy
- **Confidence:** high for the mapping; native end-to-end verification remains required
- **Revisit if:** a supported pick cannot reach the real native provider unchanged
- **Source:** assumed — autonomous

## D32: Settle Worker state from the accepted attested report
- **Question:** a real accepted worker_done completed Task/Dispatch but left Worker ready, so guarded release refused
- **Options:** infer success from process exit; bypass release guards; settle the Worker atomically with its verified report
- **Chose:** acceptReport records the reported succeeded/failed outcome in the same store transaction, including early reports through ready. Duplicates preserve the outcome and stopping workers remain fenced.
- **Why:** positive authenticated report evidence, not liveness or exit, authorizes outcome settlement and later cleanup.
- **Evidence:** real child CLI accepted report followed by release refusal; lifecycle source and regressions; subsequent real release returned released with exact process close and retained archive identity
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a late or duplicate report changes a fenced attempt or another Dispatch
- **Source:** assumed — autonomous

## D33: Repair fixture transport and native API preconditions, not production readiness
- **Question:** partial JSON replies, stale agent discovery and missing fake session provider persistence obscured real acceptance paths
- **Options:** retry malformed JSON; inflate readiness deadlines; fabricate session authority; implement the actual fixture protocols
- **Chose:** publish private CLI replies by atomic rename; refresh and enable private test binaries through the public catalog; advertise handled bracketed-paste mode before input; persist provider IDs supplied by native initialization in the fake session API; wait for public settled events. Input-driven held native commentary supplies real journal evidence.
- **Why:** every actor still launches as an actual child with the kernel-issued lease. A timer, a process ID or optimistic working status is not accepted-work proof.
- **Evidence:** observed JSON EOF and2794362f; native no-launchable-agent evidence; missing fake setProviderSession failure; native input-driven fixture source and public-event barrier
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the corrected genuine transport still cannot exercise an included flow
- **Source:** assumed — autonomous

## Progress
Iteration4: executable checkpoint df799424 (peer merge e410f69f) provides all eight real owner-scoped service APIs, shared worker lifecycle and plugin hubs; no stubs or forged session principal. Own kernel units63pass273assertions and real daemon API6pass35assertions. Latest service run4pass2fail exposed durable stop checkpoint and an invalid provider-exit/terminal-exit fixture assumption; both corrected in source, not yet claimed passing. Current own compiler improved136diagnostics27files to26diagnostics7files; the remaining source/test fixes are integrated but final compiler verification is pending. Native canonical history smoke passes before/after D27; isolated pointer fix is extracted without owner/control hubs. Core agent is completing actual ordinary Run-sender response schemas and pending worker-question persistence, based on peer public CLI evidence. Next: finish that barrier, exercise all8 real services and native kind-to-worker-to-terminal/archive smoke, affected remote suite/scripts/typecheck, docs/changelog, deps-ready and one final roadmap catchup, then queue land. D20 skips only the unstarted review campaign; D21 is the sole deferred native host-power flow. No human ask.
