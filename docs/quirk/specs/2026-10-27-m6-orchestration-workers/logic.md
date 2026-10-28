# Orchestration workers

## Status & amendments

Status: Implemented and post-integration verified through API/CLI, kernel and real terminal-UI scenarios. The authoritative queue records the final merge verdict. Technical decisions are the final section of this document. UI proof used an explicit private profile with the optional editor disabled; the observed default-profile editor activation timeout is recorded in the decision log and BLOCKERS.md.

**Amendments:** 2026-10-27 — initial combined specification for the complete two-part queue item.

2026-10-27 — lane11 service coordination adds a genuine kernel-plugin-owned coordinator variant to worker start/control, not worker report authority. Service API implementation is owned by lane11 after dependency integration; ordinary session entry points remain session-attested.

## Purpose and conceptual model

A coordinator creates durable Tasks, starts supervised attempts, receives exactly authorized completion and decides the next owner of each settled resource. A Worker is execution of one Dispatch in a terminal or background structured session; a Dispatch, not a display title or copied Task ID, carries authority. A terminal resource records custody independently from Task success. Settlement never closes a terminal automatically.

The core plugin owns Run/Task/Dispatch/mailbox/receipt authority. Worker modules extend that same plugin with staged runtime execution, resource custody, output archives and fleet evidence. Runtime effects use the public plugin API only. A worker's missing heartbeat, idle prompt, lost transport, stale status or readiness timeout is not proof that it exited.

## Scope and non-goals

In scope: both parts of `m6-orchestration-workers`: worker-start admission/placement/launch/readiness/preamble/turn observation/receipts; terminal and structured background workers; worker_done/heartbeat settlement; low-level dispatch/show; stop/abandon/exit/retry; retain/release/user takeover; output and fleet projection.

Non-goals: federation transport and remote execution host implementation; installing skills, orchestration Settings/setup cards and task-terminal links; retired scheduler/legacy adoption; Heimdall policy and objective/sitter flows. These are other queue slices, not reasons to omit local worker lifecycle. `includeRemote` must report capability/host limits honestly, not fabricate rows. No visible chat-tab feature is added: structured workers are background sessions per the architecture decision. Existing terminal rows remain the visible terminal surface.

## Data flow

The authenticated coordinator submits a validated request. Before irreversible effects, one receipt transaction accepts a Task/Dispatch/starting Worker and stamps depth/retry lineage. Placement returns the exact session whose custody is immediately recorded. Readiness and safe preamble delivery attach exact process authority and settle the staged receipt. Accepted reports atomically settle Task/Dispatch/Worker, reconcile mail/questions and promote dependencies. A later explicit retain/release/reuse decides custody. Release freezes bounded output before closing the exact owned incarnation. Fleet and read APIs expose durable and live evidence separately.

## Key decisions & rationale

Recommended: focused worker modules inside lazy `quirky.orchestration`, sharing core transactions and public runtime seams. Alternative: another worker plugin/store, rejected because report settlement becomes cross-database authority. Alternative: an in-memory supervisor, rejected because accepted launch/close ambiguity and requested-release recovery must survive restart.

All relevant API/CLI/Data/Integration gray areas are selected. The feature doc establishes purpose, consumers, primary behavior, constraints, success and full scope. Autonomous defaults below resolve the remaining observable choices; implementation details are confined to the technical section.

## Decisions Locked

### API, flags and output
- Native Quirky namespaced RPC results; `orchestration` CLI alias and documented kebab-case flags, not an Orca compatibility envelope — assumed, fast-tracked; core D5.
- Exactly one Task or spec; exactly one launch agent or existing terminal. Retry requires a Task and latest eligible settled prior Dispatch. Placement-only flags are refused on existing worktrees. Model/effort validation reuses provider public catalog and refuses unsupported options before Task effects — source locked.
- Readiness default60000ms, turn observation bounded30000ms; validate derived timer budget before effects. Task spec maximum1214464 UTF-8 bytes. Invalid inputs include exact recovery instructions — source locked.
- CLI exits1 for any start receipt other than ready, stop_unknown and release_unknown; receipt is still printed — source locked.

