# fix-test-agent-status-1028 decisions

## D1: Repair the assigned agent-status contracts without widening provider APIs
- **Question:** Which failures and verification belong to this end-phase fix?
- **Options:** Repin failed assertions; trace consumer behavior and repair its root cause; widen adjacent plugin APIs.
- **Chose:** Trace the six assigned failures, repair consumer-visible behavior, and delete incidental assertions rather than repinning them.
- **Why:** The queue names OSC session/turn ownership and the hooks switch lifecycle; tests must retain isolated homes and process cleanup.
- **Evidence:** docs/loop/reports/m7-test-triage.json; assigned queue item title; docs/loop/LOOP.md Fix items.
- **Reversibility:** easy (local repair)
- **Confidence:** high
- **Revisit if:** Evidence identifies an upstream contract owned by another repair.
- **Source:** locked by docs/loop/LOOP.md

## D2: Use native task implementers and a reachable independent reviewer
- **Question:** Which backend pairing can run unattended on this omp lane?
- **Options:** omp task implementers with opus; next reachable cross-family reviewer; task reviewer fallback.
- **Chose:** omp task implementers (OpenAI family) and gemini (`google/gemini-3.1-pro-preview:high`) for final review.
- **Why:** `pi-watch --check opus` exited 5: no authed/shipping model among its eight candidates. The full ladder probe resolved gemini and flash as cross-family alternatives; no authentication changes are permitted.
- **Evidence:** This iteration's opus and full-alias preflight output.
- **Reversibility:** easy (review backend only)
- **Confidence:** high
- **Revisit if:** Another cross-family backend resolves.
- **Source:** assumed — autonomous

## D3: Assert absent OSC questions directly
- **Question:** Do the two OSC triage errors establish a production ownership defect?
- **Options:** Change the status model to store empty strings; coerce undefined into strings; assert the semantic absence of a question.
- **Chose:** Assert `question` is undefined after a replacement or new turn, preserving the existing prompt, detail, wrong-process and stale-event regressions.
- **Why:** The recorded error says containment requires strings or arrays. `AgentRow.question` can legitimately be absent, and the turn-fencing case already waits for that absence. A containment matcher on undefined is invalid; weakening production ownership fences would address the wrong problem.
- **Evidence:** docs/loop/reports/m7-test-triage.json groups.plugins/quirky.agent-status; plugins/quirky.agent-status/test/transcript-producers.test.ts:160-168,207-223.
- **Reversibility:** easy (test contract only)
- **Confidence:** high for the matcher defect; no production-fix claim
- **Revisit if:** Consumer-visible stale question state appears in the repaired checks.
- **Source:** assumed — autonomous

## D4: Retain the already-landed duplicate-key repair for hooks settings
- **Question:** Why did the baseline lose the canonical hooks setting, and does this item need another runtime change?
- **Options:** Rename the setting; add an alias or fallback; retain the existing manifest repair and verify the actual lifecycle.
- **Chose:** Retain the existing manifest repair in `d50e89de`; no new settings/runtime change.
- **Why:** Baseline `97aaa12d` declared two `contributes.setting` JSON keys: an earlier hooks-only array and a later dashboard-only array. JSON parsing retained the later array and omitted hooks. `d50e89de` removes the earlier duplicate key and adds hooks to the surviving array. Current registration accepts the locked canonical setting ID.
- **Evidence:** `git diff 97aaa12d..992d9e53 -- plugins/quirky.agent-status/quirky-plugin.json`; confirmed commit `d50e89de`; current manifest:1500-1518; packages/daemon/src/plugins/ui-service.ts:192-195.
- **Reversibility:** easy (no additional runtime patch)
- **Confidence:** high
- **Revisit if:** Canonical plugin checks identify any remaining hooks lifecycle failure.
- **Source:** locked by docs/loop/decisions/m1-agent-status.md D26

## D5: Exercise the public CLI in isolated plugin ownership
- **Question:** What runtime smoke proves the hook switch without launching real providers or reading OS credentials?
- **Options:** Start all built-ins; use the real status plugin and daemon with fixture dependencies; rely on assertions alone.
- **Chose:** Standalone script starts the real daemon/status plugin with only fixture session/worktree/agents/hosting dependencies, then drives actual `quirky` CLI commands.
- **Why:** This exercises install, disable/removal, refusal, hooks-disabled status, persisted restart, re-enable/reinstall and explicit removal without activating accounts, Keychain access, or provider sessions. Every child is process-scoped and homes are temporary.
- **Evidence:** `bun /tmp/quirky-agent-status-lane2-4YLv5c/smoke.ts` exit0/3.01s; `AGENT_STATUS_CLI_LIFECYCLE_OK`; `AGENT_STATUS_SMOKE_CLEANED true`.
- **Reversibility:** easy (throwaway verification script)
- **Confidence:** high for CLI/API behavior; no UI or native acceptance claim
- **Revisit if:** Full end-phase checks disagree.
- **Source:** assumed — autonomous

