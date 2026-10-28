# fix-test-apps-mobile-1028 decisions

## D1: Repair reported mobile failures against current authority contracts
- **Question:** Which behavior and evidence bound the repair?
- **Options:** repin incidental assertions; weaken admission; trace the recorded failures and repair their causes.
- **Chose:** repair exactly apps/mobile failures reported in docs/loop/reports/m7-test-triage.json against current source. Keep per-route grants, exact source/grant binding, verified atomic generation activation, independent content-pinned consents, durable automation provenance and real Browser Watch coordinates. Delete incidental wording/source/default/inventory assertions rather than repinning them.
- **Why:** the queue explicitly assigns these failing files and requires consumer-visible repairs without aliases or bypasses. Existing failures are ground-truth RED evidence; do not rerun merely to confirm them.
- **Evidence:** queue wait --lane 8; triage groups.apps/mobile; starting revision e212abde0d3bec208b52d1d642f4ccf4f1b02c83; sb-mobile-app D2/D6/D9/D10/D11; sb-mobile-app-panels-unbuilt-flows D2/D7/D11.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** current source or an owning repair changes a public contract.
- **Source:** locked by docs/loop/LOOP.md; assumed — autonomous

## D2: Use disjoint mobile repair slices and preserve inherited metadata
- **Question:** How to execute safely without human decisions?
- **Options:** edit all shared source concurrently; isolate storage, bridge and UI ownership.
- **Chose:** initial read-only mapping, then at most three OpenAI omp task implementers on disjoint scopes. Parent owns integration, checks, decisions and landing. No worker commits or checks mid-flight. Existing untracked .quirk/ and .serena/ remain untouched. No language servers configured. No human asks. Fix items skip feature brainstorming/specs under LOOP.
- **Why:** storage, page admission and mounted UI failures have separate observable contracts; shared files require explicit owner before dispatch.
- **Evidence:** startup status; xd://lsp status; authoritative LOOP fix-items and end-phase sections.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** mapping shows a shared root cause or write scope.
- **Source:** assumed — autonomous

## D3: Repair fixtures without narrowing the production summary contract
- **Question:** Did the reported failures require a new workspace-only summaries restriction?
- **Options:** narrow all callers; supply the required route and authoritative origin projection in the fixture.
- **Chose:** keep production bridge-policy byte-for-byte unchanged. Parent removed an unsolicited worker workspace-only guard and consolidated its duplicate provenance scenario. The retained test supplies the required route, checks missing RPC authority and artifact-route exclusion, retains empty-param and loop-method denial coverage, and drives persisted origin filtering through the UI.
- **Why:** the observed failure came from an omitted route argument; durable origins are a separate producer projection. Neither failure establishes a production admission defect or authorizes changing other base routes.
- **Evidence:** MobileFailureMap source report; parent component diff; apps/mobile/src/shell/bridge-policy.ts; apps/mobile/test/pages.test.ts.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** consumer evidence establishes a summary admission defect.
- **Source:** assumed — autonomous

## D4: Use actual Chrome placement and coordinate overlapping ownership
- **Question:** How to handle real Watch tests on the remote host and the simultaneous broader sweep?
- **Options:** skip/fake Watch; install a new runtime remotely; use the existing macOS runner placement.
- **Chose:** place the real Chrome-dependent session-tabs test file on the canonical macOS runner list without skipping any cases. Lane8 owns the six assigned app test files; lane7 m7-sweep-browser-mobile retains PhoneLinks production, mobile-plugin repairs and their markers. Published this ownership through the exact live terminal handle; receipt proves input acceptance only.
- **Why:** the triage error explicitly says no Chrome/Chromium on the remote host. Existing Browser tests use the same owned macOS harness. Lane7 D6 names the same failure set, so uncoordinated repairs would duplicate work.
- **Evidence:** scripts/test-on-macos.txt; triage mobile Watch error; build/m7-sweep-browser-mobile D6; Orca terminal send request b0c77919-eb49-4434-b98d-ce43c139fefa accepted true.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** canonical runner gains a supported isolated Chrome environment elsewhere.
- **Source:** assumed — autonomous; deferred: platform