### Identity, modes and conflicts
- Stable Quirky session IDs plus independently kernel-attested process/structured lease incarnation. Provider transcript/session ID and client session metadata are not credentials — core D4/D15 locked.
- Terminal by default; honor actual Quirky launch-mode preference when available and supported, otherwise an explicit mode/fallback receipt. Existing-terminal reuse is terminal. A refused structured launch does not silently become a terminal — source locked and architecture background-only decision.
- Admission/claim/report/custody transitions use compare-and-set inside shared core transactions. One live Dispatch per Task and assignee incarnation; low-level dispatch cannot bypass nesting. Nesting derives deepest active role even if a worker creates a new Run — core D6 locked.
- Same UUID/input replays a durable receipt; changed payload fails request_mismatch; pending after restart becomes operation_unknown and never blindly repeats effects — core D11 locked.

### Recovery and ownership
- Positive report outranks an unproven start; wrong-process, stale attempt and stopping-worker reports do not settle work. Same-outcome duplicate completion is idempotent; changed-outcome completion is rejected — source locked.
- Real user input changes custody to user_owned/retained; injected input, terminal query replies and preamble delivery do not. Custody begins at creation, before readiness — source locked.
- No automatic stop/release on idle, timeout, heartbeat, question or stale status. Release requires accepted succeeded/failed settlement, frozen archive and exact owned identity. Stop/abandon retain worktrees/setup/configured/coordinator/external resources — source locked.
- Abandon fences without any process action and warns resources may remain alive. Retry is explicit, carries infrastructure failure budget3 and releases an owned failed-start terminal safely — source locked.

### Output and fleet
- Auto output selects only exact provider transcript evidence, else typed labelled terminal fallback. Pages pin source identity; archive remains readable after close — source locked.
- Fleet defaults to caller's bound Run; opaque snapshot pagination at most100, legacy no-limit cap5000; live/exited/unverifiable evidence stays explicit. Unverifiable never suggests stop/release — source locked.
- No new native window/menu/tray/dialog behavior; visible terminal input/custody scenarios use web dogfood. Linux/Windows lifecycle/readiness/input-origin verification is deferred platform work — locked platform scope.

## Behavior, scenarios and acceptance criteria

Each AC is exercised through the actual daemon API or CLI. Provider fixtures may replace external model transports, not orchestration behavior. Each process-starting test uses a fresh private home and stops all owned processes. Examples below describe public state before and after, not implementation copies.

### AC1 — Admission refuses before effects

Before: bound coordinator, no Tasks; enabled catalog has terminal agent A. Start with both task/spec, both agent/terminal, no agent, oversized UTF-8 spec, invalid timer, unsupported effort/model or placement-only flags on current worktree. After: typed refusal; no Task/Dispatch/terminal/worktree effect. Start from unbound/stale coordinator refuses consumer_fenced/run_required. Existing Task from another Run is task_not_found. Spec creation retains title/deps/parent/displayName.

### AC2 — Terminal launch stages and receipt

Before: ready TaskT, current workspaceW, coordinatorC selected. Start A in W. Observe starting/accepted → exact sessionS custody → readiness → authority_attached → preamble delivery → input_accepted. After: ready Worker and dispatched Task/Dispatch; receipt identifies requested/effective launch, mode, setup, timeout, effects and no unexplained residuals. C remains selected. Existing folder workspaces need no Git.

### AC3 — New placement and setup policy

Before: Git project with explicit base/setup policy. new-child creates W with coordinator workspace parent; new-top-level creates W with no parent and requested repo/name/base/display/comment/setup. Agent-first placement uses its startup terminal, not an extra unwanted shell. Wait-for-setup gates preamble; start-immediately permits setup beside it and sends one setup result status (high on failure). Record all created worktree/agent/setup/configured-tab effects; no focus theft. Folder projects refuse new worktree placement before effects.

### AC4 — Existing terminal admission and custody transfer

Before: coordinatorC, settled worker terminalS in W, plain shellP and agentX in another workspace. Reuse S for new ready TaskU: exact authority attaches to new Dispatch; prior resource is transferred and cannot later release S. C, P, wrong-workspace X, already-active S and changed incarnation are refused without typing. Pre-existing external agent has external custody and cannot be closed by release.

### AC5 — Background structured mode

