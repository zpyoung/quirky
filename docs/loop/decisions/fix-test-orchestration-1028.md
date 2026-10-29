# fix-test-orchestration-1028 decisions

## D1: Repair observed end-phase failures without weakening authority
- **Question:** Which workflow and contracts govern the claimed failure item?
- **Options:** build-first feature shortcut; end-phase diagnosis and verification.
- **Chose:** End-phase systematic diagnosis, existing behavioral regressions, canonical affected suite and required gates. No brainstorming/spec for a fix item. Separate federation transport/placement from local Ask/migration and preflight authorization.
- **Why:** m7-test-triage has landed and this item names its orchestration failures. The historical raw artifact is unavailable in this session; its committed grouped evidence remains authoritative. A canonical current run collects missing assertion details, not a claim that the reported failures were uncertain.
- **Evidence:** docs/loop/reports/m7-test-triage.json groups.plugins/quirky.orchestration; docs/loop/LOOP.md End phase/Fix items.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a failure crosses another repair owner's boundary.
- **Source:** locked by docs/loop/LOOP.md

## D2: Keep exact remote identity, settlement and private-home invariants
- **Question:** May failures be repaired by relaxed selectors, method ceilings, caller authority or local fallback?
- **Options:** compatibility aliases and relaxed fences; trace producers and fix their actual contracts.
- **Chose:** No aliases, local fallback, spoofed evidence or changed authority. Preserve exact host placement, durable FIFO, committed home verdict before host settlement, archive-before-release, authenticated owner-namespaced callbacks and unknown-is-not-exited. Preserve isolated process homes/cleanup and leave other lane's structured/main.ts wait bridge untouched.
- **Why:** Earlier federation/Heimdall/core decisions bind this repair. No language servers are configured; use scoped source mapping.
- **Evidence:** m7-orchestration-worker-federation D2-D5,D10-D11; m7-orchestration-heimdall-unbuilt-flows; actual xd://lsp status.
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** evidence conflicts with a locked contract; record rather than silently override.
- **Source:** locked by docs/loop/decisions/m7-orchestration-worker-federation.md

## Progress
Claimed lane 8. Current canonical orchestration run collecting detailed assertion/error evidence. Read-only map complete. Next delegate bounded repair slices after diagnostics; parent owns common fixture/integration and final gates. Preserve unrelated untracked diagnostic files, .quirk and .serena. An accidental suite --help invocation selected all files (the script has no help mode); it timed out after 30 seconds and is not verification evidence. No owned daemon/UI/browser has been started manually.
