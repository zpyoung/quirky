# fix-test-packages-cli-1028 decisions

## D1: Repair the named CLI boundary, not unrelated plugin failures
- **Question:** What is the acceptance boundary for this end-phase fix item?
- **Options:** restore old output snapshots wholesale; diagnose the four named files against current public contracts
- **Chose:** diagnose current CLI behavior, remove incidental wording/default/inventory mirror tests, and repair demonstrated consumer-visible failures.
- **Why:** The claimed item explicitly requires that distinction and preserves cross-plugin ownership. Fix items skip brainstorming and new specs.
- **Evidence:** queue item `fix-test-packages-cli-1028`; `docs/loop/LOOP.md`, Fix items and The end phase.
- **Reversibility:** easy (tests and bounded CLI behavior)
- **Confidence:** high
- **Revisit if:** current reproduction demonstrates a broader CLI-owned defect.
- **Source:** locked by docs/loop/LOOP.md

## D2: Use OpenAI implementers and a read-only Gemini review
- **Question:** Which reachable cross-family pair should this omp lane use?
- **Options:** unavailable Opus/Sonnet; verified Gemini; same-family Codex
- **Chose:** omp task implementers (OpenAI), Gemini high reviewer via pi-watch, with no shell or mutation tools granted to reviewers.
- **Why:** Actual `pi-watch --check` resolves Gemini `google/gemini-3.1-pro-preview:high`, while Opus and Sonnet have no authed/shipping models. Previous review provenance incidents make a real read-only tool grant preferable to a prompt-only restriction. Parent runs all checks.
- **Evidence:** preflight output, 2026-10-28; `skill://pi-dev`, Tools; `skill://subagent-driven-development`, reviewer tool restrictions.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the selected reviewer fails and its documented fallback is required.
- **Source:** assumed — autonomous

## D3: Preserve inherited untracked files and use the canonical remote suite
- **Question:** How should inherited scratch files and test execution be handled?
- **Options:** delete/stash unknown probes; preserve them and isolate owned edits; run package suites locally or use the canonical runner
- **Chose:** preserve `.quirk/`, `.serena/`, `apps/mobile/test/debug_harness.ts`, and the six existing root probes; run `bun scripts/suite.ts packages/cli` and targeted canonical commands from this worktree.
- **Why:** Unknown existing files belong to the user; nothing in this item authorizes deletion. All spawned test processes must use private homes and cleanup. No language servers are configured, so repository search is the available code-navigation path.
- **Evidence:** initial `git status --short --branch`; actual `xd://lsp` status; `packages/cli/test/fixtures/fake-daemon.ts:592-615`.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** owned test execution proves an isolation leak.
- **Source:** assumed — autonomous

## D4: Consume the ownership provider repair from its existing owner
- **Question:** Should the CLI bypass the failing ownership lookup to restore repo removal?
- **Options:** CLI fallback or repo special case; duplicate provider repair; consume the repo owner's committed correction.
- **Chose:** merge lane 10 checkpoint `1fb3789e9762959d60033d48cd78ff46605543af`.
- **Why:** The initial canonical CLI suite reproduced three actual repo-removal failures. `ownedIds` existed and was declared, but the Worktree handler map omitted it. The checkpoint registers that existing method without changing its ownership, authorization, cleanup, or failure semantics. Lane 10 owns `fix-test-repo-1028`; its decision log D1–D5 was read before consuming the checkpoint.
- **Evidence:** `plugins/quirky.worktree/main.ts:306-310`; its handlers table; `plugins/quirky.repo/src/projects.ts:135-169`; `/tmp/quirky-lane8-cli-repo-coordination.md`; initial canonical 22-remote/1-macOS CLI file run.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a real owned-session removal fails after registration.
- **Source:** locked by docs/loop/decisions/fix-test-repo-1028.md D3

