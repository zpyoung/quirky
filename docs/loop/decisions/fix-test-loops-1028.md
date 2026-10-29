# fix-test-loops-1028 decisions

## D1: Diagnose the three named loops failures against current public contracts
- **Question:** Which behavior and verification does this repair own?
- **Options:** repin current presentation or timing; reproduce the named failures and repair their demonstrated causes
- **Chose:** Reproduce the canonical loops suite, trace native held-turn lifecycle and approval observation, and retain consumer-visible assertions rather than implementation inventories.
- **Why:** The queue names two rendered native controls scenarios and API L06 from baseline 97aaa12d; the current tree includes later restyles and runtime repairs.
- **Evidence:** docs/loop/reports/m7-test-triage.json:899-920; queue item fix-test-loops-1028
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** reproduction demonstrates another owning plugin's defect
- **Source:** locked by docs/loop/LOOP.md

## D2: Run every test through the canonical remote runner and isolate runtime smoke
- **Question:** How can verification avoid competing with other lanes or changing real state?
- **Options:** direct local tests; canonical remote suite with disposable runtime homes
- **Chose:** Use bun scripts/suite.ts for both files and directories, including scripts; any actual API smoke uses the existing isolated LoopRig and cleans up in finally.
- **Why:** The inherited operator instruction requires remote tests, and loop rules prohibit real provider/home state changes.
- **Evidence:** .orca/loops/omp-until-done-50bc6f72/notes.md:114; docs/loop/LOOP.md tests never touch real state
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a named macOS-only scenario requires the documented exception
- **Source:** locked by docs/loop/LOOP.md

## D3: Restore the fixture's declared worktree dependency
- **Question:** Why does the current loops suite fail before reaching its named scenarios?
- **Options:** remove the worktree-root setting; weaken dependency discovery; install the required CLI plugin in the rig
- **Chose:** Add `quirky.cli` to the isolated loops plugin set.
- **Why:** Worktrees still declares and reads `worktreesRoot`, but its manifest now requires the CLI plugin. Missing dependency prevents registration, yielding `no setting setting:quirky.worktree/worktreesRoot`.
- **Evidence:** canonical suite before repair: 20 files, 9 passed, 11 failed in24.90s; plugins/quirky.worktree/quirky-plugin.json:12-15,2217-2223; plugins/quirky.loops/test/rig.ts:13-24. After the one-line correction, the narrow suite reaches and reproduces all three original failures.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the worktree manifest's dependency changes
- **Source:** locked by plugins/quirky.worktree/quirky-plugin.json

## D4: Repair structured approval waiting at its consumer, not Ask's guard
- **Question:** Why does L06 never resume after the public approval answer?
- **Options:** increase its watchdog; remove Ask's connection requirement; use an owned real client for the structured bridge's long-poll
- **Chose:** Use an owned client for non-native approval waits while preserving plugin-created registration, native lease-authenticated registration, and cleanup/cancellation.
- **Why:** The real API smoke reports `quirky.ask/wait needs a client connection` from structured/main.ts:361. L06's fixture catches that rejection and remains waiting; its5000ms watchdog then tears down `rig`, producing the secondary undefined `rig.sends` error. Replacing that internal send-count wait with public paused state and settled history preserves the consumer acceptance criterion.
- **Evidence:** focused canonical red reproduces L06 twice; isolated approval smoke exits1 after31.32s with exact dispatch rejection and acknowledged home cleanup; packages/daemon/src/plugins/dispatch.ts:142; plugins/quirky.ask/quirky-plugin.json:76-79. Ask owner lane8 notified via exact terminal handle, accepted delivery receipt only; no Ask source edits planned.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** cancellation fails to settle an approval or leaks a waiter connection
- **Source:** assumed — autonomous

## D5: Preserve the human-input quiet gate in native acceptance fixtures
- **Question:** Why do the two native acceptance flows time out after structured steering?
- **Options:** shorten the production quiet period; avoid real steering; let only post-human test waits enclose the documented quiet interval
- **Chose:** Keep real native steering and all tab/session/turn/queue assertions. The post-steer stopped-state and second-native-turn waits allow30seconds, with60second enclosing scenario watchdogs; unrelated waits and Stop Now remain unchanged.
- **Why:** Direct structured steering is an external user journal message. The locked20second quiet period applies before settlement and before another prompt even after view detachment. The old10second stopped wait and8second second-turn wait could never observe the intended transition.
- **Evidence:** m5-loops-core D6; driver.ts19-21,191-204,848-865; canonical red native stop12.62s and close9.34s. Actual native daemon/app-server smoke preserves the hold, then settles one iteration without another start or interrupt after20467ms; success and cleanup markers, exit0 in22.05s.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** native regression still fails after the actual quiet window
- **Source:** locked by docs/loop/decisions/m5-loops-core.md

## D6: Separate cancellation settlement from transport teardown
- **Question:** How should the new waiter connection preserve a declined approval when its session stops?
- **Options:** close immediately; synthesize a decline after connection loss; cancel the real ask and drain its in-flight wait before closing
- **Chose:** Acquire/own the lease-authenticated waiter before exposing either kind of ask. Track in-flight wait promises per session. Active cancellation cancels the actual asks, drains captured waits, then closes clients; inactive plugin shutdown closes immediately because revoked plugin context cannot cancel or wait safely.
- **Why:** The first bridge correction exposed two independent lifetime races: stopping a visible ask while post-registration connect was pending rejected lease ownership, and closing immediately after the cancel RPC discarded the real declined wait response with ConnectionLost. Moving acquisition before registration and draining the actual response retains the existing declined contract without a fabricated fallback or weakened lease check.
- **Evidence:** canonical structured cancellation test failed twice with lease-changed and twice with ConnectionLost; actual real Ask cancellation smoke reproduced ConnectionLost. Final actual session/create/send→visible Ask→structured/stop smoke prints approval-cancel success and cleanup markers, exit0. Existing closing-session-declines assertion remains unchanged; fake wait now declares the real connection-only contract.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** cancellation or disable leaves a wait/client pending, or a stopped owner admits a new wait
- **Source:** assumed — autonomous

## Progress
Named loops API/native-control files pass canonical focused verification. Actual API approval and native quiet-gate smokes passed/cleaned; cancellation refinement now passes actual real Ask stop smoke, with canonical structured/API rerun pending. Scoped static reviewer found no findings against final acquisition/drain ordering. All workers returned. Commit source, merge roadmap once, read incoming decisions, run complete affected remote suites/scripts/typecheck, rerun current API smoke and authoritative land. No global completion state observed.
