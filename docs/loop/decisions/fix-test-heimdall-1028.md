# fix-test-heimdall-1028 decisions

## D1: Repair the triaged Heimdall failures without changing authority boundaries
- **Question:** Which behavior and verification scope does this end-phase repair own?
- **Options:** relax assertions or authority checks; repair the root causes and retain behavioral regressions
- **Chose:** repair root causes across the ten named Heimdall test files; coordinate any cross-plugin cause with its owning repair
- **Why:** The queue item explicitly requires consumer-visible repairs and removal rather than repinning of incidental assertions. Owner/worker identity and lease fencing remain binding.
- **Evidence:** docs/loop/reports/m7-test-triage.json groups[plugins/quirky.heimdall]; docs/loop/queue.json item fix-test-heimdall-1028
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** investigation identifies a necessary change owned by another repair
- **Source:** locked by docs/loop/LOOP.md

## D2: Use recorded baseline failures as the initial failing evidence
- **Question:** Must the reported failures be rerun before investigation?
- **Options:** rerun merely to confirm; accept the supplied triage evidence and verify changed paths after fixes
- **Chose:** treat the supplied baseline failures as ground truth, inspect their current data paths, and run the canonical suite after the repair wave
- **Why:** User-reported observations are authoritative; redundant confirmation is prohibited. New regression behaviors must have concrete before/after evidence where applicable.
- **Evidence:** docs/loop/reports/m7-test-triage.json baseline 97aaa12d9fdf91a966cbc78d5557e113fc9789b3; scripts/suite.ts:8-19,96-117
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the recorded error does not identify the current failing boundary
- **Source:** assumed — autonomous

## Progress
Investigation: branch created from integration, all ten triage entries read, read-only ownership scout active. No production changes or checks yet. Tests run through bun scripts/suite.ts with fresh private homes and cleanup. No human decisions requested.
