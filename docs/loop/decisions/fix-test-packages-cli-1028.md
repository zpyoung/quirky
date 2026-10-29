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

## Progress
Claimed one item on lane 8. Base `0be7e675cbd63c41969811f74d889229c5ca85e3`. Read-only failure mapping and the canonical current CLI suite are running. Next: classify current failures, dispatch disjoint bounded repairs, exercise real CLI runtime behavior, merge roadmap once, complete the bounded final review/check gates, and land through the absolute canonical queue controller. No other item may be claimed in this iteration.
