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

## Progress
Claimed one item on lane1; branch build/fix-test-packages-ui-1028 from c299501db714670a51a36d5bb5b6090cbf90bcf5. Root-cause mapping in progress. End phase is active; tests and real UI smoke are required. No human questions, protected loop/shared index edits or real profile writes.
