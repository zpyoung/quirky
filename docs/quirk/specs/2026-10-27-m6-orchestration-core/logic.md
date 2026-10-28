# Orchestration core, mailbox, questions and gates

Reader: lane-1 implementer — Decision: implement against the merged prerequisite branch, then verify readiness before landing.

## Status & amendments
Status: autonomously approved design under current LOOP.md; shared contracts committed, implementation proceeds against the available dependency branch. Night mode combines technical decisions here; no separate tech.md.

**Amendments:** 2026-10-27 — initial combined specification, self-reviewed against the selected feature-doc sections. Iteration16 — current early-item protocol permits implementation against prerequisite branches before they land; independent public runtime seams are specified in `src/runtime-contracts.ts`.

Operator sprint amendment: this landing excludes **automatic idle-mailbox scheduling only**.
Its intact AC9 acceptance and implementation are preserved at `checkpoint/m6-core-idle-pointer`
(commit69083459), assigned to `m6-orchestration-idle-pointer-shutdown`. The scheduler times out
during daemon teardown. AC9 below remains the unweakened follow-up contract; explicit safe
`session/pointer`, idempotent driving prompts and all durable mail/wait/question/gate flows remain
in scope. Review/dogfood not already started is skipped under the operator's landing instruction.

## Purpose
Give coordinators and workers a durable, scriptable namespace for supervised work without introducing an automatic scheduler. A coordinator owns a Run, creates dependent Tasks, and handles durable messages, questions and gates. A Dispatch is one authoritative attempt, never merely a copied Task ID.

## Scope and non-goals
The queue item combines Part 1 (database, DAG, run/task CLI, authority, idempotency, reset, constants) and Part 2 (mail, questions, gates, coordinator-loop steps 4 and 6). Neither part excludes what the other includes.

In scope: run-create/use/current/list/show; task-create/list/update; low-level dispatch attachment and inspection needed to exercise worker authority; dispatch/worker transition contracts, circuit breaker and nesting admission; send/check/reply/inbox/ask; gate-create/resolve/list; request-show/reset; explicit safe session prompt/pointer submission. Automatic idle-mailbox scheduling is deferred by the operator amendment above. Expose the shipped behavior through public plugin methods and the generated `quirky orchestration` CLI.

Not in this item: worker-start and placement, worker show/read/list/stop/abandon/retain/release UI/fleet workflows, process custody/archive management, federation, legacy adoption/compatibility, old automatic scheduler, skill-install/settings UI, feature-wall/onboarding, task terminal links, sidebar nesting. The default depth cap is enforced here; the later settings slice owns its UI. An escalation message does not automatically fail a Task or create a gate. No retired coordinator commands or legacy tombstones are introduced.

## Conceptual model and data flow
A Run stores its objective, current coordinator session, consumer generation and historical coordinator addresses. Binding the same coordinator to a different Run unbinds the old Run, bumps its generation, fences its outstanding Delivery and wakes cancelled waiters. A Task belongs to one Run and may reference only existing Tasks in that Run as dependencies/parent; dependencies cannot be edited. A Dispatch records attempt identity, depth, assignee and consumer generation. A supervised worker state is a separate graph; context-only Dispatches need no worker row.

The plugin commits Task/lifecycle changes, messages, question closure, dependent promotion and mutation receipts together. After commit it wakes matching waiters and, if no consuming waiter owns the mail, schedules a best-effort pointer. A pointer contains only a command to check the mailbox; it neither marks messages read nor proves the agent read them. Delivery acknowledgement is explicit. A question remains pending across timeouts and is resumed by its original ID.

