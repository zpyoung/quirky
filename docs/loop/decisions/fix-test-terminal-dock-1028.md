# fix-test-terminal-dock-1028 decisions

## D1: Repair the reported delivery defect through the canonical public path
- **Question:** what scope and evidence govern this end-phase fix item?
- **Options:** weaken the stale-composer test; repair its demonstrated root cause; broaden into unrelated terminal behavior
- **Chose:** trace the existing public API/PTY regression and repair only demonstrated behavior or obsolete harness assumptions. Preserve transcript/status/screen positive-evidence precedence, explicit uncertainty, no automatic resend, private process homes and owned cleanup.
- **Why:** the claimed queue item names one Codex delivery regression; SC-19 and D15/D26 require matching positive evidence to prevent duplicate restored prompts.
- **Evidence:** queue wait lane 12 returned fix-test-terminal-dock-1028; docs/quirk/specs/2026-10-27-m3-terminal-dock/logic.md SC-19; docs/loop/decisions/m3-terminal-dock.md D15,D26
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** canonical-suite evidence identifies a separate owning consumer
- **Source:** locked by docs/loop/LOOP.md; assumed — autonomous

## D2: Retain the landed hooks manifest repair and meaningful regression unchanged
- **Question:** does the historical failure justify another production or harness patch?
- **Options:** remove the hooks-disable setup; add a settings alias/fallback; preserve the already-fixed canonical declaration and regression
- **Chose:** no production/test changes. Retain the hooks-disable setup, actual fake Codex PTY, exact post-send transcript evidence, empty-draft/no-warning checks and single-consumption assertion.
- **Why:** the historical report is `RpcError: no setting setting:quirky.agent-status/hooks`, before session launch or send. Commit d50e89de0c7bd55b6dd450e256fb4234689fb381 removed the earlier duplicate `contributes.setting` key and moved hooks into the surviving array. The fresh canonical baseline passes all 11 terminal-dock files with zero flakes. Removing setup or changing delivery behavior would address no demonstrated current defect.
- **Evidence:** docs/loop/reports/m7-test-triage.json:1874-1884; plugins/quirky.terminal-dock/test/defects.e2e.test.ts:59-134; actual `git show d50e89de -- plugins/quirky.agent-status/quirky-plugin.json`; docs/loop/decisions/fix-test-agent-status-1028.md D4; canonical suite exit0 in62.55s
- **Reversibility:** easy
- **Confidence:** high for this reported setup failure; not a whole-feature acceptance claim
- **Revisit if:** current regression or standalone public-path smoke fails
- **Source:** locked by docs/loop/decisions/fix-test-agent-status-1028.md D4; assumed — autonomous

## D3: Verify the unchanged public behavior rather than manufacturing implementation work
- **Question:** what proof and review fit a historical failure already repaired by its owner?
- **Options:** create a cosmetic source/test patch; rely on historical receipts; run current canonical checks and a standalone private-daemon smoke
- **Chose:** current terminal-dock/scripts canonical suites, full typecheck, standalone public-API send through the actual daemon/PTY and a read-only cross-family final closure review. No exported symbols, API/schema contracts, UI surfaces or native scenarios change; feature specs/README remain intentionally unchanged. No new test merely checks manifest inventory or source text.
- **Why:** existing regression drives real process input and transcript evidence; a gratuitous new test duplicates that same-path behavior. Independent live output adds smoke evidence without changing production. Opus preflight failed with no available model; Gemini resolved google/gemini-3.1-pro-preview:high. Review tools exclude shell and mutations; author decision logs are withheld.
- **Evidence:** startup skills; actual opus/gemini preflight; read-only TraceDock and follow-up; standalone /tmp/quirky-terminal-dock-l12-smoke.ts; final review command and current verification jobs
- **Reversibility:** easy
- **Confidence:** high for scope; checks still pending at decision time
- **Revisit if:** reviewer identifies a concrete consumer-visible defect
- **Source:** assumed — autonomous