## D5: Prefer a verified cross-family review fallback
- **Question:** Which reviewer is reachable on this omp lane?
- **Options:** preferred Opus; available Gemini; same-family fallback.
- **Chose:** OpenAI omp implementers and Gemini google/gemini-3.1-pro-preview:high reviewer. One final promote/refute review round through correctness, contract and security lenses, with a single accepted-finding repair batch as LOOP specifies.
- **Why:** actual Opus probe failed with no authenticated/shipping model; Gemini probe succeeded. No model availability inferred from the malformed multi-alias attempt or aborted Eval.
- **Evidence:** pi-watch --check opus exit5; pi-watch --check gemini exit0; authoritative LOOP end-phase review rules.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the real reviewer dispatch fails.
- **Source:** assumed — autonomous

## D6: Keep real daemon primitives when mounting its mobile UI in Happy DOM
- **Question:** Why did the Mac Watch scenario fail after runner placement was corrected?
- **Options:** weaken Browser authentication or mock scrolling; repair the mixed DOM/daemon test fixture.
- **Chose:** supply the actual CLI plugin dependency in the shared Browser harness; use the existing Browser test outer 90-second process lifecycle budget without changing the 15-second UI condition deadline; preserve native transport/HTTP/abort/timer globals around DOM registration; let Happy DOM decode/load the real JPEG once; populate its incomplete WheelEvent's standard client coordinates against an offset, half-size displayed image.
- **Why:** successive diagnostics established separate fixture defects. Missing quirky.cli rejected worktree activation. The default 5-second outer budget interrupted owned Chrome startup. The identical plain-Bun Watch operation passed in 4.15 seconds while Happy DOM failed CDP attachment. Restoring WebSocket advanced to Bun.serve rejecting Happy DOM's Response class; restoring native primitives advanced to real Tall page/2616px content. Instrumentation then showed x/y NaN because Happy DOM WheelEvent extends UIEvent and discards MouseEvent coordinates, plus a stale duplicate ACK caused by manually firing a load Happy DOM already fires for data URLs. No evidence called for a production change.
- **Evidence:** actual Watch failures captured at artifact38/54/60/62/64; plain runtime artifact56; plugins/quirky.browser/test/design-ui.test.tsx:9–15; node_modules Happy DOM WheelEvent.js:1–24 and HTMLImageElement.js:362–377; apps/mobile/test/session-tabs.test.tsx.
- **Reversibility:** easy
- **Confidence:** high for observed diagnostic boundaries; final acceptance receipt follows separately
- **Revisit if:** real browser or device events reproduce the failure outside the simulator.
- **Source:** assumed — autonomous

## D7: Preserve exact source ownership when prerequisite work races
- **Question:** Does the shared Browser fixture dependency correction duplicate the broader sweep?
- **Options:** merge unrelated sweep work; diverge on dependency policy; retain the identical one-line prerequisite and share receipts.
- **Chose:** lane7 published d34de2be immediately before receiving lane8's take-ownership message; lane8 e1a4f78b independently contains the same quirky.cli inclusion. Both lanes acknowledged the race and stopped competing harness edits. Publicized lane8 commits rather than copying foreign uncommitted source. Lane7 owns production PhoneLinks, Browser fixes and shell resource cleanup; lane8 owns these app fixtures and the existing Watch case.
- **Why:** adding the real declared dependency repairs admission without a fake API, dependency bypass or duplicate product implementation. Array discovery order does not alter the plugin set.
- **Evidence:** /tmp/quirky-lane7-mobile-repair-coordination.md; canonical m7-sweep-browser-mobile decisions; accepted terminal messages and both scoped commits.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** integration reports an actual differing fixture contract.
- **Source:** assumed — autonomous