## D6: Preserve incoming native clipboard and PTY history decisions
- **Question:** Do decisions brought in by the single roadmap catch-up alter this repair?
- **Options:** Expand into native clipboard/history; retain their independently owned boundaries.
- **Chose:** Read both incoming decision logs completely and retain their scope; neither conflicts with the OSC test-only correction.
- **Why:** `fix-native-m1-term-ui-1028` owns trusted window clipboard acquisition and its pending native scenario; `fix-test-packages-pty-host-1028` preserves history/screen separation and process cleanup. This item changes neither surface.
- **Evidence:** Single clean roadmap merge after e83cfee0; docs/loop/decisions/fix-native-m1-term-ui-1028.md D1-D11; docs/loop/decisions/fix-test-packages-pty-host-1028.md D1-D6.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A concrete interaction appears in canonical checks.
- **Source:** locked by incoming decision logs

## D7: Separate the overloaded local scripts timeout from the required remote run
- **Question:** How should verification respond to the operator's report of load260 on this Mac?
- **Options:** Retry local tests or raise their budgets; move every remaining test through the canonical remote suite runner.
- **Chose:** Use `bun scripts/suite.ts <file or dir>` for all remaining tests, except the runner's explicit macOS list and packaged native-app checks. Started `bun scripts/suite.ts scripts`; no new direct `bun test` invocation.
- **Why:** Before the operator note, local `bun test scripts` returned125pass/1fail across126tests12files in284.50s. Only `scripts/suite.test.ts:196`, “runFiles emits no profile rows when profiling is disabled”, exceeded5000ms (5053.94ms). This timing observation does not diagnose a production defect or prove a flake. The operator reports load260 with12lanes and16idle remote cores; remote execution avoids imposing more test load here.
- **Evidence:** Completed bg_3/raw artifact://30; operator note during iteration11. Canonical queue accepted fix-test-scripts-profile-timeout-1028 with the exact failed case; it remains a separate diagnostic item, not another claim by this lane.
- **Reversibility:** easy (execution placement; no source/deadline changes)
- **Confidence:** high for observed outputs and operator load report; no causal attribution of the exact timeout
- **Revisit if:** Remote scripts also fail.
- **Source:** locked by operator note in this conversation

## D8: Land only the exercised test-only repair and disclose the bounded review
- **Question:** What verification is sufficient for this assigned repair, and what does it not establish?
- **Options:** Claim all local checks were green; broaden into scripts timing; land the scoped repair with exact remote/runtime/review evidence.
- **Chose:** Land after caught-up remote agent-status47/47files, remote scripts12/12files, full typecheck, isolated CLI smoke, and one quick cross-family review. Preserve the earlier local timeout separately.
- **Why:** Agent-status canonical suite returned `ok:true,flaky:[]` in235.34s; operator-directed remote scripts returned the same successful result in40.90s. Full UI-lint/root/mobile/prepared-desktop typecheck exited0 in163.09s. Review targeted only code commit992d9e53..ab53523e (two assertion replacements,4changedlines), not author decision reasoning. Actual gemini dispatch returned no findings; deterministic gate/manifest returned PASS, zero advisories/limitations/questions/suppressed/excluded/unreviewed paths. Quick self-refutation is reduced independence despite using a different family; no exhaustive review claim.
- **Evidence:** bg_2,bg_4,bg_7; .quirk/build-loop/fix-test-agent-status-1028/review/{resolve,model,prepass,findings,gate,manifest}.json and raw reviewer-0.stdout/stderr with staged prompt.md. Caught-up smoke prepass exited0 in5489ms, reporting CLI lifecycle success and cleanup.
- **Reversibility:** easy (test/docs changes only)
- **Confidence:** high for the named exercised checks; bounded as above
- **Revisit if:** Integration typecheck or an end-phase consumer fails.
- **Source:** assumed — autonomous

No public API, exported symbol, plugin behavior, UI surface, native scenario, or platform support changes were needed. Existing feature specs, README and native status remain intentionally unchanged; this decision log and the appended BLOCKERS receipt document the repair. All implementation workers, scripts/suite/typecheck jobs, review and smoke processes returned; smoke removed its private homes and no browser or Quirky window was started.

## Progress
Ready to land. Source test-only repair ab53523e; hooks duplicate-key fix already inherited from d50e89de. Single roadmap catch-up completed and both incoming decision logs read. Canonical agent-status47/47 and scripts12/12files passed remotely without flakes; full typecheck passed; isolated actual CLI lifecycle smoke cleaned; final bounded quick gemini review PASS (reduced independence). Local scripts timeout remains disclosed and independently queued, not silently relabeled. Next: commit this receipt/BLOCKERS, detach, canonical queue.ts land, then preserve final notes and remove only owned /tmp scratch. Do not claim another item or whole-loop completion.
