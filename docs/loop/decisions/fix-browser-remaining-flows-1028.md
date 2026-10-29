# fix-browser-remaining-flows-1028 decisions

## D1: Consume the landed Browser owner before choosing another repair
- **Question:** Does the remaining SC5 drag failure still require a new source change after its dependency landed?
- **Options:** Duplicate the previous helper repair; consume the landed owner and inspect current coverage; weaken drag assertions.
- **Chose:** Start from current build/roadmap, inspect the landed m7-sweep-browser-mobile repair, then exercise the actual managed-page boundary through the canonical suite. Change source only for a remaining demonstrated defect.
- **Why:** The original failure is accepted evidence, not something to reconfirm unchanged. The required dependency now records a coherent Browser gate with no flakes and removal of the stale public open-drag warning. A redundant source variant would violate ownership and could regress page scoping.
- **Evidence:** fix-test-browser-1028 D7,D11; m7-sweep-browser-mobile D13,D31,D32; queue assignment fix-browser-remaining-flows-1028; branch created from build/roadmap.
- **Reversibility:** easy
- **Confidence:** high for ownership and prior failure; current independent result pending
- **Revisit if:** Actual current managed drag or a related safety assertion fails.
- **Source:** locked by queue item and docs/loop/LOOP.md

## D2: Preserve canonical checks and managed-browser safety boundaries
- **Question:** Which verification and safety requirements govern this unattended fix?
- **Options:** Run local direct tests or extend deadlines; canonical suite with existing assertions, private homes and exact page identity.
- **Chose:** Run every affected check through bun scripts/suite.ts, never direct bun test. Retain actual drag delivery, page scoping, GET-versus-OPTIONS observations, cookie safety and existing deadlines. All owned processes use temporary homes and are awaited/cleaned. No human asks, native-window inference, new authority or unrelated source edits.
- **Why:** These requirements are explicit in the assignment and the locked macOS/end-phase policy. The existing reported red is sufficient failing-before evidence; current repair consumption must receive fresh passing-after proof.
- **Evidence:** queue title; docs/loop/LOOP.md end-phase and steps6–7; fix-test-browser-1028 D11; m7-sweep-browser-mobile D7,D13.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A current error identifies a genuinely missing prerequisite rather than an interaction defect.
- **Source:** locked by queue item and docs/loop/LOOP.md

## D3: The dependency already closes the native drag flow; do not manufacture a second fix
- **Question:** Which concrete repair remains after consuming the landed owner?
- **Options:** Add another drag implementation or duplicate test; preserve the landed fix and establish focused current consumer evidence.
- **Chose:** Preserve source and permanent tests unchanged. Consume 5943a407b0d101c5960fe904918596d48fdbf928 (helper source/target selectors) and 3b3cd42f8624268cf845d925a139ea04d9d1b9cb (visible download-link fixture) through the item branch's build/roadmap base. No implementation worker is dispatched for nonexistent remaining code.
- **Why:** Exact Git patch history establishes the failed from/to helper dialect changed to source/target. The complete current Browser gate passes, including the existing real drop-payload assertion and subsequent download/history/capture operations. An additional implementation or source-text/wiring test would add dead weight, not consumer coverage.
- **Evidence:** plugins/quirky.browser/src/runtime/extras-actions.ts:315-319; plugins/quirky.browser/test/extras-automation.test.ts:118-168; exact git show of both owner commits; TraceBrowserDrag read-only report; canonical Browser/scripts gate exit0, 30 remote and7 macOS files, flaky[],67.90seconds.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The existing actual drop result or fresh API/CLI smoke fails on the composed tree.
- **Source:** assumed — autonomous; locked by queue ownership requirement

## D4: Use the reachable cross-family reviewer without filesystem tools
- **Question:** Which review pairing is reachable and safe for this evidence-only closure?
- **Options:** Unavailable Opus; reachable Gemini with unrestricted tools; reachable Gemini on a frozen bounded artifact with no tools.
- **Chose:** OpenAI author/omp coordinator, Google Gemini high reviewer, fresh promote/refute contexts with no tools. Review the consumed drag contract and consumer evidence, not author rationale or decision logs. No new feature/spec/contracts are authored for this fix item.
- **Why:** Actual pi-watch --check returns7/12ready; Opus/Sonnet unavailable, Gemini google/gemini-3.1-pro-preview:high available. Prior landed owner decisions establish that prompts alone did not prevent reviewer filesystem writes/author-rationale reads. No-tools review preserves structural independence with an explicit static-scope limit.
- **Evidence:** Current scratch probe exit5 in1.23seconds; m7-sweep-browser-mobile D19,D25,D33; docs/loop/LOOP.md fix-items and model fallback.
- **Reversibility:** easy
- **Confidence:** high for observed availability; review result pending
- **Revisit if:** The attempted dispatch fails or an actual finding requires additional context.
- **Source:** assumed — autonomous

## D5: Prove actual public API and executable CLI drop delivery without changing permanent coverage
- **Question:** Does the green package gate also establish real current interaction rather than helper acknowledgement alone?
- **Options:** Infer delivery from acknowledgement; replace Chrome with a mock; run a separate owned two-page producer/consumer smoke through the canonical runner.
- **Chose:** A throwaway standalone smoke launches the real daemon, Chrome and pinned helper with the existing private-home harness. Public API drag targets page A while B was selected; the actual CLI executable then targets B while A was selected. Both pages receive exactly one trusted drop with the expected payload, and the neighbor remains unchanged. Retain and inspect the managed-page screenshot, then remove the smoke after preserving evidence.
- **Why:** This exercises runtime selection plus native delivery and the real CLI connection/parser, independently of the permanent SC5 scenario. No source, assertions, deadline or authority is weakened.
- **Evidence:** bun /Users/zpyoung/orca/workspaces/quirky/build-lane-11/scripts/suite.ts ./managed-drag-smoke.test.ts from private /tmp/quirky-browser-l11.WkWvlX: exit0 in3.57seconds,1pass0fail8assertions. ActualCLI/API true; trusted payload owned-page-payload; neighbor unchanged;2owned helper/Chrome launches; privateHomeRemoved:true. Personally inspected managed-drag-result.png showing the received payload.
- **Reversibility:** easy
- **Confidence:** high for exact exercised managed-Chrome/API/CLI paths
- **Revisit if:** A composed source change alters target selection or actual delivery.
- **Source:** assumed — autonomous

## Progress
Current Browser/scripts gate passes all37files with no retries. Actual API+CLI two-page trusted-drop smoke passes with private home removed; screenshot inspected. Dependency commits already fix the entire named flow, so no production/test-source changes or implementation worker are necessary. Next: commit this evidence, catch up with build/roadmap, run full typecheck, perform one bounded cross-family review and canonical land. Scratch /tmp/quirky-browser-l11.WkWvlX; every check and scout has returned.