## Decisions Locked
- API/CLI: use the existing schema-generated command group and JSON-RPC envelope, not an Orca-only response wrapper. Named orchestration error reasons remain machine-readable; no Experimental enablement toggle.
- Identity: Quirky session IDs are the stable party/pane identity (m1-agent-status D2); provider conversation IDs are not credentials. Declared `from`/`terminal` never overrides caller identity. Do not copy Orca pane-remint compatibility.
- Authority: current coordinator binding and exact active Dispatch ownership govern writes, consumption, answers and reports; explicit Run arguments permit read-only inspection, never mutation authority.
- Mail: FIFO batches of at most 50, one outstanding Delivery per mailbox/generation, exact replay until acknowledged. Peek/history never consume. Type filters select wake conditions, not the contents of consuming batches.
- Recovery: timeout, disconnect, stale evidence and unknown pending receipts never imply worker death or authorize destructive process action. Reuse request/question IDs instead of minting replacement work.
- Gates: coordinator-owned; creating blocks its Task and refuses live supervised attempts. Resolving records the decision and makes the Task ready as documented; actual dispatch admission still checks all dependencies. Gate resolution is not silently injected into prompts.
- Platform: macOS acceptance only; portable storage/async APIs where practical. No claim of Linux/Windows process-identity/pointer parity.
- Scope: no scheduler, federation, legacy migration or worker-start implementation in this item. All Part 2 flows remain in scope.

## Behavior and acceptance scenarios
Each AC requires a test driving the real daemon API or generated CLI on a fresh temporary home. Tests may use scripted structured providers rather than model calls. Any subprocess also gets isolated HOME/provider homes and is cleaned up by the harness.

### AC1 — Run binding, inspection and takeover
Before: coordinator C has no Run. Walkthrough: create R1, read current/show/list, create R2 with C, then another live coordinator D uses R1. After: C owns only R2, D owns R1; unbound/rebound generations increase, historical addresses remain routable, old outstanding deliveries are fenced and old waiters stop. Another Run can be inspected without changing binding. Unknown Run returns run_not_found. List newest-first with opaque stable cursor and limit 1..100.

### AC2 — Dependency creation and promotion
Before: Run R has no Tasks. Walkthrough: create A with no dependencies and B depending on A; complete A, then inspect ready Tasks. After: A completed and B ready in the same transaction. Missing/cross-Run dependencies or parent fail without inserting anything; failed A leaves B pending until a valid completion. Dependencies are immutable. Defaults collapse whitespace and truncate title/display to 80/160 characters with `...`; brief spec is 160 characters with a truncation marker only when cut.

### AC3 — Task updates preserve attempt invariants
Before: Task T has an active Dispatch. Walkthrough: try to force T ready, try dispatched without an active attempt on another Task, and try updating T while a supervised worker is alive. After: invalid operations fail task_not_startable without changing state. Valid completed/failed updates settle context attempts, close their questions and promote dependents only on completion. A no-op with no result returns unchanged state.

### AC4 — Attempt transitions, retry circuit and nesting
Before: ready T, coordinator C and assignee W. Walkthrough: create a low-level Dispatch; contend for W with another Task; exercise expected-state transitions and failure/retry lineage. After: one active assignee/Task attempt, Task dispatched, competing or stale CAS fails atomically. Dispatch graph: pending -> dispatched/completed/failed/circuit_broken; dispatched -> completed/failed/circuit_broken; terminal states have no outgoing edges. Worker graph is the feature doc's nine-state graph, including only its documented unobserved-start correction. Failure counts carry across retries; failures 1/2 return context Task ready, failure 3 circuit-breaks and retry refuses. Worker-reported failure does not increment infrastructure failures. Child depth is deepest active caller role + 1; default cap 1, creating another Run or using low-level dispatch cannot reset it. Dry-run does not mutate or send input. Oversize specs (>1,214,464 UTF-8 bytes) fail before effects.

### AC5 — Exact-owner reports and heartbeat
Before: W owns current Dispatch D of Task T. Walkthrough: send worker_done with Task/Dispatch/outcome, then replay same outcome; send an old attempt report, wrong caller report and heartbeat after settlement. After: one valid report atomically settles Task/Dispatch and any worker row, stores result provenance and promotes dependents. Same outcome is duplicate, stale/wrong/stopping reports cannot settle the Task or refresh liveness. Rejected reports remain auditable with explicit rejection reason; no success receipt hides rejection. Heartbeat only updates an active owned Dispatch, prior unread heartbeat rows for that attempt are retired at settlement. Escalation/decision_gate sends are mail only.

