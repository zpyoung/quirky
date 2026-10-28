# fix-flaky-pty-host-manager decisions

## D1: Preserve the already-landed single-writer fixture repair
- **Question:** Is the reported five-second raw-attach failure a too-short wait or a replay/live subscription gap?
- **Options:** Increase the wait; change production subscription ordering; preserve the previously evidenced fixture repair and verify it under load.
- **Chose:** Preserve `d123de46` and `fix-flaky-pty-host-host` D12: disable terminal echo before RAW_READY, then use cat as the only output writer. Do not increase deadlines or add retries.
- **Why:** The historical evidence captured all 700 expected bytes while echo and cat interleaved within line tokens, invalidating the requirement for two intact line-39 tokens. The timeout occurred before the second raw subscribe. Current subscribeRaw synchronously registers the sink and captures replay/offset, and pump appends output to the tail before broadcasting. No production replay/live gap was identified.
- **Evidence:** docs/loop/decisions/fix-flaky-pty-host-host.md D12; git show d123de46; packages/pty-host/src/session.ts pump/subscribeRaw; packages/pty-host/test/manager.test.ts raw attach fixture; read-only PtyAttachTrace investigation.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** An exact byte comparison fails with the single-writer fixture, or an asynchronous yield is introduced inside raw attach.
- **Source:** locked by docs/loop/decisions/fix-flaky-pty-host-host.md D12

## D2: Strengthen the existing raw attach case rather than add a duplicate test
- **Question:** What regression coverage can this item add when the root-cause repair is already present?
- **Options:** Add another same-path raw attach case; change production code without evidence; strengthen the existing test's expected byte stream and pending-output boundary.
- **Chose:** Split the known bulk input inside the final line token, drain completed cat lines, complete the pending line immediately before raw reattach, and assert the exact complete stream. Retain bounded line-aligned replay, exact offsets, and replay-plus-live equality.
- **Why:** Comparing two subscribers alone can miss loss common to both. An explicit expected stream detects missing/duplicate bytes independently. Splitting input creates the scheduling boundary that exposes the original two-writer assumption, without assuming PTY callback chunk sizes, adding sleeps, increasing deadlines, or adding retries.
- **Evidence:** packages/pty-host/test/manager.test.ts raw attach test; twenty loaded corrected runs passed (180 assertions, 33.54 seconds). Temporarily re-enabling echo made the strengthened case fail at its exact prefix assertion with line-3 interrupted by cat's earlier lines, not by timing out; echo was restored afterward.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Fixture output gains another legitimate producer or terminal newline conversion changes.
- **Source:** assumed — autonomous

## D3: Run the explicitly requested narrow stress investigation on macOS
- **Question:** Does build-first mode prevent reproducing this explicitly queued debugging item?
- **Options:** Land without the requested diagnosis; run broad suites/reviews; execute the specific requested loaded reproduction and affected test only, plus typecheck.
- **Chose:** Run scoped macOS PTY diagnostics and the changed manager test, with all child processes under disposable QUIRKY_HOME process scopes. Do not run broad suites or UI/review rounds.
- **Why:** This item's title explicitly requests systematic debugging and CPU-load reproduction; narrow behavioral execution is also the engineering verification requirement. Preserve the build-first landing gate and avoid unrelated debugging.
- **Evidence:** queue item fix-flaky-pty-host-manager title; docs/loop/LOOP.md Fix items and Typecheck gate; scripts/test-support/process-scope.ts.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The authoritative loop adds a specific different policy for this fix.
- **Source:** assumed — autonomous

## D4: Land the narrow fixture regression with truthful stress limits
- **Question:** What evidence supports the final cutover, and do incoming decisions change it?
- **Options:** Claim all loaded tests pass; change a saturated screen fixture's deadline; preserve the named raw fix and disclose the separate overload finding.
- **Chose:** Preserve all original timeouts and production paths; land only the existing raw test's stronger deterministic assertions plus investigation receipts. The single roadmap merge brought in fix-flaky-terminal-features-pane D1–D4, which changes a separate window replay/readiness fixture and does not conflict with this byte-level PTY test.
- **Why:** Controlled two-writer reproduction establishes that more waiting cannot restore a split token; the corrected case passes twenty loaded repetitions, detects an echo-enabled mutation, and the complete manager file passes without synthetic overload. The separate saturated screen test's overload deadline failure remains explicit in BLOCKERS.md. No broad suite, native UI, Linux, Windows, or all-load flake-free claim is made.
- **Evidence:** Loaded raw target: 20 pass/0 fail/180 assertions, 33.54 seconds; echo-enabled mutation: expected exact-prefix failure; final manager file: 57 pass/0 fail/230 assertions, 64.29 seconds; twenty-burner full-file finding: 56 pass/1 fail; all process scopes cleaned. Commit 3e407dee followed by one clean roadmap merge. Post-merge `bun run typecheck` exited 0 in 31.67 seconds, including UI lint and root/mobile/desktop TypeScript checks.
- **Reversibility:** easy
- **Confidence:** high for the specified two-writer cause and raw byte invariants, not an exhaustive flake-rate claim
- **Revisit if:** The exact single-writer raw stream fails, or the end-phase saturated screen diagnosis finds a real output loss.
- **Source:** assumed — autonomous

## Progress
Root cause traced to an already-repaired two-writer fixture, not a demonstrated production attach gap. Historical one-write reproduction did not trigger in 100 sequential attempts under ten CPU burners or 200 attempts across eight concurrent PTYs under twenty burners. Controlled input splitting under the same twenty-burner load reproduced the causal failure: all 700 expected bytes and their character multiset arrived, but only one intact line-39 token remained; output was unchanged after 5.1 seconds. This is a controlled scheduling reproduction, not a claim that the unchanged historical one-write test failed locally. An initial controlled diagnostic had an off-by-one CRLF byte-count calculation; corrected it before the successful capture. Every diagnostic scope cleaned its children and temporary home.

The existing raw attach test now preserves the single-writer repair while checking the controlled partial-line boundary and independently known exact stream. Twenty loaded corrected runs passed; the echo-enabled mutation failed as expected; original disabled echo restored. Final complete manager file without synthetic load: 57 pass, 0 fail, 230 assertions in 64.29 seconds, owned scope cleaned.

The complete manager file with twenty CPU burners returned 56 pass/1 fail/218 assertions in 160.82 seconds: the unchanged 400,000-line saturated screen-attach case exceeded its 30-second output deadline. The changed raw attach case passed. This is recorded with exact conditions as a medium verification finding in docs/loop/BLOCKERS.md, not suppressed or called a production replay defect. No deadlines changed and no testing/debugging follow-up was added under build-first.

Implementation and required verification are complete. One clean roadmap catch-up is merged and its sole new decision log was read; post-merge typecheck passed. Ready to commit this receipt, detach and land fix-flaky-pty-host-manager through the authoritative queue script. All scout and runtime processes have returned; remove the two owned throwaway /tmp scripts after landing. No production API or runtime changes.
