# fix-test-reviews-tool-1028 decisions

## D1: Trust the reported red and trace the current public slot contract
- **Question:** Which failure and scope govern this end-phase fix?
- **Options:** rerun the reported failure merely to confirm; extend polling deadlines; investigate the active Checks refresh and fixture boundary
- **Chose:** use the reported initial and isolated retry failures as red evidence and investigate the current public slot contract before changing anything
- **Why:** the queue identifies the exact mounted Checks test and wait at line417; the other five cases pass. Neither a longer deadline nor markup/copy pinning repairs the behavioral boundary.
- **Evidence:** queue item fix-test-reviews-tool-1028; plugins/quirky.reviews/test/review-link-ui.test.tsx:400–482; fix-test-mobile-1028 D12
- **Reversibility:** easy
- **Confidence:** high for reported failure; root cause not yet established
- **Revisit if:** traced runtime evidence identifies a different broken boundary
- **Source:** assumed — autonomous

## D2: Preserve canonical ownership and isolated verification
- **Question:** Should this repair change public tool authority or use real account state?
- **Options:** fake providers or loosen authority; preserve six-slot public semantics and fresh private test homes
- **Chose:** preserve existing plugin IDs, daemon layout authority and public plugin API; every runtime uses private HOME/QUIRKY_HOME and awaited cleanup. No human asks or protected-loop edits.
- **Why:** ui-shell-slots D2/D3/D11 bind tool identity, visibility and persistence. The end phase requires canonical affected suites, scripts and typecheck, plus actual changed-path smoke evidence.
- **Evidence:** docs/loop/decisions/ui-shell-slots.md D2/D3/D11; docs/roadmap.md:13–55; canonical docs/loop/LOOP.md end phase and step6; xd://lsp status returned no configured servers
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** an actual contract inconsistency requires a separately recorded decision
- **Source:** locked by docs/loop/LOOP.md and ui-shell-slots D2/D3/D11

## D3: Release the outer async act before observing the DOM
- **Question:** Is the fixture's timeout caused by hidden-document gating or renderer scheduling?
- **Options:** override document visibility; change production polling; release React's async act scope before waiting for its commit
- **Chose:** use the existing settleUi helper followed by waitUntil outside act. Remove two incidental loading/title wording assertions without repinning them.
- **Why:** an owned standalone React19 probe observed defaultVisibility visible, insideAsyncAct loading and afterAsyncAct ready. The harness's async refresh calls nested synchronous act(root.render); the outer scope defers that commit. This isolated mechanism is real but was not the complete production root cause: the first changed canonical run exposes the additional Hook-order failure recorded in D4.
- **Evidence:** actual act-probe.tsx exit0; review-link-ui.test.tsx:234–253,400–479; canonical exact-file run initial+retry5pass/1fail with explicit Hook-order diagnostic
- **Reversibility:** easy
- **Confidence:** high for isolated scheduling; insufficient alone to fix the reported failure
- **Revisit if:** future renderer fixture waits again enclose their required commit
- **Source:** assumed — autonomous

## D4: Keep the PR action-menu hook unconditional across loading transitions
- **Question:** Why does actual provider refresh still fail after the fixture releases React's commit?
- **Options:** suppress the renderer error; special-case initial state; move the existing menu useMemo before all conditional returns
- **Chose:** move the unchanged actionItems useMemo above the no-worktree/loading/no-review returns, preserving memoization and handlers.
- **Why:** actual canonical initial and isolated retry both report ChecksPanel hook37 changing from undefined to useMemo. The loaded-only hook at former1115 follows three early returns; transitioning from initial unbound/loading state to PR12 therefore violates React's hook invariant and blocks rendering. The existing mounted real-daemon regression now reaches and catches that consumer defect.
- **Evidence:** canonical bg1 exit1/44.84seconds; ChecksPanel.tsx former1022–1093,1115–1118; React previous36hooks→next37 diagnostic
- **Reversibility:** easy
- **Confidence:** high; changed-path green verification pending
- **Revisit if:** the current canonical run exposes another actual transition defect
- **Source:** assumed — autonomous

## Progress
Step2 fixture repair exposed concrete production Hook-order failure. Existing PR menu useMemo moved before all early returns without changing handlers/dependencies. Second canonical exact-file verification running. No API changes. One task implementer prepares an independent actual daemon+mounted Checks smoke in /tmp/quirky-checks-l11.5hHALQ; all other scratch owned there. Opus unavailable exit5; Gemini fallback available exit0. Next finish runtime/suite/typecheck evidence, one bounded cross-family review, sole catch-up and canonical land.