### AC6 — Address routing, fan-out and durable enqueue
Before: Run R, live worker W, coordinator C, historic coordinator address H. Walkthrough: send to run:R, dispatch:D, C, H and supported groups, and omit `to` from W. After: all resolve to the documented durable mailbox; default worker destination is its owning Run. task: recipients, settled Dispatches, ambiguous or unreachable parties and mismatched explicit Run fail explicitly. Groups fan out one independent message per unique eligible mailbox with shared thread ID; exclude sender/current owning coordinator, match published provider identity for provider groups, live idle status for @idle, and workspace membership for @worktree. Group lifecycle messages are refused. Unbound direct mail uses run_unbound, not legacy storage. Durable enqueue succeeds independently of nudge success.

### AC7 — Delivery replay, acknowledgement and filtering
Before: 51 unread messages to R, of mixed types. Walkthrough: check with a type filter, check again, acknowledge, inspect remaining, retry acknowledgement; also peek/history/inbox. After: first Delivery contains oldest 50 of every type and replays exactly; ack consumes only its batch; last message appears in next batch. Repeated ack is harmless. Unknown/foreign IDs fail stale_delivery; old-generation IDs fail consumer_fenced. Peek/history cap at 100 and apply filters without consuming; inbox is host-wide newest history, default 20 or 100 for explicit terminal. All-read outstanding batches no longer prevent delivery creation.

### AC8 — Waiting, cancellation and rebinding
Before: empty R. Walkthrough: wait for question, enqueue status then question; contend with second waiter; disconnect/rebind while waiting; ack then interrupt the following wait. After: status alone does not wake a question-filtered waiter, question wakes it with full FIFO batch; second Run waiter fails waiter_exists. Timeout returns timedOut without consuming anything; rebinding/disconnection returns honest cancellation/fencing. A committed ack is retained in an interrupted result. Default wait 120,000 ms, client grace +10,000 ms, stderr keepalive every 15,000 ms. Invalid types and incompatible read modes fail validation.

### AC9 — Idle pointers are hints, never consumption
Before: unread undelivered Run/Dispatch mail, no consuming waiter, live idle assignee. Walkthrough: deliver a pointer, race more mail/status changes, interrupt/restart between reservation/text/Enter. After: only the pointer command (not message bodies) reaches the exact current session. Respect live idle/quiescent evidence, blocked dialogs, unfiltered waiters, filtered waiter type reservations, outstanding Deliveries and one in-flight pointer per recipient. Terminal text and Enter are separate (500 ms delay); Cursor has no auto-Enter. Revalidate identity/status before submit; uncertain submit after restart never sends duplicate Enter. Structured sessions use idempotent normal send operations. Retry parked mail on eligible activity and startup (2,000 ms delay). Mail remains unread until ack. Terminal quiescence is 3,000 ms (+50 ms recheck), using the existing safe send path rather than raw unsafe typing.

### AC10 — Ask timeout, resume and reply
Before: W owns active D of R. Walkthrough: ask Q with options; let timeout expire, resume its message ID, coordinator replies, resume again; repeat same reply then conflicting reply. After: exactly one pending question/message survives timeout, resumed waits return answer and IDs, identical reply is duplicate and differing answer fails answer_conflict. Answers are already read (not delivered twice by check); only current coordinator can answer. Wrong Dispatch/run/group/caller fails before enqueue. Default/max timeout 600,000/1,800,000 ms, clamp 0..max, client grace +5,000 ms. CLI exits 1 on timeout/cancel and prints exact resume command; no automatic re-ask. Settlement closes pending questions; uncertain live start does not.

### AC11 — Ordinary replies and gates
Before: ordinary message M and Tasks A/B with B depending on A. Walkthrough: reply to M; create gate on B, complete A, resolve gate, list by Run/task/status; try foreign-Run resolution and creation on live supervised Task. After: reply marks M read and sends threaded Re: response. Gate blocks B even after A completes; resolving makes B ready with durable resolution/time; no other Run's gate mutates. Live worker gate creation is refused. Pending gates are reported by inspection; no scheduler invents timeouts.

