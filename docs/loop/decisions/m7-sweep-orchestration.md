# m7-sweep-orchestration decisions

## D1: Follow the unattended queue workflow without human questions
- **Question:** How should brainstorming, spec approval and execution gates run without a person?
- **Options:** wait for a person; choose documented defaults and record them.
- **Chose:** Autonomous documented choices, markdown specs, no visual companion or adhd offer; no `orca ask` or human prompts.
- **Why:** This item is an unattended lane iteration; a human prompt would stop the queue.
- **Evidence:** `build/roadmap:docs/loop/LOOP.md`, Answering a skill's questions; user iteration instruction.
- **Reversibility:** easy (decisions remain reviewable).
- **Confidence:** high
- **Revisit if:** a requirement conflicts with a locked decision and cannot be satisfied without changing it.
- **Source:** locked by docs/loop/LOOP.md

## D2: Preserve the locked plugin/API architecture and explicit kind exclusions
- **Question:** What is the parity boundary for this sweep?
- **Options:** replace existing implementations; extend the shipped plugins and public API surfaces.
- **Chose:** Extend existing orchestration and generic Heimdall kernel/control/owner surfaces. Exclude GitLab, Bitbucket, Gitea/Forgejo, Azure DevOps, Objective runner and PR sitter.
- **Why:** The queue item explicitly excludes those flows; roadmap requires built-in plugins, scriptability and defect-free parity.
- **Evidence:** queue wait item m7-sweep-orchestration; docs/roadmap.md:13-55,216-228,259-266.
- **Reversibility:** hard (cross-feature API and user scope).
- **Confidence:** high
- **Revisit if:** an implementation would require changing a locked architecture decision.
- **Source:** locked by docs/roadmap.md

## D3: Use OpenAI task implementers with Gemini as the reachable cross-family reviewer
- **Question:** Which implementation/review pairing is available on this omp lane?
- **Options:** task + opus; task + sonnet; task + gemini; same-family review.
- **Chose:** IMPLEMENTER=task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini (`google/gemini-3.1-pro-preview:high`).
- **Why:** `pi-watch --check` on 2026-10-28 returned opus and sonnet unavailable (no authed/shipping models); Gemini resolved. This preserves cross-family independence rather than pretending the preferred reviewer is available.
- **Evidence:** preflight command `pi-watch --check`, scratch /tmp/quirky-orchestration-lane7.g8Qvwk; codex/terra/gemini/flash available, aggregate exit 5 for unavailable aliases.
- **Reversibility:** easy (review binding, no product contract).
- **Confidence:** high
- **Revisit if:** the bound reviewer fails actual dispatch; follow the documented fallback ladder and record it.
- **Source:** assumed — autonomous

## D4: Preserve inherited user files and isolate all running state
- **Question:** How should existing untracked user files and runtime verification be handled?
- **Options:** stash/commit unknown files; leave unrelated files untouched and use isolated component trees and temporary homes.
- **Chose:** Leave `.serena/`, `test.ts`, `test-migrated.test.ts` untouched and unstaged; stage exact item paths only. Every runtime process uses a fresh temporary `QUIRKY_HOME`, with owned process cleanup.
- **Why:** The inherited files are not this item's work; tests must not touch real state.
- **Evidence:** initial `git status --short --branch`; docs/loop/LOOP.md Hard rules.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** one of those files is explicitly required by the item (none identified).
- **Source:** locked by docs/loop/LOOP.md

## D5: Repair the demonstrated assignment-versus-process projection mismatch
- **Question:** Which bounded parity correction is supported by current code?
- **Options:** infer activity from liveness; hide settled workers; preserve both facts through the existing projection.
- **Chose:** Required boolean `assignmentActive` in Heimdall worker detail/debug, strict owner-service validation, and count only `state === 'live' && assignmentActive === true`.
- **Why:** Orchestration already publishes assignment activity and the Heimdall owner/runner already consume it. The control adapter drops it and fleet.ts counts every live process, including one whose assignment completed. Hiding such workers would lose useful retained-process visibility.
- **Evidence:** plugins/quirky.orchestration/src/services/contracts.ts:12-18; services/coordinator.ts:82-105; plugins/quirky.heimdall/src/control-host.ts:6-18,105-120; fleet.ts:195-215; owner/driver.ts:115-118; orchestration/test/services/api.test.ts:506-548.
- **Reversibility:** medium (public projection contract tightened, no persisted migration).
- **Confidence:** high for the source mismatch; runtime RED/GREEN required before shipping.
- **Revisit if:** actual API evidence shows a distinct documented meaning of running work.
- **Source:** assumed — autonomous

