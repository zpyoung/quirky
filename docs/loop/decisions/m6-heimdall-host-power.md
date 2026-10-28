# m6-heimdall-host-power decisions

## D1: Implement a daemon-owned synchronous lifecycle capability
- **Question:** brainstorming purpose, consumer, scope, response mapping, authentication and idempotency
- **Options:** asynchronous plugin events; trusted synchronous public callbacks; helper process or delay inference
- **Chose:** daemon-owned native source and public PluginContext.hostPower subscription; fence every runner synchronously before exact sleep acknowledgment, resume on confirmed powered-on event, inherit current state for late runners. No new CLI/RPC power injection.
- **Why:** assigned follow-up requires pre-sleep ordering; existing generic event delivery uses setImmediate and cannot establish it. Six essential design areas are answered by the item and source. All relevant API/integration/data gray areas use the recommended source-grounded defaults autonomously; no person is present.
- **Evidence:** heimdall.md Scheduling/Budgets; m6-heimdall-core D21; plugins/quirky.heimdall/src/runner.ts suspend/resume; packages/daemon/src/plugins/events.ts
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** native source cannot deliver safely on the Bun JS thread
- **Source:** locked by docs/loop/decisions/m6-heimdall-core.md

## D2: Drive the native runloop source on the Bun JS thread
- **Question:** native implementation approach and acknowledgment/thread safety
- **Options:** native helper/thread and bridge; direct FFI with private runloop mode; infer sleep from delayed timers
- **Chose:** direct IOKit/CoreFoundation FFI, private-mode zero-duration runloop servicing on a short unref timer; synchronous JSCallback and immediate acknowledgment after fencing. CanSystemSleep is allowed without suspend; HasPoweredOn is the wake boundary. Native registration fails visibly rather than claiming support.
- **Why:** native callbacks occur only when our JS thread runs the private source mode. No compiled library, foreign-thread callback, helper process, Electron or elapsed-delay inference. SDK documents separate CanSystemSleep/WillSleep acknowledgments and deregistration/port/service cleanup order.
- **Evidence:** macOS SDK IOPMLib.h:127-207; IOMessage.h:130-175; apps/desktop/src/bun/dock.ts; logic.md Technical decisions
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** real native registration smoke or dedicated-host sleep cycle contradicts the documented delivery protocol
- **Source:** assumed — autonomous

## D3: Apply unattended build-first execution
- **Question:** workflow, approval, implementation/reviewer pairing and verification boundaries
- **Options:** human approvals/research/review/test campaign; authoritative build-first loop
- **Chose:** one self-reviewed markdown logic spec with final technical section, autonomous defaults, commit shared public contracts before at most three omp/OpenAI implementers. Parent owns shared integration. No test suite, dogfood or review campaign now; typecheck before landing. Reviewer would be cross-family Opus but reviews/probes are not started in build-first phase. Preserve unrelated untracked .serena metadata without staging it.
- **Why:** current LOOP replaces the normal brainstorming/SDD gates, prohibits asks and moves tests/reviews to the end phase. Existing source survey is bounded prerequisite mapping, not a research swarm.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md Build first, test at the end; queue m7-test-triage remains todo
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** queue reaches end phase or authoritative LOOP changes
- **Source:** locked by docs/loop/LOOP.md

## D4: Hand off disruptive native verification and non-macOS support
- **Question:** native platform safety and verification scope
- **Options:** put the shared active workstation to sleep; register/dispose without sleep and hand off real cycle
- **Chose:** safe native registration/disposal smoke only here; pending real sleep/wake budget/fencing scenario for an idle dedicated macOS host. Linux/Windows native sources are not implemented or claimed.
- **Why:** shared build lanes must not be suspended. LOOP permits pending native-only scenarios to finish separately. No real sleep-cycle pass is claimed.
- **Evidence:** queue title idle dedicated macOS/native test host; LOOP platform/native handoff rules
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** an idle dedicated host is available for the native run
- **Source:** deferred: platform

