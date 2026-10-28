# fix-test-packages-ui-1028 decisions

## D1: Repair the six triaged UI failures without restoring incidental implementation assertions
- **Question:** What is this fix item's scope and which requirements remain binding?
- **Options:** repin assertions to current CSS/wording; diagnose the six failing behaviors and preserve consumer-visible coverage
- **Chose:** diagnose gallery interactions, inherited terminal colors, Questions open/pending lifecycle, tall-dialog reachability and focused-window command routing
- **Why:** the queue title explicitly requires behavioral repairs and deletion rather than repinning source/default/inventory mirrors
- **Evidence:** docs/loop/reports/m7-test-triage.json, packages/ui group; baseline 97aaa12d; packages/ui/test/{gallery,terminal-theme,exit.e2e,layout-shell,routed-commands}.test.*
- **Reversibility:** easy (scoped repairs)
- **Confidence:** high
- **Revisit if:** diagnosis establishes an independently owned cross-plugin defect
- **Source:** locked by docs/loop/queue.json

## D2: Use OpenAI task implementers and the reachable Gemini reviewer
- **Question:** Which cross-family backend can review this omp lane's repairs?
- **Options:** opus; gemini; same-family fallback
- **Chose:** task implementers (OpenAI), gemini reviewer (google/gemini-3.1-pro-preview:high)
- **Why:** pi-watch --check opus returned exit5 (0/8 authed/shipping combinations); pi-watch --check gemini returned exit0 and verified the google model
- **Evidence:** reviewer probes from private /tmp/quirky-ui-repair24-zBftqB scratch
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** real reviewer dispatch fails
- **Source:** assumed — autonomous

## D3: Preserve inherited untracked state and coordinate shared-shell changes
- **Question:** How should this lane handle existing .serena/ state and lane9's active UI redesign?
- **Options:** stash unrelated files; preserve them untouched and fence implementer edits
- **Chose:** preserve .serena/ unchanged; message the ui-shell-slots lane before editing shared shell files
- **Why:** the inherited directory belongs to the user; shell redesign is an explicitly named coordination dependency, not permission for aliases or legacy shell restoration
- **Evidence:** initial git status only untracked .serena/; Orca terminal send request03a14067-fa43-4e40-9e6c-d0e31c822008 accepted by lane9 terminal term_5644447c-8166-45c9-97be-541bb54f670d (delivery not proven)
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** scopes overlap or lane9 reports a changed contract
- **Source:** assumed — autonomous

## D4: Preserve exact-window command authority rather than restoring obsolete focus fallback
- **Question:** Is SC-41's focus-inferred command target still the public contract?
- **Options:** restore focus fallback in the daemon; migrate the stale test to the landed explicit-window contract
- **Chose:** verify singleton compatibility, multi-window ambiguity refusal, exact connId delivery despite another window's latest focus, and stale-target refusal without rerouting
- **Why:** m7-terminal-provider-host-and-worktree-remainder D3 explicitly chose exact connId routes and refusal of ambiguous/missing/stale targets; the daemon implementation follows that decision
- **Evidence:** docs/loop/decisions/m7-terminal-provider-host-and-worktree-remainder.md:25-34; packages/daemon/src/plugins/layout.ts:449-465
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** an authoritative decision changes target selection
- **Source:** locked by docs/loop/decisions/m7-terminal-provider-host-and-worktree-remainder.md D3

## D5: Remove CSS and inventory mirrors; retain behavior checks and use real rendering evidence
- **Question:** Should tokenized dialog sizing and decorative menu glyphs force production changes?
- **Options:** replace tokens/decorations to satisfy exact source/text assertions; delete incidental mirrors and exercise the rendered controls
- **Chose:** delete literal dialog/overlay CSS assertions and gallery category inventory; make gallery lookup ignore aria-hidden decoration; preserve production styling and terminal theme lookup
- **Why:** the dialog already has tokenized viewport-bounded max-height and overflow-y:auto; Menu's decorative arrow is aria-hidden; happy-dom does not inherit custom properties as a real browser does. A mocked inheritance shim would only test forwarding and is not retained
- **Evidence:** packages/ui/src/styles.css:916-934; packages/ui/src/design-system/navigation.tsx Menu; packages/ui/src/terminal-theme.ts:10-19; real-browser proof remains required below
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** real Chromium shows a consumer-visible styling or inheritance failure
- **Source:** assumed — autonomous

