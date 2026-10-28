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

## D6: Preserve incoming editor/native owners and keep duplicate failure evidence historical
- **Question:** Does roadmap catch-up change this script repair's scope?
- **Options:** Reopen editor/Vault native work; rewrite historical blocker entries; retain scoped repair and their independent acceptance boundaries.
- **Chose:** Read both incoming decision logs in full and retain their owners. No decision conflicts with reviewer environment propagation or malformed-evidence reporting. Historical 13-failure records remain unchanged; this item records their repaired verification.
- **Why:** fix-native-m2-editor-1028 owns Explorer path exports and native retest; fix-native-m3-vault-1028 owns clipboard reachability and native retest. Both independently observed the same UI-review fixture failures. Neither requires changing application clipboard/native state here.
- **Evidence:** Single clean git merge build/roadmap after source commit 974ed9ff; docs/loop/decisions/fix-native-m2-editor-1028.md D1–D7; docs/loop/decisions/fix-native-m3-vault-1028.md D1–D7.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** An end-phase test identifies a different defect in this repair's exact subprocess/evidence boundary.
- **Source:** locked by incoming decision logs

## D7: Adjudicate the bounded independent review against runtime and source evidence
- **Question:** Which Gemini findings require a fix?
- **Options:** Apply every suggested change; dismiss every finding because tests pass; accept evidenced gaps and reject contradicted claims.
- **Chose:** One bounded fix batch: retain every timeout child PID and assert each is terminated; create the CLI fixture's isolated home/config directories. Reject the claimed process.env Proxy failure and claimed eager-deletion leak.
- **Why:** The actual runtime probe proves direct env:process.env forwarding works, and both full suite runs exercised dynamic modes successfully. Receipt deletion occurs only after cleanup assertions succeed, so failed cleanup retains fallback ownership. However two theme dispatches overwrite the old single-PID receipt; tracking all PIDs improves failure cleanup and detects any first-child leak rather than certifying only the last child.
- **Evidence:** google/gemini-3.1-pro-preview:high read-only review completed in278.64s; scripts/ui-review/review.ts:656-689; scripts/ui-review/review.test.ts timeout receipt/afterEach; scripts/ui-review/cli.test.ts isolated directory setup; observed probe D2 and green script-suite receipts.
- **Reversibility:** easy (test fixtures only)
- **Confidence:** high
- **Revisit if:** A supported Bun version contradicts the observed environment propagation or an owned child remains alive.
- **Source:** assumed — autonomous

| Finding | Effective severity | Ruling | Evidence |
| --- | --- | --- | --- |
| C1: direct process.env loses dynamic values | High | Rejected | Direct runtime probe forwarded both values; production-backed mode tests pass. |
| C2: deleting a successful cleanup receipt leaks its child | Medium | Rejected | Deletion follows successful no-live-child assertions; failure retains the receipt. |
| C3: last-PID overwrite hides the first timeout child | Medium | Accepted, fixed | Append PID receipts; fallback handles all; assertions verify both theme children. No production leak is claimed. |
| C4: isolated home/config directories are absent | Low | Accepted, fixed | Create all three isolated directories before invoking the CLI path. |

## D8: Keep platform and visual verification claims bounded
- **Question:** Does portable environment forwarding or headless process verification certify other operating systems or UI styling?
- **Options:** Infer cross-platform/native/visual approval; retain only observed macOS command and subprocess evidence.
- **Chose:** macOS/Bun1.4.0 verification only. Linux/Windows runtime propagation and process-tree teardown need platform runs; no visual or native window approval is asserted.
- **Why:** This item changes developer script subprocess behavior and isolated tests, not application UI. Windows process groups differ from macOS and were not exercised.
- **Evidence:** Executed script suite, typecheck, runtime probe and actual CLI smoke; scripts/ui-review/review.ts sendOwnedSignal/terminateOwnedProcess.
- **Reversibility:** easy
- **Confidence:** high for the verification boundary
- **Revisit if:** Linux/Windows support is scheduled.
- **Source:** deferred: platform

## Progress
Completed implementation, one clean roadmap catch-up and one independent Gemini review plus bounded fixture fix batch. Final `bun test scripts && bun run typecheck` exited 0: 126 pass, 0 fail, 1103 assertions across 12 files (109.16s tests;152.78s combined). Nested suite-runner fixtures deliberately print failing child-suite output; the enclosing suite passed. Both timeout theme children were checked terminated. Earlier actual isolated CLI smoke exited 2 with an error review report, zero captures and retained validation diagnostic; no reviewer or application was launched. Usage spec documents error-report semantics and explicit current-environment inheritance. No application/native surface changed. All owned agents and jobs returned; no accepted review finding remains open. Next: commit receipt and fixture improvements, detach, authoritative queue land, await integration typecheck, remove owned scratch directory and end this one-item iteration. User-owned untracked .serena/ remains untouched.
