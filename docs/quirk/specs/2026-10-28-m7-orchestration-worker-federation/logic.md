# Paired-daemon worker federation

## Status & amendments
Status: Implemented under LOOP build-first; combined logic/technical specification approved autonomously. Acceptance sources are authored; caught-up root/mobile typecheck and focused real paired-daemon/CLI, store-upgrade and shipped-view proofs passed within decisions D10–D13. Suites, full UI campaigns, reviews and native/network-platform campaigns were not run.

**Amendments:** 2026-10-28 — preserve established migration order, exact accepted→attached authority, service entry-point routing, stable relay UUIDs, serialized imports and home settlement before host verdict. No human asks or external research swarm.

End-phase repair `fix-test-orchestration-1028`: bootstrap and method-ceiling denials preserve their stable peer error reasons and return HTTP 403 without exposing private error text. Paired-host acceptance uses independent real daemon processes rather than aliased module globals and shared process environment. Existing-workspace acceptance uses an actual registered host workspace; floating terminal attribution is not a remotely addressable workspace. Archived output retains exact provenance and captured bytes, but its content-derived source identity need not equal the live source identity. Verification receipts live in the repair decision log.

## Purpose, scope and conceptual model
A coordinator keeps its authoritative Run, Tasks, Dispatches and questions on the home daemon. `worker-start --on <peer-id>` executes a real worker on the explicitly paired host. That host owns its local service Run, Task, Dispatch, process and terminal custody. A durable binding maps the two identities; a remote identity is never represented as a locally authenticated session. Both session coordinators and authenticated service coordinators use the same pipeline.

In scope: exact remote existing-worktree/new-top-level placement; durable attachment receipts; mail in both directions; resumable blocking questions; status/heartbeat/report settlement at home before host acceptance; paired identity and incarnation fences; remote show/read/archive/fleet/control; task navigation to an actual remote output viewer. Non-goals: Objective/PR sitter/non-GitHub policy, native-chat parity, idle-pointer/shutdown changes, host-power ownership, peer discovery, ambient credentials and implicit local fallback.

## Data flow
Home verifies the coordinator and current peer capabilities before durable Task/Dispatch acceptance. Host authenticates its paired principal, records attachment before launching through the existing owner-scoped worker starter, and maps real process identity before submission. Home mirrors the worker receipt without acquiring local PTY authority. Mail uses durable per-binding sequence numbers, contiguous ordered pages and replay-safe imports. A worker report remains pending on host until the home has checked exact binding, current attempt and kind-owned submission preflight, then atomically settled its Task/Dispatch/Worker. Only that explicit verdict permits host report settlement. Lost contact remains unknown. Normal coordinator mail and replies queue durably and survive restart. Explicit retain/stop/release operate only through the host's existing custody checks; release freezes output before exact close.

## Key decisions & rationale
Recommended: extend the existing orchestration plugin, one store and paired transport with typed internal federation ports. Rejected: unrestricted generic RPC proxy (unbounded authority); copied local caller evidence (false process authority); second worker runtime (divergent readiness/custody); home-only metadata without host execution (not federation).

## Decisions Locked
- Authentication: dedicated paired transport, reciprocal pinned peer identity, pairing revision and host incarnation; worker process incarnation is separate. Bootstrap token authorizes status only. Every worker peer method has an explicit ceiling and advertised capability only when connected.
- CLI/API: `on` is the exact saved peer ID; no selector inference. Remote requires exact existing worktree or new-top-level; new-top-level requires repo/name. current/new-child and creation flags on existing workspace refuse before effects. Native Quirky namespaced APIs and existing JSON mutation receipts remain authoritative.
- Errors/recovery: known pre-effect refusal is failure; accepted/lost response is outcome_unknown with inspect/retry commands and no second launch. Durable same request/input replays; changed payload refuses. No network absence proves exit.
- Sync/conflicts: bidirectional ordered durable relay, idempotent contiguous import, per-item accepted/rejected lifecycle verdicts; ack only after home commit. Bound pages50, six pages/tick, active/unfinished relay only. Preserve pending work across restart.
- Questions: original question survives timeout; resume original ID; only current home coordinator replies; same answer duplicate, changed answer conflict; close on settlement, not uncertain start. Core D9 gate semantics unchanged.
- Resource control: no auto-close on report, idle, missing heartbeat or peer loss. Host proves exact custody and process identity; positive close verdict only. Archives readable after release. User takeover/retention wins.
- Fleet/navigation: provenance is explicit, pagination snapshot remains pinned and bounded; includeRemote queries host without treating failures as missing workers. Remote task link opens an actual output viewer rather than a same-ID local terminal.

## Behavior and acceptance scenarios
Each scenario has daemon/CLI acceptance source using fresh isolated homes and deterministic real provider processes; tests are authored but not run during build-first.