## D6: Keep lane9's new shell intact during composition
- **Question:** Which overlapping UI contracts may this fix change?
- **Options:** restore old rails/toggles; preserve the new shell and compose only the scoped regression repairs
- **Chose:** preserve daemon-owned six slots, exact-window history/input/focus, eight-second truthful toast lifecycle, stable mounts and canonical pending-ask authority
- **Why:** lane9's explicit overlap handoff names App/MainArea/host/styles/layout-shell/toasts changes and no gallery/terminal-theme edits; no wait or dependency was requested
- **Evidence:** /tmp/quirky-ui-shell-lane9-overlap.md; user handoff during this iteration
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the catch-up merge exposes a concrete contract conflict
- **Source:** locked by lane9 overlap handoff

## D7: Keep anonymous Ask integration distinct from authenticated-session auto-open and delayed OS notification
- **Question:** Why do SC-31/SC-29's report predicates never become true, and should production be changed to satisfy them?
- **Options:** auto-open Questions for every anonymous CLI ask and notify immediately; preserve exact active-session attention and notification ownership, then update the integration setup
- **Chose:** anonymous CLI asks preserve the chosen view/panel, still update pending attention, and appear after explicit public panel-open; verify first-answer/second-pending and waiter completion through the real CLI/daemon
- **Why:** the fixture passes no authenticated session identity. registerAsk records a session-null ask; openQuestionsPanel deliberately refuses session-null auto-open. The feature doc scopes auto-focus to the focused pane and OS escalation to three unattended minutes. A test expecting immediate notification contradicts the notification owner
- **Evidence:** plugins/quirky.ask/main.ts:184-197,346-355; plugins/quirky.ask/README.md active-session behavior; plugins/quirky.ask/test/main-ui.test.ts; plugins/quirky.notifications/test/ask-escalation.test.ts; research/orca-features/ask.md Auto-focus and Unattended asks escalate
- **Reversibility:** medium
- **Confidence:** high for contract mismatch; the actor that sent the baseline CLI SIGTERM remains unobserved
- **Revisit if:** a real CLI/daemon run still exits143 after the unattainable panel predicate is removed
- **Source:** locked by research/orca-features/ask.md and docs/loop/decisions/m1-notifications.md D5

## D8: Verify the caught-up test-only repair and native CSS behavior without manufacturing a product change
- **Question:** What evidence establishes that these failures are repaired without a CSS/theme/routing workaround?
- **Options:** trust changed assertions alone; run isolated affected tests, canonical suite, integration gates and a real browser inheritance probe
- **Chose:** run the full canonical UI package suite, the five affected-file command, scripts, build and full typecheck; separately execute the existing theme reader inside native Chromium
- **Why:** all gates passed after the single catch-up. Native computed style and readTerminalTheme both return inherited ancestor colors #123456/#ddeeff/#abcdef under root-dark/system-light, and changing root appearance changes the base palette. No production ancestor traversal, focused-window fallback or sessionless attention steal is needed
- **Evidence:** canonical bun scripts/suite.ts packages/ui:28/28files,0fail,flaky:[],49.99s; affected-file review prepass exit0,17.941s; bun test scripts:126pass/0fail/1103assertions/12files,137.56s; bun run typecheck exit0,76.24s; bun run build exit0,52.20s; native Chromium probe rootdark background#16171b vs rootlight#ffffff with systemlight
- **Reversibility:** easy
- **Confidence:** high for exercised paths only
- **Revisit if:** merge-result typecheck or a later production/native acceptance flow fails
- **Source:** assumed — autonomous

## D9: Keep documentation, platform and native acceptance bounded to this test repair
- **Question:** Does a test-only repair require a new feature spec, product changelog entry or native status reset?
- **Options:** invent a product behavior change; document the repaired test contracts and leave native acceptance unchanged
- **Chose:** this decision log is the repair documentation; no new feature spec, product changelog claim, native scenario reset or new test/review follow-up item
- **Why:** no production code changed. Gallery inventory and literal CSS copies were incidental assertions, while meaningful CLI/daemon/window behavior remains tested. The five tests pass locally, with the existing React act/deactivation warnings and the deliberately canceled SC-31 pending waiter visible; no pristine-output claim is made. Linux/Windows and native OS UI were not exercised
- **Evidence:** five-file repair scope; local gallery5/theme3/routing8/CLI4 passing; incoming fix-test-scripts-1028, fix-test-packages-daemon-1028 and fix-native-sa-browser-agent-1028 decisions read in full and retained
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a real production behavior change becomes necessary
- **Source:** deferred: platform