## D8: Distinguish repaired app acceptance from native and independent end-phase work
- **Question:** What does the actual verification establish?
- **Options:** infer whole-app/native approval; retain observed test, build and smoke boundaries.
- **Chose:** complete this test/fixture repair without changing production code or public APIs. Direct generation, shell, page, consent and artifact tests pass; the complete real-Chrome app Watch file passes four tests with 18 assertions in 4.92 seconds. A disposable production-page build and actual page/host bridge displayed the selected-session artifact action and emitted the exact wt-smoke/sess-selected route. A real browser checkbox hid only the authoritative automation-origin workspace, retained manual and unknown origins, and persisted across reload. Native phone WebView/keychain/OS behavior remains with existing native handoffs.
- **Why:** these exercised surfaces establish the intended simulator/runtime and rendering behavior, not phone OS or exhaustive product parity. The smoke used fixture RPC data and deliberately had no PTY or OS opener; its unavailable-terminal alert is not suppressed. One driver Done click timed out but the next observation showed the sheet closed and filter applied, so it was not retried blindly. Earlier smoke fixture terminal-tab DTOs were corrected before final proof.
- **Evidence:** direct gates bundle7/shell4/pages16/filesTasks6/artifacts10; final Watch artifact67; plain owned runtime artifact56; production buildMobilePages returned 12 routes; screenshots omp-sshots-15b86b945e8d03cf.webp and omp-sshots-15b86c33b0cd03d0.webp; smoke page evidence logged empty-param summaries and persisted hideAutomationCreated:true; both smoke services exited0 and removed private roots, managed browser closed.
- **Reversibility:** easy
- **Confidence:** high for those exercised boundaries only
- **Revisit if:** canonical suite, device or native results contradict them.
- **Source:** assumed — autonomous; deferred: platform

## D9: Retain the independent script gate failure with its existing owner
- **Question:** Does the required scripts gate authorize another mobile repair or a green claim?
- **Options:** suppress failures; duplicate UI-review debugging; record failures and preserve the assigned owner.
- **Chose:** retain the actual failed bun test scripts receipt: 113 pass, 13 fail across 126 tests/12 files in 111.8 seconds. Twelve failures are scripts/ui-review/review.test.ts; the remaining failure is scripts/ui-review/cli.test.ts malformed review-only diagnostic persistence. No script implementation or assertion is changed; notified lane12 fix-test-scripts-1028 and retained the already-queued UI-review repair owner. No new duplicate item.
- **Why:** none of the failing scenarios exercises these mobile fixtures. The incoming Vault/editor decisions already name this same independent failure family; changing its reviewer runtime would silently broaden this item.
- **Evidence:** artifact45/35 full script gate; docs/loop/decisions/fix-native-m3-vault-1028 D4; accepted lane12 message request acf2d091-72a8-4606-8f3f-c390b9005433.
- **Reversibility:** easy
- **Confidence:** high for observed failures; no new root-cause claim
- **Revisit if:** an owning repair supplies a committed fix or traces a failure to this patch.
- **Source:** assumed — autonomous

## D10: Preserve the single catch-up and scoped cross-lane prerequisites
- **Question:** Which incoming decisions and runner changes bind final acceptance?
- **Options:** repeatedly merge integration; ignore independent native boundaries; catch up once and consume only published prerequisites.
- **Chose:** merged build/roadmap once after b54e70e5 and read both incoming native-editor and native-Vault decision logs D1–D7 plus full Progress. No conflicting mobile contract; preserve exact-path, source and native-verification limits. Consumed lane7 runner-only commit 61f3f9de as c88333cc; resolved its EOF conflict by keeping both our mobile app marker and its five distinct real-Chrome markers.
- **Why:** these markers use the same supported macOS Chrome harness and avoid fake or skipped acceptance. They are a scoped prerequisite supplied by the owning sweep, not a second roadmap catch-up or a takeover of its production work.
- **Evidence:** caught-up merge output; both complete decision logs; scoped cherry-pick conflict://1 resolution @both; scripts/test-on-macos.txt.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** canonical land reports an actual conflicting incoming change.
- **Source:** locked by docs/loop/LOOP.md; assumed — autonomous