## D5: Verify registration separately from a real system sleep cycle
- **Question:** what the exercised evidence proves before landing
- **Options:** claim native sleep parity from synthetic events; distinguish safe native subscription proof and actual daemon behavior from disruptive OS verification
- **Chose:** safe throwaway Bun smoke with fresh temporary HOME/QUIRKY_HOME. Actual system IOKit registration, two private-runloop pump opportunities and idempotent disposal succeeded without native errors. A separate actual daemon/API run with a controlled trusted source proved suspended late enrollment has no reads/effects, wake produces a live read and exactly one landed effect, and daemon stop disposes the source. Author permanent tests without running them in the feature phase. Record both real OS-cycle scenarios pending in the native handoff.
- **Why:** a synthetic transition exercises the public kernel binding but is not evidence of OS sleep delivery; a real IOKit subscription smoke establishes FFI symbols, ABI, source creation and teardown without suspending other lanes.
- **Evidence:** /tmp/quirky-l11-power-smoke.ts output NATIVE_IOKIT_REGISTER_PUMP_DISPOSE_OK and REAL_DAEMON_API_SLEEP_FENCE_LATE_ENROLL_WAKE_EFFECT_OK, watcher7b140a18-71e9-4e2d-8609-7fb138cd0118, reads1/effects1/disposedtrue, exit0; bun run typecheck exit0 after correcting six initial diagnostics; docs/loop/native/m6-heimdall-host-power.json
- **Reversibility:** easy
- **Confidence:** high for exercised paths; real OS sleep/wake cycle remains unverified
- **Revisit if:** dedicated native-host observations expose delivery, accounting or teardown errors
- **Source:** assumed — autonomous

## D6: Keep native callback lifetime and activation lifetime explicit
- **Question:** concurrent sources, callback teardown, listener errors and plugin shutdown ordering
- **Options:** shared CF mode and immediate callback release; per-registration private mode and deferred native teardown
- **Chose:** each registration owns a uniquely named CF mode, pointer-width native out slots and its JSCallback. Reentrant dispose stops delivery immediately but releases native resources only after the servicing native call returns. Every listener is attempted; failures and asynchronous returns are logged, and the exact WillSleep notification is acknowledged once after delivery attempts. OS acknowledgment is protocol handling, not a claim that a failed fence succeeded. Native source is disposed after plugin deactivation, retaining valid public capabilities until activation revocation. Runtime revoke removes callbacks before awaiting unrelated resource cleanup.
- **Why:** a shared mode could service another daemon's callback from the wrong stack. Releasing an executing trampoline is unsafe. Withholding acknowledgment cannot guarantee fencing because macOS forces non-abortable sleep after its timeout. Plugin APIs otherwise remain valid through deactivate.
- **Evidence:** native-host-power.ts private mode/servicingRunLoop cleanup; host-power.ts listener dispatch/revocation; daemon.ts stop; SDK IOPMLib.h mandatory acknowledgment timeout
- **Reversibility:** medium
- **Confidence:** high for implementation ordering; native-cycle proof pending
- **Revisit if:** a new native event delivery mechanism changes callback ownership
- **Source:** assumed — autonomous

## Progress
Implementation integrated from two disjoint omp worktrees; both writers completed without checks and their explicit scopes/HEAD8398e94b were audited. Worker worktrees removed after merging. Parent corrected native pointer typing, isolated CF mode names and null-terminated mode buffer, replaced unsupported fake-timer calls with deterministic explicit pulses, added the public capability to affected context fixtures, and removed incidental wording/not-throw assertions. Safe native registration + actual daemon/API smoke passed; typecheck passed. No test suite, build, review or dogfood was run. Native sleep/wake scenarios remain pending. Commit integration/docs, catch up once with build/roadmap, read incoming decisions, run final typecheck/smoke, then detach and canonical queue land.
