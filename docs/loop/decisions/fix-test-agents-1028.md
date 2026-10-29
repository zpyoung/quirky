# fix-test-agents-1028 decisions

## D1: Repair the reported agent failures without weakening behavior
- **Question:** Which behavior controls this unattended fix item?
- **Options:** Re-pin incidental output; repair runtime boundaries and meaningful behavior coverage.
- **Chose:** Repair confirmed causes; delete incidental inventory assertions rather than re-pin them.
- **Why:** The triage names discovery, raw-home safety, CLI inventory, and HTTP(S) link validation failures. Existing behavior and locked decisions remain authoritative.
- **Evidence:** docs/loop/reports/m7-test-triage.json groups.plugins/quirky.agents; docs/loop/LOOP.md Fix items.
- **Reversibility:** easy (bounded agent package repair).
- **Confidence:** high
- **Revisit if:** Diagnosis identifies a conflicting locked contract.
- **Source:** assumed — autonomous

## D2: Use the canonical runner and fallback cross-family review
- **Question:** What execution and review environment is available?
- **Options:** Direct local suite; canonical routed suite. Opus; fallback Gemini.
- **Chose:** Run affected tests through bun scripts/suite.ts; omp task implementers, OpenAI author family, Gemini reviewer after Opus probe failed.
- **Why:** The runner isolates homes and routes remote work. pi-watch --check opus exited 5; --check gemini selected google/gemini-3.1-pro-preview:high. No language servers are configured. Preserve inherited untracked .serena/ without edits.
- **Evidence:** This iteration's actual queue wait and backend/LSP tool results.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The verified backend becomes unavailable.
- **Source:** assumed — autonomous

## Progress
Claimed this item only. Read authoritative loop instructions from build/roadmap. Read-only diagnosis active; no implementation or verification result yet. Next: finish root-cause mapping, implement minimal repairs, run affected suite and smoke, review, catch up once, typecheck and land via canonical absolute queue script.
