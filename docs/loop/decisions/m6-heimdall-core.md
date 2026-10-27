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

## Progress
Iteration4 claimed item and created branch. Source scoped requirements, roadmap/architecture and public-plugin bindings read. Merged early orchestration worker contracts; runtime dependency still being implemented. One combined spec plus shared type contracts ready for commit. Next: dispatch three disjoint components, integrate after all return; resolve service-coordinator public API with prerequisite lane, exercise AC1-11 through daemon API, run affected suite/scripts/typecheck once, await deps ready, catch up once, final cross-family review and queue land. No runtime acceptance claim yet.
