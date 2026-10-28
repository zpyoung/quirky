# fix-native-sa-browser-agent-1028 decisions

## D1: Treat the reported failure as a native Chrome launch/navigation prerequisite failure, not an observed focus regression
- **Question:** What failed in C2-native-focus, and which behavior can this item safely repair?
- **Options:** Change native/renderer focus; infer a Chrome startup flag from the macOS banner; trace the recorded prerequisite failure first.
- **Chose:** Trace the prerequisite failure. The native report says tab creation failed twice with `browser_tab_changed: owned browser CDP transport was lost`; Chrome exited and the fixture saw no request. Snapshot, fill, click, screenshot and subsequent focus-retention typing were not reached.
- **Why:** A simultaneous App Management banner is not causal evidence of why the Chrome process exited. Browser-agent tab creation does not invoke the hosted Browser pane or its native-webview focus implementation.
- **Evidence:** docs/loop/native/sa-browser-agent.json:6-11; /Users/zpyoung/orca/workspaces/quirky/native-qa/.quirk/using-apps-like-a-user/runs/20261028T055402-08cf/report.md:12-14; plugins/quirky.browser/src/runtime/driver.ts:524-559.
- **Reversibility:** easy
- **Confidence:** high for the failure boundary; underlying native exit cause unproven
- **Revisit if:** A compliant native run completes the browser operations and demonstrates a real focus change, or supplies a causal process-exit diagnostic.
- **Source:** assumed — autonomous

## D2: Preserve normal production credential protection and do not infer an unrelated Chrome flag repair
- **Question:** Should this item add mock-keychain or disable Chrome subsystems in production to hide the native failure?
- **Options:** Enable mock-keychain globally; add speculative component-update/Breakpad/code-sign-clone flags; retain production behavior and honor the scenario's safe test conditions.
- **Chose:** Retain production behavior. The scenario explicitly requires mock-keychain for its owned test Chrome, but the report states that flag was absent. Existing trusted test dependencies inject the flag; production intentionally does not. No product code or native scenario status is changed.
- **Why:** sa-browser-agent D30 locks ordinary production credential protection and limits what mock-keychain proves. sb-mobile-app-prerequisites D12 independently records a default-versus-mock navigation difference without proving its OS cause. Disabling native focus, changing timeouts, suppressing transport loss, or weakening credentials would not repair an evidenced cause.
- **Evidence:** docs/loop/decisions/sa-browser-agent.md D30; docs/loop/decisions/sb-mobile-app-prerequisites.md D12; plugins/quirky.browser/src/runtime/chrome.ts:100-120; plugins/quirky.browser/test/harness.ts:103-116; original native report.md:14. Chrome's upstream code-sign clone manager describes best-effort background cloning, not evidence of this run's exit: https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/mac/code_sign_clone_manager.h .
- **Reversibility:** easy
- **Confidence:** high for the safety decision; low for any particular OS-cause hypothesis
- **Revisit if:** Captured native Chrome stderr, exit status, crash report or matching OS denial identifies a concrete product defect.
- **Source:** locked by docs/loop/decisions/sa-browser-agent.md D30

## D3: Bound the completed smoke evidence to safe owned-process startup, helper attachment and tab operations
- **Question:** What can be exercised without reusing the user's browser profiles or Keychain, or claiming native acceptance?
- **Options:** Repeat the unsafe default launch; rely on source alone; run the existing runtime launch boundaries with a fresh ProcessScope and the prescribed test argument.
- **Chose:** A throwaway smoke used real `startChrome`, `startNativeHelper` and `nativeRequest`, trusted constructor `chromeArguments: ['--use-mock-keychain']`, fresh profile/HOME/QUIRKY_HOME, owned subprocesses, and inherited stderr for diagnostics. It started Chrome and agent-browser 0.27.0, received `tab_new` success with helper tab `t2`, and evaluated `document.title` successfully on about:blank. Helper close, Chrome close and ProcessScope cleanup completed; the temporary home was removed.
- **Why:** This establishes the safe launch/attachment boundary works in this shell. It does not exercise packaged-app TCC attribution, fixture navigation, the CLI, real native focus, or production default-keychain launch.
- **Evidence:** Lane12 isolated probe stdout: DevTools listening on owned loopback port; chromeReady PID46387; helperReady PID46430; tabNew success:true tabId:t2; evaluate success:true result:""; ownedCleanupDone /var/folders/x5/07kj5yld16l9wd5p_v01h20c0000gp/T/quirky-test-home-eUP65Q. Chrome also printed CVDisplayLink warnings and the helper printed an allocator warning; no causal native-exit claim follows from those.
- **Reversibility:** easy
- **Confidence:** high for the exercised boundary only
- **Revisit if:** A compliant packaged native run identifies a difference at the launch, navigation, transport or focus boundary.
- **Source:** assumed — autonomous