### AC12 — Durable mutation request recovery
Before: an authenticated caller and UUID K. Walkthrough: mutate, retry K unchanged after reconnect/restart, reuse K with different method/input, inspect completed/pending/absent. After: one effect, same stored receipt with replay marker; mismatched request fails request_mismatch. Concurrent same-request calls join; abandoned pending work yields operation_unknown, never silently repeats side effects. Absent receipt explicitly does not prove no effect. Receipts retained 30 days, max 10,000 with pruning of oldest completed batches of 64; unresolved saturation fails mutation_ledger_full. Read-only peek/all/list/show are not made mutating; check ack/consume and ask carry durable IDs.

### AC13 — Scoped reset and restart durability
Before: Runs/Tasks/mail/questions/deliveries/receipts exist. Walkthrough: reset messages, separately tasks, separately all, with explicit confirmation bypass only in tests; restart and inspect survivors. After: messages removes mail/deliveries/questions/pointer records; tasks removes Tasks/attempts/workers/gates and closes pending questions while preserving messages/Runs; all removes all orchestration state except mutation receipts. Exactly one mode required. No legacy tombstones, unrelated plugin state or real user files touched. Durable state uses schema migrations, WAL and atomic updates; restart fences stale consumers rather than inventing a live worker from absent evidence.

## Defect and refusal coverage
The selected source sections name no numbered Orca defects. Explicit regression obligations are nevertheless AC3 (dispatched without attempt), AC4/5 (copied identity, stale attempts, failure budget/depth bypass), AC7/8 (lost ack, generation fencing, filtered wait versus FIFO), AC9 (duplicate Enter/restart uncertainty), AC10 (timeout duplication), AC12 (unknown mutation replay), and no stale Experimental enablement gate. Text-mode errors must remain actionable; JSON must expose their named reasons. Out-of-scope terminal custody/federation/legacy/native UI observations are not claimed fixed by this item.

## Industry Insights
Night mode explicitly replaces external research swarms with the feature doc, roadmap and prior decision logs. Sources: orchestration.md sections The database through Reset, Constants and limits, Edge cases; docs/architecture.md Structured agent sessions/Decisions; m1-agent-status D2; m5-structured-runner D3-D8/D12/D17/D25. No external research claims.

## Deferred Ideas
Only the explicitly separated feature slices in Scope and non-goals. No additional product behavior proposed. Early dependency readiness gates landing, not implementation against the available prerequisite branch.

## Glossary
Run: durable coordinator namespace. Task: dependency-bound work item. Dispatch: authoritative attempt. Worker: supervised attempt execution state, separate from Dispatch state. Mailbox: durable run/dispatch address or supported direct address. Delivery: replayable acknowledged batch. Consumer generation: monotonic fence for prior readers. Question: resumable answer thread. Gate: coordinator-owned blocked-Task decision. Pointer: best-effort instruction to check, not message delivery proof.

## Technical decisions and implementation contracts
### Architecture and code boundaries
Create `plugins/quirky.orchestration/` as one lazy built-in. Its public contract types live in `src/contracts.ts`; no runtime activation/placeholder methods are installed during early preparation. The implementation adds `quirky-plugin.json`, `package.json`, `main.ts`, and focused `src/` modules for schema/store, identity, lifecycle, messaging/waits, questions/gates and pointer scheduling. Consumers use `PluginContext.call` rather than importing another plugin's private runtime. Protocol public contracts come from `packages/protocol/src/plugins.ts` (PluginContext, PluginCaller, PluginStore), not daemon internals.

Reuse openStore migrations/transaction for the plugin-private SQLite database. Schema version starts at 1, not Orca's migration number 43. Store UTC timestamps as ISO strings and explicitly convert JSON columns at the boundary. Enforce unique outstanding deliveries and active assignee ownership transactionally. Bound queries, batches and retained in-memory waiter/pointer maps. No async operation inside synchronous store transactions.

