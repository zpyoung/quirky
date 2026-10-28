# m5-loops-presets decisions

## D1: Extend core's plugin, not its pending branch
- **Question:** how early dependency affects ownership and interfaces
- **Options:** edit core's in-flight work; add a second scheduler; additive extension on this branch
- **Chose:** merge committed core95383d97 only, retain its source unchanged in its own worktree, extend types here, merge audited implementation when lane2 publishes it. Stable LoopService(context,timing), EvidenceEngine(context), decideNext(input) seams preserved.
- **Why:** early-item rules allow dependent work but do not authorize edits to another lane. Lane2 explicitly acknowledged additive ownership.
- **Evidence:** queue wait m5-loops-presets early/deps; lane2 acknowledgment; core D1-D12; plugins/quirky.loops/src/types.ts
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** dependency blocks or changes public contract
- **Source:** locked by docs/loop/LOOP.md

## D2: Autonomously accept one combined specification
- **Question:** brainstorming domains, approvals, research, alternatives and essential coverage
- **Options:** interactive questions/research; autonomous defaults with feature-doc evidence
- **Chose:** API/CLI/Data/Integration domains; resolve response/errors/auth, flags/output/exit/recovery, order/identity/persistence/idempotency, pacing/approval conflict semantics. No human questions, visual companion, adhd or research swarms; single logic.md with final technical section, self-reviewed P01-P12. Purpose, consumers, scope, behavior, locked constraints and success all explicit.
- **Why:** authoritative night mode and nobody-watching rule override skill interactive/research phases. Existing plugin extension beats CLI sleep or duplicate kernel scheduler.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md Night mode; docs/quirk/specs/2026-10-27-m5-loops-presets/logic.md
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** feature requirements change
- **Source:** locked by docs/loop/LOOP.md

## D3: Queue identity and atomic claim govern mutation
- **Question:** duplicate bodies, positions, in-flight changes, repeat/retry/exhaustion
- **Options:** body matching and best-effort positions; stable ids and strict dense positions
- **Chose:** stable ids, zero-based final positions, add/edit/move/remove public API; reject in-flight target mutation. Claim and attempt start atomic; only settled completion consumes claim; crash/restart reuses item. Nonempty repeat resets at claim; empty always exhausts. With done condition exhaust pauses; without one completes.
- **Why:** exactly matches documented queue behavior and avoids wrong-task/duplicate delivery. Moving another row may shift in-flight position without altering its identity/body.
- **Evidence:** fork-loops.md RPC methods, iteration cycle, stop conditions6, edge cases queue edits; P03-P07
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** public tests reveal mutation/claim race
- **Source:** locked by research/orca-features/fork-loops.md

## D4: Resume approves one iteration; pacing never catches up
- **Question:** approval/pacing ordering and exact tick boundaries
- **Options:** approval before first send; approval after each completed turn; backlog execution
- **Chose:** first iteration immediate. After completed turn and available prompt, ask-before-next pauses; resume clears held evidence and grants one send, preserving schedule. Queue exhaustion wins. From-end uses end+minutes; wall-clock epoch createdAt and first strictly later tick, counts ticks in (start,end] once on attempt settlement. Persist schedule/skips; no polling-dependent accounting or catch-up burst.
- **Why:** documented decideNext7/8, original queue behavior and strict nonoverlap. Exact end tick must be skipped, not replayed as both missed and due.
- **Evidence:** fork-loops.md Stop conditions317-321, loop-iteration-evidence64-82; P08-P12
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** authoritative tick behavior differs
- **Source:** assumed — autonomous

## D5: Keep strict public contracts and preset defaults
- **Question:** CLI flag design, config edits and error surfaces
- **Options:** permissive cross-preset flags; reject contradictions before side effects
- **Chose:** queue/interval default continue; until-done fresh unchanged. Nonblank queue seeds required, minutes positive integers, anchor from-end/wall-clock. Explicit false switches retained. Queue operations use kind discriminant and service.queue(loopId,op). Missing ids not-found, bad input invalid-params, active/ended mutation conflict. Existing auth/output conventions reused.
- **Why:** feature CLI combination checks and API strict validation are part of parity, not conveniences.
- **Evidence:** fork-loops.md CLI create78-102 and edit116; core D5; logic P02
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** UI needs additional additive metadata
- **Source:** locked by research/orca-features/fork-loops.md

