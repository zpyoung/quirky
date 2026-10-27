# fix-ask-regex-budget-20261027 decisions

## D1: Repair the bounded matcher without relaxing the existing budget
- **Question:** What is the failure and scope of this fix item?
- **Options:** relax the 100 ms assertion; reject previously accepted patterns; preserve acceptance and matching semantics while reducing execution work.
- **Chose:** preserve pattern acceptance, JavaScript matching semantics and the existing 100 ms assertion.
- **Why:** The queue reports repeated isolated remote failures at 103–118 ms for unanchored `a*a*a*b` against a 200-character nonmatch. Re-running the reported failure is unnecessary; investigate the execution mechanism instead.
- **Evidence:** queue item fix-ask-regex-budget-20261027; plugins/quirky.ask/test/core/spec.test.ts:265-273; docs/loop/decisions/m2-ask-parity.md D32.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** semantic-preserving bounded execution requires crossing a locked architecture decision.
- **Source:** assumed — autonomous

## D2: Use OpenAI implementers and the reachable Gemini reviewer
- **Question:** Which cross-family reviewer is available for this unattended omp lane?
- **Options:** preferred opus; reachable gemini; same-family review.
- **Chose:** task implementers (OpenAI), gemini via pi-watch for the final independent review.
- **Why:** pi-watch --check reports opus/sonnet unavailable and gemini available (google/gemini-3.1-pro-preview); no human decision is requested.
- **Evidence:** preflight pi-watch --check on 2026-10-27; docs/loop/LOOP.md step 5 model pairing and autonomous-question rules.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the reachable reviewer fails dispatch.
- **Source:** assumed — autonomous

## D3: Add a sound required-literal preflight, not a replacement regex engine
- **Question:** Which semantic-preserving execution change addresses the observed unanchored backtracking?
- **Options:** lower the static quantifier budget; add per-match interruptible workers; rewrite into reverse lookbehind matching; add a conservative necessary-literal filter and retain the original native matcher.
- **Chose:** prove mandatory literals only for a deliberately narrow flat syntax subset, reject absent literals before matching, and fall back unchanged for unknown syntax. Reuse the matcher for defaults, answers and UI submissions.
- **Why:** The existing budget allows three quantifiers but an unanchored search adds another loop over starting positions. The reported nonmatch contains no required `b`, so backtracking is unnecessary. Independent scout analysis recommends a sound necessary-condition prefilter. Workers would change the synchronous execution contract; reverse matching risks backreference semantics. This is not a universal regex timeout and does not claim all accepted matches are cheap.
- **Evidence:** plugins/quirky.ask/src/core/spec.ts:80-141,333-374; answers.ts:13-23; submission.ts:89-103. Local raw-regex experiment: `a*a*a*b` no-match 35.7 ms, `.*.*.*=` no-match 95.2 ms; required-literal lookahead example 0.023 ms. Scout RegexDesign and RegexScout reports.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a required-literal proof disagrees with native matching or inputs containing mandatory literals cause unacceptable latency.
- **Source:** supersedes m2-ask-parity D32

## D4: Preserve JavaScript empty-class parsing and test behavior rather than wiring
- **Question:** What did the first core-suite run and integration inspection reveal?
- **Options:** retain the invalid fixture and class approximation; correct the JavaScript class boundary and remove implementation-only mocks.
- **Chose:** the first unescaped `]` closes both `[]` and `[^]`; retain semantic regression cases around following alternatives. Remove the invalid standalone `{2}` regex fixture and the two tests overriding `.test`.
- **Why:** The first core run produced 223 pass and one fixture-construction error (`nothing to repeat`). Treating the first `]` as literal could hide a top-level alternative and infer a false requirement; `[^]a|b]c` must match `xa`. Consumer timing and native-result comparisons cover the actual contract without pinning helper wiring.
- **Evidence:** first `bun test plugins/quirky.ask/test/core` output; pattern.ts class scanner; pattern.test.ts empty-class and differential cases.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** native-result comparison finds another accepted-syntax disagreement.
- **Source:** assumed — autonomous

