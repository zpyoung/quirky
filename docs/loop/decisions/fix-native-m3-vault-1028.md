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

## D4: Preserve the separate script failures in an end-phase repair item
- **Question:** Does this Vault repair authorize changing the unrelated screenshot-review subsystem when the script gate fails?
- **Options:** Suppress or weaken its failures; expand this item into UI-review debugging; retain the failing gate evidence and queue its separate repair.
- **Chose:** Run the complete gate once, record all 13 real failures, and add `fix-test-scripts-ui-review-1028` with dependency `m7-test-triage` through the canonical queue command. Append the failure inventory to BLOCKERS.md. No script assertion, UI-review implementation or protected loop path changed.
- **Why:** End-phase triage is already claimed by lane8. These failures concern screenshot reviewer results, fixture directory reuse and malformed-input diagnostic persistence; none runs Vault clipboard actions. The final integration gate is typecheck, but a failed script gate must remain visible and owned rather than be presented as passed.
- **Evidence:** `bun test scripts`:113 pass,13 fail,945 assertions,98.17s,exit1. Twelve failures are in `scripts/ui-review/review.test.ts`; `manifest()` at85 throws EEXIST on repeated captures; several expected passed/failed or specialized errors receive generic error. `scripts/ui-review/cli.test.ts:219` throws ENOENT for ui-review-error.json after malformed review-only input. Full lane1 iteration23 output artifacts26/38; durable inventory in docs/loop/BLOCKERS.md under this item and the queued title. Canonical queue status lists m7-test-triage in-progress lane8.
- **Reversibility:** easy.
- **Confidence:** high for the failure inventory; no UI-review root cause is asserted.
- **Revisit if:** The end-phase repair identifies a Vault-dependent cause.
- **Source:** assumed — autonomous

## D5: Preserve incoming owner decisions and the narrow native boundary
- **Question:** Do decisions arriving in the one integration catch-up change the repair?
- **Options:** Reopen PTY timing or Chrome security work; preserve their owners and the Vault parity decision.
- **Chose:** Merge build/roadmap once, read both incoming decision logs completely, and retain their boundaries. No conflict with the existing Vault fix. UI-lint, root/mobile/prepared-desktop typecheck passed after the merge in43.70s.
- **Why:** fix-flaky-pty-host-clear changes only real-PTY test/cleanup budgets. fix-native-sa-browser-agent-1028 blocks unproven packaged Chrome process failure and explicitly preserves production credential protection. Neither authorizes a new Vault clipboard bridge or a native pass claim.
- **Evidence:** clean integration merge; docs/loop/decisions/fix-flaky-pty-host-clear.md D1–D6; docs/loop/decisions/fix-native-sa-browser-agent-1028.md D1–D4; `bun run typecheck` exit0.
- **Reversibility:** easy.
- **Confidence:** high for compilation and independent authority preservation.
- **Revisit if:** Canonical land reports a conflicting incoming change.
- **Source:** locked by incoming decision logs

## D6: Resolve the guarded scroll limitation without changing working UI
- **Question:** Does the first guarded run's blocked expanded-copy goal establish another product defect?
- **Options:** Change panel layout from the blocked result alone; abandon the goal; identify its actual scroll owner and repeat the guarded operation there.
- **Chose:** Inspect scroll geometry read-only, then run a focused guarded follow-up against the visible outer Agent Session History panel. It passed: loaded first-prompt content and the entire Copy first prompt button are visible. Preserve the original blocked report and its findings instead of rewriting it.
- **Why:** The nested prompt consumes its own scrolling; the outer panel had clientHeight539 and scrollHeight758. Scrolling that outer panel exposed the existing control. The menu campaign had already shown all four copy actions together. No stalled source request or remaining clipping defect was established, so another production change would be speculative.
- **Evidence:** `.quirk/using-apps-like-a-user/runs/20261028T212851-cbcb/report.md`:g1 pass,g2 blocked; obs-4.png shows every requested menu copy action. Focused follow-up `.quirk/using-apps-like-a-user/runs/20261028T213452-7fc9/report.md`:g1 pass,no findings,no cleanup errors; obs-4.png shows loaded prompt and full Copy first prompt button. Both are actual built web UI/daemon campaigns, not native certification. Build exit0 in18.90s; missing icon.iconset warning remains unchanged.
- **Reversibility:** easy.
- **Confidence:** high for visual reachability and source loading; macOS clipboard remains pending.
- **Revisit if:** The nightly native runner cannot reach these controls in its rebuilt app.
- **Source:** assumed — autonomous

## D7: Keep browser permission diagnostics separate from clipboard acceptance
- **Question:** Can the parent browser probe establish exact clipboard behavior or require a product permission change?
- **Options:** Change application permissions; call a browser clipboard shim a native pass; retain only the observed diagnostic boundary.
- **Chose:** No application permission change and no four-value browser/native pass claim. A headless Chromium probe read one exact literal log path after its isolated grant; subsequent permission/read operations failed and the tool killed its worker. Exact four-value acceptance comes only from the existing daemon/window regression; native certification stays pending.
- **Why:** The runtime already reports a denied Clipboard write honestly. Browser grant changes are not evidence against Vault's existing clipboard owner. The guarded visual campaigns never touched the clipboard. All smoke HOME/XDG_CONFIG_HOME/QUIRKY_HOME/source paths are owned temporary paths, including provider-hook writes.
- **Evidence:** Lane1 iteration23 browser probe: Clipboard write permission denied, one exact log-path read, then read/grant worker-recovery failure. Parent tabs closed/released. The first guarded campaign's ended blocked session was retained by the tool; exact-session process cleanup `playwright-cli -s=20261028T212851-cbcb close` reported it closed. This was teardown only, not an unguarded QA action. Focused follow-up end retained nothing.
- **Reversibility:** easy.
- **Confidence:** high for the reported evidence boundary; no native clipboard claim.
- **Revisit if:** A compliant native run supplies a concrete Clipboard API failure.
- **Source:** locked by docs/loop/NATIVE.md

## Progress
The already-landed parity repair is confirmed by the unchanged 29-assertion selected-copy/details regression and rebuilt web campaigns: all four menu actions visible, full first prompt loaded, expanded copy reachable by outer-panel scrolling. Only the original failed clipboard scenario is reset to pending; historical reports and separately blocked native scenarios remain intact. One clean catch-up and post-merge typecheck pass; script gate's13 UI-review failures are recorded and queued separately. No production/test edits, duplicate regression, assertion weakening or native pass claim. Both agents completed, parent tabs released, retained guarded browser closed, isolated daemon service exited0 and owned PTY pid/runtime files disappeared. Ready to commit evidence, detach, canonical queue land, wait for its result, and remove the owned scratch directory.
