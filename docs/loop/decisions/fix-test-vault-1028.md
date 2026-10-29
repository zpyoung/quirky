# fix-test-vault-1028 decisions

## D1: Repair the three recorded vault acceptance failures without repinning incidental assertions
- **Question:** Which failures and contracts govern this unattended fix item?
- **Options:** Repin presentation wording and defaults; trace and repair consumer-visible behavior while deleting incidental assertions.
- **Chose:** Trace the recorded SC-08, SC-15/16 and real-host acceptance failures; preserve meaningful identity, redaction, availability and recovery checks.
- **Why:** The queue explicitly requires consumer-visible repairs and deletion of incidental wording/source/default/inventory mirrors.
- **Evidence:** docs/loop/reports/m7-test-triage.json, groups plugins/quirky.vault; plugins/quirky.vault/test/window-parity.test.ts; plugins/quirky.vault/test/flows.test.ts.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Current evidence identifies an additional defect at the same contract seam.
- **Source:** locked by docs/loop/LOOP.md

## D2: Isolate implementation and use a reachable cross-family reviewer
- **Question:** How should implementation, review and private state be isolated?
- **Options:** Modify inherited metadata; preserve it and scope all owned work explicitly. Use unavailable Opus; use reachable Gemini.
- **Chose:** Preserve inherited untracked .serena unchanged; use explicitly scoped omp task implementers and Gemini review after green verification. No person is asked anything.
- **Why:** Opus probe returned no authenticated shipping model; Gemini probe resolved google/gemini-3.1-pro-preview:high. No language servers are configured, so code navigation uses repository search.
- **Evidence:** pi-watch --check opus exited 5; pi-watch --check gemini exited 0; xd://lsp status reported no configured servers.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The reviewer fails at dispatch.
- **Source:** assumed — autonomous

## D3: Repair fixture boundaries before changing product contracts
- **Question:** Which current failures require product changes?
- **Options:** Relax search limits or expose fallback methods; restore curated dependencies and wait for the intended asynchronous state.
- **Chose:** Add the real quirky.cli prerequisite to curated vault fixtures; fix scoped UI selectors, actual failure barriers and valid term-limit input. Keep the 512-character public query bound.
- **Why:** The actual private registry marks worktree invalid because quirky.cli is absent, invalidating session/terminal/vault. SC-08 matched preparing-results Retry before the debounced search failed. SC-15 passed 760 characters to an API that rejects more than 512 before engine truncation. Global status/menu-wrapper assertions also drifted after UI restyling.
- **Evidence:** Canonical two-file run exited 1 in 144.71s: flows 0/8, window 3 pass/5 fail/1 skip; detailed traces artifact9. Private registry diagnostic showed dependency errors and completed cleanup. service.ts:365; search/engine.ts:340-342; HistoryPanel.tsx:675.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Corrected fixtures expose a consumer-visible implementation defect.
- **Source:** assumed — autonomous

## D4: Isolate only the genuinely simultaneous Vault modules
- **Question:** Should the shared plugin loader or fixture lifetimes change to resolve a paired-host shutdown collision?
- **Options:** Change production module loading; split independent tests; copy Vault only for the simultaneous paired flow.
- **Chose:** Optional isolated Vault copies for both rigs in the paired-host flow, keeping ordinary single-rig fixtures shared. Preserve the real dependency links copied with the plugin. Re-enable local indexing explicitly before verifying its exact source after remote disable.
- **Why:** This flow requires two live daemons and cannot be split without losing its public host boundary. The production runtime has separate processes. The incoming editor D5 correctly splits independent scenarios; that is not applicable to a real paired-host operation. No production loader, deactivation, worker-recovery, API or privacy contract changed.
- **Evidence:** All-worker HEAD/scope audit at 121a8de4; integrated hosts 8729a5d1 and window 2b7703c7. The first standalone smoke caught a redundant parent-added node_modules symlink (EEXIST); 6dc09fe7 removes it. Corrected smoke exited 0 in 1.08s: two distinct host-qualified identities, remote path redaction, real remote search, local source still served after remote disable, remote no-service, privateHomesRemoved true.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A genuine separate-process daemon exhibits shared shutdown ownership.
- **Source:** assumed — autonomous

## D5: Preserve incoming editor authority and evidence limits
- **Question:** Does the single normal roadmap catch-up conflict with the repair?
- **Options:** Reopen editor ownership or change module loading; retain the landed contracts.
- **Chose:** Read fix-test-editor-1028 D1–D19 and Progress completely. Preserve canonical Git source admission, exact lease/worktree and cursor semantics, bounded review history, test isolation and native/platform qualification limits. No conflict with this test-only repair.
- **Why:** The clean catch-up brought only that item's changes. Its single-daemon rule applies to independent scenarios; this paired-host flow intentionally needs simultaneous authenticated daemons.
- **Evidence:** Clean roadmap merge after 6dc09fe7; docs/loop/decisions/fix-test-editor-1028.md:1-213.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The authoritative merge result identifies a concrete integration conflict.
- **Source:** locked by docs/loop/decisions/fix-test-editor-1028.md