## D10: Complete one bounded cross-family review without a speculative fix batch
- **Question:** Did the independent review identify an accepted defect in the five-file repair?
- **Options:** infer approval from silence; run actual promote/refute and deterministic evidence gates; invent additional repairs despite no finding
- **Chose:** one combined correctness/scope/process-ownership review, standard depth, Gemini cross-family promote and fresh refute; no fix batch because both returned actual empty JSON arrays
- **Why:** deterministic gate and manifest report PASS, zero findings/advisories/suppressed/contested/limitations/questions, full independence, and no excluded/unreviewed paths. The review is scoped to the five changed test files, not incoming other-lane changes or documentation rationale
- **Evidence:** .quirk/build-loop/fix-test-packages-ui-1028/review/{review.diff,resolve.json,prepass.json,model.json,promote.md,findings.json,claims.json,refute.md,refute.json,merged.json,gate.json,manifest.json}; promote102.87s; refute6.22s; hash69ce89dc8ab9a16c16471043db9db17f14898b613b09ea6240cf7ba3e3df070c
- **Reversibility:** easy
- **Confidence:** high for the bounded review result, not a completeness guarantee
- **Revisit if:** a later failure identifies an uncovered consumer behavior
- **Source:** assumed — autonomous

## D11: Preserve the guarded UI report's partial classifications and exact visible evidence
- **Question:** Do the real UI scenarios establish behavior, and which guard limits remain?
- **Options:** relabel partial reports as passes; repeat browser work without a supported viewport path; retain screenshots, CLI receipts and honest tool limits
- **Chose:** gallery dark/light scenarios pass; main dialog/anonymous-ask report remains partial for the guard's viewport/effect classification and native-notification visibility limits
- **Why:** at1280x720, screenshots show the100-line dialog scrolling from lines32-68 to66-100, exposing Confirm and then Confirmed via reachable action. The guard nevertheless classified scrolling NO_EFFECT and confirmation UNSETTLED, and has no supported640x480 setting. Anonymous asks preserved the chosen view, exposed two cards on explicit Questions-open, left the second after the first answer, and ended No pending questions; both genuine CLI waiters returned answered/exit0. No native OS-notification or640x480 pass is claimed. LOOP explicitly permits tool-caused partial results to be recorded rather than fabricated
- **Evidence:** .quirk/using-apps-like-a-user/runs/20261028T215550-993d/report.md and obs-7/9/11/12/13/15/17.png; gallery20261028T220547-701b/report.md and obs-5/8.png; .quirk/build-loop/fix-test-packages-ui-1028/smoke/ask-{one,two}.{log,exit}; parent directly inspected screenshots and receipts
- **Reversibility:** easy
- **Confidence:** high for visible/CLI evidence; bounded exactly as the reports state
- **Revisit if:** the guard supports a smaller viewport/effect classification or a genuine native notification scenario supplies contrary evidence
- **Source:** assumed — autonomous

## D12: Honor remote-only test execution and remove the last incidental initial-panel assumption
- **Question:** How should the operator's load directive and lane9's changed initial tools affect this repair?
- **Options:** rerun local Bun tests or pin the new initial panel; use the canonical remote runner and assert only the view/focus explicitly established by setup
- **Chose:** all test execution after the operator note uses bun scripts/suite.ts, including a single-file exit.e2e verification. Remove the initial panel:null assertion; compare the complete before/after layout to prove no stealing regardless of the profile's initial tool
- **Why:** the operator reports load260 and12active lanes. Lane9 independently opens canonical default tools; an empty initial panel is not this Ask test's contract. The final one-line deletion is the parent-adjudicated bounded fix after the reviewed snapshot, not a new production change or a claim of fresh cross-family review
- **Evidence:** operator note during this iteration; lane9 explicit ACK/overlap handoff; packages/ui/test/exit.e2e.test.ts SC-31 setup and unchanged-layout assertion
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the final remote file or merge-result typecheck fails
- **Source:** locked by operator directive and lane9 overlap handoff

