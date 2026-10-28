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

## Progress
Design complete. Commit public lifecycle contracts, then dispatch native producer and Heimdall binding in disjoint scopes. Parent owns runtime/daemon integration, documentation, typecheck and landing.
