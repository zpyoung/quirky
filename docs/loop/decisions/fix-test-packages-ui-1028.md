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
- **Why:** at the initial five-file stage, no production code changed. Gallery inventory and literal CSS copies were incidental assertions, while meaningful CLI/daemon/window behavior remained tested. The five tests passed locally, with React act/deactivation warnings and the deliberately canceled SC-31 pending waiter visible; no pristine-output claim was made. Linux/Windows native shells and OS UI were not exercised. D16–D19 record the later source-level shell-composition repair and its documentation.
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

## D16: Repair the seven real integration failures exposed by the concurrent shell cutover
- **Question:** Does the successful pre-cutover suite justify landing after the required retry merge's suite fails?
- **Options:** claim the former suite covers the new shell; restore old rails or widen deadlines; repair the evidenced composed failures in disjoint scopes
- **Chose:** three isolated source/test slices: stable active-view input and canonical focus; plugin-host/report/activity fixtures aligned to effective tools; new navigation/attention fixtures aligned to real plugin/API setup
- **Why:** post-merge typecheck passes32.91s, but canonical remote UI31files returns24pass/7fail. Failures include missing symlink destination, unknown repo method in incomplete fixtures, absent tools in legacy unit models, old auto-mounted sidebar assumptions, command/view synchronization and a real focus-only view remount. These are actionable integration findings, not permission to drop six-slot, exact-window or draft-retention behavior
- **Evidence:** .quirk/build-loop/fix-test-packages-ui-1028/composed-ui-failures.txt (complete6324-line remote output); seven files shell-navigation, shell-attention, plugin-host, layout-shell, sidebar-activity, plugin-host-unit and reports
- **Reversibility:** easy for fixture repairs; medium for active-view identity
- **Confidence:** high for observed failures; source diagnoses are verified before acceptance
- **Revisit if:** focused remote checks reveal another genuine owning path
- **Source:** assumed — autonomous

## D17: Preserve the active view's input identity and restore canonical tool focus
- **Question:** Why did the composed shell lose an active view's mount and fail panel-focus reporting?
- **Options:** suppress remounts for real input changes; memoize another history authority; render the canonical active-view input and reuse the existing focus region
- **Chose:** MainArea renders layout.view.input or its exact auxiliary route; viewTabs remain selection history. ToolShell's semantic aside uses useRegion('panel'), retaining the existing handler and HTMLElement ref contract
- **Why:** decoded history entries change object identity on focus/layout broadcasts, while the host preserves the active view's equivalent input identity. PluginSlot correctly remounts on actual input changes and must not be weakened. The new tool container lacked the old panel-region handler. Reusing the handler fixes both pointer and public focus paths without new state, aliases, casts or API changes
- **Evidence:** d364986e source slice; MainArea.tsx, ToolShell.tsx and useRegion.ts; existing layout-shell focus/DOM-retention regressions now pass; final guarded draft-retention proof D19
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual input changes stop refreshing content or a focus-only transition loses embedded state
- **Source:** supersedes fix-test-packages-ui-1028 D9 (initial test-only documentation boundary); locked by ui-shell-slots SC7

## D18: Build genuine trusted fixture clusters instead of weakening plugin admission
- **Question:** Why did adding declared dependencies alone leave the new shell fixtures broken?
- **Options:** allow reserved installed IDs or add method/settings fallbacks; load every provider; use a small genuine built-in root with all consumed owners
- **Chose:** optional builtinPluginsDir in the existing test helper, preserving one-argument callers; real repo/worktree/CLI/sidebar-extras/Ask owners in a tracked temporary built-in root. Navigation's view-only session fixture belongs to that trusted root. Ask registration uses the real worktree-bound CLI connection and requestId; key events carry their actual KeyK code
- **Why:** installed quirky.* IDs are correctly rejected by manifest admission. Worktrees consumes the sidebar-extras separator setting, so its real owner must be present. No production admission, method alias, setting fallback, timeout or session authority changes are justified. Listener teardown asserts no callbacks after unload, not the absence of legitimate transitions during unload
- **Evidence:** manifest.ts:266-267; WorktreesSection.tsx:34-38; window-env.ts options and existing callers checked after LSP references reported no server; shell-navigation/attention helpers; plugin-host-unit listener regression; canonical two-file check2/2/no flakes15.76s
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a fixture activates an unrelated provider or consumes another undeclared owner
- **Source:** assumed — autonomous

