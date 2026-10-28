# m6-orchestration-idle-pointer-shutdown decisions

## D1: Restore exactly the deferred automatic hint flow
- **Question:** purpose, consumers, scope and success criteria during brainstorming
- **Options:** explicit pointers only; restore automatic Run/Dispatch hints; redesign all orchestration
- **Chose:** restore automatic scheduling from checkpoint/m6-core-idle-pointer69083459 with intact AC9 and bounded shutdown, retaining all shipped core/services/workers.
- **Why:** queue title and core D41 name this precise deferred flow; existing safe submission is not automatic nudging.
- **Evidence:** canonical wait --lane1 returned this item; m6-orchestration-core D10/D41; orchestration.md:452-473
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a documented runtime contract prevents safe hint delivery
- **Source:** locked by docs/loop/decisions/m6-orchestration-core.md

## D2: Resolve standard gray areas autonomously using build-first rules
- **Question:** brainstorming/SDD approval, formats and research workflow
- **Options:** human gates and research/review campaign; autonomous source-backed defaults
- **Chose:** API/Data/Integration classification; resolve identity, errors/recovery, idempotency, output, waiter precedence, lifecycle and reset races. One markdown spec with final technical section, self-review, no human ask/research swarm/separate tech.md/review. OpenAI task implementer; reviewer dispatch/probes skipped because reviews are deferred.
- **Why:** nobody watches; current authoritative LOOP overrides generic skill ceremony. Feature doc/roadmap/prior decisions establish all six essential scope questions.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md Build first, test at the end; logic.md
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** end phase starts or loop workflow changes
- **Source:** locked by docs/loop/LOOP.md

## D3: Fence scheduler lifetime rather than wait indefinitely for external work
- **Question:** root-cause investigation and architecture alternatives
- **Options:** unconditional external join; timeout hiding live continuations; local cancellation/fencing with durable attempted operations
- **Chose:** terminal disposal and reset-generation fences at async boundaries, timers/listeners stopped synchronously, local waits released without waiting on external RPC promises. Already admitted session operations keep original durable IDs; late results cannot touch closed orchestration stores or start another effect.
- **Why:** checkpoint OrchestrationPointers.dispose unconditionally awaits every work/startup promise, which includes external identity/status/pointer calls without deadline/cancellation. Exact historical stuck RPC is unknown; recorded >25s teardown is ground truth, not rerun to reconfirm. A bare timeout would leave unsafe continuations.
- **Evidence:** checkpoint pointers.ts dispose/processMailbox/submitOperation/scanStartup; daemon.ts:254-264; host.ts:690-723; runtime.ts:327-331
- **Reversibility:** medium
- **Confidence:** high for lifetime dependency; medium for historical hang cause
- **Revisit if:** actual smoke shows a remaining teardown dependency
- **Source:** assumed — autonomous

## D4: Keep existing identity, waiter and consumption authority
- **Question:** API mapping, output and conflict precedence
- **Options:** raw PTY writes/new ledger; restore existing candidate and exact-session pointer seams
- **Chose:** existing public contracts/schema, command-only check --run R for both Run and Dispatch hints; no read/ack mutation; exact runtime incarnation, live idle/quiescence, one flight, waiter/delivery reservations and original operation IDs for recovery.
- **Why:** durable mail authority is independent of best-effort hints. Run-qualified Dispatch commands preserve the exact checkpoint AC9 expectation without reducing safety assertions.
- **Evidence:** orchestration.md:452-473; core D4/D7/D10; checkpoint AC9 scheduler hints case; src/runtime-contracts.ts and messaging.ts:802-828
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** generated CLI rejects the existing Run-qualified worker check
- **Source:** locked by research/orca-features/orchestration.md

