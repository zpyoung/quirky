# fix-test-browser-1028 decisions

## D1: Repair the recorded browser failures without changing public contracts
- **Question:** What is the scope of this unattended fix item?
- **Options:** Repair the recorded browser flows; widen into other plugins; suppress failed tests.
- **Chose:** Trace and repair all six recorded browser test files, preserving behavioral assertions and private process homes.
- **Why:** The canonical queue assigns these failures to lane 5; other areas have independent repair owners.
- **Evidence:** docs/loop/reports/m7-test-triage.json, groups.plugins/quirky.browser; queue item fix-test-browser-1028.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Evidence identifies a shared prerequisite owned by another repair.
- **Source:** locked by docs/loop/LOOP.md

## D2: Use omp implementers and the reachable Gemini reviewer
- **Question:** Which backend pairing can execute this end-phase repair?
- **Options:** omp with Opus review; omp with Gemini review; same-family fallback.
- **Chose:** omp OpenAI task implementers with Gemini review, one final round and one fix batch.
- **Why:** pi-watch --check resolves Gemini but reports Opus and Sonnet unavailable; no human decisions are permitted. Preserve inherited untracked .serena/ without touching it; isolate implementers outside this worktree.
- **Evidence:** This iteration's pi-watch --check output: 7/12 aliases ready, gemini google/gemini-3.1-pro-preview.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The selected reviewer cannot complete its attempted review.
- **Source:** assumed — autonomous

## D3: Route the four real-Chrome integration files to macOS
- **Question:** Why do browser extras and import tests report browser_unavailable on the remote suite host?
- **Options:** Install browser infrastructure on Linux; replace real-browser tests with mocks or skips; extend existing macOS routing.
- **Chose:** Add extras-api, extras-automation, extras-cli and import test files to scripts/test-on-macos.txt, retaining every real browser scenario.
- **Why:** The runtime's default candidates are macOS application executables. The remote Linux host has no Chrome, and the existing routing already keeps automation, pane, design-runtime and editor PDF scenarios on the installed Mac Chrome. The locked platform is macOS; no product fallback or test skip is needed.
- **Evidence:** plugins/quirky.browser/src/runtime/chrome.ts:34-59; plugins/quirky.browser/test/harness.ts:107-116; docs/loop/reports/m7-test-triage.json, browser groups; scripts/test-on-macos.txt.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The project provisions an owned Linux Chrome and chooses to support these integration scenarios there.
- **Source:** deferred: platform

## D4: Preserve import behavior tests without pinning presentation copy
- **Question:** Are the two import UI failures broken behavior or incidental assertions?
- **Options:** Change the product's copy; repin the exact literals; remove copy assertions and retain behavioral checks.
- **Chose:** Remove copy-only expectations; select Browser Settings by its semantic accessible name with punctuation tolerance, and assert its actual command execution. Retain captured destination identity in the confirmation body and exact import request.
- **Why:** The panel renders lowercase managed Chrome and an ellipsis-suffixed settings label. Neither changes import behavior. Discovery runs only when the parent explicitly opens the panel, so the scout's initial eager-detection hypothesis was rejected rather than changing the correct lifecycle.
- **Evidence:** plugins/quirky.browser/test/cookie-import-window.test.tsx; plugins/quirky.browser/test/preferences-window.test.tsx; plugins/quirky.browser/src/preferences-window/CookieImportPanel.tsx:117-128,325-330.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Behavioral verification exposes a real lazy-detection, recovery or routing defect.
- **Source:** assumed — autonomous

## D5: Install the real Worktrees dependency in the browser harness
- **Question:** Why did this iteration's real browser smoke reject tabCreate as unknown before reaching Chrome?
- **Options:** Add the declared plugin dependency to the fixture; bypass plugin validation; weaken browser calls.
- **Chose:** Add quirky.cli to the browser harness's real built-in plugin set.
- **Why:** plugin.list showed Worktrees invalid because quirky.cli was not installed, cascading invalidation to Browser, Editor, Session and Terminal. The updated Worktrees manifest declares this dependency. No production API, alias or registry bypass is needed.
- **Evidence:** Actual smoke first failed unknown method quirky.browser/tabCreate; registry diagnostic dependency quirky.cli is not installed; plugins/quirky.worktree/quirky-plugin.json:12-15. After the fixture edit, the same smoke exited 0 in 4.59s: CLI import exit0/one imported cookie, exact cookie value read back, isolated profile contained no imported cookie, literal Unicode @file input preserved, four owned launches, privateHomeRemoved:true.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Worktrees changes its declared dependency set.
- **Source:** assumed — autonomous

## D6: Authorize intended destructive test calls rather than bypass confirmation
- **Question:** Why did the old import scenarios report confirmation errors instead of downstream import results and validation errors?
- **Options:** Disable production confirmation; authorize the fixture's intended calls; weaken expected import failures.
- **Chose:** Add explicit yes:true to importCookies/importStart fixture requests, including traversal, malformed source and injected rollback cases. Retain their exact storage safety outcomes.
- **Why:** The dispatcher correctly checks destructive consent before plugin validation; these scenarios target import behavior after consent. Other browser API/CLI scenarios already grant explicit consent. Incidental warning inequality and opaque job-ID format checks were removed, not repinned.
- **Evidence:** First canonical affected suite's import.test.ts failure output; plugins/quirky.browser/test/extras-api.test.ts:37-44; scoped import component 04b0d49d.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Authorized real-browser scenarios expose a production import failure.
- **Source:** assumed — autonomous