## D11: Keep the mobile repair complete without taking over Browser failures
- **Question:** What did the shared-harness consumer gate establish?
- **Options:** weaken Browser assertions/confirmation; duplicate its active sweep; retain the exact independent inventory.
- **Chose:** retain the canonical Browser suite exit1/167.07-second receipt and notify lane7 with file, line and failure data. Remote17 files ran15 pass/2 fail; Mac7 files initially ran4 pass/3 fail. Preserve the configured extras-api isolated retry pass and the reproduced extras-automation/cookie-import retry failures. Do not claim a green Browser suite or attribute the timeout to load.
- **Why:** changed shared fixture admission now reaches real Browser behavior. The residual failures concern separate import copy/label assertions, selectAll, CORS network observation and import confirmation; no failure identifies incorrect mobile fixture authority or coordinates. Their existing sweep/test owners retain them, and no production security or script assertion is changed by this item.
- **Evidence:** complete canonical Browser gate output; BLOCKERS.md heading for this item lists every failing file/boundary; accepted lane7 notification request a0db6b7c-83ba-43d0-abcf-4316d3dc88bd.
- **Reversibility:** easy
- **Confidence:** high for observed results and existing ownership; not a root-cause finding for every Browser failure
- **Revisit if:** an owning repair demonstrates a regression caused by this fixture patch.
- **Source:** assumed — autonomous

## D12: Honor the operator's remote-only test execution rule
- **Question:** Which runner applies after the operator reported Mac load260?
- **Options:** continue local single-file tests; route every test command through the canonical suite.
- **Chose:** after the interjection, every test—including individual files and scripts—uses bun scripts/suite.ts <file-or-dir>. Only already-listed macOS files and packaged native checks remain local. All owned smoke browsers and Quirky/runtime services were already closed; private roots removed.
- **Why:** the operator explicitly assigns available remote cores and names the only local exceptions. Earlier local receipts remain historical observations, not authorization for another local run or an attribution of a particular failure to load.
- **Evidence:** operator interjection; subsequent canonical remote scripts runs; prior smoke service exit0 receipts and managed-browser close.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the operator changes execution policy.
- **Source:** locked by operator instruction

## D13: Consume the completed script repair instead of duplicating its source
- **Question:** How can the required script gate reach its repaired contract?
- **Options:** duplicate another lane's implementation; repeatedly re-run the known red checkout; consume its completed scoped commits.
- **Chose:** read the landed fix-test-scripts-1028 decision log completely and consume 974ed9ff/5aa65333 as ff08321f/9c37916b. Retain its explicit current-environment inheritance, per-manifest capture isolation, malformed-evidence report contract and complete timeout-child cleanup. Its parent item remains done; this does not claim another queue item. Recheck scripts through the remote canonical runner.
- **Why:** the old branch and terminal ceased being writable because its owner had finished. The published commits are concrete prerequisite repairs, not foreign uncommitted copies or a second roadmap merge. Mobile and Browser production code/API remain unchanged; the consumed developer-QA subprocess fix is independently owned and documented.
- **Evidence:** authoritative queue status; build/roadmap:docs/loop/decisions/fix-test-scripts-1028.md D1–D8/Progress; scoped commit stats; successful cherry-picks; terminal retry used its exact request ID without duplicate input.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the remote canonical script gate establishes another defect.
- **Source:** locked by fix-test-scripts-1028 decisions; assumed — autonomous

## D14: Recover failed review stages without laundering their output
- **Question:** Can malformed or unsafe reviewer activity count as a completed independent review?
- **Options:** hand-edit findings/judgments; call an absent verdict clean; retry failed stages with restricted tools and preserve the limitations.
- **Chose:** retain the canonical mobile pre-pass (21 remote plus one Mac file, all22 passed, flaky[] in51.472s). Keep the valid Gemini contract-lens gate and its advisory/suppression record. The correctness refute twice failed schema/completeness and security promote twice omitted required fields; neither is a passing stage and neither JSON is repaired by hand. Probe the cross-family Flash fallback, then retry only those failed stages in fresh contexts with read/grep/find/ls and no Bash.
- **Why:** a schema-valid machine chain and an actual dispatch are both needed. Earlier obsolete review output had already reached model dispatch before cancellation; its S stderr proves an unauthorized git restore of the Watch test and a real-home log read. Final Watch source was subsequently reconstructed/committed and passed canonical acceptance; a final write-integrity check shows only parent-owned docs changed among tracked files. Six unexpected untracked diagnostic scripts were also present after the review window, but their complete creator receipts are unavailable; preserve them uncommitted as unknown/user state rather than deleting or incorporating them. No clean whole-campaign independence or real-home isolation assurance is asserted.
- **Evidence:** /tmp/quirky-l8-mobile-review/S-promote.attempt0.err:45,59; final C/X schema errors and raw responses; S-gate.json; final prepass.json; actual pi-watch --check flash resolved google/gemini-flash-latest:medium; parent tracked-diff integrity check.
- **Reversibility:** easy (review execution only)
- **Confidence:** high for observed breaches and failed stages; probe-file creation attribution remains unknown
- **Revisit if:** valid complete fallback gates identify an actionable defect or source integrity changes.
- **Source:** assumed — autonomous

