# fix-native-m3-vault-1028 decisions

## D1: Reuse the landed parity repair rather than add a clipboard bridge
- **Question:** What causes the reported SC-18-native-clipboard failure, and does it require another production implementation?
- **Options:** Add a desktop clipboard bridge; duplicate the copy controls; verify and retain the already-landed menu/detail repair.
- **Chose:** Retain the parity repair in commit `27f078f5` and exercise the existing selected-source regression and rebuilt UI. No production change without evidence of a remaining product defect.
- **Why:** The authoritative native report identifies an overflow-clipped menu, an absent first-prompt action, and stalled source details. It also records successful command/ID copying. The parity repair portals the menu outside the overflow-hidden virtual row, bounds it to the viewport with scrolling, adds Copy First Prompt, and replaces the canceled-effect/last-request guard with identity-bound independent detail requests and retry. A new native clipboard owner would not repair those causes.
- **Evidence:** Native report `/Users/zpyoung/orca/workspaces/quirky/native-qa/.quirk/using-apps-like-a-user/runs/20261028T052000-37e6/report.md`:16-18,50-54; `git show 27f078f5`; plugins/quirky.vault/src/window/HistoryPanel.tsx:239-290,378-404,426-439,552-575; plugins/quirky.vault/src/window/styles.ts:26-27.
- **Reversibility:** easy (no new public contract).
- **Confidence:** high for the identified visibility defects; the historical run does not prove which request stalled.
- **Revisit if:** A rebuilt native run still cannot reach a copy control or its actual clipboard value differs.
- **Source:** locked by docs/loop/decisions/m3-vault-parity-completion.md D5

## D2: Reuse the existing consumer regression without manufacturing a new failing test
- **Question:** Should an already-repaired failure receive a duplicate test or a production change solely to produce a red/green cycle?
- **Options:** Add another same-path copy test; weaken existing assertions; run the existing real daemon/window acceptance test unchanged.
- **Chose:** Run the existing SC-18/19/20 regression unchanged. It passed one test with 29 assertions in 6.06 seconds, with React teardown/act warnings recorded rather than suppressed.
- **Why:** This test already compares the complete selected 195KB-class prompt, session ID, log path and provider-prepared resume command, distinguishes two source identities, and loads both expanded first prompts through the daemon API. No new implementation was written and no new red/green claim is made.
- **Evidence:** `bun test plugins/quirky.vault/test/window-parity.test.ts --test-name-pattern 'SC-18/19/20'`:1 pass,8 filtered,0 fail,29 assertions; plugins/quirky.vault/test/window-parity.test.ts:343-443.
- **Reversibility:** easy.
- **Confidence:** high for the isolated daemon/window behavior; this harness clipboard is not the macOS clipboard.
- **Revisit if:** A remaining defect identifies a new observable boundary not covered here.
- **Source:** assumed — autonomous

## D3: Reset only the repaired native failure; preserve evidence and native certification
- **Question:** Does a passing headless regression authorize marking the macOS clipboard scenario passed?
- **Options:** Mark native pass from web evidence; discard the old report; set the failed scenario pending and preserve its last native report.
- **Chose:** Reset only `m3-vault` SC-18-native-clipboard to pending, keeping its lastRun, report and historical summary intact. Leave the separately blocked focus/Finder scenarios and parity native handoff unchanged.
- **Why:** LOOP.md requires repaired native failures to return to pending. Actual macOS clipboard values, previous clipboard restoration, focus and Finder remain the nightly runner's responsibility. Headless evidence cannot certify them.
- **Evidence:** docs/loop/LOOP.md, Fix items step3; docs/loop/NATIVE.md:24-57; docs/loop/native/m3-vault-parity-completion.json:21-27; docs/loop/decisions/m3-vault-parity-completion.md D5.
- **Reversibility:** easy.
- **Confidence:** high.
- **Revisit if:** The next native report records a remaining failure.
- **Source:** locked by docs/loop/LOOP.md

## Progress
Root cause and already-landed repair inspected; existing literal-copy and source-detail regression passes. Rebuilt app successfully. Isolated real daemon uses only owned HOME/XDG_CONFIG_HOME/QUIRKY_HOME/source roots and current bundled plugins/UI. Web reachability campaign, script gate, catch-up, typecheck and landing remain in progress. No production or test change is justified by current evidence.
