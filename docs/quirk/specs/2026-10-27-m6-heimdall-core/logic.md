# Heimdall kernel core

## Status & amendments
Status: Approved autonomously under docs/loop/LOOP.md night mode; technical decisions included below.
Amendments: 2026-10-27 — D8 adds confirmed service-coordinator APIs; dispatchWorker stays internal. 2026-10-28 — D20 applies the authoritative aged-item exit rule; D21 tracks automatic native host-power binding in queued dependent item m6-heimdall-host-power rather than claiming an event producer exists.

## Purpose and conceptual model
Heimdall supervises durable per-workspace watchers. A registered kind authorizes an enrollment, reads a snapshot, deterministically chooses actions and executes them. The kernel owns enrollment uniqueness, scheduling, gates, write-ahead attempts, journal retention, active-work budgets, worker mailbox reconciliation and safe shutdown. A crash or lost reply never proves that an external action failed and never authorizes its blind repetition. Developers of objective and hosted-review kinds consume this core through the public plugin API.

## Scope and non-goals
Implement the queue item's Kernel pieces through Parking/terminal/stop predicates, Workers/mailbox and Shutdown. No leases, remote execution/fleet, judgment, owner agents, control commands (pause/resume/disarm/delete/approve/answer/budget edits), CLI group or UI. Objective and hosted-review logic are separate items. Source UI defects about operator-edits/rejected-plan explanations belong to those later kinds/UI, not kernel special cases. The journal retains gate reason/detail so those surfaces can expose actual causes. Explicit suspend/resume hooks are included; automatic native host-power production is deferred in D21 and m6-heimdall-host-power. No native UI scenarios are added here.

## Alternatives and key decisions
1. Recommended: one built-in plugin, public method-reference kind adapters, private SQLite and focused local modules. Preserves declared contribution/override semantics and deterministic internal callbacks.
2. Rejected: direct imports of another plugin's executable registry/service. Bypasses disable/override and binds private lifecycle.
3. Rejected: integrate supervisor state into daemon or orchestration tables. Splits ownership and turns a replaceable feature into kernel infrastructure.

## Data flow
A kind plugin registers its descriptor and hook methods. Enrollment calls its authorization hook, validates its payload and canonical workspace identity, persists one live watcher and schedules an immediate tick. A serialized tick recovers pending attempts and intervals, reads the world/mailbox, resolves uncertainty only from live evidence, evaluates stop rules/budget and executes up to32 gated actions. An attempted record commits before any effect. Workers use stable orchestration request IDs and exact recorded coordinator authority. Journal, trace and status inspection expose why nothing ran. Shutdown fences new work, drains within1500ms and leaves unresolved effects recoverable rather than pretending cancellation succeeded.

## Decisions locked
- API response/error areas: discriminated enrollment enrolled/re-armed/refused and action landed/not-landed/indeterminate; refusal details preserved. Read inspection includes malformed and forward-schema status.
- Authentication/authority: only a plugin may register hooks in its own namespace; authorization re-derives workspace/host/scheduler fields. Local scheduler authority only. Client enrollment cannot smuggle persisted authority.
- Idempotency: fingerprints JSON.stringify([contentIdentity,kind,evidenceKey]); successful and pending fingerprints never execute twice; not-landed needs new evidence. External uncertainty blocks other external work.
- Recovery/conflict: cached external decisions require a live redecision with identical fingerprint. No timeout/missing worker is proof of failure. Per-watcher ticks serialize; new pulses coalesce.
- Budget: union of overlapping active intervals, not idle elapsed time or double-counted worker/action overlap; turns are distinct successful dispatches. Zero is immediately spent, null unlimited, wall-clock precedes turns. Budget generation resets prior counters and excludes late turns from old attempts.
- Re-arm: one nonterminal enrollment per host::canonical-path. Enabled duplicate refused; disabled same-kind enrollment rearmed with spent+allowance except explicit-disarm generation reset. Terminal history remains terminal and a new enrollment may be created.
- Timing: rapid15s, active60s, idle300s, stopped no timer; failure/hold exponential30s..900s; forced live resync every900s. Successful ticks reset errors; hold count rises across consecutive holds, resets after non-hold success.
- Storage: use public per-plugin store at dataDir/store.db with WAL/FULL/foreign keys/5000ms busy timeout; private directory0700. Forward-schema downgrade refused without mutation/scheduling, with read-only diagnostic inspection if schema is readable. This preserves m0-daemon-api D9/D10 rather than silently migrating a future schema.
- Platform: portable TypeScript/Bun APIs, macOS verification only; power integration is explicit suspend/wake host hooks, not an Electron import.

## Behavior and acceptance scenarios
All public flows are exercised through daemon RPC using an isolated fixture kind plugin, with real storage and actual public orchestration when the dependency is available. Unit regressions supplement boundary cases; they do not replace the public-path proof.