## D6: Resolve design gray areas with explicit evidence instead of new policy
- **Question:** Brainstorming API/data mapping, errors/recovery, visual density, CLI output and integration authority.
- **Options:** add a second projection endpoint or UI inference; extend the existing public fields and selectors.
- **Chose:** Existing fleet/detail/debug/CLI surfaces and layout; strict boolean evidence; retain all worker rows; preserve normal command eligibility and non-consuming reads. No new scheduler, retry, telemetry or process action.
- **Why:** The consumer needs an accurate activity count, not a new lifecycle. Missing evidence is an error, not proof of inactivity. Existing UI already renders zero as “No active work”.
- **Evidence:** logic.md Decisions Locked and SC1–3; plugins/quirky.heimdall/src/ui.tsx:187; control-api.ts workerSchema; control-host.ts show/workers.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the API/UI smoke cannot preserve retained-process inspection.
- **Source:** assumed — autonomous

## D7: Preserve core D9 gate-resolution policy rather than silently amend it
- **Question:** Should resolving a gate recompute ready status from every gate and dependency?
- **Options:** silently change published status; preserve locked source parity and record the policy question for completion.
- **Chose:** Preserve `m6-orchestration-core D9`: resolution readies the Task, and dispatch admission separately checks all dependencies/pending gates. Record the multiple-gate/unmet-dependency status concern, not a proven authority bypass.
- **Why:** The earlier decision and approved spec explicitly define this behavior. The scout withdrew it as a definite defect after reading that lock. No dispatch bypass was established.
- **Evidence:** docs/loop/decisions/m6-orchestration-core.md:91-100; prior logic.md Decisions Locked/AC11; plugins/quirky.orchestration/src/gates.ts:97-116; core.ts:1378-1412.
- **Reversibility:** medium (consumer-visible Task status semantics).
- **Confidence:** high
- **Revisit if:** a source-backed amendment or authorized ruling changes the definition of ready.
- **Source:** locked by docs/loop/decisions/m6-orchestration-core.md

## D8: Inventory larger parity work without duplicating existing queue owners
- **Question:** What should happen to the feature docs' missing federation, leases, remote mirrors, judgment and native lifecycle flows?
- **Options:** call local-only implementations full parity; implement partial/fake transports; retain honest local behavior and register one complete remaining-flow item.
- **Chose:** Before landing add one completion item naming real federation placement/relay/ask/report/stop/release/fleet/navigation, generic Heimdall leases/remote mirrors/shadow judgment and the D9 status-policy question. Reuse existing m6-orchestration-idle-pointer-shutdown and m6-heimdall-host-power for their intact contracts.
- **Why:** The queue sweep explicitly permits recording too-large flows as follow-up items. Earlier M6 non-goals do not make these M7 flows disappear, but current code has no real transport/lease/judgment provider boundary. No fake success or local fallback is acceptable.
- **Evidence:** logic.md Feature flow inventory; orchestration manifest lacks --on; workers/fleet.ts explicit remote capability refusal; Heimdall core D1/D21 and control D4; canonical roadmap queue read confirms existing pointer/power items todo.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** available public remote/lease/credential seams reduce the remaining implementation boundary.
- **Source:** deferred: remaining orchestration and Heimdall parity

