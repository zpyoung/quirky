# fix-test-terminal-1028 decisions

## D1: Preserve production ownership and repair demonstrated causes
- **Question:** How to scope the terminal baseline failures in this unattended fix item?
- **Options:** Repin old expectations; weaken guards; trace each failure against current contracts.
- **Chose:** Trace failures, repair demonstrated consumer-visible defects, and delete incidental wording/source/default/inventory mirror assertions.
- **Why:** The item explicitly requires consumer-visible correctness and prohibits aliases and authority bypasses.
- **Evidence:** Queue item fix-test-terminal-1028; docs/loop/LOOP.md, Fix items.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Evidence reveals a binding contract conflict.
- **Source:** locked by docs/loop/LOOP.md

## D2: Run tests on the canonical remote runner
- **Question:** Where to reproduce and verify under local machine contention?
- **Options:** Local bun test; canonical suite runner.
- **Chose:** bun scripts/suite.ts for suites and individual test files; private homes and owned-process cleanup for actual runtime smoke.
- **Why:** Prior operator instruction routes even individual tests remotely, except listed macOS-only/native checks.
- **Evidence:** Lane notes iteration13 operator rule; docs/loop/LOOP.md test isolation.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A changed path requires native macOS-only APIs.
- **Source:** assumed — autonomous

## D3: Route macOS-only artifact and simulator acceptance to the Mac
- **Question:** Why do artifact listings and the owned simulator fixture fail on the remote test host?
- **Options:** Broaden production support; skip safety cases; route the existing acceptance files to macOS.
- **Chose:** Add artifacts-api.test.ts, artifacts.test.ts and emulator.test.ts to scripts/test-on-macos.txt with precise platform reasons. Keep every grant, file-identity and exact-device guard unchanged.
- **Why:** Artifact safePlatform explicitly requires Darwin and safe descriptor flags; emulator list/frame explicitly reject non-Darwin before invoking xcrun. Baseline generic refusals match those gates. The corrected canonical routing ran all three files on macOS and passed without source/test changes.
- **Evidence:** plugins/quirky.terminal/src/artifacts.ts:93-95,275-276; src/emulator.ts:20-21,44-48; canonical three-file run exit0, 3 passed/0 failed, 32.81s.
- **Reversibility:** easy
- **Confidence:** high for platform gates and verification; baseline refusal reasons were not persisted individually.
- **Revisit if:** Linux/Windows gain an explicitly reviewed equivalent file-capability or simulator implementation.
- **Source:** deferred: platform

## D4: Keep destructive lifecycle behavior and remove incidental prompt prose
- **Question:** Should a confirmation test require exact human-facing wording?
- **Options:** Repin current prompt copy; assert confirmation, process/layout preservation, cancellation and explicit acceptance.
- **Chose:** Remove prompt/declined wording pins from the reported lifecycle scenarios while retaining their state, exit, child-process and history assertions.
- **Why:** A real isolated daemon/API/CLI smoke confirmed artifact preview/save, pending kill confirmation, no early termination, acknowledged kill, child reaping and retained scrollback. Exact prose is not the safety contract.
- **Evidence:** plugins/quirky.terminal/test/e2e.test.ts SC-23; test/e2e/tabs.test.ts SC-14; smoke exit0 4.86s with TERMINAL_MACOS_ARTIFACT_SMOKE_OK, TERMINAL_KILL_CONFIRMATION_SMOKE_OK and TERMINAL_SMOKE_CLEANED.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Consumer state or confirmation ownership fails without a wording mismatch.
- **Source:** assumed — autonomous

## D5: Use OpenAI implementers and the reachable Google reviewer
- **Question:** Which unattended implementation/review pairing is available?
- **Options:** OpenAI task implementers plus Opus; OpenAI task implementers plus Gemini; same-family fallback.
- **Chose:** Two disjoint test-only OpenAI implementer slices, parent integration/smoke, and Gemini for a bounded cross-family final review.
- **Why:** pi-watch --check opus exited5 with no authenticated shipping model; pi-watch --check gemini exited0 and resolved google/gemini-3.1-pro-preview:high. No human prompt is permitted.
- **Evidence:** Preflight probe receipts in this iteration; docs/loop/LOOP.md model pairing and unattended choices.
- **Reversibility:** easy
- **Confidence:** high for preflight, not a claim that a review dispatch has completed.
- **Revisit if:** Gemini dispatch fails, then take the documented fallback and record reduced independence.
- **Source:** assumed — autonomous

