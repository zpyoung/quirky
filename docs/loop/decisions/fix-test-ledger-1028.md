# fix-test-ledger-1028 decisions

## D1: Restore the declared ownership provider rather than bypass project-removal safety
- **Question:** What explains the triaged ledger owner-removal and import/recovery failures?
- **Options:** bypass session discovery in repo removal; add a ledger-specific alias/fallback; register the existing declared Worktree method
- **Chose:** Add the existing `ownedIds` implementation to Worktree's handler map. Its implementation, manifest contract and repo caller remain unchanged. Preserve existing consumer-visible ownership, removal, retention, identity and import tests.
- **Why:** The baseline reports `quirky.worktree did not provide method:quirky.worktree/ownedIds`. The method is implemented and declared, but the sole provider loop only registers handler-map members. Repo removal invokes it before closing sessions and forgetting the owner. The existing Worktree ownership test and ledger removal/recovery tests are the failing-before regression evidence; duplicating a registration inventory test would not test a consumer-visible invariant.
- **Evidence:** docs/loop/reports/m7-test-triage.json groups.plugins/quirky.ledger; plugins/quirky.worktree/main.ts:306-311,431-642; quirky-plugin.json ownedIds contribution; plugins/quirky.repo/src/projects.ts:135-139; plugins/quirky.worktree/test/worktree.test.ts:339 onward
- **Reversibility:** easy
- **Confidence:** high for the missing provider; current post-repair gate pending
- **Revisit if:** canonical verification identifies an ownership/session-safety error after registration
- **Source:** assumed — autonomous

## D2: Consume the landed Ask repair without adding another confirmation path
- **Question:** Does the older connection-bound ask/wait failure need a ledger workaround?
- **Options:** weaken Ask's client admission; duplicate confirmation handling; reuse the landed kernel confirmation repair
- **Chose:** Preserve ledger's real confirmation and one-use replay assertions. The current broker already consumes durable answers through public ask/list, as fix-test-ask-1028 D3 requires.
- **Why:** The prior owner traced the kernel's illegal connection-bound wait, repaired its source and exercised the actual Ledger confirmation consumer. The baseline error does not justify undoing that cutover. Shared repo harness already includes required quirky.cli whenever Worktree is selected; no duplicate fixture dependency change is needed.
- **Evidence:** docs/loop/decisions/fix-test-ask-1028.md D3,D7; packages/daemon/src/plugins/confirm.ts; plugins/quirky.repo/test/harness.ts:126-127; plugins/quirky.ledger/test/ledger.test.ts:542-563
- **Reversibility:** easy
- **Confidence:** high for already-landed repair; current gate pending
- **Revisit if:** current real confirmation consumer fails
- **Source:** locked by docs/loop/decisions/fix-test-ask-1028.md D3

## D3: Keep the cross-plugin repair narrow and expose it to the queued owner
- **Question:** Who owns a missing Worktree method blocking Ledger when Worktree and Repo repairs are still queued?
- **Options:** block Ledger waiting for unclaimed repairs; take over all their failures; fix this single shared defect and document ownership
- **Chose:** Repair only the existing ownedIds registration here. At claim time fix-test-worktree-1028 and fix-test-repo-1028 are todo/unassigned. Their future owners must consume this landed repair rather than duplicate it. No other Worktree/Repo behavior is adopted. Run affected consumer verification and retain unrelated failures under their existing queue owners.
- **Why:** Ledger cannot exercise removal, detach, recovery or import with this declared method absent. There is no concurrent owner to conflict with, and no new API or alias is required.
- **Evidence:** canonical queue claim; read-only queue status; source baseline bb169fdb2a93b341e2de3b008226db21bce0b85b; D1 consumers
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** an active owner lands a conflicting registration or changes the public contract
- **Source:** assumed — autonomous

## D4: Use bounded unattended repair and independent cross-family review
- **Question:** How should implementation, runtime verification and review run without a person?
- **Options:** new feature specs; human decisions; focused end-phase fix with owned resources and an available cross-family reviewer
- **Chose:** One omp/OpenAI worker registers the method; parent owns evidence, checks and landing. Workers skip checks mid-flight. Use canonical remote suites, private process homes, actual daemon/API smoke, typecheck and one final review round with at most one accepted-finding fix batch. Opus and Sonnet preflight each exit5; Gemini resolves google/gemini-3.1-pro-preview:high. No LSP server is configured. Preserve inherited untracked .quirk/ and .serena/.
- **Why:** This is an existing-flow repair, not feature development. The older window timeout includes a successful retention preview but not its precise failed wait; test its current behavior before inventing a UI fix. No UI/native contract changes are planned. No platform/native qualification is inferred from remote test execution.
- **Evidence:** current LOOP.md Fix items/end phase; pi-watch preflights; xd://lsp status; triage window page snapshot
- **Reversibility:** easy
- **Confidence:** high for process/tool evidence
- **Revisit if:** current verification traces a distinct ledger or UI defect
- **Source:** assumed — autonomous

## Progress
Root cause and ownership recorded. Existing missing-provider errors are authoritative RED evidence. One scoped implementer is adding ownedIds to its existing handler map. Next: canonical affected gate, actual private daemon API/CLI smoke, one independent cross-family review, sole roadmap catch-up and typecheck, then commit/detach/canonical land exactly this item.
