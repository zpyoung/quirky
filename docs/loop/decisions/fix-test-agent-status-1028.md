# fix-test-agent-status-1028 decisions

## D1: Repair the assigned agent-status contracts without widening provider APIs
- **Question:** Which failures and verification belong to this end-phase fix?
- **Options:** Repin failed assertions; trace consumer behavior and repair its root cause; widen adjacent plugin APIs.
- **Chose:** Trace the six assigned failures, repair consumer-visible behavior, and delete incidental assertions rather than repinning them.
- **Why:** The queue names OSC session/turn ownership and the hooks switch lifecycle; tests must retain isolated homes and process cleanup.
- **Evidence:** docs/loop/reports/m7-test-triage.json; assigned queue item title; docs/loop/LOOP.md Fix items.
- **Reversibility:** easy (local repair)
- **Confidence:** high
- **Revisit if:** Evidence identifies an upstream contract owned by another repair.
- **Source:** locked by docs/loop/LOOP.md

## D2: Use native task implementers and a reachable independent reviewer
- **Question:** Which backend pairing can run unattended on this omp lane?
- **Options:** omp task implementers with opus; next reachable cross-family reviewer; task reviewer fallback.
- **Chose:** omp task implementers; probe the reviewer ladder before selecting the final review backend.
- **Why:** `pi-watch --check opus` exited 5: no authed/shipping model among its eight candidates. No human input or authentication changes are permitted.
- **Evidence:** This iteration's opus preflight output.
- **Reversibility:** easy (review backend only)
- **Confidence:** high
- **Revisit if:** Another cross-family backend resolves.
- **Source:** assumed — autonomous

## Progress
Claimed on lane 2 and created build/fix-test-agent-status-1028 from build/roadmap. Read authoritative LOOP.md through git show. Root-cause investigation active; scout tracing the assigned failures and binding decisions. Inherited untracked .quirk/ and .serena/ are retained untouched. No production edits or test executions yet.