Before: supported background provider selected and ready Task. Start structured worker: no PTY, correct model/effort passed once; preamble is its initial journaled turn, lease authority attached; receipt reports structured/preferred/reason. Setup gate shares readiness deadline. Unsupported preference or terminal reuse reports explicit terminal fallback; a structured launch refusal fails honestly without silently starting terminal. Stop, done, read and retain/release work through the same worker API.

### AC6 — Readiness, accepted write and unknown outcome

Before: fresh agent has composer marker, reused agent has idle evidence. Only after readiness may preamble submit through safe-send. Approval/question startup is labelled blocked, not blindly typed into. Accepted bytes with observed turn or permission yields ready; provider with genuinely unsupported observation yields ready/unsupported. Accepted write without turn proof yields start_unknown/outcome_unknown and blocked Task, with worker-show/read/abandon recovery commands; no resubmit. Failed-before-task terminal remains reclaimable with worker-release instruction. Ambiguous placement/network effect remains unknown, not falsely failed/rolled back.

### AC7 — Worker protocol and completion

Before: active exact workerD. Preamble names coordinator/run/task/dispatch/session, brief, authorized CLI, five-minute heartbeat (skip while blocking), checkpoint check, resumable ask, escalation and exactly one nonempty succeeded/failed completion. After done: Task and Dispatch complete/failed and Worker succeeds/fails atomically; pending questions close, unread heartbeats reconcile, successful dependency becomes ready. Worker idles and receives a fresh preamble only for a new Dispatch; it does not poll/sleep/exit the shell after reporting. Completion prose cannot override an explicit failed outcome.

### AC8 — Completion authority and races

Before: D starting or start_unknown with a live exact process. Its authorized report can settle it without later readiness callbacks reverting settlement. Same-outcome duplicate is accepted duplicate:true; conflicting duplicate, old retry Dispatch, copied ID from another process, stopped/stopping and wrong Task are rejected with auditable lifecycle reasons, never completing a newer Task. Heartbeat refreshes only the active exact attempt and routes to its Run. Readiness/exit/report races never resurrect a settled attempt.

### AC9 — Low-level dispatch and show

Before: ready T and explicitly created exact agentS. dry-run returns preamble with preview ID and changes nothing. Normal dispatch creates authority context only (no supervised Worker/resource); optional inject verifies recognized agent and exact stable incarnation before safe preamble. return-preamble/show return correct task/attempt-specific text; show without dispatch is null and optional preview. Stop/abandon context-only dispatch fences without process action; retain/release never close it. Atomic duplicate claims and depth caps apply here too.

### AC10 — Unexpected exit and circuit breaker

Before: exact active terminal worker. Certified exit sets failed/process_exited with reason and re-derives Task ready unless budget3 is exhausted; unexpected exit emits one high escalation, deliberate operator close does not. A same-runtime in-flight stop's exit instead completes stopped. Repeated/replayed exit is idempotent. No stale old-incarnation exit settles its replacement. Three infrastructure failures exhaust lineage and refuse another retry; worker-reported failure is not infrastructure failure.

### AC11 — Stop is exact and uncertainty honest

Before: ready/start_unknown exact owned agent with unrelated coordinator/setup/configured tabs. Duplicate stops coalesce. Fence before close; close only exact agent incarnation; confirmed kill→stopped/closed_agent_terminal, ambiguous/no kill→stop_unknown. Already-exited non-structured worker is stop_unknown unless certified exit path already settled it. Wrong/changed/user-owned/external identity is never closed. Task becomes blocked (or remains dispatched for another active attempt), questions close, late report cannot settle. Structured stop uses lease-owning stop path and requires its positive result.

### AC12 — Abandon and retain

Before: possibly-live unknown Worker. Abandon makes abandoned, fences authority, blocks Task, closes questions and retains owned resource; processAction:none and explicit warning; all processes/files unchanged. Same-runtime stop-in-flight refusal prevents race. Retain records user_requested and never downgrades a committed release. Stopped/abandoned release resolves retained/identity_unproven, not closed.

### AC13 — Release archives before exact close

Before: accepted succeeded or failed owned workerS. Release durably requested, re-proves exact incarnation, captures transcript/terminal/structured archive, commits archive plus releasing, then closes onlyS and records released. Frozen output remains readable with archived:true. Same release replays/already_released; concurrent calls coalesce; no duplicate close. No archive success is invented for unavailable/empty content. Setup/worktree/coordinator/active/rejected-report/heartbeat/question resources are never closed. Transient endpoint errors remain pending; changed/missing identity remains unknown/retained. Retry recovery uses a fresh request ID unless replaying the same pending transport receipt.