## D7: Consume lane 7's automation repair instead of competing with its writer
- **Question:** How should the overlapping selectAll/CORS failure repair be owned after lane 8's coordination message?
- **Options:** Continue a competing patch; consume a committed scoped patch from lane 7.
- **Chose:** Stop the duplicate automation implementer before any edits and request lane 7's committed checkpoint. Publish the UI/consent checkpoints for lane 8's affected gate.
- **Why:** Lane 8 identified lane 7 as the existing owner of these fixes. Our worker returned zero changed files; its diagnosis pointed to native-helper Meta+A bypassing the driver's macOS edit-command path and a possible preflight ordering assumption.
- **Evidence:** Operator coordination interjection; stopped BrowserAutomationFix output; /tmp/quirky-lane8-browser-checkpoint.json; Orca terminal send request a2a9e023-649d-42b8-a993-df3a88b49682 accepted (delivery unproven).
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Lane 7 reports it cannot provide the repair.
- **Source:** assumed — autonomous

## D8: Preserve incoming bindings after the single roadmap catch-up
- **Question:** Do newly landed decisions conflict with this repair?
- **Options:** Preserve the incoming contracts; diverge locally.
- **Chose:** Preserve them; no conflict found.
- **Why:** Read all four incoming logs in full through BrowserIncomingBindings: fix-test-agent-status-1028, fix-test-cli-1028, fix-test-packages-pty-host-1028 and ui-shell-slots. They retain private homes, explicit consent, canonical plugin ownership and bounded browser/native evidence. None changes cookie import semantics.
- **Evidence:** Single git merge build/roadmap after 3449a994; BrowserIncomingBindings completed report.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Landing brings a concrete conflicting contract.
- **Source:** locked by docs/loop/LOOP.md

## D9: Repair the importer fixtures rather than weaken family safety or extend deadlines
- **Question:** Why did authorized Chromium import still import zero cookies and the shutdown scenario hang?
- **Options:** Weaken whole-family exclusion; repin zero imports/increase deadlines; correct the synthetic family layout and arm its barrier.
- **Chose:** Put unreadable source cookies in independent example.org/example.net registrable families, retain decryptable example.test, assert the reported family rather than host, and set blockedSet to new-a before starting the shutdown job.
- **Why:** All original Chromium hosts shared the registrable example.test family, so exclusion was correct. The shutdown fixture awaited enteredBlockedSet without ever setting blockedSet, so no write could announce the barrier. No production importer changes or timeouts were necessary.
- **Evidence:** Canonical import file check after consent:3pass2fail twice (29.20s), mismatch reasons unreadable-partition-family/unsupported-encryption and timeout5000ms. Scoped component1f60a947 fixes only import.test.ts; canonical check then accepted1/1file0retries in16.58s. Traversal, partition, Google exclusion, source-byte preservation, rollback and shutdown cancellation assertions retained.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A correctly separated readable family is skipped or an armed write barrier fails to settle.
- **Source:** assumed — autonomous

## Progress
First wave integrated: UI test-only component ebec3ad5 audited at unchanged HEAD9b68ce76 and merged; component worktree removed after preserving inherited .serena via path-only stash. af5fa2fc includes harness, routing and README. Real CLI/browser smoke passed with privateHomeRemoved:true. Typecheck passed (176.08s); scripts passed126/0/1101 assertions (277.55s; before the operator's remote-only note).

Canonical affected suite exited1 (275.75s): remote17files accepted after preferences-integration's one isolated timeout retry; local7files four passed, extras-api timed out once then passed isolated, extras-automation retained selectAll16→0 and network200→204 failures, import retained missing-confirmation failures and one load timeout/Chrome teardown error. No package-green claim.

Both second-wave workers returned and passed HEAD/scope audits. Automation stopped with zero writes for lane7 ownership; import04b0d49d integrated. Reused import worker at unchanged cf8645f returned only test/import.test.ts changes;1f60a947 integrated. All component worktrees removed after preserving inherited .serena in path-only stashes; parent metadata untouched.

Single roadmap catchup complete with all4incoming decision logs read. Fresh canonical remote UI+scripts14/14files passed0retries30.98s. Canonical import1/1file passed0retries16.58s. Shared lane8 checkpoint contains committed UI/consent/family/gate changes. Consumed lane7 scoped5e57ad16 as c580694c: selectAll/macOS edit commands and helper pointer fields, fixture CORS/viewport corrections. Lane7's published proof is4pass1fail with remaining drag action, so no final browser-green or review yet. Await its next committed helper repair without duplicating source work, then canonical browser package, final review/typecheck and canonical queue land. All future tests use suite.ts; no owned browser or app remains running.