## D6: Use accessible control relationships and the intended search-order limit
- **Question:** What did the first full package gate expose after the original failures were reached?
- **Options:** Change shared FormRow/confirmation markup; loosen product query/candidate limits; correct fixture control and sort assumptions.
- **Chose:** Resolve inputs through label.control, supporting the shared FormRow's htmlFor relationship rather than requiring nested labels. Resolve dialog accessible names from labelledby or aria-label, as the actual confirmation host uses aria-label. Use newest ordering to prove fresh-source page replacement, then explicitly relevance ordering to exercise the candidate retrieval cap. Remove new request-wiring/mock-echo and fixture-length assertions; keep exact recovered source and page identities.
- **Why:** Full package evidence reached Hide empty sessions label lookup and both confirmation helpers. The actual UI already provides associated labels and named dialogs. Newest retrieval does not imply relevance candidate truncation. These were invalid test assumptions, not reasons to alter production semantics.
- **Evidence:** First full package run exited 1 in 172.78s: 20/24 remote files passed initially; API file passed its configured retry after a 5000ms timeout, while runner stopped on the already-corrected copied-link EEXIST. Remaining window failures: nested label lookup, labelledby-only dialog lookup and newest candidate flag expectation. ConfirmHost.tsx:53; components/Dialog.tsx:19; HistoryPanel.tsx:976-994.
- **Reversibility:** easy
- **Confidence:** high for traced fixture causes; corrected package gate recorded separately
- **Revisit if:** The corrected controls do not reach the intended actual state.
- **Source:** assumed — autonomous

## D7: All search must not depend on workspace resolution, and indexing must not rediscover every source per file
- **Question:** What explains the remaining reached search failures after valid selectors and queries?
- **Options:** Increase test or freshness deadlines; alter candidate limits; repair actual scope independence and repeated discovery.
- **Chose:** All scope bypasses workspace/project readiness checks. Streaming parse reuses scanner-owned discovery authority with existing per-file validation, leaving opaque-ID reads to rediscover paths. The candidate fixture separately waits for the real indexed-source count/no-due-work before asserting retrieval truncation. Do not change production limits or deadlines.
- **Why:** Configured retry captured All search failing with 'Resolving the current workspace and project' during stale-page replacement. The real private 601-source diagnostic showed candidate=false/freshness=true initially and only 81 indexed/545 due after repeated fresh requests for 30 seconds. Scanner.parse was performing complete root discovery for every candidate already returned by the index pass's discovery, an avoidable quadratic path. D6's preliminary sort explanation was insufficient: both orders use the candidate bound, and incomplete indexing was the actual prerequisite.
- **Evidence:** Second package gate: 22/24 remote files initially passed; scope.test.ts passed isolated retry; window-parity retained label and search failures. Native diagnostic artifact26 and cleanup marker; scanner/index.ts currentCandidateById/parse; search/index.ts runPass; search/engine.ts:474-476.
- **Reversibility:** medium
- **Confidence:** high for observed causes; final repaired-source verification follows
- **Revisit if:** source revalidation or invalidation no longer fences a changed/outside file.
- **Source:** supersedes fix-test-vault-1028 D6 candidate-limit diagnosis only

## D8: Consume the older broad consumer inventory without duplicate ownership
- **Question:** Does Lane 8's older 15-file Vault failure snapshot require new repair items or reverting current fixes?
- **Options:** Duplicate every old failure; use current owned package verification and preserve snapshot chronology.
- **Chose:** Keep this item's ownership and current repairs. Read all 15 Vault records in Lane 8's full-consumer-failures.json. Most are missing-method failures covered by the curated dependency correction; current full-package gates already reach those files successfully. No duplicate queue item or method alias.
- **Why:** The operator explicitly states that snapshot precedes later lands and is a heads-up, not scope reassignment. Current package evidence is newer; the only remaining reached failures are this item's window/search seams.
- **Evidence:** /Users/zpyoung/orca/workspaces/quirky/build-lane-8/.quirk/build-loop/fix-test-orchestration-1028/full-consumer-failures.json, selected plugins/quirky.vault records; second local-owned canonical package gate.
- **Reversibility:** easy
- **Confidence:** high for chronology and ownership
- **Revisit if:** a fresh consumer run identifies a failure absent from this item's final package evidence.
- **Source:** assumed — autonomous

