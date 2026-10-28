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

## Progress

Root-cause investigation complete to the available evidence boundary. No implementation or native pass is claimed. Block this item through the authoritative queue tool, preserving the branch as `blocked/fix-native-sa-browser-agent-1028`. Resume only with a compliant packaged native run using fresh owned state and mock-keychain, plus captured Chrome stderr/exit status and matching OS diagnostics. Do not reset C2-native-focus until a concrete repair is made; never alter production credential protection based on this investigation.
