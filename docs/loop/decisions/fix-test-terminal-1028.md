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

## Progress
All two-wave implementers returned and scoped diffs contain only assigned test files. Production terminal/host code remains unchanged. Mac-bound scenarios3/3, destructive lifecycle2/2, scripts12/12 and explicit status/alert refusal scenarios2/2 pass canonically. Real isolated daemon/API/CLI artifact save and confirmed kill smoke passed with cleanup. Initial whole terminal run failed21remote files plus the macOS paste fixture; integrated UI/window regression run is pending. Typecheck passed54.41s. Parent corrected remaining Quick Commands dialog aria-label lookup and keyboard event origin after source inspection. Next catch up roadmap once, read incoming decisions, run final full owning suite/typecheck and bounded review, record results, commit/detach and land this item only.