## D6: OpenAI implementers and reachable Gemini reviewer
- **Question:** SDD model pairing, file ownership and preflight
- **Options:** unavailable opus/sonnet; reachable cross-family Gemini
- **Chose:** omp OpenAI task implementers; Gemini cross-family final review, high effort. pi-watch --check actual report7/12 ready, opus/sonnet unavailable. No LSP configured. Inherited .serena untouched. Scratch /tmp/quirky-presets-lane5-7uwItkNC; isolated component worktrees. First pure pacing component independent of pending core; runtime and public surface components dispatched only against audited core, disjoint files, max3 total implementers.
- **Why:** source-level seams need actual core, while timing boundary work need not idle. Parent owns types/specs/decisions; workers never commit or run broad gates.
- **Evidence:** actual preflight exit5 report and xd://lsp status; PresetSeams survey
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** reviewer dispatch fails
- **Source:** assumed — autonomous

## D7: Isolated macOS API/CLI proof; no new UI
- **Question:** verification, platform and cleanup
- **Options:** live user homes and untested cross-platform claim; isolated native scripted provider
- **Chose:** every spawned process uses fresh QUIRKY_HOME/HOME/provider homes and owned cleanup. Tests cover P01-P12 through daemon/CLI plus deterministic boundary tests. Required affected runner/scripts/typecheck once; land owns full suite. No UI surface or native scenario added. Linux/Windows timer/runtime acceptance remains unverified.
- **Why:** locked platform and no-real-state rules; no point dogfooding UI this item does not add.
- **Evidence:** LOOP hard rules/night mode; architecture.md structured sessions; core harness test/rig.ts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** platform scope expands
- **Source:** deferred: platform

## D8: Relocate and attribute a misplaced worker test before resuming
- **Question:** runtime worker used a relative file-tool path, writing its new queue test in the parent instead of its component
- **Options:** commit outside-scope write; discard both copies; stop worker and reconcile exact tool payloads
- **Chose:** stop worker, move only the newly authored misplaced test, inspect raw worker transcript and compare both writes. Payloads7865/7864bytes differ only one trailing blank line; component retains the second payload exactly. Parent has no source diff; component HEAD625ca116 unchanged, declared test only. Re-baseline and require absolute component paths before authorizing production code.
- **Why:** a prompt is not isolation. No outside-scope source was committed, and no user changes were discarded. The initial missing-filter command was not a red; subsequent correct component command failed for absent queue module0pass/1fail/1error.
- **Evidence:** worker transcript PresetRuntime writes; /tmp/quirky-presets-lane5-7uwItkNC/queue-attribution.json; parent/component scope audit; actual Bun red output
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** another cross-worktree write occurs
- **Source:** assumed — autonomous

## D9: Merge audited core repairs without treating the dependency as landed
- **Question:** early dependency published source twice while its own required gate was still pending
- **Options:** wait idle until landing; copy live worker trees; merge pinned audited checkpoints and preserve later fixes
- **Chose:** merge audited e0582785, then stable repair f181908e in parent. Read core D13-D21 and notify runtime owner of exact delta: section replacement, finished-only public history, resume handoff, deferred settled/own-prompt races, shutdown cancellation, approval/time/cost safety and terminal non-adoption. Core still must reach queue done before this item lands.
- **Why:** early rules explicitly permit branch-dependent implementation; a source audit is not a green test gate. Read-only newer-schema access, bounded journal paging, central notifications and creating-plugin cleanup remain binding.
- **Evidence:** lane2 priority handoffs; core decisions D13-D21; own merges; native core smoke/typecheck reported by lane2, not substituted for presets verification
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** later dependency fixes change a seam
- **Source:** locked by docs/loop/LOOP.md

## D10: Clarify API defaults and preserve real queue lifecycle in acceptance tests
- **Question:** raw API config defaults/queue pacing and test drafts that assumed empty creation or replayed done rows
- **Options:** weaken runtime to fit drafts; correct tests against feature semantics before implementation
- **Chose:** optional raw sessionPolicy normalizes to preset default, explicit values strict; queue API may explicitly combine interval pacing while CLI every/anchor remain interval-only. Queue creation requires nonempty seeds; empty queue tests remove done rows after creation. Ask-before-next requires one resume per actual pending task, and moving done rows never replays them without repeat reset. Active attempt timing uses snapshot or finished history after stop.
- **Why:** Config shape separates prompt source from pacing; CLI has narrower flag combinations. Original feature requires nonempty seeds and done/in-flight/pending identity. A test is not authority over these invariants.
- **Evidence:** fork-loops.md Config shape, CLI combinations, Queue editor, decideNext; initial parent test review corrections sent to both owners; logic amendments
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** authoritative feature contract differs
- **Source:** locked by research/orca-features/fork-loops.md