### AC14 — User takeover wins races

Before: owned worker terminal, including one still booting. Real UI keyboard input marks user_owned and retained/user_takeover, removes stale archive and prevents release. Injected prompts, automatic terminal replies and other plugin writes do not transfer custody. Once releasing/closing is committed, conflicting takeover must not claim safety retroactively. Stopping exemption matches source. UI scenario: type into the worker, settle it, release via CLI, verify tab/process remain and output labels retained. Notification is bounded/debounced without losing first takeover.

### AC15 — Explicit retry and terminal reuse

Before: latest failed/stopped/abandoned DispatchD and failed/blocked T. worker-start taskT retry-ofD with explicit placement creates new attemptD2 and carries circuit/depth lineage. Earlier/wrong-Task/active/circuit-broken/reported-success retry refuses. If D owns a failed-start terminal, archive/release it safely before replacement; uncertainty never closes unproven old resource. Follow-up on settled terminal transfers custody and fresh preamble; late D report and release cannot touch D2.

### AC16 — Output source and pagination

Before: exact provider transcript known, output >one page. auto selects transcript; transcript source requires proof and reports typed missing/unreadable/parse/empty reasons; no guessing file paths from titles. Default40/max50 messages, response max512KiB; terminal archive max262144chars. Opaque cursor max2048chars pins source/attempt/archive; switching source yields source_changed, invalid cursor yields cursor_invalid. Bound terminal reads, clipping and completeness are explicit. After release same read returns immutable archive, not replacement-session output. API/CLI expose source, archive, exactness, both liveness verdicts, fallback, clipping, continuation and warnings.

### AC17 — Fleet evidence, attention and actions

Before: active, failed, succeeded, stopped, abandoned, released, missing/stale/future/restored sessions and mail/questions/gates. list/show expose documented worker/dispatch/resource/projection fields. Fresh evidence live; released/stopped/certified exit exited; status absent/stale>30min/future>5s/restored unconfirmed unverifiable. Outcome remains independent of liveness. Guidance/input/approval/failure/interruption/stale/unverifiable/root_completion attention derives actual state. Reclaimable→release; proven unsettled exit→recover(worker-read); released/unsupervised-settled→none; unverifiable→none, never stop. Live idle/human wait is healthy, with agentWait source/reason rather than failure.

### AC18 — Fleet snapshot and Run scope

Before: >100 attempts across two Runs; caller bound to R1. list without run uses R1 and scope.source bound; explicit R2 uses flag; unbound operator can inspect all with source all. Paginate opaque pinned snapshot newest-first max100; concurrent inserts/settlement do not skip/duplicate captured IDs. Invalid/expired cursors and >5000 legacy snapshot report typed error. terminal-state filters use active/reclaimable/retained/release_pending/release_unknown/released correctly. includeRemote without remote capability returns honest partialHostErrors, not false remote liveness.

### AC19 — Restart reconciliation and safe receipt replay

Before: daemon stops after acceptance, during stop, after release request, or after archive before close. Reopen changes stranded starting/stopping to start_unknown/stop_unknown, pending mutation to operation_unknown; requested releases alone recover after inventory with exact evidence. Settled Dispatch with lingering active Worker becomes abandoned/assignment_settled. Proven absent incarnation may settle release; inventory failure cannot. Repeating request never creates second terminal, submits preamble twice or closes a replacement. All waiters/subscriptions/timers terminate on deactivation.

### AC20 — CLI/API coverage and recorded Orca defects

Every worker method is schema-declared under quirky.orchestration with CLI help and JSON/text output. No Experimental enablement gate; source's stale docs claim must not leak into help. Worker title uses Task displayName/title rather than opaque worker-task ID when a meaningful title exists (source verified mismatch). No retired scheduler, automatic stale-heartbeat failure, bare-shell completion exit, legacy envelope or local human question prompt is introduced. Source unverified UI badges/mobile/remote host internals are not fabricated as acceptance. Concurrent long operations remain bounded and receipt-recoverable.

## Industry Insights

