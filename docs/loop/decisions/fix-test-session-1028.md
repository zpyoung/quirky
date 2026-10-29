# fix-test-session-1028 decisions

## D1: Repair the assigned session failures without weakening lifecycle boundaries
- **Question:** What constitutes the end-phase fix, given the baseline triage and newer integration changes?
- **Options:** Repin all old expectations; repair substantive regressions and stale fixtures; change public contracts to satisfy fixtures.
- **Chose:** Repair substantive regressions and stale fixtures, deleting incidental wording, inventory, source and default-copy assertions rather than repinning them.
- **Why:** The queue assignment explicitly requires consumer-visible repairs and rejects aliases or cross-plugin bypasses. Provider/account identity, exact worktree incarnation, launch snapshots, history and admission must remain authoritative.
- **Evidence:** docs/loop/reports/m7-test-triage.json, plugins/quirky.session area; authoritative docs/loop/LOOP.md, Fix items.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Current baseline evidence identifies a conflicting locked requirement.
- **Source:** locked by docs/loop/LOOP.md

## D2: Use OpenAI implementers and the reachable Gemini reviewer
- **Question:** Which implementation/review pairing is available on this omp lane?
- **Options:** OpenAI tasks with Opus; OpenAI tasks with Gemini; same-family review.
- **Chose:** OpenAI task implementers and google/gemini-3.1-pro-preview at high reasoning for independent review; Flash is a reachable cross-family fallback.
- **Why:** Fresh pi-watch checks found Opus and Sonnet unavailable; Gemini, Codex, Terra and Flash resolved. No person is available or asked.
- **Evidence:** Iteration 13 pi-watch --check outputs for all six aliases, preserved in loop progress.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Actual reviewer dispatch fails after its retry.
- **Source:** assumed — autonomous

## D3: Leave inherited metadata untouched and test only private state
- **Question:** How should the inherited untracked .serena directory and process isolation be handled?
- **Options:** Stash or delete unrelated metadata; preserve it outside every staged scope.
- **Chose:** Preserve inherited metadata untouched, use isolated component trees if implementation can split, and retain fresh temporary homes and exact process cleanup in tests and smoke runs.
- **Why:** The inherited metadata is not this item's work. End-phase tests must not touch real Quirky or provider state.
- **Evidence:** Initial git status showed only untracked .serena/; docs/loop/LOOP.md Hard rules.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Attribution detects another writer touching an owned source path.
- **Source:** locked by docs/loop/LOOP.md

## Progress
Claimed exactly one item on build/fix-test-session-1028. Full session baseline suite and read-only source/decision mapping are running. No production edits. Next: use their evidence to partition and repair, then run affected suite, actual runtime smoke, typecheck and bounded final independent review before canonical queue landing.