## D4: Block rather than manufacture a production fix from missing native diagnostics
- **Question:** Can this item finish safely with the available evidence and the build-first prohibition on native dogfood passes?
- **Options:** Land a guessed product change and reset the scenario; label a shell smoke native acceptance; block the item with the exact missing prerequisite.
- **Chose:** Block the item. Keep C2-native-focus at `fail`, preserve its historical report, author no speculative regression test, and make no product change. No suites, review rounds or native dogfood runs were started. This is an investigation-only item, so no typecheck/landing pass is claimed.
- **Why:** The saved native run has no Chrome stderr/exit-code/crash artifact, its test Chrome omitted the required mock-keychain argument, and the targeted OS log query returned no records. The safe shell probe cannot supply the absent packaged-app causal evidence. A repeat native focus test must first use the prescribed isolated test Chrome and capture its launch diagnostics; the controlling build-first policy postpones that native dogfood pass. All reachable read-only evidence and the safe process-boundary probe are complete.
- **Evidence:** Original run directory contains report/run/event files and screenshots only; targeted `/usr/bin/log show` for 2026-10-28 05:54:00–06:00:00 UTC, tccd/Google Chrome/syspolicyd and quirky/Chrome/AppManagement returned only the header; docs/loop/LOOP.md Build first, test at the end; D1-D3 above.
- **Reversibility:** easy (resume the preserved blocked branch when causal evidence is available)
- **Confidence:** high
- **Revisit if:** A compliant native rerun supplies the missing diagnostics, or native verification is explicitly authorized and available outside the postponed dogfood phase.
- **Source:** locked by docs/loop/LOOP.md

## D5: Exercise default credential protection only, without calling the rerun production-equivalent
- **Question:** What changes when this requeued end-phase item explicitly permits packaged native reruns and forbids mock-keychain as a replacement for production protection?
- **Options:** Repeat the previous mock-keychain smoke; run ordinary Chrome against the real login environment; preserve ordinary Chrome arguments inside an OS-enforced disposable diagnostic boundary.
- **Chose:** Build the packaged app and run its exact Chrome executable with the unmodified production arguments. A temporary diagnostic-only change at `productionSpawn` inherited stderr and recorded command/PID/exit/signal. It did not insert a wrapper executable, mock-keychain, password-store override, no-sandbox, GPU flag, or production behavior change. Remove that instrumentation after evidence collection.
- **Why:** The updated queue title authorizes the native attempt but does not authorize touching real credentials. D2's test-only mock-keychain recipe cannot establish production-default behavior. The safety sandbox is an explicit experimental confounder, not an equivalent production environment.
- **Evidence:** Queue item title; D2/D30 above; `.quirk/build-loop/fix-native-sa-browser-agent-1028/attempt4/logs-before-cleanup/daemon.log:3-36`; `plugins/quirky.browser/src/runtime/defaults.ts` restored to its original snapshot B6B5.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A production-equivalent disposable native login and Keychain become available.
- **Source:** supersedes fix-native-sa-browser-agent-1028 D2 (rerun recipe only; production protection remains unchanged)

## D6: Preserve the failed harness attempts and the actual safety incidents
- **Question:** Which early observations belong to this item, and did the first harness preserve its intended isolation?
- **Options:** Treat every Quirky window as owned; omit the failed attempts; stop on identity mismatch and preserve the exact limits.
- **Chose:** Stop guarded run `20261028T213902-42f3` when its bundle selector resolved to another Quirky process, not the run-owned native PID. One guarded foreground window click occurred before the mismatch was visible; no later task action was performed on that target. Its goal is blocked, not a native pass. Use exact PIDs for subsequent read-only native diagnostics.
- **Why:** `dev.quirky.app` was ambiguous: run-owned native PID38293 had no bundle ID, while the selected process41020 had that bundle ID. Its tree had no repositories despite successful run-owned CLI setup. The guard also automatically copied system clipboard text during `begin`, contrary to this scenario's no-clipboard condition. The agent did not read or print that content; it deleted the run-owned `clipboard.txt` without reading it and verified removal. Do not run that guard again for this scenario without a no-clipboard path.
- **Evidence:** Guarded report `.quirk/using-apps-like-a-user/runs/20261028T213902-42f3/report.md`; observations1/2; `orca computer list-apps` and PID metadata; guard `_begin_bind` lines1084-1092; deletion receipt `savedClipboardRemoved:true`.
- **Reversibility:** medium (the observed foreground/clipboard access cannot be undone by a passing later run)
- **Confidence:** high for the observed mismatch and deleted capture; no claim about effects in the other application's state
- **Revisit if:** The native guard supports explicit PID pinning and no-clipboard intake.
- **Source:** assumed — autonomous