1. **Placement/receipt.** Before: home bound Run and paired host with workspaceW. Start `--on host --worktree W`; after: home owns TaskT/DispatchD, host service owns its Run/Dispatch/process, receipt names binding and real host custody. Existing W is not recreated and focus is unchanged. New-top-level creates host worktree only. current/new-child/missing repo/name reject without launch.
2. **Attachment idempotency/ambiguity.** Same UUID and payload produces exactly one host launch; changed input refuses. A connection lost after host acceptance yields unknown and inspectable binding, not another worker. Early reports cannot outrun attachment mapping. Re-pair/fingerprint or daemon/process change fences old authority.
3. **Ordered mail.** Home sends two instructions, worker consumes FIFO deliveries and ack replay is idempotent. Worker status reaches the home mailbox. Duplicate import creates no duplicate message; sequence gaps refuse and do not advance ack. Restart resumes durable queues.
4. **Ask/reply.** Worker asks questionQ, timeout leaves Q pending. Home sees Q, repliesA; resumeQ returns A once and no second question. DuplicateA is accepted; conflictingB refuses. Completion closes Q; disconnected host returns uncertainty, not fabricated answer.
5. **Home settlement/preflight.** Real worker sends heartbeat and completion with exact home IDs. Home owner hook may reject; host must not settle on rejection or unavailable hook. Accepted verdict atomically settles home Task/Dispatch/Worker before host success, permits dependents, closes questions and reconciles heartbeats. Wrong peer/process, old retry, stopped/stopping report never settles newer work; duplicate same outcome remains idempotent.
6. **Control/output.** Remote show/read observes exact host worker and bounded source-pinned output. Retain preserves resources. Stop closes only exact owned terminal and exposes positive/unknown verdict. Settled release archives before close; archived read works afterward. Host loss yields unverifiable/release_pending/stop_unknown, never inferred exit. User-owned/external resources are not closed.
7. **Fleet/viewer.** Local and remote rows show actual provenance and independent durable/liveness evidence; includeRemote snapshot pages are bounded and stable with partialHostErrors. Task navigation for D opens a real host-output viewer; it never focuses an unrelated local same-ID session.
8. **Safety defects.** Reject forged RuntimeCallerEvidence/request identities; no local fallback after remote failure, no group lifecycle fanout, no advancing relay cursor before lifecycle commit, no report-before-preflight acceptance, no release of coordinator/setup/worktree. These regressions cover documented authority/uncertainty races rather than incidental wording.

## Industry insights
Research swarms intentionally omitted by LOOP. Primary evidence: external orchestration.md Federation, Messaging, Blocking ask/reply, Safe failure, Races/fencing; existing m6 worker specification and predecessor decisions D2,D4,D6,D11,D13.

## Deferred ideas
None within the claimed worker-federation flows. Existing host-power/pointer/native work retains its queue ownership. Linux/Windows transport/process custody verification is deferred platform work.

## Glossary
Home: Run authority. Host: actual process/custody authority. Binding: durable paired mapping of home and host Run/Task/Dispatch plus peer/process identity. Relay verdict: home-committed lifecycle acceptance/rejection, not transport enqueue acknowledgment. Incarnation: exact running daemon or worker process generation, never just its stable ID.

## Technical decisions and shared contracts
- Extend `plugins/quirky.orchestration` only, public PluginContext/runtime calls; do not import daemon private internals.
- Shared `src/federation/contracts.ts` defines authenticated inbound peer principal, persistent binding, relay item and narrow engine/mail/surface interfaces. These contracts are committed before implementers.
- Engine owns peer method registration/ceiling, migration and binding store, host service-worker execution and home start acceptance, core's distinct federated report authority. Never construct RuntimeCallerEvidence for a remote worker. Reuse local lifecycle transitions and receipt ledger.
- Mail owns `messaging.ts` integration and `federation/mail.ts`; all caller entry points still verify actual local worker authority, then translate exact binding IDs. Home import uses distinct authenticated binding authority and the existing kind preflight. Incoming paired principal is passed directly by the transport, not accepted from JSON or client PluginCaller fields.
- Surface owns local worker handler interception, lifecycle exact-report hook support, output/fleet/control/navigation/CLI and plugin manifest declarations. Parent coordinates interfaces; no concurrent writer shares a file.
- Peer limits must admit the existing maximum worker prompt and normal bounded output; readiness attach timeout must fit the existing worker timing contract, not silently truncate a legal launch. Every new mutation retains UUID and expected daemon incarnation.
- Keep one store migration chain and startup/disposal lifecycle. Timers are bounded to tracked active/unfinished bindings, are stopped on disposal/reset, and never keep a disabled plugin alive.
- Preserve the complete existing migration prefix, including policyMigration, before appending federation binding/mail migrations. Messages-only reset keeps relay queues/cursors; all/tasks reset fences and clears bindings without closing remote processes.
- Host acceptance publishes its actual service Run/Task/Dispatch before placement; exact attached identity is acknowledged by home before preamble input. This prevents early report deadlock. Source daemon incarnation comes from transport metadata validated against the pinned peer's actual live status, not a client-controlled request field.
- Certified host process exit is relayed only from an exact persisted process_exit observation and failed/process_exited worker record. Distinct FederatedWorkerExitInput/authority reuses local infrastructure-failure transitions, failure budget, question closure and escalation; no fabricated successful worker_done and no exit inference from network loss.
- Both ordinary and owner-scoped service entry points route remote starts/controls through the same bound engine/surface. Local host startFederated remains the actual owner-scoped local execution pipeline.
- Permanent acceptance sources cover scenarios1–8. Only `bun run typecheck` is a landing gate under LOOP. Higher-priority coding rules additionally require a focused throwaway real paired-daemon smoke; record its precise exercised scope, not a suite/UI campaign pass.
- Do not change protected loop files, shared queue/index, core D9, real homes/configuration or unrelated owners. Self-review found every claimed flow mapped to one of the three components above.
