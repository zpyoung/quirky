# fix-git-annotation-coverage-1029 decisions

## D1: Cover semantic annotations without restoring presentation mirrors
- **Question:** What does the sole authorized Git follow-up change?
- **Options:** restore deleted CSS/wording/pixel assertions; change the production algorithm speculatively; add semantic CodeMirror range and state-transition regression coverage.
- **Chose:** Add actual CodeMirror state/decoration tests in plugins/quirky.git/test/pure/conflict-markers.test.ts. Preserve parser coverage and keep production unchanged unless an exercised failure demonstrates a defect.
- **Why:** The queue item and prior Git repair accept only semantic range/state coverage, including Unicode, CRLF, edits, resolution and line boundaries. No production annotation bug has been established.
- **Evidence:** docs/loop/decisions/fix-test-git-1028.md D11,D19,D20; queue item fix-git-annotation-coverage-1029.
- **Reversibility:** easy (test-only scope)
- **Confidence:** high
- **Revisit if:** actual CodeMirror transactions expose incorrect annotation ranges.
- **Source:** locked by queue item fix-git-annotation-coverage-1029

## D2: Use canonical remote test execution and parent-owned integration
- **Question:** How should this bounded test-only follow-up be researched and verified?
- **Options:** local direct bun tests; canonical suite with a read-only source mapper and parent-owned single-file implementation.
- **Chose:** Read-only scout maps annotation implementation; parent owns the bounded tests and documentation. Every test command uses bun scripts/suite.ts, preserving its temporary homes/process cleanup. Run typecheck and an actual state transaction smoke; no UI redesign or unrelated Git/Hosting repairs.
- **Why:** Existing execution policy reserves canonical suite placement and this item names one test file. A single-file change does not need competing implementation worktrees or new public contracts.
- **Evidence:** docs/loop/decisions/fix-test-git-1028.md D2; scripts/suite.ts:8-19,96-117; docs/loop/LOOP.md Fix items.
- **Reversibility:** easy (verification and execution ownership)
- **Confidence:** high
- **Revisit if:** the targeted runtime requires a native-only surface or a demonstrated production repair.
- **Source:** locked by docs/loop/decisions/fix-test-git-1028.md D2

## D3: Observe actual field ranges through document transitions
- **Question:** Which assertions close the accepted coverage gap without reproducing presentation?
- **Options:** inspect CSS/labels or rendered height; call only the parser; inspect state-provided DecorationSets through the public EditorView.decorations facet.
- **Chose:** Four tests classify only widget versus line anchors using public WidgetType and assert exact zero-length ranges against explicit expected editor line numbers. Cover Unicode/combining/astral marker suffixes, CRLF round-trip and blank diff3 content; prefix and marker-suffix edits; splitting and joining line boundaries; invalidating/restoring just one block; resolving blocks individually and recreating a conflict after complete resolution.
- **Why:** These are consumer-visible boundaries and state transitions, not copied class names, label strings or pixel geometry. The existing extension passed every new case, so no production edit or artificial red/green repair is justified.
- **Evidence:** plugins/quirky.git/test/pure/conflict-markers.test.ts:93-208; canonical single-file gate exit0 in12.13s, no flaky files; actual CodeMirror smoke emits initial line2/widget25, prefix-edited line3/widget32 and resolved anchors[] while CRLF serialization remains true.
- **Reversibility:** easy (four deterministic tests)
- **Confidence:** high for the exercised state contract, not native rendering.
- **Revisit if:** a concrete editor transaction violates range boundaries or requires a mounted view to reproduce.
- **Source:** assumed — autonomous

## D4: Preserve exact verification and cross-family review limits
- **Question:** What has actually run on the committed tests?
- **Options:** claim broad Git/UI acceptance; report only the targeted/source gates and actual state smoke.
- **Chose:** Targeted canonical suite plus the scripts gate; full typecheck; actual in-memory CodeMirror API transactions with no process/home state. The sole catch-up merge reports already up to date. Use Gemini read-only review because opus and sonnet preflight report unavailable; grant only read, never shell/write or protected-profile access.
- **Why:** This item changes only one test file and its decision log. Existing Git/Hosting/native findings remain with their owners. Initial reviewer dispatch exited6 after a read with no required final trailer, so it is not a completed or passing review; retry only that failed review stage.
- **Evidence:** source commit06334695; composed canonical13/13files, no flaky files, then full frozen-install/UI-lint/root/mobile/prepared-desktop typecheck, combined52.75s; first full typecheck29.23s; pi-watch --check reports Gemini google/gemini-3.1-pro-preview:high available and opus0/8, sonnet0/6.
- **Reversibility:** easy (verification/reviewer execution)
- **Confidence:** high for observed checks; review pending.
- **Revisit if:** review or the canonical merge-result gate finds a concrete issue.
- **Source:** locked by docs/loop/LOOP.md verification

The retry completed in161.94s with STATUS: PASS and no actionable findings. It actually read the target test and implementation with read-only capabilities; no shell/write tools were available. This is a bounded source review, not an independent test execution or native rendering certificate. No accepted finding required a fix batch.

## Progress
Ready for canonical land. Source commit06334695 contains four new semantic tests and no production edits. Canonical targeted1/1 and composed targeted+scripts13/13 pass without retries; initial and composed full typecheck pass. Actual CodeMirror state smoke confirms Unicode/CRLF anchors move after prefix edit and disappear after resolution. Sole roadmap catch-up was already up to date. Cross-family read-only review retry completed STATUS: PASS/no actionable findings; initial incomplete dispatch remains disclosed. All worker/review jobs finished. Commit receipts, detach, canonical land and update loop notes. Preserve unrelated .serena directory; do not claim whole Git/UI/native or whole-loop completion.
