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

## Progress
Current48-file canonical Worktree run reproduced only one incidental schema-inventory failure, including its identical isolated rerun. Removed that test; focused delete coverage now passes remotely. No production changes. An implementer is preparing only an isolated throwaway actual API smoke. Next commit this bounded repair, catch up roadmap once and read incoming decisions, execute actual smoke, run final affected package/scripts/typecheck plus bounded cross-family review, then record receipts and land. Never end while a worker or command remains active.