## D9: Commit explicit contracts and use one isolated implementation component
- **Question:** Execution decomposition, TDD ordering and schema coherence.
- **Options:** parallelize tiny overlapping source/test edits; one component owning the complete vertical projection repair.
- **Chose:** One external component tree, OpenAI task implementation, cap1. Prepare tests first, parent observes the failing path, then implement the already-reviewed contract and observe passing behavior. Parent owns decisions/specs/docs/queue integration. No worker commits or mid-flight checks; parent runs narrow checks at the returned-work barrier.
- **Why:** Adapter/count/schema changes form one consumer-facing behavior and share test fixtures. Splitting source hubs buys no parallelism. `xd://lsp status` reported no configured language server; grep enumerated production consumers and typed fixture constructors before the required field cutover.
- **Evidence:** tech.md Code references/Contracts/Testing strategy; initial baseline 5520ca5b97550ce102521230c1c3d6520a2bb638; bun1.4.0 available; df reports100GiB available.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the task's exact write scope needs a new non-overlapping flow.
- **Source:** assumed — autonomous

## D10: Reproduce the projection failure before production changes
- **Question:** Does the identified source mismatch produce the wrong observable count?
- **Options:** trust static analysis; run an isolated boundary reproduction before the fix.
- **Chose:** Run throwaway `projection-before.ts` through the actual control-host and fleet modules with a live, explicitly inactive service observation and mutation ports that throw.
- **Why:** The real adapter dropped `assignmentActive`; fleet returned runningWorkers1 for expected0. The assertion failed with `1 !== 0` and exit1. This establishes the local projection defect; it is not evidence of a real daemon/worker path, which remains a separate required acceptance and smoke.
- **Evidence:** /tmp/quirky-orchestration-lane7.g8Qvwk/projection-before.ts:20; tool command output includes input activityfalse, count1 and detail row lacking activity. No production edit preceded the run.
- **Reversibility:** easy (throwaway evidence).
- **Confidence:** high for projection failure; real process/API proof pending.
- **Revisit if:** full-path acceptance cannot keep the worker live after settlement.
- **Source:** assumed — autonomous

## D11: Incorporate both independent specification-review findings before implementation
- **Question:** Are the full-path regression and remaining-flow inventory accurate?
- **Options:** assume pause prevents cleanup; use a public-hook fence before mailbox drain. Treat generic stop predicates as removal/preflight coverage; explicitly inventory missing seams.
- **Chose:** Both reviewer findings accepted as MEDIUM. Use an acknowledged bounded test-kind read fence before `drainMailbox`, held through completion/inspection and released in cleanup; do not alter production pause semantics. Add confirmed-workspace-removal and generic kind submission-preflight to the completion inventory.
- **Why:** Paused runners still drain mail and release settled workers. The current generic kind descriptor has no submission hook, and generic terminal predicates do not prove workspace-removal authority. Source parity requires naming these gaps even with concrete watcher kinds excluded.
- **Evidence:** actual pi-watch Codex review exit0, STATUS:FINDINGS,129.40s; runner.ts:1272-1277 and completion release path; source heimdall.md:101,283; updated logic.md SC1/inventory and tech.md Testing strategy.
- **Reversibility:** easy (test fence and inventory).
- **Confidence:** high
- **Revisit if:** an actual pre-drain fixture fence cannot keep inspection independent of tick completion.
- **Source:** assumed — autonomous

## D12: Land current implementation under the operator's build-first directive
- **Question:** The operator moved all suites, debugging, UI dogfood and review work to the end phase while this implementation was running.
- **Options:** continue the planned verification campaign; collect current implementation, typecheck and land immediately.
- **Chose:** Stop unstarted suites, dogfood, final code review and test-failure fixes. Preserve already-written regression source without running it. Typecheck is the only queue landing gate; no test/review/debug follow-up is added.
- **Why:** The direct operator note and updated LOOP Build first, test at the end supersede the earlier acceptance-execution plan. The spec review and pre-fix reproduction already completed remain historical evidence, not final-code clearance.
- **Evidence:** actual fresh `git show build/roadmap:docs/loop/LOOP.md`; priority message delivered to FleetProjection; agent returned without running any checks or committing.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the canonical typecheck-only land reports a type error or merge conflict.
- **Source:** locked by docs/loop/LOOP.md Build first, test at the end; supersedes D9's current test-gate plan