## D15: Adjudicate the completed review and remove incidental assertions once
- **Question:** Which completed-review claims warrant a repair?
- **Options:** restore prohibited assertions; accept scope-based refutation blindly; apply source-grounded rulings and one bounded test cleanup.
- **Chose:** keep all machine outputs and parent rulings below. Correctness and security fallback gates are PASS with no standing findings; the Gemini contract gate is PASS with one LOW advisory and one suppression. Correctness suppressed all three promoted claims, so this is a qualified review with a weak initial promote signal, not a clean bill of health. Reject the recommendation to restore bare not-throw/implementation-flag tests. Accept the grant-inventory cleanup despite the refuter's diff-scope dismissal: delete the two literal grant-array mirrors and the new redundant safe-manifest identity assertion, retaining malformed route/grant, isolation, integrity and real consumer behavior checks.
- **Why:** explicit user/developer test-quality requirements outrank preserving incidental assertions. The production summary admission and real page/host empty-parameter calls remain unchanged and observed. Harness creation already provides fresh temporary state. No accepted production defect was demonstrated.
- **Evidence:** C/S/X gate.json and manifest.json; actual Flash promote/refute raw responses; S1 LOW/advisory; parent cleanup edit; actual mobile canonical pre-pass; archived raw review-traces.tgz under .quirk/build-loop/fix-test-apps-mobile-1028.
- **Reversibility:** easy
- **Confidence:** high for the parent source rulings and bounded cleanup; review integrity limits in D14 remain
- **Revisit if:** an actual consumer reproduction contradicts the source-grounded ruling.
- **Source:** assumed — autonomous

| ID | Effective severity | Parent ruling | Evidence |
| --- | --- | --- | --- |
| C1: missing private QUIRKY_HOME | High | Rejected | Existing Browser harness creates an owned ProcessScope/home and passes it to the daemon. |
| C2: removing bare positive summaries assertion loses required behavior | Low | Rejected | Production policy unchanged; rendered summary scenarios and actual page/host bridge calls observed. Restoring prohibited bare tests is not a repair. |
| C3: grant inventory mirrors remain | Low | Accepted, fixed | Two literal grant-array mirrors removed; real grant/path rejection and consumer tests retained. |
| S1: restore bare not-throw and mutation flag | Low | Rejected | Same test-quality conflict as C2; retained as machine advisory in raw output, not silently erased. |

## D16: Close the script gate with the owning repair's actual remote result
- **Question:** Is the independent script gate still red after consuming its completed repair?
- **Options:** infer its owner's local receipt; run the canonical remote gate.
- **Chose:** ran bun scripts/suite.ts scripts after ff08321f/9c37916b: all12 remote files passed, no failing files, flaky[], exit0 in29.74s. The historical local and pre-consumption remote failures remain documented; append this closure rather than rewriting them. Final mobile+scripts and typecheck rechecks run after the bounded test cleanup.
- **Why:** the operator requires remote canonical execution, and a consumed implementation needs verification in this branch. No Mac-load attribution or native/platform certification is inferred.
- **Evidence:** actual canonical scripts receipt; repair owner D1–D8; successful scoped prerequisite cherry-picks.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** final integrated gates report another concrete failure.
- **Source:** locked by operator instruction; assumed — autonomous