## D5: One isolated implementation component with already committed public contracts
- **Question:** execution decomposition, shared contracts and inherited files
- **Options:** split tightly coupled scheduler/wiring/tests; one owner for the vertical restoration
- **Chose:** one OpenAI task component for pointers.ts, service.ts, acceptance-api.test.ts and focused lifecycle tests; parent owns spec/decisions/docs/smoke/queue. No new shared public signatures; committed existing contracts are reused. Leave inherited .serena/ untouched. No mid-flight checks or worker commits.
- **Why:** all changes implement one lifetime boundary, so splitting creates overlap without useful independent work. LSP status reported no configured servers; source inspection confirms existing callbacks/schema.
- **Evidence:** xd://lsp status; src/runs.ts:111-130; src/runtime-contracts.ts; src/store.ts pointer_operations; initial git status
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** implementation needs a new public contract
- **Source:** assumed — autonomous

## D6: Isolate macOS runtime proof and preserve platform limits
- **Question:** verification and platform scope
- **Options:** real-user state/cross-platform claim; private homes and macOS proof only
- **Chose:** tests written, not run; typecheck landing gate and narrow throwaway behavioral smoke using fresh temporary QUIRKY_HOME/HOME/provider homes, owned process cleanup. No suites, reviews, UI dogfood or native window sessions. Linux/Windows timers, pointer transport and shutdown need separate verification.
- **Why:** platform and state-isolation locks apply. Smoke proves exercised behavior, never full acceptance parity.
- **Evidence:** LOOP Platforms/Hard rules/Build first; logic.md technical contracts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** another platform is authorized
- **Source:** deferred: platform

## D7: Repair proven fixture response truncation rather than weakening AC9
- **Question:** Why did the first restored daemon smoke stall before the pointer assertion?
- **Options:** skip live status proof; increase timeouts; preserve every output byte across fake-host socket backpressure.
- **Chose:** Queue framed output per fake PTY connection and drain partial writes in order across replies/errors/data/events; add an actual transport-burst regression. Keep intact AC9 assertions/timeouts. Retain the separate scheduler disposal fence.
- **Why:** Narrow instrumented smoke established status explanation awaiting snapshot, with earlier list response id16 of5194bytes accepted only2917bytes. The fixture discarded2277bytes, then emitted snapshot id17 into the incomplete prior frame. Status/scheduler RPCs therefore could not settle. Bounded scheduler disposal did let daemon teardown finish in the instrumented failure run; it does not repair truncated transport or justify weakening acceptance.
- **Evidence:** smoke diagnostics artifact31: `fake write 16 5194 2917`, no received16/17, snapshot reply17; screen sampler read/list completed before unresolved snapshot; after cleanup plugin stop completed. Earlier uninstrumented smokes timed out120s/60s; instrumented RPC deadline failed after8s and cleaned up.
- **Reversibility:** easy
- **Confidence:** high for this demonstrated fixture hang; historical checkpoint's exact bytes were not recorded
- **Revisit if:** corrected fixture still stalls the full command-only hint smoke
- **Source:** assumed — autonomous

## D8: Execute the hint command instead of preserving an incorrect substring pin
- **Question:** The restored AC9 string expectation requested Dispatch `check --run R`, but does the worker actually receive its mail with that command?
- **Options:** change locked mailbox precedence; keep a command that fails; preserve full safety behavior and execute the captured mailbox-correct command.
- **Chose:** Run hints remain Run-qualified; Dispatch hints use unqualified check exactly as checkpoint commandFor and the feature doc specify. Keep the original AC9 target/privacy/unread assertions and20-second timeout; replace its mistaken substring assertion with actual CLI execution and exact message receipt. Original checkpoint remains unchanged for review.
- **Why:** After transport repair, real automatic text/Enter arrived only at the worker and mail stayed unread, but CLI `check --run R` returned exit1 `run_required`. Explicit Run selects coordinator authority by design; changing that would break an existing lock. A passing string assertion would not be a working nudge. This strengthens behavioral acceptance rather than reducing it.
- **Evidence:** actual smoke artifact36; orchestration.md:421,463-467; messaging.ts:1752-1773; checkpoint commandFor only appends --run for Run mailboxes.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** an explicitly authorized public mailbox selector changes
- **Source:** supersedes m6-orchestration-idle-pointer-shutdown D4's Dispatch command choice; locked by research/orca-features/orchestration.md

