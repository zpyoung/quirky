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

## Progress
Current full canonical remote script suite passed12/12files, no flaky retries. No code/test edits are needed: the queued failure inventory duplicates the already-landed repair. Independent source investigation, actual private-home CLI smoke and typecheck are in progress. Next: receive them, commit this decision receipt, catch up roadmap once and read incoming decisions, final typecheck, detach and authoritative queue land. Do not claim another item this iteration.
