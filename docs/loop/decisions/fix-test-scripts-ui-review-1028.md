# fix-test-scripts-ui-review-1028 decisions

## D1: Close the duplicate failure inventory against the landed repair, not a second implementation
- **Question:** Which repair remains necessary for this queued report of 13 UI-review script failures?
- **Options:** Reapply the earlier changes; weaken the current checks; inspect the landed repair and exercise its exact boundaries.
- **Chose:** Reuse the landed `fix-test-scripts-1028` repair without code or test changes. Verify the current script suite and real CLI rejection paths.
- **Why:** The current source already explicitly passes current process.env to reviewer subprocesses, gives each manifest independent capture files, scores the boundary fixture exactly 85, tracks both timeout children, and distinguishes returned validation reports from thrown runtime errors. These are the exact reported causes, already recorded in the binding earlier decision log. A second implementation would add dead weight or conflict with its contract.
- **Evidence:** docs/loop/decisions/fix-test-scripts-1028.md D2–D4,D7; scripts/ui-review/review.ts:440–452,620–653; scripts/ui-review/review.test.ts:27–45,88–110,152–170,362–375; scripts/ui-review/cli.test.ts:208–267. Current canonical `bun scripts/suite.ts scripts` exited 0 in32.80s:12/12 remote files passed, flaky[].
- **Reversibility:** easy (receipt-only closure)
- **Confidence:** high
- **Revisit if:** A current failure demonstrates a boundary the earlier repair did not cover.
- **Source:** locked by docs/loop/decisions/fix-test-scripts-1028.md

## D2: Preserve strict validation and the existing artifact distinction
- **Question:** Should malformed persisted evidence require ui-review-error.json, as the historical failing assertion assumed?
- **Options:** Force validation into an exception artifact; keep the earlier public contract separating validation reports and runtime exceptions.
- **Chose:** Keep returned structural validation failures in review-report.json and final exit2 result, with zero accepted captures. Invalid JSON parsing remains a thrown manifest-read failure with ui-review-error.json. Neither path may launch capture or the reviewer.
- **Why:** This distinction is explicit in the approved command spec and previous repair. No source behavior or assertion needs changing to preserve it.
- **Evidence:** docs/quirk/specs/2026-10-28-ui-screenshot-review/logic.md:30–33; scripts/ui-review.ts:244–248,294–318,341–360; scripts/ui-review/cli.test.ts:256–266.
- **Reversibility:** medium (published evidence artifacts consumed by command users)
- **Confidence:** high
- **Revisit if:** The command's published error contract is deliberately replaced.
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-screenshot-review/logic.md

## D3: Treat this as an evidence-only duplicate closure, not another implementation review
- **Question:** Which workflow remains when the exact repair and regressions have already landed?
- **Options:** Invent a new implementation and review patch; add duplicate tests; retain the prior correction and record fresh execution evidence.
- **Chose:** Investigation-only closure with current full script suite, actual CLI smoke, full typecheck and the queue's integration gate. No source/test/spec/changelog change, paid model dispatch, formal review round or new follow-up.
- **Why:** No production or test change remains to review; the original repair already received a cross-family review and its accepted fixture findings were fixed. Independent read-only source investigation agrees the exact reported causes are absent. Repeating an implementation would add no consumer behavior.
- **Evidence:** UiReviewScout source investigation; docs/loop/decisions/fix-test-scripts-1028.md D7; real CLI smoke prints UI_REVIEW_REAL_CLI_REJECTION_SMOKE_OK and UI_REVIEW_SMOKE_CLEANED, exit0. Both actual CLI children exited2; structural failure retained the validation report, invalid JSON retained the thrown manifest-read error, reviewer/capture did not start, inputs stayed unchanged, private home was deleted.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Fresh checks identify an actual outstanding defect.
- **Source:** assumed — autonomous

## D4: Retain incoming protocol and screenshot-provenance decisions without reopening their scope
- **Question:** Does the sole roadmap catch-up change the UI-review script repair contract?
- **Options:** Reopen product/schema or screenshot work; preserve the incoming test-only and documentation changes.
- **Chose:** Preserve both incoming items. Read their full decision logs including unabridged long evidence/Progress lines; no conflict with the current reviewer/validation/error-artifact contract.
- **Why:** Protocol changes remove incidental test inventories, not runtime contracts. UI-final-review publishes original before/after PNGs with immutable source attribution, not a new score or reviewer implementation.
- **Evidence:** Sole clean git merge build/roadmap after058d5cb2; docs/loop/decisions/fix-test-packages-protocol-1028.md D1–D5; docs/loop/decisions/ui-final-review.md D1–D8.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Integration finds a current script consumer failure.
- **Source:** locked by incoming decision logs

## Progress
Current canonical remote script suite passed12/12files, no flaky retries, both before catch-up (32.80s) and after catch-up (suite plus fresh actual smoke45.97s). Both real private-home CLI smoke runs exited0 with success/CLEANED markers: malformed shape returned an error report, invalid JSON retained a manifest-read exception artifact, both command exits2, no reviewer/capture, immutable inputs, private runtime removed. Final composed full typecheck passed31.51s including canonical UI lint, root/mobile/prepared desktop. Only this decision log changes; exact failure inventory was already repaired by fix-test-scripts-1028. Sole roadmap catch-up and full incoming-log reads completed; independent scout returned. Ready to commit final receipt, detach, canonical queue land and await result, delete owned scratch, end this one-item iteration. No implementation, new test, formal review, visual/native acceptance or paid model call claimed.
