# Automatic host-power lifecycle

## Status & amendments
Status: Approved autonomously under docs/loop/LOOP.md; one logic spec with technical decisions.

## Purpose and conceptual model
The daemon owns one trusted macOS sleep/wake registration. Heimdall consumes a public, in-process lifecycle capability, not the asynchronous event bus. Every runner fences new work before the native sleep acknowledgment. Wake requests an immediate live reconciliation. Active budgets never include the sleeping gap.

## Scope and non-goals
Implement the missing automatic local-host producer and lifecycle binding from heimdall.md Scheduling and Budgets, following m6-heimdall-core D21. Existing Heimdall API/CLI controls remain unchanged. No new remote power commands, shell dependence, Electron, helper processes, inferred sleep from timer delays, native compilation pipeline, sleep prevention, leases, remote fleets or judgment. Other Heimdall flows belong to their existing items. Linux/Windows bindings are deferred by platform policy.

## Decisions locked
- Integration/data mapping: synchronous suspend/resume callbacks are a public PluginContext capability, independently revocable per activation. Native event injection is not exposed over RPC.
- Conflict/idempotency: duplicate suspend/wake notifications do not repeat transitions; late subscribers receive the current suspended state before they can schedule work. A runner created during suspension is suspended before scheduling.
- Errors/recovery: all listeners are attempted even when one fails; failures are logged. The native callback never throws across FFI. A failed fence is not represented as success. Native registration failure is a startup error on macOS, not a silent no-op.
- Budget semantics: suspend closes known work intervals before the OS acknowledgment; wake does not charge the sleep gap and forces the existing fresh read/recovery path.
- Lifecycle: native delivery belongs to the Bun JS thread; subscriptions are removed on plugin revocation and source registration is disposed during daemon shutdown. Dispose is idempotent.

## Behavior and acceptance
### AC1: Fence before acknowledgment
Before: a watcher is awaiting an asynchronous world read and another has a scheduled action.
Walkthrough: macOS delivers SystemWillSleep; the daemon calls each registered suspend callback synchronously, then acknowledges that exact native notification.
After: no pending decision can commit an action; timers are cleared. Generic async event subscribers do not participate in the acknowledgment boundary. A consumer-visible regression drives the real kernel service with a controllable trusted source; a dedicated native-host scenario covers actual OS delivery.

### AC2: Exclude sleeping time and reconcile on wake
Before: active work has accumulated budget, then the host sleeps for ten minutes.
Walkthrough: suspend closes the known interval; SystemHasPoweredOn resumes all runners.
After: budget excludes the ten-minute gap; the next reconciliation reads live state before performing an effect. Existing worker/attempt outcome uncertainty remains intact; wake does not blindly replay an action.

### AC3: Enrollment/restoration during suspension
Before: the daemon's power state is suspended, including while a kind's restore or registration RPC is pending.
Walkthrough: a new runner is created or enrollment re-arms an existing runner.
After: it cannot schedule or execute until native wake; every runner in the current kernel instance is covered.

### AC4: Dispose without stale callbacks
Before: a plugin has subscribed, then is deactivated/replaced, or the daemon stops.
Walkthrough: plugin revoke removes its callbacks; daemon shutdown removes the CF runloop source, deregisters the IOKit notifier, destroys its notification port, closes the service connection and JS callback.
After: a revoked activation cannot be called; repeated disposal is harmless; a subsequent daemon can register cleanly.

### AC5: Correct native event protocol
CanSystemSleep is allowed without suspending watchers, because another application may veto idle sleep. Only SystemWillSleep fences and requires its own acknowledgment. SystemWillPowerOn does not resume early; only SystemHasPoweredOn does. Other messages are ignored. Native delivery runs on the JS thread, never a foreign-thread JS callback.

## Orca defects
The source doc lists no separate host-power defect. Regression coverage targets lost pre-sleep fencing, sleep charged to active budgets, premature wake, late enrollments escaping suspension and stale subscriptions.

## Industry insights
No external research swarm, as required by the current LOOP. Local macOS SDK IOPMLib.h IORegisterForSystemPower documents mandatory acknowledgments, the 30-second forced-sleep limit, CanSystemSleep veto semantics, and teardown order. Existing desktop dock.ts establishes Bun FFI as an in-process convention. No claim of real sleep/wake verification on the shared workstation.

## Glossary
Fence: synchronous runner state transition invalidating pending work. Acknowledgment: IOAllowPowerChange for the supplied notification ID. Native source: daemon-owned IOKit registration. Subscription: plugin-owned synchronous lifecycle handlers.

## Deferred ideas
Linux/Windows producer and verification: platform policy. Actual system sleep/wake scenario: pending dedicated macOS/native host, never put the shared build machine to sleep.

## Technical decisions
Use Bun FFI directly against system IOKit/CoreFoundation frameworks. Register an IONotificationPort runloop source in a private CFRunLoop mode on the Bun JS thread. A short unref'd timer services ready native messages with zero-duration CFRunLoopRunInMode; this polls the actual native source, not elapsed-delay inference. No worker thread or native build artifact is needed. Synchronous JSCallback handlers invoke the lifecycle service before IOAllowPowerChange. Keep source and lifecycle ownership in daemon modules; Heimdall imports only public protocol types. Subscribe before restoring or creating runners, release on shutdown, and inherit suspended state for newly created runners. Tests are authored but not run during feature-building under LOOP; typecheck is the landing gate. Native subscription/disposal smoke uses no system sleep and no persistent user state.

## Self-review
All five acceptance criteria cover the assigned Scheduling/Budgets slice. Decisions preserve core D21 and process boundaries. No unimplemented RPC or fabricated native event is presented as OS proof. Native-only OS cycle is explicitly handed off; broader feature requirements are non-goals of this slice.