External research swarms intentionally omitted by authoritative night mode. Grounding: orchestration.md lifecycle safety rule, source-recorded receipts/fencing, roadmap public-plugin scripting and prior core/structured/terminal decisions. This is not an external-research claim.

## Deferred Ideas

No in-scope local worker flow is voluntarily deferred in this initial design. Federation/settings/task-link UI belong to separate queue items. Linux/Windows validation is deferred: platform, as D10 records. Any later unreachable flow needs the LOOP-required decision and dependent queue item before landing; it cannot silently disappear from these ACs.

## Glossary

- Run: durable namespace and coordinator mailbox, not an automatic scheduler.
- Task: durable work, with immutable dependency IDs and retry lineage through Dispatches.
- Dispatch: one attempt with exact current authority and a fenced consumer generation.
- Worker: supervised terminal/background structured execution of a Dispatch.
- Resource custody: owned/transferred/user_owned/external/released identity plus release disposition.
- Receipt: durable accepted/completed/unknown mutation record, independent of socket success.
- Liveness: evidence of live/exited or explicit inability to prove either; independent of outcome.
- Archive: bounded frozen output committed before releasing a resource.

## Technical specification

### Architecture and code references

Existing prerequisite contracts: `plugins/quirky.orchestration/src/contracts.ts` (Run/Task/Dispatch/Worker/report/receipt types) and `src/runtime-contracts.ts` (SessionIdentity, SessionAuthority, public session identity/pointer). Core implementation is concurrently owned by lane1; worker modules consume its single store and coordinator/receipt/dispatch settlement seams rather than create another database.

Public runtime anchors: `packages/protocol/src/plugins.ts` PluginContext.call/openStore/subscribe/pty/launch; `plugins/quirky.session/quirky-plugin.json` create/list/show/close and prerequisite identity/pointer seams; `plugins/quirky.terminal/src/terminal.ts` bounded read/snapshot/history; `plugins/quirky.agent-status/src/send.ts` Sender safe-send/turn evidence and public method schemas; `plugins/quirky.worktree/quirky-plugin.json` create/show/setup/parent/noParent; `plugins/quirky.structured/{main,runner,journal}.ts` create/send/stop/messages and structured settled events from M5.

New files: `src/worker-contracts.ts` type-only shared request/result/host contracts; `src/workers/start.ts`, `runtime.ts`, `preamble.ts`, `lifecycle.ts`, `store.ts`, `output.ts`, `fleet.ts`, `register.ts`; worker-owned tests under `test/workers/`. Final plugin manifest/main/CLI composition remains serialized integration ownership in lane9 after merging core implementation. No cross-plugin private imports.

### Contracts and data

Worker public API names: workerStart, workerShow, workerRead, workerList, workerStop, workerAbandon, workerRelease, workerRetain, workerTerminalUserInput. Low-level dispatch/show and send worker_done/heartbeat remain core methods extended by same-transaction worker state hooks.

WorkerStart request uses requestId/contractVersion plus taskId|spec; runId/from aliases; worktree; agent|terminal; taskTitle/dependencyTaskIds/parentTaskId; model/effort; placement name/repo/baseBranch/displayName/comment/setup; retryOfDispatchId; timeoutMs. Request fields cannot supply authority. Mode, effect, setup and receipt discriminants must carry documented certainty. Public worker types extend existing contracts; do not rename core exported types or add credential fields to results.

Persist WorkerRow plus private runtimeEpoch/startOptions/identity; terminal resource with origin/current/prior owner Dispatch IDs, session/worktree/incarnation, ownershipState, releaseState, retainedReason, release/error/recovery/archive metadata; per-Dispatch immutable output archives; bounded fleet snapshots/cursors. Use the core PluginStore migration/transaction convention and receipt ledger. Atomic CAS must settle worker/custody with Task/Dispatch/mail/question changes, including reports racing readiness. All async runtime effects occur outside transactions with persisted stages before/after.

Private worker identity records distinguish supervisor `runtimeEpoch` from attached kernel `processRuntimeEpoch`; the latter is null before attachment and must match actual SessionIdentity/caller proof. Durable replay is checked before asynchronous `beforeAccept` preflight, synchronous acceptance/checkpoint commits before effects, and `afterCommit` owns launch/close. Initial preamble submission requires explicit driving intent rather than inheriting the mailbox-only Cursor no-Enter policy.

