# fix-test-scripts-1028 decisions

## D1: Repair the reported script failures without weakening behavioral coverage
- **Question:** Which failures and gates belong to this fix item?
- **Options:** Re-run the reported failing suite unchanged; trace the retained failures and their source first; broaden to unrelated feature debugging.
- **Chose:** Trace the reported failures first, repair their root causes, then run affected tests and end-phase gates.
- **Why:** The queue records 13 script failures; the reported output is ground truth. Fix items skip brainstorming/specs and retain behavior-focused coverage.
- **Evidence:** Queue item fix-test-scripts-1028; scripts/ui-review/review.test.ts:27-42,83-89,121-166; scripts/ui-review/cli.test.ts:208-222.
- **Reversibility:** easy (bounded script and fixture repairs)
- **Confidence:** high
- **Revisit if:** Source tracing reveals a conflict with a locked requirement.
- **Source:** locked by docs/loop/LOOP.md

## D2: Pass the current process environment explicitly to reviewer subprocesses
- **Question:** Is the missing fake-reviewer marker an application validation failure or a subprocess environment boundary defect?
- **Options:** Embed fixture configuration into generated executables; add a new environment override API; explicitly inherit current process.env.
- **Chose:** Explicit current process.env inheritance in the existing reviewer spawn options.
- **Why:** An isolated Bun 1.4.0 probe mutated environment after startup: implicit Bun.spawn inheritance returned {}, while explicit env returned both the marker and isolated QUIRKY_HOME. Current environment propagation fixes the real boundary without a test-only API.
- **Evidence:** scripts/ui-review/review.ts:440-451; /tmp/quirky-scripts-l12.R4Go9C/env.test.ts observed output in iteration 13.
- **Reversibility:** easy (one spawn option)
- **Confidence:** high
- **Revisit if:** Reviewer isolation policy changes from inherited developer environment to an explicit allowlist.
- **Source:** assumed — autonomous

## D3: Give each generated manifest independent capture files and restore the threshold fixture
- **Question:** How should multiple malformed-manifest cases coexist within a test?
- **Options:** Reuse scratch/captures with recursive mkdir; allocate a new capture directory per manifest.
- **Chose:** Unique temporary capture directory per manifest; correct fake reviewer's boundary mode to score exactly 85; give reviewer tests a fresh QUIRKY_HOME.
- **Why:** Repeated fixtures currently throw EEXIST before exercising validation. Unique files also prevent a later fixture from replacing earlier evidence. The boundary test requires 85, but its fixture currently returns 100.
- **Evidence:** scripts/ui-review/review.test.ts:27-42,83-89,148-166,217-270; docs/quirk/specs/2026-10-28-ui-screenshot-review/logic.md:42-44.
- **Reversibility:** easy (fixture-only)
- **Confidence:** high
- **Revisit if:** Tests move to per-case processes with independent fixture ownership.
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-screenshot-review/logic.md

## D4: Test malformed evidence rejection rather than an exception-only artifact
- **Question:** Must a handled validation failure create ui-review-error.json?
- **Options:** Force validation errors into the exception path; replace the stale artifact assertion with externally meaningful exit/report assertions.
- **Chose:** Replace the obsolete test, retaining exit 2, error status and no accepted review evidence coverage.
- **Why:** reviewManifest returns validation errors as ReviewReport; the CLI persists that report. ui-review-error.json belongs to thrown runtime exceptions. The locked spec requires rejection and preserved evidence, not an exception artifact.
- **Evidence:** scripts/ui-review.ts:294-318,341-360; scripts/ui-review/review.ts:626-631; docs/quirk/specs/2026-10-28-ui-screenshot-review/logic.md:30-32,43,85-87.
- **Reversibility:** easy (test-only)
- **Confidence:** high
- **Revisit if:** The CLI publishes a different error artifact contract.
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-screenshot-review/logic.md

## D5: Use the available Google reviewer after Opus preflight failed
- **Question:** Which independent reviewer is reachable for this bounded repair?
- **Options:** Opus; Gemini; same-family task fallback.
- **Chose:** Gemini, after pi-watch --check opus exited 5 and pi-watch --check gemini resolved google/gemini-3.1-pro-preview:high.
- **Why:** Retains cross-family review without changing authentication or asking a person.
- **Evidence:** Iteration 13 preflight commands run in /tmp/quirky-scripts-l12.R4Go9C.
- **Reversibility:** easy (reviewer selection only)
- **Confidence:** high
- **Revisit if:** The selected reviewer dispatch fails.
- **Source:** assumed — autonomous

## Progress
Repairs implemented. `bun test scripts`: 126 pass, 0 fail, 1039 assertions across 12 files (91.78s). Nested suite-runner fixtures deliberately print failing child-suite output; the enclosing suite passed. `bun run typecheck` exited 0. Actual `bun scripts/ui-review.ts --author-family openai --manifest <isolated malformed.json> --output <fresh output>` exited 2, persisted an error review report with zero captures and its diagnostic, and printed errorReport:null. No UI/product feature surface changed; no native scenario applies. Usage spec now documents handled validation reports versus thrown runtime errors and current-environment inheritance. Next: commit, merge roadmap once, inspect incoming binding decisions, bounded independent review, rerun affected gates after any merge/fix, then authoritative queue land. User-owned untracked .serena/ remains untouched.
