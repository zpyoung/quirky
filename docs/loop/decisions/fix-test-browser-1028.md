# fix-test-browser-1028 decisions

## D1: Repair the recorded browser failures without changing public contracts
- **Question:** What is the scope of this unattended fix item?
- **Options:** Repair the recorded browser flows; widen into other plugins; suppress failed tests.
- **Chose:** Trace and repair all six recorded browser test files, preserving behavioral assertions and private process homes.
- **Why:** The canonical queue assigns these failures to lane 5; other areas have independent repair owners.
- **Evidence:** docs/loop/reports/m7-test-triage.json, groups.plugins/quirky.browser; queue item fix-test-browser-1028.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Evidence identifies a shared prerequisite owned by another repair.
- **Source:** locked by docs/loop/LOOP.md

## D2: Use omp implementers and the reachable Gemini reviewer
- **Question:** Which backend pairing can execute this end-phase repair?
- **Options:** omp with Opus review; omp with Gemini review; same-family fallback.
- **Chose:** omp OpenAI task implementers with Gemini review, one final round and one fix batch.
- **Why:** pi-watch --check resolves Gemini but reports Opus and Sonnet unavailable; no human decisions are permitted. Preserve inherited untracked .serena/ without touching it; isolate implementers outside this worktree.
- **Evidence:** This iteration's pi-watch --check output: 7/12 aliases ready, gemini google/gemini-3.1-pro-preview.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The selected reviewer cannot complete its attempted review.
- **Source:** assumed — autonomous

## Progress
Investigation: authoritative LOOP and triage read; BrowserFailureMap scout maps root causes. No tests have been rerun to reconfirm reported failures. Next: bounded repair wave, actual changed-path proof, affected suite/scripts/typecheck, catch up once, final review, and canonical queue land.