### Integration boundary

Before dispatching workers, commit exact worker types and same-store bridge signatures. Reconcile bridge with lane1's published store/service implementation; do not implement a mock core or a no-op lifecycle hook. Worker runtime receives public context and exact incarnation evidence. It does not trust from strings, titles, client metadata or speculative process PID reuse.

Worker coordinator inputs use `CoordinatorEvidence = RuntimeCallerEvidence | ServiceCoordinatorEvidence`. The service variant is `{kind:'service',pluginId,runId,authority:'kernel_plugin'}`, constructed only after kernel plugin caller and owner-Run validation. It is not accepted as request data. Worker report/heartbeat hooks remain RuntimeCallerEvidence. Headless service starts require explicit existing workspace or new-top-level; no fabricated session/current/new-child context. Controls accept explicit runId and stop expectedIdentity session/incarnation, verified before fencing/close. Lane11 owns additive service APIs/core provenance extension, ordinary worker API callers still authenticate real sessions.

Input-origin tracking must distinguish human UI input from injected prompts/query replies through a public origin-bearing event/API. Existing PluginPty.onInput hears every plugin write and cannot alone authorize takeover. Extend public runtime seam where needed, with its actual consumers and behavioral tests; do not infer source from byte content.

### DO-NOT-CHANGE fences

- `docs/loop/LOOP.md`, `scripts/build-loop/`, shared queue.json and DECISIONS.md: queue-owned protocol, never edited by this feature.
- Other lanes' in-flight source/spec/decision files: no silent rewrites. Merge their commits, reconcile explicit conflicts, preserve published contracts.
- Core mutation authority/receipt/DAG semantics in core decisionsD4,D6,D7,D11: workers extend atomic transitions, not bypass them.
- Provider launch catalogs/structured options: reuse public contracts, no duplicated argv tables or credentials in worker rows.
- Real user homes/configs: no tests or diagnostics start default-profile daemons or install hooks/skills.

### Always / Ask / Never

Always persist acceptance before effects, bound waits/pages, archive before close and prove exact identity immediately before destructive runtime action. Always honor user takeover and changed custody under races. Always return unknown/pending honestly. No human asks in this run: resolve from source, record decision or block core only when truly unreachable. Never fake report settlement, readiness, safe close, transcript identity, remote support or test results.

### Cross-cutting and verification

Plugin activation remains lazy; per-session work only for tracked attempts, no perpetual broad scans. Reconciliation acts only on requested releases and known active resources. Migration stays atomic and restart-idempotent. Rollback means disable the plugin without closing tracked sessions; existing records remain inspectable when re-enabled.

Actual daemon/CLI acceptance uses private homes and real launched provider processes:
- `test/workers/acceptance.test.ts`: terminal/native start, report, archive/release, stop/retry/abandon, takeover, context dispatch, snapshot pagination and certified exit.
- `test/workers/acceptance-placement.test.ts`: admission boundaries, Git child/top-level/setup policy, no focus theft, meaningful task title, terminal reuse/transfer and external custody.
- `test/workers/acceptance-recovery.test.ts`: unobserved accepted input, exact replay/mismatch, authorized recovery, rejected-report fencing, heartbeat and source-pinned output.
- `test/workers/acceptance-restart.test.ts`: actual daemon crash after acceptance, epoch reconciliation, blocked Task and no duplicate process/input on pending replay.

Component tests in `start.test.ts`, `lifecycle.test.ts` and `output-fleet.test.ts` cover additional boundaries and races. They are not substitutes for the daemon/CLI scenarios. Kernel runtime-authority and terminal pane-input tests cover the shared public seams.

Verification runs the changed packages/plugins and consumers through the repository suite runner, scripts and typecheck. Real private runtime smoke exercised exact stop, replay without resubmission, programmatic-input custody, and a visible-screen sentinel readable after release. Real Chromium interaction exercised coordinator selection, pinned task title, physical takeover and retained release; D17/D29 state the review and profile limits. No native-only window/menu/tray scenario is added.

Self-review: AC1-20 enumerate the local feature flows, failure boundaries and recorded Orca defects. One shared store and public runtime seams keep mutation authority, resource custody and UI input origin distinct. Verification evidence and its limits are recorded in the worker decision log; the authoritative queue owns the final merge verdict.