## D13: Integrate the audited complete projection slice and preserve test execution limits
- **Question:** What source and fixture work was actually returned and integrated?
- **Options:** trust the worker's report; verify HEAD, exact paths and inherited metadata before committing.
- **Chose:** Component HEAD and main HEAD both remained b7cb3637; all ten changed/new files matched the declared Heimdall scope. The component's inherited .serena/project.local.yml retained blob36cd3defd719a2bf479631b0eff650f14447499b. Commit9bc6e3a7 contains adapter/count/schema changes, typed fixture migration and written mixed/malformed/actual-worker regressions. Parent merged it and removed the owned component worktree.
- **Why:** Assignment activity is preserved without hiding worker rows or changing process controls. Parent inherited files remain unstaged. New actual-worker fixture/acceptance source is not a passing runtime claim.
- **Evidence:** authoritative returned-work HEAD/scope/hash audit; commit9bc6e3a7; test/fleet-worker-acceptance.test.ts and test/fleet-worker-fixture.ts. Agent's concern about owner-workers.test.ts is not a demonstrated failure: that file exercises unchanged owner/workers.ts, not the tightened control-host adapter.
- **Reversibility:** medium
- **Confidence:** high for integrated source attribution; tests and real-worker/UI execution unverified.
- **Revisit if:** end-phase execution reports a concrete defect.
- **Source:** assumed — autonomous

## D14: Preserve incoming decisions and exact observed landing evidence
- **Question:** Does the current integration source typecheck, and what behavior evidence is actually available?
- **Options:** extrapolate full parity from source; retain only observed results and pending end-phase execution.
- **Chose:** One conflict-free roadmap catchup. Read all incoming m3-accounts-remaining-flows D1–D20, m7-sweep-editor-source-control D1–D18 and sb-mobile-app D1–D29 plus trailing Progress/evidence; no conflict with this local projection repair. `bun run typecheck` passed, including mobile, in26.84s after frozen install512packages.
- **Why:** No authority, session identity, native/platform or cross-owner policy changed here. A minimal module-boundary smoke returned runningWorkers0 and preserved the same live worker with assignmentActivefalse, exit0; this is not a suite, actual-worker daemon proof or UI pass. No acceptance test, affected suite, UI dogfood or final code review was run.
- **Evidence:** root/mobile typecheck bg2 exit0; standalone projection-before.ts output after cutover; new regression source remains unexecuted. The pre-fix run in D10 returned1 and failed its0 assertion.
- **Reversibility:** easy
- **Confidence:** high for these exact observations only.
- **Revisit if:** canonical merged typecheck or end-phase execution contradicts them.
- **Source:** assumed — autonomous

## D15: Register only one follow-up for genuinely unbuilt product flows
- **Question:** Which work may remain queued under the new follow-up restriction?
- **Options:** create verification/policy items; one item containing only absent feature flows.
- **Chose:** Added `m7-orchestration-heimdall-unbuilt-flows` depending on this item. It names real federation/remote navigation, generic Heimdall leases/remote mirrors/shadow judgment, confirmed-workspace-removal termination and generic submission preflight. Preserve D9 gate policy; no gate-policy, test, review, debugging or dogfood follow-up. Reuse existing pointer-shutdown and host-power items.
- **Why:** Canonical queue add exited0 and a direct authoritative queue read confirmed the single new todo item. These are absent product capabilities, not failed or unfinished verification of built code.
- **Evidence:** /tmp/quirky-orchestration-lane7.g8Qvwk/followup.json; canonical queue add and authoritative queue JSON; logic.md Feature flow inventory.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a completion prerequisite is implemented or an authorized scope ruling changes.
- **Source:** deferred: unbuilt orchestration and Heimdall flows; supersedes D8's gate-policy follow-up proposal

## Progress
Operator build-first override applied. Projection source and written regressions are integrated; the one roadmap catchup is conflict-free and all three incoming decision logs were read. Root/mobile typecheck passed26.84s. One unbuilt-flow item is registered; existing pointer/power items are not duplicated. No suites, actual-worker acceptance, UI dogfood or final code review were executed. All agents/jobs returned and component worktree removed. Commit metadata, detach and invoke canonical typecheck-only queue land now; then preserve notes/evidence, remove owned scratch and end this single-item iteration.
