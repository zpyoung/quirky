# Queue and interval loop presets

## Purpose and scope
Extend the existing daemon-owned `quirky.loops` built-in and `quirky loop` CLI with Queue and On an interval. A queue sends one durable task per successful iteration; an interval repeats one prompt without overlapping or catching up missed ticks. Both continue after CLI exit. Scope includes creation/edit validation, queue mutations and claim/retry lifecycle, repeat/exhaustion, pacing, skipped ticks and ask-before-next. Until-done completion/safety/session execution remains m5-loops-core's implementation. Setup/rail/sidebar/mobile UI belongs to the queued loops UI item; no UI or native scenario is added here.

## Conceptual model and data flow
A queue item has a stable identity, dense zero-based position, nonblank body and pending/in-flight/done state. The driver chooses a task only between iterations, claims it atomically with attempt creation, sends the claimed body, and marks it done only on settled completion. Crash/restart retry retains its claim and body. Queue operations and claims share durable transaction boundaries. Configuration and snapshot state stay authoritative in the plugin store, not a CLI process.

Interval loops use the existing repeat prompt and a positive whole number of minutes. First iteration starts immediately. From-end schedules the next eligible iteration at the last settled iteration end plus the interval. Wall-clock uses creation time as the epoch and the first tick strictly after the completed iteration; ticks during an iteration are skipped and counted, never queued for catch-up. A delayed driver starts at most one due iteration. Pausing never accumulates an execution backlog.

## Key decisions & rationale
Recommended: extend the existing plugin/types/store/decision function; reject a second scheduler/plugin (duplicates ownership and breaks lifecycle safety) and CLI sleeps (client lifetime would govern execution). Preserve documented decision precedence: existing verified completion and safety/caps/no-progress/reset rules, then queue selection/exhaustion, ask-before-next, pacing, user/agent-idle gates, then atomic claim/send. Queue exhaustion without any done condition completes; with an unmet check/evaluator it pauses queue-exhausted. A passing independent done condition may complete early, as in the original.

## Decisions locked
- API/CLI/Data/Integration gray areas all considered: reuse authenticated public method/error envelopes, snapshot JSON and existing text output; add `quirky.loops/queue` and `loop queue <id> add|edit|move|remove`. `id` targets an item, positions are absolute zero-based final positions. Invalid indices, blank bodies and preset/flag contradictions fail invalid-params; missing item/loop fails not-found; in-flight mutation and ended-loop changes fail conflict. No silent clamping or implicit item matching by body.
- CLI flags: `--preset queue` requires repeatable `--queue-item`, rejects prompt/every/anchor; `--preset interval` requires prompt and `--every`, rejects queue flags; `--every` and `--anchor` require interval. Queue/interval default continue; explicit fresh remains valid. Until-done defaults unchanged. `--repeat-queue=false`/`--ask-before-next=false` are real edits. Repeat/interval/name/session edits change subsequent iterations only.
- Queue: add may append or insert; edit/move/remove apply even to done items but never an in-flight item. Moving another item across an in-flight item may change its dense position without mutating its identity/body/claim. Empty queues are allowed after creation. Repeat resets done items to pending atomically when the next cycle is claimed; empty repeat queue still exhausts. Concurrent claim/mutation cannot send a removed or stale body.
- Ask-before-next: first iteration needs no approval. Each completed iteration pauses before another available task, and explicit resume grants exactly one next iteration. Resume clears old evidence, not queue claims or pacing. Exhaustion wins over approval so no meaningless final approval is requested. No Orca/Quirky ask call is made by this build loop; the shipped loop's pause/resume is its approval surface.
- Pacing: waits are interruptible by edit/pause/stop/resume; nextIterationAt and skippedTicks are durable snapshot fields and CLI-visible. Count skipped wall-clock ticks once per completed attempt, excluding the start tick. Changing pacing applies to the next decision, never overlaps an active turn. Time/caps safety from core remains higher priority.
- Architecture: native structured background sessions and public plugin API only; no PTY, tab creation, foreground/focus changes, private imports, kernel scheduler or new dependency.

## Acceptance scenarios
Every flow is driven through daemon API or actual CLI; pure/store tests add deterministic time and concurrency boundaries.