## D13: Retain the final remote runner's load-dependent retry instead of claiming a clean first attempt
- **Question:** Did the final single-file remote check pass without retries?
- **Options:** hide the initial failure; widen waits or change unrelated fixture lifecycle speculatively; retain the runner's observed flaky classification
- **Chose:** record suite-result ok:true with flaky:["packages/ui/test/exit.e2e.test.ts"]
- **Why:** the first remote attempt hit a beforeEach/afterEach timeout at5688ms, then an undefined win.stop and subsequent already-open headless window errors. The canonical runner's automatic isolated retry passed4tests/34assertions in7.72s. This differs from the initial full28-file run, which passed with no flaky reruns. The final default-independent assertion is exercised; no conclusion about the original143 signal sender or a zero-flake final run follows
- **Evidence:** final bun scripts/suite.ts packages/ui/test/exit.e2e.test.ts output,36.31s overall; first1pass/3fail then4pass/0fail; suite-result ok:true/flaky list as above; retained .quirk/build-loop/fix-test-packages-ui-1028/final-remote-check.txt
- **Reversibility:** easy
- **Confidence:** high for exact runner results; no attribution of scheduling or timeout internals
- **Revisit if:** the test fails its isolated retry or a consumer-visible application failure appears
- **Source:** assumed — autonomous

## D14: Close every owned runtime before landing
- **Question:** What must remain alive or on disk after this item's proof?
- **Options:** leave browsers/daemon running; preserve reports but close owned runtime and remove throwaway assets
- **Chose:** both guarded browser sessions ended with kept_open:[]/cleanup_errors:[]; parent released/killed its managed probe browser; named private daemon service exited0 after stop plus PTY shutdown; runtime.json and pty.pid are absent. Remove the temporary served theme bundle and scratch after landing, retaining ignored review/smoke reports and receipts
- **Why:** the operator explicitly requires closing owned browsers/Quirky on this overloaded Mac. No real home/profile, unrelated application or native window was used or closed
- **Evidence:** guarded reports; proc://ui-repair24-smoke exit0; teardown-marker check exit0; CLI waiters both exit0; archived review/smoke receipts under .quirk/build-loop/fix-test-packages-ui-1028/
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** teardown evidence identifies an owned live child
- **Source:** locked by operator resource directive

## D15: Compose the concurrent shell landing after canonical land refused a conflict
- **Question:** How should the required land-retry merge resolve overlapping layout-shell tests?
- **Options:** restore the old DOM-order assertion; discard the redesigned shell; preserve lane9's behavioral tests and the shared deletion of incidental structural/source copies
- **Chose:** follow the canonical land failure route, merge roadmap again, and choose the incoming empty conflict side for the obsolete overlay DOM-order test. Keep all nonconflicting gallery/theme/Ask/exact-route repairs, including initial-tool-independent Ask setup
- **Why:** the first canonical land exited1 solely because lane9's shell had concurrently landed. Both lanes explicitly agreed to delete source/structure mirrors; .layout sibling order is not a consumer contract. This is the required failed-land retry, not an unsolicited repeated catch-up. Read all five incoming decision logs in full; preserve native clipboard window-local authority, PTY history/screen separation, agent-status OSC ownership, encrypted CLI targets, six slots, canonical Ask attention and exact-window view/history/input
- **Evidence:** first queue.ts land output; sole conflict packages/ui/test/layout-shell.test.ts overlay DOM-order test; incoming fix-native-m1-term-ui-1028, fix-test-agent-status-1028, fix-test-cli-1028, fix-test-packages-pty-host-1028 and ui-shell-slots decisions; lane9 explicit test-only ACK
- **Reversibility:** easy
- **Confidence:** high for the composition; post-merge gates remain required
- **Revisit if:** merged UI suite or typecheck establishes a real integration defect
- **Source:** locked by docs/loop/LOOP.md failed-land retry procedure

## Progress
Ready to land exactly this item. Five test files repaired without production changes; components committed and merged; one clean roadmap catch-up completed and incoming decisions read. Full canonical UI suite28/28/no flakes, scripts126/0/1103, typecheck/build exit0; bounded cross-family review PASS/no findings. Final one-line default-panel assumption deletion passed the remote single-file check on the runner's automatic isolated retry, with the initial hook-timeout flake retained in D13. Actual gallery pass and main dialog/Ask screenshot/CLI evidence retained with honest guard partial classifications (D11). All owned workers, reviewer jobs, CLI waiters, browsers and private daemon/PTY have stopped; temporary theme bundle removed. Commit final receipts, detach and use the canonical absolute queue.ts land. No second item, native acceptance reset, production workaround or hidden verification claim.
