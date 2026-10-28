# m3-accounts-overflow-verification decisions

## D1: Verify the named slice without reopening Accounts
- **Question:** Which scope and design apply to this follow-up?
- **Options:** rebuild responsive layout; verify existing measured collapse and repair reproduced defects; reopen all unfinished Accounts work
- **Chose:** verify measured collapse, tooltip, badge-only and width recovery; diagnose and obtain bounded affected-package proof
- **Why:** queue title names these missing observations; original D7 locks behavior, D28 preserves core proof, D29 records timeout without verdict. Other Accounts flows belong to their separate queue item.
- **Evidence:** docs/roadmap.md M3; external accounts.md Read usage step6 and Verified; docs/loop/decisions/m3-accounts.md D7,D28,D29,D33
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** observed browser behavior violates inherited requirements
- **Source:** locked by docs/loop/LOOP.md

## D2: Resolve all verification gray areas autonomously
- **Question:** How should layout/density, interaction, errors, output and isolation ambiguities be settled without a human?
- **Options:** ask; choose source-doc/recommended defaults and record; weaken evidence to mounted tests
- **Chose:** source-doc suffix collapse and provider letters; existing Appearance density control; real +N hover/title/click; actual layout and projection agreement; preserve stale/error semantics; keep historical timeout distinct; temporary fixture homes and owned processes
- **Why:** every choice changes observable evidence; neither a 1280px no-overflow run nor mock layout establishes responsive correctness. No visual companion, adhd offer, human gate or research swarm under unattended LOOP. Recommended evidence-first verification beats speculative breakpoints; DOM-only and production redesign alternatives rejected.
- **Evidence:** logic.md AC1–AC4; external accounts.md:41,320; original Accounts D11,D23,D28–D29
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** native title painting or tooling prevents a specific observation
- **Source:** assumed — autonomous

## D3: Use reachable cross-family final review fallback
- **Question:** Which execution/reviewer pair is available?
- **Options:** OpenAI task + Opus; OpenAI task + Gemini; same-family only
- **Chose:** IMPLEMENTER=omp-task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini; Codex combined spec review as LOOP requires
- **Why:** actual pi-watch --check found Opus0/8 and Sonnet0/6 unavailable; Gemini google/gemini-3.1-pro-preview:high and Codex openai-codex/gpt-6.1-sol reachable. Codex spec independence is reduced, not cross-family clearance.
- **Evidence:** observed preflight output iteration6; web doctor ready playwright-cli0.1.22
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** dispatched backend fails
- **Source:** assumed — autonomous

## D4: Preserve historical uncertainty and reconstruct complete affected scope
- **Question:** What can explain the original 1,800-second stall when its stdout/command were not retained?
- **Options:** guess a stalled file; equate later cleanup fixes with proven cause; inspect retained artifacts and profile a conservative current scope
- **Chose:** no historical causal claim; use packages/protocol, packages/daemon, packages/ui, packages/cli, apps/desktop, and plugins quirky.accounts, quirky.session, quirky.structured, quirky.terminal, quirky.agents
- **Why:** read-only archive investigation found no affected-all-checks.json or old stdout; these ten directories derive from the original Accounts source/importer map. Current runner owns transport/test processes and cleans descendants before waiting for stream EOF, but those later repairs cannot establish where the old run stalled. Full current scope under a 1,200-second external bound and per-file profiling retains all selected tests.
- **Evidence:** RecoverSuiteEvidence report; preserved lane10 Accounts tech spec code map; current scripts/suite.ts:51-94,176-201,244-271,298-375; git log bb9d214a..HEAD runner changes; fix-test-process-leaks D10–D12
- **Reversibility:** easy
- **Confidence:** high for missing evidence/current selection; no confidence claim for historical cause
- **Revisit if:** the original run stdout or command receipt is recovered
- **Source:** assumed — autonomous

## D5: Preserve the original core and native transcript-content receipts
- **Question:** Which earlier proof remains distinct from this responsive verification?
- **Options:** replace earlier proof with new layout observations; retain its exact scope and archived receipts
- **Chose:** preserve original 48-test/295-assertion core report, prior three named guarded UI reports, and post-fix actual transcript smoke independently
- **Why:** archived landing.json confirms Accounts landed; post-fix-smoke.json confirms both selected-B native resumes read A content, matched digests and appended continuation markers. Responsive UI evidence neither replaces nor broadens those claims.
- **Evidence:** docs/loop/decisions/m3-accounts.md D28,D33; /Users/zpyoung/orca/workspaces/quirky/build-lane-10/.orca/loops/omp-until-done-50bc6f72/evidence/{landing,post-fix-smoke}.json (read in iteration6)
- **Reversibility:** easy
- **Confidence:** high for retained receipt contents
- **Revisit if:** native protocol changes invalidate the earlier boundary
- **Source:** locked by docs/loop/decisions/m3-accounts.md

## D6: Accept the spec completion-criterion finding, reject packaging false positives
- **Question:** Which combined Codex review findings require changes?
- **Options:** allow diagnosis alone to close AC4; explicitly require full passing rerun; treat scratch-relative links as broken repository links
- **Chose:** accepted F1 MEDIUM and clarified AC4: repair alone is incomplete; full bounded affected rerun must pass. Dismissed F2–F13 deterministic path-token findings after checking actual file paths/relative links/external research location.
- **Why:** the model correctly found ambiguity between Scope's passing requirement and AC4's alternative. Combined scratch artifact changes relative-link base; command tokens and multi-range line selectors are not missing source files. External research is deliberately outside the worktree.
- **Evidence:** actual standard Codex promote/refute gate NEEDS_FIXES13MEDIUM, zero suppressed/contested; /var/folders/x5/07kj5yld16l9wd5p_v01h20c0000gp/T/quirk-accounts-overflow-review-KOywJg/{gate,manifest}.json; logic.md AC4 corrected; original anchors read in this iteration
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a cited actual file or original-relative link is missing
- **Source:** assumed — autonomous

## Progress
Scope surveys completed; original D1–D35 and locked roadmap/architecture read. Both specs authored pending combined Codex review. RecoverSuiteEvidence tracing archived lane10 evidence and runner history. No behavioral change or verification success claimed. Next: adjudicate spec review; commit specs; prepare isolated actual UI fixtures and bounded profiled affected selection, repair only reproduced defects, full required checks, final review/catchup and land.