## D6: Delete mirror assertions and use actual shared-control interaction surfaces
- **Question:** How to repair failures introduced by current terminal and host presentation contracts?
- **Options:** Recreate old CSS/DOM aliases; repin copy, defaults and inventories; drive current controls and preserve consequential behavior.
- **Chose:** Delete preset-only color-error, contribution/keybinding inventory and cross-file default mirrors. Use transcript role=log, actual search input readiness, a test-owned explicit background for opacity, and fresh accessible toast status/alert notifications for rejected paste and Vault drops.
- **Why:** Initial canonical run found 21/101 remote failed files plus the macOS paste-refusal failure. Exact simulator/artifact output proves platform rejection; shared design-system migrations removed old title/toast/style classes. Meaningful cancellation, target routing, key ownership, no-shell adoption, file grants, opacity and no-write assertions stay.
- **Evidence:** Initial full canonical suite exit1 543.69s; packages/ui/src/design-system/overlays.tsx; packages/ui/src/components/Toasts.tsx; changed terminal tests. Existing ui.test.ts no longer contains the baseline inventory case and is intentionally unchanged.
- **Refinement:** The first role=alert-only fixture correction failed both paths. Source tracing proved context.toast defaults to info and the shared Toast renders role=status for that status. Observe fresh host-toast status or alert nodes without changing product severity or asserting prompt prose.
- **Reversibility:** easy
- **Confidence:** high for source/fixture mismatches; final verification pending.
- **Revisit if:** A valid current user interaction demonstrates a production defect rather than an obsolete oracle.
- **Source:** assumed — autonomous

## D7: Keep missing-session errors visible instead of restoring the prior pane
- **Question:** Should SC-76's invalid-session tail expect the old pane's focus report?
- **Options:** Restore implicit fallback; remove the superseded tail and retain the explicit missing-session scenario.
- **Chose:** Keep SC-76's valid exact pane/group selection checks and remove only its obsolete invalid-session fallback expectation. SC-72 retains missing/wrong-worktree refusal, no-shell and unchanged-layout behavior.
- **Why:** The two old/new expectations contradicted one another in the same file. A request for a missing session must not silently substitute another session. The initial SC-76 run also logged xterm renderer disposal errors; their cause remains unproven and no production workaround is introduced.
- **Evidence:** plugins/quirky.terminal/test/e2e-ui/workspace-view.test.ts SC-76 and SC-72; initial canonical failure old-focus report timeout and xterm syncScrollArea error.
- **Reversibility:** easy
- **Confidence:** high for conflicting oracles; no diagnosed cause for the renderer error.
- **Revisit if:** A valid session request no longer selects its exact pane.
- **Source:** assumed — autonomous

## D8: Preserve the three incoming owners and their bounded evidence
- **Question:** Does the single roadmap catch-up require a contract change?
- **Options:** Diverge from incoming lifecycle, Browser or Editor contracts; preserve them and exercise the composed terminal behavior.
- **Chose:** Read fix-test-browser-1028 D1–D12, fix-test-editor-1028 D1–D19 and fix-test-session-1028 D1–D11, including Progress, in full. Preserve exact simulator/file authority, structured startup reconciliation, owned process cleanup, no fallback aliases, shared controls and canonical source-admission rules.
- **Why:** The clean merge brought 30 changed files and no terminal production or fixture conflicts. Session startup reconciliation distinguishes daemon-owned structured sessions from surviving live terminals; it does not change requested-session adoption. Browser native drag remains with its explicit owner and is not declared passed here.
- **Evidence:** source6a885635 followed by the sole git merge build/roadmap; three incoming decision logs; fresh composed daemon/API/CLI smoke exit0 7.50s with both success markers and TERMINAL_SMOKE_CLEANED.
- **Reversibility:** easy
- **Confidence:** high for read contracts and exercised smoke; complete suite pending.
- **Revisit if:** Canonical terminal verification or landing reveals a concrete conflict.
- **Source:** locked by incoming decision logs

## D9: Await the completed Markdown selection rather than the first persisted tab
- **Question:** Why did the document-destination test observe the exact tab but the prior active group?
- **Options:** Relax destination selection; change Editor/Terminal ownership; wait for the existing asynchronous creation-and-focus operation to finish.
- **Chose:** Keep all final destination, active-tab, rich-mode and original-group assertions, and make their condition wait include the requested active group/tab.
- **Why:** QuickOpenOverlay.createMarkdown awaits Markdown creation, then separately opens that returned path with focus:true. The test previously returned at the intermediate persisted tab, before focus completion. The first UI/window gate observed this boundary and its configured isolated retry passed. The corrected exact-file canonical gate passed without retries.
- **Evidence:** plugins/quirky.editor/src/window/QuickOpenOverlay.tsx:143-160; plugins/quirky.terminal/test/e2e-ui/features-document-destination.test.ts; first UI/window gate53/57remote pass, document retry1/1; corrected document1/1,29.86s; latest dialog three-file gate3/3,150.26s.
- **Reversibility:** easy
- **Confidence:** high for the two-stage source contract and observed state; no production focus defect claimed.
- **Revisit if:** Completion never selects the exact requested group and tab.
- **Source:** assumed — autonomous