## D4: Preserve the incoming Hosting repair without expanding this item
- **Question:** does the sole roadmap catch-up conflict with the no-patch dock closure?
- **Options:** broaden into review-push behavior; retain independent ownership and read the incoming decisions
- **Chose:** retain incoming Hosting parser/test/documentation changes. Read fix-test-hosting-1028 D1-D6 and Progress fully; no dock setting or delivery boundary conflict.
- **Why:** catch-up fast-forward b9e1eee6034db166d2540ae8352726003528bc00 to bc52520e brought only Hosting source/tests and shared loop receipts. Its broader Git/Worktree failures remain explicitly under their existing owners; this item makes no whole-consumer passing claim.
- **Evidence:** actual sole `git merge build/roadmap` output; docs/loop/decisions/fix-test-hosting-1028.md:1-71
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual current scoped verification contradicts these boundaries
- **Source:** locked by incoming decision log; assumed — autonomous

## D5: Close the historical setup failure with current exercised evidence
- **Question:** what passed, and what is intentionally not claimed?
- **Options:** claim a new runtime fix or broad feature acceptance; record a verified no-patch closure
- **Chose:** verified no-patch closure. Before catch-up, canonical terminal-dock suite passed 11/11 files with no flakes in62.55s. After sole catch-up, canonical terminal-dock plus scripts passed23/23 files with no flakes in127.49s. Full frozen-install/UI-lint/root/mobile/prepared-desktop typecheck exited0 in52.45s.
- **Why:** the actual standalone smoke accepted the canonical hooks setting, launched private fake Codex through the real daemon/PTY, sent a unique prompt once, observed PONG while the stale composer remained, returned `observed-cleared`/accepted true, and reported empty draft/no notice/exactly one consumed prompt. It exited0 in16.84s and confirmed the owned home was removed. No source/test alteration, weakened assertion, settings alias, retry or deadline change was needed.
- **Evidence:** completed canonical bg_1/bg_3 and typecheck bg_4; smoke bg_2 with `CANONICAL_HOOKS_SETTING_ACCEPTED`, `TERMINAL_DOCK_PUBLIC_DELIVERY_OK`, `TERMINAL_DOCK_SMOKE_HOME_REMOVED true`; retained ignored evidence beside loop notes under terminal-dock-evidence/
- **Reversibility:** easy
- **Confidence:** high for the named setup/delivery regression and current scoped checks
- **Revisit if:** integration typecheck or later actual terminal-dock acceptance contradicts these receipts
- **Source:** assumed — autonomous

## D6: Bound the final independent review to no-patch closure
- **Question:** does the independent final reviewer identify a concrete reason to change production/tests?
- **Options:** broaden into a whole-feature audit; run one read-only cross-family closure review and fix confirmed findings
- **Chose:** one read-only Gemini high final review, no findings, `STATUS: PASS`, exit0 in40.40s. No finding/fix batch exists. Reviewer inspected the current regression and manifest with only read/grep/find/ls tools; no shell or mutations were allowed.
- **Why:** existing regression preserves exact post-send evidence, canonical draft clearing, no uncertainty warning, and duplicate-consumption protection. Review does not independently establish test reliability; supplied baseline facts and the parent's actual current runs are the only passing-test evidence. Reviewer line numbering differed from anchored parent reads; decision-log parent references govern.
- **Evidence:** actual bg_5 tool progress/final response; retained terminal-dock-evidence/review.txt; D5 current runs
- **Reversibility:** easy
- **Confidence:** high for observed bounded review disposition, not exhaustive defect discovery
- **Revisit if:** a concrete counterexample or current check fails
- **Source:** assumed — autonomous

## Progress
Verification and bounded review complete. Historical setup failure already repaired in d50e89de; no production/test changes warranted. Sole roadmap catch-up bc52520e complete; incoming Hosting decisions read fully and compatible. Current canonical terminal-dock/scripts23/23files no flakes, full typecheck exit0, private actual daemon/PTY smoke observed-cleared with empty draft/no notice/single consumed prompt and home removed. Read-only Gemini final closure review PASS, no findings. Every scout/check/reviewer/smoke returned; no UI/native behavior changed and no new native handoff. Next: commit this receipt, detach and canonical queue land fix-test-terminal-dock-1028; record actual landing result, delete owned /tmp script. Preserve unrelated .serena/. Do not claim another item or whole-loop completion.
