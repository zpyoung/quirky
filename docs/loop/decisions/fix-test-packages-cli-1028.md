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

## Progress
Both disjoint CLI components have been audited, parent-committed, merged, and their temporary worktrees removed. The owned provider checkpoint is integrated. The single final roadmap catch-up and incoming-log reads are complete. Real private CLI/PTY/Git smoke, the canonical 29-remote/1-macOS CLI/repo gate (one disclosed configured retry), targeted ownedIds regression, and root typecheck passed. Required script check is complete; next record its exact final result, run the single bounded read-only cross-family review and one accepted fix batch if necessary, rerun affected checks after any source change, then commit/detach and land through the absolute canonical controller. No second item may be claimed.
