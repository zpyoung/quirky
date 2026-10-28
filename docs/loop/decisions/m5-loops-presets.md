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

## Progress
Claimed exactly m5-loops-presets; parent checkpoint625ca116. Merged committed core95383d97 contracts; core code still in-flight on lane2 and must not be copied from worker trees. Combined spec/types committed1915c799. Independent pacing module verified10pass/0fail/11assertions and merged625ca116; own component removed after inherited metadata preservation. Runtime worker implements pure queue policy in isolated component after D8 replan; core-dependent runtime/surface integration remains pending audited source. Native executable daemon/CLI smoke prepared but UNRUN in scratch. Then own gates, dependency readiness, one roadmap catchup/read incoming decisions, review/land. No second item; no whole-queue completion claim.
