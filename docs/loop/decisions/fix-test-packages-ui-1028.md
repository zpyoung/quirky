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

## Progress
Claimed one item on lane1; branch build/fix-test-packages-ui-1028 from c299501db714670a51a36d5bb5b6090cbf90bcf5. Root-cause mapping in progress. End phase is active; tests and real UI smoke are required. No human questions, protected loop/shared index edits or real profile writes.