### AC1 Registry and enrollment
Before: empty kernel. Register a descriptor, enroll authorized local workspace. After: UUID watcher, random coordinator identity, revision0, enabled/unpaused, null run, immediate first tick. Unknown kind, bad payload and failed authorization refuse with details. Concurrent duplicate enrollments leave exactly one live watcher. If authorization creates resources but persistence/validation fails, invoke its undo hook. Unauthorized registration and non-owned hook names refuse.

### AC2 Refusals and re-arm
Before: enabled W at local::/canonical/path. Second enrollment refuses duplicate-workspace; foreign host/scheduler refuses owner-not-executable; disabled different kind/payload refuses invalid-payload. Before: W parked after spending10 with allowance20. After re-arm: same watcher, limit30, park acknowledged. Explicit-disarm halt instead starts a fresh generation with allowance20. Terminal W stays terminal; new enrollment gets a new ID.

### AC3 Persistence/malformed/forward schema
Before: persisted watcher and attempted effect; restart. After: same IDs/journal restored, pending effect recovered before new execution. Malformed kind payload remains inspectable and never runs; unavailable kind remains dormant until registered. Newer schema refuses writes/schedules/purge and preserves original bytes/data. Facts are append-only; attempts settle through revisions, one resolution per attempt, one terminal per watcher.

### AC4 Journal and trace retention
Before: >50 resolved observations/traces plus facts and unresolved attempts. After trim: all facts/unresolved observations and pinned traces remain, only newest50 eligible rows of each ring survive. Traces include monotonic seq, timing, exit, snapshot reads/identity/decision/declined/gate/budget/pacing/error/runner. Terminal compaction retains terminal plus pending attempts/unresolved pinned observations and writes final totals summary; no new ticks.

### AC5 Serialized schedule and pacing
Before: read blocked mid-tick; multiple wake/pulse requests. After release: no overlapping tick/effect and one immediate reconciliation follows. Tier/backoff/resync cap use declared values, stopped/suspended runners have no timer. Explicit suspend fences commit and resume forces reconciliation. Tick errors remain visible and retry with bounded backoff rather than disabling silently. Automatic OS sleep/wake delivery is not claimed: queued follow-up m6-heimdall-host-power must implement the missing trusted native publisher and pre-sleep fence/ack boundary.

### AC6 One tick and generic gate
Before: live snapshot and proposed action. Gate precedence: disabled/paused, parked, budget wall-clock/turns, stop, completed/in-flight fingerprint, failed evidence, unresolved external attempt, stale content, missing external expectedState, capability absent/off, exact approval absent, then kind preflight. After hold/escalate: specific gate/detail in trace, deduplicated attempt-abandoned and folded approval scope escalation; no execute. Matching exact approval allows; changed evidence/content does not reuse it. No-action reason/detail/considered are retained. Max32 actions prevents a hot infinite loop.

### AC7 Freshness and write-ahead safety
Before: cached external proposal A. Live read differs: record workspace-moved abandonment and immediate retick; never execute A. If identical and gates still pass, persist attempted before invoking executor. Successful settled result completes fingerprint; confirmed failure requires new evidence. Throw or lost reply is indeterminate and blocks later external effects. Restart with attempted/running state invokes live resolver; cached evidence cannot resolve it. Local replay-safe recovery is allowed only with explicit replay-safe action marker and positive kind contract, never inferred.

### AC8 Active budgets
Before: overlapping action and worker intervals [0,100] and [50,150]. Active usage150, not200; idle ticks add0. Sample15s, durable checkpoint at most60s; contact-loss/restart recovery closes at last checkpoint, not unknown elapsed gap. Distinct dispatch turns count once across retries. Limit0 parks first tick with park-budget. Exhaustion never dispatches another worker unless kind explicitly allows draining existing work. Generation boundary excludes older late reports.

### AC9 Stop/park lifecycle
Before: stop predicate terminal while external attempt pending. After: terminal deferred until outcome resolves. Park persists enabled=false plus stable park escalation/reason. Worker question/escalation parks; positively answered/resolved mailbox state acknowledges park and resumes; budget park does not auto-resume. Terminal writes summary/compacts/stops without killing worker terminals. Confirmed workspace removal may terminate only from authoritative kind evidence, never a failed read. Coordinator-seat loss parks distinctly.

### AC10 Orchestration and mailbox
Before: action requests worker dispatch. Lazily create/bind run under minted coordinator. Persist deterministic sha256('heimdall-dispatch-v1\\0'+fingerprint) request and replay data before call. Ready returns dispatched with exact dispatch identity, refused returns explicit reason, unknown remains indeterminate. Restart repeats same idempotency key or reads its receipt, never a fresh request. Successful dispatch writes one turn and worker interval. question/escalation/worker_done immediately wake runner, are idempotently drained/acknowledged, settle/park as appropriate. Settled workers release only through orchestration's archive-before-close API, never raw session close. Unverifiable/missing worker is not settled or released speculatively.

