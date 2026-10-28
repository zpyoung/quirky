# fix-test-mobile-1028 decisions

## D1: Repair the three public mobile boundaries without compatibility aliases
- **Question:** Which failures belong to this end-phase item, and how should shared ownership be handled?
- **Options:** add mobile-only browser/trust bypasses; repair the public contracts and coordinate shared owners
- **Chose:** repair the public contracts and coordinate shared owners
- **Why:** Triage records missing Chromium, missing consent trustHash, and an unknown browser paneState method; none justifies restoring obsolete aliases or bypassing content-pinned consent.
- **Evidence:** docs/loop/reports/m7-test-triage.json groups plugins/quirky.mobile; queue item fix-test-mobile-1028
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** current runtime evidence identifies a different consumer-visible boundary
- **Source:** locked by docs/loop/LOOP.md

## D2: Use reported baseline failures as red evidence and verify changes with the canonical suite
- **Question:** Should the baseline failures be rerun merely to confirm them?
- **Options:** repeat triage; trust reported evidence and run changed-path verification
- **Chose:** trust reported evidence and run changed-path verification
- **Why:** The supplied triage is authoritative failure evidence. Verification will use bun scripts/suite.ts with fresh isolated homes; no real user state is permitted.
- **Evidence:** docs/loop/reports/m7-test-triage.json baseline 97aaa12d9fdf91a966cbc78d5557e113fc9789b3; docs/loop/LOOP.md end phase and step 6
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a new regression needs a new failing scenario
- **Source:** assumed — autonomous

## Progress
Step 1 root-cause investigation underway. Claimed by lane 12; branch build/fix-test-mobile-1028. Scout maps the three failure paths; no checks or product edits yet. Existing .serena/ is unrelated and untouched.
