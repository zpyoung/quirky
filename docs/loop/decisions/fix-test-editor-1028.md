# fix-test-editor-1028 decisions

## D1: Repair the exact triaged editor behaviors without compatibility shims
- **Question:** Which failure evidence and acceptance boundary govern this fix item?
- **Options:** rerun the baseline merely to confirm; use the authoritative failure transcript and investigate its data paths
- **Chose:** Use baseline `97aaa12d` and `docs/loop/reports/m7-test-triage.{json,log.gz}` as failing-before evidence. Repair Changes shared-draft/lease handling, Explorer worktree isolation, CSV lossless edit/copy/paste, and document-link completion. Delete incidental wording/source/default assertions rather than repin them. Preserve exact window, worktree and lease authority.
- **Why:** The fix item names these four files and the triage explicitly forbids aliases, bypasses and incidental assertion mirrors. Reported failures are ground truth; new runs must validate repairs or a distinct hypothesis, not confirm the report.
- **Evidence:** docs/loop/decisions/m7-test-triage.md D5; queue wait lane 2; docs/loop/reports/m7-test-triage.json groups plugins/quirky.editor
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** detailed transcript or current code demonstrates an already-consumed correction
- **Source:** locked by docs/loop/LOOP.md and triage ownership

## D2: Run the end-phase fix workflow unattended with bounded disjoint implementation
- **Question:** How should skills, reviews, isolation and human questions be adapted?
- **Options:** new feature brainstorming/specs; fix workflow with root-cause investigation and existing behavioral regression coverage
- **Chose:** Skip feature specs per Fix items. Use up to three disjoint omp/OpenAI implementers after ownership mapping; parent integrates and runs checks once workers finish. Use external temporary worktrees. Keep inherited untracked `.quirk/` and `.serena/` untouched. No asks. All checks use `bun scripts/suite.ts ...` for the configured remote host, never direct `bun test`. Choose cross-family Gemini reviewer because `pi-watch --check opus` and `sonnet` reported no authenticated/shipping model, while Gemini resolved to `google/gemini-3.1-pro-preview:high`. One final review round and one fix batch per LOOP, not an open-ended campaign.
- **Why:** This is after m7-test-triage, so end-phase testing is enabled. LOOP overrides interactive questions and feature-spec requirements. Developer dispatch contract prohibits worker build/lint/test/formatter runs mid-flight. Existing authoritative failed tests provide the red evidence. No LSP servers are configured.
- **Evidence:** authoritative LOOP.md Fix items and end phase; reviewer probes; xd://lsp status; initial HEAD `18d47686ea4ff65d7b920a2d240d073eacb20f77`
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a worker scope intersects another or a reachable reviewer dispatch fails
- **Source:** assumed — autonomous

## Progress
Claimed on lane 2. Branch created from current roadmap. Reading detailed failure evidence and mapping disjoint implementation ownership before dispatch. Next: scoped fixes, affected suite plus scripts/typecheck and real changed-path smoke, one integration catch-up, final bounded review, canonical land.