## D10: Run one bounded cross-family review over the fixed fixture artifact
- **Question:** What independent assurance accompanies the repair?
- **Options:** Trust worker reports; repeat open-ended discovery; one fixed-artifact standard promote/refute protocol.
- **Chose:** Google Gemini high-reasoning promote and independent fresh-context refute over the 432-line source/test/README/routing artifact, excluding author decision logs and reasoning. Mechanical resolve, compiler prepass, model selection, claims, merge, gate and manifest all exited0. Both real dispatches returned empty finding arrays.
- **Why:** The gate is PASS with full family independence and zero blocking, advisory, suppressed, contested, limitation, question, excluded or unreviewed entries for that fixed artifact. This is not exhaustive UI/native qualification. The later four-line pane-search fixture-readiness correction is explicitly outside that formal artifact and receives separate checks rather than relabeling the review.
- **Evidence:** run e846ca1515138475; artifact0d161271ee5e1035d66346bde6279bbe698dce3f5289b97b98af10f1de64fb14; prepass bun run typecheck41.946s; review chain186.45s; actual raw stage outputs and gate/manifest.
- **Reversibility:** easy
- **Confidence:** high for performed protocol and scope, bounded for completeness.
- **Revisit if:** An exercised consumer boundary contradicts the reviewed tests.
- **Source:** assumed — autonomous

## D11: Wait for a pane's actual subscription before injecting its output
- **Question:** Why did the composed full suite reach undefined streams.get(101) in pane-search setup?
- **Options:** Make fake push silently drop/wait; add a fixed sleep; wait explicitly for the valid fixture's actual subscription.
- **Chose:** Only mountWithOutput waits under React act for fake.streams.has(101), bounded at2 seconds, before pushing bytes. Preserve the fake's strict delivery behavior, every search assertion, all default production and test deadlines, and shared mount semantics for failed/non-live attachments.
- **Why:** mountPane's one-tick settle is not a subscription-ready contract. The observed stack fails before search behavior, at output injection into an absent stream. Tests intending failed/non-live attach must still expose no stream rather than forcing all mounts to wait for one.
- **Evidence:** composed full suite95/98remote pass, pane-search undefined stream stack at ui-fake.ts:168 and mountWithOutput:23; test/window/pane-support.tsx:88-103.
- **Reversibility:** easy
- **Confidence:** high for the missing subscription boundary; no production timing or output-loss defect claimed.
- **Revisit if:** The valid fixture cannot subscribe within the bounded readiness wait or preserves wrong stream identity.
- **Source:** assumed — autonomous

## D12: Land with the complete owning gate and separately checked final fixture delta
- **Question:** What final evidence closes this item without overstating earlier snapshots or native qualification?
- **Options:** Relabel intermediate red runs; rerun an open-ended review campaign; retain exact snapshots and exercised acceptance.
- **Chose:** Final owning canonical run passed98/98remote plus5/5macOS files, with no retries/flaky entries, in468.50s. That snapshot predates only D11's four-line subscription-readiness fixture correction, which independently passed its full file1/1 with no retry in22.53s and final full typecheck40.17s. The current dialog three-file gate passed3/3 in150.26s; document-destination1/1 in29.86s; scripts12/12 in55.93s.
- **Why:** All named baseline files and the reached current shared-control regressions have exercised behavior coverage or explicitly removed incidental mirrors. No production API, authority, timeout, alias, provider, platform-support or UI behavior changed. The final actual composed daemon/API/CLI smoke passed7.50s with artifact save, pending/accepted kill, child reaping and retained history, then removed its private home.
- **Evidence:** canonical owning suite-result ok:true/flaky:[]; final scoped suite and typecheck receipts; TERMINAL_MACOS_ARTIFACT_SMOKE_OK, TERMINAL_KILL_CONFIRMATION_SMOKE_OK, TERMINAL_SMOKE_CLEANED; D10 formal review scope/manifest.
- **Reversibility:** easy
- **Confidence:** high for exercised tests/API/process boundaries; no OS-native, paid-provider, visual-browser or all-platform qualification inferred.
- **Revisit if:** Canonical merged-result typecheck or later consumer evidence contradicts these checks.
- **Source:** locked by docs/loop/LOOP.md verification and landing

## Progress
Ready for canonical land. Complete owning gate98remote+5macOS passed with no retries; final pane-search fixture delta independently passed and final full typecheck passed. Scripts12/12 and real composed API/CLI smoke passed with private cleanup. Standard Google/Gemini review passed on its recorded pre-pane-search artifact; no review finding remains open. All workers, models, checks and runtime processes have returned. Commit final receipt/tests, detach, run the authoritative absolute queue.ts land and await its result before ending this iteration. Remove only owned temporary scratch after successful landing; inherited .serena remains untouched.