## D5: Delete incidental mirrors while retaining behavioral transitions
- **Question:** Which stale assertions represent a supported consumer contract?
- **Options:** repin `Quirky Dark` to `Follow system` and extend the complete valid-flag inventory; remove those mirrors and preserve actual state/error behavior.
- **Chose:** delete the exact unknown-flag wording/inventory test and headed UI-table inventory test; consolidate default-dependent theme rows into explicit Solar/Lunar active/chosen/unavailable transitions; consolidate v1 output copies into CLI lifecycle, selectors, and environment precedence.
- **Why:** The baseline also reproduced four theme failures and one UI failure caused solely by a display-title change, plus the stale flag inventory. No CLI rendering source defect was demonstrated. The retained lifecycle checks real daemon state and exact PTY input/output, then observes session/worktree/repo removal; aliases are exercised rather than compared to duplicated output. Negative marker checks also require the inactive row to exist.
- **Evidence:** `packages/cli/test/cli.e2e.test.ts`; `theme.test.ts`; `ui.test.ts`; `v1-words.e2e.test.ts`; component commits `d54ef7b1` and `3eb14589`.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a documented machine-output or consumer behavior changes.
- **Source:** assumed — autonomous

## D6: Preserve private runtime proof and qualify the configured retry
- **Question:** What has actually been verified?
- **Options:** infer success from test changes; run real private CLI/PTY/Git and canonical scoped suites.
- **Chose:** run the standalone real-process smoke and the canonical CLI/repo package gate, reporting the gate's configured retry rather than claiming no flakes.
- **Why:** The 5.22-second smoke used fresh private daemon `QUIRKY_HOME`, private process `HOME`, real Git, and a real PTY. It created a checkout and shell, observed the shell's printed marker, removed the repo while its shell was live, verified no running owned shell and no registered repo, and retained the checkout on disk. Both private homes were removed by ProcessScope cleanup. The caught-up canonical gate passed 29 remote files plus one macOS file after `v1-words.e2e.test.ts` passed its configured isolated retry. Its initial beforeEach exceeded the fixture watchdog and afterEach saw undefined `h`; this is not proof of a product failure or of load as the cause. No assertion, deadline, retry policy, or fixture exception was weakened.
- **Evidence:** `.quirk/build-loop/fix-test-packages-cli-1028/runtime-smoke.json`; canonical CLI/repo run, 92.07 seconds; targeted canonical `ownedIds` regression passed one file with no retries, 21.01 seconds; root typecheck/UI lint/mobile/desktop checks passed, 53.57 seconds.
- **Reversibility:** easy
- **Confidence:** high for observed paths; no full-repository claim
- **Revisit if:** current post-review checks identify a remaining failure.
- **Source:** assumed — autonomous

## D7: The single roadmap catch-up preserves incoming ownership
- **Question:** Do the incoming Hosting, Tasks, or Vault decisions conflict with this repair?
- **Options:** broaden CLI changes; retain each area's existing authority and acceptance boundary.
- **Chose:** retain those boundaries after reading every incoming log completely.
- **Why:** Hosting D1–D6 (71 lines), Tasks D1–D9 and qualifications (107 lines), and Vault D1–D11 (125 lines) introduce no CLI signature, theme-marker, repo-removal, or selector conflict. Their partial UI/native/review evidence remains qualified and is not claimed by this item.
- **Evidence:** `docs/loop/decisions/fix-test-hosting-1028.md`; `fix-test-tasks-1028.md`; `fix-test-vault-1028.md`; completed `IncomingCliContracts` read-only report.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** controller landing exposes a concrete conflicting integration change.
- **Source:** assumed — autonomous

