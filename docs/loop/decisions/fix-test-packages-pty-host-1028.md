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

## D3: Verify preserved output, not an incidental restore page boundary
- **Question:** Should the newest history page remain exactly equal after restore?
- **Options:** Require identical newest pages; weaken retention to success-only; assert retained history content and exact combined output.
- **Chose:** Preserve exact history-page equality across stop; after restore require the history marker, the visible marker, and all expected rows in order through `read`.
- **Why:** An intermediate stronger assertion failed because restore moved `history-row-7` into scrollback. Restore explicitly appends GROUND ending with CRLF, so the newest page may gain a formerly visible row. Re-pinning that page shape would test an incidental boundary rather than retained output. The corrected file passed 2 tests/11 assertions in 2.45 seconds without runtime or timeout changes.
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

## Progress
Fixture repair and docs are implemented. Original failure reproduced canonically and locally; corrected file passed 2 tests/11 assertions. Actual isolated socket-host smoke is running. Next: receive smoke, commit source, catch up once, read incoming decisions, run affected suite/scripts/typecheck, record final outcomes, and land this one item.
