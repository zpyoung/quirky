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

## Progress
First wave integrated: UI test-only component ebec3ad5 audited at unchanged HEAD9b68ce76 and merged; component worktree removed after preserving inherited .serena via path-only stash. af5fa2fc includes harness, routing and README. Real CLI/browser smoke passed with privateHomeRemoved:true. Typecheck passed (176.08s); scripts passed126/0/1101 assertions (277.55s; before the operator's remote-only note).

Canonical affected suite exited1 (275.75s): remote17files accepted after preferences-integration's one isolated timeout retry; local7files four passed, extras-api timed out once then passed isolated, extras-automation retained selectAll16→0 and network200→204 failures, import retained missing-confirmation failures and one load timeout/Chrome teardown error. No package-green claim.

Two bounded implementers at af5fa2fc: automation owns driver/extras-actions/extras-automation; import owns import.test only. Every worker skips checks; parent must run all further tests through bun scripts/suite.ts per operator note. No owned browser/app remains. Next: receive both, audit scopes/HEAD, integrate, check both files/package, actual selectAll smoke, catch up once/read decisions, final review, typecheck, canonical land.
