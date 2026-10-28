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

## Progress
Scope investigation and self-reviewed single spec complete. Shared public contracts already exist and remain unchanged. Next: commit this preparation, dispatch one isolated implementer for restoration/lifecycle fencing and written regressions; parent runs smoke/typecheck after returned-work barrier, catches up once, records incoming decisions and lands via canonical queue.