### Contracts and interfaces
Committed types define exact domain rows, request/result mapping, mutation metadata, caller evidence, CAS transition input and public dependency ports. API namespace is `quirky.orchestration/`; CLI alias `orchestration`, verbs are the documented kebab-case names. All API methods declare schemas in the eventual manifest, including outputs/events. Caller session comes from PluginCaller; compare all declared aliases and require a live runtime-owned session. A provider conversation ID or arbitrary `from` is not authority. Any missing attestation capability requires public API growth, not trusting client fields or importing private stores.

`src/contracts.ts` defines domain shapes; `src/runtime-contracts.ts` defines the public runtime integration signatures. Kernel-verified `PluginCaller.sessionAuthority` derives from launch-scoped `QUIRKY_SESSION_TOKEN` supplied separately as hello `sessionToken`, plus independent live process/lease evidence. Public `quirky.session/identity` returns only non-secret target identity; `quirky.session/pointer` provides exact-incarnation, durable-operation-ID safe submission with honest unknown results. Runtime schemas, implementations and acceptance tests ship together. Mutation methods carry `requestId` UUID and a contract-version discriminator; CLI uses the existing transport request mechanism plus the orchestration receipt contract where long waits need a durable accepted checkpoint. Avoid duplicating conflicting ledger ownership; kernel request behavior must be inspected before integration.

### Data models and security
Run, Task, Dispatch, Worker, Message, Delivery, QuestionThread, Gate and MutationReceipt fields are defined in the committed contracts. IDs use run_/task_/ctx_/msg_/delivery_/gate_ plus 12 hex. Secret capability hashes never appear in public rows; plaintext secrets never persist. Preserve active-role authority across new Run creation. Reset is marked destructive and uses kernel confirmation (`--yes` in unattended tests only). Lifecycle report acceptance, not a timeout/idle pointer, decides completion.

### Implementation slices against committed runtime signatures
1. Orchestration plugin: core store, authenticated identity/run/task/lifecycle, mutation receipts/reset, routing/delivery/waits/question/reply/gates, manifest/custom CLI and idle-pointer scheduler; API-driven acceptance for AC1–AC13.
2. Existing runtime: public kernel-verified caller authority and live session identity; launch-scoped terminal/structured child environments; exact-incarnation, idempotent safe pointers and structured send receipts. Preserve account preparation, launch snapshots and revocation.
At most three implementers. Shared contract changes are owned by the integration parent and committed before implementers. Do not edit shared files concurrently. Tests cover plausible consumer-visible boundaries, not copied schemas/text snapshots.

The CLI adapter preserves source flags while normalizing them to the type contracts: string addresses become mailbox/group discriminants, CSV/JSON arrays become arrays, and `--id`/`--task`/`--run` map to explicit typed identity fields. Its module is declared by the manifest and remains visible in the public schema catalog. Preserve raw-payload versus structured-flag exclusivity; acknowledgement remains a durable mutation even when the following read is peek/history.

### Fences and execution rules
Never change docs/loop/LOOP.md, scripts/build-loop/, queue.json or DECISIONS.md manually; never work on main or the integration worktree. Do not change m1 stable identity, background-structured-only architecture, revocation order or shared provider launch snapshots. Always inspect available public runtime identity/send APIs before implementing pointer/authority glue. Questions are autonomously answered in the decision log; conflicts with locked decisions stop the affected item, not silently weaken guarantees.

### Verification strategy
Run implementers' own tests only during their task. At final gate run `bun scripts/suite.ts plugins/quirky.orchestration <changed consumer/package dirs>`, `bun test scripts`, `bun run typecheck` once under night mode; land owns the full suite. Real-daemon/CLI smoke uses fresh HOME, QUIRKY_HOME and provider homes; exercise run/task DAG, delivery replay/ack, ask timeout/resume/reply and gates plus restart/receipt recovery. Final cross-family review uses omp OpenAI implementers and a reachable opus reviewer (probe; choose next cross-family backend if unavailable). Catch up once immediately before final review/landing and read incoming decisions. Dogfood only added pointer UI scenarios through web surface once at the end; no native-only window scenario is introduced. Remove owned throwaway resources after the item lands.