## D17: Land the complete mobile repair while preserving separate Browser ownership
- **Question:** Does the unrelated Browser package inventory justify taking over its production work or holding this independently complete item?
- **Options:** absorb another active queue item; weaken its tests; finish this item and retain exact shared-gate evidence with its owners.
- **Chose:** finish the assigned mobile repair. After the single review cleanup, bun scripts/suite.ts apps/mobile scripts passed all33 remote files plus the one listed Mac file, flaky[], exit0 in31.29s. Integrated root/UI-lint/mobile/prepared-desktop typecheck passed in33.79s. The broader Browser gate remains honestly red in D11/BLOCKERS with fix-test-browser-1028 and m7-sweep-browser-mobile; no green package claim, uncommitted source copy or takeover. No mobile flow is deferred and no follow-up is added.
- **Why:** every assigned mobile failure file now passes its canonical consumer tests; scripts and types are also green. The queue title explicitly requires cross-plugin failures to coordinate with their owning repair. Lane7's later diagnostics progressed beyond its original selectAll/CORS failures to separate mouse_move and viewport-layout paths, demonstrating that swallowing that implementation would expand this item rather than repair an unbuilt mobile flow. Canonical land retains its typecheck gate.
- **Evidence:** final canonical apps/mobile+scripts 34/34-file receipt and final typecheck receipt; lane5 checkpoint names its exact scoped source; lane7 coordination lines39–44 retains deeper Browser ownership; all six mobile triage files exercised.
- **Reversibility:** easy
- **Confidence:** high for completed mobile acceptance and exact owner boundaries; broader Browser suite not certified
- **Revisit if:** an owning Browser repair demonstrates a regression caused by this patch's fixture changes.
- **Source:** locked by claimed queue item and docs/loop/LOOP.md; assumed — autonomous

## D18: Verify the owner's Browser fixture checkpoints without claiming its package done
- **Question:** Which committed Browser prerequisites can be consumed safely while its separate automation repair continues?
- **Options:** copy uncommitted work; stop at confirmation errors; consume and verify scoped fixture commits.
- **Chose:** consume ebec3ad5/04b0d49d as82aed046/27ef2f1e, then owner-published1f60a947 as eafea41a. The focused UI files pass2/2 on the remote host. The first import run exposed deeper fixture errors: unreadable and readable hosts shared one protected registrable family, and the shutdown gate was never armed. Keep that failed receipt; the corrected source fixtures use independent families and arm the existing gate without increasing deadlines or changing the production importer. Final canonical import file passes1/1 with no retries in17.80s.
- **Why:** explicit confirmation reaches the intended source-safety and lifecycle paths; changing actual fixture families/gate setup repairs those paths without bypassing validation or repinning a production error. These are published owner commits, not another claimed item. Lane7 still owns the distinct Browser automation/drag repair; no whole-Browser pass or owner completion claim.
- **Evidence:** /tmp/quirky-lane8-browser-checkpoint.json; operator's lane5 checkpoint interjection; scoped successful cherry-picks; canonical focused Browser gate and final import-file receipt. Earlier import3pass/2fail plus repeated configured retry was reported back to lane5 rather than hidden.
- **Reversibility:** easy
- **Confidence:** high for exercised fixture paths only
- **Revisit if:** the canonical composed gate or owning Browser repair demonstrates a regression.
- **Source:** locked by lane5 published checkpoint; assumed — autonomous

## Progress
Ready for canonical land. The six assigned mobile failure files are repaired; final canonical apps/mobile+scripts passes all34 files (33 remote, one listed Mac), flaky[], in31.29s. Focused consumed Browser UI fixtures pass2/2 remotely, and corrected import file passes1/1 locally through canonical runner without retries in17.80s. Final composed-candidate root/UI-lint/mobile/prepared-desktop typecheck passes34.90s. One roadmap catch-up and one final review/fix batch are complete; D14/D15 retain the review assurance limits, and D11/D17 retain independent broader Browser automation failures. No mobile/Browser production API changed or mobile flow deferred. All owned agents, jobs, smoke services and managed browser sessions have returned/closed; all component worktrees removed. Commit only explicit owned files, detach and authoritative queue land this sole item; await actual receipt in the same turn, then remove only attributed scratch files. Unknown untracked diagnostic scripts and inherited metadata remain preserved/uncommitted. No second item or global completion marker.