## D5: Retain the merged SC-31 repair and verify the shared pure matcher without a new UI scenario
- **Question:** Does catch-up change this fix, and which visible surface needs proof?
- **Options:** rework SC-31; retain it. Add a new UI flow; exercise existing submission tests plus a real ask daemon API smoke.
- **Chose:** retain the integration changes and use core submission coverage plus real API exercise. No UI layout, interaction, or native-only scenario changes.
- **Why:** Catch-up fast-forwarded 98902f5 to 8c34823, bringing SC-31's test correction and remote-runner classification. Its D7–D10 preserve process ownership and unrelated setup behavior. This fix changes a pure shared predicate, not the question UI's visible contract.
- **Evidence:** git merge build/roadmap output; docs/loop/decisions/fix-sc31-first-shell-race.md D7–D10. Real daemon API smoke: invalid default 26.31 ms; invalid answer 0.87 ms; matching substring answered; cleanupAll removed the fresh qa-Oz8U6q home (existence check exit 0).
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** renderer integration, error wording, or interaction behavior changes.
- **Source:** assumed — autonomous

## D6: Keep the runner's isolated-retry policy and report its observed race
- **Question:** Does a successful suite requiring one built-in isolated retry satisfy the existing gate?
- **Options:** change the window-project report race inside this regex fix; retain the existing suite policy without exclusions.
- **Chose:** retain the existing policy and report the exact result.
- **Why:** `bun run test` exited 0 across 409 remote files and two macOS-only files. The only initial failure was the worktree SC-10 UI report at window-projects.test.ts:281; its isolated rerun passed all 18 tests. All ask files, including the reported regex regression, passed.
- **Evidence:** full required suite, 1501.29 seconds, artifact://28; suite-result {"ok":true,"flaky":["plugins/quirky.worktree/test/window-projects.test.ts"]}.
- **Reversibility:** easy
- **Confidence:** high for observed results; no claim that the report race is fixed
- **Revisit if:** the file fails its runner-managed isolated retry.
- **Source:** locked by scripts/suite.ts

## D7: Accept the standard independent final review and land through the queue
- **Question:** What does Final Round 1 require, and how should the verified branch integrate?
- **Options:** fix confirmed findings; record a clean bounded review; ask for a merge/PR choice.
- **Chose:** no fix batch because promote and fresh-context refute both returned empty finding arrays. Land only through queue.ts; preserve this lane worktree and never push or touch main.
- **Why:** The deterministic review gate returned PASS with zero findings, advisories, suppressed findings, limitations, questions, exclusions or unreviewed paths. The selected Google reviewer is cross-family with the OpenAI implementer. LOOP.md already fixes the integration choice and forbids human questions.
- **Evidence:** /tmp/quirky-regex-lane7.qI2IVL/{resolve,prepass,model,findings,claims,refute,merged,gate,manifest}.json; run a716cd5d97860d52; artifact 059cdc867f3e15c74bebf1b86ed4f613dfb5559229f96792b1b6c65276989509; target 8c34823..2fc7bff; every stage exited 0.
- **Reversibility:** easy
- **Confidence:** high for the exercised scope, not a completeness guarantee
- **Revisit if:** integration verification exposes a regression.
- **Source:** locked by docs/loop/LOOP.md

## Verification
- Corrected core suite: `bun test plugins/quirky.ask/test/core` — 223 pass, 0 fail, 457 assertions, 7 files, 39 ms. The existing 100 ms worst-pattern assertion remains unchanged.
- Throwaway deterministic differential smoke: 17,097 valid patterns, 307,746 comparisons against native `RegExp.test`, no disagreement. Included quantified atoms, empty/negated-empty and escaped classes, alternatives, captures, lookarounds, backreferences, Unicode/surrogate and newline inputs.
- Real daemon API create/answer smoke: missing required literal rejected in both default and answer; unanchored matching substring accepted. Fresh home removed after cleanup (D5).
- `bun run build` — exit 0; packaged macOS app. Missing optional icon source and unset release base URL warnings remain.
- Remote reported regression: `bun scripts/suite.ts plugins/quirky.ask/test/core/spec.test.ts` — 1 file passed, 0 failed, no retry, 81.87 seconds.
- `bun run test` — exit 0; 409 remote files and two macOS-only files, runner-managed retry as D6 records.
- `bun test scripts && bun run typecheck` — exit 0; 48 script tests, 0 failures, 217 assertions; TypeScript emitted no diagnostics. Inner runner fixtures intentionally print failed-test examples.
- Final Round 1: standard Gemini promote/fresh-context refute review — PASS, full cross-family independence, no findings or limitations. Prepass matcher/spec files passed in 49 ms; review run 192.38 seconds.

## Progress
Step 6 complete: implementation 2fc7bff, required verification and independent final review passed. No open findings or runtime jobs. Smoke scripts removed; temporary home removed. Next: commit this decision log, detach, run queue.ts land fix-ask-regex-budget-20261027 and wait for its integration verification. End this iteration only after the queue lands or formally blocks this one item.
