# fix-test-packages-pty-host-1028 decisions

## D1: Preserve the stop-with-history lifecycle contract
- **Question:** What is the boundary of this end-phase repair?
- **Options:** Change stop semantics; repair only the evidenced failure and its synchronization; broaden into unrelated PTY failures.
- **Chose:** Repair only the evidenced failure while preserving root/descendant termination, retained output, and same-history restoration.
- **Why:** The queue names one consumer-visible lifecycle scenario and requires canonical package reproduction and isolated process cleanup.
- **Evidence:** packages/pty-host/test/stop-with-history.test.ts:23-59; claimed queue item fix-test-packages-pty-host-1028.
- **Reversibility:** easy (bounded lifecycle/test repair).
- **Confidence:** high
- **Revisit if:** Canonical reproduction identifies a different runtime owner or binding decision.
- **Source:** assumed — autonomous

## D2: Exercise scrollback rather than searching the visible screen through history
- **Question:** Why does the baseline marker never reach `history()`?
- **Options:** Change production history to include the screen; increase waits; emit enough output to enter actual scrollback.
- **Chose:** Emit the original marker, thirty numbered rows, and a distinct unterminated live marker. Preserve history/snapshot separation and verify the real root as well as its child is gone after stop.
- **Why:** The original one-line fixture stays entirely on the 24-row live screen. `history()` deliberately excludes that screen, so waiting longer cannot succeed. Canonical reproduction failed the same wait on both the initial and isolated run; the local file failed identically before stop. No output-loss or process-stop defect was established.
- **Evidence:** docs/loop/reports/m7-test-triage.json:161–170; packages/pty-host/src/session.ts:393–401; packages/pty-host/src/history/reader.ts:415–451; m1-term-daemon D7/D8/D24; canonical suite 16/17 files passed, focused original 1 pass/1 fail.
- **Reversibility:** easy (test fixture only).
- **Confidence:** high
- **Revisit if:** A marker scrolled above the live screen is absent from history.
- **Source:** locked by docs/loop/decisions/m1-term-daemon.md

## D3: Verify preserved output, not an incidental newest-page boundary
- **Question:** Should newest history pages remain exactly equal across stop and restore?
- **Options:** Require identical page shapes; weaken retention to success-only; assert retained history content and exact combined output.
- **Chose:** After both stop and restore require the history marker, the visible marker, and every expected output row in order through `read`. Do not pin the newest page's precise size.
- **Why:** An intermediate stronger assertion failed because restore moved `history-row-7` into scrollback. Restore explicitly appends GROUND ending with CRLF. A later local run also gained rows7/8 in the stop history page; ten isolated real-session diagnostics did not reproduce that gain and its cause is unproven. Rather than invent a fixed page shape, retain the original marker-in-history guarantee and strengthen it with exact complete output checks across both lifecycle transitions. The final focused file passed 2 tests/12 assertions in 2.57 seconds without runtime or timeout changes.
- **Evidence:** packages/pty-host/src/history/restore.ts:23–28; packages/pty-host/src/session.ts:598–601; m1-term-daemon SC-17; focused local red/green outputs in this iteration.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Restore loses, duplicates, reorders, or changes prior output.
- **Source:** locked by docs/quirk/specs/2026-10-26-m1-term-daemon/logic.md

## D4: Keep the repair test-only and retain existing ownership safeguards
- **Question:** Should this repair also change callback ordering, test budgets, or platform support?
- **Options:** Change a speculative startup race; widen timeouts proactively; retain production behavior and process scopes.
- **Chose:** No production changes, timeout increases, local synthetic load, plugin/API changes, or native scenarios. Retain temporary homes and guardian-owned cleanup; document the existing history/screen boundary in docs/v1.md.
- **Why:** The confirmed contract mismatch fully explains the reported failure. No reproduced evidence establishes an early callback loss or insufficient outer deadline; broadening would hide the actual diagnosis. Existing stop escalation remains separately tested.
- **Evidence:** packages/pty-host/test/stop-with-history.test.ts; packages/pty-host/test/helpers.ts:16–64; fix-flaky-pty-host-host D2/D5.
- **Reversibility:** easy
- **Confidence:** high for the reported failure, not all possible scheduling failures.
- **Revisit if:** A correctly synchronized lifecycle exceeds its existing budget.
- **Source:** assumed — autonomous

## D5: Preserve incoming repairs and their independent evidence boundaries
- **Question:** Do the two decision logs brought in by the single roadmap catch-up conflict with this repair?
- **Options:** Expand into browser native isolation or script review; preserve their existing owners and scoped decisions.
- **Chose:** Read both incoming logs in full; preserve the browser native reblock and script subprocess/fixture repair. Neither changes the PTY history/screen contract.
- **Why:** The browser decision requires isolated native credentials and packaged attribution, not PTY changes. The scripts decision fixes explicit environment inheritance and reviewer fixtures, which belongs to that existing item.
- **Evidence:** Single clean roadmap merge after source293d89f5; fix-native-sa-browser-agent-1028 D1–D9 and full Progress; fix-test-scripts-1028 D1–D8 and full Progress.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Integration identifies a concrete interaction.
- **Source:** locked by incoming decision logs

## D6: Land the bounded fixture repair with exercised lifecycle evidence
- **Question:** Is the named failure repaired without a speculative production change or weakened retention?
- **Options:** Land after typecheck alone; expand into unrelated diagnostics; require final affected checks and actual socket lifecycle evidence.
- **Chose:** Land the test/docs repair after the final affected suite, scripts, typecheck, isolated real-host smoke and static review.
- **Why:** The final fixture reaches actual scrollback and tests stopped/restored exact output, both screen/history surfaces and actual root/child absence. Static review found no actionable issues in the revised patch and explicitly withdrew an unsupported termination-diagnostics explanation. No runtime change, native/visual acceptance, whole-repository suite pass or additional platform support is claimed.
- **Evidence:** Final canonical PTY suite17/17files, no failures/flaky reruns50.99s; focused2pass/0fail/12assertions2.57s; scripts126pass/0fail/1103assertions109.92s; final typecheck/UIlint/root/mobile/prepared-desktop exit0 in76.38s; real socket smoke exit0 in1.33s with PTY_STOP_HISTORY_SOCKET_SMOKE_OK and PTY_STOP_HISTORY_SOCKET_CLEANED, tracked PIDs absent and temporary home removed; PtyHistoryReviewer completed with no findings.
- **Reversibility:** easy
- **Confidence:** high for the exercised lifecycle and exact failure.
- **Revisit if:** Canonical integration exposes another failure in the same boundary.
- **Source:** assumed — autonomous

## Progress
Ready for canonical landing. Source293d89f5 plus final assertion refinement; one clean roadmap catch-up, both incoming decision logs fully read and compatible. Final package17/17clean50.99s, scripts126/1261103assertions109.92s, focused2/2 12assertions2.57s and typecheck76.38s passed. Actual isolated real-host/socket lifecycle smoke passed with cleanup1.33s; static review approved revised patch. All scouts/reviewer/finite jobs returned, no owned runtime remains. Commit final refinement/receipt, detach, invoke canonical queue.ts land, then delete the two owned /tmp diagnostic scripts and end this one-item iteration.
