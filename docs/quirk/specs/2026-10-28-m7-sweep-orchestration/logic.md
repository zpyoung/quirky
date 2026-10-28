# Orchestration and Heimdall parity sweep

## Status & amendments
Status: autonomous design accepted under LOOP.md; combined Codex spec review completed, both confirmed findings incorporated. Tech spec required: public projection contract crosses orchestration and Heimdall control/UI boundaries.

**Amendments:** 2026-10-28 — initial sweep; spec review replaces unsafe pause-as-cleanup-fence assumption with an acknowledged bounded pre-mailbox-read fixture fence, and explicitly inventories generic workspace-removal/submission-preflight gaps. No production pause semantics or prior product contract overridden.

## Purpose and consumers
Give operators and agents a truthful view of supervised work. A retained worker process is useful for inspection but is not an active assignment. The Heimdall fleet must stop counting that process as running work after its Dispatch settles, without hiding or terminating it.

Consumers: people reading the Heimdall fleet/detail UI; agents reading the same schema-declared API and generated CLI; built-in and third-party plugins using owner-scoped orchestration services.

## Scope and non-goals
This item inventories both feature docs, verifies existing behavior with affected suites, fixes the demonstrated local fleet projection defect, and records remaining larger parity flows in one completion item. The queue title explicitly authorizes follow-ups for work too large for this sweep. A landed sweep is not an assertion that those completion flows shipped.

Explicit user exclusions: GitLab, Bitbucket, Gitea/Forgejo, Azure DevOps, concrete Objective runner and PR sitter. Generic kind fixtures exercise the kernel contract, not those deferred products.

No new scheduler, remote transport, lease facility, external judgment provider, interactive chat product, legacy Orca migration/shim, or gate-policy change is included in the fleet repair. Existing automatic-pointer and macOS-power queue items are reused rather than duplicated.

## Conceptual model and data flow
Orchestration owns Runs, Tasks, Dispatches, worker process identity and resource custody. Its owner-scoped inspection distinguishes an active assignment from process liveness: a worker may finish and remain alive for inspection. Heimdall reads this non-consumingly, preserving both facts. Its fleet counts only positively live workers with an active assignment. Detail and debug retain the full worker list, including inactive live processes and unverifiable workers. The UI and CLI display the same daemon projection.

## Key decisions & rationale
- Recommended: carry assignment activity through the existing projection and fix the count at its source. Alternatives: hide all inactive workers (loses debugging visibility); infer activity from liveness (the demonstrated defect); reread every Dispatch from the UI (duplicates authority and adds races).
- Require explicit boolean activity evidence, matching the service contract already used by the kernel and owner detector. Missing or malformed evidence is an inspection failure, not invented zero work.
- Keep process lifecycle, custody, mailbox acknowledgement, budgets and owner policy unchanged. Reading the fleet must never stop, release or retain a worker.
- Preserve core D9's deliberate gate-resolution behavior. A separate completion decision must resolve its conflict with prerequisite-consistent `ready` listings; no dispatch bypass was found because admission rechecks dependencies and pending gates.

## Decisions Locked
- **API/data mapping:** assignment activity and process liveness remain separate; both are exposed for every detail/debug worker. No inferred activity from idle state, provider text or process existence.
- **Error responses/recovery:** malformed service projection fails inspection; uncertainty stays explicit. Last-confirmed UI snapshot behavior remains unchanged.
- **Visual/information density:** existing fleet activity copy and layout remain; zero positively running assignments shows “No active work”. Detail retains the live process row and normal controls.
- **Integration/authentication:** inspect only the watcher's actual owned Run through public plugin methods. No forged session evidence, raw PID actions or private cross-plugin import.
- **CLI/output:** existing schema-generated methods and `quirky heimdall list/show/debug` remain the scriptable surface; no new command group or alias.
- **Scope:** existing local kernel decisions remain binding; newly inventoried remote/lease/judgment flows are not represented as shipped. Source `assumed — autonomous` unless locked by roadmap or earlier named decisions.
- **Platform:** build and test on macOS; new field and count predicate are portable. Native OS notification/power scenarios remain their existing handoffs.

