# Automatic idle mailbox nudges with bounded shutdown

## Status & amendments
Status: implemented with standalone daemon/API/CLI and unresolved-dependency smoke evidence; permanent regression cases written, not run under build-first rules. Integration typecheck and queue landing still required.

**Amendments:** 2026-10-28: restores the single flow deferred by m6-orchestration-core D41. Actual CLI execution exposed the checkpoint test's incorrect Dispatch `--run` wording: that flag selects the coordinator mailbox (orchestration.md:421), not the worker's Dispatch. Preserve all AC9 safety assertions and timeout, replace the incidental string pin with execution of the captured command and positive receipt of the exact mailed message. The original case remains reviewable at the unchanged checkpoint.

## Purpose and scope
Restore best-effort automatic Run/Dispatch mailbox command hints without making daemon/plugin shutdown wait for external status or pointer RPC completion. Consumers are idle agents; coordinators continue to use durable send/check/ack unchanged.

In scope: checkpoint/m6-core-idle-pointer's automatic pointer engine, arrival/availability and session/status/journal wakes, startup recovery, reset cooperation, safe submission and bounded lifecycle. Restore its full AC9 behavior with an executable-command regression alongside shutdown/race regressions.

Non-goals: federation, worker lifecycle redesign, human prompts, UI settings, the retired coordinator task scheduler, generic RPC cancellation, synthetic idle proof, native window behavior, automatic consumption/acknowledgement or completion.

## Conceptual model and data flow
Mail commits before notifications. A microtask offers a command-only hint to the currently eligible Run/Dispatch assignee, respecting delivery and waiter reservations. The existing public session pointer seam owns exact-incarnation validation, durable operation replay, terminal text/Enter separation, Cursor text-only behavior and structured native submission. The orchestration ledger retains message batches and unknown attempts across restart. Mail stays unread until check/ack.

Disposal is a terminal scheduler state: synchronously fence future work, clear timers and queues, unsubscribe, and release local waits. A call already admitted to another plugin belongs to that plugin's durable operation ledger; do not pretend it was cancelled or safe to replay with a new key. Any late continuation must stop before another RPC, store access, timer or event-driven wake. Thus shutdown need not await an unbounded external promise and the orchestration store may close safely.

## Decisions locked and approaches
- Recommended: restore the existing engine with a local lifecycle cancellation/fencing boundary, reusing shipped public contracts and schema. Preserve attempt IDs for uncertain work.
- Rejected: timeout-and-ignore disposal while continuations can still touch a closed store; that suppresses the symptom and creates a lifetime bug.
- Rejected: stop at explicit pointers, weaken AC9 safety/timeout, or pin a demonstrably unusable command merely to match a substring; none implements the claimed flow.
- Identity: actual runtime-owned incarnation and live status only. Unknown/blocked/working terminals are not safe to type into. Structured mailbox hints remain idle-only.
- Consumption: no pointer reads/acks messages or settles Tasks. Unfiltered waits own the mailbox; filtered waits reserve their types; outstanding deliveries suppress new hints.
- Output: Run hints use `quirky orchestration check --run <runId>`; Dispatch hints use `quirky orchestration check`, letting the existing exact-owner resolution select the worker mailbox. Never include subjects/bodies or change coordinator/Dispatch selector precedence.
- Recovery: reserved-but-not-attempted rows can be released; attempted rows reuse the same operation ID and never invent a second Enter. Reset fences pre-reset continuations as well as removing corresponding durable rows.
- Limits: retain the checkpoint's bounded queues/pages/batches/retention and event-driven scheduling rather than a poll loop.

## Acceptance scenarios
### SC1 — Full AC9 automatic hint with executable command
Before: live idle Claude worker assigned a Dispatch in R, unread private Dispatch mail, no Delivery/waiter. Walkthrough: enqueue through daemon API, observe command text and separate Enter only at the idle assignee, then execute the captured command through the real CLI. After: private body absent; inbox row remains unread; CLI successfully returns the exact mailed message. Keep the checkpoint's safety assertions and20-second timeout; replace only the erroneous Run-qualified command substring pin, not the behavioral acceptance.