## D11: Keep queue writes explicit and skip reads constant-time
- **Question:** stale driver snapshots can overwrite concurrent queue mutations, and summing all attempt keys makes each snapshot grow with loop age
- **Options:** persist full snapshot queue on every phase; explicit queue transaction and scalar skip accounting
- **Chose:** dedicated durable queue JSON row, explicit seed/mutate/claim/settle only; generic phase/config loop writes never overwrite queueItems. Claim plus attempt creation and exact-id settlement plus totals share transactions. Skipped ticks increment a stored scalar once per ended attempt, deduplicated by current attempt state/key, not by polling or summing all history.
- **Why:** driver snapshots cross awaits while API edits remain live. Long-running loops must not turn each get/phase into O(total attempts) work. Queue policy clones only changed arrays/rows and trusts the store's dense order.
- **Evidence:** core LoopStore/writeLoop and LoopDriver async shape; queue.ts policy17pass/43assertions; runtime-owner storage handoff and parent invariant messages
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** an actual concurrent mutation is lost or skip totals double-count
- **Source:** assumed — autonomous

## D12: Repair merge/type errors and give fixture watchdogs coherent outer budgets
- **Question:** first integrated checks found eight compiler diagnostics and multi-turn tests killed by Bun's5second outer guard before their10second condition wait
- **Options:** weaken assertions/production waits; repair exact compile errors and outer fixture configuration
- **Chose:** remove the duplicate waitForFinish method introduced by merging the same core repair twice; retain both decision and pacing imports; preserve core section-replacement semantics and preset scalar-column omission. Restore missing CLI test type imports, type empty-list API results, and supply the newly required unused client transport fixture as a throwing boundary. Normal new integration tests get30second outer budgets; five-turn repeat gets60; intentional real-minute tests retain100/90seconds. No condition/production timeout or behavior assertion changes.
- **Why:** native actual queue delivery passed; the failed API CRUD case passed in isolation4.78seconds/13assertions with a30second outer guard. Initial runtime file16pass/3fail had only five-second watchdog failures, including successful real-minute positive-skip and due-send tests. TypeScript is now clean after these exact repairs.
- **Evidence:** initial compiler artifact69; API/CLI artifact67; runtime16/3 artifact70; isolated API command; subsequent typecheck exit0/38.85seconds. Fixture-only fixer HEAD/scope audit passed; only test closers changed beyond named parent type repairs.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a condition itself times out or fresh required gates find an assertion failure
- **Source:** assumed — autonomous

## D13: Actual native executable smoke proves the shipped preset path
- **Question:** API harness tests alone do not prove native provider execution or executable CLI dispatch
- **Options:** accept scripted in-process runner only; run real source CLI plus real daemon and native protocol subprocess fixture
- **Chose:** run prepared isolated smoke with source daemon/CLI and executable Codex app-server fixture, no provider credentials or real homes. Observed A then C after real queue add/edit/move/remove, single resume, same continued session, completed exhaustion; interval first prompt then future epoch deadline, no early resend, immediate stop. Exactly3native turn/start requests; all children reaped and home removed.
- **Why:** exercises real parser/catalog/RPC/plugin/store/structured-runner/native JSONL transport, not mock forwarding. No UI surface is added, so no UI/native-focus pass is claimed; core's separate native handoff remains intact.
- **Evidence:** /tmp/quirky-presets-lane5-7uwItkNC/native-smoke.json ok:true, three assertion groups, homeRemoved:true; actual command exit0/19.63seconds
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** final affected or landing gate regresses native lifecycle
- **Source:** assumed — autonomous

## Progress
Runtime edaae57f and public surface a82b5a8d audited and merged; component worktrees removed after preserving inherited metadata in named stashes. Core/preset merge resolved preserving both intents, then duplicate method and fixture type issues fixed. Pure decision/queue/pacing55pass/0fail/98assertions. Actual executable native smoke PASSED (D13). TypeScript clean after D12. Corrected three-file API/CLI/runtime test run is currently in progress; final affected runner/scripts and dependency readiness/catchup still pending. Reviewer criteria prepared but no review started or PASS claimed. No second item; no whole-queue completion claim.