### AC11 Shutdown
Before: tick blocked in hook. Shutdown stops timers and fences commit, waits at most1500ms, checkpoints/closes known intervals and returns without killing workers. Late hook completion cannot write to closed storage or dispatch. Restart can inspect/recover the pending attempt. All subscriptions/timers are removed; no unhandled late rejection.

## Industry Insights
No research swarms per night mode. Grounding is the supplied heimdall.md kernel/edge-case sections, roadmap ordering/parity, architecture plugin boundary, and binding m0-daemon-api D9-D13 plus orchestration core/worker decisions. No unobserved external research claim.

## Deferred ideas
Excluded queue slices remain leases/remote fleets/judgment, operator controls/CLI/UI, owner and concrete kinds. Linux/Windows verification is deferred: platform. Automatic native macOS host sleep/wake binding is deferred in D21 because no trusted daemon producer or pre-sleep acknowledgement hook exists; m6-heimdall-host-power is queued and depends on this item. Explicit runner lifecycle hooks remain implemented and tested. No other local-core flow is deferred.

## Glossary
Enrollment: durable watcher identity and authority. Kind: authorizer and pure world/action policy. Journal: append-only kernel facts/observations, not the project ledger. Attempt: durable write-ahead effect identity. Trace: per-tick diagnostic record. Park: persisted disabled supervision awaiting a specific condition. Active time: union of known work intervals. Coordinator: exact orchestration identity owned by watcher.

## Technical specification

### Architecture and contracts
Plugin root plugins/quirky.heimdall, startup activation, dependency quirky.orchestration. Type-only src/contracts.ts precedes implementers. Internal WatcherKind callbacks use a registry; public registerKind receives schema plus hook method references and builds callbacks through PluginContext.call. No executable callback crosses RPC. Hook execute may return worker request; the kernel dispatches it under the same persisted attempt, never a public dispatch escape hatch. Public methods registerKind, enroll, inspect and reconcile (one serialized pulse). No operator command group. Registration descriptors persist so restart can lazily activate their kind plugin through its declared methods; invalid/disabled methods fail closed.

Internal boundaries: KernelStore handles enrollments/journal/traces/summary/malformed/read-only; EnrollmentService uses registry+store; Runner owns timer/tick/gate/actions+clock; OrchestrationAdapter uses context.call only; KernelService composes lifecycle and method adapters. Store and runner contract methods in src/contracts.ts are the single shared interface. Journal rows typed by kind with revision entries, monotonic per-watcher sequence, unique event IDs. SQLite indexed live workspace uniqueness excludes terminal rows, and enrollment mutation is serialized/transactional after async authorization.

Orchestration service extension, confirmed/reserved by lanes1+9: serviceRunCreate(requestId,contractVersion,key,objective), serviceRunShow(runId), serviceWorkerStart(explicit runId plus worker start without caller aliases), serviceCheck(explicit runId plus durable consume/ack/wait), serviceWorkerRelease(explicit owned runId/dispatchId). Kernel PluginCaller.pluginId is the only owner authority; `(pluginId,key)` uniquely identifies a service Run. Session coordinator fields remain null; distinct service principal/provenance and receipt fingerprint are persisted in the same orchestration store. Session/worker attestation rules remain unchanged. Service placement refuses implicit current/new-child, permitting explicit existing workspace or new-top-level. Post-commit `quirky.orchestration/message-arrived` with `{runId,messageId,type}` wakes only that run's watcher. Parent owns services/**, additive migration/principal union and hub integration after prerequisite merges; no fake session evidence or unknown-to-success conversion.

### Ownership / execution slices
The initial three disjoint slices owned persistence/enrollment, runner/gates/budgets and adapter/plugin composition. After a rejected persistence mutation, parent implemented the store and a fresh isolated task implemented registry/enrollment, preserving behavioral tests. Parent owns shared contracts/docs; separate scoped service integration extends actual orchestration after dependency merges. Each source wave is audited before integration; current dependency conflict resolvers have disjoint session/structured scopes. Controls and owner modules/hubs remain their respective lanes' ownership. No private cross-plugin imports, protected-loop edits or real profile writes.

### Verification
Workers author deterministic behavioral regressions and skip builds/tests/formatters mid-flight; parent checks settled source, actual daemon API/worker smoke and affected packages through bun scripts/suite.ts, then bun test scripts and bun run typecheck. Merge current dependencies before final checks; wait deps ready, catch up build/roadmap once and read incoming decisions. The item is already aged under authoritative night mode (D20), so do not start an unstarted final-review campaign; still fix every observed blocking defect and run the queue merge-result gate. No UI dogfood scenario is added. Every process uses fresh temporary QUIRKY_HOME/HOME and owned cleanup. Native power binding remains explicitly queued, not simulated as completed.

Self-review: AC1-11 cover every included source section and uncertainty boundary. Full-source UI/lease/owner flows are explicit non-goals. No placeholders or unresolved human choices. Newer-schema read-only diagnostics must not weaken the binding downgrade refusal. Timing and authority are concrete; runtime proof remains required before claiming success.