## Behavior & acceptance scenarios
### SC1 — A completed assignment is not running work
- **Given** a watcher whose exact owned worker is live and has an active assignment, the fleet counts one running worker.
- **When** that worker sends an authorized successful completion and its process remains alive, with an acknowledged bounded fixture read fence established before mailbox draining, the fleet reports zero running workers; detail and debug still show that worker as live and assignment-inactive. Pause alone is not a cleanup fence.
- **Then** API and real CLI inspection agree, the activity cell reads “No active work”, and neither inspection nor projection stops/releases the process or creates another worker.
- **Data before:** **Watcher**: one active worker; **Worker**: live, assignment active; **Fleet**: one running.
- **Walkthrough:** establish the fixture's pre-drain read fence; worker completes its own Dispatch through the real CLI/API authority path; operator inspects fleet/detail/debug and CLI output while the fence remains held, then releases the fence in cleanup.
- **Data after:** **Worker**: live, assignment inactive, same identity; **Fleet**: zero running; **Detail/debug**: same live worker retained.

### SC2 — Mixed activity is counted from positive facts
- **Given** one live active worker, one live inactive worker, one unverifiable active worker, and one exited inactive worker,
- **When** the fleet is projected,
- **Then** exactly one worker is counted as running; all four remain available in detail/debug without fabricated liveness or lifecycle mutation.
- **Data before:** **Workers**: active/live, inactive/live, active/unverifiable, inactive/exited.
- **Walkthrough:** read the same fleet and detail projection.
- **Data after:** **Fleet**: one running; **Worker evidence** unchanged.

### SC3 — Missing activity evidence is not silently inactive
- **Given** an owner-service response missing assignment activity or containing a non-boolean value,
- **When** Heimdall inspects that worker,
- **Then** it rejects the malformed projection through the existing inspection error path; it does not publish a newly confirmed zero-work snapshot. Valid inactive evidence remains accepted.
- **Data before:** **Owner response**: activity missing, then invalid, then explicitly false.
- **Walkthrough:** drive the adapter boundary with each response; retain existing last-confirmed snapshot policy.
- **Data after:** missing/invalid responses rejected; explicit inactive response yields a preserved inactive worker, not a deleted worker.

## Feature flow inventory
“Covered” below means implementation and existing acceptance entrypoints were located; fresh execution results belong in the decision log, not inferred from test names.