| ID | Before and action | Expected result/example |
| --- | --- | --- |
| P01 | CLI creates queue A,B with no caps/checks, then client exits | Default continue; A and B delivered in order, both done, completed on exhaustion; no third send. |
| P02 | Invalid queue/interval flags, blank items, zero/fractional minutes, invalid anchor; API invalid config | Reject before running provider/durable active loop; existing until-done remains accepted. |
| P03 | Paused queue A,B,C; add D at1, edit D to E, move C to1, remove B | Snapshot order A,C,E with positions0,1,2 and unchanged identities; resumed prompt order respects edits. Done items remain editable/movable/removable. |
| P04 | A in-flight while queue edit/move/remove and competing insertion occur | Mutating A conflicts with no partial writes; inserting another item is allowed; actual A prompt remains exact claimed body. Bad/missing positions/ids fail deterministically. |
| P05 | Repeat A,B with ask-before-next and cap5 | Sends A,B,A,B,A across explicit resumes; reset happens only at next cycle claim; no duplicate simultaneous claims. Empty repeat queue completes without done signals. |
| P06 | Queue A exhausted with configured check false, then add B and resume | Paused queue-exhausted; B actually delivered after resume. Empty queue with no done signals completes; check/evaluator pass still wins. |
| P07 | Crash or daemon restart during claimed A | Claim retained, A retries same iteration with next attempt; B never skips ahead; settled A becomes done exactly once. Stop/failed attempts never falsely consume A. |
| P08 | Interval from-end1minute, turn ends at t=20s | First immediate; nextIterationAt=80s; no early send; one send at/after80s. Explicit fresh policy honored; otherwise continue. |
| P09 | Wall-clock1minute created0, turn starts0 ends150s | Ticks60s,120s skipped exactly2; nextIterationAt180s; no catch-up burst. At exact tick boundary it is skipped, next tick chosen. Repeated polling/restart does not double-count. |
| P10 | Approval pause after turn; resume with next interval still in future; edit interval/anchor | One approval only, wait to new deadline, then one prompt; no re-pause loop or bypass of busy/user/safety holds. Exhausted queue requests no approval. Stop while waiting ends promptly. |
| P11 | list/show and reload daemon with paused queue and pacing metadata | Durable item ids/order/states, nextIterationAt/skippedTicks and completed count restored; active loops restart paused, no autonomous catch-up. |
| P12 | Safety evidence and new presets interact | Caps/protected paths/blocked markers beat queue advance/approval/pacing; independent completion beats exhausted-with-check pause; ask gate does not consume pending item. |

## Orca defects and non-regressions
The feature doc records unexercised interval/repeat paths rather than a proved defect: P05/P08/P09 provide actual deterministic/API coverage instead of assuming parity. Its observed fresh-session focus jump must not recur: presets reuse background structured sessions and never call window/tab focus APIs (P01/P08). Unknown cost/verification/notification safety remain core behavior, not reimplemented.

## Industry Insights
No external research swarm: authoritative LOOP night-mode inputs are fork-loops.md CLI/queue/store/decideNext sections, roadmap and binding core decisions D1-D12. Native structured execution is locked by architecture.md. Existing public API patterns are reused.

## Deferred ideas
None added; UI and core are separately queued requirements, not deferred portions of this item. Linux/Windows timing/process acceptance is deferred by locked macOS-only platform rule.

## Glossary
Claim: durable exclusive ownership of a queue item by an iteration attempt family. Tick: epoch-aligned scheduled instant, not a queued job. Exhaustion: no in-flight or pending item and no nonempty repeat cycle. Approval: explicit loop resume after ask-before-next, not provider tool authorization.

## Technical decisions and contracts
- Extend `plugins/quirky.loops/src/types.ts` first: QueueItem, QueueOperation; queue prompt source, interval pacing; three presets; create.queueItems as `{body:string}[]`; snapshots.queueItems and skippedTicks; attempts.queueItemId optional/null for repeat; service.queue(loopId,op). Existing callers receive additive fields; no legacy shim or alternate plugin.
- Core's store/service/driver/config/decision/CLI/main/manifest own their existing responsibilities. Queue persistence and claim are added to the store transaction; pure `src/pacing.ts` computes interval deadlines/skips. Driver passes body of the claimed item rather than rereading mutable queue. Core's evidence engine remains unchanged unless types require narrowing.
- Waiting stores the computed deadline once per latest iteration/config epoch. Skips derive from actual iteration start/end boundaries, not polling timestamps. Persist the boundary/accounting marker with the completed attempt so restart is idempotent. From-end uses latest endedAt; wall-clock uses createdAt. No shipped test-only short interval flag.
- Early dependency: merge committed core contracts now; build independent queue/pacing contracts/tests while engine is in flight, merge completed dependency again before integration/final checks, and wait for queue deps ready in this turn before landing. Never change dependency's worktree.
- Implementers use isolated worktrees and disjoint scopes, max3; OpenAI omp tasks implement, Gemini reviews after actual opus/sonnet unavailability preflight. Parent owns docs and types integration. Required affected runner `bun scripts/suite.ts plugins/quirky.loops`, `bun test scripts`, `bun run typecheck`; expand dirs only for actual changed callers. Queue land owns full-suite gate. Actual isolated daemon/CLI smoke, no UI dogfood because no UI added.

## Status & amendments
Status: autonomously accepted after flow-by-flow self-review under authoritative LOOP night mode, one combined spec and no separate tech/spec-review. 2026-10-27: initial design. All gray-area decisions resolved without human questions.