## D8: Finish failed review stages without treating malformed output as a verdict
- **Question:** How should the bounded final review handle schema failures and weak independence signals?
- **Options:** silently repair reviewer JSON; call failed stages a pass; retry only the failed stages and retain the assurance limits.
- **Chose:** one read-only C/S/X discovery round over the five scoped source/test files, independent refutation, mechanical evidence gates, and fresh retries only for malformed stages. After Gemini's X-refutation used invalid disposition values twice, use the verified Flash medium fallback for that stage.
- **Why:** All initial promote replies lacked required schema fields; S/X refutations also emitted illegal enums. None was hand-repaired or treated as a verdict. The final machine gates report C PASS with zero findings, S PASS with one suppressed finding, and X PASS with two suppressed findings; no advisory, contested, or accepted code finding remains. Parent verified S1 against existing Session CLI background-error/no-session-mutation coverage and Terminal CLI missing-session exit-2 coverage. Parent rejects X1 because the observed table mismatch was only the incidental default title, and X2 because the lifecycle still executes the aliases. Neither justifies restoring copied output tests. No code fix batch is needed.
- **Evidence:** `.quirk/build-loop/fix-test-packages-cli-1028/review-traces.tgz`; final machine gate/manifests and raw stage responses; `plugins/quirky.session/test/cli.test.ts:219-231`; `plugins/quirky.terminal/test/cli.test.ts:257-260`; `packages/cli/test/v1-words.e2e.test.ts`.
- **Reversibility:** easy
- **Confidence:** medium (bounded, qualified review; not a clean independent review claim)
- **Revisit if:** a concrete consumer failure contradicts the retained behavior.
- **Source:** assumed — autonomous

### Review assurance limits
All reviewers had read/search tools only, with no shell or mutation grants. The five reviewed source hashes matched exactly before and after the completed review. However, the initial correctness reviewer searched the shared scratch review directory; its context cannot be certified uncontaminated. Subsequent prompts explicitly prohibited scratch inspection and withheld other reviewers' results. Total S/X suppression is another weak-signal warning, not evidence of comprehensive correctness. The X manifest identifies the selected Gemini promote reviewer; the actual refutation fallback was `google/gemini-flash-latest:medium`, recorded separately in the raw trace and summary. The source-only artifact excludes author decision logs and incoming unrelated changes; no whole-branch or whole-repository review claim is made.

## D9: Claim only the exercised CLI surface
- **Question:** Do these repairs require a UI/native acceptance campaign or a new follow-up?
- **Options:** imply broad parity from package tests; add duplicate verification work; retain this item's actual boundary.
- **Chose:** retain scoped CLI/API/runtime evidence, existing broader owners, and no new follow-up.
- **Why:** All named flows are implemented. The only production delta is the existing Worktree provider registration consumed from its owner; no UI/native presentation, schema, API signature, or platform-specific behavior changed. The real CLI smoke covers the changed removal path, and the build bundles the current CLI/daemon/plugins. Scripts pass 127 tests, 1125 assertions across 12 files. Root/UI-lint/mobile/prepared-desktop types and build pass; missing-icon/release-URL build warnings remain disclosed. No native, live-provider, full-repository, or zero-flaky claim follows from these results.
- **Evidence:** scoped canonical receipts, actual runtime smoke, build (30 plugins, 26 UI plugin modules), and `.quirk/build-loop/fix-test-packages-cli-1028/receipts.json`.
- **Reversibility:** easy
- **Confidence:** high for the named exercised paths
- **Revisit if:** the controller reports a concrete integration failure.
- **Source:** assumed — autonomous

## Progress
Final post-review canonical CLI/repo gate passed all 29 remote files and one macOS file with no retries in that run (38.64 seconds). Final root/UI-lint/mobile/prepared-desktop typecheck plus full build passed (48.52 seconds combined); build warnings remain disclosed. Earlier retries are retained in D6 and the appended BLOCKERS receipt. Scripts passed 127 tests/1125 assertions, the targeted ownedIds regression passed, and real private CLI/PTY/Git runtime proof is archived. Both components are merged and removed; all checks, reviewer stages, agents, and owned runtime processes have returned. The single roadmap catch-up is complete. Candidate is ready to commit/detach and submit to the absolute canonical `queue.ts land fix-test-packages-cli-1028`; only a successful authoritative receipt finishes this item. No second item may be claimed.