### SC2 — Mail ownership and safe wakeups
Before: mail is waiting while terminal works/is blocked, or an outstanding Delivery/unfiltered waiter owns it. Walkthrough: process arrival, idle/status wake and acknowledgement/waiter release; filtered waits reserve only matching types. After: no unsafe/competing hint; eligible unreserved mail may receive one bounded command flight; check/ack remains authoritative. More mail arriving mid-flight drains only after the existing flight settles.

### SC3 — Bounded shutdown during slow dependencies
Before: scheduler is awaiting identity, eligibility or pointer submission, including startup scan and terminal Enter delay. Walkthrough: dispose or stop daemon while a dependency has not settled, then settle/reject it after disposal. After: scheduler disposal resolves independently of that dependency; listeners/timers are gone; no new RPC/store work occurs from late continuations. Durable attempted records remain recoverable with the original key, not marked falsely submitted/read. Real daemon shutdown must finish without activation/deactivation timeout warnings.

### SC4 — Restart and reset fences
Before: reserved/attempted pointer work exists or reset races an in-flight eligibility query. Walkthrough: restart, or reset messages/tasks/all, then allow the old dependency to finish. After: restart observes persisted phases and exact incarnation; uncertain submissions do not generate duplicate Enter. Reset cannot resurrect cleared mail/dispatch hints or let a stale continuation mutate a new operation. New post-reset mail can schedule normally.

## Defect coverage
The feature doc names no numbered idle-pointer defect. Regression obligations are the recorded >25-second checkpoint teardown, late closed-store access, duplicate Enter under uncertainty, unsafe status/identity changes, waiter ownership, and accidental pointer consumption. Preserve existing session pointer tests instead of replacing runtime safety with scheduler mocks.

## Industry insights
No research swarm: authoritative inputs are orchestration.md Waking waiters and nudging idle agents / Pointer push into terminal/chat, m6-orchestration-core D10/D41, the preserved checkpoint engine and current daemon/plugin lifecycle. Evidence establishes an unbounded `Promise.allSettled` dependency in checkpoint dispose; the exact historical unresolved RPC is not known.
Narrow daemon smoke also established fake PTY response truncation under backpressure (5194-byte list reply,2917bytes accepted) leaving a subsequent snapshot and status request unresolved. Fix the fixture output queue/drain across all frame kinds and retain a large interleaved transport regression; do not increase AC9 timeouts or bypass live status.

## Deferred ideas
None. Existing federation/remote parity items retain ownership. Linux/Windows lifecycle and pointer behavior need separate platform verification, not claimed here.

## Glossary
Pointer: non-consuming check command hint. Flight: one admitted pointer operation per recipient. Fence: terminal lifecycle/generation guard preventing stale async work from further effects. Unknown: lack of settled result, never proof no effect.

## Technical decisions and contracts
- Reuse committed PluginContext/PluginStore, OrchestrationMessages arrival/availability/pointerCandidates, runTaskMethods reset/binding callbacks, SessionIdentity, SessionPointerParams/Result and pointer_operations schema. No new shared public type/schema/API is needed; this spec commits the lifecycle contract before implementation.
- Restore plugins/quirky.orchestration/src/pointers.ts from checkpoint69083459; preserve its mailbox-specific command selectors and scheduling/durable semantics except the explicit lifecycle/reset fences. Repair fake-pty-host.ts output backpressure and add a bounded transport regression in pty-client.test.ts.
- Integrate in src/service.ts without dropping service coordinator, workers or message-arrived event wiring. Stop pointers before message/core disposal. Keep stores open until the guarded scheduler has relinquished local work; do not wait on external settlement.
- Check all async suspension boundaries and finally blocks, not just dispose. Settle/catch admitted promises so late rejection is observed; do not run new work after dispose or a matching reset generation.
- Tests: restore AC9 into existing acceptance-api.test.ts; add focused scheduler lifecycle tests for unresolved/late RPC, startup and reset. Use fresh isolated fixture state for real process/API coverage. No real ~/.quirky, ~/.claude or ~/.codex writes.
- Parent acceptance commands: `bun run typecheck`; a throwaway isolated daemon API/PTY smoke for command-only unread hints and bounded stop. Permanent regression execution, suites, reviews and UI dogfood remain deferred under the current build-first instruction.
- Self-review: scope matches D41; SC1 preserves and strengthens consumer-visible checkpoint behavior; SC2–4 specify safety, shutdown and recovery. Existing selector authority is unchanged. No placeholders, new scheduling authority or native-only scenario.
