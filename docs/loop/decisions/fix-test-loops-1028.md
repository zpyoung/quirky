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

## D7: Await approval registration independently of the waiting-status edge
- **Question:** Does a needs-you snapshot guarantee the runner's asynchronous Ask registration is already visible?
- **Options:** register before owning its client; assume one immediate list sees the ask; wait for the matching public pending Ask
- **Chose:** L06 and the actual API smoke wait for the matching Ask through the public list. Keep the zero-completed-iterations assertion, answer that exact Ask and verify two settled iterations. L06's30second enclosing watchdog covers its existing10second state waits and the new10second registration condition.
- **Why:** The scripted runner deliberately publishes waiting before asynchronous createAsk completes. Owning the socket before registration introduces a real setup boundary. Canonical L06 then failed twice at missing Ask after a needs-you snapshot, while the real smoke showed the same ordering; this is not an approval loss or justification to weaken client ownership.
- **Evidence:** canonical focused run after cancellation repair: structured file passed, L06 missing-Ask at404/379ms; actual composed smoke failed the identical early assertion and cleaned up. Replaced immediate list assumption, not runtime semantics.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the Ask never appears or answering it fails to resume observation
- **Source:** assumed — autonomous

## D8: Preserve incoming Ask restyle boundaries during the sole catch-up
- **Question:** Does the incoming Ask/Notifications presentation cutover conflict with the bridge repair?
- **Options:** retain obsolete UI; alter the Ask connection guard; merge the independent presentation changes
- **Chose:** Sole clean roadmap merge after source commit c3455d12. Read ui-restyle-ask D1–D12 and Progress in full. Preserve durable validation/FIFO/drafts/approval authority, lease ownership, inert preview subpath and bounded renderer claims. No conflict or Ask runtime edit.
- **Why:** The bridge consumes the existing public connection-only wait API; the incoming restyle preserves that API. Actual current approval and cancellation are exercised separately from incoming seeded transcript/renderer proof.
- **Evidence:** sole merge brought22files and one decision log; full composed typecheck passed39.24s, UIlint/root/mobile/prepared-desktop. Remote scripts12/12files passed47.22s without flaky reruns. Final lifecycle and broader affected plugin checks pending.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the current source's lifecycle verification finds an integration defect
- **Source:** locked by docs/loop/decisions/ui-restyle-ask.md

## D9: Repair newly reached acceptance fixture prerequisites without repinning presentation
- **Question:** What does the final full owning-package run reveal beyond the three named regressions?
- **Options:** hide the failed package result; repin the restyled panel title; fix declared dependencies and query the actual output log
- **Chose:** Keep source/history retention acceptance. Replace the obsolete aria-label wrapper assumption with the semantic log containing the fixture's actual assistant output, not a new copy/title pin. Investigate the two structured startup/background fixture failures against the same new Worktrees→CLI dependency.
- **Why:** Final loops+structured run reached28/31 passing files. ui-api failed only at its removed wrapper selector after35 behavioral assertions; the real output is still rendered in role=log. Its repaired full scenario passes through canonical runner1/1 in12.73s, including saved output, lifecycle, queue, CLI and close. The other two fixtures fail before their scenarios with missing setting/creator method.
- **Evidence:** canonical31files28pass3fail225.38s; plugins/quirky.loops/test/ui-api.test.ts:429-433; LoopView.tsx903-925. Native/API/structured focused3/3 remain green.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a fixture dependency correction does not expose the intended real acceptance path
- **Source:** assumed — autonomous

## D10: Close the owning-package repair and retain the failing broader boundary honestly
- **Question:** Which final evidence supports landing this one repair?
- **Options:** claim the earlier93file run passed; change independently owned plugins; land the exercised owning-package repair with exact broader failures recorded
- **Chose:** Final canonical loops+structured boundary passes31/31files, no failures/flaky reruns,188.50s. Final canonical scripts passes12/12files47.22s; final full UIlint/root/mobile/prepared-desktop typecheck passes41.32s. The focused lifecycle/API/structured3/3 passes60.38s, and retained-output UI/API scenario1/1 passes12.73s. No whole-repository or five-plugin green claim.
- **Why:** The three named failures and newly exposed owning-package fixture/selector issues are repaired without runtime guards, approval checks or the20second quiet gate being weakened. Wider Ask/Automations/Orchestration failures are concretely inventoried rather than attributed to an unproven earlier cause or hidden. The existing Orchestration repair on lane8 accepted a detailed current-handle handoff; no duplicate test/debug follow-up.
- **Evidence:** final canonical31/31 suite-result ok:true/flaky:[]; final typecheck exit0; scripts12/12 suite-result ok:true/flaky:[]; docs/loop/BLOCKERS.md section fix-test-loops-1028. Both structured fixtures now include their declared real CLI dependency with startup-owner/session/selection assertions unchanged.
- **Reversibility:** easy
- **Confidence:** high for the named owning-package repair; no broader clearance
- **Revisit if:** authoritative merged typecheck or the existing downstream repair demonstrates a bridge regression
- **Source:** assumed — autonomous

## D11: Keep runtime, review and platform assurances bounded
- **Question:** What do smoke cleanup and static review establish?
- **Options:** label all native/provider/UI/platform behavior accepted; retain only observed evidence and limits
- **Chose:** Real disposable daemon/API approval answer→resume and visible Ask→session-stop/cancel paths pass with actual terminal envelopes, two settled iterations and exact session ownership; final combined host exit0 in3.39s with both success/cleanup markers. The native fake app-server quiet-gate smoke passes after20467ms with one settled turn, no extra start/interrupt and cleanup, exit0 in22.05s. Scoped same-family static reviewer reports no findings; no cross-family/full formal campaign or native OS visual acceptance.
- **Why:** The fixtures exercise real Quirky API/daemon/owner paths, not real paid model execution or native menus/focus. All finite jobs/workers returned. Temporary runtime homes are removed; no browser was opened. Inactive-plugin/worktree/notification and removed-cwd Git shutdown warnings remain visible in the receipt and blocker ledger.
- **Evidence:** actual approval and cancellation smoke success/cleanup markers; native elapsed20467ms; LoopsRepairReviewer final no-findings report; all canonical jobs completed.
- **Reversibility:** easy
- **Confidence:** high for the exercised paths
- **Revisit if:** an OS-specific or real-provider lifecycle failure is reported
- **Source:** deferred: platform

## Progress
Final owning-package loops+structured suite31/31 clean188.50s; scripts12/12 clean47.22s; final full typecheck41.32s. Actual approval/cancellation and native quiet-gate smoke proof retained, shutdown warnings explicit. Sole roadmap merge complete; incoming Ask log fully read. All scouts/implementers/reviewer/jobs returned. Broader93file boundary73pass20fail is recorded in BLOCKERS with exact independent-owner inventory, not represented as passing. Commit final fixtures/readiness/receipt, detach and run authoritative queue land fix-test-loops-1028; wait for its actual result, then remove owned /tmp/quirky-lane10-loops-r8eAik and update loop notes. Do not claim another item or global completion.
