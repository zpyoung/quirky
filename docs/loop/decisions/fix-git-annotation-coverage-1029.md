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

## Progress
Claimed on lane12; branch build/fix-git-annotation-coverage-1029 created from build/roadmap. Read the prior repair decisions and existing parser tests. Read-only annotation mapper running; next implement semantic state/decoration tests, run canonical targeted suite and real state smoke, then catch up once, typecheck and land. Preserve unrelated .serena directory. No test or production change yet.
