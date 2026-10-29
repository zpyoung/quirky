# fix-test-worktree-1028 decisions

## D1: Diagnose the current package after consuming the landed sidebar repair
- **Question:** Which failures from baseline97aaa12d still require changes?
- **Options:** repeat historical fixes; reproduce the current package and reuse landed repairs.
- **Chose:** current canonical package reproduction, with no speculative source changes.
- **Why:** m2-sidebar-extras-followup D34–D42 records shared text traversal, optional separator handling, real window ownership, isolated composer roots and merged shell selectors; fix-test-repo-1028 D3 already registers ownedIds. Historical failures do not establish current defects.
- **Evidence:** authoritative queue wait --lane10 iteration23; docs/loop/decisions/m2-sidebar-extras-followup.md D34–D42; docs/loop/decisions/fix-test-repo-1028.md D3/D8/D9; canonical48-file worktree run started.
- **Reversibility:** easy
- **Confidence:** high for scope, current outcome pending
- **Revisit if:** the current canonical suite identifies an unresolved consumer-visible failure.
- **Source:** locked by docs/loop/LOOP.md and queue item

## D2: Preserve isolation and existing public ownership boundaries
- **Question:** How should this iteration verify fixes without mutating real state or weakening guards?
- **Options:** direct local suites and fake forwarding; canonical remote suite and an isolated actual daemon/Git smoke.
- **Chose:** every test through bun scripts/suite.ts; standalone behavior smoke with fresh private HOME/QUIRKY_HOME, auto-hooks off and owned process cleanup. No API aliases, identity bypasses, timeout padding, or incidental-copy/default/inventory assertion repinning.
- **Why:** the operator remote-test rule, loop isolation contract and explicit queue requirements bind this item. No language servers are configured.
- **Evidence:** recorded iteration13 operator rule; current xd://lsp status; docs/loop/LOOP.md; full queue item title.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a scenario is explicitly macOS/native-only.
- **Source:** locked by docs/loop/LOOP.md and queue item

## D3: Delete the remaining schema-inventory mirror, not the newly admitted removal guards
- **Question:** What remains red after consuming the sidebar fixes?
- **Options:** repin the remove schema's exact key list; remove the incidental inventory test and retain real removal behavior.
- **Chose:** delete the SC-61 api.describe/CLI inventory block and its unused ApiDescription import. No production change.
- **Why:** the current48-file canonical run passes47files; only delete.test.ts fails at its exact remove-param inventory because expectedInstanceId and safeOnly were added. The automatic isolated rerun fails identically. The same file passes39consumer-visible Git/delete/hook/session/ownership scenarios. Existing remote-owner-workspaces tests exercise stale-instance refusal and safe removal through the actual API.
- **Evidence:** canonical run1793243258886-70977, artifact11, exit1/112.34s; delete.test.ts former673–696; remote-owner-workspaces.test.ts195–205/235–255. Focused corrected delete file passes remotely1/1/no-flaky19.42s.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a meaningful public removal or discovery behavior fails rather than an enumerated copy of the declaration.
- **Source:** locked by queue item and explicit incidental-test deletion requirement

## D4: Reuse the landed repairs and verify the complete current owning package
- **Question:** Does the historical broad red inventory justify more source changes?
- **Options:** expand into historical failures; retain current fixes and run every owning file plus scripts.
- **Chose:** no further production/test changes. Commit e3657216, then the sole clean roadmap catch-up; it brings only queue metadata and no incoming decision logs. Final canonical Worktree plus scripts passes60/60files with no failures or flaky retries.
- **Why:** the full current package now passes, including the queue's named provenance, automation, creation, navigation, project removal, sidebar and composer areas. Historical26-file failures remain historical, not silently relabelled as a single root cause.
- **Evidence:** initial48-file red run artifact11; focused1/1 corrected delete file19.42s; caught-up60-file canonical run exit0/123.37s, suite-result ok:true/flaky:[].
- **Reversibility:** easy
- **Confidence:** high for exercised current files, not full-repository/native acceptance
- **Revisit if:** the merge gate or an actual consumer identifies a meaningful failure.
- **Source:** assumed — autonomous

## D5: Exercise window ownership and physical process lifetime through the real runtime
- **Question:** What actual runtime evidence supplements the current green tests?
- **Options:** reuse assertions only; a forwarding mock; fresh real daemon/Git/PTY/CLI with two authenticated UI connections.
- **Chose:** the isolated real runtime. Ambiguous activate refuses before any branch/worktree/folder mutation; navigation stays on exact windows; sleep parks only its selected view while retaining the live shell; wake preserves branch/path/session; ownedIds equals all three public rows; confirmed CLI project removal retires the physical shell and metadata while preserving all Git folders/branches/files.
- **Why:** actual public RPC/readbacks, Git porcelain and process liveness establish behavior beyond provider wiring. No rendered UI, native window, paid provider, full-repository or all-platform acceptance is implied.
- **Evidence:** actual smoke exit0/4.97s; WORKTREE_WINDOW_GIT_SMOKE_OK plus WORKTREE_WINDOW_GIT_SMOKE_CLEANED; two UI connections, two created worktrees, three owned IDs, live shell PID6568 before removal and absent after. Guardian cleanup removes private HOME/QUIRKY_HOME; no real user state touched.
- **Reversibility:** easy
- **Confidence:** high for exercised scenarios
- **Revisit if:** an actual consumer or native run identifies a different boundary.
- **Source:** assumed — autonomous

## D6: Bound final review to the one-file test deletion and disclose quick-depth independence
- **Question:** Which review protocol fits the unchanged production surface and27-line test delta?
- **Options:** a broad new campaign; bounded quick cross-family static review.
- **Chose:** one quick Gemini high dispatch with fixed diff/full test source, supplied criteria and actual typecheck ground truth only; no filesystem tools or author rationale. Opus probe is unavailable; the model ladder selects google/gemini-3.1-pro-preview.
- **Why:** the mechanical gate is PASS with zero findings/advisories/suppressions/contested claims, zero machine limitations/questions and empty excluded/unreviewed paths. Quick self-refutation has reduced independence, not standard two-context assurance; the no-tools static reviewer did not reproduce behavior. No completeness guarantee is claimed.
- **Evidence:** artifact e1569097e0d4abedf5879c94feb0c6c1d2cf6293f53e2e4481c9c691881b0439, run4b6a59379add3d31; exact response {\"findings\":[],\"suppressed\":[]}; live prepass bun run typecheck exit0/29488ms covering UI lint/root/mobile/prepared desktop. Raw protocol/prompt/source/outputs archived beside loop notes under worktree-repair-evidence/review.
- **Reversibility:** easy
- **Confidence:** high for scoped provenance, bounded for static completeness
- **Revisit if:** the merge gate or an actual consumer shows a concrete defect.
- **Source:** assumed — autonomous

## Progress
Ready for canonical land. Source e3657216 committed; sole roadmap catch-up clean and queue-metadata-only, no incoming decisions. Final caught-up Worktree+scripts60/60remote files pass without flaky retries123.37s; focused corrected delete file passed1/1. Live full typecheck prepass29.488s passes. Actual isolated two-window/Git/PTY/CLI smoke exits0/4.97s with behavior and cleanup markers. Quick cross-family static review PASS/no findings with reduced independence explicitly recorded. Only one test-inventory block/import deleted; no production change or new user-facing documentation contract. All workers/checks/smokes returned, no owned runtime/browser/service/component tree. Final receipts and smoke source archived beside notes. Next commit this receipt, detach, run exact authoritative queue land and await its result; remove owned scratch artifacts after success. Do not claim a second item this iteration.