## D9: Retain complete final gates and bounded runtime evidence
- **Question:** What does the repaired source actually prove before landing?
- **Options:** Infer global correctness from compilation; report the complete affected gate and separately exercised API/web behavior.
- **Chose:** Final canonical `bun scripts/suite.ts plugins/quirky.vault scripts` passed all 36 remote files, no failed files and no flaky retries (118.42s). Root/UI-lint/mobile/desktop typecheck and full packaged build passed (combined 68.95s). Actual 601-source diagnostic plus paired-host smoke passed in 6.10s: 626 indexed files/602 Claude sessions/zero due, candidate cap true, distinct host identities/redaction and local survival after remote disable. All owned private homes were removed.
- **Why:** This gate includes the original triaged tests, every vault consumer file from Lane 8's older inventory, scanner authority regression and existing worker mutation/sidecar/SQLite/restart/symlink coverage. The production five-second fresh-search deadline and honest freshness flag were retained. Build icon/release-URL warnings and test React teardown warnings are not relabeled warning-free. Native Trash/OS behavior is not certified by a remote skip.
- **Evidence:** bg8 suite-result ok true, flaky []; bg9 completed typecheck/build; bg10 actual diagnostic and cleanup markers; scanner component ae167d62 after HEAD/scope audit and merge.
- **Reversibility:** easy
- **Confidence:** high for named exercised outcomes
- **Revisit if:** merged gate or a real source boundary fails.
- **Source:** assumed — autonomous

## D10: Verify the shipped browser surface without foreground or real user data
- **Question:** Which user-visible flows were actually exercised?
- **Options:** Infer UI success from tests; run a private built-UI daemon and guarded unattended web flow.
- **Chose:** Guarded web run 20261029T012049-7152 passed both goals: All-scope actual transcript search with highlighted evidence; associated Agent grouping and Hide empty sessions controls followed by retained exact search result. Every feature action returned OBSERVED, screenshots were read, findings were empty, no console/network errors were recorded, no test overrides, no kept-open windows or cleanup errors. No foreground or native pass claim.
- **Why:** This used the built shipped app UI against a fresh private daemon/source home. API calls were setup only; actions went through visible UI. The initially split Changes/Vault area was expanded by its visible minimize control before result inspection.
- **Evidence:** .quirk/using-apps-like-a-user/runs/20261029T012049-7152/report.json and obs-4/obs-7/obs-8/obs-9 screenshots; full build in D9. Service logged surfaceStopped true/privateHomesRemoved true after guarded browser closure; the drained stdin supervisor was then explicitly stopped and reported exited.
- **Reversibility:** easy
- **Confidence:** high for named web goals only
- **Revisit if:** a real native or other-platform scenario reports a separate failure.
- **Source:** assumed — autonomous

## D11: Record the bounded review result and its execution-boundary violation
- **Question:** How much assurance does the actual final Gemini review provide?
- **Options:** Claim a formal whole-repository pass; ignore a prohibited command attempt; retain the scoped findings result with the violation explicit.
- **Chose:** One cross-family Gemini high review of all changed Vault source/tests returned findings [] and limitations [] in 237.67s. No accepted finding or fix batch remains. Do not present this as a formal adversarial-protocol PASS. Record that, despite the explicit read-only/no-check prompt, the reviewer attempted npm run test with the scanner file. Its check attempt is not used as verification evidence.
- **Why:** The independent final 36-file/type/build/runtime gates were already green before dispatch. A subsequent write-boundary check showed only the parent's intended README/decision-log changes and inherited .serena; no source/test mutation. A process snapshot found no remaining process containing that review test command. All reviewer/worker/check jobs returned.
- **Evidence:** bg11 actual google/gemini-3.1-pro-preview:high tool trace and final JSON; post-review diff/status; process snapshot reviewTestProcesses []; independent gates D9.
- **Reversibility:** easy
- **Confidence:** high for actual returned findings and observed boundary checks; protocol assurance explicitly reduced
- **Revisit if:** independent review or merged verification finds a concrete defect.
- **Source:** assumed — autonomous

## Progress
Ready for canonical landing. All implementation components returned, passed HEAD/scope audit, merged and were removed with inherited metadata preserved. Final affected 36-file suite passes without retries; typecheck/build pass; actual candidate/paired-daemon smoke and guarded two-goal shipped web flow pass. Sole normal roadmap catch-up consumed; bounded Gemini review returned no findings with D11 execution limitation. Browser closed, service cleanup logged both homes removed and supervisor exited; no owned runtime/check/agent remains. Commit final docs, detach and run the authoritative absolute queue land, await its receipt, then remove owned scratch. No extra queue item. Scratch: /tmp/quirky-vault-repair-lane5-RDQalGGE.