| Feature-doc flow | Existing public-path coverage / disposition |
|---|---|
| Orchestration skill install/update/copy/coverage, onboarding, depth policy | `plugins/quirky.orchestration/test/setup-acceptance.test.ts`; UI and policy implemented; no stale Experimental gate. |
| Runs, binding/generation, Tasks/DAG, Dispatch/depth/circuit/authority | `test/acceptance-api.test.ts`, `acceptance-cli.test.ts`, terminal/structured-auth tests. |
| Mail routing/groups, FIFO replay/ack, type-filtered waits, ask timeout/resume/reply | `test/acceptance-api.test.ts`, `acceptance-lifecycle-cli.test.ts`; mailbox reads separate from pointer notification. |
| Gates, mutation receipts/restart/reset | `test/acceptance-api.test.ts`; deliberate D9 unconditional ready-on-resolution remains, actual dispatch rechecks prerequisites. |
| Worker start/placement/readiness/preamble, terminal/structured mode | `test/workers/acceptance.test.ts`, `acceptance-placement.test.ts`, `acceptance-recovery.test.ts`. |
| Stop/abandon/retry/retain/release, takeover, archive, output/fleet, restart | `test/workers/acceptance*.test.ts`, `output-fleet.test.ts`, `acceptance-restart.test.ts`. |
| Task terminal links and nested sidebar/dashboard labels | `test/navigation-acceptance.test.ts`, UI model coverage; exact assignment/custody proof. |
| Automatic idle mailbox nudges and restart/shutdown behavior | Unshipped; already queued as `m6-orchestration-idle-pointer-shutdown`, intact checkpoint and contract preserved by core D41. |
| Remote worker placement, federation relay/ask/report/stop/release/fleet/navigation | Unshipped; local fleet explicitly reports unsupported remote capability. Completion item must add real transport/authority; no local fallback. |
| Orca legacy adoption and retired scheduler compatibility | Not a fresh Quirky product flow: core D4/D12 and clean-cutover architecture use native Quirky identity/store, not copied Orca tombstones/retired commands. |
| Heimdall kinds/enrollment/rearm/refusals, persistence/future schema/malformed state | `plugins/quirky.heimdall/test/acceptance.test.ts`, `enrollment-store.test.ts`. |
| Ticks/gates/live redecision/write-ahead/uncertainty/retention/pacing/budgets/park/terminal/shutdown | `runner.test.ts`, `gate-security.test.ts`, `pacing.test.ts`, `acceptance.test.ts`. |
| Workers/mailbox/service authority and owner interventions/stalls | `orchestration.test.ts`, `worker-controls.test.ts`, `owner-acceptance.test.ts`, `owner-worker-acceptance.test.ts`. |
| Fleet/detail/controls/debug/CLI/traces/glyphs/two notification transitions | `control-acceptance.test.ts`, `fleet.test.ts`, `control-host.test.ts`, UI-model tests; notification bridge in `quirky.notifications/test/heimdall.test.ts`; SC1–3 close retained-worker activity defect. |
| Automatic native sleep/wake | Unshipped; existing `m6-heimdall-host-power` owns trusted native producer and pre-sleep fencing/ack. |
| Workspace epoch leases, remote fleet mirrors/control, optional shadow judgment | Unshipped; excluded by original M6 slice, now inventoried for the completion item. No lease guarantee, remote mirror or judgment client is claimed. |
| Confirmed workspace-removal termination and generic worker-report submission preflight | Unshipped generic kernel seams; completion item must establish authoritative absence without touching workers, and public kind-owned pre-settlement validation. Do not confuse generic stop predicates with workspace proof or include deferred Objective/sitter algorithms. |
| Objective/sitter creation/plan/execution-specific behavior | Explicitly user-deferred; generic fixture kinds are not implementation of those products. |

## Defect coverage
The orchestration feature doc describes stale Experimental enablement documentation, not a real required toggle; existing setup/API behavior needs no enablement switch. Heimdall lists hidden operator-edit and rejected-plan explanations: generic status/decision/gate/escalation/journal detail rendering and `control-acceptance.test.ts` cover supplied explanations without hardcoding `.memsearch`. Actual Objective-kind production of those reasons is outside the user's included scope. SC1 adds a newly discovered Quirky projection regression, distinct from those source defects. Existing guarded-UI/native evidence is not promoted to new pass claims.

## Industry Insights
LOOP's feature docs, roadmap and earlier decision logs are the research source; no external research claims. Critical evidence: `orchestration.md` process ownership and worker lifecycle; `heimdall.md` fleet Activity semantics; core D9/D41, Heimdall core D1/D21/D22 and control D4. The owner's existing activity filtering demonstrates the intended distinction; controls currently discard it.

## Deferred Ideas
One new completion item will name federation, Heimdall leases/remote fleet/judgment, confirmed-workspace-removal termination, generic worker-report submission preflight, and the gate-status contract question. Reuse the two existing pointer/power items. Complete excluded watcher kinds only if the user separately requeues them; this sweep does not do so.

## Glossary
Assignment activity: whether the Dispatch remains active, independent of process liveness. Retained worker: process kept for inspection after assignment settlement. Running worker count: live process plus active assignment. Owner service: plugin-scoped authority to inspect/control one owned orchestration Run. Journal: Heimdall's durable action history, separate from the project ledger.