## D7: Keep shell-launch and sandbox failures separate from the original native Chrome failure
- **Question:** Did the diagnostic harness reproduce the original packaged-app failure with an attributable cause?
- **Options:** Attribute every transport failure to the original App Management banner; weaken Chrome's security until navigation succeeds; retain the concrete diagnostic cause and its confounders.
- **Chose:** Retain the confounders. The first OS policy denied local transport. Early CLI invocations were mistakenly outside that sandbox and could start detached daemons against the run-owned database; their Chrome/Keychain isolation is not established. No real credential mutation was observed or exonerated. Subsequent CLI processes ran inside the same sandbox with an invalid daemon-entry override so they could not silently autostart a replacement.
- **Why:** The corrected policy permits loopback and Unix sockets while denying non-loopback traffic, `/usr/bin/security`, declared real credential/profile paths, securityd lookups, and writes under `/Applications`. The corrected attempt has a public CLI `ui.state` response with a live renderer and two registered owned folder projects. That is CLI/setup evidence, not a focus pass. The native PID-bound screenshot remains blank and its coordinate action refuses `window_not_focused`.
- **Evidence:** `.quirk/build-loop/fix-native-sa-browser-agent-1028/{cli.jsonl,attempt2/cli.jsonl,attempt3/cli.jsonl,attempt4/cli.jsonl}`; attempt2 `owned-window-startup-error.png`; attempt4 `pid-bound-blank-window.png`; initial network-policy probe rejected numeric host syntax, explicit localhost policy admitted a live health response, and Unix-socket allowance restored the daemon CLI. Attempt4 `safety-probe.json` records security execution refusal126.
- **Reversibility:** medium (early child-isolation gap is historical; no blind Keychain cleanup is safe)
- **Confidence:** high for the later enforced boundary; uncertain early default-Chrome credential access
- **Revisit if:** Independent state evidence establishes the early child behavior, or a safer native process boundary is supplied.
- **Source:** assumed — autonomous

## D8: The captured SIGTRAP is a nested-sandbox failure, not a proven repair target
- **Question:** What do the new default-Chrome stderr and exit records establish?
- **Options:** Disable Chrome's sandbox/GPU/credential protection; infer the original App Management denial caused the crash; stop at the evidenced diagnostic boundary.
- **Chose:** Stop at the boundary. Exact production-default Chrome PID87629 publishes DevTools, repeatedly reports `sandbox initialization failed: Operation not permitted` and GPU/network-service crashes, then fatally reports `GPU process isn't usable. Goodbye.` and exits133/SIGTRAP. The helper exits0 after attachment fails; the CLI reports `browser_unavailable`, not the original run's later CDP-transport-loss message. The fixture receives no request.
- **Why:** Chrome's own child-sandbox initialization is incompatible with this external safety sandbox. Disabling that protection would change the required security model. The scoped TCC log also attributes the directly launched native Bun process to Orca Terminal Host, not the original report's Quirky attribution. Neither failure is evidence identifying the original production exit cause.
- **Evidence:** `.quirk/build-loop/fix-native-sa-browser-agent-1028/attempt4/logs-before-cleanup/daemon.log:3-36` (exact arguments, stderr, fatal and exit); `attempt4/os-log.txt` (TCC responsible/requesting identities); `attempt4/cli.jsonl` (scoped create failure); fixture-request file absent at collection.
- **Reversibility:** easy
- **Confidence:** high for the captured diagnostic cause; original native cause remains unproven
- **Revisit if:** A default-Chrome rerun under production-equivalent packaged LaunchServices attribution and an isolated login/Keychain supplies a different causal diagnostic.
- **Source:** assumed — autonomous

## D9: Reblock with the narrower native-environment prerequisite, not a speculative product change
- **Question:** Can the reported C2 failure be safely repaired and verified after these attempts?
- **Options:** Land guessed flags or focus changes; reset the native scenario based on the harness result; preserve evidence and reblock this same item.
- **Chose:** Reblock the item. Preserve C2's historical `fail` and report, leave production code unchanged, and require a disposable native login/Keychain or equivalent demonstrated isolation that permits normal Chrome child sandboxing and production-equivalent packaged-app attribution. Do not substitute mock-keychain, `--no-sandbox`, permissive credentials, or an unrelated focus repair.
- **Why:** The end-phase authorization removes D4's phase prohibition, but not the remaining safety/evidence prerequisites. No actual editor focus/typing or browser snapshot/fill/click/screenshot was reached. The original cause has no failing regression to repair. Investigation-only work does not justify a fabricated regression, suite pass or review claim.
- **Evidence:** D5-D8; all four owned-run cleanup receipts have `homeRemoved:true,appExit:0`; all supervised services exited0 after stop; both scouts returned. Temporary spawn instrumentation was restored exactly and the diagnostic runner removed. A final clean-source packaged rebuild is recorded in Progress.
- **Reversibility:** easy (resume the same item once the prerequisite exists)
- **Confidence:** high
- **Revisit if:** The stated native isolation/attribution prerequisite becomes available.
- **Source:** assumed — autonomous

## Progress

End-phase rerun attempted; original product cause remains unproven. Preserve this branch through the canonical queue block operation. Default Chrome diagnostic stderr/exit now exists but proves an external nested-sandbox/GPU SIGTRAP, not the original App Management cause. A production-equivalent disposable native login/Keychain and packaged LaunchServices attribution are required. C2 remains fail; no product or permanent-test change, native acceptance, regression/suite/typecheck/review pass, or landing is claimed. The temporary spawn diagnostic was restored to original B6B5; all run-owned services ended and homes were removed. `bun run build` on restored source exited0 in21.98seconds, rebuilding UI and the packaged app without instrumentation. Guarded report says it kept the ambiguous preexisting `dev.quirky.app` open; it was not ours to close. No owned window/service remains, and no private native permission or credential change was made.