## D19: Require clean composed acceptance and an actual retained-draft surface before retrying land
- **Question:** Is the final source integration verified, rather than merely compiling or passing the old snapshot?
- **Options:** reuse the pre-cutover pass; disclose failed gates but stop; require repaired remote/UI evidence
- **Chose:** final remote packages/ui plus scripts gate43/43files,0fail,flaky:[],42.47s; full typecheck/UIlint/root/mobile/desktop exit0,47.26s; full build exit0,24.99s; fresh guarded draft-focus pass
- **Why:** the initial composition and intermediate failed gates remain recorded, but the final gate is clean. The real rebuilt six-slot UI retains draft-survives-tool-focus while opening Details, focusing its input and returning to the center. The last focus action was OBSERVED and screenshots show the retained input/status and selected view. Initial fill's NO_EFFECT classifier anomaly is retained in the report, not hidden. This is application web evidence, not native OS acceptance or a new formal cross-family review of the integration fix batch
- **Evidence:** .quirk/build-loop/fix-test-packages-ui-1028/final-remote-acceptance.txt; final typecheck/build outputs; .quirk/using-apps-like-a-user/runs/20261028T223645-5e22/report.md and obs-6/7.png directly inspected by parent; existing shell logic SC7 and technical mount/focus contract updated after the smoke
- **Reversibility:** easy
- **Confidence:** high for exercised composed paths; earlier viewport/native-notification limits remain D11
- **Revisit if:** canonical merge-result typecheck or a later consumer path fails
- **Source:** assumed — autonomous

## D20: Keep integration ownership and runtime cleanup explicit
- **Question:** How were continuation edits and final private proof resources bounded?
- **Options:** conceal reused worker state or leave owned processes alive; assign exact scopes and retain cleanup evidence
- **Chose:** initial three composition components were isolated, audited and merged, then their trees removed. The later two-file fixture continuation was explicitly reassigned to the parent tree after its old tree was removed; parent owned the other disjoint source/helper/unit edits. No isolated-tree claim is made for that continuation. Both old and fresh proof runtimes and every owned browser/worker/check are stopped
- **Why:** final focus browser report has no kept-open session or cleanup error; named ui-repair24-focus exited0 after daemon and PTY shutdown, with runtime.json and pty.pid absent. The initial proof has the same teardown receipts. No real profile, unrelated window, protected loop path or shared queue/index was edited manually
- **Evidence:** scope audits and component commits d364986e/08e88aae/bf21d6bf; explicit continuation assignment; final report state_left; service exit0 and teardown marker check; original user .serena untouched
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** an owned child or out-of-scope edit is identified
- **Source:** locked by operator resource directive

## Progress
Ready for canonical landing retry. Initial six failures repaired; required conflict merge b591f182 preserved the new shell, and all seven composed failures are now repaired. Source keeps canonical active-view input and tool focus; genuine trusted fixtures preserve reserved-ID admission and Ask ownership. Final remote UI+scripts43/43files/no flakes, full typecheck47.26s and build24.99s pass. Actual retained-draft six-slot UI proof passes; prior gallery passes, main dialog/Ask partial-tool limits and historical hook-timeout retry remain explicit. Existing shell logic documents mount/focus invariants. One bounded initial cross-family review was completed; integration fix-batch assurance is the real remote/typing/build/UI evidence, not a fabricated later review. All workers, browsers, CLIs and both private daemon/PTY services stopped; component trees removed. Commit final scoped changes/docs, detach and retry the canonical absolute queue.ts land. Remove owned scratch only after authoritative success; handle no second item.