## D9: Keep exact smoke evidence and defer permanent test execution
- **Question:** What runtime behavior and ownership have actually been demonstrated?
- **Options:** infer a whole-suite pass; record only the exercised boundaries.
- **Chose:** Accepted scoped component0a909d1b after HEAD/path audit, merged it and removed its worktree/branch. Parent reused the existing identity validator, preserved one-shot quiet retry, and removed new mock-forwarding/internal-map test pins. A second task repaired only the fake PTY fixture and wrote its transport regression; it ran no checks or commits.
- **Why:** Real daemon/API/CLI smoke now receives command-only text and separate Enter at the idle Dispatch assignee, keeps its mail unread, executes the captured command with exit0 and exact message receipt, and marks read only on explicit ack. Shutdown during the next Enter gap returned61ms; one already-admitted session operation later rejected on revoked context and logged a handled method error. No lifecycle-timeout or closed-orchestration-store error was observed.
- **Evidence:** smoke artifact38 exit0 in2.34s. Separate SQLite-backed scheduler smoke exercised unresolved identity, status and submission, each with late resolve and reject: all six disposed in<1ms rounded0, zero late store accesses or further RPCs, original attempted phase retained. Root/mobile typecheck passed24.42s initially and22.90s after fixture repair; final post-command-correction merge gate still required.
- **Reversibility:** easy
- **Confidence:** high for exercised smoke paths only; permanent regressions remain unrun
- **Revisit if:** end-phase acceptance/suites find a concrete failure
- **Source:** assumed — autonomous

## D10: Preserve incoming lifecycle decisions and final merged evidence
- **Question:** Does the single roadmap catchup alter authority, shutdown or native constraints?
- **Options:** bypass incoming locks; reconcile all seven incoming logs before landing.
- **Chose:** Conflict-free merge; IncomingIdleDecisions read every entry/Progress in m4-hosting-ui-review-browser-routing D1–D6, m5-automations-dispatch-remote-and-args D1–D4, m5-loops-ui-visible-stop-close-review D1–D9, m6-heimdall-host-power D1–D7, sa-browser-pane-native-host-controls D1–D8, sa-browser-pane-workspace-preview D1–D7 and sb-mobile-app-panels D1–D21. No binding conflict.
- **Why:** Keep hostPower capability valid through plugin deactivation and dispose its native source afterwards; pointer fencing neither reorders that lifecycle nor infers cancellation. Preserve existing public identity, coordinator selector precedence, remote/native prerequisite blocks and mobile scope. Leave historical D4 visible with D8's explicit supersession.
- **Evidence:** final merged root/mobile `bun run typecheck` exit0 in24.65s; merged daemon/API/CLI smoke exit0 in2.39s, including all six SQLite-backed unresolved-dependency cases. Actual stop during text/Enter gap69ms; after700ms observation no delayed Enter, closed-orchestration-store access or deactivation timeout. The already-admitted session call still logs its honest revoked-context rejection rather than false cancellation.
- **Reversibility:** easy
- **Confidence:** high for the observed type/smoke gates; no suite/UI/native pass claimed
- **Revisit if:** canonical merged typecheck or end-phase acceptance reports a concrete defect
- **Source:** locked by docs/loop/LOOP.md

## Progress
Ready for canonical landing. Exact source/test/docs committed in0a909d1b and efda407d, one conflict-free roadmap catchup complete, all seven incoming logs reconciled. Final merged typecheck and standalone daemon/API/CLI/lifetime smoke passed with69ms stop and no delayed Enter. Permanent tests remain written/unrun; no suites, review or UI dogfood ran. All agents/jobs completed, component tree removed. Commit this record, detach, run the absolute canonical queue.ts land m6-orchestration-idle-pointer-shutdown, record its actual result in ignored notes, remove owned scratch and end this one-item turn.
