# Orchestration and Heimdall parity sweep — technical specification

Status: implementation and regression source committed; current operator directive requires immediate typecheck-only landing. Acceptance suites, actual-worker smoke, UI dogfood and final code review below are unexecuted end-phase obligations, not completion evidence or current gates. The combined Codex spec review preceded that directive. Behavior: [logic.md](logic.md).

## Architecture
Implements [conceptual model](logic.md#conceptual-model-and-data-flow) and [SC1](logic.md#sc1--a-completed-assignment-is-not-running-work).

Existing orchestration service coordinator publishes `ServiceRunDetail.workers`, including required `assignmentActive: boolean`, from its owner-scoped non-consuming `serviceRunShow`. Heimdall's `createControlHost` validates that response and maps it to `WatcherWorker`; `createFleetService` derives `FleetRow.runningWorkers` from those rows. The existing `FleetTable` in `src/ui.tsx` already renders zero as “No active work”. No UI layout or lifecycle change is needed.

Code root: `/Users/zpyoung/orca/workspaces/quirky/build-lane-7/`. TypeScript/Bun, existing plugin-private SQLite stores and public RPC boundaries. No new dependency or migration.

## Code references
Supports [scope](logic.md#scope-and-non-goals).

- `plugins/quirky.orchestration/src/services/contracts.ts:12-25`: `ServiceWorkerView`, `ServiceRunDetail`; read-only reference, already requires assignment activity.
- `plugins/quirky.orchestration/src/services/coordinator.ts:82-105`: existing computation of assignment activity; unchanged.
- `plugins/quirky.heimdall/src/control-contracts.ts:9`: `WatcherWorker`; add required activity boolean, preserving identity/state and optional fields.
- `plugins/quirky.heimdall/src/control-host.ts:6-18,37-45,105-120`: local service response type/schema/parser and workers mapping; validate and carry activity.
- `plugins/quirky.heimdall/src/fleet.ts:195-215`: `rowFrom`; count only live active assignments.
- `plugins/quirky.heimdall/src/control-api.ts:80-86`: shared worker response schema; add required boolean.
- `plugins/quirky.heimdall/quirky-plugin.json`: declared method worker schemas for detail/debug; mirror actual runtime schema using existing manifest convention, no unrelated rewrite.
- `plugins/quirky.heimdall/test/control-host.test.ts:7-41`: service-boundary fixture; malformed/missing activity regression.
- `plugins/quirky.heimdall/test/fleet.test.ts:84-143`: deterministic projection harness; mixed activity regression and detail/debug preservation.
- `plugins/quirky.heimdall/test/control-plane.test.ts` and `test/control-cli.test.ts`: migrate typed worker literals to explicit activity without re-pinning unrelated text.
- `plugins/quirky.orchestration/test/workers/acceptance-support.ts:34-97`: `startWorkerAcceptance`, launched-process CLI request bridge, isolated home/process cleanup.
- `plugins/quirky.orchestration/test/services/api.test.ts:506-548`: existing real-process report/retained-live service proof; use as a pattern, do not modify it.
- New `plugins/quirky.heimdall/test/fleet-worker-acceptance.test.ts`: real daemon/API/CLI regression; install a temporary declared generic kind if needed, not a production fixture endpoint.
- New `plugins/quirky.heimdall/test/fleet-worker-fixture.ts`: reusable isolated generic-kind/attested-worker fixture for regression and real runtime/UI smoke. All fixture methods remain test-owned, not production endpoints.
- `docs/quirk/specs/2026-10-27-m6-heimdall-control/logic.md`: add a dated amendment clarifying running-assignment semantics after proof; prior ACs otherwise unchanged.

No language server is configured (`xd://lsp status` observed); references were enumerated by repository grep. Production consumers are control-host/fleet/control-plane/control-cli/UI; typed fixtures in the four test files above require migration. Owner/runner already consume the richer separate `OrchestrationWorkerObservation`; they remain unchanged and consistent.

## Contracts & interfaces
Implements [SC1–SC3](logic.md#behavior--acceptance-scenarios).

`CONTRACT:` `WatcherWorker` adds required `assignmentActive: boolean`; it continues to expose `identity`, `state: live | exited | unverifiable`, and existing optional metadata/questions.

- Preconditions: owner-service response is for exactly the enrollment's orchestration Run and every worker has boolean activity evidence.
- Postconditions: mapped detail/debug workers preserve activity and identity regardless of settlement. No worker is removed solely for inactive assignment or non-live process state.
- Fleet invariant: `runningWorkers` is the number of rows where both `state === 'live'` and `assignmentActive === true`.
- Errors: missing, null, string, numeric or other non-boolean activity fails existing response validation. No default, coercion, hidden successful zero or fallback to liveness.
- Inspection remains non-consuming and side-effect-free with respect to worker/process/mailbox state. The existing fleet error and last-confirmed UI handling remain unchanged.
- Command eligibility and result semantics remain unchanged; activity is projection evidence, not new stop/release authority.

## Data models / schemas
Supports [API decisions](logic.md#decisions-locked).

`SCHEMA:` each `WatcherWorker` response schema declares `assignmentActive: { type: 'boolean' }` and includes `assignmentActive` in its required list alongside `identity` and `state`. The local service-run worker schema also requires and validates it. Existing additional-property policy remains unchanged.

No database columns, persisted enrollment values, event names or contract versions change. The source service already produces this required field; this is a clean cutover of the consuming controls projection and all affected test constructors.

## DO-NOT-CHANGE fences
Supports [scope](logic.md#scope-and-non-goals) and [locked choices](logic.md#decisions-locked).

- Orchestration gate resolution, admission, service authority, report settlement, custody and worker release: unchanged; D9 deliberately defines gate behavior and worker activity already exists upstream.
- Heimdall runner, owner driver and budget accounting: unchanged; they already distinguish assignment activity. Do not make this display repair a scheduling change.
- Fleet detail/debug worker-list cardinality, question visibility and identity fields: preserved; retained processes must remain inspectable.
- Shared loop files, queue/index, feature-doc source directory and inherited user files: do not modify. Queue changes only via canonical `queue.ts`.
- Do not weaken process-scoped cleanup, launch attestation, exact identity checks, timeouts/assertions or required acceptance paths to obtain a green run.

## Always / Ask / Never
Supports [scope and consumers](logic.md#purpose-and-consumers).

Always: use existing public plugin RPCs, exact owner Run, temporary `QUIRKY_HOME` and owned cleanup; stage exact scoped files; record choices autonomously in the item decision log. Keep all existing response schema declarations consistent.

Ask: no human prompts in this unattended run. Route an unresolvable locked-policy conflict to an explicit queue blocker/completion decision as LOOP prescribes; never silently reinterpret it.

Never: infer settled assignment from process exit alone; infer active assignment from a live process; hide a retained worker; stop/release while inspecting; add private cross-plugin runtime imports, fake fallback or production-only test endpoint.

## Cross-cutting
Supports [recovery decisions](logic.md#decisions-locked).

Security: assignment evidence comes from the existing owner-scoped response, not caller input or terminal text. Retaining all rows preserves visibility without granting additional process authority.

Observability: detail/debug explicitly expose the distinction; malformed projections use existing errors. No new telemetry or retry layer.

Migration/rollback: no persisted-state migration. Runtime schemas and manifest cut over with the field and all consumers in one item; no compatibility alias or optional default.

## Testing strategy
Implements [acceptance](logic.md#behavior--acceptance-scenarios).

The following is the written end-phase verification strategy. Do not run these tests, suites or UI passes before `m7-test-triage` under the updated LOOP. Current landing runs only `bun run typecheck`; the standalone pre-fix projection reproduction was completed before the operator's directive.

1. Tests are prepared before production behavior changes. Parent observes RED for the demonstrated retained-live count (and malformed boundary if separately exercised), then implements the minimal source fix and observes GREEN. Permanent tests must assert consumer behavior, not source strings, schema copies or mocked forwarding.
2. Deterministic fleet test covers the mixed activity matrix and full detail/debug retention. Adapter test covers malformed evidence because accepting it would fabricate activity certainty.
3. New API/CLI test launches real Quirky with an attested worker and demonstrates one running assignment. Establish and acknowledge a bounded fixture-kind `read` hook fence before mailbox draining (`src/runner.ts:1272-1277`) before sending completion. Keep that fence held through API/CLI inspection and process-aliveness checks, then release it in `finally`. Pause is not a cleanup fence: paused watchers still drain mail and release settled workers. Submit `worker_done` through the actual worker's inherited CLI authority, prove the same process remains alive, and check fleet zero plus detail/debug inactive worker. No production pause/runner change, external provider calls or real user configuration.
4. Actual-runtime smoke repeats the exercised path outside test-runner assertions. Web dogfood uses the built contributed Heimdall page: one active assignment then retained live/inactive with “No active work” and a visible live detail row. Use fresh homes, stop all owned processes. Native-only behavior unchanged; no new native scenario.

`COMMAND:` `bun test plugins/quirky.heimdall/test/fleet-worker-acceptance.test.ts plugins/quirky.heimdall/test/fleet.test.ts plugins/quirky.heimdall/test/control-host.test.ts plugins/quirky.heimdall/test/control-plane.test.ts plugins/quirky.heimdall/test/control-cli.test.ts` — expected exit 0 after fix.

`COMMAND:` `bun scripts/suite.ts plugins/quirky.heimdall plugins/quirky.orchestration plugins/quirky.notifications plugins/quirky.worktree` — affected package/plugin gate, expected exit 0. Remote runner handles its configured platform split; do not claim an unobserved macOS-only result.

`COMMAND:` `bun test scripts` and `bun run typecheck` — expected exit 0; run root build `bun run build` for web surface. Whole suite reserved for canonical queue land.

## Non-goals
See [logic scope](logic.md#scope-and-non-goals) and [flow inventory](logic.md#feature-flow-inventory). Newly inventoried larger parity gaps need actual public transport/lease/credential/lifecycle seams, not simulation in the fleet repair. The single completion item records them before landing; existing pointer/power work is not duplicated.
